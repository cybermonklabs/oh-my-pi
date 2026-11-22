/**
 * A delete of a session through `SessionManager` while another client moves that session (`moveTo`): the pickers'
 * delete (`deleteListedSession`), `deleteSessionFile` (`/delete`, `/tan`'s clean-up) and `/session delete`
 * (`dropSession`, also AgentSession's `/delete`, the task executor's and the empty-move clean-ups). The mover here is
 * an SDK host's store: SQL storage built as `examples/sdk/13-sql-sessions.ts` builds it, which claims nothing
 * (`claims` is off by default), so no lease or write fence stands between it and the deleting claiming store. The
 * move renames the session's file, then each subagent transcript keyed under its artifacts directory. A delete that
 * found the session at its path before the move renamed it, and deletes after the rename, must refuse, deleting
 * nothing, instead of removing the subagent transcripts the move has not reached: on PostgreSQL and MySQL the delete
 * waits for the session's row, which the move holds; on SQLite it waits for the write lock while the move renames
 * the file. A picker's delete once the file moved must refuse too, and must refuse when the file at the path no
 * longer holds the listed session. SQLite and the file store always; PostgreSQL and MySQL (MariaDB) when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
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
	/**
	 * SQLite: hold the picker store's next `BEGIN IMMEDIATE` (a delete's remove; a SQLite claim opens no
	 * transaction) before it is sent, until `release`. `reached` settles once a write waits there.
	 */
	readonly holdNextWrite?: () => { reached: Promise<void>; release: () => void };
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
	let hold: { reached: PromiseWithResolvers<void>; gate: PromiseWithResolvers<void> } | undefined;
	const picker = await db.open(
		adapter === "sqlite"
			? {
					wrap: client => ({
						options: client.options,
						transaction: callback => client.transaction(callback),
						unsafe: async (query, values) => {
							const held = hold;
							if (held && query === "BEGIN IMMEDIATE") {
								hold = undefined;
								held.reached.resolve();
								await held.gate.promise;
							}
							return client.unsafe(query, values);
						},
					}),
				}
			: {},
	);
	return {
		name: adapter,
		picker,
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
		holdNextWrite:
			adapter === "sqlite"
				? () => {
						const held = { reached: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() };
						hold = held;
						return { reached: held.reached.promise, release: () => held.gate.resolve() };
					}
				: undefined,
		[Symbol.asyncDispose]: () => db[Symbol.asyncDispose](),
	};
}

/**
 * A session the mover creates and holds, with two subagent transcripts, listed by the picker (its view is the one
 * a delete deletes from).
 */
async function moverSession(backend: Backend, mover: LeaseProcess): Promise<{ file: string; id: string }> {
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
	return { file: created.sessionFile, id: created.sessionId };
}

/**
 * Start the mover's move of its session and let it pause: inside the session file's rename, holding its row
 * (`"session"`), or once the file's rename committed, before the subagent transcripts (`"file"`).
 */
async function startMove(backend: Backend, mover: LeaseProcess, pause: "file" | "session"): Promise<void> {
	// The destination sorts after every row, so a delete whose lock scans the table (MySQL, MariaDB before 11.8.1)
	// has not locked the gap the move inserts into when it waits for the session's row.
	const moving = await mover.run({
		op: "move",
		cwd: backend.dir.join("moved"),
		sessionDir: backend.dir.join("sessions", "zz-moved"),
		pause,
	});
	if (moving.paused !== true) throw new Error(`the move did not pause: ${JSON.stringify(moving)}`);
}

