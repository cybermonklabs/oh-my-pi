/**
 * `session.sql.offboxCheck`: under `session.storage: sql`, a configured
 * command decides per session whether it may go to the session database.
 * A session it refuses, its subagents, its forks, its title and its markers
 * stay in local files at the paths file storage uses, and nothing of it
 * reaches either table; listing, lookup and resume still find it, in this
 * process and the next. The check is a real program (`OffboxFixture`); the
 * configuration that installs this storage is covered in
 * `sql-offbox-check-config.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OffboxCheck } from "@oh-my-pi/pi-coding-agent/session/offbox-check";
import { OffboxSessionStorage } from "@oh-my-pi/pi-coding-agent/session/offbox-session-storage";
import {
	listAllSessions,
	listSessions,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	defersSyncPublishAt,
	isSessionLeaseHeld,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createSessionSqlClient } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
	sessionRowKey,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { converse, OffboxFixture } from "../helpers/offbox-check";

type SqlClient = InstanceType<typeof SQL>;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

/** A second omp process: takes the file lease of the session id it is given, says so, and holds it until killed. */
const LEASE_HOLDER = `import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
const lease = tryAcquireSessionLease(process.argv.at(-1));
console.log(lease ? "held" : "busy");
// The timer keeps the lease referenced: a collected handle lets the lock go.
setInterval(() => lease?.toString(), 1 << 30);`;

let tableSeq = 0;

