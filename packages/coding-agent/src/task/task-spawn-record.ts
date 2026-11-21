import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * A persisted subagent spawn, the task tool's or a work pool's, written before its run starts:
 * its allocated id is positive evidence for `--restore`.
 */
export const TASK_SPAWN_MESSAGE_TYPE = "task_spawn";

export interface TaskSpawnRecord {
	id: string;
	/**
	 * The task tool aborted the spawn's run, and no call result reports it: a launch its call
	 * did not adopt, or dropped before it ran. Such a run is not the parent's work. An id's
	 * latest record decides: a later process can allocate the id again.
	 */
	discarded?: true;
}

/** Parses a task-spawn custom entry. */
export function readTaskSpawnRecord(data: unknown): TaskSpawnRecord | undefined {
	if (!isRecord(data) || typeof data.id !== "string") return undefined;
	return data.discarded === true ? { id: data.id, discarded: true } : { id: data.id };
}
