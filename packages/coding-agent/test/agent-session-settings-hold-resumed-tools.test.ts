import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

interface ProcessStep {
	session: AgentSession;
	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the hold it starts. */
	reload(content: string): Promise<void>;
}

// A resumed transcript binds its prompt: its newest reply was produced under it, and the next request reads the cache
// entry that reply wrote when it sends the same tool definitions and prompt. A setting the bash definition renders,
// changed before this process sent anything, must be held as it is once this process has sent a request.
describe("a setting a tool definition renders, changed in a resumed session before its first request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one), its settings loaded from the overlay. */
	async function runProcess(
		tempDir: TempDir,
		sessionFile: string | undefined,
		steps: (step: ProcessStep) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = tempDir.join("overlay.yml");
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		const reload = async (content: string): Promise<void> => {
			const spy = vi.spyOn(session, "holdToolDeclarationChange");
			await Bun.write(overlay, content);
			await settings.reloadFromDisk();
			await Promise.resolve();
			await Promise.all(spy.mock.results.map(result => result.value));
			spy.mockRestore();
		};
		try {
			await steps({ session, reload });
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	it("keeps the tool definitions the transcript was last sent with at its first request", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-resumed-tools-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		await Bun.write(tempDir.join("overlay.yml"), LONG_ENTRIES);
		const live = await runProcess(tempDir, undefined, async ({ session }) => {
			await session.prompt("first");
		});
		const resumed = await runProcess(tempDir, live.sessionFile, async ({ session, reload }) => {
			await reload(`${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`);
			await session.prompt("second");
		});

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected a request of each process");
		// Precondition: nothing else differs, so the resumed request reads the entry the transcript's reply wrote.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// Tools come first in cache order: the new bash definition would write the whole transcript again a moment after
		// its last write, where a held change waits for a lapse, a cut or five minutes.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
	}, 60_000);
});
