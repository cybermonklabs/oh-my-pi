/**
 * `omp --restore` and what is not the user's stop: a process exit or a shutdown
 * that cuts a turn off while it waits out a retry backoff for a key that could not
 * be resolved leaves it restorable, its parent's process exit leaves a waiting
 * subagent restorable too, and the subagents of a conversation the parent cleared
 * stay behind down the whole subagent tree, not only one level.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type Model, streamSimple, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	hasRestorableTurn,
	INTERRUPTED_TURN_ERROR,
	SESSION_EXIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { activeBranch } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { restoreEnvValue } from "./helpers/settings-test-state";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const MOCK_API_SOURCE = "restore-after-cut-off-test";
const PROVIDER_SESSION_ID = "restore-after-user-stop-session";
const FINAL_ANSWER = "finished after the key came back";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const probeSchema = type({ value: "string" });

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-after-cut-off-");
	const home = root.join("home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	const failures: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		await AgentLifecycleManager.global().dispose();
	} catch (error) {
		failures.push(error);
	}
	setSystemTime();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
	if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
});

function oauthLogin(account: string) {
	return {
		type: "oauth" as const,
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires: Date.now() + 3_600_000,
		accountId: account,
		email: `${account}@example.com`,
	};
}

function anthropicModel(): Model<Api> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
	return model;
}

interface KeyContext {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/** The test's credential store, holding one anthropic OAuth login, and its model registry. */
async function setUp(): Promise<KeyContext> {
	const authStorage = await AuthStorage.create(root.join("testauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	return { authStorage, modelRegistry };
}

/**
 * A session on the production key path (`ModelRegistry.turnResolver`, as sdk.ts wires it)
 * whose model calls `probe` once and then answers; `onProbe` runs while the tool runs.
 */
async function openSession(
	ctx: KeyContext,
	options: { baseDelayMs: number; sessionManager: SessionManager; onProbe?: () => Promise<void> },
) {
	const model = anthropicModel();
	let probeRuns = 0;
	const probe: AgentTool<typeof probeSchema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			probeRuns++;
			if (probeRuns === 1) await options.onProbe?.();
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	const mock = createMockModel({
		id: model.id,
		provider: model.provider,
		handler: context =>
			context.messages.some(message => message.role === "toolResult")
				? { content: [FINAL_ANSWER], stopReason: "stop" }
				: {
						content: [{ type: "toolCall", id: "call_probe", name: "probe", arguments: { value: "x" } }],
						stopReason: "toolUse",
					},
	});
	const agent = new Agent({
		getApiKey: async requestModel => ctx.modelRegistry.turnResolver(requestModel, PROVIDER_SESSION_ID),
		sessionId: PROVIDER_SESSION_ID,
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [probe as AgentTool],
			messages: options.sessionManager.buildSessionContext().messages,
		},
		streamFn: (_requestModel, context, streamOptions) => streamSimple(mock.model, context, streamOptions),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": options.baseDelayMs,
		"retry.maxRetries": 3,
		"retry.modelFallback": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const session = new AgentSession({
		agent,
		sessionManager: options.sessionManager,
		settings,
		modelRegistry: ctx.modelRegistry,
		providerSessionId: PROVIDER_SESSION_ID,
	});
	cleanups.push(() => session.dispose());
	const retryStarts: AutoRetryStartEvent[] = [];
	const retryEnds: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retryStarts.push(event);
		if (event.type === "auto_retry_end") retryEnds.push(event);
	});
	return { session, mock, retryStarts, retryEnds };
}

/** Holds the backoff wait (a wait of a second or more) until it is aborted; shorter waits pass at once. */
function holdBackoff() {
	const started = Promise.withResolvers<void>();
	const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		if (delayMs < 1_000) return;
		started.resolve();
		const held = Promise.withResolvers<void>();
		options?.signal?.addEventListener("abort", () => held.reject(options.signal?.reason), { once: true });
		await held.promise;
	});
	return { started: started.promise, wait };
}

