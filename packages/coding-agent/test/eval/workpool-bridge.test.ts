import { afterEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as discovery from "../../src/task/discovery";
import * as structured from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();

function makeSession(settings: Record<string, unknown> = {}): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			...settings,
		}),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	};
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toThrow("arguments must be an object");
		await expect(runEvalWorkpool({}, { session })).rejects.toThrow("requires an op");
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toThrow(
			"agent must be a non-empty string",
		);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toThrow(
			"requires a non-empty name",
		);
	});

	it("rejects unknown pool names", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toThrow(
			'unknown workpool "missing"',
		);
	});

	it("creates unique default names and validates push and peek arguments", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSession();
		const events: Array<Record<string, unknown>> = [];
		const first = await runEvalWorkpool(
			{ op: "create", agent: "scout" },
			{ session, emitStatus: event => events.push(event) },
		);
		const second = await runEvalWorkpool({ op: "create", agent: "scout" }, { session });
		expect(first).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(second).toEqual({ name: "scout-pool-2", agent: "scout", limit: 2 });
		expect(events).toEqual([{ op: "workpool", action: "create", pool: "scout-pool", count: 2 }]);
		await expect(runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session })).rejects.toThrow(
			"items string array",
		);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toThrow(
			'unknown workpool operation "wait"',
		);
	});
});

describe("workpool model validation", () => {
	it("eval mode admits an approved pinned worker and rejects an unapproved model before creating a pool", async () => {
		const approved = createMockModel();
		const unapproved = createMockModel({ id: "unapproved" });
		// A project agent's frontmatter never grants its own model.
		const agent: AgentDefinition = { ...SCOUT, source: "project", model: ["mock/unapproved"] };
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const session = Object.assign(
			makeSession({ "task.perCallModel": "eval", modelRoles: { review: "mock/mock-model" } }),
			{ modelRegistry: { getAll: () => [approved, unapproved], getAvailable: () => [approved, unapproved] } },
		);
		await expect(
			runEvalWorkpool({ op: "create", name: "denied", agent: "scout", model: "mock/unapproved" }, { session }),
		).rejects.toThrow(/not approved/);
		expect(WorkPoolRegistry.global().get("Main", "denied")).toBeUndefined();
		await expect(
			runEvalWorkpool({ op: "create", name: "approved", agent: "scout", model: "mock/mock-model" }, { session }),
		).resolves.toEqual({ name: "approved", agent: "scout", limit: 2 });
	});

	for (const { mode, model, reason } of [
		// The gate wins over the selector check, so an invalid selector still reports the disabled gate.
		{ mode: "off", model: "@smol", reason: /task\.perCallModel: off/ },
		{ mode: "on", model: "@smol", reason: /invalid `model` value/ },
	]) {
		it(`rejects ${JSON.stringify(model)} under ${mode} before registering a pool`, async () => {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
			const session = makeSession({ "task.perCallModel": mode });
			await expect(
				runEvalWorkpool({ op: "create", name: "invalid", agent: "scout", model }, { session }),
			).rejects.toThrow(reason);
			expect(WorkPoolRegistry.global().get("Main", "invalid")).toBeUndefined();
		});
	}

	it.each(["", "   "])("treats a blank model (%p) as omitted", async model => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const requested = Promise.withResolvers<unknown>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			requested.resolve(request.perCallModel);
			throw new Error("stop after dispatch");
		});
		// The gate stays off: no per-call route may reach the pool or its workers.
		const session = makeSession({ "task.perCallModel": "off" });

		await runEvalWorkpool({ op: "create", name: "blank", agent: "scout", model }, { session });
		await runEvalWorkpool({ op: "push", name: "blank", items: ["one"] }, { session });

		expect(await requested.promise).toBeUndefined();
	});

	// Losing the selector between bridge and pool would silently run workers on the agent's own model.
	it("hands the pool selector to workers", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const requested = Promise.withResolvers<unknown>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			requested.resolve(request.perCallModel);
			throw new Error("stop after dispatch");
		});
		const session = makeSession({ "task.perCallModel": "eval", modelRoles: { smol: "p/small" } });
		const model = "p/small";
		await runEvalWorkpool({ op: "create", name: "picked", agent: "scout", model }, { session });
		await runEvalWorkpool({ op: "push", name: "picked", items: ["one"] }, { session });
		expect(await requested.promise).toEqual(model);
	});
});

describe("workpool records for omp --restore", () => {
	it("records each worker before its run, and hands over a settled batch through peek() and the pool's job, not status()", async () => {
		// If this regresses, a pool worker leaves no record in its parent's transcript, so `omp --restore` cannot tell
		// a worker the parent still waits on from one whose result it got; or a `peek()` that showed the cell the
		// worker's failure, or the pool's own job, hands it over unrecorded and the worker runs again. The pool's job
		// dates its handovers when it drains, not when its delivery or a `wait` is written later.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async () => {
			throw new Error("No API key for provider: anthropic");
		});
		const records: unknown[] = [];
		const session: ToolSession = {
			...makeSession(),
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					if (customType === "task_spawn") records.push(data);
					return `entry-${records.length}`;
				},
			} as unknown as ToolSession["sessionManager"],
		};
		await runEvalWorkpool({ op: "create", name: "notes", agent: "scout" }, { session });
		const pushedAt = Date.now();
		await runEvalWorkpool({ op: "push", name: "notes", items: ["one"] }, { session });
		const poolJob = session.asyncJobManager?.getJob("notes");
		await poolJob?.promise;
		const drainedBy = Date.now();

		expect(records).toHaveLength(1);
		const worker = (records[0] as { id: string }).id;
		const held: unknown[] = [];
		await runEvalWorkpool(
			{ op: "status", name: "notes" },
			{ session, onAgentResults: results => held.push(...results) },
		);
		expect(held).toEqual([]);
		await runEvalWorkpool(
			{ op: "peek", name: "notes" },
			{ session, onAgentResults: results => held.push(...results) },
		);
		expect(held).toEqual([{ id: worker }]);
		const [reported] = (poolJob?.latestDetails?.agentResults ?? []) as Array<{ id: string; at?: number }>;
		expect(reported).toEqual({ id: worker, at: expect.any(Number) });
		expect(reported!.at!).toBeGreaterThanOrEqual(pushedAt);
		expect(reported!.at!).toBeLessThanOrEqual(drainedBy);
	});

	it("passes a shutdown of the pool's job on to its workers as a shutdown, and a cancel as a cancel", async () => {
		// If this regresses, the pool cancels its workers' batches with no reason when its own job aborts for the
		// process exit: a worker waiting to retry its key ends its turn as stopped, and `omp --restore` leaves it.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		let started = Promise.withResolvers<void>();
		let aborted = Promise.withResolvers<unknown>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const signal = request.signal;
			started.resolve();
			await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
			aborted.resolve(signal?.reason);
			throw signal?.reason;
		});
		const reasons: Record<string, unknown> = {};
		for (const name of ["shutdown", "cancel"]) {
			started = Promise.withResolvers<void>();
			aborted = Promise.withResolvers<unknown>();
			const session = makeSession();
			await runEvalWorkpool({ op: "create", name, agent: "scout" }, { session });
			await runEvalWorkpool({ op: "push", name, items: ["one"] }, { session });
			await started.promise;
			const manager = session.asyncJobManager!;
			// The pool's job was registered before its worker's batch, so a shutdown reaches it first.
			if (name === "shutdown") manager.cancelAll(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
			else manager.cancel(name);
			reasons[name] = await aborted.promise;
		}

		expect(reasons.shutdown).toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		expect(reasons.cancel).toBeInstanceOf(DOMException);
	});
});
