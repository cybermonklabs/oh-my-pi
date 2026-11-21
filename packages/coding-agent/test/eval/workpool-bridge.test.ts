import { afterEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "../../src/async";
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

	it("records each worker it spawns as owed, on disk, before the worker starts", async () => {
		// If this regresses, a pool worker leaves no record: once the call that pushed the work has finished, a worker
		// whose key failed while its batch still ran is in no window, and `omp --restore` leaves it, though the pool's
		// owner still waits on its result.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const log: string[] = [];
		const started = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async () => {
			log.push("worker started");
			started.resolve();
			throw new Error("stop after dispatch");
		});
		const session: ToolSession = {
			...makeSession(),
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					const state = data && typeof data === "object" && "state" in data ? String(data.state) : "?";
					log.push(`append ${customType} ${state}`);
					return "entry";
				},
				flush: async () => {
					await Promise.resolve();
					log.push("flushed");
				},
			},
		} as unknown as ToolSession;
		await runEvalWorkpool({ op: "create", name: "owed", agent: "scout" }, { session });
		await runEvalWorkpool({ op: "push", name: "owed", items: ["one"] }, { session });
		await started.promise;

		expect(log).toEqual(["append eval-agent-job owed", "flushed", "worker started"]);
	});

	it("records a worker's handover when a peek returns its settled batch, and the rest when the drained pool hands its result over", async () => {
		// If this regresses, a pool worker's `owed` record is never settled: `omp --restore` relaunches a worker whose
		// failure the owner already got from the pool, and the owner gets that result twice.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const log: string[] = [];
		const calls: Array<string | undefined> = [];
		const second = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			calls.push(request.spawnCallId);
			// The second worker's batch runs on until the test lets it fail too.
			if (calls.length === 2) await second.promise;
			throw new Error("No API key for provider: anthropic");
		});
		const session: ToolSession = {
			...makeSession(),
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					const record = data as { agentId?: string; state?: string } | undefined;
					log.push(`${customType} ${record?.state} ${record?.agentId}`);
					return "entry";
				},
				flush: async () => {},
			},
		} as unknown as ToolSession;
		const options = { session, spawnCallId: "call_pool_eval" };
		await runEvalWorkpool({ op: "create", name: "handed", agent: "scout" }, options);
		await runEvalWorkpool({ op: "push", name: "handed", items: ["one", "two"] }, options);
		let peeked: { batches: Array<{ agent: string; status: string }> };
		const withStatus = (status: string) => peeked.batches.find(batch => batch.status === status)?.agent;
		for (;;) {
			peeked = (await runEvalWorkpool({ op: "peek", name: "handed" }, options)) as typeof peeked;
			if (withStatus("failed") && withStatus("running")) break;
			await Bun.sleep(5);
		}
		const [failed, running] = [withStatus("failed")!, withStatus("running")!];

		expect(log.filter(line => line.includes("delivered"))).toEqual([`eval-agent-job delivered ${failed}`]);

		const poolJob = session.asyncJobManager!.getJob("handed")!;
		second.resolve();
		await poolJob.promise;

		expect(log).toEqual([
			expect.stringMatching(/^eval-agent-job owed /),
			expect.stringMatching(/^eval-agent-job owed /),
			`eval-agent-job delivered ${failed}`,
			`eval-agent-job delivered ${running}`,
		]);
		// Each worker records the `eval` call that pushed its item as the call it was spawned under.
		expect(calls).toEqual(["call_pool_eval", "call_pool_eval"]);
	});
});
