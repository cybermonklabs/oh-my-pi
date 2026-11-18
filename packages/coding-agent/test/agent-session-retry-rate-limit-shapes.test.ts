/**
 * The rate-limit wait over every shape an Anthropic refusal reaches the session
 * in, each with a context under and over `retry.rateLimitFallbackMaxContextTokens`
 * (default 100,000): a `rate_limit_error` frame in a 200 stream before
 * `message_start`, after it, and after streamed text; an HTTP 429 with no wait,
 * a stated wait, and a stated wait past `retry.maxDelayMs`; and an overload (an
 * HTTP 529 and an `overloaded_error` frame). A rate limit retries the same model
 * after the stated wait or the built-in backoff, walks `retry.fallbackChains`
 * only once the attempts are spent or the stated wait is past
 * `retry.maxDelayMs`, and never walks a context over the threshold; an overload
 * keeps the walk at its first failure. A rate limit after streamed text waits
 * the same way, then continues the answer on the same model, and never walks.
 * The built-in backoff is never read as a stated wait. The primary model's
 * requests run the real `anthropic-messages` provider; only its HTTP client is
 * replaced, so no request leaves the process. Chain models answer from a stub
 * stream.
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
/** Below {@link BACKOFF_MS}. */
const SHORT_MAX_DELAY_MS = 10_000;
/** The session's backoff for a rate limit that states no wait. */
const BACKOFF_MS = 30_000;
const STATED_WAIT_SECONDS = 20;
/** Past {@link MAX_DELAY_MS}. */
const LONG_STATED_WAIT_SECONDS = 600;
const THRESHOLD_TOKENS = 100_000;

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];
const SPENT_ON_PRIMARY = Array.from({ length: MAX_RETRIES + 1 }, () => PRIMARY);

