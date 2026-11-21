import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CyberPolicyClosureApi } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * OpenAI refuses a request whose content it flags for cybersecurity risk with the error code
 * `cyber_policy`. Every copy of that request sent again, on any route that reaches OpenAI, adds a
 * refusal to the organization's record, and repeated refusals can revoke its access. So the refusal
 * ends the model call, and until input from outside the root session arrives no model call of the
 * process reaches an OpenAI route (or a route the catalog cannot classify); a model of another
 * family may still take the work.
 *
 * Every request here goes through pi-ai's real `streamSimple`, so the process's model-call checkpoint
 * sees it; a mock-API model with the route's provider and id answers it, and `requested` records only
 * the requests that got past the checkpoint. The error responses are synthetic: only the refusal's
 * code and OpenAI's wording.
 */
const MOCK_API_SOURCE = "test/agent-session-cyber-policy";
const CYBER_POLICY: MockResponse = {
	stopReason: "error",
	errorMessage:
		"cyber_policy: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.",
};
const OVERLOADED: MockResponse = {
	stopReason: "error",
	errorMessage: "503 Service Unavailable: the server is overloaded",
};

// Two provider names for one OpenAI-compatible gateway route, as a machine can declare them, and a
// gateway whose OpenAI model has an alias the catalog cannot classify, beside a Claude model on it.
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
  gw-a:
    api: openai-responses
    baseUrl: http://127.0.0.1:2/v1
    auth: none
    models:
      - id: sol-review
        name: sol-review
        contextWindow: 400000
        maxTokens: 128000
      - id: claude-sonnet-4-5
        name: claude-sonnet-4-5
        contextWindow: 200000
        maxTokens: 64000
  gw-b:
    api: openai-responses
    baseUrl: http://127.0.0.1:2/v1
    auth: none
    models:
      - id: sol-review
        name: sol-review
        contextWindow: 400000
        maxTokens: 128000
