/**
 * A worker's `RemoteAsyncJobManager` over main's `AsyncJobManager`, across a real worker link: which of main's job
 * rows the live `process` / `widgetInputs` of a job the worker registered show up on, and when the worker lets
 * go of them. The worker side is `test/fixtures/runtime-service-worker.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { AsyncJobManager } from "../../src/async/job-manager";
import type { MainThreadLink, SubagentMainApi, SubagentWorkerApi } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService, WorkerPeer } from "../../src/thread/services";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { runtimeThreadService } from "../../src/thread/services/runtime";
import { settingsThreadService } from "../../src/thread/services/settings";
import { collectGarbage } from "../helpers/heap-snapshot";

/** Main-side view of the fixture's probe: every call is async across the link. */
type Probe = (op: string, ...args: unknown[]) => Promise<unknown>;

/** Main's side of a worker link: gets each frame the worker sends, and passes it on with `deliver`, now or later. */
type Inbound = (frame: RpcFrame, deliver: () => void) => void;

/** Holds, on main's side of a worker link, the worker's replies that carry the job results it is told to hold. */
class ResultFrames {
	readonly #holds = new Map<string, PromiseWithResolvers<() => void>>();

	/**
	 * Hold the reply that carries the job result `text`. Resolves once main has it, with what lets it through: by
	 * then the worker's run has ended, its `finally` included, and main has not settled the job's row.
	 */
	hold(text: string): Promise<() => void> {
		const hold = Promise.withResolvers<() => void>();
		this.#holds.set(text, hold);
		return hold.promise;
	}

	readonly inbound: Inbound = (frame, deliver) => {
		const text = frame.t === "ok" && typeof frame.v === "string" ? frame.v : undefined;
		const hold = text === undefined ? undefined : this.#holds.get(text);
		if (text === undefined || !hold) {
			deliver();
			return;
		}
		this.#holds.delete(text);
		hold.resolve(deliver);
	};
}

const SERVICES: readonly ThreadService[] = [settingsThreadService, runtimeThreadService, asyncJobsThreadService];

interface Started {
	worker: Worker;
	peer: WorkerPeer;
}

const started: Started[] = [];
const managers: AsyncJobManager[] = [];
let nextWorker = 1;

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 100 });
	for (const { worker, peer } of started.splice(0)) {
		for (const service of SERVICES) service.onWorkerExit?.(peer, "test end");
		peer.link.close("test end");
		worker.terminate();
	}
});

function newManager(): AsyncJobManager {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	return manager;
}

