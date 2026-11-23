/**
 * A revived subagent runs on the spawn's model, thinking level, LSP and cache-warming values and wake-turn
 * limit, wherever the cold revive runs; after the root session moved it builds in the directory its tools run in,
 * finds its project's tool sources there and still masks the root project's secrets, and with its parent parked
 * it takes the root session's workspace roots and credential source. Unless a case says other, it spawns a real
 * subagent on a scripted model, parks it, drops its warm reviver as a subagent worker's exit does, and revives it
 * cold through the persisted reviver factory;
 * `createAgentSession`'s options are read through the harness's call-through spy and every request as the
 * provider received it.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as lspModule from "@oh-my-pi/pi-coding-agent/lsp";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { assertPerCallModelApproved } from "@oh-my-pi/pi-coding-agent/task/model-approval";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { cfgTaskMaxEffort, cfgTaskMaxRuntimeMs } from "@oh-my-pi/pi-coding-agent/task/settings";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ThreadId } from "@oh-my-pi/pi-coding-agent/thread/identity";
import { RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, isRecord, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";
import {
	editStoredSpawnSpecs,
	expectEndedAtLimit,
	fixtureAgent,
	HELD,
	heldTurn,
	holdWake,
	type LifecycleFrame,
	type LiveParent,
	LOOKUP_TOOL,
	lastToolResult,
	limitLogged,
	openReviveEnv,
	type RecordedRequest,
	type ReviveEnv,
	type RevivedSubagent,
	recordFrames,
	SPAWN_MODEL,
	SPAWN_TASK,
	type SpawnedSubagent,
	sessionInitRecords,
	spawnerOptions,
	type ToolResultText,
	userTexts,
	WAKE_BODY,
} from "./revive-harness";

/** The alias a spawn names its role by; `modelRoles.task` maps it. */
const ROLE_ALIAS = "@task";
/** A model `modelRoles.task` names between the spawn and the revive. */
const ROLE_MOVED_MODEL = "mock/mock-role-moved";
/** The model of a spawn whose model the registry no longer lists at the revive. */
const LEAVING_MODEL = "mock/mock-leaving";
/** The next model of a subagent's retry-fallback chain. */
const CHAIN_MODEL = "mock/mock-chain";
/** A model that takes a thinking level. */
const THINKING_MODEL = "mock/mock-thinking";
/** The target of a session-local switch, also taking a thinking level. */
const SWITCHED_MODEL = "mock/mock-switched";
/** The model of a per-call worker's spawn. */
const PER_CALL_MODEL = "mock/mock-percall";

/** omp's log holds the spawn's own `Model … not found` text for `gone`, naming `id` and the model it started on. */
function moveLogged(warn: Mock<typeof logger.warn>, id: string, gone: string, started: string): boolean {
	// The message as logged: `Bun.inspect` escapes the quotes of a string nested in the arguments.
	return warn.mock.calls
		.map(([message, fields]) => `${message} ${Bun.inspect(fields)}`)
		.some(text => text.includes(`Model "${gone}" not found`) && text.includes(id) && text.includes(started));
}

/** Usage-aware selection reads the quota of `modelId` as depleted, and every other model's as healthy. */
function readAsDepleted(env: ReviveEnv, modelId: string): void {
	vi.spyOn(env.authStorage.health, "model").mockImplementation(async (_provider, options) =>
		options.modelId === modelId
			? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
			: { state: "healthy", accounts: [] },
	);
}

/** Bound on the wait for a woken subagent's first request: a revive that built no usable session sends none. */
const FIRST_REQUEST_BOUND_MS = 15_000;

