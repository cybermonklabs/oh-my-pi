/**
 * A picker's delete of a session it listed (`SessionManager.deleteListedSession`: the startup `--resume`
 * picker's and the in-session `/resume` picker's) while another client moves that session (`moveTo`). The mover
 * here is an SDK host's store: SQL storage built as `examples/sdk/13-sql-sessions.ts` builds it, which claims
 * nothing (`claims` is off by default), so no lease or write fence stands between it and the picker's claiming
 * store. The move renames the session's file, then each subagent transcript keyed under its artifacts directory.
 * A delete that finds the session still at its path before the move renames it waits for the session's row; once
 * the rename commits it must refuse, deleting nothing, instead of removing the subagent transcripts the move has
 * not reached. A delete once the file moved must refuse too, and a delete must refuse when the file at the path
 * no longer holds the listed session. SQLite and the file store always; PostgreSQL and MySQL (MariaDB) when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	LEASE_BACKENDS,
	LeaseProcess,
	type LeaseProcessConfig,
	openLeaseDb,
	transcript,
} from "./sql-session-lease-fixture";

// A mover process loads the whole module graph before it opens a session, which takes seconds on a loaded box.

/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

interface Backend extends AsyncDisposable {
	readonly name: string;
	/** The picker's store, in this process. */
	readonly picker: SessionStorage & { refresh?: () => Promise<void> };
	/** A store that claims nothing, for a test's own writes. */
	readonly writer: SessionStorage;
	/** How the mover process opens its store. */
	readonly config: LeaseProcessConfig;
	readonly dir: TempDir;
	/** Every session path the store holds, in order. */
	paths(): Promise<string[]>;
	/** How many transactions wait for a lock on the server (the row-lease servers only). */
	readonly lockWaits?: () => Promise<number>;
}

async function openBackend(adapter: string, url: string): Promise<Backend> {
	if (adapter === "file") {
		const dir = TempDir.createSync("@omp-picker-delete-file-");
		const storage = new FileSessionStorage();
		return {
			name: "file",
			picker: storage,
			writer: storage,
			config: { dsn: "", table: "", leaseTable: "", storage: "file" },
			dir,
			async paths() {
				const root = dir.join("sessions");
				if (!fs.existsSync(root)) return [];
				return (fs.readdirSync(root, { recursive: true }) as string[])
					.filter(name => name.endsWith(".jsonl"))
					.map(name => path.join(root, name))
					.sort();
			},
			async [Symbol.asyncDispose]() {
				dir.removeSync();
			},
		};
	}
	const db = await openLeaseDb(adapter as "sqlite" | "postgres" | "mysql", url);
	const count = async (query: string) => Number((await db.sql(query))[0]?.n ?? 0);
	return {
		name: adapter,
		picker: await db.open(),
		writer: await db.open({ claims: false }),
		// The mover claims nothing, as an SDK host's store does.
		config: { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL, claims: false },
		dir: db.dir,
		// Sorted here as the file store's are: PostgreSQL's collation orders `<stem>/A.jsonl` before `<stem>.jsonl`.
		paths: async () => (await db.paths()).sort(),
		lockWaits:
			adapter === "mysql"
				? () => count("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'")
				: adapter === "postgres"
					? () => count("SELECT COUNT(*) AS n FROM pg_locks WHERE NOT granted")
					: undefined,
		[Symbol.asyncDispose]: () => db[Symbol.asyncDispose](),
	};
}

/**
 * A session the mover creates and holds, with two subagent transcripts, listed by the picker (its view is the one
 * a picker deletes from), then its move started and paused.
 */
async function sessionBeingMoved(
	backend: Backend,
	mover: LeaseProcess,
	pause: "file" | "session",
): Promise<{ file: string; id: string }> {
	for (const dir of ["project", "moved"]) fs.mkdirSync(backend.dir.join(dir), { recursive: true });
	const created = await mover.run({
		op: "create",
		cwd: backend.dir.join("project"),
		sessionDir: backend.dir.join("sessions", "-project-"),
	});
	if (created.error || !created.sessionFile || !created.sessionId) throw new Error(`create: ${created.error}`);
	const children = await mover.run({ op: "children", names: ["A", "B"] });
	if (children.error) throw new Error(`children: ${children.error}`);
	await backend.picker.refresh?.();
	// The destination sorts after every row, so a delete whose lock scans the table (MySQL, MariaDB before 11.8.1)
	// has not locked the gap the move inserts into when it waits for the session's row.
	const moving = await mover.run({
		op: "move",
		cwd: backend.dir.join("moved"),
		sessionDir: backend.dir.join("sessions", "zz-moved"),
		pause,
	});
	if (moving.paused !== true) throw new Error(`the move did not pause: ${JSON.stringify(moving)}`);
	return { file: created.sessionFile, id: created.sessionId };
}

