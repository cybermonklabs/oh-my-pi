import * as fs from "node:fs";
import * as path from "node:path";
import { ConcatSink, logger, toError } from "@oh-my-pi/pi-utils";
import { type FullBody, FullBodies } from "./session-body";
import {
	byteLimit,
	byteOffset,
	byteWindow,
	childDirNames,
	childKeyName,
	SessionLeaseLostError,
	SessionWriteConflictError,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
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

/** A session a backend holds, as its index load lists it: its path, size in bytes and time, never its title. */
export interface SessionStorageIndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
}

/**
 * The title metadata a backend read returns with the bytes it read, from the
 * same snapshot of the session: `undefined` when the session records none (no
 * title update or titled full write set it). A title update with an empty
 * title is a title (a clear), not `undefined`. The storage lays it over the
 * head of the bytes as the session's title slot.
 */
export type SessionStorageReadTitle = SessionTitleUpdate | undefined;

/** {@link SessionStorageBackend.readFull}: the stored text as it is, and the title metadata stored with it. */
export interface SessionStorageFullRead {
	text: string;
	title: SessionStorageReadTitle;
}

/** {@link SessionStorageBackend.readFrom}: stored bytes as they are, the session's stored size, and its title metadata. */
export interface SessionStorageWindowRead {
	bytes: Uint8Array;
	size: number;
	title: SessionStorageReadTitle;
}

/** A window of a session's stored bytes: from byte `start`, at most `maxBytes` of them (to the end without them). */
export interface SessionStorageStoredWindow {
	start: number;
	maxBytes: number | undefined;
}

/**
 * What {@link SessionStorageBackend.readChunks} yields first, before any
 * byte: the title metadata of the snapshot its bytes come from.
 */
export interface SessionStorageChunksStart {
	readonly title: SessionStorageReadTitle;
}

/** An item of {@link SessionStorageBackend.readChunks}: its start record, then stored bytes. */
export type SessionStorageChunk = SessionStorageChunksStart | Uint8Array;

/**
 * A store of session files under {@link IndexedSessionStorage}. Every read
 * returns the bytes as they are stored, with the title metadata the store
 * holds for the session from the same snapshot as those bytes: the storage
 * lays the title over the head it returns, so a reader never gets one
 * version's title with another's bytes, and keeps no title of its own.
 */
export interface SessionStorageBackend {
	init(): Promise<void>;
	/** Every session the store holds, with its size and time; no title. */
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>>;
	/** The stored text and its title metadata, from one read; `null` when `path` holds no session. */
	readFull(path: string): Promise<SessionStorageFullRead | null>;
	/**
	 * At most the first `prefixBytes` and the last `suffixBytes` of the
	 * stored bytes, as text, and the title metadata, from one read. Each count
	 * is one {@link byteLimit} gave: a whole number, 0 for no window.
	 */
	readSlices(
		path: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[prefix: string, suffix: string, title: SessionStorageReadTitle]>;
	/**
	 * A window of the stored bytes, the session's stored size in bytes, and
	 * its title metadata, all from one read of the backing store; `null` when
	 * `path` holds no session. The title the read finds picks the window:
	 * without one, the bytes from byte `offset`, at most `maxBytes` of them
	 * (to the end without them), each a whole number {@link byteOffset} and
	 * {@link byteLimit} gave from the caller's, placed by the store's own byte
	 * positions (a negative offset lands where they put it); with one, the
	 * window `titled` names, in whole numbers {@link byteWindow} gave, which the
	 * title slot's window needs. Optional: without it the storage reads the
	 * whole session and cuts it.
	 */
	readFrom?(
		path: string,
		offset: number,
		maxBytes: number | undefined,
		titled: SessionStorageStoredWindow,
	): Promise<SessionStorageWindowRead | null>;
	/**
	 * A {@link SessionStorageChunksStart} with the session's title metadata,
	 * then the stored bytes from byte `fromByte` to the end, as chunks in
	 * order, all from the snapshot the start record describes (or the read
	 * fails as a conflict): what {@link readFull} returns from that offset,
	 * without holding it whole. Iterating rejects with ENOENT when `path`
	 * holds no session. Optional: without it the storage reads the whole
	 * session and cuts it.
	 */
	readChunks?(path: string, fromByte: number): AsyncIterable<SessionStorageChunk>;
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
	 * all at once. A stream that fails, or ends short, replaces nothing.
	 * Optional: without it the storage reads the spooled body back whole and
	 * calls {@link writeFull}, and a full rewrite whose spool cannot be used
	 * fails.
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
	/**
	 * Append `lines`, in order, as one write that stores all of them or none.
	 * `expectedSize` is the size this store's index held for `path` before the
	 * first line, checked once as {@link append} checks it; `mtimeMs` is the
	 * last line's. Throw {@link SessionAppendBatchRolledBackError} only when
	 * the write is known to have stored none of them (its transaction rolled
	 * back before COMMIT): the storage then appends them again, one
	 * {@link append} each, each line taking its own outcome. Any other error
	 * fails every line, and none is appended again. Optional: without it the
	 * storage appends a path's queued lines one {@link append} each.
	 */
	appendBatch?(path: string, lines: readonly string[], mtimeMs: number, expectedSize?: number): Promise<void>;
	/**
	 * Set the session's title metadata and time; its stored bytes and size stay as they are. Rejects with
	 * `ENOENT`, writing nothing, when the store holds no session at `path`.
	 */
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

/**
 * {@link SessionStorageBackend.appendBatch} stored none of its lines: its
 * transaction rolled back before COMMIT (a statement failed, such as the size
 * check, whose error is `cause`). The storage appends the lines again one at
 * a time, so each takes the outcome it would have had alone. Never leaves the
 * storage.
 */
export class SessionAppendBatchRolledBackError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`Session append batch to ${path} rolled back before its commit: ${toError(cause).message}`, { cause });
		this.name = "SessionAppendBatchRolledBackError";
		this.path = path;
	}
}

