import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toError } from "@oh-my-pi/pi-utils";
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
	 * is one {@link normalizeByteLimit} gave: a whole number, 0 for no window.
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
	 * Append `line`. `expectedSize` is the size this store's index held for
	 * `path` before the append, which a backend that guards appends (SQL
	 * storage that claims sessions) checks the shared backend's size against,
	 * rejecting with `SessionWriteConflictError` when another writer changed
	 * the file since; others ignore it.
	 */
	append(path: string, line: string, mtimeMs: number, expectedSize?: number): Promise<void>;
	/**
	 * Set the session's title metadata and time; its stored bytes and size stay as they are. Rejects with
	 * `ENOENT`, writing nothing, when the store holds no session at `path`.
	 */
	updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void>;
	truncate(path: string, mtimeMs: number): Promise<void>;
	/**
	 * Remove each of `paths` with its time and title metadata, and with `dir`
	 * (a key prefix ending in `/`) every key under it that the shared store
	 * holds when the removal runs, including ones another client committed
	 * after this store last refreshed.
	 */
	remove(paths: string[], dir?: string): Promise<void>;
	/**
	 * Move `src`'s bytes, time and title metadata to `dst`, replacing what
	 * `dst` held. With `noReplace` a `dst` the shared store holds, including
	 * one another client commits while the move runs, makes it reject with
	 * `EEXIST` naming `dst` and change neither path.
	 */
	move(src: string, dst: string, mtimeMs: number, noReplace?: boolean): Promise<void>;
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
	 * removed the path before the removal reported its failure (a reply lost
	 * after the store ran it), so only a later full write confirms it again.
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
		// A removal in flight can remove the content before its op settles (the store runs it before its reply
		// arrives), so the path is unconfirmed until the removal settles.
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
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs);
		this.#pushFrame(path, { mtimeMs, previous });
		const write = this.#enqueuePath(
			path,
			() => this.#backend.writeFull(path, content, mtimeMs, title, options?.expectedSize),
			{ trackDrain: true },
		);
		this.#trackFrame(path, mtimeMs, write);
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
		const prefixLimit = normalizeByteLimit(prefixBytes);
		const suffixLimit = normalizeByteLimit(suffixBytes);
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

	async scanLines(path: string, visit: (line: string) => boolean): Promise<void> {
		for (const line of (await this.readText(path)).split("\n")) {
			if (visit(line)) return;
		}
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
		const commitGuard = options?.commitGuard;
		if (commitGuard && !commitGuard()) return;
		await this.#awaitPath(path);
		// A concurrent flushSync (writeTextSync) may have taken over during the
		// awaitPath yield and bumped the epoch. Re-check before touching the
		// index or enqueueing the backend publish.
		if (commitGuard && !commitGuard()) return;
		this.#assertExpectedSize(path, options?.expectedSize);
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs);
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
					await this.#backend.writeFull(path, content, mtimeMs, title, options?.expectedSize);
				},
				{ trackDrain: false },
			);
			this.#dropFrame(path, mtimeMs);
		} catch (err) {
			const error = toError(err);
			try {
				// The stored text as it is: the title metadata the read returns beside it is not the body's.
				if ((await this.#backend.readFull(path))?.text === content) {
					this.#dropFrame(path, mtimeMs);
					return;
				}
			} catch {
				// Preserve the original write failure; verification was unavailable.
			}
			this.#failFrame(path, mtimeMs);
			throw error;
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
			await fs.rm(artifactsDir, { recursive: true, force: true });
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
