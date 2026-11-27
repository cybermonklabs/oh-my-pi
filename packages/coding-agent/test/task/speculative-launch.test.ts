/**
 * Contracts: speculative subagent launch for streamed batch `task` calls.
 *
 * 1. The scanner surfaces a `tasks[]` item only once its object closes —
 *    braces/quotes inside strings never close it early.
 * 2. An item's subagent starts while later items still stream; dispatch
 *    adopts the running agents instead of spawning duplicates.
 * 3. A finished call that is invalid, or whose items differ from what was
 *    launched, aborts every speculative agent.
 * 4. The host only authorizes launches under auto-allow approval with no
 *    extension lifecycle handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { BatchArgsScanner, type TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/task-details";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const sink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
};

function createSession(manager: AsyncJobManager, settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true, ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** Observable lifecycle of one mocked subagent run, keyed by agent id. */
interface SpawnEvents {
	started: PromiseWithResolvers<void>;
	aborted: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
}

const args = {
	context: "ctx",
	tasks: [
		{ name: "Alpha", agent: "task", task: "Do A." },
		{ name: "Beta", agent: "task", task: "Do B." },
	],
};
const json = JSON.stringify(args);
/** Streamed through Alpha's closing brace, mid-way into Beta. */
const alphaClosed = json.slice(0, json.indexOf('{"name":"Beta"') + 10);
const toolCall: AgentToolCall = { type: "toolCall", id: "tc-spec", name: "task", arguments: {} };

describe("BatchArgsScanner", () => {
	it("surfaces items only once their object closes, ignoring braces inside strings", () => {
		const raw =
			'{"context":"shared }\\" ctx","tasks":[{"name":"A","task":"use {x} and \\"}\\""},{"name":"B","task":"b"}]}';
		const scanner = new BatchArgsScanner();
		const seen: number[] = [];
		for (let end = 1; end <= raw.length; end++) {
			scanner.feed(raw.slice(0, end));
			seen.push(scanner.items.length);
		}

		expect(scanner.context).toBe('shared }" ctx');
		expect(scanner.items).toEqual([
			{ name: "A", task: 'use {x} and "}"' },
			{ name: "B", task: "b" },
		]);
		// Each item appears exactly at the byte that closes it.
		expect(seen.indexOf(1)).toBe(raw.indexOf('"},{"name":"B"') + 1);
		expect(seen.indexOf(2)).toBe(raw.length - 3);
	});

	it("scans appended deltas exactly like the growing buffer they add up to", () => {
		const raw =
			'{"context":"shared }\\" ctx","tasks":[{"name":"A","task":"use {x} and \\"}\\""},{"name":"B","task":"b"}]}';
		for (const size of [1, 3, 7]) {
			const fed = new BatchArgsScanner();
			const appended = new BatchArgsScanner();
			for (let start = 0; start < raw.length; start += size) {
				fed.feed(raw.slice(0, start + size));
				appended.append(raw.slice(start, start + size));
				expect([appended.context, appended.items, appended.itemsOpened]).toEqual([
					fed.context,
					fed.items,
					fed.itemsOpened,
				]);
			}
		}
	});
});

