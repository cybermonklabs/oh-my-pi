/**
 * {@link SqlSessionStorage} writes to PostgreSQL over a connection whose
 * session default is `default_transaction_read_only = on`, as a pooled
 * connection can carry from another client's session-level `SET`. PostgreSQL
 * refuses a plain write there (SQLSTATE 25006, "cannot execute INSERT in a
 * read-only transaction"); each test shows that refusal on the store's own
 * connection, makes one kind of store write on it, reads the write back
 * through the store and through a second client, and checks the connection's
 * default is still read-only. Runs only when `OMP_TEST_SQL_POSTGRES_URL`
 * names a throwaway database. Every test uses its own tables and drops them
 * when done.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readStoredParts, readStoredSession } from "../helpers/sql-session-storage";

const url = process.env.OMP_TEST_SQL_POSTGRES_URL;

/** The session table's columns, by name, as `create()` leaves them. */
const SESSION_COLUMNS = ["byte_len", "content", "mtime_ms", "path", "title", "title_source", "title_updated_at"];

let tableSeq = 0;

/** One test's database: its table names and its two clients. */
interface Db {
	/**
	 * The store's client: one connection, kept open, so a session-level `SET`
	 * on it governs every statement the store runs.
	 */
	client: SQL;
	/** A second client, on sessions that keep the server's default; it makes, reads and drops the tables. */
	other: SQL;
	table: string;
	/** A one-column table the store never touches, for the plain `INSERT` PostgreSQL refuses. */
	scratch: string;
}

let current: Db | undefined;

afterEach(async () => {
	const db = current;
	current = undefined;
	if (!db) return;
	try {
		for (const name of [`${db.table}_parts`, db.table, db.scratch]) {
			await db.other.unsafe(`DROP TABLE IF EXISTS ${name}`);
		}
	} finally {
		await db.client.end();
		await db.other.end();
	}
});

