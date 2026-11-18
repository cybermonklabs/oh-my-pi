/**
 * A session manager's own reads of a SQL session of 8 MiB or more stream it
 * through the store's chunked read (`readChunks`), so another store on the
 * same database (another process) can rewrite the transcript in the middle of
 * a read, or between two reads of one load. Each case races a real full write
 * of that other writer against such a read: the header probe and the load of
 * an open, a switch and a fork, and the check of whether a current-version
 * session predates entry ids. The cases run on a SQLite file, and skip where
 * the SQL store reads no chunks.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const MiB = 1024 * 1024;
const ID = "01a1f000-0000-7000-8000-0000000000e1";
const TIMESTAMP = "2026-11-18T00:00:00.000Z";
const HEADER = `${JSON.stringify({ type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/tmp" })}\n`;
/** Whether the SQL store reads a transcript in chunks (`readChunks`), which these races need. */
const readsChunks = await (async () => {
	const client = new SQL("sqlite::memory:");
	const storage: SessionStorage = await SqlSessionStorage.create({ client });
	const chunked = typeof storage.readChunks === "function";
	await client.close();
	return chunked;
})();

/** Nine 1 MiB custom entries of `fill` after the header, chained `p0` … `p8`; with `ids: false`, none has an id. */
function padBody(fill: string, ids = true): string {
	const lines = Array.from({ length: 9 }, (_, n) => {
		const identity = ids ? { id: `p${n}`, parentId: n === 0 ? null : `p${n - 1}` } : {};
		return `${JSON.stringify({ type: "custom", customType: "pad", ...identity, timestamp: TIMESTAMP, data: fill.repeat(MiB) })}\n`;
	});
	return HEADER + lines.join("");
}

/** A SQLite database file that each store opens on a client of its own, as two processes would. */
interface SqliteDb extends AsyncDisposable {
	/** The session's path. */
	readonly file: string;
	readonly sessionDir: string;
	/** The connection URL every store opens. */
	readonly dsn: string;
	/** A new store; `wrap` wraps the client it sends its statements through. */
	open(wrap?: (client: SqlSessionStorageClient) => SqlSessionStorageClient): Promise<SqlSessionStorage>;
}

