/**
 * The bodies of an indexed store's full writes ({@link FullBodies}): from a
 * string, or, for a backend that takes a streamed write, from lines read once
 * into a private spool file or, where the platform has no account id, into
 * compressed blocks in memory, or streamed from the lines when the spool
 * cannot be used. An atomic rewrite handed an array of lines reads them from
 * a copy of that array taken when it is called.
 */
import * as fs from "node:fs";
import { countNewlines, logger, toError } from "@oh-my-pi/pi-utils";
import { getPrivateTempDir } from "@oh-my-pi/pi-utils/dirs";
import { digestChunksSync, digestStream } from "../utils/file-hash";
import { openPrivateTempFile, openPrivateTempFileSync, type PrivateTempFile } from "../utils/owner-private-dir";
import { BLOCK_ZSTD_LEVEL } from "./block-zstd-level";
import type { SessionStorageBackend } from "./indexed-session-storage";
import {
	LINE_STREAM_CHUNK,
	SessionLeaseLostError,
	SessionWriteConflictError,
	sessionHeaderIdInPrefix,
	writeLinesToDescriptor,
	writeLinesToDescriptorSync,
} from "./session-storage";
import { parseTitleSlotFromContent, type SessionTitleUpdate, titleUpdateFromSlot } from "./session-title-slot";

/**
 * The prefix of the private temporary directory the spool files live in,
 * `omp-spool-<uid>` ({@link getPrivateTempDir}): the one a spool opens its
 * file in and the one its warning names.
 */
const SPOOL_DIR_PREFIX = "omp-spool";

/** What a refusal of the spool's directory names it. */
const SPOOL_DIR_LABEL = "Session spool directory";

/** One full write: its size and title slot, its backend publish, and the read-back after a failed publish. */
export interface FullBody {
	byteLength: number;
	title: SessionTitleUpdate | undefined;
	publish(mtimeMs: number, expectedSize: number | null | undefined): Promise<void>;
	/** Whether the backend holds exactly this body. */
	isStored(): Promise<boolean>;
	/** Free what the body holds, once its publish (and any read-back) has settled. */
	release?: () => void;
}

/**
 * A full-write body read from its lines once, when the write is queued, and
 * kept until its publish (and any read-back) has settled: so the publish
 * stores the bytes the lines held then, whatever changes in the entries
 * after, and the lines a caller hands over are not held a second time while
 * the publish waits in the path queue. A private file ({@link BodySpool}) or
 * compressed blocks in memory ({@link BodySnapshot}).
 */
interface KeptBody {
	readonly byteLength: number;
	readonly title: SessionTitleUpdate | undefined;
	/** The body in chunks of at most {@link LINE_STREAM_CHUNK} bytes, each a buffer of its own. */
	chunks(): AsyncGenerator<Uint8Array>;
	/** Free what the body holds; a later read throws {@link RELEASED_BODY_MESSAGE}. */
	close(): void;
}

/** What a read of a {@link KeptBody} after its {@link KeptBody.close} throws, spooled or kept in memory. */
const RELEASED_BODY_MESSAGE = "A session rewrite's body was read after it was released";

/**
 * A {@link KeptBody} written to a temporary file, unlinked once open, and read
 * back through its descriptor until the body is released.
 */
class BodySpool implements KeptBody {
	readonly #file: PrivateTempFile;

	constructor(
		file: PrivateTempFile,
		readonly byteLength: number,
		readonly title: SessionTitleUpdate | undefined,
	) {
		this.#file = file;
	}

	async *chunks(): AsyncGenerator<Uint8Array> {
		// The descriptor is taken before the first read, so a released body refuses even when it is
		// empty, and again after each chunk, since the body can be released while a consumer holds one.
		for (let position = 0, fd = this.#fd(); position < this.byteLength; fd = this.#fd()) {
			const buffer = Buffer.allocUnsafe(Math.min(LINE_STREAM_CHUNK, this.byteLength - position));
			const read = await readAt(fd, buffer, position);
			if (read === 0) throw new Error(`Session body spool ended at byte ${position} of ${this.byteLength}`);
			position += read;
			yield read === buffer.byteLength ? buffer : buffer.subarray(0, read);
		}
	}

