/**
 * Under `OMP_SESSION_EXCLUSIVE=1` a session that loses its file to another writer stops: it seals itself, names the
 * stop on stderr, gives back the claims its store holds, and only then ends the process. Until the process ends, a
 * caller that flushes or closes the session must not be told an entry is saved when storage does not hold it: not the
 * turn whose write met the loss, and not a turn the agent finished during the stop's wait, which the seal drops. Each
 * case holds its store's release of the claims, so the stop waits there and the process lives on, and reads what
 * `flush()`, `flushSync()` and `close()` reported meanwhile. Two paths of the release reach the stop: the recovery of
 * a queued append's write conflict, once an older build put another session over the file (every SQL backend), and a
 * lease another holder took over, which the database fence finds (the backends whose claim is a lease row). SQLite
 * always; PostgreSQL and MySQL (MySQL 8 or MariaDB) when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	transcript,
	until,
} from "./sql-session-lease-fixture";

const ID = "01a1f700-0000-7000-8000-000000000001";
/** Timings under which no heartbeat runs during a test: only a write meets the loss. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

function sessionFile(db: LeaseDb): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

/** `OMP_SESSION_EXCLUSIVE=1` until disposed, as a pod's launcher sets it for the whole process. */
function exclusive(): Disposable {
	const before = process.env.OMP_SESSION_EXCLUSIVE;
	process.env.OMP_SESSION_EXCLUSIVE = "1";
	return {
		[Symbol.dispose]() {
			if (before === undefined) delete process.env.OMP_SESSION_EXCLUSIVE;
			else process.env.OMP_SESSION_EXCLUSIVE = before;
		},
	};
}

/**
 * Hold `storage`'s release of its claims, which a stop awaits before it ends the process, for the rest of the test.
 * `reached` turns true once a stop got there, its stop line written.
 */
function holdClaimRelease(storage: SqlSessionStorage): { reached: boolean } {
	const hold = { reached: false };
	// The store's `releaseHeldClaims` is a readonly field; this store alone gets one that never settles.
	Object.defineProperty(storage, "releaseHeldClaims", {
		value: () => {
			hold.reached = true;
			return new Promise<void>(() => {});
		},
	});
	return hold;
}

/** How `call` ended: `"resolved"`, or the message it rejected with. */
async function outcome(call: Promise<unknown>): Promise<string> {
	return call.then(
		() => "resolved",
		(err: unknown) => (err instanceof Error ? err.message : String(err)),
	);
}

/** Open the session at `file` in `storage` as a resume does, claiming it. */
async function resume(storage: SqlSessionStorage, file: string): Promise<SessionManager> {
	const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
	await manager.claimOpenedSession();
	return manager;
}

/**
 * Call right after the append whose write meets the loss. What the session's callers are told: the flush that waits
 * on that write, then, once the stop reached its release, a turn appended during the stop's wait and its flush,
 * `flushSync()` and `close()`.
 */
async function reportsThroughTheStop(manager: SessionManager, hold: { reached: boolean }) {
	const inFlight = await outcome(manager.flush());
	await until(() => hold.reached, 10_000, { what: "the stop to reach its release of the store's claims" });
	manager.appendMessage(userTurn("finished during the stop's wait"));
	const afterStop = await outcome(manager.flush());
	let sync = "returned";
	try {
		manager.flushSync();
	} catch (err) {
		sync = err instanceof Error ? err.message : String(err);
	}
	return { inFlight, afterStop, sync, closed: await outcome(manager.close()) };
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 stop on SQL storage (${adapter})`, () => {
		it("rejects flush, flushSync and close with the stop once an older build put another session over its file", async () => {
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const manager = await resume(storage, file);
			manager.appendMessage(userTurn("stored before the change"));
			await manager.flush();
			const replacement = transcript("01a1f700-0000-7000-8000-0000000000d5", "another session");
			const older = await db.open({ claims: false });
			await older.writeText(file, replacement);
			await older.drain();

			// The append meets the other session's file: the recovery finds it replaced, and the session stops.
			manager.appendMessage(userTurn("refused by the size check"));
			const reports = await reportsThroughTheStop(manager, hold);

			const stop = expect.stringContaining(`Session ${ID} stops (replaced): its file now holds another session.`);
			expect({
				...reports,
				paths: await db.paths(),
				untouched: (await db.row(file))?.content === replacement,
			}).toEqual({
				inFlight: stop,
				afterStop: stop,
				sync: stop,
				closed: stop,
				paths: [file],
				untouched: true,
			});
		}, 30_000);
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 stop on SQL lease rows (${adapter})`, () => {
		it("rejects flush, flushSync and close with the stop once the fence refused a write after a takeover", async () => {
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			const manager = await resume(storage, file);
			manager.appendMessage(userTurn("stored before the takeover"));
			await manager.flush();
			const before = await db.row(file);
			// This holder looks dead to the database: another holder takes the lease over.
			await db.ageLease(ID, STILL.expiryMs + 60_000);
			const releaseNext = await (await db.open({ lease: STILL })).acquireSessionClaim?.(ID, file);
			expect(releaseNext).toBeFunction();

			// The append's write meets the fence: the claim is lost, and the session stops.
			manager.appendMessage(userTurn("refused by the fence"));
			const reports = await reportsThroughTheStop(manager, hold);

			const stop = expect.stringContaining(
				`Session ${ID} stops (open-elsewhere): another omp process took its lease over.`,
			);
			expect({
				...reports,
				paths: await db.paths(),
				untouched: Bun.deepEquals(await db.row(file), before),
			}).toEqual({
				inFlight: stop,
				afterStop: stop,
				sync: stop,
				closed: stop,
				paths: [file],
				untouched: true,
			});
			releaseNext?.();
		}, 30_000);
	});
}
