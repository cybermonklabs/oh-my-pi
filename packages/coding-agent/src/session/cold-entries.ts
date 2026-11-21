/**
 * Older entry bodies out of memory: on disk, or compressed in memory where no
 * store file can be used.
 *
 * The model context only needs the entries of the current branch from the
 * latest compaction's cut on (see {@link coldBoundary}). An entry before the
 * cut, or off the current branch, becomes *cold*, as do, from the cut on, the
 * records no context or turn reads there ({@link isStoredPastCut}, but for the
 * newest of a kind kept whole by position) and a compaction older than every
 * compaction a context build reads: the same object, converted in place, whose
 * small values stay data properties and whose large values become enumerable
 * accessors that read the entry's record back from a {@link ColdEntryStore}.
 * A cold message keeps as
 * data only the small values of the fields that readers walking the whole
 * branch on every turn read ({@link MESSAGE_FIELDS_KEPT_WHILE_SMALL}); its
 * other fields are accessors whatever their size. A cold to-do edit or tool
 * start marker keeps as data only its tree fields, `customType` and a small
 * `runtime` ({@link isCoreColdCustom}). `JSON.stringify`, spread and
 * `structuredClone` still see every field. A read returns a deep-frozen value,
 * so a place that writes into a nested value of a cold body fails with a
 * `TypeError` instead of losing the write; assigning a field
 * (`entry.message = …`, `message.content = …`) first makes the whole entry
 * whole again ({@link hydrateColdEntry}).
 *
 * Accessor functions are shared per field name and find their entry's record
 * through a symbol-keyed property, so a cold entry costs no closure.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compactionKeptStart } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger, stringifyJson } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isPidAlive } from "@oh-my-pi/pi-utils/pid";
import { type BlobStore, isBlobRef } from "./blob-store";
import {
	approvedPlanFileOf,
	COLD_APPROVED_PLAN_FILE,
	COLD_OWNER,
	COLD_ROLLOVER_REQUEST,
	type ColdCustomMessageSlots,
	type ColdMessageSlots,
	type ColdModeChangeSlots,
	coldApprovedPlanFileMark,
	coldRolloverRequestMark,
} from "./cold-message";
import { CONTEXT_NOTES_ENTRY_TYPE, contextNotesEntriesRead } from "./context-notes";
import { SESSION_EXIT_CUSTOM_TYPE, TOOL_EXECUTION_START_CUSTOM_TYPE } from "./exit-diagnostics";
import { forgetConvertMemo } from "./messages";
import { getReadableCompactionEntry, isRolloverRequestEntry } from "./session-context";
import {
	type CompactionEntry,
	type FileEntry,
	type SessionEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	TODO_HUD_STATE_CUSTOM_TYPE,
	todoSnapshotPhases,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "./session-entries";
import { repairTruncatedSnapcompactFrames, resolveBlobRefsInEntriesSync } from "./session-loader";
import { entryRecordText } from "./session-persistence";

/**
 * A string value of a cold entry stays in memory up to this many UTF-16 units:
 * ids, roles, stop reasons and most providers, models, tool names and call ids
 * fit. A message's identity strings stay whatever their length
 * ({@link MESSAGE_IDENTITY_FIELDS}).
 */
export const COLD_STRING_MAX_UNITS = 64;
/**
 * An object or array value of a cold entry stays in memory while its JSON
 * text fits in this many bytes: a message's `usage` (at most 279 bytes in a
 * long measured session) fits, as do small tool and card details.
 */
export const COLD_JSON_MAX_BYTES = 320;
/** Materialized records kept for the next field read of the same entries. */
const CACHE_ENTRIES = 8;
/**
 * Bytes the materialized records kept may hold together, each counted with
 * its images resolved ({@link freezeAndMeasure}): a record holds an image as
 * a blob reference, its materialized form as the whole base64 data. A
 * snapcompact frame stays a blob reference in both, read through
 * `lazyImageDataSync` when a context build selects it.
 */
const CACHE_BYTES = 16 * 1024 * 1024;
/**
 * Records are written to the store's file, or compressed into one block when
 * the store keeps them in memory, in batches of about this size: a batch
 * closes at the record that takes it past this size, and a file store's read
 * of a record still gathered writes the batch at once, so a write can be
 * smaller and so can the block a failed write leaves.
 */
const WRITE_BATCH_BYTES = 1024 * 1024;
/**
 * zstd level of a block of records kept in memory. Measured on two long
 * transcripts: 17.2 MiB of records took 3.9 MiB, 344.3 MiB took 65.7 MiB, and
 * a read of one record (decompress its 1 MiB block, slice it) 1.6 to 2.0 ms.
 */
const BLOCK_ZSTD_LEVEL = 3;
/**
 * Record bytes read back, or written by a load, between two full collections.
 * One synchronous loop over many cold entries (an extension reading every
 * message's content at a session start) would otherwise pile up the parse
 * garbage of every record it reads before the engine collects any of it, and
 * a load the values of every entry it converts. Loading a 344 MiB transcript
 * and then running such a loop peaked at 1,227 MiB resident unpaced and at
 * about 620 MiB with this value, the loop about a second slower and the load
 * about two; 32 and 64 MiB peaked higher.
 */
const COLLECT_AFTER_RECORD_BYTES = 16 * 1024 * 1024;
/** Record bytes counted since the last collection the pacing ran, across stores. */
let recordBytesSinceCollection = 0;

/** Count `bytes` of records; past {@link COLLECT_AFTER_RECORD_BYTES}, run a full collection and count again. */
function paceCollection(bytes: number): void {
	recordBytesSinceCollection += bytes;
	if (recordBytesSinceCollection < COLLECT_AFTER_RECORD_BYTES) return;
	recordBytesSinceCollection = 0;
	Bun.gc(true);
}

/**
 * Entry types that stay whole before the cut: extension and feature state
 * (every `custom` type but those {@link keptWholeByKind} names), and the
 * selections a resume restores (model of each role, thinking level, service
 * tier, TTSR rules, labels, credential pins, `/clear` boundaries, usage,
 * titles). {@link entriesKeptWholeOnPath} adds entries by position, among
 * them the newest mode change.
 */
const ENTRY_TYPES_KEPT_WHOLE: ReadonlySet<string> = new Set<SessionEntry["type"]>([
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"ttsr_injection",
	"label",
	"credential_pin",
	"reset_boundary",
	"model_usage",
	TITLE_CHANGE_ENTRY_TYPE,
]);

/**
 * The `custom` type of the patch records that hold the new values of the
 * entries they patch, which a load applies to those entries; no turn reads
 * the records themselves.
 */
const PATCH_RECORD_CUSTOM_TYPE = "entry_patch";

/**
 * `custom` types of the core that go cold too, every value but the tree
 * fields, `customType` and a small `runtime` read back from the store however
 * small. The `runtime` is one object per build ({@link LoadedValueInterner}),
 * so keeping it costs nothing, and `/session` reads it of every entry. A
 * user's edit of the to-do list holds the whole list, of which the restore
 * reads only the newest snapshot on the path, kept whole by position
 * ({@link entriesKeptWholeOnPath}); a tool start marker is read only for the
 * calls left pending at the end of the branch, which lie after the cut.
 */
