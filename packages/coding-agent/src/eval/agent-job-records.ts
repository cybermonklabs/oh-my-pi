/**
 * Transcript records of the eval `agent()` jobs a session spawned, which `omp --restore` reads as
 * evidence of whether the session still waits on a job's subagent ({@link readEvalAgentJobRecord}).
 *
 * A job is `owed` from its spawn until its result is handed to the session. The handover writes
 * `delivered` first and then hands the result over, so a process that goes away between the two
 * leaves `delivered`, and restore never runs a delivered job again. A result the session receives
 * as an `async-result` message needs no marker: that message is the handover and its record at once.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
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

/** Appends `state` for each of `agentIds` to `session`'s transcript, without waiting for the disk. */
export function appendEvalAgentJobRecords(
	session: ToolSession,
	agentIds: readonly string[],
	state: EvalAgentJobState,
): void {
	const manager = session.sessionManager;
	if (!manager) return;
	for (const agentId of agentIds) {
		const record: EvalAgentJobRecord = { agentId, state };
		manager.appendCustomEntry(EVAL_AGENT_JOB_CUSTOM_TYPE, record);
	}
}

/** {@link appendEvalAgentJobRecords}, then waits until the records are on disk. */
export async function recordEvalAgentJobs(
	session: ToolSession,
	agentIds: readonly string[],
	state: EvalAgentJobState,
): Promise<void> {
	if (agentIds.length === 0) return;
	appendEvalAgentJobRecords(session, agentIds, state);
	await session.sessionManager?.flush();
}

/** The eval `agent()` job record `entry` holds; undefined for any other entry. */
export function readEvalAgentJobRecord(entry: SessionEntry): EvalAgentJobRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== EVAL_AGENT_JOB_CUSTOM_TYPE) return undefined;
	const { data } = entry;
	if (!isRecord(data) || typeof data.agentId !== "string") return undefined;
	if (data.state !== "owed" && data.state !== "delivered") return undefined;
	return { agentId: data.agentId, state: data.state };
}
