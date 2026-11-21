/**
 * `omp --restore` and a subagent whose turn ended on a key it could not resolve, after its parent
 * got that failure and went on. A parent that got it from a `task` call holds it, so `--restore`
 * leaves the subagent (the control). A parent whose JavaScript eval cell got it through
 * `tool.task` holds it the same way, and `--restore` leaves that subagent too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
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
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { endsOnCredentialUnavailableTurn, hasRestorableTurn } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import {
	readDiscardedLaunch,
	TASK_LAUNCH_DISCARDED_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import * as piUtils from "@oh-my-pi/pi-utils";
import { $which, __resetDirsFromEnvForTests, isRecord, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MOCK_API_SOURCE = "restore-after-eval-cell-result-test";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const NOTES_FILE = "notes.txt";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-after-eval-cell-result-");
	const home = root.join("home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	registerMockApi(MOCK_API_SOURCE);
	// Every wait passes at once. Turn recovery's backoff sleeps through sleepLong/sleepUntil, which recheck
	// the real clock: with only scheduler.wait replaced they call it again and again until the real
	// deadline, and the spy keeps every call (millions, many GiB).
	vi.spyOn(scheduler, "wait").mockImplementation(async (_delayMs, options) => {
		options?.signal?.throwIfAborted();
	});
	vi.spyOn(piUtils, "sleepLong").mockImplementation(async (_delayMs, signal) => {
		signal?.throwIfAborted();
	});
	vi.spyOn(piUtils, "sleepUntil").mockImplementation(async (_deadlineMs, signal) => {
		signal?.throwIfAborted();
	});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
});

const WORKER: AgentDefinition = {
	name: "keyed-worker",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};

const TASK_ARGS = {
	context: "The notes need a review.",
	tasks: [{ name: "Worker", agent: WORKER.name, task: `Read ${NOTES_FILE} and report it.` }],
};

/** A cell that runs the worker as an `agent()` job and takes its result with `wait()`. */
const AGENT_CELL = [
	`const handle = await agent(${JSON.stringify(TASK_ARGS.tasks[0]!.task)}, { agent: ${JSON.stringify(WORKER.name)} });`,
	"try { print(await wait([handle])); } catch (error) { print(String(error)); }",
].join("\n");

/** A cell that runs the worker as an `agent()` job and takes its result with the bridged `tool.wait`. */
const AGENT_TOOL_WAIT_CELL = [
	`await agent(${JSON.stringify(TASK_ARGS.tasks[0]!.task)}, { agent: ${JSON.stringify(WORKER.name)} });`,
	"try { print(await tool.wait({})); } catch (error) { print(String(error)); }",
].join("\n");

const DELEGATIONS = {
	"a task call": { type: "toolCall" as const, id: "call_task", name: "task", arguments: TASK_ARGS },
	"an eval cell's tool.task": {
		type: "toolCall" as const,
		id: "call_eval",
		name: "eval",
		arguments: { language: "js", code: `print(await tool.task(${JSON.stringify(TASK_ARGS)}))`, timeout: 0 },
	},
	"a Python eval cell's tool.task": {
		type: "toolCall" as const,
		id: "call_python_eval",
		name: "eval",
		arguments: { language: "py", code: `print(await tool.task(${JSON.stringify(TASK_ARGS)}))`, timeout: 0 },
	},
	"an eval cell's agent() and wait()": {
		type: "toolCall" as const,
		id: "call_agent_eval",
		name: "eval",
		arguments: { language: "js", code: AGENT_CELL, timeout: 0 },
	},
	"a backgrounded eval cell's agent() and wait()": {
		type: "toolCall" as const,
		id: "call_agent_background_eval",
		name: "eval",
		arguments: { language: "js", code: AGENT_CELL, timeout: 0 },
	},
	"an eval cell's agent() and tool.wait()": {
		type: "toolCall" as const,
		id: "call_agent_tool_wait_eval",
		name: "eval",
		arguments: { language: "js", code: AGENT_TOOL_WAIT_CELL, timeout: 0 },
	},
};

