/**
 * Older entry bodies on disk instead of in memory.
 *
 * The model context only needs the entries of the current branch from the
 * latest compaction's cut on (see {@link coldBoundary}). An entry before the
 * cut, or off the current branch, becomes *cold*, as does a user's edit of the
 * to-do list from the cut on that is not the newest snapshot: the same
 * object, converted in place, whose small values stay data properties and whose
 * large values become enumerable accessors that read the entry's record back
 * from a {@link ColdEntryStore}. A cold message keeps as data only the small
 * values of the fields that readers walking the whole branch on every turn
 * read ({@link MESSAGE_FIELDS_KEPT_WHILE_SMALL}); its other fields are
 * accessors whatever their size. `JSON.stringify`, spread and `structuredClone`
 * still see every field. A read returns a deep-frozen value, so a place that
 * writes into a nested value of a cold body fails with a `TypeError` instead of
 * losing the write; assigning a field (`entry.message = …`,
 * `message.content = …`) first makes the whole entry whole again
 * ({@link hydrateColdEntry}).
 *
 * Accessor functions are shared per field name and find their entry's record
 * through a symbol-keyed property, so a cold entry costs no closure.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger, stringifyJson } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { type BlobStore, isBlobRef } from "./blob-store";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "./exit-diagnostics";
import { compactionKeptStart, getReadableCompactionEntry } from "./session-context";
import {
	type CompactionEntry,
	type FileEntry,
	type SessionEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	todoSnapshotPhases,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "./session-entries";
import { repairTruncatedSnapcompactFrames, resolveBlobRefsInEntriesSync } from "./session-loader";
import { entryRecordText } from "./session-persistence";

/**
 * A string value of a cold entry stays in memory up to this many UTF-16 units:
 * ids, roles, providers, models, stop reasons, tool names and call ids fit.
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
const CACHE_BYTES = 16 * 1024 * 1024;
/** Records are written in batches of about this size. */
const WRITE_BATCH_BYTES = 1024 * 1024;
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
 * tier, mode, TTSR rules, labels, credential pins, `/clear` boundaries, usage,
 * titles). {@link entriesKeptWholeOnPath} adds two entries by position.
 */
const ENTRY_TYPES_KEPT_WHOLE: ReadonlySet<string> = new Set<SessionEntry["type"]>([
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"mode_change",
	"ttsr_injection",
	"label",
	"credential_pin",
	"reset_boundary",
	"model_usage",
	TITLE_CHANGE_ENTRY_TYPE,
]);

/**
 * The `custom` type that goes cold like a message: the patch records a
 * shake pass appends hold the new bodies of the entries they patch, which a
 * load applies to those entries; no turn reads the records themselves.
 */
const PATCH_RECORD_CUSTOM_TYPE = "entry_patch";

/**
 * `custom` types of the core that go cold too, every value but the tree
 * fields and `customType` read back from the store however small: a user's
 * edit of the to-do list holds the whole list, of which the restore reads
 * only the newest snapshot on the path, kept whole by position
 * ({@link entriesKeptWholeOnPath}); a tool start marker is read only for the
 * calls left pending at the end of the branch, which lie after the cut.
 */
const CORE_CUSTOM_TYPES_COLD: ReadonlySet<string> = new Set([
	USER_TODO_EDIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
]);

/** Whether `entry` stays whole wherever it lies, by its type ({@link ENTRY_TYPES_KEPT_WHOLE}). */
export function keptWholeByKind(entry: SessionEntry): boolean {
	if (!ENTRY_TYPES_KEPT_WHOLE.has(entry.type)) return false;
	if (entry.type !== "custom") return true;
	return entry.customType !== PATCH_RECORD_CUSTOM_TYPE && !CORE_CUSTOM_TYPES_COLD.has(entry.customType);
}

/** Fields that always stay data: the tree structure every walk reads. */
const ENTRY_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp", "activeLeafId"]);
/** The fields of a cold entry of {@link CORE_CUSTOM_TYPES_COLD} that stay data. */
const CORE_CUSTOM_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set([...ENTRY_FIELDS_IN_MEMORY, "customType"]);
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
 * `api`, `customType` and `display` tell extensions what a message is.
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
]);
const NO_FIELDS: ReadonlySet<string> = new Set();

/**
 * Entries of `path` kept whole before the cut although their type is not:
 * the newest `session_init` (the contract a revived subagent rebuilds from)
 * and the newest canonical to-do snapshot, a `todo` result that records the
 * list or a user's edit of it (what the to-do list restores from).
 */
