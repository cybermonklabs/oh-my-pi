/**
 * `entry_patch` records: how a session file remembers fields set in place on
 * entries it already holds.
 *
 * Some passes change an entry after its line is written: a retry saga marks
 * the attempts it recovered (`retryRecovery`), compaction stamps its dead-end
 * `warning` and corrects `tokensAfter`, snapcompact stores its archive without
 * reasoning (`preserveData`), and an elide pass replaces heavy content with
 * placeholders. `SessionManager.patchEntries` sets those fields on the live
 * entries and appends one record listing them ({@link toEntryPatchData}),
 * instead of rewriting the whole transcript. The original lines stay in the
 * file, so every reader that loads a whole session file calls
 * {@link applyEntryPatches} after migration and after `applyToolResultPrunes`:
 * `SessionManager` resume and `forkFrom`, `loadSessionMessagesReadOnly`
 * (`history://` for parked agents), and the HTML sub-session export.
 *
 * Byte-offset tail readers (the Agent Hub transcript viewer, the collab agent
 * drawer, RPC subagent streaming) parse each line once as it lands and cannot
 * change a line they already emitted, so they show the fields as first
 * written; binaries older than the record show them the same way.
 *
 * A later full rewrite writes every patched field inline and writes each
 * record with no patches ({@link withoutEntryPatches}), so a field that a
 * later rewrite-only change replaced (images a later pass dropped from an
 * elided result) does not come back when the file is loaded.
 */
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ContextSnapshot, Message } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { CustomMessageEntry, FileEntry, SessionEntry } from "./session-entries";

export const ENTRY_PATCH_CUSTOM_TYPE = "entry_patch";

/** Top-level entry fields a patch may set. */
export interface EntryFieldsPatch {
	/** `warning` of a `compaction` entry: the dead-end warning on its divider. */
	readonly warning?: string;
	/** `tokensAfter` of a `compaction` entry, projected again after rescue tiers ran. */
	readonly tokensAfter?: number;
	/** `preserveData` of a `compaction` entry (the snapcompact archive without reasoning). */
	readonly preserveData?: Record<string, unknown>;
	/** `content` of a `custom_message` entry an elide pass shortened. */
	readonly content?: CustomMessageEntry["content"];
}

/** Fields of a `message` entry's message a patch may set. */
export interface MessageFieldsPatch {
	/** Assistant `retryRecovery`: how a retry saga settled the attempt. */
	readonly retryRecovery?: AssistantRetryRecovery;
	/** Assistant `contextSnapshot`: the usage anchor's record of tokens a history rewrite removed. */
	readonly contextSnapshot?: ContextSnapshot;
	/** Assistant `elidedOutputTokens`. */
	readonly elidedOutputTokens?: number;
	/** Tool result `prunedAt`. */
	readonly prunedAt?: number;
	/** `content` of a user, developer, assistant or tool-result message an elide pass shortened. */
	readonly content?: Message["content"];
}

/** Fields to set on one entry. */
export interface EntryPatch {
	/** Id of the entry to change. */
	readonly entryId: string;
	readonly entry?: EntryFieldsPatch;
	readonly message?: MessageFieldsPatch;
}

