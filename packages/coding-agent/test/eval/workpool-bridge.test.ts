import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { plainTurnAbortReason } from "../../src/session/exit-diagnostics";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import * as discovery from "../../src/task/discovery";
import * as executor from "../../src/task/executor";
import * as structured from "../../src/task/structured-subagent";
import { readDiscardedLaunch } from "../../src/task/speculative-launch";
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

	it("records a peek's handover of a worker's settled batch, and names every worker in the drained pool's report instead of a record", async () => {
		// If this regresses, the drained pool writes each worker's handover before its aggregate result reaches the
		// owner (which holds it in memory until a step boundary), so a process end in between leaves a worker whose
		// failure the owner never got, and `omp --restore` does not relaunch it.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const log: string[] = [];
		const calls: Array<string | undefined> = [];
		const second = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			calls.push(request.spawnCallId);
			// The second worker's batch runs on until the test lets it fail too.
			if (calls.length === 2) {
				secondStarted.resolve();
				await second.promise;
			}
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
		await secondStarted.promise;
		// The first worker's batch, dispatched first, failed at once: its job settles after the pool recorded that.
		const firstBatch = WorkPoolRegistry.global().get("Main", "handed")!.batches[0]!;
		await session.asyncJobManager!.getJob(firstBatch.jobId)?.promise.catch(() => {});
		const peeked = (await runEvalWorkpool({ op: "peek", name: "handed" }, options)) as {
			batches: Array<{ agent: string; status: string }>;
		};
		const withStatus = (status: string) => peeked.batches.find(batch => batch.status === status)?.agent;
		const [failed, running] = [withStatus("failed")!, withStatus("running")!];
		expect(failed).toBe(firstBatch.agentId);
		expect(running).toBeDefined();

		expect(log.filter(line => line.includes("delivered"))).toEqual([`eval-agent-job delivered ${failed}`]);

		const poolJob = session.asyncJobManager!.getJob("handed")!;
		second.resolve();
		await poolJob.promise.catch(() => {});

		expect(log).toEqual([
			expect.stringMatching(/^eval-agent-job owed /),
			expect.stringMatching(/^eval-agent-job owed /),
			`eval-agent-job delivered ${failed}`,
		]);
		expect(poolJob.latestDetails?.agentResults).toEqual([{ id: failed }, { id: running }]);
		// Each worker records the `eval` call that pushed its item as the call it was spawned under.
		expect(calls).toEqual(["call_pool_eval", "call_pool_eval"]);
	});

	it("records no handover when a peek shows a kept-alive worker's earlier batch while its newer one runs", async () => {
		// If this regresses, the peek settles the turn the worker still owes: once that batch fails on its key and
		// the process ends, `omp --restore` reads the worker as handed over and leaves it.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const log: string[] = [];
		const secondTurn = Promise.withResolvers<void>();
		const secondTurnStarted = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			// The worker stays parked between turns, so the pool reuses it for the queued item.
			AgentRegistry.global().register({
				id: request.identity!.id!,
				displayName: request.identity!.id!,
				kind: "sub",
				session: null,
				status: "parked",
			});
			throw new Error("No API key for provider: anthropic");
		});
		vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async () => {
			secondTurnStarted.resolve();
			await secondTurn.promise;
			throw new Error("No API key for provider: anthropic");
		});
		const session: ToolSession = {
			...makeSession({ "task.maxConcurrency": 1 }),
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					const record = data as { agentId?: string; state?: string } | undefined;
					log.push(`${customType} ${record?.state} ${record?.agentId}`);
					return "entry";
				},
				flush: async () => {},
			},
		} as unknown as ToolSession;
		await runEvalWorkpool({ op: "create", name: "reused", agent: "scout" }, { session });
		await runEvalWorkpool({ op: "push", name: "reused", items: ["one", "two"] }, { session });
		// The follow-up turn runs inside the worker's second batch, which the pool started after the first one failed.
		await secondTurnStarted.promise;
		const peeked = (await runEvalWorkpool({ op: "peek", name: "reused" }, { session })) as {
			batches: Array<{ id: string; agent: string; status: string }>;
		};

		expect(peeked.batches.map(batch => batch.status)).toEqual(["failed", "running"]);
		expect(log.filter(line => line.includes("delivered"))).toEqual([]);

		secondTurn.resolve();
		await session.asyncJobManager!.getJob("reused")!.promise.catch(() => {});
	});

	it("records a kept-alive worker's later batch owed for the call that pushed its item, before the turn starts", async () => {
		// If this regresses, a kept-alive worker records only the call that pushed its first item: when the process
		// ends inside the later call, `omp --restore` relaunches the worker and runs that call again beside it.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const log: string[] = [];
		const secondTurn = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			AgentRegistry.global().register({
				id: request.identity!.id!,
				displayName: request.identity!.id!,
				kind: "sub",
				session: null,
				status: "parked",
			});
			throw new Error("No API key for provider: anthropic");
		});
		vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async () => {
			log.push("second turn started");
			secondTurn.resolve();
			throw new Error("No API key for provider: anthropic");
		});
		const session: ToolSession = {
			...makeSession({ "task.maxConcurrency": 1 }),
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					const record = data as { agentId?: string; state?: string; spawnCallIds?: string[] } | undefined;
					log.push(`${customType} ${record?.state} ${record?.spawnCallIds?.join(",") ?? "-"}`);
					return "entry";
				},
				flush: async () => {},
			},
		} as unknown as ToolSession;
		await runEvalWorkpool({ op: "create", name: "calls", agent: "scout" }, { session, spawnCallId: "call_1" });
		await runEvalWorkpool({ op: "push", name: "calls", items: ["one"] }, { session, spawnCallId: "call_1" });
		await runEvalWorkpool({ op: "push", name: "calls", items: ["two"] }, { session, spawnCallId: "call_2" });
		await secondTurn.promise;

		expect(log).toEqual(["eval-agent-job owed -", "eval-agent-job owed call_2", "second turn started"]);
		await session.asyncJobManager!.getJob("calls")!.promise.catch(() => {});
	});

	for (const [how, reason, discarded] of [
		["a stop", plainTurnAbortReason("stop"), true],
		["control: the session manager's shutdown", ASYNC_JOB_MANAGER_SHUTDOWN_REASON, false],
	] as const) {
		it(`${discarded ? "records" : "does not record"} each worker's spawn discarded on ${how} of the pool`, async () => {
			// If this regresses, a stop (a kill, the user's stop) cancels only the batches still running: a worker whose
			// batch already failed on its key stays owed, and `omp --restore` relaunches it for a pool its owner stopped.
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
			const log: string[] = [];
			const started = Promise.withResolvers<void>();
			vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
				started.resolve();
				await new Promise<void>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				throw new Error("unreachable");
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
					// Every record is appended as entry "entry", so the live transcript holds the pool's spawn records.
					getEntries: () => [{ id: "entry" }],
				},
			} as unknown as ToolSession;
			await runEvalWorkpool({ op: "create", name: "stopped", agent: "scout" }, { session });
			await runEvalWorkpool({ op: "push", name: "stopped", items: ["one"] }, { session });
			await started.promise;
			const worker = WorkPoolRegistry.global().get("Main", "stopped")!.agents[0]!.id;
			session.asyncJobManager!.cancel("stopped", { ownerId: "Main" }, reason);
			await session.asyncJobManager!.getJob("stopped")?.promise.catch(() => {});

			expect(log.filter(line => line.startsWith("task-launch-discarded"))).toEqual(
				discarded ? [`task-launch-discarded undefined ${worker}`] : [],
			);
		});
	}

	it("records a fresh worker discarded on a stop after its batch failed on its key and it left the pool", async () => {
		// If this regresses, the stop discards only the workers the pool still keeps: with fresh agents a worker leaves
		// the pool when its batch settles, so the one whose turn already failed on its key stays owed, and
		// `omp --restore` relaunches it for a pool its owner stopped.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const log: string[] = [];
		const secondStarted = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			calls += 1;
			if (calls === 1) throw new Error("No API key for provider: anthropic");
			secondStarted.resolve();
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			throw new Error("unreachable");
		});
		const session: ToolSession = {
			...makeSession({ "eval.workpool.freshAgents": true }),
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					const record = data as { agentId?: string; state?: string } | undefined;
					log.push(`${customType} ${record?.state} ${record?.agentId}`);
					return "entry";
				},
				flush: async () => {},
				// Every record is appended as entry "entry", so the live transcript holds the pool's spawn records.
				getEntries: () => [{ id: "entry" }],
			},
		} as unknown as ToolSession;
		await runEvalWorkpool({ op: "create", name: "fresh", agent: "scout" }, { session });
		await runEvalWorkpool({ op: "push", name: "fresh", items: ["one", "two"] }, { session });
		await secondStarted.promise;
		const pool = WorkPoolRegistry.global().get("Main", "fresh")!;
		const [failedBatch, runningBatch] = pool.batches;
		await session.asyncJobManager!.getJob(failedBatch!.jobId)?.promise.catch(() => {});
		expect(pool.agents.map(agent => agent.id)).not.toContain(failedBatch!.agentId);
		session.asyncJobManager!.cancel("fresh", { ownerId: "Main" }, plainTurnAbortReason("stop"));
		await session.asyncJobManager!.getJob("fresh")?.promise.catch(() => {});

		expect(log.filter(line => line.startsWith("task-launch-discarded")).sort()).toEqual(
			[
				`task-launch-discarded undefined ${failedBatch!.agentId}`,
				`task-launch-discarded undefined ${runningBatch!.agentId}`,
			].sort(),
		);
	});

	it("records the workers of a pool a session switch stopped in the pool's own transcript, not the resumed one", async () => {
		// If this regresses, a switch to another session moves the live session manager before it stops the pool, so
		// the discards land in the resumed transcript (where they can shadow its own ids) and the old one keeps its
		// key-stranded worker owed for `omp --restore`.
		using dir = TempDir.createSync("@pi-pool-switch-");
		const sessions = path.join(dir.path(), "sessions");
		// Both sessions are on disk, as a session whose turn ran a pool is (a session file is written lazily, from its
		// first assistant message, so these user-only test sessions are forced onto disk).
		const resumed = SessionManager.create(dir.path(), sessions);
		await resumed.ensureOnDisk();
		resumed.appendMessage({ role: "user", content: "another session", timestamp: Date.now() });
		await resumed.flush();
		const resumedFile = resumed.getSessionFile()!;
		await resumed.close();
		const live = SessionManager.create(dir.path(), sessions);
		await live.ensureOnDisk();
		live.appendMessage({ role: "user", content: "run the pool", timestamp: Date.now() });
		await live.flush();
		const ownFile = live.getSessionFile()!;
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const started = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			throw new Error("unreachable");
		});
		const session: ToolSession = {
			...makeSession(),
			sessionManager: live,
			getSessionFile: () => live.getSessionFile() ?? null,
		} as unknown as ToolSession;
		await runEvalWorkpool({ op: "create", name: "switched", agent: "scout" }, { session });
		await runEvalWorkpool({ op: "push", name: "switched", items: ["one"] }, { session });
		await started.promise;
		const worker = WorkPoolRegistry.global().get("Main", "switched")!.agents[0]!.id;
		// switchSession moves the live manager to the resumed file, then stops the outgoing session's jobs.
		await live.setSessionFile(resumedFile);
		session.asyncJobManager!.cancel("switched", { ownerId: "Main" }, plainTurnAbortReason("stop"));
		await session.asyncJobManager!.getJob("switched")?.promise.catch(() => {});
		await live.flush();

		const discarded = (entries: readonly SessionEntry[]) =>
			entries.flatMap(entry => {
				const id = readDiscardedLaunch(entry);
				return id ? [id] : [];
			});
		expect(discarded(live.getEntries())).toEqual([]);
		await live.close();
		const own = await SessionManager.open(ownFile, undefined, undefined, { suppressBreadcrumb: true });
		expect(discarded(own.getEntries())).toEqual([worker]);
		await own.close();
	});

	/**
	 * A pool `name` of one worker whose run waits until it is stopped, made in a session on disk whose live manager
	 * is `live` (in `dir`); resolves once the worker runs, with the worker's id and the session the pool runs in.
	 */
	async function runningPoolIn(live: SessionManager, name: string) {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const started = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			throw new Error("unreachable");
		});
		const session: ToolSession = {
			...makeSession(),
			sessionManager: live,
			getSessionFile: () => live.getSessionFile() ?? null,
		} as unknown as ToolSession;
		await runEvalWorkpool({ op: "create", name, agent: "scout" }, { session });
		await runEvalWorkpool({ op: "push", name, items: ["one"] }, { session });
		await started.promise;
		const worker = WorkPoolRegistry.global().get("Main", name)!.agents[0]!.id;
		return { worker, session };
	}

	const discardedIn = (entries: readonly SessionEntry[]) =>
		entries.flatMap(entry => {
			const id = readDiscardedLaunch(entry);
			return id ? [id] : [];
		});

	async function stopPool(session: ToolSession, name: string): Promise<void> {
		session.asyncJobManager!.cancel(name, { ownerId: "Main" }, plainTurnAbortReason("stop"));
		await session.asyncJobManager!.getJob(name)?.promise.catch(() => {});
	}

	it("records the workers of a pool stopped after /fork in the fork the user goes on with, and in the session it was forked from", async () => {
		// If this regresses, the discards are chosen by the pool's file path: after a whole-session fork they land only
		// in the pre-fork file, and the fork the user continues keeps the workers' spawn records with no discard, so
		// `omp --restore` of it relaunches a worker of a pool the user stopped.
		using dir = TempDir.createSync("@pi-pool-fork-");
		const live = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		await live.ensureOnDisk();
		live.appendMessage({ role: "user", content: "run the pool", timestamp: Date.now() });
		await live.flush();
		const { worker, session } = await runningPoolIn(live, "forked");
		const forked = await live.fork();
		await stopPool(session, "forked");
		await live.flush();

		expect(discardedIn(live.getEntries())).toEqual([worker]);
		await live.close();
		const before = await SessionManager.open(forked!.oldSessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		expect(discardedIn(before.getEntries())).toEqual([worker]);
		await before.close();
	});

	it("records the workers of a pool stopped after two branches from entries in every session that holds its spawns", async () => {
		// If this regresses, the session manager remembers only the last session it left (or none for a branch from
		// an entry): the middle session B, left for C, keeps the workers' spawn records with no discard, and
		// `omp --restore` of it relaunches a worker of a pool the user stopped.
		using dir = TempDir.createSync("@pi-pool-entry-branches-");
		const live = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		await live.ensureOnDisk();
		live.appendMessage({ role: "user", content: "run the pool", timestamp: Date.now() });
		await live.flush();
		const fileA = live.getSessionFile()!;
		const { worker, session } = await runningPoolIn(live, "branched");
		// AgentSession branches first and stops the session's jobs after, so the new session holds the spawn records.
		live.createBranchedSession(live.appendMessage({ role: "user", content: "branch here", timestamp: Date.now() }));
		await live.flush();
		const fileB = live.getSessionFile()!;
		live.createBranchedSession(live.appendMessage({ role: "user", content: "and here", timestamp: Date.now() }));
		await live.flush();
		expect(new Set([fileA, fileB, live.getSessionFile()]).size).toBe(3);
		await stopPool(session, "branched");
		await live.flush();

		expect(discardedIn(live.getEntries())).toEqual([worker]);
		await live.close();
		for (const file of [fileA, fileB]) {
			const left = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
			expect(discardedIn(left.getEntries())).toEqual([worker]);
			await left.close();
		}
	});

	it("records the workers of a pool stopped after the session moved in the moved session, and makes no file at the old path", async () => {
		// If this regresses, the discards go to the pool's old path, which the move left empty: nothing is written,
		// and `omp --restore` of the moved session relaunches a worker of a pool the user stopped.
		using dir = TempDir.createSync("@pi-pool-move-");
		const live = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		await live.ensureOnDisk();
		live.appendMessage({ role: "user", content: "run the pool", timestamp: Date.now() });
		await live.flush();
		const oldFile = live.getSessionFile()!;
		const { worker, session } = await runningPoolIn(live, "moved");
		const elsewhere = path.join(dir.path(), "elsewhere");
		fs.mkdirSync(elsewhere);
		await live.moveTo(elsewhere);
		expect(live.getSessionFile()).not.toBe(oldFile);
		await stopPool(session, "moved");
		await live.flush();

		expect(discardedIn(live.getEntries())).toEqual([worker]);
		expect(fs.existsSync(oldFile)).toBe(false);
		await live.close();
	});
});
