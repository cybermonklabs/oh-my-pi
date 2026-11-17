/**
 * The fallback walk after a failed request, with `retry.usageAwareFallback`
 * on: a fallback model whose usage is spent (every account held by an
 * exhausted quota window or a usage-limit block) is passed over, and every
 * other read (the reserve, unknown usage, a read that throws, a short
 * account-policy or 401 block, a depleted read that lists no account, a usage
 * limit on only some accounts) still switches to it, so the refusal steps keep
 * reaching the other accounts and models.
 *
 * The failing model P, the fallback X and the fallback after it Y are bundled
 * models of three providers. With the setting on, the check before every model
 * call also reads the current model's usage, so the usage stub answers P and Y
 * as well.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const MOCK_API_SOURCE = "agent-session-retry-fallback-usage-walk-test";
const WAIT_MS = 4_000;

const ACCOUNT_POLICY_DENIAL: MockResponse = {
	stopReason: "error",
	errorMessage:
		"This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
};
const CODEX_ACCOUNT_POLICY_DENIAL: MockResponse = {
	content: [{ type: "thinking", thinking: "Checking whether this security request is allowed." }],
	stopReason: "error",
	errorMessage:
		"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
};
const CLASSIFIER_REFUSAL: MockResponse = {
	content: [{ type: "thinking", thinking: "Classifier evaluation before refusal." }],
	stopReason: "error",
	stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
	errorMessage: "Refusal (cyber): Classifier declined this turn.",
};
const SERVER_ERROR = "500 Internal Server Error";

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected the bundled model ${provider}/${id}`);
	return model;
}

const PRIMARY = bundled("anthropic", "claude-sonnet-4-5");
const FALLBACK = bundled("openai", "gpt-4o-mini");
const NEXT_FALLBACK = bundled("google", "gemini-2.5-flash");
const CODEX = bundled("openai-codex", "gpt-5.6-sol");
const CODEX_FALLBACK = bundled("openai", "gpt-5.5");

function chainOf(...models: Model[]): Record<string, string[]> {
	return { default: models.map(formatModelString) };
}

/**
 * A stream that ends with a provider error stamped with the requested model's
 * identity, so the retry classifier reads it as that model's failure, with its
 * HTTP status when one is given.
 */
function providerErrorStream(model: Model, errorMessage: string, errorStatus?: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const failure: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			errorStatus,
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: failure });
	});
	return stream;
}

type DepletionCause = "usage" | "account-policy" | "auth";

/**
 * A depleted read with one account per cause, each held by a block of that
 * cause. The accounts are built apart from the read, so the read also
 * compiles against a usage type that names no cause.
 */
function depletedRead(...causes: DepletionCause[]): ModelUsageHealth {
	const accounts = causes.map((cause, index) => ({
		credentialId: index + 1,
		credentialType: "oauth" as const,
		state: "depleted" as const,
		depletedBy: cause,
	}));
	return { state: "depleted", accounts };
}

/** Rejects once `signal` aborts, and never before. */
function rejectWhenAborted(signal: AbortSignal | undefined): Promise<ModelUsageHealth> {
	if (!signal) return Promise.reject(new Error("The usage read got no abort signal"));
	const { promise, reject } = Promise.withResolvers<ModelUsageHealth>();
	if (signal.aborted) reject(signal.reason);
	else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	return promise;
}

type UsageAnswer = ModelUsageHealth | Error | ((signal: AbortSignal | undefined) => Promise<ModelUsageHealth>);

/**
 * An agent on `primary` that records each requested `provider/id`. Every
 * request to `primary` fails with `failure`; every other model answers.
 */
function createWalkAgent(
	primary: Model,
	requestedModels: string[],
	failure: MockResponse | ((model: Model) => AssistantMessageEventStream),
): Agent {
	const mock = createMockModel();
	return new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requestedModels.push(formatModelString(model));
			if (model.provider === primary.provider && model.id === primary.id) {
				if (typeof failure === "function") return failure(model);
				mock.push(failure);
			} else {
				mock.push({ content: ["answered"] });
			}
			return mock.stream(model, context, options);
		},
	});
}

function walkSettings(primary: Model, values: Readonly<Record<string, unknown>>): Settings {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.usageAwareFallback": true,
		...values,
	});
	settings.setModelRole("default", formatModelString(primary));
	return settings;
}