describe("omp --restore after a process exit cut off a turn waiting to retry its key", () => {
	const cuts: Record<string, (session: AgentSession) => Promise<void>> = {
		"the session's dispose (a process exit)": session => session.dispose(),
		"an abort with the shutdown reason, then dispose": async session => {
			await session.abort({ reason: INTERRUPTED_TURN_ERROR });
			await session.dispose();
		},
	};
	for (const [cut, cutTurn] of Object.entries(cuts)) {
		it(`goes on with the turn: ${cut}`, async () => {
			// If this regresses, a worker killed while it waits for its key reads as one the user stopped, and
			// `omp --restore` leaves it with nothing to go on with it.
			const ctx = await setUp();
			const worker = await openSession(ctx, {
				baseDelayMs: 5_000,
				sessionManager: SessionManager.create(root.path(), root.join("sessions")),
				// A failed refresh disables the login while the tool runs, so the next request has no key.
				onProbe: async () => {
					for (const account of ctx.authStorage.oauth.accounts("anthropic")) {
						await ctx.authStorage.credentials.disable(account.credentialId, LOGIN_DISABLED_CAUSE);
					}
				},
			});
			const backoff = holdBackoff();
			const prompting = worker.session.prompt("run the probe").catch(() => undefined);
			await backoff.started;
			const sessionFile = worker.session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await cutTurn(worker.session);
			await prompting;
			backoff.wait.mockRestore();

			// The key is readable again; a new process opens the session with `--restore`.
			await ctx.authStorage.credentials.set("anthropic", [oauthLogin("acc-relogin")]);
			mockSchedulerWaitWithClock();
			const reopened = await SessionManager.open(sessionFile);
			const tail = reopened
				.getBranch()
				.filter(entry => entry.type === "message")
				.at(-1);
			expect(
				tail?.type === "message" && tail.message.role === "assistant"
					? { stopReason: tail.message.stopReason, credentialUnavailable: tail.message.credentialUnavailable }
					: undefined,
			).toEqual({ stopReason: "error", credentialUnavailable: true });
			expect(hasRestorableTurn(reopened.getBranch())).toBe(true);
			const restarted = await openSession(ctx, { baseDelayMs: 40, sessionManager: reopened });
			await expect(restarted.session.restoreInterruptedTurn()).resolves.toBe(true);
			await restarted.session.waitForIdle();
			const last = restarted.session.agent.state.messages.at(-1);
			expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
			// It went on from the tool result: one request, and the tool did not run again.
			expect(restarted.mock.calls).toHaveLength(1);
		});
	}
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

function subagentResult(id: string, exitCode: number, error?: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "user",
		task: `${id} task`,
		exitCode,
		output: exitCode === 0 ? "finished after the restart" : "",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...(error === undefined ? {} : { error }),
	};
}

/** The parent's sync `task` call to subagent `id`, the failed result it got back at once, and its answer. */
function appendParentTaskTurn(main: SessionManager, id: string): void {
	const callId = `call_${id}`;
	const error = "Retry budget exhausted after 2 retries: No API key for provider: anthropic";
	main.appendMessage({ role: "user", content: `Delegate the ${id} work.`, timestamp: Date.now() });
	main.appendMessage(
		assistant({
			content: [{ type: "toolCall", id: callId, name: "task", arguments: { agent: "worker", task: `${id} task` } }],
			stopReason: "toolUse",
		}),
	);
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [subagentResult(id, 1, error)],
		totalDurationMs: 5,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "task",
		content: [
			{
				type: "text",
				text: `<task-result id="${id}" agent="worker" status="failed (exit 1)"><output>${error}</output></task-result>`,
			},
		],
		details,
		isError: false,
		timestamp: Date.now(),
	};
	main.appendMessage(result);
	main.appendMessage(assistant({ content: [{ type: "text", text: `${id} could not run.` }] }));
}

/** The parent's sync `task` call to subagent `id`, without its result: the parent's process ended while it waited. */
function appendParentTaskCall(main: SessionManager, id: string): void {
	main.appendMessage({ role: "user", content: `Delegate the ${id} work.`, timestamp: Date.now() });
	main.appendMessage(
		assistant({
			content: [
				{ type: "toolCall", id: `call_${id}`, name: "task", arguments: { agent: "worker", task: `${id} task` } },
			],
			stopReason: "toolUse",
		}),
	);
}

/** Subagent `id`'s transcript under `mainFile`: its turn ended because its key could not be resolved, then a normal exit. */
async function writeStrandedSubagent(mainFile: string, cwd: string, id: string): Promise<void> {
	const sub = await SessionManager.open(path.join(mainFile.slice(0, -6), `${id}.jsonl`), undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"] });
	sub.appendMessage({ role: "user", content: `${id} task`, timestamp: Date.now() });
	sub.appendMessage(
		assistant({
			stopReason: "error",
			errorMessage: "Retry budget exhausted after 2 retries: No API key for provider: anthropic",
			credentialUnavailable: true,
		}),
	);
	sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
	await sub.close();
}

/** A transcript under `dir` for subagent `id` whose turn finished: nothing to go on with of its own. */
async function writeFinishedSubagent(
	parentFile: string,
	cwd: string,
	id: string,
	spawnsChild?: string,
	appendSpawn = appendParentTaskTurn,
): Promise<void> {
	const sub = await SessionManager.open(path.join(parentFile.slice(0, -6), `${id}.jsonl`), undefined, undefined, {
		initialCwd: cwd,
		parentSession: parentFile,
		suppressBreadcrumb: true,
	});
	sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "task", "yield"] });
	if (spawnsChild) appendSpawn(sub, spawnsChild);
	else sub.appendMessage({ role: "user", content: `${id} task`, timestamp: Date.now() });
	sub.appendMessage(assistant({ content: [{ type: "text", text: `${id} done` }] }));
	sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
	await sub.close();
}

