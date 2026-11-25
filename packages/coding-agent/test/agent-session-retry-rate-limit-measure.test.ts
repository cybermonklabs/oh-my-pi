import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
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
/** Tokens the seeded turn's usage reports: well under the default 100,000 threshold. */
const SEED_TOKENS = 20_000;
/** Roughly 200,000 tokens of text (1 MB), well over the default threshold by any count. */
const LARGE_OUTPUT = "word ".repeat(200_000);

const PROVIDER = "anthropic";
const PRIMARY = "claude-opus-5-5";
const CHAIN = ["claude-fable-5-2", "claude-opus-5"];

function bundledModel(id: string): Model<Api> {
	const model = getBundledModel(PROVIDER, id);
	if (!model) throw new Error(`Expected bundled ${PROVIDER}/${id}`);
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

function pythonExecution(output: string): AgentMessage {
	return {
		role: "pythonExecution",
		code: "print(open('build.log').read())",
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function fileMention(content: string): AgentMessage {
	return {
		role: "fileMention",
		files: [{ path: "build.log", content, lineCount: 1 }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function bashExecution(output: string, excludeFromContext: boolean): AgentMessage {
	return {
		role: "bashExecution",
		command: "cat build.log",
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
		excludeFromContext,
	} as AgentMessage;
}

const SPENT_ON_PRIMARY = Array.from({ length: MAX_RETRIES + 1 }, () => PRIMARY);

describe("rate-limit retry: the context measure covers every message kind the turn sends", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-rate-limit-measure-");
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
	 * Seeds one answered turn whose usage reports `SEED_TOKENS`, appends
	 * `extra` to the session, then sends a short prompt. The primary refuses
	 * every request with a rate limit; every chain model answers.
	 */
	async function runRateLimitedTurn(extra: AgentMessage) {
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
					return answerStream(model, "Seeded turn", SEED_TOKENS);
				}
				requestedModels.push(model.id);
				requestBytes.push(JSON.stringify(context.messages).length);
				if (model.id === PRIMARY) return refusedStream(model, failure);
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

		await current.prompt("Seed the session");
		await current.waitForIdle();
		sessionManager.appendMessage(extra as never);
		current.replaceMessagesFromSessionContext(sessionManager.buildSessionContext().messages);
		await current.prompt("Answer after the rate limit");
		await current.waitForIdle();

		return { requestedModels, requestBytes, fallbackTargets };
	}

	// Regression: a user who ran a `$` Python cell or attached an `@file` with a
	// large output sees a rate limit move the session to another model, which
	// resends the whole large context to a cold prompt cache, instead of waiting
	// on the model it was using and then showing the provider's error.
	it.each([
		{ name: "a $ Python execution output", extra: pythonExecution(LARGE_OUTPUT) },
		{ name: "an @file mention", extra: fileMention(LARGE_OUTPUT) },
	])("never moves a context over the threshold down the chain when $name makes it large", async ({ extra }) => {
		const result = await runRateLimitedTurn(extra);

		// The fixture really sends the large output in every request.
		expect(Math.min(...result.requestBytes)).toBeGreaterThan(LARGE_OUTPUT.length);
		expect(result.fallbackTargets).toEqual([]);
		expect(result.requestedModels).toEqual(SPENT_ON_PRIMARY);
	});

	// Regression: a user who ran a large `!!` command, whose output never reaches
	// the model, sees a rate limit end the turn with the provider's error although
	// the small context it really sends could have moved to the next model.
	it("moves a small context down the chain once the attempts are spent when a large !! bash output is never sent", async () => {
		const result = await runRateLimitedTurn(bashExecution(LARGE_OUTPUT, true));

		// The fixture really keeps the large output out of every request.
		expect(Math.max(...result.requestBytes)).toBeLessThan(LARGE_OUTPUT.length / 10);
		expect(result.fallbackTargets).toEqual([`${PROVIDER}/${CHAIN[0]}`]);
		expect(result.requestedModels).toEqual([...SPENT_ON_PRIMARY, CHAIN[0]]);
	});
});
