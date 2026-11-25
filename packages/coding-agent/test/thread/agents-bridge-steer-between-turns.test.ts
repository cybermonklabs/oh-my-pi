import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../../src/irc/bus";
import { handleRpcSteerSubagent } from "../../src/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "../../src/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<AgentsProbe> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return probe.promise;
}

/**
 * Poll a condition fed by another thread (mirror patches, worker-side state).
 * There is no in-process clock to fake across a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function liveRef(id: string): AgentRef {
	const ref = AgentRegistry.global().get(id);
	if (!ref) throw new Error(`no ref ${id}`);
	return ref;
}

/** This session's `get_subagents` roster, listing `id` running with its transcript at `sessionFile`. */
function rosterListing(id: string, sessionFile: string): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const roster = new RpcSubagentRegistry(eventBus, () => {});
	cleanups.push(() => roster.dispose());
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile,
	} satisfies SubagentLifecyclePayload);
	return roster;
}

/**
 * Hold what the worker reports to the main thread about subagent `id` until
 * `release`, in its order: the state patches and run-state reports of its
 * session's mirror, and the status changes of its registry ref. The main
 * thread then still sees the subagent as it was when the hold began, as it
 * does while those reports are on their way across the bridge.
 */
function holdWorkerReports(id: string, mirror: RemoteAgentSession): { release(): void } {
	const held: Array<() => void> = [];
	let holding = true;
	const applyPatch = mirror.applyPatch.bind(mirror);
	const applyRunState = mirror.applyRunState.bind(mirror);
	const registry = AgentRegistry.global();
	const setStatus = registry.setStatus.bind(registry);
	vi.spyOn(mirror, "applyPatch").mockImplementation(patch => {
		if (holding) held.push(() => applyPatch(patch));
		else applyPatch(patch);
	});
	vi.spyOn(mirror, "applyRunState").mockImplementation(state => {
		if (holding) held.push(() => applyRunState(state));
		else applyRunState(state);
	});
	vi.spyOn(registry, "setStatus").mockImplementation((agentId, status, expected) => {
		if (!holding || agentId !== id) return setStatus(agentId, status, expected);
		// The worker's compare-and-set would succeed: nothing else changes the ref meanwhile.
		held.push(() => setStatus(agentId, status, expected));
		return true;
	});
	return {
		release() {
			holding = false;
			for (const apply of held.splice(0)) apply();
		},
	};
}

describe("steer_subagent to a worker-homed subagent whose turn just ended", () => {
	const id = "W1";
	const text = "Also check the README.";

	it("queues the message for the next prompt of the run, which takes it, instead of starting a turn of its own", async () => {
		// If this regresses, a host that steers a subagent run in a worker just as
		// one of its turns ends sees the subagent answer the message in a turn of its
		// own, and the run's next prompt (the executor's yield reminder) fails with
		// AgentBusyError, so the subagent stops without doing what was asked.
		using dir = TempDir.createSync("@omp-steer-between-turns-");
		const sessionFile = path.join(dir.path(), `${id}.jsonl`);
		const probe = await startWorker();
		await probe.open(id, { sessionFile, gated: true });
		const roster = rosterListing(id, sessionFile);
		const session = liveRef(id).session;
		if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker session mirror");

		// In a real run the task executor runs inside the worker and sends the
		// subagent's prompts there; `probe.prompt` stands in for it.
		const firstTurn = probe.prompt(id, "Do the task.");
		await waitFor(() => session.isStreaming && liveRef(id).status === "running");
		// The turn ends on the worker while its reports have not reached the main thread yet.
		const reports = holdWorkerReports(id, session);
		await probe.openGate();
		await firstTurn;
		expect({ isStreaming: session.isStreaming, status: liveRef(id).status }).toEqual({
			isStreaming: true,
			status: "running",
		});

		// The next model call on the worker waits until the case lets it go: a turn
		// the steer started stays in flight while the executor's next prompt arrives.
		await probe.holdNextModelCall(id);

		// The steer goes to the worker as a prompt or as a queued steer.
		const reached = Promise.withResolvers<{ sent: Promise<unknown> }>();
		for (const method of ["prompt", "steer"] as const) {
			const original = session[method].bind(session) as (...args: unknown[]) => Promise<unknown>;
			vi.spyOn(session, method).mockImplementation(((...args: unknown[]) => {
				const sent = original(...args);
				reached.resolve({ sent: sent.catch(() => {}) });
				return sent;
			}) as never);
		}
		const answer = handleRpcSteerSubagent(roster, id, text);
		const { sent } = await reached.promise;
		reports.release();
		// On the worker the message is now queued, or in a turn of its own that waits on its model call.
		const modelCallHeld = probe.modelCallHeld();
		await Promise.race([sent, modelCallHeld]);

		// The executor's next prompt runs and takes the message into its own turn.
		const nextPrompt = probe.prompt(id, "Submit your result.").then(
			() => "accepted",
			(error: unknown) => String(error),
		);
		await modelCallHeld;
		await probe.releaseModelCall();
		expect(await nextPrompt).toBe("accepted");
		expect(await answer).toBeUndefined();
		expect(await probe.userTexts(id)).toEqual(["Do the task.", "Submit your result.", text]);
		expect((await probe.settled(id)).steering).toEqual([]);
	}, 60_000);
});
