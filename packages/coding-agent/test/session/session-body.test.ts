/**
 * The bodies of indexed storage's full writes (`session-body.ts`): a rewrite of
 * lines on a backend that takes a streamed write goes through a private spool
 * file, or, where the account id cannot be read, a compressed copy in memory;
 * a backend without a streamed write takes the joined lines.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
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
import { parseTitleSlotFromContent, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { logger } from "@oh-my-pi/pi-utils";
import { withoutAccountId } from "../helpers/account-id";
import { MemoryBackend, StreamingMemoryBackend } from "../helpers/memory-session-backend";
import { endSpoolReadsAt, fillDiskUnder, holdFirstSpoolWrite, spoolWarnings } from "../helpers/spool-unusable";

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

/**
 * Whether a rewrite waits on `reached`, an asynchronous call it makes, before
 * it settles: `step` (by default its body's preparation) when it does.
 */
function firstOf(reached: Promise<void>, rewrite: Promise<void>, step = "preparing"): Promise<string> {
	return Promise.race([
		reached.then(() => step),
		rewrite.then(
			() => "settled",
			() => "settled",
		),
	]);
}

/** Past what an ordering case waits: held gates it releases itself, and a few writes to memory. */
const ORDER_TIMEOUT_MS = 10_000;

/**
 * A {@link StreamingMemoryBackend} that records what it holds after each
 * full write and each move, in the order it takes them, and can hold its
 * next streamed write until the test releases it.
 */
class OrderedBackend extends StreamingMemoryBackend {
	/** `path: text` after each full write, `src -> dst: text` after each move. */
	readonly stores: string[] = [];
	#streamHold: { reached: () => void; gate: Promise<void> } | undefined;

	/** Hold the next streamed write before it reads its stream; `reached` resolves once it waits. */
	holdNextStream(): Held {
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		this.#streamHold = { reached: () => reached.resolve(), gate: gate.promise };
		return { reached: reached.promise, release: () => gate.resolve() };
	}

	override async writeFull(path: string, content: string): Promise<void> {
		await super.writeFull(path, content);
		this.stores.push(`${path}: ${content}`);
	}

	override async writeFullStream(path: string, chunks: AsyncIterable<Uint8Array>, byteLength: number): Promise<void> {
		const hold = this.#streamHold;
		this.#streamHold = undefined;
		if (hold) {
			hold.reached();
			await hold.gate;
		}
		await super.writeFullStream(path, chunks, byteLength);
		this.stores.push(`${path}: ${this.sessions.get(path)}`);
	}

	override async move(src: string, dst: string): Promise<void> {
		await super.move(src, dst);
		this.stores.push(`${src} -> ${dst}: ${this.sessions.get(dst)}`);
	}
}

/** A held step of a rewrite (its body's preparation, its publish): `reached` resolves once it waits, and it waits until `release`. */
interface Held {
	reached: Promise<void>;
	release: () => void;
}

/**
 * Hold each asynchronous compression (`Bun.zstdCompress`) until `release`
 * runs; `reached` resolves once the first waits. `vi.restoreAllMocks()` undoes
 * the hold for later calls; a held call waits for `release`.
 */
function holdCompression(): Held {
	const compress = Bun.zstdCompress;
	const reached = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	vi.spyOn(Bun, "zstdCompress").mockImplementation((async (data: Uint8Array, options?: { level?: number }) => {
		reached.resolve();
		await gate.promise;
		return Reflect.apply(compress, Bun, [data, options]);
	}) as typeof Bun.zstdCompress);
	return { reached: reached.promise, release: () => gate.resolve() };
}

/** The title slot the session manager writes first in a body, for `title`. */
function titleSlot(title: string): string {
	return serializeTitleSlot({ title, source: "user", updatedAt: "2026-01-01T00:00:00.000Z" });
}

