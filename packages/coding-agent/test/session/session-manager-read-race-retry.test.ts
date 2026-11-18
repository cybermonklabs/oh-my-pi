/**
 * A session manager's own loads of a transcript of 8 MiB or more stream it
 * through the storage's `readChunks`. A full rewrite or delete of it between
 * two chunks fails that stream with `SessionReadConflictError`; an open (with
 * its header probe) and a switch then stream the transcript again from its
 * start, a bounded number of times, and never read it as one string.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { ColdEntryStore } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { type ColdStoreStats, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	RACED_READ_RETRIES,
	SessionReadConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

const MiB = 1024 * 1024;
const FILE = "/sessions/p/raced.jsonl";
const TIMESTAMP = "2026-11-18T00:00:00.000Z";
// Past the 8 MiB above which the loader streams.
const BODY =
	`${JSON.stringify({ type: "session", version: 3, id: "raced", timestamp: TIMESTAMP, cwd: "/tmp" })}\n` +
	`${JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: TIMESTAMP, customType: "pad", data: "x".repeat(9 * MiB) })}\n`;

/**
 * In-memory storage that streams a transcript 1 MiB at a time, and fails each
 * stream that `raced` names (by its 1-based pass number) after its first
 * chunk, as a full rewrite made between two chunks fails a chunked read.
 */
class RacedStorage extends MemorySessionStorage {
	passes = 0;
	/** Called with each stream's 1-based pass number before the stream reads anything. */
	onPass?: (pass: number) => void;

	constructor(readonly raced: (pass: number) => boolean) {
		super();
	}

	async *readChunks(path: string, fromByte = 0): AsyncGenerator<Uint8Array> {
		const pass = ++this.passes;
		this.onPass?.(pass);
		const bytes = Buffer.from(super.readTextSync(path), "utf8").subarray(fromByte);
		for (let start = 0; start < bytes.byteLength; start += MiB) {
			if (start > 0 && this.raced(pass)) throw new SessionReadConflictError(path);
			yield bytes.subarray(start, start + MiB);
		}
	}
}

/** Storage holding `body` at {@link FILE} whose streams `raced` names are raced, and spies on its whole-text reads. */
function racedStorage(raced: (pass: number) => boolean, body = BODY) {
	const storage = new RacedStorage(raced);
	storage.writeTextSync(FILE, body);
	const wholeReads = [spyOn(storage, "readText"), spyOn(storage, "readTextSync")];
	return { storage, wholeReads: () => wholeReads.reduce((total, spy) => total + spy.mock.calls.length, 0) };
}

/**
 * A transcript past 8 MiB, as {@link BODY} is, with a compaction in its first
 * 1 MiB that keeps from `u2`: a load that streams to it moves the older `u1`
 * to a cold store before the stream reaches its second chunk.
 */
const COMPACTED_BODY = [
	{ type: "session", version: 3, id: "compacted", timestamp: TIMESTAMP, cwd: "/tmp" },
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: TIMESTAMP,
		message: { role: "user", content: "older ".repeat(200), timestamp: 1 },
	},
	{
		type: "message",
		id: "u2",
		parentId: "u1",
		timestamp: TIMESTAMP,
		message: { role: "user", content: "kept", timestamp: 2 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "u2",
		timestamp: TIMESTAMP,
		summary: "summary",
		firstKeptEntryId: "u2",
		tokensBefore: 1000,
	},
	{ type: "custom", id: "pad", parentId: "c1", timestamp: TIMESTAMP, customType: "pad", data: "x".repeat(9 * MiB) },
]
	.map(entry => `${JSON.stringify(entry)}\n`)
	.join("");

/** The first {@link RACED_READ_RETRIES} streams, which a reader that reads again gets past. */
const firstRetries = (pass: number): boolean => pass <= RACED_READ_RETRIES;
const everyPass = (): boolean => true;

