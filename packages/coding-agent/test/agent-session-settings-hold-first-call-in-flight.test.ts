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
	heldOpen,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Past the longest a held settings change waits while requests keep the cache warm. */
const PAST_HOLD_BOUND_MS = 6 * 60_000;

// `task.maxConcurrency` renders into the system prompt ("Max N concurrent subagents") and no listener rebuilds the
// prompt for it. While the session's first request is in flight, that request has sent the prompt and its reply binds
// it: a change made then is held as one made after the reply, not left for a later rebuild to send a moment after the
// prompt's first cache write.
describe("a setting only the system prompt renders, changed while the first request is in flight", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the prompt that request sent for the next one, and sends the change once it is due", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-first-in-flight-");
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
		const sent = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const gateway = mockGatewayFetch(turn => {
			const reply = answer(turn, { cacheWriteTokens: 100 });
			if (turn !== 1) return reply;
			sent.resolve();
			return heldOpen(reply, released.promise);
		});
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
			toolNames: ["read", "task"],
			contextFiles: [],
			skills: [],
		});
		try {
			const first = session.prompt("first");
			await sent.promise;
			await reloadOverlay({ session, settings, overlay }, `${LONG_ENTRIES}task:\n  maxConcurrency: 3\n`, [
				"holdToolDeclarationChange",
			]);
			released.resolve();
			await first;
			// A rebuild that changes nothing of its own, such as a memory backend's periodic refresh.
			await session.refreshBaseSystemPrompt();
			await session.prompt("second");
			now += PAST_HOLD_BOUND_MS;
			await session.prompt("third, five minutes or more after the change");
		} finally {
			released.resolve();
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, second, third] = gateway.requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the first request went out before the change.
		expect(textOf(first.system)).not.toContain("Max 3 concurrent subagents");
		// The prompt the first reply bound stays: a new one would rewrite the whole cached prompt a moment after its
		// first write.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// Held, not lost: it goes out with the first request five minutes or more after it.
		expect(textOf(third.system)).toContain("Max 3 concurrent subagents");
	}, 60_000);
});