const CONTEXTS = {
	/** Roughly 150,000 tokens of prompt text, over the threshold by any count. */
	large: "word ".repeat(150_000),
	small: "Answer after the refusal",
} as const;
type ContextSize = keyof typeof CONTEXTS;

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START_FRAME = sseFrame("message_start", {
	type: "message_start",
	message: {
		id: "msg_refusal_shape",
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

const RATE_LIMIT_MESSAGE = `This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: ${PRIMARY}). Reduce the prompt length or the maximum tokens requested, or try again later.`;

const RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: { type: "rate_limit_error", message: RATE_LIMIT_MESSAGE },
});

const OVERLOADED_FRAME = sseFrame("error", {
	type: "error",
	error: { type: "overloaded_error", message: "Overloaded" },
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

/** A rate limit after streamed text whose message states a wait past {@link MAX_DELAY_MS}. */
const LONG_WAIT_RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: {
		type: "rate_limit_error",
		message: `${RATE_LIMIT_MESSAGE} Please retry after ${LONG_STATED_WAIT_SECONDS} seconds.`,
	},
});

/** What a request to the primary answers: a 200 event stream, or an HTTP refusal. */
type PrimaryAnswer =
	| { stream: string }
	| { status: number; errorType: string; message: string; retryAfterSeconds?: number };

/**
 * What the turn does. `waits`: the primary is retried until its attempts are
 * spent, each retry after `waitMs`; then a small context walks to the next
 * chain entry and a large one ends with the provider's error. `walks`: a
 * small context walks at the first failure, a large one ends there.
 * `continues`: after `waitMs` the primary is asked once more, to continue the
 * answer it had streamed, and the turn ends with that continuation.
 * `spent`: every context retries the primary, each after `waitMs`, until its
 * attempts are spent, then ends with the provider's error. `ends`: every
 * context ends at the first failure with the provider's error, on the same
 * model. `overload`: every context walks at the first failure.
 */
type Outcome =
	| { kind: "waits"; waitMs: number }
	| { kind: "walks" }
	| { kind: "continues"; waitMs: number }
	| { kind: "spent"; waitMs: number }
	| { kind: "ends" }
	| { kind: "overload" };

interface Shape {
	name: string;
	/** The primary's answers, in request order; the last answers every later request. */
	answers: readonly PrimaryAnswer[];
	outcome: Outcome;
	maxDelayMs?: number;
}

const SHAPES: Shape[] = [
	{
		name: "a rate_limit_error frame before message_start",
		answers: [{ stream: RATE_LIMIT_FRAME }],
		outcome: { kind: "waits", waitMs: BACKOFF_MS },
	},
	{
		name: "a rate_limit_error frame after message_start",
		answers: [{ stream: MESSAGE_START_FRAME + RATE_LIMIT_FRAME }],
		outcome: { kind: "waits", waitMs: BACKOFF_MS },
	},
	{
		name: "a rate_limit_error frame after a text delta",
		answers: [{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME }, { stream: CONTINUED_ANSWER }],
		outcome: { kind: "continues", waitMs: BACKOFF_MS },
	},
	{
		name: "a rate_limit_error frame after a text delta on every request",
		answers: [{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME }],
		outcome: { kind: "spent", waitMs: BACKOFF_MS },
	},
	{
		name: "a rate_limit_error frame after a text delta stating a wait past retry.maxDelayMs",
		answers: [
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + LONG_WAIT_RATE_LIMIT_FRAME },
			{ stream: CONTINUED_ANSWER },
		],
		outcome: { kind: "ends" },
	},
	{
		name: "an HTTP 429 that states no wait",
		answers: [{ status: 429, errorType: "rate_limit_error", message: RATE_LIMIT_MESSAGE }],
		outcome: { kind: "waits", waitMs: BACKOFF_MS },
	},
	{
		name: "an HTTP 429 that states a wait",
		answers: [
			{
				status: 429,
				errorType: "rate_limit_error",
				message: RATE_LIMIT_MESSAGE,
				retryAfterSeconds: STATED_WAIT_SECONDS,
			},
		],
		outcome: { kind: "waits", waitMs: STATED_WAIT_SECONDS * 1000 },
	},
	{
		name: "an HTTP 429 that states a wait past retry.maxDelayMs",
		answers: [
			{
				status: 429,
				errorType: "rate_limit_error",
				message: RATE_LIMIT_MESSAGE,
				retryAfterSeconds: LONG_STATED_WAIT_SECONDS,
			},
		],
		outcome: { kind: "walks" },
	},
	// The built-in backoff is not a stated wait: under a retry.maxDelayMs below
	// it, the session waits the cap and retries, and never reports a wait the
	// provider asked for.
	{
		name: "an HTTP 429 that states no wait, under a retry.maxDelayMs below the backoff",
		answers: [{ status: 429, errorType: "rate_limit_error", message: RATE_LIMIT_MESSAGE }],
		outcome: { kind: "waits", waitMs: SHORT_MAX_DELAY_MS },
		maxDelayMs: SHORT_MAX_DELAY_MS,
	},
	{
		name: "a rate_limit_error frame after message_start, under a retry.maxDelayMs below the backoff",
		answers: [{ stream: MESSAGE_START_FRAME + RATE_LIMIT_FRAME }],
		outcome: { kind: "waits", waitMs: SHORT_MAX_DELAY_MS },
		maxDelayMs: SHORT_MAX_DELAY_MS,
	},
	{
		name: "an HTTP 529 overload",
		answers: [{ status: 529, errorType: "overloaded_error", message: "Overloaded" }],
		outcome: { kind: "overload" },
	},
	{
		name: "an overloaded_error frame before message_start",
		answers: [{ stream: OVERLOADED_FRAME }],
		outcome: { kind: "overload" },
	},
];

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
	const headers = new Headers({ "request-id": "req_refusal_shape" });
	if ("stream" in answer) {
		headers.set("content-type", "text/event-stream");
		return new Response(new TextEncoder().encode(answer.stream), { status: 200, headers });
	}
	headers.set("content-type", "application/json");
	if (answer.retryAfterSeconds !== undefined) headers.set("retry-after", String(answer.retryAfterSeconds));
	const body = JSON.stringify({ type: "error", error: { type: answer.errorType, message: answer.message } });
	// What the HTTP client throws for a refused request.
	throw await AIError.AnthropicApiError.fromResponse(new Response(body, { status: answer.status, headers }));
}

