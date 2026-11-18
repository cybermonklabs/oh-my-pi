import { expect, test } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { executeCancel } from "../../src/async/job-control";
import { runEvalCancel, runEvalWait } from "../../src/eval/handle-bridge";
import { cancelOwnedAsyncJob } from "../../src/session/async-job-views";
import { INTERRUPTED_TURN_ERROR, turnAbortKind } from "../../src/session/exit-diagnostics";
import { USER_INTERRUPT_LABEL } from "../../src/session/messages";
import type { ToolSession } from "../../src/tools";

/** An agent's job that runs until it is cancelled, with the reason its signal aborted with. */
function startAgentJob(manager: AsyncJobManager) {
	const started = Promise.withResolvers<void>();
	const abortReason = Promise.withResolvers<unknown>();
	const id = manager.register(
		"task",
		"Scout",
		async ({ signal }) => {
			signal.addEventListener("abort", () => abortReason.resolve(signal.reason), { once: true });
			started.resolve();
			await abortReason.promise;
			return "cancelled";
		},
		{ id: "held-agent", ownerId: "Main", agentId: "Scout" },
	);
	return { id, started: started.promise, abortReason: abortReason.promise };
}

function evalSession(manager: AsyncJobManager): ToolSession {
	return { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession;
}

const aborts = [
	{ name: "the user's stop", reason: USER_INTERRUPT_LABEL, kind: "stop" },
	{ name: "the parent's process exit", reason: INTERRUPTED_TURN_ERROR, kind: "cutOff" },
] as const;

for (const abort of aborts) {
	test(`a wait() that ${abort.name} aborted ends the awaited agent's job with that abort's kind`, async () => {
		// If this regresses, the job aborts with the platform's unmarked reason, which its subagent reads as a
		// cut-off whatever ended the cell: `omp --restore` relaunches an agent the user stopped.
		const manager = new AsyncJobManager({});
		try {
			const job = startAgentJob(manager);
			await job.started;
			const controller = new AbortController();
			const waited = runEvalWait(
				{ items: [{ kind: "agent", id: job.id }] },
				{ session: evalSession(manager), signal: controller.signal },
			);
			controller.abort(abort.reason);
			await expect(waited).rejects.toThrow();
			expect(turnAbortKind(await job.abortReason)).toBe(abort.kind);
		} finally {
			await manager.dispose();
		}
	});
}

test("cancel() of an agent handle stops the agent's job", async () => {
	// If this regresses, the cell's own cancel reads to the subagent as a cut-off, and `omp --restore` relaunches it.
	const manager = new AsyncJobManager({});
	try {
		const job = startAgentJob(manager);
		await job.started;
		expect(runEvalCancel({ item: { kind: "agent", id: job.id } }, { session: evalSession(manager) })).toEqual({
			cancelled: true,
		});
		expect(turnAbortKind(await job.abortReason)).toBe("stop");
	} finally {
		await manager.dispose();
	}
});

test("the owner's cancel of an agent's job stops it", async () => {
	// If this regresses, a `cancel` of the job (or `proc://<id>/kill`) aborts it with the platform's unmarked reason,
	// which an `agent()` subagent reads as a cut-off: `omp --restore` relaunches an agent its owner cancelled.
	const manager = new AsyncJobManager({});
	try {
		const job = startAgentJob(manager);
		await job.started;
		await executeCancel(evalSession(manager), manager, "Main", [job.id]);
		expect(turnAbortKind(await job.abortReason)).toBe("stop");
	} finally {
		await manager.dispose();
	}
});

test("the user's cancel of an agent's job from the jobs view stops it", async () => {
	// If this regresses, `/jobs kill` (or the jobs sheet) aborts the job with the platform's unmarked reason, which an
	// `agent()` subagent reads as a cut-off: `omp --restore` relaunches an agent the user cancelled.
	const manager = new AsyncJobManager({});
	try {
		const job = startAgentJob(manager);
		await job.started;
		expect(cancelOwnedAsyncJob(manager, "Main", job.id)).toBe(true);
		expect(turnAbortKind(await job.abortReason)).toBe("stop");
	} finally {
		await manager.dispose();
	}
});
