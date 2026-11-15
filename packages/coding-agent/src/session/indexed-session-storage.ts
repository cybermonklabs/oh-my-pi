import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake, toError } from "@oh-my-pi/pi-utils";
import {
	childDirNames,
	childKeyName,
	LINE_STREAM_CHUNK,
	SessionLeaseLostError,
	SessionWriteConflictError,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
	writeLinesToDescriptorSync,
} from "./session-storage";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { eexist, enoent } from "./session-storage-errors";
import {
	overlayTitleSlotContent,
	overlayTitleSlotPrefix,
	parseTitleSlotFromContent,
	type SessionTitleUpdate,
	serializeTitleSlot,
	titleUpdateFromSlot,
} from "./session-title-slot";

export interface SessionStorageIndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
	title?: string;
	titleSource?: SessionTitleUpdate["source"];
	titleUpdatedAt?: string;
}

export interface SessionStorageBackend {
	init(): Promise<void>;
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>>;
	readFull(path: string): Promise<string | null>;
	readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	/**
	 * The UTF-8 text from byte `offset` to the end, or at most `maxBytes` of
	 * it, and the session's size in bytes, both from one read of the backing
	 * store; `null` when `path` holds no session. A capped read may end inside
	 * a character. Optional: without it the storage reads the whole session
	 * and cuts it.
	 */
	readFrom?(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null>;
	/**
	 * The stored bytes from byte `fromByte` to the end, as chunks in order:
	 * what {@link readFull} returns from that offset, without holding it whole.
	 * Iterating rejects with ENOENT when `path` holds no session. Optional:
	 * without it the storage reads the whole session and cuts it.
	 */
	readChunks?(path: string, fromByte: number): AsyncIterable<Uint8Array>;
	/**
	 * Replace content, atomically rejecting when the shared backend's current
	 * UTF-8 byte length differs from `expectedSize`.
	 */
	writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void>;
	/**
	 * {@link writeFull} of the UTF-8 bytes `chunks` yields, `byteLength` in all,
	 * without holding them whole; the same size check, and the content replaced
	 * all at once. Optional: without it the storage reads the spooled body back
	 * whole and calls {@link writeFull}.
	 */
	writeFullStream?(
		path: string,
		chunks: AsyncIterable<Uint8Array>,
		byteLength: number,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void>;
	/**
	 * Append `line`. `expectedSize` is the size this store's index held for
	 * `path` before the append, which a backend that guards appends (SQL
	 * storage that claims sessions) checks the shared backend's size against,
	 * rejecting with `SessionWriteConflictError` when another writer changed
	 * the file since; others ignore it.
	 */
	append(path: string, line: string, mtimeMs: number, expectedSize?: number): Promise<void>;
	updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void>;
	truncate(path: string, mtimeMs: number): Promise<void>;
	/**
	 * Remove `paths`, and with `dir` (a key prefix ending in `/`) every key
	 * under it that the shared store holds when the removal runs, including
	 * ones another client committed after this store last refreshed.
	 */
	remove(paths: string[], dir?: string): Promise<void>;
	/**
	 * Move `src` to `dst`, replacing `dst`. With `noReplace` a `dst` the shared
	 * store holds, including one another client commits while the move runs,
	 * makes it reject with `EEXIST` naming `dst` and change neither path.
	 */
	move(src: string, dst: string, mtimeMs: number, noReplace?: boolean): Promise<void>;
}

interface IndexEntry {
	size: number;
	mtimeMs: number;
	title?: string;
	titleSource?: SessionTitleUpdate["source"];
	titleUpdatedAt?: string;
	/**
	 * Set on an entry restored after a failed removal: the backend may have
	 * deleted part of the path (Redis deletes the file key before the
	 * metadata), so only a later full write confirms it again.
	 */
	unconfirmed?: true;
}

interface EnqueueOptions {
	trackDrain: boolean;
	/**
	 * Chain on the uncaught per-path pending op so an op queued behind a
	 * failed one fail-fasts instead of running. Only positional publishes
	 * with no backend CAS token (backend.append) opt in: absolute publishes
	 * carry their own backend validation and run to converge (e.g. a
	 * superseding title update over a failed one).
	 */
	abortOnPredecessorFailure?: boolean;
}

/** Optimistic index entry a queued append installed, kept for failure rollback. */
interface IndexAppend {
	mtimeMs: number;
	previous: IndexEntry | undefined;
	/** Set when the queued op removes the path (unlink, delete, rename source). */
	removal?: true;
}

const RESOLVED = Promise.resolve();

function matchesGlobSegment(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
	return name === pattern;
}

/**
 * Match a slash-joined index key remainder against a pattern of the same
 * shape (`"*.jsonl"`, or a wildcard project directory followed by
 * `"*.jsonl"` for the one-level cross-project case). Segment counts must
 * agree, so a direct child never matches a two-segment pattern and a
 * nested key never matches a one-segment one.
 */
function matchesGlob(name: string, pattern: string): boolean {
	const nameParts = name.split("/");
	const patternParts = pattern.split("/");
	if (nameParts.length !== patternParts.length) return false;
	return nameParts.every((part, i) => matchesGlobSegment(part, patternParts[i]));
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function normalizeByteLimit(maxBytes: number): number {
	if (!(maxBytes > 0)) return 0;
	return Math.trunc(maxBytes);
}

function uniquePaths(paths: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}
function titleUpdateForIndex(entry: IndexEntry): SessionTitleUpdate | undefined {
	if (!entry.titleUpdatedAt) return undefined;
	return { title: entry.title, source: entry.titleSource, updatedAt: entry.titleUpdatedAt };
}

/** Directory under the OS temp directory holding full-write bodies until their backend publish settles. */
const SPOOL_DIR = "omp-spool";
/**
 * Age at which a spool file is a dead process's. Only Windows leaves one
 * behind: POSIX unlinks a spool file as soon as it is open, while Windows
 * removes it after the publish, so a killed process's file is swept at the
 * next start.
 */
const STALE_SPOOL_MS = 60 * 60 * 1000;
let staleSpoolsSwept = false;

/** One full write: its size and title slot, its backend publish, and the read-back after a failed publish. */
interface FullBody {
	byteLength: number;
	title: SessionTitleUpdate | undefined;
	publish(mtimeMs: number, expectedSize: number | null | undefined): Promise<void>;
	/** Whether the backend holds exactly this body. */
	isStored(): Promise<boolean>;
	/** Free what the body holds, once its publish (and any read-back) has settled. */
	release?: () => void;
}

/**
 * A full-write body written to a temporary file, so the lines a caller hands
 * over are not held a second time while the publish waits in the path queue.
 * It is read back through its descriptor.
 */
class BodySpool {
	readonly #fd: number;
	/** The file to remove on close; unset on POSIX, where it was unlinked once open. */
	readonly #file: string | undefined;
	#closed = false;

	constructor(
		fd: number,
		file: string | undefined,
		readonly byteLength: number,
		readonly title: SessionTitleUpdate | undefined,
	) {
		this.#fd = fd;
		this.#file = file;
	}

	/** The body in reads of {@link LINE_STREAM_CHUNK} bytes, each a buffer of its own. */
	async *chunks(): AsyncGenerator<Uint8Array> {
		for (let position = 0; position < this.byteLength;) {
			const buffer = Buffer.allocUnsafe(Math.min(LINE_STREAM_CHUNK, this.byteLength - position));
			const read = await readAt(this.#fd, buffer, position);
			if (read === 0) throw new Error(`Session body spool ended at byte ${position} of ${this.byteLength}`);
			position += read;
			yield read === buffer.byteLength ? buffer : buffer.subarray(0, read);
		}
	}

	/** The whole body as one string, for a backend that has no streamed full write. */
	text(): string {
		const bytes = Buffer.allocUnsafe(this.byteLength);
		for (let position = 0; position < bytes.byteLength;) {
			const read = fs.readSync(this.#fd, bytes, position, bytes.byteLength - position, position);
			if (read === 0) throw new Error(`Session body spool ended at byte ${position} of ${this.byteLength}`);
			position += read;
		}
		return bytes.toString("utf-8");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			fs.closeSync(this.#fd);
			if (this.#file) fs.rmSync(this.#file, { force: true });
		} catch {
			// A Windows file still in use is swept at the next start.
		}
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

/** Remove spool files a killed process left behind; Windows only, once per process. */
function sweepStaleSpools(dir: string): void {
	if (staleSpoolsSwept) return;
	staleSpoolsSwept = true;
	const cutoff = Date.now() - STALE_SPOOL_MS;
	for (const name of fs.readdirSync(dir)) {
		const file = path.join(dir, name);
		try {
			if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
		} catch {
			// Removed by another process meanwhile, or still open in one.
		}
	}
}

/**
 * Spool `lines` to a new file under `<os temp>/omp-spool`, iterating them
 * once, counting its bytes and reading the title slot from its first line.
 */
function spoolLines(lines: Iterable<string>): BodySpool {
	const dir = path.join(os.tmpdir(), SPOOL_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const windows = process.platform === "win32";
	if (windows) sweepStaleSpools(dir);
	const file = path.join(dir, `${process.pid}-${Snowflake.next()}.spool`);
	const fd = fs.openSync(file, "wx+", 0o600);
	try {
		if (!windows) fs.unlinkSync(file);
		const { bytes, head } = writeLinesToDescriptorSync(fd, lines);
		return new BodySpool(fd, windows ? file : undefined, bytes, titleUpdateFromSlot(parseTitleSlotFromContent(head)));
	} catch (err) {
		new BodySpool(fd, file, 0, undefined).close();
		throw err;
	}
}

/** The SHA-256 of `chunks` and their byte count. */
async function digestChunks(chunks: AsyncIterable<Uint8Array>): Promise<{ byteLength: number; digest: string }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let total = 0;
	for await (const chunk of chunks) {
		hasher.update(chunk);
		total += chunk.byteLength;
	}
	return { byteLength: total, digest: hasher.digest("hex") };
}

/**
 * `chunks` with the title slot laid over their first
 * {@link SESSION_TITLE_SLOT_BYTES} bytes, as {@link overlayTitleSlotPrefix}
 * lays it over a head window, from byte `fromByte` on.
 */
async function* overlayTitleSlotChunks(
	chunks: AsyncIterable<Uint8Array>,
	title: SessionTitleUpdate,
	fromByte: number,
): AsyncGenerator<Uint8Array> {
	const slot = Buffer.from(serializeTitleSlot(title), "utf-8");
	let head: Uint8Array[] | undefined = [];
	let headBytes = 0;
	let skip = fromByte;
	const overlaid = (): Buffer => {
		// A fresh buffer: the slot never writes into a chunk the backend handed out.
		const bytes = Buffer.concat(head ?? [], headBytes);
		slot.copy(bytes, 0, 0, Math.min(slot.byteLength, bytes.byteLength));
		head = undefined;
		return bytes;
	};
	for await (const chunk of chunks) {
		let out = chunk;
		if (head) {
			head.push(chunk);
			headBytes += chunk.byteLength;
			if (headBytes < slot.byteLength) continue;
			out = overlaid();
		}
		if (skip >= out.byteLength) {
			skip -= out.byteLength;
			continue;
		}
		yield skip > 0 ? out.subarray(skip) : out;
		skip = 0;
	}
	if (head && headBytes > skip) yield overlaid().subarray(skip);
}

export class IndexedSessionStorage implements SessionStorage {
	/**
	 * Sync writes only update {@link #index} and queue the remote publish, so a
	 * caller tracking a durable byte size must wait for {@link drain}.
	 */
	readonly defersSyncPublish = true;
	readonly #backend: SessionStorageBackend;
	readonly #index = new Map<string, IndexEntry>();
	readonly #writers = new Set<IndexedSessionStorageWriter>();
	readonly #pathTails = new Map<string, Promise<void>>();
	readonly #pathPending = new Map<string, Promise<void>>();
	readonly #drainPending = new Set<Promise<void>>();
	/**
	 * Live optimistic index frames per path, oldest first. Every synchronous
	 * index update whose backend op is still queued pushes a frame; settlement
	 * drops it (success) or drops it and every frame queued behind it and
	 * restores the earliest dropped frame's entry (failure). Rolling back to
	 * the last durable entry instead of the immediately previous one keeps a
	 * failed op in a chain from stranding later recovery rewrites on an
	 * unreachable CAS token (rJDg).
	 */
	readonly #pendingFrames = new Map<string, IndexAppend[]>();
	#nextMtimeMs = 0;
	/** Paths changed locally while each in-flight {@link refresh} read the backend. */
	readonly #refreshWindows = new Set<Set<string>>();
	#firstDrainError: Error | undefined;
	#assertExpectedSize(path: string, expectedSize: number | null | undefined): void {
		if (expectedSize === undefined) return;
		const actualSize = this.#index.get(path)?.size ?? null;
		if (actualSize !== expectedSize) {
			throw new SessionWriteConflictError(path, expectedSize, actualSize);
		}
	}

	constructor(backend: SessionStorageBackend) {
		this.#backend = backend;
	}

	async initialize(): Promise<void> {
		await this.#backend.init();
		await this.refresh();
	}

	/**
	 * Merge the backend's current index into this one, so sessions other
	 * processes created, changed, or removed since the last load show in
	 * `existsSync`, `statSync`, and the listings. A path this storage has an
	 * operation in flight for, or changes while the backend read runs, keeps
	 * its local entry: the read cannot describe a write it may predate.
	 */
	async refresh(): Promise<void> {
		const window = new Set<string>(this.#pendingFrames.keys());
		this.#refreshWindows.add(window);
		try {
			const rows = await this.#backend.loadIndex();
			const fresh = new Map<string, IndexEntry>();
			for (const row of rows) {
				fresh.set(row.path, {
					size: row.size,
					mtimeMs: row.mtimeMs,
					title: row.titleUpdatedAt ? row.title : undefined,
					titleSource: row.titleUpdatedAt ? row.titleSource : undefined,
					titleUpdatedAt: row.titleUpdatedAt,
				});
			}
			const settled = (path: string): boolean => !window.has(path) && !this.#pendingFrames.has(path);
			for (const path of [...this.#index.keys()]) {
				if (!fresh.has(path) && settled(path)) this.#index.delete(path);
			}
			for (const [path, entry] of fresh) {
				if (!settled(path)) continue;
				this.#index.set(path, entry);
				if (entry.mtimeMs > this.#nextMtimeMs) this.#nextMtimeMs = entry.mtimeMs;
			}
		} finally {
			this.#refreshWindows.delete(window);
		}
	}

	/** Record a local index change in every refresh whose backend read is in flight. */
	#touch(path: string): void {
		for (const window of this.#refreshWindows) window.add(path);
	}

	async drain(): Promise<void> {
		// Quiesce EVERY pending backend operation, not just the drain-tracked
		// fire-and-forget publishes: an atomic write whose commit guard passed
		// just before a terminal seal is still on the wire with
		// `trackDrain: false`, and a graceful shutdown (SessionManager.close)
		// must not return while it can still publish under a reopened path.
		while (this.#drainPending.size > 0 || this.#pathPending.size > 0) {
			await Promise.allSettled([...this.#drainPending, ...this.#pathPending.values()]);
		}
		const error = this.#firstDrainError;
		this.#firstDrainError = undefined;
		if (error) throw error;
	}

	ensureDirSync(_dir: string): void {
		// Indexed backends are flat: directories are derived from key prefixes.
	}

	existsSync(path: string): boolean {
		return this.#index.has(path);
	}

	existsConfirmedSync(path: string): boolean {
		const frames = this.#pendingFrames.get(path);
		if (!frames) {
			const entry = this.#index.get(path);
			return entry !== undefined && !entry.unconfirmed;
		}
		// A removal in flight can delete the content before its op settles (Redis deletes the
		// file key before the metadata), so the path is unconfirmed until the removal settles.
		if (frames.some(frame => frame.removal)) return false;
		// The oldest live frame's previous entry is the last state the backend confirmed.
		const confirmed = frames[0]?.previous;
		return confirmed !== undefined && !confirmed.unconfirmed;
	}

	/**
	 * Resolve once the publishes queued for `path` have settled, rejecting when
	 * one failed. The path tail is installed synchronously by `#enqueuePaths`,
	 * so a caller confirming immediately after `writeTextSync` observes its own
	 * write rather than a later one.
	 */
	confirmWrites(path: string): Promise<void> {
		return this.#awaitPath(path);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#assertExpectedSize(path, options?.expectedSize);
		this.#queueFullWrite(path, this.#textBody(path, content), options?.expectedSize);
	}

	/**
	 * Streaming {@link writeTextSync}: spools `lines`, iterated once, to a
	 * temporary file and publishes it from there, so the body is never one
	 * string. A subclass or spy that intercepts {@link writeTextSync} still sees
	 * every full rewrite: the lines are then joined and routed through it.
	 */
	writeLinesSync(path: string, lines: Iterable<string>, options?: SessionStorageWriteOptions): void {
		if (this.writeTextSync !== IndexedSessionStorage.prototype.writeTextSync) {
			this.writeTextSync(path, Array.from(lines).join(""), options);
			return;
		}
		this.#assertExpectedSize(path, options?.expectedSize);
		this.#queueFullWrite(path, this.#spoolBody(path, spoolLines(lines)), options?.expectedSize);
	}

	/** Install `body` in the index and queue its publish, tracked by {@link drain}. */
	#queueFullWrite(path: string, body: FullBody, expectedSize: number | null | undefined): void {
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		this.#setIndex(path, body.byteLength, mtimeMs, body.title ?? null);
		this.#pushFrame(path, { mtimeMs, previous });
		const write = this.#enqueuePath(path, () => body.publish(mtimeMs, expectedSize), { trackDrain: true });
		this.#trackFrame(path, mtimeMs, write);
		if (body.release) void write.then(body.release, body.release);
	}

	#textBody(path: string, content: string): FullBody {
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		return {
			byteLength: byteLength(content),
			title,
			publish: (mtimeMs, expectedSize) => this.#backend.writeFull(path, content, mtimeMs, title, expectedSize),
			isStored: async () => (await this.#backend.readFull(path)) === content,
		};
	}

	#spoolBody(path: string, spool: BodySpool): FullBody {
		return {
			byteLength: spool.byteLength,
			title: spool.title,
			publish: (mtimeMs, expectedSize) =>
				this.#backend.writeFullStream
					? this.#backend.writeFullStream(
							path,
							spool.chunks(),
							spool.byteLength,
							mtimeMs,
							spool.title,
							expectedSize,
						)
					: this.#backend.writeFull(path, spool.text(), mtimeMs, spool.title, expectedSize),
			// Compared by size and SHA-256, so neither side is read whole.
			isStored: async () => {
				const stored = await digestChunks(this.#backendChunks(path, 0));
				if (stored.byteLength !== spool.byteLength) return false;
				return stored.digest === (await digestChunks(spool.chunks())).digest;
			},
			release: () => spool.close(),
		};
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		if (!previous) throw enoent(path);
		const mtimeMs = this.#allocMtimeMs();
		const next = {
			...previous,
			title: title.title,
			titleSource: title.source,
			titleUpdatedAt: title.updatedAt,
			mtimeMs,
		};
		this.#index.set(path, next);
		this.#pushFrame(path, { mtimeMs, previous });
		const pending = this.#enqueuePath(path, () => this.#backend.updateSessionTitle(path, title, mtimeMs), {
			trackDrain: false,
		});
		this.#trackFrame(path, mtimeMs, pending);
		try {
			await pending;
		} catch (err) {
			throw toError(err);
		}
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const resolvedDir = path.resolve(dir);
		const out: string[] = [];
		const segments = pattern.split("/").length;
		for (const key of this.#index.keys()) {
			const name = childKeyName(resolvedDir, key, segments);
			if (name === undefined || !matchesGlob(name, pattern)) continue;
			out.push(key);
		}
		return out;
	}

	listDirsSync(dir: string): string[] {
		return childDirNames(path.resolve(dir), this.#index.keys());
	}

	listAllSync(): string[] {
		return [...this.#index.keys()];
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	async readText(path: string): Promise<string> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		await this.#awaitPath(path);
		const content = await this.#backend.readFull(path);
		if (content === null) throw enoent(path);
		const title = titleUpdateForIndex(entry);
		return title ? overlayTitleSlotContent(content, title) : content;
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		const prefixLimit = normalizeByteLimit(prefixBytes);
		const suffixLimit = normalizeByteLimit(suffixBytes);
		if (prefixLimit === 0 && suffixLimit === 0) return ["", ""];
		await this.#awaitPath(path);
		const [prefix, suffix] = await this.#backend.readSlices(path, prefixLimit, suffixLimit);
		const title = titleUpdateForIndex(entry);
		return [title ? overlayTitleSlotPrefix(prefix, prefixLimit, title) : prefix, suffix];
	}

	/**
	 * The text from byte `offset`, at most `maxBytes` of it, and the size the
	 * read saw. Both come from the backend's read, not this storage's index, so
	 * an append another process made since the index loaded is read too. The
	 * title slot is synthesized over the stored head, so a read that starts
	 * inside it reads from the start and overlays the slot.
	 */
	async readTextFrom(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number }> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		await this.#awaitPath(path);
		const title = offset < SESSION_TITLE_SLOT_BYTES ? titleUpdateForIndex(entry) : undefined;
		const start = title ? 0 : offset;
		const limit = maxBytes === undefined ? undefined : offset - start + Math.max(0, maxBytes);
		const read = await this.#readBackendFrom(path, start, limit);
		if (!read) throw enoent(path);
		if (!title) return read;
		const head = overlayTitleSlotPrefix(read.text, byteLength(read.text), title);
		return { text: Buffer.from(head, "utf-8").subarray(offset).toString("utf-8"), size: read.size };
	}

	async #readBackendFrom(
		path: string,
		offset: number,
		maxBytes: number | undefined,
	): Promise<{ text: string; size: number } | null> {
		if (this.#backend.readFrom) return this.#backend.readFrom(path, offset, maxBytes);
		const content = await this.#backend.readFull(path);
		if (content === null) return null;
		const bytes = Buffer.from(content, "utf-8");
		if (offset >= bytes.length) return { text: "", size: bytes.length };
		const end = maxBytes === undefined ? undefined : offset + maxBytes;
		return { text: bytes.subarray(offset, end).toString("utf-8"), size: bytes.length };
	}

	/**
	 * The bytes from byte `fromByte`, read from the backend in chunks. As in
	 * {@link readTextFrom}, the title slot is synthesized over the stored head,
	 * so a read that starts inside it reads from the start and overlays it.
	 */
	async *readChunks(path: string, fromByte = 0): AsyncGenerator<Uint8Array> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		await this.#awaitPath(path);
		const start = Math.max(0, fromByte);
		const title = start < SESSION_TITLE_SLOT_BYTES ? titleUpdateForIndex(entry) : undefined;
		if (title) yield* overlayTitleSlotChunks(this.#backendChunks(path, 0), title, start);
		else yield* this.#backendChunks(path, start);
	}

	/** The stored bytes from `fromByte`: the backend's chunks, or its whole read cut there. */
	async *#backendChunks(path: string, fromByte: number): AsyncGenerator<Uint8Array> {
		if (this.#backend.readChunks) {
			yield* this.#backend.readChunks(path, fromByte);
			return;
		}
		const content = await this.#backend.readFull(path);
		if (content === null) throw enoent(path);
		const bytes = Buffer.from(content, "utf-8");
		if (fromByte < bytes.byteLength) yield bytes.subarray(fromByte);
	}

	async scanLines(path: string, visit: (line: string) => boolean): Promise<void> {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of this.readChunks(path)) {
			let searchFrom = pending.length;
			pending += decoder.decode(chunk, { stream: true });
			let start = 0;
			for (let newline = pending.indexOf("\n", searchFrom); newline !== -1;) {
				if (visit(pending.slice(start, newline))) return;
				start = newline + 1;
				searchFrom = start;
				newline = pending.indexOf("\n", searchFrom);
			}
			pending = pending.slice(start);
		}
		// The text after the last newline, "" when the file ends with one, as `split("\n")` yields it.
		visit(pending + decoder.decode());
	}

	async writeText(path: string, content: string): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
		this.#pushFrame(path, { mtimeMs, previous });
		const pending = this.#enqueuePath(path, () => this.#backend.writeFull(path, content, mtimeMs, title), {
			trackDrain: false,
		});
		this.#trackFrame(path, mtimeMs, pending);
		await pending;
	}

	async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		await this.#publishAtomic(path, options, () => this.#textBody(path, content));
	}

	/**
	 * Streaming {@link writeTextAtomic}: spools `lines`, iterated once, to a
	 * temporary file and publishes it from there, and after a failed publish
	 * compares the stored bytes with the spool by size and SHA-256. A subclass or
	 * spy that intercepts {@link writeTextAtomic} still sees every full rewrite:
	 * the lines are then joined and routed through it.
	 */
	async writeLinesAtomic(path: string, lines: Iterable<string>, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.writeTextAtomic !== IndexedSessionStorage.prototype.writeTextAtomic) {
			return this.writeTextAtomic(path, Array.from(lines).join(""), options);
		}
		await this.#publishAtomic(path, options, () => this.#spoolBody(path, spoolLines(lines)));
	}

	/**
	 * Publish the body `prepare` makes once the guards pass, then settle the
	 * optimistic index frame: a failed publish whose body the backend holds
	 * anyway counts as landed.
	 */
	async #publishAtomic(
		path: string,
		options: WriteTextAtomicOptions | undefined,
		prepare: () => FullBody,
	): Promise<void> {
		const commitGuard = options?.commitGuard;
		if (commitGuard && !commitGuard()) return;
		await this.#awaitPath(path);
		// A concurrent flushSync (writeTextSync) may have taken over during the
		// awaitPath yield and bumped the epoch. Re-check before touching the
		// index or enqueueing the backend publish.
		if (commitGuard && !commitGuard()) return;
		this.#assertExpectedSize(path, options?.expectedSize);
		const body = prepare();
		try {
			const previous = this.#index.get(path);
			const mtimeMs = this.#allocMtimeMs();
			this.#setIndex(path, body.byteLength, mtimeMs, body.title ?? null);
			this.#pushFrame(path, { mtimeMs, previous });
			try {
				await this.#enqueuePath(
					path,
					async () => {
						// Final guard immediately before the backend actually publishes.
						// If a concurrent writer has advanced the index past our
						// optimistic entry, leave that newer state alone; otherwise
						// restore the pre-write snapshot so readers do not observe a
						// body we never wrote.
						if (commitGuard && !commitGuard()) {
							const current = this.#index.get(path);
							if (current?.mtimeMs === mtimeMs) this.#restoreIndex(path, previous);
							this.#abandonFrame(path, mtimeMs);
							return;
						}
						await body.publish(mtimeMs, options?.expectedSize);
					},
					{ trackDrain: false },
				);
				this.#dropFrame(path, mtimeMs);
			} catch (err) {
				const error = toError(err);
				try {
					if (await body.isStored()) {
						this.#dropFrame(path, mtimeMs);
						return;
					}
				} catch {
					// Preserve the original write failure; verification was unavailable.
				}
				this.#failFrame(path, mtimeMs);
				throw error;
			}
		} finally {
			body.release?.();
		}
	}

