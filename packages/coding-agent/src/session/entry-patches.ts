/**
 * `entry_patch` records: how a session file remembers fields set in place on
 * entries it already holds.
 *
 * Some passes change an entry after its line is written: a retry saga marks
 * the attempts it recovered (`retryRecovery`), compaction stamps its dead-end
 * `warning` and corrects `tokensAfter`, snapcompact stores its archive without
 * reasoning (`preserveData`), and an elide pass replaces heavy content with
 * placeholders. `SessionManager.patchEntries` sets those fields on the live
 * entries and appends one record listing them ({@link toEntryPatchData}), so
 * the write's size follows the patched fields, not the transcript. The
 * original lines stay in the file, so every reader that loads a whole session
 * file calls {@link applyEntryPatches} after migration and after
 * `applyToolResultPrunes`: `SessionManager` resume and `forkFrom`,
 * `loadSessionMessagesReadOnly` (`history://` for parked agents), and the HTML
 * sub-session export. A `SessionManager` that keeps the entries another writer
 * appended to its file applies the records among them to the entries it holds.
 *
 * The readers that show a subagent's transcript as they read it, the RPC
 * subagent transcript and the Agent Hub transcript viewer, read a byte range
 * of the file and call {@link applyEntryPatchesInWindow} on its entries, so
 * each entry they return carries every record the range holds. A record
 * written after a reader returned its target does not change that entry: the
 * RPC result lists the record among its raw entries, and the viewer shows the
 * field when it next reads the file from its start (on opening it, or after a
 * rewrite). The collab agent drawer and binaries older than the record show
 * the fields as first written.
 *
 * A later full rewrite writes every patched field inline and writes each
 * record with no patches ({@link withoutEntryPatches}), so a field that a
 * later rewrite-only change replaced (images a later pass dropped from an
 * elided result) does not come back when the file is loaded.
 */
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ContextSnapshot, Message } from "@oh-my-pi/pi-ai";
import { cloneJsonTree, isRecord, logger } from "@oh-my-pi/pi-utils";
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
	if (preserveData !== undefined) fields.preserveData = cloneJsonTree(preserveData);
	if (content !== undefined) fields.content = cloneJsonTree(content);
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
	if (retryRecovery !== undefined) fields.retryRecovery = cloneJsonTree(retryRecovery);
	if (contextSnapshot !== undefined) fields.contextSnapshot = cloneJsonTree(contextSnapshot);
	if (elidedOutputTokens !== undefined) fields.elidedOutputTokens = elidedOutputTokens;
	if (prunedAt !== undefined) fields.prunedAt = prunedAt;
	if (content !== undefined) fields.content = cloneJsonTree(content);
	return fields;
}

/**
 * The `data` to persist for one set of patches. Copies each field explicitly,
 * so a field a caller adds to a patch object does not silently become part of
 * the on-disk record, and copies each object value ({@link cloneJsonTree}), so
 * the record shares no object with the entries the caller patches.
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

/**
 * Message roles whose `content` an elide pass shortens, each with whether that
 * `content` may be a string; assistant and tool-result `content` is always a
 * list of blocks.
 */
const CONTENT_TAKES_STRING: Record<Message["role"], boolean> = {
	user: true,
	developer: true,
	assistant: false,
	toolResult: false,
};

function isContentRole(role: string): role is Message["role"] {
	return Object.hasOwn(CONTENT_TAKES_STRING, role);
}

/** Whether every field `patch` names exists on `entry`'s kind, with a `content` of the shape its role holds. */
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
	if (message.content === undefined) return true;
	return isContentRole(role) && (CONTENT_TAKES_STRING[role] || typeof message.content !== "string");
}

/**
 * `value` for `holder[key]`: `value` itself when `holder` already holds it
 * there, else a copy. Reads `key`'s own data descriptor, so no accessor runs
 * to answer the identity check.
 */
function ownCopy<H extends object, K extends keyof H>(holder: H, key: K, value: H[K]): H[K] {
	return Object.getOwnPropertyDescriptor(holder, key)?.value === value ? value : cloneJsonTree(value);
}