/** A work-pool item whose worker runs until its pool is stopped. */
const SLOW_ITEM = "Read the slow notes.";

/**
 * Runs a parent turn whose model makes `call`, then answers. Waits for the session's jobs to settle and their results
 * to be delivered, unless `leaveJobsRunning` (a work pool the test stops by a session change).
 */
async function runParent(
	call: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> },
	options: {
		leaveJobsRunning?: boolean;
		sessionStorage?: SessionStorage;
		/** Runs on the parent session before its prompt, such as a switch to another session. */
		beforePrompt?: (session: AgentSession) => Promise<void>;
	} = {},
) {
	const python = "language" in call.arguments && call.arguments.language === "py";
	const interpreter = Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "";
	if (python && !interpreter) throw new Error("The Python eval case needs python3 or python on PATH, or PYTHON set");
	const cwd = root.join("home", "work");
	await Bun.write(path.join(cwd, NOTES_FILE), "the notes\n");
	const authStorage = await AuthStorage.create(root.join("parentauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	await authStorage.credentials.set("anthropic", [
		{
			type: "oauth",
			access: "access-acc-live",
			refresh: "refresh-acc-live",
			expires: Date.now() + 3_600_000,
			accountId: "acc-live",
			email: "acc-live@example.com",
		},
	]);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	const parentModel = createMockModel({
		id: "parent-model",
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "task")) return { content: ["label"] };
			if (context.messages.some(message => message.role === "toolResult")) {
				return { content: ["The worker could not read the notes."] };
			}
			return { content: [call], stopReason: "toolUse" };
		},
	});
	// A worker given `SLOW_ITEM` answers only once its run is stopped. Its request resolved its key before the other
	// worker's first turn disables the login, which waits for it.
	const hasSlowItem = JSON.stringify(call.arguments).includes(SLOW_ITEM);
	const slowWorkerAsked = Promise.withResolvers<void>();
	const workerModel = createMockModel({
		provider: "anthropic",
		id: "mock-claude",
		handler: async context => {
			if (!(context.tools ?? []).some(tool => tool.name === "read")) return { content: ["label"] };
			if (JSON.stringify(context.messages).includes(SLOW_ITEM)) {
				slowWorkerAsked.resolve();
				return { content: ["the slow notes"], delayMs: 3_600_000 };
			}
			if (!context.messages.some(message => message.role === "toolResult")) {
				if (hasSlowItem) await slowWorkerAsked.promise;
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
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [parentModel, workerModel]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [WORKER], projectAgentsDir: null });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("parent-sessions"), options.sessionStorage),
		settings: Settings.isolated({
			"async.enabled": call.id.startsWith("call_agent"),
			"task.batch": true,
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
			"eval.py": python,
			"python.interpreter": interpreter,
			"eval.autoBackground.enabled": call.id === "call_agent_background_eval",
			"eval.autoBackground.thresholdMs": 1,
		}),
		toolNames:
			call.name !== "eval"
				? ["task"]
				: [
						"eval",
						"task",
						...(call.id === "call_agent_tool_wait_eval" ? ["wait"] : []),
						// A cell reads and kills a job through `proc://`, which the read and write tools serve.
						...(JSON.stringify(call.arguments).includes("proc://") ? ["read", "write"] : []),
					],
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
	if (call.name === "eval") cleanups.push(() => disposeAllVmContexts());
	if (options.beforePrompt) await options.beforePrompt(session);
	await session.prompt("Delegate reading the notes.");
	await session.waitForIdle();
	if (options.leaveJobsRunning) return session;
	// A backgrounded cell finishes as a job, and its result reaches the parent as a delivery.
	await Promise.allSettled((session.asyncJobManager?.getRunningJobs() ?? []).map(job => job.promise));
	await session.asyncJobManager?.drainDeliveries({ timeoutMs: 10_000 });
	await session.waitForIdle();
	return session;
}

/**
 * Ends the parent's process normally, then has a new process restore its session from the file: `parentFile`,
 * else the one the parent writes now.
 */
