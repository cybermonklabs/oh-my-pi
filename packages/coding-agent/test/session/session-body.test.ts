/**
 * The bodies of indexed storage's full writes (`session-body.ts`): a rewrite of
 * lines a generator yields goes through a private spool file, or, where the
 * account id cannot be read, a compressed copy in memory, and publishes the
 * bytes the lines held when it was queued.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { FullBodies } from "@oh-my-pi/pi-coding-agent/session/session-body";
import {
	LINE_STREAM_CHUNK,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { withoutAccountId } from "../helpers/account-id";
import { MemoryBackend, StreamingMemoryBackend } from "../helpers/memory-session-backend";
import { fillDiskUnder, spoolWarnings } from "../helpers/spool-unusable";

/** What a read of a rewrite's body after its release throws, whether the body is spooled or kept in memory. */
const RELEASED_BODY = "A session rewrite's body was read after it was released";

/** A {@link StreamingMemoryBackend} whose streamed full write waits, before it reads a chunk, until the test lets it go on. */
class HeldStreamBackend extends StreamingMemoryBackend {
	#entered = Promise.withResolvers<void>();
	#release = Promise.withResolvers<void>();

	/** Resolve once a streamed full write has started and waits. */
	entered(): Promise<void> {
		return this.#entered.promise;
	}

	/** Let the waiting streamed full write go on, and hold the next one. */
	release(): void {
		const release = this.#release;
		this.#entered = Promise.withResolvers();
		this.#release = Promise.withResolvers();
		release.resolve();
	}

	override async writeFullStream(path: string, chunks: AsyncIterable<Uint8Array>, byteLength: number): Promise<void> {
		const release = this.#release.promise;
		this.#entered.resolve();
		await release;
		await super.writeFullStream(path, chunks, byteLength);
	}
}

/** An indexed storage that records the whole text each full rewrite hands its own text writers. */
class InterceptingIndexedStorage extends IndexedSessionStorage {
	readonly intercepted: string[] = [];

	override writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.intercepted.push(content);
		super.writeTextSync(path, content, options);
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.intercepted.push(content);
		await super.writeTextAtomic(path, content, options);
	}
}

