/**
 * `SessionManager.appendCustomEntriesToFile` on SQL storage that claims sessions: it claims the session through
 * `acquireSessionClaim`, which answers only once the database has, as `renameSessionTitle` does, before it loads
 * the transcript. A PostgreSQL or MySQL store's `claimSession` answers at once and learns only later that another
 * process holds the session, so an append claimed that way would load and write a session it does not hold. Runs
 * against SQLite always and against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL`
 * name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	type LeaseProcessConfig,
	openLeaseDb,
	transcript,
} from "./sql-session-lease-fixture";

const ID = "01a1f200-0000-7000-8000-000000000001";
/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
const RECORDS = [
	{ customType: "eval-agent-job", data: { agentId: "Worker", state: "delivered" } },
	{ customType: "eval-agent-job", data: { agentId: "Other", state: "delivered" } },
];

function sessionFile(db: LeaseDb): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
}

function processConfig(db: LeaseDb): LeaseProcessConfig {
	return { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL };
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`SessionManager.appendCustomEntriesToFile on SQL storage (${adapter})`, () => {
		it("appends the entries after the session's last entry when no other process holds it", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();

			expect(await SessionManager.appendCustomEntriesToFile(ID, file, RECORDS, storage)).toBe("appended");
			await storage.drain();

			const entries = ((await db.row(file))?.content ?? "")
				.split("\n")
				.filter(line => line.trim() !== "")
				.map(line => JSON.parse(line) as { type: string; id?: string; parentId?: string | null; data?: unknown });
			const appended = entries.slice(-2);
			expect({
				types: appended.map(entry => entry.type),
				data: appended.map(entry => entry.data),
				parent: appended[0]?.parentId,
			}).toEqual({
				types: ["custom", "custom"],
				data: RECORDS.map(record => record.data),
				parent: entries.at(-3)?.id,
			});
		});

		it("writes nothing while another process holds the session", async () => {
			// If this regresses to an optimistic claim, a PostgreSQL or MySQL store loads the session and writes the
			// entries before it learns that the other process holds it.
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const before = await db.row(file);
			await using other = await LeaseProcess.start(processConfig(db), db.dir.join("home"));
			expect((await other.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);
			// On a store with lease rows, the other process's claim is its row: a setup that missed it fails here, not
			// as an append that was not refused.
			if (adapter !== "sqlite") {
				expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([other.pid]);
			}

			const outcome = await SessionManager.appendCustomEntriesToFile(ID, file, RECORDS, storage).then(
				result => result,
				(err: unknown) => `rejected: ${String(err)}`,
			);
			await storage.drain();

			expect({ outcome, unchanged: Bun.deepEquals(await db.row(file), before) }).toEqual({
				outcome: "refused",
				unchanged: true,
			});
		}, 30_000);
	});
}
