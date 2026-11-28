/**
 * `entry_patch` records: how a session file remembers fields set in place on
 * entries it already holds.
 *
 * Some passes change an entry after its line is written: a retry saga marks
 * the attempts it recovered (`retryRecovery`), a continuation marks the failed
 * turn it continued from (`continued`), compaction stamps its dead-end
 * `warning` and corrects `tokensAfter`, snapcompact stores its archive without
 * reasoning (`preserveData`), and an elide pass replaces heavy content with
 * placeholders. `SessionManager.patchEntries` sets those fields on the live
 * entries and appends one record listing them ({@link toEntryPatchData}), so
 * the write's size follows the patched fields, not the transcript; when a
 * target's line holds 4 MiB or more, which a collab guest cannot fetch, it
 * rewrites the file instead, writing that line with the fields set. The
 * original lines stay in the file, so every reader that shows or derives from
 * a patched field applies the records, with the one implementation in
 * `@oh-my-pi/pi-utils/entry-patches` (this module adds logging and the message
 * cache to it):
 *
 * - Whole-file readers call {@link applyEntryPatches} after migration and after
 *   `applyToolResultPrunes`: `SessionManager` resume and `forkFrom`,
 *   `loadSessionMessagesReadOnly` (`history://` and `agent://` for parked
 *   agents), the HTML sub-session export, `omp anonymize`, and
 *   `omp gc --strip` to find the turn it keeps verbatim. A `SessionManager`
 *   that keeps the entries another writer appended to its file applies the
 *   records among them to the entries it holds.
 * - Memory extraction reads the rollout's records first, then its messages
 *   with them applied, so the extraction model gets an elide pass's
 *   placeholders; a storage it reads in chunks must give both reads one body.
 * - Readers of windows apply each window's records to its entries (the RPC
 *   subagent transcript, whose entries keep the records for a client that
 *   holds earlier windows) and to entries of earlier windows: the Agent Hub
 *   transcript viewer, local or over a collab host's replies, through an
 *   `EntryPatchReplay`, and Agent Activity, which shows the rows a patched
 *   turn's content yields ({@link assistantTurnContent}).
 * - The Agent Hub's history of a parked agent counts the tool calls, and
 *   finds the turn that produced output, of each turn's patched content.
 * - Readers that store what they derived apply a later record to the stored
 *   result: a stats tail read, or a `scripts/session-stats/sync.py` run
 *   (through `scripts/entry_patches.py`), that meets a record naming an entry
 *   an earlier read stored, or an entry with an id a record of an earlier read
 *   names, derives the session's rows again.
 * - The session picker applies the records of its 4 KiB prefix and its
 *   32 KiB tail window to the entries its prefix holds and to the last turn
 *   its status reads, and the records its line scan read (from the file's
 *   start to the line it stopped at), then the tail window's, to the prompt
 *   that scan finds. A record past the prefix that the tail window misses and
 *   the scan did not reach is not read, so a long session whose first prompt
 *   an elide pass shortened can still preview it in full; the prompt text the
 *   picker falls back to when no scan finds one (cut from the prefix's partial
 *   line) takes no record. Its search holds the messages of the file's first
 *   4 KiB as stored: a record that shortens an entry brings no later text
 *   into it.
 * - `omp gc --strip` strips replay data from a record's patched content as
 *   from the message's own line, and leaves a record the readers skip as
 *   written.
 *
 * Of entries that share an id, {@link applyEntryPatches}, an
 * `EntryPatchReplay`, the stats parser and the Python readers set a record's
 * fields on the last in the file only.
 *
 * The raw readers return the records unapplied, among the entries:
 * `loadSessionFile`, `loadEntriesFromFile`, `loadEntriesFromFileStream`,
 * `parseSessionEntries`, `visitSessionFile`, `visitEntriesFromFile`,
 * `visitEntriesFromFileStream` and `visitEntriesFromChunksSync`; so do
 * `get_entries`, `get_tree` and the RPC window's raw `entries`.
 * `scripts/bench-title-fork.ts` reads each session's first prompt raw, as
 * typed, since the titles it compares were made from that text. Readers of
 * other fields (header and title reads, entry ids, usage and cost) need no
 * record. Binaries older than the record show the fields as first written.
 *
 * A later full rewrite writes every patched field inline and writes each
 * record with no patches ({@link withoutEntryPatches}), so a field that a
 * later rewrite-only change replaced (images a later pass dropped from an
 * elided result) does not come back when the file is loaded.
 *
 * With session-store masking on, each patch reaches the store masked as its
 * fields are in the stored line of the entry it patches
 * ({@link maskEntryPatchRecord}), so the entry a load patches is the one a
 * full write stores.
 */
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ContextSnapshot, Message } from "@oh-my-pi/pi-ai";
import { cloneJsonTree, logger } from "@oh-my-pi/pi-utils";
import {
	applyEntryPatches as applyPatchRecords,
	type EntryFieldsPatch as StoredEntryFieldsPatch,
	type EntryPatch as StoredEntryPatch,
	type EntryPatchContent,
	type EntryPatchHooks,
	type EntryPatchSkip,
	type EntryPatchTargets as StoredEntryPatchTargets,
	isEntryPatchData,
	isEntryPatchRecord,
	type MessageFieldsPatch as StoredMessageFieldsPatch,
	patchFitsMessageRole,
	setPatchedFields as setStoredPatchFields,
} from "@oh-my-pi/pi-utils/entry-patches";
import type { SessionStoreMask } from "../secrets/session-store-mask";
import type { CustomEntry, CustomMessageEntry, FileEntry, SessionEntry } from "./session-entries";
import {
	type MaskedForm,
	maskEntryFields,
	maskMessageFields,
	maskSessionEntry,
	maskStoredData,
} from "./session-entry-mask";

