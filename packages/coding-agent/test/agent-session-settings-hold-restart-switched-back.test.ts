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
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, auto-learn on. */
const LEARNING = "providers:\n  cacheRetention: long\nautolearn:\n  enabled: true\n";

/** {@link LEARNING} under the local memory backend, which offers the `learn` tool. */
const LOCAL_MEMORY = `${LEARNING}memory:\n  backend: local\n`;

/** {@link LEARNING} with memory switched off, which withdraws `learn`. */
const MEMORY_OFF = `${LEARNING}memory:\n  backend: off\n`;

describe("a held memory switch whose notice went out, switched back before a restart", () => {
	afterEach(() => {
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
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
			restoreFetch();
		}
	}

	// Memory is switched back on before the restart: by the first process, which then exits before its next request,
	// or by the configuration while no process runs.
	it.each([
		["by the first process", true],
		["while no process runs", false],
	])(
		"tells the resumed model that the tool its notice called refused runs again, switched back %s",
		async (_, live) => {
			using dir = TempDir.createSync("@pi-settings-hold-restart-switched-back-");
			await Bun.write(dir.join("models.yml"), gatewayModelsYml());

			// The first process answers once under local memory; memory is switched off, which is held, and the second
			// request tells the model that calls to `learn` are refused. The process exits with the switch still held.
			const before = await runProcess(dir, LOCAL_MEMORY, undefined, async (session, settings, overlay) => {
				await session.prompt("first");
				await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, RELOAD_CALLS);
				await session.settleMemoryBackend();
				await session.prompt("after the switch off");
				if (!live) return;
				await reloadOverlay({ session, settings, overlay }, LOCAL_MEMORY, RELOAD_CALLS);
				await session.settleMemoryBackend();
			});
			// The session is resumed at once under local memory, its cache entry warm.
			const resumed = await runProcess(dir, LOCAL_MEMORY, before.sessionFile, async session => {
				await session.prompt("after the restart");
			});

			const [first, afterOff] = before.requests;
			const [afterRestart] = resumed.requests;
			if (!first || !afterOff || !afterRestart) throw new Error("Expected the two processes' requests");
			// Preconditions: the switch was held, and its notice told the model that `learn` is refused; the resumed process
			// sends the prompt and tool definitions the transcript was sent with, `learn` among them, and its calls run.
			expect(before.requests).toHaveLength(2);
			expect(withoutCacheControl(afterOff.system)).toBe(withoutCacheControl(first.system));
			expect(first.tools?.map(tool => tool.name)).toContain("learn");
			expect(textOf(afterOff.messages.slice(first.messages.length))).toContain(
				"calls to them are refused from now on: `learn`",
			);
			expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(afterRestart.tools)).toBe(withoutCacheControl(first.tools));

			// The resumed request tells the model that memory is back and `learn` runs again, as the notice of a switch
			// back in one process does; without it the model keeps the earlier notice's word that its calls are refused.
			const resumedContext = textOf(afterRestart.messages.slice(afterOff.messages.length));
			expect(resumedContext).toContain("`memory.backend`");
			expect(resumedContext).toContain("`learn`");
		},
		60_000,
	);
});
