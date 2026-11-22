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
import type { SessionAcquireOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
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
/** Short timings: a heartbeat every half second, an expiry in three. */
const SHORT = { expiryMs: 3000, heartbeatMs: 500 };
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
			const child = path.join(parent.slice(0, -".jsonl".length), "Worker.jsonl");
			await store.writeText(parent, transcript(parentId, "the parent, held elsewhere"));
			await store.writeText(
				child,
				`${JSON.stringify({ type: "session", version: 3, id: "Worker", timestamp: new Date().toISOString(), cwd: "/w" })}\n`,
			);
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
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`a switch that waits for another holder's lease, on SQL storage (${adapter})`, () => {
		it("records the sibling a lease loss moved the session to during the wait as left", async () => {
			// If this regresses, the switch reads the session it leaves before its claim waits: a heartbeat that finds
			// the session's lease taken over moves it to a sibling during the wait, the sibling is never recorded as
			// left, and a work pool stopped after the switch writes no discard records there.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: SHORT });
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
	});
}
