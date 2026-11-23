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
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const MAX_RETRIES = 2;
const MAX_DELAY_MS = 120_000;
const STATED_WAIT_SECONDS = 30;
/** The default `retry.rateLimitFallbackMaxContextTokens`. */
const CONTEXT_THRESHOLD = 100_000;

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];
const SPENT_ON_PRIMARY = Array.from({ length: MAX_RETRIES + 1 }, () => PRIMARY);

function bundledModel(id: string): Model<Api> {
	const model = getBundledModel(PROVIDER, id);
	if (!model) throw new Error(`Expected bundled ${PROVIDER}/${id}`);
	return model;
}

function usage(input: number, output: number): AssistantMessage["usage"] {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** An Anthropic per-minute rate limit (HTTP 429, not a usage limit) with a `retry-after` header. */
function rateLimit(): Promise<AIError.FinalizeResult> {
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
		{ api: "anthropic-messages", provider: PROVIDER, model: PRIMARY },
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
			usage: usage(0, 0),
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

/** A stream that delivers `message` whole, as a finished provider response. */
function finishedStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	});
	return stream;
}

function answer(
	model: Model<Api>,
	content: AssistantMessage["content"],
	input: number,
	output: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(input, output),
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

describe("rate-limit retry: the context measure covers the latest answer's own output", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-answer-size-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(PROVIDER, "anthropic-test-key");
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
	 * The first request is answered with `seedAnswer`; every later request to
	 * the primary is refused with a rate limit, and every chain model answers.
	 * `followUp` is sent after the seeded turn when given; without it the
	 * refused request is the seeded turn's own continuation (after a tool call).
	 */
	async function runRateLimitedTurn(options: {
		seedAnswer: (model: Model<Api>) => AssistantMessage;
		seedPrompt: string;
		followUp?: string;
	}) {
		const failure = await rateLimit();
		const requestedModels: string[] = [];
		const requestBytes: number[] = [];
		let seeded = false;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			convertToLlm,
			initialState: {
				model: bundledModel(PRIMARY),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context) => {
				if (!seeded) {
					seeded = true;
					return finishedStream(options.seedAnswer(model));
				}
				requestedModels.push(model.id);
				requestBytes.push(JSON.stringify(context.messages).length);
				if (model.id === PRIMARY) return refusedStream(model, failure);
				return finishedStream(answer(model, [{ type: "text", text: `Answered on ${model.id}` }], 1_000, 10));
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
					[`${PROVIDER}/${PRIMARY}`]: CHAIN.map(id => `${PROVIDER}/${id}`),
				},
			}),
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const current = session;
		const fallbackTargets: string[] = [];
		current.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
		});

		await current.prompt(options.seedPrompt);
		await current.waitForIdle();
		if (options.followUp !== undefined) {
			await current.prompt(options.followUp);
			await current.waitForIdle();
		}

		const last = current.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Expected a final assistant message");
		return { requestedModels, requestBytes, fallbackTargets, last, model: current.model?.id, current };
	}

	// Regression: a user whose last answer was long (a 60,000-token report on top
	// of a 50,000-token prompt) hits a rate limit, and the session jumps to
	// another model and resends the whole ~110,000-token context to a cold prompt
	// cache, instead of waiting on the model it was using and then showing the
	// provider's error.
	it("never moves a context over the threshold down the chain when the latest answer's text makes it large", async () => {
		const promptTokens = 50_000;
		const report = "word ".repeat(60_000);
		const result = await runRateLimitedTurn({
			seedAnswer: model => answer(model, [{ type: "text", text: report }], promptTokens, 60_000),
			seedPrompt: "Write the full report",
			followUp: "Now summarize it",
		});

		// The fixture really sends the answer again, and with the prompt it is over the threshold.
		expect(Math.min(...result.requestBytes)).toBeGreaterThan(report.length);
		expect(promptTokens + result.current.agent.tokenizer.countTokens(report)).toBeGreaterThan(CONTEXT_THRESHOLD);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
		expect(result.model).toBe(PRIMARY);
		expect(result.last.stopReason).toBe("error");
		expect(result.last.errorMessage).toContain("rate_limit_error");
	});

	// Regression: a user whose last answer wrote a 30,000-token file (on top of
	// an 80,000-token prompt) hits a rate limit on the request that follows the
	// tool result, and the session jumps to another model and resends the whole
	// ~110,000-token context to a cold prompt cache, instead of waiting on the
	// model it was using and then showing the provider's error.
	it("never moves a context over the threshold down the chain when the latest answer's tool-call arguments make it large", async () => {
		const promptTokens = 80_000;
		const fileContent = "word ".repeat(30_000);
		const result = await runRateLimitedTurn({
			seedAnswer: model =>
				answer(
					model,
					[
						{
							type: "toolCall",
							id: "call_write",
							name: "write",
							arguments: { path: "report.md", content: fileContent },
						},
					],
					promptTokens,
					30_000,
				),
			seedPrompt: "Write the report to report.md",
		});

		// The fixture really sends the tool call again, and with the prompt it is over the threshold.
		expect(Math.min(...result.requestBytes)).toBeGreaterThan(fileContent.length);
		expect(promptTokens + result.current.agent.tokenizer.countTokens(fileContent)).toBeGreaterThan(CONTEXT_THRESHOLD);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
		expect(result.model).toBe(PRIMARY);
		expect(result.last.stopReason).toBe("error");
		expect(result.last.errorMessage).toContain("rate_limit_error");
	});
});
