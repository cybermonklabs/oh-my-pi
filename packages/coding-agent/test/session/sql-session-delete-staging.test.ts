/**
 * A staged full write puts its parts under `<path>#staging-…`, with no session
 * row, and swaps them in at the end. A process killed before the swap leaves
 * those parts behind. When the transcript is a subagent's whose first write
 * was staged, it has no row either, so nothing lists it. Deleting the parent
 * session must still remove every part under the session's artifacts
 * directory, staging parts included. Each case runs against SQLite always and
 * against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, transcript, until } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000e1";
/** Timings under which no heartbeat runs during a case; the test ages the lease itself. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
const PROCESS_SCRIPT = path.join(import.meta.dir, "sql-session-delete-staging-process.ts");

/** Every path in the parts table that starts with `dir`. */
async function partPathsUnder(db: LeaseDb, dir: string): Promise<string[]> {
	const rows = await db.sql(`SELECT DISTINCT path FROM ${db.table}_parts`);
	return rows
		.map(row => String(row.path))
		.filter(stored => stored.startsWith(dir))
		.sort();
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`deleting a SQL session after a killed staged write (${adapter})`, () => {
		it("removes the staging parts a killed first write of a subagent transcript left under its artifacts directory", async () => {
			// If this regresses, a deleted session still leaves the parts of its half-written subagent
			// transcript in the database, where no listing shows them.
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const artifacts = `${file.slice(0, -".jsonl".length)}/`;
			const subagent = `${artifacts}Task.jsonl`;
			const store = await db.open({ lease: STILL });
			const releaseFirst = await store.acquireSessionClaim?.(ID, file);
			await store.writeText(file, transcript(ID, "parent"));
			await store.drain();
			releaseFirst?.();
			await store.drain();

			// Another process takes the session over and dies inside the staged first write of its subagent's transcript.
			const child = Bun.spawn(
				[
					process.execPath,
					PROCESS_SCRIPT,
					JSON.stringify({
						dsn: db.dsn,
						table: db.table,
						leaseTable: db.leaseTable,
						lease: STILL,
						id: ID,
						sessionFile: file,
						file: subagent,
					}),
				],
				{ stdout: "pipe", stderr: "pipe", env: process.env },
			);
			try {
				const reader = child.stdout.getReader();
				let report = "";
				while (!report.includes("\n")) {
					const { done, value } = await reader.read();
					if (done) throw new Error(`the writer exited early: ${await new Response(child.stderr).text()}`);
					report += new TextDecoder().decode(value);
				}
				expect(JSON.parse(report)).toEqual({ staged: true });
			} finally {
				child.kill("SIGKILL");
				await child.exited;
			}
			const left = await partPathsUnder(db, artifacts);
			expect(left.length).toBe(1);
			expect(left[0]?.startsWith(`${subagent}#staging-`)).toBe(true);

			// The dead process's claim is taken over (its lease row looks expired; SQLite's OS lock died with it).
			if (adapter !== "sqlite") await db.ageLease(ID, STILL.expiryMs + 60_000);
			await store.refresh();
			let release: (() => void) | null | undefined;
			await until(async () => {
				release = await store.acquireSessionClaim?.(ID, file);
				return typeof release === "function";
			});
			await store.deleteSessionWithArtifacts(file);
			await store.drain();
			expect({ paths: await db.paths(), parts: await partPathsUnder(db, artifacts) }).toEqual({
				paths: [],
				parts: [],
			});
			release?.();
		}, 120_000);
	});
}
