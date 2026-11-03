/**
 * `session.sql.offboxCheck`: SQL session storage that keeps some sessions on
 * this machine. A configured command ({@link runOffboxCheck}) says, per
 * session, whether its transcripts may go to the session database; a session
 * it refuses, and everything under it, stays in local files at the paths file
 * storage would use, and nothing of it reaches the database.
 *
 * Two pieces:
 *
 * - {@link OffboxSessionStorage}, the storage the process installs, routes
 *   each call between the database store and a {@link FileSessionStorage}.
 *   A session whose transcript is a local file when this process first
 *   touches it (refused by an earlier process, or older than `sql`) is a
 *   file session: reads and writes go to the file storage, as they would
 *   under `session.storage: file`. Every other session goes to the database
 *   store. Listings and lookups see both: the database rows, plus the local
 *   files of file sessions and of directories no session governs.
 * - {@link OffboxBackend} sits between the database store
 *   ({@link IndexedSessionStorage}) and its SQL backend. The check runs
 *   asynchronously and the storage's synchronous writes cannot wait for it,
 *   so the database store's own write queue holds a session's writes until
 *   the verdict lands: an allowed session's writes then go to the database,
 *   a refused session's to local files. Once its writes settle, the router
 *   hands its index entries and open writers over to file storage without
 *   a database statement; it then has file semantics before and after restart.
 *
 * Which sessions govern a path: its own session (the transcript
 * `<stem>.jsonl`, or a marker beside it: `<stem>.jsonl.tombstone`,
 * `<stem>.continuation`, `<stem>.exported`) and every enclosing session
 * whose artifacts directory holds it (`<parent>/<Agent>.jsonl`,
 * `<parent>/draft.txt`, …). A path is local when any of them is refused, or
 * when the session its header names as `parentSession` is local (a fork, a
 * continuation, a subagent). The check runs once per session per process,
 * with the cwd and id of the session's header: the header the first write
 * carries, a header this process read, or the stored one.
 *
 * Every {@link SessionStorage} method has one routing rule, and a method
 * added to the interface later takes the rule of its kind:
 *
 * - Writes to a path (`writeText*`, `writeLines*`, `updateSessionTitle`,
 *   `openWriter`, `ensureDirSync`): the store its governing sessions are
 *   routed to — a file session's go to files, every other to the database
 *   store, whose gate then sends a refused session's to local files.
 * - Reads of a path (`existsSync`, `existsConfirmedSync`, `statSync`,
 *   `exists`, `readText*`, `hasAssistantTurn`, `keepsOnLocalDisk`,
 *   `unlink`, `deleteSessionWithArtifacts*`): the same store, falling back
 *   to the database for a file session's path only the database holds (a
 *   row written before the session was refused).
 * - Ownership (`claimSession`, `withSessionFileLockSync`): the lease store —
 *   files for a session kept on this machine (a file session, one the check
 *   refused, a new one not yet decided), else the database store. A method
 *   keyed by session id instead of path (a lease probe) goes to the store
 *   that took that session's claim; one over many ids takes the union.
 * - Listing and lookup (`listFilesSync`, `listDirsSync`, `listAllSync`,
 *   `refresh`, `drain`, `confirmWrites`): both stores, or the database store
 *   alone where the file store reads live state (`refresh`) or has nothing
 *   queued (`confirmWrites`).
 * - `rename` and `renameNoReplace`: by the source's store; cross-route
 *   no-replace moves refuse. Replacing moves can bring an existing database
 *   row already under a file session down into that session's local tree.
 *
 * An optional method one store lacks is still implemented here, with the
 * outcome its callers choose when it is absent (a claim that guards nothing,
 * the operation run without a lock); {@link supportsAt} tells a caller, per
 * path, whether the routed store has it.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { hasFsCode, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { moveFileAcrossDevices } from "../utils/atomic-file";
import {
	holdsKey,
	type IndexedSessionStorage,
	type SessionIndexScope,
	type SessionIndexScopeKeys,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
	sessionIndexScopeKeys,
} from "./indexed-session-storage";
import { type OffboxCheck, runOffboxCheck } from "./offbox-check";
import { isAssistantMessageLine } from "./session-entries";
import {
	FileSessionStorage,
	readSessionTextFrom,
	type SessionStorage,
	type SessionStorageCapability,
	type SessionStorageStat,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "./session-storage";
import { overlayTitleSlotContent, type SessionTitleUpdate } from "./session-title-slot";

const TRANSCRIPT_SUFFIX = ".jsonl";
/** Sidecars a session keeps beside its transcript; each follows its session's route. */
const MARKER_SUFFIXES = [".jsonl.tombstone", ".continuation", ".exported"] as const;
/** Bytes read from a stored transcript's head to find its header: the title slot plus a header line fit well inside. */
const HEADER_PREFIX_BYTES = 64 * 1024;

/** The fields of a session header the check and the parent links use. */
export interface SessionHeaderFacts {
	id: string;
	cwd: string | undefined;
	/** The parent's session file (subagents) or session id (forks, continuations). */
	parentSession: string | undefined;
}

