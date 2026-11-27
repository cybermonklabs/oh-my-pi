/**
 * The bodies of an indexed store's full writes ({@link FullBodies}): from a
 * string, or, for a backend that takes a streamed write, from lines read once
 * into a private spool file or, where the platform has no account id, into
 * compressed blocks in memory. When the spool fails, the lines are streamed
 * to the backend from the caller's array.
 */
import * as fs from "node:fs";
import { countNewlines, logger, toError } from "@oh-my-pi/pi-utils";
import { digestStream } from "../utils/file-hash";
import {
	openPrivateTempFile,
	openPrivateTempFileSync,
	type PrivateTempFile,
	privateTempDir,
} from "../utils/owner-private-dir";
import type { SessionStorageBackend } from "./indexed-session-storage";
import { sessionIdFromContent } from "./session-header-id";
import {
	encodeLineChunks,
	LINE_STREAM_CHUNK,
	SessionWriteConflictError,
	writeLinesToDescriptor,
	writeLinesToDescriptorSync,
} from "./session-storage";
import { parseTitleSlotFromContent, type SessionTitleUpdate, titleUpdateFromSlot } from "./session-title-slot";

/**
 * The kind of private temporary directory the spool files live in
 * ({@link privateTempDir}): the one a spool opens its file in and the one its
 * warning names.
 */
const SPOOL_DIR_KIND = "spool";

/** What a refusal of the spool's directory names it. */
const SPOOL_DIR_LABEL = "Session spool directory";

/** zstd level of the blocks of a rewrite's body kept in memory where no spool file can be made ({@link BodySnapshot}). */
const BLOCK_ZSTD_LEVEL = 3;

/** One full write: its size and title slot, its backend publish, and the read-back after a failed publish. */
export interface FullBody {
	byteLength: number;
	title: SessionTitleUpdate | undefined;
	publish(mtimeMs: number, expectedSize: number | null | undefined, mayPublish?: () => boolean): Promise<void>;
	/** Whether the backend holds exactly this body. */
	isStored(): Promise<boolean>;
	/** Free what the body holds, once its publish (and any read-back) has settled. */
	release?: () => void;
}

/**
 * A full-write body read from its lines once, when the write is queued, and
 * kept until its publish (and any read-back) has settled, so the lines a
 * caller hands over are not held a second time while the publish waits in
 * the path queue. A private file ({@link BodySpool}) or compressed blocks in
 * memory ({@link BodySnapshot}).
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

	async *chunks(): AsyncGenerator<Uint8Array> {
		for (const block of this.#heldBlocks()) yield Bun.zstdDecompressSync(block);
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
 * The head of a full write's lines, which its title slot and the header's
 * session id are read from: the lines through the second newline (the title
 * slot is read to the first, the session id at most to the second), at most
 * those that make up the first {@link LINE_STREAM_CHUNK} UTF-16 units, and
 * always the whole first line.
 */
function linesHead(lines: readonly string[]): string {
	let head = "";
	let newlines = 0;
	for (const line of lines) {
		if (newlines >= 2 || head.length >= LINE_STREAM_CHUNK) break;
		head += line;
		newlines += countNewlines(line);
	}
	return head;
}

/** The title slot at the head of `lines` ({@link linesHead}). */
function linesTitle(lines: readonly string[]): SessionTitleUpdate | undefined {
	return titleUpdateFromSlot(parseTitleSlotFromContent(linesHead(lines)));
}

/** Keep `lines` in a {@link BodySnapshot}, compressing each block synchronously. */
function snapshotLinesSync(lines: readonly string[]): BodySnapshot {
	const blocks: Uint8Array[] = [];
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines, true)) {
		blocks.push(Bun.zstdCompressSync(chunk, { level: BLOCK_ZSTD_LEVEL }));
		bytes += chunk.byteLength;
	}
	return new BodySnapshot(blocks, bytes, linesTitle(lines));
}

/**
 * {@link snapshotLinesSync} with each block compressed off the event loop.
 * Each chunk is a view of one buffer that the next overwrites, so it is
 * compressed before the next is encoded.
 */
async function snapshotLines(lines: readonly string[]): Promise<BodySnapshot> {
	const blocks: Uint8Array[] = [];
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines, true)) {
		blocks.push(await Bun.zstdCompress(chunk, { level: BLOCK_ZSTD_LEVEL }));
		bytes += chunk.byteLength;
	}
	return new BodySnapshot(blocks, bytes, linesTitle(lines));
}

/**
 * Spool `lines` to a new file of account `uid` under `os.tmpdir()/omp-spool-<uid>/`
 * ({@link openPrivateTempFileSync}) through synchronous writes. Throws when the
 * file cannot be made, opened or written, or its directory is refused; a
 * file it opened is closed.
 */
function spoolLinesSync(lines: readonly string[], uid: number): BodySpool {
	const file = openPrivateTempFileSync(SPOOL_DIR_KIND, uid, SPOOL_DIR_LABEL);
	try {
		return new BodySpool(file, writeLinesToDescriptorSync(file.fd, lines), linesTitle(lines));
	} catch (err) {
		file.close();
		throw err;
	}
}