async function restoreInNewProcess(parent: AgentSession, parentFile = parent.sessionManager.getSessionFile()) {
	if (!parentFile) throw new Error("Expected a persisted parent session file");
	const parentText = parent.agent.state.messages
		.filter(message => message.role === "assistant")
		.flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text));
	// A cell that moved to the background answers its call with the job marker (`details.async`).
	const backgrounded = parent.agent.state.messages.some(
		message =>
			message.role === "toolResult" &&
			message.toolName === "eval" &&
			(message.details as { async?: unknown } | undefined)?.async !== undefined,
	);
	await parent.dispose();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	const reopened = await SessionManager.open(parentFile, undefined, undefined, { suppressBreadcrumb: true });
	const parentEntries = reopened.getEntries();
	const leafId = reopened.getLeafId();
	await reopened.close();
	const manager = new AsyncJobManager({});
	cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
	manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
	vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(
		async options => ({ index: 0, id: options.id, exitCode: 0, output: "the notes" }) as SingleResult,
	);
	const outcome = await restoreSession({
		sessionManager: { getSessionFile: () => parentFile, getEntries: () => parentEntries, getLeafId: () => leafId },
		asyncJobManager: manager,
		settings: Settings.isolated(),
		restoreInterruptedTurn: vi.fn(async () => false),
	} as unknown as AgentSession);
	for (const id of outcome.subagents) await manager.getJob(id)?.promise;
	// What `--restore` could go on with: a subagent whose own transcript is restorable, and whether its turn ended on
	// its key (so `--restore` judges it by its parent's records, not as a cut-off turn).
	const subagents = Object.values(await collectSubSessions(parentFile)).map(sub => ({
		id: sub.agentId,
		restorableAlone: hasRestorableTurn(sub.entries),
		keyStranded: endsOnCredentialUnavailableTurn(sub.entries),
	}));
	return { backgrounded, outcome, parentText, parentEntries, subagents };
}

describe("omp --restore after the parent got its subagent's failed key turn and went on", () => {
	for (const [name, call] of Object.entries(DELEGATIONS)) {
		it(`leaves the subagent when the parent got the failure from ${name}`, async () => {
			const parent = await runParent(call);
			const { backgrounded, outcome, parentText, subagents } = await restoreInNewProcess(parent);
			expect(backgrounded).toBe(call.id === "call_agent_background_eval");
			expect(subagents).toEqual([{ id: expect.any(String), restorableAlone: true, keyStranded: true }]);
			expect(parentText).toContain("The worker could not read the notes.");
			expect(outcome.subagents).toEqual([]);
		}, 60_000);
	}
});

/** Cell lines that make the work pool "notes" of `WORKER`. */
const POOL_HEAD = `const pool = await workpool(${JSON.stringify(WORKER.name)}, { name: "notes" });`;
/**
 * Cell lines that wait until the pool's own job has settled, reading its `proc://` page (a read never takes a
 * job's result): its first line is `<id> [<type>] — <state> — …`.
 */
const WAIT_FOR_POOL_SETTLED = [
	'let state = (await read("proc://notes")).split("\\n")[0];',
	"while (/— (running|queued) —/.test(state)) {",
	"\tawait new Promise(resolve => setTimeout(resolve, 10));",
	'\tstate = (await read("proc://notes")).split("\\n")[0];',
	"}",
	"print(state);",
].join("\n");
/**
 * A cell's kill of the job `notes` through `proc://notes/kill`, with the bridged write tool. The prelude's `write()`
 * writes files only here: it rejects a protocol path that has no local root, such as `proc://`.
 */
const KILL_POOL = 'await tool.write({ path: "proc://notes/kill", content: "" });';

function killCall(code: string) {
	return { type: "toolCall" as const, id: "call_kill", name: "eval", arguments: { language: "js", code, timeout: 0 } };
}

function toolResultDetails(entries: readonly SessionEntry[], toolCallId: string): Record<string, unknown> | undefined {
	const entry = entries.find(
		candidate =>
			candidate.type === "message" &&
			candidate.message.role === "toolResult" &&
			candidate.message.toolCallId === toolCallId,
	);
	if (entry?.type !== "message" || entry.message.role !== "toolResult") return undefined;
	return entry.message.details as Record<string, unknown> | undefined;
}

