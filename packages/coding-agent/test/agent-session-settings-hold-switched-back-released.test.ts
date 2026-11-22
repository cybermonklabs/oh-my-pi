/**
 * Memory switched off on a bound prompt is held, and its hidden settings notice tells the model that calls to `learn`
 * are refused. Memory is switched back on, and the hold ends before any request carries a notice of the switch back:
 * the held rebuild comes due (five minutes on, a lapsed cache entry) in the same process, or a process that resumes
 * the session no longer keeps the transcript's prompt. The model must still learn that the setting is back and that
 * `learn` runs again; nothing else would contradict the refusal it was told.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, auto-learn on. */
const LEARNING = "providers:\n  cacheRetention: long\nautolearn:\n  enabled: true\n";

/** {@link LEARNING} under the local memory backend, which offers the `learn` tool. */
const LOCAL_MEMORY = `${LEARNING}memory:\n  backend: local\n`;

/** {@link LEARNING} with memory switched off, which withdraws `learn`. */
const MEMORY_OFF = `${LEARNING}memory:\n  backend: off\n`;

const MINUTE_MS = 60_000;

/** The real clock, read before any test moves it. */
const realNow = Date.now.bind(Date);

/** Moves the clock `offsetMs` ahead of real time from now on. */
function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

describe("a held memory switch whose notice went out, switched back, ended before a notice of it", () => {
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

	/** The first request's process steps: memory switched off, which is held and told, at the clock's start. */
	async function switchOffAndTell(session: AgentSession, settings: Settings, overlay: string): Promise<void> {
		setClock(0);
		await session.prompt("first");
		await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, RELOAD_CALLS);
		await session.settleMemoryBackend();
		setClock(MINUTE_MS);
		await session.prompt("after the switch off");
	}

	/** The precondition every case shares: the notice of the switch told the model that `learn` is refused. */
	function expectRefusalTold(first: MessagesRequest, afterOff: MessagesRequest): void {
		expect(textOf(afterOff.messages.slice(first.messages.length))).toContain(
			"calls to them are refused from now on: `learn`",
		);
	}

	it("tells the model at the request the held rebuild comes due at, in the same process", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-switched-back-released-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const { requests } = await runProcess(dir, LOCAL_MEMORY, undefined, async (session, settings, overlay) => {
			await switchOffAndTell(session, settings, overlay);
			setClock(2 * MINUTE_MS);
			await reloadOverlay({ session, settings, overlay }, LOCAL_MEMORY, RELOAD_CALLS);
			await session.settleMemoryBackend();
			// No request before the change is due: its rebuild runs ahead of the next request's notices.
			setClock(6 * MINUTE_MS);
			await session.prompt("after the deadline");
			await session.prompt("again");
		});

		const [first, afterOff, afterDeadline, again] = requests;
		if (!first || !afterOff || !afterDeadline || !again) throw new Error("Expected four requests");
		expectRefusalTold(first, afterOff);
		const told = textOf(afterDeadline.messages.slice(afterOff.messages.length));
		expect(told).toContain("`memory.backend`");
		expect(told).toContain("`learn`");
		// Told once: the next request's context carries it.
		expect(textOf(again.messages.slice(afterDeadline.messages.length))).not.toContain("`memory.backend`");
	}, 60_000);

	// Memory is switched back on while no process runs; the resumed process does not keep the transcript's prompt:
	// the change is past its five minutes, or the cache entry lapsed.
	it.each([
		["past the change's five minutes", 6 * MINUTE_MS],
		["once the cache entry lapsed", 2 * 60 * MINUTE_MS],
	])(
		"tells the model at the first request of a process that resumes the session %s",
		async (_, offset) => {
			using dir = TempDir.createSync("@pi-settings-hold-switched-back-released-");
			await Bun.write(dir.join("models.yml"), gatewayModelsYml());
			const before = await runProcess(dir, LOCAL_MEMORY, undefined, switchOffAndTell);
			setClock(offset);
			const resumed = await runProcess(dir, LOCAL_MEMORY, before.sessionFile, async session => {
				await session.prompt("after the restart");
			});

			const [first, afterOff] = before.requests;
			const [afterRestart] = resumed.requests;
			if (!first || !afterOff || !afterRestart) throw new Error("Expected the two processes' requests");
			expectRefusalTold(first, afterOff);
			const told = textOf(afterRestart.messages.slice(afterOff.messages.length));
			expect(told).toContain("`memory.backend`");
			expect(told).toContain("`learn`");
		},
		60_000,
	);
});