/**
 * What the index keeps of a path: its size and time, for the synchronous
 * answers (`existsSync`, `statSync`, the listings). No title: every read
 * takes the title from the backend read it makes, with the bytes.
 */
interface IndexEntry {
	size: number;
	mtimeMs: number;
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
	/**
	 * With {@link abortOnPredecessorFailure}: run when a predecessor's failure
	 * skips the task, just before the operation rejects with that failure.
	 */
	onAbort?: (error: unknown) => void;
}

/** Optimistic index entry a queued append installed, kept for failure rollback. */
interface IndexAppend {
	mtimeMs: number;
	previous: IndexEntry | undefined;
	/** Set when the queued op removes the path (unlink, delete, rename source). */
	removal?: true;
}

/**
 * A line queued on a path's append batch: its optimistic index frame, the
 * error of the writer that queued it, and its own outcome, which settles its
 * frame and its bytes of the process's queued appends ({@link appendAdmission}).
 */
interface QueuedLine {
	/**
	 * The line. A batch appended one line at a time empties it as its own
	 * write lands ({@link IndexedSessionStorage}'s `#appendLines`).
	 */
	line: string;
	/** The line's UTF-8 byte length. */
	readonly bytes: number;
	readonly frame: IndexAppend;
	readonly getError: (() => Error | undefined) | undefined;
	readonly settled: PromiseWithResolvers<void>;
}

/**
 * Whether a batch's `lines` can go to the backend in one write with the
 * outcome each would have alone: no line's writer has failed, and each
 * line's size check expects the size the line before it leaves, as lines
 * queued one after another do. A failed frame ahead of them can rebase one
 * line's expected size; then each line goes alone.
 */
function appendsChain(lines: readonly QueuedLine[]): boolean {
	let size: number | undefined;
	for (const queued of lines) {
		if (queued.getError?.()) return false;
		const expected = queued.frame.previous?.size ?? 0;
		if (size !== undefined && expected !== size) return false;
		size = expected + queued.bytes;
	}
	return true;
}

const RESOLVED = Promise.resolve();

/**
 * UTF-8 bytes of appended lines that every {@link IndexedSessionStorage} in
 * this process together holds queued and unsettled past which
 * {@link IndexedSessionStorage.waitForAppendAdmission} waits. Not a hard
 * bound: `appendSync` queues its line whatever the queue holds, and an async
 * `append` queues its line before it waits, so the queue passes it by what
 * they add while turns wait.
 */
const APPEND_ADMISSION_BYTES = 64 * 1024 * 1024;

/**
 * How long an admission waits before it logs a warning, once: queued lines
 * that take this long to settle (a backend whose connection hangs) hold every
 * turn of the process before each model request and each tool result.
 */
