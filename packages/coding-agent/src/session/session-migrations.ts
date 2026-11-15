import { Snowflake } from "@oh-my-pi/pi-utils";
import {
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "./session-entries";

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	return Snowflake.next(); // fallback to full snowflake id
}

/** The part of an entry the v1 → v2 migration reads back when it maps `firstKeptEntryIndex`. */
type MigratedEntryRef = Pick<SessionHeader, "type"> | Pick<SessionEntry, "type" | "id">;

/** Ids the v1 → v2 migration has assigned so far, in file order. */
interface V1ToV2State {
	ids: Set<string>;
	prevId: string | null;
}

/**
 * v1 → v2 for one entry, in file order: assign its id and parent, and turn a
 * compaction's `firstKeptEntryIndex` into the id of the entry `entryAt` finds
 * at that file index. Mutates in place.
 */
function migrateEntryV1ToV2(
	entry: FileEntry,
	state: V1ToV2State,
	entryAt: (index: number) => MigratedEntryRef | undefined,
): void {
	if (entry.type === "session") {
		entry.version = 2;
		return;
	}

	entry.id = generateId(state.ids);
	state.ids.add(entry.id);
	entry.parentId = state.prevId;
	state.prevId = entry.id;

	// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
	if (entry.type === "compaction") {
		const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
		if (typeof comp.firstKeptEntryIndex === "number") {
			const targetEntry = entryAt(comp.firstKeptEntryIndex);
			if (targetEntry && targetEntry.type !== "session") {
				comp.firstKeptEntryId = targetEntry.id;
			}
			delete comp.firstKeptEntryIndex;
		}
	}
}

/** v2 → v3 for one entry: rename the hookMessage role to custom. Mutates in place. */
function migrateEntryV2ToV3(entry: FileEntry): void {
	if (entry.type === "session") {
		entry.version = 3;
		return;
	}

	if (entry.type === "message") {
		const msg = entry.message as { role?: string };
		if (msg.role === "hookMessage") {
			(entry.message as { role: string }).role = "custom";
		}
	}
}

/** True for a non-header entry without an id: a session whose entries all look like this predates ids. */
export function lacksEntryId(entry: FileEntry): boolean {
	return entry.type !== "session" && (typeof entry.id !== "string" || entry.id.length === 0);
}

/**
 * The migrations a session needs, applied one entry at a time in file order,
 * so a streamed load migrates each entry as it arrives. `unindexed` is
 * whether the file has non-header entries and none of them has an id (see
 * {@link lacksEntryId}); a current-version file needs it to decide.
 */
export class SessionEntryMigration {
	readonly #v1ToV2: boolean;
	readonly #v2ToV3: boolean;
	readonly #state: V1ToV2State = { ids: new Set(), prevId: null };
	/** What each entry seen so far left for a later compaction's `firstKeptEntryIndex`, by file index. */
	readonly #seen: MigratedEntryRef[] = [];

	constructor(header: SessionHeader, unindexed: boolean) {
		const version = header.version ?? 1;
		this.#v1ToV2 = version < 2 || unindexed;
		this.#v2ToV3 = version < 3;
		this.needed = version < CURRENT_SESSION_VERSION || unindexed;
	}

	/** Whether this session needs any migration; {@link migrate} is a no-op otherwise. */
	readonly needed: boolean;

	/** Migrate the next entry in file order, the header first. */
	migrate(entry: FileEntry): void {
		if (!this.needed) return;
		if (this.#v1ToV2) {
			migrateEntryV1ToV2(entry, this.#state, index => this.#seen[index]);
			this.#seen.push(entry.type === "session" ? { type: entry.type } : { type: entry.type, id: entry.id });
		}
		if (this.#v2ToV3) migrateEntryV2ToV3(entry);
		else if (entry.type === "session") entry.version = CURRENT_SESSION_VERSION;
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;
	const hasNonHeaderEntries = entries.some(e => e.type !== "session");
	const unindexed = hasNonHeaderEntries && entries.every(e => e.type === "session" || lacksEntryId(e));

	if (version >= CURRENT_SESSION_VERSION && !unindexed) return false;

	if (version < 2 || unindexed) {
		const state: V1ToV2State = { ids: new Set(), prevId: null };
		for (const entry of entries) migrateEntryV1ToV2(entry, state, index => entries[index]);
	}
	if (version < 3) {
		for (const entry of entries) migrateEntryV2ToV3(entry);
	} else if (header) header.version = CURRENT_SESSION_VERSION;
	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}