function isCoreColdCustom(entry: SessionEntry): boolean {
	// Compared when called, not gathered into a set when this module loads: the modules that
	// define these types can still be loading then, in an import cycle through this one.
	return (
		entry.type === "custom" &&
		(entry.customType === USER_TODO_EDIT_CUSTOM_TYPE || entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE)
	);
}

/** Whether `entry` stays whole wherever it lies, by its type ({@link ENTRY_TYPES_KEPT_WHOLE}). */
export function keptWholeByKind(entry: SessionEntry): boolean {
	if (!ENTRY_TYPES_KEPT_WHOLE.has(entry.type) || isCoreColdCustom(entry) || isStoredPastCut(entry)) return false;
	// The context reads only the notebook revisions it builds from, kept whole by position.
	return entry.type !== "custom" || entry.customType !== CONTEXT_NOTES_ENTRY_TYPE;
}

/** Fields that always stay data: the tree structure every walk reads. */
const ENTRY_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp", "activeLeafId"]);
/** The fields of a cold entry of {@link isCoreColdCustom} that stay data. */
const CORE_CUSTOM_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set([...ENTRY_FIELDS_IN_MEMORY, "customType"]);
/** The fields of a cold entry of {@link isCoreColdCustom} that stay data while small. */
const CORE_CUSTOM_FIELDS_KEPT_WHILE_SMALL: ReadonlySet<string> = new Set(["runtime"]);
const MESSAGE_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set(["role"]);
/**
 * The fields of a cold message that stay data while small: those that readers
 * walking the whole branch read of every message. The check whether a new
 * message is persisted already keys every message on the branch again after
 * each entry that is not a message (every tool call appends a start marker)
 * by `timestamp`, `provider`, `model`, `responseId`, `stopReason`,
 * `toolCallId`, `toolName` and `attribution`; the prompt cache scan of a new
 * branch view reads `stopReason` and `usage`; the to-do restore `toolName`
 * and `isError`; the retry checks that find a failed reply `errorMessage`;
 * the prune passes that run at the end of every turn read `prunedAt`
 * (`collectSupersededResults` and `collectUselessResults`) and `useless`
 * (`collectUselessResults`) of the results from the latest compaction's
 * boundary on (that compaction itself when it kept no entry), which is the
 * whole branch when the boundary is not on it; `api`, `customType` and
 * `display` tell extensions what a message is. The strings of
 * {@link MESSAGE_IDENTITY_FIELDS} stay data whatever their length.
 */
const MESSAGE_FIELDS_KEPT_WHILE_SMALL: ReadonlySet<string> = new Set([
	"timestamp",
	"stopReason",
	"toolCallId",
	"toolName",
	"isError",
	"provider",
	"model",
	"api",
	"usage",
	"responseId",
	"customType",
	"display",
	"attribution",
	"errorMessage",
	"prunedAt",
	"useless",
]);
/**
 * The fields of {@link MESSAGE_FIELDS_KEPT_WHILE_SMALL} that name what a
 * message is and whom it answers: a string value of one stays data whatever
 * its length. They are bounded identifiers a provider or a tool assigns, not
 * bodies a turn writes, and the per-turn readers key every message on the
 * branch by them, so one behind an accessor reads that message's record back
 * from the store on every turn: an OpenAI Responses tool call id is its
 * `call_id` and item id joined (81 characters), and a Bedrock application
 * inference profile ARN as a model id runs past 64 too.
 */
const MESSAGE_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
	"toolCallId",
	"responseId",
	"provider",
	"model",
	"api",
	"toolName",
	"customType",
]);

/** The compactions a context build on a path can start from. */
export interface ReadCompactions {
	/**
	 * The newest compaction on the path, the one a build with no model starts
	 * from, then the newest the model can replay when that is another one;
	 * null where the path has no compaction, or none the model can replay.
	 */
	readonly distinct: readonly (CompactionEntry | null)[];
}

/** {@link ReadCompactions} of `path` for `model`. */
export function readCompactions(path: readonly SessionEntry[], model: Model | undefined): ReadCompactions {
	const newest = getReadableCompactionEntry(path, undefined);
	const readable = model ? getReadableCompactionEntry(path, model) : newest;
	return { distinct: readable === newest ? [newest] : [newest, readable] };
}

/**
 * Entries of `path` kept whole before the cut although their type is not:
 * the newest `session_init` (the contract a revived subagent rebuilds from),
 * the newest canonical to-do snapshot, a `todo` result that records the list
 * or a user's edit of it (what the to-do list restores from), the newest to-do
 * HUD choice and the newest mode change (what a resume restores; of an older
 * one a resume reads only its mode and the approved plan file it names, both
 * in memory: {@link COLD_APPROVED_PLAN_FILE}), the notebook revisions every
 * context build reads ({@link contextNotesEntriesRead}), and the request the
 * context of an `experimental-context-rollover` compaction takes from before
 * its kept entries ({@link rolloverRequest}), for each of `compactions`.
 */
export function entriesKeptWholeOnPath(path: readonly SessionEntry[], compactions: ReadCompactions): Set<SessionEntry> {
	const kept = new Set<SessionEntry>(contextNotesEntriesRead(path));
	let sessionInit = false;
	let todo = false;
	let hudState = false;
	let modeChange = false;
	for (let index = path.length - 1; index >= 0 && !(sessionInit && todo && hudState && modeChange); index--) {
		const entry = path[index]!;
		if (entry.type === "session_init") {
			if (!sessionInit) kept.add(entry);
			sessionInit = true;
		} else if (entry.type === "mode_change") {
			if (!modeChange) kept.add(entry);
			modeChange = true;
		} else if (entry.type === "custom" && entry.customType === TODO_HUD_STATE_CUSTOM_TYPE) {
			if (!hudState) kept.add(entry);
			hudState = true;
		} else if (!todo && todoSnapshotPhases(entry)) {
			kept.add(entry);
			todo = true;
		}
	}
	for (const compaction of compactions.distinct) {
		const request = compaction ? rolloverRequest(path, compaction) : undefined;
		if (request) kept.add(request);
	}
	return kept;
}

/**
 * The request the model context of `compaction` on `path` takes from before
 * its kept entries, as `buildSessionContext` recovers it for an
 * `experimental-context-rollover` compaction: the newest request
 * ({@link isRolloverRequestEntry}) between the newest `/clear` boundary and
 * the compaction, when it lies before `firstKeptEntryId`. Undefined for any
 * other compaction, and when a `/clear` boundary after the compaction starts
 * the context instead.
 */
function rolloverRequest(path: readonly SessionEntry[], compaction: CompactionEntry): SessionEntry | undefined {
	if (!isRecord(compaction.details) || compaction.details.kind !== "experimental-context-rollover") return undefined;
	const compactionIndex = path.indexOf(compaction);
	const resetIndex = path.findLastIndex(entry => entry.type === "reset_boundary");
	if (resetIndex > compactionIndex) return undefined;
	const firstKeptIndex = path.findIndex(entry => entry.id === compaction.firstKeptEntryId);
	for (let index = compactionIndex - 1; index > resetIndex; index--) {
		const entry = path[index]!;
		if (!isRolloverRequestEntry(entry)) continue;
		return index < firstKeptIndex ? entry : undefined;
	}
	return undefined;
}