describe("IndexedSessionStorage full writes of lines a generator yields", () => {
	// SessionManager passes an array of serialized lines. These cases also exercise SDK callers with iterables.
	const lines = [
		`${JSON.stringify({ type: "session", version: 3, id: "lazy", timestamp: "t0", cwd: "/cwd" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "a", parentId: null, timestamp: "t1" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "b", parentId: "a", timestamp: "t2" })}\n`,
	];
	const body = lines.join("");
	function* serialized(): Generator<string> {
		yield* lines;
	}

	it("spools the lines and stores their bytes through writeLinesAtomic and writeLinesSync", async () => {
		const backend = new MemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });
		storage.writeLinesSync("/sessions/sync.jsonl", serialized(), { expectedSize: null });
		await storage.drain();

		expect(Object.fromEntries(backend.sessions)).toEqual({
			"/sessions/atomic.jsonl": body,
			"/sessions/sync.jsonl": body,
		});
	});

	it.skipIf(process.getuid === undefined)(
		"spools into a directory of this account's own under the OS temp directory, private to it",
		async () => {
			// Another account on the machine that ran omp first owns any shared name there.
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-dir-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			try {
				const storage = new IndexedSessionStorage(new MemoryBackend());
				await storage.initialize();
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });

				const spools = fs.readdirSync(tmp);
				expect(spools).toEqual([`omp-spool-${process.getuid?.()}`]);
				expect(fs.statSync(path.join(tmp, spools[0] ?? "")).mode & 0o777).toBe(0o700);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.getuid === undefined)(
		"leaves the previous body intact when a spool fails after consuming one line of a one-shot iterable",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-full-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			vi.spyOn(logger, "warn").mockImplementation(() => {});
			const target = "/sessions/one-shot.jsonl";
			try {
				const backend = new StreamingMemoryBackend();
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				await storage.writeText(target, body);
				const disk = fillDiskUnder(tmp);
				let consumed = 0;
				const iterator = (function* () {
					consumed++;
					yield `${"x".repeat(LINE_STREAM_CHUNK + 1)}\n`;
					consumed++;
					yield lines[1]!;
				})();
				const oneShot = { [Symbol.iterator]: () => iterator };
				const outcome = await storage.writeLinesAtomic(target, oneShot).then(
					() => "stored",
					(error: unknown) => String(error),
				);
				expect({ outcome, consumed, refused: disk.refused(), stored: await storage.readText(target) }).toEqual({
					outcome: expect.stringContaining("ENOSPC"),
					consumed: 1,
					refused: 1,
					stored: body,
				});
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.getuid === undefined)(
		"replays arrays and explicitly replayable iterables after a spool fails",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-replay-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			try {
				const backend = new StreamingMemoryBackend();
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				const disk = fillDiskUnder(tmp);
				await storage.writeLinesAtomic("/sessions/array.jsonl", lines);
				await storage.writeLinesAtomic(
					"/sessions/iterable.jsonl",
					{ [Symbol.iterator]: serialized },
					{ replayable: true },
				);
				expect(disk.refused()).toBe(2);
				expect(spoolWarnings(warn.mock.calls)).toHaveLength(1);
				expect(backend.streamedBytes).toEqual([Buffer.byteLength(body), Buffer.byteLength(body)]);
				expect([...backend.sessions.values()]).toEqual([body, body]);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.getuid === undefined)(
		"stores the joined replayable lines when the spool fails and the backend has no streamed write",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-join-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			// The first line alone fills a spool chunk, so the write fails before pulling the next line.
			const rewrite = [
				`${JSON.stringify({ type: "session", data: `${"x".repeat(LINE_STREAM_CHUNK)}é🌲` })}\n`,
				lines[1]!,
			];
			const expected = rewrite.join("");
			try {
				const backend = new MemoryBackend();
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				const disk = fillDiskUnder(tmp);
				await storage.writeLinesAtomic("/sessions/array.jsonl", rewrite, { expectedSize: null });
				storage.writeLinesSync(
					"/sessions/iterable.jsonl",
					{ [Symbol.iterator]: () => rewrite.values() },
					{ expectedSize: null, replayable: true },
				);
				await storage.drain();
				expect(disk.refused()).toBe(2);
				expect(spoolWarnings(warn.mock.calls)).toHaveLength(1);
				expect(backend.writeFullBytes).toEqual([Buffer.byteLength(expected), Buffer.byteLength(expected)]);
				expect([...backend.sessions.values()]).toEqual([expected, expected]);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.getuid === undefined)(
		"spools a large record in bounded writes without splitting a surrogate pair",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-utf8-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const target = "/sessions/utf8.jsonl";
			const prefix = '{"type":"custom","data":"';
			const record = `${prefix}${"x".repeat(LINE_STREAM_CHUNK - prefix.length - 1)}😀z"}\n`;
			try {
				const storage = new IndexedSessionStorage(new MemoryBackend());
				await storage.initialize();
				const writes = vi.spyOn(fs, "writeFileSync");
				await storage.writeLinesAtomic(target, [record], { expectedSize: null });
				expect(Buffer.from(await storage.readText(target))).toEqual(Buffer.from(record));
				const sizes = writes.mock.calls.flatMap(([fd, data]) =>
					typeof fd === "number" && ArrayBuffer.isView(data) ? [data.byteLength] : [],
				);
				expect(sizes.length).toBeGreaterThan(1);
				expect(Math.max(...sizes)).toBeLessThanOrEqual(LINE_STREAM_CHUNK);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.getuid === undefined)(
		"decodes bounded asynchronous spool reads and checks the commit guard after them",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-async-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const target = "/sessions/async.jsonl";
			// A BOM and a two-byte character with one byte on each side of a spool read boundary.
			const text = `\uFEFF${"x".repeat(LINE_STREAM_CHUNK - 4)}é${"y".repeat(LINE_STREAM_CHUNK)}`;
			try {
				const storage = new IndexedSessionStorage(new MemoryBackend());
				await storage.initialize();
				let allowed = true;
				let invalidateOnRead = false;
				const sizes: number[] = [];
				const read = fs.read;
				vi.spyOn(fs, "read").mockImplementation(((
					fd: number,
					buffer: Uint8Array,
					offset: number,
					length: number,
					position: number,
					callback: (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Uint8Array) => void,
				) => {
					sizes.push(length);
					read(fd, buffer, offset, length, position, (error, bytesRead, data) => {
						if (invalidateOnRead) allowed = false;
						callback(error, bytesRead, data);
					});
				}) as typeof fs.read);
				await storage.writeLinesAtomic(target, [text], { commitGuard: () => allowed });
				expect(sizes.length).toBeGreaterThan(1);
				expect(Math.max(...sizes)).toBeLessThanOrEqual(LINE_STREAM_CHUNK);
				expect(await storage.readText(target)).toBe(text);

				invalidateOnRead = true;
				await storage.writeLinesAtomic(target, ["stale rewrite\n"], { commitGuard: () => allowed });
				expect(storage.statSync(target).size).toBe(Buffer.byteLength(text));
				expect(await storage.readText(target)).toBe(text);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it("stops encoding an oversized read-back and requires exact bytes to confirm a failed publish", async () => {
		const target = "/sessions/read-back.jsonl";
		const backend = new MemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		await storage.writeText(target, "old body");
		const error = new Error("write response lost");
		vi.spyOn(backend, "writeFull").mockRejectedValue(error);
		const encoded = vi.spyOn(TextEncoder.prototype, "encodeInto");
		const readFull = backend.readFull.bind(backend);
		vi.spyOn(backend, "readFull").mockImplementation(file => {
			encoded.mockClear();
			return readFull(file);
		});
		try {
			const intended = "new body 🌲\n";
			backend.sessions.set(target, "x".repeat(3 * LINE_STREAM_CHUNK));
			await expect(storage.writeLinesAtomic(target, [intended])).rejects.toBe(error);
			const reads = encoded.mock.calls.map(([text]) => (text ?? "").length);
			expect(reads).toEqual([LINE_STREAM_CHUNK]);

			backend.sessions.set(target, "bad body 🌲\n");
			await expect(storage.writeLinesAtomic(target, [intended])).rejects.toBe(error);
			backend.sessions.set(target, intended);
			await expect(storage.writeLinesAtomic(target, [intended])).resolves.toBeUndefined();
			expect(storage.statSync(target).size).toBe(Buffer.byteLength(intended));
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("preserves a leading BOM in both chunked and whole-read scans", async () => {
		class ChunkedBackend extends MemoryBackend {
			async *readChunks(target: string, fromByte: number): AsyncGenerator<Uint8Array> {
				const bytes = Buffer.from((await this.readFull(target))!);
				for (let i = fromByte; i < bytes.length; i += 2) yield bytes.subarray(i, i + 2);
			}
		}
		const target = "/sessions/bom.jsonl";
		const text = `\uFEFF${body}`;
		for (const backend of [new MemoryBackend(), new ChunkedBackend()]) {
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(target, text);
			const visited: string[] = [];
			await storage.scanLines(target, line => {
				visited.push(line);
				return false;
			});
			expect(visited).toEqual(text.split("\n"));
		}
	});

	it("rejects a short stream without replacing the previous body", async () => {
		const backend = new StreamingMemoryBackend();
		const target = "/sessions/short.jsonl";
		await backend.writeFull(target, body);
		async function* shortStream() {
			yield Buffer.from("short");
		}
		const outcome = await backend.writeFullStream(target, shortStream(), 6).then(
			() => "stored",
			(error: unknown) => String(error),
		);
		expect({ outcome, stored: await backend.readFull(target) }).toEqual({
			outcome: expect.stringContaining("5 bytes, expected 6"),
			stored: body,
		});
	});

	// If this regresses, a full rewrite where the platform gives no account id (Windows) writes the
	// session's unmasked body to a file under the temporary directory, which takes that directory's
	// access list, and no directory owner can be checked against an account id there.
	it("makes no spool file without an account id: streams the body to a backend that takes a stream, and hands it whole to one that does not", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-windows-"));
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
		withoutAccountId();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const streaming = new StreamingMemoryBackend();
			const joined = new MemoryBackend();
			for (const backend of [streaming, joined]) {
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });
				storage.writeLinesSync("/sessions/sync.jsonl", serialized(), { expectedSize: null });
				await storage.drain();
			}

			expect({
				underTmp: fs.readdirSync(tmp),
				streamed: streaming.streamedBytes,
				streamingWriteFull: streaming.writeFullBytes,
				stored: [streaming, joined].map(backend => Object.fromEntries(backend.sessions)),
				spoolWarnings: spoolWarnings(warn.mock.calls),
			}).toEqual({
				underTmp: [],
				streamed: [Buffer.byteLength(body), Buffer.byteLength(body)],
				streamingWriteFull: [],
				stored: [
					{ "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
					{ "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
				],
				spoolWarnings: [],
			});
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	// If this regresses, a full rewrite where the platform gives no account id (Windows) reads the
	// session's entries again as it publishes, so an entry patched after the rewrite was queued fails
	// the publish ("Session rewrite not stored"): the synchronous rewrite reports a disk failure and the
	// atomic one throws to its caller.
	it("publishes the bytes the lines held when the rewrite was queued without an account id, whatever they hold after", async () => {
		withoutAccountId();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(logger, "error").mockImplementation(() => {});
		try {
			const backend = new HeldStreamBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			// A session's rewrite reads its lines from its live entries on each pass over them.
			const live = { data: "as queued" };
			const liveLines: Iterable<string> = {
				*[Symbol.iterator]() {
					yield lines[0]!;
					const entry = {
						type: "custom",
						customType: "n",
						id: "a",
						parentId: null,
						timestamp: "t1",
						data: live.data,
					};
					yield `${JSON.stringify(entry)}\n`;
				},
			};
			const queued = Array.from(liveLines).join("");
			const outcome = (write: Promise<void>): Promise<string> =>
				write.then(
					() => "stored",
					(error: unknown) => String(error),
				);

			storage.writeLinesSync("/sessions/sync.jsonl", liveLines, { expectedSize: null });
			await backend.entered();
			// Same length, other bytes: only the content changed.
			live.data = "patched!!";
			backend.release();
			const sync = await outcome(storage.drain());
			live.data = "as queued";
			const atomicWrite = storage.writeLinesAtomic("/sessions/atomic.jsonl", liveLines, { expectedSize: null });
			await backend.entered();
			live.data = "patched!!";
			backend.release();
			const atomic = await outcome(atomicWrite);

			expect({ sync, atomic, stored: Object.fromEntries(backend.sessions) }).toEqual({
				sync: "stored",
				atomic: "stored",
				stored: { "/sessions/sync.jsonl": queued, "/sessions/atomic.jsonl": queued },
			});
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("hands a subclass that intercepts writeTextAtomic and writeTextSync the joined lines, and stores them", async () => {
		const backend = new MemoryBackend();
		const storage = new InterceptingIndexedStorage(backend);
		await storage.initialize();

		await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });
		storage.writeLinesSync("/sessions/sync.jsonl", serialized(), { expectedSize: null });
		await storage.drain();

		expect(storage.intercepted).toEqual([body, body]);
		expect(Object.fromEntries(backend.sessions)).toEqual({
			"/sessions/atomic.jsonl": body,
			"/sessions/sync.jsonl": body,
		});
	});

	// If this regresses, a spooled body read after its release reads a closed descriptor, or one the
	// process has since given to another file, and publishes that file's bytes as the session.
	it.skipIf(process.getuid === undefined)(
		"refuses a read of a spooled body after its release, through a streamed write and a whole one",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-released-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const other = path.join(tmp, "other");
			fs.writeFileSync(other, "o".repeat(Buffer.byteLength(body)));
			try {
				const outcomes: Array<{ failure: string | undefined; stored: string | undefined }> = [];
				for (const backend of [new StreamingMemoryBackend(), new MemoryBackend()]) {
					// What the backend holds, read back after a failed publish.
					async function* stored(target: string): AsyncGenerator<Uint8Array> {
						const text = backend.sessions.get(target);
						if (text !== undefined) yield Buffer.from(text);
					}
					const bodies = new FullBodies(backend, stored);
					const released = bodies.lines("/sessions/released.jsonl", serialized());
					released.release?.();
					// The next file opened takes the descriptor number the spool held.
					const fd = fs.openSync(other, "r");
					try {
						// Called inside a task, as the store's path queue calls a publish.
						const failure = await Promise.resolve()
							.then(() => released.publish(1, null))
							.then(
								() => undefined,
								(error: unknown) => String(error),
							);
						outcomes.push({ failure, stored: backend.sessions.get("/sessions/released.jsonl") });
					} finally {
						fs.closeSync(fd);
					}
				}
				const refused = { failure: expect.stringContaining(RELEASED_BODY), stored: undefined };
				expect(outcomes).toEqual([refused, refused]);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	// If this regresses, an empty spooled body read after its release publishes an empty session
	// through a streamed write, where a longer one refuses the read as the body's contract says.
	it.skipIf(process.getuid === undefined)(
		"refuses a streamed read of an empty spooled body after its release",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-released-empty-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			try {
				const backend = new StreamingMemoryBackend();
				const bodies = new FullBodies(backend, async function* () {});
				const released = bodies.lines("/sessions/empty.jsonl", []);
				released.release?.();
				const failure = await released.publish(1, null).then(
					() => undefined,
					(error: unknown) => String(error),
				);

				expect({
					byteLength: released.byteLength,
					failure,
					stored: backend.sessions.get("/sessions/empty.jsonl"),
				}).toEqual({
					byteLength: 0,
					failure: expect.stringContaining(RELEASED_BODY),
					stored: undefined,
				});
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	// If this regresses, a body kept in memory (no account id, Windows) read after its release publishes
	// an empty session, or refuses with another message than a released spool's, so one body contract
	// reports one fault two ways.
	it("refuses a read of a body kept in memory after its release, through a streamed write and a whole one, as a spool does", async () => {
		withoutAccountId();
		try {
			const outcomes: Array<{ failure: string | undefined; stored: string | undefined }> = [];
			for (const backend of [new StreamingMemoryBackend(), new MemoryBackend()]) {
				const bodies = new FullBodies(backend, async function* () {});
				const released = bodies.lines("/sessions/released.jsonl", serialized());
				released.release?.();
				// Called inside a task, as the store's path queue calls a publish.
				const failure = await Promise.resolve()
					.then(() => released.publish(1, null))
					.then(
						() => undefined,
						(error: unknown) => String(error),
					);
				outcomes.push({ failure, stored: backend.sessions.get("/sessions/released.jsonl") });
			}
			const refused = { failure: expect.stringContaining(RELEASED_BODY), stored: undefined };
			expect(outcomes).toEqual([refused, refused]);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
