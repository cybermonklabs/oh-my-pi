/**
 * Session leases under `session.sql.offboxCheck` (`OffboxSessionStorage`).
 * A new session takes the file lease while its verdict is pending; an
 * allowed one trades it for the SQL lease before its first database write,
 * a refused one keeps the file lease and never names the lease table, and an
 * existing database session refused at its first write trades its SQL lease
 * for the file lease. The lease probe reports both kinds. SQLite always;
 * PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { OffboxSessionStorage } from "@oh-my-pi/pi-coding-agent/session/offbox-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isSessionLeaseHeld } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { probeStorageSessionLeases } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SESSION_LEASE_EXPIRY_MS } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { converse, OffboxFixture } from "../helpers/offbox-check";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, SqlSessionHolder } from "../helpers/sql-lease-fixture";

/** Every test runs the check program, a process of its own; a loaded box takes seconds. */
const TEST_MS = 60_000;

/** The storage `sql` with the check installs, over the fixture's tables; `record` collects its statements. */
function offbox(db: LeaseDb, fx: OffboxFixture, record?: string[]): Promise<OffboxSessionStorage> {
	return OffboxSessionStorage.create({
		check: fx.check(),
		openDatabase: wrapBackend => db.open({ wrapBackend, record }),
	});
}

function allowedDir(db: LeaseDb): string {
	return path.join(db.root, "-work-allowed");
}

function refusedDir(db: LeaseDb): string {
	return path.join(db.root, "-work-refuse-me");
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`${adapter} session leases under the off-box check`, () => {
		it(
			"an allowed new session holds the SQL lease, so a second process's append goes to a sibling",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const fx = new OffboxFixture(db.dir);
				const manager = SessionManager.create(fx.allowedCwd, allowedDir(db), await offbox(db, fx));
				const id = manager.getSessionId();
				try {
					converse(manager, "allowed reply");
					await manager.flush();
					const file = manager.getSessionFile() as string;
					expect((await db.row(file))?.content).toContain("allowed reply");
					expect(fs.existsSync(file)).toBe(false);
					expect(await db.leases(id)).toHaveLength(1);
					// The file lease it held while the verdict was pending is released.
					expect(isSessionLeaseHeld(id)).toBe(false);

					const { holder } = await SqlSessionHolder.open(db, file);
					await using _holder = holder;
					const second = await holder.append("second process's turn");
					expect(second.error).toBeUndefined();
					expect(second.file).not.toBe(file);
					expect((await db.row(file))?.content).not.toContain("second process's turn");
					expect((await db.row(second.file))?.content).toContain("second process's turn");
					await holder.exit();
				} finally {
					await manager.close();
				}
				expect(await db.leases(id)).toEqual([]);
			},
			TEST_MS,
		);

		it(
			"a refused session keeps the file lease and never names the lease table",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const fx = new OffboxFixture(db.dir);
				const record: string[] = [];
				const storage = await offbox(db, fx, record);
				const manager = SessionManager.create(fx.refusedCwd, refusedDir(db), storage);
				const id = manager.getSessionId();
				converse(manager, "refused reply");
				await manager.flush();
				const file = manager.getSessionFile() as string;
				expect(fs.readFileSync(file, "utf8")).toContain("refused reply");
				expect(isSessionLeaseHeld(id)).toBe(true);
				converse(manager, "second refused reply");
				await manager.close();
				await storage.drain();

				expect(record.filter(query => query.includes(db.leaseTable))).toEqual([]);
				expect(await db.leases(id)).toEqual([]);
				expect(await db.row(file)).toBeUndefined();
				expect(isSessionLeaseHeld(id)).toBe(false);
			},
			TEST_MS,
		);

		it(
			"an existing database session refused at its first write trades its SQL lease for the file lease",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const fx = new OffboxFixture(db.dir);
				const id = "01a1880d-eeee-7000-9000-000000000005";
				const file = path.join(refusedDir(db), `2026-11-03T00-00-00-000Z_${id}.jsonl`);
				const timestamp = "2026-11-03T00:00:00.000Z";
				const plain = await db.open();
				await plain.writeText(
					file,
					`${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: fx.refusedCwd })}\n` +
						`${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: "stored", timestamp: 1 } })}\n`,
				);
				await plain.drain();

				const storage = await offbox(db, fx);
				const manager = await SessionManager.open(file, refusedDir(db), storage, { suppressBreadcrumb: true });
				try {
					converse(manager, "refused at its first write");
					await manager.flush();
					await storage.drain();
					expect(manager.getSessionFile()).toBe(file);
					expect(fs.readFileSync(file, "utf8")).toContain("refused at its first write");
					expect(isSessionLeaseHeld(id)).toBe(true);
					expect(await db.leases(id)).toEqual([]);
				} finally {
					await manager.close();
				}
			},
			TEST_MS,
		);

		it(
			"an allowed session that loses its lease moves to a sibling that is still allowed and leased",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const fx = new OffboxFixture(db.dir);
				const manager = SessionManager.create(fx.allowedCwd, allowedDir(db), await offbox(db, fx));
				const id = manager.getSessionId();
				try {
					converse(manager, "before the takeover");
					await manager.flush();
					const file = manager.getSessionFile() as string;

					// The holder looks dead to the database: another process takes the lease over.
					await db.ageLease(id, SESSION_LEASE_EXPIRY_MS + 30_000);
					const taker = await db.open();
					const release = taker.claimSession(id, file);
					await taker.refresh({ kind: "session", file });
					await taker.openWriter(file).append('{"type":"taker"}\n');
					expect((await db.leases(id)).map(lease => lease.holder)).toHaveLength(1);

					converse(manager, "after the takeover");
					await manager.flush();
					const sibling = manager.getSessionFile() as string;
					const siblingId = manager.getSessionId();
					expect(sibling).not.toBe(file);
					expect(path.dirname(sibling)).toBe(path.dirname(file));
					expect((await db.row(file))?.content).not.toContain("after the takeover");
					const moved = (await db.row(sibling))?.content ?? "";
					expect(moved).toContain("before the takeover");
					expect(moved).toContain("after the takeover");
					expect(fs.existsSync(sibling)).toBe(false);
					expect(await db.leases(siblingId)).toHaveLength(1);
					expect(isSessionLeaseHeld(siblingId)).toBe(false);
					release();
				} finally {
					await manager.close();
				}
			},
			TEST_MS,
		);

		it(
			"the lease probe reports a file-leased refused session and an SQL-leased allowed one",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const fx = new OffboxFixture(db.dir);
				const storage = await offbox(db, fx);
				const refused = SessionManager.create(fx.refusedCwd, refusedDir(db), storage);
				const allowed = SessionManager.create(fx.allowedCwd, allowedDir(db), storage);
				const ids = [refused.getSessionId(), allowed.getSessionId()];
				converse(refused, "refused reply");
				converse(allowed, "allowed reply");
				await refused.flush();
				await allowed.flush();

				const report = await probeStorageSessionLeases(storage, [...ids, "no-such-session"], "omp session lease");
				expect(report).toEqual({ held: ids, unknown: [] });

				await refused.close();
				await allowed.close();
				expect(await probeStorageSessionLeases(storage, ids, "omp session lease")).toEqual({
					held: [],
					unknown: [],
				});
			},
			TEST_MS,
		);
	});
}
