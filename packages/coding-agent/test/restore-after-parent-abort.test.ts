/**
 * `omp --restore` and a parent's sync subagents waiting to retry a key that could not
 * be resolved, when the parent's abort reaches them: a launch the parent's streamed
 * `task` call discards unadopted is stopped, so `--restore` relaunches nothing for a job
 * the parent never adopted; launches the call adopted but never started, because the
 * call was aborted first, follow that abort: the parent's process exit leaves them
 * restorable, the parent's stop ends them; a stop of a continuation turn (one a queued
 * steer started) without a reason stops its subagent too; the parent's process exit
 * during its sync call leaves the subagent for `--restore`, although the call records the
 * run that exit cut off as its result; and a subagent a JavaScript eval cell started
 * through `tool.task` follows the parent's abort the same way: an exit cuts it off, the
 * user's stop ends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hasRestorableTurn, plainTurnAbortReason } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { activeBranch, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectSubSessions, type SubSession } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type RestoreOutcome, restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { isTaskToolDetails, type SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, postmortem, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MOCK_API_SOURCE = "restore-after-parent-abort-test";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const NOTES_FILE = "notes.txt";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-after-parent-abort-");
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

const WORKER: AgentDefinition = {
	name: "keyed-worker",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};

const CALL: AgentToolCall = { type: "toolCall", id: "call_task", name: "task", arguments: {} };

/** The parent's streamed batch `task` call, one item per worker name. */
function batchCall(names: readonly string[]) {
	return {
		context: "The notes need a review.",
		tasks: names.map(name => ({ name, agent: WORKER.name, task: `Read ${NOTES_FILE} and report it.` })),
	};
}

/** The parent's `eval` call: a JavaScript cell that runs one worker through its sync `task` tool. */
const CELL_CALL = {
	type: "toolCall" as const,
	id: "call_eval",
	name: "eval",
	arguments: {
		language: "js",
		code: `print(await tool.task(${JSON.stringify(batchCall(["CellWorker"]))}))`,
		timeout: 0,
	},
};

/** The host's go-ahead for every launch, as under auto-allow approval with no lifecycle handlers. */
const launchSink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
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
 * A parent session on the production SDK path whose batch `task` tool runs `WORKER`
 * subagents in sync (no background jobs); a turn of its model spawns one worker, by a
 * `task` call, or with `delegation: "eval"` by an `eval` call whose JavaScript cell calls
 * `tool.task` (`CELL_CALL`). The worker's model is on anthropic, keyed by the store's
 * only OAuth login; its first request disables that login, as a failed refresh does, so
 * every later request has no key and its turn waits out a retry backoff. Every subagent
 * run's result is collected in `runs`.
 */
async function openParentWithKeyedWorkers(delegation: "task" | "eval" = "task") {
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
				return { content: ["The worker could not read the notes."] };
			}
			return {
				content: [
					delegation === "eval"
						? CELL_CALL
						: { type: "toolCall", id: CALL.id, name: "task", arguments: batchCall(["SteeredWorker"]) },
				],
				stopReason: "toolUse",
			};
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
	const runSubprocess = executorModule.runSubprocess;
	const runs: Promise<SingleResult>[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
		const run = runSubprocess(options);
		runs.push(run);
		return run;
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("parent-sessions")),
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": true,
			"task.speculativeLaunch": true,
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
			"eval.py": false,
			"eval.autoBackground.enabled": false,
		}),
		toolNames: delegation === "eval" ? ["eval", "task"] : ["task"],
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
	if (delegation === "eval") cleanups.push(() => disposeAllVmContexts());
	const task = session.getToolByName("task");
	const launches = await task?.speculation?.stream?.open({ coordinator: launchSink, parentToolCallId: CALL.id });
	if (!task || !launches) throw new Error("Expected the task tool to launch streamed items");
	return { parent: session, task, launches, runs };
}

/**
 * Ends the parent's process once its subagent runs settled (every live session closes),
 * then has a new process restore the parent's session from its file: what `--restore`
 * relaunched, the parent's entries it read, and the subagent transcripts it judged.
 */
