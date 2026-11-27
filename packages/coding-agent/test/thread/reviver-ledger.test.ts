import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
// Load the session layer first: it closes the services import cycle in the order the app uses.
import "../../src/session/agent-session";
import {
	AgentLifecycleManager,
	type AgentReviveState,
	WarmReviveInputsMissingError,
} from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus } from "../../src/registry/agent-registry";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import type { MainThreadLink, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcEndpoint, type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import * as agentsRemote from "../../src/thread/services/agents-remote";
import { identityThreadService } from "../../src/thread/services/identity";

/**
 * The seam of the worker's revive table (INFRA-5582 part 9): one table per worker thread, made when `agents-remote`
 * loads, holding the revive state of each subagent that worker parked; the seam answers how many entries it holds
 * for an id. Read through the module's namespace, so this file loads where the table does not exist yet: there each
 * read fails, naming the missing seam.
 */
const WORKER_TABLE_SEAM = "reviveTableEntriesForTests";

function workerTableEntries(id: string): number {
	const seam: unknown = Reflect.get(agentsRemote, WORKER_TABLE_SEAM);
	if (typeof seam !== "function") {
		throw new Error(`agents-remote exports no ${WORKER_TABLE_SEAM}(id): this worker keeps no revive table to read`);
	}
	const entries: unknown = Reflect.apply(seam, undefined, [id]);
	if (typeof entries !== "number") throw new Error(`${WORKER_TABLE_SEAM}("${id}") returned ${String(entries)}`);
	return entries;
}

/** A warm reviver whose transcript holds no revive inputs: the lifecycle forgets it and revives cold. */
async function reviveWithoutInputs(): Promise<AgentSessionHandle> {
	throw new WarmReviveInputsMissingError("no revive inputs in this test");
}

function portEndpoint(port: MessagePort): RpcEndpoint {
	return {
		send: frame => port.postMessage(frame),
		listen: handler => {
			const listener = (frame: RpcFrame): void => handler(frame);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
	};
}

interface LinkedWorker {
	/** What else the worker got at boot, as it got it. */
	readonly globals: Record<string, unknown>;
	/** The worker side's adopt at a subagent's run's end, once main has taken it. */
	adopt(id: string, expected?: AgentRef): Promise<void>;
	/** Resolves once every message either side sent before has been handled on both. */
	quiet(): Promise<void>;
}

/** No pool of a test process numbers a worker this high. */
const LEDGER_THREAD = "w90001";

const cleanups: Array<() => unknown> = [];

/**
 * A worker's links to main on this thread: two links over one message channel, the main one with the identity and
 * agents services' main hooks (which serve main's lifecycle to this worker through its session bridge), the worker
 * one with their worker hooks. The worker gets main's lifecycle and `globals` as at boot, and adopts through that
 * lifecycle as a subagent homed there does at the end of its run.
 */
async function linkWorker(globals: Record<string, unknown> = {}): Promise<LinkedWorker> {
	const lifecycle = AgentLifecycleManager.global();
	if (!(lifecycle instanceof AgentLifecycleManager)) throw new Error("expected main's own lifecycle");
	const channel = new MessageChannel();
	const mainLink: MainThreadLink = new RpcLink(portEndpoint(channel.port1), { name: `main↔${LEDGER_THREAD}` });
	const workerLink: WorkerThreadLink = new RpcLink(portEndpoint(channel.port2), { name: `${LEDGER_THREAD}↔main` });
	const peer: WorkerPeer = { threadId: LEDGER_THREAD, link: mainLink, retain: () => () => {} };
	for (const service of [identityThreadService, agentsThreadService]) {
		service.installMain?.(peer);
		service.installWorker?.(workerLink);
	}
	let booted: Record<string, unknown> = {};
	workerLink.handle("boot", received => {
		booted = received;
	});
	await mainLink.call("boot", { ...globals, lifecycle });
	cleanups.push(() => {
		agentsThreadService.onWorkerExit?.(peer, "ledger test over");
		mainLink.close();
		workerLink.close();
		channel.port1.close();
	});
	const remote = booted.lifecycle;
	if (!(remote instanceof agentsRemote.RemoteAgentLifecycle)) throw new Error("main's lifecycle did not cross");
	// A round trip: the worker's call reaches main after its earlier messages, and main's reply after main's.
	const quiet = () => remote.whenReleased("ledger-quiet");
	return {
		globals: booted,
		adopt: async (id, expected) => {
			const revive: AgentReviveState = { reviver: reviveWithoutInputs, state: { id } };
			remote.adopt(id, { idleTtlMs: 0, revive }, expected);
			await quiet();
		},
		quiet,
	};
}

function register(id: string, status: AgentStatus = "idle"): AgentRef {
	return AgentRegistry.global().register({
		id,
		displayName: "task",
		kind: "sub",
		session: null,
		sessionFile: null,
		status,
	});
}

function isRef(value: unknown): value is AgentRef {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "id") === "string" &&
		typeof Reflect.get(value, "generation") === "number"
	);
}