/**
 * Index in `path` of the cut for the leaf that `path` ends at: the first entry
 * the context keeps ({@link compactionKeptStart}) of each of `compactions`,
 * whichever comes first. 0 (nothing cold) when the context uses no compaction.
 */
export function coldCutPathIndex(path: readonly SessionEntry[], compactions: ReadCompactions): number {
	let start = path.length;
	for (const compaction of compactions.distinct) {
		if (!compaction) return 0;
		start = Math.min(start, compactionKeptStart(path, compaction, path.indexOf(compaction)));
	}
	return start;
}

/**
 * Index in `entries` of the first entry kept by the compaction that is the last
 * of `entries`, for a load that has read the transcript up to that compaction:
 * the entry {@link compactionKeptStart} would find, searched only from `from`
 * on. A kept start before `from` gives `from`; a compaction whose kept entry
 * was not loaded keeps only itself.
 */
export function streamedKeptStart(
	entries: readonly SessionEntry[],
	compaction: CompactionEntry,
	from: number,
	isLoaded: (id: string) => boolean,
): number {
	const at = entries.length - 1;
	const { firstKeptEntryId, providerReplayThroughEntryId } = compaction;
	const keptId = firstKeptEntryId === "" ? providerReplayThroughEntryId : firstKeptEntryId;
	if (!keptId) return at;
	for (let index = at - 1; index >= from; index--) {
		if (entries[index]!.id !== keptId) continue;
		return keptId === firstKeptEntryId ? index : Math.min(index + 1, at);
	}
	return isLoaded(keptId) ? from : at;
}

/** Short strings shared across a load's entries; longer ones are mostly unique. */
const INTERNED_STRING_MAX_UNITS = 64;
/** Runtimes are shared up to this JSON length: a source checkout's, with commit and branch, runs past 64. */
const INTERNED_RUNTIME_MAX_UNITS = 256;
/** Distinct values one load shares at most, so unique values cannot grow the tables without bound. */
const INTERNED_VALUES_MAX = 16_384;

/**
 * Shares equal values among the entries one load parses, which the parser
 * gives each its own copy of: short strings of the entry and of its message
 * (a string's identity is not observable), each `parentId` with its parent's
 * `id`, and the `runtime` identity, the same for every entry one build wrote,
 * which is frozen once shared. Memory per entry is what a long session's
 * older entries keep in memory, so the copies add up.
 */
export class LoadedValueInterner {
	readonly #strings = new Map<string, string>();
	readonly #runtimes = new Map<string, object>();

	/** Share `entry`'s values with the entries already interned; `parent` is its parent entry, if loaded. */
	intern(entry: SessionEntry, parent: SessionEntry | undefined): void {
		const holder = entry as unknown as Record<string, unknown>;
		this.#internStrings(holder);
		if (parent && entry.parentId === parent.id) holder.parentId = parent.id;
		const runtime = holder.runtime;
		if (typeof runtime === "object" && runtime !== null) holder.runtime = this.#internRuntime(runtime);
		const message = entry.type === "message" ? holder.message : undefined;
		if (typeof message === "object" && message !== null && !Array.isArray(message)) {
			this.#internStrings(message as Record<string, unknown>);
		}
	}

	#internStrings(holder: Record<string, unknown>): void {
		for (const key of Object.keys(holder)) {
			if (key === "id" || key === "parentId" || key === "timestamp") continue;
			const value = holder[key];
			if (typeof value !== "string" || value.length > INTERNED_STRING_MAX_UNITS) continue;
			const shared = this.#strings.get(value);
			if (shared !== undefined) holder[key] = shared;
			else if (this.#strings.size < INTERNED_VALUES_MAX) this.#strings.set(value, value);
		}
	}

	#internRuntime(runtime: object): object {
		const key = stringifyJson(runtime);
		if (key === undefined || key.length > INTERNED_RUNTIME_MAX_UNITS) return runtime;
		const shared = this.#runtimes.get(key);
		if (shared) return shared;
		if (this.#runtimes.size >= INTERNED_VALUES_MAX) return runtime;
		this.#runtimes.set(key, Object.freeze(runtime));
		return runtime;
	}
}

/** Which entries are cold for one leaf and model. */
export interface ColdBoundary {
	/** By index in the entries it was computed for: 1 where the entry belongs in the store. */
	readonly cold: Uint8Array;
}

/**
 * Which of `entries` (file order) belong in the store while the leaf ends
 * `path`: every entry except those the context reads (the current path from
 * the cut on, but the records no context or turn reads there:
 * {@link isStoredPastCut}, and a compaction older than every compaction a
 * build reads, as the stale entry a snapcompact frame rescue replaces), those
 * kept whole by kind ({@link keptWholeByKind}) and those kept whole by
 * position on the path ({@link entriesKeptWholeOnPath}). An entry off the
 * current path is cold wherever it lies.
 */
export function coldBoundary(
	entries: readonly SessionEntry[],
	path: readonly SessionEntry[],
	model: Model | undefined,
): ColdBoundary {
	const compactions = readCompactions(path, model);
	const cut = coldCutPathIndex(path, compactions);
	const whole = cut > 0 ? entriesKeptWholeOnPath(path, compactions) : new Set<SessionEntry>();
	const firstReadCompaction = cut > 0 ? firstReadCompactionIndex(path, compactions) : 0;
	for (let index = cut; index < path.length; index++) {
		const entry = path[index]!;
		if (cut > 0 && (isStoredPastCut(entry) || (entry.type === "compaction" && index < firstReadCompaction))) continue;
		whole.add(entry);
	}
	const cold = new Uint8Array(entries.length);
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (!whole.has(entry) && !keptWholeByKind(entry)) cold[index] = 1;
	}
	return { cold };
}

/**
 * Index in `path` of the oldest of `compactions`, the oldest compaction a
 * context build reads: the newest compaction, or the newest the model can
 * replay when that one is older; a build for the model passes over those
 * between them, reading their preserved data. Nothing reads a compaction
 * before it but for its small values (the display transcript marks it
 * superseded).
 */
function firstReadCompactionIndex(path: readonly SessionEntry[], compactions: ReadCompactions): number {
	let first = path.length;
	for (const compaction of compactions.distinct) first = Math.min(first, compaction ? path.indexOf(compaction) : 0);
	return first;
}

/**
 * Whether `entry` goes to the store from the cut on too, unless kept whole by
 * position: a record no turn reads (a patch record, which a load applies; a
 * `session_exit` record, of which a resume reads only the newest's kind and
 * how many tool calls were pending, not their arguments), or one a newer
 * entry of its kind supersedes (a user's edit of the to-do list, a to-do HUD
 * choice, a mode change: only the newest on the path is read whole; of an
 * older mode change a resume reads only its mode and the approved plan file it
 * names, both in memory: {@link COLD_APPROVED_PLAN_FILE}).
 */
