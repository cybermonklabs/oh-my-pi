/**
 * `omp --restore` and the subagents a subagent's own jobs run (an eval `agent()` handle),
 * when such a subagent waits to retry a key that could not be resolved: a kill of the
 * subagent that owns the job, or its parent's stop, stops it, and `--restore` leaves it;
 * `--restore` leaves every subagent under a subagent that was killed or whose last turn a
 * stop ended, even one that a cancel giving no reason cut off; and the parent's process
 * exit still leaves the whole chain for `--restore`. A subagent's dispose stops the jobs
 * it owns, unless the dispose is for the process exit, which shuts them down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { handleRpcCancelSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createTurnAbortRecord,
	hasRestorableTurn,
	INTERRUPTED_TURN_ERROR,
	SESSION_EXIT_CUSTOM_TYPE,
	turnAbortKind,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { GENERIC_ABORT_SENTINEL, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { activeBranch } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectSubSessions, type SubSession } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type RestoreOutcome, restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, postmortem, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MOCK_API_SOURCE = "restore-under-stopped-subagent-test";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const NOTES_FILE = "notes.txt";
/** The reason on the record a stop of a turn waiting to retry ends it with, as its transcript stores it. */
const RETRY_CANCELLED_RECORD = "Retry cancelled";
const KEY_ERROR = "Retry budget exhausted after 2 retries: No API key for provider: anthropic";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-under-stopped-subagent-");
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

/** The subagent a planner's job runs: it reads a file with a model keyed by an OAuth login. */
const READER: AgentDefinition = {
	name: "keyed-reader",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};

/** The parent's subagent: it starts a reader as an eval `agent()` handle, a job it owns. */
const PLANNER: AgentDefinition = {
	name: "planner",
	description: "Has a reader read the file it is given",
	systemPrompt: "Start a reader for the file with agent() and report what it says.",
	tools: ["eval"],
	spawns: [READER.name],
	model: ["mock/planner-model"],
	source: "bundled",
};

/** The planner's `eval` call: a JavaScript cell that starts a reader in the background and returns. */
const READER_CELL = {
	type: "toolCall" as const,
	id: "call_eval",
	name: "eval",
	arguments: {
		language: "js",
		code: [
			`const reader = await agent(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)}, { agent: ${JSON.stringify(READER.name)} });`,
			"print(reader.id);",
		].join("\n"),
		timeout: 0,
	},
};

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

/** Holds each backoff wait (a wait of a second or more) until it is aborted; shorter waits pass at once. */
function holdBackoff(expected: number) {
	const holds = Array.from({ length: expected }, () => Promise.withResolvers<void>());
	let held = 0;
	const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		if (delayMs < 1_000) return;
		if (held < holds.length) holds[held]!.resolve();
		held++;
		const release = Promise.withResolvers<void>();
		options?.signal?.addEventListener("abort", () => release.reject(options.signal?.reason), { once: true });
		await release.promise;
	});
	return { allHeld: Promise.all(holds.map(hold => hold.promise)), wait };
}

/**
 * A parent session on the production SDK path whose model spawns `PLANNER` as a sync task
 * subagent. The planner's model runs `READER_CELL`, which starts a `READER` as a background
 * job the planner owns, then holds its next request until something ends the planner's run.
 * The reader's model is on anthropic, keyed by the store's only OAuth login; its first
 * request disables that login, as a failed refresh does, so its next request has no key and
 * its turn waits out a retry backoff. `roster` is the RPC host's view of the subagents, and
 * every subagent run's result is collected in `runs`.
 */