/** `data` of an `entry_patch` custom entry. */
export interface EntryPatchData {
	readonly patches: readonly EntryPatch[];
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function toEntryFields({ warning, tokensAfter, preserveData, content }: EntryFieldsPatch): EntryFieldsPatch {
	const fields: Writable<EntryFieldsPatch> = {};
	if (warning !== undefined) fields.warning = warning;
	if (tokensAfter !== undefined) fields.tokensAfter = tokensAfter;
	if (preserveData !== undefined) fields.preserveData = preserveData;
	if (content !== undefined) fields.content = content;
	return fields;
}

function toMessageFields({
	retryRecovery,
	contextSnapshot,
	elidedOutputTokens,
	prunedAt,
	content,
}: MessageFieldsPatch): MessageFieldsPatch {
	const fields: Writable<MessageFieldsPatch> = {};
	if (retryRecovery !== undefined) fields.retryRecovery = retryRecovery;
	if (contextSnapshot !== undefined) fields.contextSnapshot = contextSnapshot;
	if (elidedOutputTokens !== undefined) fields.elidedOutputTokens = elidedOutputTokens;
	if (prunedAt !== undefined) fields.prunedAt = prunedAt;
	if (content !== undefined) fields.content = content;
	return fields;
}

/**
 * The `data` to persist for one set of patches. Copies each field explicitly,
 * so a field a caller adds to a patch object does not silently become part of
 * the on-disk record.
 */
export function toEntryPatchData(patches: readonly EntryPatch[]): EntryPatchData {
	return {
		patches: patches.map(({ entryId, entry, message }) => {
			const patch: Writable<EntryPatch> = { entryId };
			if (entry) patch.entry = toEntryFields(entry);
			if (message) patch.message = toMessageFields(message);
			return patch;
		}),
	};
}

/** Message roles whose `content` an elide pass shortens. */
const CONTENT_ROLES: Record<string, true> = { user: true, developer: true, assistant: true, toolResult: true };

/** Whether every field `patch` names exists on `entry`'s kind. */
export function entryAcceptsPatch(entry: SessionEntry, patch: EntryPatch): boolean {
	const fields = patch.entry;
	if (fields) {
		const compactionFields =
			fields.warning !== undefined || fields.tokensAfter !== undefined || fields.preserveData !== undefined;
		if (compactionFields && entry.type !== "compaction") return false;
		if (fields.content !== undefined && entry.type !== "custom_message") return false;
	}
	const message = patch.message;
	if (!message) return true;
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	const assistantFields =
		message.retryRecovery !== undefined ||
		message.contextSnapshot !== undefined ||
		message.elidedOutputTokens !== undefined;
	if (assistantFields && role !== "assistant") return false;
	if (message.prunedAt !== undefined && role !== "toolResult") return false;
	return message.content === undefined || CONTENT_ROLES[role] === true;
}

/** Set `patch`'s fields on `entry`, which {@link entryAcceptsPatch} accepted. */
export function setPatchedFields(entry: SessionEntry, patch: EntryPatch): void {
	const fields = patch.entry;
	if (fields && entry.type === "compaction") {
		if (fields.warning !== undefined) entry.warning = fields.warning;
		if (fields.tokensAfter !== undefined) entry.tokensAfter = fields.tokensAfter;
		if (fields.preserveData !== undefined) entry.preserveData = fields.preserveData;
	}
	if (fields?.content !== undefined && entry.type === "custom_message") entry.content = fields.content;
	const patched = patch.message;
	if (!patched || entry.type !== "message") return;
	const message = entry.message;
	if (message.role === "assistant") {
		if (patched.retryRecovery !== undefined) message.retryRecovery = patched.retryRecovery;
		if (patched.contextSnapshot !== undefined) message.contextSnapshot = patched.contextSnapshot;
		if (patched.elidedOutputTokens !== undefined) message.elidedOutputTokens = patched.elidedOutputTokens;
	}
	if (patched.prunedAt !== undefined && message.role === "toolResult") message.prunedAt = patched.prunedAt;
	if (patched.content !== undefined && "content" in message && message.content !== patched.content) {
		// `entryAcceptsPatch` admits only roles whose `content` is one member of
		// `Message["content"]`; TypeScript cannot narrow the assignment across the union.
		const target: { content: Message["content"] } = message;
		target.content = patched.content;
		// The message keeps its identity across context rebuilds; drop its cached estimate.
		invalidateMessageCache(message);
	}
}

function isContent(value: unknown): value is Message["content"] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.every(block => isRecord(block) && typeof block.type === "string"))
	);
}

function isEntryFields(value: unknown): value is EntryFieldsPatch {
	return (
		isRecord(value) &&
		(value.warning === undefined || typeof value.warning === "string") &&
		(value.tokensAfter === undefined || typeof value.tokensAfter === "number") &&
		(value.preserveData === undefined || isRecord(value.preserveData)) &&
		(value.content === undefined || isContent(value.content))
	);
}

function isMessageFields(value: unknown): value is MessageFieldsPatch {
	return (
		isRecord(value) &&
		(value.retryRecovery === undefined || isRecord(value.retryRecovery)) &&
		(value.contextSnapshot === undefined || isRecord(value.contextSnapshot)) &&
		(value.elidedOutputTokens === undefined || typeof value.elidedOutputTokens === "number") &&
		(value.prunedAt === undefined || typeof value.prunedAt === "number") &&
		(value.content === undefined || isContent(value.content))
	);
}

function isEntryPatch(value: unknown): value is EntryPatch {
	return (
		isRecord(value) &&
		typeof value.entryId === "string" &&
		(value.entry === undefined || isEntryFields(value.entry)) &&
		(value.message === undefined || isMessageFields(value.message))
	);
}

function isEntryPatchData(value: unknown): value is EntryPatchData {
	return isRecord(value) && Array.isArray(value.patches) && value.patches.every(isEntryPatch);
}

/**
 * Set, in place, every field an `entry_patch` record in `entries` names, so
 * freshly loaded entries read as the live session's entries did. Records apply
 * in file order, so the newest value of a field wins, and applying them again
 * changes nothing. A record may precede its target. A malformed record, or a
 * patch whose target is missing or lacks a field it names, is skipped with a
 * warning.
 */
export function applyEntryPatches(entries: readonly FileEntry[]): void {
	let byId: Map<string, SessionEntry> | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_PATCH_CUSTOM_TYPE) continue;
		if (!isEntryPatchData(entry.data)) {
			logger.warn("Skipping malformed entry patch record", { id: entry.id });
			continue;
		}
		if (!byId) {
			byId = new Map();
			for (const candidate of entries) if (candidate.type !== "session") byId.set(candidate.id, candidate);
		}
		for (const patch of entry.data.patches) {
			const target = byId.get(patch.entryId);
			if (!target || !entryAcceptsPatch(target, patch)) {
				logger.warn("Entry patch record targets no matching entry", { id: entry.id, target: patch.entryId });
				continue;
			}
			setPatchedFields(target, patch);
		}
	}
}

const NO_PATCHES: EntryPatchData = { patches: [] };

/**
 * `entry` as a full rewrite writes it: an `entry_patch` record loses its
 * patches, because the rewrite writes every patched field inline. Replaying
 * the old values would undo a change made after the record that only a full
 * rewrite persists.
 */
export function withoutEntryPatches(entry: FileEntry): FileEntry {
	return entry.type === "custom" && entry.customType === ENTRY_PATCH_CUSTOM_TYPE
		? { ...entry, data: NO_PATCHES }
		: entry;
}