export function entriesKeptWholeOnPath(path: readonly SessionEntry[]): Set<SessionEntry> {
	const kept = new Set<SessionEntry>();
	let sessionInit = false;
	let todo = false;
	for (let index = path.length - 1; index >= 0 && !(sessionInit && todo); index--) {
		const entry = path[index]!;
		if (entry.type === "session_init") {
			if (!sessionInit) kept.add(entry);
			sessionInit = true;
		} else if (!todo && todoSnapshotPhases(entry)) {
			kept.add(entry);
			todo = true;
		}
	}
	return kept;
}

/**
 * Index in `path` of the cut for the leaf that `path` ends at: the first entry
 * the context keeps ({@link compactionKeptStart}) of the newest compaction on
 * the path and, with `model`, of the newest compaction `model` can replay,
 * whichever comes first. 0 (nothing cold) when the context uses no compaction.
 */
export function coldCutPathIndex(path: readonly SessionEntry[], model: Model | undefined): number {
	const compactions = [getReadableCompactionEntry(path, undefined)];
	if (model) compactions.push(getReadableCompactionEntry(path, model));
	let start = path.length;
	for (const compaction of compactions) {
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
 * the cut on, but a user's edit of the to-do list, which no context or turn
 * reads but the newest snapshot), those kept whole by kind
 * ({@link keptWholeByKind}) and those kept whole by position on the path
 * ({@link entriesKeptWholeOnPath}). An entry off the current path is cold
 * wherever it lies.
 */
export function coldBoundary(
	entries: readonly SessionEntry[],
	path: readonly SessionEntry[],
	model: Model | undefined,
): ColdBoundary {
	const cut = coldCutPathIndex(path, model);
	const whole = cut > 0 ? entriesKeptWholeOnPath(path) : new Set<SessionEntry>();
	for (let index = cut; index < path.length; index++) {
		const entry = path[index]!;
		if (cut > 0 && entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) continue;
		whole.add(entry);
	}
	const cold = new Uint8Array(entries.length);
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (!whole.has(entry) && !keptWholeByKind(entry)) cold[index] = 1;
	}
	return { cold };
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
const COLD_OWNER = Symbol("omp.coldOwner");
/** On an entry made whole again: the record it had, which it takes back if it goes cold unchanged. */
const COLD_FORMER = Symbol("omp.coldFormer");

interface ColdEntrySlots {
	[COLD_STORE]?: ColdEntryStore;
	[COLD_OFFSET]?: number;
	[COLD_LENGTH]?: number;
	[COLD_MESSAGE]?: object;
	[COLD_FORMER]?: ColdRecord;
}

interface ColdMessageSlots {
	[COLD_OWNER]?: object;
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
 * while small).
 */
function coldFields(
	holder: Record<string, unknown>,
	inMemory: ReadonlySet<string>,
	whileSmall: ReadonlySet<string> | undefined,
): string[] {
	const keys: string[] = [];
	for (const key of Object.keys(holder)) {
		if (inMemory.has(key)) continue;
		if ((whileSmall && !whileSmall.has(key)) || !staysInMemory(holder[key])) keys.push(key);
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

function deepFreeze(value: unknown): void {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item !== "object" || item === null || Object.isFrozen(item)) continue;
		Object.freeze(item);
		if (Array.isArray(item)) {
			for (const element of item) pending.push(element);
		} else {
			for (const key of Object.keys(item)) pending.push(Reflect.get(item, key));
		}
	}
}

/** What the finalizer needs to release a store; must not refer to the store. */
interface StoreHandle {
	fd: number;
	/** Set on Windows, where an open file cannot be unlinked: deleted when the store goes. */
	path: string | undefined;
	/** Set once `fd` is closed: the number may belong to another file since. */
	closed: boolean;
}

const windowsStoreHandles = new Set<StoreHandle>();
let windowsExitHookInstalled = false;
/** Whether a store that could not be opened was reported; the cause is the host's, so once is enough. */
let openFailureLogged = false;

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
	readonly bytes: number;
}

/**
 * One loaded manager's records of cold entries: a file under
 * `os.tmpdir()/omp-cold-<uid>/`, unlinked as soon as it is open on POSIX (its disk
 * is freed when the descriptor closes, and a killed process leaves nothing;
 * on Windows it is deleted when the store is closed or collected and at
 * exit). A record is the entry exactly as the manager held it, with image
 * data replaced by blob references. Every cold entry refers to its store, so
 * a clone sharing the entries keeps it open as long as it needs it; the last
 * manager holding it closes it when that manager closes ({@link release}).
 */
