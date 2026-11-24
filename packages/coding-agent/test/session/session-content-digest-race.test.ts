/**
 * `sessionContentDigest` hashes a transcript's chunks as the storage yields
 * them. A full rewrite or delete between two chunks fails that read with
 * `SessionReadConflictError`; the digest then reads the transcript again from
 * its start, a bounded number of times, and never as one string. If this
 * regresses, opening a session by path with `throwIfMissing` (resume, export,
 * share) while another process rewrites it fails with the read race instead of
 * opening the new body.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { sessionContentDigest } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	MemorySessionStorage,
	RACED_READ_RETRIES,
	SessionReadConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

const CHUNK = 64 * 1024;
const FILE = "/sessions/p/raced.jsonl";
const TIMESTAMP = "2026-11-18T00:00:00.000Z";

/** A transcript of several {@link CHUNK}s whose one custom entry is filled with `fill`. */
function body(fill: string): string {
	return (
		`${JSON.stringify({ type: "session", version: 3, id: "raced", timestamp: TIMESTAMP, cwd: "/tmp" })}\n` +
		`${JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: TIMESTAMP, customType: "pad", data: fill.repeat(3 * CHUNK) })}\n`
	);
}

const OLD = body("a");
const NEW = body("b");

/**
 * In-memory storage that streams a transcript {@link CHUNK} bytes at a time.
 * Each of its first `racedPasses` streams replaces the transcript with
 * {@link NEW} after its first chunk and then fails, as a full rewrite made
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
		for (let start = 0; start < bytes.byteLength; start += CHUNK) {
			if (start > 0 && pass <= this.racedPasses) {
				super.writeTextSync(path, NEW);
				throw new SessionReadConflictError(path);
			}
			yield bytes.subarray(start, start + CHUNK);
		}
	}
}

/** `racedPasses` storage holding {@link OLD} at {@link FILE}, and spies on its whole-text reads. */
function racedStorage(racedPasses: number) {
	const storage = new RacedStorage(racedPasses);
	storage.writeTextSync(FILE, OLD);
	const wholeReads = [spyOn(storage, "readText"), spyOn(storage, "readTextSync")];
	return { storage, wholeReads: () => wholeReads.reduce((total, spy) => total + spy.mock.calls.length, 0) };
}

describe("sessionContentDigest of a transcript a full rewrite races", () => {
	it("hashes the body that replaced the transcript by streaming it again from its start", async () => {
		const { storage, wholeReads } = racedStorage(1);

		const digest = await sessionContentDigest(FILE, storage);

		expect({ digest, passes: storage.passes, wholeReads: wholeReads() }).toEqual({
			digest: new Bun.CryptoHasher("sha256").update(NEW).digest("hex"),
			passes: 2,
			wholeReads: 0,
		});
	});

	it("surfaces the read conflict from a read raced on every pass, after its retries, with no whole-text read", async () => {
		const { storage, wholeReads } = racedStorage(Number.POSITIVE_INFINITY);

		const error = await sessionContentDigest(FILE, storage).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(SessionReadConflictError);
		expect({ passes: storage.passes, wholeReads: wholeReads() }).toEqual({
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
		});
	});
});