/** Wakes `id` on `session` as a peer's IRC message does: its turn's first request, or undefined when none came within the bound. */
async function wakeWithin(env: ReviveEnv, session: AgentSession, id: string): Promise<RecordedRequest | undefined> {
	const bound = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => bound.resolve(undefined), FIRST_REQUEST_BOUND_MS);
	try {
		return await Promise.race([env.wake(session, id), bound.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** A task spawn of `id` by `parent`, with `extra` over the shared spawn inputs. */
function taskSpawn(
	env: ReviveEnv,
	parent: ToolSession,
	id: string,
	extra: Partial<ExecutorOptions> = {},
): ExecutorOptions {
	return { ...spawnerOptions(parent), ...env.subagentInputs(id), ...extra };
}

async function spawnAndPark(env: ReviveEnv, options: ExecutorOptions): Promise<SpawnedSubagent> {
	const spawned = await env.spawn(options);
	await env.park(options.id);
	return spawned;
}

async function reviveCold(env: ReviveEnv, id: string): Promise<RevivedSubagent> {
	env.dropWarmReviver(id);
	return env.revive(id);
}

/** A test process with a live root parent and the cold reviver over it. */
async function openTestProcess(
	settings: Readonly<Record<string, unknown>> = {},
): Promise<{ env: ReviveEnv; root: LiveParent }> {
	const env = await openReviveEnv(settings);
	const root = env.createLiveParent();
	env.installColdReviver(root);
	return { env, root };
}

/** The live session of a spawned subagent, which its spawn left idle and adopted. */
function liveSession(id: string): AgentSession {
	return localSession(AgentRegistry.global().get(id)?.session);
}

/** Records a session-local switch (a prewalk hand-off) to `model`, with the thinking level high, in `id`'s transcript. */
function recordSessionLocalSwitch(id: string, model: string): void {
	const sessionManager = liveSession(id).sessionManager;
	sessionManager.appendModelChange(model, "prewalk");
	sessionManager.appendThinkingLevelChange(Effort.High, Effort.High);
}

/** The first `createAgentSession` call of `id`: its spawn's build. */
function spawnBuildOptions(env: ReviveEnv, id: string) {
	const build = env.builds.find(candidate => candidate.options.agentId === id);
	if (!build) throw new Error(`${id} was never built`);
	return build.options;
}

describe("a task subagent spawned with LSP off, under idle cache warming", () => {
	const id = "LspOffIdleWarming";
	let env: ReviveEnv | undefined;
	let spawnHadWarmer: boolean | undefined;
	let cold: RevivedSubagent | undefined;
	let writethroughsDuringWake = -1;

	beforeAll(async () => {
		const opened = await openTestProcess({ "providers.cacheWarming": "idle" });
		env = opened.env;
		await env.spawn(taskSpawn(env, opened.root.toolSession, id));
		spawnHadWarmer = liveSession(id).cacheWarmingStatus !== undefined;
		await env.park(id);
		// The root's LSP policy is on (the harness's factory), while the spawn turned LSP off.
		cold = await reviveCold(env, id);
		const writethrough = vi.spyOn(lspModule, "createLspWritethrough");
		const before = writethrough.mock.calls.length;
		env.turns = {
			...env.turns,
			wakeToolCall: { name: "write", arguments: { path: "notes.ts", content: "export const rows = 1;\n" } },
		};
		await wakeWithin(env, cold.session, id);
		writethroughsDuringWake = writethrough.mock.calls.length - before;
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("cache warming: the cold-revived session has the spawn's cache-warming value, false, and no cache warmer", () => {
		if (!env || !cold) throw new Error("The test process did not start");
		expect(spawnBuildOptions(env, id).cacheWarming).toBe(false);
		expect(spawnHadWarmer).toBe(false);
		expect(cold.build.options.cacheWarming).toBe(false);
		expect(cold.session.cacheWarmingStatus).toBeUndefined();
	}, 30_000);

	it("LSP: a spawn with LSP off revives with LSP off, and a write after the revive runs no LSP writethrough", () => {
		if (!cold) throw new Error("The test process did not start");
		expect(cold.build.options.enableLsp).toBe(false);
		expect(lastToolResult(cold.session, "write")?.isError).toBe(false);
		expect(writethroughsDuringWake).toBe(0);
	}, 30_000);
});

describe("the role moved and the spawn's provider reads as depleted", () => {
	const id = "RoleMovedDepleted";
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({
			modelRoles: { default: SPAWN_MODEL, task: SPAWN_MODEL },
			"retry.usageAwareFallback": true,
		});
		env = opened.env;
		env.addModel("mock-role-moved");
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: ROLE_ALIAS }));
		env.settings.setModelRole("task", ROLE_MOVED_MODEL);
		readAsDepleted(env, "mock-model");
		const cold = await reviveCold(env, id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("model: the first request after the cold revive names the spawn's exact model", () => {
		expect(request?.model).toBe(SPAWN_MODEL);
	}, 30_000);
});

describe("a spawn whose model the session resolved from a pattern, revived warm", () => {
	const id = "PatternResolved";
	const discovered = "mock/mock-discovered";
	let env: ReviveEnv | undefined;
	let spawned: SpawnedSubagent | undefined;
	let request: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({ modelRoles: { default: SPAWN_MODEL, task: discovered } });
		env = opened.env;
		// The role's model is listed only after discovery, so the spawn leaves the model to the session.
		env.addDiscoveredModel("mock-discovered");
		env.addModel("mock-role-moved");
		spawned = await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: ROLE_ALIAS }));
		env.settings.setModelRole("task", ROLE_MOVED_MODEL);
		const warm = await env.revive(id);
		request = await wakeWithin(env, warm.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("model: after a warm revive, the first request names the model the session started on", () => {
		if (!env) throw new Error("The test process did not start");
		const options = spawnBuildOptions(env, id);
		expect(options.model).toBeUndefined();
		expect(options.modelPattern).toBeDefined();
		expect(spawned?.lastRequest.model).toBe(discovered);
		expect(request?.model).toBe(discovered);
	}, 30_000);
});

describe("a thinking level change in the transcript, with no session-local switch", () => {
	const id = "ThinkingChanged";
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;
	let request: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.addModel("mock-thinking", { thinking: true });
		// The fixture agent's thinking level is low; the transcript then records a change to high.
		await env.spawn(taskSpawn(env, opened.root.toolSession, id, { modelOverride: THINKING_MODEL }));
		liveSession(id).sessionManager.appendThinkingLevelChange(Effort.High, Effort.High);
		await env.park(id);
		cold = await reviveCold(env, id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("thinking: the cold-revived level is the spec's, not the transcript's", () => {
		expect(cold?.build.options.thinkingLevel).toBe(Effort.Low);
		expect(request?.model).toBe(THINKING_MODEL);
		expect(request?.reasoning).toBe(Effort.Low);
	}, 30_000);
});

describe("a session-local model switch in the transcript", () => {
	let env: ReviveEnv | undefined;
	let warmRequest: RecordedRequest | undefined;
	let coldRequest: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.addModel("mock-thinking", { thinking: true });
		env.addModel("mock-switched", { thinking: true });
		// Two subagents in the same state, so each revive starts from the transcript the switch left.
		for (const id of ["SwitchedWarm", "SwitchedCold"]) {
			await env.spawn(taskSpawn(env, opened.root.toolSession, id, { modelOverride: THINKING_MODEL }));
			recordSessionLocalSwitch(id, SWITCHED_MODEL);
			await env.park(id);
		}
		const warm = await env.revive("SwitchedWarm");
		warmRequest = await wakeWithin(env, warm.session, "SwitchedWarm");
		const cold = await reviveCold(env, "SwitchedCold");
		coldRequest = await wakeWithin(env, cold.session, "SwitchedCold");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("prewalk: after a warm revive, the first request names the switched model at the transcript's level", () => {
		expect(warmRequest?.model).toBe(SWITCHED_MODEL);
		expect(warmRequest?.reasoning).toBe(Effort.High);
	}, 30_000);

	it("prewalk: after a cold revive, the first request names the switched model at the transcript's level", () => {
		expect(coldRequest?.model).toBe(SWITCHED_MODEL);
		expect(coldRequest?.reasoning).toBe(Effort.High);
	}, 30_000);
});

describe("a wake limit of 2000 ms at spawn, the live setting 0 at the revive", () => {
	const id = "WakeLimit";
	let env: ReviveEnv | undefined;
	let frames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await openTestProcess({ "task.maxRuntimeMs": 2_000 });
		env = opened.env;
		frames = recordFrames(env.eventBus);
		const options = { description: "wake limit row", parentToolCallId: "call-wake-limit" };
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, options));
		env.dropWarmReviver(id);
		cfgTaskMaxRuntimeMs.override(env.settings, 0);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("wake limit: the cold-revived wake turn ends at the spawn's limit, its frames carrying the spawn's agent source, description and parentToolCallId", async () => {
		if (!env) throw new Error("The test process did not start");
		const warn = vi.spyOn(logger, "warn");
		env.respond = holdWake;
		const from = frames.length;
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		expect(receipt.outcome).toBe("revived");
		const turn = await heldTurn(frames, id, from);
		expect(turn.started.agentSource).toBe("bundled");
		expect(turn.started.description).toBe("wake limit row");
		expect(turn.started.parentToolCallId).toBe("call-wake-limit");
		expectEndedAtLimit(turn, 2_000);
		expect(limitLogged(warn, id, 2_000)).toBe(true);
	}, 30_000);
});

describe("a spawn's own limit of 3000 ms through runStructuredSubagent, the setting 0", () => {
	const id = "OwnLimit";
	let env: ReviveEnv | undefined;
	let frames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		frames = recordFrames(env.eventBus);
		const main = SessionManager.create(env.cwd, path.join(env.root, "sessions"));
		main.appendMessage({ role: "user", content: "Run the batch.", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted root session file");
		await main.close();
		const session: ToolSession = { ...opened.root.toolSession, getSessionFile: () => mainFile };
		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: SPAWN_TASK,
			agent: "task",
			model: SPAWN_MODEL,
			maxRuntimeMs: 3_000,
			identity: { id },
			parentToolCallId: "call-own-limit",
			keepAlive: true,
		});
		if (execution.result.exitCode !== 0) throw new Error(`Spawn of ${id} failed: ${execution.result.error}`);
		await env.park(id);
		env.dropWarmReviver(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a spawn's own limit: the cold-revived wake turn ends at the limit the spawn was given", async () => {
		if (!env) throw new Error("The test process did not start");
		const warn = vi.spyOn(logger, "warn");
		env.respond = holdWake;
		const from = frames.length;
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		expect(receipt.outcome).toBe("revived");
		expectEndedAtLimit(await heldTurn(frames, id, from), 3_000);
		expect(limitLogged(warn, id, 3_000)).toBe(true);
	}, 30_000);
});

/**
 * Models of the requests of `id`'s next wake turn on `revived`, whose first attempt the provider refuses with
 * a retryable error.
 */
async function wakeModelsAfterRefusal(env: ReviveEnv, revived: RevivedSubagent, id: string): Promise<string[]> {
	const from = env.requests.length;
	let refused = false;
	env.respond = request => {
		if (refused || !userTexts(request).some(text => text.includes(WAKE_BODY))) return undefined;
		refused = true;
		return { throw: "overloaded_error: provider returned error 503" };
	};
	await wakeWithin(env, revived.session, id);
	env.respond = undefined;
	return env.requests.slice(from).map(request => request.model);
}

describe("a retryable failure after either revive", () => {
	let env: ReviveEnv | undefined;
	let warmModels: string[] = [];
	let coldModels: string[] = [];

	beforeAll(async () => {
		const opened = await openTestProcess({
			"retry.enabled": true,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
			modelRoles: { default: SPAWN_MODEL, task: SPAWN_MODEL },
			"retry.fallbackChains": { task: [CHAIN_MODEL] },
		});
		env = opened.env;
		env.addModel("mock-chain");
		for (const id of ["RetryWarm", "RetryCold"]) {
			await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: ROLE_ALIAS }));
		}
		warmModels = await wakeModelsAfterRefusal(env, await env.revive("RetryWarm"), "RetryWarm");
		coldModels = await wakeModelsAfterRefusal(env, await reviveCold(env, "RetryCold"), "RetryCold");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("retry fallback: the models of the attempts are the same after a warm and after a cold revive", () => {
		// The first attempt of each wake turn went to the spawn's model and was refused.
		expect(warmModels[0]).toBe(SPAWN_MODEL);
		expect(coldModels).toEqual(warmModels);
	}, 30_000);
});

