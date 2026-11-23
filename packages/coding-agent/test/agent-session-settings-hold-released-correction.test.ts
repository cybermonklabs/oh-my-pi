/**
 * Memory switched off and the tool calls' intent field turned off on a bound prompt are held, and the hidden settings
 * notice tells the model both, and that calls to `learn` are refused. Both are set back, and the process exits before
 * a request carries a notice of it. A process that resumes the session once the change is five minutes old sends its
 * own build, which has the intent field and `learn`, and holds a `personality` change made before its first request.
 * That request's notice puts right what the earlier notice told, and must say that the switch back is in effect: the
 * system prompt and tools it carries follow it, so it is not held with the `personality` change. A correction the
 * request's prompt does not follow yet (a kept restored prompt built with the value an earlier notice told, while the
 * setting changed since) goes out with the rebuild, so it is named among the held settings.
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

/** {@link LEARNING} under the local memory backend, which offers the `learn` tool, with the intent field on. */
const LOCAL_MEMORY = `${LEARNING}memory:\n  backend: local\ntools:\n  intentTracing: true\n`;

/** {@link LEARNING} with memory switched off, which withdraws `learn`, and the intent field off. */
const MEMORY_OFF = `${LEARNING}memory:\n  backend: off\ntools:\n  intentTracing: false\n`;

/** {@link LOCAL_MEMORY} with another `personality`, a change the system prompt renders. */
const PRAGMATIC = `${LOCAL_MEMORY}personality: pragmatic\n`;

/** {@link LOCAL_MEMORY} with yet another `personality`. */
const FRIENDLY = `${LOCAL_MEMORY}personality: friendly\n`;

const MINUTE_MS = 60_000;

/** The line of a settings notice that starts the settings a change that is no longer held left as they are now. */
const RELEASED_LIST = "the change it described is no longer held";

describe("a correction a held change's notice owes for an earlier change that ended", () => {
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

	it("names the switch back as in effect, apart from the held change", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-released-correction-");
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
		// Preconditions: the first process told the model that the intent field is off and `learn` refused; the resumed
		// process sends the prompt and the tools the switch back gives, and holds the `personality` change.
		expect(textOf(afterOff.messages.slice(first.messages.length))).toContain(
			"`tools.intentTracing`: `true` → `false`",
		);
		expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(afterRestart.tools)).toBe(withoutCacheControl(first.tools));

		const told = textOf(afterRestart.messages.slice(afterOff.messages.length));
		const split = told.indexOf(RELEASED_LIST);
		expect(split).toBeGreaterThan(-1);
		const held = told.slice(0, split);
		const released = told.slice(split);
		expect(held).toContain("`personality`");
		expect(held).not.toContain("`tools.intentTracing`");
		expect(held).not.toContain("`memory.backend`");
		expect(released).toContain("`tools.intentTracing`: `false` → `true`");
		expect(released).toContain('`memory.backend`: `"off"` → `"local"`');
		expect(released).not.toContain("`personality`");
		expect(told).toContain("calls to them run again from now on: `learn`");
	}, 60_000);

	it("keeps a correction the kept restored prompt was not built with among the held settings", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-released-correction-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const before = await runProcess(dir, LOCAL_MEMORY, undefined, async (session, settings, overlay) => {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, PRAGMATIC, RELOAD_CALLS);
			setClock(MINUTE_MS);
			await session.prompt("after the change");
			setClock(6 * MINUTE_MS);
			await session.prompt("after the rebuild");
		});
		// The configuration changes `personality` again while no process runs; a process resumes the session while
		// the cache entry is warm, so it keeps the stored prompt, which was built with the value the notice told.
		setClock(7 * MINUTE_MS);
		const resumed = await runProcess(dir, FRIENDLY, before.sessionFile, async session => {
			await session.prompt("after the restart");
		});

		const [, changeTold, rebuilt] = before.requests;
		const [afterRestart] = resumed.requests;
		if (!changeTold || !rebuilt || !afterRestart) throw new Error("Expected the two processes' requests");
		// Preconditions: the earlier process told the model `personality` is `pragmatic` and sent the rebuild; the
		// resumed process keeps that prompt.
		expect(textOf(changeTold.messages)).toContain('`personality`: `"default"` → `"pragmatic"`');
		expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(rebuilt.system));

		// The prompt the request carries is not built with the new value: it goes out with the rebuild.
		const told = textOf(afterRestart.messages.slice(rebuilt.messages.length));
		expect(told).toContain("The change is held");
		expect(told).toContain('`personality`: `"pragmatic"` → `"friendly"`');
		expect(told).not.toContain(RELEASED_LIST);
	}, 60_000);
});
