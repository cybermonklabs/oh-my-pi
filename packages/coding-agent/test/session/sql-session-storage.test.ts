/**
 * Functional tests for {@link SqlSessionStorage}. Driven by a real
 * `Bun.SQL` SQLite instance (in-memory) so the storage exercises actual
 * SQL execution, not a hand-rolled mock. PostgreSQL/MySQL statements are
 * covered by the dialect-specific query suite below, which inspects the
 * statements built at construction, and live by
 * sql-session-storage-dialects.test.ts when a server is configured.
 */

import { describe, expect, it } from "bun:test";
import { listAllSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionReadConflictError, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { copyTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { readStoredParts, readStoredSession, readStoredSessions } from "../helpers/sql-session-storage";

const MiB = 1024 * 1024;

/** The SQLite schema docs/session.md gives `createTable: false` consumers. */
const SQLITE_SCHEMA = [
	`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, byte_len INTEGER)`,
	`CREATE TABLE omp_session_files_parts (path TEXT NOT NULL, start_offset INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (path, start_offset))`,
];

async function createSqlite(): Promise<{ client: InstanceType<typeof SQL>; storage: SqlSessionStorage }> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	return { client, storage };
}

/** Wrap a SQLite client so every statement the storage issues is recorded. */
function recordQueries(client: InstanceType<typeof SQL>): { client: SqlSessionStorageClient; queries: string[] } {
	const queries: string[] = [];
	const wrapped: SqlSessionStorageClient = {
		options: client.options,
		unsafe(query, values) {
			queries.push(query);
			return client.unsafe(query, values);
		},
		transaction(callback) {
			return client.transaction(async transaction =>
				callback({
					unsafe(query, values) {
						queries.push(query);
						return transaction.unsafe(query, values);
					},
				}),
			);
		},
	};
	return { client: wrapped, queries };
}

describe("SqlSessionStorage (SQLite backend)", () => {
	it("indexes writeText metadata and reads content asynchronously", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		expect(await readStoredSessions(client, "omp_session_files")).toEqual([
			{ path: "/sessions/p/a.jsonl", content: "line1\nline2\n" },
		]);

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
		await client.end();
	});

	it("create() warms the metadata index without reading session content", async () => {
		const client = new SQL("sqlite::memory:");
		for (const ddl of SQLITE_SCHEMA) await client.unsafe(ddl);
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms, byte_len) VALUES (?, '', ?, ?)`, [
			"/sessions/p/huge.jsonl",
			Date.now(),
			10,
		]);
		await client.unsafe(`INSERT INTO omp_session_files_parts (path, start_offset, content) VALUES (?, 0, ?)`, [
			"/sessions/p/huge.jsonl",
			"0123456789",
		]);

		const { client: wrapped, queries } = recordQueries(client);
		const storage = await SqlSessionStorage.create({ client: wrapped, createTable: false });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		expect(queries.filter(query => /\bcontent\b/i.test(query))).toEqual([]);
		await client.end();
	});

	it("listFilesSync returns only direct children matching the glob", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		expect(storage.listFilesSync("/dir", "*.jsonl").sort()).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);
		expect(storage.listFilesSync("/dir", "*.bak")).toEqual(["/dir/note.bak"]);
		await client.end();
	});

	it("listAllSessions finds SQL-only sessions across every project directory", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/projA/a.jsonl", '{"type":"session","id":"session-a","cwd":"/work/a"}\n');
		await storage.writeText("/sessions/projB/b.jsonl", '{"type":"session","id":"session-b","cwd":"/work/b"}\n');

		const sessions = await listAllSessions(storage, "/sessions");

		expect(sessions.map(session => session.id).sort()).toEqual(["session-a", "session-b"]);
		await client.end();
	});

	it("writer.append appends to SQL after drain", async () => {
		const { client, storage } = await createSqlite();
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from SQL.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		await storage.drain();
		expect(await readStoredSession(client, "omp_session_files", "/sessions/p/session.jsonl")).toBe(
			'{"type":"session"}\n{"type":"message"}\n',
		);

		await writer.close();
		await client.end();
	});

	it("flags='w' truncates both mirror and SQL row", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(await readStoredSession(client, "omp_session_files", "/sessions/p/keep.jsonl")).toBe("fresh\n");
		await client.end();
	});

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");
		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
		await client.end();
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");

		// Force a SQL error: drop the table so the next append throws.
		await client.unsafe("DROP TABLE omp_session_files");
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow();
		expect(writer.getError()).toBeDefined();
		await client.end();
	});

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files ORDER BY path`)) as Array<{
			path: string;
		}>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/other.jsonl"]);
		await client.end();
	});

	it("rename moves content and mtime atomically inside the mirror and the DB", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);

		expect(await readStoredSessions(client, "omp_session_files")).toEqual([
			{ path: "/sessions/p/renamed.jsonl", content: "payload\n" },
		]);
		await client.end();
	});

	it("rename overwrites an existing destination (parity with fs.rename)", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "from-a\n");
		await storage.writeText("/sessions/p/b.jsonl", "from-b\n");

		await storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");
		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/b.jsonl")).toBe("from-a\n");
		expect(await readStoredSessions(client, "omp_session_files")).toEqual([
			{ path: "/sessions/p/b.jsonl", content: "from-a\n" },
		]);
		await client.end();
	});

	it("rename to the same path preserves the row", async () => {
		const { client, storage } = await createSqlite();
		const sessionPath = "/sessions/p/same.jsonl";
		await storage.writeText(sessionPath, "keep-me\n");

		await storage.rename(sessionPath, sessionPath);

		expect(storage.existsSync(sessionPath)).toBe(true);
		expect(await storage.readText(sessionPath)).toBe("keep-me\n");

		await client.unsafe(`DELETE FROM omp_session_files WHERE path = ?`, [sessionPath]);
		await expect(storage.rename(sessionPath, sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("rename rolls back destination deletion when moving the source fails", async () => {
		const { client, storage } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(
			`CREATE TRIGGER reject_session_move BEFORE UPDATE OF path ON omp_session_files ` +
				`WHEN OLD.path = '${source}' BEGIN SELECT RAISE(ABORT, 'move rejected'); END`,
		);

		await expect(storage.rename(source, destination)).rejects.toThrow("move rejected");

		expect(await storage.readText(source)).toBe("source\n");
		expect(await storage.readText(destination)).toBe("destination\n");
		await client.end();
	});

	it("rename rejects an externally deleted source without deleting the destination", async () => {
		const { client, storage } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(`DELETE FROM omp_session_files WHERE path = ?`, [source]);

		await expect(storage.rename(source, destination)).rejects.toMatchObject({ code: "ENOENT" });

		expect(await storage.readText(destination)).toBe("destination\n");
		expect(await readStoredSessions(client, "omp_session_files")).toEqual([
			{ path: destination, content: "destination\n" },
		]);
		await client.end();
	});

	it("rename rejects a missing source, including a same-path rename", async () => {
		const { client, storage } = await createSqlite();

		await expect(storage.rename("/sessions/p/missing.jsonl", "/sessions/p/new.jsonl")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(storage.rename("/sessions/p/missing.jsonl", "/sessions/p/missing.jsonl")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await client.end();
	});

	it("refresh() reloads the mirror from SQL after out-of-band writes", async () => {
		const { client, storage } = await createSqlite();
		// Simulate a peer process inserting directly.
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms, byte_len) VALUES (?, ?, ?, ?)`, [
			"/peer/x.jsonl",
			"from peer\n",
			Date.now() + 5_000,
			10,
		]);
		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);

		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
		await client.end();
	});

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		await client.end();
	});

	it("readChunks streams the parts in start_offset order, a part per chunk, from any offset", async () => {
		const { client, storage } = await createSqlite();
		const path = "/sessions/p/parts.jsonl";
		// Three-byte characters put the full write's 1 MiB cut one byte early; each append is a part of its own size.
		const body = `${"€".repeat(400_000)}\n`;
		const appends = Array.from({ length: 10 }, (_, n) => `${n}:${"😀".repeat(n * 30_000)}€\n`);
		await storage.writeText(path, body);
		const writer = storage.openWriter(path);
		for (const line of appends) await writer.append(line);
		await writer.close();
		const expected = Buffer.from(body + appends.join(""));
		const partSizes = (
			(await client.unsafe(
				`SELECT length(cast(content AS blob)) AS len FROM omp_session_files_parts WHERE path = ? ORDER BY start_offset`,
				[path],
			)) as Array<{ len: number }>
		).map(part => part.len);

		const chunks = await Array.fromAsync(storage.readChunks(path));
		expect(chunks.map(chunk => chunk.byteLength)).toEqual(partSizes);
		expect(Buffer.concat(chunks).equals(expected)).toBe(true);

		const bodyBytes = Buffer.byteLength(body);
		const firstPart = partSizes[0] ?? 0;
		for (const offset of [
			1,
			firstPart - 1,
			firstPart,
			firstPart + 1,
			bodyBytes,
			bodyBytes + 3,
			expected.length - 1,
		]) {
			const read = Buffer.concat(await Array.fromAsync(storage.readChunks(path, offset)));
			expect({ offset, equal: read.equals(expected.subarray(offset)) }).toEqual({ offset, equal: true });
		}
		expect(await Array.fromAsync(storage.readChunks(path, expected.length))).toEqual([]);
		expect(await Array.fromAsync(storage.readChunks(path, expected.length + 5))).toEqual([]);
		await client.end();
	});

	it("readChunks lays the indexed title over the head as readTextFrom does, across small parts", async () => {
		const { client, storage } = await createSqlite();
		const path = "/sessions/p/titled-parts.jsonl";
		const slot = serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" });
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		const writer = storage.openWriter(path);
		// The slot arrives as three parts, so the overlay spans chunks.
		for (const piece of [slot.slice(0, 100), slot.slice(100, 200), slot.slice(200), header, "tail\n"]) {
			await writer.append(piece);
		}
		await writer.close();
		await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

		for (const offset of [0, 10, 150, 255, 256, 300]) {
			const chunks = Buffer.concat(await Array.fromAsync(storage.readChunks(path, offset))).toString("utf-8");
			expect({ offset, chunks }).toEqual({ offset, chunks: (await storage.readTextFrom(path, offset)).text });
		}
		const head = Buffer.concat(await Array.fromAsync(storage.readChunks(path))).toString("utf-8");
		expect(JSON.parse(head.split("\n")[0] ?? "")).toMatchObject({ title: "New", source: "user" });
		await client.end();
	});

	it("readChunks reads many small appended parts in a few queries, not one per few parts", async () => {
		const raw = new SQL("sqlite::memory:");
		const { client, queries } = recordQueries(raw);
		const storage = await SqlSessionStorage.create({ client });
		const path = "/sessions/p/appended.jsonl";
		// About 4 MiB in 4,000 parts.
		const lines = Array.from({ length: 4000 }, (_, n) => `${JSON.stringify({ n, pad: "x".repeat(1000) })}\n`);
		const writer = storage.openWriter(path);
		for (const line of lines) await writer.append(line);
		await writer.close();

		queries.length = 0;
		const read = Buffer.concat(await Array.fromAsync(storage.readChunks(path)));
		expect(read.toString("utf-8")).toBe(lines.join(""));
		// The session's size, then pages spanning 1, 2 and 4 MiB: together past the 4 MiB stored.
		expect(queries.length).toBeLessThanOrEqual(4);
		await raw.end();
	});

	it("readChunks fetches about the window a reader stops after, not a whole page of 12 MiB", async () => {
		const raw = new SQL("sqlite::memory:");
		let paged = 0;
		let pages = 0;
		const client: SqlSessionStorageClient = {
			options: raw.options,
			async unsafe(query, values) {
				const rows = await raw.unsafe(query, values);
				if (query.startsWith("SELECT start_offset, content FROM")) {
					pages++;
					for (const row of rows as Array<{ content: string }>) paged += Buffer.byteLength(row.content);
				}
				return rows;
			},
			transaction(callback) {
				return raw.transaction(async transaction =>
					callback({ unsafe: (query, values) => transaction.unsafe(query, values) }),
				);
			},
		};
		const storage = await SqlSessionStorage.create({ client });
		const path = "/sessions/p/windowed.jsonl";
		const part = 100 * 1024;
		const writer = storage.openWriter(path);
		// 8 MiB in parts of 100 KiB.
		for (let n = 0; n < 82; n++) await writer.append(`${String(n).padStart(2, "0")}:${"x".repeat(part - 4)}\n`);
		await writer.close();

		// Windows of 1 MiB as memories stage 1 reads them: from the start, and from inside a part.
		for (const offset of [0, 4 * MiB]) {
			paged = 0;
			pages = 0;
			let read = 0;
			for await (const chunk of storage.readChunks(path, offset)) {
				read += chunk.byteLength;
				if (read >= MiB) break;
			}
			// One page: the window, the part it ends in, and the head of the part it starts in.
			const bound = MiB + part + (offset % part);
			expect({ offset, pages, withinBound: paged <= bound }).toEqual({ offset, pages: 1, withinBound: true });
		}
		await raw.end();
	});

	it("readChunks from inside a row an older version wrote fetches only the row's bytes from there on", async () => {
		const raw = new SQL("sqlite::memory:");
		const path = "/sessions/p/legacy.jsonl";
		const legacy = `${"€".repeat(50_000)}\n`;
		await SqlSessionStorage.create({ client: raw });
		await raw.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms, byte_len) VALUES (?, ?, ?, ?)`, [
			path,
			legacy,
			1,
			Buffer.byteLength(legacy),
		]);
		let fetched = 0;
		const count = (rows: unknown[]): void => {
			for (const row of rows as Array<Record<string, unknown>>) {
				for (const value of Object.values(row)) {
					if (typeof value === "string") fetched += Buffer.byteLength(value);
					else if (value instanceof Uint8Array) fetched += value.byteLength;
				}
			}
		};
		const client: SqlSessionStorageClient = {
			options: raw.options,
			async unsafe(query, values) {
				const rows = await raw.unsafe(query, values);
				count(rows);
				return rows;
			},
			transaction(callback) {
				return raw.transaction(async transaction =>
					callback({ unsafe: (query, values) => transaction.unsafe(query, values) }),
				);
			},
		};
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter(path);
		await writer.append("tail\n");
		await writer.close();
		const expected = Buffer.from(`${legacy}tail\n`);

		for (const offset of [0, 1, 100_000, Buffer.byteLength(legacy) - 1]) {
			fetched = 0;
			const read = Buffer.concat(await Array.fromAsync(storage.readChunks(path, offset)));
			expect({ offset, equal: read.equals(expected.subarray(offset)), fetched }).toEqual({
				offset,
				equal: true,
				fetched: expected.length - offset,
			});
		}
		await raw.end();
	});

	/**
	 * Seeds `path` through one storage, takes the first chunk of its read,
	 * replaces the session with `replacement` through a second storage on the
	 * same database, and expects the rest of the read to fail.
	 */
	async function expectReadToFailWhenReplaced(
		path: string,
		seed: (reader: SqlSessionStorage) => Promise<void>,
		replacement: string,
	): Promise<void> {
		const client = new SQL("sqlite::memory:");
		const reader = await SqlSessionStorage.create({ client });
		const rewriter = await SqlSessionStorage.create({ client });
		await seed(reader);

		const chunks = reader.readChunks(path)[Symbol.asyncIterator]();
		expect((await chunks.next()).done).toBe(false);
		await rewriter.writeText(path, replacement);
		const rest = (async () => {
			let chunk = await chunks.next();
			while (!chunk.done) chunk = await chunks.next();
		})();
		await expect(rest).rejects.toBeInstanceOf(SessionReadConflictError);
		await client.end();
	}

	it("readChunks fails rather than mix two bodies when a full write replaces the session between pages", async () => {
		const path = "/sessions/p/replaced.jsonl";
		await expectReadToFailWhenReplaced(
			path,
			async reader => {
				const writer = reader.openWriter(path);
				// Parts of 2 MiB: the first page, which spans 1 MiB, holds only the first.
				for (let n = 0; n < 3; n++) await writer.append(`${n}:${"x".repeat(2 * MiB - 3)}\n`);
				await writer.close();
			},
			'{"n":"replaced"}\n',
		);
	});

	// SQLite gives the next insert one more than the largest rowid left, so a
	// full write that deleted the table's last parts would hand their rowids to
	// its own parts, and a reader checking the part it started at by rowid
	// would take the new body's parts for the old one's.
	it("readChunks fails rather than mix two bodies of one size when a full write replaces the table's last parts", async () => {
		const path = "/sessions/p/same-size.jsonl";
		// Three parts of 1 MiB: the first page, which spans 1 MiB, holds only the first.
		const body = (fill: string): string => `${fill.repeat(3 * MiB - 1)}\n`;
		await expectReadToFailWhenReplaced(path, reader => reader.writeText(path, body("a")), body("b"));
	});

	// The windowed readers (RPC subagent reads, the Agent Hub viewer) read
	// through readTextFrom and read on from where its text ends; a size short
	// of that end reads as a rewrite to a shorter transcript and starts over.
	it("readTextFrom reads a titled session shorter than its title slot as readText reads it", async () => {
		const { client, storage } = await createSqlite();
		const path = "/sessions/p/short-titled.jsonl";
		await storage.writeText(path, "short header\n");
		await storage.updateSessionTitle(path, { title: "Renamed", source: "user", updatedAt: "t1" });
		const text = Buffer.from(await storage.readText(path), "utf-8");
		// From the start whole, a capped window inside the slot, and from where the slot ends.
		for (const [offset, maxBytes] of [
			[0, undefined],
			[5, 100],
			[text.length, undefined],
		] as const) {
			const end = maxBytes === undefined ? undefined : offset + maxBytes;
			expect({ offset, read: await storage.readTextFrom(path, offset, maxBytes) }).toEqual({
				offset,
				read: { text: text.subarray(offset, end).toString("utf-8"), size: text.length },
			});
		}
		await client.end();
	});

	it("copies a transcript of many parts with an append per MiB, not one per part", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const from = "/sessions/p/source/Child.jsonl";
		const to = "/sessions/p/copy/Child.jsonl";
		const lines = Array.from({ length: 3000 }, (_, n) => `${JSON.stringify({ n, pad: "x".repeat(1000) })}\n`);
		const writer = storage.openWriter(from);
		for (const line of lines) await writer.append(line);
		await writer.close();

		expect(await copyTranscriptTree(storage, "/sessions/p/source", "/sessions/p/copy")).toEqual([{ from, to }]);
		const body = lines.join("");
		expect(await readStoredSession(client, "omp_session_files", to)).toBe(body);
		// Each append stores one part.
		expect((await readStoredParts(client, "omp_session_files", to)).length).toBeLessThanOrEqual(
			Math.ceil(Buffer.byteLength(body) / MiB),
		);
		await client.end();
	});

	it("persists title updates as indexed fields across storage reloads", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await SqlSessionStorage.create({ client });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		await client.end();
	});

	it("readTextSlices uses bounded SQL byte substrings instead of a full content select", async () => {
		const sqlite = new SQL("sqlite::memory:");
		const { client, queries } = recordQueries(sqlite);
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		queries.length = 0;
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("substr(cast(content AS blob)");
		expect(queries[0]).not.toMatch(/SELECT\s+content\s+AS\s+content/i);
		await sqlite.end();
	});

	it("warms the index and takes a slice in as many queries at 10,000 parts as at 10", async () => {
		const counts: Array<{ warm: number; slice: number }> = [];
		for (const partCount of [10, 10_000]) {
			const sqlite = new SQL("sqlite::memory:");
			const seeded = await SqlSessionStorage.create({ client: sqlite });
			const writer = seeded.openWriter("/sessions/p/long.jsonl");
			for (let part = 0; part < partCount; part++) await writer.append(`{"n":${part},"s":"😀"}\n`);
			await writer.close();

			const { client, queries } = recordQueries(sqlite);
			const storage = await SqlSessionStorage.create({ client });
			const warm = queries.length;
			const [head, tail] = await storage.readTextSlices("/sessions/p/long.jsonl", 4096, 4096);
			expect(head.startsWith('{"n":0,"s":"😀"}\n{"n":1,')).toBe(true);
			expect(tail.endsWith(`{"n":${partCount - 2},"s":"😀"}\n{"n":${partCount - 1},"s":"😀"}\n`)).toBe(true);
			counts.push({ warm, slice: queries.length - warm });
			await sqlite.end();
		}
		expect(counts[1]).toEqual(counts[0]);
	});

	it("custom table name is honored", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		await storage.writeText("/sessions/p/x.jsonl", "hello\n");
		expect(await readStoredSessions(client, "agent_sessions")).toEqual([
			{ path: "/sessions/p/x.jsonl", content: "hello\n" },
		]);
		await client.end();
	});

	it("rejects table names that aren't safe identifiers", async () => {
		const client = new SQL("sqlite::memory:");
		await expect(SqlSessionStorage.create({ client, table: "drop table users; --" })).rejects.toThrow(
			/table name must match/,
		);
		await client.end();
	});

	it("refuses table names too long to leave room for the _parts table", async () => {
		const client = new SQL("sqlite::memory:");
		await expect(SqlSessionStorage.create({ client, table: "t".repeat(58) })).rejects.toThrow(
			/table name must match/,
		);
		const storage = await SqlSessionStorage.create({ client, table: "t".repeat(57) });
		await storage.writeText("/s/x.jsonl", "ok\n");
		expect(await readStoredSession(client, "t".repeat(57), "/s/x.jsonl")).toBe("ok\n");
		await client.end();
	});

	it("LIKE special chars in artifact paths don't blow up the prefix sweep", async () => {
		const { client, storage } = await createSqlite();
		// Path containing `%`, `_`, and the escape char `#`.
		await storage.writeText("/sessions/p/odd%_#name.jsonl", "session\n");
		await storage.writeText("/sessions/p/odd%_#name/draft.txt", "sidecar");
		await storage.writeText("/sessions/p/sibling.jsonl", "untouched");

		await storage.deleteSessionWithArtifacts("/sessions/p/odd%_#name.jsonl");
		expect(storage.existsSync("/sessions/p/odd%_#name.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/odd%_#name/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/sibling.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files`)) as Array<{ path: string }>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/sibling.jsonl"]);
		await client.end();
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const { client, storage } = await createSqlite();
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("createTable: false skips the DDL (consumer manages migrations)", async () => {
		const client = new SQL("sqlite::memory:");
		// Pre-create the tables with the documented schema.
		for (const ddl of SQLITE_SCHEMA) await client.unsafe(ddl);
		const storage = await SqlSessionStorage.create({ client, createTable: false });
		await storage.writeText("/s/x.jsonl", "ok");
		expect(await storage.readText("/s/x.jsonl")).toBe("ok");
		await client.end();
	});
});

describe("SqlSessionStorage (SQLite concurrency)", () => {
	it("appends to two sessions at once on one store", async () => {
		const { client, storage } = await createSqlite();
		const first = storage.openWriter("/sessions/p/first.jsonl");
		const second = storage.openWriter("/sessions/p/second.jsonl");
		const lines = Array.from({ length: 20 }, (_, n) => `line ${n} 😀\n`);

		await Promise.all(lines.flatMap(line => [first.append(line), second.append(line)]));
		await first.close();
		await second.close();

		expect(await readStoredSessions(client, "omp_session_files")).toEqual([
			{ path: "/sessions/p/first.jsonl", content: lines.join("") },
			{ path: "/sessions/p/second.jsonl", content: lines.join("") },
		]);
		await client.end();
	});

	it("keeps a title update that races a create-if-missing which conflicts and rolls back", async () => {
		const client = new SQL("sqlite::memory:");
		// `stale` loads before the sessions below exist, so each of its creates conflicts.
		const stale = await SqlSessionStorage.create({ client });
		const storage = await SqlSessionStorage.create({ client });
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		const titled = `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`;
		const sessions = Array.from({ length: 10 }, (_, n) => n);
		for (const n of sessions) {
			await storage.writeText(`/sessions/p/titled-${n}.jsonl`, titled);
			await storage.writeText(`/sessions/p/taken-${n}.jsonl`, "taken\n");
		}

		const creates = sessions.map(n =>
			stale.writeTextAtomic(`/sessions/p/taken-${n}.jsonl`, "late\n", { expectedSize: null }).then(
				() => null,
				(error: unknown) => error,
			),
		);
		const titles = sessions.map(n =>
			storage.updateSessionTitle(`/sessions/p/titled-${n}.jsonl`, {
				title: `New ${n}`,
				source: "user",
				updatedAt: "t2",
			}),
		);
		await Promise.all(titles);
		for (const failure of await Promise.all(creates)) expect(failure).toBeInstanceOf(SessionWriteConflictError);

		const reloaded = await SqlSessionStorage.create({ client });
		for (const n of sessions) {
			const titleLine = (await reloaded.readText(`/sessions/p/titled-${n}.jsonl`)).split("\n")[0];
			expect(JSON.parse(titleLine)).toMatchObject({ type: "title", title: `New ${n}`, source: "user" });
			expect(await reloaded.readText(`/sessions/p/taken-${n}.jsonl`)).toBe("taken\n");
		}
		await client.end();
	});

	it("lets clients of one file in one process take turns without waiting out the busy timeout", async () => {
		using dir = TempDir.createSync("@omp-sql-session-sqlite-clients-");
		const file = dir.join("sessions.sqlite");
		const replacerClient = new SQL(`sqlite:${file}`);
		const appenderClient = new SQL(`sqlite:${file}`);
		const replacer = await SqlSessionStorage.create({ client: replacerClient });
		// A wrapper around the second client still shares the file's turn.
		const appender = await SqlSessionStorage.create({ client: recordQueries(appenderClient).client });
		// The store set its busy timeout, so a collision here would block the thread for 5 s.
		const [busy] = (await replacerClient.unsafe("PRAGMA busy_timeout")) as Array<{ timeout: number }>;
		expect(busy?.timeout).toBe(5000);
		await replacer.writeText("/sessions/p/replaced.jsonl", "r0\n");
		const lines: string[] = [];
		let slowest = 0;

		for (let trial = 1; trial <= 20; trial++) {
			const body = `r${trial} ${"😀".repeat(trial)}\n`;
			const line = `a${trial}\n`;
			const writer = appender.openWriter("/sessions/p/appended.jsonl");
			const started = performance.now();
			await Promise.all([
				replacer.writeTextAtomic("/sessions/p/replaced.jsonl", body, {
					expectedSize: replacer.statSync("/sessions/p/replaced.jsonl").size,
				}),
				writer.append(line),
			]);
			await writer.close();
			slowest = Math.max(slowest, performance.now() - started);
			lines.push(line);
			expect(await readStoredSession(replacerClient, "omp_session_files", "/sessions/p/replaced.jsonl")).toBe(body);
		}

		expect(slowest).toBeLessThan(1000);
		expect(await readStoredSession(replacerClient, "omp_session_files", "/sessions/p/appended.jsonl")).toBe(
			lines.join(""),
		);
		await replacerClient.end();
		await appenderClient.end();
	});

	it("waits for another process's write lock on the same SQLite file instead of failing", async () => {
		using dir = TempDir.createSync("@omp-sql-session-sqlite-processes-");
		const url = `sqlite:${dir.join("sessions.sqlite")}`;
		const client = new SQL(url);
		const storage = await SqlSessionStorage.create({ client });
		// A real delay: SQLite's busy timeout waits on the wall clock, and while
		// it waits this process's only thread is blocked, so it cannot tell the
		// lock holder when to let go.
		const holdMs = 1000;
		const script = dir.join("lock-holder.ts");
		await Bun.write(
			script,
			[
				'import { SQL } from "bun";',
				"const client = new SQL(process.argv[2]);",
				'await client.unsafe("BEGIN IMMEDIATE");',
				"await client.unsafe(\"INSERT INTO omp_session_files (path, content, mtime_ms, byte_len) VALUES ('/sessions/p/other.jsonl', 'other\\n', 1, 6)\");",
				'process.stdout.write("locked\\n");',
				"await Bun.sleep(Number(process.argv[3]));",
				'await client.unsafe("COMMIT");',
				"await client.end();",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, url, String(holdMs)], { stdout: "pipe", stderr: "pipe" });
		const { value } = await child.stdout.getReader().read();
		expect(new TextDecoder().decode(value)).toBe("locked\n");

		const started = performance.now();
		const writer = storage.openWriter("/sessions/p/mine.jsonl");
		await writer.append("mine\n");
		await writer.close();
		// The append ran only once the other process committed.
		expect(performance.now() - started).toBeGreaterThan(holdMs / 2);
		expect({ exitCode: await child.exited, stderr: await new Response(child.stderr).text() }).toEqual({
			exitCode: 0,
			stderr: "",
		});

		await storage.refresh();
		expect(await storage.readText("/sessions/p/mine.jsonl")).toBe("mine\n");
		expect(await storage.readText("/sessions/p/other.jsonl")).toBe("other\n");
		await client.end();
	});
});

// ---------------------------------------------------------------------------
// Dialect-specific statement coverage without a server: a stub client
// captures the rendered SQL and bound values, catching dialect-specific
// regressions in the query builder on every run. (Live PostgreSQL/MySQL
// coverage is env-gated in sql-session-storage-dialects.test.ts.)
// ---------------------------------------------------------------------------

interface CapturedQuery {
	sql: string;
	values: unknown[] | undefined;
}

function capturingClient(adapter: "postgres" | "mysql"): {
	client: SqlSessionStorageClient;
	queries: CapturedQuery[];
} {
	const queries: CapturedQuery[] = [];
	const client: SqlSessionStorageClient = {
		options: { adapter },
		async unsafe(sql, values) {
			queries.push({ sql, values });
			return [];
		},
		async transaction(callback) {
			return callback(client);
		},
	};
	return { client, queries };
}

describe("SqlSessionStorage (dialect-specific SQL)", () => {
	it("PostgreSQL binds numbered placeholders and appends a part in one statement", async () => {
		const { client, queries } = capturingClient("postgres");
		const storage = await SqlSessionStorage.create({ client });

		const tables = queries.filter(q => q.sql.startsWith("CREATE TABLE"));
		expect(tables).toHaveLength(2);
		expect(tables[0]?.sql).toContain("omp_session_files (path TEXT PRIMARY KEY");
		expect(tables[0]?.sql).toContain("mtime_ms BIGINT");
		expect(tables[0]?.sql).toContain("byte_len BIGINT");
		expect(tables[1]?.sql).toContain("omp_session_files_parts (path TEXT NOT NULL, start_offset BIGINT NOT NULL");
		expect(tables[1]?.sql).toContain("PRIMARY KEY (path, start_offset)");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("byte_len");
		expect(loadIndex?.sql).not.toMatch(/\bcontent\b/);

		const appendStart = queries.length;
		const writer = storage.openWriter("/s/p.jsonl");
		await writer.append("chunk\n");
		await writer.close();
		// The append binds only the appended line and never concatenates onto stored content.
		const appended = queries.slice(appendStart);
		expect(appended).toHaveLength(1);
		expect(appended[0]?.sql).toContain("INSERT INTO omp_session_files_parts");
		expect(appended[0]?.sql).not.toContain("||");
		expect(appended[0]?.values).toEqual(["/s/p.jsonl", expect.any(Number), 6, "chunk\n"]);

		for (const query of queries) {
			const numbers = [...query.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
			expect(numbers.length === 0 ? 0 : Math.max(...numbers)).toBe(query.values?.length ?? 0);
			expect(query.sql).not.toContain("?");
		}
		expect(storage.adapter).toBe("postgres");
	});

	it("MySQL binds one value per `?` and no `VALUES(col)` in upserts", async () => {
		const { client, queries } = capturingClient("mysql");
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/replace.jsonl", "body\n");
		const writer = storage.openWriter("/s/m.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const tables = queries.filter(q => q.sql.startsWith("CREATE TABLE"));
		expect(tables).toHaveLength(2);
		for (const table of tables) {
			expect(table.sql).toContain("path VARCHAR(512) NOT NULL");
			expect(table.sql).toContain("LONGTEXT");
			expect(table.sql).toContain("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin");
		}
		expect(tables[1]?.sql).toContain("PRIMARY KEY (path, start_offset)");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("byte_len");
		expect(loadIndex?.sql).not.toMatch(/\bcontent\b/);

		const upserts = queries.filter(q => q.sql.includes("ON DUPLICATE KEY UPDATE"));
		expect(upserts).toHaveLength(2);
		expect(upserts.every(query => !/VALUES\(\w+\)/i.test(query.sql))).toBe(true);
		const replace = upserts.find(q => q.sql.includes("title_updated_at"));
		expect(replace?.values).toEqual([
			"/s/replace.jsonl",
			expect.any(Number),
			null,
			null,
			null,
			5,
			expect.any(Number),
			null,
			null,
			null,
			5,
		]);

		const parts = queries.filter(q => q.sql.startsWith("INSERT INTO omp_session_files_parts"));
		expect(parts.map(q => q.values)).toEqual([
			["/s/replace.jsonl", 0, "body\n"],
			[6, "chunk\n", "/s/m.jsonl", 6],
		]);

		for (const query of queries) {
			expect(query.sql.split("?").length - 1).toBe(query.values?.length ?? 0);
			expect(query.sql).not.toContain("$1");
		}
		expect(storage.adapter).toBe("mysql");
	});

	it("rejects clients reporting an unknown adapter without an override", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "weirdb" },
			async unsafe() {
				return [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		await expect(SqlSessionStorage.create({ client })).rejects.toThrow(/unable to infer adapter/);
	});

	it("explicit `adapter` option overrides the reported adapter", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "" }, // empty / missing
			async unsafe() {
				return [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		const storage = await SqlSessionStorage.create({ client, adapter: "postgres" });
		expect(storage.adapter).toBe("postgres");
	});
});
