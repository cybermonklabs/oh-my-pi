import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
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

const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];
const MAX_RETRIES = 2;
const MAX_DELAY_MS = 120_000;
const STATED_WAIT_SECONDS = 30;
/** Under the default `retry.rateLimitFallbackMaxContextTokens` of 100,000. */
const SMALL_CONTEXT_TOKENS = 50_000;
/** Over the default `retry.rateLimitFallbackMaxContextTokens` of 100,000. */
const LARGE_CONTEXT_TOKENS = 150_000;

function anthropicModel(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled anthropic/${id}`);
	return model;
}

function usage(input: number): AssistantMessage["usage"] {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** An Anthropic refusal the way the provider finalizes it: HTTP status, JSON body, and any `retry-after` header. */
function refusal(
	status: number,
	errorType: string,
	message: string,
	retryAfterSeconds?: number,
): Promise<AIError.FinalizeResult> {
	const body = JSON.stringify({ type: "error", error: { type: errorType, message } });
	return AIError.finalize(
		Object.assign(new Error(`${status} ${body}`), {
			status,
			headers: retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) },
		}),
		{ api: "anthropic-messages", provider: "anthropic", model: PRIMARY },
	);
}

/** A per-minute rate limit: an HTTP 429 `rate_limit_error` that is not a usage limit. */
function rateLimit(retryAfterSeconds = STATED_WAIT_SECONDS): Promise<AIError.FinalizeResult> {
	return refusal(
		429,
		"rate_limit_error",
		`This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: ${PRIMARY}). Reduce the prompt length or the maximum tokens requested, or try again later.`,
		retryAfterSeconds,
	);
}

/** A stream that ends with a finalized provider error, as a provider stream does. */
function refusedStream(model: Model<Api>, failure: AIError.FinalizeResult): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(0),
			stopReason: failure.stopReason,
			errorMessage: failure.message,
			errorStatus: failure.status,
			errorId: failure.id,
			timestamp: Date.now(),
		};
		// A build whose finalized error carries the retry-after delay beside the
		// message hands it to the turn as `errorRetryAfterMs`, as a provider stream does.
		const statedWaitMs = (failure as { retryAfterMs?: number }).retryAfterMs;
		if (statedWaitMs !== undefined) Object.assign(partial, { errorRetryAfterMs: statedWaitMs });
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

/** A plain-text answer from `model` (no thinking) whose usage reports `inputTokens` of prompt. */
function answerStream(model: Model<Api>, text: string, inputTokens: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(inputTokens),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("retry fallback on a rate limit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	/**
	 * Seeds one answered turn on the primary (plain text, no signed thinking)
	 * whose usage reports `contextTokens`, then sends a prompt the primary
	 * refuses with `failure` for its first `primaryRefusals` attempts.
	 */
	async function runRefusedTurn(options: {
		failure: AIError.FinalizeResult;
		primaryRefusals: number;
		contextTokens: number;
		settings?: Record<string, unknown>;
	}) {
		const requestedModels: string[] = [];
		let seeded = false;
		let refused = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: anthropicModel(PRIMARY), systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				if (!seeded) {
					seeded = true;
					return answerStream(model, "Seeded turn", options.contextTokens);
				}
				requestedModels.push(model.id);
				if (model.id === PRIMARY && refused < options.primaryRefusals) {
					refused++;
					return refusedStream(model, options.failure);
				}
				return answerStream(model, `Answered on ${model.id}`, options.contextTokens);
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
				"retry.fallbackChains": { [`anthropic/${PRIMARY}`]: CHAIN.map(id => `anthropic/${id}`) },
				...options.settings,
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const fallbackTargets: string[] = [];
		const retryDelays: number[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
			if (event.type === "auto_retry_start") retryDelays.push(event.delayMs);
		});

		await session.prompt("Seed the session");
		await session.waitForIdle();
		await session.prompt("Answer after the rate limit");
		await session.waitForIdle();

		const last = session.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Expected a final assistant message");
		return { requestedModels, fallbackTargets, retryDelays, last, model: session.model?.id };
	}

	it("waits out a stated rate-limit wait on the same model when the latest turn carries no signed thinking", async () => {
		const result = await runRefusedTurn({
			failure: await rateLimit(),
			primaryRefusals: MAX_RETRIES,
			contextTokens: SMALL_CONTEXT_TOKENS,
		});

		expect(result.requestedModels).toEqual([PRIMARY, PRIMARY, PRIMARY]);
		expect(result.retryDelays).toEqual([STATED_WAIT_SECONDS * 1000, STATED_WAIT_SECONDS * 1000]);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.model).toBe(PRIMARY);
		expect(result.last).toMatchObject({ stopReason: "stop", model: PRIMARY });
	});

	it.each([
		{
			name: "the same-model attempts are spent",
			retryAfterSeconds: STATED_WAIT_SECONDS,
			primaryAttempts: MAX_RETRIES + 1,
		},
		{
			name: "the stated wait is past retry.maxDelayMs",
			retryAfterSeconds: (MAX_DELAY_MS / 1000) * 5,
			primaryAttempts: 1,
		},
	])("moves a small session to the next chain entry once $name", async ({ retryAfterSeconds, primaryAttempts }) => {
		const result = await runRefusedTurn({
			failure: await rateLimit(retryAfterSeconds),
			primaryRefusals: Number.POSITIVE_INFINITY,
			contextTokens: SMALL_CONTEXT_TOKENS,
		});

		expect(result.requestedModels).toEqual([...Array.from({ length: primaryAttempts }, () => PRIMARY), CHAIN[0]]);
		expect(result.fallbackTargets).toEqual([`anthropic/${CHAIN[0]}`]);
		expect(result.model).toBe(CHAIN[0]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
	});

	it.each([
		{
			name: "the same-model attempts are spent",
			retryAfterSeconds: STATED_WAIT_SECONDS,
			primaryAttempts: MAX_RETRIES + 1,
			settings: {},
		},
		{
			name: "the attempts are spent under retry.rateLimitWalksChain",
			retryAfterSeconds: STATED_WAIT_SECONDS,
			primaryAttempts: MAX_RETRIES + 1,
			settings: { "retry.rateLimitWalksChain": true },
		},
		{
			name: "the stated wait is past retry.maxDelayMs",
			retryAfterSeconds: (MAX_DELAY_MS / 1000) * 5,
			primaryAttempts: 1,
			settings: {},
		},
	])(
		"keeps a large session on the rate-limited model and ends the turn with the provider's error once $name",
		async ({ retryAfterSeconds, primaryAttempts, settings }) => {
			const result = await runRefusedTurn({
				failure: await rateLimit(retryAfterSeconds),
				primaryRefusals: Number.POSITIVE_INFINITY,
				contextTokens: LARGE_CONTEXT_TOKENS,
				settings,
			});

			expect(result.requestedModels).toEqual(Array.from({ length: primaryAttempts }, () => PRIMARY));
			expect(result.fallbackTargets).toEqual([]);
			expect(result.model).toBe(PRIMARY);
			expect(result.last.stopReason).toBe("error");
			expect(result.last.errorMessage).toContain("rate_limit_error");
		},
	);

	it.each([
		{ name: "an HTTP 529 overload", failure: () => refusal(529, "overloaded_error", "Overloaded") },
		{ name: "an HTTP 500", failure: () => refusal(500, "api_error", "Internal server error") },
	])("moves even a large session down the chain at the first $name", async ({ failure }) => {
		const result = await runRefusedTurn({
			failure: await failure(),
			primaryRefusals: Number.POSITIVE_INFINITY,
			contextTokens: LARGE_CONTEXT_TOKENS,
		});

		expect(result.requestedModels).toEqual([PRIMARY, CHAIN[0]]);
		expect(result.fallbackTargets).toEqual([`anthropic/${CHAIN[0]}`]);
		expect(result.model).toBe(CHAIN[0]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
	});
});
