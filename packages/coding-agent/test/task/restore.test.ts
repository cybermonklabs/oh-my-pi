import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
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

describe("restoreSession (omp --restore)", () => {
	const ids = ["Cut", "Done", "Killed", "Stranded", "Refused", "ClearedHere", "ErrorHere", "Older", "Left", "Current"];
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
});
