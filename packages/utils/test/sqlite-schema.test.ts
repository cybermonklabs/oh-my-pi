import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { getDbBusyTimeoutMs, setInteractiveHost } from "../src/env";
import { initializeSqliteSchema, isSqliteBusyError, openSqliteDatabase, openSqliteDatabaseSync } from "../src/sqlite";
import { TempDir } from "../src/temp";

const SCHEMA = "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value TEXT)";

function createStore(dbPath: string, journalMode = "WAL"): void {
	const db = new Database(dbPath);
	db.run(`PRAGMA journal_mode=${journalMode}`);
	db.run(SCHEMA);
	db.close();
}

/** A second connection that holds the write lock, as another omp process mid-transaction does. */
function holdWriteLock(dbPath: string): Database {
	const holder = new Database(dbPath);
	holder.run("BEGIN IMMEDIATE");
	return holder;
}

/**
 * Another process that holds the write lock for `ms`, then commits. Resolves once it holds it. It takes
 * the lock kind every omp process takes (the SQLite lock shim, #15586): with POSIX locks in the holder,
 * an open under gVisor waits out the whole hold and then succeeds instead of reporting the lock.
 */
async function holdWriteLockInChild(
	dbPath: string,
	ms: number,
	begin = "BEGIN IMMEDIATE",
): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
	const script = `
		const { Database } = require("bun:sqlite");
		import(${JSON.stringify(`${import.meta.dir}/../src/sqlite.ts`)}).then(({ ensureSqliteLockShim }) => {
			ensureSqliteLockShim();
			const db = new Database(${JSON.stringify(dbPath)});
			db.run(${JSON.stringify(begin)});
			db.run("INSERT INTO entries (value) VALUES ('peer')");
			console.log("held");
			setTimeout(() => { db.run("COMMIT"); db.close(); }, ${ms});
		});
	`;
	const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
	const { value } = await child.stdout.getReader().read();
	expect(new TextDecoder().decode(value)).toContain("held");
	return child;
}

describe("initializeSqliteSchema", () => {
	test("a current schema initializes while another connection holds the write lock", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-current-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const holder = holdWriteLock(dbPath);
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA busy_timeout = 0");
			let runs = 0;
			initializeSqliteSchema(db, () => {
				runs++;
				db.run(SCHEMA);
			});
			expect(runs).toBe(1);
			// The connection is writable again once the peer commits.
			holder.run("COMMIT");
			db.run("INSERT INTO entries (value) VALUES ('after')");
		} finally {
			db.close();
			holder.close();
		}
	});

	test("a schema that needs a write waits for the write lock, then applies it in one transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-migrate-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const apply = (db: Database) => () => {
			db.run(SCHEMA);
			db.run("CREATE TABLE IF NOT EXISTS added (id INTEGER PRIMARY KEY)");
			if (db.query("SELECT 1 FROM added WHERE id = 1").get() === null) db.run("INSERT INTO added (id) VALUES (1)");
		};
		const holder = holdWriteLock(dbPath);
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA busy_timeout = 0");
			expect(() => initializeSqliteSchema(db, apply(db))).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
			expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'added'").get()).toBeNull();
			holder.run("COMMIT");
			initializeSqliteSchema(db, apply(db));
			expect(db.query("SELECT id FROM added").all()).toEqual([{ id: 1 }]);
			// Now current: initializes again under a held write lock.
			holder.run("BEGIN IMMEDIATE");
			initializeSqliteSchema(db, apply(db));
			holder.run("COMMIT");
		} finally {
			db.close();
			holder.close();
		}
	});

	test("other errors propagate and leave the connection writable", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-error-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const db = new Database(dbPath);
		try {
			expect(() =>
				initializeSqliteSchema(db, () => {
					throw new Error("broken initializer");
				}),
			).toThrow("broken initializer");
			expect(db.inTransaction).toBe(false);
			db.run("INSERT INTO entries (value) VALUES ('writable')");
		} finally {
			db.close();
		}
	});

	test("inside a caller's transaction, the schema is applied in that transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-nested-");
		const dbPath = dir.join("store.db");
		const db = new Database(dbPath);
		try {
			db.run("BEGIN IMMEDIATE");
			initializeSqliteSchema(db, () => db.run(SCHEMA));
			expect(db.inTransaction).toBe(true);
			db.run("ROLLBACK");
			expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'entries'").get()).toBeNull();
		} finally {
			db.close();
		}
	});
});