describe("the spawn's model gone after discovery, with a chain for the role", () => {
	const id = "GoneWithChain";
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;
	let request: RecordedRequest | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({
			modelRoles: { default: SPAWN_MODEL, task: LEAVING_MODEL },
			"retry.fallbackChains": { task: [CHAIN_MODEL] },
		});
		env = opened.env;
		env.scriptDiscovery();
		for (const model of ["mock-leaving", "mock-chain", "mock-role-moved"]) env.addModel(model);
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: ROLE_ALIAS }));
		env.removeModel(LEAVING_MODEL);
		// The role now names a model that is not the next model of the chain.
		env.settings.setModelRole("task", ROLE_MOVED_MODEL);
		warn = vi.spyOn(logger, "warn");
		cold = await reviveCold(env, id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("model gone, with a chain: the cold revive starts on the chain's next known model, the turn ends normally, and omp logs the move", () => {
		if (!cold || !warn) throw new Error("The test process did not start");
		expect(request?.model).toBe(CHAIN_MODEL);
		const last = cold.session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
		expect(moveLogged(warn, id, LEAVING_MODEL, CHAIN_MODEL)).toBe(true);
	}, 30_000);
});

describe("the spawn's model gone, no chain, a nested subagent", () => {
	const liveChild = "ChildOfLiveParent";
	const parkedChild = "ChildOfParkedParent";
	const parentModel = "mock/mock-parent";
	let env: ReviveEnv | undefined;
	let warn: Mock<typeof logger.warn> | undefined;
	let liveParentRequest: RecordedRequest | undefined;
	let parkedParentRequest: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({ modelRoles: { default: SPAWN_MODEL, task: LEAVING_MODEL } });
		env = opened.env;
		env.scriptDiscovery();
		for (const model of ["mock-leaving", "mock-parent", "mock-role-moved"]) env.addModel(model);
		for (const [parentId, childId] of [
			["LiveParent", liveChild],
			["ParkedParent", parkedChild],
		]) {
			await env.spawn(taskSpawn(env, opened.root.toolSession, parentId, { modelOverride: parentModel }));
			const parent = env.toolSessionOf(parentId);
			await spawnAndPark(env, taskSpawn(env, parent, childId, { modelOverride: ROLE_ALIAS }));
			env.dropWarmReviver(childId);
		}
		await env.park("ParkedParent");
		env.removeModel(LEAVING_MODEL);
		// The role now names a model other than the parent's.
		env.settings.setModelRole("task", ROLE_MOVED_MODEL);
		warn = vi.spyOn(logger, "warn");
		const live = await env.revive(liveChild);
		liveParentRequest = await wakeWithin(env, live.session, liveChild);
		const parked = await env.revive(parkedChild);
		parkedParentRequest = await wakeWithin(env, parked.session, parkedChild);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("model gone, no chain: the first request names the model of the parent's live session", () => {
		if (!warn) throw new Error("The test process did not start");
		expect(liveParentRequest?.model).toBe(parentModel);
		expect(moveLogged(warn, liveChild, LEAVING_MODEL, parentModel)).toBe(true);
	}, 30_000);

	it("model gone, no chain, the parent a parked subagent: the first request names the root session's model", () => {
		if (!warn) throw new Error("The test process did not start");
		expect(parkedParentRequest?.model).toBe(SPAWN_MODEL);
		expect(moveLogged(warn, parkedChild, LEAVING_MODEL, SPAWN_MODEL)).toBe(true);
	}, 30_000);
});

