/**
 * `omp --restore` and the sync subagents a parent's `task` call launched while it
 * streamed, each waiting to retry a key that could not be resolved: a launch the
 * call discards unadopted is stopped, so `--restore` relaunches nothing for a job the
 * parent never adopted; and launches the call adopted but never started, because the
 * call was aborted first, follow that abort: the parent's process exit leaves them
 * restorable, the parent's stop ends them.
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
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hasRestorableTurn, plainTurnAbortReason } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { activeBranch } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectSubSessions, type SubSession } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type RestoreOutcome, restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MOCK_API_SOURCE = "restore-after-speculative-discard-test";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const NOTES_FILE = "notes.txt";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-after-speculative-discard-");
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
 * subagents in sync (no background jobs). The worker's model is on anthropic, keyed by
 * the store's only OAuth login; its first request disables that login, as a failed
 * refresh does, so every later request has no key and its turn waits out a retry
 * backoff. Every subagent run's result is collected in `runs`.
 */
async function openParentWithKeyedWorkers() {
	const cwd = root.join("home", "work");
	await Bun.write(path.join(cwd, NOTES_FILE), "the notes\n");
	const authStorage = await AuthStorage.create(root.join("parentauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	const parentModel = createMockModel({ id: "parent-model", handler: { content: ["label"] } });
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
	const task = session.getToolByName("task");
	const launches = await task?.speculation?.stream?.open({ coordinator: launchSink, parentToolCallId: CALL.id });
	if (!task || !launches) throw new Error("Expected the task tool to launch streamed items");
	return { parent: session, task, launches, runs };
}

/**
 * Ends the parent's process once its subagent runs settled (every live session closes),
 * then has a new process restore the parent's session: what `--restore` relaunched, and
 * the subagent transcripts it judged.
 */
async function restoreInNewProcess(
	parent: AgentSession,
	runs: readonly Promise<SingleResult>[],
): Promise<{ outcome: RestoreOutcome; subagents: SubSession[] }> {
	await Promise.all(runs);
	const parentFile = parent.sessionManager.getSessionFile();
	if (!parentFile) throw new Error("Expected a persisted parent session file");
	const entries = parent.sessionManager.getEntries();
	const leafId = parent.sessionManager.getLeafId();
	await parent.dispose();
	await AgentLifecycleManager.global().dispose();

	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	const manager = new AsyncJobManager({});
	cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
	manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
	vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => subagentResult(options.id));
	const outcome = await restoreSession({
		sessionManager: { getSessionFile: () => parentFile, getEntries: () => entries, getLeafId: () => leafId },
		asyncJobManager: manager,
		settings: Settings.isolated(),
		restoreInterruptedTurn: vi.fn(async () => false),
	} as unknown as AgentSession);
	for (const id of outcome.subagents) await manager.getJob(id)?.promise;
	return { outcome, subagents: Object.values(await collectSubSessions(parentFile)) };
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
