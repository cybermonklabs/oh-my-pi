import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { executeCancel } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type AsyncResultDetails,
	ASYNC_RESULT_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import {
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { GENERIC_ABORT_SENTINEL, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VIBE_CLI_AGENT, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { TempDir } from "@oh-my-pi/pi-utils";

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

/** A turn the process died in, mid tool call (no result, no exit record). */
const cutOff: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		stopReason: "toolUse",
	}),
];
/** A turn that ended on the model's own answer. */
const finished: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ content: [{ type: "text", text: "all done" }] }),
];

/**
 * A turn as the agent ends it when no request could resolve its provider key:
 * the provider's `!command` apiKey produced nothing, so the turn's resolver
 * (`ModelRegistry.turnResolver`, as sdk.ts wires it) failed and no request went out.
 */
async function keyUnresolvedTurn(dir: string): Promise<Message[]> {
	const modelsPath = path.join(dir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				"custom-proxy": {
					baseUrl: "https://custom-proxy.example.com/v1",
					api: "openai-completions",
					apiKey: "!false",
					models: [{ id: "custom-model", name: "Custom Model" }],
				},
			},
		}),
	);
	const authStorage = await AuthStorage.create(path.join(dir, "testauth.db"));
	try {
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected the custom test model");
		const mock = createMockModel({ provider: model.provider, id: model.id });
		const agent = new Agent({
			getApiKey: requestModel => registry.turnResolver(requestModel),
			initialState: { model, systemPrompt: ["sub prompt"], tools: [], messages: [] },
			streamFn: (_model, context, options) => aiStream.streamSimple(mock.model, context, options),
		});
		await agent.prompt("work");
		expect(mock.calls).toHaveLength(0);
		return agent.state.messages as Message[];
	} finally {
		authStorage.close();
	}
}

/** Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract. */
async function writeSubagent(
	mainFile: string,
	cwd: string,
	id: string,
	messages: Message[],
	options?: { agent?: string; normalExit?: boolean },
): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({
		systemPrompt: ["sub prompt"],
		task: `${id} task`,
		tools: ["read", "yield"],
		agent: options?.agent,
	});
	for (const message of messages) manager.appendMessage(message);
	if (options?.normalExit) {
		manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
	}
	await manager.close();
	return file;
}

function subagentResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: id,
		agentSource: "user",
		task: `${id} task`,
		exitCode: 0,
		output: "finished after the restart",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** The parent's `task` call that spawned subagent `id`, and the result that names it. */
function appendTaskSpawn(main: SessionManager, id: string): void {
	const callId = `call_${id}`;
	main.appendMessage(
		assistant({
			content: [{ type: "toolCall", id: callId, name: "task", arguments: { agent: "task", task: `${id} task` } }],
			stopReason: "toolUse",
		}),
	);
	const details: TaskToolDetails = { projectAgentsDir: null, results: [subagentResult(id)], totalDurationMs: 5 };
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "task",
		content: [{ type: "text", text: `${id} finished` }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
	main.appendMessage(result);
}

const KEY_ERROR = "Retry budget exhausted after 2 retries: No API key for provider: anthropic";

/** A turn that ended because no request could resolve its provider key, even after its retries. */
const stranded: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true }),
];

/**
 * The parent's `task` call to subagent `id` and what the call got back: nothing (`cut off`:
 * the parent's process ended while it waited), the sync spawn's failed result (with `run`'s
 * fields), or a background spawn's "started" record, which names the spawn only in its progress.
 */
function parentTaskCall(
	id: string,
	outcome: "cut off" | "failed" | "started",
	run: Partial<SingleResult> = {},
): Message[] {
	const toolCallId = `call_${id}`;
	const call = assistant({
		content: [{ type: "toolCall", id: toolCallId, name: "task", arguments: { agent: "task", task: `${id} task` } }],
		stopReason: "toolUse",
	});
	if (outcome === "cut off") return [call];
	const failed: TaskToolDetails = {
		projectAgentsDir: null,
		results: [{ ...subagentResult(id), exitCode: 1, output: "", error: KEY_ERROR, ...run }],
		totalDurationMs: 5,
	};
	const started = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 5,
		progress: [{ index: 0, id, agent: "task", agentSource: "user", status: "running", task: `${id} task` }],
		async: { state: "running", jobId: id, type: "task" },
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "task",
		content: [{ type: "text", text: outcome === "failed" ? KEY_ERROR : `Started background job ${id}.` }],
		details: outcome === "failed" ? failed : started,
		isError: false,
		timestamp: Date.now(),
	};
	return [call, result];
}

/**
 * The results of a sync spawn that settle nothing of its run, as the parent's agent loop records
 * them when the parent's process goes away inside the call.
 */
const unsettledRunResults: Record<string, Partial<SingleResult>> = {
	"the run its process exit cut off": { aborted: true },
	"the run lost with its worker thread": {
		error: "Subagent worker w1 exited mid-run: worker pool disposed",
		workerLost: true,
	},
};

/** A sync spawn's result when its worker thread crashed while the parent ran on. */
const crashedWorkerRun: Partial<SingleResult> = {
	error: "Subagent worker w1 exited mid-run: worker crashed: out of memory",
	workerLost: true,
};

/** The parent's next turns after its sync call's result: it lived on, read the result and went on. */
const laterTurns: Record<string, () => AssistantMessage> = {
	"the parent answered it": () =>
		assistant({ content: [{ type: "text", text: "Unsettled did not finish; going on without it." }] }),
	"the user stopped the parent's next request": () =>
		assistant({ stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL }),
};

/**
 * The records that end the parent's turn after its sync call's result when the parent's process goes away
 * inside the call: exit recovery's, or the agent loop's record of an abort without a reason (its flag beside
 * its text, as the loop writes it), which a dispose for a quit, `/restart` or a signal leaves. That record
 * also comes with its text alone (saved before the flag existed) and with the flag alone (turn recovery's
 * stamp on a platform's own abort text).
 */
const exitTurnEnds: Record<string, (branch: SessionEntry[]) => AssistantMessage> = {
	"the interrupted-turn record exit recovery writes": branch => {
		const record = createInterruptedTurnAbortMessage(branch, undefined, { assumeExit: true });
		if (!record) throw new Error("Expected exit recovery to close the parent's turn");
		return record;
	},
	"the record of an abort without a reason that a quit or a signal leaves": () =>
		assistant({
			stopReason: "aborted",
			errorMessage: GENERIC_ABORT_SENTINEL,
			errorId: AIError.create(AIError.Flag.Abort),
		}),
	"that record saved before its flag existed, its text alone": () =>
		assistant({ stopReason: "aborted", errorMessage: GENERIC_ABORT_SENTINEL }),
	"the flag alone, which turn recovery stamps on a platform's own abort text": () =>
		assistant({
			stopReason: "aborted",
			errorMessage: "The operation was aborted",
			errorId: AIError.create(AIError.Flag.Abort),
		}),
};

