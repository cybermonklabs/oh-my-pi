/**
 * Memory switched off on a bound prompt is held, and its hidden settings notice tells the model that calls to `learn`
 * are refused. Memory is switched back on, and the process exits before any request carries a notice of the switch
 * back. A process that resumes the session once the change is five minutes old does not keep the transcript's prompt;
 * its own build is that prompt, so the prompt stays bound, and a settings change made before its first request is
 * held. That request must still tell the model that `memory.backend` is back and that `learn` runs again: the held
 * change's notice is the only settings notice it carries, and `learn` does run.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, auto-learn on. */
const LEARNING = "providers:\n  cacheRetention: long\nautolearn:\n  enabled: true\n";

/** {@link LEARNING} under the local memory backend, which offers the `learn` tool. */
const LOCAL_MEMORY = `${LEARNING}memory:\n  backend: local\n`;

/** {@link LEARNING} with memory switched off, which withdraws `learn`. */
const MEMORY_OFF = `${LEARNING}memory:\n  backend: off\n`;

/** {@link LOCAL_MEMORY} with another `personality`, a change the system prompt renders. */
const PRAGMATIC = `${LOCAL_MEMORY}personality: pragmatic\n`;

const MINUTE_MS = 60_000;

describe("a held memory switch told, switched back, then a held change in a process resumed past five minutes", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from an overlay with
	 * `overlay`: runs `steps` on the session, then exits. Returns the requests and the session file.
	 */
	async function runProcess(
		dir: TempDir,
		overlay: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings, overlayPath: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(restore);
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
			await session.settleMemoryBackend();
			await steps(session, settings, overlayPath);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("tells the model at the resumed process's first request that `learn` runs again", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-spent-notice-new-hold-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const before = await runProcess(dir, LOCAL_MEMORY, undefined, async (session, settings, overlay) => {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, RELOAD_CALLS);
			await session.settleMemoryBackend();
			setClock(MINUTE_MS);
			await session.prompt("after the switch off");
			setClock(2 * MINUTE_MS);
			await reloadOverlay({ session, settings, overlay }, LOCAL_MEMORY, RELOAD_CALLS);
			await session.settleMemoryBackend();
		});
		setClock(7 * MINUTE_MS);
		const resumed = await runProcess(dir, LOCAL_MEMORY, before.sessionFile, async (session, settings, overlay) => {
			await reloadOverlay({ session, settings, overlay }, PRAGMATIC, RELOAD_CALLS);
			await session.prompt("after the restart");
		});

		const [first, afterOff] = before.requests;
		const [afterRestart] = resumed.requests;
		if (!first || !afterOff || !afterRestart) throw new Error("Expected the two processes' requests");
		// Preconditions: the first process told the model that `learn` is refused; the resumed process holds the
		// `personality` change (its first request sends the transcript's system prompt), so it tells it in a notice.
		expect(textOf(afterOff.messages.slice(first.messages.length))).toContain(
			"calls to them are refused from now on: `learn`",
		);
		expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(afterOff.system));
		expect(afterRestart.tools?.map(tool => tool.name)).toContain("learn");

		// The refusal the model was told no longer holds: the first request of the resumed process says so.
		const told = textOf(afterRestart.messages.slice(afterOff.messages.length));
		expect(told).toContain("`memory.backend`");
		expect(told).toContain("calls to them run again from now on: `learn`");
	}, 60_000);
});