async function restoreInNewProcess(
	parent: AgentSession,
	runs: readonly Promise<SingleResult>[],
): Promise<{ outcome: RestoreOutcome; parentEntries: SessionEntry[]; subagents: SubSession[] }> {
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
	return { outcome, parentEntries, subagents: Object.values(await collectSubSessions(parentFile)) };
}

function subagentResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: WORKER.name,
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
	credentialUnavailable: true | undefined;
	restorable: boolean;
}

function turnEnd(sub: SubSession): TurnEnd {
	const branch = activeBranch(sub.entries, sub.leafId);
	const tail = branch.filter(entry => entry.type === "message").at(-1);
	return {
		stopReason: tail?.type === "message" && tail.message.role === "assistant" ? tail.message.stopReason : undefined,
		credentialUnavailable:
			tail?.type === "message" && tail.message.role === "assistant" ? tail.message.credentialUnavailable : undefined,
		restorable: hasRestorableTurn(branch),
	};
}

describe("omp --restore after a streamed task call discarded a sync launch waiting to retry its key", () => {
	it("stops the launched subagent's turn, so --restore of the parent relaunches nothing", async () => {
		// If this regresses, the discard reads to the subagent as its parent's process exit: its turn keeps the
		// marked error, and `omp --restore` relaunches it, giving the parent a result for a job it never adopted.
		const { parent, launches, runs } = await openParentWithKeyedWorkers();
		const backoff = holdBackoff(1);
		const launched = batchCall(["KeyedWorker"]);
		await launches.update(CALL, JSON.stringify(launched));
		// The worker's first request went out; its next one has no key and waits out the backoff.
		await backoff.allHeld;
		expect(runs).toHaveLength(1);
		// The call finishes with other arguments, so dispatch never adopts the launch.
		await launches.finalize({
			toolCall: CALL,
			args: { ...launched, tasks: [{ ...launched.tasks[0]!, task: "Summarize the notes instead." }] },
		});

		const { outcome, subagents } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(outcome.subagents).toEqual([]);
		expect(subagents.map(turnEnd)).toEqual([
			{ stopReason: "aborted", credentialUnavailable: undefined, restorable: false },
		]);
	}, 30_000);
});

describe("omp --restore after a sync task call was aborted before the launches it adopted started", () => {
	const aborts = [
		{ name: "the parent's process exit", reason: () => plainTurnAbortReason("cutOff"), restorable: true },
		{ name: "the parent's stop", reason: () => plainTurnAbortReason("stop"), restorable: false },
	];
	for (const abort of aborts) {
		it(`follows ${abort.name}`, async () => {
			// If this regresses, the subagents the call adopted read every abort of the call as a stop (or every
			// one as a cut-off): a process exit loses their turns, or a stop leaves them for `--restore`.
			const { parent, task, launches, runs } = await openParentWithKeyedWorkers();
			const backoff = holdBackoff(2);
			const launched = batchCall(["FirstWorker", "SecondWorker"]);
			await launches.update(CALL, JSON.stringify(launched));
			await backoff.allHeld;
			expect(runs).toHaveLength(2);
			await launches.finalize({ toolCall: CALL, args: launched });
			// The parent's turn was aborted while the call was being dispatched, before its spawns started.
			const call = new AbortController();
			call.abort(abort.reason());
			await task.execute(CALL.id, launched, call.signal);

			const { outcome, subagents } = await restoreInNewProcess(parent, runs);
			backoff.wait.mockRestore();

			const ids = subagents.map(sub => sub.agentId).sort();
			expect(ids).toHaveLength(2);
			expect([...outcome.subagents].sort()).toEqual(abort.restorable ? ids : []);
			const end: TurnEnd = abort.restorable
				? { stopReason: "error", credentialUnavailable: true, restorable: true }
				: { stopReason: "aborted", credentialUnavailable: undefined, restorable: false };
			expect(subagents.map(turnEnd)).toEqual([end, end]);
		}, 30_000);
	}
});