/** The records that hand a parent its background subagent `id`'s settled job result. */
const jobResultRecords: Record<string, (main: SessionManager, id: string, status: "completed" | "failed") => void> = {
	"its async-result delivery": (main, id, status) => {
		const details: AsyncResultDetails = {
			jobs: [{ jobId: id, type: "task", status, agentId: id, label: `${id} task`, durationMs: 5 }],
		};
		main.appendCustomMessageEntry(ASYNC_RESULT_MESSAGE_TYPE, `Background job ${id} ${status}.`, true, details);
	},
	"a wait that returned it": (main, id, status) => {
		main.appendMessage(
			assistant({
				content: [{ type: "toolCall", id: `call_wait_${status}`, name: "wait", arguments: {} }],
				stopReason: "toolUse",
			}),
		);
		const details: CoordinationDetails = {
			op: "wait",
			jobs: [
				{
					id,
					type: "task",
					status,
					label: `${id} task`,
					durationMs: 5,
					...(status === "failed" ? { errorText: KEY_ERROR } : { resultText: "first part done" }),
					agentUrlId: id,
				},
			],
		};
		main.appendMessage({
			role: "toolResult",
			toolCallId: `call_wait_${status}`,
			toolName: "wait",
			content: [{ type: "text", text: `### ${id} [task] — ${status}` }],
			details,
			isError: false,
			timestamp: Date.now(),
		});
	},
};

/** An eval cell result that handed the parent subagent results through a bridged call. */
function appendEvalAgentResults(main: SessionManager, id: string): void {
	const toolCallId = `call_eval_${id}`;
	main.appendMessage(
		assistant({
			content: [{ type: "toolCall", id: toolCallId, name: "eval", arguments: { language: "js", code: "…" } }],
			stopReason: "toolUse",
		}),
	);
	main.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "eval",
		content: [{ type: "text", text: `${id} failed` }],
		details: {
			language: "js",
			languages: ["js"],
			cells: [],
			agentResults: [{ id }],
		},
		isError: false,
		timestamp: Date.now(),
	});
}

/** The delivery of a background eval cell that handed the parent subagent results. */
function appendAsyncEvalAgentResults(main: SessionManager, id: string): void {
	const details: AsyncResultDetails = {
		jobs: [
			{
				jobId: "eval",
				type: "eval",
				status: "completed",
				agentResults: [{ id }],
			},
		],
	};
	main.appendCustomMessageEntry(ASYNC_RESULT_MESSAGE_TYPE, `Background eval handed ${id} its result.`, true, details);
}

/** A durable background eval `agent()` state transition. */
function appendEvalAgentSpawn(main: SessionManager, id: string, status: "unsettled" | "delivered"): void {
	main.appendCustomEntry("eval_agent_spawn", { id, status });
}

/** The record the task tool writes when it spawns subagent `id`: the id it allocated for the spawn. */
function appendTaskSpawnRecord(main: SessionManager, id: string): void {
	main.appendCustomEntry("task_spawn", { id });
}

/** A `wait` result that returned a settled background eval job whose cells were handed subagent `id`'s result. */
function appendWaitForEvalJob(main: SessionManager, id: string): void {
	main.appendMessage(
		assistant({
			content: [{ type: "toolCall", id: "call_wait_eval", name: "wait", arguments: {} }],
			stopReason: "toolUse",
		}),
	);
	const details: CoordinationDetails = {
		op: "wait",
		jobs: [
			{ id: "eval-job", type: "eval", status: "completed", label: "eval", durationMs: 5, agentResults: [{ id }] },
		],
	};
	main.appendMessage({
		role: "toolResult",
		toolCallId: "call_wait_eval",
		toolName: "wait",
		content: [{ type: "text", text: "### eval-job [eval] — completed" }],
		details,
		isError: false,
		timestamp: Date.now(),
	});
}

/**
 * The process exit record a SIGTERM leaves: written before the turn is aborted, it names the tool calls still
 * running then (none when the process ended while a response streamed).
 */
function appendSignalExit(main: SessionManager, pendingCallIds: string[]): void {
	main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "SIGTERM",
		kind: "signal",
		recordedAt: new Date().toISOString(),
		...(pendingCallIds.length > 0
			? { pendingToolCalls: pendingCallIds.map(toolCallId => ({ toolCallId, toolName: "eval" })) }
			: {}),
	});
}

/** The result the agent loop records for a call the process exit aborted. */
function abortedResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "Command aborted" }],
		isError: true,
		timestamp: Date.now(),
	};
}

/** The interrupted-turn record that closes the parent's turn its process exit cut off. */
function closeInterruptedTurn(main: SessionManager): void {
	const record = createInterruptedTurnAbortMessage(main.getBranch(), undefined, { assumeExit: true });
	if (!record) throw new Error("Expected the parent's turn to read as cut off");
	main.appendMessage(record);
}

/** The parent's `eval` call whose JavaScript cell runs a work pool. */
function poolEvalCall(toolCallId: string): AssistantMessage {
	return assistant({
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "eval",
				arguments: { language: "js", code: 'const pool = await workpool("task"); …' },
			},
		],
		stopReason: "toolUse",
	});
}

/** The marker the session writes when the parent's call `toolCallId` starts running. */
function markStarted(main: SessionManager, toolCallId: string): void {
	main.appendCustomEntry("tool_execution_start", {
		toolCallId,
		toolName: "eval",
		startedAt: new Date().toISOString(),
	});
}

