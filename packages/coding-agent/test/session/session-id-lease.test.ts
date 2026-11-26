/**
 * t-e-38's fresh-session row in its `--session-id X` form: a session started
 * with `--session-id` on SQL session storage takes its lease at its first
 * write, so another process's `--resume` of the id waits and moves off, and
 * another process's `--session-id` of the id waits as that resume does and is
 * then refused, writing nothing. Once the first process lets the session go,
 * `--session-id` of the id resumes it. `--session-id` comes from 06f00eba, so
 * this file exists only where the claim and it are both present: the cut that
 * composes them adds it. SQLite always; PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import { LEASE_BACKENDS, LeaseProcess, openLeaseDb } from "./sql-session-lease-fixture";

const ID = "01a1f500-0000-7000-8000-000000000001";
const RESUME_WAIT_MS = 35_000;

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`omp --session-id on SQL storage (${adapter})`, () => {
		it("takes the lease at its first write, so another process's resume of the id waits and moves off", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const config = { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable };
			const dir = db.dir.join("sessions");
			const cwd = db.dir.path();
			await using first = await LeaseProcess.start(config, db.dir.join("first"));
			const started = await first.run({ op: "resume", args: ["--session-dir", dir, "--session-id", ID], cwd });
			expect([started.error, started.sessionId]).toEqual([undefined, ID]);
			if (adapter !== "sqlite") expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([first.pid]);
			const before = await db.row(started.sessionFile ?? "");

			await using second = await LeaseProcess.start(config, db.dir.join("second"));
			const resumed = await second.run({
				op: "resume",
				args: ["--session-dir", dir, "--resume", ID],
				cwd,
				sessionStart: true,
			});
			expect(resumed.error).toBeUndefined();
			expect([resumed.sessionId === ID, resumed.sessionStartId === resumed.sessionId]).toEqual([false, true]);
			expect(await db.row(started.sessionFile ?? "")).toEqual(before);
			if (adapter !== "sqlite") expect(resumed.elapsedMs).toBeGreaterThanOrEqual(RESUME_WAIT_MS - 1000);

			await using third = await LeaseProcess.start(config, db.dir.join("third"));
			const refused = await third.run({ op: "resume", args: ["--session-dir", dir, "--session-id", ID], cwd });
			expect(refused.error).toContain(`Session "${ID}" is open in another running omp process.`);
			expect(await db.row(started.sessionFile ?? ""), "the refused launch wrote nothing").toEqual(before);
			expect(await db.paths(), "no session but the two of before").toHaveLength(2);

			// The first process lets the session go: the same command now resumes it under its own id.
			await first.run({ op: "closeHeld" });
			await using fourth = await LeaseProcess.start(config, db.dir.join("fourth"));
			const reopened = await fourth.run({ op: "resume", args: ["--session-dir", dir, "--session-id", ID], cwd });
			expect([reopened.error, reopened.sessionId, reopened.sessionFile]).toEqual([
				undefined,
				ID,
				started.sessionFile,
			]);
			expect((await db.row(started.sessionFile ?? ""))?.content).toContain(`resumed by ${fourth.pid}`);
		}, 240_000);
	});
}
