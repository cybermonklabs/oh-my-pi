import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
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

/** {@link LOCAL_MEMORY} with memory switched off. */
const MEMORY_OFF = `${LONG_ENTRIES}memory:\n  backend: off\n`;

/** A consolidated memory summary the local backend renders. */
const MEMORY_SUMMARY = Array.from({ length: 30 }, (_, index) => `Project fact ${index}: keep it.`).join("\n");

/** Custom entry type a held settings rebuild records on the branch (`SYSTEM_PROMPT_HOLD_CUSTOM_TYPE`). */
const HOLD_RECORD = "system-prompt-hold";

describe("a memory backend switch held on a bound prompt when the process exits", () => {
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

	it("tells the model of the switch, or sends it, at the first request after a restart", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-memory-restart-");
		await Bun.write(`${getMemoryRoot(dir.path(), dir.path())}/memory_summary.md`, `${MEMORY_SUMMARY}\n`);
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());

		// The first process answers once under local memory, then memory is switched off and the process exits
		// before its next request: the switch is held, and no request has carried its notice yet.
		const live = await runProcess(dir, LOCAL_MEMORY, undefined, async (session, settings, overlay) => {
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, [
				"refreshBaseSystemPrompt",
				"reconcileBuiltinTools",
				"holdToolDeclarationChange",
			]);
			await session.settleMemoryBackend();
		});
		// What a session on memory off sends: the prompt the held rebuild commits.
		const fresh = await runProcess(dir, MEMORY_OFF, undefined, async session => {
			await session.prompt("a fresh session");
		});
		// The session is resumed at once, its cache entry warm, with memory off.
		const resumed = await runProcess(dir, MEMORY_OFF, live.sessionFile, async session => {
			await session.prompt("second");
		});

		const [first] = live.requests;
		const [rebuilt] = fresh.requests;
		const [afterRestart] = resumed.requests;
		if (!first || !rebuilt || !afterRestart) throw new Error("Expected the three processes' requests");
		// Preconditions: the first process sent one request and recorded the hold of the switch on the branch, and
		// the switch changes the system prompt (the summary leaves it).
		expect(live.requests).toHaveLength(1);
		const entries = (await Bun.file(live.sessionFile).text())
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(line => JSON.parse(line) as { type?: string; customType?: string });
		expect(entries.some(entry => entry.type === "custom" && entry.customType === HOLD_RECORD)).toBe(true);
		expect(withoutCacheControl(first.system)).toContain("Project fact 1");
		expect(withoutCacheControl(rebuilt.system)).not.toContain("Project fact 1");

		// In one process the next request carries the held switch's notice. The resumed process sends the prompt
		// built under local memory again, and nothing in its context names the switch.
		const told = {
			rebuilt: withoutCacheControl(afterRestart.system) === withoutCacheControl(rebuilt.system),
			noticed: textOf(afterRestart.messages).includes("`memory.backend`"),
		};
		expect(told).not.toEqual({ rebuilt: false, noticed: false });
	}, 60_000);
});
