import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockContent } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { SubagentSpawnSignal } from "../../src/thread/subagent-spawn-signal";
import {
	prewarmSubagentWorker,
	SubagentWorkerPool,
	setSubagentWorkerPoolForTests,
} from "../../src/thread/subagent-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function message(calls: Array<{ name: string; args?: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call_${index}`,
			name: call.name,
			arguments: {},
		})),
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

/** The event stream of one assistant message whose tool calls stream their arguments in `deltas`. */
function stream(calls: Array<{ name: string; deltas: string[] }>): AssistantMessageEvent[] {
	const partial = message(calls);
	const events: AssistantMessageEvent[] = [{ type: "start", partial }];
	calls.forEach((call, contentIndex) => {
		events.push({ type: "toolcall_start", contentIndex, partial });
		for (const delta of call.deltas) events.push({ type: "toolcall_delta", contentIndex, delta, partial });
	});
	return events;
}

/** `[event index, expected spawns]` for every event the signal reported a grown count on. */
function fired(signal: SubagentSpawnSignal, events: AssistantMessageEvent[]): Array<[number, number]> {
	return events.flatMap((event, index): Array<[number, number]> => {
		const expected = signal.observe(event);
		return expected ? [[index, expected]] : [];
	});
}

const ITEM = '{"agent":"task","task":"x"}';

describe("SubagentSpawnSignal", () => {
	it("reports one spawn when a task call starts streaming, then one per tasks[] item as soon as it opens", () => {
		const signal = new SubagentSpawnSignal();
		const events = stream([
			{ name: "read", deltas: ['{"path":'] },
			{
				name: "task",
				deltas: ['{"context":"c","tasks":[', ITEM, `,${ITEM}`, `,${ITEM.slice(0, 9)}`, `${ITEM.slice(9)}]}`],
			},
		]);
		// start, read start, read delta, task start (3: one spawn), item 1 (5: still one),
		// item 2 (6), item 3 counts when its `{` streams (7), before it closes in the last delta (8).
		expect(fired(signal, events)).toEqual([
			[3, 1],
			[6, 2],
			[7, 3],
		]);
		// A new message starts over; a single-task call is one spawn.
		expect(fired(signal, stream([{ name: "task", deltas: ['{"agent":"task","task":"x"}'] }]))).toEqual([[1, 1]]);
	});

	it("adds up the spawning calls of one message", () => {
		const signal = new SubagentSpawnSignal();
		const events = stream([
			{ name: "task", deltas: [`{"tasks":[${ITEM},${ITEM}]}`] },
			{ name: "task", deltas: [] },
		]);
		expect(fired(signal, events)).toEqual([
			[1, 1],
			[2, 2],
			[3, 3],
		]);
	});

	it("fires for an eval call only once its code calls agent() or workpool(), across delta boundaries", () => {
		const signal = new SubagentSpawnSignal();
		expect(fired(signal, stream([{ name: "eval", deltas: ['{"code":"x = 1', '\\nprint(x)"}'] }]))).toEqual([]);
		expect(
			fired(signal, stream([{ name: "eval", deltas: ['{"code":"r = await ag', "ent(", '{prompt: 1})"}'] }])),
		).toEqual([[3, 1]]);
		expect(fired(signal, stream([{ name: "eval", deltas: ['{"code":"await workpool (items)', "agent("] }]))).toEqual([
			[2, 1],
		]);
	});
});

describe("prewarmSubagentWorker", () => {
	afterEach(() => setSubagentWorkerPoolForTests(undefined));

	it("starts a worker in the background once the coming spawns reach a worker bracket", async () => {
		const pool = new SubagentWorkerPool({ maxWorkers: () => 4 });
		setSubagentWorkerPoolForTests(pool);
		const nextImmediate = (): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			return promise;
		};
		try {
			const settings = Settings.isolated();
			const modelRegistry = new ModelRegistry(createInMemoryAuthStorage());
			prewarmSubagentWorker(settings, modelRegistry, 8);
			await nextImmediate();
			expect(pool.workers()).toEqual([]);
			prewarmSubagentWorker(settings, modelRegistry, 9);
			expect(pool.workers()).toEqual([]);
			await nextImmediate();
			const [worker] = pool.workers();
			if (!worker) throw new Error("prewarm started no worker");
			await worker.ready;
			expect(worker.runs).toBe(0);
		} finally {
			pool.dispose();
		}
	});
});

describe("AgentSession subagent worker prewarm", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setSubagentWorkerPoolForTests(undefined);
	});

	it("counts each assistant message's task items from zero", async () => {
		// If this regresses, a later message's task call is counted on top of the earlier
		// messages' (or not at all), so the pool boots workers for spawns that never come.
		const pool = new SubagentWorkerPool({ maxWorkers: () => 0 });
		setSubagentWorkerPoolForTests(pool);
		const prewarm = vi.spyOn(pool, "prewarm");
		const taskCall = (task: string): MockContent => ({
			type: "toolCall",
			name: "task",
			arguments: {
				context: "c",
				tasks: [
					{ agent: "task", task },
					{ agent: "task", task },
				],
			},
		});
		const mock = createMockModel({
			responses: [{ content: [taskCall("first")] }, { content: [taskCall("second")] }, { content: ["done"] }],
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		try {
			await session.prompt("spawn two subagents, twice");
			await session.waitForIdle();
			// Per message: one spawn once the task call starts, two once both items open.
			expect(prewarm.mock.calls).toEqual([[1], [2], [1], [2]]);
		} finally {
			await session.dispose();
			authStorage.close();
			pool.dispose();
		}
	});
});
