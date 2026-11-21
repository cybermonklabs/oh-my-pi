/**
 * `omp --restore` and a subagent whose turn ended on a key it could not resolve, after its parent
 * got that failure and went on. A parent that got it from a `task` call holds it, so `--restore`
 * leaves the subagent (the control). A parent whose JavaScript eval cell got it through
 * `tool.task` holds it the same way, and `--restore` leaves that subagent too. A work pool's worker,
 * whose failure a cell got through the pool: when a later call of the turn was cut off, `--restore`
 * leaves it; when the process ended inside the cell that ran the pool, the parent's model never read
 * what the cell got, and the worker goes on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
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
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import * as piUtils from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, isRecord, postmortem, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
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
	// Every retry backoff passes at once, so the subagent's turn runs out of retries. Turn recovery's backoff
	// sleeps through sleepLong/sleepUntil, which recheck the real clock: with only scheduler.wait replaced they
	// call it again and again until the real deadline, and the spy keeps every call (millions, many GiB).
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

type ParentCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

const DELEGATIONS: Record<string, ParentCall> = {
	"a task call": { type: "toolCall", id: "call_task", name: "task", arguments: TASK_ARGS },
	"an eval cell's tool.task": {
		type: "toolCall",
		id: "call_eval",
		name: "eval",
		arguments: { language: "js", code: `print(await tool.task(${JSON.stringify(TASK_ARGS)}))`, timeout: 0 },
	},
};

/**
 * A JavaScript cell that runs `WORKER` on one item in a work pool, then waits through the bridged `wait`
 * tool for the pool's next result, which takes it: the pool's job delivers nothing afterwards.
 */
const POOL_CELL = [
	`const pool = await workpool(${JSON.stringify(WORKER.name)}, { name: "notes" });`,
	`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)});`,
	"print(JSON.stringify(await tool.wait({})));",
].join("\n");
/** A cell that never returns; the parent's process ends while it runs. */
const HANGING_CELL = "await Promise.withResolvers().promise;";
/** A work-pool item whose worker runs until its pool is stopped. */
const SLOW_ITEM = "Read the slow notes.";
/** The ways a cell kills a job through `proc://<id>/kill`: the prelude's `write()` and the bridged write tool. */
const KILL_CALLS: Record<string, string> = {
	"write()": 'await write("proc://notes/kill", "");',
	"tool.write": 'await tool.write({ path: "proc://notes/kill", content: "" });',
};

function evalCall(id: string, code: string): ParentCall {
	return { type: "toolCall", id, name: "eval", arguments: { language: "js", code, timeout: 0 } };
}

/**
 * Runs a parent turn whose model makes `steps`, one call per response, then answers. With `cut`, the
 * parent's process gets SIGTERM once `cut.ready` says the call `cut.callId` runs far enough.
 */
async function runParent(
	steps: readonly ParentCall[],
	cut?: {
		callId: string;
		ready: (event: { type: string; toolCallId?: string; partialResult?: unknown }) => boolean;
		/** Also awaited before the SIGTERM. */
		after?: Promise<unknown>;
	},
	/** Settings beyond the defaults below, such as `eval.workpool.freshAgents`. */
	extraSettings: Record<string, unknown> = {},
	/** The parent session's store; the file store by default. */
	sessionStorage: SessionStorage = new FileSessionStorage(),
) {
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
			const step = steps[context.messages.filter(message => message.role === "toolResult").length];
			if (!step) return { content: ["The worker could not read the notes."] };
			return { content: [step], stopReason: "toolUse" };
		},
	});
	// A worker given `SLOW_ITEM` answers only once its run is stopped. Its request resolved its key before the other
	// worker's first turn disables the login, which waits for it.
	const hasSlowItem = steps.some(step => JSON.stringify(step.arguments).includes(SLOW_ITEM));
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
				// A failed refresh disables the only login: every later request has no key.
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
		sessionManager: SessionManager.create(cwd, root.join("parent-sessions"), sessionStorage),
		settings: Settings.isolated({
			"async.enabled": false,
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
			"eval.py": false,
			"eval.autoBackground.enabled": false,
			...extraSettings,
		}),
		toolNames: steps.some(step => step.name === "eval")
			? [
					"eval",
					"task",
					...(steps.some(step => JSON.stringify(step.arguments).includes("tool.wait")) ? ["wait"] : []),
					// A cell reads and kills a job through `proc://`, which the read and write tools serve.
					...(steps.some(step => JSON.stringify(step.arguments).includes("proc://")) ? ["read", "write"] : []),
				]
			: ["task"],
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
	if (steps.some(step => step.name === "eval")) cleanups.push(() => disposeAllVmContexts());
	if (!cut) {
		await session.prompt("Delegate reading the notes.");
		await session.waitForIdle();
		return session;
	}
	const ready = Promise.withResolvers<void>();
	session.subscribe(event => {
		if ("toolCallId" in event && event.toolCallId === cut.callId && cut.ready(event)) ready.resolve();
	});
	const turn = session.prompt("Delegate reading the notes.");
	await ready.promise;
	await cut.after;
	await session.dispose({ reason: postmortem.Reason.SIGTERM });
	await turn.catch(() => {});
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
	// What `--restore` could go on with: a subagent nobody killed (no tombstone) whose own transcript is restorable,
	// and whether its turn ended on its key (so `--restore` judges it by its parent's records, not as a cut-off turn).
	const subagents = Object.values(await collectSubSessions(parentFile)).map(sub => ({
		id: sub.agentId,
		killed: sub.aborted,
		restorableAlone: hasRestorableTurn(sub.entries),
		keyStranded: endsOnCredentialUnavailableTurn(sub.entries),
	}));
	return { outcome, parentText, parentEntries, subagents };
}