describe("omp --restore after a cell killed its work pool through proc://<id>/kill", () => {
	it("leaves the worker of a settled pool the cell killed with tool.write, whose kill result handed over the pool's report", async () => {
		// If this regresses, the bridge records the handovers of a `task` and a `wait` call only: the kill takes the
		// settled pool's result, so no delivery follows, the eval result names no worker, and `--restore` relaunches
		// the worker whose failure the kill showed the cell.
		const cell = [
			POOL_HEAD,
			`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)});`,
			WAIT_FOR_POOL_SETTLED,
			KILL_POOL,
		].join("\n");
		const parent = await runParent(killCall(cell));
		const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

		expect(subagents).toEqual([{ id: expect.any(String), restorableAlone: true, keyStranded: true }]);
		expect(outcome.subagents).toEqual([]);
		// The pool had settled: the kill result's job report holds its worker's result, and the cell recorded it.
		expect(toolResultDetails(parentEntries, "call_kill")?.agentResults).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: subagents[0]!.id })]),
		);
	}, 60_000);

	it("leaves a running pool's worker whose turn had already ended on its key: the kill records it discarded", async () => {
		// If this regresses, the kill stops the worker still running, but not the worker whose batch had already failed
		// on its key (its batch settled, so its cancel does nothing). The kill hands nothing over (the pool had not
		// drained) and the cancelled pool is never delivered, so `--restore` relaunches that worker for a pool the
		// parent killed.
		const cell = [
			POOL_HEAD,
			`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)}, ${JSON.stringify(SLOW_ITEM)});`,
			"let status = await pool.status();",
			"while (status.items.failed === 0) {",
			"\tawait new Promise(resolve => setTimeout(resolve, 10));",
			"\tstatus = await pool.status();",
			"}",
			KILL_POOL,
			"print(JSON.stringify(status.items));",
		].join("\n");
		const parent = await runParent(killCall(cell));
		const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

		const stranded = subagents.filter(subagent => subagent.keyStranded);
		expect(subagents).toHaveLength(2);
		expect(stranded).toEqual([{ id: expect.any(String), restorableAlone: true, keyStranded: true }]);
		expect(outcome.subagents).toEqual([]);
		const discarded = parentEntries.flatMap(entry =>
			entry.type === "custom" &&
			entry.customType === TASK_LAUNCH_DISCARDED_CUSTOM_TYPE &&
			isRecord(entry.data) &&
			typeof entry.data.agentId === "string"
				? [entry.data.agentId]
				: [],
		);
		expect(discarded.sort()).toEqual(subagents.map(subagent => subagent.id).sort());
	}, 60_000);
});

/**
 * A cell that makes the pool, pushes an item whose worker ends on its key and the slow item, and returns once the
 * first has failed: the pool still runs, with one worker stranded on its key and one waiting.
 */
const RUNNING_POOL_CELL = [
	POOL_HEAD,
	`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)}, ${JSON.stringify(SLOW_ITEM)});`,
	"let status = await pool.status();",
	"while (status.items.failed === 0) {",
	"\tawait new Promise(resolve => setTimeout(resolve, 10));",
	"\tstatus = await pool.status();",
	"}",
	"print(JSON.stringify(status.items));",
].join("\n");

function poolCall() {
	return {
		type: "toolCall" as const,
		id: "call_pool",
		name: "eval",
		arguments: { language: "js", code: RUNNING_POOL_CELL, timeout: 0 },
	};
}

/** The subagent ids the entries record as discarded spawns. */
function discardedIds(entries: ReadonlyArray<{ type?: unknown; customType?: unknown; data?: unknown }>): string[] {
	return entries.flatMap(entry => readDiscardedLaunch(entry as SessionEntry) ?? []).sort();
}

/** The subagent ids a session file records as discarded spawns, read through a session manager. */
async function discardedIn(file: string): Promise<string[]> {
	const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
	const ids = discardedIds(manager.getEntries());
	await manager.close();
	return ids;
}

