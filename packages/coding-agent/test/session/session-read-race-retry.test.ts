/**
 * A transcript of 8 MiB or more loads, and copies, through `readChunks`. A
 * full rewrite or delete of it between two chunks fails that read with
 * `SessionReadConflictError` (the holder's process, or this process's own
 * queued writes, which reads do not wait for, can make one). The load and the
 * copy then stream the transcript again from its start, a bounded number of
 * times, and never read it as one string.
 *
 * The last cases race a real second writer: another `SqlSessionStorage` on
 * the same database rewrites the transcript right after the first chunk a
 * read took, on SQLite always and on PostgreSQL when
 * `OMP_TEST_SQL_POSTGRES_URL` names a database.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { findSessionContinuation } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { copySessionArtifacts, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	RACED_READ_RETRIES,
	SessionReadConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { copyTranscript } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import { paddedTranscript, padFills, raceAfterFirstChunk, STILL } from "./chunked-read-race";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb } from "./sql-session-lease-fixture";

const MiB = 1024 * 1024;
const FILE = "/sessions/p/raced.jsonl";
const COPY = "/sessions/q/raced.jsonl";
const TIMESTAMP = "2026-11-18T00:00:00.000Z";
// Past the 8 MiB above which the loader streams.
const BODY =
	`${JSON.stringify({ type: "session", version: 3, id: "raced", timestamp: TIMESTAMP, cwd: "/tmp" })}\n` +
	`${JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: TIMESTAMP, customType: "pad", data: "x".repeat(9 * MiB) })}\n`;

/**
 * In-memory storage that streams a transcript 1 MiB at a time, and fails the
 * first `racedPasses` streams after their first chunk, as a full rewrite made
 * between two chunks fails a chunked read.
 */
class RacedStorage extends MemorySessionStorage {
	passes = 0;

	constructor(readonly racedPasses: number) {
		super();
	}

	async *readChunks(path: string, fromByte = 0): AsyncGenerator<Uint8Array> {
		const bytes = Buffer.from(super.readTextSync(path), "utf8").subarray(fromByte);
		const pass = ++this.passes;
		for (let start = 0; start < bytes.byteLength; start += MiB) {
			if (start > 0 && pass <= this.racedPasses) throw new SessionReadConflictError(path);
			yield bytes.subarray(start, start + MiB);
		}
	}
}

/** `racedPasses` storage holding {@link BODY} at {@link FILE}, and spies on its whole-text reads. */
function racedStorage(racedPasses: number) {
	const storage = new RacedStorage(racedPasses);
	storage.writeTextSync(FILE, BODY);
	const wholeReads = [spyOn(storage, "readText"), spyOn(storage, "readTextSync")];
	return { storage, wholeReads: () => wholeReads.reduce((total, spy) => total + spy.mock.calls.length, 0) };
}

