/**
 * A store gives back, at a signal's exit, every lease row it still holds, whoever took the lease: here a
 * short-lived claimant (as a delete, a rename or a move's destination takes one) whose `finally` a signal skips,
 * since postmortem ends the process after its cleanup callbacks. SIGTERM and SIGINT: the row is gone after exit 143
 * or 130, also when the claim has two references (a shared claim). SIGKILL, the control: nothing runs at exit, so
 * the row stays. Another cleanup callback that keeps the pass open past postmortem's 10 s base deadline (these rows
 * wait for it in real time): one that settles after 11 s under a `deadlineMs` of its own, after which the release
 * still gets its time; one that never settles, before which the release never starts, so the row stays and another
 * store takes it over only once it expired, 30 s after its last heartbeat on the database clock. An
 * `OMP_SESSION_EXCLUSIVE=1` stop, which ends the process by `process.exit` without postmortem's cleanup, gives back
 * the claims the store still holds first. Real processes on PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a server; a SQLite claim is an OS lock the kernel drops.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { openLeaseDb, ROW_LEASE_BACKENDS, transcript } from "./sql-session-lease-fixture";

const CHILD = path.join(import.meta.dir, "sql-session-lease-exit-child.ts");
const ID = "01a1f700-0000-7000-8000-000000000001";
const EXITS = { SIGTERM: 143, SIGINT: 130, SIGKILL: 137 } as const;
/** A launcher-named session another process holds, whose open stops an `OMP_SESSION_EXCLUSIVE=1` process. */
const HELD_ELSEWHERE = "01a1f700-0000-7000-8000-000000000002";
/** The store's lease expiry (`SESSION_LEASE_EXPIRY_MS`), on the database clock. */
const LEASE_EXPIRY_MS = 30_000;
/**
 * How much earlier than the expiry a take-over's `acquired_at` may read: PostgreSQL reads `clock_timestamp()` for
 * the new row's values before it tests the old row's expiry in the same statement.
 */
const TAKE_CLOCK_SLACK_MS = 1000;

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`a store's leases at a signal's exit (${adapter})`, () => {
		const rows: { signal: keyof typeof EXITS; peer?: "long" | "hung"; shared?: boolean; name: string }[] = [
			{ signal: "SIGTERM", name: "gives back a lease no session teardown reaches on SIGTERM" },
			{ signal: "SIGINT", name: "gives back a lease no session teardown reaches on SIGINT" },
			{ signal: "SIGTERM", shared: true, name: "gives back a lease held by two references on SIGTERM" },
			{ signal: "SIGKILL", name: "keeps the row after SIGKILL, since nothing runs at exit (control)" },
			{
				signal: "SIGTERM",
				peer: "long",
				name: "gives the lease back on SIGTERM after another callback held the pass past the base deadline under its own deadlineMs",
			},
			{
				signal: "SIGTERM",
				peer: "hung",
				name: "leaves the row to expire on SIGTERM while another callback never settles, without releasing it before that callback",
			},
		];
		for (const { signal, peer, shared, name } of rows) {
			it(
				name,
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const file = path.join(db.dir.path(), "sessions", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
					const child = Bun.spawn(
						[
							process.execPath,
							CHILD,
							JSON.stringify({
								dsn: db.dsn,
								table: db.table,
								leaseTable: db.leaseTable,
								sessionId: ID,
								file,
								peer,
								shared,
							}),
						],
						{ stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(60_000) },
					);
					const stderr = new Response(child.stderr).text();
					const reader = child.stdout.getReader();
					let out = "";
					while (!out.includes("held\n")) {
						const { done, value } = await reader.read();
						if (done) throw new Error(`the child ended before it held the lease: ${await stderr}`);
						out += new TextDecoder().decode(value);
					}
					const rowsWhileHeld = (await db.leases(ID)).length;
					child.kill(signal);
					const exitCode = await child.exited;
					const rowsAfterExit = (await db.leases(ID)).length;
					const kept = signal === "SIGKILL" || peer === "hung";
					expect({ rowsWhileHeld, exitCode, rowsAfterExit }).toEqual({
						rowsWhileHeld: 1,
						exitCode: EXITS[signal],
						rowsAfterExit: kept ? 1 : 0,
					});
					if (peer !== "hung") return;
					// The row left behind expires as documented: another store is refused it while it is live, and
					// takes it over only once its heartbeat is older than the expiry, on the database clock.
					const column = async (name: string) =>
						Number((await db.sql(`SELECT ${name} FROM ${db.leaseTable} WHERE session_id = @1`, [ID]))[0]?.[name]);
					const lastHeartbeat = await column("heartbeat_at");
					const other = await db.open({ claims: true });
					const refusedWhileLive = (await other.acquireSessionClaim?.(ID, file)) === null;
					const release = await other.acquireSessionClaim?.(ID, file, { waitMs: 45_000 });
					const takenAfterMs = (await column("acquired_at")) - lastHeartbeat;
					release?.();
					await other.drain();
					expect({
						refusedWhileLive,
						taken: typeof release === "function",
						takenAfterExpiry: takenAfterMs >= LEASE_EXPIRY_MS - TAKE_CLOCK_SLACK_MS,
					}).toEqual({ refusedWhileLive: true, taken: true, takenAfterExpiry: true });
				},
				120_000,
			);
		}

		it("gives back a lease it still holds when an exclusive stop ends the process", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = path.join(db.dir.path(), "sessions", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
			const heldFile = path.join(db.dir.path(), "sessions", `2026-11-18T00-00-00-000Z_${HELD_ELSEWHERE}.jsonl`);
			// The other process: a store of this test that holds the launcher-named session.
			const holder = await db.open({ claims: true });
			const releaseHeld = await holder.acquireSessionClaim?.(HELD_ELSEWHERE, heldFile);
			await holder.writeText(heldFile, transcript(HELD_ELSEWHERE, "held elsewhere", "/"));
			await holder.drain();
			const child = Bun.spawn(
				[
					process.execPath,
					CHILD,
					JSON.stringify({
						dsn: db.dsn,
						table: db.table,
						leaseTable: db.leaseTable,
						sessionId: ID,
						file,
						stopOn: heldFile,
					}),
				],
				{
					env: { ...process.env, OMP_SESSION_EXCLUSIVE: "1" },
					stdout: "pipe",
					stderr: "pipe",
					signal: AbortSignal.timeout(60_000),
				},
			);
			const [exitCode, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			const rowsAfterExit = (await db.leases(ID)).length;
			const heldRows = (await db.leases(HELD_ELSEWHERE)).length;
			releaseHeld?.();
			await holder.drain();
			expect({
				exitCode,
				stopped: stderr.includes(`Session ${HELD_ELSEWHERE} stops (open-elsewhere)`),
				rowsAfterExit,
				heldRows,
			}).toEqual({ exitCode: 1, stopped: true, rowsAfterExit: 0, heldRows: 1 });
		}, 60_000);
	});
}