describe("omp --restore after a stop without a reason ended a continuation turn's sync subagent waiting to retry its key", () => {
	it("stops the subagent's turn, so --restore of the parent relaunches nothing", async () => {
		// If this regresses, the continuation's own signal aborts first with the platform's unmarked reason, which
		// reads to the subagent as its parent's process exit: its turn keeps the marked error, and `omp --restore`
		// relaunches a subagent of a turn the user stopped.
		const { parent, runs } = await openParentWithKeyedWorkers();
		const backoff = holdBackoff(1);
		// A steer on the idle parent starts its turn as a continuation (a queued-message drain).
		await parent.steer("Delegate reading the notes.");
		await backoff.allHeld;
		expect(runs).toHaveLength(1);
		await parent.abort();

		const { outcome, subagents } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(outcome.subagents).toEqual([]);
		expect(subagents.map(turnEnd)).toEqual([
			{ stopReason: "aborted", credentialUnavailable: undefined, restorable: false },
		]);
	}, 30_000);
});

describe("omp --restore after the parent's process exit cut off its sync task call while the subagent waited to retry its key", () => {
	it("relaunches the subagent, although the parent recorded the run that exit cut off as the call's result", async () => {
		// If this regresses, the result the parent's agent loop records as its process goes away reads as the
		// subagent's failure, which the parent never acted on: `omp --restore` leaves the subagent's turn unfinished.
		const { parent, runs } = await openParentWithKeyedWorkers();
		const backoff = holdBackoff(1);
		const turn = parent.prompt("Delegate reading the notes.");
		await backoff.allHeld;
		expect(runs).toHaveLength(1);
		await parent.dispose({ reason: postmortem.Reason.EXIT });
		await turn;

		const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		const ids = subagents.map(sub => sub.agentId);
		expect(ids).toHaveLength(1);
		const recorded = parentEntries.flatMap(entry =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "task" &&
			isTaskToolDetails(entry.message.details)
				? entry.message.details.results.map(result => ({ id: result.id, aborted: result.aborted }))
				: [],
		);
		expect(recorded).toEqual([{ id: ids[0], aborted: true }]);
		expect(outcome.subagents).toEqual(ids);
		expect(subagents.map(turnEnd)).toEqual([{ stopReason: "error", credentialUnavailable: true, restorable: true }]);
	}, 30_000);
});

describe("omp --restore after the parent's abort reached a sync subagent its JavaScript eval cell started while it waited to retry its key", () => {
	it("relaunches the subagent the parent's process exit cut off", async () => {
		// If this regresses, the eval bridge aborts the cell's `tool.task` call with an error it made of the exit's
		// reason, which reads to the subagent as a stop: its turn ends on an aborted record, and `omp --restore`
		// leaves the work the exit cut off unfinished.
		const { parent, runs } = await openParentWithKeyedWorkers("eval");
		const backoff = holdBackoff(1);
		const turn = parent.prompt("Delegate reading the notes from a script.");
		await backoff.allHeld;
		expect(runs).toHaveLength(1);
		await parent.dispose({ reason: postmortem.Reason.EXIT });
		await turn;

		const { outcome, subagents } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		const ids = subagents.map(sub => sub.agentId);
		expect(ids).toHaveLength(1);
		expect(subagents.map(turnEnd)).toEqual([{ stopReason: "error", credentialUnavailable: true, restorable: true }]);
		expect(outcome.subagents).toEqual(ids);
	}, 30_000);

	it("leaves the subagent the user's stop ended", async () => {
		// If this regresses, the user's stop reaches the cell's subagent as a cut-off: its turn keeps the marked
		// error, and `omp --restore` relaunches work the user stopped.
		const { parent, runs } = await openParentWithKeyedWorkers("eval");
		const backoff = holdBackoff(1);
		const turn = parent.prompt("Delegate reading the notes from a script.");
		await backoff.allHeld;
		expect(runs).toHaveLength(1);
		await parent.abort({ reason: USER_INTERRUPT_LABEL });
		await turn;

		const { outcome, subagents } = await restoreInNewProcess(parent, runs);
		backoff.wait.mockRestore();

		expect(subagents.map(turnEnd)).toEqual([
			{ stopReason: "aborted", credentialUnavailable: undefined, restorable: false },
		]);
		expect(outcome.subagents).toEqual([]);
	}, 30_000);
});