/** The same, read straight from the file at once: no wait for an append still running. */
function discardedOnDisk(file: string): string[] {
	return discardedIds(
		readFileSync(file, "utf8")
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as { type?: unknown; customType?: unknown; data?: unknown }),
	);
}

/** A file store whose reads wait 300 ms, so an append through it ends well after the call that started it. */
class SlowReadStorage extends FileSessionStorage {
	override async readText(sessionPath: string): Promise<string> {
		await Bun.sleep(300);
		return super.readText(sessionPath);
	}
}

/** Starts the parent with a running pool, one worker stranded on its key; returns it, its file and the pool's job. */
async function parentWithRunningPool(sessionStorage?: SessionStorage) {
	const parent = await runParent(poolCall(), { leaveJobsRunning: true, sessionStorage });
	const parentFile = parent.sessionManager.getSessionFile();
	if (!parentFile) throw new Error("Expected a persisted parent session file");
	const pool = parent.asyncJobManager?.getJob("notes");
	expect(pool?.status).toBe("running");
	return { parent, parentFile, pool };
}

/**
 * Another session on disk, next to `nextTo`, whose one entry is a user message, as another writer makes it: no
 * model or reminder entry comes before that message.
 */
async function anotherSession(cwd: string, nextTo: string): Promise<string> {
	const target = SessionManager.create(cwd, path.dirname(nextTo));
	target.appendMessage({ role: "user", content: "another session", timestamp: 1 });
	// A session with no assistant message is written only when asked.
	await target.ensureOnDisk();
	await target.flush();
	const targetFile = target.getSessionFile();
	await target.close();
	if (!targetFile) throw new Error("Expected the other session's file");
	return targetFile;
}

describe("omp --restore after the parent resumed another session while its work pool ran", () => {
	it("leaves the pool's key-stranded worker: the switch's stop records the discards in the pool's own session", async () => {
		// If this regresses, `switchSession` points the session's manager at the resumed file before it cancels the
		// session's jobs, so the stopped pool writes its discards there: the session it was made in keeps its worker's
		// spawn record and no discard, its `--restore` relaunches the worker that ended on its key, and the resumed
		// session gains records that are not its own. Its reads are slow, so only the pool's job waiting for the
		// discards it appends to its own file makes them be there when the job settles.
		const { parent, parentFile, pool } = await parentWithRunningPool(new SlowReadStorage());
		const targetFile = await anotherSession(parent.sessionManager.getCwd(), parentFile);

		expect(await parent.switchSession(targetFile)).toBe(true);
		await pool?.promise.catch(() => {});
		expect(discardedOnDisk(parentFile)).toHaveLength(2);
		expect(await discardedIn(targetFile)).toEqual([]);
		const { outcome, subagents } = await restoreInNewProcess(parent, parentFile);

		expect(subagents).toHaveLength(2);
		expect(subagents.filter(subagent => subagent.keyStranded)).toHaveLength(1);
		expect(await discardedIn(parentFile)).toEqual(subagents.map(subagent => subagent.id).sort());
		expect(outcome.subagents).toEqual([]);
	}, 60_000);

	it("keeps the discards on the branch it goes on with when it resumes the pool's session again at once", async () => {
		// If this regresses, the resume back loads the pool's session before the stop's discards are in it, and its
		// next entry follows the old last entry: the discards end up on a side branch `--restore` does not read.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const targetFile = await anotherSession(parent.sessionManager.getCwd(), parentFile);

		expect(await parent.switchSession(targetFile)).toBe(true);
		expect(await parent.switchSession(parentFile, { keepModel: true })).toBe(true);
		parent.sessionManager.appendCustomEntry("after-resume", {});
		await parent.sessionManager.flush();
		await pool?.promise.catch(() => {});

		const reopened = await SessionManager.open(parentFile, undefined, undefined, { suppressBreadcrumb: true });
		const branch = reopened.getBranch();
		await reopened.close();
		expect(branch.at(-1)).toMatchObject({ type: "custom", customType: "after-resume" });
		expect(discardedIds(branch)).toHaveLength(2);
	}, 60_000);
});

