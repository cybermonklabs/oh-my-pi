/**
 * Older entry bodies out of memory: cold entries, whose records live in a
 * {@link ColdEntryStore} (`cold-entry-store.ts`), on disk or compressed in
 * memory where no store file can be used.
 *
 * Which entries go cold is the policy of `cold-entry-policy.ts`
 * (`coldBoundary`). A cold entry is the same object, converted in place,
 * whose small values stay data properties and whose large values become
 * enumerable accessors that read the entry's record back from its store.
 * A cold message keeps as
 * data only the small values of the fields that readers walking the whole
 * branch on every turn read ({@link MESSAGE_FIELDS_KEPT_WHILE_SMALL}); its
 * other fields are accessors whatever their size. A cold to-do edit or tool
 * start marker keeps as data only its tree fields, `customType` and a small
 * `runtime` (`ColdKind.coreCustom`). `JSON.stringify`, spread and
 * `structuredClone` still see every field. A read returns a deep-frozen value,
 * so a place that writes into a nested value of a cold body fails with a
 * `TypeError` instead of losing the write; assigning a field
 * (`entry.message = …`, `message.content = …`) first makes the whole entry
 * whole again ({@link hydrateColdEntry}).
 *
 * Accessor functions are shared per field name and find their entry's record
 * through a symbol-keyed property, so a cold entry costs no closure.
 */
import { isRecord, stringifyJson } from "@oh-my-pi/pi-utils";
import { isBlobRef } from "./blob-store";
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
import { belongsCold, type ColdBoundary, coldKindOf } from "./cold-entry-policy";
import { type ColdEntryStore, type ColdRecord, paceCollection } from "./cold-entry-store";
import type { EntryPatchTargets } from "./entry-patches";
import { forgetConvertMemo } from "./messages";
import { isRolloverRequestEntry } from "./session-context";
import type { FileEntry, SessionEntry } from "./session-entries";
import { repairTruncatedSnapcompactFrames } from "./session-loader";
import { entryJsonText, entryRecordText } from "./session-persistence";

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

/** Fields that always stay data: the tree structure every walk reads. */
const ENTRY_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp", "activeLeafId"]);
/** The fields of a cold entry of a `ColdKind.coreCustom` type (cold-entry-policy.ts) that stay data. */
const CORE_CUSTOM_FIELDS_IN_MEMORY: ReadonlySet<string> = new Set([...ENTRY_FIELDS_IN_MEMORY, "customType"]);
/** The fields of a cold entry of a `ColdKind.coreCustom` type (cold-entry-policy.ts) that stay data while small. */
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
 * references (a record holds an image inline only where the entry was loaded
 * so, or the blob store could not take it) and with legacy truncated snapcompact
 * frames repaired, as resolving the record would, each value the entry keeps
 * in memory taken from the entry. The persisted line is the one the whole entry
 * gives, but a full write neither reads nor hashes nor stores again an image its
 * record holds as a reference.
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
 * `ColdKind.coreCustom` (cold-entry-policy.ts) every value but the tree fields, `customType`
 * and a small `runtime`. An entry made whole from this
 * store whose values are unchanged takes its former record back instead of
 * writing a new one. Pass `imagesExternalized` for an entry parsed from a
 * session file, whose image data are blob references already, and `paced`
 * from a load, which converts a whole transcript in one burst: the record's
 * bytes count toward the next full collection
 * (`COLLECT_AFTER_RECORD_BYTES` in cold-entry-store.ts), as a read's do. Returns false,
 * changing nothing, when every value stays, `entry` is cold already, the
 * store is closed, or the record cannot be made, which only a value JSON
 * cannot write causes ({@link entryRecordText}; reported once per store): the
 * entry then stays whole.
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
		coldKindOf(entry).coreCustom
			? coldFields(holder, CORE_CUSTOM_FIELDS_IN_MEMORY, CORE_CUSTOM_FIELDS_KEPT_WHILE_SMALL)
			: coldFields(holder, ENTRY_FIELDS_IN_MEMORY, undefined)
	).filter(key => key !== "message" || !shell);
	if (entryKeys.length === 0 && messageKeys.length === 0) return false;

	const store = openStore();
	if (!store.writable) return false;
	let text: string;
	try {
		text = options?.imagesExternalized ? (entryJsonText(entry) ?? "null") : entryRecordText(entry, store.blobs);
	} catch (error) {
		// Only a value JSON cannot write gets here (a cycle, a getter or `toJSON`
		// that throws, a bigint in a value too deep for a recursive walk, a text
		// past the engine's longest string): never an entry parsed from a
		// transcript line shorter than that, and its transcript write fails too.
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

/**
 * `byId` as the targets of the prune and patch records a load or an adoption
 * of another writer's entries applies: each cold target is made whole first,
 * its images left as blob references ({@link hydrateColdEntry}), since a write
 * through one of its accessors would make it whole with every image read back
 * just before the record replaces them. Each target it makes whole is pushed
 * to `hydrated`.
 */
export function wholeTargetsOf(byId: EntryPatchTargets, hydrated?: SessionEntry[]): EntryPatchTargets {
	return {
		get(id) {
			const target = byId.get(id);
			if (target && hydrateColdEntry(target, { resolveBlobs: false })) hydrated?.push(target);
			return target;
		},
	};
}
