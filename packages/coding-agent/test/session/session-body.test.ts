/**
 * The bodies of indexed storage's full writes (`session-body.ts`): a rewrite of
 * lines on a backend that takes a streamed write goes through a private spool
 * file, or, where the account id cannot be read, a compressed copy in memory;
 * a backend without a streamed write takes the joined lines.
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
import { fillDiskUnder, holdFirstSpoolWrite, spoolWarnings } from "../helpers/spool-unusable";

/** What a read of a rewrite's body after its release throws, whether the body is spooled or kept in memory. */
const RELEASED_BODY = "A session rewrite's body was read after it was released";

/** An indexed storage that records each full rewrite its text and line writers see. */
class InterceptingIndexedStorage extends IndexedSessionStorage {
	readonly intercepted: string[] = [];

	override writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.intercepted.push(`text:${content}`);
		super.writeTextSync(path, content, options);
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.intercepted.push(`text:${content}`);
		await super.writeTextAtomic(path, content, options);
	}

	override writeLinesSync(path: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.intercepted.push(`lines:${lines.join("")}`);
		super.writeLinesSync(path, lines, options);
	}

	override async writeLinesAtomic(
		path: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.intercepted.push(`lines:${lines.join("")}`);
		await super.writeLinesAtomic(path, lines, options);
	}
}

/** Whether a rewrite's body preparation waits on `reached`, an asynchronous call it makes, before the rewrite settles. */
function firstOf(reached: Promise<void>, rewrite: Promise<void>): Promise<string> {
	return Promise.race([
		reached.then(() => "preparing"),
		rewrite.then(
			() => "settled",
			() => "settled",
		),
	]);
}