describe("model kinds a spawn can start on", () => {
	// Ids no bundled catalog model has, so the provider's runtime key lists no second model with the same id.
	const openRouterBase = buildModel({
		id: "fixture-lab/fixture-model",
		name: "Fixture Model",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const bedrockBase = buildModel({
		id: "fixture-bedrock-base",
		name: "Bedrock base",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
	const kinds = [
		{ id: "CloneKind", kind: "a requested-id clone", pattern: "openrouter/fixture-lab/fixture-model-20251222:nitro" },
		{
			id: "ProfileKind",
			kind: "an inference-profile model",
			pattern: "amazon-bedrock/arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/fixture-profile",
		},
		{ id: "DiscoveredKind", kind: "a model from runtime discovery", pattern: "mock/mock-discovered" },
	];
	const spawnedOn = new Map<string, string>();
	const revivedOn = new Map<string, string | undefined>();
	let env: ReviveEnv | undefined;

	beforeAll(async () => {
		// A chain for every subagent, so a revive that loses the exact model moves to a model of the chain.
		const opened = await openTestProcess({ "retry.fallbackChains": { default: [CHAIN_MODEL] } });
		env = opened.env;
		env.addModel("mock-chain");
		env.addProviderModel(openRouterBase);
		env.addProviderModel(bedrockBase);
		env.addDiscoveredModel("mock-discovered");
		for (const { id, pattern } of kinds) {
			const options = taskSpawn(env, opened.root.toolSession, id, { modelOverride: pattern });
			spawnedOn.set(id, (await spawnAndPark(env, options)).lastRequest.model);
		}
		// A resumed process: no warm reviver, and a registry whose discovery has not run yet.
		env.restart(opened.root);
		env.forgetDiscovery();
		for (const { id } of kinds) {
			const cold = await env.revive(id);
			revivedOn.set(id, (await wakeWithin(env, cold.session, id))?.model);
		}
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	for (const { id, kind, pattern } of kinds) {
		it(`model kinds: a subagent spawned on ${kind} revives cold on the same model, not a model of the chain`, () => {
			expect(spawnedOn.get(id)).toBe(pattern);
			expect(revivedOn.get(id)).toBe(pattern);
		}, 30_000);
	}
});

/** One case of a per-call worker: the roles and default chain it spawns under, and what changes before the revive. */
interface PerCallCase {
	title: string;
	id: string;
	roles: Readonly<Record<string, string>>;
	chain?: string[];
	beforeRevive: (env: ReviveEnv) => void;
	check: (env: ReviveEnv, spawned: SpawnedSubagent) => Promise<void>;
}

/** The wake request after a cold revive of `id` names `model`. */
async function expectRevivedOn(env: ReviveEnv, id: string, model: string): Promise<void> {
	const cold = await env.revive(id);
	expect((await wakeWithin(env, cold.session, id))?.model).toBe(model);
}

const PER_CALL_CASES: PerCallCase[] = [
	{
		title: "saved model there: it revives cold on its saved per-call model and level, its ceiling the lower of the spec's and the live task.maxEffort",
		id: "PerCallSaved",
		roles: { smol: PER_CALL_MODEL },
		beforeRevive: env => cfgTaskMaxEffort.override(env.settings, Effort.High),
		check: async (env, spawned) => {
			const [record] = await sessionInitRecords(spawned.sessionFile);
			const cold = await env.revive(spawned.id);
			const request = await wakeWithin(env, cold.session, spawned.id);
			const model = cold.build.options.model;
			expect(model ? formatModelStringWithRouting(model) : undefined).toBe(PER_CALL_MODEL);
			expect<unknown>(cold.build.options.thinkingLevel).toBe(record?.perCallThinkingLevel ?? undefined);
			expect(cold.build.options.thinkingLevelCeiling).toBe(Effort.Medium);
			expect(request?.model).toBe(PER_CALL_MODEL);
		},
	},
	{
		title: "saved model gone, the next chain model approved: it resumes on that model",
		id: "PerCallGoneChain",
		roles: { smol: PER_CALL_MODEL, slow: CHAIN_MODEL },
		chain: [CHAIN_MODEL],
		beforeRevive: env => env.removeModel(PER_CALL_MODEL),
		check: (env, spawned) => expectRevivedOn(env, spawned.id, CHAIN_MODEL),
	},
	{
		title: "saved model unapproved and no chain model approved: the revive is refused with an error that names the grant",
		id: "PerCallUnapproved",
		roles: { smol: PER_CALL_MODEL },
		chain: [CHAIN_MODEL],
		beforeRevive: env => env.settings.setModelRole("smol", undefined),
		check: async (env, spawned) => {
			await expect(env.revive(spawned.id)).rejects.toThrow(/is not approved for agent/);
		},
	},
	{
		title: "saved model gone and no other model in its chain: the revive is refused with an error that names the model",
		id: "PerCallGoneAlone",
		roles: { smol: PER_CALL_MODEL },
		beforeRevive: env => env.removeModel(PER_CALL_MODEL),
		check: async (env, spawned) => {
			await expect(env.revive(spawned.id)).rejects.toThrow(`${PER_CALL_MODEL} is no longer available`);
		},
	},
	{
		title: "saved model still listed but no longer approved: it resumes on the next model of its chain the grants approve",
		id: "PerCallUnapprovedChain",
		roles: { smol: PER_CALL_MODEL, slow: CHAIN_MODEL },
		chain: [CHAIN_MODEL],
		beforeRevive: env => env.settings.setModelRole("smol", undefined),
		check: (env, spawned) => expectRevivedOn(env, spawned.id, CHAIN_MODEL),
	},
];

for (const perCall of PER_CALL_CASES) {
	describe(`a per-call worker revived cold (${perCall.id})`, () => {
		let env: ReviveEnv | undefined;
		let spawned: SpawnedSubagent | undefined;

		beforeAll(async () => {
			const opened = await openTestProcess({
				modelRoles: { default: SPAWN_MODEL, ...perCall.roles },
				...(perCall.chain ? { "retry.fallbackChains": { default: perCall.chain } } : {}),
				"task.maxEffort": Effort.Medium,
			});
			env = opened.env;
			env.scriptDiscovery();
			env.addModel("mock-percall");
			env.addModel("mock-chain");
			spawned = await spawnAndPark(env, {
				...taskSpawn(env, opened.root.toolSession, perCall.id, { modelOverride: PER_CALL_MODEL }),
				parentActiveModelPattern: SPAWN_MODEL,
				perCallModelGrants: {
					settings: opened.root.toolSession.settings,
					agentName: "task",
					agentSource: "bundled",
					parentModelPattern: SPAWN_MODEL,
				},
			});
			env.dropWarmReviver(perCall.id);
			perCall.beforeRevive(env);
		}, 60_000);

		afterAll(async () => {
			await env?.close();
		}, 30_000);

		it(
			perCall.title,
			async () => {
				if (!env || !spawned) throw new Error("The test process did not start");
				await perCall.check(env, spawned);
			},
			30_000,
		);
	});
}

describe("a killed subagent revived cold by an IRC send", () => {
	const id = "KilledAgent";
	let env: ReviveEnv | undefined;
	let frames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await openTestProcess({
			"task.maxRuntimeMs": 2_000,
			modelRoles: { default: SPAWN_MODEL, task: SPAWN_MODEL },
		});
		env = opened.env;
		env.addModel("mock-role-moved");
		frames = recordFrames(env.eventBus);
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: ROLE_ALIAS }));
		await env.kill(id);
		env.settings.setModelRole("task", ROLE_MOVED_MODEL);
		cfgTaskMaxRuntimeMs.override(env.settings, 0);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("killed agent: an IRC send revives it cold on the spec's model, LSP value and wake limit", async () => {
		if (!env) throw new Error("The test process did not start");
		const warn = vi.spyOn(logger, "warn");
		env.respond = holdWake;
		const from = frames.length;
		const first = env.nextRequest();
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		expect(receipt.outcome).toBe("revived");
		expect((await first).model).toBe(SPAWN_MODEL);
		expect(env.builds.findLast(build => build.options.agentId === id)?.options.enableLsp).toBe(false);
		expectEndedAtLimit(await heldTurn(frames, id, from), 2_000);
		expect(limitLogged(warn, id, 2_000)).toBe(true);
	}, 30_000);
});

/** One OpenAI-compatible request the worker-homed subagent sent. */
interface WireRequest {
	model: string;
	toolNames: string[];
}

function wireText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

/** A streamed chat completion holding one text answer. */
function completionStream(text: string): Response {
	const base = { id: "chatcmpl-revive", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const frames = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Polls a condition another thread feeds; waits on the condition itself, never a guessed duration. */
async function waitFor(check: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

describe("a worker-homed subagent revived cold in a worker after its worker exits", () => {
	const id = "WorkerHomed";
	const marker = `omp-test-worker-homed-${Bun.randomUUIDv7("hex")}`;
	const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const agent: AgentDefinition = {
		name: "task",
		description: "worker-homed fixture agent",
		systemPrompt: `You check fixture rows (${marker}).`,
		source: "bundled",
		tools: ["read", "bash", "lsp"],
	};
	const requests: WireRequest[] = [];
	const savedEnv: Record<string, string | undefined> = {};
	let frames: LifecycleFrame[] = [];
	let root = "";
	let server: Bun.Server<undefined> | undefined;
	let pool: SubagentWorkerPool | undefined;
	let authStorage: AuthStorage | undefined;
	let jobs: AsyncJobManager | undefined;
	let rootSession: AgentSession | undefined;
	let homeBeforeExit: ThreadId | undefined;

	/** The subagent's own turns carry `marker` in their system prompt; a wake turn's request is held until aborted. */
	async function answer(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model" }, { id: "fake-model-2" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body: unknown = await request.json();
		if (!isRecord(body)) return completionStream("ok");
		const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
		const system = messages.filter(message => message.role === "system" || message.role === "developer");
		if (!system.some(message => wireText(message.content).includes(marker))) return completionStream("ok");
		const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
		requests.push({
			model: String(body.model),
			toolNames: tools.map(tool => (isRecord(tool.function) ? String(tool.function.name) : "")),
		});
		const users = messages.filter(message => message.role === "user");
		if (users.some(message => wireText(message.content).includes(WAKE_BODY))) {
			const released = Promise.withResolvers<void>();
			request.signal.addEventListener("abort", () => released.resolve(), { once: true });
			await released.promise;
		}
		return completionStream("pong");
	}

	beforeAll(async () => {
		for (const key of envKeys) savedEnv[key] = process.env[key];
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-revive-worker-homed-"));
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp", "agent");
		const cwd = path.join(root, "work");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		// Workers read these at start-up, so they are set before the pool spawns any.
		restoreEnvValue("HOME", home);
		restoreEnvValue("PI_CODING_AGENT_DIR", agentDir);
		restoreEnvValue("OMP_PROFILE", undefined);
		restoreEnvValue("PI_PROFILE", undefined);
		__resetDirsFromEnvForTests();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
		const modelsPath = path.join(agentDir, "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${server.port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"      - id: fake-model-2",
				"        name: Fake Model 2",
				"        reasoning: false",
				"",
			].join("\n"),
		);
		authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		await modelRegistry.refresh();
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"task.completionProbe": false,
			"task.maxRuntimeMs": 2_000,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"async.enabled": true,
			modelRoles: { default: "fake/fake-model", task: "fake/fake-model" },
		});
		jobs = new AsyncJobManager({ maxRunningJobs: 4 });
		const eventBus = new EventBus();
		frames = recordFrames(eventBus);
		// Every run and every revive goes to a worker.
		pool = new SubagentWorkerPool({
			maxWorkers: () => 1,
			idleMs: 600_000,
			hostsOnMain: false,
			worker: { initTimeoutMs: 60_000 },
		});
		setSubagentWorkerPoolForTests(pool);
		const result = await runSubprocess({
			cwd,
			agent,
			task: "ping",
			index: 0,
			id,
			description: "worker-homed row",
			parentToolCallId: "call-worker-homed",
			modelOverride: ROLE_ALIAS,
			structured: false,
			settings,
			authStorage,
			modelRegistry,
			costGate: new CostGate(settings, 0, () => {}),
			asyncJobManager: jobs,
			eventBus,
			artifactsDir: path.join(root, "artifacts"),
			enableLsp: false,
			enableMCP: false,
			taskDepth: 0,
		});
		if (result.exitCode !== 0) throw new Error(`Spawn of ${id} failed: ${result.error}`);
		const mirror = AgentRegistry.global().get(id)?.session;
		if (!(mirror instanceof RemoteAgentSession)) throw new Error(`${id} is not homed in a worker`);
		const homeThread = mirror.home;
		homeBeforeExit = homeThread;
		await waitFor(() => !mirror.ircWakesPending);
		await AgentLifecycleManager.global().park(id);
		// The worker exits after the park; its exit drops the warm reviver.
		const worker = pool.forThread(homeThread);
		if (!worker) throw new Error(`No worker homes ${id}`);
		worker.terminate("worker exited after the park");
		await waitFor(() => pool?.forThread(homeThread)?.alive !== true);
		// The live state at the revive: the role moved, the wake limit off.
		settings.setModelRole("task", "fake/fake-model-2");
		cfgTaskMaxRuntimeMs.override(settings, 0);
		const fakeModel = modelRegistry.find("fake", "fake-model");
		if (!fakeModel) throw new Error("fake model missing from the main registry");
		rootSession = new AgentSession({
			agent: new Agent({ initialState: { model: fakeModel, systemPrompt: ["root"], tools: [] }, convertToLlm }),
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			modelRegistry,
			agentId: MAIN_AGENT_ID,
		});
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: rootSession,
				authStorage,
				modelRegistry,
				settings,
				// The root's LSP policy is on, while the spawn turned LSP off.
				enableLsp: true,
				eventBus,
			}),
			() => 0,
		);
	}, 120_000);

	afterAll(async () => {
		await AgentLifecycleManager.global().dispose();
		setSubagentWorkerPoolForTests(undefined);
		pool?.dispose();
		server?.stop(true);
		await jobs?.dispose({ timeoutMs: 1_000 });
		await rootSession?.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		authStorage?.close();
		AgentStorage.close();
		closeModelCache();
		for (const key of envKeys) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		if (root) await removeWithRetries(root);
	}, 30_000);

	it("worker-homed: after its worker exits, an IRC send revives it cold in a worker on the spawn's model and LSP value, and its wake turn ends at the spawn's limit", async () => {
		const from = frames.length;
		const sentAt = requests.length;
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		expect(receipt.outcome).toBe("revived");
		const revived = AgentRegistry.global().get(id)?.session;
		expect(revived).toBeInstanceOf(RemoteAgentSession);
		expect(revived instanceof RemoteAgentSession ? revived.home : undefined).not.toBe(homeBeforeExit);
		const turn = await heldTurn(frames, id, from);
		const [wake] = requests.slice(sentAt);
		// Cache warming is held on the main thread only: a worker-homed session's cache warmer crosses no seam to main
		// (its mirror has no cache-warming status) and sends nothing on the wire.
		// The spawn's model, not the role's new one.
		expect(wake?.model).toBe("fake-model");
		// The agent lists `lsp`, which the spawn's LSP setting kept out; the revive keeps it out.
		expect(wake?.toolNames).not.toContain("lsp");
		// The spawn's limit, with the spawn's agent source, description and parentToolCallId.
		expect(turn.started.agentSource).toBe("bundled");
		expect(turn.started.description).toBe("worker-homed row");
		expect(turn.started.parentToolCallId).toBe("call-worker-homed");
		expectEndedAtLimit(turn, 2_000);
	}, 30_000);
});

