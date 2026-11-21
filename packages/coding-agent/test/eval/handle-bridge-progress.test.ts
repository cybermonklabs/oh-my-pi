import { expect, setSystemTime, test, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "../../src/async";
import { EVAL_STATUS_BRIDGE_NAME, runEvalStatus, runEvalWait } from "../../src/eval/handle-bridge";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import type { ToolSession } from "../../src/tools";

/** A session manager that logs each eval job record appended and each flush, in order, into `log`. */
function loggingSessionManager(log: string[]) {
	return {
		appendCustomEntry: (customType: string, data?: unknown) => {
			log.push(`append ${customType} ${JSON.stringify(data)}`);
			return "entry";
		},
		flush: async () => {
			await Promise.resolve();
			log.push("flushed");
		},
	};
}

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

test("eval wait reports the agent result it hands the cell, and status reports none", async () => {
	// If this regresses, a `status()` or `done()` poll, which gives the cell only the run's state, reads to
	// `omp --restore` as the handover of a result the cell never got.
	const manager = new AsyncJobManager({});
	const id = manager.register("task", "Scout", async () => "done", {
		id: "settled-agent-result",
		ownerId: "Main",
		agentId: "Scout",
	});
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	await job.promise;
	const held: Array<{ id: string; handedAt?: number }> = [];
	const options = {
		session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
		onAgentResults: (results: Array<{ id: string; handedAt: number }>) => held.push(...results),
	};

	runEvalStatus({ item: { kind: "agent", id } }, options);
	expect(held).toEqual([]);
	const before = Date.now();
	await runEvalWait({ items: [{ kind: "agent", id }] }, options);
	expect(held).toEqual([{ id: "Scout", handedAt: expect.any(Number) }]);
	expect(held[0]!.handedAt).toBeGreaterThanOrEqual(before);
	await manager.dispose();
});

test("eval wait writes `delivered` once, to disk, before the cell gets a settled agent's result; status writes nothing", async () => {
	// If this regresses, a process that goes away after the cell read the result but before anything recorded it
	// leaves the job `owed`, and `omp --restore` runs a subagent whose result the parent already has; or a second
	// wait() moves the handover's time past a turn the parent then messaged the subagent for; or every status poll
	// writes a false handover and flushes the disk.
	const manager = new AsyncJobManager({});
	const ids = ["Waited", "Statused"].map(agentId =>
		manager.register("task", agentId, async () => "done", { id: agentId, ownerId: "Main", agentId }),
	);
	await Promise.all(ids.map(id => manager.getJob(id)?.promise));
	const log: string[] = [];
	const session = {
		asyncJobManager: manager,
		getAgentId: () => "Main",
		sessionManager: loggingSessionManager(log),
	} as unknown as ToolSession;

	await runEvalWait({ items: [{ kind: "agent", id: "Waited" }] }, { session });
	log.push("wait returned");
	await runEvalWait({ items: [{ kind: "agent", id: "Waited" }] }, { session });
	log.push("second wait returned");
	await callSessionTool(EVAL_STATUS_BRIDGE_NAME, { item: { kind: "agent", id: "Statused" } }, { session });
	log.push("status returned");

	expect(log).toEqual([
		'append eval-agent-job {"agentId":"Waited","state":"delivered"}',
		"flushed",
		"wait returned",
		"second wait returned",
		"status returned",
	]);
	await manager.dispose();
});

test("eval wait records a run's handover once, and names it with its first handover time, when the job manager returns a new job object on every read", async () => {
	// If this regresses, the worker thread's job manager, which builds a new job object for each read, defeats the
	// once-per-run check: each later wait() appends `delivered` again, or names the run in the eval result with a
	// later time, and either settles a follow-up turn the cell started between the two waits.
	const manager = new AsyncJobManager({});
	const id = manager.register("task", "Worker", async () => "done", {
		id: "Worker",
		ownerId: "Main",
		agentId: "Worker",
	});
	await manager.getJob(id)?.promise;
	const getJob = manager.getJob.bind(manager);
	vi.spyOn(manager, "getJob").mockImplementation(jobId => {
		const job = getJob(jobId);
		return job && { ...job };
	});
	const log: string[] = [];
	const session = {
		asyncJobManager: manager,
		getAgentId: () => "Main",
		sessionManager: loggingSessionManager(log),
	} as unknown as ToolSession;
	const held: Array<{ id: string; handedAt: number }> = [];
	const onAgentResults = (results: Array<{ id: string; handedAt: number }>) => held.push(...results);

	try {
		setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
		await runEvalWait({ items: [{ kind: "agent", id }] }, { session, onAgentResults });
		setSystemTime(new Date("2026-11-17T12:05:00.000Z"));
		await runEvalWait({ items: [{ kind: "agent", id }] }, { session, onAgentResults });
	} finally {
		setSystemTime();
	}

	expect(log).toEqual(['append eval-agent-job {"agentId":"Worker","state":"delivered"}', "flushed"]);
	const first = Date.parse("2026-11-17T12:00:00.000Z");
	expect(held).toEqual([
		{ id: "Worker", handedAt: first },
		{ id: "Worker", handedAt: first },
	]);
	await manager.dispose();
});

test("a concurrent eval wait of the same run waits for the first wait's record to reach the disk", async () => {
	// If this regresses, a second wait() that finds the handover being recorded returns at once: its caller takes the
	// result before the `delivered` record is durable, and a process that goes away then leaves the job `owed`.
	const manager = new AsyncJobManager({});
	const id = manager.register("task", "Worker", async () => "done", {
		id: "Worker",
		ownerId: "Main",
		agentId: "Worker",
	});
	await manager.getJob(id)?.promise;
	const log: string[] = [];
	const disk = Promise.withResolvers<void>();
	const session = {
		asyncJobManager: manager,
		getAgentId: () => "Main",
		sessionManager: {
			appendCustomEntry: (customType: string, data?: unknown) => {
				log.push(`append ${customType} ${JSON.stringify(data)}`);
				return "entry";
			},
			flush: async () => {
				await disk.promise;
				log.push("flushed");
			},
		},
	} as unknown as ToolSession;

	const first = runEvalWait({ items: [{ kind: "agent", id }] }, { session }).then(() =>
		log.push("first wait returned"),
	);
	const second = runEvalWait({ items: [{ kind: "agent", id }] }, { session }).then(() =>
		log.push("second wait returned"),
	);
	// A real wait, on purpose: the test shows that no wait returns while the disk is held, an absence no event
	// signals. A wait that returns early has this long to do so; under load the test can only miss it, not fail falsely.
	await Bun.sleep(50);
	log.push("disk done");
	disk.resolve();
	await Promise.all([first, second]);

	expect(log.slice(0, 2)).toEqual(['append eval-agent-job {"agentId":"Worker","state":"delivered"}', "disk done"]);
	expect(log.slice(2).sort()).toEqual(["first wait returned", "flushed", "second wait returned"].sort());
	expect(log.indexOf("flushed")).toBeLessThan(log.indexOf("second wait returned"));
	await manager.dispose();
});

test("a bridged tool.task records each background spawn it starts as owed before the cell goes on", async () => {
	// If this regresses, a background spawn a cell starts through `tool.task` leaves no record: its "started" result
	// settles no run, so a process that goes away before the spawn's result reaches the parent leaves a subagent
	// `omp --restore` never relaunches, though the parent never got its result.
	const log: string[] = [];
	const taskTool: AgentTool = {
		name: "task",
		label: "Task",
		description: "Runs subagents",
		parameters: type({}),
		async execute() {
			log.push("task ran");
			return {
				content: [{ type: "text", text: "Started background job Worker." }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 5,
					progress: [{ index: 0, id: "Worker", agent: "task", agentSource: "user", status: "running", task: "t" }],
					async: { state: "running", jobId: "Worker", type: "task" },
				},
			};
		},
	};
	const session = {
		getAgentId: () => "Main",
		sessionManager: loggingSessionManager(log),
		getToolByName: (name: string) => (name === "task" ? taskTool : undefined),
	} as unknown as ToolSession;
	const held: Array<{ id: string }> = [];

	await callSessionTool("task", {}, { session, onAgentResults: results => held.push(...results) });
	log.push("cell went on");

	expect(log).toEqual([
		"task ran",
		'append eval-agent-job {"agentId":"Worker","state":"owed"}',
		"flushed",
		"cell went on",
	]);
	expect(held).toEqual([]);
});

test("a bridged tool.wait records each subagent result it hands the cell before the cell gets it", async () => {
	// If this regresses, a result a cell takes through `tool.wait` reaches no record `omp --restore` reads: an
	// `agent()` job stays `owed` and a background `task` spawn stays "started", so the subagent runs again for a
	// parent that already acted on its failure.
	const manager = new AsyncJobManager({});
	const id = manager.register("task", "Worker", async () => "done", {
		id: "Worker",
		ownerId: "Main",
		agentId: "Worker",
	});
	await manager.getJob(id)?.promise;
	const log: string[] = [];
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Waits for background jobs",
		parameters: type({}),
		async execute() {
			log.push("wait ran");
			return {
				content: [{ type: "text", text: "Worker failed." }],
				details: {
					op: "wait",
					jobs: [
						{
							id: "Worker",
							type: "task",
							status: "failed",
							label: "Worker",
							durationMs: 5,
							agentUrlId: "Worker",
						},
						{ id: "Busy", type: "task", status: "running", label: "Busy", durationMs: 5, agentUrlId: "Busy" },
						{ id: "bash-1", type: "bash", status: "completed", label: "ls", durationMs: 5 },
					],
				},
			};
		},
	};
	const session = {
		asyncJobManager: manager,
		getAgentId: () => "Main",
		sessionManager: loggingSessionManager(log),
		getToolByName: (name: string) => (name === "wait" ? waitTool : undefined),
	} as unknown as ToolSession;
	const held: Array<{ id: string; handedAt?: number }> = [];
	const onAgentResults = (results: Array<{ id: string; handedAt?: number }>) => held.push(...results);

	await callSessionTool("wait", {}, { session, onAgentResults });
	log.push("cell got the result");
	await callSessionTool("wait", {}, { session, onAgentResults });
	log.push("cell got it again");

	expect(log).toEqual([
		"wait ran",
		'append eval-agent-job {"agentId":"Worker","state":"delivered"}',
		"flushed",
		"cell got the result",
		"wait ran",
		"cell got it again",
	]);
	expect(held).toEqual([
		{ id: "Worker", handedAt: expect.any(Number) },
		{ id: "Worker", handedAt: expect.any(Number) },
	]);
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