export class ColdEntryStore {
	readonly #blobs: BlobStore;
	readonly #handle: StoreHandle;
	/** Bytes handed out to records, written or pending. */
	#bytes = 0;
	/** Bytes on disk; every later byte is in `#pending`. */
	#written = 0;
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	/** Set when a write failed: the pending records stay in memory and the store takes no new one. */
	#writeFailed = false;
	/** Managers holding the store ({@link retain}). */
	#holders = 0;
	/** Materialized records by offset; a record larger than {@link CACHE_BYTES} is not kept. */
	readonly #cache = new LRUCache<number, CachedRecord>({
		max: CACHE_ENTRIES,
		maxSize: CACHE_BYTES,
		sizeCalculation: cached => cached.bytes,
	});
	#materializations = 0;
	#hydrations = 0;

	/**
	 * A new store, or undefined when its file cannot be made (`os.tmpdir()`
	 * read-only, missing and impossible to create, out of descriptors): the
	 * caller then keeps its entries whole, as a session without a store does.
	 */
	static open(blobs: BlobStore): ColdEntryStore | undefined {
		try {
			return new ColdEntryStore(blobs);
		} catch (error) {
			if (!openFailureLogged) {
				openFailureLogged = true;
				logger.warn("Older session entries stay in memory: their store cannot be opened", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
	}

	/** Throws when the file cannot be made; {@link open} returns undefined instead. */
	constructor(blobs: BlobStore) {
		this.#blobs = blobs;
		// One directory per account: `os.tmpdir()` is shared between accounts on
		// Linux and the directory is 0700, so under one shared name the first
		// account would own it and every other account's open would fail.
		const uid = process.getuid?.();
		const dir = path.join(os.tmpdir(), uid === undefined ? "omp-cold" : `omp-cold-${uid}`);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, `${process.pid}-${crypto.randomUUID()}.jsonl`);
		const fd = fs.openSync(file, "wx+", 0o600);
		this.#handle = { fd, path: undefined, closed: false };
		if (process.platform === "win32") {
			this.#handle.path = file;
			trackWindowsStore(this.#handle);
		} else {
			try {
				fs.unlinkSync(file);
			} catch (error) {
				fs.closeSync(fd);
				throw error;
			}
		}
		storeRegistry.register(this, this.#handle, this);
	}

	/** Whether the store takes new records: it is open and no write to it failed. */
	get writable(): boolean {
		return !this.#writeFailed && !this.#handle.closed;
	}

	/** Bytes of records written to the store. */
	get bytes(): number {
		return this.#bytes;
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

	/** The record parsed, its blob references resolved and deep-frozen; the 8 most recent are cached. */
	materialize(record: ColdRecord): Readonly<Record<string, unknown>> {
		const cached = this.#cache.get(record.offset);
		if (cached) return cached.entry;
		const entry = this.parse(record, true);
		deepFreeze(entry);
		this.#materializations++;
		this.#cache.set(record.offset, { entry, bytes: record.length });
		return entry;
	}

	/** Count a hydration of one of this store's entries. */
	noteHydration(): void {
		this.#hydrations++;
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
		storeRegistry.unregister(this);
		this.#cache.clear();
		this.#pending = [];
		releaseStoreHandle(this.#handle);
	}

	/** Write one record; its entry becomes cold through {@link convertToColdEntry}. Only while {@link writable}. */
	append(data: Buffer): ColdRecord {
		if (!this.writable) throw new Error("A cold entry store that failed or closed cannot take a record.");
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
	 * Write the pending records. A failed write keeps them in memory, joined in
	 * one buffer, where reads still find them; the store then takes no new
	 * record and tries no write again, so a full disk costs one attempt.
	 */
	#flush(): boolean {
		if (this.#pendingBytes === 0) return true;
		if (this.#writeFailed) return false;
		const data = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingBytes);
		this.#pending = [data];
		try {
			let done = 0;
			while (done < data.length) {
				done += fs.writeSync(this.#handle.fd, data, done, data.length - done, this.#written + done);
			}
		} catch (error) {
			this.#writeFailed = true;
			logger.warn("Older session entries stay in memory: writing their store failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		this.#written += data.length;
		this.#pending = [];
		this.#pendingBytes = 0;
		return true;
	}

	#read(record: ColdRecord): Buffer {
		if (this.#handle.closed) throw new Error("An older session entry was read after its session closed.");
		if (record.offset >= this.#written && !this.#flush()) {
			const start = record.offset - this.#written;
			return this.#pending[0]!.subarray(start, start + record.length);
		}
		const data = Buffer.allocUnsafe(record.length);
		let done = 0;
		while (done < record.length) {
			const read = fs.readSync(this.#handle.fd, data, done, record.length - done, record.offset + done);
			if (read === 0) throw new Error("A cold session entry's record is truncated.");
			done += read;
		}
		return data;
	}
}

/**
 * Make a cold `entry` whole again, in place: parse its record unfrozen and turn
 * every accessor back into a data property, `entry.message` staying the same
 * object. Without `resolveBlobs: false` image data are read back from the blob
 * store. The entry remembers its record, which it takes back when it goes cold
 * again unchanged ({@link convertToColdEntry}). Returns false when `entry` is
 * not cold.
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
	return copy as unknown as SessionEntry;
}

/**
 * Make `entry` cold, in place: write its record to the store `openStore`
 * returns (called only when a record is written) and turn into an accessor
 * each value of the entry too large to keep ({@link COLD_STRING_MAX_UNITS},
 * {@link COLD_JSON_MAX_BYTES}), each value of its `message` but the small ones
 * of {@link MESSAGE_FIELDS_KEPT_WHILE_SMALL}, and for a type of
 * {@link CORE_CUSTOM_TYPES_COLD} every value but the tree fields and
 * `customType`. An entry made whole from this
 * store whose values are unchanged takes its former record back instead of
 * writing a new one. Pass `imagesExternalized` for an entry parsed from a
 * session file, whose image data are blob references already, and `paced`
 * from a load, which converts a whole transcript in one burst: the record's
 * bytes count toward the next full collection
 * ({@link COLLECT_AFTER_RECORD_BYTES}), as a read's do. Returns false,
 * changing nothing, when every value stays, `entry` is cold already, or
 * there is no store that takes records (`openStore` returns undefined, or a
 * write to the store failed): the entry then stays whole.
 */
export function convertToColdEntry(
	entry: SessionEntry,
	openStore: () => ColdEntryStore | undefined,
	options?: { imagesExternalized?: boolean; paced?: boolean },
): boolean {
	if (isColdEntry(entry) || !Object.isExtensible(entry)) return false;
	const holder = entry as unknown as Record<string, unknown>;
	const message = entry.type === "message" ? holder.message : undefined;
	const shell =
		typeof message === "object" && message !== null && !Array.isArray(message) && Object.isExtensible(message)
			? (message as Record<string, unknown>)
			: undefined;
	const messageKeys = shell ? coldFields(shell, MESSAGE_FIELDS_IN_MEMORY, MESSAGE_FIELDS_KEPT_WHILE_SMALL) : [];
	const entryKeys = (
		entry.type === "custom" && CORE_CUSTOM_TYPES_COLD.has(entry.customType)
			? coldFields(holder, CORE_CUSTOM_FIELDS_IN_MEMORY, NO_FIELDS)
			: coldFields(holder, ENTRY_FIELDS_IN_MEMORY, undefined)
	).filter(key => key !== "message" || !shell);
	if (entryKeys.length === 0 && messageKeys.length === 0) return false;

	const store = openStore();
	if (!store?.writable) return false;
	const text = options?.imagesExternalized ? (stringifyJson(entry) ?? "null") : entryRecordText(entry, store.blobs);
	const data = Buffer.from(text, "utf8");
	const slots: ColdEntrySlots = entry as object;
	const former = slots[COLD_FORMER];
	const record = former && store.holds(former, data) ? former : store.append(data);
	delete slots[COLD_FORMER];
	setRecordSlots(entry, record);
	for (const key of entryKeys) Object.defineProperty(entry, key, entryFieldAccessor(key));
	if (shell && messageKeys.length > 0) {
		setHiddenSlot(shell, COLD_OWNER, entry);
		for (const key of messageKeys) Object.defineProperty(shell, key, messageFieldAccessor(key));
		setHiddenSlot(entry, COLD_MESSAGE, shell);
		Object.defineProperty(entry, "message", entryMessageAccessor);
	}
	if (options?.paced) paceCollection(data.length);
	return true;
}

/** {@link convertToColdEntry} for each of `entries` that `boundary` leaves cold ({@link belongsCold}). */
export function convertColdEntries(
	entries: readonly SessionEntry[],
	boundary: ColdBoundary,
	openStore: () => ColdEntryStore | undefined,
	options?: { paced?: boolean },
): void {
	for (let index = 0; index < entries.length; index++) {
		if (belongsCold(boundary, index)) convertToColdEntry(entries[index]!, openStore, options);
	}
}
