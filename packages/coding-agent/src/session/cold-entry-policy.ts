/**
 * Which entries go cold ({@link coldBoundary}). The model context only needs
 * the entries of the current branch from the latest compaction's cut on
 * ({@link coldCutPathIndex}). An entry before the cut, or off the current
 * branch, goes cold, unless its kind keeps it whole wherever it lies or its
 * position on the path keeps it whole ({@link entriesKeptWholeOnPath}); from
 * the cut on, the records no context or turn reads go cold too, but for the
 * newest of a kind kept whole by position, as does a compaction older than
 * every compaction a context build reads. The kind rules are one table, keyed
 * by entry type and, for a `custom` entry, by `customType` ({@link coldKindOf});
 * the position rules follow it.
 */
import { compactionKeptStart } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { CONTEXT_NOTES_ENTRY_TYPE, contextNotesEntriesRead } from "./context-notes";
import { SESSION_EXIT_CUSTOM_TYPE, TOOL_EXECUTION_START_CUSTOM_TYPE } from "./exit-diagnostics";
import { getReadableCompactionEntry, isRolloverRequestEntry } from "./session-context";
import {
	type CompactionEntry,
	GOAL_COMPLETED_CUSTOM_TYPE,
	type SessionEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	TODO_HUD_STATE_CUSTOM_TYPE,
	todoSnapshotPhases,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "./session-entries";

/** What an entry's kind says about where it lies. */
export interface ColdKind {
	/** It stays whole wherever it lies. */
	readonly wholeByKind: boolean;
	/**
	 * It goes to the store from the cut on too, unless kept whole by position
	 * ({@link entriesKeptWholeOnPath}): a record no turn reads, or one a newer
	 * entry of its kind supersedes, of which only the newest on the path is
	 * read whole.
	 */
	readonly storedPastCut: boolean;
	/**
	 * A `custom` type of the core that goes cold with every value but the tree
	 * fields, `customType` and a small `runtime` read back from the store
	 * however small. The `runtime` is one object per build (the load's
	 * interner), so keeping it costs nothing, and `/session` reads it of every
	 * entry.
	 */
	readonly coreCustom: boolean;
}

const GOES_COLD: ColdKind = { wholeByKind: false, storedPastCut: false, coreCustom: false };
const KEPT_WHOLE: ColdKind = { wholeByKind: true, storedPastCut: false, coreCustom: false };
const STORED_PAST_CUT: ColdKind = { wholeByKind: false, storedPastCut: true, coreCustom: false };

/**
 * The `custom` type of the patch records that hold the new values of the
 * entries they patch, which a load applies to those entries; no turn reads
 * the records themselves.
 */
const PATCH_RECORD_CUSTOM_TYPE = "entry_patch";

/** The kind rules: by entry type, and for a `custom` entry by its `customType`. */
interface ColdKindTable {
	readonly entryTypes: ReadonlyMap<string, ColdKind>;
	readonly customTypes: ReadonlyMap<string, ColdKind>;
}

let coldKindTable: ColdKindTable | undefined;

function coldKinds(): ColdKindTable {
	// Built at the first lookup, not when this module loads: the modules that
	// define these types can still be loading then, in an import cycle through this one.
	coldKindTable ??= {
		entryTypes: new Map<string, ColdKind>([
			// The selections a resume restores: model of each role, thinking level,
			// service tier, TTSR rules, labels, credential pins, `/clear`
			// boundaries, usage, titles.
			["model_change", KEPT_WHOLE],
			["thinking_level_change", KEPT_WHOLE],
			["service_tier_change", KEPT_WHOLE],
			["ttsr_injection", KEPT_WHOLE],
			["label", KEPT_WHOLE],
			["credential_pin", KEPT_WHOLE],
			["reset_boundary", KEPT_WHOLE],
			["model_usage", KEPT_WHOLE],
			[TITLE_CHANGE_ENTRY_TYPE, KEPT_WHOLE],
			// Only the newest on the path is read whole; of an older one a resume
			// reads only its mode and the approved plan file it names, both in
			// memory (`COLD_APPROVED_PLAN_FILE`).
			["mode_change", STORED_PAST_CUT],
		]),
		customTypes: new Map<string, ColdKind>([
			[PATCH_RECORD_CUSTOM_TYPE, STORED_PAST_CUT],
			// A user's edit of the to-do list holds the whole list, of which the
			// restore reads only the newest snapshot on the path, kept whole by position.
			[USER_TODO_EDIT_CUSTOM_TYPE, { wholeByKind: false, storedPastCut: true, coreCustom: true }],
			// A tool start marker is read only for the calls left pending at the end
			// of the branch, which lie after the cut.
			[TOOL_EXECUTION_START_CUSTOM_TYPE, { wholeByKind: false, storedPastCut: false, coreCustom: true }],
			// A resume reads only the newest exit record's kind and how many tool
			// calls were pending, not their arguments.
			[SESSION_EXIT_CUSTOM_TYPE, STORED_PAST_CUT],
			// A goal's completion record holds the objective its mode changes hold.
			[GOAL_COMPLETED_CUSTOM_TYPE, STORED_PAST_CUT],
			// Only the newest to-do HUD choice on the path is read whole.
			[TODO_HUD_STATE_CUSTOM_TYPE, STORED_PAST_CUT],
			// The context reads only the notebook revisions it builds from, kept whole by position.
			[CONTEXT_NOTES_ENTRY_TYPE, GOES_COLD],
		]),
	};
	return coldKindTable;
}

/**
 * What `entry`'s kind says about where it lies: a `custom` type the table
 * does not name is extension or feature state, kept whole; any other entry
 * type it does not name goes cold.
 */
export function coldKindOf(entry: SessionEntry): ColdKind {
	const kinds = coldKinds();
	if (entry.type === "custom") return kinds.customTypes.get(entry.customType) ?? KEPT_WHOLE;
	return kinds.entryTypes.get(entry.type) ?? GOES_COLD;
}

/** Whether `entry` stays whole wherever it lies, by its kind ({@link coldKindOf}). */
export function keptWholeByKind(entry: SessionEntry): boolean {
	return coldKindOf(entry).wholeByKind;
}

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

/** Which entries are cold for one leaf and model. */
export interface ColdBoundary {
	/** By index in the entries it was computed for: 1 where the entry belongs in the store. */
	readonly cold: Uint8Array;
}

/**
 * Which of `entries` (file order) belong in the store while the leaf ends
 * `path`: every entry except those the context reads (the current path from
 * the cut on, but the records no context or turn reads there:
 * {@link ColdKind.storedPastCut}, and a compaction older than every compaction a
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
		if (cut > 0 && (coldKindOf(entry).storedPastCut || (entry.type === "compaction" && index < firstReadCompaction)))
			continue;
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

/** Whether the entry at index `index` belongs in the store under `boundary`; an entry added since is whole. */
export function belongsCold(boundary: ColdBoundary, index: number): boolean {
	return boundary.cold[index] === 1;
}