describe("a session manager's load that a full rewrite races", () => {
	/** Each entry `manager` holds, as its type and the length of its data. */
	function held(manager: SessionManager): unknown[] {
		return manager.getEntries().map(entry => [entry.type, entry.type === "custom" ? String(entry.data).length : 0]);
	}

	it("opens the session with every entry, its header probe reading one chunk and its load streamed again", async () => {
		// The first stream is the header probe, which stops in its first chunk, so no race reaches it;
		// the second is the load's first pass, raced past that chunk.
		const { storage, wholeReads } = racedStorage(pass => pass <= 2);

		const manager = await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true });

		expect({
			held: held(manager),
			sessionId: manager.getSessionId(),
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({ held: [["custom", 9 * MiB]], sessionId: "raced", passes: 3, wholeReads: 0 });
	});

	it("opens the session after a race on a header probe that reads past its first chunk", async () => {
		// A header record longer than a chunk: the probe reads a second chunk, which the race cuts off.
		const header = {
			type: "session",
			version: 3,
			id: "raced",
			timestamp: TIMESTAMP,
			cwd: "/tmp",
			pad: "h".repeat(MiB),
		};
		const body = `${JSON.stringify(header)}\n${BODY.slice(BODY.indexOf("\n") + 1)}`;
		const { storage, wholeReads } = racedStorage(pass => pass === 1, body);

		const manager = await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true });

		expect({
			held: held(manager),
			sessionId: manager.getSessionId(),
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({ held: [["custom", 9 * MiB]], sessionId: "raced", passes: 3, wholeReads: 0 });
	});

	it("switches to the session with every entry, streaming the load again from its start", async () => {
		const { storage, wholeReads } = racedStorage(firstRetries);
		const manager = SessionManager.create("/tmp", path.dirname(FILE), storage);

		await manager.setSessionFile(FILE);

		expect({
			held: held(manager),
			sessionId: manager.getSessionId(),
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({ held: [["custom", 9 * MiB]], sessionId: "raced", passes: RACED_READ_RETRIES + 1, wholeReads: 0 });
	});

	it("surfaces the read conflict from a switch raced on every pass, after its retries, with no whole-text read", async () => {
		const { storage, wholeReads } = racedStorage(everyPass);
		const manager = SessionManager.create("/tmp", path.dirname(FILE), storage);

		const error = await manager.setSessionFile(FILE).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(SessionReadConflictError);
		expect({ passes: storage.passes, wholeReads: wholeReads() }).toEqual({
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
		});
	});

	it("closes the cold store a raced load opened, keeping only the store of the load that finished", async () => {
		const unraced = racedStorage(() => false, COMPACTED_BODY);
		const whole = await SessionManager.open(FILE, path.dirname(FILE), unraced.storage, { suppressBreadcrumb: true });
		const closes = spyOn(ColdEntryStore.prototype, "close");
		// The first stream is the header probe, the second the load's first.
		const { storage } = racedStorage(pass => pass === 2, COMPACTED_BODY);

		const manager = await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true });

		const stats = ({ coldEntries, storeBytes }: ColdStoreStats) => ({ coldEntries, storeBytes });
		const closed = closes.mock.calls.length;
		closes.mockRestore();
		expect(stats(whole.coldStoreStats()).coldEntries).toBeGreaterThan(0);
		expect({ closed, stats: stats(manager.coldStoreStats()), passes: storage.passes }).toEqual({
			closed: 1,
			stats: stats(whole.coldStoreStats()),
			passes: 3,
		});
		await manager.close();
		await whole.close();
	});

	it("gives the entries the ids and parents of the body it loads when a full write lands between the check for entry ids and the load", async () => {
		// If this regresses, opening a current-version session whose entries had
		// no ids while another writer rewrote it with ids renumbers every entry of
		// the new body, so the tree, the leaf and every reference by id break.
		const pad = (fill: string, identity: object) => ({
			type: "custom",
			customType: "pad",
			...identity,
			timestamp: TIMESTAMP,
			data: fill.repeat(9 * MiB),
		});
		const transcript = (entries: object[]) =>
			[{ type: "session", version: 3, id: "raced", timestamp: TIMESTAMP, cwd: "/tmp" }, ...entries]
				.map(entry => `${JSON.stringify(entry)}\n`)
				.join("");
		const unindexed = transcript([pad("u", {}), { type: "custom", customType: "note", timestamp: TIMESTAMP }]);
		const indexed = transcript([
			pad("i", { id: "p0", parentId: null }),
			{ type: "custom", customType: "note", id: "n1", parentId: "p0", timestamp: TIMESTAMP },
		]);
		const { storage } = racedStorage(() => false, unindexed);
		// The streams: the header probe, the load's first pass (which stops at the
		// first entry, without an id), the check that reads every entry, then the load.
		storage.onPass = pass => {
			if (pass === 4) storage.writeTextSync(FILE, indexed);
		};

		const manager = await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true });

		expect({
			entries: manager
				.getEntries()
				.map(entry => [entry.id, entry.parentId, entry.type === "custom" ? String(entry.data).charAt(0) : ""]),
			passes: storage.passes,
		}).toEqual({
			entries: [
				["p0", null, "i"],
				["n1", "p0", "u"],
			],
			passes: 5,
		});
		await manager.close();
	});
});
