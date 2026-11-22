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
import { once } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { MemoryBackendId } from "./types";

export const MEMORY_RECALL_ENTRY_TYPE = "memory_recall";

/**
 * Whether `backend` recalls into the conversation (Hindsight, Mnemopi): only then is a transcript's recall the
 * conversation's own, which the session sends again ({@link findConversationRecall}).
 */
export function recallsIntoConversation(backend: MemoryBackendId): boolean {
	return backend === "hindsight" || backend === "mnemopi";
}

/**
 * Hidden message reporting what changed in a reused recall's memories. Its details
 * ({@link MemoryRecallChangesDetails}) carry the memories still current, so the
 * report and its bookkeeping reach the transcript together, only once delivered.
 * The session keeps every report the reused recall carries ({@link findDeliveredRecallChanges}),
 * and a model call whose context holds no message with a report's text (a compaction
 * summarized it, a branch it is not on) sends that report again after its newest content.
 */
export const MEMORY_RECALL_CHANGES_MESSAGE_TYPE = "memory-recall-changes";

/** A {@link MEMORY_RECALL_CHANGES_MESSAGE_TYPE} message's text and its backend's details. */
export interface RecallChangesReport {
	content: string;
	details: unknown;
}

/**
 * Hidden message carrying a recall that first succeeded after the conversation's prompt had been
 * sent without one: delivered after the turn's newest content instead of as a new system block, so
 * the cached prompt holds. The session keeps that recall as the conversation's own
 * (`AgentSession.memoryRecall`): a model call whose context holds no such message with it (a
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

/** The recall `entry` records ({@link MEMORY_RECALL_ENTRY_TYPE}) with the scope it read; undefined for any other entry. */
function recordedRecall(entry: SessionEntry): MemoryRecallEntryData | undefined {
	return entry.type === "custom" &&
		entry.customType === MEMORY_RECALL_ENTRY_TYPE &&
		isMemoryRecallEntryData(entry.data)
		? entry.data
		: undefined;
}

/**
 * The newest recall `branch` recorded with the text `text` at or before `from`, since its last context reset;
 * undefined without one.
 */
function newestRecordedRecall(
	branch: readonly SessionEntry[],
	text: string,
	from: number,
): MemoryRecallEntryData | undefined {
	for (let index = from; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "reset_boundary") return undefined;
		const recall = recordedRecall(entry);
		if (recall?.text === text) return recall;
	}
	return undefined;
}

/**
 * The recall the hidden {@link MEMORY_RECALL_MESSAGE_TYPE} message at `index` of `branch` carries, unless it is
 * another scope's than `scope` (any is taken without it): the newest recall recorded before it with its text, since
 * the last context reset, read another scope. Undefined for any other entry. The message names no scope; the backend
 * records the recall it carries, with the scope it read, when it adopts it, and one no record names (a backend that
 * records none) is not another scope's.
 */
function hiddenRecallOf(
	branch: readonly SessionEntry[],
	index: number,
	scope: (() => string | undefined) | undefined,
): string | undefined {
	const message = branch[index];
	if (
		message.type !== "custom_message" ||
		message.customType !== MEMORY_RECALL_MESSAGE_TYPE ||
		typeof message.content !== "string"
	) {
		return undefined;
	}
	if (!scope) return message.content;
	const recorded = newestRecordedRecall(branch, message.content, index - 1);
	return recorded === undefined || recorded.scope === scope() ? message.content : undefined;
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
		} else if (turnFollowed) {
			const recall = recordedRecall(entry);
			if (recall?.scope === scope) return { text: recall.text, memories: reported ?? recall.memories };
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
 * The recall the branch delivered as a hidden {@link MEMORY_RECALL_MESSAGE_TYPE} message since its last context reset:
 * the newest one, or with `scope`, the scope the live backend's recall reads (read once, only when the branch holds a
 * hidden recall), the newest one of that scope. The sign that a recall the backend reuses went out as a hidden message.
 */
export function findDeliveredRecall(
	branch: readonly SessionEntry[],
	scope?: () => string | undefined,
): string | undefined {
	const live = scope && once(scope);
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index].type === "reset_boundary") return undefined;
		const hidden = hiddenRecallOf(branch, index, live);
		if (hidden !== undefined) return hidden;
	}
	return undefined;
}