`;

const OUTSIDE = { origin: "outside" } as const;

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.messages.findLast(entry => entry.role === "assistant");
	if (message?.role !== "assistant") throw new Error("Expected an assistant message");
	return message;
}

describe("AgentSession after a cyber_policy refusal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	const others: AgentSession[] = [];

	beforeAll(async () => {
		registerMockApi(MOCK_API_SOURCE);
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
		for (const other of others.splice(0)) await other.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
		unregisterCustomApis(MOCK_API_SOURCE);
	});

	function models() {
		const gateway = modelRegistry.find("gateway-openai", "openai/gpt-6.1-sol");
		const gatewayAlias = modelRegistry.find("gateway", "openai/gpt-6.1-sol");
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		const openai = getBundledModel("openai", "gpt-5.5");
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		const daybreak = getBundledModel("openai", "daybreak-blue-latest");
		const aliasA = modelRegistry.find("gw-a", "sol-review");
		const aliasB = modelRegistry.find("gw-b", "sol-review");
		const gatewayClaude = modelRegistry.find("gw-a", "claude-sonnet-4-5");
		if (
			!gateway ||
			!gatewayAlias ||
			!codex ||
			!openai ||
			!sonnet ||
			!opus ||
			!daybreak ||
			!aliasA ||
			!aliasB ||
			!gatewayClaude
		) {
			throw new Error("Expected the gateway routes from models.yml and the bundled test models");
		}
		// The catalog puts every OpenAI route below in one lineage, whatever provider serves it.
		for (const model of [gateway, gatewayAlias, codex, openai]) expect(model.identity.class).toBe("openai");
		// It cannot classify OpenAI's Daybreak models or a gateway's own alias names.
		for (const model of [daybreak, aliasA, aliasB]) expect(model.identity.class).toBe("unknown");
		for (const model of [sonnet, opus, gatewayClaude]) expect(model.identity.class).toBe("anthropic");
		return { gateway, gatewayAlias, codex, openai, sonnet, opus, daybreak, aliasA, aliasB, gatewayClaude };
	}

	/**
	 * A session whose requests go through `streamSimple` to a mock-API model per route answered by
	 * `answer`; `requested` records each request that got past the model-call checkpoint.
	 */
	function startSession(options: {
		primary: Model;
		chains: Record<string, string[]>;
		maxRetries?: number;
		answer: (model: Model, routeAttempt: number) => MockResponse;
		tools?: AgentTool[];
		/** The parent's closure, as a subagent session receives it. */
		cyberPolicyClosure?: CyberPolicyClosureApi;
		/** Keeps an earlier session alive beside this one. */
		keepOthers?: boolean;
	}): { live: AgentSession; requested: string[]; fallbacks: string[]; nextRequest: () => Promise<void> } {
		const requested: string[] = [];
		const fallbacks: string[] = [];
		let waiter: PromiseWithResolvers<void> | undefined;
		const attempts = new Map<string, number>();
		const mocks = new Map<string, MockModel>();
		const mockFor = (model: Model): MockModel => {
			const route = selector(model);
			let mock = mocks.get(route);
			if (!mock) {
				mock = createMockModel({
					provider: model.provider,
					id: model.id,
					handler: () => {
						requested.push(route);
						const attempt = (attempts.get(route) ?? 0) + 1;
						attempts.set(route, attempt);
						waiter?.resolve();
						return options.answer(model, attempt);
					},
				});
				// The checkpoint reads the family of the model it is given: the mock's must be the route's.
				expect(mock.identity.class).toBe(model.identity.class);
				mocks.set(route, mock);
			}
			return mock;
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: options.primary, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: (model, context, streamOptions) => streamSimple(mockFor(model), context, streamOptions),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": options.maxRetries ?? 3,
			"retry.modelFallback": true,
			"retry.fallbackChains": options.chains,
		});
		settings.setModelRole("default", selector(options.primary));
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			cyberPolicyClosure: options.cyberPolicyClosure,
		});
		if (options.keepOthers) others.push(live);
		else session = live;
		live.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event.to);
		});
		const nextRequest = () => {
			waiter = Promise.withResolvers<void>();
			return waiter.promise;
		};
		return { live, requested, fallbacks, nextRequest };
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

	it("keeps every OpenAI route out of the walk until input from outside the session", async () => {
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

		// A person's next prompt may walk to OpenAI again.
		modelRegistry.clearSuppressedSelectors();
		await live.setModel(sonnet);
		requested.length = 0;
		await live.prompt("A new request", OUTSIDE);
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

	it("closes OpenAI routes the catalog cannot classify: Daybreak and a gateway alias", async () => {
		const { codex, daybreak, aliasB, sonnet } = models();
		const { live, requested } = startSession({
			primary: codex,
			chains: { [selector(codex)]: [selector(aliasB), selector(daybreak), selector(sonnet)] },
			answer: model => (model.provider === sonnet.provider ? { content: ["answered by Claude"] } : CYBER_POLICY),
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(codex), selector(sonnet)]);
		expect(lastAssistant(live).stopReason).toBe("stop");
	});

	it("closes an unclassified route's aliases but not a known other family on the same gateway", async () => {
		const { aliasA, aliasB, gatewayClaude } = models();
		const { live, requested } = startSession({
			primary: aliasA,
			chains: { [selector(aliasA)]: [selector(aliasB), selector(gatewayClaude)] },
			answer: model => (model.id === gatewayClaude.id ? { content: ["answered by Claude"] } : CYBER_POLICY),
		});

		await live.prompt("Review this change");
		await live.waitForIdle();

		expect(requested).toEqual([selector(aliasA), selector(gatewayClaude)]);
		expect(lastAssistant(live).stopReason).toBe("stop");
	});

	it("sends nothing for an automatic turn while every route left is closed, and keeps its input", async () => {
		const { gateway, gatewayAlias, codex } = models();
		const { live, requested } = startSession({
			primary: gateway,
			chains: { [selector(gateway)]: [selector(gatewayAlias), selector(codex)] },
			answer: () => CYBER_POLICY,
		});
		await live.prompt("Review this change");
		await live.waitForIdle();
		expect(requested).toEqual([selector(gateway)]);

		// A background job result arrives: the session starts a turn of its own.
		await live.sendCustomMessage(
			{ customType: "test-job-result", content: "job finished", display: true },
			{ triggerTurn: true },
		);
		await live.waitForIdle();

		expect(requested).toEqual([selector(gateway)]);
		expect(lastAssistant(live).errorMessage).toContain("cyber_policy");
		expect(live.messages.some(message => message.role === "custom" && message.customType === "test-job-result")).toBe(
			true,
		);

		// A person's next prompt ends the closure: that prompt reaches the route again.
		await live.prompt("Try another way", OUTSIDE);
		await live.waitForIdle();
		expect(requested).toEqual([selector(gateway), selector(gateway)]);
	});

	it("keeps the closure through prompts the session makes itself, until input from outside", async () => {
		const { codex, sonnet } = models();
		const { live, requested, nextRequest } = startSession({
			primary: codex,
			chains: { [selector(codex)]: [selector(sonnet)] },
			answer: model => (model.provider === codex.provider ? CYBER_POLICY : { content: ["answered by Claude"] }),
		});
		await live.prompt("Review this change");
		await live.waitForIdle();
		expect(requested).toEqual([selector(codex), selector(sonnet)]);

		// The refusing route's cooldown runs out, then a hook continues the turn on its own.
		modelRegistry.clearSuppressedSelectors();
		const continued = nextRequest();
		live.queueDeferredMessage({
			role: "custom",
			customType: "test-hook-continuation",
			content: "Continue.",
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		await continued;
		await live.waitForIdle();
		expect(requested).toEqual([selector(codex), selector(sonnet), selector(sonnet)]);

		// A prompt with no origin (an SDK or test caller) keeps it too.
		await live.prompt("Another request");
		await live.waitForIdle();
		expect(requested.at(-1)).toBe(selector(sonnet));

		// A person's prompt ends the closure, and the primary comes back (it refuses again, and the
		// walk then moves the turn to Claude once more).
		const before = requested.length;
		await live.prompt("Next request", OUTSIDE);
		await live.waitForIdle();
		expect(requested.slice(before)).toEqual([selector(codex), selector(sonnet)]);
	});

	// An extension relays deliveries: only one it tags as from outside (a person's turn) ends the closure;
	// another session's message, or one whose sender it cannot read, carries no such tag and keeps it.
	it("an extension's delivery ends the closure only when tagged as from outside", async () => {
		const { gateway } = models();
		const { live, requested } = startSession({
			primary: gateway,
			chains: {},
			answer: () => CYBER_POLICY,
		});
		await live.prompt("Review this change");
		await live.waitForIdle();
		expect(live.cyberPolicyClosure.active).toBe(true);

		// Another agent session's message: no tag.
		await live.sendCustomMessage(
			{ customType: "relay-message", content: "from another session", display: true },
			{ triggerTurn: true },
		);
		await live.waitForIdle();
		// A sender the extension could not read: tagged as made inside.
		await live.sendUserMessage("from an unknown sender", { origin: "inside" });
		await live.waitForIdle();
		// A value an omp does not know is no outside tag either.
		await live.sendUserMessage("from a future sender kind", { origin: "elsewhere" as never });
		await live.waitForIdle();
		expect(requested).toEqual([selector(gateway)]);
		expect(live.cyberPolicyClosure.active).toBe(true);

		// A person's turn relayed from a chat or ticket system.
		await live.sendUserMessage("A person's reply", { origin: "outside" });
		await live.waitForIdle();
		expect(requested).toEqual([selector(gateway), selector(gateway)]);
	});

	it("a custom message relaying a person's turn ends the closure", async () => {
		const { gateway } = models();
		const { live, requested } = startSession({ primary: gateway, chains: {}, answer: () => CYBER_POLICY });
		await live.prompt("Review this change");
		await live.waitForIdle();

		await live.sendCustomMessage(
			{ customType: "relay-message", content: "a person's comment", display: true },
			{ triggerTurn: true, origin: "outside" },
		);
		await live.waitForIdle();

		expect(requested).toEqual([selector(gateway), selector(gateway)]);
	});

	// `/compact`, `/handoff` and `/tree` from a person (TUI) or an RPC client are input from outside; the
	// compactions the session runs by itself (idle, overflow, extensions) are not.
	it.each([
		["compact", (live: AgentSession, origin?: "outside") => live.compact(undefined, { origin })],
		["handoff", (live: AgentSession, origin?: "outside") => live.handoff(undefined, { origin })],
		[
			"navigateTree",
			(live: AgentSession, origin?: "outside") =>
				live.navigateTree(live.sessionManager.getLeafId() ?? "", { summarize: false, origin }),
		],
	] as const)("a person's %s ends the closure; the session's own keeps it", async (_name, run) => {
		const { gateway } = models();
		const { live } = startSession({ primary: gateway, chains: {}, answer: () => CYBER_POLICY });
		await live.prompt("Review this change");
		await live.waitForIdle();
		expect(live.cyberPolicyClosure.active).toBe(true);

		// The maintenance itself may fail on this fixture (no history worth compacting, a held model):
		// only who asked for it decides the closure.
		await Promise.resolve(run(live)).catch(() => {});
		expect(live.cyberPolicyClosure.active).toBe(true);
		await Promise.resolve(run(live, "outside")).catch(() => {});
		expect(live.cyberPolicyClosure.active).toBe(false);
	});

	it("a loop iteration keeps the closure; a typed submission ends it", async () => {
		const { gateway } = models();
		const { live, requested } = startSession({
			primary: gateway,
			chains: {},
			answer: () => CYBER_POLICY,
		});
		await live.prompt("Review this change");
		await live.waitForIdle();
		const mode = {
			markPendingSubmissionStarted: () => true,
			finishPendingSubmission: () => {},
			showError: () => {},
			checkShutdownRequested: async () => {},
			skillCommands: new Map(),
			renderOptimisticSkillMessage: () => {},
			clearOptimisticSkillMessage: () => {},
			optimisticSkillMessagePending: false,
			restoreDroppedPrompt: () => {},
		} as never;

		// `/loop` resubmits its body as a submission without an origin.
		await submitInteractiveInput(mode, live, { text: "Keep going", cancelled: false, started: true });
		await live.waitForIdle();
		expect(requested).toEqual([selector(gateway)]);
		expect(live.cyberPolicyClosure.active).toBe(true);

		await submitInteractiveInput(mode, live, {
			text: "Try this",
			cancelled: false,
			started: true,
			origin: "outside",
		});
		await live.waitForIdle();
		expect(requested).toEqual([selector(gateway), selector(gateway)]);
	});

	it("an RPC client's steer or follow-up ends the closure; the session's own does not", async () => {
		const { gateway } = models();
		const { live } = startSession({ primary: gateway, chains: {}, answer: () => CYBER_POLICY });
		await live.prompt("Review this change");
		await live.waitForIdle();
		expect(live.cyberPolicyClosure.active).toBe(true);

		await live.followUp("queued by the session", undefined, { synthetic: true });
		expect(live.cyberPolicyClosure.active).toBe(true);
		await live.steer("a client's steer", undefined, { origin: "outside" }).catch(() => {});
		expect(live.cyberPolicyClosure.active).toBe(false);
	});

	it("sends no side-channel turn over the conversation to a closed route", async () => {
		const { gateway, gatewayAlias, sonnet } = models();
		const { live, requested } = startSession({
			primary: gateway,
			chains: { [selector(gateway)]: [selector(gatewayAlias)] },
			answer: () => CYBER_POLICY,
		});
		await live.prompt("Review this change");
		await live.waitForIdle();

		// The side turn's request uses pi-ai's own streamSimple: the checkpoint holds it.
		await expect(live.runEphemeralTurn({ promptText: "Recap where things stand." })).rejects.toThrow("cyber_policy");
		expect(requested).toEqual([selector(gateway)]);
		expect(live.cyberPolicyClosure.isClosed(sonnet)).toBe(false);
	});

	it("holds a run already in flight when its subagent's refusal closes the routes", async () => {
		const { openai, codex } = models();
		let child: { live: AgentSession; requested: string[] } | undefined;
		const delegate: AgentTool = {
			name: "delegate",
			label: "Delegate",
			description: "Runs a subagent",
			parameters: type({}),
			execute: async () => {
				child = startSession({
					primary: codex,
					chains: {},
					answer: () => CYBER_POLICY,
					cyberPolicyClosure: parent.live.cyberPolicyClosure,
					keepOthers: true,
				});
				await child.live.prompt("The delegated work");
				await child.live.waitForIdle();
				return { content: [{ type: "text", text: "the subagent stopped" }] };
			},
		};
		const parent = startSession({
			primary: openai,
			chains: {},
			maxRetries: 0,
			tools: [delegate],
			answer: (_model, attempt) =>
				attempt === 1
					? { content: [{ type: "toolCall", name: "delegate", arguments: {} }] }
					: { content: ["done"] },
		});

		await parent.live.prompt("Review this change", OUTSIDE);
		await parent.live.waitForIdle();

		expect(child?.requested).toEqual([selector(codex)]);
		// The parent's run was in flight when the closure opened: its next call is held.
		expect(parent.requested).toEqual([selector(openai)]);
		expect(lastAssistant(parent.live).errorMessage).toContain("cyber_policy");
	});

	it("a subagent shares its root's closure, and input to the subagent does not end it", async () => {
		const { codex, openai, sonnet } = models();
		const parent = startSession({
			primary: codex,
			chains: { [selector(codex)]: [selector(sonnet)] },
			answer: model => (model.provider === codex.provider ? CYBER_POLICY : { content: ["answered by Claude"] }),
		});
		await parent.live.prompt("Review this change");
		await parent.live.waitForIdle();
		const child = startSession({
			primary: openai,
			chains: {},
			answer: () => ({ content: ["child answer"] }),
			cyberPolicyClosure: parent.live.cyberPolicyClosure,
			keepOthers: true,
		});

		await child.live.prompt("Subagent task", OUTSIDE);
		await child.live.waitForIdle();

		expect(child.requested).toEqual([]);
		expect(lastAssistant(child.live).errorMessage).toContain("cyber_policy");
		expect(parent.live.cyberPolicyClosure.isClosed(codex)).toBe(true);
	});

	it("a subagent's refusal closes its root's routes, and only OpenAI's", async () => {
		const { codex, openai, sonnet } = models();
		const root = startSession({ primary: sonnet, chains: {}, answer: () => ({ content: ["ok"] }) });
		const child = startSession({
			primary: openai,
			chains: {},
			answer: () => CYBER_POLICY,
			cyberPolicyClosure: root.live.cyberPolicyClosure,
			keepOthers: true,
		});

		await child.live.prompt("Subagent task");
		await child.live.waitForIdle();

		expect(child.requested).toEqual([selector(openai)]);
		expect(root.live.cyberPolicyClosure.isClosed(codex)).toBe(true);
		expect(root.live.cyberPolicyClosure.isClosed(sonnet)).toBe(false);
	});

	// Two session trees in one process (an SDK host, an ACP agent, a server): one tree's refusal holds
	// its own tree, not the other, and a tree left undisposed never takes on the other's refusal.
	it("another session tree in the same process is neither held nor closed by this tree's refusal", async () => {
		const { gateway, openai } = models();
		const refusing = startSession({ primary: gateway, chains: {}, answer: () => CYBER_POLICY });
		const other = startSession({
			primary: openai,
			chains: {},
			answer: () => ({ content: ["answered"] }),
			keepOthers: true,
		});

		await refusing.live.prompt("Review this change");
		await refusing.live.waitForIdle();
		expect(refusing.live.cyberPolicyClosure.active).toBe(true);

		await other.live.prompt("Unrelated work");
		await other.live.waitForIdle();

		expect(other.live.cyberPolicyClosure.active).toBe(false);
		expect(other.requested).toEqual([selector(openai)]);
		expect(lastAssistant(other.live).stopReason).toBe("stop");
	});

	// A host can start a run on the session's agent itself (`session.agent.prompt`, public in the SDK),
	// past every session entry point: the agent's run still carries its tree's scope, so another tree's
	// refusal does not hold it as a call made outside every session.
	it("a run started on another tree's agent itself is not held by this tree's refusal", async () => {
		const { gateway, openai } = models();
		const refusing = startSession({ primary: gateway, chains: {}, answer: () => CYBER_POLICY });
		const other = startSession({
			primary: openai,
			chains: {},
			answer: () => ({ content: ["answered"] }),
			keepOthers: true,
		});

		await refusing.live.prompt("Review this change");
		await refusing.live.waitForIdle();
		expect(refusing.live.cyberPolicyClosure.active).toBe(true);

		await other.live.agent.prompt("Unrelated work");

		expect(other.requested).toEqual([selector(openai)]);
		expect(lastAssistant(other.live).stopReason).toBe("stop");
	});
});
