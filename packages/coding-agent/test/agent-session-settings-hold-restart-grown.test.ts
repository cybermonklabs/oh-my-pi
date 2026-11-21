import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
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

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The local memory backend, which renders the project's consolidated summary in the system prompt. */
const LOCAL_MEMORY = `${LONG_ENTRIES}memory:\n  backend: local\n`;

/** {@link LOCAL_MEMORY} with another personality. */
const PRAGMATIC = `${LOCAL_MEMORY}personality: pragmatic\n`;

/** {@link PRAGMATIC} with memory switched off. */
const PRAGMATIC_MEMORY_OFF = `${LONG_ENTRIES}memory:\n  backend: off\npersonality: pragmatic\n`;

/** A consolidated memory summary the local backend renders. */
const MEMORY_SUMMARY = Array.from({ length: 30 }, (_, index) => `Project fact ${index}: keep it.`).join("\n");

describe("a held settings change that takes in another setting after its notice, across a restart", () => {
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

	it("tells the resumed model of the setting the hold took in after the notice the transcript carries", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-restart-grown-");
		await Bun.write(`${getMemoryRoot(dir.path(), dir.path())}/memory_summary.md`, `${MEMORY_SUMMARY}\n`);
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());

		// The first process holds a personality change and tells the model of it at its second request; then memory is
		// switched off, which the hold takes in, and the process exits before its next request.
		const live = await runProcess(dir, LOCAL_MEMORY, undefined, async (session, settings, overlay) => {
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, PRAGMATIC, RELOAD_CALLS);
			await session.prompt("second");
			await reloadOverlay({ session, settings, overlay }, PRAGMATIC_MEMORY_OFF, RELOAD_CALLS);
			await session.settleMemoryBackend();
		});
		// The session is resumed at once, its cache entry warm, on the settings the first process ended with.
		const resumed = await runProcess(dir, PRAGMATIC_MEMORY_OFF, live.sessionFile, async session => {
			await session.prompt("third");
		});

		const [first, second] = live.requests;
		const [third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Preconditions: the personality change was held and its notice went out with the second request, which named
		// nothing of memory; the resumed process sends the held prompt again, the summary in it.
		expect(live.requests).toHaveLength(2);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`personality`");
		expect(textOf(second.messages)).not.toContain("`memory.backend`");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(third.system)).toContain("Project fact 1");

		// The resumed request tells the model that memory is off although the prompt still renders the summary.
		expect(textOf(third.messages.slice(second.messages.length))).toContain('`memory.backend`: `"local"` → `"off"`');
	}, 60_000);
});
