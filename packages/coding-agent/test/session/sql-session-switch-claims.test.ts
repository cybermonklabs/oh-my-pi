/**
 * `SessionManager.setSessionFile` with a claim on SQL storage that claims sessions, where #66's records of the
 * sessions a manager left and its appends to a left session (`appendCustomEntriesToFile`, a stopped work pool's
 * discards) meet the release's writer claim. Runs against SQLite always and against PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database; a lease taken over needs a lease row, so
 * that case runs on PostgreSQL and MySQL only.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionAcquireOptions, SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	transcript,
	until,
} from "./sql-session-lease-fixture";

/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
/**
 * A heartbeat every half second, and an expiry no case reaches: a store judges another holder's lease stale by its
 * own expiry, so a short one would let the switch take a held target as stale under load.
 */
const HEARTBEAT = { expiryMs: 600_000, heartbeatMs: 500 };
const RECORDS = [
	{ customType: "eval-agent-job", data: { agentId: "Worker", state: "discarded" } },
	{ customType: "eval-agent-job", data: { agentId: "Other", state: "discarded" } },
];
/** Each case takes session ids of its own (`Bun.randomUUIDv7()`): on SQLite a claim is an OS lock this process holds, so a
 * case that fails before it closes its managers must not hold a later case's session. */
function fileOf(db: LeaseDb, id: string): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${id}.jsonl`);
}

/**
 * `store`, whose claims through `acquireSessionClaim` take longer: a writer's claim is held `writerHoldMs` before it
 * answers (a slow database round trip, with the writer slot already taken), another claim waits `otherDelayMs`
 * before it is asked for (an append still on its way).
 */
function slowClaims(store: SqlSessionStorage, { writerHoldMs = 0, otherDelayMs = 0 }): SqlSessionStorage {
	return new Proxy(store, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (property !== "acquireSessionClaim" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (sessionId: string, sessionPath: string, options?: SessionAcquireOptions) => {
				if (!options?.writer && otherDelayMs > 0) await Bun.sleep(otherDelayMs);
				const release = await value.call(target, sessionId, sessionPath, options);
				if (options?.writer && writerHoldMs > 0) await Bun.sleep(writerHoldMs);
				return release;
			};
		},
	});
}

/**
 * `store`, whose claims a switch and an append take in one order of events, whatever the load: the switch's first
 * writer claim calls `onWriterAsk` (which starts the append) and is passed on only once another claim (the
 * append's) has been asked for, and that claim is passed on only once the writer claim has answered. So the append
 * is pending when the switch's claim answers. `counts.writer` counts the writer claims asked for.
 */
function orderedClaims(
	store: SqlSessionStorage,
	onWriterAsk: () => void,
	counts: { writer: number },
): SqlSessionStorage {
	const otherAsked = Promise.withResolvers<void>();
	const writerAnswered = Promise.withResolvers<void>();
	return new Proxy(store, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (property !== "acquireSessionClaim" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (sessionId: string, sessionPath: string, options?: SessionAcquireOptions) => {
				if (options?.writer) {
					counts.writer++;
					if (counts.writer === 1) {
						onWriterAsk();
						await otherAsked.promise;
					}
					const release = await value.call(target, sessionId, sessionPath, options);
					writerAnswered.resolve();
					return release;
				}
				otherAsked.resolve();
				await writerAnswered.promise;
				return value.call(target, sessionId, sessionPath, options);
			};
		},
	});
}

/**
 * `store`, whose reads of `file`'s whole text wait for `gate`: a switch to `file` loads it late. `asked` hears when
 * the first such read is asked for.
 */
function slowLoad(store: SqlSessionStorage, file: string, gate: Promise<void>, asked: () => void): SqlSessionStorage {
	return new Proxy(store, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (property !== "readText" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (readPath: string, ...rest: unknown[]) => {
				if (path.resolve(readPath) === path.resolve(file)) {
					asked();
					await gate;
				}
				return value.call(target, readPath, ...rest);
			};
		},
	});
}

/** A subagent transcript `name` under `parent`'s artifacts directory, as the task tool writes its first line. */
async function writeSubagentTranscript(store: SqlSessionStorage, parent: string, name: string): Promise<string> {
	const file = path.join(parent.slice(0, -".jsonl".length), `${name}.jsonl`);
	await store.writeText(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: "/w" })}\n`,
	);
	return file;
}

