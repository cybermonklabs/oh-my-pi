import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * OpenAI refuses a request whose content it flags for cybersecurity risk with the error code
 * `cyber_policy`. Every copy of that request sent again, on any route that reaches OpenAI, adds a
 * refusal to the organization's record, and repeated refusals can revoke its access. So the refusal
 * ends the model call: no retry on the same route, no sibling credential, and for the rest of the
 * turn the fallback walk passes over every OpenAI route, other OpenAI models included. A model of
 * another family may still take the turn.
 *
 * The error responses here are synthetic: only the refusal's code and OpenAI's wording.
 */
const CYBER_POLICY: MockResponse = {
	stopReason: "error",
	errorMessage:
		"cyber_policy: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.",
};
const OVERLOADED: MockResponse = {
	stopReason: "error",
	errorMessage: "503 Service Unavailable: the server is overloaded",
};

// Two provider names for one OpenAI-compatible gateway route, as a machine can declare them. The mock
// stream answers every request, so the routes need no credential.
const GATEWAY_MODELS_YML = `providers:
  gateway-openai:
    api: openai-responses
    baseUrl: http://127.0.0.1:1/v1
    auth: none
    models:
      - id: openai/gpt-6.1-sol
        name: gpt-6.1-sol
        contextWindow: 400000
        maxTokens: 128000
  gateway:
    api: openai-responses
    baseUrl: http://127.0.0.1:1/v1
    auth: none
    models:
      - id: openai/gpt-6.1-sol
        name: gpt-6.1-sol
        contextWindow: 400000
        maxTokens: 128000
`;

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message;
}