/** {@link spoolLinesSync} through asynchronous opens and writes ({@link openPrivateTempFile}). */
async function spoolLines(lines: readonly string[], uid: number): Promise<BodySpool> {
	const file = await openPrivateTempFile(SPOOL_DIR_KIND, uid, SPOOL_DIR_LABEL);
	try {
		return new BodySpool(file, await writeLinesToDescriptor(file.fd, lines), linesTitle(lines));
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
 * Measure `lines` for a full write streamed from them ({@link streamLines}):
 * the size and SHA-256 of their UTF-8 bytes, and the title slot and the
 * header's session id read from their head ({@link linesHead}).
 */
function measureLines(lines: readonly string[]): MeasuredLines {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines, true)) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	const head = linesHead(lines);
	return {
		bytes,
		hash: hasher.digest("hex"),
		title: titleUpdateFromSlot(parseTitleSlotFromContent(head)),
		sessionId: sessionIdFromContent(head),
	};
}

/**
 * The UTF-8 bytes of `lines` ({@link encodeLineChunks}) for a backend's streamed
 * write, read from the lines again. The stream fails at its end, so the
 * backend replaces nothing, when they are not the bytes `measured` holds:
 * the array changed after {@link measureLines} read it.
 */
async function* streamLines(lines: readonly string[], measured: MeasuredLines): AsyncGenerator<Uint8Array> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines)) {
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
			publish: async (mtimeMs, expectedSize, mayPublish) => {
				if (mayPublish?.() === false) return;
				await this.#backend.writeFull(path, content, mtimeMs, title, expectedSize);
			},
			isStored: async () => (await this.#backend.readFull(path)) === content,
		};
	}

	/**
	 * The body of a full rewrite of `lines`, read from them now. A backend
	 * without a streamed write takes them joined into one string
	 * ({@link text}), returned at once: keeping them anywhere else first would
	 * only add a copy. For one with a streamed write they are spooled to a
	 * private temporary file, or, where the platform has no account id
	 * (Windows), kept compressed in memory, since there is no owner to check a
	 * spool directory against and a file takes its directory's access list.
	 * When the spool cannot be made, opened or written (`os.tmpdir()`
	 * read-only or full, or its spool directory not private to this account),
	 * the lines are streamed from `lines` when the body publishes
	 * ({@link #streamedBody}), and the store warns once. The spool's opens and
	 * writes and the compression run off the event loop, so it keeps running
	 * while a large body is prepared; {@link linesSync} does the same
	 * synchronously.
	 */
	lines(path: string, lines: readonly string[]): FullBody | Promise<FullBody> {
		const writeFullStream = this.#backend.writeFullStream;
		if (!writeFullStream) return this.text(path, lines.join(""));
		return this.#keptLines(path, lines, writeFullStream);
	}

	/** The body {@link lines} keeps for a backend with a streamed write, prepared off the event loop. */
	async #keptLines(path: string, lines: readonly string[], writeFullStream: WriteFullStream): Promise<FullBody> {
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, await snapshotLines(lines), writeFullStream);
		try {
			return this.#keptBody(path, await spoolLines(lines, uid), writeFullStream);
		} catch (err) {
			return this.#unspooledBody(path, lines, uid, err, writeFullStream);
		}
	}

	/** {@link lines} through synchronous writes and compression, for a caller that cannot wait. */
	linesSync(path: string, lines: readonly string[]): FullBody {
		const writeFullStream = this.#backend.writeFullStream;
		if (!writeFullStream) return this.text(path, lines.join(""));
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, snapshotLinesSync(lines), writeFullStream);
		try {
			return this.#keptBody(path, spoolLinesSync(lines, uid), writeFullStream);
		} catch (err) {
			return this.#unspooledBody(path, lines, uid, err, writeFullStream);
		}
	}

	/** The body `kept` holds, streamed from it, and compared with it after a failed publish. */
	#keptBody(path: string, kept: KeptBody, writeFullStream: WriteFullStream): FullBody {
		return {
			byteLength: kept.byteLength,
			title: kept.title,
			publish: async (mtimeMs, expectedSize, mayPublish) => {
				if (mayPublish?.() === false) return;
				await writeFullStream.call(
					this.#backend,
					path,
					kept.chunks(),
					kept.byteLength,
					mtimeMs,
					kept.title,
					expectedSize,
				);
			},
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

	/** The body of a full rewrite of `lines` whose spool of account `uid` failed with `err`: warned once, then streamed. */
	#unspooledBody(
		path: string,
		lines: readonly string[],
		uid: number,
		err: unknown,
		writeFullStream: WriteFullStream,
	): FullBody {
		const spoolError = toError(err).message;
		if (!this.#spoolFailureLogged) {
			this.#spoolFailureLogged = true;
			logger.warn("Session rewrites stream straight to the store: their spool file cannot be used", {
				dir: privateTempDir(SPOOL_DIR_KIND, uid),
				error: spoolError,
			});
		}
		return this.#streamedBody(path, lines, spoolError, writeFullStream);
	}

	/**
	 * The body of a full rewrite of `lines` whose spool cannot be used:
	 * measured now ({@link measureLines}), and read from the lines again when
	 * it publishes through the backend's streamed write ({@link streamLines}).
	 * A publish that fails replaces nothing. The store logs the session, path
	 * and cause unless the backend reports a size conflict.
	 */
	#streamedBody(
		path: string,
		lines: readonly string[],
		spoolError: string,
		writeFullStream: WriteFullStream,
	): FullBody {
		const measured = measureLines(lines);
		return {
			byteLength: measured.bytes,
			title: measured.title,
			publish: async (mtimeMs, expectedSize, mayPublish) => {
				if (mayPublish?.() === false) return;
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
			// Compare by size and SHA-256, chunk by chunk, with what the lines measured.
			isStored: async () => {
				const stored = await digestStream(this.#storedChunks(path, measured.bytes));
				return stored.bytes === measured.bytes && stored.hash === measured.hash;
			},
		};
	}
}
