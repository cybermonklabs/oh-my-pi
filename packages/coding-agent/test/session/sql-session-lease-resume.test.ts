/**
 * `omp --resume` of a session another omp process holds, on SQL session
 * storage, through the CLI's own `createSessionManager` in real processes.
 * Every open of an existing session waits up to its store's
 * `openClaimWaitMs` (one lease expiry and 5 s by default, 35 s under the
 * default 30 s expiry) for the holder's lease to go or expire; a live holder
 * keeps it, so the resume moves to a minted id before `session_start` sees
 * the held one, and a killed holder's lease expires, so the resume keeps the
 * id. Under `OMP_SESSION_EXCLUSIVE=1` nothing moves the id: the process exits
 * non-zero instead. SQLite takes the kernel's lock, which needs no wait.
 * PostgreSQL and MySQL run when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SESSION_TRANSFER_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { SESSION_OPEN_CLAIM_WAIT_MS } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
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

// These tests run the CLI's resume across real processes, against leases on the database clock, which no fake
// timer reaches. No verdict comes from a clock: a wait ends on what it waits for, a lease gone or the open's own
// wait run out, and each row's timeout is only its guard against a hang. A wait that must run out while the holder
// lives is the store's `openClaimWaitMs`, set short, so it spends no lease expiry of real time; a killed holder's
// lease is aged past its expiry by the row itself once the resume says it waits on it.

// A new id each run: file storage's claim is an OS lock keyed by the session id alone, machine-wide, so two runs of
// this file at once under one fixed id would meet each other's holder.
const ID = Bun.randomUUIDv7();
/**
 * Every row's timeout (`setDefaultTimeout`, below), and only its guard against a hang: twice the longest correct
 * run seen with every lease process's start held 30 s and every non-zero exit held 22 s. Two runs on 2026-11-22 on
 * a box at load 800 to 1,400: 52 of 52 rows passed with the longest at 205.5 s (18:50 to 19:47Z), and 25 of 25
 * named rows passed with the longest at 562.3 s (20:27 to 21:20Z, the MySQL row "moves a second live process to a
 * fork…", in a stretch where other rows also ran 4 to 8 times their usual 70 s).
 */
const ROW_GUARD_MS = 1_125_000;
/**
 * The wait of an open that must end on what it waits for (a killed holder's lease running out) or never begin (a
 * held SQLite lock): as long as the row's guard, so the guard, not the wait, bounds it.
 */
const LONG_WAIT_MS = ROW_GUARD_MS;
setDefaultTimeout(ROW_GUARD_MS);
/** The wait of an open whose holder lives on: it runs out while the holder's 30 s lease holds. */
const HELD_WAIT_MS = 2000;
/** Lease timings under which a process's heartbeat comes soon: a takeover or a lost row is found in a second. */
const SHORT_LEASE = { expiryMs: 3000, heartbeatMs: 500 };
/** Lease timings under which no lease expires and no heartbeat runs within a row, so only the row ages a lease. */
const STILL_LEASE = { expiryMs: 600_000, heartbeatMs: 300_000 };
/** File storage's wait for a holder that is still ending: {@link SESSION_OPEN_CLAIM_WAIT_MS}, which no option moves. */
const FILE_RESUME_WAIT_MS = SESSION_OPEN_CLAIM_WAIT_MS;

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

/** `session`'s store configuration for a process whose open must see its wait run out while the holder lives. */
function heldWait(session: Session): LeaseProcessConfig {
	return { ...session.config, openClaimWaitMs: HELD_WAIT_MS };
}

