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
import * as AIError from "@oh-my-pi/pi-ai/error";
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
const FRESH_TEXT = "A fresh answer.";
const MAX_RETRIES = 2;
const MAX_DELAY_MS = 120_000;
const RATE_LIMIT_MESSAGE = "This request would exceed your organization's rate limit.";

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

/** A whole answer whose only text is `text`. */
function answer(text: string): string {
	return (
		MESSAGE_START_FRAME +
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}) +
		sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		}) +
		sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 8 },
		}) +
		sseFrame("message_stop", { type: "message_stop" })
	);
}

/** A whole answer, as the continuation gets it. */
const CONTINUED_ANSWER = answer(CONTINUED_TEXT);

/** What a request to the primary answers: a 200 event stream, or an HTTP refusal. */
type PrimaryAnswer = { stream: string } | { status: number; retryAfterSeconds?: number };

/** An HTTP 429 rate limit at request time. */
const HTTP_RATE_LIMIT: PrimaryAnswer = { status: 429 };

async function primaryResponse(primary: PrimaryAnswer): Promise<Response> {
	const headers = new Headers({ "request-id": "req_kept_turn" });
	if ("stream" in primary) {
		headers.set("content-type", "text/event-stream");
		return new Response(new TextEncoder().encode(primary.stream), { status: 200, headers });
	}
	headers.set("content-type", "application/json");
	if (primary.retryAfterSeconds !== undefined) headers.set("retry-after", String(primary.retryAfterSeconds));
	const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: RATE_LIMIT_MESSAGE } });
	// What the HTTP client throws for a refused request.
	throw await AIError.AnthropicApiError.fromResponse(new Response(body, { status: primary.status, headers }));
}

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
	let sessions: AgentSession[];
	let managers: SessionManager[];
	/** What the primary's next requests answer, in order; the last answers every later one. */
	let primaryAnswers: PrimaryAnswer[];
	let primaryRequests: number;

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
		sessions = [];
		managers = [];
		primaryAnswers = [];
		primaryRequests = 0;
		modelRegistry.clearSuppressedSelectors();
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			primaryRequests++;
			const next = primaryAnswers.length > 1 ? primaryAnswers.shift()! : primaryAnswers[0]!;
			return { asResponse: () => primaryResponse(next) } as never;
		});
		mockSchedulerWaitWithClock();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		for (const manager of managers.splice(0).reverse()) await manager.close();
		vi.restoreAllMocks();
	});

	/** A session on `sessionManager` whose context starts as `messages`, as a resume builds it. */
	function startSession(sessionManager: SessionManager, messages: AgentMessage[] = []): AgentSession {
		const model = getBundledModel(PROVIDER, PRIMARY);
		if (!model) throw new Error(`Expected bundled ${PROVIDER}/${PRIMARY}`);
		const agent = new Agent({
			getApiKey: requested => `${requested.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
			streamFn: (requested, context, options) =>
				streamAnthropic(requested as Model<"anthropic-messages">, context, {
					...options,
					apiKey: `${requested.provider}-test-key`,
					providerRetryWait: async () => {},
				}),
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": MAX_RETRIES,
				"retry.maxDelayMs": MAX_DELAY_MS,
			}),
			modelRegistry,
		});
		sessions.push(session);
		return session;
	}

	/** Writes what `sessionManager` holds to its file and opens that file again, as a resume does. */
	async function reopen(sessionManager: SessionManager): Promise<SessionManager> {
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected the session to persist a file");
		const reopened = await SessionManager.open(sessionFile, path.dirname(sessionFile), undefined, {
			suppressBreadcrumb: true,
		});
		managers.push(reopened);
		return reopened;
	}

	/**
	 * Sends a prompt whose primary requests take `answers` in order (the last
	 * repeating); then opens the session file again. Returns the conversation
	 * the session holds live and the one it rebuilds from the file, and the
	 * reopened file's first failed assistant entry.
	 */
	async function runAndReopen(answers: PrimaryAnswer[]) {
		primaryAnswers = answers;
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		managers.push(sessionManager);
		const session = startSession(sessionManager);

		await session.prompt("Answer in two parts");
		await session.waitForIdle();

		const reopened = await reopen(sessionManager);
		const failedEntry = reopened
			.getEntries()
			.find(
				entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
		return {
			requests: primaryRequests,
			reopened,
			live: conversation(session.agent.state.messages),
			rebuilt: conversation(reopened.buildSessionContext().messages),
			failedEntry,
		};
	}

	// Regression: a rate limit cuts off an answer after its text is on screen,
	// the session waits and the model continues it, and after a resume the
	// model no longer sees the first half of its own answer.
	it("keeps the text of a turn a rate limit cut off, before its continuation", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);

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
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + RATE_LIMIT_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);

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
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + OVERLOADED_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);

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

	// Regression: a rate limit cuts off an answer and every continuation is
	// refused until the attempts are spent; the user resumes the session and
	// retries, and after the next resume the model sees the abandoned first
	// half of the answer in front of the fresh one.
	it("leaves out a kept turn whose continuations all failed, after a resume and a retry", async () => {
		const first = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME },
			HTTP_RATE_LIMIT,
		]);
		expect(first.failedEntry).toMatchObject({ message: { retryRecovery: { status: "superseded" } } });

		primaryAnswers = [{ stream: answer(FRESH_TEXT) }];
		const resumed = startSession(first.reopened, first.reopened.buildSessionContext().messages);
		expect(await resumed.retry()).toBe(true);
		await resumed.waitForIdle();
		const reopened = await reopen(first.reopened);

		const rebuilt = conversation(reopened.buildSessionContext().messages);
		expect(rebuilt).toEqual(["user", `assistant[text:${FRESH_TEXT}]`]);
		expect(rebuilt).toEqual(conversation(resumed.agent.state.messages));
	});

	// Every other end of a run that kept a turn (here a stated wait past
	// retry.maxDelayMs on its continuation) marks no `kept`, so the rebuild
	// leaves the turn out, as it did before `kept` existed.
	it("leaves out a kept turn whose continuation stated a wait past retry.maxDelayMs", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME },
			{ ...HTTP_RATE_LIMIT, retryAfterSeconds: 600 },
		]);

		expect(result.rebuilt).toEqual(["user"]);
		expect(result.failedEntry).toMatchObject({ message: { content: [{ type: "text", text: FIRST_TEXT }] } });
		expect(result.failedEntry).not.toMatchObject({ message: { retryRecovery: { kept: true } } });
	});

	// Regression guard: a failed tool-call turn the retry replaced (its marker
	// does not say kept) has its entries, its synthetic result included, on
	// the path on disk; the rebuilt context must not bring the turn back, or the
	// model would see a turn its live context dropped.
	it("leaves out a failed tool-call turn the retry replaced", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
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
		const reopened = await reopen(sessionManager);

		const rebuilt = conversation(reopened.buildSessionContext().messages);
		expect(rebuilt.filter(message => message.startsWith("assistant"))).toEqual([`assistant[text:${CONTINUED_TEXT}]`]);
	});
});