async function connect(): Promise<Db> {
	const table = `omp_rw_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	const db: Db = {
		client: new SQL(url!, { max: 1, idleTimeout: 0 }),
		other: new SQL(url!),
		table,
		scratch: `${table}_scratch`,
	};
	current = db;
	await db.other.unsafe(`CREATE TABLE ${db.scratch} (n integer)`);
	return db;
}

function open(db: Db): Promise<SqlSessionStorage> {
	return SqlSessionStorage.create({ client: db.client, table: db.table });
}

/** The store's connection's default for new transactions: `on` while they start read-only. */
async function readOnlyDefault(db: Db): Promise<string | undefined> {
	const rows = (await db.client.unsafe("SHOW default_transaction_read_only")) as Array<{
		default_transaction_read_only: string;
	}>;
	return rows[0]?.default_transaction_read_only;
}

/**
 * Make every transaction on the store's connection start read-only, for that
 * session alone, and show PostgreSQL now refuses a plain write there.
 */
async function setReadOnly(db: Db): Promise<void> {
	await db.client.unsafe("SET default_transaction_read_only = on");
	expect(await readOnlyDefault(db)).toBe("on");
	await expect(db.client.unsafe(`INSERT INTO ${db.scratch} (n) VALUES (1)`)).rejects.toMatchObject({
		errno: "25006",
	});
}

/** A store made while the default is still read-write, holding `sessions`; then the default turns read-only. */
async function readOnlyStore(sessions: Record<string, string> = {}): Promise<{ db: Db; storage: SqlSessionStorage }> {
	const db = await connect();
	const storage = await open(db);
	for (const [path, content] of Object.entries(sessions)) await storage.writeText(path, content);
	await setReadOnly(db);
	return { db, storage };
}

/** A session's content as the second client reads it; `null` when no row exists. */
function stored(db: Db, path: string): Promise<string | null> {
	return readStoredSession(db.other, db.table, path, "postgres");
}

/** The parts the second client finds for `path`. */
function storedParts(db: Db, path: string): Promise<string[]> {
	return readStoredParts(db.other, db.table, path, "postgres");
}

/** `table`'s column names, sorted, as the second client sees them; none when it does not exist. */
async function columns(db: Db, table: string): Promise<string[]> {
	const rows = (await db.other.unsafe(
		"SELECT column_name FROM information_schema.columns " +
			"WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name",
		[table],
	)) as Array<{ column_name: string }>;
	return rows.map(row => row.column_name);
}

describe.skipIf(!url)("SqlSessionStorage on a PostgreSQL connection whose transactions default to read-only", () => {
	it("starts again on tables that exist", async () => {
		const path = "/sessions/p/kept.jsonl";
		const { db } = await readOnlyStore({ [path]: "kept\n" });

		const storage = await open(db);

		expect(await storage.readText(path)).toBe("kept\n");
		expect(await stored(db, path)).toBe("kept\n");
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("creates its tables", async () => {
		const db = await connect();
		await setReadOnly(db);

		const storage = await open(db);

		expect(await columns(db, db.table)).toEqual(SESSION_COLUMNS);
		expect(await columns(db, `${db.table}_parts`)).toEqual(["content", "path", "start_offset"]);
		const path = "/sessions/p/new.jsonl";
		await storage.writeText(path, "new\n");
		expect(await storage.readText(path)).toBe("new\n");
		expect(await stored(db, path)).toBe("new\n");
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("migrates a session table from before titles and parts", async () => {
		const db = await connect();
		const path = "/sessions/p/old.jsonl";
		const content = "old ✓\n";
		await db.other.unsafe(
			`CREATE TABLE ${db.table} (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms BIGINT NOT NULL)`,
		);
		await db.other.unsafe(`INSERT INTO ${db.table} (path, content, mtime_ms) VALUES ($1, $2, 1)`, [path, content]);
		await setReadOnly(db);

		const storage = await open(db);

		expect(await storage.readText(path)).toBe(content);
		expect(storage.statSync(path).size).toBe(Buffer.byteLength(content));
		expect(await columns(db, db.table)).toEqual(SESSION_COLUMNS);
		const rows = (await db.other.unsafe(`SELECT byte_len FROM ${db.table} WHERE path = $1`, [path])) as Array<{
			byte_len: number | bigint | string;
		}>;
		expect(Number(rows[0]?.byte_len)).toBe(Buffer.byteLength(content));
		expect(await stored(db, path)).toBe(content);
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("appends through a writer", async () => {
		const { db, storage } = await readOnlyStore();
		const path = "/sessions/p/appended.jsonl";

		const writer = storage.openWriter(path);
		await writer.append("one\n");
		await writer.append("two ✓\n");
		await writer.close();

		expect(await storage.readText(path)).toBe("one\ntwo ✓\n");
		expect(await stored(db, path)).toBe("one\ntwo ✓\n");
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("writes a session whole", async () => {
		const { db, storage } = await readOnlyStore();
		const path = "/sessions/p/written.jsonl";

		await storage.writeText(path, "whole ✓\n");

		expect(await storage.readText(path)).toBe("whole ✓\n");
		expect(await stored(db, path)).toBe("whole ✓\n");
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("creates a session and replaces it at its size", async () => {
		const { db, storage } = await readOnlyStore();
		const path = "/sessions/p/atomic.jsonl";

		await storage.writeTextAtomic(path, "first\n", { expectedSize: null });
		expect(await stored(db, path)).toBe("first\n");
		await storage.writeTextAtomic(path, "second ✓\n", { expectedSize: storage.statSync(path).size });

		expect(await storage.readText(path)).toBe("second ✓\n");
		expect(await stored(db, path)).toBe("second ✓\n");
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("truncates a session through a writer opened with flags w", async () => {
		const path = "/sessions/p/truncated.jsonl";
		const { db, storage } = await readOnlyStore({ [path]: "old\nlines\n" });

		const writer = storage.openWriter(path, { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText(path)).toBe("fresh\n");
		expect(await stored(db, path)).toBe("fresh\n");
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("updates a session's title", async () => {
		const path = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		const { db, storage } = await readOnlyStore({
			[path]: `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		});

		await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

		await storage.refresh();
		expect(JSON.parse((await storage.readText(path)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		const rows = (await db.other.unsafe(
			`SELECT title, title_source, title_updated_at FROM ${db.table} WHERE path = $1`,
			[path],
		)) as Array<{ title: string; title_source: string; title_updated_at: string }>;
		expect(rows[0]).toEqual({ title: "New", title_source: "user", title_updated_at: "t2" });
		expect(await readOnlyDefault(db)).toBe("on");
	});

	// Two kinds of write: `rename` first deletes any row at `to`, `renameNoReplace` never does.
	for (const method of ["rename", "renameNoReplace"] as const) {
		it(`moves a session through ${method}`, async () => {
			const from = "/sessions/p/from.jsonl";
			const to = "/sessions/q/to.jsonl";
			const { db, storage } = await readOnlyStore({ [from]: "moved\n" });

			await storage[method](from, to);

			await storage.refresh();
			expect(storage.existsSync(from)).toBe(false);
			expect(await storage.readText(to)).toBe("moved\n");
			expect(await stored(db, from)).toBeNull();
			expect(await storedParts(db, from)).toEqual([]);
			expect(await stored(db, to)).toBe("moved\n");
			expect(await readOnlyDefault(db)).toBe("on");
		});
	}

	it("unlinks a session", async () => {
		const path = "/sessions/p/unlinked.jsonl";
		const { db, storage } = await readOnlyStore({ [path]: "gone\n" });

		await storage.unlink(path);

		await storage.refresh();
		expect(storage.existsSync(path)).toBe(false);
		expect(await stored(db, path)).toBeNull();
		expect(await storedParts(db, path)).toEqual([]);
		expect(await readOnlyDefault(db)).toBe("on");
	});

	it("deletes a session with its artifacts", async () => {
		// The delete also removes the artifacts directory from local disk.
		using dir = TempDir.createSync("@omp-sql-read-write-");
		const session = dir.join("s.jsonl");
		const artifact = dir.join("s", "x.jsonl");
		const { db, storage } = await readOnlyStore({ [session]: "session\n", [artifact]: "artifact\n" });

		await storage.deleteSessionWithArtifacts(session);

		await storage.refresh();
		for (const path of [session, artifact]) {
			expect(storage.existsSync(path)).toBe(false);
			expect(await stored(db, path)).toBeNull();
			expect(await storedParts(db, path)).toEqual([]);
		}
		expect(await readOnlyDefault(db)).toBe("on");
	});
});
