import type { ModeChangeEntry } from "./session-entries";

/**
 * The mark a cold session entry's message carries (`convertToColdEntry` in
 * `cold-entries.ts`): a hidden slot naming the entry whose record in the store
 * holds the message's bodies. Kept apart from `cold-entries.ts` so that the
 * message conversion (`messages.ts`) can tell a cold message without importing
 * the store, which imports the conversion's own importers.
 */
export const COLD_OWNER = Symbol("omp.coldOwner");

/** The hidden slot of a cold entry's message. */
export interface ColdMessageSlots {
	[COLD_OWNER]?: object;
}

/** Whether `message` is a cold entry's message, whose bodies are read back from the store on access. */
export function isColdMessage(message: object): boolean {
	const slots: ColdMessageSlots = message;
	return slots[COLD_OWNER] !== undefined;
}

/**
 * The mark a cold `custom_message` entry carries: whether it is a request the
 * context of a rollover compaction takes from before its kept entries
 * (`isRolloverRequestEntry` in `session-context.ts`), decided as the entry
 * went cold. The walk that looks for that request passes over the older
 * custom messages on every context build, and a parent's IRC message is told
 * by a flag inside its `details`, which a cold entry reads back from the
 * store; the mark answers for it from memory. Kept here, as {@link COLD_OWNER}
 * is, so the context build can read it without importing the store.
 */
export const COLD_ROLLOVER_REQUEST = Symbol("omp.coldRolloverRequest");

/** The hidden slot of a cold `custom_message` entry. */
export interface ColdCustomMessageSlots {
	[COLD_ROLLOVER_REQUEST]?: boolean;
}

/** {@link COLD_ROLLOVER_REQUEST} of `entry`; undefined unless it is a cold `custom_message`. */
export function coldRolloverRequestMark(entry: object): boolean | undefined {
	const slots: ColdCustomMessageSlots = entry;
	return slots[COLD_ROLLOVER_REQUEST];
}

/**
 * The mark a cold `mode_change` entry carries: the `approvedPlanFilePath` its
 * `data` names, or null when it names none, taken as the entry went cold. A
 * session's construction walks the mode changes back to the newest plan mode
 * for the plan a reviewer approved, and a goal records a mode change on every
 * turn whose `data` (the goal) a cold entry reads back from the store; the
 * mark answers for it from memory. Kept here, as {@link COLD_OWNER} is, so
 * the session can read it without importing the store.
 */
export const COLD_APPROVED_PLAN_FILE = Symbol("omp.coldApprovedPlanFile");

/** The hidden slot of a cold `mode_change` entry. */
export interface ColdModeChangeSlots {
	[COLD_APPROVED_PLAN_FILE]?: string | null;
}

/** The approved plan file mode change `entry` names, or null: from its mark while cold, so no record is read. */
export function approvedPlanFileOf(entry: ModeChangeEntry): string | null {
	const slots: ColdModeChangeSlots = entry as object;
	const mark = slots[COLD_APPROVED_PLAN_FILE];
	if (mark !== undefined) return mark;
	const planFile = entry.data?.approvedPlanFilePath;
	return typeof planFile === "string" ? planFile : null;
}