// The record's own vocabulary lives in `@oh-my-pi/pi-utils/entry-patches`, with the
// apply logic every package shares; the SDK publishes it from here, as it always has.
export { ENTRY_PATCH_CUSTOM_TYPE, entryAcceptsPatch, isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";

/** Top-level entry fields a patch may set, typed as the session's entries hold them. */
export interface EntryFieldsPatch extends StoredEntryFieldsPatch {
	readonly preserveData?: Record<string, unknown>;
	readonly content?: CustomMessageEntry["content"];
}

/** Fields of a `message` entry's message a patch may set, typed as the session's messages hold them. */
export interface MessageFieldsPatch extends StoredMessageFieldsPatch {
	readonly retryRecovery?: AssistantRetryRecovery;
	readonly contextSnapshot?: ContextSnapshot;
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
	continued,
	contextSnapshot,
	elidedOutputTokens,
	prunedAt,
	content,
}: MessageFieldsPatch): MessageFieldsPatch {
	const fields: Writable<MessageFieldsPatch> = {};
	if (retryRecovery !== undefined) fields.retryRecovery = cloneJsonTree(retryRecovery);
	if (continued !== undefined) fields.continued = continued;
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

/** A session's entries by id: where a patch or prune record finds the entry it names. */
export type EntryPatchTargets = StoredEntryPatchTargets<SessionEntry>;

function warnSkipped(skip: EntryPatchSkip): void {
	switch (skip.reason) {
		case "malformed":
			logger.warn("Skipping malformed entry patch record", { id: skip.recordId });
			return;
		case "missing-target":
			logger.warn("Entry patch record targets no matching entry", { id: skip.recordId, target: skip.entryId });
			return;
		case "misfit":
			logger.warn("Skipping entry patch that does not fit its target", { id: skip.recordId, target: skip.entryId });
			return;
	}
}

/**
 * How a session's own readers apply records: each skipped record is logged,
 * and a message whose `content` a patch replaced drops its cached estimate.
 */
export const SESSION_ENTRY_PATCH_HOOKS: EntryPatchHooks<FileEntry> = {
	onSkip: warnSkipped,
	onMessageContentSet: entry => {
		if (entry.type === "message") invalidateMessageCache(entry.message);
	},
};

/** {@link SESSION_ENTRY_PATCH_HOOKS} for a window of a transcript, where a target before the window is not missing. */
export const WINDOW_ENTRY_PATCH_HOOKS: EntryPatchHooks<FileEntry> = {
	onSkip: skip => {
		if (skip.reason !== "missing-target") warnSkipped(skip);
	},
	onMessageContentSet: SESSION_ENTRY_PATCH_HOOKS.onMessageContentSet,
};

/**
 * Set `patch`'s fields on `entry`, as `@oh-my-pi/pi-utils/entry-patches`'
 * `setPatchedFields` does, dropping the cached estimate of a message whose
 * `content` it replaced.
 */
export function setPatchedFields(entry: SessionEntry, patch: EntryPatch): void {
	setStoredPatchFields<FileEntry>(entry, patch, SESSION_ENTRY_PATCH_HOOKS);
}

/**
 * Set, in place, every field an `entry_patch` record in `entries` names, so
 * freshly loaded entries read as the live session's entries did
 * (`applyEntryPatches` of `@oh-my-pi/pi-utils/entry-patches`). `targets`
 * finds the entry a patch names; by default it is one of `entries`. A
 * malformed record, or a patch whose target is missing, lacks a field it
 * names, or holds `content` of another shape, is skipped with a warning.
 * Returns whether any field was set.
 */
export function applyEntryPatches(entries: readonly FileEntry[], targets?: EntryPatchTargets): boolean {
	return applyPatchRecords(entries, { ...SESSION_ENTRY_PATCH_HOOKS, targets });
}

/**
 * The `content` `patch` sets on the assistant turn it names, or `undefined`
 * when it sets none or names a field an assistant turn lacks: for a reader
 * that keeps only what it derived from a turn's content (its tool calls, the
 * rows it shows) and sets that again from a record.
 */
export function assistantTurnContent(patch: StoredEntryPatch): EntryPatchContent | undefined {
	const content = patch.message?.content;
	return content !== undefined && patchFitsMessageRole(patch, "assistant") ? content : undefined;
}

/** `data` of an `entry_patch` record that sets no field. */
export const NO_PATCHES: EntryPatchData = { patches: [] };

/**
 * `entry` as a full rewrite writes it: an `entry_patch` record loses its
 * patches, because the rewrite writes every patched field inline. Replaying
 * the old values would undo a change made after the record that only a full
 * rewrite persists.
 */
export function withoutEntryPatches(entry: FileEntry): FileEntry {
	return isEntryPatchRecord(entry) ? { ...entry, data: NO_PATCHES } : entry;
}

/**
 * `value` with each own field's value replaced by what `maskField` gives for
 * it, in key order; `value` itself when every field keeps its value.
 */
function maskFields<T extends object>(value: T, maskField: (key: string, field: unknown) => unknown): T {
	const fields = Object.entries(value);
	let changed = false;
	for (const field of fields) {
		const masked = maskField(field[0], field[1]);
		if (Object.is(masked, field[1])) continue;
		field[1] = masked;
		changed = true;
	}
	// `fromEntries` defines each key as its own field, a parsed `__proto__` included.
	return changed ? (Object.fromEntries(fields) as T) : value;
}

/**
 * `record`, an `entry_patch` record read in `form`, as the store holds it
 * under `mask`; the live record keeps its values. Its own fields are masked as
 * every entry's are ({@link maskSessionEntry}). Each patch is masked as its
 * fields are in the stored line of the entry it names, found in `targets`:
 * that entry's `type` and its message's `role`, which a cold entry keeps in
 * memory, choose the rules, so a signed block whose text masking changes loses
 * its signature as it does there, a field that entry keeps stays as written,
 * and `entryId` is kept. A patch naming an entry `targets` lacks (one an
 * atomic batch rolled back) has no such rules: masked as free data, it is left
 * out of the stored record when masking changes it, so no masked text is
 * stored beside its signature. Any other field of the data is masked as free
 * data, and data of another shape as any `custom` entry's is.
 */
export function maskEntryPatchRecord(
	record: CustomEntry,
	targets: EntryPatchTargets,
	mask: SessionStoreMask | null,
	form: MaskedForm,
): CustomEntry {
	if (mask === null || mask.empty) return record;
	const data = record.data;
	if (!isEntryPatchData(data)) return maskSessionEntry(record, mask, form);
	let patches: StoredEntryPatch[] | undefined;
	for (let index = 0; index < data.patches.length; index++) {
		const patch = data.patches[index]!;
		const target = targets.get(patch.entryId);
		let masked: StoredEntryPatch | undefined;
		if (target) {
			masked = maskFields(patch, (key, value) => {
				// Kept, as the entry's own `id` is.
				if (key === "entryId") return value;
				if (key === "entry") return maskEntryFields(value, target.type, mask, form);
				if (key === "message" && target.type === "message") {
					return maskMessageFields(value, target.message.role, mask, form);
				}
				return maskStoredData(value, mask, form);
			});
		} else if (maskStoredData(patch, mask, form) === patch) {
			masked = patch;
		}
		if (patches === undefined) {
			if (masked === patch) continue;
			patches = data.patches.slice(0, index);
		}
		if (masked !== undefined) patches.push(masked);
	}
	const maskedData = maskFields(data, (key, value) =>
		key === "patches" ? (patches ?? value) : maskStoredData(value, mask, form),
	);
	// The record's own fields; its data is masked above.
	const fields = { ...record, data: NO_PATCHES };
	const maskedFields = maskSessionEntry(fields, mask, form);
	if (maskedFields === fields && maskedData === data) return record;
	return { ...maskedFields, data: maskedData };
}