async function openParentWithPlanner() {
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
			if (context.messages.some(message => message.role === "toolResult")) {
				return { content: ["The planner did not finish."] };
			}
			return {
				content: [
					{
						type: "toolCall",
						id: "call_task",
						name: "task",
						arguments: { agent: PLANNER.name, name: "Planner", task: `Have ${NOTES_FILE} read.` },
					},
				],
				stopReason: "toolUse",
			};
		},
	});
	const plannerHolds = Promise.withResolvers<void>();
	const plannerModel = createMockModel({
		id: "planner-model",
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "eval")) return { content: ["label"] };
			if (!context.messages.some(message => message.role === "toolResult")) {
				return { content: [READER_CELL], stopReason: "toolUse" };
			}
			// The reader runs in the background; this request lasts until the planner's run ends.
			plannerHolds.resolve();
			return { content: ["The reader is reading."], delayMs: 600_000 };
		},
	});
	const readerModel = createMockModel({
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
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [parentModel, plannerModel, readerModel]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [PLANNER, READER], projectAgentsDir: null });
	const runSubprocess = executorModule.runSubprocess;
	const runs: Promise<SingleResult>[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
		const run = runSubprocess(options);
		runs.push(run);
		return run;
	});
	const subagentEventBus = new EventBus();
	const roster = new RpcSubagentRegistry(subagentEventBus, () => {});
	cleanups.push(() => roster.dispose());
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("parent-sessions")),
		subagentEventBus,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.enableLsp": false,
			"task.completionProbe": false,
			"task.workerThreads": 0,
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 5_000,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"autolearn.enabled": false,
			"eval.py": false,
			"eval.autoBackground.enabled": false,
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
	cleanups.push(() => disposeAllVmContexts());
	return { parent: session, roster, runs, plannerHolds: plannerHolds.promise };
}

/**
 * Has the parent's model spawn the planner, and waits until the planner's next request is
 * held while the reader its job runs waits out its key backoff. Returns the parent's turn,
 * the planner's agent id, and the reader's job.
 */
async function startPlannerWithWaitingReader(
	parent: AgentSession,
	roster: RpcSubagentRegistry,
	plannerHolds: Promise<void>,
) {
	const backoff = holdBackoff(1);
	const turn = parent.prompt("Have the notes read.");
	await Promise.all([plannerHolds, backoff.allHeld]);
	const plannerId = roster.getSubagents().find(snapshot => snapshot.agent === PLANNER.name)?.id;
	if (!plannerId) throw new Error("Expected the RPC host to list the running planner");
	const readerJobs = parent.asyncJobManager?.getRunningJobs({ ownerId: plannerId }) ?? [];
	expect(readerJobs).toHaveLength(1);
	return { turn, backoff, plannerId, readerJob: readerJobs[0]! };
}

/**
 * Ends the parent's process once its subagent runs settled (every live session closes),
 * then has a new process restore the parent's session from its file: what `--restore`
 * relaunched, and the planner and reader transcripts it judged.
 */
async function restoreInNewProcess(
	parent: AgentSession,
	runs: readonly Promise<SingleResult>[],
): Promise<{ outcome: RestoreOutcome; planner: SubSession; reader: SubSession }> {
	await Promise.all(runs);
	const parentFile = parent.sessionManager.getSessionFile();
	if (!parentFile) throw new Error("Expected a persisted parent session file");
	await parent.dispose();
	await AgentLifecycleManager.global().dispose();

	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	// The new process reads the parent's transcript as the last one left it in its file.
	const reopened = await SessionManager.open(parentFile, undefined, undefined, { suppressBreadcrumb: true });
	const parentEntries = reopened.getEntries();
	const leafId = reopened.getLeafId();
	await reopened.close();
	const manager = new AsyncJobManager({});
	cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
	manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
	vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => subagentResult(options.id));
	const outcome = await restoreSession({
		sessionManager: { getSessionFile: () => parentFile, getEntries: () => parentEntries, getLeafId: () => leafId },
		asyncJobManager: manager,
		settings: Settings.isolated(),
		restoreInterruptedTurn: vi.fn(async () => false),
	} as unknown as AgentSession);
	for (const id of outcome.subagents) await manager.getJob(id)?.promise;
	const subagents = Object.values(await collectSubSessions(parentFile));
	expect(subagents).toHaveLength(2);
	const planner = subagents.find(sub => sub.parent === null);
	const reader = subagents.find(sub => sub.parent !== null);
	if (!planner || !reader) throw new Error("Expected the planner's transcript and the reader's under it");
	return { outcome, planner, reader };
}

function subagentResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: READER.name,
		agentSource: "bundled",
		task: `Read ${NOTES_FILE} and report it.`,
		exitCode: 0,
		output: "the notes",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** How a subagent's turn ended on its selected branch, and whether `--restore` would go on with it. */
interface TurnEnd {
	stopReason: AssistantMessage["stopReason"] | undefined;
	/** The reason an aborted record gives. */
	abortReason: string | undefined;
	credentialUnavailable: true | undefined;
	restorable: boolean;
}

function turnEnd(sub: SubSession): TurnEnd {
	const branch = activeBranch(sub.entries, sub.leafId);
	const tail = branch.filter(entry => entry.type === "message").at(-1);
	const message = tail?.type === "message" && tail.message.role === "assistant" ? tail.message : undefined;
	return {
		stopReason: message?.stopReason,
		abortReason: message?.stopReason === "aborted" ? message.errorMessage : undefined,
		credentialUnavailable: message?.credentialUnavailable,
		restorable: hasRestorableTurn(branch),
	};
}

/** A turn a stop ended while it waited to retry: `--restore` leaves it. */
const STOPPED: TurnEnd = {
	stopReason: "aborted",
	abortReason: RETRY_CANCELLED_RECORD,
	credentialUnavailable: undefined,
	restorable: false,
};

/** A turn cut off while it waited to retry: it keeps its marked attempt, and `--restore` can go on with it. */
const CUT_OFF: TurnEnd = {
	stopReason: "error",
	abortReason: undefined,
	credentialUnavailable: true,
	restorable: true,
};

describe("omp --restore after the RPC host killed a subagent whose eval agent() job's subagent waited to retry its key", () => {
	it("stops the job's subagent, so --restore relaunches nothing", async () => {
		// If this regresses, the killed subagent's dispose (or its run's end) cancels its own jobs as a cut-off:
		// the job's subagent keeps its marked attempt, gets no tombstone, and `omp --restore` relaunches it
		// under a subagent the user killed.
		const { parent, roster, runs, plannerHolds } = await openParentWithPlanner();
		const { turn, backoff, plannerId } = await startPlannerWithWaitingReader(parent, roster, plannerHolds);
		await expect(handleRpcCancelSubagent(roster, plannerId)).resolves.toBe(true);
		await turn;

		const { outcome, planner, reader } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(planner.aborted).toBe(true);
		expect(turnEnd(reader)).toEqual(STOPPED);
		expect(outcome.subagents).toEqual([]);
	}, 30_000);
});

describe("omp --restore after the user's stop of the parent ended a subagent whose eval agent() job's subagent waited to retry its key", () => {
	it("stops the job's subagent, so --restore relaunches nothing", async () => {
		// If this regresses, the task executor reaps the stopped subagent's jobs with no reason, which reads to
		// the job's subagent as a process exit: it keeps its marked attempt, and `omp --restore` relaunches work
		// the user stopped.
		const { parent, roster, runs, plannerHolds } = await openParentWithPlanner();
		const { turn, backoff } = await startPlannerWithWaitingReader(parent, roster, plannerHolds);
		// The RPC host's `abort`, as the user's Esc.
		await parent.abort({ reason: USER_INTERRUPT_LABEL });
		await turn;

		const { outcome, planner, reader } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(planner.aborted).toBe(false);
		expect(turnEnd(reader)).toEqual(STOPPED);
		expect(outcome.subagents).toEqual([]);
	}, 30_000);
});