describe("omp --restore of a subagent its process left mid-turn", () => {
	const id = "RestoredMidTurn";
	const interrupted = "Go on with the remaining rows.";
	let env: ReviveEnv | undefined;
	let jobs: AsyncJobManager | undefined;
	let root: AgentSession | undefined;
	let frames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await openTestProcess({ "task.maxRuntimeMs": 2_000 });
		env = opened.env;
		frames = recordFrames(env.eventBus);
		const main = SessionManager.create(env.cwd, path.join(env.root, "sessions"));
		main.appendMessage({ role: "user", content: "Run the batch.", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted root session file");
		await main.close();
		const artifactsDir = mainFile.slice(0, -".jsonl".length);
		const options = {
			artifactsDir,
			sessionFile: mainFile,
			index: 2,
			description: "restore row",
			parentToolCallId: "call-restore",
		};
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, options));
		// The process died after the next prompt was written and before any answer.
		const childFile = path.join(artifactsDir, `${id}.jsonl`);
		const child = await SessionManager.open(childFile, undefined, undefined, { suppressBreadcrumb: true });
		child.appendMessage({ role: "user", content: interrupted, timestamp: Date.now() });
		await child.close();
		// `omp --restore` is a new process: a new lifecycle manager with the cold reviver, the setting 0.
		env.restart(opened.root);
		cfgTaskMaxRuntimeMs.override(env.settings, 0);
		jobs = new AsyncJobManager({ maxRunningJobs: 4 });
		const cwd = env.cwd;
		root = {
			sessionManager: { getSessionFile: () => mainFile, getCwd: () => cwd, getArtifactManager: () => undefined },
			asyncJobManager: jobs,
			settings: env.settings,
			effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
			preparedExtensions: undefined,
			restoreInterruptedTurn: async () => false,
		} as unknown as AgentSession;
	}, 60_000);

	afterAll(async () => {
		await jobs?.dispose({ timeoutMs: 1_000 });
		await env?.close();
	}, 30_000);

	it("omp --restore: the restored turn ends at the spawn's limit, its frames carrying the spawn's agent source, description, index and parentToolCallId", async () => {
		if (!env || !root) throw new Error("The test process did not start");
		const warn = vi.spyOn(logger, "warn");
		env.respond = request => (userTexts(request).some(text => text.includes(interrupted)) ? HELD : undefined);
		const from = frames.length;
		const outcome = await restoreSession(root, { eventBus: env.eventBus, subagentEventBus: env.subagentEventBus });
		expect(outcome.subagents).toEqual([id]);
		const turn = await heldTurn(frames, id, from);
		expect(turn.started.agentSource).toBe("bundled");
		expect(turn.started.description).toBe("restore row");
		expect(turn.started.index).toBe(2);
		expect(turn.started.parentToolCallId).toBe("call-restore");
		expectEndedAtLimit(turn, 2_000);
		expect(limitLogged(warn, id, 2_000)).toBe(true);
	}, 30_000);
});

describe("a chain whose every model is gone after discovery", () => {
	const id = "WholeChainGone";
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({
			modelRoles: { default: SPAWN_MODEL, task: LEAVING_MODEL },
			"retry.fallbackChains": { task: [CHAIN_MODEL] },
		});
		env = opened.env;
		env.scriptDiscovery();
		for (const model of ["mock-leaving", "mock-chain", "mock-role-moved"]) env.addModel(model);
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: ROLE_ALIAS }));
		env.removeModel(LEAVING_MODEL);
		env.removeModel(CHAIN_MODEL);
		env.settings.setModelRole("task", ROLE_MOVED_MODEL);
		warn = vi.spyOn(logger, "warn");
		const cold = await reviveCold(env, id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("with a chain whose every model is gone after discovery, the cold revive starts on the live parent's model, with the log line", () => {
		if (!warn) throw new Error("The test process did not start");
		expect(request?.model).toBe(SPAWN_MODEL);
		expect(moveLogged(warn, id, LEAVING_MODEL, SPAWN_MODEL)).toBe(true);
	}, 30_000);
});

describe("a warm revive whose model left the registry", () => {
	const id = "WarmModelGone";
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.scriptDiscovery();
		env.addModel("mock-leaving");
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: LEAVING_MODEL }));
		env.removeModel(LEAVING_MODEL);
		warn = vi.spyOn(logger, "warn");
		const warm = await env.revive(id);
		request = await wakeWithin(env, warm.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a warm revive whose model left the registry starts on the model it holds, with no log line", () => {
		if (!warn) throw new Error("The test process did not start");
		expect(request?.model).toBe(LEAVING_MODEL);
		expect(warn.mock.calls.map(args => Bun.inspect(args)).filter(text => text.includes("not found"))).toEqual([]);
	}, 30_000);
});