const APPEND_ADMISSION_WARN_MS = 10_000;

/**
 * The process's queued appends: the UTF-8 bytes of the lines every path of
 * every {@link IndexedSessionStorage} queued, each counted from when it
 * queues until its backend write settles, either way; and the admissions
 * waiting for them to fall to {@link APPEND_ADMISSION_BYTES}.
 */
class AppendAdmission {
	#queuedBytes = 0;
	readonly #waiters = new Set<() => void>();

	/** Whether the queued bytes are at or under {@link APPEND_ADMISSION_BYTES}. */
	get admits(): boolean {
		return this.#queuedBytes <= APPEND_ADMISSION_BYTES;
	}

	queue(bytes: number): void {
		this.#queuedBytes += bytes;
	}

	settle(bytes: number): void {
		this.#queuedBytes -= bytes;
		if (!this.admits) return;
		for (const admit of this.#waiters) admit();
		this.#waiters.clear();
	}

	/** Resolve once the queued bytes are at or under {@link APPEND_ADMISSION_BYTES}, or `signal` fires; at once when either holds now. */
	wait(signal: AbortSignal | undefined): Promise<void> {
		if (this.admits || signal?.aborted) return RESOLVED;
		return this.#waitFor(signal);
	}

	async #waitFor(signal: AbortSignal | undefined): Promise<void> {
		const queuedBytes = this.#queuedBytes;
		const started = performance.now();
		const { promise, resolve } = Promise.withResolvers<void>();
		const admit = (): void => resolve();
		this.#waiters.add(admit);
		signal?.addEventListener("abort", admit, { once: true });
		const slow = setTimeout(() => {
			logger.warn("Session append admission still waiting", {
				queuedBytes: this.#queuedBytes,
				admissionBytes: APPEND_ADMISSION_BYTES,
				waitMs: Math.round(performance.now() - started),
			});
		}, APPEND_ADMISSION_WARN_MS);
		// The warning alone keeps no process alive.
		slow.unref();
		try {
			await promise;
		} finally {
			clearTimeout(slow);
			this.#waiters.delete(admit);
			signal?.removeEventListener("abort", admit);
		}
		logger.debug("Session append admission waited", { queuedBytes, waitMs: Math.round(performance.now() - started) });
	}
}

const appendAdmission = new AppendAdmission();

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

const utf8Decoder = new TextDecoder("utf-8");

/**
 * The bytes `[start, end)` of the text {@link IndexedSessionStorage.readText}
 * gives a session titled `title`, from its stored bytes from byte `storedFrom`
 * (`stored`): below {@link SESSION_TITLE_SLOT_BYTES} the title slot's (which
 * stands for the stored head, and for the whole of a shorter body), past it
 * the stored ones.
 */