async function startWorker(inbound?: Inbound): Promise<Probe> {
	const spawned = new Worker(new URL("../fixtures/runtime-service-worker.ts", import.meta.url).href, {
		type: "module",
	});
	const channel = new MessageChannel();
	const counter = new SharedArrayBuffer(4);
	const { promise: ready, resolve } = Promise.withResolvers<void>();
	const onReady = (event: MessageEvent): void => {
		if (event.data?.ready) {
			spawned.removeEventListener("message", onReady);
			resolve();
		}
	};
	spawned.addEventListener("message", onReady);
	spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
	await ready;
	const threadId = `w${nextWorker++}` as const;
	const link: MainThreadLink = new RpcLink<SubagentMainApi, SubagentWorkerApi>(
		{
			send: frame => spawned.postMessage(frame),
			listen: handler => {
				const listener = (event: MessageEvent<RpcFrame>): void => {
					const frame = event.data;
					if (inbound) inbound(frame, () => handler(frame));
					else handler(frame);
				};
				spawned.addEventListener("message", listener);
				return () => spawned.removeEventListener("message", listener);
			},
		},
		{ name: `main↔${threadId}`, syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
	);
	link.handle("ping", nonce => nonce);
	const peer: WorkerPeer = { threadId, link };
	for (const service of SERVICES) service.installMain?.(peer);
	let probe: Probe | undefined;
	await link.call("boot", {
		settings: settingsThreadService.globals?.(peer),
		probe: (registered: Probe) => {
			probe = registered;
		},
	});
	if (!probe) throw new Error("fixture did not register its probe");
	started.push({ worker: spawned, peer });
	return probe;
}

/** A job the fixture registers with `options` (see its `registerJob` probe); its owner is `Worker`. */
async function registerJob(
	probe: Probe,
	manager: AsyncJobManager,
	options: { id?: string; foreground?: boolean; inputs?: boolean },
): Promise<string> {
	const id = await probe("registerJob", manager, "Worker", options);
	if (typeof id !== "string") throw new Error("registerJob returned no id");
	return id;
}

/** Run the body of `id` to its end and wait until main's row settled. */
async function settle(probe: Probe, manager: AsyncJobManager, id: string): Promise<void> {
	const settled = manager.getJob(id)?.promise;
	if (!settled) throw new Error(`no row ${id} on main`);
	await probe("finish", id, "done");
	await settled;
}

/** Main's row of `id`: whether it is there, settled, and listed as a background job. */
function mainRow(manager: AsyncJobManager, id: string): { status?: string; foreground?: boolean } | null {
	const row = manager.getJob(id);
	return row ? { status: row.status, foreground: row.foreground } : null;
}

/** Full collections in both threads; the second round lets the release frames of the first one land. */
async function collectBothThreads(probe: Probe): Promise<void> {
	for (let round = 0; round < 2; round++) {
		await probe("gc");
		await collectGarbage();
	}
}

describe("a worker's live inputs of its jobs across main's job rows", () => {
	it("keeps a foreground job's live output on the worker when main promoted the job before the worker released it", async () => {
		// If this regresses, a worker subagent's foreground bash call that main moved to the background loses its
		// output on the worker (`proc://<id>/streams`) once the call returns, though main still lists the job; or
		// main drops the promoted job's row once its run settles.
		const manager = newManager();
		const probe = await startWorker();

		// Settled, then promoted by main, then released by the worker's foreground call.
		const settledFirst = await registerJob(probe, manager, { id: "settled-first", foreground: true, inputs: true });
		await probe("appendHeld", settledFirst, "settled first\n");
		await settle(probe, manager, settledFirst);
		expect(manager.backgroundJob(settledFirst)).toBe(true);
		await probe("releaseForeground", manager, settledFirst);

		// Released by the worker's foreground call while it ran, then promoted by main, then settled.
		const releasedFirst = await registerJob(probe, manager, { id: "released-first", foreground: true, inputs: true });
		await probe("appendHeld", releasedFirst, "released first\n");
		await probe("releaseForeground", manager, releasedFirst);
		expect(manager.backgroundJob(releasedFirst)).toBe(true);
		await settle(probe, manager, releasedFirst);

		const seen = async (id: string) => ({
			main: mainRow(manager, id),
			workerRow: await probe("localInputs", manager, id),
			workerListing: await probe("listedInputs", manager, id),
			workerSources: await probe("localSources", manager, id),
		});
		const kept = { hasWidgetInputs: true, pids: [4242] };
		expect({ settledFirst: await seen(settledFirst), releasedFirst: await seen(releasedFirst) }).toEqual({
			settledFirst: {
				main: { status: "completed", foreground: undefined },
				workerRow: kept,
				workerListing: kept,
				workerSources: [{ text: "settled first\n", open: false }],
			},
			releasedFirst: {
				main: { status: "completed", foreground: undefined },
				workerRow: kept,
				workerListing: kept,
				workerSources: [{ text: "released first\n", open: false }],
			},
		});
	});

	it("keeps a released foreground job's live output on the worker when main promotes the job after its body ended but before main has its result, and drops it once main discards the row of one it did not promote", async () => {
		// If this regresses, a worker subagent's foreground bash call that main moves to the background just as the
		// call ends loses its output on the worker (`proc://<id>/streams`) though main keeps listing the job; or a
		// call main did not move keeps its output on the worker for ten minutes after main dropped its row.
		const frames = new ResultFrames();
		const manager = newManager();
		const probe = await startWorker(frames.inbound);

		/** Release `id` from the worker's foreground call, then end its body with `text`, held on main's side. */
		const endReleased = async (id: string, text: string): Promise<() => void> => {
			await probe("appendHeld", id, `${text}\n`);
			await probe("releaseForeground", manager, id);
			const held = frames.hold(text);
			await probe("finish", id, text);
			return held;
		};

		const promoted = await registerJob(probe, manager, { id: "promoted", foreground: true, inputs: true });
		const promotedSettled = manager.getJob(promoted)?.promise;
		const deliverPromoted = await endReleased(promoted, "promoted result");
		const promotedBeforeResult = mainRow(manager, promoted);
		expect(manager.backgroundJob(promoted)).toBe(true);
		deliverPromoted();
		await promotedSettled;

		// The control: released the same way, and main discards its row once the result arrives.
		const discarded = await registerJob(probe, manager, { id: "discarded", foreground: true, inputs: true });
		const discardedSettled = manager.getJob(discarded)?.promise;
		const deliverDiscarded = await endReleased(discarded, "discarded result");
		const discardedBeforeResult = mainRow(manager, discarded);
		deliverDiscarded();
		await discardedSettled;

		// No lookup on the worker before this point: only main's notice that it discarded the row lets the worker
		// drop the job's inputs, which alone keep its tap (the fixture holds it weakly).
		await collectBothThreads(probe);
		expect({
			promoted: {
				mainBeforeResult: promotedBeforeResult,
				main: mainRow(manager, promoted),
				workerTap: await probe("tapAlive", promoted),
				workerRow: await probe("localInputs", manager, promoted),
				workerSources: await probe("localSources", manager, promoted),
			},
			discarded: {
				mainBeforeResult: discardedBeforeResult,
				main: mainRow(manager, discarded),
				workerTap: await probe("tapAlive", discarded),
				workerRow: await probe("localInputs", manager, discarded),
			},
		}).toEqual({
			promoted: {
				mainBeforeResult: { status: "running", foreground: true },
				main: { status: "completed", foreground: undefined },
				workerTap: true,
				workerRow: { hasWidgetInputs: true, pids: [4242] },
				workerSources: [{ text: "promoted result\n", open: false }],
			},
			discarded: {
				mainBeforeResult: { status: "running", foreground: true },
				main: null,
				workerTap: false,
				workerRow: { hasWidgetInputs: false, pids: null },
			},
		});
	});

	it("never shows a worker job's live inputs on a later row main gives the same id", async () => {
		// If this regresses, a job id main gives out again (after it evicted the job that had it) shows, on the
		// worker that registered the earlier job, that job's process and output: in `proc://<id>` and in job
		// listings, for a published result, for a job main registered, or for another worker's job.
		const manager = newManager();
		const [probe, other] = await Promise.all([startWorker(), startWorker()]);
		const ids = ["published-here", "published-on-main", "registered-elsewhere"];
		for (const id of ids) {
			await registerJob(probe, manager, { id, inputs: true });
			await probe("appendHeld", id, "the earlier job's output\n");
			await settle(probe, manager, id);
		}
		expect(manager.evictCompletedJobs({ ownerId: "Worker" })).toBe(ids.length);

		expect(await probe("publishCompleted", manager, "published-here", "published here")).toBe("published-here");
		expect(
			manager.publishCompleted(
				"task",
				"main result",
				{ text: "published on main" },
				{
					id: "published-on-main",
					ownerId: "Worker",
				},
			),
		).toBe("published-on-main");
		expect(await registerJob(other, manager, { id: "registered-elsewhere", inputs: true })).toBe(
			"registered-elsewhere",
		);

		// Listings first: a row lookup would let go of the earlier job's inputs before the listing reads them.
		const listed = {
			publishedHere: await probe("listedInputs", manager, "published-here"),
			publishedOnMain: await probe("listedInputs", manager, "published-on-main"),
			registeredElsewhere: await probe("listedInputs", manager, "registered-elsewhere"),
		};
		const rows = {
			publishedHere: await probe("localInputs", manager, "published-here"),
			publishedOnMain: await probe("localInputs", manager, "published-on-main"),
			registeredElsewhere: await probe("localInputs", manager, "registered-elsewhere"),
			registeredElsewhereOnItsWorker: await other("localInputs", manager, "registered-elsewhere"),
		};
		const none = { hasWidgetInputs: false, pids: null };
		// The other worker's process as main projects it: main pulled no pids from that worker yet.
		const projected = { hasWidgetInputs: false, pids: [] };
		expect({ listed, rows }).toEqual({
			listed: { publishedHere: none, publishedOnMain: none, registeredElsewhere: projected },
			rows: {
				publishedHere: none,
				publishedOnMain: none,
				registeredElsewhere: projected,
				registeredElsewhereOnItsWorker: { hasWidgetInputs: true, pids: [4242] },
			},
		});
		await settle(other, manager, "registered-elsewhere");
	});
});
