/**
 * SQL session storage through PgBouncer in transaction mode, as the
 * agents-postgres pool runs it (PgBouncer 1.25.2): the CLI's store opens,
 * writes a session, claims it, and refreshes its lease on the heartbeat.
 * PgBouncer before 1.26 refuses a `search_path` startup parameter, so the
 * store locks `search_path` in each transaction instead.
 *
 * Runs when `OMP_TEST_PGBOUNCER_DSN` names a database through such a pool,
 * as `session-storage-postgres-pool.test.ts` runs when `OMP_TEST_POSTGRES_DSN`
 * is set. The store makes the CLI's default tables there, so the database
 * should be one no other test uses.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SESSION_LEASE_HEARTBEAT_MS } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { transcript, until } from "./sql-session-lease-fixture";

const PGBOUNCER_DSN = process.env.OMP_TEST_PGBOUNCER_DSN;

interface HeartbeatRow {
	heartbeat_at: number | bigint | string;
}

describe.skipIf(!PGBOUNCER_DSN)("SQL session storage through a transaction-mode PgBouncer", () => {
	it("opens the store, writes, takes a claim and heartbeats through PgBouncer", async () => {
		using dir = TempDir.createSync("@omp-sql-pgbouncer-");
		const dsnFile = dir.join("dsn");
		await Bun.write(dsnFile, PGBOUNCER_DSN ?? "");
		const storage = await resolveSessionStorage({
			settings: Settings.isolated(),
			env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
		});
		// Through the same pool, so the reads below cross it too.
		const monitor = new SQL(PGBOUNCER_DSN ?? "", { max: 1 });
		const id = Bun.randomUUIDv7();
		const file = dir.join(`sessions/-project-/2026-11-17T00-00-00-000Z_${id}.jsonl`);
		const heartbeatAt = async (): Promise<number | undefined> => {
			const rows = (await monitor.unsafe(
				"SELECT heartbeat_at FROM public.omp_session_leases WHERE session_id = $1",
				[id],
			)) as HeartbeatRow[];
			return rows[0] === undefined ? undefined : Number(rows[0].heartbeat_at);
		};
		try {
			const release = await storage.acquireSessionClaim?.(id, file);
			await storage.writeText(file, transcript(id, "through the pool"));
			const writer = storage.openWriter(file);
			await writer.append(`${JSON.stringify({ type: "custom", customType: "pool", data: {} })}\n`);
			await writer.close();
			await storage.drain();
			const claimedAt = await heartbeatAt();
			await until(async () => ((await heartbeatAt()) ?? 0) > (claimedAt ?? 0), SESSION_LEASE_HEARTBEAT_MS + 5000);
			const content = await storage.readText(file);
			release?.();
			await storage.drain();

			expect({
				claimed: typeof release,
				claimedAt: typeof claimedAt,
				written: content.includes("through the pool") && content.includes('"customType":"pool"'),
				leaseAfterRelease: await heartbeatAt(),
			}).toEqual({ claimed: "function", claimedAt: "number", written: true, leaseAfterRelease: undefined });
		} finally {
			await monitor.end();
		}
	}, 60_000);
});
