/**
 * A SQLite session claim made while another process is letting the same
 * session go is taken once that holder has let go: the claim tries the
 * session's OS lock again for {@link SQLITE_CLAIM_RELEASE_WINDOW_MS} and does
 * not refuse a session whose holder releases it within that window.
 */
import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { SQLITE_CLAIM_RELEASE_WINDOW_MS, type SqlSessionStorage } from "../../src/session/sql-session-storage";
import { type LeaseDb, openLeaseDb } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-00000000c001";
/** When, on the claim's clock, the stubbed holder lets the session go: after the claim began, inside its window. */
const LETS_GO_AT_MS = 20;

function sessionFile(db: LeaseDb): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-19T00-00-00-000Z_${ID}.jsonl`);
}

/**
 * Claim `ID` at `file` while `held(clock)` says another process holds the
 * session's lock: each native claim of a lock is refused while it does, and
 * is the real claim after. The claim runs on a clock of its own, which
 * `performance.now()` reads and each `Bun.sleep` moves on by its length at
 * once, so the window is counted in the claim's own steps whatever the
 * host's load. Returns the claim's answer and its clock when it answered.
 */
async function claimOnOwnClock(
	db: LeaseDb,
	storage: SqlSessionStorage,
	held: (clock: number) => boolean,
): Promise<{ release: (() => void) | null | undefined; answeredAt: number }> {
	let clock = 0;
	const claimLock = natives.FileLock.tryAcquire.bind(natives.FileLock);
	// A released handle answers `acquired: false`, as a refused claim's does.
	const refused = claimLock(db.dir.join("refused"));
	refused.release();
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
		clock += Number(ms);
	});
	vi.spyOn(natives.FileLock, "tryAcquire").mockImplementation(lockPath =>
		held(clock) ? refused : claimLock(lockPath),
	);
	try {
		const release = await storage.acquireSessionClaim?.(ID, sessionFile(db));
		return { release, answeredAt: clock };
	} finally {
		vi.restoreAllMocks();
	}
}

describe("SqlSessionStorage SQLite session claims", () => {
	// If this regresses, an omp process that opens a session on a SQLite store in the moment another
	// process lets it go finds the session held, and its next write moves to a sibling session with a
	// new id instead of resuming the one the user asked for.
	it("takes a session whose other holder lets it go within the claim's window", async () => {
		await using db = await openLeaseDb("sqlite", "sqlite");
		const storage = await db.open();
		const { release, answeredAt } = await claimOnOwnClock(db, storage, clock => clock < LETS_GO_AT_MS);

		// Taken once the holder let go, after the claim was refused while it held the lock.
		expect(release).toBeFunction();
		expect(answeredAt).toBeGreaterThanOrEqual(LETS_GO_AT_MS);
		release?.();
	});

	// If this regresses, an open that meets a holder letting the session go gives up before that
	// holder could finish, and the session moves to a sibling with a new id.
	it("refuses a session whose lock stays held, and not before the window has passed", async () => {
		await using db = await openLeaseDb("sqlite", "sqlite");
		const storage = await db.open();
		const { release, answeredAt } = await claimOnOwnClock(db, storage, () => true);

		expect(release).toBeNull();
		expect(answeredAt).toBeGreaterThanOrEqual(SQLITE_CLAIM_RELEASE_WINDOW_MS);
	});
});
