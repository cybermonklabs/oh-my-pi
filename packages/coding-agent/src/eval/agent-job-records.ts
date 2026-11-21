/**
 * Transcript records of the subagent jobs whose results a session's eval cells take, which
 * `omp --restore` reads as evidence of whether the session still waits on a job's subagent
 * ({@link readEvalAgentJobRecord}).
 *
 * An eval `agent()` job is `owed` from its spawn until its result is handed to the session. A
 * cell's `wait()` and a bridged `tool.wait` write `delivered` first and then hand the result
 * over, so a process that goes away between the two leaves `delivered`, and restore never runs
 * that run again; a background `task` spawn's result a bridged `tool.wait` hands a cell is
 * recorded the same way. A handle's `status()`, `done()` and `attempts()` hand the cell no
 * result and write nothing. A result the session receives as an `async-result` message needs no
 * marker: that message is the handover and its record at once.
 */
import { isRecord, stringProperty } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { ToolSession } from "../tools";

/** Custom entry type of an eval `agent()` job record. */
export const EVAL_AGENT_JOB_CUSTOM_TYPE = "eval-agent-job";

/** `owed`: spawned, its result not yet handed to the session; `delivered`: handed over, or being handed over. */
export type EvalAgentJobState = "owed" | "delivered";

/** One state change of the eval `agent()` job whose subagent is `agentId`. */
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

/** Job runs whose handover is already recorded. */
const handedOver = new WeakSet<object>();

/**
 * Records that each of `runs` handed its subagent's result to `session`'s cell: `delivered`,
 * on disk, before the caller hands the result over. A run whose handover is recorded writes
 * nothing again (a second `wait()` on a settled handle), so the record keeps the time its result
 * first reached the cell, and a later turn the parent messages the subagent for stays a new run.
 * A run with no job object (one the manager no longer holds) is recorded each time.
 */
export async function recordHandovers(
	session: ToolSession,
	runs: ReadonlyArray<{ agentId: string; job: object | undefined }>,
): Promise<void> {
	const fresh = runs.filter(run => !run.job || !handedOver.has(run.job));
	for (const run of fresh) if (run.job) handedOver.add(run.job);
	await recordEvalAgentJobs(
		session,
		fresh.map(run => run.agentId),
		"delivered",
	);
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