function isStoredPastCut(entry: SessionEntry): boolean {
	if (entry.type === "mode_change") return true;
	if (entry.type !== "custom") return false;
	const type = entry.customType;
	return (
		type === PATCH_RECORD_CUSTOM_TYPE ||
		type === USER_TODO_EDIT_CUSTOM_TYPE ||
		type === SESSION_EXIT_CUSTOM_TYPE ||
		type === TODO_HUD_STATE_CUSTOM_TYPE
	);
}

/** Whether the entry at index `index` belongs in the store under `boundary`; an entry added since is whole. */
export function belongsCold(boundary: ColdBoundary, index: number): boolean {
	return boundary.cold[index] === 1;
}

/** Where one entry's record lives, read from the entry's hidden slots. */
interface ColdRecord {
	readonly store: ColdEntryStore;
	readonly offset: number;
	readonly length: number;
}

// A record's location is kept as three hidden values on the entry (no object
// per entry); copies of a cold entry carry the same three.
const COLD_STORE = Symbol("omp.coldStore");
const COLD_OFFSET = Symbol("omp.coldOffset");
const COLD_LENGTH = Symbol("omp.coldLength");
const COLD_MESSAGE = Symbol("omp.coldMessage");
/** On an entry made whole again: the record it had, which it takes back if it goes cold unchanged. */
const COLD_FORMER = Symbol("omp.coldFormer");

interface ColdEntrySlots {
	[COLD_STORE]?: ColdEntryStore;
	[COLD_OFFSET]?: number;
	[COLD_LENGTH]?: number;
	[COLD_MESSAGE]?: object;
	[COLD_FORMER]?: ColdRecord;
}

function recordOf(entry: object): ColdRecord | undefined {
	const slots: ColdEntrySlots = entry;
	const store = slots[COLD_STORE];
	if (!store) return undefined;
	return { store, offset: slots[COLD_OFFSET] ?? 0, length: slots[COLD_LENGTH] ?? 0 };
}

function setHiddenSlot(target: object, key: symbol, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
}

function setRecordSlots(target: object, record: ColdRecord): void {
	setHiddenSlot(target, COLD_STORE, record.store);
	setHiddenSlot(target, COLD_OFFSET, record.offset);
	setHiddenSlot(target, COLD_LENGTH, record.length);
}

/** Whether `entry` keeps values in a {@link ColdEntryStore}. */
export function isColdEntry(entry: object): boolean {
	const slots: ColdEntrySlots = entry;
	return slots[COLD_STORE] !== undefined;
}

/** The materialized record of cold `entry`, shared and frozen. */
function materializedRecordOf(entry: object): Readonly<Record<string, unknown>> {
	const record = recordOf(entry);
	if (!record) throw new Error("A cold session entry lost its record.");
	return record.store.materialize(record);
}

function ownerOf(message: object): object {
	const slots: ColdMessageSlots = message;
	const owner = slots[COLD_OWNER];
	if (!owner) throw new Error("A cold session message lost its entry.");
	return owner;
}

const entryFieldAccessors = new Map<string, PropertyDescriptor>();
const messageFieldAccessors = new Map<string, PropertyDescriptor>();

function entryFieldAccessor(key: string): PropertyDescriptor {
	let accessor = entryFieldAccessors.get(key);
	if (!accessor) {
		accessor = {
			get(this: object): unknown {
				return materializedRecordOf(this)[key];
			},
			set(this: object, value: unknown): void {
				hydrateColdEntry(this);
				Reflect.set(this, key, value);
			},
			enumerable: true,
			configurable: true,
		};
		entryFieldAccessors.set(key, accessor);
	}
	return accessor;
}

function messageFieldAccessor(key: string): PropertyDescriptor {
	let accessor = messageFieldAccessors.get(key);
	if (!accessor) {
		accessor = {
			get(this: object): unknown {
				const message = materializedRecordOf(ownerOf(this)).message;
				return typeof message === "object" && message !== null ? Reflect.get(message, key) : undefined;
			},
			set(this: object, value: unknown): void {
				hydrateColdEntry(ownerOf(this));
				Reflect.set(this, key, value);
			},
			enumerable: true,
			configurable: true,
		};
		messageFieldAccessors.set(key, accessor);
	}
	return accessor;
}

/** `entry.message` of a cold entry: the same message object, whose own large values are accessors. */
const entryMessageAccessor: PropertyDescriptor = {
	get(this: object): unknown {
		const slots: ColdEntrySlots = this;
		return slots[COLD_MESSAGE];
	},
	set(this: object, value: unknown): void {
		hydrateColdEntry(this);
		Reflect.set(this, "message", value);
	},
	enumerable: true,
	configurable: true,
};

function isAccessorFrom(target: object, key: string, accessors: ReadonlyMap<string, PropertyDescriptor>): boolean {
	const getter = Object.getOwnPropertyDescriptor(target, key)?.get;
	return getter !== undefined && getter === accessors.get(key)?.get;
}

/**
 * Fields of `holder` a cold entry reads back from the store, in key order:
 * every one not in `inMemory` that is too large to keep, and every one not in
 * `whileSmall` whatever its size (with `whileSmall` undefined, any field stays
 * while small). A string of a field in `identities` stays whatever its length.
 */
function coldFields(
	holder: Record<string, unknown>,
	inMemory: ReadonlySet<string>,
	whileSmall: ReadonlySet<string> | undefined,
	identities?: ReadonlySet<string>,
): string[] {
	const keys: string[] = [];
	for (const key of Object.keys(holder)) {
		if (inMemory.has(key)) continue;
		const value = holder[key];
		if (identities?.has(key) && typeof value === "string" && !isBlobRef(value)) continue;
		if ((whileSmall && !whileSmall.has(key)) || !staysInMemory(value)) keys.push(key);
	}
	return keys;
}

/**
 * Whether a value of a cold entry stays a data property. A value holding a
 * blob reference never does: only a read through the store resolves it.
 */
function staysInMemory(value: unknown): boolean {
	if (typeof value === "string") return value.length <= COLD_STRING_MAX_UNITS && !isBlobRef(value);
	if (typeof value !== "object" || value === null) return true;
	return jsonFits(value, COLD_JSON_MAX_BYTES);
}

/**
 * Whether `value`'s JSON text fits in `limit` UTF-8 bytes and holds no blob
 * reference. A walk that counts each UTF-16 unit as one byte bounds the text
 * from below and stops as soon as it passes the limit, so a large value is
 * rejected without serializing it.
 */
function jsonFits(value: object, limit: number): boolean {
	let lowerBound = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item === "string") {
			if (isBlobRef(item)) return false;
			lowerBound += item.length + 2;
		} else if (typeof item === "number" || typeof item === "boolean" || item === null) lowerBound += 1;
		else if (Array.isArray(item)) {
			lowerBound += item.length + 1;
			if (lowerBound > limit) return false;
			for (const element of item) pending.push(element);
		} else if (typeof item === "object") {
			lowerBound += 1;
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				const child: unknown = Reflect.get(item, key);
				if (child === undefined || typeof child === "function") continue;
				lowerBound += key.length + 3;
				pending.push(child);
			}
		}
		if (lowerBound > limit) return false;
	}
	const text = stringifyJson(value);
	return text === undefined || Buffer.byteLength(text, "utf8") <= limit;
}