/** The data of the records `manager`'s current branch holds of {@link RECORDS}' type. */
function recordsOnBranch(manager: SessionManager): unknown[] {
	return manager
		.getBranch()
		.flatMap(entry => (entry.type === "custom" && entry.customType === "eval-agent-job" ? [entry.data] : []));
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(
		`a switch to a session a stopped pool's discards append to, on SQL storage (${adapter})`,
		() => {
			for (const [when, delays, startAppendAfterMs] of [
				["already running when the switch starts", { writerHoldMs: 800, otherDelayMs: 100 }, 0],
				["started while the switch takes its claim", { writerHoldMs: 600, otherDelayMs: 1500 }, 100],
			] as const) {
				it(`lets an append ${when} land, then takes the session under its id with both records on its branch`, async () => {
					// If this regresses, the switch holds the session's writer claim while the append writes: the append's
					// session meets it and moves to a sibling (a new row holds the records, and the append still answers
					// "appended"), or the switch meets the append's writer and moves the user's session to a sibling.
					await using db = await openLeaseDb(adapter, url ?? "");
					const store = await db.open({ lease: STILL });
					const targetId = Bun.randomUUIDv7();
					const file = fileOf(db, targetId);
					await store.writeText(file, transcript(targetId, "before"));
					await store.drain();
					const before = await db.paths();
					const slow = slowClaims(store, delays);
					const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), slow);

					let appended: Promise<unknown> = Promise.resolve();
					const startAppend = () => {
						appended = SessionManager.appendCustomEntriesToFile(targetId, file, RECORDS, slow).then(
							outcome => outcome,
							(err: unknown) => `rejected: ${String(err)}`,
						);
					};
					if (startAppendAfterMs === 0) startAppend();
					else setTimeout(startAppend, startAppendAfterMs);
					await manager.setSessionFile(file, { claim: { waitMs: 0 } });
					const outcome = await appended;

					expect({
						id: manager.getSessionId(),
						file: manager.getSessionFile(),
						outcome,
						records: recordsOnBranch(manager),
					}).toEqual({ id: targetId, file, outcome: "appended", records: RECORDS.map(record => record.data) });
					await manager.close();
					await store.drain();
					expect(await db.paths()).toEqual(before);
				}, 30_000);
			}
		},
	);

	describe.skipIf(!url)(`a switch to a session another process holds, on SQL storage (${adapter})`, () => {
		it("records the session it left, and not the held one it moved off", async () => {
			// If this regresses, the move off the held session records that session as left: a work pool stopped
			// after the switch then tries to write its discards there, is refused, and warns that it could not record
			// them, though the session was never this manager's.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const targetId = Bun.randomUUIDv7();
			const held = fileOf(db, targetId);
			await store.writeText(held, transcript(targetId, "held elsewhere"));
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: targetId, path: held })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			manager.appendMessage({ role: "user", content: "the session it leaves", timestamp: Date.now() });
			await manager.flush();
			const leftId = manager.getSessionId();
			const leftFile = manager.getSessionFile() ?? "";
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const mark = manager.getLeftSessionsMark();

			await manager.setSessionFile(held, { claim: { waitMs: 0 } });

			const sibling = manager.getSessionFile() ?? "";
			expect({ notices, left: manager.getLeftSessions(mark) }).toEqual({
				notices: [{ reason: "open-elsewhere", from: held, to: sibling }],
				left: [{ id: leftId, file: leftFile }],
			});
			await manager.close();
		}, 30_000);

		it("records the session it left, and not a subagent transcript whose parent another process holds", async () => {
			// If this regresses, the parent follow a refused subagent-transcript claim starts forks the transcript beside
			// its parent and records the held transcript as left: a work pool stopped after the switch then tries to write
			// its discards there, is refused, and warns that it could not record them, though the transcript was never
			// this manager's.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			const child = await writeSubagentTranscript(store, parent, "Worker");
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			manager.appendMessage({ role: "user", content: "the session it leaves", timestamp: Date.now() });
			await manager.flush();
			const leftId = manager.getSessionId();
			const leftFile = manager.getSessionFile() ?? "";
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const mark = manager.getLeftSessionsMark();

			// The transcript's claim is its parent's lease, which the holder has: the switch adopts the refusal and
			// follows the parent, which goes on in no sibling here, so the transcript forks beside the parent.
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			await until(() => notices.length > 0, 10_000);

			const fork = manager.getSessionFile() ?? "";
			expect({ notices, beside: path.dirname(fork), left: manager.getLeftSessions(mark) }).toEqual({
				notices: [{ reason: "open-elsewhere", from: child, to: fork }],
				beside: path.dirname(parent),
				left: [{ id: leftId, file: leftFile }],
			});
			await manager.close();
		}, 60_000);

		it("records no subagent transcript as left when it is adopted while the follow of another one still runs", async () => {
			// If this regresses, the adoption of the second transcript takes the first transcript's follow, still waiting
			// for the parent, as its own: it starts none, the first follow ends at its file check, and the second
			// transcript's next write starts a follow of its own that records it as left when it forks beside the parent.
			// The switch away from the first transcript before its follow forked it records it as left no more than the
			// fork does: it was never this manager's either.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const first = await writeSubagentTranscript(store, parent, "Worker");
			const second = await writeSubagentTranscript(store, parent, "Other");
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			manager.appendMessage({ role: "user", content: "the session it leaves", timestamp: Date.now() });
			await manager.flush();
			const leftId = manager.getSessionId();
			const leftFile = manager.getSessionFile() ?? "";
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const mark = manager.getLeftSessionsMark();

			// The first adoption starts a follow, which waits a second for the parent before it forks; the second
			// adoption comes inside that second.
			await manager.setSessionFile(first, { claim: { waitMs: 0 } });
			await manager.setSessionFile(second, { claim: { waitMs: 0 } });
			manager.appendMessage({ role: "user", content: "after the switch", timestamp: Date.now() });
			await manager.flush();
			await until(() => notices.some(notice => notice.from === second), 10_000);

			expect({
				forked: notices.filter(notice => notice.from === second).length,
				left: manager.getLeftSessions(mark),
			}).toEqual({ forked: 1, left: [{ id: leftId, file: leftFile }] });
			await manager.close();
		}, 60_000);

		it("records no transcript adopted under a refused claim as left when a new session starts from it, and writes that session at once", async () => {
			// If this regresses, /new from a subagent transcript adopted under a refused claim, before its follow forked or
			// moved it, records the transcript as left, though it was never this manager's: a work pool stopped then tries
			// to write its discards there, is refused, and warns that it could not record them. Or the follow still in
			// flight counts as the new session's too (it has the same switch generation), and holds the new session's
			// first write until the follow ends.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(store, parent, "Worker");
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			manager.appendMessage({ role: "user", content: "the session it leaves", timestamp: Date.now() });
			await manager.flush();
			const leftId = manager.getSessionId();
			const leftFile = manager.getSessionFile() ?? "";
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const mark = manager.getLeftSessionsMark();

			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			await manager.newSession();
			const fresh = manager.getSessionFile() ?? "";

			// The adoption's follow forks a second after it at the earliest: /new left the transcript before that, else
			// this run tested nothing.
			expect({ notices, left: manager.getLeftSessions(mark), written: store.existsSync(fresh) }).toEqual({
				notices: [],
				left: [{ id: leftId, file: leftFile }],
				written: true,
			});
			await manager.close();
		}, 60_000);

		it("writes the session it switched to at once while the follow of a transcript it left still waits", async () => {
			// If this regresses, a write holds for any parent follow in flight, also one of a subagent transcript the
			// manager has left: the republish the session it switched to owes (its transcript has a torn record) waits
			// for that follow, up to a second, and writes nothing until then.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(store, parent, "Worker");
			const otherId = Bun.randomUUIDv7();
			const other = fileOf(db, otherId);
			await store.writeText(other, `${transcript(otherId, "a session with a torn record")}{"type":"mess\n`);
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));

			// The adoption starts a follow, which waits a second for the parent before it forks the transcript.
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			await manager.setSessionFile(other, { claim: { waitMs: 0 } });
			const before = store.statSync(other).size;
			manager.appendMessage({ role: "user", content: "written at once", timestamp: Date.now() });
			const after = store.statSync(other).size;

			// The follow had forked nothing yet: else this run tested nothing.
			expect({ notices, file: manager.getSessionFile(), grew: after > before }).toEqual({
				notices: [],
				file: other,
				grew: true,
			});
			await manager.close();
		}, 60_000);

		it("starts no second follow for a write while the follow of a transcript adopted under a refused claim waits", async () => {
			// If this regresses, the follow in flight does not count as the transcript's own: a write while it waits asks
			// for the parent's lease once more and, refused, starts another follow of the same transcript. A write asks
			// once on its own (its check of who holds the session), so each write may ask once, not twice.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			await base.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(base, parent, "Worker");
			await base.drain();
			let asks = 0;
			const store = new Proxy(base, {
				get(t, property) {
					const value: unknown = Reflect.get(t, property, t);
					if (typeof value !== "function") return value;
					if (property !== "claimSession" && property !== "acquireSessionClaim") return value.bind(t);
					return (...args: unknown[]) => {
						asks++;
						return value.apply(t, args);
					};
				},
			}) as SqlSessionStorage;
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));

			// The adoption asks for the transcript's claim (its parent's lease), is refused, and starts a follow that
			// waits a second.
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			const asked = asks;
			const writes = 2;
			for (let n = 0; n < writes; n++) {
				manager.appendMessage({ role: "user", content: `while the follow waits ${n}`, timestamp: Date.now() });
			}

			// The adoption asked, and the follow had forked nothing yet: else this run tested nothing.
			expect({ asked: asked > 0, notices, atMostOncePerWrite: asks - asked <= writes }).toEqual({
				asked: true,
				notices: [],
				atMostOncePerWrite: true,
			});
			await manager.close();
		}, 60_000);

		it("asks once and waits once when another process refuses the claim while an append to the session runs", async () => {
			// If this regresses, the switch takes an append that started during its claim as a reason to claim again,
			// though the refused claim holds no writer slot: it asks a second time, on a store with lease rows waits out
			// `waitMs` a second time, and reports the wait twice.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const targetId = Bun.randomUUIDv7();
			const held = fileOf(db, targetId);
			await store.writeText(held, transcript(targetId, "held elsewhere"));
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: targetId, path: held })).held).toBe(true);
			const counts = { writer: 0 };
			let appended: Promise<unknown> = Promise.resolve();
			// The append starts when the switch asks for its claim, and is still on its way when the refusal comes.
			const ordered: SqlSessionStorage = orderedClaims(
				store,
				() => {
					appended = SessionManager.appendCustomEntriesToFile(targetId, held, RECORDS, ordered).catch(
						() => undefined,
					);
				},
				counts,
			);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), ordered);

			let waits = 0;
			await manager.setSessionFile(held, { claim: { waitMs: 1500, onWait: () => waits++ } });
			await appended;

			// A lease row's holder is reported once per wait. SQLite's claim is an OS lock: it is refused at once,
			// without a wait, and names no holder.
			expect({ claims: counts.writer, waits, movedOff: manager.getSessionId() !== targetId }).toEqual({
				claims: 1,
				waits: adapter === "sqlite" ? 0 : 1,
				movedOff: true,
			});
			await manager.close();
		}, 60_000);

		it("records the fork a follow made while a switch away loaded its target as left, and frees its claim", async () => {
			// If this regresses, the follow of a transcript adopted under a refused claim forks it while the switch
			// loads its target, and the switch either drops the fork's work (no fork, the transcript's entries kept
			// nowhere) or records only what it read before the load: the fork, where the work now is, is never recorded
			// as left, and its claim stays held by this manager.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			await base.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(base, parent, "Worker");
			await base.writeText(target, transcript(targetId, "the session it switches to"));
			await base.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			// The switch's load waits until the follow has forked the transcript (or 10 s pass).
			const gate = Promise.withResolvers<void>();
			let loadAskedAt = 0;
			const store = slowLoad(base, target, gate.promise, () => (loadAskedAt ||= Date.now()));
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			manager.appendMessage({ role: "user", content: "the session it leaves", timestamp: Date.now() });
			await manager.flush();
			const leftId = manager.getSessionId();
			const leftFile = manager.getSessionFile() ?? "";
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => {
				notices.push(notice);
				gate.resolve();
			});
			const mark = manager.getLeftSessionsMark();

			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			const adoptedAt = Date.now();
			setTimeout(() => gate.resolve(), 10_000);
			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			await manager.flush();

			// The switch reached its load before the follow's second was over: else this run tested nothing.
			expect(loadAskedAt - adoptedAt).toBeLessThan(800);
			const fork = notices[0]?.to ?? "";
			const left = manager.getLeftSessions(mark);
			expect({ id: manager.getSessionId(), notices, left: left.map(entry => entry.file) }).toEqual({
				id: targetId,
				notices: [{ reason: "open-elsewhere", from: child, to: fork }],
				left: [leftFile, fork],
			});
			expect(left[0]?.id).toBe(leftId);
			// The fork's claim went with the switch: another process can take it.
			const forkId = left[1]?.id ?? "";
			expect((await holder.run({ op: "claim", sessionId: forkId, path: fork })).held).toBe(true);
			await manager.close();
		}, 60_000);

		it("lands a write made while a switch loads its target in the session left, and frees that session's claim", async () => {
			// If this regresses, the write in the gap claims the session left again (its claim was given up at the
			// drain) and the adoption overwrites that claim unreleased: another process cannot open the session left.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const ownId = Bun.randomUUIDv7();
			const own = fileOf(db, ownId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			await base.writeText(own, transcript(ownId, "the session it leaves"));
			await base.writeText(target, transcript(targetId, "the session it switches to"));
			await base.drain();
			const gate = Promise.withResolvers<void>();
			const live: { manager?: SessionManager } = {};
			const store = slowLoad(base, target, gate.promise, () => {
				// As a pool's spawn record or an extension's timer does: a write while the switch loads its target.
				live.manager?.appendMessage({ role: "user", content: "written during the load", timestamp: Date.now() });
				void live.manager?.flush().finally(() => gate.resolve());
			});
			const manager = await SessionManager.open(own, path.dirname(own), store, { suppressBreadcrumb: true });
			live.manager = manager;
			await manager.claimOpenedSession();
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));

			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			await manager.flush();
			await using other = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("other"),
			);

			const before = { id: manager.getSessionId(), notices };
			const leftFree = (await other.run({ op: "claim", sessionId: ownId, path: own })).held;
			await manager.close();
			expect({
				...before,
				leftFree,
				inLeft: ((await db.row(own))?.content ?? "").includes("written during the load"),
				inTarget: ((await db.row(target))?.content ?? "").includes("written during the load"),
			}).toEqual({ id: targetId, notices: [], leftFree: true, inLeft: true, inTarget: false });
		}, 60_000);

		it("records the sibling a write made while a switch loaded its target moved to, when another process took the session left", async () => {
			// If this regresses, the write in the gap finds the session left held by another process and moves it to a
			// sibling, but the switch records only what it read before the load: the sibling, which holds the write, is
			// never recorded as left, and a work pool stopped after the switch writes no discard records there.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const ownId = Bun.randomUUIDv7();
			const own = fileOf(db, ownId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			await base.writeText(own, transcript(ownId, "the session it leaves"));
			await base.writeText(target, transcript(targetId, "the session it switches to"));
			await base.drain();
			await using other = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("other"),
			);
			const gate = Promise.withResolvers<void>();
			const live: { manager?: SessionManager } = {};
			const store = slowLoad(base, target, gate.promise, () => {
				// The switch gave the session's claim up at its drain; another process takes it, then a write lands.
				void other.run({ op: "claim", sessionId: ownId, path: own }).then(() => {
					live.manager?.appendMessage({ role: "user", content: "written during the load", timestamp: Date.now() });
				});
			});
			const manager = await SessionManager.open(own, path.dirname(own), store, { suppressBreadcrumb: true });
			live.manager = manager;
			await manager.claimOpenedSession();
			const notices: SessionPersistenceNotice[] = [];
			// The load goes on once the write has moved the session off (or 10 s pass).
			manager.onPersistenceNotice(notice => {
				notices.push(notice);
				gate.resolve();
			});
			setTimeout(() => gate.resolve(), 10_000);
			const mark = manager.getLeftSessionsMark();

			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			await manager.flush();

			const sibling = notices[0]?.to ?? "";
			const before = {
				id: manager.getSessionId(),
				notices,
				left: manager.getLeftSessions(mark).map(entry => entry.file),
			};
			await manager.close();
			expect({
				...before,
				inSibling: ((await db.row(sibling))?.content ?? "").includes("written during the load"),
			}).toEqual({
				id: targetId,
				notices: [{ reason: "open-elsewhere", from: own, to: sibling }],
				left: [own, sibling],
				inSibling: true,
			});
		}, 60_000);

		it("keeps a queued write's entry in a recorded session when the switch's drain met another session over the file", async () => {
			// If this regresses, the recovery of the queued write's conflict runs only after the switch set its new file:
			// it finds the file changed, moves nothing, and the entry written after the other session's change is kept
			// in no session at all.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const ownId = Bun.randomUUIDv7();
			const own = fileOf(db, ownId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			await base.writeText(own, transcript(ownId, "before"));
			await base.writeText(target, transcript(targetId, "the session it switches to"));
			await base.drain();
			// The recovery's read of the session left waits until the switch is over (or 3 s pass): a switch that does
			// not wait for the recovery has set its new file by then.
			const switchDone = Promise.withResolvers<void>();
			let armed = false;
			let recoveryReads = 0;
			const store = new Proxy(base, {
				get(t, property) {
					const value: unknown = Reflect.get(t, property, t);
					if (typeof value !== "function") return value;
					if (property !== "readText") return value.bind(t);
					return async (readPath: string, ...rest: unknown[]) => {
						if (armed && path.resolve(readPath) === path.resolve(own)) {
							recoveryReads++;
							await Promise.race([switchDone.promise, Bun.sleep(3000)]);
						}
						return value.call(t, readPath, ...rest);
					};
				},
			}) as SqlSessionStorage;
			const manager = await SessionManager.open(own, path.dirname(own), store, { suppressBreadcrumb: true });
			await manager.claimOpenedSession();
			manager.appendMessage({ role: "user", content: "mine before the change", timestamp: Date.now() });
			await manager.flush();
			const mark = manager.getLeftSessionsMark();
			// An older build, which claims nothing, puts another session over the file; the next append is queued.
			const older = await db.open({ claims: false });
			await older.writeText(own, transcript(Bun.randomUUIDv7(), "another session"));
			await older.drain();
			manager.appendMessage({ role: "user", content: "mine after the change", timestamp: Date.now() });

			armed = true;
			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			switchDone.resolve();
			await manager.flush();
			const left = manager.getLeftSessions(mark).map(entry => path.resolve(entry.file));
			const id = manager.getSessionId();
			await manager.close();
			const holding: string[] = [];
			for (const p of await db.paths()) {
				if (((await db.row(p))?.content ?? "").includes("mine after the change")) holding.push(path.resolve(p));
			}

			// The drain met the other session's journal: else this run tested nothing.
			expect(recoveryReads).toBeGreaterThan(0);
			expect({ id, kept: holding.length > 0, recorded: holding.some(p => left.includes(p)) }).toEqual({
				id: targetId,
				kept: true,
				recorded: true,
			});
		}, 60_000);

		it("records no transcript adopted under a refused claim as left after a switch away from it failed", async () => {
			// If this regresses, the failed switch clears the mark of the held adoption before its load throws, and the
			// next switch away records the transcript as left, though it was never this manager's.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			const broken = fileOf(db, Bun.randomUUIDv7());
			await base.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(base, parent, "Worker");
			await base.writeText(target, transcript(targetId, "the session it switches to"));
			// A file whose first line is no session header: a switch to it fails its load.
			await base.writeText(broken, `${JSON.stringify({ type: "message", id: "m1", parentId: null })}\n`);
			await base.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), base);
			manager.appendMessage({ role: "user", content: "the session it leaves", timestamp: Date.now() });
			await manager.flush();
			const leftId = manager.getSessionId();
			const leftFile = manager.getSessionFile() ?? "";
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const mark = manager.getLeftSessionsMark();

			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			const adoptedAt = Date.now();
			await expect(manager.setSessionFile(broken)).rejects.toThrow("the session header is missing or malformed");
			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			const switchedAt = Date.now();
			await manager.flush();

			// Both switches were over before the follow's second was: else this run tested nothing.
			expect(switchedAt - adoptedAt).toBeLessThan(800);
			expect({ id: manager.getSessionId(), notices, left: manager.getLeftSessions(mark) }).toEqual({
				id: targetId,
				notices: [],
				left: [{ id: leftId, file: leftFile }],
			});
			await manager.close();
		}, 60_000);

		it("lands a write made while a switch resolves its target's blob references in the session left, not at the target's path", async () => {
			// If this regresses, the switch sets its new file before it resolves the target's blob references: a write
			// while it waits for the session database's blob table goes to the target's path under the session left's
			// id, and claims that id there, before the target's own entries replace the manager's.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const ownId = Bun.randomUUIDv7();
			const own = fileOf(db, ownId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			await base.writeText(own, transcript(ownId, "the session it leaves"));
			const timestamp = "2026-11-17T00:00:00.000Z";
			const image = { type: "image", data: `blob:sha256:${"ab".repeat(32)}`, mimeType: "image/png" };
			await base.writeText(
				target,
				`${[
					{ type: "session", version: 3, id: targetId, timestamp, cwd: "/project" },
					{
						type: "message",
						id: "m1",
						parentId: null,
						timestamp,
						message: { role: "user", content: [image], timestamp: 1 },
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);
			await base.drain();
			const live: { manager?: SessionManager } = {};
			let armed = false;
			let blobAsks = 0;
			// The blob table's size lookup, which the switch's load makes for the target's image, waits for a write.
			const store = new Proxy(base, {
				get(t, property) {
					const value: unknown = Reflect.get(t, property, t);
					if (property === "blobTier" && value && typeof value === "object") {
						return new Proxy(value, {
							get(tier, key) {
								const member: unknown = Reflect.get(tier, key, tier);
								if (typeof member !== "function") return member;
								if (key !== "sizes") return member.bind(tier);
								return async (...args: unknown[]) => {
									if (armed && blobAsks++ === 0 && live.manager) {
										live.manager.appendMessage({
											role: "user",
											content: "written during the blob step",
											timestamp: Date.now(),
										});
										await live.manager.flush();
									}
									return member.apply(tier, args);
								};
							},
						});
					}
					return typeof value === "function" ? value.bind(t) : value;
				},
			}) as SqlSessionStorage;
			const manager = await SessionManager.open(own, path.dirname(own), store, { suppressBreadcrumb: true });
			live.manager = manager;
			await manager.claimOpenedSession();

			armed = true;
			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			await manager.flush();
			await using other = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("other"),
			);
			const id = manager.getSessionId();
			const leftFree = (await other.run({ op: "claim", sessionId: ownId, path: own })).held;
			await manager.close();

			// The load asked the blob table about the target's image: else this run tested nothing.
			expect(blobAsks).toBeGreaterThan(0);
			expect({
				id,
				leftFree,
				inLeft: ((await db.row(own))?.content ?? "").includes("written during the blob step"),
				inTarget: ((await db.row(target))?.content ?? "").includes("written during the blob step"),
			}).toEqual({ id: targetId, leftFree: true, inLeft: true, inTarget: false });
		}, 60_000);

		it("lands every write made while a switch drains or loads in the session it was made in, and lets no claim go under a write in flight", async () => {
			// Writes at counted points: one while the switch's first drain closes the session left's writer, two while the
			// switch reads its target, one while it closes the writer those two opened, two after the switch. A write
			// during a close comes once the close has begun, as any write that runs while the switch awaits it. Each write
			// must land in the row of the session whose id the manager had when it was made, at that session's file; every
			// writer the store opened for the session left must be closed; and no claim of the session left may be let go
			// while one of its appends is still in flight. If the switch let the claim go before the appends of the drain
			// or of the load were confirmed, the store's fence could refuse them; if the drain dropped the writer a write
			// opened while it closed the old one, that writer stays open; if the switch set the new file before its drain
			// ended, a write in the drain would carry the session left's entries to the target's path.
			await using db = await openLeaseDb(adapter, url ?? "");
			const base = await db.open({ lease: STILL });
			const ownId = Bun.randomUUIDv7();
			const own = fileOf(db, ownId);
			const targetId = Bun.randomUUIDv7();
			const target = fileOf(db, targetId);
			await base.writeText(own, transcript(ownId, "the session it leaves"));
			await base.writeText(target, transcript(targetId, "the session it switches to"));
			await base.drain();
			const live: { manager?: SessionManager } = {};
			const made: Array<{ text: string; id: string; file: string | undefined }> = [];
			const write = (when: string) => {
				const current = live.manager;
				if (!current) throw new Error("no manager to write with");
				const text = `${when} ${made.length}`;
				made.push({ text, id: current.getSessionId(), file: current.getSessionFile() });
				current.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			};
			let switching = false;
			let loadWrites = 0;
			// The writes made while the switch closed a writer of the session left: "drain" before the load, "close" after.
			const closeWrites: string[] = [];
			const opened: SessionStorageWriter[] = [];
			const closed = new Set<SessionStorageWriter>();
			// Appends of the session left the store has not confirmed yet, and their count at each release of its claim.
			let inFlight = 0;
			const releasedWithInFlight: number[] = [];
			const counted = <T>(promise: Promise<T>): Promise<T> => {
				inFlight++;
				return promise.finally(() => {
					inFlight--;
				});
			};
			const watchRelease = (release: (() => void) | null): (() => void) | null =>
				release &&
				(() => {
					releasedWithInFlight.push(inFlight);
					release();
				});
			const store = new Proxy(base, {
				get(t, property) {
					const value: unknown = Reflect.get(t, property, t);
					if (typeof value !== "function") return value;
					if (property === "readText") {
						return async (readPath: string, ...rest: unknown[]) => {
							if (switching && loadWrites === 0 && path.resolve(readPath) === path.resolve(target)) {
								write("load");
								write("load");
								loadWrites = 2;
							}
							return value.call(t, readPath, ...rest);
						};
					}
					if (property === "claimSession") {
						return (sessionId: string, ...rest: unknown[]) => {
							const release = value.call(t, sessionId, ...rest) as (() => void) | null;
							return sessionId === ownId ? watchRelease(release) : release;
						};
					}
					if (property === "acquireSessionClaim") {
						return async (sessionId: string, ...rest: unknown[]) => {
							const release = (await value.call(t, sessionId, ...rest)) as (() => void) | null;
							return sessionId === ownId ? watchRelease(release) : release;
						};
					}
					if (property === "openWriter") {
						return (writerPath: string, ...rest: unknown[]) => {
							const writer = value.call(t, writerPath, ...rest) as SessionStorageWriter;
							if (path.resolve(writerPath) !== path.resolve(own)) return writer;
							const proxy: SessionStorageWriter = new Proxy(writer, {
								get(w, key) {
									const member: unknown = Reflect.get(w, key, w);
									if (typeof member !== "function") return member;
									if (key === "append" || key === "flush") {
										return (...args: unknown[]) => counted(member.apply(w, args) as Promise<void>);
									}
									if (key !== "close") return member.bind(w);
									return () => {
										closed.add(proxy);
										const closing = member.call(w) as Promise<void>;
										const when = loadWrites === 0 ? "drain" : "close";
										if (switching && !closeWrites.includes(when)) {
											closeWrites.push(when);
											// Once the close has begun: the next thing a caller that awaits it lets run.
											void Promise.resolve().then(() => write(when));
										}
										return closing;
									};
								},
							});
							opened.push(proxy);
							return proxy;
						};
					}
					return value.bind(t);
				},
			}) as SqlSessionStorage;
			const manager = await SessionManager.open(own, path.dirname(own), store, { suppressBreadcrumb: true });
			live.manager = manager;
			await manager.claimOpenedSession();
			// A confirmed write first, so the switch's first drain closes a writer.
			write("before");
			await manager.flush();

			switching = true;
			await manager.setSessionFile(target, { claim: { waitMs: 0 } });
			switching = false;
			write("after");
			write("after");
			await manager.flush();
			await manager.close();
			const homes = new Map([
				[ownId, own],
				[targetId, target],
			]);
			const rows = new Map([
				[ownId, (await db.row(own))?.content ?? ""],
				[targetId, (await db.row(target))?.content ?? ""],
			]);

			// Writes came while the switch read its target, and while it closed the session left's writer before the load
			// (under that session's id) and after it, and its claim was let go: else this run tested nothing. On a store
			// that confirms appends later (PostgreSQL), the close after the load is the drain's, so its write is the
			// session left's too; where an append is durable when it returns (SQLite), nothing is left to drain.
			expect({
				loadWrites,
				closeWrites,
				drainWrite: made.find(entry => entry.text.startsWith("drain "))?.id,
				releases: releasedWithInFlight.length > 0,
				id: manager.getSessionId(),
			}).toEqual({
				loadWrites: 2,
				closeWrites: ["drain", "close"],
				drainWrite: ownId,
				releases: true,
				id: targetId,
			});
			expect({
				releasedWithInFlight: releasedWithInFlight.filter(count => count > 0),
				unclosed: opened.filter(writer => !closed.has(writer)).length,
				misplaced: made.filter(entry => {
					const otherId = entry.id === ownId ? targetId : ownId;
					return (
						entry.file !== homes.get(entry.id) ||
						!(rows.get(entry.id) ?? "").includes(`"${entry.text}"`) ||
						(rows.get(otherId) ?? "").includes(`"${entry.text}"`)
					);
				}),
			}).toEqual({ releasedWithInFlight: [], unclosed: 0, misplaced: [] });
		}, 60_000);

		it("lets the follow of a first adoption not fork a transcript a switch came back to under its claim", async () => {
			// If this regresses, the follow the first adoption started outlives a switch away and back: once the
			// parent's holder has let go, the second adoption holds the transcript's claim, but the first follow, still
			// waiting for the parent, finds the path unchanged and forks the transcript beside its parent.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			const otherId = Bun.randomUUIDv7();
			const other = fileOf(db, otherId);
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(store, parent, "Worker");
			await store.writeText(other, transcript(otherId, "another session"));
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));

			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			const adoptedAt = Date.now();
			await manager.setSessionFile(other, { claim: { waitMs: 0 } });
			await holder.run({ op: "release", sessionId: parentId });
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			const backAt = Date.now();
			await manager.flush();

			// The switch came back before the first follow's second was over: else this run tested nothing.
			expect(backAt - adoptedAt).toBeLessThan(800);
			expect({ file: manager.getSessionFile(), id: manager.getSessionId(), notices }).toEqual({
				file: child,
				id: "Worker",
				notices: [],
			});
			await manager.close();
		}, 60_000);

		it("forks a transcript once when a switch came back to it under a refused claim within the first follow's wait", async () => {
			// If this regresses, the second adoption takes the first adoption's follow, which a switch has outdated, as
			// its own: it starts none, the first follow ends without writing, and the transcript stays held, never forked.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			const otherId = Bun.randomUUIDv7();
			const other = fileOf(db, otherId);
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			const child = await writeSubagentTranscript(store, parent, "Worker");
			await store.writeText(other, transcript(otherId, "another session"));
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: parentId, path: parent })).held).toBe(true);
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));

			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			await manager.setSessionFile(other, { claim: { waitMs: 0 } });
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			// flush() waits for the follow this transcript has now, the second adoption's.
			await manager.flush();

			const fork = manager.getSessionFile() ?? "";
			expect({ notices, beside: path.dirname(fork) }).toEqual({
				notices: [{ reason: "open-elsewhere", from: child, to: fork }],
				beside: path.dirname(parent),
			});
			await manager.close();
		}, 60_000);
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`a switch that waits for another holder's lease, on SQL storage (${adapter})`, () => {
		it("records the sibling a lease loss moved the session to during the wait as left", async () => {
			// If this regresses, the switch reads the session it leaves before its claim waits: a heartbeat that finds
			// the session's lease taken over moves it to a sibling during the wait, the sibling is never recorded as
			// left, and a work pool stopped after the switch writes no discard records there.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: HEARTBEAT });
			const leftId = Bun.randomUUIDv7();
			const targetId = Bun.randomUUIDv7();
			const own = fileOf(db, leftId);
			const target = fileOf(db, targetId);
			await store.writeText(own, transcript(leftId, "the session it leaves"));
			await store.writeText(target, transcript(targetId, "held elsewhere"));
			await store.drain();
			const holder = await db.open({ lease: STILL });
			const releaseHolder = await holder.acquireSessionClaim?.(targetId, target);
			expect(releaseHolder).toBeFunction();
			const manager = await SessionManager.open(own, path.dirname(own), store, { suppressBreadcrumb: true });
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			await manager.claimOpenedSession();
			const mark = manager.getLeftSessionsMark();

			let waited = false;
			const switched = manager.setSessionFile(target, { claim: { waitMs: 15_000, onWait: () => (waited = true) } });
			await until(() => waited);
			await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [leftId]);
			await until(() => notices.length > 0, 5000);
			releaseHolder?.();
			await holder.drain();
			await switched;

			const sibling = notices[0]?.to ?? "";
			expect({
				id: manager.getSessionId(),
				notices,
				left: manager.getLeftSessions(mark).map(left => left.file),
			}).toEqual({
				id: targetId,
				notices: [{ reason: "open-elsewhere", from: own, to: sibling }],
				left: [own, sibling],
			});
			await manager.close();
		}, 60_000);

		it("lets a follow that waited for its parent's sibling move nothing once a switch came back to the transcript under its claim", async () => {
			// If this regresses, the follow of a subagent transcript adopted under a refused claim, waiting for the
			// parent's sibling to get the parent's copy of the transcript, moves it there after the manager switched away
			// and came back to it under a claim of its own: the transcript leaves the path the manager holds, and that
			// claim goes.
			await using db = await openLeaseDb(adapter, url ?? "");
			const parentBase = await db.open({ lease: HEARTBEAT });
			const parentId = Bun.randomUUIDv7();
			const parent = fileOf(db, parentId);
			await parentBase.writeText(parent, transcript(parentId, "the parent"));
			const child = await writeSubagentTranscript(parentBase, parent, "Worker");
			const otherId = Bun.randomUUIDv7();
			const other = fileOf(db, otherId);
			await parentBase.writeText(other, transcript(otherId, "another session"));
			await parentBase.drain();
			// The parent's move to a sibling copies its subagent transcripts there; that copy reads the transcript, and
			// waits for the gate.
			const copyGate = Promise.withResolvers<void>();
			let copyAsked = false;
			const parentStore = new Proxy(parentBase, {
				get(t, property) {
					const value: unknown = Reflect.get(t, property, t);
					if (typeof value !== "function") return value;
					if (property !== "readText") return value.bind(t);
					return async (readPath: string, ...rest: unknown[]) => {
						if (path.resolve(readPath) === path.resolve(child)) {
							copyAsked = true;
							await copyGate.promise;
						}
						return value.call(t, readPath, ...rest);
					};
				},
			}) as SqlSessionStorage;
			const parentManager = await SessionManager.open(parent, path.dirname(parent), parentStore, {
				suppressBreadcrumb: true,
			});
			const parentNotices: SessionPersistenceNotice[] = [];
			parentManager.onPersistenceNotice(notice => parentNotices.push(notice));
			await parentManager.claimOpenedSession();
			// Another holder takes the parent's lease: the parent's heartbeat finds it gone, and the parent moves to a
			// sibling, whose copy of the transcript waits.
			await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [parentId]);
			await until(() => parentNotices.length > 0 && copyAsked, 10_000);

			const store = await db.open({ lease: STILL });
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			// The transcript's claim is the parent's lease, which the other holder has: the adoption is refused, and
			// its follow finds the parent's sibling and waits for the copy.
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			// The other holder lets go: a switch away and back takes the transcript under a claim of its own.
			await db.sql(`DELETE FROM ${db.leaseTable} WHERE session_id = @1`, [parentId]);
			await manager.setSessionFile(other, { claim: { waitMs: 0 } });
			await manager.setSessionFile(child, { claim: { waitMs: 0 } });
			const held = manager.getSessionFile();
			copyGate.resolve();
			// flush() waits for the follow.
			await manager.flush();

			expect({ held, file: manager.getSessionFile() }).toEqual({ held: child, file: child });
			await manager.close();
			await parentManager.close();
		}, 60_000);
	});
}