function titledWindow(
	stored: Uint8Array,
	storedFrom: number,
	start: number,
	end: number,
	title: SessionTitleUpdate,
): Uint8Array {
	if (start >= end) return stored.subarray(0, 0);
	const slot = Buffer.from(serializeTitleSlot(title), "utf-8");
	if (start >= slot.length) return stored.subarray(start - storedFrom, end - storedFrom);
	if (end <= slot.length) return slot.subarray(start, end);
	return Buffer.concat([slot.subarray(start), stored.subarray(slot.length - storedFrom, end - storedFrom)]);
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

/** The stored bytes a backend's chunked read yields, without its start record. */
async function* storedChunks(read: AsyncIterable<SessionStorageChunk>): AsyncGenerator<Uint8Array> {
	for await (const item of read) if (item instanceof Uint8Array) yield item;
}

/**
 * The bytes from `fromByte` of a backend's chunked read from there (its
 * start record, then its stored chunks), as {@link IndexedSessionStorage}'s
 * `readText` gives them: with the read's title, the title slot it makes is
 * the first {@link SESSION_TITLE_SLOT_BYTES} bytes, over whatever is stored
 * there (a body shorter than the slot reads as the slot alone), and the
 * stored bytes follow from there on; without one, the stored bytes as they
 * are. The bytes before `fromByte` are never read.
 */
async function* titledChunks(read: AsyncIterable<SessionStorageChunk>, fromByte: number): AsyncGenerator<Uint8Array> {
	// The stored bytes the slot stands in for that are still to come.
	let skip = 0;
	for await (const item of read) {
		if (!(item instanceof Uint8Array)) {
			if (item.title && fromByte < SESSION_TITLE_SLOT_BYTES) {
				yield Buffer.from(serializeTitleSlot(item.title), "utf-8").subarray(fromByte);
				skip = SESSION_TITLE_SLOT_BYTES - fromByte;
			}
			continue;
		}
		if (skip >= item.byteLength) {
			skip -= item.byteLength;
			continue;
		}
		yield skip > 0 ? item.subarray(skip) : item;
		skip = 0;
	}
}

export class IndexedSessionStorage implements SessionStorage {
	/**
	 * Sync writes only update {@link #index} and queue the remote publish, so a
	 * caller tracking a durable byte size must wait for {@link drain}.
	 */
	readonly defersSyncPublish = true;
	/**
	 * The bytes from byte `fromByte`, read from the backend in chunks. Set only
	 * when the backend has its own {@link SessionStorageBackend.readChunks}, so a
	 * caller that finds it reads in bounded pieces; a caller that does not
	 * reads the session whole once. The bytes are those {@link readText} reads
	 * from there: the title slot the read's title makes stands for the first
	 * {@link SESSION_TITLE_SLOT_BYTES} stored bytes.
	 */
	readonly readChunks?: (path: string, fromByte?: number) => AsyncIterable<Uint8Array>;
	readonly #backend: SessionStorageBackend;
	/** The bodies of this store's full writes. */
	readonly #bodies: FullBodies;
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
	/**
	 * The append batch of each path that is still gathering lines: the last
	 * operation queued on the path, not started yet. A line queued for the
	 * path joins it; any other operation queued on the path, and the batch's
	 * own start, closes it, so later lines start the next batch.
	 */
	readonly #gathering = new Map<string, QueuedLine[]>();
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
		// A failed publish's read-back compares the stored bytes as they are, without the title.
		this.#bodies = new FullBodies(backend, path => storedChunks(this.#backendRead(path, 0)));
		if (backend.readChunks) this.readChunks = (path, fromByte = 0) => this.#readChunks(path, fromByte);
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
			for (const row of rows) fresh.set(row.path, { size: row.size, mtimeMs: row.mtimeMs });
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

	/**
	 * {@link SessionStorage.waitForAppendAdmission}. A wait lasts while the
	 * lines that every path of every `IndexedSessionStorage` in this process
	 * has queued to append hold more than 64 MiB, each counted from when it
	 * queues until its backend write settles, either way; a line a waiting
	 * caller appends next is not counted, so no caller waits for capacity only
	 * its own write would free. That is where turns start to wait, not a hard
	 * bound: `appendSync` never waits, and `append` queues its line, then
	 * waits. A wait that lasts 10 s logs a warning once, with the bytes queued
	 * then (`Session append admission still waiting`); a wait that waited logs
	 * the bytes queued when it began and how long it took (`Session append
	 * admission waited`).
	 */
	waitForAppendAdmission(signal?: AbortSignal): Promise<void> {
		return appendAdmission.wait(signal);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#assertExpectedSize(path, options?.expectedSize);
		this.#queueFullWrite(path, this.#bodies.text(path, content), options?.expectedSize);
	}

	/**
	 * Streaming {@link writeTextSync}: reads `lines` once, into a temporary
	 * file, or, where the platform has no account ids, into compressed blocks
	 * in memory, and publishes the body from there, so it is never one string.
	 * When the spool cannot be used it streams the lines to the backend instead
	 * (see {@link FullBodies.lines}). A subclass or spy that intercepts
	 * {@link writeTextSync} still sees every full rewrite: the lines are then
	 * joined and routed through it.
	 */
	writeLinesSync(path: string, lines: Iterable<string>, options?: SessionStorageWriteOptions): void {
		if (this.writeTextSync !== IndexedSessionStorage.prototype.writeTextSync) {
			this.writeTextSync(path, Array.from(lines).join(""), options);
			return;
		}
		this.#assertExpectedSize(path, options?.expectedSize);
		this.#queueFullWrite(path, this.#bodies.lines(path, lines), options?.expectedSize);
	}

	/** Install `body` in the index and queue its publish, tracked by {@link drain}. */
	#queueFullWrite(path: string, body: FullBody, expectedSize: number | null | undefined): void {
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		this.#setIndex(path, body.byteLength, mtimeMs);
		this.#pushFrame(path, { mtimeMs, previous });
		const write = this.#enqueuePath(path, () => body.publish(mtimeMs, expectedSize), { trackDrain: true });
		this.#trackFrame(path, mtimeMs, write);
		if (body.release) void write.then(body.release, body.release);
	}

	/**
	 * Set `path`'s title in the backend's metadata. The index takes only the
	 * update's time: readers read the title with the bytes, from the backend.
	 */
	async updateSessionTitle(path: string, title: SessionTitleUpdate): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		if (!previous) throw enoent(path);
		const mtimeMs = this.#allocMtimeMs();
		this.#index.set(path, { ...previous, mtimeMs });
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

	/** The text, with the title slot the read's own title makes laid over the stored head ({@link overlayTitleSlotContent}). */
	async readText(path: string): Promise<string> {
		if (!this.#index.has(path)) throw enoent(path);
		await this.#awaitPath(path);
		const read = await this.#backend.readFull(path);
		if (read === null) throw enoent(path);
		return read.title ? overlayTitleSlotContent(read.text, read.title) : read.text;
	}

	/**
	 * The text's first `prefixBytes` and last `suffixBytes`, with the title
	 * slot the read's own title makes laid over the prefix
	 * ({@link overlayTitleSlotPrefix}); the suffix is the stored one.
	 */
	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		if (!this.#index.has(path)) throw enoent(path);
		const prefixLimit = byteLimit(prefixBytes);
		const suffixLimit = byteLimit(suffixBytes);
		if (prefixLimit === 0 && suffixLimit === 0) return ["", ""];
		await this.#awaitPath(path);
		const [prefix, suffix, title] = await this.#backend.readSlices(path, prefixLimit, suffixLimit);
		return [title ? overlayTitleSlotPrefix(prefix, prefixLimit, title) : prefix, suffix];
	}

	/**
	 * The text from byte `offset`, at most `maxBytes` of it, and the size the
	 * read saw: the window {@link byteWindow} cuts from the bytes
	 * {@link readText} reads, and their size. Both come from the backend's read,
	 * not this storage's index, so an append another process made since the
	 * index loaded is read too. The title slot the read's title makes stands for
	 * the first {@link SESSION_TITLE_SLOT_BYTES} stored bytes, and for the whole
	 * of a shorter body, so with a title the size is never less than the slot's.
	 *
	 * Each read keeps the answers it has always given to whole numbers, and
	 * makes any other offset or limit whole by {@link byteLimit}'s rule before
	 * it reads: without the backend's `readFrom`, a whole read counts a negative
	 * offset from the end and decodes the window as it is; with it, an untitled
	 * read takes the window the backend's own byte positions place from the
	 * offset, and a titled read takes a negative offset as byte 0; both decode
	 * the window with a TextDecoder, which drops a byte-order mark that starts it.
	 */
	async readTextFrom(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number }> {
		if (!this.#index.has(path)) throw enoent(path);
		await this.#awaitPath(path);
		if (!this.#backend.readFrom) {
			const read = await this.#backend.readFull(path);
			if (read === null) throw enoent(path);
			const bytes = Buffer.from(read.title ? overlayTitleSlotContent(read.text, read.title) : read.text, "utf-8");
			const { start, end } = byteWindow(offset, maxBytes, bytes.length);
			return { text: bytes.toString("utf-8", start, end), size: bytes.length };
		}
		// The stored bytes a titled window can cover, whatever the session's size: the title slot needs none of them.
		const stored = byteWindow(offset, maxBytes, Number.POSITIVE_INFINITY, "from-start");
		const read = await this.#backend.readFrom(
			path,
			byteOffset(offset),
			maxBytes === undefined ? undefined : byteLimit(maxBytes),
			{
				start: stored.start,
				maxBytes: stored.end === Number.POSITIVE_INFINITY ? undefined : stored.end - stored.start,
			},
		);
		if (!read) throw enoent(path);
		if (!read.title) return { text: utf8Decoder.decode(read.bytes), size: read.size };
		const size = Math.max(read.size, SESSION_TITLE_SLOT_BYTES);
		const { start, end } = byteWindow(offset, maxBytes, size, "from-start");
		return { text: utf8Decoder.decode(titledWindow(read.bytes, stored.start, start, end, read.title)), size };
	}

	/** {@link readChunks}, also on a backend without its own: then one whole read, cut at `fromByte`. */
	async *#readChunks(path: string, fromByte: number): AsyncGenerator<Uint8Array> {
		if (!this.#index.has(path)) throw enoent(path);
		await this.#awaitPath(path);
		const start = Math.max(0, fromByte);
		yield* titledChunks(this.#backendRead(path, start), start);
	}

	/** The backend's chunked read from `fromByte`, or its whole read as one: the start record, then the stored bytes. */
	async *#backendRead(path: string, fromByte: number): AsyncGenerator<SessionStorageChunk> {
		if (this.#backend.readChunks) {
			yield* this.#backend.readChunks(path, fromByte);
			return;
		}
		const read = await this.#backend.readFull(path);
		if (read === null) throw enoent(path);
		yield { title: read.title };
		const bytes = Buffer.from(read.text, "utf-8");
		if (fromByte < bytes.byteLength) yield bytes.subarray(fromByte);
	}

	async scanLines(path: string, visit: (line: string) => boolean): Promise<void> {
		// Each line decodes on its own; only the first, the start of the text, drops a byte order mark.
		const rest = new TextDecoder("utf-8", { ignoreBOM: true });
		let decoder = new TextDecoder();
		const lines = new ConcatSink();
		for await (const chunk of this.#readChunks(path, 0)) {
			for (const line of lines.appendAndFlushLines(chunk)) {
				if (visit(decoder.decode(line))) return;
				decoder = rest;
			}
		}
		// The text after the last newline, "" when the file ends with one, as `split("\n")` yields it.
		visit(decoder.decode(lines.flush()));
	}

	async writeText(path: string, content: string): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs);
		this.#pushFrame(path, { mtimeMs, previous });
		const pending = this.#enqueuePath(path, () => this.#backend.writeFull(path, content, mtimeMs, title), {
			trackDrain: false,
		});
		this.#trackFrame(path, mtimeMs, pending);
		await pending;
	}

	async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		await this.#publishAtomic(path, options, () => this.#bodies.text(path, content));
	}

	/**
	 * Streaming {@link writeTextAtomic}: spools `lines` to a temporary file and
	 * publishes it from there, and after a failed publish compares the stored
	 * bytes with the spool by size and SHA-256. When the spool cannot be used
	 * it streams the lines to the backend instead (see {@link FullBodies.lines}). A
	 * subclass or spy that intercepts {@link writeTextAtomic} still sees every
	 * full rewrite: the lines are then joined and routed through it.
	 */
	async writeLinesAtomic(path: string, lines: Iterable<string>, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.writeTextAtomic !== IndexedSessionStorage.prototype.writeTextAtomic) {
			return this.writeTextAtomic(path, Array.from(lines).join(""), options);
		}
		await this.#publishAtomic(path, options, () => this.#bodies.lines(path, lines));
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
			this.#setIndex(path, body.byteLength, mtimeMs);
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
			// A failed removal restores every index entry, even when the backend
			// already deleted the content (the reply was lost): the session
			// stays present but unconfirmed, and an append extends whatever the
			// backend holds.
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
		this.#setIndex(path, 0, mtimeMs);
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
		this.#setIndex(path, size, mtimeMs, previous);
		return { mtimeMs, previous };
	}

	/**
	 * Queue the publish of `line` on `path`: it joins the path's batch still
	 * gathering lines ({@link #gathering}), or starts one, which goes to the
	 * backend once the path's earlier operations settle. The promise is the
	 * line's own outcome; its index frame and its bytes of the process's
	 * queued appends ({@link appendAdmission}) settle with it.
	 */
	_queueAppend(path: string, line: string, append: IndexAppend, getError?: () => Error | undefined): Promise<void> {
		const { mtimeMs } = append;
		const bytes = byteLength(line);
		this.#pushFrame(path, append);
		const queued: QueuedLine = { line, bytes, frame: append, getError, settled: Promise.withResolvers() };
		const gathering = this.#gathering.get(path);
		if (gathering) gathering.push(queued);
		else this.#queueBatch(path, [queued]);
		appendAdmission.queue(bytes);
		const settled = queued.settled.promise;
		void settled.then(
			() => {
				appendAdmission.settle(bytes);
				this.#dropFrame(path, mtimeMs);
			},
			() => {
				appendAdmission.settle(bytes);
				this.#failFrame(path, mtimeMs);
			},
		);
		return settled;
	}

	/**
	 * Queue an append batch of `lines` on `path`, which gathers lines until it
	 * starts. Each line settles before the batch's operation does, so its
	 * frame has settled when anything awaiting the path resumes: on success as
	 * its write lands; on failure, every line not settled yet, with the
	 * batch's error, also when a failed predecessor skips the batch.
	 */
	#queueBatch(path: string, lines: QueuedLine[]): void {
		const fail = (err: unknown): void => {
			if (this.#gathering.get(path) === lines) this.#gathering.delete(path);
			const error = toError(err);
			for (const queued of lines) queued.settled.reject(error);
		};
		this.#enqueuePath(
			path,
			async () => {
				if (this.#gathering.get(path) === lines) this.#gathering.delete(path);
				try {
					await this.#appendLines(path, lines);
				} catch (err) {
					fail(err);
					throw err;
				}
			},
			{ trackDrain: true, abortOnPredecessorFailure: true, onAbort: fail },
		);
		this.#gathering.set(path, lines);
	}

	/**
	 * Publish a batch's lines, in order: in one backend `appendBatch` when the
	 * backend has one and the lines chain ({@link appendsChain}), each line
	 * settling with it; else, and again after a batch the backend rolled back,
	 * one `append` each, each line settling with its own write and the first
	 * failure failing the rest, as a path's queue fails the operations behind
	 * a failed one. A line appended alone lets go of its text as it lands: its
	 * bytes leave the process's queued appends then, so a later write of the
	 * batch that stalls keeps only the lines they still count. A batch that
	 * fails otherwise fails every line: whether it stored them is unknown, so
	 * none is appended again.
	 */
	async #appendLines(path: string, lines: readonly QueuedLine[]): Promise<void> {
		if (this.#backend.appendBatch && lines.length > 1 && appendsChain(lines)) {
			try {
				await this.#backend.appendBatch(
					path,
					lines.map(queued => queued.line),
					lines[lines.length - 1].frame.mtimeMs,
					lines[0].frame.previous?.size ?? 0,
				);
				for (const queued of lines) queued.settled.resolve();
				return;
			} catch (err) {
				if (!(err instanceof SessionAppendBatchRolledBackError)) throw err;
			}
		}
		for (const queued of lines) {
			const error = queued.getError?.();
			if (error) throw error;
			await this.#backend.append(path, queued.line, queued.frame.mtimeMs, queued.frame.previous?.size ?? 0);
			queued.line = "";
			queued.settled.resolve();
		}
	}

	#restoreIndex(path: string, entry: IndexEntry | undefined): void {
		this.#touch(path);
		if (entry) {
			this.#index.set(path, entry);
		} else {
			this.#index.delete(path);
		}
	}

	/**
	 * Set `path`'s size and time. An append passes the entry it extends,
	 * whose unconfirmed mark it keeps: it does not restore what a failed
	 * removal deleted. A full write or a truncation passes none, and a full
	 * write confirms the path.
	 */
	#setIndex(path: string, size: number, mtimeMs: number, extended?: IndexEntry): void {
		this.#touch(path);
		this.#index.set(path, extended?.unconfirmed ? { size, mtimeMs, unconfirmed: true } : { size, mtimeMs });
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
		// A line queued after this operation must not join a batch ahead of it.
		for (const path of unique) this.#gathering.delete(path);
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
		const { onAbort } = options;
		const operation = Promise.all(previous).then(
			task,
			onAbort &&
				(err => {
					onAbort(err);
					throw err;
				}),
		);
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
		// The caller waits for what is queued now: a line queued after this goes in a batch of its own.
		this.#gathering.delete(path);
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

	/**
	 * Queue `line` at once, in call order, as {@link appendSync} does; resolve
	 * once it is stored and the process's queued appends admit more
	 * ({@link IndexedSessionStorage.waitForAppendAdmission}), so a caller that
	 * awaits each append queues no more while the queue is past 64 MiB. A
	 * line that fails rejects as it settles, without waiting for admission.
	 */
	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const append = this.#storage._appendForWriter(this.#path, line);
		await this.#trackPromise(this.#storage._queueAppend(this.#path, line, append, () => this.#error));
		await this.#storage.waitForAppendAdmission();
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