describe("AgentSession after a cyber_policy refusal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-cyber-policy-");
		fs.writeFileSync(path.join(tempDir.path(), "models.yml"), GATEWAY_MODELS_YML);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.credentials.remove("openai-codex");
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		authStorage.keys.setRuntime("openai-codex", "codex-test-key");
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function models() {
		const gateway = modelRegistry.find("gateway-openai", "openai/gpt-6.1-sol");
		const gatewayAlias = modelRegistry.find("gateway", "openai/gpt-6.1-sol");
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		const openai = getBundledModel("openai", "gpt-5.5");
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		if (!gateway || !gatewayAlias || !codex || !openai || !sonnet || !opus) {
			throw new Error("Expected the gateway routes from models.yml and the bundled test models");
		}
		// The catalog puts every OpenAI route below in one lineage, whatever provider serves it.
		for (const model of [gateway, gatewayAlias, codex, openai]) expect(model.identity.class).toBe("openai");
		return { gateway, gatewayAlias, codex, openai, sonnet, opus };
	}

	/** A session whose requests are answered per route by `answer`; `requested` records each route asked. */
	function startSession(options: {
		primary: Model;
		chains: Record<string, string[]>;
		maxRetries?: number;
		answer: (model: Model, routeAttempt: number) => MockResponse;
		tools?: AgentTool[];
	}): { live: AgentSession; requested: string[]; fallbacks: string[] } {
		const requested: string[] = [];
		const fallbacks: string[] = [];
		const attempts = new Map<string, number>();
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: options.primary, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: (model, context, streamOptions) => {
				const route = selector(model);
				requested.push(route);
				const attempt = (attempts.get(route) ?? 0) + 1;
				attempts.set(route, attempt);
				mock.push(options.answer(model, attempt));
				return mock.stream(model, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": options.maxRetries ?? 3,
			"retry.modelFallback": true,
			"retry.fallbackChains": options.chains,
		});
		settings.setModelRole("default", selector(options.primary));
		const live = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session = live;
		live.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event.to);
		});
		return { live, requested, fallbacks };
	}

	it("sends the refused request to no other OpenAI route and lets another family take the turn", async () => {
		const { gateway, gatewayAlias, codex, openai, sonnet } = models();
		const { live, requested, fallbacks } = startSession({
			primary: gateway,
			chains: { [selector(gateway)]: [selector(gatewayAlias), selector(codex), selector(openai), selector(sonnet)] },
			answer: model => (model.identity.class === "openai" ? CYBER_POLICY : { content: ["answered by Claude"] }),
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(gateway), selector(sonnet)]);
		expect(fallbacks).toEqual([selector(sonnet)]);
		expect(lastAssistant(live).stopReason).toBe("stop");
	});

	it("ends the turn on the refusal when every fallback is an OpenAI route", async () => {
		const { gateway, gatewayAlias, codex } = models();
		const { live, requested, fallbacks } = startSession({
			primary: gateway,
			chains: { [selector(gateway)]: [selector(gatewayAlias), selector(codex)] },
			answer: () => CYBER_POLICY,
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(gateway)]);
		expect(fallbacks).toEqual([]);
		expect(lastAssistant(live).errorMessage).toContain("cyber_policy");
		expect(live.isRetrying).toBe(false);
	});

	it("keeps every OpenAI route out of the walk for the rest of the turn, and only that turn", async () => {
		const { codex, openai, sonnet, opus } = models();
		const executed: string[] = [];
		const noop: AgentTool = {
			name: "noop",
			label: "No-op",
			description: "Does nothing",
			parameters: type({}),
			execute: async id => {
				executed.push(id);
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const { live, requested, fallbacks } = startSession({
			primary: codex,
			// A later failure on the Claude fallback consults these chains, whose next entry is OpenAI.
			chains: {
				[selector(codex)]: [selector(sonnet), selector(openai), selector(opus)],
				[selector(sonnet)]: [selector(openai), selector(opus)],
			},
			maxRetries: 0,
			tools: [noop],
			answer: (model, attempt) => {
				if (model.identity.class === "openai") return CYBER_POLICY;
				if (model.id === sonnet.id) {
					return attempt === 1 ? { content: [{ type: "toolCall", name: "noop", arguments: {} }] } : OVERLOADED;
				}
				return { content: [`answered by ${model.id}`] };
			},
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(executed).toHaveLength(1);
		expect(requested).toEqual([selector(codex), selector(sonnet), selector(sonnet), selector(opus)]);
		expect(fallbacks).toEqual([selector(sonnet), selector(opus)]);
		expect(lastAssistant(live).stopReason).toBe("stop");

		// The next turn may walk to OpenAI again: the refusal closed those routes for its own turn only.
		modelRegistry.clearSuppressedSelectors();
		await live.setModel(sonnet);
		requested.length = 0;
		await live.prompt("A new request");
		await live.waitForIdle();
		expect(requested).toEqual([selector(sonnet), selector(openai), selector(opus)]);
	});

	it("still walks to another OpenAI route on a 503, as before", async () => {
		const { gateway, gatewayAlias, sonnet } = models();
		const { live, requested, fallbacks } = startSession({
			primary: gateway,
			chains: { [selector(gateway)]: [selector(gatewayAlias), selector(sonnet)] },
			maxRetries: 0,
			answer: model =>
				model.provider === gateway.provider ? OVERLOADED : { content: [`answered by ${selector(model)}`] },
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(gateway), selector(gatewayAlias)]);
		expect(fallbacks).toEqual([selector(gatewayAlias)]);
		expect(lastAssistant(live).stopReason).toBe("stop");
	});

	it("still retries the same route after a 429, as before", async () => {
		const { gateway } = models();
		const { live, requested } = startSession({
			primary: gateway,
			chains: {},
			maxRetries: 1,
			answer: (_model, attempt) =>
				attempt === 1
					? { stopReason: "error", errorMessage: "429 Too Many Requests: rate limit exceeded, retry-after-ms=1" }
					: { content: ["answered after the retry"] },
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(gateway), selector(gateway)]);
		expect(lastAssistant(live).stopReason).toBe("stop");
	});

	it("still walks a classifier refusal to the next model, OpenAI included, as before", async () => {
		const { codex, openai, sonnet } = models();
		const { live, requested, fallbacks } = startSession({
			primary: codex,
			chains: { [selector(codex)]: [selector(openai), selector(sonnet)] },
			answer: model =>
				model.provider === codex.provider
					? {
							stopReason: "error",
							stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
							errorMessage: "Refusal (cyber): Declined.",
						}
					: { content: [`answered by ${selector(model)}`] },
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(codex), selector(openai)]);
		expect(fallbacks).toEqual([selector(openai)]);
		expect(lastAssistant(live).stopReason).toBe("stop");
	});
});
