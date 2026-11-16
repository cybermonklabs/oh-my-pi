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

const MAX_RETRIES = 2;
const MAX_DELAY_MS = 120_000;
/** The default `retry.rateLimitFallbackMaxContextTokens`. */
const CONTEXT_THRESHOLD = 100_000;
const STATED_WAIT_SECONDS = 30;
/** Roughly 200,000 tokens of prompt text (1 MB), well over the threshold by any count. */
const LARGE_PROMPT = "word ".repeat(200_000);

interface Route {
	provider: "anthropic" | "openai";
	primary: string;
	chain: string[];
}

const ANTHROPIC: Route = {
	provider: "anthropic",
	primary: "claude-opus-5-5",
	chain: ["claude-fable-5-2", "claude-opus-5"],
};
const OPENAI: Route = { provider: "openai", primary: "gpt-5.2", chain: ["gpt-5.1", "gpt-5"] };

function bundledModel(provider: Route["provider"], id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
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

/** An Anthropic per-minute rate limit (HTTP 429, not a usage limit) with a `retry-after` header. */
function anthropicRateLimit(): Promise<AIError.FinalizeResult> {
	const body = JSON.stringify({
		type: "error",
		error: {
			type: "rate_limit_error",
			message:
				"This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: claude-opus-5-5). Reduce the prompt length or the maximum tokens requested, or try again later.",
		},
	});
	return AIError.finalize(
		Object.assign(new Error(`429 ${body}`), { status: 429, headers: { "retry-after": String(STATED_WAIT_SECONDS) } }),
		{ api: "anthropic-messages", provider: "anthropic", model: ANTHROPIC.primary },
	);
}

/** An OpenAI per-minute rate limit (HTTP 429 `rate_limit_exceeded`) whose body states the wait. */
function openaiRateLimit(statedWait: string): Promise<AIError.FinalizeResult> {
	const body = JSON.stringify({
		error: {
			message: `Rate limit reached for gpt-5.2 in organization org-test on requests per min (RPM): Limit 500. Please try again in ${statedWait}.`,
			type: "requests",
			code: "rate_limit_exceeded",
		},
	});
	return AIError.finalize(Object.assign(new Error(`429 ${body}`), { status: 429, headers: {} }), {
		api: "openai-responses",
		provider: "openai",
		model: OPENAI.primary,
	});
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
		const { retryAfterMs } = failure as { retryAfterMs?: number };
		if (retryAfterMs !== undefined) Object.assign(partial, { errorRetryAfterMs: retryAfterMs });
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

/** A plain-text answer whose usage reports `inputTokens` of prompt. */
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

describe("rate-limit retry: the context a session sends and the wait a provider states", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-context-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
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
	 * Optionally seeds one answered turn whose usage reports `seedTokens`, lets
	 * `beforePrompt` reshape the session, then sends `prompt`. The primary
	 * refuses with `failure` for its first `primaryRefusals` requests; every
	 * other request is answered.
	 */
	async function runRefusedTurn(options: {
		route: Route;
		failure: AIError.FinalizeResult;
		primaryRefusals: number;
		seedTokens?: number;
		prompt?: string;
		beforePrompt?: (session: AgentSession, sessionManager: SessionManager) => void;
	}) {
		const { route } = options;
		const requestedModels: string[] = [];
		let seeded = options.seedTokens === undefined;
		let refused = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: bundledModel(route.provider, route.primary),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: model => {
				if (!seeded) {
					seeded = true;
					return answerStream(model, "Seeded turn", options.seedTokens ?? 0);
				}
				requestedModels.push(model.id);
				if (model.id === route.primary && refused < options.primaryRefusals) {
					refused++;
					return refusedStream(model, options.failure);
				}
				return answerStream(model, `Answered on ${model.id}`, 1_000);
			},
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": MAX_RETRIES,
				"retry.maxDelayMs": MAX_DELAY_MS,
				"retry.fallbackChains": {
					[`${route.provider}/${route.primary}`]: route.chain.map(id => `${route.provider}/${id}`),
				},
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const current = session;
		const fallbackTargets: string[] = [];
		const retryDelays: number[] = [];
		let contextTokensAtFirstRetry: number | undefined;
		current.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
			if (event.type === "auto_retry_start") {
				retryDelays.push(event.delayMs);
				contextTokensAtFirstRetry ??= current.getContextUsage()?.tokens;
			}
		});

		if (options.seedTokens !== undefined) {
			await current.prompt("Seed the session");
			await current.waitForIdle();
		}
		options.beforePrompt?.(current, sessionManager);
		await current.prompt(options.prompt ?? "Answer after the rate limit");
		await current.waitForIdle();

		const last = current.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Expected a final assistant message");
		return {
			requestedModels,
			fallbackTargets,
			retryDelays,
			contextTokensAtFirstRetry,
			last,
			model: current.model?.id,
		};
	}

	// Regression: a user who pastes a large prompt into a rate-limited session
	// sees the session jump to another model and resend the whole prompt to a
	// cold prompt cache, instead of waiting on the model it was using and then
	// showing the provider's error.
	it.each([
		{ name: "with no answered request yet", seedTokens: undefined },
		{ name: "after a small answered turn", seedTokens: 50_000 },
	])(
		"never moves a context over the threshold down the chain when the size comes from messages sent $name",
		async ({ seedTokens }) => {
			const result = await runRefusedTurn({
				route: ANTHROPIC,
				failure: await anthropicRateLimit(),
				primaryRefusals: Number.POSITIVE_INFINITY,
				seedTokens,
				prompt: LARGE_PROMPT,
			});

			// The fixture really sends a context over the threshold.
			expect(result.contextTokensAtFirstRetry).toBeGreaterThan(CONTEXT_THRESHOLD);
			expect(result.fallbackTargets).toEqual([]);
			expect(result.requestedModels).toEqual(Array.from({ length: MAX_RETRIES + 1 }, () => ANTHROPIC.primary));
			expect(result.model).toBe(ANTHROPIC.primary);
			expect(result.last.stopReason).toBe("error");
			expect(result.last.errorMessage).toContain("rate_limit_error");
		},
	);

	// Regression: right after a compaction shrank a large session, a rate limit
	// ends the user's turn with the provider's error although the next model in
	// the chain could have answered the now-small context.
	it("moves a context that a compaction brought under the threshold to the next chain entry once the attempts are spent", async () => {
		let contextTokensAfterCompaction: number | undefined;
		const result = await runRefusedTurn({
			route: ANTHROPIC,
			failure: await anthropicRateLimit(),
			primaryRefusals: Number.POSITIVE_INFINITY,
			seedTokens: 140_000,
			beforePrompt: (current, sessionManager) => {
				// Compact everything before the seeded turn and keep that turn, as a compaction keeps the newest turns.
				const firstKept = sessionManager
					.getEntries()
					.find(entry => entry.type === "message" && entry.message.role === "user");
				if (!firstKept) throw new Error("Expected the seeded user entry");
				sessionManager.appendCompaction("Summary of the earlier work.", "Earlier work", firstKept.id, 140_000, {
					tokensAfter: 2_000,
				});
				current.replaceMessagesFromSessionContext(sessionManager.buildSessionContext().messages);
				contextTokensAfterCompaction = current.getContextUsage()?.tokens;
			},
		});

		// The fixture really leaves a context under the threshold.
		expect(contextTokensAfterCompaction).toBeLessThan(CONTEXT_THRESHOLD);
		expect(result.requestedModels).toEqual([
			...Array.from({ length: MAX_RETRIES + 1 }, () => ANTHROPIC.primary),
			ANTHROPIC.chain[0],
		]);
		expect(result.fallbackTargets).toEqual([`anthropic/${ANTHROPIC.chain[0]}`]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: ANTHROPIC.chain[0] });
	});

	// Regression: a provider asks for a six-minute wait and the session, blind
	// to it, retries the same model after its own short backoff, re-hits the
	// limit and keeps the user waiting before it finally moves down the chain.
	it("moves a small session down the chain at once when the body states a compound wait past retry.maxDelayMs", async () => {
		const result = await runRefusedTurn({
			route: OPENAI,
			failure: await openaiRateLimit("6m0s"),
			primaryRefusals: Number.POSITIVE_INFINITY,
			seedTokens: 50_000,
		});

		expect(result.requestedModels).toEqual([OPENAI.primary, OPENAI.chain[0]]);
		expect(result.fallbackTargets).toEqual([`openai/${OPENAI.chain[0]}`]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: OPENAI.chain[0] });
	});

	// Regression: a provider asks for a ninety-second wait and the session
	// retries after a shorter one, so the retry re-hits the limit and spends
	// the user's attempts on requests the provider already said it would refuse.
	it("waits the full compound wait the body states under retry.maxDelayMs before retrying the same model", async () => {
		const result = await runRefusedTurn({
			route: OPENAI,
			failure: await openaiRateLimit("1m30s"),
			primaryRefusals: 1,
			seedTokens: 50_000,
		});

		expect(result.requestedModels).toEqual([OPENAI.primary, OPENAI.primary]);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.retryDelays).toHaveLength(1);
		expect(result.retryDelays[0]).toBeGreaterThanOrEqual(90_000);
		expect(result.retryDelays[0]).toBeLessThanOrEqual(MAX_DELAY_MS);
		expect(result.last).toMatchObject({ stopReason: "stop", model: OPENAI.primary });
	});
});
