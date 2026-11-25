/**
 * Rate limits an Anthropic 200 response stream reports as a `rate_limit_error`
 * frame, each with a context under and over `retry.rateLimitFallbackMaxContextTokens`
 * (default 100,000):
 *
 * - a frame after `message_start` is sent once per session attempt: the
 *   provider does not send the same request again on its own before the
 *   session waits, and a stated wait past `retry.maxDelayMs` walks a small
 *   context at once and ends a large one;
 * - a frame after visible text and a complete tool call waits, then continues
 *   on the same model;
 * - after a rate limit cut an answer off, a continuation that an overload, a
 *   server error or a usage limit refuses walks `retry.fallbackChains` at that
 *   refusal, as a continuation after a dropped stream does.
 *
 * The primary model's requests run the real `anthropic-messages` provider; only
 * its HTTP client is replaced, so no request leaves the process. Chain models
 * answer from a stub stream.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const MAX_RETRIES = 2;
const MAX_DELAY_MS = 120_000;
const THRESHOLD_TOKENS = 100_000;
/** Past {@link MAX_DELAY_MS}. */
const LONG_STATED_WAIT_SECONDS = 600;

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];
const SPENT_ON_PRIMARY = Array.from({ length: MAX_RETRIES + 1 }, () => PRIMARY);

const CONTEXTS = {
	/** Roughly 150,000 tokens of prompt text, over the threshold by any count. */
	large: "word ".repeat(150_000),
	small: "Answer after the rate limit",
} as const;
type ContextSize = keyof typeof CONTEXTS;

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START_FRAME = sseFrame("message_start", {
	type: "message_start",
	message: {
		id: "msg_rate_limit_r6",
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
		delta: { type: "text_delta", text: "Here is the first part of the answer" },
	});

/** Closes the text block and streams a whole `read` tool call after it. */
const COMPLETE_TOOL_CALL_FRAMES =
	sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sseFrame("content_block_start", {
		type: "content_block_start",
		index: 1,
		content_block: { type: "tool_use", id: "toolu_rate_limit_r6", name: "read", input: {} },
	}) +
	sseFrame("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"path": "/tmp/notes.txt"}' },
	}) +
	sseFrame("content_block_stop", { type: "content_block_stop", index: 1 });

const RATE_LIMIT_MESSAGE = `This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: ${PRIMARY}). Reduce the prompt length or the maximum tokens requested, or try again later.`;

/** The frame the Anthropic API streams for a per-minute rate limit; it states no wait. */
const RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: { type: "rate_limit_error", message: RATE_LIMIT_MESSAGE },
});

/** A rate-limit frame whose message states a wait past {@link MAX_DELAY_MS}. */
const LONG_WAIT_RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: {
		type: "rate_limit_error",
		message: `${RATE_LIMIT_MESSAGE} Please retry after ${LONG_STATED_WAIT_SECONDS} seconds.`,
	},
});

const CONTINUED_TEXT = ", and here is the rest of it.";

/** A whole answer, as the continuation after a rate limit gets it. */
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

/** What a request to the primary answers: a 200 event stream, or an HTTP refusal. */
type PrimaryAnswer = { stream: string } | { status: number; errorType: string; message: string };

function bundledModel(id: string): Model<Api> {
	const model = getBundledModel(PROVIDER, id);
	if (!model) throw new Error(`Expected bundled ${PROVIDER}/${id}`);
	return model;
}

/** A plain-text answer from a chain model. */
function answerStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

async function primaryResponse(answer: PrimaryAnswer): Promise<Response> {
	const headers = new Headers({ "request-id": "req_rate_limit_r6" });
	if ("stream" in answer) {
		headers.set("content-type", "text/event-stream");
		return new Response(new TextEncoder().encode(answer.stream), { status: 200, headers });
	}
	headers.set("content-type", "application/json");
	const body = JSON.stringify({ type: "error", error: { type: answer.errorType, message: answer.message } });
	// What the HTTP client throws for a refused request.
	throw await AIError.AnthropicApiError.fromResponse(new Response(body, { status: answer.status, headers }));
}

