import { expect, test } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { runEvalStatus, runEvalWait } from "../../src/eval/handle-bridge";
import type { ToolSession } from "../../src/tools";
import { evalHeldAgentResults } from "../../src/tools/eval";

test("an eval cell keeps each subagent's latest handover, whatever order the bridged calls report them in", () => {
	// If this regresses, a background eval job that reports an older handover (its own cell's time) after a newer
	// `peek()` handover overwrites it: `omp --restore` reads the turn the subagent began between the two as a new
	// run and relaunches work whose result the parent already got. The eval tool records its bridged calls'
	// handovers through this recorder (`EvalTool.execute`).
	const clock = [3_000, 4_000, 5_000];
	const held = evalHeldAgentResults(() => clock.shift() ?? Number.NaN);
	expect(held.list()).toBeUndefined();
	held.onAgentResults([{ id: "Pool-1" }]);
	held.onAgentResults([
		{ id: "Pool-1", at: 1_000 },
		{ id: "Worker", at: 2_000 },
	]);
	held.onAgentResults([{ id: "Worker", at: 2_500, aborted: true }]);

	expect(held.list()).toEqual([
		{ id: "Pool-1", at: 3_000 },
		{ id: "Worker", at: 2_500, aborted: true },
	]);
});

test("settled eval progress is emitted once", async () => {
	const manager = new AsyncJobManager({});
	const progress = { status: "completed", assignment: "investigate", toolCount: 7 };
	const id = manager.register(
		"task",
		"Scout",
		async ({ reportProgress }) => {
			await reportProgress("done", { progress: [progress] });
			return "done";
		},
		{ id: "settled-progress", ownerId: "Main", agentId: "Scout" },
	);
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	await job.promise;
	const events: Array<{ op: string }> = [];
	await runEvalWait(
		{ items: [{ kind: "agent", id }] },
		{
			session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
			emitStatus: event => events.push(event),
		},
	);
	expect(events.filter(event => event.op === "agent")).toHaveLength(1);
	await manager.dispose();
});

test("records the settled agent handle a wait() hands an eval cell, not one a status poll reads", async () => {
	// If this regresses, a `status()` or `done()` poll, which gives the cell only the status, reads as a handover:
	// `omp --restore` then takes the parent for holding a result its cell never got.
	const manager = new AsyncJobManager({});
	const id = manager.register("task", "Worker", async () => "failed", {
		id: "worker-job",
		ownerId: "Main",
		agentId: "Worker",
	});
	await manager.getJob(id)?.promise;
	const session = { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession;
	const held: Array<{ id: string }> = [];

	const polled = runEvalStatus(
		{ item: { kind: "agent", id } },
		{ session, onAgentResults: results => held.push(...results) },
	);
	expect(polled.status).toBe("completed");
	expect(held).toEqual([]);

	await runEvalWait({ items: [{ kind: "agent", id }] }, { session, onAgentResults: results => held.push(...results) });
	expect(held).toEqual([{ id: "Worker" }]);
	await manager.dispose();
});

test("each awaited batch job reports its own agent's progress (issue #18393)", async () => {
	const manager = new AsyncJobManager({});
	// A batch `task` call shares one progress array across its jobs.
	const batch = [
		{ id: "Alpha", status: "running", assignment: "alpha work", toolCount: 1 },
		{ id: "Beta", status: "running", assignment: "beta work", toolCount: 9 },
	];
	const ids = ["Alpha", "Beta"].map(agentId =>
		manager.register(
			"task",
			agentId,
			async ({ reportProgress }) => {
				await reportProgress("done", { progress: batch });
				return "done";
			},
			{ id: agentId, ownerId: "Main", agentId },
		),
	);
	await Promise.all(ids.map(id => manager.getJob(id)?.promise));
	const events: Array<{ op: string; id?: string; toolCount?: number; taskPreview?: string }> = [];
	await runEvalWait(
		{ items: ids.map(id => ({ kind: "agent", id })) },
		{
			session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
			emitStatus: event => events.push(event),
		},
	);
	const rows = events
		.filter(event => event.op === "agent")
		.map(({ id, toolCount, taskPreview }) => ({ id, toolCount, taskPreview }));
	expect(rows).toEqual([
		{ id: "Alpha", toolCount: 1, taskPreview: "alpha work" },
		{ id: "Beta", toolCount: 9, taskPreview: "beta work" },
	]);
	await manager.dispose();
});

test("agent progress events keep scalar fields and cut long text", async () => {
	const manager = new AsyncJobManager({});
	const assignment = `Review the parser\n${"x".repeat(20_000)}`;
	const progress = {
		status: "completed",
		assignment,
		task: assignment,
		toolCount: 26,
		cost: 0.0177,
		advisor: false,
		resolvedModelIdentity: "anthropic/claude-haiku-5-5",
		extractedToolData: { yield: [{ data: "y".repeat(50_000) }] },
		recentTools: [{ tool: "read", args: "z".repeat(5_000) }],
		recentOutput: ["line"],
	};
	const id = manager.register(
		"task",
		"Scout",
		async ({ reportProgress }) => {
			await reportProgress("done", { progress: [progress] });
			return "done";
		},
		{ id: "large-progress", ownerId: "Main", agentId: "Scout" },
	);
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	await job.promise;
	const events: Array<Record<string, unknown>> = [];
	try {
		await runEvalWait(
			{ items: [{ kind: "agent", id }] },
			{
				session: { asyncJobManager: manager, getAgentId: () => "Main" } as unknown as ToolSession,
				emitStatus: event => events.push(event),
			},
		);
		const [event] = events.filter(candidate => candidate.op === "agent");
		expect(event).toMatchObject({
			op: "agent",
			id: "Scout",
			status: "completed",
			toolCount: 26,
			cost: 0.0177,
			advisor: false,
			resolvedModelIdentity: "anthropic/claude-haiku-5-5",
			taskPreview: "Review the parser",
		});
		expect(event).not.toHaveProperty("extractedToolData");
		expect(event).not.toHaveProperty("recentTools");
		expect(event).not.toHaveProperty("recentOutput");
		expect(event).not.toHaveProperty("assignment");
		expect(event).not.toHaveProperty("task");
		expect(JSON.stringify(event).length).toBeLessThan(1_500);
	} finally {
		await manager.dispose();
	}
});

test("timeouts past the 32-bit timer limit do not fire instantly (issue #12375)", async () => {
	const manager = new AsyncJobManager({});
	const id = manager.register(
		"task",
		"Scout",
		async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
			return "done";
		},
		{ id: "slow-settle", ownerId: "Main", agentId: "Scout" },
	);
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	const startedAt = Date.now();
	try {
		// Pre-fix the overflowing timer fired in ~1ms and the wait resolved as
		// "timeout" while the job was still running; now the natural settle at
		// ~200ms must win instead.
		const result = await runEvalWait(
			{ items: [{ kind: "agent", id }], timeoutMs: 2_400_000_000 },
			{
				session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
				emitStatus: () => {},
			},
		);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
		expect(result.items[0]).toMatchObject({ status: "completed" });
	} finally {
		await manager.dispose();
	}
});
