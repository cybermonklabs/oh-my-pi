/**
 * A SQLite session claim made while another process is letting the same
 * session go is taken once that holder has let go: the claim does not
 * refuse a session whose holder is releasing it.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { openLeaseDb } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-00000000c001";
const HOLDER_SCRIPT = path.join(import.meta.dir, "sql-session-claim-holder-process.ts");
/** How long after it is told to the holder lets the session go. */
const RELEASE_AFTER_MS = 25;

/** A reader of `child`'s stdout, one JSON line per call. */
function jsonLines(child: Bun.Subprocess<"pipe", "pipe", "pipe">): () => Promise<Record<string, unknown>> {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	return async () => {
		let newline = buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`The holder exited early: ${await new Response(child.stderr).text()}`);
			buffered += decoder.decode(value, { stream: true });
			newline = buffered.indexOf("\n");
		}
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		return JSON.parse(line) as Record<string, unknown>;
	};
}

describe("SqlSessionStorage SQLite session claims", () => {
	// If this regresses, an omp process that opens a session on a SQLite store in the moment another
	// process lets it go finds the session held, and its next write moves to a sibling session with a
	// new id instead of resuming the one the user asked for.
	it("takes a claim of a session whose other holder lets it go 25 ms after the claim began", async () => {
		await using db = await openLeaseDb("sqlite", "sqlite");
		const storage = await db.open();
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-19T00-00-00-000Z_${ID}.jsonl`);
		const home = db.dir.join("home");
		const config = {
			dsn: db.dsn,
			table: db.table,
			leaseTable: db.leaseTable,
			sessionId: ID,
			file,
			releaseAfterMs: RELEASE_AFTER_MS,
		};
		const child = Bun.spawn([process.execPath, HOLDER_SCRIPT, JSON.stringify(config)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// The live environment, so the holder meets this test's session-owner locks.
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_STATE_HOME: path.join(home, "state"),
				XDG_CACHE_HOME: path.join(home, "cache"),
			},
		});
		try {
			const next = jsonLines(child);
			expect(await next()).toEqual({ held: true });

			child.stdin.write("release\n");
			child.stdin.flush();
			const claimStartedAt = performance.timeOrigin + performance.now();
			const release = await storage.acquireSessionClaim?.(ID, file);
			const { stillHeldAt } = await next();

			// The claim began while the other process still held the session, and was taken.
			expect(claimStartedAt).toBeLessThan(Number(stillHeldAt));
			expect(release).toBeFunction();
			release?.();
		} finally {
			child.kill();
			await child.exited;
		}
	}, 30_000);
});