/** {@link moverSession}, then {@link startMove}. */
async function sessionBeingMoved(
	backend: Backend,
	mover: LeaseProcess,
	pause: "file" | "session",
): Promise<{ file: string; id: string }> {
	const session = await moverSession(backend, mover);
	await startMove(backend, mover, pause);
	return session;
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

/** A delete's outcome when it refused because the session moved from `file`. */
function refusedMoved(file: string, id: string): string {
	return `refused: Cannot delete session "${file}": the file no longer holds session ${id} (it moved or was deleted). Nothing was deleted.`;
}

/** A delete as its callers make it: readied before the move starts (a caller's session may be open), then run. */
interface DeleteShape {
	readonly name: string;
	prepare(backend: Backend, file: string, id: string): Promise<AsyncDisposable & { run(): Promise<string> }>;
}

const DELETES: readonly DeleteShape[] = [
	{
		name: "the resume pickers' delete (deleteListedSession)",
		async prepare(backend, file, id) {
			return {
				run: () => outcome(SessionManager.deleteListedSession({ path: file, id }, backend.picker)),
				async [Symbol.asyncDispose]() {},
			};
		},
	},
	{
		name: "`/delete` and `/tan`'s clean-up (deleteSessionFile)",
		async prepare(backend, file) {
			return {
				run: () => outcome(SessionManager.deleteSessionFile(file, backend.picker)),
				async [Symbol.asyncDispose]() {},
			};
		},
	},
	{
		// The command's own handler, on a SessionManager that has the session open; AgentSession's `/delete`, the
		// task executor's and the empty-move clean-ups make the same `dropSession` call.
		name: "`/session delete` (dropSession)",
		async prepare(backend, file) {
			const manager = await SessionManager.open(file, path.dirname(file), backend.picker, {
				suppressBreadcrumb: true,
			});
			const output: string[] = [];
			const runtime = {
				session: { isStreaming: false } as unknown as AgentSession,
				sessionManager: manager,
				output: (text: string) => void output.push(text),
			} as unknown as SlashCommandRuntime;
			return {
				async run() {
					const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
					const failed = typeof result === "object" && "failed" in result && result.failed === true;
					return failed ? `refused: ${output.join("\n").replace(/^Failed to delete session: /, "")}` : "deleted";
				},
				[Symbol.asyncDispose]: () => manager.close(),
			};
		},
	},
];

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

	for (const shape of DELETES) {
		const title = `${shape.name} of a ${adapter} session another client is moving`;
		describe.skipIf(!url || adapter === "file")(title, () => {
			it.skipIf(!["mysql", "postgres"].includes(adapter))(
				"refuses, deleting nothing, when it waited for the session's row while the move renamed its file (the reviewer's race), and the move keeps the session whole",
				async () => {
					await using backend = await openBackend(adapter, url ?? "");
					await using mover = await LeaseProcess.start(backend.config, backend.dir.join("mover"));
					const { file, id } = await moverSession(backend, mover);
					await using deletion = await shape.prepare(backend, file, id);
					await startMove(backend, mover, "session");
					const deleting = deletion.run();
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
					expect({ deleted, moveError: ended.error, paths: await backend.paths() }).toEqual({
						deleted: refusedMoved(file, id),
						moveError: undefined,
						paths: whole(String(ended.sessionFile)),
					});
				},
				60_000,
			);

			// SQLite's write lock is the database's: a delete that read the session at its path waits for it while a
			// move's short transaction renames the file, then runs between that rename and the transcripts' (it fails
			// with SQLITE_BUSY, deleting nothing, only if the lock stays held past the 5 s busy timeout).
			it.skipIf(adapter !== "sqlite")(
				"refuses, deleting nothing, when it waited for the write lock while the move renamed its file, and the move keeps the session whole",
				async () => {
					await using backend = await openBackend(adapter, url ?? "");
					await using mover = await LeaseProcess.start(backend.config, backend.dir.join("mover"));
					const { file, id } = await moverSession(backend, mover);
					await using deletion = await shape.prepare(backend, file, id);
					const held = backend.holdNextWrite!();
					const deleting = deletion.run();
					// The delete reads the session at its path, then waits to begin its transaction.
					await Promise.race([held.reached, deleting]);
					await startMove(backend, mover, "file");
					held.release();
					const deleted = await deleting;
					const ended = await mover.run({ op: "moveGo" });
					expect({ deleted, moveError: ended.error, paths: await backend.paths() }).toEqual({
						deleted: refusedMoved(file, id),
						moveError: undefined,
						paths: whole(String(ended.sessionFile)),
					});
				},
				60_000,
			);
		});
	}
}