describe("omp --restore after the parent got its subagent's failed key turn and went on", () => {
	for (const [name, call] of Object.entries(DELEGATIONS)) {
		it(`leaves the subagent when the parent got the failure from ${name}`, async () => {
			// If this regresses, `omp --restore` runs a subagent again whose failure the parent already read and
			// answered, and the parent gets its result a second time.
			const parent = await runParent([call]);
			const { outcome, parentText, subagents } = await restoreInNewProcess(parent);
			// The subagent's own transcript ends on the key marker, so only the parent's held result settles it.
			expect(subagents).toEqual([
				{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true },
			]);
			// The parent read the failure and answered.
			expect(parentText).toContain("The worker could not read the notes.");
			expect(outcome.subagents).toEqual([]);
		}, 60_000);
	}
});

describe("omp --restore after the parent's cell got its work-pool worker's failed key turn through the pool", () => {
	it("leaves the worker when a later call of the parent's turn was cut off", async () => {
		// If this regresses, the cut-off counts from the turn's input: the worker whose failure the first cell
		// already got through its pool reads as work of the call SIGTERM ended, and `--restore` relaunches it, so
		// the parent gets that result a second time. (Whether the cell's `wait` also lists the worker's own batch
		// job, and so names the worker, depends on timing; task/restore pins the case where no record names it.)
		const parent = await runParent([evalCall("call_pool", POOL_CELL), evalCall("call_hang", HANGING_CELL)], {
			callId: "call_hang",
			ready: event => event.type === "tool_execution_start",
		});
		const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

		// The first cell got the worker's failure through the pool.
		const poolResult = parentEntries.find(
			entry =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "call_pool",
		);
		expect(JSON.stringify(poolResult)).toContain("failed");
		expect(subagents).toEqual([{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true }]);
		expect(outcome.subagents).toEqual([]);
	}, 60_000);

	it("relaunches the worker when SIGTERM ended the cell that ran the pool, after the pool had its failure", async () => {
		// The control: the worker began inside the call the process ended in, whose cell never returned what it got,
		// so the parent's model never read the failure, even when the cut-off result names the worker.
		const parent = await runParent([evalCall("call_pool", `${POOL_CELL}\n${HANGING_CELL}`)], {
			callId: "call_pool",
			ready: event =>
				event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("failed"),
		});
		const { outcome, subagents } = await restoreInNewProcess(parent);

		expect(subagents).toEqual([{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true }]);
		expect(outcome.subagents).toEqual([subagents[0]!.id]);
	}, 60_000);
});