describe("task speculative launch", () => {
	const managers: AsyncJobManager[] = [];
	const spawns = new Map<string, SpawnEvents>();
	const startedIds = new Set<string>();
	const spawn = (id: string): SpawnEvents => {
		let events = spawns.get(id);
		if (!events) {
			events = {
				started: Promise.withResolvers<void>(),
				aborted: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			};
			spawns.set(id, events);
		}
		return events;
	};

	async function openSession(settings: Record<string, unknown> = {}): Promise<{
		tool: TaskTool;
		toolSession: ToolSession;
		manager: AsyncJobManager;
		session: TaskLaunchSession;
	}> {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const toolSession = createSession(manager, settings);
		const tool = await TaskTool.create(toolSession);
		const session = await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!session) throw new Error("expected a task launch session");
		return { tool, toolSession, manager, session: session as TaskLaunchSession };
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const events = spawn(id);
			startedIds.add(id);
			options.signal?.addEventListener(
				"abort",
				() => {
					events.aborted.resolve();
					events.release.resolve();
				},
				{ once: true },
			);
			events.started.resolve();
			await events.release.promise;
			return makeResult(id);
		});
	});

	afterEach(async () => {
		for (const events of spawns.values()) events.release.resolve();
		spawns.clear();
		startedIds.clear();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("starts each item as it closes and dispatch adopts the running agents", async () => {
		const { tool, manager, session } = await openSession();

		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;
		expect(startedIds.has("Beta")).toBe(false);

		session.finalize({ toolCall, args });
		await spawn("Beta").started.promise;

		const result = await tool.execute(toolCall.id, args);

		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(2);
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		spawn("Alpha").release.resolve();
		spawn("Beta").release.resolve();
		await manager.getJob("Alpha")!.promise;
		await manager.getJob("Beta")!.promise;
		expect(manager.getJob("Alpha")!.status).toBe("completed");
		expect(manager.getJob("Beta")!.status).toBe("completed");
	});

	it("adopts an empty model placeholder without changing the submitted arguments", async () => {
		const { tool, manager, session } = await openSession();
		const submitted = {
			context: "ctx",
			tasks: [{ name: "Alpha", agent: "task", task: "Do A.", model: [] as string[] }],
		};
		const original = structuredClone(submitted);
		session.update(toolCall, JSON.stringify(submitted));
		await spawn("Alpha").started.promise;
		session.finalize({ toolCall, args: submitted });
		const result = await tool.execute(toolCall.id, submitted);
		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual(original);
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha"]);
		spawn("Alpha").release.resolve();
		await manager.getJob("Alpha")!.promise;
		expect(manager.getJob("Alpha")!.status).toBe("completed");
	});

	it("aborts launched agents when the finished call is invalid", async () => {
		const { session } = await openSession();
		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;

		session.finalize({
			toolCall,
			args: {
				context: "ctx",
				tasks: [
					{ name: "Alpha", task: "Do A." },
					{ name: "alpha", task: "dup" },
				],
			},
		});

		await spawn("Alpha").aborted.promise;
		expect([...startedIds]).toEqual(["Alpha"]);
	});

	it("aborts launched agents when finished items differ from what launched", async () => {
		const { session } = await openSession();
		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;

		const changed = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", task: "Do something else." },
				{ name: "Beta", agent: "task", task: "Do B." },
			],
		};
		expect(session.matchesFinalArgs(changed)).toBe(false);
		session.finalize({ toolCall, args: changed });

		await spawn("Alpha").aborted.promise;
		expect([...startedIds]).toEqual(["Alpha"]);
	});

	it("launches nothing for a batch call with a top-level isolated, which dispatch refuses", async () => {
		const authorize = vi.spyOn(sink, "authorizeLaunch");
		const { tool, session } = await openSession();
		const call = { context: "ctx", isolated: true, tasks: args.tasks };
		const raw = JSON.stringify(call);
		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		// `adopt` awaits the launch queue, so a launch `update` scheduled has asked for authorization by now.
		await session.adopt([]);
		expect(authorize).not.toHaveBeenCalled();

		const result = await tool.execute(toolCall.id, call);
		expect(result.isError).toBe(true);
		expect(result.content.find(part => part.type === "text")?.text).toContain(
			"Top-level `isolated` is not part of the batch shape",
		);
	});

	// The launcher cannot see a key that has not streamed. While the session can isolate, an item
	// that names no `isolated` of its own therefore waits for dispatch instead of starting in the
	// user's checkout for a call whose top-level `isolated` may still arrive.
	it("launches nothing for items that name no isolated of their own while isolation is enabled", async () => {
		const authorize = vi.spyOn(sink, "authorizeLaunch");
		const { session } = await openSession({ "task.isolation.enabled": true });
		const call = { context: "ctx", tasks: args.tasks, isolated: true };
		const raw = JSON.stringify(call);
		// Both items have closed; the top-level key has not streamed yet, and cannot be read.
		session.update(toolCall, raw.slice(0, raw.indexOf(',"isolated"')));
		// `adopt` awaits the launch queue: anything scheduled has asked for authorization by now.
		await session.adopt([]);
		expect(authorize).not.toHaveBeenCalled();
		expect([...startedIds]).toEqual([]);
	});

	// The whole order, through dispatch: nothing has started, and the call is refused.
	it("refuses a batch call whose top-level isolated streams after its items", async () => {
		const authorize = vi.spyOn(sink, "authorizeLaunch");
		const { tool, manager, session } = await openSession({ "task.isolation.enabled": true });
		const call = { context: "ctx", tasks: args.tasks, isolated: true };
		const raw = JSON.stringify(call);
		session.update(toolCall, raw.slice(0, raw.indexOf(',"isolated"')));
		session.update(toolCall, raw);
		session.finalize({ toolCall, args: call });
		const result = await tool.execute(toolCall.id, call);
		await session.adopt([]);

		expect(authorize).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.content.find(part => part.type === "text")?.text).toContain(
			"Top-level `isolated` is not part of the batch shape",
		);
		expect(manager.getJob("Alpha")).toBeUndefined();
	});

	// With isolation off, no child can be isolated, so items still start early. The trailing key is
	// refused at dispatch, and the started items are aborted rather than run a second time.
	it("aborts, and does not re-run, items started before a trailing top-level isolated", async () => {
		const { tool, manager, session } = await openSession();
		const call = { context: "ctx", tasks: args.tasks, isolated: true };
		const raw = JSON.stringify(call);
		session.update(toolCall, raw.slice(0, raw.indexOf(',"isolated"')));
		// Both items closed in that chunk, so both launch; awaiting each start leaves nothing in
		// flight when the test ends, which would otherwise reach a later file's `runSubprocess` spy.
		await spawn("Alpha").started.promise;
		await spawn("Beta").started.promise;
		session.update(toolCall, raw);
		session.finalize({ toolCall, args: call });
		await spawn("Alpha").aborted.promise;
		await spawn("Beta").aborted.promise;

		const result = await tool.execute(toolCall.id, call);
		expect(result.isError).toBe(true);
		expect(result.content.find(part => part.type === "text")?.text).toContain(
			"Top-level `isolated` is not part of the batch shape",
		);
		// A re-run would be announced as `Alpha-2`; dispatch starts nothing.
		expect(manager.getJob("Alpha-2")).toBeUndefined();
		expect(manager.getJob("Beta-2")).toBeUndefined();
	});

	// The halt reads the top level only. `isolated` inside an item is the shape the refusal asks for,
	// so it must keep its early start: a halt on the text anywhere would cost every corrected retry.
	it("still starts an item that carries its own isolated while isolation is enabled", async () => {
		const authorize = vi.spyOn(sink, "authorizeLaunch");
		const { session } = await openSession({ "task.isolation.enabled": true });
		const call = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", task: "Do A.", isolated: false },
				{ name: "Beta", agent: "task", task: "Do B." },
			],
		};
		const raw = JSON.stringify(call);
		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		// The run reaching the executor is the contract: the item started while Beta still streamed.
		// Waiting for it also leaves nothing in flight; a bare queue barrier can return before the
		// run starts, and the run then reaches a later test file's `runSubprocess` spy.
		await spawn("Alpha").started.promise;
		expect(authorize).toHaveBeenCalledTimes(1);
		session.discard("test over");
		await spawn("Alpha").aborted.promise;
	});

	// The halt can land while a launch waits for authorization, so the wait is re-checked after it.
	it("does not start a launch whose authorization returns after the call halted", async () => {
		const asked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(sink, "authorizeLaunch").mockImplementation(async () => {
			asked.resolve();
			await release.promise;
			return { allowed: true };
		});
		const { toolSession, session } = await openSession();
		const call = { context: "ctx", tasks: args.tasks, isolated: true };
		const raw = JSON.stringify(call);
		session.update(toolCall, raw.slice(0, raw.indexOf(',"isolated"')));
		await asked.promise;
		// The key arrives while the first launch is still waiting for its answer.
		session.update(toolCall, raw);
		release.resolve();
		// `adopt` awaits the launch queue, so the answered launch has run to its end by now. Starting
		// one allocates its agent id, which is the step that puts an output manager on the session.
		await session.adopt([]);
		expect(toolSession.agentOutputManager).toBeUndefined();
		expect([...startedIds]).toEqual([]);
	});
});

describe("speculative launch authorization", () => {
	it("allows launches only under auto-allow approval without lifecycle handlers", async () => {
		const launch = { tool: { name: "task", approval: "exec" as const }, toolCall, args: { context: "ctx" } };
		const authorize = (approvalMode: string, handlers: boolean) => {
			const settings = Settings.isolated({ "tools.approvalMode": approvalMode });
			const session = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
			};
			return createSpeculativeToolExecutionConfig(settings, session, {
				hasHandlers: event => handlers && event === "tool_call",
			}).host?.authorizeLaunch?.(launch);
		};

		expect(await authorize("yolo", false)).toMatchObject({ allowed: true });
		expect(await authorize("yolo", true)).toMatchObject({ allowed: false });
		expect(await authorize("always-ask", false)).toMatchObject({ allowed: false });
	});
});