/** One source of a subagent's retry-fallback chain: the settings it spawns under and the model patterns it names. */
interface ChainSource {
	source: string;
	settings: Readonly<Record<string, unknown>>;
	modelOverride: string[];
}

const CHAIN_SOURCES: ChainSource[] = [
	{
		source: "the role's entry of retry.fallbackChains",
		settings: {
			modelRoles: { default: SPAWN_MODEL, task: LEAVING_MODEL },
			"retry.fallbackChains": { task: [CHAIN_MODEL] },
		},
		modelOverride: [ROLE_ALIAS],
	},
	{
		source: "the default entry of retry.fallbackChains",
		settings: { "retry.fallbackChains": { default: [CHAIN_MODEL] } },
		modelOverride: [LEAVING_MODEL],
	},
	{
		source: "a spawn that named more than one model pattern",
		settings: {},
		modelOverride: [LEAVING_MODEL, CHAIN_MODEL],
	},
];

for (const [index, { source, settings, modelOverride }] of CHAIN_SOURCES.entries()) {
	describe(`a cold revive whose model is gone walks the chain the spawn had (${index + 1})`, () => {
		const id = `ChainSource${index + 1}`;
		let env: ReviveEnv | undefined;
		let request: RecordedRequest | undefined;

		beforeAll(async () => {
			const opened = await openTestProcess(settings);
			env = opened.env;
			env.scriptDiscovery();
			env.addModel("mock-leaving");
			env.addModel("mock-chain");
			await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride }));
			env.removeModel(LEAVING_MODEL);
			const cold = await reviveCold(env, id);
			request = await wakeWithin(env, cold.session, id);
		}, 60_000);

		afterAll(async () => {
			await env?.close();
		}, 30_000);

		it(`the chain from ${source}`, () => {
			expect(request?.model).toBe(CHAIN_MODEL);
		}, 30_000);
	});
}

describe("a cold revive whose aggregator model is gone, with a provider wildcard in the chain", () => {
	const id = "AggregatorGone";
	/** The spawn's model: an aggregator's id, which carries the vendor's prefix. */
	const aggregatorModel = "fixture-aggregator/fixture-vendor/fixture-model";
	/** The same model at the vendor's direct provider, which lists it under its bare id. */
	const directModel = "fixture-direct/fixture-model";
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({ "retry.fallbackChains": { default: ["fixture-direct/*"] } });
		env = opened.env;
		env.scriptDiscovery();
		env.addModel("fixture-vendor/fixture-model", { provider: "fixture-aggregator" });
		env.addModel("fixture-model", { provider: "fixture-direct" });
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: aggregatorModel }));
		env.removeModel(aggregatorModel);
		// The registry's provider lookup finds the scripted models too, as it finds a provider's catalog models.
		const registry = env.modelRegistry;
		const find = registry.find.bind(registry);
		vi.spyOn(registry, "find").mockImplementation((provider, modelId) => {
			const listed = registry.getAll().find(model => model.provider === provider && model.id === modelId);
			return listed ?? find(provider, modelId);
		});
		warn = vi.spyOn(logger, "warn");
		const cold = await reviveCold(env, id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the cold revive starts on the model's bare id at the wildcard's provider, as a retry hop does, and omp logs the move", () => {
		if (!warn) throw new Error("The test process did not start");
		expect(request?.model).toBe(directModel);
		expect(moveLogged(warn, id, aggregatorModel, directModel)).toBe(true);
	}, 30_000);
});

describe("a session-local switch whose model is gone at the revive", () => {
	const gone = "mock/mock-switched-gone";
	let env: ReviveEnv | undefined;
	let warmRequest: RecordedRequest | undefined;
	let coldRequest: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.scriptDiscovery();
		env.addModel("mock-thinking", { thinking: true });
		for (const id of ["GoneSwitchWarm", "GoneSwitchCold"]) {
			await env.spawn(taskSpawn(env, opened.root.toolSession, id, { modelOverride: THINKING_MODEL }));
			// The registry never lists the switched model.
			recordSessionLocalSwitch(id, gone);
			await env.park(id);
		}
		const warm = await env.revive("GoneSwitchWarm");
		warmRequest = await wakeWithin(env, warm.session, "GoneSwitchWarm");
		const cold = await reviveCold(env, "GoneSwitchCold");
		coldRequest = await wakeWithin(env, cold.session, "GoneSwitchCold");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("after a session-local switch whose model is gone, the warm revive starts on the spec's model with the transcript's level", () => {
		expect(warmRequest?.model).toBe(THINKING_MODEL);
		expect(warmRequest?.reasoning).toBe(Effort.High);
	}, 30_000);

	it("after a session-local switch whose model is gone, the cold revive starts on the spec's model with the transcript's level", () => {
		expect(coldRequest?.model).toBe(THINKING_MODEL);
		expect(coldRequest?.reasoning).toBe(Effort.High);
	}, 30_000);
});

describe("a session-local switch whose model's provider reads as depleted", () => {
	let env: ReviveEnv | undefined;
	let warmRequest: RecordedRequest | undefined;
	let coldRequest: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({ "retry.usageAwareFallback": true });
		env = opened.env;
		env.addModel("mock-thinking", { thinking: true });
		env.addModel("mock-switched", { thinking: true });
		for (const id of ["DepletedSwitchWarm", "DepletedSwitchCold"]) {
			await env.spawn(taskSpawn(env, opened.root.toolSession, id, { modelOverride: THINKING_MODEL }));
			recordSessionLocalSwitch(id, SWITCHED_MODEL);
			await env.park(id);
		}
		readAsDepleted(env, "mock-switched");
		const warm = await env.revive("DepletedSwitchWarm");
		warmRequest = await wakeWithin(env, warm.session, "DepletedSwitchWarm");
		const cold = await reviveCold(env, "DepletedSwitchCold");
		coldRequest = await wakeWithin(env, cold.session, "DepletedSwitchCold");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("after a session-local switch, the warm revive starts on the switched model, with no usage-aware fallback at revive", () => {
		expect(warmRequest?.model).toBe(SWITCHED_MODEL);
	}, 30_000);

	it("after a session-local switch, the cold revive starts on the switched model, with no usage-aware fallback at revive", () => {
		expect(coldRequest?.model).toBe(SWITCHED_MODEL);
	}, 30_000);
});

describe("a tool whose tool source was removed while the subagent was parked", () => {
	const tool = "mcp__fixture__probe";
	let env: ReviveEnv | undefined;
	let spawnedTools: string[] = [];
	let warmTools: string[] = [];
	let coldTools: string[] = [];

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.mcp.setFixtureTools(["probe"]);
		for (const id of ["SourceGoneWarm", "SourceGoneCold"]) {
			await env.spawn(taskSpawn(env, opened.root.toolSession, id));
			spawnedTools = liveSession(id).getAllToolNames();
			await env.park(id);
		}
		// The MCP server is dropped from the process's MCP manager.
		env.mcp.setFixtureTools([]);
		const warm = await env.revive("SourceGoneWarm");
		warmTools = warm.session.getAllToolNames();
		const cold = await reviveCold(env, "SourceGoneCold");
		coldTools = cold.session.getAllToolNames();
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a tool whose source was removed while parked is absent after a warm and after a cold revive", () => {
		expect(spawnedTools).toContain(tool);
		expect(warmTools).not.toContain(tool);
		expect(coldTools).not.toContain(tool);
	}, 30_000);
});