describe("omp --restore after SIGTERM while the parent's next cell waited on a work-pool worker", () => {
	it("relaunches the worker, which its pool's spawn record names, when the cell that pushed its item had returned", async () => {
		// If this regresses, a worker that writes no spawn record is judged by the cut-off window alone: it began in
		// the cell that pushed its item, before the cell whose wait SIGTERM ended, and the turn its parent still
		// waits on is never relaunched.
		const backoff = Promise.withResolvers<void>();
		// The worker's retry backoff lasts until the process ends, so the worker still waits to retry at the SIGTERM.
		const blockUntilAborted = async (signal?: AbortSignal): Promise<void> => {
			backoff.resolve();
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};
		vi.spyOn(piUtils, "sleepLong").mockImplementation(async (_delayMs, signal) => blockUntilAborted(signal));
		vi.spyOn(piUtils, "sleepUntil").mockImplementation(async (_deadlineMs, signal) => blockUntilAborted(signal));
		const pushCell = [
			`const pool = await workpool(${JSON.stringify(WORKER.name)}, { name: "notes" });`,
			`print(JSON.stringify(await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)})));`,
		].join("\n");
		const parent = await runParent(
			[evalCall("call_push", pushCell), evalCall("call_wait", "print(JSON.stringify(await tool.wait({})));")],
			{
				callId: "call_wait",
				ready: event => event.type === "tool_execution_start",
				after: backoff.promise,
			},
		);
		const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

		// The pool recorded its worker in the parent's transcript before the worker's run started.
		const spawned = parentEntries.flatMap(entry =>
			entry.type === "custom" && entry.customType === "task_spawn" ? [entry.data] : [],
		);
		// The worker's turn ended on its key, so the relaunch comes from the pool's spawn record, not from a cut-off turn.
		expect(subagents).toEqual([{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true }]);
		expect(spawned).toEqual([{ id: subagents[0]!.id }]);
		expect(outcome.subagents).toEqual([subagents[0]!.id]);
	}, 60_000);

	it("leaves the worker whose failure the cell that pushed its item read through peek()", async () => {
		// The control: the same worker and records, but the cell was handed the worker's failure, and the eval result
		// records that handover with its time, so `--restore` sends the parent no second result.
		const pushAndPeekCell = [
			`const pool = await workpool(${JSON.stringify(WORKER.name)}, { name: "notes" });`,
			`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)});`,
			"let snapshot = await pool.peek();",
			"while (snapshot.pending > 0) {",
			"\tawait new Promise(resolve => setTimeout(resolve, 10));",
			"\tsnapshot = await pool.peek();",
			"}",
			'print(snapshot.batches.map(batch => `${batch.agent}: ${batch.status}`).join("\\n"));',
		].join("\n");
		const parent = await runParent([evalCall("call_push", pushAndPeekCell), evalCall("call_hang", HANGING_CELL)], {
			callId: "call_hang",
			ready: event => event.type === "tool_execution_start",
		});
		const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

		const pushResult = parentEntries.find(
			entry =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "call_push",
		);
		const details =
			pushResult?.type === "message" && pushResult.message.role === "toolResult"
				? (pushResult.message.details as { agentResults?: Array<{ id: string; at?: number }> })
				: undefined;
		expect(subagents).toEqual([{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true }]);
		expect(details?.agentResults).toEqual([{ id: subagents[0]!.id, at: expect.any(Number) }]);
		expect(outcome.subagents).toEqual([]);
	}, 60_000);
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
	for (const [how, kill] of Object.entries(KILL_CALLS)) {
		it(`leaves the worker of a settled pool the cell killed with ${how}, whose kill result handed over the pool's report`, async () => {
			// If this regresses, the bridge records the handovers of a `task` and a `wait` call only: the kill takes the
			// settled pool's result, so no delivery follows, the eval result names no worker, and `--restore` relaunches
			// the worker whose failure the kill showed the cell.
			const cell = [
				POOL_HEAD,
				`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)});`,
				WAIT_FOR_POOL_SETTLED,
				kill,
			].join("\n");
			const parent = await runParent([evalCall("call_kill", cell)]);
			const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

			expect(subagents).toEqual([
				{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true },
			]);
			expect(outcome.subagents).toEqual([]);
			// The pool had settled: the kill result's job report holds its worker's result, and the cell recorded it.
			expect(toolResultDetails(parentEntries, "call_kill")?.agentResults).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: subagents[0]!.id })]),
			);
		}, 60_000);
	}

	for (const freshAgents of [false, true]) {
		it(`leaves a running pool's worker whose turn had already ended on its key: the kill records it discarded${freshAgents ? " (eval.workpool.freshAgents, the worker gone from the pool's live agents)" : ""}`, async () => {
			// If this regresses, the kill stops the worker still running, but not the worker whose batch had already
			// failed on its key (its batch settled, so its cancel does nothing). The kill hands nothing over (the pool
			// had not drained) and the cancelled pool is never delivered, so `--restore` relaunches that worker for a
			// pool the parent killed. With fresh agents, a settled worker has already left the pool's live agents:
			// the discard must come from every worker the pool started, its batches' too.
			const cell = [
				POOL_HEAD,
				`await pool.push(${JSON.stringify(`Read ${NOTES_FILE} and report it.`)}, ${JSON.stringify(SLOW_ITEM)});`,
				"let status = await pool.status();",
				"while (status.items.failed === 0) {",
				"\tawait new Promise(resolve => setTimeout(resolve, 10));",
				"\tstatus = await pool.status();",
				"}",
				KILL_CALLS["write()"],
				"print(JSON.stringify(status.items));",
			].join("\n");
			const parent = await runParent([evalCall("call_kill", cell)], undefined, {
				"eval.workpool.freshAgents": freshAgents,
			});
			const { outcome, parentEntries, subagents } = await restoreInNewProcess(parent);

			const stranded = subagents.filter(subagent => subagent.keyStranded);
			expect(subagents).toHaveLength(2);
			expect(stranded).toEqual([
				{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true },
			]);
			expect(outcome.subagents).toEqual([]);
			const discarded = parentEntries.flatMap(entry =>
				entry.type === "custom" && entry.customType === "task_spawn" && isRecord(entry.data) && entry.data.discarded
					? [entry.data.id]
					: [],
			);
			expect(discarded.sort()).toEqual(subagents.map(subagent => subagent.id).sort());
		}, 60_000);
	}
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

