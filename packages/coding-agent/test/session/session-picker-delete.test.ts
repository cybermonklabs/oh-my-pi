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
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";
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

/** A UTF-8 byte order mark. */
const MARK = "\uFEFF";

function userTurn(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * A session this process's SessionManager writes through the picker's (claiming) store: a turn and its reply,
 * published (a session with no reply yet is not written).
 */
async function ownSession(backend: Backend): Promise<SessionManager> {
	fs.mkdirSync(backend.dir.join("project"), { recursive: true });
	const manager = SessionManager.create(
		backend.dir.join("project"),
		backend.dir.join("sessions", "-project-"),
		backend.picker,
	);
	manager.appendMessage(userTurn("the manager's turn"));
	manager.appendMessage(createAssistantMessage("the manager's reply"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file || !(await backend.paths()).includes(file)) throw new Error("the session is not in the store");
	return manager;
}

/**
 * `manager` deletes its own current file (`dropSession`): the file is in the store before, it is deleted, and only
 * `kept` remain.
 */
async function expectOwnDelete(backend: Backend, manager: SessionManager, kept: string[] = []): Promise<void> {
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("the manager has no file");
	await backend.picker.refresh?.();
	expect(await backend.paths()).toEqual([...kept, file].sort());
	const deleted = await outcome(manager.dropSession(file));
	expect({ deleted, paths: await backend.paths() }).toEqual({ deleted: "deleted", paths: [...kept].sort() });
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

	// `dropSession` of the manager's own file expects the session the manager owns there, never the one the header
	// names when the delete reads it. Each `site` names where SessionManager sets its file and id.
	describe.skipIf(!url)(`a SessionManager's delete of its own ${adapter} session`, () => {
		it("refuses, deleting nothing, when another session took its path", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const manager = await ownSession(backend);
			try {
				const file = manager.getSessionFile() ?? "";
				const other = crypto.randomUUID();
				await backend.writer.writeText(file, transcript(other, "another session"));
				await backend.writer.drain();
				await backend.picker.refresh?.();
				const deleted = await outcome(manager.dropSession(file));
				expect({ deleted, paths: await backend.paths() }).toEqual({
					deleted: `refused: Cannot delete session "${file}": the file no longer holds session ${manager.getSessionId()} (it holds ${other}). Nothing was deleted.`,
					paths: [file],
				});
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes a session it started (site: #resetToNewSession)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const manager = await ownSession(backend);
			try {
				await expectOwnDelete(backend, manager);
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes a session it opened (site: #setSessionFile, the id from the header)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const writer = await ownSession(backend);
			const file = writer.getSessionFile() ?? "";
			await writer.close();
			const manager = await SessionManager.open(file, path.dirname(file), backend.picker, {
				suppressBreadcrumb: true,
			});
			try {
				await expectOwnDelete(backend, manager);
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes an empty file it opened and wrote its header to (site: #setSessionFile's empty branch)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const file = backend.dir.join("sessions", "-project-", "explicit.jsonl");
			backend.writer.ensureDirSync(path.dirname(file));
			await backend.writer.writeText(file, "");
			await backend.writer.drain();
			await backend.picker.refresh?.();
			const manager = await SessionManager.open(file, path.dirname(file), backend.picker, {
				suppressBreadcrumb: true,
			});
			try {
				expect(manager.getSessionFile()).toBe(file);
				await expectOwnDelete(backend, manager);
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes its session after moving it (site: moveTo)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const manager = await ownSession(backend);
			try {
				const from = manager.getSessionFile();
				fs.mkdirSync(backend.dir.join("moved"), { recursive: true });
				await manager.moveTo(backend.dir.join("moved"), backend.dir.join("sessions", "zz-moved"));
				expect(manager.getSessionFile()).not.toBe(from);
				await expectOwnDelete(backend, manager);
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes its fork, keeping the session it forked from (site: fork)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const manager = await ownSession(backend);
			try {
				const from = manager.getSessionFile() ?? "";
				await manager.fork();
				await expectOwnDelete(backend, manager, [from]);
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes its branched session, keeping the session it branched from (site: createBranchedSession)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const manager = await ownSession(backend);
			try {
				const from = manager.getSessionFile() ?? "";
				manager.createBranchedSession(manager.getLeafId() ?? "");
				await manager.flush();
				await expectOwnDelete(backend, manager, [from]);
			} finally {
				await manager.close();
			}
		}, 60_000);

		it("deletes the session through a clone of its state (site: restoreState)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const manager = await ownSession(backend);
			const clone = manager.cloneCurrentSession();
			try {
				await expectOwnDelete(backend, clone);
			} finally {
				await clone.close();
				await manager.close();
			}
		}, 60_000);

		it("deletes the sibling it moved to while another process held its session, keeping that session (site: #moveOffSessionFile)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const writer = await ownSession(backend);
			const file = writer.getSessionFile() ?? "";
			await writer.close();
			await using holder = await LeaseProcess.start({ ...backend.config, claims: true }, backend.dir.join("holder"));
			const held = await holder.run({ op: "hold", file, sessionDir: path.dirname(file) });
			expect([held.error, held.sessionFile]).toEqual([undefined, file]);
			await backend.picker.refresh?.();
			const manager = await SessionManager.open(file, path.dirname(file), backend.picker, {
				suppressBreadcrumb: true,
			});
			try {
				manager.appendMessage(userTurn("while another process holds the session"));
				await manager.flush();
				expect(manager.getSessionFile()).not.toBe(file);
				await expectOwnDelete(backend, manager, [file]);
			} finally {
				await manager.close();
			}
		}, 60_000);
	});

	// The listing, the loader and the delete read a header the same way (leadingSessionHeader): a session the picker
	// lists is deleted as listed, and one the loader opens is deleted by its own manager.
	describe.skipIf(!url)(`a delete of a listed ${adapter} session whose header the listing reads leniently`, () => {
		/** A session file `content` at `name` in the picker's session dir, listed by the picker with its id. */
		async function listedFile(backend: Backend, name: string, content: string, id: string): Promise<string> {
			const dir = backend.dir.join("sessions", "-project-");
			const file = path.join(dir, name);
			backend.writer.ensureDirSync(dir);
			await backend.writer.writeText(file, content);
			await backend.writer.drain();
			await backend.picker.refresh?.();
			const listed = (await listSessions(dir, backend.picker)).map(info => [info.path, info.id]);
			expect(listed).toEqual([[file, id]]);
			return file;
		}
		const headerLine = (id: string) =>
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-21T00:00:00.000Z", cwd: "/w" });

		it("deletes a session whose header was cut short (listed, not resumable)", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const id = crypto.randomUUID();
			const cut = headerLine(id).slice(0, -12);
			const file = await listedFile(backend, "cut.jsonl", cut, id);
			const deleted = await outcome(SessionManager.deleteListedSession({ path: file, id }, backend.picker));
			expect({ deleted, paths: await backend.paths() }).toEqual({ deleted: "deleted", paths: [] });
		}, 60_000);

		it("deletes a session listed past a malformed line before its header, through the picker", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const id = crypto.randomUUID();
			const content = `{"type":"title","title":"torn\n${headerLine(id)}\n${transcript(id, "a turn").split("\n").slice(1).join("\n")}`;
			const file = await listedFile(backend, "torn.jsonl", content, id);
			const deleted = await outcome(SessionManager.deleteListedSession({ path: file, id }, backend.picker));
			expect({ deleted, paths: await backend.paths() }).toEqual({ deleted: "deleted", paths: [] });
		}, 60_000);

		it("deletes a session opened past a malformed line before its header, by its own manager", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const id = crypto.randomUUID();
			const content = `{"type":"title","title":"torn\n${headerLine(id)}\n${transcript(id, "a turn").split("\n").slice(1).join("\n")}`;
			const file = await listedFile(backend, "torn.jsonl", content, id);
			const manager = await SessionManager.open(file, path.dirname(file), backend.picker, {
				suppressBreadcrumb: true,
			});
			try {
				expect(manager.getSessionId()).toBe(id);
				const deleted = await outcome(manager.dropSession(file));
				expect({ deleted, paths: await backend.paths() }).toEqual({ deleted: "deleted", paths: [] });
			} finally {
				await manager.close();
			}
		}, 60_000);

		// Every store returns a session file's text as stored, a leading byte order mark included, and the manager
		// expects that size; the loader drops exactly one leading mark. Open, append, rewrite whole, reopen and delete:
		// one session throughout (at bbdb6d5f the file store's text path read 3 bytes fewer than the file holds, so
		// the first whole rewrite met a size conflict and moved the session to a second file under a new id).
		async function rewriteMarked(backend: Backend, firstTurn: string): Promise<void> {
			const id = crypto.randomUUID();
			const file = await listedFile(backend, "bom.jsonl", `${MARK}${transcript(id, firstTurn)}`, id);
			const dir = path.dirname(file);
			const manager = await SessionManager.open(file, dir, backend.picker, { suppressBreadcrumb: true });
			try {
				expect([manager.getSessionId(), manager.getEntries().length]).toEqual([id, 1]);
				manager.appendMessage(userTurn("a second turn"));
				manager.appendMessage(createAssistantMessage("a reply"));
				await manager.flush();
				await manager.rewriteEntries();
				await manager.flush();
				expect([manager.getSessionFile(), manager.getSessionId()]).toEqual([file, id]);
			} finally {
				await manager.close();
			}
			await backend.picker.refresh?.();
			expect((await listSessions(dir, backend.picker)).map(info => [info.path, info.id])).toEqual([[file, id]]);
			const reopened = await SessionManager.open(file, dir, backend.picker, { suppressBreadcrumb: true });
			try {
				expect([reopened.getSessionId(), reopened.getEntries().length]).toEqual([id, 3]);
				const deleted = await outcome(reopened.dropSession(file));
				expect({ deleted, paths: await backend.paths() }).toEqual({ deleted: "deleted", paths: [] });
			} finally {
				await reopened.close();
			}
		}

		it("keeps a session that starts with a byte order mark as one session through an append and a whole rewrite", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			await rewriteMarked(backend, "a turn");
		}, 60_000);

		it.skipIf(adapter !== "file")(
			"keeps a 9 MiB session that starts with a byte order mark (the stream path) as one session through an append and a whole rewrite",
			async () => {
				await using backend = await openBackend(adapter, url ?? "");
				await rewriteMarked(backend, "x".repeat(9 * 1024 * 1024));
			},
			180_000,
		);

		it("returns a session file's leading byte order marks as stored", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const id = crypto.randomUUID();
			const file = await listedFile(backend, "marks.jsonl", `${MARK}${MARK}${transcript(id, "a turn")}`, id);
			const marks = (text: string) => text.length - text.replace(/^\uFEFF+/, "").length;
			const store = backend.picker;
			expect({
				whole: marks(await store.readText(file)),
				head: marks((await store.readTextSlices(file, 64, 0))[0]),
				from: store.readTextFrom ? marks((await store.readTextFrom(file, 0)).text) : "no readTextFrom",
			}).toEqual({ whole: 2, head: 2, from: 2 });
		}, 60_000);

		// Exactly one leading mark is dropped: a second one leaves the header line unreadable on every store, so the
		// session is listed by its line, not opened, and deleted as listed.
		it("lists, does not open, and deletes as listed a session that starts with two byte order marks", async () => {
			await using backend = await openBackend(adapter, url ?? "");
			const id = crypto.randomUUID();
			const file = await listedFile(backend, "two-marks.jsonl", `${MARK}${MARK}${transcript(id, "a turn")}`, id);
			const opening = await SessionManager.open(file, path.dirname(file), backend.picker, {
				suppressBreadcrumb: true,
			}).then(
				async manager => {
					await manager.close();
					return "opened";
				},
				(err: unknown) => `refused: ${err instanceof Error ? err.message : String(err)}`,
			);
			expect(opening).toBe(
				`refused: Cannot resume session "${file}": the session header is missing or malformed. The file was not modified.`,
			);
			const deleted = await outcome(SessionManager.deleteListedSession({ path: file, id }, backend.picker));
			expect({ deleted, paths: await backend.paths() }).toEqual({ deleted: "deleted", paths: [] });
		}, 60_000);
	});
}
