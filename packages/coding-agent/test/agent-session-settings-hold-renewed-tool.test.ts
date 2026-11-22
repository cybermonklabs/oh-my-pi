/**
 * Memory switched off on a bound prompt is held, and its hidden settings notice tells the model that calls to `learn`
 * are refused until the rebuild. Memory is switched back on, and the process exits before any request carries a notice
 * of that. A process that resumes the session once the change is five minutes old sends its own build, which is the
 * transcript's prompt, so the prompt stays bound; the configuration then switches memory off again, and that change is
 * held. The earlier notice's change ended, and its time has passed: the first request of the new change must tell the
 * model again that `memory.backend` is off and that calls to `learn` are refused, with the new change's time.
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

/** The notice's line for the tools a change disables that the request still lists. */
const REFUSED_LEARN = "calls to them are refused from now on: `learn`";

const MINUTE_MS = 60_000;

/** The time a settings notice gives for its change to go out. */
function noticeDeadline(notice: string): number {
	const deadline = notice.match(/at the first request made at (\S+) or later/)?.[1];
	if (!deadline) throw new Error("Expected the notice's deadline");
	return Date.parse(deadline);
}

describe("a held memory switch told, switched back, then held again in a process resumed past five minutes", () => {
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

	it("tells the model again that `learn` is refused, with the new change's time", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-renewed-tool-");
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
		let resumedAt = 0;
		const resumed = await runProcess(dir, LOCAL_MEMORY, before.sessionFile, async (session, settings, overlay) => {
			await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, RELOAD_CALLS);
			await session.settleMemoryBackend();
			resumedAt = Date.now();
			await session.prompt("after the restart");
		});

		const [first, afterOff] = before.requests;
		const [afterRestart] = resumed.requests;
		if (!first || !afterOff || !afterRestart) throw new Error("Expected the two processes' requests");
		// Preconditions: the first process told the model that `learn` is refused, by a time that passed before the
		// restart; the resumed process holds the switch, so its first request keeps the transcript's prompt and tools.
		const offNotice = textOf(afterOff.messages.slice(first.messages.length));
		expect(offNotice).toContain(REFUSED_LEARN);
		expect(noticeDeadline(offNotice)).toBeLessThan(resumedAt);
		expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(afterOff.system));
		expect(afterRestart.tools?.map(tool => tool.name)).toContain("learn");

		const told = textOf(afterRestart.messages.slice(afterOff.messages.length));
		expect(noticeDeadline(told)).toBeGreaterThan(resumedAt);
		expect(told).toContain('`memory.backend`: `"local"` → `"off"`');
		expect(told).toContain(REFUSED_LEARN);
	}, 60_000);
});
