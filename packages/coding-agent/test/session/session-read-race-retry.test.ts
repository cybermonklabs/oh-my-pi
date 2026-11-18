/**
 * A transcript of 8 MiB or more loads, and copies, through `readChunks`. A
 * full rewrite or delete of it between two chunks fails that read with
 * `SessionReadConflictError` (the holder's process, or this process's own
 * queued writes, which reads do not wait for, can make one). The load and the
 * copy then stream the transcript again from its start, a bounded number of
 * times, and never read it as one string.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	MemorySessionStorage,
	RACED_READ_RETRIES,
	SessionReadConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { copyTranscript } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";

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
