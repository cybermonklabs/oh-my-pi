/**
 * A rate limit the Anthropic API reports inside the response stream (an SSE
 * `error` frame of type `rate_limit_error` before `message_start`) carries no
 * HTTP status. The primary model's requests run the real `anthropic-messages`
 * provider, which parses that frame; only its HTTP client is replaced, so no
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
/** Roughly 150,000 tokens of prompt text, over the default 100,000-token threshold by any count. */
const LARGE_PROMPT = "word ".repeat(150_000);

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];
const SPENT_ON_PRIMARY = Array.from({ length: MAX_RETRIES + 1 }, () => PRIMARY);

/** The frame the Anthropic API streams for a per-minute rate limit hit after the response began. */
const RATE_LIMIT_FRAME = `event: error\ndata: ${JSON.stringify({
	type: "error",
	error: {
		type: "rate_limit_error",
		message:
			"This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: claude-opus-5-5). Reduce the prompt length or the maximum tokens requested, or try again later.",
	},
})}\n\n`;

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

describe("rate-limit retry: a rate limit reported inside the response stream", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-stream-error-");
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
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	/** Sends `prompt`; every primary request streams the rate-limit frame, every chain model answers. */
	async function runStreamRateLimitedTurn(prompt: string) {
		let providerRequests = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			providerRequests++;
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
		let contextTokensAtFirstFailure: number | undefined;
		current.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackTargets.push(event.to);
			// The first retry decision, same model or chain, reads the context the failed request sent.
			if (event.type === "retry_fallback_applied" || event.type === "auto_retry_start") {
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
			contextTokensAtFirstFailure,
			last,
			model: current.model?.id,
		};
	}

	// Regression: a user who pastes a large prompt hits a rate limit the API
	// reports inside the stream, and the session jumps to another model and
	// resends the whole prompt to a cold prompt cache at the first failure,
	// instead of waiting on the model it was using and then showing the
	// provider's error, as it does for the same rate limit sent as HTTP 429.
	it("never moves a context over the threshold down the chain", async () => {
		const result = await runStreamRateLimitedTurn(LARGE_PROMPT);

		// The fixture really goes through the provider's stream parse, with a context over the threshold.
		expect(result.providerRequests).toBeGreaterThan(0);
		expect(result.contextTokensAtFirstFailure).toBeGreaterThan(100_000);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
		expect(result.model).toBe(PRIMARY);
		expect(result.last.stopReason).toBe("error");
		expect(result.last.errorMessage).toContain("rate_limit_error");
	});

	// Regression: a user in a small session hits a rate limit the API reports
	// inside the stream, and the session leaves the model it was using at the
	// first failure, instead of retrying that model after the wait as it does for
	// the same rate limit sent as HTTP 429, and only then moving down the chain.
	it("retries the same model until its attempts are spent before moving a small context down the chain", async () => {
		const result = await runStreamRateLimitedTurn("Answer after the rate limit");

		expect(result.providerRequests).toBeGreaterThan(0);
		expect(result.contextTokensAtFirstFailure).toBeLessThan(100_000);
		expect(result.requestedModels).toEqual([...SPENT_ON_PRIMARY, CHAIN[0]]);
		expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
		expect(result.last).toMatchObject({ stopReason: "stop", model: CHAIN[0] });
	});
});