function sqliteDb(): SqliteDb {
	const dir = TempDir.createSync("@omp-sql-load-race-");
	const dsn = `sqlite://${path.join(dir.path(), "sessions.db")}`;
	const clients: Array<InstanceType<typeof SQL>> = [];
	const file = path.join(dir.path(), "sessions", "-tmp-", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
	return {
		file,
		sessionDir: path.dirname(file),
		dsn,
		async open(wrap) {
			const client = new SQL(dsn);
			clients.push(client);
			return SqlSessionStorage.create({ client: wrap ? wrap(client) : client });
		},
		async [Symbol.asyncDispose]() {
			for (const client of clients) await client.close();
			dir.removeSync();
		},
	};
}

/** `store`'s full write of `content` over the session, landed in the database. */
async function rewrite(store: SqlSessionStorage, file: string, content: string): Promise<void> {
	await store.writeTextAtomic(file, content);
	await store.drain();
}

/**
 * Another process's full write of `content`, of the stored body's size, over
 * the session: on a connection of its own, its parts replaced by new ones,
 * as a store's full write replaces them. Stores of one process queue their
 * SQLite calls behind each other, so this writer cannot be one of them.
 */
async function rewritePartsElsewhere(dsn: string, file: string, content: string): Promise<void> {
	const client = new SQL(dsn);
	try {
		await client.unsafe("PRAGMA busy_timeout = 5000");
		await client.transaction(async transaction => {
			const [last] = (await transaction.unsafe(
				"SELECT coalesce(max(rowid), 0) AS last FROM omp_session_files_parts",
			)) as Array<{ last: number }>;
			let rowid = Number(last?.last ?? 0);
			await transaction.unsafe("DELETE FROM omp_session_files_parts WHERE path = ?", [file]);
			for (let start = 0; start < content.length; start += MiB) {
				await transaction.unsafe(
					"INSERT INTO omp_session_files_parts (rowid, path, start_offset, content) VALUES (?, ?, ?, ?)",
					[++rowid, file, start, content.slice(start, start + MiB)],
				);
			}
		});
	} finally {
		await client.close();
	}
}

/** A holder store that wrote `content` to the session, and a reader store that sees it. */
async function seeded(db: SqliteDb, content: string) {
	const holder = await db.open();
	await holder.writeTextAtomic(db.file, content);
	await holder.drain();
	const reader = await db.open();
	await reader.refresh();
	return { holder, reader };
}

/**
 * Run `race` once, right after the first chunk of the first chunked read of
 * `reader` that reads past that chunk (a header probe stops in it). Returns
 * whether it ran.
 */
function raceAfterFirstChunk(reader: SessionStorage, race: () => Promise<void>): () => boolean {
	const readChunks = reader.readChunks?.bind(reader);
	if (!readChunks) throw new Error("the SQL store reads no chunks");
	let raced = false;
	spyOn(reader, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
		(async function* () {
			for await (const chunk of readChunks(chunkPath, fromByte)) {
				yield chunk;
				if (raced) continue;
				raced = true;
				await race();
			}
		})(),
	);
	return () => raced;
}

/** The fill of each pad entry `manager` holds, in order. */
function fills(manager: SessionManager): string {
	return manager
		.getEntries()
		.map(entry => (entry.type === "custom" ? String(entry.data).charAt(0) : ""))
		.join("");
}

describe.skipIf(!readsChunks)("streamed loads of a SQL session that another store rewrites", () => {
	it("opens one whole body when the holder rewrites the transcript between the start of the header probe's read and its first page", async () => {
		// If this regresses, `omp --resume` of a long SQL session that another
		// process rewrites just then fails with a read conflict instead of opening.
		await using db = sqliteDb();
		let raced = false;
		const holder = await db.open();
		await holder.writeTextAtomic(db.file, padBody("a"));
		await holder.drain();
		// Another process's rewrite lands right after the statement that starts the first chunked read.
		const reader = await db.open(client => ({
			options: client.options,
			transaction: callback => client.transaction(transaction => callback(transaction)),
			unsafe: async (query: string, values?: unknown[]) => {
				const rows = await client.unsafe(query, values);
				if (!raced && query.includes("AS first_part")) {
					raced = true;
					await rewritePartsElsewhere(db.dsn, db.file, padBody("b"));
				}
				return rows;
			},
		}));
		await reader.refresh();

		const manager = await SessionManager.open(db.file, db.sessionDir, reader, { suppressBreadcrumb: true });
		const loaded = fills(manager);
		await manager.close();

		expect(raced).toBe(true);
		expect(["aaaaaaaaa", "bbbbbbbbb"]).toContain(loaded);
	}, 120_000);

	it("opens one whole body when the holder rewrites the transcript after the first chunk of the open's load", async () => {
		// If this regresses, `omp --resume` of a long SQL session another process
		// is compacting fails with a read conflict, or opens a mix of two bodies.
		await using db = sqliteDb();
		const { holder, reader } = await seeded(db, padBody("a"));
		const raced = raceAfterFirstChunk(reader, () => rewrite(holder, db.file, padBody("b")));

		const manager = await SessionManager.open(db.file, db.sessionDir, reader, { suppressBreadcrumb: true });
		const loaded = fills(manager);
		await manager.close();

		expect(raced()).toBe(true);
		expect(["aaaaaaaaa", "bbbbbbbbb"]).toContain(loaded);
	}, 120_000);

	it("switches to one whole body when the holder rewrites the transcript after the first chunk of the switch's load", async () => {
		// If this regresses, switching to a long SQL session another process is
		// compacting (`/resume`) fails with a read conflict, or shows a mix of two bodies.
		await using db = sqliteDb();
		const { holder, reader } = await seeded(db, padBody("a"));
		const manager = SessionManager.create("/tmp", db.sessionDir, reader);
		const raced = raceAfterFirstChunk(reader, () => rewrite(holder, db.file, padBody("b")));

		await manager.setSessionFile(db.file);
		const loaded = fills(manager);
		await manager.close();

		expect(raced()).toBe(true);
		expect(["aaaaaaaaa", "bbbbbbbbb"]).toContain(loaded);
	}, 120_000);

	it("forks one whole body when the holder rewrites the transcript after the first chunk of the fork's load", async () => {
		// If this regresses, forking a long SQL session another process is
		// compacting fails with a read conflict, or the fork holds a mix of two bodies.
		await using db = sqliteDb();
		const { holder, reader } = await seeded(db, padBody("a"));
		const raced = raceAfterFirstChunk(reader, () => rewrite(holder, db.file, padBody("b")));

		const fork = await SessionManager.forkFrom(db.file, "/tmp", db.sessionDir, reader, {
			suppressBreadcrumb: true,
		});
		const loaded = fills(fork);
		await fork.close();

		expect(raced()).toBe(true);
		expect(["aaaaaaaaa", "bbbbbbbbb"]).toContain(loaded);
	}, 120_000);

	it("gives the entries the ids and parents of the body it loads when the holder rewrites the transcript after the check for entry ids", async () => {
		// If this regresses, opening a current-version session whose entries had
		// no ids while another process rewrote it with ids renumbers every entry
		// of the new body, so the tree, the leaf and every reference by id break.
		await using db = sqliteDb();
		const { holder, reader } = await seeded(db, padBody("u", false));
		const chunked: SessionStorage = reader;
		const readChunks = chunked.readChunks?.bind(chunked);
		if (!readChunks) throw new Error("the SQL store reads no chunks");
		// The check reads the whole transcript: the first read that ends; the rewrite lands before the next.
		let wholeReads = 0;
		let raced = false;
		spyOn(chunked, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
			(async function* () {
				if (wholeReads > 0 && !raced) {
					raced = true;
					await rewrite(holder, db.file, padBody("i"));
				}
				yield* readChunks(chunkPath, fromByte);
				wholeReads++;
			})(),
		);

		const manager = await SessionManager.open(db.file, db.sessionDir, reader, { suppressBreadcrumb: true });
		const loaded = fills(manager);
		const identity = manager.getEntries().map(entry => [entry.id, entry.parentId]);
		await manager.close();

		expect(raced).toBe(true);
		expect(loaded).toBe("iiiiiiiii");
		expect(identity).toEqual(Array.from({ length: 9 }, (_, n) => [`p${n}`, n === 0 ? null : `p${n - 1}`]));
	}, 120_000);
});
