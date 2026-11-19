/**
 * The readers that build state from a streamed read of a stored transcript (a
 * resume, an open by path, the copy of a fork's source, an HTML export, and
 * the reload after a claim) see each chunk before the read checks what it
 * yielded. On SQLite an omp release older than the store's rowid rule, sharing
 * the database, can re-create a session between two pages of a read so that
 * no page check sees it: the part the read starts at gets its rowid back, and
 * the part it fetched last holds the same bytes in both bodies. Only the
 * read's check at its end sees it, and fails the read with
 * `SessionReadConflictError`. Each reader must then drop what it built and
 * read the session again from its start, ending with the new body alone: its
 * first prompt and every pad from it.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildSessionData } from "@oh-my-pi/pi-coding-agent/export/html";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSessionFile, parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { defaultSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { copyTranscript } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	firstPrompt,
	MiB,
	olderWriterWrites,
	padFills,
	paddedTranscript,
	RACED_SESSION_ID,
	type Race,
	raceAfterFirstChunk,
	STILL,
	sharedPadBody,
	startedByOlderWriter,
} from "./chunked-read-race";
import { type LeaseDb, openLeaseDb } from "./sql-session-lease-fixture";

/** The body the session holds when a read starts, and the one the older release re-creates it as after the first chunk. */
const BEFORE = sharedPadBody("first", "b");
const AFTER = sharedPadBody("FIRST", "c");
/** What the new body holds: its first prompt and its pads' fills (see {@link summary}). */
const NEW_BODY = "FIRST accccccc";
/** A load streams a transcript of this many bytes or more (`STREAM_LOAD_THRESHOLD_BYTES` in session-loader.ts). */
const STREAM_LOAD_BYTES = 8 * MiB;

/** The first prompt among `entries` and their pads' fills: `NEW_BODY` for the new body, `first abbbbbbb` for the old one. */
function summary(entries: readonly FileEntry[]): string {
	return `${firstPrompt(entries)} ${padFills(entries)}`;
}

/**
 * Session {@link RACED_SESSION_ID}'s file in `db` holding `lines`, which an
 * older release started and a store of this release appended to, and a
 * second store that reads it, as another omp process does. Returns the reader
 * and the release of the first store's claim.
 */