	rename(src: string, dst: string): Promise<void> {
		return this.#rename(src, dst, false);
	}

	/**
	 * {@link rename} that never replaces: a `dst` in this store's view, or one
	 * another client committed to the shared store, makes it reject with
	 * `EEXIST` naming `dst`, and neither path changes.
	 */
	renameNoReplace(src: string, dst: string): Promise<void> {
		return this.#rename(src, dst, true);
	}

	async #rename(src: string, dst: string, noReplace: boolean): Promise<void> {
		await this.#awaitPath(src);
		await this.#awaitPath(dst);
		const entry = this.#index.get(src);
		if (!entry) throw enoent(src);
		if (src === dst) {
			await this.#enqueuePath(src, () => this.#backend.move(src, dst, entry.mtimeMs), { trackDrain: false });
			return;
		}
		const dstPrevious = this.#index.get(dst);
		if (noReplace && dstPrevious) throw eexist(dst);
		this.#index.delete(src);
		this.#index.set(dst, { ...entry });
		this.#pushFrame(src, { mtimeMs: entry.mtimeMs, previous: entry, removal: true });
		this.#pushFrame(dst, { mtimeMs: entry.mtimeMs, previous: dstPrevious });
		try {
			await this.#enqueuePaths([src, dst], () => this.#backend.move(src, dst, entry.mtimeMs, noReplace), {
				trackDrain: false,
			});
			this.#dropFrame(src, entry.mtimeMs);
			this.#dropFrame(dst, entry.mtimeMs);
		} catch (err) {
			this.#failFrame(src, entry.mtimeMs);
			this.#failFrame(dst, entry.mtimeMs);
			throw toError(err);
		}
	}

	async unlink(path: string): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		if (!previous) throw enoent(path);
		this.#index.delete(path);
		this.#pushFrame(path, { mtimeMs: previous.mtimeMs, previous, removal: true });
		try {
			await this.#enqueuePath(path, () => this.#backend.remove([path]), { trackDrain: false });
			this.#dropFrame(path, previous.mtimeMs);
		} catch (err) {
			this.#failFrame(path, previous.mtimeMs);
			throw toError(err);
		}
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Rows another client committed under the artifacts directory (a
		// subagent transcript, a draft) go too: the refresh brings the ones
		// committed so far into this view, and the backend removes every key
		// under the directory it holds when the removal runs, so one committed
		// after the refresh goes as well.
		await this.refresh();
		await this.#awaitPath(sessionPath);
		const sessionEntry = this.#index.get(sessionPath);
		if (!sessionEntry) throw enoent(sessionPath);

		const artifactsDir = sessionPath.slice(0, -6);
		const prefix = artifactsDir.endsWith("/") ? artifactsDir : `${artifactsDir}/`;
		const paths = [sessionPath];
		for (const key of this.#index.keys()) {
			if (key.startsWith(prefix)) paths.push(key);
		}

		for (const path of paths) await this.#awaitPath(path);

		const previous = new Map<string, IndexEntry>();
		for (const path of paths) {
			const entry = this.#index.get(path);
			if (entry) previous.set(path, entry);
			this.#index.delete(path);
		}
		for (const [path, entry] of previous) {
			this.#pushFrame(path, { mtimeMs: sessionEntry.mtimeMs, previous: entry, removal: true });
		}

		try {
			await this.#enqueuePaths(paths, () => this.#backend.remove(paths, prefix), { trackDrain: false });
			for (const [path] of previous) this.#dropFrame(path, sessionEntry.mtimeMs);
		} catch (err) {
			for (const [path] of previous) this.#failFrame(path, sessionEntry.mtimeMs);
			throw toError(err);
		}
		// Tool artifacts and sidecars stay on local disk whatever holds the
		// transcripts, so removing the session removes them as the file
		// backend's delete does.
		try {
			await fs.promises.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(`Session deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`, {
				cause: error,
			});
		}
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = new IndexedSessionStorageWriter(this, path, options);
		this.#writers.add(writer);
		return writer;
	}

	_writerClosed(writer: IndexedSessionStorageWriter): void {
		this.#writers.delete(writer);
	}

	_truncateForWriter(path: string): number {
		const mtimeMs = this.#allocMtimeMs();
		this.#pushFrame(path, { mtimeMs, previous: this.#index.get(path) });
		this.#setIndex(path, 0, mtimeMs, null);
		return mtimeMs;
	}

	_queueTruncate(path: string, mtimeMs: number, getError?: () => Error | undefined): Promise<void> {
		const tracked = this.#enqueuePath(
			path,
			async () => {
				const error = getError?.();
				if (error) throw error;
				await this.#backend.truncate(path, mtimeMs);
			},
			{ trackDrain: true },
		);
		this.#trackFrame(path, mtimeMs, tracked);
		return tracked;
	}

	_appendForWriter(path: string, line: string): IndexAppend {
		const mtimeMs = this.#allocMtimeMs();
		const previous = this.#index.get(path);
		const size = (previous?.size ?? 0) + byteLength(line);
		this.#setIndex(path, size, mtimeMs);
		return { mtimeMs, previous };
	}

	_queueAppend(path: string, line: string, append: IndexAppend, getError?: () => Error | undefined): Promise<void> {
		const { mtimeMs } = append;
		this.#pushFrame(path, append);
		const tracked = this.#enqueuePath(
			path,
			async () => {
				const error = getError?.();
				if (error) throw error;
				await this.#backend.append(path, line, mtimeMs, append.previous?.size ?? 0);
			},
			{ trackDrain: true, abortOnPredecessorFailure: true },
		);
		this.#trackFrame(path, mtimeMs, tracked);
		return tracked;
	}

	#restoreIndex(path: string, entry: IndexEntry | undefined): void {
		this.#touch(path);
		if (entry) {
			this.#index.set(path, entry);
		} else {
			this.#index.delete(path);
		}
	}

	#setIndex(
		path: string,
		size: number,
		mtimeMs: number,
		title: SessionTitleUpdate | null | undefined = undefined,
	): void {
		this.#touch(path);
		const current = title === undefined ? this.#index.get(path) : undefined;
		this.#index.set(path, {
			size,
			mtimeMs,
			title: title === undefined ? current?.title : (title?.title ?? undefined),
			titleSource: title === undefined ? current?.titleSource : (title?.source ?? undefined),
			titleUpdatedAt: title === undefined ? current?.titleUpdatedAt : (title?.updatedAt ?? undefined),
			// An append extends the current content, so it does not restore what a failed removal deleted.
			...(current?.unconfirmed ? { unconfirmed: true } : {}),
		});
		if (mtimeMs > this.#nextMtimeMs) this.#nextMtimeMs = mtimeMs;
	}

	#allocMtimeMs(): number {
		const now = Date.now();
		const next = now > this.#nextMtimeMs ? now : this.#nextMtimeMs + 1;
		this.#nextMtimeMs = next;
		return next;
	}

	#enqueuePath(path: string, task: () => Promise<void>, options: EnqueueOptions): Promise<void> {
		return this.#enqueuePaths([path], task, options);
	}

	#pushFrame(path: string, frame: IndexAppend): void {
		this.#touch(path);
		const frames = this.#pendingFrames.get(path);
		if (frames) frames.push(frame);
		else this.#pendingFrames.set(path, [frame]);
	}

	#dropFrame(path: string, mtimeMs: number): void {
		const frames = this.#pendingFrames.get(path);
		if (!frames) return;
		const index = frames.findIndex(frame => frame.mtimeMs === mtimeMs);
		if (index >= 0) frames.splice(index, 1);
		if (frames.length === 0) this.#pendingFrames.delete(path);
	}

	/**
	 * Drop the frame of an op that never published. A newer frame was queued
	 * on top of this op's unpublished entry, so it inherits this frame's
	 * previous entry, keeping the oldest live frame's previous durable state.
	 */
	#abandonFrame(path: string, mtimeMs: number): void {
		const frames = this.#pendingFrames.get(path);
		if (!frames) return;
		const index = frames.findIndex(frame => frame.mtimeMs === mtimeMs);
		if (index < 0) return;
		const [abandoned] = frames.splice(index, 1);
		const next = frames[index];
		if (abandoned && next) next.previous = abandoned.previous;
		if (frames.length === 0) this.#pendingFrames.delete(path);
	}

	/**
	 * Settle a failed optimistic frame. The frame drops; when newer frames
	 * are still live their publishes will converge the backend past this
	 * failure, so the next frame rebases onto this frame's previous instead
	 * of restoring it. When no newer frame lives, restore this frame's
	 * previous unless a newer mutation committed meanwhile: a failure that
	 * settles outside the queue (the atomic write's gated readback) can
	 * land after a newer write committed and dropped its frame, and
	 * restoring then would clobber newer durable state (F1). Index mtimes
	 * are unique per mutation, so a live entry carrying a different mtime
	 * proves a newer commit won; an absent entry (unlink/rename-src
	 * bookkeeping) or our own optimistic entry still restores. Rebased
	 * chains stay exact: the oldest live frame's previous is always
	 * durable state. A failed removal may have deleted part of the path
	 * before it failed, so the entry it hands on is marked unconfirmed.
	 */
	#failFrame(path: string, mtimeMs: number): void {
		const frames = this.#pendingFrames.get(path);
		if (!frames) return;
		const index = frames.findIndex(frame => frame.mtimeMs === mtimeMs);
		if (index < 0) return;
		const [failed] = frames.splice(index, 1);
		if (failed === undefined) return;
		const next = frames[index];
		const previous =
			failed.removal && failed.previous ? { ...failed.previous, unconfirmed: true as const } : failed.previous;
		if (next === undefined) {
			const current = this.#index.get(path);
			if (current === undefined || current.mtimeMs === mtimeMs) this.#restoreIndex(path, previous);
		} else next.previous = previous;
		if (frames.length === 0) this.#pendingFrames.delete(path);
	}

	/**
	 * Settle an optimistic frame when its queued backend op settles: success
	 * drops the frame (its entry is durable), failure folds it via #failFrame.
	 */
	#trackFrame(path: string, mtimeMs: number, tracked: Promise<void>): void {
		void tracked.then(
			() => this.#dropFrame(path, mtimeMs),
			() => this.#failFrame(path, mtimeMs),
		);
	}

	#enqueuePaths(paths: readonly string[], task: () => Promise<void>, options: EnqueueOptions): Promise<void> {
		const unique = uniquePaths(paths);
		// Predecessor choice (rJDg): a positional publish with no backend CAS
		// token (backend.append) chains on the uncaught pending op so it
		// fail-fasts behind a failed op instead of landing on a body the
		// backend never accepted. Absolute publishes carry their own backend
		// validation and chain on the caught tail, so a superseding publish
		// still runs to converge (e.g. a newer title update over a failed one).
		const previous = unique.map(
			path =>
				(options.abortOnPredecessorFailure ? this.#pathPending.get(path) : this.#pathTails.get(path)) ?? RESOLVED,
		);
		const operation = Promise.all(previous).then(task);
		const tracked = operation.catch(err => {
			const error = toError(err);
			// A write the claim fence refused changed nothing, and its caller
			// republishes those entries elsewhere: no durable write is missing.
			if (options.trackDrain && !this.#firstDrainError && !(error instanceof SessionLeaseLostError)) {
				this.#firstDrainError = error;
			}
			throw error;
		});
		const tail = tracked.catch(() => {});
		for (const path of unique) {
			this.#pathTails.set(path, tail);
			this.#pathPending.set(path, tracked);
		}
		tail.finally(() => {
			for (const path of unique) {
				if (this.#pathTails.get(path) === tail) this.#pathTails.delete(path);
			}
		});
		tracked
			.finally(() => {
				for (const path of unique) {
					if (this.#pathPending.get(path) === tracked) this.#pathPending.delete(path);
				}
			})
			.catch(() => {});
		tracked.catch(() => {});
		if (options.trackDrain) {
			this.#drainPending.add(tracked);
			tracked
				.finally(() => {
					this.#drainPending.delete(tracked);
				})
				.catch(() => {});
		}
		return tracked;
	}

	#awaitPath(path: string): Promise<void> {
		return this.#pathPending.get(path) ?? RESOLVED;
	}
}

