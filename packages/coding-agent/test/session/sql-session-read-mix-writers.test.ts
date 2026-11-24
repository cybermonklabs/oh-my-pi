/**
 * A chunked SQLite read raced by writers its page checks cannot see: an older
 * omp release re-creating the session from another process, and the reading
 * store itself re-creating it with the rowids it had. Only the read's check at
 * its end can catch either (`PRAGMA data_version` for another connection's
 * commit, the store's own count of its writes of the path for its own), and the
 * read gives one body or a read conflict, never a mix. The tester's cases for
 * the same class are in `sql-session-read-mix.test.ts`.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorage, SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	appendLines,
	firstPrompt,
	padFills,
	RACED_SESSION_ID,
	raceAfterFirstChunk,
	sharedPadBody,
	STILL,
	startedByOlderWriter,
} from "./chunked-read-race";
import { type LeaseDb, openLeaseDb } from "./sql-session-lease-fixture";

const ID = RACED_SESSION_ID;

/**
 * Read `file` through `reader` from `fromByte`, running `race` once, right
 * after the first chunk. What the read gave: the name of the entry of `bodies`
 * its bytes equal, "read conflict", "a short body" (the start of one of
 * `bodies`) or "a mix".
 */
async function racedRead(
	reader: SqlSessionStorage,
	file: string,
	fromByte: number,
	race: () => Promise<void>,
	bodies: Record<string, string>,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of reader.readChunks(file, fromByte)) {
			chunks.push(chunk);
			if (chunks.length === 1) await race();
		}
	} catch (err) {
		if (!(err instanceof SessionReadConflictError)) throw err;
		return "read conflict";
	}
	const text = Buffer.concat(chunks).toString("utf8");
	const named = Object.entries(bodies).find(([, body]) => body === text);
	if (named) return named[0];
	return Object.values(bodies).some(body => body.startsWith(text)) ? "a short body" : "a mix";
}

const OLDER_WRITER_PROCESS = path.join(import.meta.dir, "sql-session-older-writer-process.ts");

/**
 * Write `lines` as session `file` of `db` from another process, the way an
 * older omp release running there does (`sql-session-older-writer-process.ts`),
 * and wait until that process has committed and exited.
 */