describe("IndexedSessionStorage full writes of lines", () => {
	// SessionManager passes an array of serialized lines.
	const lines = [
		`${JSON.stringify({ type: "session", version: 3, id: "lazy", timestamp: "t0", cwd: "/cwd" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "a", parentId: null, timestamp: "t1" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "b", parentId: "a", timestamp: "t2" })}\n`,
	];
	const body = lines.join("");

	/** What the running test acquired, each released after it, newest first, even when one before it throws. */
	let cleanup = new AsyncDisposableStack();
	afterEach(async () => {
		const acquired = cleanup;
		cleanup = new AsyncDisposableStack();
		// First: a held call released after it runs the real one, and the temporary directory is
		// the real one again before the directories standing for it go.
		acquired.defer(() => vi.restoreAllMocks());
		await acquired.disposeAsync();
	});

	/** A new directory standing for `os.tmpdir()` in this test, removed after it. */
	async function useTmpDir(prefix: string): Promise<string> {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
		cleanup.defer(() => fsp.rm(tmp, { recursive: true, force: true }));
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
		return tmp;
	}

	/** `held`, released after the test too, also when it fails before it releases it. */
	function releasedAfter(held: Held): Held {
		cleanup.defer(held.release);
		return held;
	}

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
		const tmp = await useTmpDir("omp-spool-joined-");
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
	});

	it.skipIf(process.getuid === undefined)(
		"spools into a directory of this account's own under the OS temp directory, private to it",
		async () => {
			// Another account on the machine that ran omp first owns any shared name there.
			const tmp = await useTmpDir("omp-spool-dir-");
			const storage = new IndexedSessionStorage(new StreamingMemoryBackend());
			await storage.initialize();
			await storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });

			const spools = fs.readdirSync(tmp);
			expect(spools).toEqual([`omp-spool-${process.getuid?.()}`]);
			expect(fs.statSync(path.join(tmp, spools[0] ?? "")).mode & 0o777).toBe(0o700);
		},
	);

	it.skipIf(process.getuid === undefined)(
		"streams the lines straight to the backend when the spool fails, warning once",
		async () => {
			const tmp = await useTmpDir("omp-spool-full-");
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
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
		},
	);

	// If this regresses, a large atomic rewrite whose spool cannot be used (a full temporary disk) reads the
	// whole transcript in one turn of the event loop to measure it, and the TUI and every other session of
	// the process freeze while it does.
	it.skipIf(process.getuid === undefined)(
		"measures an atomic rewrite whose spool fails in chunks, letting the event loop run between them",
		async () => {
			const tmp = await useTmpDir("omp-spool-full-measure-");
			const target = "/sessions/measured.jsonl";
			// Four chunks of the lines.
			const rewrite = Array.from(
				{ length: 6 },
				(_, n) => `${JSON.stringify({ type: "custom", n, data: "x".repeat(LINE_STREAM_CHUNK / 2) })}\n`,
			);
			const backend = new StreamingMemoryBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			const disk = fillDiskUnder(tmp);
			// Each piece of a line encoded, by the spool, the measure, and the publish.
			const encoded = vi.spyOn(TextEncoder.prototype, "encodeInto");
			let encodedBeforeMeasure = 0;
			let firstTurn: { encoded: number; published: number } | undefined;
			vi.spyOn(logger, "warn").mockImplementation(message => {
				if (!String(message).includes("spool")) return;
				// The spool failed: the lines are measured from here, then published.
				encodedBeforeMeasure = encoded.mock.calls.length;
				setImmediate(() => {
					firstTurn = {
						encoded: encoded.mock.calls.length - encodedBeforeMeasure,
						published: backend.streamedBytes.length,
					};
				});
			});
			await storage.writeLinesAtomic(target, rewrite, { expectedSize: null });
			// The measure and the publish each encode the lines once.
			const encodedByMeasure = (encoded.mock.calls.length - encodedBeforeMeasure) / 2;

			expect({
				refused: disk.refused(),
				firstTurnMidMeasure:
					firstTurn !== undefined && firstTurn.encoded > 0 && firstTurn.encoded < encodedByMeasure,
				publishedByFirstTurn: firstTurn?.published,
				storedIsRewrite: backend.sessions.get(target) === rewrite.join(""),
			}).toEqual({ refused: 1, firstTurnMidMeasure: true, publishedByFirstTurn: 0, storedIsRewrite: true });
		},
	);

	// If this regresses, a large atomic rewrite (a compaction) freezes the TUI and every other session of
	// the process while its body is spooled, or stores a body its commit guard refused meanwhile.
	it.skipIf(process.getuid === undefined)(
		"spools an atomic rewrite through asynchronous writes, and stores nothing when its commit guard fails meanwhile",
		async () => {
			const tmp = await useTmpDir("omp-spool-async-write-");
			const target = "/sessions/guarded.jsonl";
			const backend = new StreamingMemoryBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(target, "previous body\n");
			const held = releasedAfter(holdFirstSpoolWrite(tmp));
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
		},
	);

	// If this regresses, a write called while a large rewrite's body is spooled lands first, and the rewrite,
	// called before it, then replaces it: the session keeps the older of the two bodies.
	it.skipIf(process.getuid === undefined)(
		"publishes a write called while an atomic rewrite's body is spooled after the rewrite, in call order",
		async () => {
			const tmp = await useTmpDir("omp-spool-order-");
			const target = "/sessions/order.jsonl";
			const later = "written after the rewrite was called\n";
			const backend = new StreamingMemoryBackend();
			// What the backend holds after each full write it takes, in the order it takes them.
			const stores: string[] = [];
			const writeFull = backend.writeFull.bind(backend);
			vi.spyOn(backend, "writeFull").mockImplementation(async (file, content) => {
				await writeFull(file, content);
				stores.push(content);
			});
			const writeFullStream = backend.writeFullStream.bind(backend);
			vi.spyOn(backend, "writeFullStream").mockImplementation(async (file, chunks, byteLength) => {
				await writeFullStream(file, chunks, byteLength);
				stores.push(backend.sessions.get(file) ?? "");
			});
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(target, "previous body\n");
			const held = releasedAfter(holdFirstSpoolWrite(tmp));
			const rewrite = storage.writeLinesAtomic(target, lines);
			const first = await firstOf(held.reached, rewrite);
			// Called while the rewrite's body is spooled, with no commit guard and no expected size.
			const write = storage.writeTextAtomic(target, later);
			held.release();
			await Promise.all([rewrite, write]);

			expect({ first, stores, stored: backend.sessions.get(target), size: storage.statSync(target).size }).toEqual({
				first: "preparing",
				stores: ["previous body\n", body, later],
				stored: later,
				size: Buffer.byteLength(later),
			});
		},
	);

	// If this regresses, a write called while a rewrite prepares its body queues behind one called later,
	// once the rewrite publishes, and replaces it: both report success, and the session keeps the older body.
	it(
		"publishes three writes to a path in call order: a rewrite held while it prepares and while it publishes, a write called while it prepares, and one called while it publishes",
		async () => {
			withoutAccountId();
			const target = "/sessions/three.jsonl";
			const backend = new OrderedBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(target, "previous\n");
			const preparing = releasedAfter(holdCompression());
			const publishing = releasedAfter(backend.holdNextStream());

			const rewrite = storage.writeLinesAtomic(target, lines);
			const prepared = await firstOf(preparing.reached, rewrite);
			const whilePreparing = storage.writeText(target, "B\n");
			preparing.release();
			const published = await firstOf(publishing.reached, rewrite, "publishing");
			const whilePublishing = storage.writeText(target, "C\n");
			publishing.release();
			const outcomes = await Promise.allSettled([rewrite, whilePreparing, whilePublishing]);

			expect({
				prepared,
				published,
				outcomes: outcomes.map(settled => settled.status),
				stores: backend.stores,
				stored: backend.sessions.get(target),
				size: storage.statSync(target).size,
			}).toEqual({
				prepared: "preparing",
				published: "publishing",
				outcomes: ["fulfilled", "fulfilled", "fulfilled"],
				stores: [`${target}: previous\n`, `${target}: ${body}`, `${target}: B\n`, `${target}: C\n`],
				stored: "C\n",
				size: Buffer.byteLength("C\n"),
			});
		},
		ORDER_TIMEOUT_MS,
	);

	// If this regresses, a session moved onto a path and then rewritten there (a fork or a move that rewrites
	// the header) loses the rewrite: the move, called first, waits for it and then replaces it.
	it(
		"leaves a rewrite of a rename's destination, called after the rename, at the destination",
		async () => {
			withoutAccountId();
			const src = "/sessions/source.jsonl";
			const dst = "/sessions/destination.jsonl";
			const backend = new OrderedBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(src, "source\n");
			await storage.writeText(dst, "destination\n");

			const renamed = storage.rename(src, dst);
			const rewrite = storage.writeLinesAtomic(dst, lines);
			const outcomes = await Promise.allSettled([renamed, rewrite]);

			expect({
				outcomes: outcomes.map(settled => settled.status),
				stores: backend.stores,
				stored: Object.fromEntries(backend.sessions),
				indexed: { src: storage.existsSync(src), dstSize: storage.statSync(dst).size },
			}).toEqual({
				outcomes: ["fulfilled", "fulfilled"],
				stores: [`${src}: source\n`, `${dst}: destination\n`, `${src} -> ${dst}: source\n`, `${dst}: ${body}`],
				stored: { [dst]: body },
				indexed: { src: false, dstSize: Buffer.byteLength(body) },
			});
		},
		ORDER_TIMEOUT_MS,
	);

	// If this regresses, a rewrite whose body cannot be prepared (its compression fails) lets a write called
	// after it past the rewrite called before it, which then replaces that later write.
	it(
		"keeps a rewrite ahead of later writes when a rewrite called between them fails to prepare its body",
		async () => {
			withoutAccountId();
			const target = "/sessions/failed-middle.jsonl";
			const compress = Bun.zstdCompress;
			const first = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			cleanup.defer(() => gate.resolve());
			const compressionFailed = new Error("compression failed");
			let compressions = 0;
			// The first rewrite's body is one block, held; the second rewrite's block fails.
			vi.spyOn(Bun, "zstdCompress").mockImplementation((async (data: Uint8Array, options?: { level?: number }) => {
				compressions++;
				if (compressions === 2) throw compressionFailed;
				if (compressions === 1) {
					first.resolve();
					await gate.promise;
				}
				return Reflect.apply(compress, Bun, [data, options]);
			}) as typeof Bun.zstdCompress);
			const backend = new OrderedBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(target, "previous\n");

			const rewrite = storage.writeLinesAtomic(target, lines);
			const prepared = await firstOf(first.promise, rewrite);
			// Fails while the first rewrite is still held, and reports it to its own caller only.
			const failed = await storage.writeLinesAtomic(target, ["middle\n"]).then(
				() => undefined,
				(error: unknown) => error,
			);
			const later = storage.writeTextAtomic(target, "C\n");
			gate.resolve();
			const outcomes = await Promise.allSettled([rewrite, later]);

			expect({
				prepared,
				failed,
				outcomes: outcomes.map(settled => settled.status),
				stores: backend.stores,
				stored: backend.sessions.get(target),
				size: storage.statSync(target).size,
			}).toEqual({
				prepared: "preparing",
				failed: compressionFailed,
				outcomes: ["fulfilled", "fulfilled"],
				stores: [`${target}: previous\n`, `${target}: ${body}`, `${target}: C\n`],
				stored: "C\n",
				size: Buffer.byteLength("C\n"),
			});
		},
		ORDER_TIMEOUT_MS,
	);

	/**
	 * An atomic rewrite of lines past one chunk, a title slot first, whose
	 * caller puts another title slot first and another last line in its array
	 * once the body's preparation waits on `held`; what the store then holds
	 * and reads back.
	 */
	async function rewriteWhileTheCallerChangesItsLines(held: Held) {
		const target = "/sessions/handed.jsonl";
		const handed = [
			titleSlot("Handed over"),
			`${JSON.stringify({ type: "custom", data: "x".repeat(LINE_STREAM_CHUNK) })}\n`,
			"last line handed over\n",
		];
		const expected = handed.join("");
		const backend = new StreamingMemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const rewrite = storage.writeLinesAtomic(target, handed, { expectedSize: null });
		const first = await firstOf(held.reached, rewrite);
		handed[0] = titleSlot("Changed by the caller");
		handed[2] = "last line changed by the caller\n";
		held.release();
		await rewrite;
		const stored = backend.sessions.get(target) ?? "";
		// The title comes from the store's index, laid over the stored slot.
		const read = await storage.readText(target);
		return {
			first,
			storedLastLine: stored.slice(stored.lastIndexOf("\n", stored.length - 2) + 1),
			readTitle: parseTitleSlotFromContent(read)?.title,
			// Whole bodies compared here, so a failure does not print a megabyte.
			storedIsHanded: stored === expected,
			readIsHanded: read === expected,
		};
	}

	const handedOver = {
		first: "preparing",
		storedLastLine: "last line handed over\n",
		readTitle: "Handed over",
		storedIsHanded: true,
		readIsHanded: true,
	};

	// If this regresses, a caller that changes its array of lines while an atomic rewrite's body is prepared
	// gets a stored line, or a title, that it never handed over.
	it.skipIf(process.getuid === undefined)(
		"stores the lines and title an atomic rewrite was handed when the caller changes its array while they are spooled",
		async () => {
			const tmp = await useTmpDir("omp-spool-handed-");
			const held = releasedAfter(holdFirstSpoolWrite(tmp));
			expect(await rewriteWhileTheCallerChangesItsLines(held)).toEqual(handedOver);
		},
	);

	it("stores the lines and title an atomic rewrite was handed when the caller changes its array while they are compressed without an account id", async () => {
		withoutAccountId();
		const held = releasedAfter(holdCompression());
		expect(await rewriteWhileTheCallerChangesItsLines(held)).toEqual(handedOver);
	});

	// If this regresses, a large atomic rewrite where the platform gives no account id (Windows) freezes
	// the TUI and every other session of the process while its body is compressed.
	it("compresses an atomic rewrite's body off the event loop without an account id", async () => {
		withoutAccountId();
		const held = releasedAfter(holdCompression());
		const backend = new StreamingMemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const rewrite = storage.writeLinesAtomic("/sessions/atomic.jsonl", lines, { expectedSize: null });
		const first = await firstOf(held.reached, rewrite);
		held.release();
		await rewrite;

		expect({ first, stored: backend.sessions.get("/sessions/atomic.jsonl") }).toEqual({
			first: "preparing",
			stored: body,
		});
	});

	it.skipIf(process.getuid === undefined)(
		"spools a large record in bounded writes without splitting a surrogate pair",
		async () => {
			await useTmpDir("omp-spool-utf8-");
			const target = "/sessions/utf8.jsonl";
			const prefix = '{"type":"custom","data":"';
			const record = `${prefix}${"x".repeat(LINE_STREAM_CHUNK - prefix.length - 1)}😀z"}\n`;
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
		},
	);

	it.skipIf(process.getuid === undefined)(
		"streams a spooled body in bounded reads, keeping a BOM and a character split across two reads",
		async () => {
			await useTmpDir("omp-spool-reads-");
			const target = "/sessions/reads.jsonl";
			// A BOM and a two-byte character with one byte on each side of a spool read boundary.
			const text = `\uFEFF${"x".repeat(LINE_STREAM_CHUNK - 4)}é${"y".repeat(LINE_STREAM_CHUNK)}`;
			const storage = new IndexedSessionStorage(new StreamingMemoryBackend());
			await storage.initialize();
			const reads = vi.spyOn(fs, "read");
			await storage.writeLinesAtomic(target, [text]);
			// `fs.read(fd, buffer, offset, length, position, callback)`, as the spool calls it.
			const sizes = reads.mock.calls.map(call => Number((call as unknown[])[3]));
			expect(sizes.length).toBeGreaterThan(1);
			expect(Math.max(...sizes)).toBeLessThanOrEqual(LINE_STREAM_CHUNK);
			expect(await storage.readText(target)).toBe(text);
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

	// If this regresses, a rewrite whose spool file reads back short (a disk fault, the file cut under the
	// process) publishes a truncated session through a backend that does not count the bytes it takes, or
	// the store's index keeps the size of a body the backend never took.
	it.skipIf(process.getuid === undefined)(
		"rejects an atomic rewrite whose spool ends early, keeping the previous body and its size",
		async () => {
			const tmp = await useTmpDir("omp-spool-short-");
			const target = "/sessions/short.jsonl";
			// Past one spool read: the spool ends after the first.
			const rewrite = [...lines, `${JSON.stringify({ type: "custom", data: "x".repeat(LINE_STREAM_CHUNK) })}\n`];
			const backend = new StreamingMemoryBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			await storage.writeText(target, body);
			const reads = endSpoolReadsAt(tmp, LINE_STREAM_CHUNK);

			const failure = await storage
				.writeLinesAtomic(target, rewrite, { expectedSize: Buffer.byteLength(body) })
				.then(
					() => "stored",
					(error: unknown) => String(error),
				);
			expect({
				failure,
				cut: reads.cut(),
				stored: backend.sessions.get(target),
				size: storage.statSync(target).size,
				streamed: backend.streamedBytes,
			}).toEqual({
				// The spool's own refusal, not the backend's count of what it took.
				failure: expect.stringContaining(
					`Session body spool ended at byte ${LINE_STREAM_CHUNK} of ${Buffer.byteLength(rewrite.join(""))}`,
				),
				cut: 1,
				stored: body,
				size: Buffer.byteLength(body),
				streamed: [],
			});
		},
	);

	// If this regresses, a full rewrite where the platform gives no account id (Windows) writes the
	// session's unmasked body to a file under the temporary directory, which takes that directory's
	// access list, and no directory owner can be checked against an account id there.
	it("makes no spool file without an account id: streams the body to a backend that takes a stream, and hands it whole to one that does not", async () => {
		const tmp = await useTmpDir("omp-spool-windows-");
		withoutAccountId();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
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
		const tmp = await useTmpDir("omp-spool-released-");
		const other = path.join(tmp, "other");
		fs.writeFileSync(other, "o".repeat(Buffer.byteLength(body)));
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
		cleanup.defer(() => fs.closeSync(fd));
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
	});

	// If this regresses, an empty spooled body read after its release publishes an empty session
	// through a streamed write, where a longer one refuses the read as the body's contract says.
	it.skipIf(process.getuid === undefined)(
		"refuses a streamed read of an empty spooled body after its release",
		async () => {
			await useTmpDir("omp-spool-released-empty-");
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
		},
	);

	// If this regresses, a body kept in memory (no account id, Windows) read after its release publishes
	// an empty session, or refuses with another message than a released spool's, so one body contract
	// reports one fault two ways.
	it("refuses a streamed read of a body kept in memory after its release, as a spool does", async () => {
		withoutAccountId();
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
	});
});
