import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
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
import { recordEvalAgentJobs, recordHandovers } from "@oh-my-pi/pi-coding-agent/eval/agent-job-records";
import { EVAL_STATE_CONTEXT_TYPE } from "@oh-my-pi/pi-coding-agent/eval/state";
import {
	createInterruptedTurnAbortMessage,
	restoreSkippedCallReason,
	type RestoreSkippedCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { GENERIC_ABORT_SENTINEL, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { TASK_LAUNCH_DISCARDED_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
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

/**
 * Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract:
 * `spawnCallId` names the parent's call the spawn was requested under.
 */
async function writeSubagent(
	mainFile: string,
	cwd: string,
	id: string,
	messages: Message[],
	options?: { agent?: string; normalExit?: boolean; spawnCallId?: string },
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
		spawnCallId: options?.spawnCallId,
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

/** The key a skip result's details carry on disk (`RESTORE_SKIPPED_CALL_DETAIL`), as a transcript holds it. */
const SKIP_FLAG = "restoreSkippedCall";

/** When subagent FollowedUp's first turn ran, in the follow-up cases. */
const FOLLOW_UP_START = Date.parse("2026-11-17T12:00:00.000Z");

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

/** A bridged tool result in the parent transcript, with its eval-held agent records when it has them. */
function appendParentToolResult(main: SessionManager, toolName: string, details: unknown): void {
	const toolCallId = `call_${toolName}_${crypto.randomUUID()}`;
	main.appendMessage(
		assistant({
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
			stopReason: "toolUse",
		}),
	);
	main.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: `${toolName} returned.` }],
		details,
		isError: false,
		timestamp: Date.now(),
	});
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
		"Streamed",
		"Spawned",
		"PoolWorker",
		"Replaced",
		"Vibe-1",
		"Reused",
	];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;
	/**
	 * The turn {@link keyUnresolvedTurn} builds, built once for the file: building it runs the provider's
	 * `!command` key in a supervised child process (`runShellCommand`), whose start can take seconds on a loaded
	 * machine, past a case's default 5 s timeout. The hook's own timeout covers the command's 10 s bound.
	 */
	let keyUnresolvedMessages: Message[] = [];
	beforeAll(async () => {
		const dir = TempDir.createSync("@pi-restore-key-unresolved-turn-");
		try {
			keyUnresolvedMessages = await keyUnresolvedTurn(dir.path());
		} finally {
			dir.removeSync();
		}
	}, 30_000);

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

	/**
	 * Restores the parent session `main` in a new process, as its last one left it: what went on, and
	 * the parent's own resumed turn, called with the cut-off calls that started relaunched subagents.
	 */
	async function restoreParent(main: SessionManager, mainFile: string) {
		const entries = main.getEntries();
		const leafId = main.getLeafId();
		await main.close();
		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		const followUp = vi
			.spyOn(executorModule, "runSubagentFollowUpTurn")
			.mockImplementation(async options => subagentResult(options.id));
		const restoreTurn = vi.fn(async (_options: RestoreSkippedCalls) => false);
		const outcome = await restoreSession({
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => entries, getLeafId: () => leafId },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: restoreTurn,
		} as unknown as AgentSession);
		for (const id of outcome.subagents) await manager.getJob(id)?.promise;
		return { outcome, followUp, restoreTurn };
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

	it("row 8: relaunches a subagent whose turn ended because its key could not be resolved, even after a normal exit", async () => {
		// If this regresses, the stranded subagent is never relaunched: its failed turn reads as final.
		tempDir = TempDir.createSync("@pi-restore-key-unresolved-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		const mainEntries = main.getEntries();
		const mainLeafId = main.getLeafId();
		await main.close();
		// The worker's process exited normally on the failed turn.
		await writeSubagent(mainFile, cwd, "Stranded", keyUnresolvedMessages, { normalExit: true });
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

	it("row 8: judges each subagent by the branch its transcript selects, not by entries on other branches", async () => {
		// If this regresses, a turn on an abandoned branch or behind a `/clear` is relaunched, or the selected
		// branch's key-unresolved turn is not.
		tempDir = TempDir.createSync("@pi-restore-branches-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
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

	it("relaunches a subagent of the parent's current conversation, not one of a branch it left or from before its /clear", async () => {
		// If this regresses, `--restore` relaunches a subagent of work its parent left behind, and the parent
		// receives a result for a job its current conversation never started.
		tempDir = TempDir.createSync("@pi-restore-parent-conversation-");
		const cwd = tempDir.path();
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		// No `task` result names "Older": the parent's process ended inside the call that spawned it, before the /clear.
		await writeSubagent(mainFile, cwd, "Older", cutOff);
		setSystemTime(new Date(start + 60_000));
		main.appendResetBoundary();
		setSystemTime(new Date(start + 120_000));
		const prompt = main.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
		// The parent spawned "Left", then went back to its prompt and went on another way.
		appendTaskSpawn(main, "Left");
		await writeSubagent(mainFile, cwd, "Left", cutOff);
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
		await writeSubagent(mainFile, cwd, "Current", cutOff);
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

	it("does not relaunch a subagent stranded without its key when no parent record says it still waits", async () => {
		// If this regresses, `--restore` treats an absent result as an outstanding wait and sends a
		// second result to a parent that never shows that it waits.
		const { main, mainFile, cwd } = openParent();
		await writeSubagent(mainFile, cwd, "Unrecorded", stranded, { normalExit: true });
		main.appendMessage(assistant({ content: [{ type: "text", text: "Done without it." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	/** Sets the system clock to `start`, and returns a step that moves it one second on. */
	function clockFrom(start: number): () => void {
		let now = start;
		setSystemTime(new Date(now));
		return () => setSystemTime(new Date((now += 1_000)));
	}

	/** The parent's assistant message that calls `toolName` (id `callId`), and nothing else. */
	function toolCallMessage(callId: string, toolName: string): AssistantMessage {
		return assistant({
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: {} }],
			stopReason: "toolUse",
		});
	}

	/** The result of the parent's call `callId` to `toolName`, with `details`. */
	function toolResultMessage(callId: string, toolName: string, details: unknown, isError = false): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: `${toolName} returned.` }],
			details,
			isError,
			timestamp: Date.now(),
		};
	}

	it("does not relaunch a key-stranded subagent of a backgrounded eval cell that no parent record names", async () => {
		// A backgrounded cell's own result reaches the parent as a job delivery, which names no subagent the cell ran.
		const { main, mainFile, cwd } = openParent();
		appendParentToolResult(main, "eval", { async: { state: "running", jobId: "eval-job", type: "eval" } });
		await writeSubagent(mainFile, cwd, "Background", stranded, { normalExit: true });
		main.appendMessage(assistant({ content: [{ type: "text", text: "Going on." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	for (const [source, toolName, details] of [
		[
			"an eval cell's work pool, whose result names no worker",
			"eval",
			{
				language: "js",
				cells: [{ code: "await pool.run(items)", language: "js", output: "Worker failed.", status: "complete" }],
			},
		],
		[
			"vibe_wait, whose settled list restore does not read",
			"vibe_wait",
			{
				op: "wait",
				screens: [],
				wait: {
					settled: [{ id: "Worker", jobId: "vibe-Worker", status: "failed" }],
					stillRunning: [],
					timedOut: false,
				},
			},
		],
	] as const) {
		it(`does not relaunch a worker whose failure the parent got from ${source}, when a later call of that turn is cut off: the window alone decides`, async () => {
			// If this regresses, the cut-off window opens at the turn's input instead of at the call the process went away
			// inside: a worker whose failure an earlier call of the same turn returned is relaunched, and the parent gets
			// its result a second time.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			tick();
			main.appendMessage(toolCallMessage("call_batch", toolName));
			tick();
			await writeSubagent(mainFile, cwd, "Worker", stranded, { normalExit: true });
			tick();
			main.appendMessage(toolResultMessage("call_batch", toolName, details));
			tick();
			// The turn's next call, which the parent's process went away inside.
			main.appendMessage(toolCallMessage("call_read", "read"));

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: [] });
			expect(followUp).not.toHaveBeenCalled();
		});
	}

	it("does not relaunch a key-stranded subagent after its parent moved off the branch that ran eval", async () => {
		// If this regresses, restore reads the branch the parent left: its `owed` record reads as a wait, and the
		// parent receives a result for a job its conversation never started.
		const { main, mainFile, cwd } = openParent();
		const beforeEval = main.getLeafId();
		if (!beforeEval) throw new Error("Expected the initial parent branch entry");
		appendAgentJobRecord(main, "Moved", "owed");
		appendParentToolResult(main, "eval", {});
		await writeSubagent(mainFile, cwd, "Moved", stranded, { normalExit: true });
		main.branch(beforeEval);
		main.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() });
		main.appendMessage(assistant({ content: [{ type: "text", text: "Answered on the other branch." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not relaunch a spawn of a reply the parent replaced, though the new reply's cut-off turn keeps the same input", async () => {
		// If this regresses, the cut-off window opens at the input both branches share, before the replaced reply's
		// spawns: a subagent of a reply the parent abandoned is relaunched for a turn that never started it.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const input = main.getLeafId();
		if (!input) throw new Error("Expected the parent's input entry");
		tick();
		main.appendMessage(toolCallMessage("call_eval_replaced", "eval"));
		tick();
		await writeSubagent(mainFile, cwd, "Replaced", stranded, { normalExit: true });
		tick();
		// The reply was regenerated from the same input; the process went away inside the new reply's call.
		main.branch(input);
		main.appendMessage(toolCallMessage("call_read_new", "read"));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("relaunches only the spawn of the reply that streamed after the parent went back to the input, not one of the reply it replaced", async () => {
		// If this regresses, the window of the reply that streamed when the process went away opens before the parent
		// went back to the input: a spawn the replaced reply made after its last saved entry is relaunched for a turn
		// that never started it; or the streaming reply's own spawn, which no record names yet, is not relaunched.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const input = main.getLeafId();
		if (!input) throw new Error("Expected the parent's input entry");
		tick();
		main.appendMessage(toolCallMessage("call_eval_replaced", "eval"));
		tick();
		// The replaced reply's cell spawned this subagent after the reply's last saved entry; nothing names it.
		await writeSubagent(mainFile, cwd, "Replaced", stranded, { normalExit: true });
		tick();
		// The parent went back to the input; selecting the branch saved a summary of the one it left.
		main.branchWithSummary(input, "The replaced reply ran a cell.");
		tick();
		// The new reply launched a subagent while it streamed, before it was saved; then the process went away.
		await writeSubagent(mainFile, cwd, "Streamed", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Streamed"] });
	});

	it("relaunches neither spawn when nothing the selected branch wrote places the parent's return to the input", async () => {
		// If this regresses, the window opens at the replaced reply's last saved entry, and the replaced reply's spawn
		// made after it is relaunched, though nothing tells it from a spawn of the new reply.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const input = main.getLeafId();
		if (!input) throw new Error("Expected the parent's input entry");
		tick();
		main.appendMessage(toolCallMessage("call_eval_replaced", "eval"));
		tick();
		await writeSubagent(mainFile, cwd, "Replaced", stranded, { normalExit: true });
		tick();
		main.branch(input);
		await writeSubagent(mainFile, cwd, "Streamed", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
	});

	it("does not relaunch a key-stranded subagent of a turn its parent ended by an abort that gave a reason", async () => {
		// If this regresses, an abort with a caller's own reason reads as a process exit here though it reads as a turn
		// the parent took everywhere else: the subagent of a turn that lived on and ended is relaunched.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		main.appendMessage(toolCallMessage("call_eval_reason", "eval"));
		tick();
		await writeSubagent(mainFile, cwd, "Reasoned", stranded, { normalExit: true });
		tick();
		main.appendMessage(toolResultMessage("call_eval_reason", "eval", {}));
		tick();
		main.appendMessage(assistant({ stopReason: "aborted", errorMessage: "Superseded by the owner's next task" }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not relaunch a later turn's unrecorded subagent because an earlier turn left a task call unanswered", async () => {
		// If this regresses, a `task` call a hard kill left without a result keeps the whole conversation waiting: every
		// unrecorded subagent of every later turn is relaunched, though those turns ended.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		main.appendMessage(toolCallMessage("call_old_task", "task"));
		tick();
		// After the kill the user went on (`omp -c` repairs nothing without an exit record).
		main.appendMessage({ role: "user", content: "go on", timestamp: Date.now() });
		tick();
		main.appendMessage(toolCallMessage("call_eval_later", "eval"));
		tick();
		await writeSubagent(mainFile, cwd, "Later", stranded, { normalExit: true });
		tick();
		main.appendMessage(toolResultMessage("call_eval_later", "eval", {}));
		main.appendMessage(assistant({ content: [{ type: "text", text: "Done." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	for (const [end, endRecords] of Object.entries({
		"its terminal yield's result": () => [] as Message[],
		"the abort without a reason the executor stops its session with after that yield": () => [
			assistant({
				stopReason: "aborted",
				errorMessage: GENERIC_ABORT_SENTINEL,
				errorId: AIError.create(AIError.Flag.Abort),
			}),
		],
	})) {
		it(`does not relaunch an unrecorded subagent of a parent subagent whose run ended with ${end}`, async () => {
			// If this regresses, a parent subagent's finished run reads as a turn its process cut off: the subagent it
			// left without a record, spawned as its yield reply began, is relaunched, and its result goes to a parent
			// whose run is over. Without the yield check the window would open at that reply and take it in.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			appendTaskSpawn(main, "Outer");
			const outerFile = path.join(mainFile.slice(0, -6), "Outer.jsonl");
			const outer = await SessionManager.open(outerFile, undefined, undefined, {
				initialCwd: cwd,
				parentSession: mainFile,
				suppressBreadcrumb: true,
			});
			outer.appendSessionInit({ systemPrompt: ["sub prompt"], task: "Outer task", tools: ["eval", "yield"] });
			outer.appendMessage({ role: "user", content: "Outer task", timestamp: Date.now() });
			tick();
			outer.appendMessage(toolCallMessage("call_outer_eval", "eval"));
			tick();
			outer.appendMessage(toolResultMessage("call_outer_eval", "eval", {}));
			tick();
			outer.appendMessage(toolCallMessage("call_outer_yield", "yield"));
			await writeSubagent(outerFile, cwd, "Inner", stranded, { normalExit: true });
			outer.appendMessage(toolResultMessage("call_outer_yield", "yield", { data: "done", status: "success" }));
			for (const message of endRecords()) outer.appendMessage(message);
			await outer.close();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).not.toContain("Inner");
		});
	}

	it("relaunches an unrecorded subagent of a parent subagent whose terminal yield came while its backgrounded cell still ran", async () => {
		// If this regresses, restore reads that yield as the end of the run, though the executor parks the run there
		// until the cell's job settles: the cell's subagent, which no record names, is left while its parent waits.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		appendTaskSpawn(main, "Outer");
		const outerFile = path.join(mainFile.slice(0, -6), "Outer.jsonl");
		const outer = await SessionManager.open(outerFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		});
		outer.appendSessionInit({ systemPrompt: ["sub prompt"], task: "Outer task", tools: ["eval", "yield"] });
		outer.appendMessage({ role: "user", content: "Outer task", timestamp: Date.now() });
		tick();
		outer.appendMessage(toolCallMessage("call_outer_eval", "eval"));
		tick();
		outer.appendMessage(
			toolResultMessage("call_outer_eval", "eval", { async: { state: "running", jobId: "bg_cell", type: "eval" } }),
		);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_yield", "yield"));
		outer.appendMessage(toolResultMessage("call_outer_yield", "yield", { data: "done", status: "success" }));
		tick();
		// The backgrounded cell spawned it after the yield; its job never delivered before the process went away.
		await writeSubagent(outerFile, cwd, "Inner", stranded, { normalExit: true });
		await outer.close();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toContain("Inner");
	});

	/** Opens parent subagent Outer under `main`, its task prompt written. */
	async function openOuter(main: SessionManager, mainFile: string, cwd: string) {
		appendTaskSpawn(main, "Outer");
		const outerFile = path.join(mainFile.slice(0, -6), "Outer.jsonl");
		const outer = await SessionManager.open(outerFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		});
		outer.appendSessionInit({ systemPrompt: ["sub prompt"], task: "Outer task", tools: ["eval", "yield"] });
		outer.appendMessage({ role: "user", content: "Outer task", timestamp: Date.now() });
		return { outer, outerFile };
	}

	it("leaves a paused yield's grandchild when the executor's abort parked its parent, which restore does not go on with", async () => {
		// If this regresses, the subagent the parked run's backgrounded cell spawned is relaunched with that run as its
		// owner, but the run is not continued (its tail is the executor's abort), so the relaunched result reaches no
		// one: the work runs again for nothing.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const { outer, outerFile } = await openOuter(main, mainFile, cwd);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_eval", "eval"));
		tick();
		outer.appendMessage(
			toolResultMessage("call_outer_eval", "eval", { async: { state: "running", jobId: "bg_cell", type: "eval" } }),
		);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_yield", "yield"));
		outer.appendMessage(toolResultMessage("call_outer_yield", "yield", { data: "done", status: "success" }));
		// The executor parks the run: it stops the session with an abort that gives no reason.
		outer.appendMessage(
			assistant({
				stopReason: "aborted",
				errorMessage: GENERIC_ABORT_SENTINEL,
				errorId: AIError.create(AIError.Flag.Abort),
			}),
		);
		tick();
		await writeSubagent(outerFile, cwd, "Inner", stranded, { normalExit: true });
		await outer.close();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).not.toContain("Outer");
		expect(outcome.subagents).not.toContain("Inner");
	});

	it("relaunches a paused yield's backgrounded work's subagent but not the worker of a finished call that handed its failure over", async () => {
		// If this regresses, the paused yield's window opens at the oldest pending job and takes in a work-pool worker
		// whose failure a later foreground cell already got (its pool result names no one): it is relaunched, and the
		// parent gets its result a second time. The backgrounded cell's own subagent, spawned after the yield, stays
		// the run's.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const { outer, outerFile } = await openOuter(main, mainFile, cwd);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_bg", "eval"));
		tick();
		outer.appendMessage(
			toolResultMessage("call_outer_bg", "eval", { async: { state: "running", jobId: "bg_cell", type: "eval" } }),
		);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_pool", "eval"));
		tick();
		await writeSubagent(outerFile, cwd, "PoolWorker", stranded, { normalExit: true });
		tick();
		outer.appendMessage(
			toolResultMessage("call_outer_pool", "eval", {
				language: "js",
				cells: [
					{ code: "await pool.run(items)", language: "js", output: "PoolWorker failed.", status: "complete" },
				],
			}),
		);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_yield", "yield"));
		outer.appendMessage(toolResultMessage("call_outer_yield", "yield", { data: "done", status: "success" }));
		tick();
		await writeSubagent(outerFile, cwd, "Inner", stranded, { normalExit: true });
		await outer.close();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toContain("Inner");
		expect(outcome.subagents).not.toContain("PoolWorker");
	});

	it("relaunches a backgrounded cell's subagent spawned while a later call ran, and leaves that call's own worker", async () => {
		// If this regresses, the paused yield's window leaves out every spawn inside a finished call's run, whoever
		// made it: the backgrounded cell's subagent, whose transcript began while the later call ran, is left though
		// the run still waits on the cell; or that call's own worker, whose failure it handed over, is relaunched.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const { outer, outerFile } = await openOuter(main, mainFile, cwd);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_bg", "eval"));
		tick();
		outer.appendMessage(
			toolResultMessage("call_outer_bg", "eval", { async: { state: "running", jobId: "bg_cell", type: "eval" } }),
		);
		tick();
		outer.appendMessage(toolCallMessage("call_outer_fg", "eval"));
		tick();
		await writeSubagent(outerFile, cwd, "CellWorker", stranded, { normalExit: true, spawnCallId: "call_outer_bg" });
		await writeSubagent(outerFile, cwd, "ForegroundWorker", stranded, {
			normalExit: true,
			spawnCallId: "call_outer_fg",
		});
		tick();
		outer.appendMessage(toolResultMessage("call_outer_fg", "eval", {}));
		tick();
		outer.appendMessage(toolCallMessage("call_outer_yield", "yield"));
		outer.appendMessage(toolResultMessage("call_outer_yield", "yield", { data: "done", status: "success" }));
		await outer.close();

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toContain("CellWorker");
		expect(outcome.subagents).not.toContain("ForegroundWorker");
	});

	for (const [label, inner, parked] of [
		["leaves a grandchild its parked parent's `owed` record names", "owed", true],
		["leaves a grandchild a process exit cut off under a parked parent", "cut off", true],
		[
			"control: relaunches a grandchild a process exit cut off under a paused yield restore goes on with",
			"cut off",
			false,
		],
	] as const) {
		it(label, async () => {
			// If this regresses, the subagent under a run parked at its yield, which restore does not go on with, is
			// relaunched with that run as its owner when a record names it or its own request was cut off: no session
			// takes its result, and the work runs again for nothing.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			const { outer, outerFile } = await openOuter(main, mainFile, cwd);
			tick();
			outer.appendMessage(toolCallMessage("call_outer_bg", "eval"));
			tick();
			// An `agent()` job the cell started: owed to Outer until its result is handed over.
			if (inner === "owed")
				await recordEvalAgentJobs({ sessionManager: outer } as unknown as ToolSession, ["Inner"], "owed");
			await writeSubagent(outerFile, cwd, "Inner", inner === "owed" ? stranded : cutOff, {
				normalExit: inner === "owed",
				spawnCallId: "call_outer_bg",
			});
			tick();
			outer.appendMessage(
				toolResultMessage("call_outer_bg", "eval", { async: { state: "running", jobId: "bg_cell", type: "eval" } }),
			);
			tick();
			outer.appendMessage(toolCallMessage("call_outer_yield", "yield"));
			outer.appendMessage(toolResultMessage("call_outer_yield", "yield", { data: "done", status: "success" }));
			if (parked) {
				// The executor parks the run: it stops the session with an abort that gives no reason.
				outer.appendMessage(
					assistant({
						stopReason: "aborted",
						errorMessage: GENERIC_ABORT_SENTINEL,
						errorId: AIError.create(AIError.Flag.Abort),
					}),
				);
			}
			await outer.close();

			const { outcome } = await restoreParent(main, mainFile);

			if (parked) expect(outcome.subagents).not.toContain("Inner");
			else expect(outcome.subagents).toContain("Inner");
		});
	}

	/** The settled pool job `pool`, as a job report lists it with the workers its result hands over. */
	const poolJob = {
		id: "pool",
		type: "task",
		status: "completed",
		agentUrlId: "pool",
		agentResults: [{ id: "PoolWorker" }],
	};
	const POOL_HANDOVERS: Record<string, ((main: SessionManager, records: ToolSession) => Promise<void>) | undefined> = {
		"a peek's handover record": async (_main, records) => {
			await recordHandovers(records, [{ agentId: "PoolWorker", jobId: "PoolWorker-b1" }]);
		},
		"the pool's delivery, which names its workers": async main => {
			const details: AsyncResultDetails = {
				jobs: [{ jobId: "pool", type: "task", status: "completed", agentResults: [{ id: "PoolWorker" }] }],
			};
			main.appendCustomMessageEntry(ASYNC_RESULT_MESSAGE_TYPE, "Background job pool completed.", true, details);
		},
		"a wait that returned the pool": async main => {
			main.appendMessage(
				assistant({ content: [{ type: "toolCall", id: "call_wait", name: "wait", arguments: {} }] }),
			);
			main.appendMessage(toolResultMessage("call_wait", "wait", { op: "wait", jobs: [poolJob] }));
		},
		"a kill of the settled pool": async main => {
			main.appendMessage(
				assistant({ content: [{ type: "toolCall", id: "call_kill", name: "write", arguments: {} }] }),
			);
			main.appendMessage(toolResultMessage("call_kill", "write", { proc: { op: "cancel", jobs: [poolJob] } }));
		},
		"the parent's stop of the pool, which discards its workers": async main => {
			main.appendCustomEntry(TASK_LAUNCH_DISCARDED_CUSTOM_TYPE, { agentId: "PoolWorker" });
		},
		"control: nothing, the process went away": undefined,
	};
	for (const [how, handOver] of Object.entries(POOL_HANDOVERS)) {
		it(`${handOver ? "leaves" : "relaunches"} a work pool's key-stranded worker after ${how}`, async () => {
			// If this regresses, a worker whose failure the pool already handed its owner (or whose pool the owner
			// stopped) is relaunched, and the owner gets a result it holds or never wants; or a worker the owner still
			// waits on is left.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			tick();
			main.appendMessage(toolCallMessage("call_pool", "eval"));
			tick();
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			await writeSubagent(mainFile, cwd, "PoolWorker", stranded, { normalExit: true, spawnCallId: "call_pool" });
			tick();
			main.appendMessage(toolResultMessage("call_pool", "eval", {}));
			tick();
			await handOver?.(main, records);
			tick();
			main.appendMessage(assistant({ content: [{ type: "text", text: "Waiting on the pool." }] }));

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(handOver ? [] : ["PoolWorker"]);
		});
	}

	for (const [label, recorded] of [
		["names the later call that pushed a kept-alive pool worker's cut-off batch, which its owed record names", true],
		["control: names no call of the batch when no owed record names the later call (an older version)", false],
	] as const) {
		it(label, async () => {
			// If this regresses, a kept-alive worker is matched by the call that pushed its first item only: the later
			// call whose items its cut-off batch runs is run again beside the relaunched worker, and pushes them again.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			tick();
			main.appendMessage(toolCallMessage("call_push_1", "eval"));
			tick();
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			// Its first batch finished; the process ended inside its second turn.
			await writeSubagent(mainFile, cwd, "PoolWorker", [...finished, ...cutOff], { spawnCallId: "call_push_1" });
			tick();
			main.appendMessage(toolResultMessage("call_push_1", "eval", {}));
			tick();
			main.appendMessage(
				assistant({
					content: [
						{
							type: "toolCall",
							id: "call_push_2",
							name: "eval",
							arguments: { language: "js", code: "pool.push(...)" },
						},
						{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "bun test" } },
					],
					stopReason: "toolUse",
				}),
			);
			tick();
			appendExecutionStart(main, "call_push_2", "eval");
			appendExecutionStart(main, "call_bash", "bash");
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed", recorded ? ["call_push_2"] : undefined);

			const { outcome, restoreTurn } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(["PoolWorker"]);
			expect(restoreTurn).toHaveBeenCalledWith({ relaunched: recorded ? { call_push_2: ["PoolWorker"] } : {} });
		});
	}

	for (const [label, discardFirst] of [
		[
			"leaves a cut-off worker whose parent's conversation records its spawn discarded after its transcript began (a fork copied it mid-run, the stop ended it)",
			false,
		],
		["control: relaunches a cut-off worker of the same id whose transcript began after the discard", true],
	] as const) {
		it(label, async () => {
			// If this regresses, a whole-session fork copies a running pool worker's transcript mid-run; the stop that
			// follows records the worker discarded in the fork, but its copied transcript still reads as cut off, so
			// the fork's `--restore` relaunches a worker of a pool the user stopped.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			tick();
			main.appendMessage(toolCallMessage("call_pool", "eval"));
			tick();
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			if (discardFirst) {
				tick();
				main.appendCustomEntry(TASK_LAUNCH_DISCARDED_CUSTOM_TYPE, { agentId: "PoolWorker" });
			}
			tick();
			await writeSubagent(mainFile, cwd, "PoolWorker", cutOff, { spawnCallId: "call_pool" });
			tick();
			if (!discardFirst) main.appendCustomEntry(TASK_LAUNCH_DISCARDED_CUSTOM_TYPE, { agentId: "PoolWorker" });
			tick();
			main.appendMessage(toolResultMessage("call_pool", "eval", {}));
			tick();
			main.appendMessage(assistant({ content: [{ type: "text", text: "Stopped the pool." }] }));

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(discardFirst ? ["PoolWorker"] : []);
		});
	}

	/**
	 * Opens pool worker PoolWorker's transcript under `mainFile`, spawned under `call_pool`, with a first batch that
	 * finished; the caller writes the rest and closes it.
	 */
	async function openPoolWorker(mainFile: string, cwd: string): Promise<SessionManager> {
		const worker = await SessionManager.open(
			path.join(mainFile.slice(0, -6), "PoolWorker.jsonl"),
			undefined,
			undefined,
			{ initialCwd: cwd, parentSession: mainFile, suppressBreadcrumb: true },
		);
		worker.appendSessionInit({
			systemPrompt: ["sub prompt"],
			task: "PoolWorker task",
			tools: ["read", "yield"],
			spawnCallId: "call_pool",
		});
		worker.appendMessage({ role: "user", content: "item one", timestamp: Date.now() });
		worker.appendMessage(assistant({ content: [{ type: "text", text: "item one done" }] }));
		return worker;
	}

	/** Ends `worker`'s turn on a key that could not be resolved, records its normal exit, and closes it. */
	async function endOnKey(worker: SessionManager): Promise<void> {
		worker.appendMessage(assistant({ stopReason: "error", errorMessage: KEY_ERROR, credentialUnavailable: true }));
		worker.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		await worker.close();
	}

	for (const [label, stopped] of [
		[
			"leaves a reused pool worker whose later batch failed on its key, when a peek handed over its earlier batch and the parent then stopped the pool",
			true,
		],
		["control: relaunches it when the parent did not stop the pool, which still owes the later batch", false],
	] as const) {
		it(label, async () => {
			// If this regresses, restore reads the peek's handover of the worker's earlier batch before the discard the
			// stop wrote: that handover is older than the later batch's turn, so the parent reads as waiting on that
			// turn, and a worker of a pool its owner stopped runs the later batch's items again.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			main.appendMessage(toolCallMessage("call_pool", "eval"));
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			const worker = await openPoolWorker(mainFile, cwd);
			setSystemTime(new Date(start + 60_000));
			// The cell's peek showed the first batch settled while another worker kept the pool from draining.
			appendAgentJobRecord(main, "PoolWorker", "delivered");
			setSystemTime(new Date(start + 120_000));
			// A later push went to the idle worker: the pool wrote it owed again, and its second batch ended because
			// its key could not be resolved.
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed", ["call_pool"]);
			worker.appendMessage({ role: "user", content: "item two", timestamp: Date.now() });
			await endOnKey(worker);
			setSystemTime(new Date(start + 180_000));
			// The cell killed the pool, whose stop recorded its workers discarded, and the cell ended.
			if (stopped) main.appendCustomEntry(TASK_LAUNCH_DISCARDED_CUSTOM_TYPE, { agentId: "PoolWorker" });
			main.appendMessage(toolResultMessage("call_pool", "eval", {}));
			main.appendMessage(
				assistant({ content: [{ type: "text", text: stopped ? "Stopped the pool." : "Waiting on the pool." }] }),
			);
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(stopped ? [] : ["PoolWorker"]);
		});
	}

	for (const [label, drained] of [
		[
			"relaunches a kept-alive pool worker whose turn began after the pool drained, though the owner took the pool's result later",
			true,
		],
		["control: leaves it when the pool's report gives no drain time, so the delivery's time counts", false],
	] as const) {
		it(label, async () => {
			// If this regresses, restore settles the pool's workers at the time its result reached the owner, not when
			// the pool drained: a turn a kept-alive worker began in between (an IRC message woke it), which the result
			// does not hold, reads as handed over and is lost when it ends on its key.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			main.appendMessage(toolCallMessage("call_pool", "eval"));
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			const worker = await openPoolWorker(mainFile, cwd);
			main.appendMessage(toolResultMessage("call_pool", "eval", {}));
			const drainedAt = start + 60_000;
			setSystemTime(new Date(start + 120_000));
			// An IRC message woke the kept-alive worker after the pool drained; that turn ended on its key.
			worker.appendCustomMessageEntry("irc:incoming", "One more thing.", true, {
				from: MAIN_AGENT_ID,
				message: "One more thing.",
			});
			await endOnKey(worker);
			setSystemTime(new Date(start + 180_000));
			// The owner took the pool's result only now.
			const details: AsyncResultDetails = {
				jobs: [
					{
						jobId: "pool",
						type: "task",
						status: "completed",
						agentResults: [drained ? { id: "PoolWorker", handedAt: drainedAt } : { id: "PoolWorker" }],
					},
				],
			};
			main.appendCustomMessageEntry(ASYNC_RESULT_MESSAGE_TYPE, "Background job pool completed.", true, details);
			main.appendMessage(assistant({ content: [{ type: "text", text: "The pool finished." }] }));
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(drained ? ["PoolWorker"] : []);
		});
	}

	for (const [label, stopped] of [
		[
			"leaves a reused pool worker whose later batch failed on its key, when the cell that stopped the pool names the worker's earlier batch in its eval result",
			true,
		],
		["control: relaunches it when that cell did not stop the pool", false],
	] as const) {
		it(label, async () => {
			// If this regresses, the stopping cell's `eval` result, written after the stop's discard, decides as the
			// worker's latest record: it names the worker for the earlier batch the cell's bridged `tool.wait` got, the
			// discard is never read, and the worker runs the later batch's items again for a pool its owner stopped.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			main.appendMessage(toolCallMessage("call_pool", "eval"));
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			const worker = await openPoolWorker(mainFile, cwd);
			const firstHandedAt = start + 60_000;
			setSystemTime(new Date(firstHandedAt));
			// The cell's bridged `tool.wait` on the worker's first batch job wrote its handover.
			appendAgentJobRecord(main, "PoolWorker", "delivered");
			setSystemTime(new Date(start + 120_000));
			// The cell pushed more items to the idle worker, whose second batch ended because its key could not be
			// resolved.
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed", ["call_pool"]);
			worker.appendMessage({ role: "user", content: "item two", timestamp: Date.now() });
			await endOnKey(worker);
			setSystemTime(new Date(start + 180_000));
			// The same cell killed the pool, whose stop recorded its workers discarded.
			if (stopped) main.appendCustomEntry(TASK_LAUNCH_DISCARDED_CUSTOM_TYPE, { agentId: "PoolWorker" });
			setSystemTime(new Date(start + 190_000));
			// The cell ended: its result names the worker for the first batch it got.
			main.appendMessage(
				toolResultMessage("call_pool", "eval", { agentResults: [{ id: "PoolWorker", handedAt: firstHandedAt }] }),
			);
			main.appendMessage(
				assistant({ content: [{ type: "text", text: stopped ? "Stopped the pool." : "Waiting on the pool." }] }),
			);
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(stopped ? [] : ["PoolWorker"]);
		});
	}

	for (const [label, drained] of [
		[
			"relaunches a kept-alive pool worker whose turn began after the pool drained, though a cell's bridged wait took the pool's result later",
			true,
		],
		["control: leaves it when the wait's handover record gives no drain time, so the record's time counts", false],
	] as const) {
		it(label, async () => {
			// If this regresses, restore settles a worker whose pool's result a cell took through a bridged `tool.wait`
			// (or a kill) at the time of the `delivered` record the wait wrote, not when the pool drained: a turn an IRC
			// message started on the kept-alive worker in between reads as handed over and is lost when it ends on its
			// key.
			const start = Date.parse("2026-11-17T12:00:00.000Z");
			setSystemTime(new Date(start));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			main.appendMessage(toolCallMessage("call_pool", "eval"));
			await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
			const worker = await openPoolWorker(mainFile, cwd);
			main.appendMessage(toolResultMessage("call_pool", "eval", {}));
			const drainedAt = start + 60_000;
			setSystemTime(new Date(start + 120_000));
			// An IRC message woke the kept-alive worker after the pool drained; that turn ended on its key.
			worker.appendCustomMessageEntry("irc:incoming", "One more thing.", true, {
				from: MAIN_AGENT_ID,
				message: "One more thing.",
			});
			await endOnKey(worker);
			setSystemTime(new Date(start + 180_000));
			// A later cell's bridged `tool.wait` took the pool's result only now.
			main.appendMessage(toolCallMessage("call_wait", "eval"));
			main.appendCustomEntry(
				"eval-agent-job",
				drained
					? { agentId: "PoolWorker", state: "delivered", handedAt: drainedAt }
					: { agentId: "PoolWorker", state: "delivered" },
			);
			main.appendMessage(
				toolResultMessage("call_wait", "eval", {
					agentResults: [{ id: "PoolWorker", handedAt: drained ? drainedAt : Date.now() }],
				}),
			);
			main.appendMessage(assistant({ content: [{ type: "text", text: "The pool finished." }] }));
			setSystemTime();

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(drained ? ["PoolWorker"] : []);
		});
	}

	for (const [label, wentBack] of [
		[
			"relaunches a subagent the current conversation still waits on, though a branch the user left by their own navigation holds its handover",
			true,
		],
		["control: leaves it when that handover is on the selected branch", false],
	] as const) {
		it(label, async () => {
			// If this regresses, restore reads the handovers on every branch the parent left, not only on the branches a
			// tool replay left: after the user went back and on another way, a handover the conversation they went on
			// with never got settles a subagent its `owed` record still waits on, and it is left.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			const records = { sessionManager: main } as unknown as ToolSession;
			tick();
			main.appendMessage(toolCallMessage("call_agent", "eval"));
			await recordEvalAgentJobs(records, ["Background"], "owed");
			tick();
			await writeSubagent(mainFile, cwd, "Background", stranded, { normalExit: true, spawnCallId: "call_agent" });
			tick();
			const started = main.appendMessage(toolResultMessage("call_agent", "eval", {}));
			tick();
			main.appendMessage({ role: "user", content: "Is it done?", timestamp: Date.now() });
			main.appendMessage(toolCallMessage("call_wait", "eval"));
			appendAgentJobRecord(main, "Background", "delivered");
			main.appendMessage(
				toolResultMessage("call_wait", "eval", { agentResults: [{ id: "Background", handedAt: Date.now() }] }),
			);
			main.appendMessage(assistant({ content: [{ type: "text", text: "Background could not run." }] }));
			tick();
			if (wentBack) {
				// The user went back to the cell's result and on another way.
				main.branch(started);
				main.appendMessage({ role: "user", content: "Do something else meanwhile.", timestamp: Date.now() });
				main.appendMessage(assistant({ content: [{ type: "text", text: "Doing it." }] }));
			}

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome.subagents).toEqual(wentBack ? ["Background"] : []);
		});
	}

	it("relaunches a work pool's key-stranded worker whose cancelled batch the pool's delivery names as aborted", async () => {
		// If this regresses, an aborted run the pool reports settles the worker: the owner never read a result of it.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const records = { sessionManager: main } as unknown as ToolSession;
		tick();
		main.appendMessage(toolCallMessage("call_pool", "eval"));
		tick();
		await recordEvalAgentJobs(records, ["PoolWorker"], "owed");
		await writeSubagent(mainFile, cwd, "PoolWorker", stranded, { normalExit: true, spawnCallId: "call_pool" });
		tick();
		main.appendMessage(toolResultMessage("call_pool", "eval", {}));
		tick();
		const details: AsyncResultDetails = {
			jobs: [
				{ jobId: "pool", type: "task", status: "cancelled", agentResults: [{ id: "PoolWorker", aborted: true }] },
			],
		};
		main.appendCustomMessageEntry(ASYNC_RESULT_MESSAGE_TYPE, "Background job pool cancelled.", true, details);

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["PoolWorker"]);
	});

	/** The parent's reply that calls `bash` (`call_bash`) and `task` (`call_task`) at once. */
	function bashAndTaskBatch(): AssistantMessage {
		return assistant({
			content: [
				{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "bun test" } },
				{ type: "toolCall", id: "call_task", name: "task", arguments: { agent: "task", task: "work" } },
			],
			stopReason: "toolUse",
		});
	}

	/** Appends the start record of the parent's call `toolCallId`, and returns its entry id. */
	function appendExecutionStart(main: SessionManager, toolCallId: string, toolName: string): string {
		return main.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId,
			toolName,
			startedAt: new Date().toISOString(),
		});
	}

	/** The parent's reply that calls an eval cell (`call_eval`) and `bash` (`call_bash`). */
	function evalAndBashReply(): AssistantMessage {
		return assistant({
			content: [
				{ type: "toolCall", id: "call_eval", name: "eval", arguments: { language: "js", code: "tool.task(...)" } },
				{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "bun test" } },
			],
			stopReason: "toolUse",
		});
	}

	it("names for the resumed turn the cut-off call each relaunched subagent's spawn record names, not each call whose run covers it", async () => {
		// If this regresses, a cut-off `bash` that ran while a backgrounded cell spawned is not run again, and its
		// result says it started that subagent; or a streamed launch made before its call started is not named, and
		// its `task` call runs again beside the relaunched subagent.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		main.appendMessage(toolCallMessage("call_cell", "eval"));
		tick();
		main.appendMessage(
			toolResultMessage("call_cell", "eval", { async: { state: "running", jobId: "bg_cell", type: "eval" } }),
		);
		tick();
		main.appendMessage(bashAndTaskBatch());
		tick();
		// The streamed launch spawned before its call's `tool_execution_start`.
		await writeSubagent(mainFile, cwd, "Streamed", cutOff, { spawnCallId: "call_task" });
		tick();
		appendExecutionStart(main, "call_bash", "bash");
		appendExecutionStart(main, "call_task", "task");
		tick();
		// While both calls ran, the backgrounded cell spawned its own subagent, and an older version wrote one that
		// names no call.
		await writeSubagent(mainFile, cwd, "CellSpawn", cutOff, { spawnCallId: "call_cell" });
		await writeSubagent(mainFile, cwd, "Unnamed", cutOff);

		const { outcome, restoreTurn } = await restoreParent(main, mainFile);

		expect([...outcome.subagents].sort()).toEqual(["CellSpawn", "Streamed", "Unnamed"]);
		expect(restoreTurn).toHaveBeenCalledWith({ relaunched: { call_task: ["Streamed"] } });
	});

	it("names the skipped call again when a second process end inside the resumed batch has restore relaunch its subagent again", async () => {
		// If this regresses, the second restore reads the skipped call's run as the replay's instant, which leaves out
		// its subagent's spawn: the call runs again and starts the work a second time.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		const anchor = main.appendMessage(bashAndTaskBatch());
		tick();
		appendExecutionStart(main, "call_bash", "bash");
		appendExecutionStart(main, "call_task", "task");
		tick();
		await writeSubagent(mainFile, cwd, "Worker", cutOff, { spawnCallId: "call_task" });
		tick();
		// The first restore strips the batch's cut-off results onto another branch and runs the batch again from its
		// reply: the `task` call is blocked with the skip result, and the process ends again while `bash` runs.
		main.branch(anchor);
		appendExecutionStart(main, "call_task", "task");
		main.appendMessage(toolResultMessage("call_task", "task", {}, true));
		appendExecutionStart(main, "call_bash", "bash");

		const { outcome, restoreTurn } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Worker"]);
		expect(restoreTurn).toHaveBeenCalledWith({ relaunched: { call_task: ["Worker"] } });
	});

	it("names the skipped call again at a second restore when the first cut-off result, now on the branch the replay left, named its subagent", async () => {
		// If this regresses, the second restore reads the subagent as work its parent left, since its only record is
		// the cut-off eval result (the cell got the subagent's aborted run) that the first restore's replay moved off
		// the selected branch: it is not relaunched, and the eval call runs again and starts a second subagent.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		const anchor = main.appendMessage(
			assistant({
				content: [
					{
						type: "toolCall",
						id: "call_eval",
						name: "eval",
						arguments: { language: "js", code: "tool.task(...)" },
					},
					{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "bun test" } },
				],
				stopReason: "toolUse",
			}),
		);
		tick();
		appendExecutionStart(main, "call_eval", "eval");
		tick();
		await writeSubagent(mainFile, cwd, "Worker", cutOff, { spawnCallId: "call_eval" });
		tick();
		main.appendMessage(
			toolResultMessage(
				"call_eval",
				"eval",
				{ agentResults: [{ id: "Worker", aborted: true, handedAt: Date.now() }] },
				true,
			),
		);
		tick();
		main.branch(anchor);
		appendExecutionStart(main, "call_eval", "eval");
		main.appendMessage(toolResultMessage("call_eval", "eval", {}, true));
		appendExecutionStart(main, "call_bash", "bash");

		const { outcome, restoreTurn } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Worker"]);
		expect(restoreTurn).toHaveBeenCalledWith({ relaunched: { call_eval: ["Worker"] } });
	});

	it("leaves a subagent whose recorded call a reply on a branch the parent left made, though no result names it", async () => {
		// If this regresses, a subagent of work the parent left (it went back before that reply and went on another
		// way) is placed in the current conversation by its transcript's time alone, and the new conversation gets
		// a result for a job it never started.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		const input = main.appendMessage({ role: "user", content: "Read the notes.", timestamp: Date.now() });
		tick();
		main.appendMessage(toolCallMessage("call_left", "task"));
		tick();
		await writeSubagent(mainFile, cwd, "LeftWorker", cutOff, { spawnCallId: "call_left" });
		tick();
		main.branch(input);
		main.appendMessage(assistant({ content: [{ type: "text", text: "Starting over." }] }));

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual([]);
	});

	/**
	 * A parent whose reply `call_eval` (an eval cell) and `call_bash` its process ended inside, after the cell's
	 * subagent `Worker` (spawned under `call_eval`) ended its turn with `workerTurn`, and the cell's cut-off error
	 * result named `firstHandovers` as handed over to the cell then. A first restore then ran the batch again from
	 * the reply, giving `call_eval` an error result (with `replayed`'s text and details, when given), and the
	 * process ended again while the replayed `bash` ran.
	 */
	async function replayedEvalBatch(
		workerTurn: Message[],
		firstHandovers: Array<{ id: string; aborted?: boolean }>,
		replayed?: { text: string; details: Record<string, unknown> },
	) {
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		const anchor = main.appendMessage(evalAndBashReply());
		tick();
		appendExecutionStart(main, "call_eval", "eval");
		tick();
		await writeSubagent(mainFile, cwd, "Worker", workerTurn, { spawnCallId: "call_eval", normalExit: true });
		tick();
		const agentResults = firstHandovers.map(handed => ({ ...handed, handedAt: Date.now() }));
		main.appendMessage(toolResultMessage("call_eval", "eval", { agentResults }, true));
		tick();
		main.branch(anchor);
		appendExecutionStart(main, "call_eval", "eval");
		const result = toolResultMessage("call_eval", "eval", replayed?.details ?? {}, true);
		main.appendMessage(
			replayed === undefined ? result : { ...result, content: [{ type: "text", text: replayed.text }] },
		);
		appendExecutionStart(main, "call_bash", "bash");
		return restoreParent(main, mainFile);
	}

	for (const [label, aborted] of [
		[
			"leaves a key-stranded subagent at a second restore when the first cut-off result, now on the branch the replay left, handed its failure to the cell",
			false,
		],
		["control: relaunches it when that result named only its aborted run, which the cell never read", true],
	] as const) {
		it(label, async () => {
			// If this regresses, the second restore reads the subagent placed by its call but not the handover its first
			// cut-off result holds on the branch the replay left: the subagent whose failure the cell already got (and
			// whose call the replay ran again) is relaunched beside the replay's own subagent.
			const { outcome, restoreTurn } = await replayedEvalBatch(stranded, [
				aborted ? { id: "Worker", aborted: true } : { id: "Worker" },
			]);

			expect(outcome.subagents).toEqual(aborted ? ["Worker"] : []);
			expect(restoreTurn).toHaveBeenCalledWith({ relaunched: aborted ? { call_eval: ["Worker"] } : {} });
		});
	}

	for (const [label, replayed] of [
		[
			"does not run a cut-off call again whose skip an earlier restore wrote, though its relaunched subagent has finished since",
			"skip",
		],
		["control: runs it again when the replayed call's result was no skip", "none"],
		[
			"control: runs it again when the replayed call's result only reads like a skip, without the skip's details flag",
			"text",
		],
	] as const) {
		it(label, async () => {
			// If this regresses, the second restore names a call only for a subagent it relaunches now: the subagent the
			// first restore relaunched finished before the second process end, so the call runs again and starts it
			// a second time. Or a result whose text only begins as a skip's does (a tool or the model wrote it), and a
			// call that should run again does not.
			const text = restoreSkippedCallReason(["Worker"]);
			const { outcome, restoreTurn } = await replayedEvalBatch(
				finished,
				[{ id: "Worker", aborted: true }],
				replayed === "none" ? undefined : { text, details: replayed === "skip" ? { [SKIP_FLAG]: true } : {} },
			);

			expect(outcome.subagents).toEqual([]);
			expect(restoreTurn).toHaveBeenCalledWith(
				replayed === "skip" ? { relaunched: {}, ran: { call_eval: ["Worker"] } } : { relaunched: {} },
			);
		});
	}

	/**
	 * A parent whose process ended inside its reply's `call_eval` and `call_bash`, after the cell's subagent `Worker`
	 * (spawned under `call_eval`) ended its turn on its key and `firstRun` wrote what the batch's first run left: by
	 * default the cell's cut-off error result, which says the cell got Worker's failure. A first restore then ran
	 * the batch again from the reply (with `forkAtStart`, the branch was cut at the cell's start record instead), and
	 * the process ended again before the replay's first result: the selected branch holds only a start record there.
	 */
	async function restoreAfterCutOffReplay(
		options: { firstRun?: (main: SessionManager) => void; forkAtStart?: boolean } = {},
	) {
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		const anchor = main.appendMessage(evalAndBashReply());
		tick();
		const started = appendExecutionStart(main, "call_eval", "eval");
		tick();
		await writeSubagent(mainFile, cwd, "Worker", stranded, { spawnCallId: "call_eval", normalExit: true });
		tick();
		(options.firstRun ?? cellGotWorkersFailure)(main);
		tick();
		if (options.forkAtStart) {
			main.branch(started);
			appendExecutionStart(main, "call_bash", "bash");
		} else {
			main.branch(anchor);
			appendExecutionStart(main, "call_eval", "eval");
		}
		return restoreParent(main, mainFile);
	}

	/** The cell's cut-off error result, which says the cell got Worker's failure. */
	function cellGotWorkersFailure(main: SessionManager): void {
		main.appendMessage(
			toolResultMessage("call_eval", "eval", { agentResults: [{ id: "Worker", handedAt: Date.now() }] }, true),
		);
	}

	for (const [label, rest, relaunched] of [
		[
			"leaves a key-stranded subagent whose failure the cell got, when the replay of its batch was cut off before its first result",
			undefined,
			false,
		],
		[
			"leaves it when the first run's branch holds only what a cut-off batch leaves besides: the other call's error result, the turn's abort, an exit record, a retry's model and thinking changes, an eval snapshot",
			(main: SessionManager) => {
				appendExecutionStart(main, "call_bash", "bash");
				main.appendMessage(toolResultMessage("call_bash", "bash", {}, true));
				main.appendModelChange("anthropic/claude-haiku-4-5");
				main.appendThinkingLevelChange("low");
				main.appendMessage(assistant({ stopReason: "aborted", errorMessage: "Request was aborted" }));
				main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
					reason: "dispose",
					kind: "process_exit",
					recordedAt: new Date().toISOString(),
				});
				main.appendCustomMessageEntry(EVAL_STATE_CONTEXT_TYPE, "eval runtime state", false);
			},
			false,
		],
		[
			"relaunches it when that branch holds a prompt: a turn the conversation took there",
			(main: SessionManager) => main.appendMessage({ role: "user", content: "Go on.", timestamp: Date.now() }),
			true,
		],
		[
			"relaunches it when that branch holds an IRC message, which the conversation takes as a turn",
			(main: SessionManager) =>
				main.appendCustomMessageEntry("irc:incoming", "Status?", true, { from: MAIN_AGENT_ID, message: "Status?" }),
			true,
		],
		[
			"relaunches it when that branch holds a reply that makes a call",
			(main: SessionManager) =>
				main.appendMessage(
					assistant({
						stopReason: "aborted",
						content: [{ type: "toolCall", id: "call_more", name: "bash", arguments: { command: "ls" } }],
					}),
				),
			true,
		],
		[
			"relaunches it when that branch holds a reply that completed",
			(main: SessionManager) => main.appendMessage(assistant({ content: [{ type: "text", text: "Done." }] })),
			true,
		],
		[
			"relaunches it when that branch holds a result that is no error: a call that ran to its end",
			(main: SessionManager) => main.appendMessage(toolResultMessage("call_bash", "bash", {})),
			true,
		],
		[
			"relaunches it when that branch holds a result of a call the reply did not make",
			(main: SessionManager) => main.appendMessage(toolResultMessage("call_other", "bash", {}, true)),
			true,
		],
	] as const) {
		it(label, async () => {
			// If this regresses, restore judges the branch the batch's first run lies on by what the selected branch
			// wrote after the fork: a replay cut off before its first result wrote only a start record, the branch is not
			// read, and the subagent whose failure the cell got is relaunched beside the replayed cell's own. Or it reads a
			// branch that holds a turn the conversation took there as a replay's, and settles a subagent from it.
			const { outcome } = await restoreAfterCutOffReplay({
				firstRun: main => {
					cellGotWorkersFailure(main);
					rest?.(main);
				},
			});

			expect(outcome.subagents).toEqual(relaunched ? ["Worker"] : []);
		});
	}

	for (const [label, options] of [
		[
			"relaunches it when the first run's branch holds no result of the reply's calls, which no replay leaves",
			{ firstRun: (main: SessionManager) => appendAgentJobRecord(main, "Worker", "delivered") },
		],
		[
			"relaunches it when that branch forks below the reply, at the cell's start record, as a re-answer's does",
			{ forkAtStart: true },
		],
	] as const) {
		it(label, async () => {
			// If this regresses, a branch that no replay left (it holds none of the reply's results, or it forks below
			// the reply) reads as the batch's first run, and its handover settles a subagent the conversation the parent
			// went on with never got.
			const { outcome } = await restoreAfterCutOffReplay(options);

			expect(outcome.subagents).toEqual(["Worker"]);
		});
	}

	it("relaunches a subagent the current conversation still waits on, when its handover is only on the branch a /tree re-answer of an ask left", async () => {
		// If this regresses, the branch a person left by re-answering an `ask` (the reply's only call, which got its
		// result with no start record) reads as a replay's, and the handover on it settles a subagent the conversation
		// they went on with never got.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const records = { sessionManager: main } as unknown as ToolSession;
		tick();
		main.appendMessage(toolCallMessage("call_agent", "eval"));
		await recordEvalAgentJobs(records, ["Background"], "owed");
		tick();
		await writeSubagent(mainFile, cwd, "Background", stranded, { normalExit: true, spawnCallId: "call_agent" });
		tick();
		main.appendMessage(toolResultMessage("call_agent", "eval", {}));
		tick();
		main.appendMessage({ role: "user", content: "Which way?", timestamp: Date.now() });
		const askReply = main.appendMessage(toolCallMessage("call_ask", "ask"));
		main.appendMessage(toolResultMessage("call_ask", "ask", {}));
		main.appendMessage(toolCallMessage("call_wait", "eval"));
		appendAgentJobRecord(main, "Background", "delivered");
		main.appendMessage(
			toolResultMessage("call_wait", "eval", { agentResults: [{ id: "Background", handedAt: Date.now() }] }),
		);
		main.appendMessage(assistant({ content: [{ type: "text", text: "Background could not run." }] }));
		tick();
		// The person re-answered the ask in `/tree`: a sibling result under the reply, and the conversation went on.
		main.branch(askReply);
		main.appendMessage(toolResultMessage("call_ask", "ask", {}));
		main.appendMessage(assistant({ content: [{ type: "text", text: "Going the other way." }] }));

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual(["Background"]);
	});

	it("leaves a subagent an earlier reply spawned, whose handover the first run of a replayed cell held", async () => {
		// The rule covers every subagent spawned in the current conversation, not only one the replayed reply's calls
		// spawned: the first restore read this handover on the selected branch and left the subagent, so the second
		// must too. If this regresses, the second restore relaunches a subagent whose failure the cell got.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const records = { sessionManager: main } as unknown as ToolSession;
		tick();
		main.appendMessage(toolCallMessage("call_agent", "eval"));
		await recordEvalAgentJobs(records, ["Background"], "owed");
		tick();
		await writeSubagent(mainFile, cwd, "Background", stranded, { normalExit: true, spawnCallId: "call_agent" });
		tick();
		main.appendMessage(toolResultMessage("call_agent", "eval", {}));
		tick();
		const anchor = main.appendMessage(evalAndBashReply());
		tick();
		appendExecutionStart(main, "call_eval", "eval");
		tick();
		main.appendMessage(
			toolResultMessage("call_eval", "eval", { agentResults: [{ id: "Background", handedAt: Date.now() }] }, true),
		);
		tick();
		main.branch(anchor);
		appendExecutionStart(main, "call_eval", "eval");
		main.appendMessage(toolResultMessage("call_eval", "eval", {}, true));
		appendExecutionStart(main, "call_bash", "bash");

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome.subagents).toEqual([]);
	});

	it("relaunches only the streamed reply's spawn when the replaced reply forked after the input, from a summary both branches share", async () => {
		// If this regresses, the replacement window opens at the first entry after the input, which here is the
		// summary both branches share, before the replaced reply: that reply's spawn is relaunched for a conversation
		// that abandoned it.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		const input = main.getLeafId();
		if (!input) throw new Error("Expected the parent's input entry");
		tick();
		main.branchWithSummary(input, "S1: the work so far.");
		const shared = main.getLeafId();
		if (!shared) throw new Error("Expected the shared summary entry");
		tick();
		main.appendMessage(toolCallMessage("call_eval_replaced", "eval"));
		tick();
		await writeSubagent(mainFile, cwd, "Replaced", stranded, { normalExit: true });
		tick();
		// The parent went back onto the shared summary; selecting it saved a second summary there.
		main.branchWithSummary(shared, "S2: the replaced reply ran a cell.");
		tick();
		await writeSubagent(mainFile, cwd, "Streamed", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Streamed"] });
	});

	for (const [records, details, relaunched] of [
		["leaves it when the eval result's agentResults names it", { agentResults: [{ id: "Held" }] }, false],
		["control: relaunches it when the eval result names no agent result", {}, true],
	] as const) {
		it(`a key-stranded subagent whose failure the parent's cut-off eval cell got through tool.task: ${records}`, async () => {
			// The process went away inside the cell that got the failure. Only `agentResults` shows the handover: without
			// it, the cut-off call reads as still waiting on what it spawned.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			tick();
			main.appendMessage(toolCallMessage("call_eval_cut", "eval"));
			tick();
			await writeSubagent(mainFile, cwd, "Held", stranded, { normalExit: true });
			tick();
			main.appendMessage(toolResultMessage("call_eval_cut", "eval", details, true));
			main.appendMessage(
				assistant({
					stopReason: "aborted",
					errorMessage: GENERIC_ABORT_SENTINEL,
					errorId: AIError.create(AIError.Flag.Abort),
				}),
			);

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: relaunched ? ["Held"] : [] });
		});
	}

	it("relaunches a background subagent an eval cell's tool.task started, whose result never reached the parent, after a later call is cut off", async () => {
		// If this regresses, the `owed` record a bridged background spawn leaves is not read: the subagent, whose
		// "started" result settled nothing and whose failure never reached the parent, is outside the cut-off call's
		// window and is left, though its parent still waits on it.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		main.appendMessage(toolCallMessage("call_eval_spawn", "eval"));
		appendAgentJobRecord(main, "Spawned", "owed");
		tick();
		await writeSubagent(mainFile, cwd, "Spawned", stranded, { normalExit: true });
		tick();
		main.appendMessage(toolResultMessage("call_eval_spawn", "eval", {}));
		tick();
		main.appendMessage(toolCallMessage("call_read", "read"));

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Spawned"] });
	});

	it("does not relaunch a background subagent whose failure an eval cell's tool.wait handed over", async () => {
		// The records a bridged `tool.wait` leaves: `delivered` before the cell gets the result, and the subagent in
		// the eval result's `agentResults`.
		const { main, mainFile, cwd } = openParent();
		for (const message of parentTaskCall("Spawned", "started")) main.appendMessage(message);
		main.appendMessage(assistant({ content: [{ type: "text", text: "Spawned is running." }] }));
		await writeSubagent(mainFile, cwd, "Spawned", stranded, { normalExit: true });
		main.appendMessage({ role: "user", content: "check on it", timestamp: Date.now() });
		main.appendMessage(toolCallMessage("call_eval_wait", "eval"));
		appendAgentJobRecord(main, "Spawned", "delivered");
		main.appendMessage(toolResultMessage("call_eval_wait", "eval", { agentResults: [{ id: "Spawned" }] }));
		main.appendMessage(assistant({ content: [{ type: "text", text: "Spawned could not run." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	/** The record of eval `agent()` job `agentId` that its owner's transcript holds (`eval-agent-job`). */
	function appendAgentJobRecord(main: SessionManager, agentId: string, state: "owed" | "delivered"): void {
		main.appendCustomEntry("eval-agent-job", { agentId, state });
	}

	it("relaunches an eval agent() job's key-stranded subagent while its result is still owed to its idle parent", async () => {
		// If this regresses, the result a background agent() job still owes its parent stops counting as the
		// parent's wait, and `omp --restore` loses work the parent will receive as a delivery.
		const { main, mainFile, cwd } = openParent();
		appendAgentJobRecord(main, "Owed", "owed");
		appendParentToolResult(main, "eval", {});
		await writeSubagent(mainFile, cwd, "Owed", stranded, { normalExit: true });
		main.appendMessage(assistant({ content: [{ type: "text", text: "Owed is running." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Owed"] });
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Owed", restore: true });
	});

	it("does not relaunch an eval agent() job's key-stranded subagent whose result an eval cell's wait() delivered", async () => {
		const { main, mainFile, cwd } = openParent();
		appendAgentJobRecord(main, "Waited", "owed");
		await writeSubagent(mainFile, cwd, "Waited", stranded, { normalExit: true });
		// wait() writes `delivered` before the cell receives the result; the eval result names the run it handed over.
		appendAgentJobRecord(main, "Waited", "delivered");
		appendParentToolResult(main, "eval", { agentResults: [{ id: "Waited" }] });
		main.appendMessage(assistant({ content: [{ type: "text", text: "Waited could not run." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not relaunch an eval agent() job's key-stranded subagent whose result a backgrounded cell delivered", async () => {
		const { main, mainFile, cwd } = openParent();
		appendAgentJobRecord(main, "InBackground", "owed");
		appendParentToolResult(main, "eval", { async: { state: "running", jobId: "eval-job", type: "eval" } });
		await writeSubagent(mainFile, cwd, "InBackground", stranded, { normalExit: true });
		// The backgrounded cell's wait() wrote `delivered`; the cell's own job result then reached the parent.
		appendAgentJobRecord(main, "InBackground", "delivered");
		jobResultRecords["its async-result delivery"]!(main, "eval-job", "completed");
		main.appendMessage(assistant({ content: [{ type: "text", text: "The cell finished." }] }));

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not relaunch an eval agent() job's key-stranded subagent delivered just before its parent's process went away", async () => {
		// wait() writes `delivered` before the handover, so the only window a crash leaves is `delivered` without the
		// eval result that records the handover. The parent's turn was still live, which alone would relaunch it.
		const { main, mainFile, cwd } = openParent();
		appendAgentJobRecord(main, "Crashed", "owed");
		await writeSubagent(mainFile, cwd, "Crashed", stranded, { normalExit: true });
		main.appendMessage(
			assistant({
				content: [{ type: "toolCall", id: "call_eval_crash", name: "eval", arguments: {} }],
				stopReason: "toolUse",
			}),
		);
		appendAgentJobRecord(main, "Crashed", "delivered");

		const { outcome, followUp } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
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

	for (const [label, claimed] of [
		[
			"never relaunches a key-stranded vibe worker that interactive mode rehydrated, though a cut-off vibe_wait waited on it",
			true,
		],
		["control: relaunches the same key-stranded subagent when no vibe record claims it", false],
	] as const) {
		it(label, async () => {
			// Interactive mode rehydrates vibe workers as subagent refs before `--restore` runs, so the persisted roster
			// keeps them. If this regresses, `--restore` runs the vibe worker's turn as a task job beside vibe mode's own
			// record of it, whose director decides its next turn.
			const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
			const { main, mainFile, cwd } = openParent();
			const lifecycle = (data: Record<string, unknown>) =>
				main.appendCustomEntry("vibe-session-lifecycle", {
					version: 1,
					id: "Vibe-1",
					ownerId: MAIN_AGENT_ID,
					parentSessionId: main.getSessionId(),
					...data,
				});
			tick();
			main.appendMessage(toolCallMessage("call_spawn", "vibe_spawn"));
			if (claimed) {
				lifecycle({
					action: "spawn",
					cli: "fast",
					agent: VIBE_CLI_AGENT.fast,
					childSessionFile: "Vibe-1.jsonl",
					createdAt: Date.now(),
				});
			}
			tick();
			main.appendMessage(toolResultMessage("call_spawn", "vibe_spawn", {}));
			tick();
			main.appendMessage(toolCallMessage("call_vibe_wait", "vibe_wait"));
			if (claimed) lifecycle({ action: "turn-started", turn: 1 });
			// The worker's transcript begins inside the cut-off call's window, so only vibe mode's claim keeps it out.
			tick();
			await writeSubagent(mainFile, cwd, "Vibe-1", stranded, { normalExit: true });
			setSystemTime();
			// Interactive mode's start-up, before `--restore`: vibe mode registers its resumable worker.
			const rehydrated = await VibeSessionRegistry.global().rehydrate({
				getSessionId: () => main.getSessionId(),
				getSessionFile: () => mainFile,
				sessionManager: main as unknown as ToolSession["sessionManager"],
				settings: Settings.isolated(),
			});
			expect(rehydrated).toBe(claimed ? 1 : 0);
			if (claimed) {
				expect(AgentRegistry.global().get("Vibe-1")).toMatchObject({ kind: "sub", parentId: MAIN_AGENT_ID });
			}

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: claimed ? [] : ["Vibe-1"] });
		});
	}

	it("relaunches a later spawn of an id a discarded launch never wrote a transcript for, cut off with no record yet", async () => {
		// If this regresses, the old discard record decides for the id however late: a later process allocated the id
		// again (the discarded launch never wrote a transcript), its spawn had written no record when the process went
		// away inside the call, and `--restore` leaves a subagent its parent still waits on.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		main.appendCustomEntry("task-launch-discarded", { agentId: "Reused" });
		tick();
		main.appendMessage(assistant({ content: [{ type: "text", text: "Moved on." }] }));
		main.appendMessage({ role: "user", content: "try again", timestamp: Date.now() });
		tick();
		main.appendMessage(toolCallMessage("call_task_again", "task"));
		tick();
		await writeSubagent(mainFile, cwd, "Reused", stranded, { normalExit: true });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: ["Reused"] });
	});

	it("leaves a launch whose discard record is on the selected branch and came after its transcript began", async () => {
		// The guard beside the reused-id case: the discard still decides for the launch it was written for.
		const tick = clockFrom(Date.parse("2026-11-17T12:00:00.000Z"));
		const { main, mainFile, cwd } = openParent();
		tick();
		main.appendMessage(toolCallMessage("call_task_stream", "task"));
		tick();
		await writeSubagent(mainFile, cwd, "Reused", stranded, { normalExit: true });
		tick();
		main.appendCustomEntry("task-launch-discarded", { agentId: "Reused" });

		const { outcome } = await restoreParent(main, mainFile);

		expect(outcome).toEqual({ turn: false, subagents: [] });
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
			setSystemTime(new Date(FOLLOW_UP_START));
			const { main, mainFile, cwd } = openParent();
			for (const message of parentTaskCall("FollowedUp", "started")) main.appendMessage(message);
			await writeFollowedUp(mainFile, cwd, () => {
				deliver(main, "FollowedUp", "completed");
				main.appendMessage(assistant({ content: [{ type: "text", text: "Asked FollowedUp for the rest." }] }));
			});

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: ["FollowedUp"] });
			expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "FollowedUp", restore: true });
		});
	}

	/** The records an eval cell leaves when a bridged call hands it subagent `id`'s result. */
	const evalHandovers: Record<string, { agentJob: boolean; record: (main: SessionManager, id: string) => void }> = {
		"an eval cell's tool.task result": {
			agentJob: false,
			record: (main, id) => appendParentToolResult(main, "eval", { agentResults: [{ id, handedAt: Date.now() }] }),
		},
		"an agent() job's wait() in a foreground cell": {
			agentJob: true,
			record: (main, id) => {
				appendAgentJobRecord(main, id, "delivered");
				appendParentToolResult(main, "eval", { agentResults: [{ id, handedAt: Date.now() }] });
			},
		},
		"an agent() job's wait() in a backgrounded cell": {
			agentJob: true,
			record: (main, id) => appendAgentJobRecord(main, id, "delivered"),
		},
	};

	for (const [handover, { agentJob, record }] of Object.entries(evalHandovers)) {
		it(`relaunches a subagent whose follow-up turn ended without its key after ${handover} handed its parent the first turn's result`, async () => {
			// If this regresses, the eval handover of the subagent's first result reads as the failure of the turn its
			// parent messaged it for: `--restore` never goes on with that turn, as it does for a `task` spawn's.
			setSystemTime(new Date(FOLLOW_UP_START));
			const { main, mainFile, cwd } = openParent();
			if (agentJob) appendAgentJobRecord(main, "FollowedUp", "owed");
			await writeFollowedUp(mainFile, cwd, () => {
				record(main, "FollowedUp");
				main.appendMessage(assistant({ content: [{ type: "text", text: "Asked FollowedUp for the rest." }] }));
			});

			const { outcome, followUp } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: ["FollowedUp"] });
			expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "FollowedUp", restore: true });
		});
	}

	for (const [records, handedAt, relaunched] of [
		["relaunches it: the eval result says the handover came before that turn", FOLLOW_UP_START + 60_000, true],
		["control: an eval result that says no handover time settles by when it was written", undefined, false],
	] as const) {
		it(`a follow-up turn a cell started after it took the subagent's result through tool.wait, the cell's eval result written after that turn began: ${records}`, async () => {
			// If this regresses, the eval result, saved when the cell ends, settles the subagent at that later time: the
			// turn the same cell messaged it for after the handover reads as settled, and `--restore` never goes on with it.
			setSystemTime(new Date(FOLLOW_UP_START));
			const { main, mainFile, cwd } = openParent();
			appendAgentJobRecord(main, "FollowedUp", "owed");
			await writeFollowedUp(
				mainFile,
				cwd,
				// The cell's tool.wait took the first turn's result; the cell then messaged the subagent.
				() => appendAgentJobRecord(main, "FollowedUp", "delivered"),
				// The cell ended after the follow-up turn had begun; its eval result names the handover.
				() => {
					appendParentToolResult(main, "eval", {
						agentResults: [handedAt === undefined ? { id: "FollowedUp" } : { id: "FollowedUp", handedAt }],
					});
					main.appendMessage(assistant({ content: [{ type: "text", text: "Asked FollowedUp for the rest." }] }));
				},
			);

			const { outcome } = await restoreParent(main, mainFile);

			expect(outcome).toEqual({ turn: false, subagents: relaunched ? ["FollowedUp"] : [] });
		});
	}

	/**
	 * Subagent FollowedUp's transcript under `mainFile`: a first turn that finished at
	 * {@link FOLLOW_UP_START}, then, two minutes later, a turn its parent's message woke, which ended
	 * because its key could not be resolved. `parentRecords` runs a minute after the first turn, to
	 * write what the parent recorded between the two; `afterTurnBegan`, when given, a minute after
	 * the follow-up turn began.
	 */
	async function writeFollowedUp(
		mainFile: string,
		cwd: string,
		parentRecords: () => void,
		afterTurnBegan?: () => void,
	): Promise<void> {
		setSystemTime(new Date(FOLLOW_UP_START));
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
		setSystemTime(new Date(FOLLOW_UP_START + 60_000));
		parentRecords();
		// The message woke the subagent; that turn ended because its key could not be resolved.
		setSystemTime(new Date(FOLLOW_UP_START + 120_000));
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
		if (afterTurnBegan) {
			setSystemTime(new Date(FOLLOW_UP_START + 180_000));
			afterTurnBegan();
		}
		await sub.close();
		setSystemTime();
	}
});