/** `"deleted"`, or `"refused: <message>"`. */
function outcome(deleting: Promise<void>): Promise<string> {
	return deleting.then(
		() => "deleted",
		(error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
	);
}

/** The session's file and both subagent transcripts at the moved path, and nothing left at the old one. */
function whole(movedFile: string): string[] {
	const stem = movedFile.slice(0, -".jsonl".length);
	return [movedFile, path.join(stem, "A.jsonl"), path.join(stem, "B.jsonl")].sort();
}

const BACKENDS: ReadonlyArray<{ adapter: string; url: string | undefined }> = [
	...LEASE_BACKENDS,
	{ adapter: "file", url: "file" },
];

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`a picker's delete of a listed ${adapter} session`, () => {
		// Before this change the delete was refused here too (the store's index no longer held the path), but as
		// ENOENT; it now names the session it was asked to delete. The race below is the one that split a session.
		it("refuses a session another client is moving, once the move carried its file and before its subagent transcripts, and the move keeps them all", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			await using mover = await LeaseProcess.start(backend.config, backend.dir.join("mover"));
			const { file, id } = await sessionBeingMoved(backend, mover, "file");
			const deleted = await outcome(SessionManager.deleteListedSession({ path: file, id }, backend.picker));
			const ended = await mover.run({ op: "moveGo" });
			expect({
				deleted,
				moveError: ended.error,
				paths: await backend.paths(),
			}).toEqual({
				deleted: `refused: Cannot delete session "${file}": the file no longer holds session ${id} (it moved or was deleted). Nothing was deleted.`,
				moveError: undefined,
				paths: whole(String(ended.sessionFile)),
			});
		}, 60_000);

		// On SQLite a delete cannot wait out a move's open transaction: it fails with SQLITE_BUSY ("database is
		// locked") and deletes nothing, before this fix as after it, so this race runs on the row-lock servers.
		it.skipIf(!["mysql", "postgres"].includes(adapter))(
			"refuses a session a client holding no claim is moving, while the move holds the session's file before renaming it (the reviewer's race), and the move keeps it whole",
			async () => {
				await using backend = await openBackend(adapter, url ?? "");
				await using mover = await LeaseProcess.start(backend.config, backend.dir.join("mover"));
				const { file, id } = await sessionBeingMoved(backend, mover, "session");
				const deleting = outcome(SessionManager.deleteListedSession({ path: file, id }, backend.picker));
				// The delete finds the session still at its path, then waits for the session's row, which the move
				// holds: let it reach that wait before the move goes on. The server's lock tables are read 150 ms
				// apart (they are refilled no faster), for at most 4 s; a refused delete settles first.
				const until = Date.now() + 4000;
				while (Date.now() < until) {
					if (await Promise.race([deleting.then(() => true), Bun.sleep(150).then(() => false)])) break;
					if (((await backend.lockWaits?.()) ?? 0) > 0) break;
				}
				const ended = await mover.run({ op: "moveGo" });
				const deleted = await deleting;
				expect({
					deleted,
					moveError: ended.error,
					paths: await backend.paths(),
				}).toEqual({
					deleted: `refused: Cannot delete session "${file}": the file no longer holds session ${id} (it moved or was deleted). Nothing was deleted.`,
					moveError: undefined,
					paths: whole(String(ended.sessionFile)),
				});
			},
			60_000,
		);

		it("refuses when the listed file now holds another session, and deletes nothing", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const listed = crypto.randomUUID();
			const other = crypto.randomUUID();
			const file = backend.dir.join("sessions", "-project-", "listed.jsonl");
			const child = path.join(file.slice(0, -".jsonl".length), "A.jsonl");
			backend.writer.ensureDirSync(path.dirname(child));
			await backend.writer.writeText(file, transcript(listed, "the listed session"));
			await backend.writer.writeText(child, transcript(crypto.randomUUID(), "its subagent"));
			// Another session takes the path.
			await backend.writer.writeText(file, transcript(other, "another session"));
			await backend.writer.drain();
			await backend.picker.refresh?.();

			const deleted = await outcome(SessionManager.deleteListedSession({ path: file, id: listed }, backend.picker));
			expect({ deleted, paths: await backend.paths() }).toEqual({
				deleted: `refused: Cannot delete session "${file}": the file no longer holds session ${listed} (it holds ${other}). Nothing was deleted.`,
				paths: [file, child].sort(),
			});
		}, 60_000);
	});
}