	close(): void {
		this.#file.close();
	}

	/**
	 * The descriptor, until {@link close}: after it the number can belong to
	 * another file. Refused in the body's words, as a released snapshot is;
	 * the file's own refusal stays behind it.
	 */
	#fd(): number {
		if (this.#file.closed) throw new Error(RELEASED_BODY_MESSAGE);
		return this.#file.fd;
	}
}

function readAt(fd: number, buffer: Uint8Array, position: number): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	fs.read(fd, buffer, 0, buffer.byteLength, position, (err, bytesRead) => {
		if (err) reject(err);
		else resolve(bytesRead);
	});
	return promise;
}

/**
 * A {@link KeptBody} kept in memory where no private spool file can be made
 * (a platform without account ids, Windows): the UTF-8 bytes of its lines,
 * zstd-compressed in blocks of at most {@link LINE_STREAM_CHUNK} bytes, each
 * ending on a character boundary, so no string or buffer as long as the body
 * is held.
 */
class BodySnapshot implements KeptBody {
	#blocks: readonly Uint8Array[] | undefined;

	constructor(
		blocks: readonly Uint8Array[],
		readonly byteLength: number,
		readonly title: SessionTitleUpdate | undefined,
	) {
		this.#blocks = blocks;
	}

	/**
	 * Each block decompressed off the event loop, so a backend that takes the
	 * chunks without waiting on I/O between them still lets it run.
	 */
	async *chunks(): AsyncGenerator<Uint8Array> {
		for (const block of this.#heldBlocks()) yield await Bun.zstdDecompress(block);
	}

	close(): void {
		this.#blocks = undefined;
	}

	/** The blocks, until {@link close}: a read after it would publish an empty body. */
	#heldBlocks(): readonly Uint8Array[] {
		if (!this.#blocks) throw new Error(RELEASED_BODY_MESSAGE);
		return this.#blocks;
	}
}

/**
 * Snapshot `lines` into a {@link BodySnapshot}, iterating them once, counting
 * their bytes and reading the title slot from their {@link LinesHead}, as the
 * spool does ({@link spoolLinesSync}), and compressing each block
 * synchronously.
 */
function snapshotLinesSync(lines: Iterable<string>): BodySnapshot {
	const head = new LinesHead();
	const blocks: Uint8Array[] = [];
	let bytes = 0;
	for (const chunk of encodeLines(head.note(lines), true)) {
		blocks.push(Bun.zstdCompressSync(chunk, { level: BLOCK_ZSTD_LEVEL }));
		bytes += chunk.byteLength;
	}
	return new BodySnapshot(blocks, bytes, head.title());
}

/**
 * {@link snapshotLinesSync} with each block compressed off the event loop.
 * Each chunk is a view of one buffer that the next overwrites, so it is
 * compressed before the next is encoded.
 */
async function snapshotLines(lines: Iterable<string>): Promise<BodySnapshot> {
	const head = new LinesHead();
	const blocks: Uint8Array[] = [];
	let bytes = 0;
	for (const chunk of encodeLines(head.note(lines), true)) {
		blocks.push(await Bun.zstdCompress(chunk, { level: BLOCK_ZSTD_LEVEL }));
		bytes += chunk.byteLength;
	}
	return new BodySnapshot(blocks, bytes, head.title());
}

/**
 * The head of a full write's lines, which its title slot and the header's
 * session id are read from: the lines through the second newline (the title
 * slot is read to the first, the session id at most to the second), at most
 * those that make up the first {@link LINE_STREAM_CHUNK} UTF-16 units, and
 * always the whole first line. The spool ({@link spoolLines}), the snapshot
 * ({@link snapshotLines}) and a write streamed from the lines
 * ({@link measureLines}) all read it here, so they read the same title.
 */
class LinesHead {
	#text = "";
	#newlines = 0;

