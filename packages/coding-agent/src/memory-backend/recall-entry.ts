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
 */
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

export const MEMORY_RECALL_ENTRY_TYPE = "memory_recall";

/**
 * Hidden message reporting what changed in a reused recall's memories. Its details
 * ({@link MemoryRecallChangesDetails}) carry the memories still current, so the
 * report and its bookkeeping reach the transcript together, only once delivered.
 */
export const MEMORY_RECALL_CHANGES_MESSAGE_TYPE = "memory-recall-changes";

/**
 * Hidden message carrying a recall that first succeeded after the conversation's prompt had been
 * sent without one: delivered after the turn's newest content instead of as a new system block, so
 * the cached prompt holds. The session keeps that recall as the conversation's own
 * (`AgentSession.hiddenMemoryRecall`): a model call whose context holds no such message with it (a
 * branch the message is not on, a compaction that summarized it, an older recall in its place) sends
 * it again after its newest content, a resume does not add it to the system prompt, and a prompt
 * rebuild asks the backend to leave it out of the memory instructions (`recallDelivered`).
 */
export const MEMORY_RECALL_MESSAGE_TYPE = "memory-recall";

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
 * The recall the branch delivered as a hidden {@link MEMORY_RECALL_MESSAGE_TYPE} message since its
 * last context reset: the newest one. A loaded transcript's hidden recall, and the sign that a recall
 * the backend reuses from it went out that way.
 */
export function findDeliveredRecall(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "reset_boundary") return undefined;
		if (
			entry.type === "custom_message" &&
			entry.customType === MEMORY_RECALL_MESSAGE_TYPE &&
			typeof entry.content === "string"
		) {
			return entry.content;
		}
	}
	return undefined;
}

/**
 * A memory backend's `instructions` without `recall`, the recall the conversation carries as a hidden message, where
 * they carry it verbatim: the fallback for a backend that ignores `recallDelivered`. A backend that re-renders its
 * recall, as Mnemopi cuts its own to the current token budget on every render, may carry text this search misses, so
 * it leaves the recall out itself.
 */
export function withoutDeliveredRecall(instructions: string | undefined, recall: string): string | undefined {
	if (!instructions || !recall) return instructions;
	const index = instructions.lastIndexOf(recall);
	if (index < 0) return instructions;
	const rest = `${instructions.slice(0, index).trimEnd()}${instructions.slice(index + recall.length)}`.trim();
	return rest || undefined;
}