describe("rate-limit retry across the shapes of a refusal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-shapes-");
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

	/** Sends `prompt`; the primary's requests take `answers` in order (the last repeating), every chain model answers. */
	async function runRefusedTurn(answers: readonly PrimaryAnswer[], prompt: string, maxDelayMs: number) {
		let primaryRequests = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				({
					asResponse: () => primaryResponse(answers[Math.min(primaryRequests++, answers.length - 1)]!),
				}) as never,
		);
		const requestedModels: string[] = [];
		// A request to the primary after the first that no `auto_retry_start`
		// with a wait preceded: the session sent it again at once.
		let immediatePrimaryResends = 0;
		let waitedSinceLastRequest = false;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: bundledModel(PRIMARY), systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				if (model.id === PRIMARY && requestedModels.length > 0 && !waitedSinceLastRequest) {
					immediatePrimaryResends++;
				}
				waitedSinceLastRequest = false;
				requestedModels.push(model.id);
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
				"retry.maxDelayMs": maxDelayMs,
				"retry.fallbackChains": { [`${PROVIDER}/${PRIMARY}`]: CHAIN.map(id => `${PROVIDER}/${id}`) },
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const current = session;
		const fallbackTargets: string[] = [];
		const retryDelays: number[] = [];
		const retryEndErrors: string[] = [];
		let contextTokensAtFirstFailure: number | undefined;
		current.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
			if (event.type === "auto_retry_start") {
				retryDelays.push(event.delayMs);
				if (event.delayMs > 0) waitedSinceLastRequest = true;
			}
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

		const last = current.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Expected a final assistant message");
		return {
			requestedModels,
			fallbackTargets,
			retryDelays,
			retryEndErrors,
			immediatePrimaryResends,
			contextTokensAtFirstFailure,
			last,
			model: current.model?.id,
		};
	}

	function describeOutcome(outcome: Outcome, size: ContextSize): string {
		switch (outcome.kind) {
			case "waits":
				return size === "small"
					? `retries the same model after ${outcome.waitMs}ms until its attempts are spent, then walks the chain`
					: `retries the same model after ${outcome.waitMs}ms until its attempts are spent, then ends without walking`;
			case "walks":
				return size === "small" ? "walks the chain at once" : "ends at once without walking";
			case "continues":
				return `waits ${outcome.waitMs}ms, then continues the answer on the same model`;
			case "spent":
				return `continues on the same model after ${outcome.waitMs}ms until its attempts are spent, then ends without walking`;
			case "ends":
				return "ends at once on the same model with the provider's error";
			case "overload":
				return "walks the chain at the first failure";
		}
	}

	for (const shape of SHAPES) {
		for (const size of ["small", "large"] as const) {
			it(`${shape.name}, ${size} context: ${describeOutcome(shape.outcome, size)}`, async () => {
				const result = await runRefusedTurn(shape.answers, CONTEXTS[size], shape.maxDelayMs ?? MAX_DELAY_MS);

				if (size === "large") expect(result.contextTokensAtFirstFailure).toBeGreaterThan(THRESHOLD_TOKENS);
				else expect(result.contextTokensAtFirstFailure).toBeLessThan(THRESHOLD_TOKENS);
				// No primary request is sent again without a wait.
				expect(result.immediatePrimaryResends).toBe(0);
				// The session never reports a wait the provider did not state.
				for (const text of [...result.retryEndErrors, result.last.errorMessage ?? ""]) {
					if (shape.outcome.kind !== "walks" && shape.outcome.kind !== "ends") {
						expect(text).not.toMatch(/Provider requested \d+ms wait/);
					}
				}

				const walked = { fallbackTargets: [`${PROVIDER}/${CHAIN[0]}`], model: CHAIN[0] };
				const stayed = { fallbackTargets: [], model: PRIMARY };
				const { outcome } = shape;
				if (outcome.kind === "overload") {
					expect(result.requestedModels).toEqual([PRIMARY, CHAIN[0]]);
					expect(result).toMatchObject(walked);
					expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
					return;
				}
				if (outcome.kind === "continues") {
					expect(result.requestedModels).toEqual([PRIMARY, PRIMARY]);
					expect(result.retryDelays).toEqual([outcome.waitMs]);
					expect(result).toMatchObject(stayed);
					expect(result.last).toMatchObject({
						stopReason: "stop",
						model: PRIMARY,
						content: [{ type: "text", text: CONTINUED_TEXT }],
					});
					return;
				}
				if (outcome.kind === "spent" || outcome.kind === "ends") {
					expect(result.requestedModels).toEqual(outcome.kind === "spent" ? SPENT_ON_PRIMARY : [PRIMARY]);
					if (outcome.kind === "spent") {
						expect(result.retryDelays).toEqual(Array.from({ length: MAX_RETRIES }, () => outcome.waitMs));
					} else {
						// The turn ends because the stated wait is past the cap, and says so.
						expect(result.retryEndErrors).toEqual([
							expect.stringContaining(
								`Provider requested ${LONG_STATED_WAIT_SECONDS * 1000}ms wait, exceeds retry.maxDelayMs`,
							),
						]);
					}
					expect(result).toMatchObject(stayed);
					expect(result.last.stopReason).toBe("error");
					expect(result.last.errorMessage).toContain("rate_limit_error");
					return;
				}
				if (outcome.kind === "waits") {
					expect(result.retryDelays.slice(0, MAX_RETRIES)).toEqual(
						Array.from({ length: MAX_RETRIES }, () => outcome.waitMs),
					);
				}
				const primaryAttempts = outcome.kind === "waits" ? SPENT_ON_PRIMARY : [PRIMARY];
				if (size === "small") {
					expect(result.requestedModels).toEqual([...primaryAttempts, CHAIN[0]]);
					expect(result).toMatchObject(walked);
					expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
				} else {
					expect(result.requestedModels).toEqual(primaryAttempts);
					expect(result).toMatchObject(stayed);
					expect(result.last.stopReason).toBe("error");
					expect(result.last.errorMessage).toContain("rate_limit_error");
				}
			});
		}
	}
});