	/** `lines` as they are, noting the head as they pass. */
	*note(lines: Iterable<string>): Generator<string> {
		for (const line of lines) {
			if (this.#newlines < 2 && this.#text.length < LINE_STREAM_CHUNK) {
				this.#text += line;
				this.#newlines += countNewlines(line);
			}
			yield line;
		}
	}

	/** The title slot at the head of the lines {@link note} passed. */
	title(): SessionTitleUpdate | undefined {
		return titleUpdateFromSlot(parseTitleSlotFromContent(this.#text));
	}

	/** The session id in the header at the head of the lines {@link note} passed. */
	sessionId(): string | undefined {
		return sessionHeaderIdInPrefix(this.#text);
	}
}

/**
 * How much a read of a full write's lines passed: its lines, and their
 * UTF-16 length. The spool's read notes every line it took before it failed;
 * the read that streams the body in its place must pass at least as much, or
 * the source gave its lines once and the second read holds only what the
 * spool left.
 */
class LinesRead {
	lines = 0;
	length = 0;

	/** `lines` as they are, counting each as it passes. */
	*note(lines: Iterable<string>): Generator<string> {
		for (const line of lines) {
			this.lines++;
			this.length += line.length;
			yield line;
		}
	}
}

/**
 * A full write's lines as its spool reads them, kept for the read that
 * streams the body in the spool's place ({@link FullBodies}): a source that
 * yields its lines only once (an iterator, or an iterable that hands out the
 * same iterator on every call) is read into an array first, since read again
 * it would yield none. {@link pulled} counts what the spool read, and
 * {@link failed} is set when the lines themselves threw.
 */
class SpoolSource {
	readonly lines: Iterable<string>;
	readonly pulled = new LinesRead();
	failed = false;

	constructor(lines: Iterable<string>) {
		// An iterator is its own iterable, and an iterable can hand out one iterator on every call: either
		// yields its lines only once.
		const iterator: unknown = lines[Symbol.iterator]();
		const once = iterator === lines || lines[Symbol.iterator]() === iterator;
		this.lines = once ? Array.from(lines) : lines;
	}

	/**
	 * {@link lines} for the spool. Only a throw from them lands in the catch:
	 * a throw from the spool's own writes ends the iteration through
	 * `return`, which runs no catch.
	 */
	*read(): Generator<string> {
		try {
			yield* this.pulled.note(this.lines);
		} catch (err) {
			this.failed = true;
			throw err;
		}
	}
}

/**
 * Spool `lines` to a new file of account `uid` under `os.tmpdir()/omp-spool-<uid>/`
 * ({@link openPrivateTempFileSync}) through synchronous writes, iterating them
 * once, counting their bytes and reading the title slot from their
 * {@link LinesHead}. Throws when the file cannot be made, opened or written,
 * or its directory is refused; a file it opened is closed.
 */
function spoolLinesSync(lines: Iterable<string>, uid: number): BodySpool {
	const file = openPrivateTempFileSync(SPOOL_DIR_PREFIX, uid, SPOOL_DIR_LABEL);
	try {
		const head = new LinesHead();
		const bytes = writeLinesToDescriptorSync(file.fd, head.note(lines));
		return new BodySpool(file, bytes, head.title());
	} catch (err) {
		file.close();
		throw err;
	}
}

/** {@link spoolLinesSync} through asynchronous opens and writes ({@link openPrivateTempFile}). */
async function spoolLines(lines: Iterable<string>, uid: number): Promise<BodySpool> {
	const file = await openPrivateTempFile(SPOOL_DIR_PREFIX, uid, SPOOL_DIR_LABEL);
	try {
		const head = new LinesHead();
		const bytes = await writeLinesToDescriptor(file.fd, head.note(lines));
		return new BodySpool(file, bytes, head.title());
	} catch (err) {
		file.close();
		throw err;
	}
}

/** `lines` joined into one string, read once. */
function joinLines(lines: Iterable<string>): string {
	if (Array.isArray(lines)) return lines.join("");
	let text = "";
	for (const line of lines) text += line;
	return text;
}

/** A full-write body's UTF-8 byte length and SHA-256 (hex), and the title slot and session id read from its head. */
interface MeasuredLines {
	bytes: number;
	hash: string;
	title: SessionTitleUpdate | undefined;
	sessionId: string | undefined;
}

/**
 * The UTF-8 bytes of `lines` in chunks of at most {@link LINE_STREAM_CHUNK}
 * bytes, iterating them once and never holding their concatenation: a chunk
 * holds as many lines as fit, and a longer line is cut across chunks, never
 * inside a character. Each chunk is a buffer of its own, or, with `reuse`,
 * a view of one buffer that the next chunk overwrites.
 */
export function* encodeLines(lines: Iterable<string>, reuse = false): Generator<Uint8Array> {
	const encoder = new TextEncoder();
	let buffer = Buffer.allocUnsafe(LINE_STREAM_CHUNK);
	let used = 0;
	for (const line of lines) {
		for (let read = 0; read < line.length;) {
			const encoded = encoder.encodeInto(read === 0 ? line : line.slice(read), buffer.subarray(used));
			read += encoded.read;
			used += encoded.written;
			// The rest of the line does not fit: the buffer is full, to within a character.
			if (read < line.length) {
				yield buffer.subarray(0, used);
				if (!reuse) buffer = Buffer.allocUnsafe(LINE_STREAM_CHUNK);
				used = 0;
			}
		}
	}
	if (used > 0) yield buffer.subarray(0, used);
}

/**
 * Measure `lines` for a full write streamed from them ({@link streamLines}):
 * the size and SHA-256 of their UTF-8 bytes, and the title slot and the
 * header's session id read from their {@link LinesHead}, as the spool reads
 * the title. Iterates them once.
 */
function measureLines(lines: Iterable<string>): MeasuredLines {
	const head = new LinesHead();
	const { bytes, hash } = digestChunksSync(encodeLines(head.note(lines), true));
	return { bytes, hash, title: head.title(), sessionId: head.sessionId() };
}

/**
 * {@link measureLines} that lets the event loop run between chunks, for a
 * body prepared off it: the whole transcript is never read in one turn.
 * Each chunk is a view of one buffer that the next overwrites; the
 * generator, and so the buffer, waits while the event loop runs.
 */
async function measureLinesAsync(lines: Iterable<string>): Promise<MeasuredLines> {
	const head = new LinesHead();
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLines(head.note(lines), true)) {
		if (bytes > 0) await Bun.sleep(0);
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { bytes, hash: hasher.digest("hex"), title: head.title(), sessionId: head.sessionId() };
}

/**
 * The UTF-8 bytes of `lines` ({@link encodeLines}) for a backend's streamed
 * write, read from the lines again, letting the event loop run before each
 * chunk after the first, so a backend that takes them without waiting on I/O
 * between them still lets it run. Each chunk is a buffer of its own, so a
 * backend may keep it. The stream fails at its end, so the backend replaces
 * nothing, when they are not the bytes `measured` holds: the lines changed
 * after they were measured, as the caller's lines of a synchronous rewrite,
 * which are streamed from, can.
 */
async function* streamLines(lines: Iterable<string>, measured: MeasuredLines): AsyncGenerator<Uint8Array> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLines(lines)) {
		if (bytes > 0) await Bun.sleep(0);
		hasher.update(chunk);
		bytes += chunk.byteLength;
		yield chunk;
	}
	if (bytes !== measured.bytes || hasher.digest("hex") !== measured.hash) {
		throw new Error(`The lines of a session rewrite changed after they were measured (${measured.bytes} bytes)`);
	}
}

/** A backend's streamed full write. */
type WriteFullStream = NonNullable<SessionStorageBackend["writeFullStream"]>;

/**
 * The bodies of the full writes of one store over `backend`, which a failed
 * publish compares with what `storedChunks` reads back.
 */
export class FullBodies {
	readonly #backend: SessionStorageBackend;
	readonly #storedChunks: (path: string, maxBytes: number) => AsyncIterable<Uint8Array>;
	/** Set once this store warned that a full rewrite could not use the spool. */
	#spoolFailureLogged = false;