describe("MainSessionBridge reviver ledger", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("drops a worker reviver when its adoption ends (release, re-adopt, removal, forget)", async () => {
		// Kill ends an adoption too. If this regresses, the worker keeps the revive state of every subagent whose
		// adoption ended on main, for as long as the worker lives.
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const worker = await linkWorker();
		const entriesOnceQuiet = async (id: string) => {
			await worker.quiet();
			return workerTableEntries(id);
		};

		for (let i = 0; i < 50; i++) {
			const id = `Run${i}-Sub`;
			register(id);
			await worker.adopt(id);
			await worker.adopt(id); // re-adopt replaces the prior reviver
			expect(workerTableEntries(id)).toBe(1);
			await lifecycle.release(id);
			expect(await entriesOnceQuiet(id)).toBe(0);
		}

		register("Removed-Sub");
		await worker.adopt("Removed-Sub");
		expect(workerTableEntries("Removed-Sub")).toBe(1);
		registry.unregister("Removed-Sub");
		expect(await entriesOnceQuiet("Removed-Sub")).toBe(0);

		register("Forgot-Sub", "parked");
		await worker.adopt("Forgot-Sub");
		expect(workerTableEntries("Forgot-Sub")).toBe(1);
		// Its warm revive finds no revive inputs: the lifecycle forgets it, and with no cold reviver revives nothing.
		// (Awaited as a value: `expect(promise).rejects` waits without handling this thread's port messages.)
		const refusal = await lifecycle.ensureLive("Forgot-Sub").then(
			() => "revived",
			(error: unknown) => String(error),
		);
		expect(refusal).toContain("no reviver registered");
		expect(await entriesOnceQuiet("Forgot-Sub")).toBe(0);

		register("Killed-Sub");
		await worker.adopt("Killed-Sub");
		expect(workerTableEntries("Killed-Sub")).toBe(1);
		await lifecycle.release("Killed-Sub", undefined, { tombstone: true });
		expect(await entriesOnceQuiet("Killed-Sub")).toBe(0);

		await worker.adopt("Unknown-Sub"); // refused adoption
		expect(await entriesOnceQuiet("Unknown-Sub")).toBe(0);
	});

	it("keeps no worker table entry for a refused adoption", async () => {
		// If this regresses, a subagent whose adoption main refused (its id taken by a newer agent while its run
		// ended) leaves its revive state on its worker, which nothing ever drops.
		const stale = register("Stale-Sub");
		const worker = await linkWorker({ stale });
		const expected = worker.globals.stale;
		if (!isRef(expected)) throw new Error("the subagent's ref did not cross to the worker");
		AgentRegistry.global().unregister("Stale-Sub");
		register("Stale-Sub");
		await worker.adopt("Stale-Sub", expected);
		expect(AgentLifecycleManager.global().has("Stale-Sub")).toBe(false);
		await worker.quiet();
		expect(workerTableEntries("Stale-Sub")).toBe(0);
	});
});