/** The spawn id of a discarded spawn record, else undefined. */
function discardedId(entry: { type?: unknown; customType?: unknown; data?: unknown }): string | undefined {
	if (entry.type !== "custom" || entry.customType !== "task_spawn" || !isRecord(entry.data)) return undefined;
	return entry.data.discarded === true && typeof entry.data.id === "string" ? entry.data.id : undefined;
}

function isDiscardRecord(entry: { type?: unknown; customType?: unknown; data?: unknown }): boolean {
	return discardedId(entry) !== undefined;
}

/** The spawn ids a session file records as discarded, read through a session manager. */
async function discardedIn(file: string): Promise<string[]> {
	const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
	const ids = manager.getEntries().flatMap(entry => discardedId(entry) ?? []);
	await manager.close();
	return ids.sort();
}

/** The same, read straight from the file at once: no wait for an append still running. */
function discardedOnDisk(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.flatMap(line => discardedId(JSON.parse(line) as { type?: unknown; customType?: unknown; data?: unknown }) ?? [])
		.sort();
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
	const parent = await runParent([evalCall("call_pool", RUNNING_POOL_CELL)], undefined, {}, sessionStorage);
	const parentFile = parent.sessionManager.getSessionFile();
	if (!parentFile) throw new Error("Expected a persisted parent session file");
	const pool = parent.asyncJobManager?.getJob("notes");
	expect(pool?.status).toBe("running");
	return { parent, parentFile, pool };
}

/** Another session on disk, next to `nextTo`, with one entry. */
async function anotherSession(cwd: string, nextTo: string): Promise<string> {
	const target = SessionManager.create(cwd, path.dirname(nextTo));
	target.appendMessage({ role: "user", content: "another session", timestamp: 1 });
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
		// session gains records that are not its own.
		// Its reads are slow, so the discards the switch's stop appends to the pool's own file land well after the
		// stop: only the pool's job waiting for them makes them be there when the job settles.
		const { parent, parentFile, pool } = await parentWithRunningPool(new SlowReadStorage());
		const targetFile = await anotherSession(parent.sessionManager.getCwd(), parentFile);

		expect(await parent.switchSession(targetFile)).toBe(true);
		await pool?.promise.catch(() => {});
		// The pool's job settles only once its discards are on disk, so a reader that does not wait for this
		// process's appends (another process's `--restore`) finds them.
		expect(discardedOnDisk(parentFile)).toHaveLength(2);
		expect(await discardedIn(targetFile)).toEqual([]);
		const { outcome, subagents } = await restoreInNewProcess(parent, parentFile);

		expect(subagents).toHaveLength(2);
		expect(subagents.filter(subagent => subagent.keyStranded)).toEqual([
			{ id: expect.any(String), killed: false, restorableAlone: true, keyStranded: true },
		]);
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
		expect(branch.filter(entry => isDiscardRecord(entry))).toHaveLength(2);
	}, 60_000);
});

describe("omp --restore after the parent forked or moved its session while its work pool ran", () => {
	it("leaves the worker in the fork the user goes on with: a later stop records the discards there", async () => {
		// If this regresses, the pool picks where to write by the file it was made in: after a whole-session fork
		// (new file, new session id, the same entries), a later stop writes the discards into the file before the
		// fork, and the fork keeps the spawn records and no discard, so its `--restore` relaunches the worker that
		// ended on its key.
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
		// The session before the fork holds the spawn records too, so it gets the discards as well.
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