	constructor(
		backend: SessionStorageBackend,
		storedChunks: (path: string, maxBytes: number) => AsyncIterable<Uint8Array>,
	) {
		this.#backend = backend;
		this.#storedChunks = storedChunks;
	}

	text(path: string, content: string): FullBody {
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		return {
			byteLength: Buffer.byteLength(content, "utf-8"),
			title,
			publish: (mtimeMs, expectedSize) => this.#backend.writeFull(path, content, mtimeMs, title, expectedSize),
			isStored: async () => (await this.#backend.readFull(path)) === content,
		};
	}

	/**
	 * The body of a full rewrite of `lines`, read from them now. A backend
	 * without a streamed write takes them joined into one string
	 * ({@link text}), returned at once: keeping them anywhere else first would
	 * only add a copy. For one with a streamed write they are spooled to a
	 * private temporary file, or, where the platform has no account id
	 * (Windows), kept compressed in memory ({@link snapshotLines}), since
	 * there is no owner to check a spool directory against and a file takes
	 * its directory's access list. An array of lines is read from a copy taken
	 * before the first await, so a caller that changes its array while the
	 * body is prepared changes no line of it and not its title; any other
	 * iterable (the session manager's lazily serialized body) is read as the
	 * body is prepared, never held whole. When the spool cannot be made,
	 * opened or written (`os.tmpdir()` read-only or full, or its spool
	 * directory not private to this account), it is streamed from the lines
	 * themselves ({@link #streamedBody}), with one warning per store; the
	 * lines are measured for it between turns of the event loop. That reads
	 * the lines again, so a source that yields its lines only once is read
	 * into an array first ({@link SpoolSource}): read again, it would yield
	 * none, and the streamed write would replace the stored body with an
	 * empty one. A source that hides being read once (an iterable that hands
	 * out a new iterator over one shared generator, as `gen.map(f)` gives) is
	 * found by its second read: one that passes fewer lines, or fewer UTF-16
	 * units, than the spool read ({@link LinesRead}) fails the rewrite, which
	 * replaces nothing. A throw from `lines` itself (an entry that cannot be
	 * read or serialized) is no spool failure: it propagates as it is, with no
	 * second read and no warning. The spool's opens and writes, the
	 * compression, and that measure run off the event loop or between its
	 * turns, so it keeps running while a large body is prepared;
	 * {@link linesSync} does the same synchronously.
	 */
	lines(path: string, lines: Iterable<string>): FullBody | Promise<FullBody> {
		const writeFullStream = this.#backend.writeFullStream;
		if (!writeFullStream) return this.text(path, joinLines(lines));
		return this.#keptLines(path, lines, writeFullStream);
	}

	/** The body {@link lines} keeps for a backend with a streamed write, prepared off the event loop. */
	async #keptLines(path: string, lines: Iterable<string>, writeFullStream: WriteFullStream): Promise<FullBody> {
		// Taken before the first await: everything below reads an array of lines as it was handed over.
		const handed: Iterable<string> = Array.isArray(lines) ? lines.slice() : lines;
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, await snapshotLines(handed), writeFullStream);
		const source = new SpoolSource(handed);
		try {
			return this.#keptBody(path, await spoolLines(source.read(), uid), writeFullStream);
		} catch (err) {
			const spoolError = this.#spoolFailed(source, uid, err);
			const read = new LinesRead();
			const measured = await measureLinesAsync(read.note(source.lines));
			return this.#streamedBody(path, source, read, measured, spoolError, writeFullStream);
		}
	}

