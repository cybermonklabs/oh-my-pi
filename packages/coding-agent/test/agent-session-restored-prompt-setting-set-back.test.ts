/**
 * A resumed process keeps the system prompt its transcript was last sent with while the cache entry is warm, in place
 * of its own build. The configuration changed `personality` while no process ran, so this process's own build differs
 * from the kept prompt. The configuration sets `personality` back to the value the kept prompt was built with: the
 * prompt the model holds already says what the settings say, so no hidden settings notice may tell the model that its
 * prompt was written under the value set while no process ran.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	personalityOverlay,
	RELOAD_CALLS,
	reloadOverlay,
} from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

describe("a setting set back, in a resumed process, to the value its kept prompt was built with", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from an overlay with
	 * `personality`: runs `steps`, then exits.
	 */
	async function runProcess(
		dir: TempDir,
		personality: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings, overlay: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, personalityOverlay(personality));
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await steps(session, settings, overlay);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	it("tells the model of no change", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-setting-set-back-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, "default", undefined, async session => {
			await session.prompt("first");
		});
		// The configuration moved to `pragmatic` while no process ran; the session is resumed at once, its cache entry
		// warm, and the configuration sync sets `personality` back before the first request.
		const resumed = await runProcess(dir, "pragmatic", live.sessionFile, async (session, settings, overlay) => {
			await reloadOverlay({ session, settings, overlay }, personalityOverlay("default"), RELOAD_CALLS);
			await session.prompt("second");
		});

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		// Precondition: the resumed request continues the transcript's cached prompt, built under `default`.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(continuesCachedPrompt(first, second)).toBe(true);

		// The prompt was never written under `pragmatic`: nothing tells the model it was.
		expect(textOf(second.messages.slice(first.messages.length))).not.toContain('`"pragmatic"`');
	}, 60_000);
});