/**
 * Deep-freeze `value` and return a lower bound of its JSON text's length,
 * counting each UTF-16 unit as one byte as {@link jsonFits} does. For a
 * materialized record that is its size with each image resolved to the
 * base64 data its blob reference stands for; a snapcompact frame counts as
 * the blob reference it stays.
 */
function freezeAndMeasure(value: unknown): number {
	let units = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item === "string") units += item.length + 2;
		else if (typeof item !== "object" || item === null) units += 1;
		else if (!Object.isFrozen(item)) {
			Object.freeze(item);
			if (Array.isArray(item)) {
				units += item.length + 1;
				for (const element of item) pending.push(element);
			} else {
				units += 1;
				for (const key of Object.keys(item)) {
					units += key.length + 3;
					pending.push(Reflect.get(item, key));
				}
			}
		}
	}
	return units;
}

/** What the finalizer needs to release a store's file; must not refer to the store. */
interface StoreHandle {
	fd: number;
	/** Set on Windows, where an open file cannot be unlinked: deleted when the store goes. */
	path: string | undefined;
	/** Set once `fd` is closed: the number may belong to another file since. */
	closed: boolean;
}

/** Records from store offset `start` to `end`, whole, kept compressed in memory. */
interface CompressedBlock {
	readonly start: number;
	readonly end: number;
	readonly data: Uint8Array;
}

/** A {@link CompressedBlock} decompressed: its records' bytes, from store offset `block.start`. */
interface DecompressedBlock {
	readonly block: CompressedBlock;
	readonly data: Buffer;
}

const windowsStoreHandles = new Set<StoreHandle>();
let windowsExitHookInstalled = false;
/**
 * Whether a store whose file could not be made was reported; the cause is the
 * host's, so once per process is enough.
 */
let openFailureLogged = false;
/** A store file's name: the pid of the process that made it, then a UUID. */
const STORE_FILE_NAME = /^(\d+)-[0-9a-f-]+\.jsonl$/;
/** Whether this process swept the store directory ({@link sweepStaleStores}). */
let staleStoresSwept = false;

/**
 * Delete from `dir` the store files of processes that are gone, at the first
 * store a process opens; for Windows, where a store's file is deleted only
 * when the store closes, is collected or at exit, so a killed process leaves
 * its file, which holds its entries unmasked. A file whose pid a live process
 * has (its own, or a dead one's pid reused) stays until a later sweep finds
 * that pid gone.
 */
function sweepStaleStores(dir: string): void {
	if (staleStoresSwept) return;
	staleStoresSwept = true;
	for (const name of fs.readdirSync(dir)) {
		const match = STORE_FILE_NAME.exec(name);
		if (!match || isPidAlive(Number(match[1]))) continue;
		try {
			fs.rmSync(path.join(dir, name), { force: true });
		} catch {
			// Still held open by some process: a later process's sweep takes it.
		}
	}
}

/**
 * Throw unless `dir` is a directory, not a link to one, that account `uid`
 * owns and no other account can enter: `mkdirSync` takes a directory that
 * exists as it is, which another account could have made first.
 */
function assertPrivateDirectory(dir: string, uid: number): void {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`${dir} is not a directory this account owns alone`);
	}
}

/**
 * Make a store's file under `os.tmpdir()/omp-cold-<uid>/`, a directory the
 * account owns alone, and unlink it once open outside Windows. Throws when the
 * file cannot be made (`os.tmpdir()` read-only, under a regular file, full,
 * out of descriptors) or the directory is not the account's alone.
 */