describe("omp --restore after the parent forked or moved its session while its work pool ran", () => {
	it("leaves the worker in the fork the user goes on with: a later stop records the discards there", async () => {
		// If this regresses, the pool picks where to write by the file it was made in: after a whole-session fork, a
		// later stop writes the discards into the file before the fork, and the fork keeps the spawn records and no
		// discard, so its `--restore` relaunches the worker that ended on its key.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		expect(await parent.fork()).toBe(true);
		const forkFile = parent.sessionManager.getSessionFile();
		if (!forkFile) throw new Error("Expected the fork's file");
		expect(forkFile).not.toBe(parentFile);

		expect(await parent.newSession()).toBe(true);
		await pool?.promise.catch(() => {});
		const { outcome, subagents } = await restoreInNewProcess(parent, forkFile);

		expect(subagents).toHaveLength(2);
		expect(subagents.filter(subagent => subagent.keyStranded)).toHaveLength(1);
		// Neither worker is relaunched: not the one stranded on its key, and not the one the fork copied mid-run,
		// whose copy reads as cut off.
		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(await discardedIn(forkFile)).toEqual(ids);
		expect(await discardedIn(parentFile)).toEqual(ids);
	}, 60_000);

	it("leaves the worker in the moved session: a later stop records the discards at its new path", async () => {
		// If this regresses, a stop after `/move` appends to the path the pool was made at, which the move emptied:
		// nothing is written, and the moved session's `--restore` relaunches the worker that ended on its key.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const movedCwd = root.join("home", "moved");
		await fs.mkdir(movedCwd, { recursive: true });
		await parent.moveSession(movedCwd, root.join("moved-sessions"));
		const movedFile = parent.sessionManager.getSessionFile();
		if (!movedFile) throw new Error("Expected the moved session's file");
		expect(movedFile).not.toBe(parentFile);

		expect(await parent.newSession()).toBe(true);
		await pool?.promise.catch(() => {});
		const { outcome, subagents } = await restoreInNewProcess(parent, movedFile);

		expect(subagents).toHaveLength(2);
		expect(subagents.filter(subagent => subagent.keyStranded)).toHaveLength(1);
		expect(outcome.subagents).toEqual([]);
		expect(await discardedIn(movedFile)).toEqual(subagents.map(subagent => subagent.id).sort());
	}, 60_000);
});

/** A user message after the pool's spawn records: the parent's second prompt, while the pool still runs. */
async function secondPromptEntryId(parent: AgentSession): Promise<string> {
	await parent.prompt("Say done.");
	await parent.waitForIdle();
	const entry = parent.sessionManager
		.getBranch()
		.findLast(candidate => candidate.type === "message" && candidate.message.role === "user");
	if (!entry) throw new Error("Expected the second prompt's entry");
	return entry.id;
}