/** The session header among the first two lines of `text` (a title slot may come first), or `undefined`. */
export function parseSessionHeaderFacts(text: string): SessionHeaderFacts | undefined {
	let start = 0;
	for (let line = 0; line < 2 && start < text.length; line++) {
		const end = text.indexOf("\n", start);
		const raw = text.slice(start, end < 0 ? Math.min(text.length, start + HEADER_PREFIX_BYTES) : end);
		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			record = undefined;
		}
		if (isRecord(record) && record.type === "session" && typeof record.id === "string") {
			return {
				id: record.id,
				cwd: typeof record.cwd === "string" && record.cwd ? record.cwd : undefined,
				parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
			};
		}
		if (end < 0) break;
		start = end + 1;
	}
	return undefined;
}

function transcriptStem(file: string): string | undefined {
	return file.endsWith(TRANSCRIPT_SUFFIX) ? file.slice(0, -TRANSCRIPT_SUFFIX.length) : undefined;
}

/** The session `file` belongs to by name: its transcript's stem, or the stem of the transcript a marker sits beside. */
function ownStem(file: string): string | undefined {
	const stem = transcriptStem(file);
	if (stem !== undefined) return stem;
	for (const suffix of MARKER_SUFFIXES) {
		if (file.endsWith(suffix)) return file.slice(0, -suffix.length);
	}
	return undefined;
}

function transcriptOf(stem: string): string {
	return `${stem}${TRANSCRIPT_SUFFIX}`;
}