	/** {@link lines} through synchronous writes and compression, for a caller that cannot wait. */
	linesSync(path: string, lines: Iterable<string>): FullBody {
		const writeFullStream = this.#backend.writeFullStream;
		if (!writeFullStream) return this.text(path, joinLines(lines));
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, snapshotLinesSync(lines), writeFullStream);
		const source = new SpoolSource(lines);
		try {
			return this.#keptBody(path, spoolLinesSync(source.read(), uid), writeFullStream);
		} catch (err) {
			const spoolError = this.#spoolFailed(source, uid, err);
			const read = new LinesRead();
			const measured = measureLines(read.note(source.lines));
			return this.#streamedBody(path, source, read, measured, spoolError, writeFullStream);
		}
	}

	/** The body `kept` holds, streamed from it, and compared with it after a failed publish. */
	#keptBody(path: string, kept: KeptBody, writeFullStream: WriteFullStream): FullBody {
		return {
			byteLength: kept.byteLength,
			title: kept.title,
			publish: (mtimeMs, expectedSize) =>
				writeFullStream.call(
					this.#backend,
					path,
					kept.chunks(),
					kept.byteLength,
					mtimeMs,
					kept.title,
					expectedSize,
				),
			// Compared by size and SHA-256, chunk by chunk: only a backend without
			// `readChunks` reads the stored side whole.
			isStored: async () => {
				const stored = await digestStream(this.#storedChunks(path, kept.byteLength));
				if (stored.bytes !== kept.byteLength) return false;
				return stored.hash === (await digestStream(kept.chunks())).hash;
			},
			release: () => kept.close(),
		};
	}

