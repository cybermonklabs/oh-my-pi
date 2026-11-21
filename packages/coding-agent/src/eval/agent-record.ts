import { isRecord } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async";

/** A persisted `agent()` spawn: an unsettled one is positive evidence its parent still waits. */
export const EVAL_AGENT_SPAWN_MESSAGE_TYPE = "eval_agent_spawn";

export type EvalAgentSpawnStatus = "unsettled" | "delivered";

export interface EvalAgentSpawnRecord {
	id: string;
	status: EvalAgentSpawnStatus;
}

/** Parses an eval-agent custom entry without making restore trust arbitrary custom data. */
export function readEvalAgentSpawnRecord(data: unknown): EvalAgentSpawnRecord | undefined {
	if (!isRecord(data) || typeof data.id !== "string") return undefined;
	return data.status === "unsettled" || data.status === "delivered" ? { id: data.id, status: data.status } : undefined;
}

/** The `agent()` id whose result a completed async job is about to deliver, if any. */
export function evalAgentResultId(job: AsyncJob | undefined): string | undefined {
	const details = job?.latestDetails;
	if (!isRecord(details) || !isRecord(details.evalResult) || !isRecord(details.evalResult.details)) return undefined;
	return typeof details.evalResult.details.id === "string" ? details.evalResult.details.id : undefined;
}
