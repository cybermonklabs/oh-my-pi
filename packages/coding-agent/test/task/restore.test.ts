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
 * its text, as the loop writes it), which a dispose for a quit, `/restart` or a signal leaves.
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
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => [], getLeafId: () => null },
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
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => [], getLeafId: () => null },
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
});