	/**
	 * The failure of the spool of `source`'s lines for account `uid`: `err` as
	 * it is, thrown, when the lines themselves threw; else warned once per
	 * store, and returned as its message.
	 */
	#spoolFailed(source: SpoolSource, uid: number, err: unknown): string {
		if (source.failed) throw err;
		const spoolError = toError(err).message;
		if (!this.#spoolFailureLogged) {
			this.#spoolFailureLogged = true;
			logger.warn("Session rewrites stream straight to the store: their spool file cannot be used", {
				dir: getPrivateTempDir(SPOOL_DIR_PREFIX, uid),
				error: spoolError,
			});
		}
		return spoolError;
	}

	/**
	 * The body of a full rewrite of `source`'s lines whose spool cannot be
	 * used: `measured` from them by a read that `read` counted
	 * ({@link measureLines}, {@link measureLinesAsync}), and read from the
	 * lines again when it publishes, through the backend's streamed write
	 * ({@link streamLines}), so it is never one value. A measuring read that
	 * passed fewer lines, or fewer UTF-16 units, than the failed spool read
	 * (`source.pulled`) throws before anything is published, with an error
	 * logged: the source gave its lines once, and the read holds only what
	 * the spool left. A publish that fails replaces nothing, and is logged as
	 * an error naming the session, the path and the cause (and `spoolError`,
	 * why the spool failed), besides failing the write as any publish does;
	 * the next full rewrite tries the spool, and this, again. A refusal the
	 * caller resolves (a size conflict, a lost claim) is not logged.
	 */
	#streamedBody(
		path: string,
		source: SpoolSource,
		read: LinesRead,
		measured: MeasuredLines,
		spoolError: string,
		writeFullStream: WriteFullStream,
	): FullBody {
		const { lines, pulled } = source;
		if (read.lines < pulled.lines || read.length < pulled.length) {
			const error = new Error(
				`The lines of a session rewrite could not be read again after its spool failed: the spool read ${pulled.lines} lines, the second read ${read.lines}`,
			);
			logger.error("Session rewrite not stored: its spool cannot be used, and its lines cannot be read again", {
				session: measured.sessionId,
				path,
				error: error.message,
				spoolError,
			});
			throw error;
		}
		return {
			byteLength: measured.bytes,
			title: measured.title,
			publish: async (mtimeMs, expectedSize) => {
				try {
					await writeFullStream.call(
						this.#backend,
						path,
						streamLines(lines, measured),
						measured.bytes,
						mtimeMs,
						measured.title,
						expectedSize,
					);
				} catch (err) {
					if (!(err instanceof SessionWriteConflictError) && !(err instanceof SessionLeaseLostError)) {
						logger.error("Session rewrite not stored: its spool cannot be used, and streaming it failed", {
							session: measured.sessionId,
							path,
							error: toError(err).message,
							spoolError,
						});
					}
					throw err;
				}
			},
			// Compared by size and SHA-256, chunk by chunk, with what the lines measured.
			isStored: async () => {
				const stored = await digestStream(this.#storedChunks(path, measured.bytes));
				return stored.bytes === measured.bytes && stored.hash === measured.hash;
			},
		};
	}
}