/** The answer a /btw promotes into its branch. */
function btwAnswer(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "A side answer." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("omp --restore after the parent branched off its session from an entry while its work pool ran", () => {
	it("leaves the worker in the session a fork from an entry makes: the fork's stop records the discards there", async () => {
		// If this regresses, the fork cancels the session's jobs before it makes the new session: the stopped pool
		// writes its discards at the old session's leaf, and the fork copies the path up to the entry, the pool's spawn
		// records with it but not the discards, and the worker transcripts, so its `--restore` relaunches the worker
		// that ended on its key.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const entryId = await secondPromptEntryId(parent);
		expect(await parent.fork(entryId)).toBe(true);
		const newFile = parent.sessionManager.getSessionFile();
		if (!newFile) throw new Error("Expected the new session's file");
		expect(newFile).not.toBe(parentFile);
		await pool?.promise.catch(() => {});
		await parent.sessionManager.flush();
		const { outcome, subagents } = await restoreInNewProcess(parent, newFile);

		expect(subagents).toHaveLength(2);
		expect(subagents.filter(subagent => subagent.keyStranded)).toHaveLength(1);
		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(await discardedIn(newFile)).toEqual(ids);
		expect(await discardedIn(parentFile)).toEqual(ids);
	}, 60_000);

	it("records the discards in the session a branch from an entry makes, and in the one it left", async () => {
		// A branch copies the path up to the entry's parent, the pool's spawn records with it, but no worker
		// transcripts, so its own `--restore` has no worker to relaunch; the discards still go where the records are.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const entryId = await secondPromptEntryId(parent);
		expect((await parent.branch(entryId)).cancelled).toBe(false);
		const newFile = parent.sessionManager.getSessionFile();
		if (!newFile) throw new Error("Expected the new session's file");
		expect(newFile).not.toBe(parentFile);
		await pool?.promise.catch(() => {});
		await parent.sessionManager.flush();
		const { outcome, subagents } = await restoreInNewProcess(parent, parentFile);

		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(ids).toHaveLength(2);
		expect(await discardedIn(parentFile)).toEqual(ids);
		expect(await discardedIn(newFile)).toEqual(ids);
	}, 60_000);

	it("records the discards in the session a branch from its first entry, a user message, leaves for an empty one", async () => {
		// If this regresses, the session manager starts the empty session without recording the one it left: the
		// branch cancels the session's jobs only after that, the new session holds no spawn record, and the stopped
		// pool writes its discards nowhere, so the left session's `--restore` relaunches the worker that ended on its
		// key.
		// A session omp starts records its model, thinking level and date reminder before the first user message, so
		// the parent resumes a session another writer made, which starts with its user message, and runs the pool there.
		const parent = await runParent(poolCall(), {
			leaveJobsRunning: true,
			beforePrompt: async session => {
				const cwd = session.sessionManager.getCwd();
				const target = await anotherSession(cwd, root.join("parent-sessions", "placeholder.jsonl"));
				expect(await session.switchSession(target)).toBe(true);
			},
		});
		const sessionFile = parent.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected the resumed session's file");
		const pool = parent.asyncJobManager?.getJob("notes");
		expect(pool?.status).toBe("running");
		const firstPrompt = parent.sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!firstPrompt) throw new Error("Expected the first user message's entry");
		// The message is the root entry, so the branch takes the path that makes an empty session.
		expect(firstPrompt.parentId).toBeNull();
		expect((await parent.branch(firstPrompt.id)).cancelled).toBe(false);
		const newFile = parent.sessionManager.getSessionFile();
		if (!newFile) throw new Error("Expected the new session's file");
		expect(newFile).not.toBe(sessionFile);
		await pool?.promise.catch(() => {});
		await parent.sessionManager.flush();
		const { outcome, subagents } = await restoreInNewProcess(parent, sessionFile);

		expect(subagents).toHaveLength(2);
		expect(subagents.filter(subagent => subagent.keyStranded)).toHaveLength(1);
		expect(outcome.subagents).toEqual([]);
		expect(await discardedIn(sessionFile)).toEqual(subagents.map(subagent => subagent.id).sort());
		expect(await discardedIn(newFile)).toEqual([]);
	}, 60_000);

	it("promotes a /btw answer into a new session while the pool runs, and records the discards in both sessions", async () => {
		// If this regresses, the /btw branch cancels the session's jobs first: the stopped pool appends its discards at
		// the leaf the branch is pinned to, and the branch refuses with "session changed since /btw started".
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const leafId = parent.sessionManager.getLeafId();
		if (!leafId) throw new Error("Expected a leaf");
		const result = await parent.branchFromBtw(
			"A side question?",
			btwAnswer(),
			leafId,
			parent.sessionManager.getSessionId(),
		);
		expect(result.cancelled).toBe(false);
		const newFile = result.sessionFile;
		if (!newFile) throw new Error("Expected the /btw session's file");
		expect(newFile).not.toBe(parentFile);
		await pool?.promise.catch(() => {});
		await parent.sessionManager.flush();
		const { outcome, subagents } = await restoreInNewProcess(parent, parentFile);

		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(ids).toHaveLength(2);
		expect(await discardedIn(parentFile)).toEqual(ids);
		expect(await discardedIn(newFile)).toEqual(ids);
	}, 60_000);
});

