import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
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
import {
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { GENERIC_ABORT_SENTINEL, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
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
	];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		for (const id of ids) AgentRegistry.global().unregister(id);
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