/** The exit code of `process` when it exits within `ms`, else `undefined`: for a check that it is still running. */
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

			// On SQLite a wait as long as the row: one would show as the row's timeout. Elsewhere one that runs out.
			const second = await LeaseProcess.start(
				adapter === "sqlite" ? { ...session.config, openClaimWaitMs: LONG_WAIT_MS } : heldWait(session),
				db.dir.join("second"),
			);
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
				expect(resumed.stderr).not.toContain("held by another omp process");
			} else {
				// It waited its whole wait while the holder lived, then moved off.
				expect(resumed.elapsedMs).toBeGreaterThanOrEqual(HELD_WAIT_MS - 1000);
				expect(resumed.stderr).toContain(`Session ${ID} is held by another omp process (host `);
				expect(resumed.stderr).toContain(`pid ${holder.pid}); waiting up to 2 s for its lease to expire`);
			}
		});

		it("keeps the id when the holder was killed: the resume waits out its lease and appends to the session", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			// A lease that no clock ends within the row: the row ages it once the resume says it waits on it.
			const still = { ...session.config, lease: STILL_LEASE };
			const holder = await LeaseProcess.start(still, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			await holder.kill();

			await using second = await LeaseProcess.start(
				{ ...still, openClaimWaitMs: LONG_WAIT_MS },
				db.dir.join("second"),
			);
			const resuming = second.run(resumeById(session));
			if (adapter !== "sqlite") {
				// The dead holder's lease is still live: the resume waits on it, naming it, and the lease then expires.
				const waitLine = `pid ${holder.pid}); waiting up to ${LONG_WAIT_MS / 1000} s for its lease to expire`;
				expect(await second.stderrShows(waitLine)).toBe(true);
				await db.ageLease(ID, STILL_LEASE.expiryMs + 60_000);
			}
			const resumed = await resuming;

			expect(resumed.error).toBeUndefined();
			expect([resumed.sessionId, resumed.sessionStartId, resumed.sessionFile]).toEqual([ID, ID, session.file]);
			expect(resumed.notices).toEqual([]);
			const content = (await db.row(session.file))?.content ?? "";
			expect([content.includes(`held by ${holder.pid}`), content.includes(`resumed by ${second.pid}`)]).toEqual([
				true,
				true,
			]);
			if (adapter === "sqlite") {
				// The kernel dropped the dead holder's lock at once, so the resume never waited, and it holds the session now.
				expect(resumed.stderr).not.toContain("held by another omp process");
				expect(await (await db.open()).acquireSessionClaim?.(ID, session.file)).toBeNull();
			} else {
				// It took the expired lease over, and holds the session now.
				expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([second.pid]);
			}
		});

		it("with --continue, moves a second live process to a minted id before session_start, too", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await using holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
			expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
			const held = await db.row(session.file);

			await using second = await LeaseProcess.start(heldWait(session), db.dir.join("second"));
			const continued = await second.run(continueRecent(session));

			expect(continued.error).toBeUndefined();
			expect([continued.sessionId === ID, continued.sessionStartId === continued.sessionId]).toEqual([false, true]);
			expect(await db.row(session.file)).toEqual(held);
			if (adapter !== "sqlite") expect(continued.elapsedMs).toBeGreaterThanOrEqual(HELD_WAIT_MS - 1000);
		});

		it("opens exactly the session an exact --resume id names, following no continuation header or marker", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await plantContinuation(db, session);

			await using resumed = await LeaseProcess.start(session.config, db.dir.join("resumed"));
			const opened = await resumed.run(resumeById(session));

			expect([opened.error, opened.sessionId, opened.sessionFile]).toEqual([undefined, ID, session.file]);
		});

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
		});

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
		});

		it("with the automatic resume, claims the newest session at open without waiting, moving a held one off before session_start", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			// A wait as long as the row: one would show as the row's timeout.
			await using second = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, openClaimWaitMs: LONG_WAIT_MS },
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
			expect(resumed.stderr).not.toContain("held by another omp process");
			expect(await db.row(file)).toEqual(held);
		});

		for (const via of ["switch", "rpc"] as const) {
			it(`with ${via === "rpc" ? "RPC open_session" : "switchSession"}, takes the lease before the id, so nothing sees X while it waits`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const session = await storedSession(db);
				await using holder = await LeaseProcess.start(session.config, db.dir.join("holder"));
				expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
				const held = await db.row(session.file);

				await using second = await LeaseProcess.start(heldWait(session), db.dir.join("second"));
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
					...(switched.waitedOn === ID ? ["wait"] : []),
				];
				expect({ seenX, movedOff: switched.sessionId !== ID }).toEqual({ seenX: [], movedOff: true });
				expect(await db.row(session.file)).toEqual(held);
				if (adapter !== "sqlite") {
					expect(switched.elapsedMs).toBeGreaterThanOrEqual(HELD_WAIT_MS - 1000);
					// When its claim started to wait, the manager still reported the session it switched from.
					expect(switched.waitedOn).toBe(switched.scratchId);
					// The switch gave its claim the store's wait, not the fixed 35 s.
					expect(switched.claimWaitMs).toBe(HELD_WAIT_MS);
				}
			});
		}

		it("claims a fresh session at its first write, so a --resume of it from another process waits and moves off", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const config = { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable };
			const dir = db.dir.join("sessions");
			await using first = await LeaseProcess.start(config, db.dir.join("first"));
			const created = await first.run({ op: "create", cwd: db.dir.path(), sessionDir: dir });
			const freshId = created.sessionId ?? "";
			const before = await db.row(created.sessionFile ?? "");

			await using second = await LeaseProcess.start(
				{ ...config, openClaimWaitMs: HELD_WAIT_MS },
				db.dir.join("second"),
			);
			const resumed = await second.run({
				op: "resume",
				args: ["--session-dir", dir, "--resume", freshId],
				cwd: db.dir.path(),
				sessionStart: true,
			});

			expect(resumed.error).toBeUndefined();
			expect(resumed.sessionId === freshId).toBe(false);
			expect(await db.row(created.sessionFile ?? "")).toEqual(before);
			if (adapter !== "sqlite") expect(resumed.elapsedMs).toBeGreaterThanOrEqual(HELD_WAIT_MS - 1000);
		});
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

			await using resumed = await LeaseProcess.start(heldWait(session), db.dir.join("resumed"), EXCLUSIVE);
			const failure = await resumed.run(resumeById(session)).then(
				opened => `opened ${opened.sessionId}`,
				(err: unknown) => String(err),
			);
			const exitCode = await resumed.exited;

			expect({
				exitCode,
				reason: failure.includes(
					`Session ${ID} stops (open-elsewhere): another omp process holds its lease (host `,
				),
				pid: failure.includes(`pid ${holder.pid})`),
			}).toEqual({ exitCode: 1, reason: true, pid: true });
			expect(await db.paths()).toEqual(before);
		});

		it("exits non-zero when a heartbeat finds its lease taken over, instead of moving to a sibling", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			// A heartbeat every half second, so the next one comes soon after the takeover.
			const resumedConfig = { ...session.config, lease: SHORT_LEASE };
			await using resumed = await LeaseProcess.start(resumedConfig, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed.run(resumeById(session));
			expect([opened.sessionId, opened.notices]).toEqual([ID, []]);
			const before = await db.row(session.file);

			// Another holder took the lease over; the next heartbeat finds it.
			await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [ID]);
			const exitCode = await resumed.exited;

			expect(exitCode).toBe(1);
			expect(await resumed.stderr()).toContain(
				`Session ${ID} stops (open-elsewhere): another omp process took its lease over`,
			);
			expect(await db.paths()).toEqual([session.file]);
			expect(await db.row(session.file)).toEqual(before);
		});

		it("exits non-zero when a heartbeat finds its lease row gone, instead of moving to a sibling", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			const resumedConfig = { ...session.config, lease: SHORT_LEASE };
			await using resumed = await LeaseProcess.start(resumedConfig, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed.run(resumeById(session));
			expect([opened.sessionId, opened.notices]).toEqual([ID, []]);
			const before = await db.row(session.file);

			// Another holder came, wrote and released: only a release deletes a row. The next heartbeat finds it gone.
			await db.sql(`DELETE FROM ${db.leaseTable} WHERE session_id = @1`, [ID]);
			const exitCode = await resumed.exited;

			expect(exitCode).toBe(1);
			expect(await resumed.stderr()).toContain(`Session ${ID} stops (open-elsewhere)`);
			expect(await db.paths()).toEqual([session.file]);
			expect(await db.row(session.file)).toEqual(before);
		});

		it("takes over a lease whose heartbeat another login set far in the future, within its wait, and runs", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const session = await storedSession(db);
			await db.sql(
				`INSERT INTO ${db.leaseTable} (session_id, holder, host, pid, acquired_at, heartbeat_at) ` +
					"VALUES (@1, 'another-login', 'elsewhere', 1, 0, 9223372036854775807)",
				[ID],
			);

			// A wait as long as the row: a takeover that waited it out would show as the row's timeout.
			const resumedConfig = { ...session.config, openClaimWaitMs: LONG_WAIT_MS };
			await using resumed = await LeaseProcess.start(resumedConfig, db.dir.join("resumed"), EXCLUSIVE);
			const opened = await resumed
				.run(resumeById(session))
				.catch((err: unknown) => ({ error: String(err), sessionId: undefined, stderr: undefined }));

			expect({ error: opened.error, sessionId: opened.sessionId }).toEqual({ error: undefined, sessionId: ID });
			// It took the lease over at its first claim, without waiting for it.
			expect(opened.stderr).not.toContain("held by another omp process");
			expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([resumed.pid]);
			expect(await exitOf(resumed, 1000)).toBeUndefined();
		});
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

			expect({ error: late.error, movedOff: late.sessionId !== ID }).toEqual({
				error: undefined,
				movedOff: true,
			});
			expect(await db.row(session.file)).toEqual(before);
			expect((await db.row(late.sessionFile ?? ""))?.content).toContain("after the takeover");
			taken?.();
		});
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
				const exitCode = await resumed.exited;

				expect({ exitCode, reason: failure.includes(`Session ${ID} stops (contested)`) }).toEqual({
					exitCode: 1,
					reason: true,
				});
				expect(await db.paths()).toEqual([session.file]);
			});

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
				const exitCode = await resumed.exited;

				expect({ exitCode, reason: failure.includes(`Session ${ID} stops (replaced)`) }).toEqual({
					exitCode: 1,
					reason: true,
				});
				expect(await db.paths()).toEqual([session.file]);
				expect((await db.row(session.file))?.content).toBe(replacement);
			});
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
		const exitCode = await resumed.exited;

		expect({ exitCode, reason: failure.includes(`Session ${ID} stops (contested)`) }).toEqual({
			exitCode: 1,
			reason: true,
		});
		expect(fs.readdirSync(session.dir).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(session.file),
		]);
	});

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
		const exitCode = await resumed.exited;

		expect({ exitCode, reason: failure.includes(`Session ${ID} stops (replaced)`) }).toEqual({
			exitCode: 1,
			reason: true,
		});
		expect(fs.readdirSync(session.dir).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(session.file),
		]);
		expect(await Bun.file(session.file).text()).toBe(replacement);
	});

	/** What a resume that waits on another holder's file lease says on stderr when it starts to wait. */
	const WAIT_LINE = `Session ${ID} is held by another omp process; waiting up to 35 s for its lease to go`;

	// A launcher starts the next process on a session while the one before it is still ending (`--resume=<file>
	// --mode rpc`, with OMP_SESSION_EXCLUSIVE=1).
	it("waits for a holder that ends within the wait, then resumes the session under its own id", async () => {
		using dir = TempDir.createSync("@omp-exclusive-wait-");
		const session = await fileSession(dir);
		await using holder = await LeaseProcess.start(session.config, dir.join("holder"));
		expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
		const holderPid = holder.pid;

		await using resumed = await LeaseProcess.start(session.config, dir.join("resumed"), EXCLUSIVE);
		const resuming = resumed.run(resumeById(session));
		// The holder ends only once the resume says it waits on the holder's lease.
		const waiting = await resumed.stderrShows(WAIT_LINE);
		await holder[Symbol.asyncDispose]();
		const report = await resuming;
		const after = await resumed.run({ op: "append", text: "after the wait" });

		expect({
			waiting,
			error: report.error,
			sessionId: report.sessionId,
			sessionFile: report.sessionFile,
			sessionStartId: report.sessionStartId,
			afterSessionId: after.sessionId,
			afterSessionFile: after.sessionFile,
		}).toEqual({
			waiting: true,
			error: undefined,
			sessionId: ID,
			sessionFile: session.file,
			sessionStartId: ID,
			afterSessionId: ID,
			afterSessionFile: session.file,
		});
		expect(fs.readdirSync(session.dir).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(session.file),
		]);
		const content = await Bun.file(session.file).text();
		expect([
			content.includes(`held by ${holderPid}`),
			content.includes(`resumed by ${resumed.pid}`),
			content.includes("after the wait"),
		]).toEqual([true, true, true]);
	});

	it("exits non-zero naming open-elsewhere when the holder still holds the session after the wait, and writes nothing", async () => {
		using dir = TempDir.createSync("@omp-exclusive-wait-bound-");
		const session = await fileSession(dir);
		await using holder = await LeaseProcess.start(session.config, dir.join("holder"));
		expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
		const before = await Bun.file(session.file).text();

		await using resumed = await LeaseProcess.start(session.config, dir.join("resumed"), EXCLUSIVE);
		const started = performance.now();
		const failure = await resumed.run(resumeById(session)).then(
			done => `resumed ${done.sessionId} ${done.error ?? ""}`,
			(err: unknown) => String(err),
		);
		const exitCode = await resumed.exited;
		const elapsedMs = performance.now() - started;

		expect({
			exitCode,
			waited: failure.includes(WAIT_LINE),
			stopped: failure.includes(`Session ${ID} stops (open-elsewhere): another omp process holds it.`),
			waitedOut: elapsedMs >= FILE_RESUME_WAIT_MS,
		}).toEqual({ exitCode: 1, waited: true, stopped: true, waitedOut: true });
		expect(fs.readdirSync(session.dir).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(session.file),
		]);
		expect(await Bun.file(session.file).text()).toBe(before);
	});

	it("gives the session up when its manager closes while the claim waits, so the closed manager never takes it back", async () => {
		using dir = TempDir.createSync("@omp-exclusive-wait-close-");
		const session = await fileSession(dir);
		await using holder = await LeaseProcess.start(session.config, dir.join("holder"));
		expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);

		await using waiter = await LeaseProcess.start(session.config, dir.join("waiter"), EXCLUSIVE);
		const opened = await waiter.run({
			op: "openWaiting",
			file: session.file,
			sessionDir: session.dir,
			waitMs: FILE_RESUME_WAIT_MS,
		});
		await waiter.run({ op: "closeWaiting" });
		// The holder ends after the close, while the closed manager's claim would still be waiting.
		await holder[Symbol.asyncDispose]();
		const settled = await waiter.run({ op: "settleWaiting" });

		expect({ waiting: opened.waiting, heldAfterSettle: settled.held }).toEqual({
			waiting: true,
			heldAfterSettle: false,
		});
	});

	it("does not stop the process when its manager closes as the claim starts to wait and the wait is over before it looks again", async () => {
		using dir = TempDir.createSync("@omp-exclusive-wait-close-early-");
		const session = await fileSession(dir);
		await using holder = await LeaseProcess.start(session.config, dir.join("holder"));
		expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
		const before = await Bun.file(session.file).text();

		const waiter = await LeaseProcess.start(session.config, dir.join("waiter"), EXCLUSIVE);
		const opened = await waiter
			.run({ op: "openWaiting", file: session.file, sessionDir: session.dir, waitMs: 50, closeOnWait: true })
			.then(
				report => ({ waiting: report.waiting }),
				(err: unknown) => ({ error: String(err) }),
			);
		// The claim settles without stopping the process; the holder still holds the session.
		const settled = await waiter.run({ op: "settleWaiting" }).then(
			() => "settled",
			(err: unknown) => String(err),
		);
		await waiter[Symbol.asyncDispose]();
		const stderr = await waiter.stderr();

		expect({
			opened,
			settled,
			exitCode: await waiter.exited,
			stopped: stderr.includes(`Session ${ID} stops (`),
		}).toEqual({ opened: { waiting: true }, settled: "settled", exitCode: 0, stopped: false });
		expect(await Bun.file(session.file).text()).toBe(before);
	});
});
