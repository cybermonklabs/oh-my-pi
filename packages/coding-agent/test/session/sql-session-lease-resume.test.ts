/**
 * `omp --resume` of a session another omp process holds, on SQL session
 * storage, through the CLI's own `createSessionManager` in real processes
 * with the real lease timings (30 s expiry, 10 s heartbeat). Every open of
 * an existing session waits up to 35 s for the holder's lease to go or
 * expire; a live holder keeps it, so the resume moves to a minted id before
 * `session_start` sees the held one, and a killed holder's lease expires, so
 * the resume keeps the id. Under `OMP_SESSION_EXCLUSIVE=1` nothing moves the
 * id: the process exits non-zero instead. SQLite takes the kernel's lock,
 * which needs no wait. PostgreSQL and MySQL run when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SESSION_TRANSFER_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	type LeaseProcessConfig,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	transcript,
} from "./sql-session-lease-fixture";

// These tests wait in real time on purpose: they run the CLI's resume against
// the real 30 s lease expiry across processes, which no fake timer reaches.

const ID = "01a1f200-0000-7000-8000-000000000001";
const EXPIRY_MS = 30_000;
const RESUME_WAIT_MS = EXPIRY_MS + 5000;

interface Session {
	dir: string;
	file: string;
	cwd: string;
	config: LeaseProcessConfig;
}

/** Session {@link ID} stored in `db`, its directory, and the configuration processes open the store with. */
async function storedSession(db: LeaseDb): Promise<Session> {
	const cwd = db.dir.path();
	const dir = db.dir.join("sessions");
	const file = path.join(dir, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
	const storage = await db.open({ claims: false });
	await storage.writeText(file, transcript(ID, "before", cwd));
	await storage.drain();
	return { dir, file, cwd, config: { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable } };
}

function resumeById(session: Session, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		op: "resume",
		args: ["--session-dir", session.dir, "--resume", ID],
		cwd: session.cwd,
		sessionStart: true,
		...extra,
	};
}

function continueRecent(session: Session): Record<string, unknown> {
	return { op: "resume", args: ["--session-dir", session.dir, "--continue"], cwd: session.cwd, sessionStart: true };
}

const EXCLUSIVE = { OMP_SESSION_EXCLUSIVE: "1" };

/** The exit code of `process`, once it exits within `ms`. */
async function exitOf(process: LeaseProcess, ms: number): Promise<number | undefined> {
	return Promise.race([process.exited, Bun.sleep(ms).then(() => undefined)]);
}

/** The header (first session entry) of the transcript `content`. */
function headerOf(content: string): Record<string, unknown> {
	const line = content.split("\n").find(candidate => candidate.includes('"type":"session"')) ?? "{}";
	return JSON.parse(line) as Record<string, unknown>;
}