async function storedSession(
	db: LeaseDb,
	lines: string[],
): Promise<{ reader: SqlSessionStorage; file: string; release: () => void }> {
	// A load streams only a transcript past its threshold, and only a read over several pages can be raced
	// between two of them: the stored body and the new one are both past it.
	expect([lines, AFTER].map(body => Buffer.byteLength(body.join("")) >= STREAM_LOAD_BYTES)).toEqual([true, true]);
	// Lines of the same lengths, so every part of the new body starts where one of the old body did.
	expect(AFTER.map(line => line.length)).toEqual(BEFORE.map(line => line.length));
	const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${RACED_SESSION_ID}.jsonl`);
	const release = await startedByOlderWriter(db, file, lines);
	const reader = await db.open({ lease: STILL });
	await reader.refresh();
	return { reader, file, release };
}

/**
 * Make the older release re-create `file` of `db` as {@link AFTER} once the
 * reads of it through `reader` yielded `afterBytes` bytes (by default, right
 * after the first chunk).
 */
function olderReleaseRecreates(reader: SqlSessionStorage, db: LeaseDb, file: string, afterBytes?: number): Race {
	return raceAfterFirstChunk(reader, file, () => olderWriterWrites(db, file, AFTER), afterBytes);
}

describe("a reader of a SQLite session an older release re-creates after the first chunk of its read", () => {
	it("resumes the new body alone (SessionManager.open)", async () => {
		// If this regresses, resuming a long session while an older omp release re-creates it opens with the
		// first turn of the old transcript followed by the later entries of the new one.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const { reader, file, release } = await storedSession(db, BEFORE);
		const race = olderReleaseRecreates(reader, db, file);

		const manager = await SessionManager.open(file, path.dirname(file), reader, { suppressBreadcrumb: true });
		const resumed = summary(manager.getEntries());
		await manager.close();
		release();

		expect({ raced: race.ran, resumed }).toEqual({ raced: true, resumed: NEW_BODY });
	}, 120_000);

	it("loads the new body alone (loadSessionFile)", async () => {
		// If this regresses, opening a long session by its path while an older omp release re-creates it loads
		// the first turn of the old transcript followed by the later entries of the new one.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const { reader, file, release } = await storedSession(db, BEFORE);
		const race = olderReleaseRecreates(reader, db, file);

		const loaded = summary((await loadSessionFile(file, reader)).entries);
		release();

		expect({ raced: race.ran, loaded }).toEqual({ raced: true, loaded: NEW_BODY });
	}, 120_000);

	it("copies the new body alone to the fork (copyTranscript)", async () => {
		// If this regresses, forking a long session while an older omp release re-creates it gives the fork a
		// transcript that starts with the old session's first turn and goes on with the new one's entries.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const { reader, file, release } = await storedSession(db, BEFORE);
		const to = path.join(db.dir.path(), "sessions", "-fork-", path.basename(file));
		const race = raceAfterFirstChunk(reader, file, async () => {
			// The copy's own writes first: the older release's connection must not wait on them for a lock.
			await reader.drain();
			await olderWriterWrites(db, file, AFTER);
		});

		const copied = await copyTranscript(reader, file, to);
		await reader.drain();
		const stored = (await db.row(to))?.content ?? "";
		release();

		expect({
			raced: race.ran,
			copied,
			copy: summary(parseSessionEntries(stored)),
			whole: stored === AFTER.join(""),
		}).toEqual({
			raced: true,
			copied: true,
			copy: NEW_BODY,
			whole: true,
		});
	}, 120_000);

	it("exports the new body alone (the session data the HTML export embeds, read as exportFromFile opens it)", async () => {
		// If this regresses, an HTML export of a long session that an older omp release re-creates meanwhile
		// shows the old session's first turn followed by the new one's entries.
		// exportFromFile cannot run whole here: its document needs the export viewer that `bun gen:export-viewer`
		// builds at install, which this checkout has not built. So the case makes the export's read, as
		// exportFromFile does (SessionManager.open from the default storage, the session required), and takes the
		// data the export would embed (buildSessionData).
		await using db = await openLeaseDb("sqlite", "sqlite");
		const { reader, file, release } = await storedSession(db, BEFORE);
		// That open reads the session twice (again after it looked at the recorded directory) and keeps the
		// second read, so the race lands right after the second read's first chunk.
		const race = olderReleaseRecreates(reader, db, file, Buffer.byteLength(BEFORE.join("")) + 1);
		const previous = defaultSessionStorage();
		setDefaultSessionStorage(reader);
		let exported: string;
		try {
			const manager = await SessionManager.open(file, undefined, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			exported = summary(buildSessionData(manager).entries);
			await manager.close();
		} finally {
			setDefaultSessionStorage(previous);
		}
		release();

		expect({ raced: race.ran, exported }).toEqual({ raced: true, exported: NEW_BODY });
	}, 120_000);

	it("reloads the new body alone once it holds the claim (claimOpenedSession)", async () => {
		// If this regresses, resuming a long session that an older omp release wrote while another process held
		// it goes on, once the claim is taken, from the old transcript's first turn and the new one's entries.
		await using db = await openLeaseDb("sqlite", "sqlite");
		// The manager opens a longer body (nine pads); the older release then writes BEFORE in its place, so the
		// stored size is not the one the manager loaded, and the claim reads the session again. The reader's
		// index still holds the longer size, past the streaming threshold, so that read streams.
		const { reader, file, release } = await storedSession(db, paddedTranscript(RACED_SESSION_ID, "first", "b", 9));
		const manager = await SessionManager.open(file, path.dirname(file), reader, { suppressBreadcrumb: true });
		release();
		await olderWriterWrites(db, file, BEFORE);
		const race = olderReleaseRecreates(reader, db, file);

		await manager.claimOpenedSession();
		const reloaded = summary(manager.getEntries());
		await manager.close();

		expect({ raced: race.ran, reloaded }).toEqual({ raced: true, reloaded: NEW_BODY });
	}, 120_000);
});