async function olderProcessWrites(db: LeaseDb, file: string, lines: string[]): Promise<void> {
	const child = Bun.spawn([process.execPath, OLDER_WRITER_PROCESS], {
		stdin: new Blob([JSON.stringify({ file: db.dsn.slice("sqlite://".length), table: db.table, path: file, lines })]),
		stdout: "ignore",
		stderr: "pipe",
		env: process.env,
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(`the older release's process exited with ${code}: ${stderr}`);
}

// The older release re-creates the session from another process: its commit gives no page check a sign
// (the part the read starts at gets its rowid back, the part it fetched last is the same in both bodies),
// and only the read's check at its end, which sees the commit of another connection, can catch it.
describe("a chunked SQLite read raced by an older release re-creating the session from another process", () => {
	it("yields the old body, the new one or a read conflict when the other process re-creates it between two pages", async () => {
		// If this regresses, while an older omp release in another process shares the SQLite database, reading a
		// session that process re-creates meanwhile gives its first lines from the old transcript and the rest
		// from the new one.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const before = sharedPadBody("first", "b");
		const after = sharedPadBody("FIRST", "c");
		const release = await startedByOlderWriter(db, file, before);
		const reader = await db.open({ lease: STILL });
		await reader.refresh();

		const outcome = await racedRead(reader, file, 0, () => olderProcessWrites(db, file, after), {
			"old body": before.join(""),
			"new body": after.join(""),
		});
		const recreated = (await db.row(file))?.content === after.join("");

		expect(["old body", "new body", "read conflict"]).toContain(outcome);
		expect(recreated).toBe(true);
		release();
	}, 120_000);

	it("loads the new body's entries when the other process re-creates it after the first chunk of the load", async () => {
		// If this regresses, resuming a session an older omp release in another process re-creates meanwhile
		// opens with the first turn of the old transcript followed by the later entries of the new one.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const release = await startedByOlderWriter(db, file, sharedPadBody("first", "b"));
		const reader = await db.open({ lease: STILL });
		await reader.refresh();
		const race = raceAfterFirstChunk(reader, file, () => olderProcessWrites(db, file, sharedPadBody("FIRST", "c")));

		const loaded = await loadSessionFile(file, reader);

		expect({ raced: race.ran, loaded: `${firstPrompt(loaded.entries)} ${padFills(loaded.entries)}` }).toEqual({
			raced: true,
			loaded: "FIRST accccccc",
		});
		release();
	}, 120_000);
});

// The store that reads the session re-creates it itself, its clock held at one millisecond: a part it inserts
// after it deleted the session's parts then takes the rowid of the part it replaces (the documented gap in
// the store's rowid rule), so no page check sees the re-create; and SQLite's data_version, which moves for
// every other connection's commit, never moves for the connection's own. Only the store's own count of its
// writes to the path can show it.
describe("a chunked SQLite read raced by its own store re-creating the session with the rowids it had", () => {
	/**
	 * Session `file` of `db`, written one line at a time as `lines` by a store
	 * that claims it and then reads it; what its own connection reports
	 * (`PRAGMA data_version`); the rowid of its first part; and the re-create:
	 * a delete and appends of other lines.
	 */
	async function ownSession(db: LeaseDb, file: string, lines: string[]) {
		let connection: SqlSessionStorageClient | undefined;
		const store = await db.open({
			lease: STILL,
			wrap: client => {
				connection = client;
				return client;
			},
		});
		const release = await store.acquireSessionClaim?.(ID, file);
		await appendLines(store, file, lines);
		return {
			store,
			release: () => release?.(),
			dataVersion: async () => (await connection?.unsafe("PRAGMA data_version"))?.[0],
			firstRowid: async () =>
				(
					await db.sql(
						`SELECT CAST(rowid AS TEXT) AS id FROM ${db.table}_parts WHERE path = @1 AND start_offset = 0`,
						[file],
					)
				)[0]?.id,
			recreate: async (next: string[]) => {
				await store.unlink(file);
				await store.drain();
				await appendLines(store, file, next);
			},
		};
	}

	it("yields the old body, the new one or a read conflict when the store re-creates it between two pages", async () => {
		// If this regresses, a session this process deletes and starts again under the same path while it reads
		// it reads as the old transcript's first lines followed by the new one's.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const before = sharedPadBody("first", "b");
		const after = sharedPadBody("FIRST", "c");
		const clock = spyOn(Date, "now").mockReturnValue(Date.now());
		try {
			const session = await ownSession(db, file, before);
			const seen = { rowid: await session.firstRowid(), dataVersion: await session.dataVersion() };

			const outcome = await racedRead(session.store, file, 0, () => session.recreate(after), {
				"old body": before.join(""),
				"new body": after.join(""),
			});

			expect(["old body", "new body", "read conflict"]).toContain(outcome);
			expect({
				recreated: (await db.row(file))?.content === after.join(""),
				rowid: await session.firstRowid(),
				dataVersion: await session.dataVersion(),
			}).toEqual({ recreated: true, ...seen });
			session.release();
		} finally {
			clock.mockRestore();
		}
	}, 120_000);

	it("loads the new body's entries when the store re-creates it after the first chunk of the load", async () => {
		// If this regresses, resuming a session this process deleted and started again under the same path
		// meanwhile opens with the first turn of the old transcript followed by the later entries of the new one.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const clock = spyOn(Date, "now").mockReturnValue(Date.now());
		try {
			const session = await ownSession(db, file, sharedPadBody("first", "b"));
			const race = raceAfterFirstChunk(session.store, file, () => session.recreate(sharedPadBody("FIRST", "c")));

			const loaded = await loadSessionFile(file, session.store);

			expect({ raced: race.ran, loaded: `${firstPrompt(loaded.entries)} ${padFills(loaded.entries)}` }).toEqual({
				raced: true,
				loaded: "FIRST accccccc",
			});
			session.release();
		} finally {
			clock.mockRestore();
		}
	}, 120_000);
});

/**
 * A wrapper of a store's client that only times other writers' commits against the store's own statements:
 * it runs an armed race once, right after the store's next statement completes (`afterStatement`), or right
 * after its next statement that returns a stored part (`afterPart`: a value of at least 512 KiB, as every pad
 * of these bodies is 1 MiB), before the rows go back. It keeps the client's `options`, the database file name
 * included, so the store queues and checks its calls as it does on the client itself.
 */
function statementRaces(): {
	wrap: (client: SqlSessionStorageClient) => SqlSessionStorageClient;
	afterStatement: (race: () => Promise<void>) => void;
	afterPart: (race: () => Promise<void>) => void;
} {
	let afterStatement: (() => Promise<void>) | undefined;
	let afterPart: (() => Promise<void>) | undefined;
	const holdsPart = (result: unknown): boolean =>
		Array.isArray(result) &&
		result.some(
			row =>
				typeof row === "object" &&
				row !== null &&
				Object.values(row).some(
					value =>
						(typeof value === "string" && value.length >= 512 * 1024) ||
						(value instanceof Uint8Array && value.byteLength >= 512 * 1024),
				),
		);
	return {
		wrap: client => ({
			options: client.options,
			async unsafe(query, values) {
				const result = await client.unsafe(query, values);
				let race: (() => Promise<void>) | undefined;
				if (afterStatement) {
					race = afterStatement;
					afterStatement = undefined;
				} else if (afterPart && holdsPart(result)) {
					race = afterPart;
					afterPart = undefined;
				}
				if (race) await race();
				return result;
			},
			transaction: callback => client.transaction(callback),
			end: () => client.end?.() ?? Promise.resolve(),
		}),
		afterStatement(race) {
			afterStatement = race;
		},
		afterPart(race) {
			afterPart = race;
		},
	};
}

/**
 * Make the reads of `file` through `reader.readChunks` race around the check at their end, by the other
 * process's re-creates (`recreate`): as `next` right after the first chunk the reads yield (the part the read
 * starts at gets its rowid back and the last part it fetched is the same, so no page check sees it); once they
 * have yielded all `size` bytes, as `back` right after the reader's next statement, where the check starts;
 * and as `next` again right after the reader's next statement after that which returns a stored part, the
 * first page the check reads again. Returns the re-creates that ran, in order.
 */
function raceAroundEndCheck(
	reader: SqlSessionStorage,
	file: string,
	races: ReturnType<typeof statementRaces>,
	size: number,
	recreate: (lines: string[]) => Promise<void>,
	bodies: { back: string[]; next: string[] },
): string[] {
	const readChunks = reader.readChunks.bind(reader);
	const ran: string[] = [];
	let yielded = 0;
	let armed = false;
	spyOn(reader, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
		(async function* () {
			if (chunkPath !== file) {
				yield* readChunks(chunkPath, fromByte);
				return;
			}
			for await (const chunk of readChunks(chunkPath, fromByte)) {
				const first = yielded === 0;
				yielded += chunk.byteLength;
				yield chunk;
				if (first) {
					await recreate(bodies.next);
					ran.push("next after the first chunk");
				}
				if (!armed && yielded >= size) {
					armed = true;
					races.afterStatement(async () => {
						await recreate(bodies.back);
						ran.push("back where the end check starts");
						races.afterPart(async () => {
							await recreate(bodies.next);
							ran.push("next after the end check's first page");
						});
					});
				}
			}
		})(),
	);
	return ran;
}

// The older release in another process re-creates the session three times around one chunked read: once
// between its pages, which no page check sees; once more with the old body right where the read's check at its
// end starts; and once more with the new body right after that check has read its first page again. The check
// then reads the old body's first page and the new body's rest, the same bytes the read yielded, and finds
// them unchanged. Only a check that also sees the commits during its own reading can catch it.
describe("a chunked SQLite read raced by an older release re-creating the session around the check at its end", () => {
	it("yields the old body, the new one or a read conflict when the other process re-creates it while the check reads it again", async () => {
		// If this regresses, while an older omp release in another process shares the SQLite database, reading a
		// session that process re-creates several times meanwhile gives the start of one version of the transcript
		// followed by the end of another.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const before = sharedPadBody("first", "b");
		const after = sharedPadBody("FIRST", "c");
		const release = await startedByOlderWriter(db, file, before);
		const races = statementRaces();
		const reader = await db.open({ lease: STILL, wrap: races.wrap });
		await reader.refresh();
		const ran = raceAroundEndCheck(
			reader,
			file,
			races,
			Buffer.byteLength(before.join("")),
			lines => olderProcessWrites(db, file, lines),
			{ back: before, next: after },
		);

		// The re-creates run from raceAroundEndCheck, as the read goes.
		const outcome = await racedRead(reader, file, 0, async () => {}, {
			"old body": before.join(""),
			"new body": after.join(""),
		});

		expect(ran[0]).toBe("next after the first chunk");
		expect(["old body", "new body", "read conflict"]).toContain(outcome);
		release();
	}, 120_000);

	it("loads one body's entries when the other process re-creates it while the check of the load's read reads it again", async () => {
		// If this regresses, resuming a session an older omp release in another process re-creates several times
		// meanwhile opens with the first turn of one version of the transcript followed by the later entries of
		// another.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const before = sharedPadBody("first", "b");
		const after = sharedPadBody("FIRST", "c");
		const release = await startedByOlderWriter(db, file, before);
		const races = statementRaces();
		const reader = await db.open({ lease: STILL, wrap: races.wrap });
		await reader.refresh();
		const ran = raceAroundEndCheck(
			reader,
			file,
			races,
			Buffer.byteLength(before.join("")),
			lines => olderProcessWrites(db, file, lines),
			{ back: before, next: after },
		);

		let loaded: string;
		try {
			const session = await loadSessionFile(file, reader);
			loaded = `${firstPrompt(session.entries)} ${padFills(session.entries)}`;
		} catch (err) {
			if (!(err instanceof SessionReadConflictError)) throw err;
			loaded = "read conflict";
		}

		expect(ran[0]).toBe("next after the first chunk");
		// "first abbbbbbb" is the old body, "FIRST accccccc" the new one.
		expect(["first abbbbbbb", "FIRST accccccc", "read conflict"]).toContain(loaded);
		release();
	}, 120_000);
});
