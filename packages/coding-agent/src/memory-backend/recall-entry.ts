/**
 * Keeps a transcript's first-turn memory recall with the transcript.
 *
 * The recall block becomes part of the system prompt, so it is history: a
 * session resumed in a new process sends the block it was sent with instead of
 * recalling again from a memory store that has changed since, which would
 * change the prompt bytes and miss every provider prompt-cache entry built on
 * them. Backends that can look memories up again also record which memories
 * the block holds, so a resume can report what changed since as a new message
 * rather than rewriting the block.
 *
 * The transcript also keeps the last failed automatic recall, so a session
 * resumed in a new process waits out the same pause before recalling again.
 */
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

export const MEMORY_RECALL_ENTRY_TYPE = "memory_recall";

/** Custom entry recording the last failed automatic recall of a scope. */
export const MEMORY_RECALL_FAILURE_ENTRY_TYPE = "memory_recall_failure";

/**
 * Hidden message reporting what changed in a reused recall's memories. Its details
 * ({@link MemoryRecallChangesDetails}) carry the memories still current, so the
 * report and its bookkeeping reach the transcript together, only once delivered.
 */
export const MEMORY_RECALL_CHANGES_MESSAGE_TYPE = "memory-recall-changes";

/** One memory in a recall block, as last reported to the model. */
export interface RecalledMemory {
	id: string;
	/** The memory's text as the model last saw it: the recall preview, clipped. */
	text: string;
	/** The block's token budget cut this memory: `text` is the visible prefix only. */
	cut?: true;
}

export interface PersistedRecall {
	/** Recall block, `""` when the recall found nothing. */
	text: string;
	/** Memories the block holds that are still current as far as the model knows. */
	memories: RecalledMemory[];
}

/** A failed automatic recall, as last recorded for a scope. */
export interface RecallFailure {
	/** When the recall failed, epoch ms. */
	at: number;
	/** Consecutive failed recalls it ends; `0` once a recall answered since. */
	failures: number;
	/** The failure's cause. */
	error: string;
}

/** Details of a {@link MEMORY_RECALL_CHANGES_MESSAGE_TYPE} message. */
export interface MemoryRecallChangesDetails {
	scope: string;
	/** The reused recall's memories still current after the report. */
	memories: RecalledMemory[];
}

interface MemoryRecallEntryData extends PersistedRecall {
	version: 1;
	/**
	 * Backend and memory banks the recall read. A recall is only restored into
	 * the same scope, so a backend switch or a cwd move never carries one
	 * project's memories into another.
	 */
	scope: string;
}

interface MemoryRecallFailureEntryData extends RecallFailure {
	version: 1;
	/** Backend and memory banks the recall read, as {@link MemoryRecallEntryData.scope}. */
	scope: string;
}

function isRecalledMemories(value: unknown): value is RecalledMemory[] {
	return (
		Array.isArray(value) &&
		value.every(
			memory =>
				typeof memory === "object" &&
				memory !== null &&
				"id" in memory &&
				typeof memory.id === "string" &&
				"text" in memory &&
				typeof memory.text === "string" &&
				(!("cut" in memory) || memory.cut === true),
		)
	);
}

function isMemoryRecallEntryData(data: unknown): data is MemoryRecallEntryData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"text" in data &&
		typeof data.text === "string" &&
		"memories" in data &&
		isRecalledMemories(data.memories)
	);
}

function isMemoryRecallFailureEntryData(data: unknown): data is MemoryRecallFailureEntryData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"at" in data &&
		typeof data.at === "number" &&
		Number.isFinite(data.at) &&
		"failures" in data &&
		typeof data.failures === "number" &&
		Number.isInteger(data.failures) &&
		data.failures >= 0 &&
		"error" in data &&
		typeof data.error === "string"
	);
}

function isMemoryRecallChangesDetails(details: unknown): details is MemoryRecallChangesDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		"scope" in details &&
		typeof details.scope === "string" &&
		"memories" in details &&
		isRecalledMemories(details.memories)
	);
}

/**
 * The latest recall for `scope` on the current branch that a turn followed, with the
 * memories still current per the latest change report delivered after it. Undefined
 * when the branch needs a fresh recall: none was recorded since the last context
 * reset, or no turn followed one (a branch that edits the first prompt asks a
 * different question).
 */
export function findPersistedRecall(
	sessionManager: Pick<SessionManager, "getBranch">,
	scope: string,
): PersistedRecall | undefined {
	const entries: SessionEntry[] = sessionManager.getBranch();
	let turnFollowed = false;
	let reported: RecalledMemory[] | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "reset_boundary") return undefined;
		if (entry.type === "message") {
			turnFollowed = true;
		} else if (entry.type === "custom_message" && entry.customType === MEMORY_RECALL_CHANGES_MESSAGE_TYPE) {
			if (reported === undefined && isMemoryRecallChangesDetails(entry.details) && entry.details.scope === scope) {
				reported = entry.details.memories;
			}
		} else if (
			turnFollowed &&
			entry.type === "custom" &&
			entry.customType === MEMORY_RECALL_ENTRY_TYPE &&
			isMemoryRecallEntryData(entry.data) &&
			entry.data.scope === scope
		) {
			return { text: entry.data.text, memories: reported ?? entry.data.memories };
		}
	}
	return undefined;
}

/** Records a fresh recall. */
export function persistRecall(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	scope: string,
	recall: PersistedRecall,
): void {
	sessionManager.appendCustomEntry(MEMORY_RECALL_ENTRY_TYPE, {
		version: 1,
		scope,
		text: recall.text,
		memories: recall.memories,
	} satisfies MemoryRecallEntryData);
}

/**
 * The latest failed automatic recall recorded for `scope` on the current branch, or
 * undefined when none was, or a recall of that scope was recorded after it. A context
 * reset does not end it: the server's health is not conversation state.
 */
export function findRecallFailure(
	sessionManager: Pick<SessionManager, "getBranch">,
	scope: string,
): RecallFailure | undefined {
	const entries: SessionEntry[] = sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom") continue;
		if (entry.customType === MEMORY_RECALL_ENTRY_TYPE) {
			if (isMemoryRecallEntryData(entry.data) && entry.data.scope === scope) return undefined;
		} else if (
			entry.customType === MEMORY_RECALL_FAILURE_ENTRY_TYPE &&
			isMemoryRecallFailureEntryData(entry.data) &&
			entry.data.scope === scope
		) {
			return { at: entry.data.at, failures: entry.data.failures, error: entry.data.error };
		}
	}
	return undefined;
}

/** Records the failure state of `scope`'s automatic recall. */
export function persistRecallFailure(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	scope: string,
	failure: RecallFailure,
): void {
	sessionManager.appendCustomEntry(MEMORY_RECALL_FAILURE_ENTRY_TYPE, {
		version: 1,
		scope,
		at: failure.at,
		failures: failure.failures,
		error: failure.error,
	} satisfies MemoryRecallFailureEntryData);
}