describe("a streamed read that a full rewrite races", () => {
	it("loads the whole transcript by streaming it again from its start", async () => {
		const { storage, wholeReads } = racedStorage(RACED_READ_RETRIES);

		const loaded = await loadSessionFile(FILE, storage);

		expect({
			types: loaded.entries.map(entry => entry.type),
			sourceSize: loaded.sourceSize,
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({
			types: ["session", "custom"],
			sourceSize: Buffer.byteLength(BODY),
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
		});
	});

	it("copies the whole transcript by removing the partial copy and copying again from its start", async () => {
		const { storage, wholeReads } = racedStorage(RACED_READ_RETRIES);

		const copied = await copyTranscript(storage, FILE, COPY);

		expect({ copied, passes: storage.passes, wholeReads: wholeReads() }).toEqual({
			copied: true,
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
		});
		expect(storage.readTextSync(COPY) === BODY).toBe(true);
	});

	it("surfaces the read conflict from a load raced on every pass, after its retries, with no whole-text read", async () => {
		const { storage, wholeReads } = racedStorage(Number.POSITIVE_INFINITY);

		const error = await loadSessionFile(FILE, storage).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(SessionReadConflictError);
		expect({ passes: storage.passes, wholeReads: wholeReads() }).toEqual({
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
		});
	});

	it("surfaces the read conflict from a copy raced on every pass, after its retries, leaving no partial copy", async () => {
		const { storage, wholeReads } = racedStorage(Number.POSITIVE_INFINITY);

		const error = await copyTranscript(storage, FILE, COPY).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(SessionReadConflictError);
		expect({ passes: storage.passes, wholeReads: wholeReads(), copyLeft: storage.existsSync(COPY) }).toEqual({
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
			copyLeft: false,
		});
	});
});

/** A session file of `db` named for `id`, created `second` seconds after the fixture's epoch. */
function sessionPath(db: LeaseDb, id: string, second = 0): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-0${second}-000Z_${id}.jsonl`);
}

/** A JSONL entry line. */
function line(entry: Record<string, unknown>): string {
	return `${JSON.stringify(entry)}\n`;
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a streamed SQL read that another store's full rewrite races (${adapter})`, () => {
		const ID = "01a1f000-0000-7000-8000-0000000000e1";

		/** A store that writes `lines` at `file`, and a second store on the same database that reads it. */
		async function stores(db: LeaseDb, file: string, lines: string[]) {
			const holder = await db.open({ lease: STILL });
			await holder.writeLinesAtomic(file, lines);
			await holder.drain();
			const reader = await db.open({ lease: STILL });
			await reader.refresh();
			const rewrite = async (next: string[]) => {
				await holder.writeLinesAtomic(file, next, { expectedSize: holder.statSync(file).size });
				await holder.drain();
			};
			return { holder, reader, rewrite };
		}

		it("loads one body's entries of a session rewritten after the first chunk, streamed again and never read whole", async () => {
			// If this regresses, resuming a long SQL session another process rewrites (compacts) fails with
			// a read conflict, or opens with the first lines of the old transcript and the rest of the new one.
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = sessionPath(db, ID);
			const { reader, rewrite } = await stores(db, file, paddedTranscript(ID, "first", "a", 9));
			const race = raceAfterFirstChunk(reader, file, () => rewrite(paddedTranscript(ID, "first", "b", 9)));
			const wholeReads = spyOn(reader, "readText");

			const loaded = await loadSessionFile(file, reader);

			expect({ raced: race.ran, wholeReads: wholeReads.mock.calls.length }).toEqual({ raced: true, wholeReads: 0 });
			expect(["aaaaaaaaa", "bbbbbbbbb"]).toContain(padFills(loaded.entries));
		}, 120_000);

		it("peeks one body's session_init of a session rewritten after the first chunk, never no init", async () => {
			// If this regresses, reviving a parked subagent whose long SQL transcript is being rewritten finds
			// no recorded contract (`null`) and cannot rebuild its system prompt and tools.
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = sessionPath(db, ID);
			const withInit = (fill: string) => [
				...paddedTranscript(ID, "first", fill, 9),
				line({
					type: "session_init",
					id: "i1",
					parentId: null,
					timestamp: "2026-11-18T00:00:00.000Z",
					systemPrompt: [`prompt ${fill}`],
					task: `task ${fill}`,
					tools: ["read"],
				}),
			];
			const { reader, rewrite } = await stores(db, file, withInit("a"));
			const race = raceAfterFirstChunk(reader, file, () => rewrite(withInit("b")));

			const peek = await SessionManager.peekSessionInit(file, reader);

			expect(race.ran).toBe(true);
			expect([
				{ systemPrompt: ["prompt a"], task: "task a" },
				{ systemPrompt: ["prompt b"], task: "task b" },
			]).toContainEqual({ systemPrompt: peek?.init?.systemPrompt ?? [], task: peek?.init?.task ?? "no init" });
		}, 120_000);

		it("follows a long continuation rewritten after the first chunk of the read that looks for the turn both copies hold", async () => {
			// If this regresses, `--resume` of a session that moved on into a long SQL copy, while that copy is
			// being rewritten, reopens the old copy and revives the conversation as it was before the move.
			await using db = await openLeaseDb(adapter, url ?? "");
			const original = sessionPath(db, ID);
			const copyId = "01a1f000-0000-7000-8000-0000000000e2";
			const copy = sessionPath(db, copyId, 1);
			const turn = (id: string, text: string, second: number) =>
				line({
					type: "message",
					id,
					parentId: null,
					timestamp: `2026-11-17T00:00:0${second}.000Z`,
					message: { role: "user", content: text, timestamp: second },
				});
			const header = (id: string, extra: Record<string, unknown> = {}) =>
				line({ type: "session", version: 3, id, timestamp: "2026-11-17T00:00:00.000Z", cwd: "/project", ...extra });
			// The copy holds the original's newest turn past its first chunk, then a newer turn of its own.
			const copyLines = (fill: string) => [
				header(copyId, { continuationOf: ID }),
				...paddedTranscript(copyId, "unused", fill, 9).slice(2),
				turn("m1", "first", 0),
				turn("m2", "moved on", 2),
			];
			const { holder, reader, rewrite } = await stores(db, copy, copyLines("a"));
			await holder.writeLinesAtomic(original, [header(ID), turn("m1", "first", 0)]);
			await holder.drain();
			await reader.refresh();
			const race = raceAfterFirstChunk(reader, copy, () => rewrite(copyLines("b")));

			const continuation = await findSessionContinuation(original, reader);

			expect(race.ran).toBe(true);
			expect(continuation?.session.path).toBe(copy);
		}, 120_000);

		it("copies one body of a subagent transcript rewritten after the first chunk into a fork, leaving no partial copy", async () => {
			// If this regresses, a fork of a SQL session whose subagent transcript is being rewritten gets no
			// copy of it (the failure is only logged) or a copy mixing the old transcript and the new one.
			await using db = await openLeaseDb(adapter, url ?? "");
			const source = sessionPath(db, ID);
			const fork = sessionPath(db, "01a1f000-0000-7000-8000-0000000000e3", 1);
			const worker = `${source.slice(0, -".jsonl".length)}/Worker.jsonl`;
			const forkWorker = `${fork.slice(0, -".jsonl".length)}/Worker.jsonl`;
			const before = paddedTranscript("worker", "work", "a", 3);
			const after = paddedTranscript("worker", "work", "b", 3);
			const { reader, rewrite } = await stores(db, worker, before);
			const race = raceAfterFirstChunk(reader, worker, () => rewrite(after));

			await copySessionArtifacts(source, fork, reader);

			const copied = (await db.row(forkWorker))?.content;
			const forkDir = `${fork.slice(0, -".jsonl".length)}/`;
			expect(race.ran).toBe(true);
			expect((await db.paths()).filter(stored => stored.startsWith(forkDir))).toEqual([forkWorker]);
			expect(copied === before.join("") || copied === after.join("")).toBe(true);
		}, 120_000);
	});
}