/**
 * The recall a conversation carries since its last context reset, and how it rides: as a hidden
 * {@link MEMORY_RECALL_MESSAGE_TYPE} message, or as the system prompt's own last block, as a recall
 * the conversation's first request sent goes out. A prompt build leaves it out of the memory
 * instructions (`recallDelivered`) and, for a block, appends it after the prompt as that block.
 */
export interface ConversationRecall {
	text: string;
	hidden: boolean;
}

/**
 * `blocks` with `recall` as its own last block ({@link ConversationRecall}): `blocks` itself when it ends
 * with that block already, else a copy with the block appended.
 */
export function appendRecallBlock(blocks: string[], recall: string): string[] {
	return blocks.at(-1) === recall ? blocks : [...blocks, recall];
}

/**
 * The recall a loaded transcript's branch leaves the conversation carrying ({@link ConversationRecall}), of `scope`, the
 * scope the live backend's recall reads (read once, only when the branch holds a recall): the newest one of that scope
 * it delivered as a hidden message since its last context reset, else the newest recall of that scope it recorded since
 * then that a turn followed, whose request sent it as the system prompt's last block. Undefined without one, and when
 * that recall found nothing. Another backend's, bank's or server's recall is not the conversation's: that backend
 * recalls afresh.
 */
export function findConversationRecall(
	branch: readonly SessionEntry[],
	scope: () => string | undefined,
): ConversationRecall | undefined {
	const live = once(scope);
	let turnFollowed = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "reset_boundary") return undefined;
		if (entry.type === "message") {
			turnFollowed = true;
			continue;
		}
		const hidden = hiddenRecallOf(branch, index, live);
		if (hidden !== undefined) return { text: hidden, hidden: true };
		const recall = turnFollowed ? recordedRecall(entry) : undefined;
		if (recall && recall.scope === live()) return recall.text ? { text: recall.text, hidden: false } : undefined;
	}
	return undefined;
}

/**
 * The {@link MEMORY_RECALL_CHANGES_MESSAGE_TYPE} reports of `scope`, the scope the live backend's recall reads (read
 * once, only when the branch holds a recall or a report), the branch delivered for the recall it reuses: every one
 * since the newest recall of that scope it recorded or its last context reset, oldest first, each text once. A loaded
 * transcript's reports, and those before a reused recall's new one; another scope's reports report on another recall.
 */
export function findDeliveredRecallChanges(
	branch: readonly SessionEntry[],
	scope: () => string | undefined,
): RecallChangesReport[] {
	const live = once(scope);
	const start =
		branch.findLastIndex(entry => {
			if (entry.type === "reset_boundary") return true;
			const recall = recordedRecall(entry);
			return recall !== undefined && recall.scope === live();
		}) + 1;
	const reports: RecallChangesReport[] = [];
	const seen = new Set<string>();
	for (let index = start; index < branch.length; index++) {
		const entry = branch[index];
		if (
			entry.type !== "custom_message" ||
			entry.customType !== MEMORY_RECALL_CHANGES_MESSAGE_TYPE ||
			typeof entry.content !== "string" ||
			seen.has(entry.content) ||
			!isMemoryRecallChangesDetails(entry.details) ||
			entry.details.scope !== live()
		) {
			continue;
		}
		seen.add(entry.content);
		reports.push({ content: entry.content, details: entry.details });
	}
	return reports;
}

/**
 * Whether `text` is a recall the branch recorded since its last context reset, of whichever scope: a stored prompt
 * whose last block it is carries that recall as its own block.
 */
export function isRecordedRecall(branch: readonly SessionEntry[], text: string): boolean {
	return newestRecordedRecall(branch, text, branch.length - 1) !== undefined;
}

/**
 * A memory backend's `instructions` without `recall`, the recall the conversation carries itself
 * ({@link ConversationRecall}), as a hidden message or as the prompt's own last block, where they carry it verbatim:
 * the fallback for a backend that ignores `recallDelivered`. A backend that re-renders its recall, as Mnemopi cuts its
 * own to the current token budget on every render, may carry text this search misses, so it leaves the recall out
 * itself.
 */
export function withoutDeliveredRecall(instructions: string | undefined, recall: string): string | undefined {
	if (!instructions || !recall) return instructions;
	const index = instructions.lastIndexOf(recall);
	if (index < 0) return instructions;
	const rest = `${instructions.slice(0, index).trimEnd()}${instructions.slice(index + recall.length)}`.trim();
	return rest || undefined;
}
