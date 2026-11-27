/**
 * Loads of a transcript of 8 MiB or more, a session manager's and
 * `loadSessionFile`'s, stream it through the storage's `readChunks`. A full
 * rewrite or delete of it between two chunks fails that stream with
 * `SessionReadConflictError` (or ENOENT after the bytes already read); an open
 * (with its header probe), a switch and a `loadSessionFile` then stream the
 * transcript again from its start, a bounded number of times, and never read
 * it as one string.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	RACED_READ_RETRIES,
	SessionReadConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const MiB = 1024 * 1024;
const FILE = path.resolve("/sessions/p/raced.jsonl");
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
	#bytes!: Buffer;
	conflict = (file: string): Error => new SessionReadConflictError(file);
	/** Called with each stream's 1-based pass number before the stream reads anything. */
	onPass?: (pass: number) => void;

	constructor(readonly raced: (pass: number) => boolean) {
		super();
	}

	override writeTextSync(file: string, body: string): void {
		super.writeTextSync(file, body);
		if (file === FILE) this.#bytes = Buffer.from(body, "utf8");
	}

	async *readChunks(file: string, fromByte = 0): AsyncGenerator<Uint8Array> {
		const pass = ++this.passes;
		this.onPass?.(pass);
		const bytes = this.#bytes.subarray(fromByte);
		for (let start = 0; start < bytes.byteLength; start += MiB) {
			if (start > 0 && this.raced(pass)) throw this.conflict(file);
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

/** The first {@link RACED_READ_RETRIES} streams, which a reader that reads again gets past. */
const firstRetries = (pass: number): boolean => pass <= RACED_READ_RETRIES;
const everyPass = (): boolean => true;

/** A streamed transcript whose header and one entry fit in its first chunk. */
const shortTranscript = (id: string): string =>
	[
		{ type: "session", version: 3, id, timestamp: TIMESTAMP },
		{ type: "custom", id: `${id}-entry`, parentId: null, customType: "note", timestamp: TIMESTAMP },
	]
		.map(record => `${JSON.stringify(record)}\n`)
		.join("") + "\n".repeat(8 * MiB);

/** Make each raced stream of `storage` fail with ENOENT after `replacement` took the transcript's place. */
function replaceMidReadWithEnoent(storage: RacedStorage, replacement: string): void {
	storage.conflict = file => {
		storage.writeTextSync(file, replacement);
		return Object.assign(new Error("File removed mid-read"), { code: "ENOENT" });
	};
}

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

		const entries = manager.getEntries();
		expect({
			entries: entries.map(entry => [entry.id, entry.parentId]),
			// The fill of the pad, which tells the two bodies apart.
			pads: entries.flatMap(entry =>
				entry.type === "custom" && entry.customType === "pad" ? [String(entry.data).charAt(0)] : [],
			),
			passes: storage.passes,
		}).toEqual({
			entries: [
				["p0", null],
				["n1", "p0"],
			],
			pads: ["i"],
			passes: 5,
		});
		await manager.close();
	});

	it("uses the launch workspace when the replacement loaded after the probe has a missing cwd", async () => {
		using root = TempDir.createSync("@omp-raced-open-");
		const launch = root.path();
		const originalCwd = path.join(launch, "original");
		const missingCwd = path.join(launch, "missing");
		await fs.mkdir(originalCwd);
		const bodyAt = (id: string, cwd: string) =>
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: TIMESTAMP, cwd })}\n${"\n".repeat(8 * MiB)}`;
		const replacement = bodyAt("replacement", missingCwd);
		const { storage } = racedStorage(() => false, bodyAt("original", originalCwd));
		storage.onPass = pass => {
			if (pass === 2) storage.writeTextSync(FILE, replacement);
		};
		const options = { initialCwd: launch, suppressBreadcrumb: true };
		const direct = await SessionManager.open(
			FILE,
			undefined,
			racedStorage(() => false, replacement).storage,
			options,
		);
		const raced = await SessionManager.open(FILE, undefined, storage, options);
		const workspace = (manager: SessionManager) => [
			manager.getSessionId(),
			manager.getCwd(),
			manager.getSessionDir(),
		];

		expect(workspace(direct)).toEqual([
			"replacement",
			launch,
			SessionManager.getDefaultSessionDir(launch, undefined, storage),
		]);
		expect(workspace(raced)).toEqual(workspace(direct));
		await raced.close();
		await direct.close();
	});

	it("retries from the start after ENOENT follows a valid streamed prefix", async () => {
		const { storage, wholeReads } = racedStorage(pass => pass === 2, shortTranscript("partial"));
		replaceMidReadWithEnoent(storage, shortTranscript("replacement"));

		const manager = await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true });

		expect(manager.getSessionId()).toBe("replacement");
		expect(manager.getEntries().map(entry => entry.id)).toEqual(["replacement-entry"]);
		expect({ passes: storage.passes, wholeReads: wholeReads() }).toEqual({ passes: 3, wholeReads: 0 });
		await manager.close();
	});
});

describe("a session file load that a delete races", () => {
	it("reads the replacement from its start instead of returning the prefix read before ENOENT", async () => {
		// If this regresses, an export or other read-only load of a long transcript
		// deleted or replaced mid-read gets its first chunk's entries as the whole session.
		const { storage, wholeReads } = racedStorage(pass => pass === 1, shortTranscript("partial"));
		replaceMidReadWithEnoent(storage, shortTranscript("replacement"));

		const loaded = await loadSessionFile(FILE, storage);

		expect({
			ids: loaded.entries.map(entry => entry.id),
			sourceSize: loaded.sourceSize,
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({
			ids: ["replacement", "replacement-entry"],
			sourceSize: Buffer.byteLength(shortTranscript("replacement")),
			passes: 2,
			wholeReads: 0,
		});
	});
});
