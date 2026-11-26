/**
 * The bodies of an indexed store's full writes ({@link FullBodies}): from a
 * string, or from lines read once into a private spool file or, where the
 * platform has no account id, into compressed blocks in memory, or streamed
 * from the lines when the spool cannot be used.
 */
import * as fs from "node:fs";
import { countNewlines, logger, toError } from "@oh-my-pi/pi-utils";
import { digestStream } from "../utils/file-hash";
import { openPrivateTempFile, type PrivateTempFile, privateTempDir } from "../utils/owner-private-dir";
import { BLOCK_ZSTD_LEVEL } from "./block-zstd-level";
import type { SessionStorageBackend } from "./indexed-session-storage";
import { sessionIdFromContent } from "./session-header-id";
import { LINE_STREAM_CHUNK, SessionWriteConflictError, writeLinesToDescriptorSync } from "./session-storage";
import { parseTitleSlotFromContent, type SessionTitleUpdate, titleUpdateFromSlot } from "./session-title-slot";

/**
 * The kind of private temporary directory the spool files live in
 * ({@link privateTempDir}): the one a spool opens its file in and the one its
 * warning names.
 */
const SPOOL_DIR_KIND = "spool";

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
	/** The whole body as one string, for a backend that has no streamed full write. */
	text(): string;
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

	text(): string {
		const fd = this.#fd();
		const bytes = Buffer.allocUnsafe(this.byteLength);
		for (let position = 0; position < bytes.byteLength;) {
			const read = fs.readSync(fd, bytes, position, bytes.byteLength - position, position);
			if (read === 0) throw new Error(`Session body spool ended at byte ${position} of ${this.byteLength}`);
			position += read;
		}
		return bytes.toString("utf-8");
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

	async *chunks(): AsyncGenerator<Uint8Array> {
		for (const block of this.#heldBlocks()) yield Bun.zstdDecompressSync(block);
	}

	text(): string {
		let text = "";
		for (const block of this.#heldBlocks()) text += Bun.zstdDecompressSync(block).toString("utf-8");
		return text;
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
 * spool does ({@link spoolLines}).
 */
function snapshotLines(lines: Iterable<string>): BodySnapshot {
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
		return sessionIdFromContent(this.#text);
	}
}

/**
 * Spool `lines` to a new file of account `uid` under `os.tmpdir()/omp-spool-<uid>/`
 * ({@link openPrivateTempFile}), iterating them once, counting their bytes and
 * reading the title slot from their {@link LinesHead}. Throws when the file
 * cannot be made, opened or written, or its directory is refused; a file it
 * opened is closed.
 */
function spoolLines(lines: Iterable<string>, uid: number): BodySpool {
	const file = openPrivateTempFile(SPOOL_DIR_KIND, uid, "Session spool directory");
	try {
		const head = new LinesHead();
		const bytes = writeLinesToDescriptorSync(file.fd, head.note(lines));
		return new BodySpool(file, bytes, head.title());
	} catch (err) {
		file.close();
		throw err;
	}
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
function* encodeLines(lines: Iterable<string>, reuse = false): Generator<Uint8Array> {
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
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLines(head.note(lines), true)) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { bytes, hash: hasher.digest("hex"), title: head.title(), sessionId: head.sessionId() };
}

/**
 * The UTF-8 bytes of `lines` ({@link encodeLines}) for a backend's streamed
 * write, read from the lines again. The stream fails at its end, so the
 * backend replaces nothing, when they are not the bytes `measured` holds:
 * the lines changed after {@link measureLines} read them.
 */
async function* streamLines(lines: Iterable<string>, measured: MeasuredLines): AsyncGenerator<Uint8Array> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLines(lines)) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
		yield chunk;
	}
	if (bytes !== measured.bytes || hasher.digest("hex") !== measured.hash) {
		throw new Error(`The lines of a session rewrite changed after they were measured (${measured.bytes} bytes)`);
	}
}

/**
 * The bodies of the full writes of one store over `backend`, which a failed
 * publish compares with what `storedChunks` reads back.
 */
export class FullBodies {
	readonly #backend: SessionStorageBackend;
	readonly #storedChunks: (path: string) => AsyncIterable<Uint8Array>;
	/** Set once this store warned that a full rewrite could not use the spool. */
	#spoolFailureLogged = false;

	constructor(backend: SessionStorageBackend, storedChunks: (path: string) => AsyncIterable<Uint8Array>) {
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

	/** The body `kept` holds, published from it, and compared with it after a failed publish. */
	#keptBody(path: string, kept: KeptBody): FullBody {
		return {
			byteLength: kept.byteLength,
			title: kept.title,
			publish: (mtimeMs, expectedSize) =>
				this.#backend.writeFullStream
					? this.#backend.writeFullStream(path, kept.chunks(), kept.byteLength, mtimeMs, kept.title, expectedSize)
					: this.#backend.writeFull(path, kept.text(), mtimeMs, kept.title, expectedSize),
			// Compared by size and SHA-256, chunk by chunk: only a backend without
			// `readChunks` reads the stored side whole.
			isStored: async () => {
				const stored = await digestStream(this.#storedChunks(path));
				if (stored.bytes !== kept.byteLength) return false;
				return stored.hash === (await digestStream(kept.chunks())).hash;
			},
			release: () => kept.close(),
		};
	}

	/**
	 * The body of a full rewrite of `lines`, read from them now: spooled to a
	 * private temporary file, or, where the platform has no account id
	 * (Windows), kept compressed in memory ({@link snapshotLines}), since
	 * there is no owner to check a spool directory against and a file takes
	 * its directory's access list. When the spool cannot be made, opened or
	 * written (`os.tmpdir()` read-only or full, or its spool directory not
	 * private to this account), it is streamed from the lines themselves
	 * ({@link #streamedBody}), with one warning per store. That reads `lines`
	 * again, so an iterator, which yields its lines only once, is read into an
	 * array first. A throw from `lines` itself (an entry that cannot be read or
	 * serialized) is no spool failure: it propagates as it is, with no second
	 * read and no warning.
	 */
	lines(path: string, lines: Iterable<string>): FullBody {
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, snapshotLines(lines));
		// An iterator is its own iterable, and yields its lines only once.
		const iterator: unknown = lines[Symbol.iterator]();
		const readable: Iterable<string> = iterator === lines ? Array.from(lines) : lines;
		let linesFailed = false;
		// Only a throw from `readable` lands in the catch: a throw from the spool's
		// own writes ends the iteration through `return`, which runs no catch.
		function* noteLinesFailure(): Generator<string> {
			try {
				yield* readable;
			} catch (err) {
				linesFailed = true;
				throw err;
			}
		}
		try {
			return this.#keptBody(path, spoolLines(noteLinesFailure(), uid));
		} catch (err) {
			if (linesFailed) throw err;
			const spoolError = toError(err).message;
			if (!this.#spoolFailureLogged) {
				this.#spoolFailureLogged = true;
				logger.warn("Session rewrites stream straight to the store: their spool file cannot be used", {
					dir: privateTempDir(SPOOL_DIR_KIND, uid),
					error: spoolError,
				});
			}
			return this.#streamedBody(path, readable, spoolError);
		}
	}

	/**
	 * The body of a full rewrite of `lines` whose spool cannot be used:
	 * measured now ({@link measureLines}), and read from the lines again when
	 * it publishes, through the backend's streamed write ({@link streamLines}),
	 * so it is never one value; a backend without one cannot take it, and its
	 * rewrite fails without reading the stored copy back. A publish that fails
	 * replaces nothing, and is logged as an error naming the session, the path
	 * and the cause, besides failing the write as any publish does; the next
	 * full rewrite tries the spool, and this, again. A refusal the caller
	 * resolves (a size conflict) is not logged.
	 */
	#streamedBody(path: string, lines: Iterable<string>, spoolError: string): FullBody {
		const measured = measureLines(lines);
		const writeFullStream = this.#backend.writeFullStream;
		return {
			byteLength: measured.bytes,
			title: measured.title,
			publish: async (mtimeMs, expectedSize) => {
				try {
					if (!writeFullStream) {
						throw new Error("Session storage backend has no streamed full write (writeFullStream)");
					}
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
					if (!(err instanceof SessionWriteConflictError)) {
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
			// Compared by size and SHA-256, chunk by chunk, with what the lines measured. A backend
			// without a streamed write was handed nothing, so nothing it holds is this write's: no read.
			isStored: async () => {
				if (!writeFullStream) return false;
				const stored = await digestStream(this.#storedChunks(path));
				return stored.bytes === measured.bytes && stored.hash === measured.hash;
			},
		};
	}
}
