import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, StopDetails } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockContent, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

type FallbackApplied = Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>;
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

/** One classifier refusal shape per row: each category and stream position takes the same path. */
const REFUSALS: Array<{ name: string; content: MockContent[]; stopDetails: StopDetails }> = [
	{
		name: "a reasoning_extraction refusal after streamed thinking",
		content: [{ type: "thinking", thinking: "Reasoning the classifier read before it refused." }],
		stopDetails: {
			type: "refusal",
			category: "reasoning_extraction",
			explanation: "Classifier declined the reply.",
		},
	},
	{
		name: "a cyber refusal before any output",
		content: [],
		stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined the request." },
	},
	{ name: "a sensitive stop", content: [], stopDetails: { type: "sensitive" } },
];

function refusal(shape: (typeof REFUSALS)[number]): MockResponse {
	return {
		content: shape.content,
		stopReason: "error",
		stopDetails: shape.stopDetails,
		errorMessage: `Refusal (${shape.stopDetails.category ?? shape.stopDetails.type}): Classifier declined.`,
	};
}

const CYBER_POLICY_ERROR = "cyber_policy: This content was flagged for possible cybersecurity risk.";

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("a classifier refusal is retried on the model that refused it before the fallback walk", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	const primary = bundled("anthropic", "claude-sonnet-4-5");
	const firstFallback = bundled("openai", "gpt-4o-mini");
	const secondFallback = bundled("openai", "gpt-4o");

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-refusal-same-model-");
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
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	/**
	 * Runs one prompt on `startModel`. `respond` gets the model and how many requests that model
	 * has had before this one, and returns the scripted reply.
	 */
	async function run(options: {
		startModel?: Model;
		respond: (model: Model, priorRequests: number) => MockResponse;
		settings?: Record<string, unknown>;
	}): Promise<{
		requested: string[];
		fallbacks: FallbackApplied[];
		retryEnds: RetryEnd[];
		last: AssistantMessage;
	}> {
		const startModel = options.startModel ?? primary;
		const requested: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: startModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, streamOptions) => {
				const key = selector(model);
				const priorRequests = requested.filter(entry => entry === key).length;
				requested.push(key);
				mock.push(options.respond(model, priorRequests));
				return mock.stream(model, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			...options.settings,
		});
		settings.setModelRole("default", selector(startModel));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const fallbacks: FallbackApplied[] = [];
		const retryEnds: RetryEnd[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		await session.prompt("Answer the question");
		await session.waitForIdle();
		// A turn that ends on a refusal prunes it from the active context; the settled outcome stays readable.
		const last = session.getLastAssistantMessage();
		if (!last) throw new Error("Expected a settled assistant message");
		return { requested, fallbacks, retryEnds, last };
	}

	it.each(REFUSALS)("answers on the refused model when a retry there is served: $name", async shape => {
		const result = await run({
			respond: (model, prior) =>
				selector(model) === selector(primary) && prior === 0
					? refusal(shape)
					: { content: [`ok:${selector(model)}`] },
			settings: { "retry.fallbackChains": { default: [selector(firstFallback)] } },
		});

		expect(result.requested).toEqual([selector(primary), selector(primary)]);
		expect(result.fallbacks).toEqual([]);
		expect(session?.model?.id).toBe(primary.id);
		expect(result.last.stopReason).toBe("stop");
		expect(result.last.content).toEqual([{ type: "text", text: `ok:${selector(primary)}` }]);
	});

	it.each(REFUSALS)("walks the chain once the refused model's two retries are refused: $name", async shape => {
		const result = await run({
			respond: model =>
				selector(model) === selector(primary) ? refusal(shape) : { content: ["fallback answered"] },
			settings: { "retry.fallbackChains": { default: [selector(firstFallback)] } },
		});

		expect(result.requested).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(firstFallback),
		]);
		expect(result.fallbacks.map(event => `${event.from} -> ${event.to}`)).toEqual([
			`${selector(primary)} -> ${selector(firstFallback)}`,
		]);
		expect(session?.model?.id).toBe(firstFallback.id);
		expect(result.last.content).toEqual([{ type: "text", text: "fallback answered" }]);
	});

	it("gives every model of the walk its own two retries, and never walks back to one it left", async () => {
		const result = await run({
			respond: model =>
				selector(model) === selector(secondFallback)
					? { content: ["second fallback answered"] }
					: refusal(REFUSALS[1]),
			settings: {
				"retry.fallbackChains": {
					default: [selector(firstFallback), selector(secondFallback)],
					[selector(firstFallback)]: [selector(primary), selector(secondFallback)],
				},
			},
		});

		expect(result.requested).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(firstFallback),
			selector(firstFallback),
			selector(firstFallback),
			selector(secondFallback),
		]);
		expect(session?.model?.id).toBe(secondFallback.id);
	});

	it("ends the turn on the refusal after the two retries when no chain is configured", async () => {
		const result = await run({ respond: () => refusal(REFUSALS[0]) });

		expect(result.requested).toEqual([selector(primary), selector(primary), selector(primary)]);
		expect(result.last.stopReason).toBe("error");
		expect(result.last.stopDetails).toMatchObject({ type: "refusal", category: "reasoning_extraction" });
		expect(result.last.errorMessage).toBe("Refusal (reasoning_extraction): Classifier declined.");
		expect(result.retryEnds).toHaveLength(1);
		expect(result.retryEnds[0]).toMatchObject({ success: false, attempt: 2 });
	});

	it("keeps the same-model retries inside retry.maxRetries", async () => {
		const result = await run({
			respond: model =>
				selector(model) === selector(primary) ? refusal(REFUSALS[1]) : { content: ["fallback answered"] },
			settings: { "retry.maxRetries": 1, "retry.fallbackChains": { default: [selector(firstFallback)] } },
		});

		expect(result.requested).toEqual([selector(primary), selector(primary), selector(firstFallback)]);
		expect(session?.model?.id).toBe(firstFallback.id);
	});

	// Control: a failure that is not a refusal keeps its own path.
	it("still walks the chain at once on an overloaded 503", async () => {
		const result = await run({
			respond: (model, prior) =>
				selector(model) === selector(primary) && prior === 0
					? { throw: "overloaded_error: provider returned error 503" }
					: { content: ["fallback answered"] },
			settings: { "retry.fallbackChains": { default: [selector(firstFallback)] } },
		});

		expect(result.requested).toEqual([selector(primary), selector(firstFallback)]);
		expect(session?.model?.id).toBe(firstFallback.id);
	});

	// Control: an OpenAI `cyber_policy` refusal is not a classifier refusal and is never sent
	// again to the model it refused; the walk may still give the turn to another family.
	it("sends an OpenAI cyber_policy refusal once and lets another family take the turn", async () => {
		const result = await run({
			startModel: firstFallback,
			respond: model =>
				selector(model) === selector(firstFallback)
					? { stopReason: "error", errorMessage: CYBER_POLICY_ERROR }
					: { content: ["claude answered"] },
			settings: { "retry.fallbackChains": { default: [selector(primary)] } },
		});

		expect(result.requested).toEqual([selector(firstFallback), selector(primary)]);
		expect(session?.model?.id).toBe(primary.id);
		expect(result.last.content).toEqual([{ type: "text", text: "claude answered" }]);
	});
});