describe("stored LSP, IRC and MCP values revived in a process with each off", () => {
	const id = "StoredFlagsOn";
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		const flags = { enableLsp: true, enableIrc: true, enableMCP: true };
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, flags));
		// The resumed process allows none of the three, and its MCP manager serves no tool.
		const policy = { enableLsp: false, enableIrc: false, enableMCP: false };
		env.restart(env.createLiveParent(env.createSettings(), policy), false);
		cold = await env.revive(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a stored LSP, IRC or MCP value never turns on what the live process has off", () => {
		if (!env || !cold) throw new Error("The test process did not start");
		const spawned = spawnBuildOptions(env, id);
		expect([spawned.enableLsp, spawned.enableIrc, spawned.enableMCP]).toEqual([true, true, true]);
		expect(cold.build.options.enableLsp).not.toBe(true);
		expect(cold.build.options.enableIrc).not.toBe(true);
		expect(cold.build.options.enableMCP).not.toBe(true);
	}, 30_000);
});

/**
 * Rewrites each `session_init` of `sessionFile`, as a party that can write the stored session but not the
 * operator's config can: `edit` gets the stored spawn spec's settings layers and returns the ones to store.
 */
function editStoredSettingsLayers(
	sessionFile: string,
	edit: (layers: Record<string, unknown>) => Record<string, unknown>,
): Promise<number> {
	return editStoredSpawnSpecs(sessionFile, spec => {
		const settings = isRecord(spec.settings) ? spec.settings : {};
		const layers = isRecord(settings.layers) ? settings.layers : {};
		spec.settings = { ...settings, layers: edit(layers) };
	});
}

/** `layers.overrides`, with `extra` merged into it one level deep. */
function withOverrides(
	layers: Record<string, unknown>,
	extra: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, unknown> {
	const overrides = isRecord(layers.overrides) ? { ...layers.overrides } : {};
	for (const [key, value] of Object.entries(extra)) {
		const existing = overrides[key];
		overrides[key] = isRecord(existing) ? { ...existing, ...value } : value;
	}
	return { ...layers, overrides };
}

describe("a stored settings overlay that says it is not derived", () => {
	const id = "StoredAuthority";
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({
			// The operator denies `git push` and allows only the spawn's model as a per-call model.
			"bash.patterns": [{ match: "git push *", approval: "deny" }],
			"task.perCallModelAllow": [SPAWN_MODEL],
			modelRoles: { default: SPAWN_MODEL, smol: PER_CALL_MODEL },
		});
		env = opened.env;
		env.addModel("mock-percall");
		const spawned = await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id));
		env.dropWarmReviver(id);
		await editStoredSettingsLayers(spawned.sessionFile, layers => ({
			...withOverrides(layers, {
				bash: { patterns: [{ match: "*", approval: "allow" }] },
				task: { perCallModelAllow: [PER_CALL_MODEL] },
			}),
			derived: false,
		}));
		cold = await env.revive(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("does not become grant authority: the operator's bash deny rule still holds after the cold revive", () => {
		const approval = cold?.session.getToolByName("bash")?.approval;
		if (typeof approval !== "function") throw new Error("The revived subagent has no bash approval check");
		expect(approval({ command: "git push origin main" })).toMatchObject({ policy: "deny" });
	}, 30_000);

	it("does not become grant authority: a stored task.perCallModelAllow entry grants nothing to the revived subagent", () => {
		if (!env || !cold) throw new Error("The test process did not start");
		const { modelRegistry } = env;
		const perCall = modelRegistry.getAll().find(model => formatModelStringWithRouting(model) === PER_CALL_MODEL);
		if (!perCall) throw new Error(`${PER_CALL_MODEL} is not listed`);
		const grants = { settings: cold.session.settings, agentName: "task", agentSource: "bundled" as const };
		expect(() => assertPerCallModelApproved(perCall, grants, modelRegistry)).toThrow(/is not approved for agent/);
	}, 30_000);
});

describe("a stored settings overlay holding a value its setting rejects", () => {
	const id = "StoredMalformed";
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		const spawned = await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id));
		env.dropWarmReviver(id);
		await editStoredSettingsLayers(spawned.sessionFile, layers =>
			withOverrides(layers, { compaction: { thresholdPercent: "lots" } }),
		);
		warn = vi.spyOn(logger, "warn");
		cold = await env.revive(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("revives on the settings of an older record, as a malformed part does, with one warning naming the subagent", () => {
		if (!cold || !warn) throw new Error("The test process did not start");
		expect(JSON.stringify(cold.build.settingsLayers)).not.toContain("lots");
		const rejected = warn.mock.calls.filter(
			([message, fields]) =>
				message.startsWith("Revived subagent's stored settings do not restore") && fields?.subagent === id,
		);
		expect(rejected).toHaveLength(1);
	}, 30_000);
});

/** A provider the operator turns off between the park and the revive; the registry still lists its models. */
const DISABLED_PROVIDER = "other";

describe("the spawn's model of a provider disabled between the park and the revive", () => {
	const id = "ModelProviderDisabled";
	const gone = `${DISABLED_PROVIDER}/mock-other`;
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.scriptDiscovery();
		env.addModel("mock-other", { provider: DISABLED_PROVIDER });
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: gone }));
		env.dropWarmReviver(id);
		cfgDisabledProviders.set(env.settings, [DISABLED_PROVIDER]);
		warn = vi.spyOn(logger, "warn");
		const cold = await env.revive(id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("counts as not known: the cold revive starts on the parent's model, and omp logs the move", () => {
		if (!warn) throw new Error("The test process did not start");
		expect(request?.model).toBe(SPAWN_MODEL);
		expect(moveLogged(warn, id, gone, SPAWN_MODEL)).toBe(true);
	}, 30_000);
});