/** A copy of session {@link ID} an older build wrote: its header continues the session, and a marker names it. */
async function plantContinuation(db: LeaseDb, session: Session): Promise<{ copyId: string; copy: string }> {
	const copyId = "01a1f200-0000-7000-8000-0000000000c2";
	const copy = path.join(session.dir, `2026-11-17T00-00-05-000Z_${copyId}.jsonl`);
	const later = "2026-11-17T00:00:05.000Z";
	const planter = await db.open({ claims: false });
	await planter.writeText(
		copy,
		`${[
			{
				type: "session",
				version: 3,
				id: copyId,
				timestamp: later,
				cwd: session.cwd,
				continuationOf: ID,
				parentSession: ID,
			},
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: later,
				message: { role: "user", content: "the copy", timestamp: 2 },
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	// 4de591c2's `<old stem>.continuation` marker, naming the copy.
	await planter.writeText(`${session.file.slice(0, -".jsonl".length)}.continuation`, copyId);
	await planter.drain();
	return { copyId, copy };
}

/** Append a `departed` entry to session {@link ID}, as another process's `omp session moved` does. */
async function appendDeparted(db: LeaseDb, session: Session): Promise<void> {
	const marker = await SessionManager.open(session.file, session.dir, await db.open({ claims: false }), {
		suppressBreadcrumb: true,
	});
	marker.appendCustomMessageEntry(SESSION_TRANSFER_MESSAGE_TYPE, "moved", true, {
		kind: "departed",
		to: "another-box",
	});
	await marker.close();
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`omp --resume of a held SQL session (${adapter})`, () => {
		it("moves a second live process to a fork before session_start, which names X and no continuation, and leaves X alone", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await using holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			const held = await db.row(session.file);

			const second = await LeaseProcess.start(session.config, db.dir.join("second"));
			const resumed = await second.run(resumeById(session, { turns: 2 }));
			await second[Symbol.asyncDispose]();

			expect(resumed.error).toBeUndefined();
			expect(resumed.sessionId).not.toBe(ID);
			expect(resumed.sessionStartId).toBe(resumed.sessionId);
			expect(resumed.notices).toEqual([
				{ reason: "open-elsewhere", from: session.file, to: resumed.sessionFile ?? "" },
			]);
			expect(await db.row(session.file)).toEqual(held);
			const fork = (await db.row(resumed.sessionFile ?? ""))?.content ?? "";
			expect([fork.includes(`resumed by ${second.pid}`), fork.includes(`resumed by ${second.pid} (2)`)]).toEqual([
				true,
				true,
			]);
			// The writer leaves no pointer: a fork of X, and nothing that sends a resume of X to it.
			const { parentSession, continuationOf } = headerOf(fork);
			expect({ parentSession, continuationOf }).toEqual({ parentSession: ID, continuationOf: undefined });
			expect((await db.paths()).filter(file => file.endsWith(".continuation"))).toEqual([]);
			if (adapter === "sqlite") {
				// A held OS lock always means a live holder: no wait.
				expect(resumed.elapsedMs).toBeLessThan(5000);
				expect(resumed.stderr).not.toContain("held by another omp process");
			} else {
				expect(resumed.elapsedMs).toBeGreaterThanOrEqual(RESUME_WAIT_MS - 1000);
				expect(resumed.stderr).toContain(`Session ${ID} is held by another omp process (host `);
				expect(resumed.stderr).toContain(`pid ${holder.pid}); waiting up to 35 s for its lease to expire`);
			}
		}, 90_000);

		it("keeps the id when the holder was killed: the resume waits out its lease and appends to the session", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			const holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			await holder.kill();

			await using second = await LeaseProcess.start(session.config, db.dir.join("second"));
			const resumed = await second.run(resumeById(session));

			expect(resumed.error).toBeUndefined();
			expect([resumed.sessionId, resumed.sessionStartId, resumed.sessionFile]).toEqual([ID, ID, session.file]);
			expect(resumed.notices).toEqual([]);
			const content = (await db.row(session.file))?.content ?? "";
			expect([content.includes(`held by ${holder.pid}`), content.includes(`resumed by ${second.pid}`)]).toEqual([
				true,
				true,
			]);
			if (adapter === "sqlite") {
				// The kernel dropped the dead holder's lock at once, and the resume holds the session now.
				expect(await (await db.open()).acquireSessionClaim?.(ID, session.file)).toBeNull();
			} else {
				// It waited for the dead holder's lease, and holds the session now.
				expect(resumed.stderr).toContain(`pid ${holder.pid}); waiting up to 35 s for its lease to expire`);
				expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([second.pid]);
			}
		}, 90_000);

		it("with --continue, moves a second live process to a minted id before session_start, too", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await using holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			const held = await db.row(session.file);

			await using second = await LeaseProcess.start(session.config, db.dir.join("second"));
			const continued = await second.run(continueRecent(session));

			expect(continued.error).toBeUndefined();
			expect([continued.sessionId === ID, continued.sessionStartId === continued.sessionId]).toEqual([false, true]);
			expect(await db.row(session.file)).toEqual(held);
			if (adapter !== "sqlite") expect(continued.elapsedMs).toBeGreaterThanOrEqual(RESUME_WAIT_MS - 1000);
		}, 90_000);

		it("opens exactly the session an exact --resume id names, following no continuation header or marker", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await plantContinuation(db, session);

			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"));
			const opened = await resumed.run(resumeById(session));

			expect([opened.error, opened.sessionId, opened.sessionFile]).toEqual([undefined, ID, session.file]);
		}, 60_000);

		it("with OMP_SESSION_EXCLUSIVE=1, opens exactly the session a --resume path names, following no continuation", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await plantContinuation(db, session);

			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed.run({
				op: "resume",
				args: ["--session-dir", session.dir, "--resume", session.file],
				cwd: session.cwd,
				sessionStart: true,
			});

			expect([opened.error, opened.sessionId, opened.sessionFile]).toEqual([undefined, ID, session.file]);
		}, 60_000);

		it("with OMP_SESSION_EXCLUSIVE=1, logs a departed entry and opens the session, writing its next turn there", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await appendDeparted(db, session);
			const before = await db.paths();

			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed.run(resumeById(session)).catch((err: unknown) => ({ error: String(err) }));

			expect({
				error: opened.error,
				sessionId: "sessionId" in opened ? opened.sessionId : undefined,
				logged:
					"stderr" in opened &&
					opened.stderr?.includes(`Session ${ID} holds a departed entry (moved to another-box)`),
			}).toEqual({ error: undefined, sessionId: ID, logged: true });
			expect((await db.row(session.file))?.content).toContain(`resumed by ${resumed.pid}`);
			expect(await db.paths()).toEqual(before);
			expect(await exitOf(resumed, 1000)).toBeUndefined();
		}, 60_000);

		it("with the automatic resume, claims the newest session at open without waiting, moving a held one off before session_start", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			await using second = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable },
				db.dir.join("second"),
			);
			const cwd = db.dir.path();
			// The automatic resume looks in the default session directory of the second process's home.
			const dir = (await second.run({ op: "defaultSessionDir", cwd })).sessionDir ?? "";
			const file = path.join(dir, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const writer = await db.open({ claims: false });
			await writer.writeText(file, transcript(ID, "before", cwd));
			await writer.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "hold", file, sessionDir: dir })).sessionId).toBe(ID);
			const held = await db.row(file);

			const resumed = await second.run({
				op: "resume",
				args: [],
				cwd,
				sessionStart: true,
				settings: { autoResume: true },
			});

			expect(resumed.error).toBeUndefined();
			expect([resumed.sessionId === ID, resumed.sessionStartId === resumed.sessionId]).toEqual([false, true]);
			expect(resumed.notices).toEqual([{ reason: "open-elsewhere", from: file, to: resumed.sessionFile ?? "" }]);
			// A start that names no session and picks none never waits.
			expect(resumed.elapsedMs).toBeLessThan(10_000);
			expect(await db.row(file)).toEqual(held);
		}, 60_000);

		for (const via of ["switch", "rpc"] as const) {
			it(`with ${via === "rpc" ? "RPC open_session" : "switchSession"}, takes the lease before the id, so nothing sees X while it waits`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const session = await storedSession(db);
				await using holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
				expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
				const held = await db.row(session.file);

				await using second = await LeaseProcess.start(session.config, db.dir.join("second"));
				const switched = await second.run({
					op: "switch",
					via,
					cwd: session.cwd,
					scratchDir: db.dir.join("scratch"),
					file: session.file,
					dir: session.dir,
				});

				expect(switched.error).toBeUndefined();
				const seenX = [
					...(switched.events ?? []).filter(event => event.id === ID).map(event => event.type),
					...(switched.polled ?? []).filter(id => id === ID).map(() => "poll"),
				];
				expect({ seenX, movedOff: switched.sessionId !== ID }).toEqual({ seenX: [], movedOff: true });
				expect(await db.row(session.file)).toEqual(held);
				if (adapter !== "sqlite") {
					expect(switched.elapsedMs).toBeGreaterThanOrEqual(RESUME_WAIT_MS - 1000);
					// While it waited the manager reported the session it switched from, then the fork.
					expect(switched.polled?.[0]).toBe(switched.scratchId);
				}
			}, 90_000);
		}

		it("claims a fresh session at its first write, so a --resume of it from another process waits and moves off", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const config = { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable };
			const dir = db.dir.join("sessions");
			await using first = await LeaseProcess.start(config, db.dir.join("first"));
			const created = await first.run({ op: "create", cwd: db.dir.path(), sessionDir: dir });
			const freshId = created.sessionId ?? "";
			const before = await db.row(created.sessionFile ?? "");

			await using second = await LeaseProcess.start(config, db.dir.join("second"));
			const resumed = await second.run({
				op: "resume",
				args: ["--session-dir", dir, "--resume", freshId],
				cwd: db.dir.path(),
				sessionStart: true,
			});

			expect(resumed.error).toBeUndefined();
			expect(resumed.sessionId === freshId).toBe(false);
			expect(await db.row(created.sessionFile ?? "")).toEqual(before);
			if (adapter !== "sqlite") expect(resumed.elapsedMs).toBeGreaterThanOrEqual(RESUME_WAIT_MS - 1000);
		}, 90_000);
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`omp --resume <id> under OMP_SESSION_EXCLUSIVE=1 (${adapter})`, () => {
		it("exits non-zero naming the holder when the session is still held after the wait, and writes no sibling", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await using holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			const before = await db.paths();

			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
			const failure = await resumed.run(resumeById(session)).then(
				opened => `opened ${opened.sessionId}`,
				(err: unknown) => String(err),
			);
			const exitCode = await exitOf(resumed, 60_000);

			expect({
				exitCode,
				reason: failure.includes(
					`Session ${ID} stops (open-elsewhere): another omp process holds its lease (host `,
				),
				pid: failure.includes(`pid ${holder.pid})`),
			}).toEqual({ exitCode: 1, reason: true, pid: true });
			expect(await db.paths()).toEqual(before);
		}, 90_000);

		it("exits non-zero when a heartbeat finds its lease taken over, instead of moving to a sibling", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed.run(resumeById(session));
			expect([opened.sessionId, opened.notices]).toEqual([ID, []]);
			const before = await db.row(session.file);

			// Another holder took the lease over; the next heartbeat (every 10 s) finds it.
			await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [ID]);
			const exitCode = await exitOf(resumed, 20_000);

			expect(exitCode).toBe(1);
			expect(await resumed.stderr()).toContain(
				`Session ${ID} stops (open-elsewhere): another omp process took its lease over`,
			);
			expect(await db.paths()).toEqual([session.file]);
			expect(await db.row(session.file)).toEqual(before);
		}, 60_000);

		it("exits non-zero when a heartbeat finds its lease row gone, instead of moving to a sibling", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed.run(resumeById(session));
			expect([opened.sessionId, opened.notices]).toEqual([ID, []]);
			const before = await db.row(session.file);

			// Another holder came, wrote and released: only a release deletes a row.
			await db.sql(`DELETE FROM ${db.leaseTable} WHERE session_id = @1`, [ID]);
			const exitCode = await exitOf(resumed, 20_000);

			expect(exitCode).toBe(1);
			expect(await resumed.stderr()).toContain(`Session ${ID} stops (open-elsewhere)`);
			expect(await db.paths()).toEqual([session.file]);
			expect(await db.row(session.file)).toEqual(before);
		}, 60_000);

		it("takes over a lease whose heartbeat another login set far in the future, within its wait, and runs", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await db.sql(
				`INSERT INTO ${db.leaseTable} (session_id, holder, host, pid, acquired_at, heartbeat_at) ` +
					"VALUES (@1, 'another-login', 'elsewhere', 1, 0, 9223372036854775807)",
				[ID],
			);

			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed
				.run(resumeById(session))
				.catch((err: unknown) => ({ error: String(err), sessionId: undefined, elapsedMs: undefined }));

			expect({ error: opened.error, sessionId: opened.sessionId }).toEqual({ error: undefined, sessionId: ID });
			expect(opened.elapsedMs).toBeLessThan(RESUME_WAIT_MS);
			expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([resumed.pid]);
			expect(await exitOf(resumed, 1000)).toBeUndefined();
		}, 90_000);
	});

	describe.skipIf(!url)(`a stopped holder of a SQL session (${adapter})`, () => {
		it("has its next write after a takeover refused by the database fence, and moves off without writing X", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			// Timings under which the holder's own clock still proves its claim after the stop.
			const still = { ...session.config, lease: { expiryMs: 600_000, heartbeatMs: 300_000 } };
			await using holder = await LeaseProcess.start(still, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			process.kill(holder.pid, "SIGSTOP");
			let taken: (() => void) | null | undefined;
			try {
				// The stopped holder looks dead to the database: another holder takes the lease over.
				await db.ageLease(ID, 660_000);
				taken = await (await db.open({ lease: still.lease })).acquireSessionClaim?.(ID, session.file);
			} finally {
				process.kill(holder.pid, "SIGCONT");
			}
			expect(taken).toBeFunction();
			const before = await db.row(session.file);

			const late = await holder.run({ op: "append", text: "after the takeover" });

			expect({ error: late.error, movedOff: late.sessionId !== ID }).toEqual({ error: undefined, movedOff: true });
			expect(await db.row(session.file)).toEqual(before);
			expect((await db.row(late.sessionFile ?? ""))?.content).toContain("after the takeover");
			taken?.();
		}, 60_000);
	});
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(
		`omp --resume <id> under OMP_SESSION_EXCLUSIVE=1 when an older build writes the file (${adapter})`,
		() => {
			// Through an append: a rewrite a caller asks for rejects a stale view instead (see the manager rows).
			it("exits non-zero naming contested when an append and every full write meet a file an older build changed", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const session = await storedSession(db);
				await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
				expect((await resumed.run(resumeById(session))).sessionId).toBe(ID);

				const failure = await resumed.run({ op: "append", text: "after the older build", contested: true }).then(
					done => `appended ${done.sessionId} ${done.error ?? ""}`,
					(err: unknown) => String(err),
				);
				const exitCode = await exitOf(resumed, 20_000);

				expect({ exitCode, reason: failure.includes(`Session ${ID} stops (contested)`) }).toEqual({
					exitCode: 1,
					reason: true,
				});
				expect(await db.paths()).toEqual([session.file]);
			}, 60_000);

			it("exits non-zero naming replaced when an older build put another session over its file", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const session = await storedSession(db);
				await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"), EXCLUSIVE);
				expect((await resumed.run(resumeById(session))).sessionId).toBe(ID);
				const older = await db.open({ claims: false });
				const replacement = transcript("01a1f200-0000-7000-8000-0000000000d4", "another session", session.cwd);
				await older.writeText(session.file, replacement);
				await older.drain();

				const failure = await resumed.run({ op: "append", text: "after the older build" }).then(
					done => `appended ${done.sessionId} ${done.error ?? ""}`,
					(err: unknown) => String(err),
				);
				const exitCode = await exitOf(resumed, 20_000);

				expect({ exitCode, reason: failure.includes(`Session ${ID} stops (replaced)`) }).toEqual({
					exitCode: 1,
					reason: true,
				});
				expect(await db.paths()).toEqual([session.file]);
				expect((await db.row(session.file))?.content).toBe(replacement);
			}, 60_000);
		},
	);
}

// The same paths on file storage.
describe("omp --resume <id> under OMP_SESSION_EXCLUSIVE=1 on file storage", () => {
	/** Session {@link ID} written to disk in a fresh directory, and a process configuration on file storage. */
	async function fileSession(dir: TempDir): Promise<Session> {
		const cwd = dir.path();
		const sessions = dir.join("sessions");
		const file = path.join(sessions, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		await Bun.write(file, transcript(ID, "before", cwd));
		return { dir: sessions, file, cwd, config: { dsn: "", table: "", leaseTable: "", storage: "file" } };
	}

	it("exits non-zero naming contested when every full write meets a file another writer changed", async () => {
		using dir = TempDir.createSync("@omp-exclusive-contested-");
		const session = await fileSession(dir);
		await using resumed = await LeaseProcess.start(session.config, dir.join("resumed"), EXCLUSIVE);
		expect((await resumed.run(resumeById(session))).sessionId).toBe(ID);

		const failure = await resumed.run({ op: "rewrite", contested: true }).then(
			done => `rewrote ${done.sessionId} ${done.error ?? ""}`,
			(err: unknown) => String(err),
		);
		const exitCode = await exitOf(resumed, 20_000);

		expect({ exitCode, reason: failure.includes(`Session ${ID} stops (contested)`) }).toEqual({
			exitCode: 1,
			reason: true,
		});
		expect(fs.readdirSync(session.dir).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(session.file),
		]);
	}, 60_000);

	it("exits non-zero naming replaced when its file now holds another session", async () => {
		using dir = TempDir.createSync("@omp-exclusive-replaced-");
		const session = await fileSession(dir);
		await using resumed = await LeaseProcess.start(session.config, dir.join("resumed"), EXCLUSIVE);
		expect((await resumed.run(resumeById(session))).sessionId).toBe(ID);
		// Another writer puts another session over the file.
		const replacement = transcript("01a1f200-0000-7000-8000-0000000000d4", "another session", session.cwd);
		await Bun.write(session.file, replacement);

		const failure = await resumed.run({ op: "rewrite" }).then(
			done => `rewrote ${done.sessionId} ${done.error ?? ""}`,
			(err: unknown) => String(err),
		);
		const exitCode = await exitOf(resumed, 20_000);

		expect({ exitCode, reason: failure.includes(`Session ${ID} stops (replaced)`) }).toEqual({
			exitCode: 1,
			reason: true,
		});
		expect(fs.readdirSync(session.dir).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(session.file),
		]);
		expect(await Bun.file(session.file).text()).toBe(replacement);
	}, 60_000);
});