function modelOf(session: AgentSession): string | undefined {
	return session.model ? formatModelString(session.model) : undefined;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const last = session.messages.at(-1);
	if (last?.role !== "assistant") throw new Error("Expected the turn to end on an assistant message");
	return last;
}

async function runTurn(session: AgentSession, text: string): Promise<void> {
	await withTimeout(session.prompt(text), WAIT_MS, "The prompt did not settle");
	await withTimeout(session.waitForIdle(), WAIT_MS, "The session did not settle");
}

interface WalkRun {
	session: AgentSession;
	sessionManager: SessionManager;
	/** The `to` of each `retry_fallback_applied` event, in order. */
	fallbacks: string[];
}

describe("AgentSession fallback walk with usage-aware fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// One registry for the file: building it indexes every bundled model. Each
	// test resets the fallback cooldowns the walk leaves on it.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-usage-walk-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const provider of [PRIMARY.provider, FALLBACK.provider, NEXT_FALLBACK.provider]) {
			authStorage.keys.setRuntime(provider, `${provider}-test-key`);
		}
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
		unregisterCustomApis(MOCK_API_SOURCE);
		authStorage.keys.removeRuntime(CODEX.provider);
		await authStorage.credentials.remove(CODEX.provider);
	});

	/** Answers each usage read by the model's `provider/id`; a model `answers` does not name reads healthy. */
	function stubUsageReads(answers: Record<string, UsageAnswer>): void {
		vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async (provider, options) => {
			const answer = answers[`${provider}/${options.modelId}`];
			if (answer === undefined) return { state: "healthy", accounts: [] };
			if (answer instanceof Error) throw answer;
			return typeof answer === "function" ? answer(options.signal) : answer;
		});
	}

	function startSession(agent: Agent, settings: Settings, providerSessionId?: string): WalkRun {
		const sessionManager = SessionManager.inMemory();
		const started = new AgentSession({ agent, sessionManager, settings, modelRegistry, providerSessionId });
		session = started;
		const fallbacks: string[] = [];
		started.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event.to);
		});
		return { session: started, sessionManager, fallbacks };
	}

	/** The fallback X answered the turn: the walk switched onto it once and nothing else ran. */
	function expectAnsweredOnFallback(run: WalkRun, requestedModels: string[]): void {
		expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(FALLBACK)]);
		expect(run.fallbacks).toEqual([formatModelString(FALLBACK)]);
		expect(modelOf(run.session)).toBe(formatModelString(FALLBACK));
		expect(lastAssistant(run.session).stopReason).toBe("stop");
	}

	describe("passing over a spent fallback", () => {
		it("skips a fallback whose usage is spent and switches to the one after it", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
			// The session history never records a switch onto the spent model.
			const entries = run.sessionManager.getEntries();
			const modelChanges = entries.flatMap(entry => (entry.type === "model_change" ? [entry.model] : []));
			expect(modelChanges).toContain(formatModelString(NEXT_FALLBACK));
			expect(modelChanges).not.toContain(formatModelString(FALLBACK));
		});

		it("answers on the fallback after a spent one under the fail-closed reserve policy", async () => {
			// Switching onto the spent model would let the check before its request
			// end the turn with a fail-closed refusal although a usable fallback follows.
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.usageReservePolicy": "fail-closed",
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("ends the turn on the denial of the primary when its only fallback is spent", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			const last = lastAssistant(run.session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(ACCOUNT_POLICY_DENIAL.errorMessage);
		});

		it("ends the turn on the spent retry budget when the only fallback is spent", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, model => providerErrorStream(model, SERVER_ERROR, 500)),
				walkSettings(PRIMARY, { "retry.maxRetries": 0, "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			const last = lastAssistant(run.session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(`Retry budget exhausted after 0 retries: ${SERVER_ERROR}`);
		});

		it("switches to no fallback when the session is aborted during the usage read of a fallback", async () => {
			const readStarted = Promise.withResolvers<void>();
			stubUsageReads({
				[formatModelString(FALLBACK)]: signal => {
					readStarted.resolve();
					return rejectWhenAborted(signal);
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, model => providerErrorStream(model, SERVER_ERROR, 500)),
				walkSettings(PRIMARY, {
					"retry.maxRetries": 3,
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
				}),
			);

			const turn = run.session.prompt("Fail on the primary, then abort");
			try {
				await withTimeout(readStarted.promise, WAIT_MS, "The fallback's usage read did not start");
			} finally {
				await withTimeout(run.session.abort(), WAIT_MS, "The abort did not finish");
			}
			await withTimeout(turn, WAIT_MS, "The prompt did not settle");
			await withTimeout(run.session.waitForIdle(), WAIT_MS, "The session did not settle");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			expect(run.session.isRetrying).toBe(false);
		});
	});

	describe("switching to a fallback whose usage is not spent", () => {
		it("switches to a fallback at the reserve", async () => {
			stubUsageReads({
				[formatModelString(FALLBACK)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a fallback whose usage is unknown", async () => {
			stubUsageReads({
				[formatModelString(FALLBACK)]: {
					state: "unknown",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "unknown" }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a fallback whose usage read throws", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: new Error("usage endpoint unreachable") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		for (const cause of ["account-policy", "auth"] as const) {
			it(`switches to a depleted fallback that only a short ${cause} block holds`, async () => {
				stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead(cause) });
				const requestedModels: string[] = [];
				const run = startSession(
					createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
					walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
				);

				await runTurn(run.session, "Fail on the primary");

				expectAnsweredOnFallback(run, requestedModels);
			});
		}

		it("switches to a fallback whose depleted read lists no account", async () => {
			// The plan gate leaves this read when it filters every account out.
			stubUsageReads({ [formatModelString(FALLBACK)]: { state: "depleted", accounts: [] } });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a fallback that a usage limit holds on one account only", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage", "account-policy") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a spent fallback when usage-aware fallback is off", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.usageAwareFallback": false,
					"retry.fallbackChains": chainOf(FALLBACK),
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});
	});

	describe("refusal steps with every usage read healthy", () => {
		it("steps a classifier refusal down to the next model", async () => {
			stubUsageReads({});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, CLASSIFIER_REFUSAL),
				walkSettings(PRIMARY, { "retry.maxRetries": 1, "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Recover from a classifier refusal");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("tries every Codex account on an account-policy denial and then the configured fallback", async () => {
			const providerSessionId = "usage-walk-codex-account-policy";
			vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
			registerMockApi(MOCK_API_SOURCE);
			const accountKeys = ["codex-key-A", "codex-key-B", "codex-key-C", "codex-key-D"];
			await authStorage.credentials.set(
				CODEX.provider,
				accountKeys.map(key => ({ type: "api_key" as const, key })),
			);
			stubUsageReads({});
			const requestedKeys: string[] = [];
			const codexMock = createMockModel({
				id: CODEX.id,
				provider: CODEX.provider,
				handler: (_context, options) => {
					if (typeof options?.apiKey !== "string") {
						throw new Error("Expected streamSimple to pass a resolved string API key");
					}
					requestedKeys.push(options.apiKey);
					return CODEX_ACCOUNT_POLICY_DENIAL;
				},
			});
			const answerMock = createMockModel({ handler: { content: ["answered"] } });
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => modelRegistry.resolver(model, providerSessionId),
				sessionId: providerSessionId,
				initialState: { model: CODEX, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					return model.provider === CODEX.provider
						? aiStream.streamSimple(codexMock.model, context, options)
						: answerMock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(CODEX, { "retry.maxRetries": 0, "retry.fallbackChains": chainOf(CODEX_FALLBACK) }),
				providerSessionId,
			);

			await runTurn(run.session, "Continue authorized security work");

			expect(requestedModels).toEqual([
				...accountKeys.map(() => formatModelString(CODEX)),
				formatModelString(CODEX_FALLBACK),
			]);
			expect([...requestedKeys].sort()).toEqual(accountKeys);
			expect(run.fallbacks).toEqual([formatModelString(CODEX_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(CODEX_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("walks a Codex plan denial to the same model on another provider", async () => {
			authStorage.keys.setRuntime(CODEX.provider, `${CODEX.provider}-test-key`);
			stubUsageReads({});
			const requestedModels: string[] = [];
			const planDenial = `Codex error event: The '${CODEX.id}' model is not supported when using Codex with a ChatGPT account. (code=model_not_found)`;
			const run = startSession(
				createWalkAgent(CODEX, requestedModels, model => providerErrorStream(model, planDenial)),
				walkSettings(CODEX, { "retry.fallbackChains": { [`${CODEX.provider}/*`]: ["openai/*"] } }),
			);

			await runTurn(run.session, "Use a model the plan does not include");

			const sameModelElsewhere = `openai/${CODEX.id}`;
			expect(requestedModels).toEqual([formatModelString(CODEX), sameModelElsewhere]);
			expect(run.fallbacks).toEqual([sameModelElsewhere]);
			expect(modelOf(run.session)).toBe(sameModelElsewhere);
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});
	});

	describe("a classifier refusal whose fallback-credit target is spent", () => {
		// The catalog lets Fable's refusal credit be redeemed on Opus 4.8 and not on Sonnet 4.5.
		const FABLE = bundled("anthropic", "claude-fable-5");
		const CREDIT_TARGET = bundled("anthropic", "claude-opus-4-8");
		const OTHER_CLAUDE = bundled("anthropic", "claude-sonnet-4-5");

		/** A Fable refusal that carries a live fallback credit. */
		function refusalWithCredit(): MockResponse {
			return {
				content: [{ type: "thinking", thinking: "Before the refusal.", thinkingSignature: "sig_fable_refusal" }],
				stopReason: "error",
				stopDetails: {
					type: "refusal",
					category: "cyber",
					explanation: "Classifier declined this turn.",
					fallback_credit_token: "fct_signed_test",
					fallback_has_prefill_claim: true,
				},
				errorMessage: "Refusal (cyber): Classifier declined this turn.",
				fallbackCreditHandle: {
					token: "fct_signed_test",
					prefillClaim: true,
					params: {
						model: FABLE.id,
						messages: [{ role: "user", content: "Test prompt" }],
						max_tokens: 1024,
						stream: true,
					},
					betas: ["fallback-credit-2026-06-01"],
					expiresAt: Date.now() + 60_000,
				},
			};
		}

		// Each order reaches the other Claude model by a different path: after the
		// walk passes over the spent target, or before the walk reads the target.
		for (const [order, chain] of [
			["the target first", chainOf(CREDIT_TARGET, OTHER_CLAUDE)],
			["the other model first", chainOf(OTHER_CLAUDE, CREDIT_TARGET)],
		] as const) {
			it(`steps a refusal past its spent fallback-credit target to the next model (${order})`, async () => {
				stubUsageReads({ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") });
				const requestedModels: string[] = [];
				// Stamped with Fable's identity, so the retry policy reads the refusal as Fable's.
				const mock = createMockModel({
					provider: FABLE.provider,
					id: FABLE.id,
					responses: [
						{
							content: [
								{ type: "thinking", thinking: "Signed reasoning.", thinkingSignature: "seed-signature" },
								"Seeded turn",
							],
						},
						refusalWithCredit(),
					],
					handler: { content: ["answered"] },
				});
				const agent = new Agent({
					getApiKey: model => `${model.provider}-test-key`,
					initialState: { model: FABLE, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: (model, context, options) => {
						requestedModels.push(formatModelString(model));
						return mock.stream(model, context, options);
					},
				});
				const run = startSession(
					agent,
					walkSettings(FABLE, {
						"retry.maxRetries": 1,
						"retry.fallbackChains": chain,
						"retry.fallbackRevertPolicy": "cooldown-expiry",
					}),
				);
				await runTurn(run.session, "Seed signed thinking");
				// While a Fable turn with signed thinking leads the history and the
				// credit is live, the refusal walk passes over the Claude models that
				// cannot redeem it.
				const seeded = agent.state.messages.findLast(
					(message): message is AssistantMessage => message.role === "assistant",
				);
				if (!seeded) throw new Error("Expected the seeded assistant message");
				seeded.api = FABLE.api;

				await runTurn(run.session, "Recover from the refusal");

				expect(requestedModels).toEqual([
					formatModelString(FABLE),
					formatModelString(FABLE),
					formatModelString(OTHER_CLAUDE),
				]);
				expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
				expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
				expect(lastAssistant(run.session).stopReason).toBe("stop");
			});
		}
	});

	describe("the fallback before a turn keeps its rule", () => {
		it("passes over a fallback at the reserve when the primary is spent before its first request", async () => {
			// The walk after a failed request switches to a fallback at the reserve.
			// The check before the model call does not: on a spent primary it moves
			// to the first fallback that is neither spent nor at the reserve.
			stubUsageReads({
				[formatModelString(PRIMARY)]: depletedRead("usage"),
				[formatModelString(FALLBACK)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK) }),
			);

			await runTurn(run.session, "Start on a spent primary");

			expect(requestedModels).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});
	});
});
