import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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

const MEMORIES = "<memories>\nRelevant memories:\n\n- The deploy host is alpha-7.\n</memories>";

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

/**
 * A memory backend that behaves as Hindsight does: each turn retries a recall until one succeeds, and once one
 * is adopted the memory instructions of every later prompt build carry it. The first `failures` recalls fail;
 * with `reused`, the recall is the one the resumed transcript recorded.
 */
function recallingBackend(failures: number, reused = false): MemoryBackend {
	let attempts = 0;
	let adopted: string | undefined;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return adopted ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (adopted !== undefined || ++attempts <= failures) return undefined;
			return {
				context: MEMORIES,
				reused,
				commit: () => {
					adopted = MEMORIES;
					return true;
				},
			};
		},
	};
}

interface ProcessRun {
	requests: MessagesRequest[];
	sessionFile: string;
}

describe("memory recall in a conversation whose prompt is bound", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) with `backend`: sends each prompt, then exits. */
	async function runProcess(
		tempDir: TempDir,
		backend: MemoryBackend,
		prompts: string[],
		sessionFile?: string,
	): Promise<ProcessRun> {
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const requests: MessagesRequest[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				return answer(requests.length);
			}),
		);
		const backendSpy = vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(backend);
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
			toolNames: ["read"],
			contextFiles: [],
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			for (const text of prompts) await session.prompt(text);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			backendSpy.mockRestore();
			fetchSpy.mockRestore();
		}
	}

	it("sends a recall that first succeeds after a failed one after the newest content, keeping the system blocks", async () => {
		using tempDir = TempDir.createSync("@pi-late-memory-recall-");
		const { requests } = await runProcess(tempDir, recallingBackend(1), ["first", "second", "third"]);
		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");

		expect(withoutCacheControl(first.system)).not.toContain("alpha-7");
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		// The recall rides the second turn's new messages, then stays in the replayed history.
		expect(withoutCacheControl(second.messages.slice(first.messages.length))).toContain("alpha-7");
		expect(continuesCachedPrompt(second, third)).toBe(true);
	}, 30_000);

	it("keeps a recall the resumed transcript carries after its content out of the system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-late-memory-recall-");
		const live = await runProcess(tempDir, recallingBackend(1), ["first", "second"]);
		const resumed = await runProcess(tempDir, recallingBackend(0, true), ["third"], live.sessionFile);

		const lastBefore = live.requests.at(-1);
		const firstAfter = resumed.requests[0];
		if (!lastBefore || !firstAfter) throw new Error("Expected requests before and after the resume");
		expect(withoutCacheControl(firstAfter.system)).not.toContain("alpha-7");
		expect(continuesCachedPrompt(lastBefore, firstAfter)).toBe(true);
	}, 30_000);

	it("keeps a first-turn recall in the system prompt for the whole conversation", async () => {
		using tempDir = TempDir.createSync("@pi-late-memory-recall-");
		const { requests } = await runProcess(tempDir, recallingBackend(0), ["first", "second"]);
		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected two requests");

		expect(withoutCacheControl(first.system)).toContain("alpha-7");
		expect(withoutCacheControl(first.messages)).not.toContain("alpha-7");
		expect(continuesCachedPrompt(first, second)).toBe(true);
	}, 30_000);
});
