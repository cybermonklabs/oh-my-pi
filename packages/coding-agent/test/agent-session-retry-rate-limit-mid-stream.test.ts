/**
 * A rate limit the Anthropic API reports inside a 200 response stream after the
 * response began (an SSE `error` frame of type `rate_limit_error` after
 * `message_start`, with or without streamed text before it), and a rate limit
 * that states no wait under a `retry.maxDelayMs` below the built-in rate-limit
 * backoff. The primary model's requests run the real `anthropic-messages`
 * provider, which parses the frames; only its HTTP client is replaced, so no
 * request leaves the process. Chain models answer from a stub stream.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
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
/** Below the 30-second backoff the session applies to a rate limit that states no wait. */
const SHORT_MAX_DELAY_MS = 10_000;
/** Roughly 150,000 tokens of prompt text, over the default 100,000-token threshold by any count. */
const LARGE_PROMPT = "word ".repeat(150_000);
const SMALL_PROMPT = "Answer after the rate limit";

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];
const SPENT_ON_PRIMARY = Array.from({ length: MAX_RETRIES + 1 }, () => PRIMARY);

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START_FRAME = sseFrame("message_start", {
	type: "message_start",
	message: {
		id: "msg_rate_limit_frame",
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

/** The frame the Anthropic API streams for a per-minute rate limit; it states no wait. */
const RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: {
		type: "rate_limit_error",
		message:
			"This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: claude-opus-5-5). Reduce the prompt length or the maximum tokens requested, or try again later.",
	},
});

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

describe("rate-limit retry: a rate limit reported after the response stream began", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-mid-stream-");
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

	/** Sends `prompt`; every primary request streams `stream`, every chain model answers. */
	async function runRateLimitedTurn(stream: string, prompt: string, maxDelayMs = MAX_DELAY_MS) {
		let providerRequests = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			providerRequests++;
			const body = new TextEncoder().encode(stream);
			return {
				async asResponse() {
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream", "request-id": "req_rate_limit_frame" },
					});
				},
			} as never;
		});
		const requestedModels: string[] = [];
		// A request to the primary after the first that no `auto_retry_start`
		// with a wait preceded: the session sent it again at once.
		let immediatePrimaryResends = 0;
		let waitScheduledSinceLastRequest = false;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: bundledModel(PRIMARY),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				if (model.id === PRIMARY && requestedModels.length > 0 && !waitScheduledSinceLastRequest) {
					immediatePrimaryResends++;
				}
				waitScheduledSinceLastRequest = false;
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
				"retry.fallbackChains": {
					[`${PROVIDER}/${PRIMARY}`]: CHAIN.map(id => `${PROVIDER}/${id}`),
				},
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
			if (event.type === "auto_retry_start" && event.delayMs > 0) waitScheduledSinceLastRequest = true;
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
			providerRequests,
			immediatePrimaryResends,
			retryEndErrors,
			contextTokensAtFirstFailure,
			last,
			model: current.model?.id,
		};
	}

	// Regression: a user who pastes a large prompt hits a rate limit the API
	// reports after the response began, and the session jumps to another model
	// and resends the whole prompt to a cold prompt cache at the first failure,
	// instead of waiting on the model it was using and then showing the
	// provider's rate-limit error, as it does for the same frame sent before the
	// response began.
	it("never moves a context over the threshold down the chain for a rate limit after message_start", async () => {
		const result = await runRateLimitedTurn(MESSAGE_START_FRAME + RATE_LIMIT_FRAME, LARGE_PROMPT);

		expect(result.providerRequests).toBeGreaterThan(0);
		expect(result.contextTokensAtFirstFailure).toBeGreaterThan(100_000);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
		expect(result.model).toBe(PRIMARY);
		expect(result.last.stopReason).toBe("error");
		expect(result.last.errorMessage).toContain("rate_limit_error");
	});

	// Regression: a user in a small session hits a rate limit the API reports
	// after the response began, and the session leaves the model it was using at
	// the first failure, instead of retrying that model after the wait until its
	// attempts are spent and only then moving down the chain.
	it("retries the same model until its attempts are spent before moving a small context down the chain for a rate limit after message_start", async () => {
		const result = await runRateLimitedTurn(MESSAGE_START_FRAME + RATE_LIMIT_FRAME, SMALL_PROMPT);

		expect(result.providerRequests).toBeGreaterThan(0);
		expect(result.contextTokensAtFirstFailure).toBeLessThan(100_000);
		expect(result.requestedModels).toEqual([...SPENT_ON_PRIMARY, CHAIN[0]]);
		expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
	});

	// Regression: a user whose answer has started to stream hits a rate limit,
	// and the session sends the whole large context to the rate-limited model
	// again at once, several times in a row with no wait, each time adding a
	// resume note to the conversation, before it shows the error.
	it("re-sends a large context to the rate-limited model only after a wait when text streamed before the rate limit", async () => {
		const result = await runRateLimitedTurn(MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME, LARGE_PROMPT);

		expect(result.providerRequests).toBeGreaterThan(0);
		expect(result.contextTokensAtFirstFailure).toBeGreaterThan(100_000);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels.every(id => id === PRIMARY)).toBe(true);
		expect(result.immediatePrimaryResends).toBe(0);
		expect(result.last.stopReason).toBe("error");
	});
});