function statIfPresent(file: string): fs.Stats | undefined {
	try {
		return fs.statSync(file);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** Rename a local file; across devices, copy it; a directory move that already carried it is done. */
async function moveLocalFile(src: string, dst: string, noReplace = false): Promise<void> {
	if (src === dst) return;
	try {
		if (!noReplace) return await fsp.rename(src, dst);
		await fsp.link(src, dst);
		try {
			fs.unlinkSync(src);
		} catch (err) {
			fs.unlinkSync(dst);
			throw err;
		}
	} catch (err) {
		if (hasFsCode(err, "EXDEV")) return moveFileAcrossDevices(src, dst);
		// A directory move may already have carried this file, but a taken
		// no-replace destination is never evidence that this move succeeded.
		if (!noReplace && isEnoent(err) && fs.existsSync(dst)) return;
		throw toError(err);
	}
}

/**
 * A rename across the off-box routes: one path is kept on this machine and
 * the other would be in the session database. Never moves a local session
 * into the database.
 */
export class SessionOffboxMoveError extends Error {
	readonly from: string;
	readonly to: string;

	constructor(from: string, to: string) {
		super(
			`Cannot move ${from} to ${to}: session.sql.offboxCheck keeps one of them on this machine and the other in the session database. Nothing was moved.`,
		);
		this.name = "SessionOffboxMoveError";
		this.from = from;
		this.to = to;
	}
}

type GateRoute = "database" | "local";

/** What the gate asks the routing storage about a path. */
interface OffboxRoutes {
	/** Sessions governing `file`, outermost first. */
	stemsOf(file: string): string[];
	/** Whether `stem` is a file session (a local transcript the routing storage serves from files). */
	keptInFiles(stem: string): boolean;
	/** Whether `stem` names a session either store knows. */
	isSession(stem: string): boolean;
	/** Whether the database store has confirmed `file` (it was in the database before the queued writes). */
	databaseConfirms(file: string): boolean;
}

/**
 * The SQL backend behind the off-box check: holds each session's writes
 * until its verdict, then sends them to the database (allowed) or to local
 * files at the same paths (refused). A refused session already in the
 * database (written before the check refused it) is copied down from its
 * stored row on its first local write; its rows stay, and are removed only
 * when the session is deleted or moved.
 */
class OffboxBackend implements SessionStorageBackend {
	readonly #inner: SessionStorageBackend;
	readonly #check: OffboxCheck;
	readonly #files: FileSessionStorage;
	#routes: OffboxRoutes | undefined;
	/** Per session stem: may it go to the database. Settled once per process. */
	readonly #verdicts = new Map<string, Promise<boolean>>();
	/** The verdicts that have settled, for synchronous callers (claims and locks). */
	readonly #settled = new Map<string, boolean>();
	/** Headers of sessions not yet decided, as writes and reads showed them. */
	readonly #headers = new Map<string, SessionHeaderFacts>();
	/** Session id → stem, for `parentSession` links that name an id. */
	readonly #stemsById = new Map<string, string>();
	/** Paths this backend keeps in local files. */
	readonly #local = new Set<string>();
	/** The subset of {@link #local} the database holds no row for. */
	readonly #localOnly = new Set<string>();

	constructor(inner: SessionStorageBackend, check: OffboxCheck, files: FileSessionStorage) {
		this.#inner = inner;
		this.#check = check;
		this.#files = files;
	}

	attach(routes: OffboxRoutes): void {
		this.#routes = routes;
	}

	/** Whether `stem` has a verdict, settled or in flight. */
	decided(stem: string): boolean {
		return this.#verdicts.has(stem);
	}

	/** `stem`'s verdict once it has settled; `undefined` while it is undecided or in flight. */
	settledVerdict(stem: string): boolean | undefined {
		return this.#settled.get(stem);
	}

	/** Remember the header a write or read showed for `stem`: its check's input, and the target of id links. */
	noteHeader(stem: string, header: SessionHeaderFacts): void {
		this.#stemsById.set(header.id, stem);
		if (!this.#verdicts.has(stem)) this.#headers.set(stem, header);
	}

	normalizePath(file: string): string {
		return this.#inner.normalizePath?.(file) ?? file;
	}

	init(): Promise<void> {
		return this.#inner.init();
	}

	/**
	 * Stop serving `keys`' paths from local files: the routing storage serves
	 * them through file storage now. Returns those the database also holds a
	 * row for (copied down after a refusal), which go when the session goes.
	 */
	releaseLocal(keys: SessionIndexScopeKeys): string[] {
		const backed: string[] = [];
		for (const file of this.#local) {
			if (!holdsKey(keys, file)) continue;
			if (!this.#localOnly.has(file)) backed.push(file);
			this.#local.delete(file);
			this.#localOnly.delete(file);
		}
		return backed;
	}

	async loadIndex(scope: SessionIndexScope): Promise<Iterable<SessionStorageIndexEntry>> {
		const rows = await this.#inner.loadIndex(scope);
		if (this.#local.size === 0) return rows;
		// The database store indexes what it holds in `scope`: its local files there too, at their
		// size on disk. They carry their own title slot, so their entries carry no title to overlay.
		const keys = sessionIndexScopeKeys(scope);
		const entries = new Map<string, SessionStorageIndexEntry>();
		for (const row of rows) entries.set(this.normalizePath(row.path), row);
		for (const file of this.#local) {
			if (!holdsKey(keys, file)) continue;
			const stat = statIfPresent(file);
			if (stat) entries.set(file, { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
		}
		return entries.values();
	}

	async readFull(file: string): Promise<string | null> {
		if (!this.#local.has(file)) return this.#inner.readFull(file);
		try {
			return await fsp.readFile(file, "utf-8");
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async readSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		if (!this.#local.has(file)) return this.#inner.readSlices(file, prefixBytes, suffixBytes);
		try {
			return await this.#files.readTextSlices(file, prefixBytes, suffixBytes);
		} catch (err) {
			if (isEnoent(err)) return ["", ""];
			throw err;
		}
	}

	async readFrom(file: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null> {
		if (this.#local.has(file)) {
			try {
				return await this.#files.readTextFrom(file, offset, maxBytes);
			} catch (err) {
				if (isEnoent(err)) return null;
				throw err;
			}
		}
		if (this.#inner.readFrom) return this.#inner.readFrom(file, offset, maxBytes);
		const content = await this.#inner.readFull(file);
		if (content === null) return null;
		const bytes = Buffer.from(content, "utf-8");
		if (offset >= bytes.length) return { text: "", size: bytes.length };
		const end = maxBytes === undefined ? undefined : offset + Math.max(0, maxBytes);
		return { text: bytes.subarray(offset, end).toString("utf-8"), size: bytes.length };
	}

	async writeFull(
		file: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		if ((await this.#routeFor(file, true, content)) === "database") {
			await this.#inner.writeFull(file, content, mtimeMs, title, expectedSize);
			return;
		}
		// A size-checked replace compares against the content the database held: bring it down first.
		if (typeof expectedSize === "number") await this.#adopt(file);
		else this.#claimLocal(file);
		this.#writeLocal(file, content, expectedSize);
	}

	async append(file: string, line: string, mtimeMs: number): Promise<void> {
		if ((await this.#routeFor(file, true, line)) === "database") {
			await this.#inner.append(file, line, mtimeMs);
			return;
		}
		await this.#adopt(file);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		await fsp.appendFile(file, line);
	}

	async updateSessionTitle(file: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		if ((await this.#routeFor(file, true)) === "database") {
			await this.#inner.updateSessionTitle(file, title, mtimeMs);
			return;
		}
		await this.#adopt(file);
		await this.#files.updateSessionTitle(file, title);
	}

	async truncate(file: string, mtimeMs: number): Promise<void> {
		if ((await this.#routeFor(file, true)) === "database") {
			await this.#inner.truncate(file, mtimeMs);
			return;
		}
		this.#claimLocal(file);
		this.#writeLocal(file, "");
	}

	async remove(files: string[], dir?: string): Promise<void> {
		const database: string[] = [];
		const local: string[] = [];
		for (const file of files) {
			const route = await this.#routeFor(file, false);
			if (route === "local") local.push(file);
			// A refused session's row the database already held goes with it; a path that only
			// ever existed here is never named to the database.
			if (route === "database" || !this.#localOnly.has(file)) database.push(file);
		}
		const databaseDir =
			dir && (await this.#routeFor(path.join(dir, ".scope"), false)) === "database" ? dir : undefined;
		if (database.length > 0 || databaseDir) await this.#inner.remove(database, databaseDir);
		for (const file of local) {
			await fsp.rm(file, { force: true });
			this.#local.delete(file);
			this.#localOnly.delete(file);
		}
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		const from = await this.#routeFor(src, true);
		if (src === dst) {
			if (from === "database") await this.#inner.move(src, dst, mtimeMs, noReplace);
			return;
		}
		// A moved session keeps its verdict at its new path.
		const dstStem = transcriptStem(dst);
		if (dstStem !== undefined && !this.#verdicts.has(dstStem)) this.#settle(dstStem, from === "database");
		const to = await this.#routeFor(dst, true);
		if (from !== to) throw new SessionOffboxMoveError(src, dst);
		if (from === "database") {
			await this.#inner.move(src, dst, mtimeMs, noReplace);
			return;
		}
		// Not local yet: a row the database held for a refused session, copied down before it moves.
		await this.#adopt(src, true);
		const backedByDatabase = !this.#localOnly.has(src);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		await moveLocalFile(src, dst, noReplace);
		this.#local.delete(src);
		this.#localOnly.delete(src);
		this.#local.add(dst);
		this.#localOnly.add(dst);
		if (backedByDatabase) await this.#inner.remove([src]);
	}

	#lookup(): OffboxRoutes {
		if (!this.#routes) throw new Error("OffboxBackend used before OffboxSessionStorage attached to it");
		return this.#routes;
	}

	#settle(stem: string, allowed: boolean): void {
		this.#verdicts.set(stem, Promise.resolve(allowed));
		this.#settled.set(stem, allowed);
		this.#headers.delete(stem);
	}

	/**
	 * Where `file`'s data goes. `local` when a session governing it is refused
	 * (the sessions inside a refused one are refused without a check of their
	 * own), `database` when every one is allowed; a path no session governs
	 * stays local. With `decide` false (a removal) no check runs, and a path
	 * whose sessions are undecided is a database path.
	 */
	async #routeFor(file: string, decide: boolean, content?: string): Promise<GateRoute> {
		if (this.#local.has(file)) return "local";
		const own = transcriptStem(file);
		if (own !== undefined && content !== undefined && !this.#verdicts.has(own)) {
			const header = parseSessionHeaderFacts(content);
			if (header) this.noteHeader(own, header);
		}
		const stems = this.#lookup().stemsOf(file);
		if (stems.length === 0) return decide ? "local" : "database";
		for (const [index, stem] of stems.entries()) {
			const pending = this.#verdicts.get(stem);
			const allowed = decide ? await this.#decide(stem, new Set()) : pending ? await pending : undefined;
			if (allowed !== false) continue;
			for (const inner of stems.slice(index + 1)) {
				if (!this.#verdicts.has(inner)) this.#settle(inner, false);
			}
			return "local";
		}
		return "database";
	}

	#decide(stem: string, visiting: ReadonlySet<string>): Promise<boolean> {
		const known = this.#verdicts.get(stem);
		if (known) return known;
		const verdict = this.#evaluate(stem, new Set([...visiting, stem]));
		this.#verdicts.set(stem, verdict);
		void verdict.then(allowed => {
			this.#settled.set(stem, allowed);
			this.#headers.delete(stem);
		});
		return verdict;
	}

	/** Whether `stem` may go to the database. Never rejects: a failure to decide refuses. */
	async #evaluate(stem: string, visiting: ReadonlySet<string>): Promise<boolean> {
		const sessionFile = transcriptOf(stem);
		try {
			const routes = this.#lookup();
			if (routes.keptInFiles(stem)) return false;
			const header = this.#headers.get(stem) ?? (await this.#storedHeader(sessionFile));
			if (!header) return this.#refused(sessionFile, undefined, "no session header was found to check");
			this.#stemsById.set(header.id, stem);
			const parent = this.#parentStem(header.parentSession);
			if (parent !== undefined && parent !== stem && !visiting.has(parent)) {
				const parentKnown = this.#verdicts.has(parent) || routes.isSession(parent);
				if (routes.keptInFiles(parent) || (parentKnown && !(await this.#decide(parent, visiting)))) {
					logger.debug("Session kept off the session database with its parent session", {
						sessionId: header.id,
						sessionFile,
						parentSession: header.parentSession,
					});
					return false;
				}
			}
			if (!header.cwd) return this.#refused(sessionFile, header, "its header records no working directory");
			const verdict = await runOffboxCheck(this.#check, { cwd: header.cwd, sessionId: header.id, sessionFile });
			return verdict.allowed || this.#refused(sessionFile, header, verdict.reason);
		} catch (err) {
			return this.#refused(sessionFile, undefined, `the check could not be evaluated: ${toError(err).message}`);
		}
	}

	#refused(sessionFile: string, header: SessionHeaderFacts | undefined, reason: string | undefined): false {
		logger.warn("session.sql.offboxCheck keeps a session off the session database", {
			sessionId: header?.id,
			sessionFile,
			cwd: header?.cwd,
			reason,
		});
		return false;
	}

	#parentStem(parentSession: string | undefined): string | undefined {
		if (!parentSession) return undefined;
		if (path.isAbsolute(parentSession)) return transcriptStem(path.resolve(parentSession));
		return this.#stemsById.get(parentSession);
	}

	/** The header of a transcript the database holds; `undefined` when it holds none. */
	async #storedHeader(sessionFile: string): Promise<SessionHeaderFacts | undefined> {
		if (!this.#lookup().databaseConfirms(sessionFile)) return undefined;
		const [prefix] = await this.#inner.readSlices(sessionFile, HEADER_PREFIX_BYTES, 0);
		return parseSessionHeaderFacts(prefix);
	}

	/** Keep `file` local from now on, copying down the row the database holds for it. */
	async #adopt(file: string, knownInDatabase = false): Promise<void> {
		if (this.#local.has(file)) return;
		if (knownInDatabase || this.#lookup().databaseConfirms(file)) {
			const stored = await this.#inner.readFull(file);
			if (stored !== null) {
				const title = await this.#storedTitle(file);
				this.#local.add(file);
				this.#writeLocal(file, title ? overlayTitleSlotContent(stored, title) : stored);
				return;
			}
		}
		this.#local.add(file);
		this.#localOnly.add(file);
	}

	/** Keep `file` local from now on without its stored content (the write replaces it). */
	#claimLocal(file: string): void {
		if (this.#local.has(file)) return;
		this.#local.add(file);
		if (!this.#lookup().databaseConfirms(file)) this.#localOnly.add(file);
	}

	/**
	 * The title the database stores for `file` in its title columns, which a
	 * title update changes without rewriting the stored content's slot.
	 */
	async #storedTitle(file: string): Promise<SessionTitleUpdate | undefined> {
		for (const row of await this.#inner.loadIndex({ kind: "session", file })) {
			if (!row.titleUpdatedAt || this.normalizePath(row.path) !== file) continue;
			return { title: row.title, source: row.titleSource, updatedAt: row.titleUpdatedAt };
		}
		return undefined;
	}

	#writeLocal(file: string, content: string, expectedSize?: number | null): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.#files.writeTextSync(file, content, expectedSize === undefined ? undefined : { expectedSize });
	}
}

/**
 * A database-store writer that moves to file storage when its session is
 * handed over to files (a session the check refused, once nothing of it is
 * queued): the writer it leaves then has nothing in flight, and its later
 * appends go to the file in-body, as under file storage.
 */
class OffboxWriter implements SessionStorageWriter {
	#inner: SessionStorageWriter;
	#onFiles = false;
	/** The file storage's writer once the session is a file session; `undefined` before. */
	readonly #fileWriter: () => SessionStorageWriter | undefined;

	constructor(inner: SessionStorageWriter, fileWriter: () => SessionStorageWriter | undefined) {
		this.#inner = inner;
		this.#fileWriter = fileWriter;
	}

	#current(): SessionStorageWriter {
		if (this.#onFiles || !this.#inner.isOpen()) return this.#inner;
		const files = this.#fileWriter();
		if (!files) return this.#inner;
		void this.#inner.close().catch(() => {});
		this.#inner = files;
		this.#onFiles = true;
		return files;
	}

	appendSync(line: string): void {
		const writer = this.#current();
		if (!writer.appendSync) throw new Error("The session writer cannot append synchronously");
		writer.appendSync(line);
	}

	append(line: string): Promise<void> {
		return this.#current().append(line);
	}

	flush(): Promise<void> {
		return this.#inner.flush();
	}

	flushSync(): void {
		this.#inner.flushSync?.();
	}

	isOpen(): boolean {
		return this.#inner.isOpen();
	}

	close(): Promise<void> {
		return this.#inner.close();
	}

	getError(): Error | undefined {
		return this.#inner.getError();
	}
}

export interface OffboxSessionStorageOptions {
	check: OffboxCheck;
	/**
	 * Open the session database store with `wrapBackend` around its backend
	 * (`SqlSessionStorageOptions.wrapBackend`), so every read and write it
	 * makes passes the off-box gate.
	 */
	openDatabase(wrapBackend: (backend: SessionStorageBackend) => SessionStorageBackend): Promise<IndexedSessionStorage>;
	/** Storage for file sessions. Default: a new {@link FileSessionStorage}. */
	files?: FileSessionStorage;
}

/** Which store serves a session in this process: `file` for a file session, `database` for the rest. */
type StoreRoute = "file" | "database";

/** The storage `session.storage: sql` installs when `session.sql.offboxCheck` is set; see the module doc. */
export class OffboxSessionStorage implements SessionStorage {
	/** The database store queues its publishes; file sessions publish in-body and confirm at once. */
	readonly defersSyncPublish = true;
	readonly #database: IndexedSessionStorage;
	readonly #files: FileSessionStorage;
	readonly #gate: OffboxBackend;
	/** Per session stem, the store that serves it; decided at the first touch that finds out. */
	readonly #routes = new Map<string, StoreRoute>();
	/** Rows the database held for sessions refused and handed over to files here: they go with the session. */
	readonly #staleRows = new Set<string>();

	private constructor(database: IndexedSessionStorage, files: FileSessionStorage, gate: OffboxBackend) {
		this.#database = database;
		this.#files = files;
		this.#gate = gate;
		gate.attach({
			stemsOf: file => this.#stemsOf(path.resolve(file)),
			keptInFiles: stem => this.#keptInFiles(stem),
			isSession: stem => this.#isSession(stem),
			databaseConfirms: file => this.#database.existsConfirmedSync?.(file) ?? this.#database.existsSync(file),
		});
	}

	static async create(options: OffboxSessionStorageOptions): Promise<OffboxSessionStorage> {
		const files = options.files ?? new FileSessionStorage();
		const opened: { gate?: OffboxBackend } = {};
		const database = await options.openDatabase(backend => {
			opened.gate = new OffboxBackend(backend, options.check, files);
			return opened.gate;
		});
		if (!opened.gate) {
			throw new Error("OffboxSessionStorage: openDatabase did not pass the database backend through wrapBackend");
		}
		return new OffboxSessionStorage(database, files, opened.gate);
	}

	confirmWrites(file: string): Promise<void> {
		// A file session never queues: the database store has nothing pending for its paths.
		return this.#database.confirmWrites?.(file) ?? Promise.resolve();
	}

	ensureDirSync(dir: string): void {
		// The database store derives directories from keys (its ensureDirSync does
		// nothing), and the gate creates a refused session's directories as it writes.
		const stems = this.#stemsFrom(undefined, path.resolve(dir));
		if (this.#routedToFiles(stems)) this.#files.ensureDirSync(dir);
		else this.#database.ensureDirSync(dir);
	}

	existsSync(file: string): boolean {
		return this.#readStore(file).existsSync(file);
	}

	existsConfirmedSync(file: string): boolean {
		const store = this.#readStore(file);
		if (store === this.#files) return this.#files.existsSync(file);
		return this.#database.existsConfirmedSync?.(file) ?? false;
	}

	/** Whether `file` is a plain local file this storage serves through file storage. */
	keepsOnLocalDisk(file: string): boolean {
		return this.#readStore(file) === this.#files;
	}

	/** File sessions publish in-body, as under file storage; the database store queues. */
	defersSyncPublishAt(file: string): boolean {
		return this.#readStore(file) !== this.#files;
	}

	writeTextSync(file: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#noteHeader(file, content);
		this.#writeStore(file).writeTextSync(file, content, options);
	}

	writeLinesSync(file: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.#noteHeader(file, lines.slice(0, 2).join(""));
		const store = this.#writeStore(file);
		if (store.writeLinesSync) store.writeLinesSync(file, lines, options);
		else store.writeTextSync(file, lines.join(""), options);
	}

	updateSessionTitle(file: string, update: SessionTitleUpdate): Promise<void> {
		return this.#writeStore(file).updateSessionTitle(file, update);
	}

	statSync(file: string): SessionStorageStat {
		return this.#readStore(file).statSync(file);
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const listed = this.#database.listFilesSync(dir, pattern);
		const seen = new Set(listed.map(file => path.resolve(file)));
		const sessions = new Map<string, boolean>();
		for (const file of this.#files.listFilesSync(dir, pattern)) {
			const resolved = path.resolve(file);
			if (seen.has(resolved) || !this.#listsLocally(this.#stemsOf(resolved, sessions))) continue;
			seen.add(resolved);
			listed.push(file);
		}
		return listed;
	}

	listDirsSync(dir: string): string[] {
		const names = new Set(this.#database.listDirsSync(dir));
		const resolved = path.resolve(dir);
		const sessions = new Map<string, boolean>();
		for (const name of this.#files.listDirsSync(dir)) {
			if (names.has(name)) continue;
			if (this.#listsLocally(this.#stemsFrom(undefined, path.join(resolved, name), sessions))) names.add(name);
		}
		return [...names];
	}

	refresh(scope?: SessionIndexScope): Promise<void> {
		return this.#database.refresh(scope);
	}

	listAllSync(): string[] {
		const listed = new Set(this.#database.listAllSync());
		const visited = new Set<string>();
		for (const [stem] of this.#routes) {
			if (!this.#routedToFiles([stem])) continue;
			const keys = sessionIndexScopeKeys({ kind: "session", file: transcriptOf(stem) });
			for (const file of keys.exact) if (this.#files.existsSync(file)) listed.add(file);
			// File storage has no whole-filesystem index: enumerate only the
			// finite session trees this router knows, not arbitrary local roots.
			const directories = [stem];
			for (const dir of directories) {
				if (visited.has(dir)) continue;
				visited.add(dir);
				for (const file of this.#files.listFilesSync(dir, "*")) listed.add(file);
				for (const name of this.#files.listDirsSync(dir)) directories.push(path.join(dir, name));
			}
		}
		return [...listed];
	}

	exists(file: string): Promise<boolean> {
		return this.#readStore(file).exists(file);
	}

	async readText(file: string): Promise<string> {
		const text = await this.#readStore(file).readText(file);
		this.#noteHeader(file, text);
		return text;
	}

	readTextSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return this.#readStore(file).readTextSlices(file, prefixBytes, suffixBytes);
	}

	readTextFrom(file: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number }> {
		return readSessionTextFrom(this.#readStore(file), file, offset, maxBytes);
	}

	async hasAssistantTurn(file: string): Promise<boolean> {
		const store = this.#readStore(file);
		if (store.hasAssistantTurn) return store.hasAssistantTurn(file);
		for (const line of (await store.readText(file)).split("\n")) {
			if (isAssistantMessageLine(line)) return true;
		}
		return false;
	}

	writeText(file: string, content: string): Promise<void> {
		this.#noteHeader(file, content);
		return this.#writeStore(file).writeText(file, content);
	}

	writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.#noteHeader(file, content);
		return this.#writeStore(file).writeTextAtomic(file, content, options);
	}

	writeLinesAtomic(file: string, lines: readonly string[], options?: WriteTextAtomicOptions): Promise<void> {
		this.#noteHeader(file, lines.slice(0, 2).join(""));
		const store = this.#writeStore(file);
		if (store.writeLinesAtomic) return store.writeLinesAtomic(file, lines, options);
		return store.writeTextAtomic(file, lines.join(""), options);
	}

	rename(src: string, dst: string): Promise<void> {
		return this.#rename(src, dst, false);
	}

	renameNoReplace(src: string, dst: string): Promise<void> {
		return this.#rename(src, dst, true);
	}

	async #rename(src: string, dst: string, noReplace: boolean): Promise<void> {
		const target = path.resolve(dst);
		const targetStems = this.#stemsOf(target);
		const targetOwn = transcriptStem(target);
		const intoFiles = this.#routedToFiles(targetStems);
		if (this.#readStore(src) === this.#files) {
			// The SQL index is scoped and lazy: another client may own the
			// destination even though this process has never listed it.
			await this.#database.refresh({ kind: "session", file: target });
			// A file session stays local wherever it moves; it never moves into a database session's tree.
			const enclosing = targetStems.filter(stem => stem !== targetOwn);
			const intoDatabase = enclosing.length > 0 && !intoFiles;
			if (intoDatabase || this.#database.existsSync(target)) throw new SessionOffboxMoveError(src, dst);
			if (targetOwn !== undefined && !this.#routes.has(targetOwn)) this.#routes.set(targetOwn, "file");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			if (noReplace) await moveLocalFile(src, dst, true);
			else await this.#files.rename(src, dst);
			// A row the database held at the old path (written before the session was refused)
			// would list the moved session a second time, at the path it left.
			await this.#dropStaleRow(src, false);
			return;
		}
		if (intoFiles) {
			if (noReplace) throw new SessionOffboxMoveError(src, dst);
			// A row left in the database under a file session's tree (written before the
			// session was refused) moves with the session, down into its local tree.
			if (!this.#routedToFiles(this.#stemsOf(path.resolve(src)))) throw new SessionOffboxMoveError(src, dst);
			if (await this.#files.exists(dst)) throw new SessionOffboxMoveError(src, dst);
			await this.#files.writeText(dst, await this.#database.readText(src));
			await this.#database.unlink(src);
			return;
		}
		for (const stem of targetStems) if (!this.#routes.has(stem)) this.#routes.set(stem, "database");
		if (noReplace) await this.#database.renameNoReplace(src, dst);
		else await this.#database.rename(src, dst);
	}

	unlink(file: string): Promise<void> {
		return this.#readStore(file).unlink(file);
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		const store = this.#readStore(sessionPath);
		await store.deleteSessionWithArtifacts(sessionPath);
		// A file session the database also held a row for (written before it was refused) leaves both.
		if (store === this.#files) await this.#dropStaleRow(sessionPath, true);
	}

	/**
	 * A session kept on this machine takes the file storage's ownership lease,
	 * as under file storage: a file session, one the check refused, and a new
	 * one not yet decided (its transcript may yet stay local). A database
	 * session takes the database store's claim, which this version does not
	 * have; there the claim guards nothing, and {@link supportsAt} says so.
	 */
	claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		const store = this.#leaseStore(sessionPath);
		return store.claimSession ? store.claimSession(sessionId, sessionPath) : () => {};
	}

	/** The cross-process lock of the store {@link claimSession} names; none, and `operation` runs, where it has none. */
	withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		const store = this.#leaseStore(sessionPath);
		return store.withSessionFileLockSync ? store.withSessionFileLockSync(sessionPath, operation) : operation();
	}

	/** The conditional delete of the store serving `sessionPath`; `false` (nothing deleted) where it has none. */
	async deleteSessionWithArtifactsIf(
		sessionPath: string,
		shouldDelete: (content: string) => boolean,
	): Promise<boolean> {
		const store = this.#readStore(sessionPath);
		if (!store.deleteSessionWithArtifactsIf) return false;
		const deleted = await store.deleteSessionWithArtifactsIf(sessionPath, shouldDelete);
		if (deleted && store === this.#files) await this.#dropStaleRow(sessionPath, true);
		return deleted;
	}

	/** The synchronous read of the store serving `file`; the database store has none. */
	readTextSync(file: string): string {
		const store = this.#readStore(file);
		if (!store.readTextSync) {
			throw new Error(`${file} cannot be read synchronously: the session database store reads asynchronously`);
		}
		return store.readTextSync(file);
	}

	/** Whether the store an optional method routes `file` to has that method. */
	supportsAt(file: string, capability: SessionStorageCapability): boolean {
		const leased = capability === "claimSession" || capability === "withSessionFileLockSync";
		const store = leased ? this.#leaseStore(file) : this.#readStore(file);
		return store[capability] !== undefined;
	}

	openWriter(file: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const store = this.#writeStore(file);
		if (store === this.#files) return this.#files.openWriter(file, options);
		return new OffboxWriter(this.#database.openWriter(file, options), () =>
			this.#writeStore(file) === this.#files ? this.#files.openWriter(file, { ...options, flags: "a" }) : undefined,
		);
	}

	async drain(): Promise<void> {
		await this.#database.drain();
		await this.#files.drain();
	}

	/** Sessions governing `file` (resolved), outermost first; see the module doc. */
	#stemsOf(file: string, sessions?: Map<string, boolean>): string[] {
		const own = ownStem(file);
		return this.#stemsFrom(own, path.dirname(own ?? file), sessions);
	}

	/**
	 * `own` (when given) after the sessions enclosing `dir`: `dir` itself when
	 * it is a session's artifacts directory, then each such parent in turn.
	 */
	#stemsFrom(own: string | undefined, dir: string, sessions?: Map<string, boolean>): string[] {
		const stems: string[] = [];
		for (let current = dir; current !== path.dirname(current) && this.#isSession(current, sessions);) {
			stems.push(current);
			current = path.dirname(current);
		}
		stems.reverse();
		if (own !== undefined) stems.push(own);
		return stems;
	}

	#isSession(stem: string, sessions?: Map<string, boolean>): boolean {
		const known = sessions?.get(stem);
		if (known !== undefined) return known;
		const transcript = transcriptOf(stem);
		const result =
			this.#routes.has(stem) ||
			this.#gate.decided(stem) ||
			this.#database.existsSync(transcript) ||
			fs.existsSync(transcript);
		sessions?.set(stem, result);
		return result;
	}

	/**
	 * Whether `stems` include a file session: one routed to files, one the
	 * check refused here once it is handed over, or one with a local
	 * transcript found for an unrouted stem.
	 */
	#routedToFiles(stems: readonly string[]): boolean {
		for (const stem of stems) {
			const route = this.#routes.get(stem);
			if (route === "file") return true;
			if (route === "database" && this.#gate.settledVerdict(stem) === false && this.#handOverToFiles(stem)) {
				return true;
			}
		}
		for (const stem of stems) {
			if (this.#routes.has(stem) || !fs.existsSync(transcriptOf(stem))) continue;
			this.#routes.set(stem, "file");
			return true;
		}
		return false;
	}

	/**
	 * Make a session the check refused in this process a file session once
	 * nothing of it is queued in the database store, as it is after a
	 * restart: from then on it has file storage's semantics (in-body writes,
	 * write-conflict recovery, the file lease). Its entries leave the database
	 * store's index and the gate without a statement; a refresh lists again any
	 * row the database held there before the refusal.
	 */
	#handOverToFiles(stem: string): boolean {
		const keys = sessionIndexScopeKeys({ kind: "session", file: transcriptOf(stem) });
		if (this.#database.hasPendingWrites(keys)) return false;
		this.#routes.set(stem, "file");
		this.#database.releaseIndexEntries(keys);
		for (const file of this.#gate.releaseLocal(keys)) this.#staleRows.add(file);
		return true;
	}

	/**
	 * Remove what the database still holds at a file session's `file` (rows
	 * written before the session was refused): the row alone, or with
	 * `whole` the session's rows under its artifacts directory too. Only a
	 * row the database holds is named to it.
	 */
	async #dropStaleRow(file: string, whole: boolean): Promise<void> {
		const resolved = path.resolve(file);
		const handedOver = this.#staleRows.delete(resolved);
		if (!handedOver && !this.#database.existsSync(resolved)) return;
		try {
			if (whole) await this.#database.deleteSessionWithArtifacts(resolved);
			else await this.#database.unlink(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#keptInFiles(stem: string): boolean {
		const route = this.#routes.get(stem);
		return route === "file" || (route === undefined && fs.existsSync(transcriptOf(stem)));
	}

	/**
	 * Whether a local entry governed by `stems` belongs in a listing: a file
	 * session's, or one no session governs. A database session's directory
	 * holds only tool artifacts (and, for a session refused in this process,
	 * local files the database store already lists).
	 */
	#listsLocally(stems: readonly string[]): boolean {
		return stems.length === 0 || this.#routedToFiles(stems);
	}

	#writeStore(file: string): SessionStorage {
		const stems = this.#stemsOf(path.resolve(file));
		if (this.#routedToFiles(stems)) return this.#files;
		for (const stem of stems) if (!this.#routes.has(stem)) this.#routes.set(stem, "database");
		return this.#database;
	}

	#readStore(file: string): SessionStorage {
		if (!this.#routedToFiles(this.#stemsOf(path.resolve(file)))) return this.#database;
		// A file session's path the database alone holds (written before the session was refused) still reads.
		return this.#files.existsSync(file) || !this.#database.existsSync(file) ? this.#files : this.#database;
	}

	/** Where the session at `file` takes its ownership lease and lock; see {@link claimSession}. */
	#leaseStore(file: string): SessionStorage {
		const resolved = path.resolve(file);
		const stems = this.#stemsOf(resolved);
		if (this.#routedToFiles(stems)) return this.#files;
		const verdicts = stems.map(stem => this.#gate.settledVerdict(stem));
		if (verdicts.includes(false)) return this.#files;
		if (verdicts.every(verdict => verdict === true)) return this.#database;
		// Undecided: a session the database already holds keeps its claims there.
		return this.#database.existsConfirmedSync?.(resolved) ? this.#database : this.#files;
	}

	/** Hand the session header `text` starts with to the gate: the input of its check and of parent links. */
	#noteHeader(file: string, text: string): void {
		const stem = transcriptStem(path.resolve(file));
		if (stem === undefined || this.#gate.decided(stem)) return;
		const header = parseSessionHeaderFacts(text);
		if (header) this.#gate.noteHeader(stem, header);
	}
}