describe("omp --restore after the user cleared the parent of nested subagents", () => {
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		for (const id of ["Outer", "Inner", "NewOuter", "NewInner"]) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
	});

	it("does not relaunch the subagent of a subagent the cleared conversation spawned, and relaunches one of the new conversation", async () => {
		// If this regresses, `--restore` relaunches a nested subagent of work the user cleared, whose own parent is
		// not relaunched, so its result goes to a job nobody waits on.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const cwd = root.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		// Before the /clear: the parent spawned Outer, and Outer spawned Inner, which was stranded.
		appendParentTaskTurn(main, "Outer");
		await writeFinishedSubagent(mainFile, cwd, "Outer", "Inner");
		await writeStrandedSubagent(path.join(mainFile.slice(0, -6), "Outer.jsonl"), cwd, "Inner");
		setSystemTime(new Date(start + 60_000));
		main.appendResetBoundary();
		setSystemTime(new Date(start + 120_000));
		// After it: NewOuter spawned NewInner, which was stranded too.
		appendParentTaskTurn(main, "NewOuter");
		await writeFinishedSubagent(mainFile, cwd, "NewOuter", "NewInner", appendParentTaskCall);
		await writeStrandedSubagent(path.join(mainFile.slice(0, -6), "NewOuter.jsonl"), cwd, "NewInner");
		main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		await main.close();
		setSystemTime();

		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options =>
			subagentResult(options.id, 0),
		);
		const session = {
			sessionManager: await SessionManager.open(mainFile),
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => false),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome.subagents).toEqual(["NewInner"]);
		for (const id of outcome.subagents) await manager.getJob(id)?.promise;
	});
});

const NOTES_FILE = "notes.txt";
const WORKER: AgentDefinition = {
	name: "keyed-worker",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};

/**
 * A parent session on the production SDK path whose model spawns `WORKER` as a sync task
 * subagent. The worker's model is on anthropic, keyed by the store's only OAuth login; once
 * its first request has gone out, a failed refresh disables that login, so the worker's next
 * request has no key and its turn waits out a retry backoff.
 */
async function openParentWithKeyedWorker() {
	const cwd = root.join("home", "work");
	await Bun.write(path.join(cwd, NOTES_FILE), "the notes\n");
	const authStorage = await AuthStorage.create(root.join("parentauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	const parentModel = createMockModel({
		id: "parent-model",
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "task")) return { content: ["label"] };
			if (!context.messages.some(message => message.role === "toolResult")) {
				return {
					content: [
						{
							type: "toolCall",
							id: "call_task",
							name: "task",
							arguments: { agent: WORKER.name, name: "KeyedWorker", task: `Read ${NOTES_FILE} and report it.` },
						},
					],
					stopReason: "toolUse",
				};
			}
			return { content: ["The worker could not read the notes."], stopReason: "stop" };
		},
	});
	const workerModel = createMockModel({
		provider: "anthropic",
		id: "mock-claude",
		handler: async context => {
			if (!(context.tools ?? []).some(tool => tool.name === "read")) return { content: ["label"] };
			if (!context.messages.some(message => message.role === "toolResult")) {
				for (const account of authStorage.oauth.accounts("anthropic")) {
					await authStorage.credentials.disable(account.credentialId, LOGIN_DISABLED_CAUSE);
				}
				return {
					content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: NOTES_FILE } }],
					stopReason: "toolUse",
				};
			}
			return { content: ["the notes"] };
		},
	});
	// Only the scripted models are available, so no label or title request leaves the process.
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [parentModel, workerModel]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [WORKER], projectAgentsDir: null });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("parent-sessions")),
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.enableLsp": false,
			"task.completionProbe": false,
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 5_000,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"autolearn.enabled": false,
		}),
		toolNames: ["task"],
		spawns: "*",
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	cleanups.push(() => session.dispose());
	return { parent: session, workerModel };
}

describe("omp --restore after the parent's process exit cut off a subagent waiting to retry its key", () => {
	it("leaves the subagent's turn on its marked error, not on a stop record, so --restore can relaunch it", async () => {
		// If this regresses, the parent's exit (a SIGTERM, a pod eviction) reads to its subagent as the user's stop:
		// the subagent's turn ends on an aborted record, and `omp --restore` of the parent relaunches nothing.
		const { parent, workerModel } = await openParentWithKeyedWorker();
		const backoff = holdBackoff();
		const prompting = parent.prompt("Delegate reading the notes.").catch(() => undefined);
		// The worker's first request went out; its next one has no key and waits out the backoff.
		await backoff.started;
		expect(
			workerModel.calls.filter(call => (call.context.tools ?? []).some(tool => tool.name === "read")),
		).toHaveLength(1);
		const parentFile = parent.sessionManager.getSessionFile();
		if (!parentFile) throw new Error("Expected a persisted parent session file");
		// The parent's process exits while the worker waits.
		await parent.dispose();
		await prompting;
		backoff.wait.mockRestore();

		const subSessions = Object.values(await collectSubSessions(parentFile));
		expect(subSessions).toHaveLength(1);
		const worker = subSessions[0]!;
		const branch = activeBranch(worker.entries, worker.leafId);
		const tail = branch.filter(entry => entry.type === "message").at(-1);
		expect(
			tail?.type === "message" && tail.message.role === "assistant"
				? { stopReason: tail.message.stopReason, credentialUnavailable: tail.message.credentialUnavailable }
				: undefined,
		).toEqual({ stopReason: "error", credentialUnavailable: true });
		expect(hasRestorableTurn(branch)).toBe(true);
	}, 30_000);
});