/** One test's tables on one database, dropped when done. */
class Db implements AsyncDisposable {
	readonly table = `omp_offbox_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly statements: Array<{ sql: string; values: unknown[] }> = [];
	readonly recording: SqlSessionStorageClient;
	onIndexRead?: () => Promise<void>;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		url: string,
	) {
		// Server databases open as the configured store opens them, so a pooler DSN
		// (`?pool_mode=transaction`) works; the in-memory SQLite database is one connection.
		this.client = adapter === "sqlite" ? new SQL(url) : createSessionSqlClient(url);
		const run = async (executor: SqlSessionStorageTransaction, sql: string, values?: unknown[]) => {
			this.statements.push({ sql, values: values ?? [] });
			const result = await executor.unsafe(sql, values);
			if (sql.startsWith("SELECT path, mtime_ms")) await this.onIndexRead?.();
			return result;
		};
		this.recording = {
			options: this.client.options,
			unsafe: (sql, values) => run(this.client, sql, values),
			transaction: work =>
				this.client.transaction(transaction => work({ unsafe: (sql, values) => run(transaction, sql, values) })),
		};
	}

	/** A plain SQL store, as `sql` without the check opens it. */
	plain(sessionsRoot: string): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client: this.recording, table: this.table, sessionsRoot });
	}

	/** The storage `sql` with the check installs, over this test's tables. */
	offbox(sessionsRoot: string, check: OffboxCheck): Promise<OffboxSessionStorage> {
		return OffboxSessionStorage.create({
			check,
			openDatabase: wrapBackend =>
				SqlSessionStorage.create({ client: this.recording, table: this.table, sessionsRoot, wrapBackend }),
		});
	}

	async keys(table = this.table): Promise<string[]> {
		const rows = (await this.client.unsafe(`SELECT path FROM ${table}`)) as Array<{ path: string }>;
		return [...new Set(rows.map(row => String(row.path)))].sort();
	}

	/** Every row of both tables, every column a write changes, in a fixed order. */
	async snapshot(): Promise<{ files: unknown[]; parts: unknown[] }> {
		const files = (await this.client.unsafe(
			`SELECT path, content, mtime_ms, title, title_source, title_updated_at, byte_len FROM ${this.table} ORDER BY path`,
		)) as Array<Record<string, unknown>>;
		const parts = (await this.client.unsafe(
			`SELECT path, start_offset, content FROM ${this.table}_parts ORDER BY path, start_offset`,
		)) as Array<Record<string, unknown>>;
		return { files: files.map(row => ({ ...row })), parts: parts.map(row => ({ ...row })) };
	}

	/** Every `<table>_meta` row (the schema checks the store recorded). */
	async meta(): Promise<unknown[]> {
		const rows = (await this.client.unsafe(`SELECT * FROM ${this.table}_meta ORDER BY name`)) as Array<
			Record<string, unknown>
		>;
		return rows.map(row => ({ ...row }));
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_meta`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

/** A subagent transcript under `parentFile`, written the way the task tool writes one. */
async function runSubagent(
	storage: SessionStorage,
	parentFile: string,
	name: string,
	cwd: string,
	reply: string,
): Promise<string> {
	const file = path.join(parentFile.slice(0, -".jsonl".length), `${name}.jsonl`);
	const child = await SessionManager.open(file, undefined, storage, {
		initialCwd: cwd,
		parentSession: parentFile,
		suppressBreadcrumb: true,
	});
	converse(child, reply);
	await child.flush();
	await child.close();
	return file;
}

/** A current-version transcript: title slot, header, one user turn, one assistant reply. */
function transcript(id: string, cwd: string, reply: string): string {
	const timestamp = "2026-11-03T00:00:00.000Z";
	return `${serializeTitleSlot({ updatedAt: timestamp })}${[
		{ type: "session", version: 3, id, timestamp, cwd },
		{ type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: "q", timestamp: 1 } },
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

let previousStorage: SessionStorage;

beforeEach(() => {
	previousStorage = defaultSessionStorage();
});

afterEach(() => {
	setDefaultSessionStorage(previousStorage);
	mock.restore();
});

/**
 * Each test below starts real check processes (and one a second omp process).
 * On a loaded box starting one takes seconds: at load ~410 these tests took
 * up to 11.05 s (move), 10.76 s (lifecycle), 9.51 s (timeout), 8.19 s
 * (hand-over), past bun's 5 s default, and under 1.5 s at load ~280.
 */
const PROCESS_TEST_TIMEOUT_MS = 60_000;

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`session.sql.offboxCheck (${adapter})`, () => {
		const connect = (): Db => new Db(adapter, url ?? "");

		it(
			"issues no SQL write for any part of a refused session's full lifecycle",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				db.statements.length = 0;
				const dir = path.join(fx.sessionsRoot, "refused");
				const manager = SessionManager.create(fx.refusedCwd, dir, storage);
				converse(manager, "first reply");
				await manager.flush();
				const file = manager.getSessionFile() as string;
				await manager.setSessionName("Private title", "user");
				await runSubagent(storage, file, "Worker", fx.refusedCwd, "private child");
				const fork = await SessionManager.forkFrom(file, fx.refusedCwd, dir, storage);
				converse(fork, "private fork");
				await fork.flush();
				await fork.close();
				await manager.moveTo(fx.allowedCwd, path.join(fx.sessionsRoot, "moved"));
				converse(manager, "last private reply");
				await manager.flush();
				await manager.close();
				await storage.drain();
				const writes = db.statements.filter(
					({ sql }) =>
						/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i.test(sql) &&
						[db.table, `${db.table}_parts`, `${db.table}_meta`, "omp_session_leases"].some(table =>
							sql.includes(table),
						),
				);
				expect(writes).toEqual([]);
				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
				expect(fs.readFileSync(manager.getSessionFile() as string, "utf-8")).toContain("last private reply");
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"no-replace moves preserve taken destinations and refuse cross-route publication",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const local = path.join(fx.sessionsRoot, "local.jsonl");
				const taken = path.join(fx.sessionsRoot, "taken.jsonl");
				const allowed = path.join(fx.sessionsRoot, "allowed.jsonl");
				await storage.writeText(local, transcript("local", fx.refusedCwd, "private"));
				await storage.writeText(taken, transcript("taken", fx.refusedCwd, "taken"));
				await storage.writeText(allowed, transcript("allowed", fx.allowedCwd, "public"));
				await storage.drain();
				expect(storage.listAllSync().sort()).toEqual([local, taken, allowed].sort());
				await expect(storage.renameNoReplace!(local, taken)).rejects.toMatchObject({ code: "EEXIST" });
				await expect(
					storage.renameNoReplace!(local, path.join(allowed.slice(0, -6), "Child.jsonl")),
				).rejects.toMatchObject({ name: "SessionOffboxMoveError" });
				const other = await db.plain(fx.sessionsRoot);
				const remoteTaken = path.join(fx.sessionsRoot, "remote-taken.jsonl");
				await other.writeText(remoteTaken, transcript("remote-taken", fx.allowedCwd, "remote"));
				await expect(storage.renameNoReplace!(allowed, remoteTaken)).rejects.toMatchObject({ code: "EEXIST" });
				await expect(storage.renameNoReplace!(local, remoteTaken)).rejects.toMatchObject({
					name: "SessionOffboxMoveError",
				});
				expect(await storage.readText(local)).toContain("private");
				expect(await storage.readText(taken)).toContain("taken");
				expect(await other.readText(remoteTaken)).toContain("remote");
				expect(await storage.readText(allowed)).toContain("public");
				await expect(
					storage.renameNoReplace!(allowed, path.join(taken.slice(0, -6), "Child.jsonl")),
				).rejects.toMatchObject({ name: "SessionOffboxMoveError" });
				const movedLocal = path.join(fx.sessionsRoot, "moved-local.jsonl");
				const movedSql = path.join(fx.sessionsRoot, "moved-sql.jsonl");
				await storage.renameNoReplace!(local, movedLocal);
				await storage.renameNoReplace!(allowed, movedSql);
				expect(await storage.readText(movedLocal)).toContain("private");
				expect(await storage.readText(movedSql)).toContain("public");
				expect([storage.existsSync(local), storage.existsSync(allowed)]).toEqual([false, false]);
				expect(await db.keys()).toEqual(
					[sessionRowKey(movedSql, fx.sessionsRoot), sessionRowKey(remoteTaken, fx.sessionsRoot)].sort(),
				);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"refreshes SQL by scope while local entries remain live",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const firstDir = path.join(fx.sessionsRoot, "first");
				const secondDir = path.join(fx.sessionsRoot, "second");
				const local = path.join(firstDir, "local.jsonl");
				await storage.writeText(local, transcript("local", fx.refusedCwd, "private"));
				const remote = await db.plain(fx.sessionsRoot);
				const first = path.join(firstDir, "remote.jsonl");
				const second = path.join(secondDir, "remote.jsonl");
				await remote.writeText(first, transcript("first", fx.allowedCwd, "first remote"));
				await remote.writeText(second, transcript("second", fx.allowedCwd, "second remote"));
				await storage.refresh({ kind: "dir", dir: firstDir });
				expect(storage.listFilesSync(firstDir, "*.jsonl").sort()).toEqual([local, first].sort());
				expect(storage.listFilesSync(secondDir, "*.jsonl")).toEqual([]);
				await storage.refresh({ kind: "session", file: second });
				expect(await storage.readText(second)).toContain("second remote");
				const marker = `${local.slice(0, -6)}.exported`;
				await storage.writeText(marker, "local marker");
				await storage.refresh({ kind: "prefix", prefix: firstDir });
				expect(await storage.readText(marker)).toBe("local marker");
				await storage.refresh({ kind: "all" });
				expect(storage.listAllSync().sort()).toEqual([local, first, second, marker].sort());
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"keeps SQL behavior unchanged when no off-box check is installed",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.plain(fx.sessionsRoot);
				const manager = SessionManager.create(fx.refusedCwd, path.join(fx.sessionsRoot, "unchecked"), storage);
				converse(manager, "unchecked reply");
				await manager.flush();
				await manager.close();
				const file = manager.getSessionFile() as string;
				expect(await db.keys()).toEqual([sessionRowKey(file, fx.sessionsRoot)]);
				expect(fs.existsSync(file)).toBe(false);
				expect(fx.runs()).toEqual([]);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"deletes allowed artifacts committed after its scope snapshot",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const parent = path.join(fx.sessionsRoot, "parent.jsonl");
				await storage.writeText(parent, transcript("parent", fx.allowedCwd, "public"));
				const late = path.join(parent.slice(0, -6), "Late.jsonl");
				db.onIndexRead = async () => {
					db.onIndexRead = undefined;
					// Commit after the snapshot without re-entering the store's SQLite
					// serialization lock, which remains held until that snapshot returns.
					const key = sessionRowKey(late, fx.sessionsRoot);
					const bind = adapter === "postgres" ? "$1" : "?";
					await db.client.unsafe(
						`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len, kind) VALUES (${bind}, '', 1, 1, 'transcript')`,
						[key],
					);
					await db.client.unsafe(
						`INSERT INTO ${db.table}_parts (path, start_offset, content) VALUES (${bind}, 0, 'x')`,
						[key],
					);
				};
				await storage.deleteSessionWithArtifacts(parent);
				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"keeps a refused session, its subagent, title and fork out of both tables, and still finds it",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const warn = spyOn(logger, "warn").mockImplementation(() => {});
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const metaBefore = await db.meta();
				setDefaultSessionStorage(storage);
				const sessionDir = path.join(fx.sessionsRoot, "-work-refuse-me");

				const manager = SessionManager.create(fx.refusedCwd, sessionDir, storage);
				converse(manager, "first refused reply");
				converse(manager, "second refused reply");
				await manager.flush();
				const sessionFile = manager.getSessionFile() as string;
				const sessionId = manager.getSessionId();
				// A refused session's claim is the file storage's ownership lease.
				expect(isSessionLeaseHeld(sessionId)).toBe(true);
				await manager.setSessionName("Named while open", "user");
				const childFile = await runSubagent(storage, sessionFile, "Worker", fx.refusedCwd, "subagent reply");
				const fork = await SessionManager.forkFrom(sessionFile, fx.refusedCwd, sessionDir, storage);
				converse(fork, "fork reply");
				await fork.flush();
				const forkFile = fork.getSessionFile() as string;
				await fork.close();
				await manager.close();
				const renamed = await SessionManager.renameSessionTitle(sessionFile, "Renamed in the picker", {
					cwd: fx.refusedCwd,
				});
				await storage.drain();

				expect(renamed).toBe("Renamed in the picker");
				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
				const local = fs.readFileSync(sessionFile, "utf-8");
				expect(local).toContain("second refused reply");
				expect(local).toContain("Renamed in the picker");
				expect(fs.readFileSync(childFile, "utf-8")).toContain("subagent reply");
				expect(fs.readFileSync(forkFile, "utf-8")).toContain("fork reply");
				// One run, for the session: its subagent and its fork follow it without one.
				expect(fx.runs()).toEqual([fx.runFor(fx.refusedCwd, sessionId, sessionFile)]);
				// One warning, naming the session and the check's first line of output.
				expect(warn.mock.calls.filter(([message]) => String(message).includes("offboxCheck"))).toEqual([
					[
						"session.sql.offboxCheck keeps a session off the session database",
						{
							sessionId,
							sessionFile,
							cwd: fx.refusedCwd,
							reason: `the check exited 1: no-offbox: REFUSED ${sessionFile}: test marker`,
						},
					],
				]);

				expect((await listSessions(sessionDir, storage)).map(session => session.path).sort()).toEqual(
					[forkFile, sessionFile].sort(),
				);
				expect((await listAllSessions(storage, fx.sessionsRoot)).map(session => session.path)).toContain(
					sessionFile,
				);
				const resolved = await resolveResumableSession(sessionId.slice(0, 8), fx.refusedCwd, sessionDir, storage);
				expect(resolved?.session.path).toBe(sessionFile);

				// The next process finds the local transcript, keeps the session local
				// without running the check again, and resumes it.
				const later = await db.offbox(fx.sessionsRoot, fx.check());
				expect((await listSessions(sessionDir, later)).map(session => session.path).sort()).toEqual(
					[forkFile, sessionFile].sort(),
				);
				const laterResolved = await resolveResumableSession(
					sessionId.slice(0, 8),
					fx.refusedCwd,
					sessionDir,
					later,
				);
				expect(laterResolved?.session.path).toBe(sessionFile);
				const resumed = await SessionManager.open(sessionFile, sessionDir, later, { suppressBreadcrumb: true });
				expect(resumed.getSessionName()).toBe("Renamed in the picker");
				converse(resumed, "resumed reply");
				await resumed.flush();
				await resumed.close();
				await later.drain();

				expect(fs.readFileSync(sessionFile, "utf-8")).toContain("resumed reply");
				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
				// The schema checks are all the meta table holds: no refused session adds to it.
				expect(await db.meta()).toEqual(metaBefore);
				expect(fx.runs()).toHaveLength(1);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"moves a refused session and its subagent to another directory without writing a row",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const manager = SessionManager.create(
					fx.refusedCwd,
					path.join(fx.sessionsRoot, "-work-refuse-me"),
					storage,
				);
				converse(manager, "before the move");
				await manager.flush();
				const sessionFile = manager.getSessionFile() as string;
				await runSubagent(storage, sessionFile, "Worker", fx.refusedCwd, "subagent reply");

				// The new cwd is one the check allows: the session keeps its verdict anyway.
				const targetDir = path.join(fx.sessionsRoot, "-work-allowed");
				await manager.moveTo(fx.allowedCwd, targetDir);
				converse(manager, "after the move");
				await manager.flush();
				const movedFile = manager.getSessionFile() as string;
				await manager.close();
				await storage.drain();

				expect(movedFile).toBe(path.join(targetDir, path.basename(sessionFile)));
				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
				expect(fs.existsSync(sessionFile)).toBe(false);
				expect(fs.readFileSync(movedFile, "utf-8")).toContain("after the move");
				const movedChild = path.join(movedFile.slice(0, -".jsonl".length), "Worker.jsonl");
				expect(fs.readFileSync(movedChild, "utf-8")).toContain("subagent reply");
				expect((await listSessions(targetDir, storage)).map(session => session.path)).toEqual([movedFile]);
				// Nothing of the old tree is left in the store's view, without a refresh.
				const oldStem = sessionFile.slice(0, -".jsonl".length);
				expect(storage.listFilesSync(oldStem, "*.jsonl")).toEqual([]);
				expect(storage.listDirsSync(path.dirname(oldStem))).not.toContain(path.basename(oldStem));
				expect(
					storage.listAllSync().filter(file => file === sessionFile || file.startsWith(`${oldStem}/`)),
				).toEqual([]);
				expect(fx.runs()).toHaveLength(1);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"gives a refused session file storage's behaviour once it is handed over: another process's lease moves it to a sibling",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const sessionDir = path.join(fx.sessionsRoot, "-work-refuse-me");
				const manager = SessionManager.create(fx.refusedCwd, sessionDir, storage);
				converse(manager, "first reply");
				await manager.flush();
				const sessionFile = manager.getSessionFile() as string;
				const sessionId = manager.getSessionId();
				await manager.close();
				await storage.drain();
				// Nothing of it is queued now: it is a file session, publishing in-body.
				expect(defersSyncPublishAt(storage, sessionFile)).toBe(false);

				// Another omp process takes the session's file lease.
				const holder = Bun.spawn([process.execPath, "-e", LEASE_HOLDER, sessionId], {
					cwd: path.resolve(import.meta.dir, "../.."),
					// The test's owners directory, set in this process's environment at load.
					env: { ...process.env },
					stdout: "pipe",
					stderr: "inherit",
				});
				try {
					const reader = holder.stdout.getReader();
					const first = await reader.read();
					reader.releaseLock();
					expect(new TextDecoder().decode(first.value)).toStartWith("held");

					const reopened = await SessionManager.open(sessionFile, sessionDir, storage, {
						suppressBreadcrumb: true,
					});
					const notices: string[] = [];
					reopened.onPersistenceNotice(notice => notices.push(notice.reason));
					converse(reopened, "reply after the other process took it");
					await reopened.flush();
					const sibling = reopened.getSessionFile() as string;
					await reopened.close();
					await storage.drain();

					expect(notices).toEqual(["open-elsewhere"]);
					expect(path.dirname(sibling)).toBe(sessionDir);
					expect(sibling).not.toBe(sessionFile);
					expect(fs.readFileSync(sibling, "utf-8")).toContain("reply after the other process took it");
					expect(fs.readFileSync(sessionFile, "utf-8")).not.toContain("reply after the other process took it");
				} finally {
					holder.kill();
					await holder.exited;
				}
				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
				// The sibling continues a local session: it stays local without a check of its own.
				expect(fx.runs()).toHaveLength(1);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"sends an allowed session to the database and keeps a refused subagent of it local",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const sessionDir = path.join(fx.sessionsRoot, "-work-allowed");

				const manager = SessionManager.create(fx.allowedCwd, sessionDir, storage);
				converse(manager, "allowed reply");
				await manager.flush();
				const sessionFile = manager.getSessionFile() as string;
				const stem = sessionFile.slice(0, -".jsonl".length);
				const workerFile = await runSubagent(storage, sessionFile, "Worker", fx.allowedCwd, "allowed subagent");
				const refusedFile = await runSubagent(
					storage,
					sessionFile,
					"RefuseWorker",
					fx.allowedCwd,
					"refused subagent",
				);
				await manager.close();
				await storage.drain();

				const keys = [
					sessionRowKey(sessionFile, fx.sessionsRoot),
					sessionRowKey(workerFile, fx.sessionsRoot),
				].sort();
				expect(await db.keys()).toEqual(keys);
				expect(await db.keys(`${db.table}_parts`)).toEqual(keys);
				expect([fs.existsSync(sessionFile), fs.existsSync(workerFile)]).toEqual([false, false]);
				expect(fs.readFileSync(refusedFile, "utf-8")).toContain("refused subagent");
				expect(fx.runs()).toEqual([
					fx.runFor(fx.allowedCwd, manager.getSessionId(), sessionFile),
					expect.objectContaining({ sessionFile: workerFile }),
					expect.objectContaining({ sessionFile: refusedFile }),
				]);
				// The session's tree, as the storage lists it, holds both subagents, here and in the next process.
				expect(storage.listFilesSync(stem, "*.jsonl").sort()).toEqual([refusedFile, workerFile].sort());
				const later = await db.offbox(fx.sessionsRoot, fx.check());
				// A new store loads nothing until a caller refreshes the scope it reads.
				await later.refresh({ kind: "dir", dir: stem });
				expect(later.listFilesSync(stem, "*.jsonl").sort()).toEqual([refusedFile, workerFile].sort());
				expect(await later.readText(refusedFile)).toContain("refused subagent");
				expect(await later.readText(workerFile)).toContain("allowed subagent");
				expect((await listSessions(sessionDir, later)).map(session => session.path)).toEqual([sessionFile]);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"copies a session the database already holds down before its first write, leaving its rows as they were",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);
				const id = "01a1880d-dddd-7000-9000-000000000004";
				const sessionDir = path.join(fx.sessionsRoot, "-work-refuse-me");
				const sessionFile = path.join(sessionDir, `2026-11-03T00-00-00-000Z_${id}.jsonl`);
				// Written by `sql` before the check was configured.
				const plain = await db.plain(fx.sessionsRoot);
				await plain.writeText(sessionFile, transcript(id, fx.refusedCwd, "stored reply"));
				await plain.updateSessionTitle(sessionFile, {
					title: "Stored title",
					source: "user",
					updatedAt: "2026-11-03T00:00:01.000Z",
				});
				await plain.drain();
				const before = await db.snapshot();

				const storage = await db.offbox(fx.sessionsRoot, fx.check());
				const manager = await SessionManager.open(sessionFile, sessionDir, storage, { suppressBreadcrumb: true });
				converse(manager, "local reply");
				await manager.flush();
				await manager.close();
				await storage.drain();

				expect(await db.snapshot()).toEqual(before);
				const local = fs.readFileSync(sessionFile, "utf-8");
				expect(local).toContain("stored reply");
				expect(local).toContain("local reply");
				expect(local).toContain("Stored title");
				expect(fx.runs()).toEqual([fx.runFor(fx.refusedCwd, id, sessionFile)]);

				const later = await db.offbox(fx.sessionsRoot, fx.check());
				const reopened = await SessionManager.open(sessionFile, sessionDir, later, { suppressBreadcrumb: true });
				const texts = reopened
					.getEntries()
					.flatMap(entry => (entry.type === "message" ? [JSON.stringify(entry)] : []));
				await reopened.close();
				expect(texts.some(text => text.includes("stored reply"))).toBe(true);
				expect(texts.some(text => text.includes("local reply"))).toBe(true);
				expect(fx.runs()).toHaveLength(1);
			},
			PROCESS_TEST_TIMEOUT_MS,
		);

		it(
			"refuses a session whose check runs past its timeout or cannot start",
			async () => {
				await using db = connect();
				using tmp = TempDir.createSync("@omp-offbox-");
				const fx = new OffboxFixture(tmp);

				// A real 300 ms limit: the check is another process (it sleeps 60 s), whose clock
				// fake timers cannot move, and the limit is what kills it.
				const slow = await db.offbox(fx.sessionsRoot, fx.check(300));
				const started = performance.now();
				const slowManager = SessionManager.create(fx.slowCwd, path.join(fx.sessionsRoot, "-work-slow"), slow);
				converse(slowManager, "slow reply");
				await slowManager.flush();
				await slowManager.close();
				await slow.drain();
				const slowFile = slowManager.getSessionFile() as string;
				// Far below the check's 60 s sleep: the limit killed it. The margin covers
				// starting processes on a loaded box (9.5 s measured at load ~410).
				expect(performance.now() - started).toBeLessThan(30_000);

				const missing = await db.offbox(fx.sessionsRoot, fx.missingCheck());
				const missingManager = SessionManager.create(
					fx.allowedCwd,
					path.join(fx.sessionsRoot, "-work-allowed"),
					missing,
				);
				converse(missingManager, "unchecked reply");
				await missingManager.flush();
				await missingManager.close();
				await missing.drain();
				const missingFile = missingManager.getSessionFile() as string;

				expect([await db.keys(), await db.keys(`${db.table}_parts`)]).toEqual([[], []]);
				expect(fs.readFileSync(slowFile, "utf-8")).toContain("slow reply");
				expect(fs.readFileSync(missingFile, "utf-8")).toContain("unchecked reply");
			},
			PROCESS_TEST_TIMEOUT_MS,
		);
	});
}