class IndexedSessionStorageWriter implements SessionStorageWriter {
	#storage: IndexedSessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;
	#pendingChain: Promise<void> = Promise.resolve();

	constructor(
		storage: IndexedSessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			const mtimeMs = storage._truncateForWriter(path);
			this.#trackPromise(storage._queueTruncate(path, mtimeMs, () => this.#error));
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	#trackPromise(promise: Promise<void>): Promise<void> {
		const next = this.#pendingChain.then(async () => {
			if (this.#error) throw this.#error;
			try {
				await promise;
			} catch (err) {
				throw this.#recordError(err);
			}
		});
		this.#pendingChain = next.catch(() => {});
		return next;
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		// Local index is updated immediately; remote publish stays ordered on the
		// path queue. Callers that need remote durability still await append()/flush().
		const append = this.#storage._appendForWriter(this.#path, line);
		void this.#trackPromise(this.#storage._queueAppend(this.#path, line, append, () => this.#error));
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const append = this.#storage._appendForWriter(this.#path, line);
		await this.#trackPromise(this.#storage._queueAppend(this.#path, line, append, () => this.#error));
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
		await this.#pendingChain;
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.flush();
		} finally {
			this.#storage._writerClosed(this);
		}
	}

	getError(): Error | undefined {
		return this.#error;
	}
}
