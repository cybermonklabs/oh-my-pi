/**
 * A long SQLite session loads while another omp process keeps committing to
 * the same database file. Each commit of another connection moves the
 * reader's `PRAGMA data_version`, so the chunked read checks at its end
 * whether what it yielded is still stored; appends to another session change
 * none of it, and the load must give the session's entries, not a read
 * conflict.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { appendLines, firstPrompt, padFills, paddedTranscript, STILL } from "./chunked-read-race";
import { type LeaseDb, openLeaseDb, transcript, until } from "./sql-session-lease-fixture";

/** The session the case loads, and the one the other process appends to meanwhile. */
const LONG_ID = "01a1f000-0000-7000-8000-000000000081";
const BUSY_ID = "01a1f000-0000-7000-8000-000000000082";
/** Pads of 1 MiB the long session holds after its first turn: about 64 MiB. */
const PADS = 64;

const BUSY_WRITER_PROCESS = path.join(import.meta.dir, "sql-session-busy-writer-process.ts");

/**
 * Start another process that claims session {@link BUSY_ID} as `file` of
 * `db` and appends to it every 50 ms on its own clock
 * (`sql-session-busy-writer-process.ts`). Returns its stop, which ends the
 * process's stdin, waits up to 10 s for it to exit and then kills it, and
 * says how it ended: "exited 0", or its exit code and what it wrote to
 * stderr. A second call gives the first call's answer.
 */
function startBusyWriter(db: LeaseDb, file: string): () => Promise<string> {
	const config = {
		dsn: db.dsn,
		table: db.table,
		leaseTable: db.leaseTable,
		lease: STILL,
		sessionId: BUSY_ID,
		path: file,
		header: transcript(BUSY_ID, "busy"),
		everyMs: 50,
	};
	const child = Bun.spawn([process.execPath, BUSY_WRITER_PROCESS, JSON.stringify(config)], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
		env: process.env,
	});
	const stderr = new Response(child.stderr).text();
	const stop = async (): Promise<string> => {
		let killed = false;
		if (child.exitCode === null && child.signalCode === null) {
			child.stdin.end();
			const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
			if (!exited) {
				child.kill("SIGKILL");
				killed = true;
			}
		}
		const code = await child.exited;
		if (code === 0 && !killed) return "exited 0";
		return `exited ${code}${killed ? " when killed, 10 s after its stdin ended" : ""}: ${await stderr}`;
	};
	let stopped: Promise<string> | undefined;
	return () => {
		stopped ??= stop();
		return stopped;
	};
}

/** Lines session `file` of `db` holds (each ends in a newline), read on the fixture's own connection. */
async function storedLines(db: LeaseDb, file: string): Promise<number> {
	return ((await db.row(file))?.content.split("\n").length ?? 1) - 1;
}

describe("a long SQLite session loaded while another process appends to another session of the file", () => {
	it("loads every entry with no read conflict while the other session gets a line every 50 ms", async () => {
		// If this regresses, resuming a long session (tens of MiB) on a SQLite database fails with a read conflict
		// while another omp process on the same database keeps writing its own session, as a running agent does.
		await using db = await openLeaseDb("sqlite", "sqlite");
		const dir = path.join(db.dir.path(), "sessions", "-project-");
		const longFile = path.join(dir, `2026-11-17T00-00-00-000Z_${LONG_ID}.jsonl`);
		const busyFile = path.join(dir, `2026-11-17T00-00-01-000Z_${BUSY_ID}.jsonl`);
		const writer = await db.open({ lease: STILL });
		const release = await writer.acquireSessionClaim?.(LONG_ID, longFile);
		await appendLines(writer, longFile, paddedTranscript(LONG_ID, "first", "a", PADS));
		const reader = await db.open({ lease: STILL });
		await reader.refresh();

		const stopBusyWriter = startBusyWriter(db, busyFile);
		let loaded: string;
		let busyLinesBefore: number;
		let busyLinesAfter: number;
		let busyWriter: string;
		try {
			// Its header, and at least one append on its clock, are stored before the load starts.
			try {
				await until(async () => (await storedLines(db, busyFile)) > 2);
			} catch (err) {
				throw new Error(`the busy writer stored no append: it ${await stopBusyWriter()}`, { cause: err });
			}
			busyLinesBefore = await storedLines(db, busyFile);
			try {
				const session = await loadSessionFile(longFile, reader);
				loaded = `${firstPrompt(session.entries)} ${padFills(session.entries)}`;
			} catch (err) {
				if (!(err instanceof SessionReadConflictError)) throw err;
				loaded = "read conflict";
			}
			busyLinesAfter = await storedLines(db, busyFile);
		} finally {
			busyWriter = await stopBusyWriter();
		}

		expect({ loaded, appendedDuringLoad: busyLinesAfter > busyLinesBefore, busyWriter }).toEqual({
			loaded: `first ${"a".repeat(PADS)}`,
			appendedDuringLoad: true,
			busyWriter: "exited 0",
		});
		release?.();
	}, 300_000);
});