describe("restoreSession (omp --restore)", () => {
	const ids = [
		"Cut",
		"Done",
		"Killed",
		"Stranded",
		"Refused",
		"ClearedHere",
		"ErrorHere",
		"Older",
		"Left",
		"Current",
		"Held",
		"Outer",
		"Inner",
		"Awaited",
		"Started",
		"Delivered",
		"FollowedUp",
		"Unsettled",
		"EvalHeld",
		"BranchEval",
		"UnknownPath",
		"EvalAgent",
		"DeliveredAgent",
		"Scout",
		"Scout-2",
		"Worker",
		"Worker-2",
		"Lead",
		"Lead.Worker",
		"EvalCut",
		"WaitEval",
		"Pool-1",
		"Pool-2",
		"AgentFollowUp",
		"Discarded",
		"Pool-3",
		"Reused",
		"Reagent",
		"Kept",
		"Vibe-1",
		"Pool-K",
	];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		for (const id of ids) AgentRegistry.global().unregister(id);
		VibeSessionRegistry.resetGlobalForTests();
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	/** Restores the parent session `main` in a new process, as its last one left it: what went on. */
	async function restoreParent(main: SessionManager, mainFile: string) {
		const entries = main.getEntries();
		const leafId = main.getLeafId();
		await main.close();
		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		const followUp = vi
			.spyOn(executorModule, "runSubagentFollowUpTurn")
			.mockImplementation(async options => subagentResult(options.id));
		const outcome = await restoreSession({
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => entries, getLeafId: () => leafId },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => false),
		} as unknown as AgentSession);
		for (const id of outcome.subagents) await manager.getJob(id)?.promise;
		return { outcome, followUp };
	}

	/** A parent session that asked for work: its file, and the manager that writes it. */
	function openParent(): { main: SessionManager; mainFile: string; cwd: string } {
		tempDir = TempDir.createSync("@pi-restore-parent-waits-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		return { main, mainFile, cwd };
	}

	it("goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones", async () => {
		tempDir = TempDir.createSync("@pi-restore-subagents-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await main.close();
		await writeSubagent(mainFile, cwd, "Cut", cutOff, { agent: "scout" });
		await writeSubagent(mainFile, cwd, "Done", finished);
		const killed = await writeSubagent(mainFile, cwd, "Killed", cutOff);
		await fs.writeFile(getAgentTombstonePath(killed), "");

		manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink(MAIN_AGENT_ID, jobId => {
			delivered.push(jobId);
		});
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(subagentResult("Cut"));
		const restoreTurn = vi.fn(async () => true);
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => [], getLeafId: () => null },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: restoreTurn,
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: true, subagents: ["Cut"] });
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({
			id: "Cut",
			agent: { name: "Cut" },
			restore: true,
			message: "Cut task",
			softRequestBudget: 100,
		});
		await manager.getJob("Cut")!.promise;
		await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
		expect(delivered).toEqual(["Cut"]);
	});

	it("relaunches a subagent whose turn ended because its key could not be resolved, even after a normal exit", async () => {
		// If this regresses, the stranded subagent is never relaunched: its failed turn reads as final.
		tempDir = TempDir.createSync("@pi-restore-key-unresolved-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		// The task tool recorded the id it allocated for the spawn: the parent's only record of it.
		appendTaskSpawnRecord(main, "Stranded");
		const mainEntries = main.getEntries();
		const mainLeafId = main.getLeafId();
		await main.close();
		// The worker's process exited normally on the failed turn.
		await writeSubagent(mainFile, cwd, "Stranded", await keyUnresolvedTurn(cwd), { normalExit: true });
		// A turn the provider refused is final, as before.
		await writeSubagent(
			mainFile,
			cwd,
			"Refused",
			[
				{ role: "user", content: "work", timestamp: Date.now() },
				assistant({
					stopReason: "error",
					errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}',
				}),
			],
			{ normalExit: true },
		);

		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		const followUp = vi
			.spyOn(executorModule, "runSubagentFollowUpTurn")
			.mockResolvedValue(subagentResult("Stranded"));
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => mainEntries, getLeafId: () => mainLeafId },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => false),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: false, subagents: ["Stranded"] });
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Stranded", restore: true, message: "Stranded task" });
		await manager.getJob("Stranded")!.promise;
	});

	it("judges each subagent by the branch its transcript selects, not by entries on other branches", async () => {
		// If this regresses, a turn on an abandoned branch or behind a `/clear` is relaunched, or the selected
		// branch's key-unresolved turn is not.
		tempDir = TempDir.createSync("@pi-restore-branches-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		// The task tool recorded the ids it allocated: each subagent is the parent's work, so only its own
		// transcript's branches decide.
		appendTaskSpawnRecord(main, "ClearedHere");
		appendTaskSpawnRecord(main, "ErrorHere");
		const mainEntries = main.getEntries();
		const mainLeafId = main.getLeafId();
		await main.close();
		const keyUnresolved = assistant({
			stopReason: "error",
			errorMessage: "Retry budget exhausted after 2 retries: No API key for provider: anthropic",
			credentialUnavailable: true,
		});
		const writeBranches = async (id: string, layout: (sub: SessionManager, root: string) => void) => {
			const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
			const sub = await SessionManager.open(file, undefined, undefined, {
				initialCwd: cwd,
				parentSession: mainFile,
				suppressBreadcrumb: true,
			});
			sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"] });
			layout(sub, sub.appendMessage({ role: "user", content: "work", timestamp: Date.now() }));
			sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "dispose",
				kind: "normal",
				recordedAt: new Date().toISOString(),
			});
			await sub.close();
		};
		// The selected branch was cleared; the key-unresolved turn sits on another branch, written later.
		await writeBranches("ClearedHere", (sub, root) => {
			sub.appendResetBoundary();
			sub.appendMessageToBranch(keyUnresolved, root);
		});
		// The selected branch ends on the key-unresolved turn; a `/clear` sits on an abandoned branch.
		await writeBranches("ErrorHere", (sub, root) => {
			const failed = sub.appendMessage(keyUnresolved);
			sub.branch(root);
			sub.appendResetBoundary();
			sub.branch(failed);
		});

		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(subagentResult("ErrorHere"));
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => mainEntries, getLeafId: () => mainLeafId },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => false),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: false, subagents: ["ErrorHere"] });
		await manager.getJob("ErrorHere")!.promise;
	});

	it("relaunches a key-stranded subagent of the parent's current conversation, not one of a branch it left or from before its /clear", async () => {
		// If this regresses, `--restore` relaunches a key-stranded subagent of work its parent left behind (such a
		// turn stays restorable after a normal exit), and the parent receives a result for a job its current
		// conversation never started.
		tempDir = TempDir.createSync("@pi-restore-parent-conversation-");
		const cwd = tempDir.path();
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		// No `task` result names "Older": the parent's process ended inside the call that spawned it, before the /clear.
		await writeSubagent(mainFile, cwd, "Older", stranded);
		setSystemTime(new Date(start + 60_000));
		main.appendResetBoundary();
		setSystemTime(new Date(start + 120_000));
		const prompt = main.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
		// The parent spawned "Left", then went back to its prompt and went on another way.
		appendTaskSpawn(main, "Left");
		await writeSubagent(mainFile, cwd, "Left", stranded);
		main.branch(prompt);
		// On that way it spawned "Current", and its process ended inside that call: no result names it either.
		main.appendMessage(
			assistant({
				content: [
					{
						type: "toolCall",
						id: "call_Current",
						name: "task",
						arguments: { agent: "task", task: "Current task" },
					},
				],
				stopReason: "toolUse",
			}),
		);
		await writeSubagent(mainFile, cwd, "Current", stranded);
		const mainEntries = main.getEntries();
		const mainLeafId = main.getLeafId();
		await main.close();
		setSystemTime();

		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(subagentResult("Current"));
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => mainEntries, getLeafId: () => mainLeafId },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => false),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: false, subagents: ["Current"] });
		await manager.getJob("Current")!.promise;
	});

	it("does not relaunch a subagent stranded without its key whose failed result its parent holds, at the top level or under a subagent", async () => {
		// If this regresses, `--restore` relaunches a subagent whose failure its parent's model already acted on, and
		// the parent receives a second result for a call it answered.
		const { main, mainFile, cwd } = openParent();
		await writeSubagent(mainFile, cwd, "Held", stranded, { normalExit: true });
		for (const message of parentTaskCall("Held", "failed")) main.appendMessage(message);
		main.appendMessage(assistant({ content: [{ type: "text", text: "Held could not run." }] }));
		// Outer got Inner's failed result the same way, answered, and finished.
		await writeSubagent(path.join(mainFile.slice(0, -6), "Outer.jsonl"), cwd, "Inner", stranded, {
			normalExit: true,
		});
		await writeSubagent(
			mainFile,
			cwd,
			"Outer",
			[
				{ role: "user", content: "Outer task", timestamp: Date.now() },
				...parentTaskCall("Inner", "failed"),
				assistant({ content: [{ type: "text", text: "Inner could not run." }] }),
			],
			{ normalExit: true },
		);
		appendTaskSpawn(main, "Outer");

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("relaunches a subagent stranded without its key while its parent's sync call still waited on it", async () => {
		// If this regresses, the work of a subagent whose parent's process ended while it waited is lost: no result
		// reached the parent, and nothing goes on with it.
		const { main, mainFile, cwd } = openParent();
		for (const message of parentTaskCall("Awaited", "cut off")) main.appendMessage(message);
		await writeSubagent(mainFile, cwd, "Awaited", stranded, { normalExit: true });

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Awaited"] });
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Awaited", restore: true });
	});

	it("does not relaunch a subagent stranded without its key under a subagent spawned before the main session's /clear, though its own parent still waits on it", async () => {
		// If this regresses, `--restore` relaunches a subagent of a subagent of work the user cleared, whose own
		// parent is not relaunched: the cleared work goes on, and its result reaches a parent that never runs again.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawn(main, "Outer");
		// Outer's call to Inner got no result (Outer still waits on it), then Outer exited normally.
		await writeSubagent(path.join(mainFile.slice(0, -6), "Outer.jsonl"), cwd, "Inner", stranded, {
			normalExit: true,
		});
		await writeSubagent(
			mainFile,
			cwd,
			"Outer",
			[{ role: "user", content: "Outer task", timestamp: Date.now() }, ...parentTaskCall("Inner", "cut off")],
			{ normalExit: true },
		);
		setSystemTime(new Date(start + 60_000));
		main.appendResetBoundary();
		setSystemTime(new Date(start + 120_000));
		main.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
		setSystemTime();

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	/**
	 * Restores a parent whose sync call spawned "Unsettled", which was stranded without its key, and got the run's
	 * failed result (with `run`'s fields) after the subagent's turn began: `record` writes that result and what
	 * follows it in the parent's transcript.
	 */
	async function restoreAfterSyncResult(
		run: Partial<SingleResult>,
		record: (main: SessionManager, result: Message) => void,
	) {
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		const [call, result] = parentTaskCall("Unsettled", "failed", run);
		main.appendMessage(call!);
		await writeSubagent(mainFile, cwd, "Unsettled", stranded, { normalExit: true });
		setSystemTime(new Date(start + 60_000));
		record(main, result!);
		setSystemTime();
		return restoreParent(main, mainFile);
	}

	for (const [record, run] of Object.entries(unsettledRunResults)) {
		it(`relaunches a subagent stranded without its key whose parent's sync call recorded ${record}`, async () => {
			// If this regresses, the result the parent's agent loop records as its process goes away inside the call
			// reads as the subagent's failure, which the parent never acted on: `--restore` loses the subagent's turn.
			// The call's result is written as the parent's process goes away, after the subagent's turn began.
			const { outcome, followUp } = await restoreAfterSyncResult(run, (main, result) => main.appendMessage(result));

			expect(outcome).toEqual({ turn: false, subagents: ["Unsettled"] });
			expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Unsettled", restore: true });
		});
	}

	const settledRuns: Array<[run: string, result: Partial<SingleResult>]> = [
		["whose worker crashed while its parent lived on", crashedWorkerRun],
		["whose aborted run's result its parent read", unsettledRunResults["the run its process exit cut off"]!],
	];
	for (const [run, result] of settledRuns) {
		for (const [turn, laterTurn] of Object.entries(laterTurns)) {
			it(`does not relaunch a subagent stranded without its key ${run}, after which ${turn}`, async () => {
				// If this regresses, a lost worker's or an aborted run's result reads as unsettled after the parent read
				// it and went on: `--restore` relaunches the subagent, and the parent receives a second result for a call
				// it acted on.
				const { outcome, followUp } = await restoreAfterSyncResult(result, (main, message) => {
					main.appendMessage(message);
					main.appendMessage(laterTurn());
				});

				expect(outcome).toEqual({ turn: false, subagents: [] });
				expect(followUp).not.toHaveBeenCalled();
			});
		}
	}

	for (const [end, endTurn] of Object.entries(exitTurnEnds)) {
		it(`relaunches a subagent stranded without its key whose worker its parent's exit lost, the call's result followed only by ${end}`, async () => {
			// If this regresses, the record that ends the parent's turn as its process goes away reads as a turn the
			// parent took after the result: `--restore` loses the turn of a subagent its parent still waits on.
			const { outcome, followUp } = await restoreAfterSyncResult(
				unsettledRunResults["the run lost with its worker thread"]!,
				(main, result) => {
					// As the parent's process goes away, its dispose records the exit first; the call's result and the
					// record that ends the turn follow.
					main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
						reason: "sigterm",
						kind: "signal",
						recordedAt: new Date().toISOString(),
					});
					main.appendMessage(result);
					main.appendMessage(endTurn(main.getBranch()));
				},
			);

			expect(outcome).toEqual({ turn: false, subagents: ["Unsettled"] });
			expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Unsettled", restore: true });
		});
	}

	it("relaunches a background subagent stranded without its key whose parent holds only the record that started it", async () => {
		// If this regresses, a background subagent whose failed job result never reached its parent is lost: the
		// parent's record of its start reads as its result.
		const { main, mainFile, cwd } = openParent();
		for (const message of parentTaskCall("Started", "started")) main.appendMessage(message);
		main.appendMessage(assistant({ content: [{ type: "text", text: "Started is running." }] }));
		await writeSubagent(mainFile, cwd, "Started", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Started"] });
	});

	for (const [record, deliver] of Object.entries(jobResultRecords)) {
		it(`does not relaunch a background subagent stranded without its key whose failed job result reached its parent: ${record}`, async () => {
			// If this regresses, `--restore` relaunches a background subagent whose failure its parent's model already
			// acted on, and the parent receives the job's result a second time.
			const { main, mainFile, cwd } = openParent();
			for (const message of parentTaskCall("Delivered", "started")) main.appendMessage(message);
			main.appendMessage(assistant({ content: [{ type: "text", text: "Delivered is running." }] }));
			await writeSubagent(mainFile, cwd, "Delivered", stranded, { normalExit: true });
			deliver(main, "Delivered", "failed");
			main.appendMessage(assistant({ content: [{ type: "text", text: "Delivered could not run." }] }));

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: [] });
			expect(followUp).not.toHaveBeenCalled();
		});

		it(`relaunches a subagent whose follow-up turn ended without its key when its parent holds only an earlier turn's result: ${record}`, async () => {
			// If this regresses, the result of the subagent's first turn reads as the failure of the turn its parent
			// messaged it for: the parent waits on that turn, and `--restore` never goes on with it.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			for (const message of parentTaskCall("FollowedUp", "started")) main.appendMessage(message);
			const sub = await SessionManager.open(
				path.join(mainFile.slice(0, -6), "FollowedUp.jsonl"),
				undefined,
				undefined,
				{
					initialCwd: cwd,
					parentSession: mainFile,
					suppressBreadcrumb: true,
				},
			);
			sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: "FollowedUp task", tools: ["read", "yield"] });
			sub.appendMessage({ role: "user", content: "FollowedUp task", timestamp: Date.now() });
			sub.appendMessage(assistant({ content: [{ type: "text", text: "first part done" }] }));
			// The parent got that first result, then messaged the subagent to go on.
			setSystemTime(new Date(start + 60_000));
			deliver(main, "FollowedUp", "completed");
			main.appendMessage(assistant({ content: [{ type: "text", text: "Asked FollowedUp for the rest." }] }));
			// The message woke the subagent; that turn ended because its key could not be resolved.
			setSystemTime(new Date(start + 120_000));
			sub.appendCustomMessageEntry("irc:incoming", "Now do the rest.", true, {
				from: MAIN_AGENT_ID,
				message: "Now do the rest.",
			});
			sub.appendMessage(assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true }));
			sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "dispose",
				kind: "normal",
				recordedAt: new Date().toISOString(),
			});
			await sub.close();
			setSystemTime();

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: ["FollowedUp"] });
			expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "FollowedUp", restore: true });
		});
	}

	// Each bridged call that hands a cell a subagent's result (`tool.task` in JavaScript or Python, `tool.wait`,
	// `wait()`) reports it through the same record, the eval result's `agentResults`; core/js-tool-bridge,
	// core/python-tool-bridge and eval/handle-bridge-progress pin that each call writes it, and that a status poll
	// does not.
	const evalEvidence: Record<string, (main: SessionManager, id: string) => void> = {
		"an eval result whose cells' bridged calls were handed it (agentResults)": appendEvalAgentResults,
		"a backgrounded eval cell's async-result delivery": appendAsyncEvalAgentResults,
		"a wait that returned a backgrounded eval job whose cells were handed it": appendWaitForEvalJob,
	};
	for (const [source, record] of Object.entries(evalEvidence)) {
		it(`does not relaunch a key-stranded subagent whose parent got its failure through ${source}`, async () => {
			// If this regresses, an eval path that handed the parent the failure is invisible to --restore,
			// and the parent gets that same result a second time.
			const { main, mainFile, cwd } = openParent();
			// The cell started the subagent as an agent() handle, whose record says the parent still owes its result.
			appendEvalAgentSpawn(main, "EvalHeld", "unsettled");
			await writeSubagent(mainFile, cwd, "EvalHeld", stranded, { normalExit: true });
			record(main, "EvalHeld");
			main.appendMessage(assistant({ content: [{ type: "text", text: "EvalHeld could not run." }] }));

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: [] });
			expect(followUp).not.toHaveBeenCalled();
		});
	}

	it("does not relaunch a key-stranded subagent when the parent moved to a branch before its eval result", async () => {
		// If this regresses, reading only direct task results misses the eval result on the branch the parent left,
		// treats its absence on the selected branch as permission, and relaunches work the parent left behind.
		const { main, mainFile, cwd } = openParent();
		const branchBeforeEval = main.getLeafId();
		if (!branchBeforeEval) throw new Error("Expected parent branch");
		appendEvalAgentResults(main, "BranchEval");
		main.branch(branchBeforeEval);
		main.appendMessage({ role: "user", content: "different work", timestamp: Date.now() });
		await writeSubagent(mainFile, cwd, "BranchEval", stranded, { normalExit: true });

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not relaunch a key-stranded subagent that no record names, outside a turn the process cut off", async () => {
		// A path that records no subagent ids (an eval workpool batch, `vibe_wait`) leaves nothing to read. That
		// absence is not evidence that the parent still waits, so --restore leaves the subagent.
		const { main, mainFile, cwd } = openParent();
		main.appendMessage(assistant({ content: [{ type: "text", text: "Done." }] }));
		await writeSubagent(mainFile, cwd, "UnknownPath", stranded, { normalExit: true });

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("relaunches a key-stranded background eval agent whose unsettled spawn record the parent still owes", async () => {
		const { main, mainFile, cwd } = openParent();
		appendEvalAgentSpawn(main, "EvalAgent", "unsettled");
		await writeSubagent(mainFile, cwd, "EvalAgent", stranded, { normalExit: true });

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["EvalAgent"] });
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "EvalAgent", restore: true });
	});

	it("does not relaunch a key-stranded background eval agent whose spawn record says delivered", async () => {
		// The session writes `delivered` before it queues the agent's async-result (agent-session-async-delivery
		// pins that order). If the process exits between the two, the record still keeps a second result from
		// reaching the parent.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		appendEvalAgentSpawn(main, "DeliveredAgent", "unsettled");
		await writeSubagent(mainFile, cwd, "DeliveredAgent", stranded, { normalExit: true });
		setSystemTime(new Date(start + 60_000));
		appendEvalAgentSpawn(main, "DeliveredAgent", "delivered");
		setSystemTime();

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("relaunches a background eval agent whose follow-up turn, asked after its result was delivered, ended without its key", async () => {
		// If this regresses, the `delivered` record of the agent's first turn reads as settling the turn its parent
		// messaged it for afterwards: the parent waits on that turn, and `--restore` never goes on with it.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		appendEvalAgentSpawn(main, "AgentFollowUp", "unsettled");
		const sub = await SessionManager.open(
			path.join(mainFile.slice(0, -6), "AgentFollowUp.jsonl"),
			undefined,
			undefined,
			{ initialCwd: cwd, parentSession: mainFile, suppressBreadcrumb: true },
		);
		sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: "AgentFollowUp task", tools: ["read", "yield"] });
		sub.appendMessage({ role: "user", content: "AgentFollowUp task", timestamp: Date.now() });
		sub.appendMessage(assistant({ content: [{ type: "text", text: "first part done" }] }));
		// Its result was delivered to the parent, which then messaged the kept-alive agent to go on.
		setSystemTime(new Date(start + 60_000));
		appendEvalAgentSpawn(main, "AgentFollowUp", "delivered");
		main.appendMessage(assistant({ content: [{ type: "text", text: "Asked AgentFollowUp for the rest." }] }));
		// The message woke the agent; that turn ended because its key could not be resolved.
		setSystemTime(new Date(start + 120_000));
		sub.appendCustomMessageEntry("irc:incoming", "Now do the rest.", true, {
			from: MAIN_AGENT_ID,
			message: "Now do the rest.",
		});
		sub.appendMessage(assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true }));
		sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		await sub.close();
		setSystemTime();

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["AgentFollowUp"] });
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "AgentFollowUp", restore: true });
	});

	it("does not relaunch a key-stranded spawn the task tool discarded", async () => {
		// If this regresses, a launch its call dropped keeps the spawn record its start wrote and no result names it:
		// `--restore` relaunches it, and the parent gets a result for a job its call never adopted.
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawnRecord(main, "Discarded");
		await writeSubagent(mainFile, cwd, "Discarded", stranded, { normalExit: true });
		main.appendCustomEntry("task_spawn", { id: "Discarded", discarded: true });

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("relaunches the subagent of a task call whose name an earlier one used, by the id the task tool allocated, after a hard kill", async () => {
		// If this regresses, a call that reused a name, or ran in a nested parent, is matched by its `name` argument
		// ("Worker") instead of the id its subagent ran under ("Worker-2", "Lead.Worker"): after a SIGKILL no result
		// names the run, and the subagent the parent still waits on is never relaunched. The task tool launched
		// each spawn while its call streamed, before the call's response was written, so only the spawn's record
		// places it in the call the process ended in.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		// An earlier call named "Worker" finished; the parent answered.
		appendTaskSpawnRecord(main, "Worker");
		appendTaskSpawn(main, "Worker");
		main.appendMessage(assistant({ content: [{ type: "text", text: "Worker finished." }] }));
		setSystemTime(new Date(start + 60_000));
		main.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
		// A later call used the name again, so the task tool allocated "Worker-2" while the call streamed. The
		// parent's subagent "Lead" was spawned the same way.
		setSystemTime(new Date(start + 61_000));
		appendTaskSpawnRecord(main, "Worker-2");
		appendTaskSpawnRecord(main, "Lead");
		await writeSubagent(mainFile, cwd, "Worker-2", stranded, { normalExit: true });
		// Lead made the same kind of call: in its own transcript the call named "Worker", and its spawn, launched
		// while that call streamed, ran as "Lead.Worker".
		const leadFile = await writeSubagent(mainFile, cwd, "Lead", [
			{ role: "user", content: "Lead task", timestamp: Date.now() },
		]);
		setSystemTime(new Date(start + 62_000));
		const lead = await SessionManager.open(leadFile, undefined, undefined, { suppressBreadcrumb: true });
		lead.appendCustomEntry("task_spawn", { id: "Lead.Worker" });
		await writeSubagent(leadFile, cwd, "Lead.Worker", stranded, { normalExit: true });
		// Both calls' responses were written; then the kill cut both parents off inside their calls.
		setSystemTime(new Date(start + 63_000));
		lead.appendMessage(
			assistant({
				content: [
					{
						type: "toolCall",
						id: "call_lead",
						name: "task",
						arguments: { agent: "task", name: "Worker", task: "y" },
					},
				],
				stopReason: "toolUse",
			}),
		);
		await lead.close();
		main.appendMessage(
			assistant({
				content: [
					{
						type: "toolCall",
						id: "call_again",
						name: "task",
						arguments: { agent: "task", name: "Worker", task: "x" },
					},
				],
				stopReason: "toolUse",
			}),
		);
		setSystemTime();

		const { outcome } = await restoreParent(main, mainFile);

		// Lead goes on with its own cut-off turn, and each stranded spawn goes on under the id it ran as.
		expect(outcome.subagents.sort()).toEqual(["Lead", "Lead.Worker", "Worker-2"]);
	});

	it("does not relaunch the subagent of a name used again after the parent's /clear (Scout, then Scout-2)", async () => {
		// If this regresses, the new conversation's `task {name: "Scout"}` call matches the old "Scout" by its name:
		// the held-result scan stops at the /clear, so the old Scout, whose failure the parent already answered, is
		// relaunched into the new conversation after any exit, a normal one included.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawnRecord(main, "Scout");
		await writeSubagent(mainFile, cwd, "Scout", stranded, { normalExit: true });
		const [call, failed] = parentTaskCall("Scout", "failed");
		main.appendMessage(call!);
		main.appendMessage(failed!);
		main.appendMessage(assistant({ content: [{ type: "text", text: "Scout could not run." }] }));
		setSystemTime(new Date(start + 60_000));
		main.appendResetBoundary();
		setSystemTime(new Date(start + 120_000));
		main.appendMessage({ role: "user", content: "scout again", timestamp: Date.now() });
		main.appendMessage(
			assistant({
				content: [
					{
						type: "toolCall",
						id: "call_scout_2",
						name: "task",
						arguments: { agent: "task", name: "Scout", task: "z" },
					},
				],
				stopReason: "toolUse",
			}),
		);
		// "Scout" was taken, so the task tool allocated "Scout-2"; it was stranded too, and the parent exited normally.
		appendTaskSpawnRecord(main, "Scout-2");
		await writeSubagent(mainFile, cwd, "Scout-2", stranded, { normalExit: true });
		main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		setSystemTime();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Scout-2"]);
	});

	it("relaunches an eval cell's tool.task subagent whose parent turn exit recovery closed as cut off", async () => {
		// If this regresses, the subagent the cell's `tool.task` spawned in the call the process ended in is not
		// relaunched: the cell's result never came back, and the task tool's spawn record alone names it.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		main.appendMessage(
			assistant({
				content: [
					{ type: "toolCall", id: "call_eval_cut", name: "eval", arguments: { language: "js", code: "…" } },
				],
				stopReason: "toolUse",
			}),
		);
		// The cell's `tool.task` ran the task tool, which records the id it allocates before the run starts.
		setSystemTime(new Date(start + 1_000));
		appendTaskSpawnRecord(main, "EvalCut");
		await writeSubagent(mainFile, cwd, "EvalCut", stranded, { normalExit: true });
		// Exit recovery paired the unfinished call with its result and closed the turn.
		setSystemTime(new Date(start + 2_000));
		main.appendMessage({
			role: "toolResult",
			toolCallId: "call_eval_cut",
			toolName: "eval",
			content: [{ type: "text", text: "interrupted" }],
			isError: true,
			timestamp: Date.now(),
		});
		closeInterruptedTurn(main);
		setSystemTime();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["EvalCut"]);
	});

	it("relaunches an eval cell's tool.task subagent after a hard kill, before any interrupted-turn record exists", async () => {
		// If this regresses, the parent's eval call has no result and no record closes its turn (SIGKILL, OOM), and
		// the spawn record the cell's `tool.task` wrote does not place the subagent in that call: the work its
		// parent still waits on is never relaunched.
		const { main, mainFile, cwd } = openParent();
		main.appendMessage(
			assistant({
				content: [
					{ type: "toolCall", id: "call_eval_kill", name: "eval", arguments: { language: "js", code: "…" } },
				],
				stopReason: "toolUse",
			}),
		);
		appendTaskSpawnRecord(main, "EvalCut");
		await writeSubagent(mainFile, cwd, "EvalCut", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["EvalCut"]);
	});

	// A subagent no record names anywhere: a work-pool worker a version that wrote no spawn record started, whose
	// result the pool took itself (the cell read it through the pool). Only the call the process ended in places
	// such a subagent in its parent's work: it began after that call started running.
	const laterCuts: Record<string, (main: SessionManager) => void> = {
		"a hard kill inside the parent's next call": main => {
			main.appendMessage(poolEvalCall("call_next"));
			markStarted(main, "call_next");
		},
		"a SIGTERM inside the parent's next call": main => {
			main.appendMessage(poolEvalCall("call_next"));
			markStarted(main, "call_next");
			appendSignalExit(main, ["call_next"]);
			main.appendMessage(abortedResult("call_next", "eval"));
			closeInterruptedTurn(main);
		},
		"a SIGTERM while the parent's next response streamed": main => {
			appendSignalExit(main, []);
			closeInterruptedTurn(main);
		},
	};
	for (const [cut, cutOff] of Object.entries(laterCuts)) {
		it(`does not relaunch a work-pool worker whose failure an earlier eval call of the turn handed the parent, after ${cut}`, async () => {
			// If this regresses, the cut-off counts from the turn's input: the worker the earlier call's cell already
			// got the failure of reads as work of the call the process ended in, and `--restore` relaunches it, so the
			// parent gets its result a second time.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			setSystemTime(new Date(start + 1_000));
			main.appendMessage(poolEvalCall("call_pool"));
			markStarted(main, "call_pool");
			// The pool's worker started inside that call, and its turn ended on the missing key.
			setSystemTime(new Date(start + 2_000));
			await writeSubagent(mainFile, cwd, "Pool-1", stranded, { normalExit: true });
			// The cell got the failure through the pool; its result names no subagent.
			setSystemTime(new Date(start + 3_000));
			main.appendMessage({
				role: "toolResult",
				toolCallId: "call_pool",
				toolName: "eval",
				content: [{ type: "text", text: "Pool-1: No API key for provider: anthropic" }],
				details: { language: "js", languages: ["js"], cells: [] },
				isError: false,
				timestamp: Date.now(),
			});
			setSystemTime(new Date(start + 4_000));
			cutOff(main);
			setSystemTime();

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: [] });
			expect(followUp).not.toHaveBeenCalled();
		});
	}

	const poolCallCuts: Record<string, (main: SessionManager) => void> = {
		"a hard kill": () => {},
		"a SIGTERM": main => {
			appendSignalExit(main, ["call_pool"]);
			main.appendMessage(abortedResult("call_pool", "eval"));
			closeInterruptedTurn(main);
		},
	};
	for (const [cut, cutOff] of Object.entries(poolCallCuts)) {
		it(`relaunches a work-pool worker that began inside the eval call ${cut} ended`, async () => {
			// If this regresses, the call the process ended in no longer places the workers its cell started in the
			// parent's work, and the pool's work the parent still waits on is lost.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			setSystemTime(new Date(start + 1_000));
			main.appendMessage(poolEvalCall("call_pool"));
			markStarted(main, "call_pool");
			setSystemTime(new Date(start + 2_000));
			await writeSubagent(mainFile, cwd, "Pool-2", stranded, { normalExit: true });
			setSystemTime(new Date(start + 3_000));
			cutOff(main);
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(["Pool-2"]);
		});
	}

	it("does not relaunch a work-pool worker of a call that ended before the call of the same response the process ended in", async () => {
		// If this regresses, the cut-off counts from the response that made both calls: the worker whose failure
		// the first call's cell got, before the second call started, reads as work of the call SIGTERM ended.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		setSystemTime(new Date(start + 1_000));
		const response = poolEvalCall("call_first");
		response.content.push({
			type: "toolCall",
			id: "call_second",
			name: "eval",
			arguments: { language: "js", code: "…" },
		});
		main.appendMessage(response);
		markStarted(main, "call_first");
		setSystemTime(new Date(start + 2_000));
		await writeSubagent(mainFile, cwd, "Pool-1", stranded, { normalExit: true });
		// Eval calls run one at a time: the first one's result is written before the second starts.
		setSystemTime(new Date(start + 3_000));
		main.appendMessage({
			role: "toolResult",
			toolCallId: "call_first",
			toolName: "eval",
			content: [{ type: "text", text: "Pool-1: No API key for provider: anthropic" }],
			details: { language: "js", languages: ["js"], cells: [] },
			isError: false,
			timestamp: Date.now(),
		});
		setSystemTime(new Date(start + 4_000));
		markStarted(main, "call_second");
		setSystemTime(new Date(start + 5_000));
		appendSignalExit(main, ["call_second"]);
		main.appendMessage(abortedResult("call_second", "eval"));
		closeInterruptedTurn(main);
		setSystemTime();

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("relaunches a subagent whose failure the cell got in the eval call the process exit cut off, the parent taking no turn after it", async () => {
		// If this regresses, the aborted eval result the agent loop writes as the process goes away names what the
		// cell's bridged calls had handed it, and that reads as a result the parent holds: the parent's model never
		// read it, and `--restore` leaves the subagent's turn unfinished.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		setSystemTime(new Date(start + 1_000));
		main.appendMessage(poolEvalCall("call_pool"));
		markStarted(main, "call_pool");
		setSystemTime(new Date(start + 2_000));
		await writeSubagent(mainFile, cwd, "Pool-1", stranded, { normalExit: true });
		// The cell's bridged `wait` got the worker's failure; then SIGTERM ended the cell.
		setSystemTime(new Date(start + 3_000));
		appendSignalExit(main, ["call_pool"]);
		main.appendMessage({
			...abortedResult("call_pool", "eval"),
			details: { language: "js", languages: ["js"], cells: [], agentResults: [{ id: "Pool-1" }] },
		});
		closeInterruptedTurn(main);
		setSystemTime();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Pool-1"]);
	});

	for (const [where, startedAt] of [
		["the earlier call, which had finished", 2_000],
		["the call the hard kill ended", 5_000],
	] as const) {
		it(`on a second --restore after a hard kill, judges a subagent no record names that began in ${where} as the first did`, async () => {
			// If this regresses, the second `--restore` finds no exit record before the interrupted-turn record the first
			// one wrote, and reads every call of the response as cut off: the window then opens at the first, finished
			// call, and a worker whose failure that call already handed the parent is relaunched.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			setSystemTime(new Date(start + 1_000));
			const response = poolEvalCall("call_first");
			response.content.push({
				type: "toolCall",
				id: "call_second",
				name: "eval",
				arguments: { language: "js", code: "…" },
			});
			main.appendMessage(response);
			markStarted(main, "call_first");
			setSystemTime(new Date(start + 3_000));
			main.appendMessage({
				role: "toolResult",
				toolCallId: "call_first",
				toolName: "eval",
				content: [{ type: "text", text: "Pool-1: No API key for provider: anthropic" }],
				details: { language: "js", languages: ["js"], cells: [] },
				isError: false,
				timestamp: Date.now(),
			});
			setSystemTime(new Date(start + 4_000));
			markStarted(main, "call_second");
			setSystemTime(new Date(start + startedAt));
			await writeSubagent(mainFile, cwd, "Pool-1", stranded, { normalExit: true });
			// A hard kill: no exit record. The first `--restore`'s recovery paired the unfinished call with its result
			// and closed the turn; the turn it went on with ended on the key again, and that process exited normally.
			setSystemTime(new Date(start + 10_000));
			for (const result of createInterruptedToolResults(main.getBranch())) main.appendMessage(result);
			const record = createInterruptedTurnAbortMessage(main.getBranch(), undefined, { assumeExit: true });
			if (!record) throw new Error("Expected the parent's turn to read as cut off");
			main.appendMessage(record);
			setSystemTime(new Date(start + 11_000));
			main.appendMessage(assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true }));
			main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "dispose",
				kind: "normal",
				recordedAt: new Date().toISOString(),
			});
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(startedAt === 5_000 ? ["Pool-1"] : []);
		});
	}

	it("relaunches a key-stranded spawn under an id a later process allocated again after a discarded launch", async () => {
		// If this regresses, the discard record of an earlier launch, which wrote no transcript and so freed its id,
		// removes the later spawn under that id from the parent's work: the run the parent waits on is never relaunched.
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawnRecord(main, "Reused");
		main.appendCustomEntry("task_spawn", { id: "Reused", discarded: true });
		main.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
		appendTaskSpawnRecord(main, "Reused");
		await writeSubagent(mainFile, cwd, "Reused", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Reused"]);
	});

	it("relaunches a key-stranded eval agent() a later process spawned under the id of a discarded task launch", async () => {
		// If this regresses, only `task_spawn` records decide an id's latest spawn: the older discard of a streamed
		// launch that wrote no transcript hides the `agent()` that a resumed process later gave the same id, and the
		// run the parent waits on is never relaunched.
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawnRecord(main, "Reagent");
		main.appendCustomEntry("task_spawn", { id: "Reagent", discarded: true });
		main.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
		appendEvalAgentSpawn(main, "Reagent", "unsettled");
		await writeSubagent(mainFile, cwd, "Reagent", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Reagent"]);
	});

	// A work pool records each worker before its run starts (`task_spawn`), and its handovers settle it: a `peek()`
	// the cell made, which the eval result records with when it was handed over, or the pool's own job.
	const poolHandovers: Record<string, { agentResults?: Array<{ id: string; at?: number }>; relaunched: boolean }> = {
		"the cell pushed its item and returned, and the next cell still waited on the worker": { relaunched: true },
		"the cell was handed the worker's failure through peek()": {
			agentResults: [{ id: "Pool-3", at: Date.parse("2026-11-17T12:00:02.500Z") }],
			relaunched: false,
		},
	};
	for (const [handover, { agentResults, relaunched }] of Object.entries(poolHandovers)) {
		it(`${relaunched ? "relaunches" : "does not relaunch"} a work-pool worker after a hard kill when ${handover}`, async () => {
			// If this regresses, a pool worker that only the call before the cut-off one started is judged by the
			// cut-off window alone: one the parent still waits on is never relaunched.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			setSystemTime(new Date(start + 1_000));
			main.appendMessage(poolEvalCall("call_push"));
			markStarted(main, "call_push");
			setSystemTime(new Date(start + 2_000));
			appendTaskSpawnRecord(main, "Pool-3");
			await writeSubagent(mainFile, cwd, "Pool-3", stranded, { normalExit: true });
			setSystemTime(new Date(start + 3_000));
			main.appendMessage({
				role: "toolResult",
				toolCallId: "call_push",
				toolName: "eval",
				content: [{ type: "text", text: "pushed" }],
				details: { language: "js", languages: ["js"], cells: [], ...(agentResults ? { agentResults } : {}) },
				isError: false,
				timestamp: Date.now(),
			});
			setSystemTime(new Date(start + 4_000));
			main.appendMessage(poolEvalCall("call_wait"));
			markStarted(main, "call_wait");
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(relaunched ? ["Pool-3"] : []);
		});
	}

	it("relaunches a subagent whose turn began after the cell was handed its previous result, though the eval result was written later", async () => {
		// If this regresses, a handover is dated by the eval result, written when the cell ends: a kept-alive
		// subagent (a pool's next batch, a message from the cell) that began a new turn after the handover but
		// before the cell ended reads as settled, and the turn its parent waits on is never relaunched.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawnRecord(main, "Kept");
		const sub = await SessionManager.open(path.join(mainFile.slice(0, -6), "Kept.jsonl"), undefined, undefined, {
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		});
		sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: "Kept task", tools: ["read", "yield"] });
		sub.appendMessage({ role: "user", content: "Kept task", timestamp: Date.now() });
		sub.appendMessage(assistant({ content: [{ type: "text", text: "first batch done" }] }));
		// The cell was handed that result at 2 s; the subagent's next turn began at 3 s and ended on its key.
		setSystemTime(new Date(start + 3_000));
		sub.appendCustomMessageEntry("irc:incoming", "Next batch.", true, {
			from: MAIN_AGENT_ID,
			message: "Next batch.",
		});
		sub.appendMessage(assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true }));
		sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		await sub.close();
		// The cell ended, and its result was written, at 5 s.
		setSystemTime(new Date(start + 5_000));
		main.appendMessage(
			assistant({
				content: [{ type: "toolCall", id: "call_kept", name: "eval", arguments: { language: "js", code: "…" } }],
				stopReason: "toolUse",
			}),
		);
		main.appendMessage({
			role: "toolResult",
			toolCallId: "call_kept",
			toolName: "eval",
			content: [{ type: "text", text: "done" }],
			details: { language: "js", languages: ["js"], cells: [], agentResults: [{ id: "Kept", at: start + 2_000 }] },
			isError: false,
			timestamp: Date.now(),
		});
		main.appendMessage(assistant({ content: [{ type: "text", text: "Waiting on Kept." }] }));
		setSystemTime();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Kept"]);
	});

	it("never relaunches a key-stranded vibe worker that interactive mode rehydrated, even one the vibe_wait a hard kill ended waited on", async () => {
		// Interactive mode rehydrates vibe workers as subagent refs before `--restore` runs, so the persisted roster
		// keeps them. If this regresses, `--restore` runs the vibe worker's turn as a task job beside vibe mode's own
		// record of it.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		setSystemTime(new Date(start + 1_000));
		main.appendMessage(
			assistant({
				content: [
					{ type: "toolCall", id: "call_spawn", name: "vibe_spawn", arguments: { cli: "fast", prompt: "x" } },
				],
				stopReason: "toolUse",
			}),
		);
		markStarted(main, "call_spawn");
		main.appendCustomEntry("vibe-session-lifecycle", {
			version: 1,
			id: "Vibe-1",
			ownerId: MAIN_AGENT_ID,
			parentSessionId: main.getSessionId(),
			action: "spawn",
			cli: "fast",
			agent: VIBE_CLI_AGENT.fast,
			childSessionFile: "Vibe-1.jsonl",
			createdAt: Date.now(),
		});
		setSystemTime(new Date(start + 2_000));
		main.appendMessage({
			role: "toolResult",
			toolCallId: "call_spawn",
			toolName: "vibe_spawn",
			content: [{ type: "text", text: "Spawned Vibe-1." }],
			isError: false,
			timestamp: Date.now(),
		});
		setSystemTime(new Date(start + 3_000));
		main.appendMessage(
			assistant({
				content: [{ type: "toolCall", id: "call_vibe_wait", name: "vibe_wait", arguments: {} }],
				stopReason: "toolUse",
			}),
		);
		markStarted(main, "call_vibe_wait");
		main.appendCustomEntry("vibe-session-lifecycle", {
			version: 1,
			id: "Vibe-1",
			ownerId: MAIN_AGENT_ID,
			parentSessionId: main.getSessionId(),
			action: "turn-started",
			turn: 1,
		});
		// The worker's transcript begins inside the cut-off call's window, so only vibe mode's claim keeps it out.
		setSystemTime(new Date(start + 4_000));
		await writeSubagent(mainFile, cwd, "Vibe-1", stranded, { normalExit: true });
		setSystemTime();
		// Interactive mode's start-up, before `--restore`: vibe mode registers its resumable worker.
		const rehydrated = await VibeSessionRegistry.global().rehydrate({
			getSessionId: () => main.getSessionId(),
			getSessionFile: () => mainFile,
			sessionManager: main as unknown as ToolSession["sessionManager"],
			settings: Settings.isolated(),
		});
		expect(rehydrated).toBe(1);
		expect(AgentRegistry.global().get("Vibe-1")).toMatchObject({ kind: "sub", parentId: MAIN_AGENT_ID });

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual([]);
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not relaunch a work-pool worker of a settled pool the parent killed, whose kill result handed over the pool's report", async () => {
		// If this regresses, `--restore` reads job reports only from `wait` results and async deliveries: killing a pool
		// that had already drained consumes its result, so no delivery follows, and each key-stranded worker whose
		// failure the kill result showed the parent runs again.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const { main, mainFile, cwd } = openParent();
		setSystemTime(new Date(start + 1_000));
		main.appendMessage(poolEvalCall("call_push"));
		markStarted(main, "call_push");
		setSystemTime(new Date(start + 2_000));
		appendTaskSpawnRecord(main, "Pool-K");
		await writeSubagent(mainFile, cwd, "Pool-K", stranded, { normalExit: true });
		main.appendMessage({
			role: "toolResult",
			toolCallId: "call_push",
			toolName: "eval",
			content: [{ type: "text", text: "pushed" }],
			details: { language: "js", languages: ["js"], cells: [] },
			isError: false,
			timestamp: Date.now(),
		});
		// The pool drained, and the parent killed it before its async result arrived: the real kill result.
		setSystemTime(new Date(start + 3_000));
		const poolManager = new AsyncJobManager({ onJobComplete: () => {} });
		const pool = poolManager.register(
			"task",
			"notes",
			async ({ reportProgress }) => {
				await reportProgress("drained", { agentResults: [{ id: "Pool-K", at: Date.now() }] });
				return "Pool `notes` completed";
			},
			{ id: "notes", ownerId: MAIN_AGENT_ID },
		);
		await poolManager.getJob(pool)?.promise;
		const kill = await executeCancel(
			{ asyncJobManager: poolManager, getAgentId: () => MAIN_AGENT_ID } as unknown as ToolSession,
			poolManager,
			MAIN_AGENT_ID,
			[pool],
		);
		await poolManager.dispose({ timeoutMs: 1000 });
		main.appendMessage(
			assistant({
				content: [
					{
						type: "toolCall",
						id: "call_kill",
						name: "write",
						arguments: { path: "proc://notes/kill", content: "" },
					},
				],
				stopReason: "toolUse",
			}),
		);
		main.appendMessage({
			role: "toolResult",
			toolCallId: "call_kill",
			toolName: "write",
			content: kill.content,
			details: { proc: kill.details, touchesNoFiles: true },
			isError: false,
			timestamp: Date.now(),
		});
		main.appendMessage(assistant({ content: [{ type: "text", text: "Stopped the pool; Pool-K had no key." }] }));
		setSystemTime();

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(kill.details?.jobs?.[0]).toMatchObject({
			id: "notes",
			agentResults: [{ id: "Pool-K", at: start + 3_000 }],
		});
		expect(outcome.subagents).toEqual([]);
		expect(followUp).not.toHaveBeenCalled();
	});
});
