import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ObservedPromptCacheEntry } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-status";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** What one process builds its prompt from: a context file whose text differs between runs, and the operator's role text. */
interface ProcessInputs {
	agentsMd: string;
	appendSystemPrompt: string;
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
		startup?: (session: AgentSession, sessionManager: SessionManager) => Promise<void>,
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
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			appendSystemPrompt: inputs.appendSystemPrompt,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: inputs.agentsMd }],
			skills: [],
		});
		try {
			await startup?.(session, sessionManager);
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
});