describe("omp --restore under a subagent that was killed after a cancel without a reason cut its job's subagent off", () => {
	it("relaunches nothing, although the job's subagent kept its marked attempt", async () => {
		// If this regresses, a site that cancels a job without saying how (as every job cancel did before this
		// check) leaves the job's subagent restorable, and `omp --restore` relaunches it under a killed subagent.
		const { parent, roster, runs, plannerHolds } = await openParentWithPlanner();
		const { turn, backoff, plannerId, readerJob } = await startPlannerWithWaitingReader(parent, roster, plannerHolds);
		// A cancel that gives no reason reads to the reader as a process exit: it is cut off.
		parent.asyncJobManager?.cancel(readerJob.id, { ownerId: plannerId });
		await readerJob.promise;
		await expect(handleRpcCancelSubagent(roster, plannerId)).resolves.toBe(true);
		await turn;

		const { outcome, planner, reader } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(turnEnd(reader)).toEqual(CUT_OFF);
		expect(planner.aborted).toBe(true);
		expect(outcome.subagents).toEqual([]);
	}, 30_000);
});

describe("omp --restore after the parent's process exit cut off a subagent whose eval agent() job's subagent waited to retry its key", () => {
	it("relaunches the job's subagent", async () => {
		// If this regresses, the process exit reads to the job's subagent as a stop, or its parent's aborted record
		// as one a stop wrote: `omp --restore` leaves the work the exit cut off unfinished.
		const { parent, roster, runs, plannerHolds } = await openParentWithPlanner();
		const { turn, backoff } = await startPlannerWithWaitingReader(parent, roster, plannerHolds);
		await parent.dispose({ reason: postmortem.Reason.EXIT });
		await turn;

		const { outcome, planner, reader } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(planner.aborted).toBe(false);
		expect(turnEnd(reader)).toEqual(CUT_OFF);
		expect(outcome.subagents).toEqual([reader.agentId]);
	}, 30_000);
});

describe("a subagent session's dispose ends the jobs it owns as the dispose says", () => {
	/**
	 * A subagent session (no job manager of its own, the shared `manager`) owning a running job,
	 * and the reason the job's signal aborts with.
	 */
	async function subagentOwningJob(manager: AsyncJobManager) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(root.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, root.join("models.yml")),
			asyncJobManager: manager,
			agentId: "Planner",
		});
		const started = Promise.withResolvers<void>();
		const abortReason = Promise.withResolvers<unknown>();
		manager.register(
			"task",
			"Reader",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				started.resolve();
				await aborted.promise;
				abortReason.resolve(signal.reason);
				return "stopped";
			},
			{ ownerId: "Planner", agentId: "Reader" },
		);
		await started.promise;
		return { session, abortReason: abortReason.promise };
	}

	it("stops them when the subagent is killed or released", async () => {
		// If this regresses, a killed subagent's jobs read to their subagents as a process exit: they keep their
		// turns for `omp --restore`, which relaunches them under a subagent the user killed.
		const manager = new AsyncJobManager({});
		cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
		const { session, abortReason } = await subagentOwningJob(manager);
		await session.dispose();
		expect(turnAbortKind(await abortReason)).toBe("stop");
	});

	it("shuts them down when the dispose is for the process exit", async () => {
		// If this regresses, the subagents of a subagent the process exit released stay adopted past the
		// lifecycle's teardown instead of being parked for `omp --restore`.
		const manager = new AsyncJobManager({});
		cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
		const { session, abortReason } = await subagentOwningJob(manager);
		await session.dispose({ reason: postmortem.Reason.EXIT });
		expect(await abortReason).toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
	});
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
		api: "mock",
		provider: "mock",
		model: "planner-model",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

/** The parent's sync `task` call to the planner, without its result: the parent's process ended while it waited. */
function appendPlannerCall(main: SessionManager): void {
	main.appendMessage({ role: "user", content: "Have the notes read.", timestamp: Date.now() });
	main.appendMessage(
		assistant({
			content: [
				{
					type: "toolCall",
					id: "call_task",
					name: "task",
					arguments: { agent: PLANNER.name, name: "Planner", task: `Have ${NOTES_FILE} read.` },
				},
			],
			stopReason: "toolUse",
		}),
	);
}