/**
 * Set `patch`'s fields on `entry`, which {@link entryAcceptsPatch} accepted.
 * Each object value is copied ({@link cloneJsonTree}, which shares the
 * immutable strings) unless `entry` already holds that very value, so `entry`
 * never shares an object with a record: a later in-place write to `entry`,
 * such as an elide or prune pass writing into `content`, leaves the record as
 * written and succeeds when the record's data was read back frozen.
 */
export function setPatchedFields(entry: SessionEntry, patch: EntryPatch): void {
	const fields = patch.entry;
	if (fields && entry.type === "compaction") {
		if (fields.warning !== undefined) entry.warning = fields.warning;
		if (fields.tokensAfter !== undefined) entry.tokensAfter = fields.tokensAfter;
		if (fields.preserveData !== undefined) entry.preserveData = ownCopy(entry, "preserveData", fields.preserveData);
	}
	if (fields?.content !== undefined && entry.type === "custom_message") {
		entry.content = ownCopy(entry, "content", fields.content);
	}
	const patched = patch.message;
	if (!patched || entry.type !== "message") return;
	const message = entry.message;
	if (message.role === "assistant") {
		if (patched.retryRecovery !== undefined) {
			message.retryRecovery = ownCopy(message, "retryRecovery", patched.retryRecovery);
		}
		if (patched.contextSnapshot !== undefined) {
			message.contextSnapshot = ownCopy(message, "contextSnapshot", patched.contextSnapshot);
		}
		if (patched.elidedOutputTokens !== undefined) message.elidedOutputTokens = patched.elidedOutputTokens;
	}
	if (patched.prunedAt !== undefined && message.role === "toolResult") message.prunedAt = patched.prunedAt;
	if (
		patched.content !== undefined &&
		"content" in message &&
		Object.getOwnPropertyDescriptor(message, "content")?.value !== patched.content
	) {
		// `entryAcceptsPatch` admits only roles whose `content` is one member of
		// `Message["content"]`; TypeScript cannot narrow the assignment across the union.
		const target: { content: Message["content"] } = message;
		target.content = cloneJsonTree(patched.content);
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

/** Where {@link applyEntryPatches} finds the entry a patch names. */
export interface EntryPatchTargets {
	get(entryId: string): SessionEntry | undefined;
}

function entriesById(entries: readonly FileEntry[]): Map<string, SessionEntry> {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) if (entry.type !== "session") byId.set(entry.id, entry);
	return byId;
}

function applyRecords(
	entries: readonly FileEntry[],
	targets: EntryPatchTargets | undefined,
	warnMissingTarget: boolean,
): boolean {
	let lookup = targets;
	let changed = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_PATCH_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isEntryPatchData(data)) {
			logger.warn("Skipping malformed entry patch record", { id: entry.id });
			continue;
		}
		lookup ??= entriesById(entries);
		for (const patch of data.patches) {
			const target = lookup.get(patch.entryId);
			if (!target) {
				if (warnMissingTarget) {
					logger.warn("Entry patch record targets no matching entry", { id: entry.id, target: patch.entryId });
				}
				continue;
			}
			if (!entryAcceptsPatch(target, patch)) {
				logger.warn("Skipping entry patch that does not fit its target", { id: entry.id, target: patch.entryId });
				continue;
			}
			setPatchedFields(target, patch);
			changed = true;
		}
	}
	return changed;
}

/**
 * Set, in place, every field an `entry_patch` record in `entries` names, so
 * freshly loaded entries read as the live session's entries did. `targets`
 * finds the entry a patch names; by default it is one of `entries`. Records
 * apply in file order, so the newest value of a field wins, and applying them
 * again changes nothing. A record may precede its target. A malformed record,
 * or a patch whose target is missing, lacks a field it names, or holds
 * `content` of another shape, is skipped with a warning. Returns whether any
 * field was set.
 */
export function applyEntryPatches(entries: readonly FileEntry[], targets?: EntryPatchTargets): boolean {
	return applyRecords(entries, targets, true);
}

/**
 * {@link applyEntryPatches} on `entries`, the complete lines of a byte range of
 * a transcript that a reader shows as it reads. A patch whose target is not
 * among them is skipped with no warning: its target lies before the range,
 * where the reader returned it earlier.
 */
export function applyEntryPatchesInWindow(entries: readonly FileEntry[]): void {
	applyRecords(entries, undefined, false);
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
