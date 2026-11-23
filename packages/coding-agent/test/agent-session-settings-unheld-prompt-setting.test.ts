import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

// `task.maxConcurrency` renders into the system prompt ("Max N concurrent subagents") and belongs to none of the
// setting groups whose change starts a held rebuild. Its change starts no rebuild of its own; the next rebuild that
// would change nothing (a memory backend's periodic refresh, a reload that finds nothing new) sends it at once.
describe("a configuration reload of a setting only the system prompt renders, on a bound prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the system prompt through a rebuild that changes nothing of its own", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-unheld-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
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
			toolNames: ["read", "task"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			await session.refreshBaseSystemPrompt();
			await session.prompt("second");
			const spy = vi.spyOn(session, "holdToolDeclarationChange");
			await Bun.write(overlay, `${LONG_ENTRIES}task:\n  maxConcurrency: 3\n`);
			await settings.reloadFromDisk();
			await Promise.resolve();
			await Promise.all(spy.mock.results.map(result => result.value));
			spy.mockRestore();
			await session.refreshBaseSystemPrompt();
			await session.prompt("third");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, second, third] = gateway.requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the rebuild alone changes nothing.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// The change would rewrite the whole cached prompt a moment after its last write, where a held change waits for
		// a lapse, a cut or five minutes.
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);
});
