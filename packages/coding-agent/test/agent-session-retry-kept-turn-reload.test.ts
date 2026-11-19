/**
 * A failed turn that automatic retry keeps in context instead of sending it
 * again (a rate limit after visible text, a stream cut after a complete tool
 * call), and whose continuation then succeeds, is still in the model context
 * the session rebuilds from its file, as a resume, a reload or a compaction
 * rebuilds it: the continuation picks up from that turn, so without it the
 * model would never see the first half of the answer, or would see a tool
 * result whose call is gone. A failed turn the retry replaced stays out of
 * that context. The primary model's requests run the real `anthropic-messages`
 * provider; only its HTTP client is replaced, so no request leaves the process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const TOOL_CALL_ID = "toolu_kept_turn";
const FIRST_TEXT = "Here is the first part of the answer";
const CONTINUED_TEXT = ", and here is the rest of it.";

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START_FRAME = sseFrame("message_start", {
	type: "message_start",
	message: {
		id: "msg_kept_turn",
		type: "message",
		role: "assistant",
		model: PRIMARY,
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 1 },
	},
});

const TEXT_FRAMES =
	sseFrame("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	}) +
	sseFrame("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: FIRST_TEXT },
	});

/** Closes the text block and streams a whole `read` tool call after it. */
const COMPLETE_TOOL_CALL_FRAMES =
	sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sseFrame("content_block_start", {
		type: "content_block_start",
		index: 1,
		content_block: { type: "tool_use", id: TOOL_CALL_ID, name: "read", input: {} },
	}) +
	sseFrame("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"path": "/tmp/notes.txt"}' },
	}) +
	sseFrame("content_block_stop", { type: "content_block_stop", index: 1 });

const RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: {
		type: "rate_limit_error",
		message: `This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: ${PRIMARY}).`,
	},
});

/** An overload inside the open message: the provider reports it as a cut stream. */
const OVERLOADED_FRAME = sseFrame("error", {
	type: "error",
	error: { type: "overloaded_error", message: "Overloaded" },
});

/** A whole answer, as the continuation gets it. */
const CONTINUED_ANSWER =
	MESSAGE_START_FRAME +
	sseFrame("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	}) +
	sseFrame("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: CONTINUED_TEXT },
	}) +
	sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sseFrame("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 8 },
	}) +
	sseFrame("message_stop", { type: "message_stop" });

/** The conversation a model request is built from: what each user, assistant and tool-result message holds. */
function conversation(messages: readonly AgentMessage[]): string[] {
	const shapes: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			shapes.push("user");
		} else if (message.role === "toolResult") {
			shapes.push(`result:${message.toolCallId}`);
		} else if (message.role === "assistant") {
			const blocks = message.content.map(block =>
				block.type === "text" ? `text:${block.text}` : block.type === "toolCall" ? `call:${block.id}` : block.type,
			);
			shapes.push(`assistant[${blocks.join(" ")}]`);
		}
	}
	return shapes;
}