function openStoreFile(): StoreHandle {
	// One directory per account: `os.tmpdir()` is shared between accounts on
	// Linux and the directory is 0700, so under one shared name the first
	// account would own it and every other account's open would fail.
	const uid = process.getuid?.();
	const dir = path.join(os.tmpdir(), uid === undefined ? "omp-cold" : `omp-cold-${uid}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const windows = process.platform === "win32";
	if (windows) sweepStaleStores(dir);
	else if (uid !== undefined) assertPrivateDirectory(dir, uid);
	const file = path.join(dir, `${process.pid}-${crypto.randomUUID()}.jsonl`);
	const fd = fs.openSync(file, "wx+", 0o600);
	const handle: StoreHandle = { fd, path: undefined, closed: false };
	if (windows) {
		handle.path = file;
		trackWindowsStore(handle);
		return handle;
	}
	try {
		fs.unlinkSync(file);
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
	return handle;
}

function releaseStoreHandle(handle: StoreHandle): void {
	if (handle.closed) return;
	handle.closed = true;
	try {
		fs.closeSync(handle.fd);
	} catch {
		// Already closed.
	}
	if (handle.path === undefined) return;
	windowsStoreHandles.delete(handle);
	try {
		fs.unlinkSync(handle.path);
	} catch {
		// Already gone.
	}
}

/** Closes a store's descriptor once no manager and no cold entry refers to the store. */
const storeRegistry = new FinalizationRegistry<StoreHandle>(releaseStoreHandle);

function trackWindowsStore(handle: StoreHandle): void {
	windowsStoreHandles.add(handle);
	if (windowsExitHookInstalled) return;
	windowsExitHookInstalled = true;
	process.once("exit", () => {
		for (const pending of windowsStoreHandles) releaseStoreHandle(pending);
	});
}

interface CachedRecord {
	readonly entry: Readonly<Record<string, unknown>>;
	/** The record's size with its images resolved ({@link freezeAndMeasure}), at least its bytes in the store. */
	readonly bytes: number;
}

/**
 * One loaded manager's records of cold entries, with one of two backings.
 * Normally a file under `os.tmpdir()/omp-cold-<uid>/`, a directory the account
 * owns alone, unlinked as soon as it is open on POSIX (its disk is freed when
 * the descriptor closes, and a killed process leaves nothing; on Windows it is
 * deleted when the store is closed or collected and at exit, and a later
 * process deletes a killed process's file at its first store open, unless
 * that pid is in use again). Where that file cannot be made, and from a
 * failed write to it on (a full disk), the records are kept in memory instead,
 * zstd-compressed in blocks of whole records of about
 * {@link WRITE_BATCH_BYTES}; the records gathered for the next block stay as
 * bytes, and the records the file already holds are read from it. A read of a
 * record in a block decompresses that block, and the reads after it in the
 * same synchronous pass share it while they stay in that block, so a pass over
 * the records in store order decompresses each block once; the block is
 * dropped as soon as the pass ends (in a microtask), leaving only the parsed
 * records in the record cache. No other directory is used. A record is
 * the entry exactly as the manager held it, with image data replaced by blob
 * references. Every cold entry refers to its store, so a clone sharing the
 * entries keeps it open as long as it needs it; the last manager holding it
 * closes it when that manager closes ({@link release}).
 */
export class ColdEntryStore {
	readonly #blobs: BlobStore;
	/** The store's file; undefined for a store kept in memory from its start. */
	readonly #handle: StoreHandle | undefined;
	#closed = false;
	/** Bytes handed out to records. */
	#bytes = 0;
	/** Bytes in the file; every later record is in a block or in `#pending`. */
	#written = 0;
	/** Whether new records go to compressed blocks: there is no file, or a write to it failed. */
	#inMemory: boolean;
	/** The records past the file kept compressed, in offset order. */
	readonly #blocks: CompressedBlock[] = [];
	/**
	 * The block the latest read decompressed, for the reads of the same
	 * synchronous pass (a full rewrite, a walk of every entry); dropped in a
	 * microtask, so nothing of it outlives the pass ({@link #readBlock}).
	 */
	#decompressed: DecompressedBlock | undefined;
	/** The records after the file and the blocks, gathered for the next write or block, in offset order. */
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	/** Managers holding the store ({@link retain}). */
	#holders = 0;
	/** Whether an entry that stayed whole because its record could not be made was reported. */
	#recordFailureLogged = false;
	/**
	 * Materialized records by offset, each counted with its images resolved; a
	 * record larger than {@link CACHE_BYTES} so counted is not kept.
	 */
	readonly #cache = new LRUCache<number, CachedRecord>({
		max: CACHE_ENTRIES,
		maxSize: CACHE_BYTES,
		sizeCalculation: cached => cached.bytes,
	});
	#materializations = 0;
	#hydrations = 0;

	/**
	 * A new store: over a file, or in memory where its file cannot be made
	 * (`os.tmpdir()` read-only, under a regular file, full, out of descriptors,
	 * or its directory not one the account owns alone), which is logged once
	 * per process with the reason.
	 */
	static open(blobs: BlobStore): ColdEntryStore {
		try {
			return new ColdEntryStore(blobs, openStoreFile());
		} catch (error) {
			if (!openFailureLogged) {
				openFailureLogged = true;
				logger.warn(
					"Older session entries are kept compressed in memory: their store cannot be made under the temporary directory",
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
			return new ColdEntryStore(blobs, undefined);
		}
	}

	/** A store over the file `handle` holds, or in memory without one; see {@link open}. */
	private constructor(blobs: BlobStore, handle: StoreHandle | undefined) {
		this.#blobs = blobs;
		this.#handle = handle;
		this.#inMemory = handle === undefined;
		if (handle) storeRegistry.register(this, handle, this);
	}

	/** Whether the store takes new records: it is open. */
	get writable(): boolean {
		return !this.#closed;
	}

	/** Bytes of records written to the store. */
	get bytes(): number {
		return this.#bytes;
	}

	/** Whether new records are kept compressed in memory: the store has no file, or a write to it failed. */
	get inMemory(): boolean {
		return this.#inMemory;
	}

	/** Bytes of the compressed blocks the store keeps in memory. */
	get compressedBytes(): number {
		let bytes = 0;
		for (const block of this.#blocks) bytes += block.data.byteLength;
		return bytes;
	}

	/** Records read and parsed to serve an accessor read (cache misses). */
	get materializations(): number {
		return this.#materializations;
	}

	/** Cold entries made whole again. */
	get hydrations(): number {
		return this.#hydrations;
	}

	/** The blob store image data of this store's records live in. */
	get blobs(): BlobStore {
		return this.#blobs;
	}

	/**
	 * The record parsed fresh and unfrozen, its blob references resolved when
	 * `resolveBlobs`. Its bytes count toward the next full collection
	 * ({@link COLLECT_AFTER_RECORD_BYTES}).
	 */
	parse(record: ColdRecord, resolveBlobs: boolean): Record<string, unknown> {
		const entry = JSON.parse(this.#read(record).toString("utf8")) as Record<string, unknown>;
		if (resolveBlobs) resolveBlobRefsInEntriesSync([entry as unknown as SessionEntry], this.#blobs);
		paceCollection(record.length);
		return entry;
	}

	/**
	 * The record parsed, its blob references resolved and deep-frozen; the 8
	 * most recent are cached while together they hold at most
	 * {@link CACHE_BYTES}.
	 */
	materialize(record: ColdRecord): Readonly<Record<string, unknown>> {
		const cached = this.#cache.get(record.offset);
		if (cached) return cached.entry;
		const entry = this.parse(record, true);
		const bytes = Math.max(record.length, freezeAndMeasure(entry));
		this.#materializations++;
		this.#cache.set(record.offset, { entry, bytes });
		return entry;
	}

	/** Count a hydration of one of this store's entries. */
	noteHydration(): void {
		this.#hydrations++;
	}

	/** Report an entry that stays whole because its record could not be made; once per store. */
	noteRecordFailure(error: unknown): void {
		if (this.#recordFailureLogged) return;
		this.#recordFailureLogged = true;
		logger.warn("An older session entry stays in memory: its record could not be made", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	/** Count one more manager holding the store. */
	retain(): void {
		this.#holders++;
	}

	/**
	 * Drop one manager's hold. With `close` (the manager closes) the store
	 * closes at once when no other manager holds it; a store a manager let go
	 * of otherwise (a switch to another session) closes once it is collected,
	 * since a snapshot taken to roll that switch back can still read it.
	 */
	release(close: boolean): void {
		this.#holders = Math.max(0, this.#holders - 1);
		if (close && this.#holders === 0) this.close();
	}

	/** Close the store now; a later read of one of its records throws. */
	close(): void {
		this.#closed = true;
		this.#cache.clear();
		this.#pending = [];
		this.#pendingBytes = 0;
		this.#blocks.length = 0;
		this.#decompressed = undefined;
		if (!this.#handle) return;
		storeRegistry.unregister(this);
		releaseStoreHandle(this.#handle);
	}

	/** Write one record; its entry becomes cold through {@link convertToColdEntry}. Only while {@link writable}. */
	append(data: Buffer): ColdRecord {
		if (!this.writable) throw new Error("A cold entry store that closed cannot take a record.");
		const record: ColdRecord = { store: this, offset: this.#bytes, length: data.length };
		this.#pending.push(data);
		this.#pendingBytes += data.length;
		this.#bytes += data.length;
		if (this.#pendingBytes >= WRITE_BATCH_BYTES) this.#flush();
		return record;
	}

	/** Whether `record` of this store holds exactly `data`, so an entry that goes cold unchanged can take it back. */
	holds(record: ColdRecord, data: Buffer): boolean {
		return record.store === this && record.length === data.length && this.#read(record).equals(data);
	}

	/**
	 * Write the gathered records to the file, or compress them into one block
	 * when the store keeps its records in memory. A failed write (a full disk)
	 * moves the store to blocks, the records that write held first, and tries
	 * no write again, so a full disk costs one attempt; the file keeps serving
	 * the records it holds.
	 */
	#flush(): void {
		if (this.#pendingBytes === 0) return;
		const data = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingBytes);
		this.#pending = [];
		this.#pendingBytes = 0;
		if (this.#handle && !this.#inMemory) {
			try {
				let done = 0;
				while (done < data.length) {
					done += fs.writeSync(this.#handle.fd, data, done, data.length - done, this.#written + done);
				}
				this.#written += data.length;
				return;
			} catch (error) {
				this.#inMemory = true;
				logger.warn("Older session entries are kept compressed in memory: writing their store failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const start = this.#bytes - data.length;
		const block: CompressedBlock = {
			start,
			end: this.#bytes,
			data: Bun.zstdCompressSync(data, { level: BLOCK_ZSTD_LEVEL }),
		};
		this.#blocks.push(block);
	}

	#read(record: ColdRecord): Buffer {
		if (this.#closed) throw new Error("An older session entry was read after its session closed.");
		const pendingStart = this.#bytes - this.#pendingBytes;
		if (record.offset >= pendingStart) {
			// A file store writes the batch the record is in, and reads it back
			// from where that left it; a store in memory reads the gathered bytes.
			if (!this.#inMemory) this.#flush();
			else return this.#readPending(record, pendingStart);
		}
		if (record.offset < this.#written) return this.#readFile(record);
		return this.#readBlock(record);
	}

	/** `record` among the gathered records, which start at store offset `start`. */
	#readPending(record: ColdRecord, start: number): Buffer {
		let offset = start;
		for (const data of this.#pending) {
			if (offset === record.offset && data.length === record.length) return data;
			offset += data.length;
		}
		throw new Error("A cold session entry's record is missing from its store.");
	}

	#readFile(record: ColdRecord): Buffer {
		const fd = this.#handle?.fd;
		if (fd === undefined) throw new Error("A cold session entry's record is missing from its store.");
		const data = Buffer.allocUnsafe(record.length);
		let done = 0;
		while (done < record.length) {
			const read = fs.readSync(fd, data, done, record.length - done, record.offset + done);
			if (read === 0) throw new Error("A cold session entry's record is truncated.");
			done += read;
		}
		return data;
	}

	/**
	 * `record` from the block that holds it: the block the latest read
	 * decompressed when the record is in it, else its block decompressed and
	 * kept for the reads of the same synchronous pass, which drops it once the
	 * pass ends.
	 */
	#readBlock(record: ColdRecord): Buffer {
		let decompressed = this.#decompressed;
		if (!decompressed || record.offset < decompressed.block.start || record.offset >= decompressed.block.end) {
			const block = this.#blockOf(record);
			decompressed = { block, data: Bun.zstdDecompressSync(block.data) };
			this.#decompressed = decompressed;
			queueMicrotask(() => {
				this.#decompressed = undefined;
			});
		}
		const at = record.offset - decompressed.block.start;
		return decompressed.data.subarray(at, at + record.length);
	}

	/** The block that holds `record`. */
	#blockOf(record: ColdRecord): CompressedBlock {
		const blocks = this.#blocks;
		let low = 0;
		let high = blocks.length - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const block = blocks[middle]!;
			if (record.offset < block.start) high = middle - 1;
			else if (record.offset >= block.end) low = middle + 1;
			else return block;
		}
		throw new Error("A cold session entry's record is missing from its store.");
	}
}

/**
 * Make a cold `entry` whole again, in place: parse its record unfrozen and turn
 * every accessor back into a data property, `entry.message` staying the same
 * object. Without `resolveBlobs: false` image data are read back from the blob
 * store, but for snapcompact frames, which stay blob references that
 * `lazyImageDataSync` reads when a context build selects them. The entry
 * remembers its record, which it takes back when it goes cold again unchanged
 * ({@link convertToColdEntry}). Returns false when `entry` is not cold.
 */
export function hydrateColdEntry(entry: object, options?: { resolveBlobs?: boolean }): boolean {
	const record = recordOf(entry);
	if (!record) return false;
	const parsed = record.store.parse(record, options?.resolveBlobs !== false);
	const slots: ColdEntrySlots = entry;
	const shell = slots[COLD_MESSAGE];
	if (shell) {
		const parsedMessage = parsed.message;
		if (typeof parsedMessage === "object" && parsedMessage !== null) {
			restoreFields(shell, parsedMessage as Record<string, unknown>, messageFieldAccessors);
		}
		const shellSlots: ColdMessageSlots = shell;
		delete shellSlots[COLD_OWNER];
		setOwnField(entry, "message", shell);
		delete slots[COLD_MESSAGE];
	}
	restoreFields(entry, parsed, entryFieldAccessors);
	delete slots[COLD_STORE];
	delete slots[COLD_OFFSET];
	delete slots[COLD_LENGTH];
	const markSlots: ColdCustomMessageSlots = entry;
	delete markSlots[COLD_ROLLOVER_REQUEST];
	const modeChangeSlots: ColdModeChangeSlots = entry;
	delete modeChangeSlots[COLD_APPROVED_PLAN_FILE];
	setHiddenSlot(entry, COLD_FORMER, record);
	record.store.noteHydration();
	return true;
}

function restoreFields(
	target: object,
	source: Record<string, unknown>,
	accessors: ReadonlyMap<string, PropertyDescriptor>,
): void {
	for (const key of Object.keys(target)) {
		if (!isAccessorFrom(target, key, accessors)) continue;
		setOwnField(target, key, source[key]);
	}
}

/**
 * Cold `entry` as a plain object with the same fields in the same order, for
 * `prepareEntryForPersistence`: its record parsed with image data left as blob
 * references (every record holds them so) and with legacy truncated snapcompact
 * frames repaired, as resolving the record would, each value the entry keeps
 * in memory taken from the entry. The persisted line is the one the whole entry
 * gives, but a full write neither reads nor hashes nor stores its images again.
 * `undefined` when `entry` is not cold.
 */
export function coldEntryForPersistence(entry: FileEntry): FileEntry | undefined {
	const record = recordOf(entry);
	if (!record) return undefined;
	const parsed = record.store.parse(record, false);
	repairTruncatedSnapcompactFrames(parsed as unknown as FileEntry);
	const view = fieldsOver(entry, parsed, entryFieldAccessors);
	const slots: ColdEntrySlots = entry as object;
	const shell = slots[COLD_MESSAGE];
	if (shell) view.message = fieldsOver(shell, isRecord(parsed.message) ? parsed.message : {}, messageFieldAccessors);
	return view as unknown as FileEntry;
}

/** Set `target[key]` as an own data property, even for a key such as `__proto__` that assignment treats apart. */
function setOwnField(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** `holder`'s fields in key order: the value of each of its accessors from `record`, each data value its own. */
function fieldsOver(
	holder: object,
	record: Readonly<Record<string, unknown>>,
	accessors: ReadonlyMap<string, PropertyDescriptor>,
): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(holder)) {
		setOwnField(fields, key, isAccessorFrom(holder, key, accessors) ? record[key] : Reflect.get(holder, key));
	}
	return fields;
}

/**
 * Copy `source`'s fields onto `target` in key order: accessors shared, data
 * copied so the two share nothing mutable (data values are small), and
 * `define` given the first say over each key.
 */
function copyFields(
	source: object,
	target: Record<string, unknown>,
	accessors: ReadonlyMap<string, PropertyDescriptor>,
	define?: (key: string) => boolean,
): void {
	for (const key of Object.keys(source)) {
		if (define?.(key)) continue;
		if (isAccessorFrom(source, key, accessors)) {
			Object.defineProperty(target, key, accessors.get(key)!);
			continue;
		}
		const value: unknown = Reflect.get(source, key);
		setOwnField(target, key, typeof value === "object" && value !== null ? structuredClone(value) : value);
	}
}

/**
 * A new cold entry over the same record as cold `entry`: the same fields in
 * the same order, with its own message object, and `overrides` applied as
 * data. The copy shares no mutable value with `entry`.
 */
export function copyColdEntry(entry: SessionEntry, overrides?: Readonly<Record<string, unknown>>): SessionEntry {
	const record = recordOf(entry);
	if (!record) throw new Error("Only a cold session entry can be copied over its record.");
	const copy: Record<string, unknown> = {};
	const slots: ColdEntrySlots = entry as object;
	const shell = slots[COLD_MESSAGE];
	copyFields(entry, copy, entryFieldAccessors, key => {
		if (overrides && Object.hasOwn(overrides, key)) {
			setOwnField(copy, key, overrides[key]);
			return true;
		}
		if (key !== "message" || !shell) return false;
		const messageCopy: Record<string, unknown> = {};
		copyFields(shell, messageCopy, messageFieldAccessors);
		setHiddenSlot(messageCopy, COLD_OWNER, copy);
		setHiddenSlot(copy, COLD_MESSAGE, messageCopy);
		Object.defineProperty(copy, "message", entryMessageAccessor);
		return true;
	});
	for (const key of Object.keys(overrides ?? {})) {
		if (!Object.hasOwn(copy, key)) setOwnField(copy, key, overrides?.[key]);
	}
	setRecordSlots(copy, record);
	const mark = coldRolloverRequestMark(entry);
	if (mark !== undefined) setHiddenSlot(copy, COLD_ROLLOVER_REQUEST, mark);
	const planFile = coldApprovedPlanFileMark(entry);
	if (planFile !== undefined) setHiddenSlot(copy, COLD_APPROVED_PLAN_FILE, planFile);
	return copy as unknown as SessionEntry;
}

/**
 * Make `entry` cold, in place: write its record to the store `openStore`
 * returns (called only when a record is written) and turn into an accessor
 * each value of the entry too large to keep ({@link COLD_STRING_MAX_UNITS},
 * {@link COLD_JSON_MAX_BYTES}), each value of its `message` but the small ones
 * of {@link MESSAGE_FIELDS_KEPT_WHILE_SMALL}, and for a type of
 * {@link isCoreColdCustom} every value but the tree fields, `customType`
 * and a small `runtime`. An entry made whole from this
 * store whose values are unchanged takes its former record back instead of
 * writing a new one. Pass `imagesExternalized` for an entry parsed from a
 * session file, whose image data are blob references already, and `paced`
 * from a load, which converts a whole transcript in one burst: the record's
 * bytes count toward the next full collection
 * ({@link COLLECT_AFTER_RECORD_BYTES}), as a read's do. Returns false,
 * changing nothing, when every value stays, `entry` is cold already, the
 * store is closed, or the record cannot be made (an image the blob store
 * cannot take; reported once per store): the entry then stays whole.
 */
export function convertToColdEntry(
	entry: SessionEntry,
	openStore: () => ColdEntryStore,
	options?: { imagesExternalized?: boolean; paced?: boolean },
): boolean {
	if (isColdEntry(entry) || !Object.isExtensible(entry)) return false;
	const holder = entry as unknown as Record<string, unknown>;
	const message = entry.type === "message" ? holder.message : undefined;
	const shell =
		typeof message === "object" && message !== null && !Array.isArray(message) && Object.isExtensible(message)
			? (message as Record<string, unknown>)
			: undefined;
	const messageKeys = shell
		? coldFields(shell, MESSAGE_FIELDS_IN_MEMORY, MESSAGE_FIELDS_KEPT_WHILE_SMALL, MESSAGE_IDENTITY_FIELDS)
		: [];
	const entryKeys = (
		isCoreColdCustom(entry)
			? coldFields(holder, CORE_CUSTOM_FIELDS_IN_MEMORY, CORE_CUSTOM_FIELDS_KEPT_WHILE_SMALL)
			: coldFields(holder, ENTRY_FIELDS_IN_MEMORY, undefined)
	).filter(key => key !== "message" || !shell);
	if (entryKeys.length === 0 && messageKeys.length === 0) return false;

	const store = openStore();
	if (!store.writable) return false;
	let text: string;
	try {
		text = options?.imagesExternalized ? (stringifyJson(entry) ?? "null") : entryRecordText(entry, store.blobs);
	} catch (error) {
		store.noteRecordFailure(error);
		return false;
	}
	const data = Buffer.from(text, "utf8");
	const slots: ColdEntrySlots = entry as object;
	const former = slots[COLD_FORMER];
	const record = former && store.holds(former, data) ? former : store.append(data);
	delete slots[COLD_FORMER];
	// Decided while every value is still in memory; see COLD_ROLLOVER_REQUEST and COLD_APPROVED_PLAN_FILE.
	if (entry.type === "custom_message") setHiddenSlot(entry, COLD_ROLLOVER_REQUEST, isRolloverRequestEntry(entry));
	else if (entry.type === "mode_change") setHiddenSlot(entry, COLD_APPROVED_PLAN_FILE, approvedPlanFileOf(entry));
	setRecordSlots(entry, record);
	for (const key of entryKeys) Object.defineProperty(entry, key, entryFieldAccessor(key));
	if (shell && messageKeys.length > 0) {
		setHiddenSlot(shell, COLD_OWNER, entry);
		for (const key of messageKeys) Object.defineProperty(shell, key, messageFieldAccessor(key));
		setHiddenSlot(entry, COLD_MESSAGE, shell);
		Object.defineProperty(entry, "message", entryMessageAccessor);
		// The message keeps its identity, so its conversion for the model would
		// keep the bodies it held in memory; none is kept while it is cold.
		forgetConvertMemo(shell);
	}
	if (options?.paced) paceCollection(data.length);
	return true;
}

/** {@link hydrateColdEntry} with `options` for each of `entries` that `boundary` keeps whole ({@link belongsCold}). */
export function hydrateKeptEntries(
	entries: readonly SessionEntry[],
	boundary: ColdBoundary,
	options?: { resolveBlobs?: boolean },
): void {
	for (let index = 0; index < entries.length; index++) {
		if (!belongsCold(boundary, index)) hydrateColdEntry(entries[index]!, options);
	}
}

/** {@link convertToColdEntry} for each of `entries` that `boundary` leaves cold ({@link belongsCold}). */
export function convertColdEntries(
	entries: readonly SessionEntry[],
	boundary: ColdBoundary,
	openStore: () => ColdEntryStore,
	options?: { paced?: boolean },
): void {
	for (let index = 0; index < entries.length; index++) {
		if (belongsCold(boundary, index)) convertToColdEntry(entries[index]!, openStore, options);
	}
}