describe("IndexedSessionStorage full writes of lines", () => {
	// SessionManager passes an array of serialized lines.
	const lines = [
		`${JSON.stringify({ type: "session", version: 3, id: "lazy", timestamp: "t0", cwd: "/cwd" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "a", parentId: null, timestamp: "t1" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "b", parentId: "a", timestamp: "t2" })}\n`,
	];
	const body = lines.join("");

	it("streams the lines' bytes through writeLinesAtomic and writeLinesSync to a backend that takes a stream", async () => {
		const backend = new StreamingMemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
		storage.writeLinesSync("/sessions/sync.jsonl", lines, { expectedSize: null });
		await storage.drain();

		expect({
			streamed: backend.streamedBytes,
			writeFull: backend.writeFullBytes,
			stored: Object.fromEntries(backend.sessions),
		}).toEqual({
			streamed: [Buffer.byteLength(body), Buffer.byteLength(body)],
			writeFull: [],
			stored: { "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
		});
	});

	// If this regresses, every rewrite on a backend without a streamed write (the built-in SQL and Redis
	// storage) writes the whole transcript to a temporary file and reads it back into one string anyway,
	// a full-transcript disk write and read for nothing.
	it("hands a backend without a streamed write the joined lines, and makes no spool file", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-joined-"));
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
		try {
			const backend = new MemoryBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();

			await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
			storage.writeLinesSync("/sessions/sync.jsonl", lines, { expectedSize: null });
			await storage.drain();

			expect({
				underTmp: fs.readdirSync(tmp),
				writeFull: backend.writeFullBytes,
				stored: Object.fromEntries(backend.sessions),
			}).toEqual({
				underTmp: [],
				writeFull: [Buffer.byteLength(body), Buffer.byteLength(body)],
				stored: { "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
			});
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	it.skipIf(process.getuid === undefined)(
		"spools into a directory of this account's own under the OS temp directory, private to it",
		async () => {
			// Another account on the machine that ran omp first owns any shared name there.
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-dir-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			try {
				const storage = new IndexedSessionStorage(new StreamingMemoryBackend());
				await storage.initialize();
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });

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
		"streams the lines straight to the backend when the spool fails, warning once",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-full-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			try {
				const backend = new StreamingMemoryBackend();
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				const disk = fillDiskUnder(tmp);
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
				storage.writeLinesSync("/sessions/sync.jsonl", lines, { expectedSize: null });
				await storage.drain();
				expect({
					refused: disk.refused(),
					warnings: spoolWarnings(warn.mock.calls).length,
					streamed: backend.streamedBytes,
					stored: Object.fromEntries(backend.sessions),
				}).toEqual({
					refused: 2,
					warnings: 1,
					streamed: [Buffer.byteLength(body), Buffer.byteLength(body)],
					stored: { "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
				});
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	// If this regresses, a large atomic rewrite (a compaction) freezes the TUI and every other session of
	// the process while its body is spooled, or stores a body its commit guard refused meanwhile.
	it.skipIf(process.getuid === undefined)(
		"spools an atomic rewrite through asynchronous writes, and stores nothing when its commit guard fails meanwhile",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-async-write-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const target = "/sessions/guarded.jsonl";
			try {
				const backend = new StreamingMemoryBackend();
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				await storage.writeText(target, "previous body\n");
				const held = holdFirstSpoolWrite(tmp);
				let allowed = true;
				const rewrite = storage.writeLinesAtomic(target, lines, { commitGuard: () => allowed });
				const first = await firstOf(held.reached, rewrite);
				// Another writer takes the session over while the body is spooled.
				allowed = false;
				held.release();
				await rewrite;

				expect({ first, stored: backend.sessions.get(target), size: storage.statSync(target).size }).toEqual({
					first: "preparing",
					stored: "previous body\n",
					size: Buffer.byteLength("previous body\n"),
				});
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	// If this regresses, a large atomic rewrite where the platform gives no account id (Windows) freezes
	// the TUI and every other session of the process while its body is compressed.
	it("compresses an atomic rewrite's body off the event loop without an account id", async () => {
		withoutAccountId();
		const compress = Bun.zstdCompress;
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		vi.spyOn(Bun, "zstdCompress").mockImplementation((async (data: Uint8Array, options?: { level?: number }) => {
			reached.resolve();
			await gate.promise;
			return Reflect.apply(compress, Bun, [data, options]);
		}) as typeof Bun.zstdCompress);
		try {
			const backend = new StreamingMemoryBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			const rewrite = storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
			const first = await firstOf(reached.promise, rewrite);
			gate.resolve();
			await rewrite;

			expect({ first, stored: backend.sessions.get("/sessions/atomic.jsonl") }).toEqual({
				first: "preparing",
				stored: body,
			});
		} finally {
			gate.resolve();
			vi.restoreAllMocks();
		}
	});

	it.skipIf(process.getuid === undefined)(
		"spools a large record in bounded writes without splitting a surrogate pair",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-utf8-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const target = "/sessions/utf8.jsonl";
			const prefix = '{"type":"custom","data":"';
			const record = `${prefix}${"x".repeat(LINE_STREAM_CHUNK - prefix.length - 1)}😀z"}\n`;
			try {
				const storage = new IndexedSessionStorage(new StreamingMemoryBackend());
				await storage.initialize();
				const writes = vi.spyOn(fs, "write");
				await storage.writeLinesAtomic(target, [record], { expectedSize: null });
				expect(Buffer.from(await storage.readText(target))).toEqual(Buffer.from(record));
				// `fs.write(fd, buffer, offset, length, position, callback)`, as the spool calls it.
				const sizes = writes.mock.calls.flatMap(call => {
					const [fd, data] = call as unknown[];
					return typeof fd === "number" && ArrayBuffer.isView(data) ? [data.byteLength] : [];
				});
				expect(sizes.length).toBeGreaterThan(1);
				expect(Math.max(...sizes)).toBeLessThanOrEqual(LINE_STREAM_CHUNK);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.getuid === undefined)(
		"streams a spooled body in bounded reads, keeping a BOM and a character split across two reads",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-reads-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const target = "/sessions/reads.jsonl";
			// A BOM and a two-byte character with one byte on each side of a spool read boundary.
			const text = `\uFEFF${"x".repeat(LINE_STREAM_CHUNK - 4)}é${"y".repeat(LINE_STREAM_CHUNK)}`;
			try {
				const storage = new IndexedSessionStorage(new StreamingMemoryBackend());
				await storage.initialize();
				const reads = vi.spyOn(fs, "read");
				await storage.writeLinesAtomic(target, [text]);
				// `fs.read(fd, buffer, offset, length, position, callback)`, as the spool calls it.
				const sizes = reads.mock.calls.map(call => Number((call as unknown[])[3]));
				expect(sizes.length).toBeGreaterThan(1);
				expect(Math.max(...sizes)).toBeLessThanOrEqual(LINE_STREAM_CHUNK);
				expect(await storage.readText(target)).toBe(text);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	it("stops encoding an oversized read-back and requires exact bytes to confirm a failed publish", async () => {
		const target = "/sessions/read-back.jsonl";
		const backend = new StreamingMemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		await storage.writeText(target, "old body");
		const error = new Error("write response lost");
		vi.spyOn(backend, "writeFullStream").mockRejectedValue(error);
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
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
				storage.writeLinesSync("/sessions/sync.jsonl", lines, { expectedSize: null });
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

	// If this regresses, a subclass or spy that takes each rewrite's lines (as a test of the session
	// manager's rewrites does) misses them, or a subclass that overrides the text writers silently turns
	// every streamed rewrite into one transcript-sized string.
	it("hands a subclass that intercepts writeLinesAtomic and writeLinesSync each rewrite's lines, still streamed past its text writers", async () => {
		const backend = new StreamingMemoryBackend();
		const storage = new InterceptingIndexedStorage(backend);
		await storage.initialize();

		await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
		storage.writeLinesSync("/sessions/sync.jsonl", lines, { expectedSize: null });
		await storage.drain();

		expect({
			intercepted: storage.intercepted,
			streamed: backend.streamedBytes,
			stored: Object.fromEntries(backend.sessions),
		}).toEqual({
			intercepted: [`lines:${body}`, `lines:${body}`],
			streamed: [Buffer.byteLength(body), Buffer.byteLength(body)],
			stored: { "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
		});
	});

	// If this regresses, a spooled body read after its release reads a closed descriptor, or one the
	// process has since given to another file, and publishes that file's bytes as the session.
	it.skipIf(process.getuid === undefined)("refuses a streamed read of a spooled body after its release", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-released-"));
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
		const other = path.join(tmp, "other");
		fs.writeFileSync(other, "o".repeat(Buffer.byteLength(body)));
		try {
			const backend = new StreamingMemoryBackend();
			// What the backend holds, read back after a failed publish.
			async function* stored(target: string): AsyncGenerator<Uint8Array> {
				const text = backend.sessions.get(target);
				if (text !== undefined) yield Buffer.from(text);
			}
			const bodies = new FullBodies(backend, stored);
			const released = await bodies.lines("/sessions/released.jsonl", lines);
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
				expect({ failure, stored: backend.sessions.get("/sessions/released.jsonl") }).toEqual({
					failure: expect.stringContaining(RELEASED_BODY),
					stored: undefined,
				});
			} finally {
				fs.closeSync(fd);
			}
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

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
				const released = await bodies.lines("/sessions/empty.jsonl", []);
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
	it("refuses a streamed read of a body kept in memory after its release, as a spool does", async () => {
		withoutAccountId();
		try {
			const backend = new StreamingMemoryBackend();
			const bodies = new FullBodies(backend, async function* () {});
			const released = await bodies.lines("/sessions/released.jsonl", lines);
			released.release?.();
			// Called inside a task, as the store's path queue calls a publish.
			const failure = await Promise.resolve()
				.then(() => released.publish(1, null))
				.then(
					() => undefined,
					(error: unknown) => String(error),
				);
			expect({ failure, stored: backend.sessions.get("/sessions/released.jsonl") }).toEqual({
				failure: expect.stringContaining(RELEASED_BODY),
				stored: undefined,
			});
		} finally {
			vi.restoreAllMocks();
		}
	});
});
