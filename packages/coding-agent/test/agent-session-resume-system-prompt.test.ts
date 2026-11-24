import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ObservedPromptCacheEntry } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-status";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/**
 * What one process builds its prompt from: a context file whose text differs between runs, the operator's role text,
 * and the `--config` overlay its settings load (long cache retention without one).
 */
interface ProcessInputs {
	agentsMd: string;
	appendSystemPrompt: string;
	overlay?: string;
}

interface ProcessRun {
	requests: MessagesRequest[];
	sessionFile: string;
	/** The `system-prompt-digest` records on the branch when the process exits. */
	promptDigests: unknown[];
	/** The prompt-cache entry the transcript left, as the process judged it before its first request. */
	cacheEntryAtStart: ObservedPromptCacheEntry | undefined;
}

const ROLE = "You review the parser changes of this repository.";

/** An overlay that asks for the one-hour cache entries every reply writes. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

const MINUTE_MS = 60_000;

/** The real clock, read before any test moves it. */
const realNow = Date.now.bind(Date);

/** Moves the clock `offsetMs` ahead of real time from now on. */
function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

describe("system prompt of a resumed session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one): runs `startup` as the process's own startup
	 * steps would before any prompt, sends each prompt, then exits.
	 */
	async function runProcess(
		tempDir: TempDir,
		inputs: ProcessInputs,
		prompts: string[],
		sessionFile?: string,
		startup?: (session: AgentSession, sessionManager: SessionManager, settings: Settings) => Promise<void>,
	): Promise<ProcessRun> {
		// Each reply writes the prompt cache, so a reopened transcript says what its newest reply left there.
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const settings = inputs.overlay
			? await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path(), configFiles: [inputs.overlay] })
			: Settings.isolated({ "providers.cacheRetention": "long" });
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			appendSystemPrompt: inputs.appendSystemPrompt,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: inputs.agentsMd }],
			skills: [],
		});
		try {
			await startup?.(session, sessionManager, settings);
			const cacheEntryAtStart = session.observedPromptCacheEntry();
			for (const text of prompts) await session.prompt(text);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			const promptDigests = sessionManager
				.getBranchView()
				.flatMap(entry =>
					entry.type === "custom" && entry.customType === "system-prompt-digest" ? [entry.data] : [],
				);
			return { requests, sessionFile: file, promptDigests, cacheEntryAtStart };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	it("continues the transcript's cached prompt after a restart that builds another system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, { agentsMd: "Build with make.", appendSystemPrompt: ROLE }, [
			"first",
			"second",
		]);
		// The context file changed while no process ran: the new process's own build differs.
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", appendSystemPrompt: ROLE },
			["third"],
			live.sessionFile,
		);

		const lastBefore = live.requests.at(-1);
		if (!lastBefore) throw new Error("Expected the first process's requests");
		expect(withoutCacheControl(resumed.requests[0]?.system)).toBe(withoutCacheControl(lastBefore.system));
		expect(continuesCachedPrompt(lastBefore, resumed.requests[0]!)).toBe(true);
		// The cache status reads the transcript's entry as one the next request still reads.
		expect(resumed.cacheEntryAtStart).toMatchObject({ inferred: true });
		expect(resumed.cacheEntryAtStart?.change).toBeUndefined();
		// The resumed reply was produced under the recorded prompt, so nothing new is recorded for it.
		expect(resumed.promptDigests).toEqual(live.promptDigests);
	}, 30_000);

	/**
	 * A CLI process's extension tools register after the session is built, as a tool-set apply. `eval`'s
	 * description lists the tools a cell can call, so the tool definitions follow the set too.
	 */
	const registerExtensionTools = (session: AgentSession) =>
		session.setActiveToolPresentation(["read", "bash", "eval"], []);

	it("keeps the transcript's cached prompt through a startup rebuild that changes nothing of its own", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(
			tempDir,
			{ agentsMd: "Build with make.", appendSystemPrompt: ROLE },
			["first"],
			undefined,
			registerExtensionTools,
		);
		// Then, before the first request, an extension's startup skill discovery (or a memory backend) rebuilds the
		// prompt from the inputs the process started with.
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", appendSystemPrompt: ROLE },
			["second"],
			live.sessionFile,
			async session => {
				await registerExtensionTools(session);
				await session.refreshBaseSystemPrompt();
			},
		);

		const lastBefore = live.requests.at(-1);
		if (!lastBefore) throw new Error("Expected the first process's requests");
		expect(continuesCachedPrompt(lastBefore, resumed.requests[0]!)).toBe(true);
		expect(resumed.promptDigests).toEqual(live.promptDigests);
	}, 30_000);

	it("sends a startup rebuild that changes the prompt, such as an added workspace directory", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		await Bun.write(tempDir.join("added-workspace-root/README.md"), "A second root.\n");
		const live = await runProcess(
			tempDir,
			{ agentsMd: "Build with make.", appendSystemPrompt: ROLE },
			["first"],
			undefined,
			registerExtensionTools,
		);
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", appendSystemPrompt: ROLE },
			["second"],
			live.sessionFile,
			async (session, sessionManager) => {
				await registerExtensionTools(session);
				// `/add-dir` before the first prompt.
				await sessionManager.addWorkspaceDirectory(tempDir.join("added-workspace-root"));
				await session.refreshBaseSystemPrompt();
			},
		);

		const system = withoutCacheControl(resumed.requests[0]?.system);
		expect(system).toContain("added-workspace-root");
		expect(system).toContain("Build with ninja.");
	}, 30_000);

	it("builds the system prompt afresh when the operator's appended prompt changed", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, { agentsMd: "Build with make.", appendSystemPrompt: ROLE }, ["first"]);
		const newRole = "You write the lexer of this repository.";
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with make.", appendSystemPrompt: newRole },
			["second"],
			live.sessionFile,
		);

		const system = withoutCacheControl(resumed.requests[0]?.system);
		expect(system).toContain(newRole);
		expect(system).not.toContain(ROLE);
	}, 30_000);

	// The stored prompt is kept for the transcript's live cache entry, but what this process's own build would change
	// (here a context file edited between the processes) waits at most five minutes, however often calls keep the
	// entry warm; a further restart does not start the five minutes again.
	it("sends this process's own build at the first request five minutes after the restore, a restart included", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, { agentsMd: "Build with make.", appendSystemPrompt: ROLE }, ["first"]);
		const inputs = { agentsMd: "Build with ninja.", appendSystemPrompt: ROLE };
		// A call every minute keeps the one-hour entry warm.
		const callEveryMinute = (from: number, to: number) => async (session: AgentSession) => {
			for (let minute = from; minute <= to; minute++) {
				setClock(minute * MINUTE_MS);
				await session.prompt(`a call at minute ${minute}`);
			}
		};
		const restored = await runProcess(tempDir, inputs, [], live.sessionFile, callEveryMinute(0, 2));
		const restarted = await runProcess(tempDir, inputs, [], live.sessionFile, callEveryMinute(3, 5));

		const stored = withoutCacheControl(live.requests[0]?.system);
		const sent = [...restored.requests, ...restarted.requests].map(request => withoutCacheControl(request.system));
		expect(sent).toHaveLength(6);
		expect(sent.slice(0, 5)).toEqual(Array<string>(5).fill(stored));
		expect(sent[5]).toContain("Build with ninja.");
		expect(sent[5]).not.toContain("Build with make.");
	}, 30_000);

	// A settings change held on the bound prompt when the first process stopped is still withheld by the prompt the
	// resumed process restores: it goes out five minutes after the change, not five minutes after the restart.
	it("sends a settings change held before a restart at the first request five minutes after the change", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, OVERLAY);
		const inputs = { agentsMd: "Build with make.", appendSystemPrompt: ROLE, overlay };
		const live = await runProcess(tempDir, inputs, [], undefined, async (session, _sessionManager, settings) => {
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, `${OVERLAY}personality: pragmatic\n`);
			await session.prompt("second");
		});
		// What a process started on the changed settings sends.
		const fresh = await runProcess(tempDir, inputs, ["a fresh session"]);

		setClock(3 * MINUTE_MS);
		const resumed = await runProcess(tempDir, inputs, [], live.sessionFile, async session => {
			await session.prompt("three minutes after the change");
			setClock(5 * MINUTE_MS);
			await session.prompt("five minutes after the change");
		});

		const bound = withoutCacheControl(live.requests[0]?.system);
		// Precondition: the first process held the change on its bound prompt.
		expect(withoutCacheControl(live.requests[1]?.system)).toBe(bound);
		const [beforeBound, atBound] = resumed.requests.map(request => withoutCacheControl(request.system));
		expect(beforeBound).toBe(bound);
		expect(atBound).toBe(withoutCacheControl(fresh.requests[0]?.system));
	}, 60_000);
});