describe("a chain model of a provider disabled between the park and the revive", () => {
	const id = "ChainProviderDisabled";
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({
			"retry.fallbackChains": { default: [`${DISABLED_PROVIDER}/mock-other`, CHAIN_MODEL] },
		});
		env = opened.env;
		env.scriptDiscovery();
		env.addModel("mock-leaving");
		env.addModel("mock-chain");
		env.addModel("mock-other", { provider: DISABLED_PROVIDER });
		await spawnAndPark(env, taskSpawn(env, opened.root.toolSession, id, { modelOverride: LEAVING_MODEL }));
		env.removeModel(LEAVING_MODEL);
		cfgDisabledProviders.set(env.settings, [DISABLED_PROVIDER]);
		const cold = await reviveCold(env, id);
		request = await wakeWithin(env, cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("is passed over: the cold revive starts on the next model of the chain whose provider is enabled", () => {
		expect(request?.model).toBe(CHAIN_MODEL);
	}, 30_000);
});

describe("a prewalk target of a provider disabled between the park and the revive", () => {
	const id = "PrewalkProviderDisabled";
	const target = `${DISABLED_PROVIDER}/mock-other-prewalk`;
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		env.scriptDiscovery();
		env.addModel("mock-other-prewalk", { provider: DISABLED_PROVIDER });
		const agent = fixtureAgent({ prewalk: target });
		await spawnAndPark(env, { ...taskSpawn(env, opened.root.toolSession, id), ...env.subagentInputs(id, agent) });
		env.dropWarmReviver(id);
		cfgDisabledProviders.set(env.settings, [DISABLED_PROVIDER]);
		warn = vi.spyOn(logger, "warn");
		cold = await env.revive(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("is not armed by the cold revive, as the spawn would not arm it, and omp logs that it was skipped", () => {
		if (!env || !cold || !warn) throw new Error("The test process did not start");
		const armed = spawnBuildOptions(env, id).prewalk;
		expect(armed ? formatModelStringWithRouting(armed.target) : undefined).toBe(target);
		expect(cold.build.options.prewalk).toBeUndefined();
		const skipped = warn.mock.calls.filter(([, fields]) => isRecord(fields) && fields.subagent === id);
		expect(skipped.map(([, fields]) => (isRecord(fields) ? fields.target : undefined))).toContain(target);
	}, 30_000);
});

/** A secret of project A: the test process's cwd, where the subagent is spawned and where its tools run. */
const SECRET_A = "fixture-secret-alpha-4f81c2d9";
/** A secret of project B, the directory the root session moves to while the subagent is parked. */
const SECRET_B = "fixture-secret-bravo-93e07a1b";
/** A file of project A whose read result holds {@link SECRET_A} after {@link ALPHA_ROW}. */
const ALPHA_FILE = "alpha.txt";
const ALPHA_ROW = "alpha row:";
/** A file of project A whose read result holds {@link SECRET_B} after {@link BRAVO_ROW}. */
const BRAVO_FILE = "bravo.txt";
const BRAVO_ROW = "bravo row:";

/** Writes project A's and project B's `.omp/secrets.yml`, each naming its secret, and A's two files; returns B. */
async function writeSecretProjects(env: ReviveEnv): Promise<string> {
	const projectB = path.join(env.root, "project-b");
	for (const [dir, secret] of [
		[env.cwd, SECRET_A],
		[projectB, SECRET_B],
	]) {
		await fs.mkdir(path.join(dir, ".omp"), { recursive: true });
		await Bun.write(path.join(dir, ".omp", "secrets.yml"), `- type: plain\n  content: ${secret}\n`);
	}
	await Bun.write(path.join(env.cwd, ALPHA_FILE), `${ALPHA_ROW} ${SECRET_A}\n`);
	await Bun.write(path.join(env.cwd, BRAVO_FILE), `${BRAVO_ROW} ${SECRET_B}\n`);
	return projectB;
}

/**
 * Whether the content of a request's messages carries `text`: what a provider is sent, not the `details` a tool
 * result keeps for the session's own display.
 */
function carries(request: RecordedRequest | undefined, text: string): boolean {
	return JSON.stringify(request?.messages.map(message => message.content) ?? []).includes(text);
}

/** The next wake turns read `file` in the subagent's tools' directory before they answer; none reads with no file. */
function readOnWake(env: ReviveEnv, file?: string): void {
	env.turns = file
		? { ...env.turns, wakeToolCall: { name: "read", arguments: { path: file } } }
		: { yieldArguments: env.turns.yieldArguments };
}

describe("project secrets after the root session moved to another directory", () => {
	const id = "SecretsAfterMove";
	let env: ReviveEnv | undefined;
	let projectB = "";
	let warmRequest: RecordedRequest | undefined;
	let cold: RevivedSubagent | undefined;
	let coldFirst: RecordedRequest | undefined;
	let coldNext: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess({ "secrets.enabled": true });
		env = opened.env;
		projectB = await writeSecretProjects(env);
		await env.spawn(taskSpawn(env, opened.root.toolSession, id));
		// A tool result holding SA enters the transcript before the park.
		readOnWake(env, ALPHA_FILE);
		await env.wake(liveSession(id), id);
		readOnWake(env);
		await env.park(id);
		// The root session moves to project B, as `/move` and `/wt` move it.
		await opened.root.session.sessionManager.moveTo(projectB);
		const warm = await env.revive(id);
		warmRequest = await env.wake(warm.session, id);
		await env.park(id);
		cold = await reviveCold(env, id);
		readOnWake(env, BRAVO_FILE);
		coldFirst = await env.wake(cold.session, id);
		coldNext = env.requests.at(-1);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("project secrets: after the root moved, the first request after the warm revive carries SA masked", () => {
		expect(carries(warmRequest, ALPHA_ROW)).toBe(true);
		expect(carries(warmRequest, SECRET_A)).toBe(false);
	}, 30_000);

	it("project secrets: after the root moved, the first request after the cold revive carries SA masked, and the request after a tool result holding SB carries SB masked", () => {
		// The cold revive builds in A, where its tools run, and loads B's project secrets beside A's.
		expect(cold?.build.options.cwd).toBe(env?.cwd);
		expect(cold?.build.options.secretsProjectDirs).toEqual([projectB]);
		expect(carries(coldFirst, ALPHA_ROW)).toBe(true);
		expect(carries(coldFirst, SECRET_A)).toBe(false);
		expect(coldNext).not.toBe(coldFirst);
		expect(carries(coldNext, BRAVO_ROW)).toBe(true);
		expect(carries(coldNext, SECRET_B)).toBe(false);
	}, 30_000);
});

describe("project secrets after the root session moved, secrets.enabled turned on after the cold revive", () => {
	const id = "SecretsTurnedOn";
	let env: ReviveEnv | undefined;
	let request: RecordedRequest | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		const projectB = await writeSecretProjects(env);
		await env.spawn(taskSpawn(env, opened.root.toolSession, id));
		readOnWake(env, ALPHA_FILE);
		await env.wake(liveSession(id), id);
		await env.park(id);
		await opened.root.session.sessionManager.moveTo(projectB);
		const cold = await reviveCold(env, id);
		readOnWake(env, BRAVO_FILE);
		await env.wake(cold.session, id);
		// Turning the setting on builds the session's secret mask; the build is installed through `setObfuscator`.
		const installed = Promise.withResolvers<void>();
		const setObfuscator = cold.session.setObfuscator.bind(cold.session);
		vi.spyOn(cold.session, "setObfuscator").mockImplementation(obfuscator => {
			setObfuscator(obfuscator);
			installed.resolve();
		});
		cfgSecretsEnabled.override(env.settings, true);
		await installed.promise;
		readOnWake(env);
		request = await env.wake(cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("project secrets: with secrets.enabled off at the cold revive and turned on during the session, the request after it carries SA and SB masked", () => {
		expect(carries(request, ALPHA_ROW)).toBe(true);
		expect(carries(request, BRAVO_ROW)).toBe(true);
		expect(carries(request, SECRET_A)).toBe(false);
		expect(carries(request, SECRET_B)).toBe(false);
	}, 30_000);
});

describe("a nested subagent whose parent is parked, the root session's workspace roots changed after the spawn", () => {
	const parentId = "RootsParent";
	const childId = "RootsChild";
	let env: ReviveEnv | undefined;
	let root: LiveParent | undefined;
	let cold: RevivedSubagent | undefined;
	let second = "";
	let lookup: ToolResultText | undefined;

	beforeAll(async () => {
		const opened = await openTestProcess();
		env = opened.env;
		root = opened.root;
		await env.spawn(taskSpawn(env, root.toolSession, parentId));
		const parent = env.toolSessionOf(parentId);
		// The root's kernel and the parent's both define the child's custom tool.
		env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
		env.kernels.define(parent, [LOOKUP_TOOL]);
		const customTools = createEvalCustomTools(parent, [LOOKUP_TOOL]);
		await spawnAndPark(env, taskSpawn(env, parent, childId, { description: "lookup rows", customTools }));
		await env.park(parentId);
		second = path.join(env.root, "second-root");
		await fs.mkdir(second, { recursive: true });
		// The root session gains a second workspace root, as `/add-dir` adds one.
		await root.session.sessionManager.addWorkspaceDirectory(second);
		cold = await reviveCold(env, childId);
		env.turns = { ...env.turns, wakeToolCall: { name: LOOKUP_TOOL.name, arguments: { key: "a" } } };
		await env.wake(cold.session, childId);
		lookup = lastToolResult(cold.session, LOOKUP_TOOL.name);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a parked parent: the cold revive takes the root session's live workspace roots and its session id as the credential source", () => {
		if (!root || !cold) throw new Error("The test process did not start");
		const roots = root.toolSession.additionalDirectories;
		expect(roots).toHaveLength(2);
		expect(roots).toContain(second);
		// One comparison, so a failure names each of the two values the revive got.
		const { additionalDirectories, credentialSourceSessionId } = cold.build.options;
		expect({ additionalDirectories, credentialSourceSessionId }).toEqual({
			additionalDirectories: roots,
			credentialSourceSessionId: root.session.sessionManager.getSessionId(),
		});
	}, 30_000);

	it("a parked parent: the child's custom tool stays unavailable, though the root's kernel defines a tool of its name", () => {
		expect(lookup?.isError).toBe(true);
		expect(lookup?.text).toMatch(/unavailable/i);
		expect(env?.kernels.calls).toEqual([]);
	}, 30_000);
});
