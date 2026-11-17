import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ObservedPromptCacheEntry } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-status";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** An Anthropic gateway reached on a `.local` host, configured as a deployment's `models.yml` declares it. */
const GATEWAY = "http://gateway.test.local:4000";
const MODELS_YML = `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

interface MessagesRequest {
	system?: unknown;
	tools?: unknown[];
	messages: unknown[];
}

function answer(turn: number): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				// Each reply writes the prompt cache, so a reopened transcript says what its newest reply left there.
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `seen ${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
function withoutCacheControl(value: unknown): string {
	return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
}

/**
 * Whether `later` sends `earlier`'s prompt in cache order, tools, then system, then every message, with the same
 * bytes, so its cache lookup reads all of `earlier`'s prompt.
 */
function continuesCachedPrompt(earlier: MessagesRequest, later: MessagesRequest): boolean {
	return (
		withoutCacheControl(later.tools) === withoutCacheControl(earlier.tools) &&
		withoutCacheControl(later.system) === withoutCacheControl(earlier.system) &&
		withoutCacheControl(later.messages.slice(0, earlier.messages.length)) === withoutCacheControl(earlier.messages)
	);
}

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

	/** One process on the session file (a new session without one): sends each prompt, then exits. */
	async function runProcess(
		tempDir: TempDir,
		inputs: ProcessInputs,
		prompts: string[],
		sessionFile?: string,
	): Promise<ProcessRun> {
		const requests: MessagesRequest[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				return answer(requests.length);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			appendSystemPrompt: inputs.appendSystemPrompt,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: inputs.agentsMd }],
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
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
			fetchSpy.mockRestore();
		}
	}

	it("continues the transcript's cached prompt after a restart that builds another system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
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

	it("builds the system prompt afresh when the operator's appended prompt changed", async () => {
		using tempDir = TempDir.createSync("@pi-resume-system-prompt-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
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