describe("rate-limit retry: a rate limit that states no wait under a short retry.maxDelayMs", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-no-stated-wait-");
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

	/** Sends `prompt` with retry.maxDelayMs at {@link SHORT_MAX_DELAY_MS}; every primary request streams the rate-limit frame. */
	async function runShortCapTurn(prompt: string) {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			const body = new TextEncoder().encode(RATE_LIMIT_FRAME);
			return {
				async asResponse() {
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream", "request-id": "req_rate_limit_frame" },
					});
				},
			} as never;
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: bundledModel(PRIMARY),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
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
				"retry.maxDelayMs": SHORT_MAX_DELAY_MS,
				"retry.fallbackChains": {
					[`${PROVIDER}/${PRIMARY}`]: CHAIN.map(id => `${PROVIDER}/${id}`),
				},
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const current = session;
		const fallbackTargets: string[] = [];
		const retryEndErrors: string[] = [];
		current.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
			if (event.type === "auto_retry_end" && event.finalError) retryEndErrors.push(event.finalError);
		});

		await current.prompt(prompt);
		await current.waitForIdle();

		const last = current.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Expected a final assistant message");
		return { requestedModels, fallbackTargets, retryEndErrors, last, model: current.model?.id };
	}

	// Regression: a user who lowered retry.maxDelayMs below 30 seconds hits a
	// rate limit that names no wait, and the session leaves the model it was
	// using at the first failure, as if the provider had asked for a wait past
	// the cap, instead of retrying that model until its attempts are spent.
	it("retries the same model before moving a small context down the chain", async () => {
		const result = await runShortCapTurn(SMALL_PROMPT);

		expect(result.requestedModels).toEqual([...SPENT_ON_PRIMARY, CHAIN[0]]);
		expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
	});

	// Regression: a user with a large session who lowered retry.maxDelayMs below
	// 30 seconds hits a rate limit that names no wait, and the turn ends after a
	// single attempt with "Provider requested 30000ms wait", a wait the provider
	// never asked for, instead of retrying the model it was using.
	it("retries the same model for a large context and reports no wait the provider never stated", async () => {
		const result = await runShortCapTurn(LARGE_PROMPT);

		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
		expect(result.model).toBe(PRIMARY);
		expect(result.last.stopReason).toBe("error");
		for (const text of [...result.retryEndErrors, result.last.errorMessage ?? ""]) {
			expect(text).not.toMatch(/Provider requested \d+ms wait/);
		}
	});
});