describe("open BUSY budget", () => {
	// A peer that holds the write lock for 6 s outlasts the former budget of four attempts
	// (1 s busy handler each plus 100/200/400 ms sleeps, ~4.7 s) that failed headless starts.
	// Real time on purpose: SQLite's busy handler and the peer's lock are wall-clock, in another process.
	const HOLD_MS = 6_000;

	test("openSqliteDatabase waits out a peer's long write transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-busy-async-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const peer = await holdWriteLockInChild(dbPath, HOLD_MS);
		const rows = await openSqliteDatabase(dbPath, db => {
			try {
				db.run("INSERT INTO entries (value) VALUES ('mine')");
				return db.query<{ value: string }, []>("SELECT value FROM entries ORDER BY id").all();
			} finally {
				db.close();
			}
		});
		expect(rows).toEqual([{ value: "peer" }, { value: "mine" }]);
		await peer.exited;
	}, 30_000);

	// SQLite's busy handler sleeps the calling thread. On an interactive host each attempt's handler
	// used the 5 s store timeout, so waiting out a peer froze the event loop in 5 s stretches. The peer
	// holds an exclusive lock on a rollback-journal store, so the opener's read waits in the busy handler.
	test("openSqliteDatabase keeps its event loop running while it waits out a peer", async () => {
		await using dir = await TempDir.create("@omp-sqlite-busy-loop-");
		const dbPath = dir.join("store.db");
		createStore(dbPath, "DELETE");
		const wasInteractive = setInteractiveHost(true);
		try {
			const peer = await holdWriteLockInChild(dbPath, 3_000, "BEGIN EXCLUSIVE");
			let last = performance.now();
			let longestStall = 0;
			const beat = setInterval(() => {
				const now = performance.now();
				longestStall = Math.max(longestStall, now - last);
				last = now;
			}, 5);
			try {
				const rows = await openSqliteDatabase(dbPath, db => {
					try {
						return db.query<{ value: string }, []>("SELECT value FROM entries ORDER BY id").all();
					} finally {
						db.close();
					}
				});
				// An open that blocked until it succeeded resolves before the next tick: measure that stretch too.
				longestStall = Math.max(longestStall, performance.now() - last);
				expect(rows).toEqual([{ value: "peer" }]);
			} finally {
				clearInterval(beat);
			}
			expect(longestStall).toBeLessThan(1_000);
			await peer.exited;
		} finally {
			setInteractiveHost(wasInteractive);
		}
	}, 30_000);

	test("a successful openSqliteDatabase gives the connection the store's busy timeout", async () => {
		await using dir = await TempDir.create("@omp-sqlite-busy-restore-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const timeoutOf = (db: Database) => db.query("PRAGMA busy_timeout").values()[0]?.[0];
		const plain = await openSqliteDatabase(dbPath, db => db);
		try {
			expect(timeoutOf(plain)).toBe(getDbBusyTimeoutMs());
		} finally {
			plain.close();
		}
		const chosen = await openSqliteDatabase(dbPath, db => db, { busyTimeoutMs: 4_321 });
		try {
			expect(timeoutOf(chosen)).toBe(4_321);
		} finally {
			chosen.close();
		}
	});

	// The synchronous opener runs on its caller's thread (the TUI's event loop for the caches that use
	// it), so it does not sleep out a peer's lock: it fails after the connection's busy timeout and its
	// caller falls back.
	test("openSqliteDatabaseSync fails a peer's long write transaction without waiting it out", async () => {
		await using dir = await TempDir.create("@omp-sqlite-busy-sync-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const peer = await holdWriteLockInChild(dbPath, HOLD_MS);
		const start = performance.now();
		let opened: Database | undefined;
		let error: unknown;
		try {
			opened = openSqliteDatabaseSync(dbPath, db => {
				db.run("INSERT INTO entries (value) VALUES ('mine')");
				return db;
			});
		} catch (caught) {
			error = caught;
		}
		const waited = performance.now() - start;
		opened?.close();
		expect(String(error)).toContain("database is locked");
		expect(isSqliteBusyError(error)).toBe(true);
		expect(waited).toBeLessThan(HOLD_MS / 2);
		await peer.exited;
	}, 30_000);

	test("an attempt whose busy_timeout PRAGMA fails closes its connection", async () => {
		await using dir = await TempDir.create("@omp-sqlite-pragma-fail-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const run = Database.prototype.run;
		const close = Database.prototype.close;
		let failed = 0;
		let closed = 0;
		const runSpy = spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof run>
		) {
			if (String(args[0]).startsWith("PRAGMA busy_timeout")) {
				failed++;
				throw new Error("planted busy_timeout failure");
			}
			return run.apply(this, args);
		});
		const closeSpy = spyOn(Database.prototype, "close").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof close>
		) {
			closed++;
			return close.apply(this, args);
		});
		try {
			await expect(openSqliteDatabase(dbPath, db => db)).rejects.toThrow("planted busy_timeout failure");
			expect(() => openSqliteDatabaseSync(dbPath, db => db)).toThrow("planted busy_timeout failure");
		} finally {
			runSpy.mockRestore();
			closeSpy.mockRestore();
		}
		expect(failed).toBe(2);
		expect(closed).toBe(2);
	});
});