describe("rate-limit retry: frames in a 200 stream, round six", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-r6-");
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
		modelRegistry.clearSuppressedSelectors();
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	/**
	 * Sends `prompt`; the primary's HTTP requests take `answers` in order (the
	 * last repeating), every chain model answers. `timeline` lists, in order,
	 * each model request the session made (`request:<id>`) and each
	 * `auto_retry_start` (`wait:<delayMs>`).
	 */
	async function runTurn(answers: readonly PrimaryAnswer[], prompt: string) {
		let primaryBodies = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				({
					asResponse: () => primaryResponse(answers[Math.min(primaryBodies++, answers.length - 1)]!),
				}) as never,
		);
		const requestedModels: string[] = [];
		const timeline: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: bundledModel(PRIMARY), systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(model.id);
				timeline.push(`request:${model.id}`);
				if (model.id === PRIMARY) {
					return streamAnthropic(model as Model<"anthropic-messages">, context, {
						...options,
						apiKey: `${model.provider}-test-key`,
						providerRetryWait: async () => {},
					});
				}
				return answerStream(model, `Answered on ${model.id}`);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": MAX_RETRIES,
				"retry.maxDelayMs": MAX_DELAY_MS,
				"retry.fallbackChains": { [`${PROVIDER}/${PRIMARY}`]: CHAIN.map(id => `${PROVIDER}/${id}`) },
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const current = session;
		const fallbackTargets: string[] = [];
		const retryEndErrors: string[] = [];
		let contextTokensAtFirstFailure: number | undefined;
		current.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
			if (event.type === "auto_retry_start") timeline.push(`wait:${event.delayMs}`);
			if (event.type === "auto_retry_end" && event.finalError) retryEndErrors.push(event.finalError);
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				contextTokensAtFirstFailure ??= current.getContextUsage()?.tokens;
			}
		});

		await current.prompt(prompt);
		await current.waitForIdle();

		// The conversation's last message: the answer, or the error that ended the turn.
		const last = current.messages.at(-1);
		return {
			primaryBodies,
			primaryAttempts: requestedModels.filter(id => id === PRIMARY).length,
			requestedModels,
			timeline,
			fallbackTargets,
			retryEndErrors,
			contextTokensAtFirstFailure,
			last,
			model: current.model?.id,
		};
	}

	function expectContextSize(tokens: number | undefined, size: ContextSize): void {
		if (size === "large") expect(tokens).toBeGreaterThan(THRESHOLD_TOKENS);
		else expect(tokens).toBeLessThan(THRESHOLD_TOKENS);
	}

	describe("a rate_limit_error frame after message_start", () => {
		for (const size of ["small", "large"] as const) {
			// Regression: a user hits a per-minute rate limit that the API reports
			// after the response began, and the session sends the same request to
			// the rate-limited model ten more times within a minute, the whole
			// context each time, before it waits at all, so one prompt costs
			// thirty-odd requests against the limit instead of one per attempt.
			it(`states no wait, ${size} context: sends one request per attempt, at most retry.maxRetries + 1`, async () => {
				const result = await runTurn([{ stream: MESSAGE_START_FRAME + RATE_LIMIT_FRAME }], CONTEXTS[size]);

				expectContextSize(result.contextTokensAtFirstFailure, size);
				expect(result.primaryBodies).toBe(result.primaryAttempts);
				expect(result.primaryBodies).toBeLessThanOrEqual(MAX_RETRIES + 1);
				if (size === "small") {
					expect(result.requestedModels).toEqual([...SPENT_ON_PRIMARY, CHAIN[0]]);
					expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
					expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
				} else {
					expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
					expect(result.fallbackTargets).toEqual([]);
					expect(result.last).toMatchObject({
						role: "assistant",
						stopReason: "error",
						errorMessage: expect.stringContaining("rate_limit_error"),
					});
				}
			});
		}

		// Regression: a user in a small session hits a rate limit that asks for a
		// ten-minute wait, and the session sends the same request ten more times
		// within a minute, against the wait the provider asked for, before it
		// moves to the next model in the chain.
		it("states a wait past retry.maxDelayMs, small context: walks the chain at once, with no request sent again", async () => {
			const result = await runTurn([{ stream: MESSAGE_START_FRAME + LONG_WAIT_RATE_LIMIT_FRAME }], CONTEXTS.small);

			expectContextSize(result.contextTokensAtFirstFailure, "small");
			expect(result.primaryBodies).toBe(1);
			expect(result.requestedModels).toEqual([PRIMARY, CHAIN[0]]);
			expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
			expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
		});

		// Regression: a user with a large session hits a rate limit that asks for
		// a ten-minute wait, and the session sends the whole large context to the
		// rate-limited model ten more times within a minute before it shows the
		// provider's error.
		it("states a wait past retry.maxDelayMs, large context: ends on the same model, with no request sent again", async () => {
			const result = await runTurn([{ stream: MESSAGE_START_FRAME + LONG_WAIT_RATE_LIMIT_FRAME }], CONTEXTS.large);

			expectContextSize(result.contextTokensAtFirstFailure, "large");
			expect(result.primaryBodies).toBe(1);
			expect(result.requestedModels).toEqual([PRIMARY]);
			expect(result.fallbackTargets).toEqual([]);
			expect(result.model).toBe(PRIMARY);
			expect(result.last).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: expect.stringContaining("rate_limit_error"),
			});
		});
	});

	describe("a rate_limit_error frame after visible text and a complete tool call", () => {
		for (const size of ["small", "large"] as const) {
			// Regression: a user watches an answer stream its text and a tool call,
			// a rate limit cuts it off, and the turn stops at once on the
			// rate-limit error, instead of waiting for the limit to clear and then
			// going on with the answer on the same model.
			it(`${size} context: waits, then continues on the same model`, async () => {
				const result = await runTurn(
					[
						{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + RATE_LIMIT_FRAME },
						{ stream: CONTINUED_ANSWER },
					],
					CONTEXTS[size],
				);

				expectContextSize(result.contextTokensAtFirstFailure, size);
				const firstWait = result.timeline.findIndex(
					entry => entry.startsWith("wait:") && Number(entry.slice("wait:".length)) > 0,
				);
				expect(firstWait).toBeGreaterThan(-1);
				expect(result.timeline.slice(firstWait + 1)).toContain(`request:${PRIMARY}`);
				expect(result.requestedModels).toEqual([PRIMARY, PRIMARY]);
				expect(result.fallbackTargets).toEqual([]);
				expect(result.model).toBe(PRIMARY);
				expect(result.last).toMatchObject({ stopReason: "stop", model: PRIMARY });
			});
		}
	});

	describe("a continuation after a rate limit cut the answer off, refused before it streams", () => {
		const refusals: { name: string; refusal: PrimaryAnswer }[] = [
			{
				name: "an HTTP 529 overload",
				refusal: { status: 529, errorType: "overloaded_error", message: "Overloaded" },
			},
			{
				name: "an HTTP 500 server error",
				refusal: { status: 500, errorType: "api_error", message: "Internal server error" },
			},
			{
				name: "an HTTP 429 usage limit",
				refusal: {
					status: 429,
					errorType: "rate_limit_error",
					message: "Claude usage limit reached. Your limit will reset at 5pm.",
				},
			},
		];
		for (const { name, refusal } of refusals) {
			// Regression: a user's answer is cut off by a rate limit, and when the
			// model that would continue it is overloaded, failing or out of usage,
			// the session keeps retrying that model and then shows its error,
			// instead of moving to the next model in the chain at that refusal as
			// it does when a dropped stream cut the answer off.
			it(`${name}, small context: walks the chain at that refusal`, async () => {
				const result = await runTurn(
					[{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME }, refusal],
					CONTEXTS.small,
				);

				expectContextSize(result.contextTokensAtFirstFailure, "small");
				expect(result.requestedModels).toEqual([PRIMARY, PRIMARY, CHAIN[0]]);
				expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
				expect(result.model).toBe(CHAIN[0]);
				expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
			});
		}
	});
});