describe("omp --restore after the parent went through several sessions while its work pool ran", () => {
	/** Forks the whole live session and returns the fork's file. */
	async function forkWhole(parent: AgentSession, from: string): Promise<string> {
		expect(await parent.fork()).toBe(true);
		const forkFile = parent.sessionManager.getSessionFile();
		if (!forkFile || forkFile === from) throw new Error("Expected a new fork file");
		return forkFile;
	}

	it("records the discards in the pool's session and the fork it left, not in the session it resumed", async () => {
		// If this regresses, the stop reaches only the live session and the pool's own: the fork B the parent left for
		// another session D keeps the spawn records and no discard, and its `--restore` relaunches the worker.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const forkB = await forkWhole(parent, parentFile);
		const otherD = await anotherSession(parent.sessionManager.getCwd(), parentFile);
		expect(await parent.switchSession(otherD)).toBe(true);
		await pool?.promise.catch(() => {});
		const { outcome, subagents } = await restoreInNewProcess(parent, forkB);

		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(ids).toHaveLength(2);
		expect(await discardedIn(forkB)).toEqual(ids);
		expect(await discardedIn(parentFile)).toEqual(ids);
		expect(await discardedIn(otherD)).toEqual([]);
	}, 60_000);

	it("records the discards in every session it left since the pool was made: two forks, then a resume", async () => {
		// If this regresses, the manager remembers only the last session it left: the first fork B, left for the
		// second fork C, gets no discards.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const forkB = await forkWhole(parent, parentFile);
		const forkC = await forkWhole(parent, forkB);
		const otherD = await anotherSession(parent.sessionManager.getCwd(), parentFile);
		expect(await parent.switchSession(otherD)).toBe(true);
		await pool?.promise.catch(() => {});
		const { outcome, subagents } = await restoreInNewProcess(parent, forkB);

		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(ids).toHaveLength(2);
		for (const file of [parentFile, forkB, forkC]) expect(await discardedIn(file)).toEqual(ids);
		expect(await discardedIn(otherD)).toEqual([]);
	}, 60_000);

	it("records the discards at the moved session's new path after a move, a fork and a resume", async () => {
		// If this regresses, the stop looks for the pool's session at the path it had when the pool was made, which the
		// move emptied, and the fork that came after is the only left session remembered.
		const { parent, parentFile, pool } = await parentWithRunningPool();
		const movedCwd = root.join("home", "moved");
		await fs.mkdir(movedCwd, { recursive: true });
		await parent.moveSession(movedCwd, root.join("moved-sessions"));
		const movedFile = parent.sessionManager.getSessionFile();
		if (!movedFile || movedFile === parentFile) throw new Error("Expected the moved session's file");
		const forkB = await forkWhole(parent, movedFile);
		const otherD = await anotherSession(parent.sessionManager.getCwd(), forkB);
		expect(await parent.switchSession(otherD)).toBe(true);
		await pool?.promise.catch(() => {});
		const { outcome, subagents } = await restoreInNewProcess(parent, movedFile);

		expect(outcome.subagents).toEqual([]);
		const ids = subagents.map(subagent => subagent.id).sort();
		expect(ids).toHaveLength(2);
		expect(await discardedIn(movedFile)).toEqual(ids);
		expect(await discardedIn(forkB)).toEqual(ids);
	}, 60_000);

	it("does not try the session the parent left before the pool existed", async () => {
		// If this regresses, a stop also tries the never-written draft the parent left for the session the pool runs in,
		// and logs that it could not record its discards there.
		const warn = vi.spyOn(logger, "warn");
		const parent = await runParent(poolCall(), {
			leaveJobsRunning: true,
			beforePrompt: async session => {
				const cwd = session.sessionManager.getCwd();
				const target = await anotherSession(cwd, root.join("parent-sessions", "placeholder.jsonl"));
				expect(await session.switchSession(target)).toBe(true);
			},
		});
		const pool = parent.asyncJobManager?.getJob("notes");
		expect(pool?.status).toBe("running");
		expect(await parent.newSession()).toBe(true);
		await pool?.promise.catch(() => {});

		const poolWarnings = warn.mock.calls.filter(([message]) => String(message).startsWith("workpool:"));
		expect(poolWarnings).toEqual([]);
	}, 60_000);
});
