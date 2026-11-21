import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Past the longest a held settings change waits while requests keep the cache warm. */
const PAST_HOLD_BOUND_MS = 6 * 60_000;

// A held settings change keeps the tool definitions of the request the conversation continues from. A hold that began
// on one branch kept that branch's definitions; after `/tree` to a reply whose request declared other definitions, the
// next request continues from that reply, and only its definitions read the cache entry it left.
describe("a settings change held on one branch, then /tree to a reply sent with other tool definitions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("declares what the request of the reply /tree moved to declared", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-tree-follow-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			const firstReply = session.sessionManager
				.getBranchView()
				.find(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!firstReply) throw new Error("Expected the first reply on the branch");
			// The change is held, then goes out with the first request five minutes or more after it.
			await reloadOverlay({ session, settings, overlay }, `${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`, [
				"holdToolDeclarationChange",
			]);
			now += PAST_HOLD_BOUND_MS;
			await session.prompt("second");
			// Putting the timeout back is held too: the tools keep what the second request declared.
			await reloadOverlay({ session, settings, overlay }, LONG_ENTRIES, ["holdToolDeclarationChange"]);
			// The user continues from the first reply while that change is still held.
			await session.navigateTree(firstReply.id);
			await session.prompt("third, on the branch from the first reply");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, second, third] = gateway.requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Preconditions: the second request sent the changed definition under the same system prompt.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(second.tools)).toContain("(default 120s)");
		// Tools come first in cache order: keeping the definitions of the branch the hold began on writes the whole
		// conversation again, where the first request's definitions read the entry its reply left.
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(third.tools)).toBe(withoutCacheControl(first.tools));
	}, 60_000);
});
