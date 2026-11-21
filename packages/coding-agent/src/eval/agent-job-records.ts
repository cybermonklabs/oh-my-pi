/**
 * Transcript records of the subagent jobs a session's eval cells start or take results of,
 * which `omp --restore` reads as evidence of whether the session still waits on a job's
 * subagent ({@link readEvalAgentJobRecord}).
 *
 * A job is `owed` from its spawn until its result is handed to the session: an eval `agent()`
 * job, a background spawn a bridged `tool.task` starts, whose "started" result names no
 * settled run, and a work pool's worker. A cell's `wait()` and a bridged `tool.wait` write
 * `delivered` first and then hand the result over, so a process that goes away between the two
 * leaves `delivered`, and restore never runs that run again; a background `task` spawn's result
 * a bridged `tool.wait` hands a cell is recorded the same way, and so is each worker's batch
 * the pool's aggregate result or a `peek` hands over. A handle's `status()`, `done()` and
 * `attempts()` hand the cell no result and write nothing. A result the session receives as an
 * `async-result` message needs no marker: that message is the handover and its record at once.
 */
import { isRecord, stringProperty } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { ToolSession } from "../tools";

/** Custom entry type of an eval job record: an `agent()` job's, a bridged `tool.task` background spawn's, or a work pool worker's. */
export const EVAL_AGENT_JOB_CUSTOM_TYPE = "eval-agent-job";

/** `owed`: spawned, its result not yet handed to the session; `delivered`: handed over, or being handed over. */
export type EvalAgentJobState = "owed" | "delivered";

/** One state change of the eval job whose subagent is `agentId`. */
export interface EvalAgentJobRecord {
	agentId: string;
	state: EvalAgentJobState;
}

/**
 * Appends `state` for each of `agentIds` to `session`'s transcript, then waits until the records
 * are on disk. Nothing is written or flushed for no ids or a session without a transcript.
 */
export async function recordEvalAgentJobs(
	session: ToolSession,
	agentIds: readonly string[],
	state: EvalAgentJobState,
): Promise<void> {
	const manager = session.sessionManager;
	if (!manager || agentIds.length === 0) return;
	for (const agentId of agentIds) {
		const record: EvalAgentJobRecord = { agentId, state };
		manager.appendCustomEntry(EVAL_AGENT_JOB_CUSTOM_TYPE, record);
	}
	await manager.flush();
}

/** The handover record of one job run: when it was first handed over (epoch ms), and its write and flush. */
interface Handover {
	at: number;
	written: Promise<void>;
}

/**
 * Per session manager, the handover record of each job run (keyed by {@link runKey}), settled or
 * still in flight. `/new` and a session switch keep the manager, so one map can span several
 * transcripts; job ids do not repeat across them, so no run's record stands for another's.
 */
const handovers = new WeakMap<object, Map<string, Handover>>();

/** A job run's identity within its session: its subagent and its job. A follow-up turn is no job run. */
function runKey(run: { agentId: string; jobId: string }): string {
	return `${run.agentId}\u0000${run.jobId}`;
}

/**
 * Records that each of `runs` handed its subagent's result to `session`'s cell: `delivered`,
 * on disk, before the caller hands the result over. A run is known by its subagent and job ids,
 * not by a job object (the worker thread's job manager builds a new one on every read), and is
 * recorded once: a later `wait()` on the settled handle writes nothing. A caller that finds the
 * record still being written waits for it to reach the disk too, so no concurrent `wait()` hands
 * the result over first. A failed write is forgotten, and the next handover of that run writes
 * it again.
 *
 * Returns, for each of `runs` in order, when its result first reached the cell (epoch ms): the
 * time the eval result names it with, so a turn the cell messaged the subagent for after that
 * stays unsettled, however often or late the cell waits again.
 */
export async function recordHandovers(
	session: ToolSession,
	runs: ReadonlyArray<{ agentId: string; jobId: string }>,
): Promise<number[]> {
	const manager = session.sessionManager;
	if (!manager) return runs.map(() => Date.now());
	let byRun = handovers.get(manager);
	if (!byRun) {
		byRun = new Map();
		handovers.set(manager, byRun);
	}
	const fresh = runs.filter(run => !byRun.has(runKey(run)));
	if (fresh.length > 0) {
		const at = Date.now();
		// Appended synchronously in this call, before any other caller can look the run up.
		const written = recordEvalAgentJobs(
			session,
			fresh.map(run => run.agentId),
			"delivered",
		);
		for (const run of fresh) byRun.set(runKey(run), { at, written });
		written.catch(() => {
			for (const run of fresh) if (byRun.get(runKey(run))?.written === written) byRun.delete(runKey(run));
		});
	}
	const recorded = runs.map(run => byRun.get(runKey(run))!);
	await Promise.all(recorded.map(handover => handover.written));
	return recorded.map(handover => handover.at);
}

/**
 * The settled subagent jobs a `wait` tool result hands its caller: each listed job that is no
 * longer running and has a subagent (`agentUrlId`), with its job id.
 */
export function waitHandedSubagents(details: unknown): Array<{ agentId: string; jobId: string }> {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	const handed: Array<{ agentId: string; jobId: string }> = [];
	for (const job of details.jobs) {
		if (!isRecord(job) || job.status === "running") continue;
		const agentId = stringProperty(job, "agentUrlId");
		const jobId = stringProperty(job, "id");
		if (agentId && jobId) handed.push({ agentId, jobId });
	}
	return handed;
}

/** The eval `agent()` job record `entry` holds; undefined for any other entry. */
export function readEvalAgentJobRecord(entry: SessionEntry): EvalAgentJobRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== EVAL_AGENT_JOB_CUSTOM_TYPE) return undefined;
	const { data } = entry;
	if (!isRecord(data) || typeof data.agentId !== "string") return undefined;
	if (data.state !== "owed" && data.state !== "delivered") return undefined;
	return { agentId: data.agentId, state: data.state };
}