describe("automatic retry: a kept turn in the context rebuilt from the session file", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let managers: SessionManager[];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-kept-turn-reload-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(PROVIDER, `${PROVIDER}-test-key`);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		managers = [];
		modelRegistry.clearSuppressedSelectors();
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const manager of managers.splice(0).reverse()) await manager.close();
		vi.restoreAllMocks();
	});

	/**
	 * Sends a prompt whose first primary request streams `failedStream` and
	 * every later one {@link CONTINUED_ANSWER}; then opens the session file
	 * again. Returns the conversation the session holds live and the one it
	 * rebuilds from the file, and the reopened file's failed entry.
	 */
	async function runAndReopen(failedStream: string) {
		let requests = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			const stream = requests++ === 0 ? failedStream : CONTINUED_ANSWER;
			return {
				async asResponse() {
					return new Response(new TextEncoder().encode(stream), {
						status: 200,
						headers: { "content-type": "text/event-stream", "request-id": "req_kept_turn" },
					});
				},
			} as never;
		});
		const model = getBundledModel(PROVIDER, PRIMARY);
		if (!model) throw new Error(`Expected bundled ${PROVIDER}/${PRIMARY}`);
		const agent = new Agent({
			getApiKey: requested => `${requested.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) =>
				streamAnthropic(requested as Model<"anthropic-messages">, context, {
					...options,
					apiKey: `${requested.provider}-test-key`,
					providerRetryWait: async () => {},
				}),
		});
		const sessionsDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionsDir);
		managers.push(sessionManager);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 2,
				"retry.maxDelayMs": 120_000,
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();

		await session.prompt("Answer in two parts");
		await session.waitForIdle();
		await sessionManager.flush();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected the session to persist a file");
		const reopened = await SessionManager.open(sessionFile, sessionsDir, undefined, { suppressBreadcrumb: true });
		managers.push(reopened);
		const failedEntry = reopened
			.getEntries()
			.find(
				entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
		return {
			requests,
			live: conversation(session.agent.state.messages),
			rebuilt: conversation(reopened.buildSessionContext().messages),
			failedEntry,
		};
	}

	// Regression: a rate limit cuts off an answer after its text is on screen,
	// the session waits and the model continues it, and after a resume the
	// model no longer sees the first half of its own answer.
	it("keeps the text of a turn a rate limit cut off, before its continuation", async () => {
		const result = await runAndReopen(MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME);

		expect(result.requests).toBe(2);
		expect(result.rebuilt).toEqual(["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`]);
		expect(result.rebuilt).toEqual(result.live);
		// The transcript still shows the cut-off turn as recovered, and the file says it was kept.
		expect(result.failedEntry).toMatchObject({ message: { retryRecovery: { status: "recovered", kept: true } } });
	});

	// Regression: a rate limit cuts off an answer after its text and a complete
	// tool call, the session waits and the model reissues the call, and after a
	// resume the model sees a tool result whose call is gone, and no longer the
	// first half of its answer.
	it("keeps a turn a rate limit cut off after a complete tool call, with its call and result", async () => {
		const result = await runAndReopen(
			MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + RATE_LIMIT_FRAME,
		);

		expect(result.requests).toBe(2);
		expect(result.rebuilt).toEqual([
			"user",
			`assistant[text:${FIRST_TEXT} call:${TOOL_CALL_ID}]`,
			`result:${TOOL_CALL_ID}`,
			`assistant[text:${CONTINUED_TEXT}]`,
		]);
		expect(result.rebuilt).toEqual(result.live);
		expect(result.failedEntry).toMatchObject({ message: { retryRecovery: { status: "recovered", kept: true } } });
	});

	// Regression: the stream is cut after a complete tool call, the session
	// continues the turn from its tool result, and after a resume the model
	// sees a tool result whose call is gone.
	it("keeps a turn a cut stream ended after a complete tool call, with its call and result", async () => {
		const result = await runAndReopen(
			MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + OVERLOADED_FRAME,
		);

		expect(result.requests).toBe(2);
		expect(result.rebuilt).toEqual([
			"user",
			`assistant[text:${FIRST_TEXT} call:${TOOL_CALL_ID}]`,
			`result:${TOOL_CALL_ID}`,
			`assistant[text:${CONTINUED_TEXT}]`,
		]);
		expect(result.rebuilt).toEqual(result.live);
		expect(result.failedEntry).toMatchObject({ message: { retryRecovery: { status: "recovered", kept: true } } });
	});

	// Regression guard: a failed tool-call turn the retry replaced (its marker
	// does not say kept) has its entries, its synthetic result included, on
	// the path on disk; the rebuilt context must not bring the turn back, or the
	// model would see a turn its live context dropped.
	it("leaves out a failed tool-call turn the retry replaced", async () => {
		const sessionsDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionsDir);
		managers.push(sessionManager);
		const usage: AssistantMessage["usage"] = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const turn = { api: "anthropic-messages", provider: PROVIDER, model: PRIMARY, usage } as const;
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Answer" }], timestamp: 1 });
		sessionManager.appendMessage({
			...turn,
			role: "assistant",
			content: [{ type: "toolCall", id: TOOL_CALL_ID, name: "read", arguments: { path: "/tmp/notes.txt" } }],
			stopReason: "error",
			errorMessage: "503 service unavailable",
			// What the retry writes on a turn it replaced, and every marked turn of a file written before `kept`.
			retryRecovery: {
				kind: "auto-retry",
				status: "recovered",
				attempt: 1,
				recoveredAt: "2026-11-19T00:00:00.000Z",
				recovery: "plain",
				note: "error; retried",
			},
			timestamp: 2,
		});
		const syntheticResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: TOOL_CALL_ID,
			toolName: "read",
			content: [{ type: "text", text: "Tool call was not executed" }],
			details: { __synthetic: true, executed: false },
			isError: true,
			timestamp: 3,
		};
		sessionManager.appendMessage(syntheticResult);
		sessionManager.appendMessage({
			...turn,
			role: "assistant",
			content: [{ type: "text", text: CONTINUED_TEXT }],
			stopReason: "stop",
			timestamp: 4,
		});
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected the session to persist a file");

		const reopened = await SessionManager.open(sessionFile, sessionsDir, undefined, { suppressBreadcrumb: true });
		managers.push(reopened);

		const rebuilt = conversation(reopened.buildSessionContext().messages);
		expect(rebuilt.filter(message => message.startsWith("assistant"))).toEqual([`assistant[text:${CONTINUED_TEXT}]`]);
	});
});