/** The planner's transcript under `mainFile`: it started the reader from an eval cell, then its turn ended on `end`. */
async function writePlanner(mainFile: string, cwd: string, end: readonly AssistantMessage[]): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), "Planner.jsonl");
	const planner = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	planner.appendSessionInit({ systemPrompt: ["planner prompt"], task: "Planner task", tools: ["eval", "yield"] });
	planner.appendMessage({ role: "user", content: "Planner task", timestamp: Date.now() });
	planner.appendMessage(assistant({ content: [READER_CELL], stopReason: "toolUse" }));
	const cellResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: READER_CELL.id,
		toolName: "eval",
		content: [{ type: "text", text: "Reader" }],
		isError: false,
		timestamp: Date.now(),
	};
	planner.appendMessage(cellResult);
	for (const message of end) planner.appendMessage(message);
	await planner.close();
	return file;
}

/** The reader's transcript under `plannerFile`: its turn ended because its key could not be resolved, then a normal exit. */
async function writeStrandedReader(plannerFile: string, cwd: string): Promise<void> {
	const reader = await SessionManager.open(path.join(plannerFile.slice(0, -6), "Reader.jsonl"), undefined, undefined, {
		initialCwd: cwd,
		parentSession: plannerFile,
		suppressBreadcrumb: true,
	});
	reader.appendSessionInit({ systemPrompt: ["reader prompt"], task: "Reader task", tools: ["read", "yield"] });
	reader.appendMessage({ role: "user", content: "Reader task", timestamp: Date.now() });
	reader.appendMessage(
		assistant({
			provider: "anthropic",
			api: "anthropic-messages",
			model: "mock-claude",
			stopReason: "error",
			errorMessage: KEY_ERROR,
			credentialUnavailable: true,
		}),
	);
	reader.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
	await reader.close();
}

describe("omp --restore reads how the last turn of a subagent above a stranded subagent ended", () => {
	const failedAttempt = assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true });
	const ends: Array<{ name: string; end: () => AssistantMessage[]; relaunched: string[] }> = [
		{
			name: "the user's interrupt leaves the subagent under it",
			end: () => [
				assistant({
					stopReason: "aborted",
					errorMessage: USER_INTERRUPT_LABEL,
					errorId: AIError.create(AIError.Flag.UserInterrupt),
				}),
			],
			relaunched: [],
		},
		{
			name: "a stop of its retry leaves the subagent under it",
			end: () => [failedAttempt, createTurnAbortRecord(failedAttempt, RETRY_CANCELLED_RECORD, Date.now())],
			relaunched: [],
		},
		{
			name: "the record a process exit leaves relaunches the subagent under it",
			end: () => [createTurnAbortRecord(assistant({}), INTERRUPTED_TURN_ERROR, Date.now())],
			relaunched: ["Planner", "Reader"],
		},
		{
			name: "an abort without a reason, which a process going away also leaves, relaunches the subagent under it",
			end: () => [
				assistant({
					stopReason: "aborted",
					errorMessage: GENERIC_ABORT_SENTINEL,
					errorId: AIError.create(AIError.Flag.Abort),
				}),
			],
			relaunched: ["Reader"],
		},
	];
	for (const row of ends) {
		it(row.name, async () => {
			// If this regresses, `omp --restore` relaunches the subagent of a job its stopped parent subagent owned
			// (whose result nobody waits on), or leaves one a process exit cut off with its whole chain.
			const cwd = root.path();
			const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
			const mainFile = main.getSessionFile();
			if (!mainFile) throw new Error("Expected a persisted session file");
			appendPlannerCall(main);
			await main.close();
			const plannerFile = await writePlanner(mainFile, cwd, row.end());
			await writeStrandedReader(plannerFile, cwd);

			const manager = new AsyncJobManager({});
			cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
			manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
			vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options =>
				subagentResult(options.id),
			);
			const sessionManager = await SessionManager.open(mainFile);
			cleanups.push(() => sessionManager.close());
			const outcome = await restoreSession({
				sessionManager,
				asyncJobManager: manager,
				settings: Settings.isolated(),
				restoreInterruptedTurn: vi.fn(async () => false),
			} as unknown as AgentSession);
			for (const id of outcome.subagents) await manager.getJob(id)?.promise;

			expect(outcome.subagents).toEqual(row.relaunched);
		});
	}
});
