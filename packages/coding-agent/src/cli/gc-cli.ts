import { Database } from "bun:sqlite";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { isCompressScratchPath } from "@oh-my-pi/omp-stats/parser";
import {
	formatBytes,
	getAgentDir,
	getBlobsDir,
	getConfigRootDir,
	getCustomSessionFilesDir,
	getHistoryDbPath,
	getModelDbPath,
	getReportsDir,
	getSessionsDir,
	getTerminalSessionsDir,
	hashPath,
	isPidAlive,
	normalizePathForComparison,
	readLines,
	type FileLockHandle,
} from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { Setting } from "../config/registry";

import { BLOB_HASH_RE, BLOB_STAGING_RE, blobStagingPath } from "../session/blob-store";
import { listSessionsReadOnly, type SessionInfo, type SessionStatus } from "../session/session-listing";
import { parseTerminalBreadcrumb } from "../session/session-paths";
import {
	findArchivedSessionFiles,
	getArchivedSessionsDir,
	inflateArchivedBytes,
	inflateArchivedTranscript,
	isArchivedSessionPath,
	listArchivedSessionFiles,
	liveSessionPathForArchive,
	restoreArchivedSessionLocked,
} from "../session/session-archive";
import { codeOf, statIfPresent, withGcLock } from "../session/gc-lock";
import { readSessionHeaderId } from "../session/session-loader";
import {
	FileSessionStorage,
	SESSION_STAGING_RE,
	type SessionStorage,
	tryAcquireSessionLease,
} from "../session/session-storage";
import { resolveSessionStorage } from "../session/session-storage-config";
import {
	type CompressCandidate,
	type CompressMethod,
	compressCandidate,
	compressFilesInPlace,
	compressionWorks,
	compressMethod,
	sweepCompressScratch,
} from "./gc-compress";
import {
	cfgGcArchive,
	GC_BLOBS_WARNING,
	cfgGcBlobs,
	cfgGcColdArchiveAfterDays,
	cfgGcCompress,
	cfgGcCompressAfterDays,
	cfgGcRetainNewestGlobal,
	cfgGcRetainNewestPerCwd,
	cfgGcStale,
	cfgGcStaleRetainDays,
	cfgGcStaleRetainNewest,
	cfgGcStrip,
	cfgGcStripAfterDays,
	cfgGcWal,
} from "./gc-settings";
import { applyStrip, planStrip, type StripPlan } from "./gc-strip";
import { createProgressTracker, type ProgressOutput, type ProgressTracker } from "./progress-reporter";

const BLOB_FILE_RE = /^([a-f0-9]{64})(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/gi;
const JSONL_GLOB = new Bun.Glob("**/*.jsonl");
/** Top-level transcripts: `<sessionsRoot>/<cwd>/<id>.jsonl`. */
const TRANSCRIPT_GLOB = new Bun.Glob("*/*.jsonl");
const JSONL_GZ_GLOB = new Bun.Glob("**/*.jsonl.gz");
const JSONL_BACKUP_GLOB = new Bun.Glob("**/*.jsonl.*.bak");
const SESSION_STAGING_GLOB = new Bun.Glob("**/.*.tmp");
const ANY_FILE_GLOB = new Bun.Glob("**/*");
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["pending", "interrupted", "unknown"]);
const DAY_MS = 86_400_000;
const GC_WRITE_GRACE_MS = 5 * 60_000;
const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";
/** Bytes sampled to rule out a session header before streaming an artifact. */
const HEADER_SNIFF_BYTES = 4096;
/**
 * Minimum age before a dangling session pointer is pruned. A lazy session's
 * marker and fresh breadcrumb name a transcript that is not on disk until its
 * first turn, so an idle-but-open session must keep them well past the
 * write grace.
 */
const STALE_POINTER_GRACE_MS = DAY_MS;
/**
 * The session files on disk. The archive and compress phases run only while
 * the configured storage keeps sessions there, and collab replicas are always
 * files (a guest refuses to join under `session.storage: sql`), so those
 * phases read them through this, never through the process default.
 */
const LOCAL_SESSION_FILES = new FileSessionStorage();
/** Sessions (and archived transcripts) stripped at once, so one's reads overlap another's writes. */
const STRIP_CONCURRENCY = 8;

export interface GcCommandFlags {
	apply?: boolean;
	json?: boolean;
	agentDir?: string;
	blobs?: boolean;
	archive?: boolean;
	wal?: boolean;
	stale?: boolean;
	compress?: boolean;
	/** Session id prefix or archive path to bring back out of the archive. */
	restore?: string;
	strip?: boolean;
	coldArchiveAfterDays?: number;
	retainNewestGlobal?: number;
	retainNewestPerCwd?: number;
	staleRetainNewest?: number;
	staleRetainDays?: number;
	compressAfterDays?: number;
	stripAfterDays?: number;
}

export interface GcCommandArgs {
	flags: GcCommandFlags;
	/** Where to draw transient per-step progress bars; drawn only on a TTY, none when omitted. */
	progress?: ProgressOutput;
}

export interface BlobGcResult {
	referenced: number;
	candidates: number;
	wouldDelete: number;
	deleted: number;
	bytes: number;
	errors: string[];
}

export interface ArchiveGcResult {
	scanned: number;
	skippedActive: number;
	keptNewestGlobal: number;
	keptNewestPerCwd: number;
	wouldArchive: number;
	archived: number;
	/** Session staging temps past the write grace, left by a killed or crashed writer. */
	wouldDeleteTemps: number;
	deletedTemps: number;
	tempBytes: number;
	/** Links inside an artifact tree whose target was already gone, so the archive could not hold their bytes. */
	brokenLinks: number;
	/**
	 * Files a symlinked transcript pointed at. Their bytes are in the archive
	 * now, and omp no longer uses them, but they are outside its storage so it
	 * does not delete them.
	 */
	orphanedTargets: string[];
	errors: string[];
}

export interface RestoreGcResult {
	/** What the caller asked for: a session id prefix or an archive path. */
	query: string;
	archivePath?: string;
	sessionPath?: string;
	bytes: number;
	artifactsRestored: boolean;
	/** What restoring the transcript does not bring back, in words a caller can print. */
	notRestored: string[];
	errors: string[];
}

export interface WalCheckpointResult {
	dbPath: string;
	walBytes: number;
	wouldCheckpoint: boolean;
	checkpointed: boolean;
	busy: number;
	log: number;
	checkpointedFrames: number;
}

export interface WalGcResult {
	databases: WalCheckpointResult[];
	walBytes: number;
	wouldCheckpoint: boolean;
	checkpointed: boolean;
}

export interface StaleGcResult {
	/** Custom-session-file markers whose recorded transcript is gone. */
	danglingMarkers: number;
	/** Terminal breadcrumbs whose session file is gone. */
	staleBreadcrumbs: number;
	/** Debug report bundles beyond the retention window. */
	expiredReports: number;
	/** Collab guest replicas beyond the retention window. */
	expiredReplicas: number;
	wouldDelete: number;
	deleted: number;
	bytes: number;
	errors: string[];
}

export interface CompressGcResult {
	/** False when the sessions' filesystem has no supported transparent compression; nothing was scanned. */
	supported: boolean;
	/** The filesystem's compression method when supported. */
	method?: CompressMethod;
	/**
	 * With `--apply`, why a probe file showed the filesystem does not actually
	 * compress (e.g. macOS 27 `ditto`); set means no session was scanned.
	 */
	probeFailure?: string;
	scanned: number;
	/** Idle sessions with files to compress that a running process still owns. */
	skippedLive: number;
	/** Sessions with at least one file still stored uncompressed. */
	sessions: number;
	wouldCompress: number;
	compressed: number;
	/** Logical bytes of the files selected for compression. */
	bytes: number;
	/** Bytes those files allocated on disk before compression. */
	allocatedBefore: number;
	/** Bytes the selected files allocate on disk afterwards (`--apply` only). */
	allocatedAfter: number;
	/** Scratch directories a killed run left behind; removed with `--apply`. */
	leftoverScratchDirs: number;
	errors: string[];
}

/** A phase this run did not perform because it works only on session files on disk. */
export interface GcRefusal {
	phase: "archive" | "compress" | "restore";
	/** The phase was named on the command line, so its refusal fails the run. */
	requested: boolean;
	reason: string;
}

export interface StripGcResult {
	/** Top-level session transcripts found; archived transcripts are scanned as well. */
	scanned: number;
	/** Idle sessions (or archived subagent transcripts) with replay data that a running process still owns. */
	skippedLive: number;
	/** Transcripts with replay data to strip: session, subagent, and archived. */
	wouldStrip: number;
	stripped: number;
	/** Session records that carry replay data. */
	records: number;
	/** JSONL bytes the replay data occupies; uncompressed for archived transcripts. */
	bytes: number;
	errors: string[];
}

export interface GcResult {
	agentDir: string;
	apply: boolean;
	stale?: StaleGcResult;
	strip?: StripGcResult;
	blobs?: BlobGcResult;
	archive?: ArchiveGcResult;
	restore?: RestoreGcResult;
	compress?: CompressGcResult;
	wal?: WalGcResult;
	/** Phases skipped because the configured session storage does not keep sessions on disk. */
	refused?: GcRefusal[];
	lockPath: string;
	/**
	 * What a reader has to be told, in the result rather than only in the
	 * rendering of it. The text output held the only copy, so every JSON
	 * route reclaimed silently — and a JSON consumer is exactly the caller
	 * who automated this.
	 */
	warnings?: string[];
}

interface BlobCandidate {
	hash: string;
	paths: string[];
	bytes: number;
	mtimeMs: number;
}

interface BlobStagingFile {
	path: string;
	bytes: number;
	mtimeMs: number;
}

interface BlobScan {
	candidates: BlobCandidate[];
	staging: BlobStagingFile[];
}

interface ArchiveCandidate {
	session: SessionInfo;
	relativePath: string;
	destinationPath: string;
}

interface ResolvedGcOptions {
	apply: boolean;
	json: boolean;
	agentDir: string;
	runBlobs: boolean;
	runArchive: boolean;
	runWal: boolean;
	runStale: boolean;
	runCompress: boolean;
	/** Set by `--restore`; it runs alone, since no sweep may race a restore. */
	restoreTarget?: string;
	/** Phase flags the caller passed, so `--restore` can refuse to drop them. */
	explicitPhases: string[];
	runStrip: boolean;
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
	staleRetainNewest: number;
	staleRetainDays: number;
	compressAfterDays: number;
	stripAfterDays: number;
	/** Wraps each slow per-item loop in a progress bar. */
	track: ProgressTracker;
}

interface WalCheckpointRow {
	busy?: number | bigint | null;
	log?: number | bigint | null;
	checkpointed?: number | bigint | null;
}

function normalizeNumberSetting(value: unknown, defaultValue: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
	return Math.max(0, Math.floor(value));
}

function numberSetting(value: number | undefined, fallback: unknown, defaultValue: number): number {
	if (value !== undefined && Number.isFinite(value)) return Math.max(0, Math.floor(value));
	return normalizeNumberSetting(fallback, defaultValue);
}

async function resolveOptions({ flags, progress }: GcCommandArgs): Promise<ResolvedGcOptions> {
	const agentDir = path.resolve(flags.agentDir ?? getAgentDir());
	const selected =
		flags.blobs === true ||
		flags.archive === true ||
		flags.wal === true ||
		flags.stale === true ||
		flags.compress === true ||
		flags.strip === true;
	const archiveSelected = selected && flags.archive === true;
	const staleSelected = selected && flags.stale === true;
	const compressSelected = selected && flags.compress === true;
	const stripSelected = selected && flags.strip === true;
	const needsArchiveSettings =
		archiveSelected &&
		(flags.coldArchiveAfterDays === undefined ||
			flags.retainNewestGlobal === undefined ||
			flags.retainNewestPerCwd === undefined);
	const needsStaleSettings =
		staleSelected && (flags.staleRetainNewest === undefined || flags.staleRetainDays === undefined);
	const needsCompressSettings = compressSelected && flags.compressAfterDays === undefined;
	const needsStripSettings = stripSelected && flags.stripAfterDays === undefined;
	const settings =
		!selected || needsArchiveSettings || needsStaleSettings || needsCompressSettings || needsStripSettings
			? flags.apply === true
				? await Settings.loadIsolated({ agentDir })
				: await Settings.loadReadOnly({ agentDir })
			: undefined;
	const read = <T>(setting: Setting<T>): T => (settings ? setting.get(settings) : setting.default);
	return {
		apply: flags.apply === true,
		json: flags.json === true,
		agentDir,
		restoreTarget: flags.restore?.trim() || undefined,
		explicitPhases: (["blobs", "archive", "wal", "stale", "compress"] as const).filter(
			phase => flags[phase] === true,
		),
		runBlobs: selected ? flags.blobs === true : read(cfgGcBlobs),
		runArchive: selected ? flags.archive === true : read(cfgGcArchive),
		runWal: selected ? flags.wal === true : read(cfgGcWal),
		runStale: selected ? flags.stale === true : read(cfgGcStale),
		runCompress: selected ? flags.compress === true : read(cfgGcCompress),
		runStrip: selected ? flags.strip === true : read(cfgGcStrip),
		coldArchiveAfterDays: numberSetting(
			flags.coldArchiveAfterDays,
			read(cfgGcColdArchiveAfterDays),
			cfgGcColdArchiveAfterDays.default,
		),
		retainNewestGlobal: numberSetting(
			flags.retainNewestGlobal,
			read(cfgGcRetainNewestGlobal),
			cfgGcRetainNewestGlobal.default,
		),
		retainNewestPerCwd: numberSetting(
			flags.retainNewestPerCwd,
			read(cfgGcRetainNewestPerCwd),
			cfgGcRetainNewestPerCwd.default,
		),
		staleRetainNewest: numberSetting(
			flags.staleRetainNewest,
			read(cfgGcStaleRetainNewest),
			cfgGcStaleRetainNewest.default,
		),
		staleRetainDays: numberSetting(flags.staleRetainDays, read(cfgGcStaleRetainDays), cfgGcStaleRetainDays.default),
		compressAfterDays: numberSetting(
			flags.compressAfterDays,
			read(cfgGcCompressAfterDays),
			cfgGcCompressAfterDays.default,
		),
		stripAfterDays: numberSetting(flags.stripAfterDays, read(cfgGcStripAfterDays), cfgGcStripAfterDays.default),
		track: createProgressTracker(progress),
	};
}

export function collectGcErrors(result: GcResult): string[] {
	return [
		...(result.stale?.errors ?? []).map(error => `stale: ${error}`),
		...(result.strip?.errors ?? []).map(error => `strip: ${error}`),
		...(result.blobs?.errors ?? []).map(error => `blobs: ${error}`),
		...(result.archive?.errors ?? []).map(error => `archive: ${error}`),
		...(result.restore?.errors ?? []).map(error => `restore: ${error}`),
		...(result.compress?.errors ?? []).map(error => `compress: ${error}`),
		// A phase the settings enabled is reported and skipped; one the command
		// line asked for cannot be done, so the run fails.
		...(result.refused ?? []).filter(refusal => refusal.requested).map(r => `${r.phase}: ${r.reason}`),
	];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}

/** Small registry/breadcrumb marker files; a missing file reads as empty. */
async function readTextIfPresent(file: string): Promise<string> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return "";
		throw error;
	}
}

async function scanSessionLines(
	source: ReadableStream<Uint8Array>,
	compressed: boolean,
	onLine: (line: Uint8Array) => void,
): Promise<void> {
	// readLines buffers at most the largest record, including malformed records.
	const scan = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const line of readLines(stream)) onLine(line);
	};
	if (!compressed) {
		await scan(source);
		return;
	}
	const gunzip = createGunzip();
	await pipeline(source, gunzip, async (inflated: NodeJS.ReadableStream) => {
		// Match the native stream's byte budget, not one arbitrary chunk or
		// a default queue that counts each potentially large chunk as size 1.
		await scan(
			Readable.toWeb(inflated, {
				strategy: new ByteLengthQueuingStrategy({ highWaterMark: gunzip.readableHighWaterMark }),
			}),
		);
	});
}

/**
 * Every transcript below `root`, links followed.
 *
 * `followSymlinks` because a transcript placed in a session directory as a
 * symlink is a transcript like any other — `FileSessionStorage.listFilesSync`
 * already treats one that way — and a blob it references must not be swept
 * as unreferenced because this walk could not see the file that references
 * it.
 */
async function scanSessionTree(glob: Bun.Glob, root: string): Promise<string[]> {
	try {
		const files = await Array.fromAsync(glob.scan({ cwd: root, followSymlinks: true }), name =>
			path.join(root, name),
		);
		files.sort();
		return files;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}
async function collectJsonlFiles(root: string): Promise<string[]> {
	return await scanSessionTree(JSONL_GLOB, root);
}

async function collectCompressedJsonlFiles(root: string): Promise<string[]> {
	return await scanSessionTree(JSONL_GZ_GLOB, root);
}

async function collectBackupJsonlFiles(root: string): Promise<string[]> {
	return await scanSessionTree(JSONL_BACKUP_GLOB, root);
}

/**
 * Every name the sweep would treat as a session, with what stands at it.
 *
 * Holding a lease for each session this run collected says nothing about a
 * session that did not exist when it collected them. `SessionManager.forkFrom`
 * creates one with a journal that carries the parent's blob references, and
 * a manager whose session was collected moves to a sibling by design — both
 * put a live reference to a blob this run has already judged unreferenced,
 * with no symlink and nothing hostile involved. The same is true of
 * artifacts: `session-manager.ts:178-200` copies a child's `.jsonl` into the
 * tree without claiming that child's lease.
 *
 * There is no door to hold here, so this is a way to notice that the room
 * changed: take it twice, once when the sessions are read and once when the
 * candidate set is final, and refuse the whole phase if a name appeared,
 * vanished, or changed in identity, size or modification time. No lock, so
 * nothing here stops a session being created.
 *
 * It is not a guarantee and it is not free. A change undone again before
 * the second listing passes it, and so does one that leaves name, size and
 * modification time equal — at one-second timestamp granularity an ordinary
 * rewrite can. It costs two full walks of the sessions tree on top of the
 * reference walk, measured 5.785 seconds apart on a tree of 8,001 sessions.
 * It narrows the window; it does not close it, which is why reclamation is
 * opt-in.
 */
async function sessionTreeCensus(
	sessionRoots: string[],
	agentDir: string,
): Promise<{ entries?: Map<string, string>; unresolved?: string }> {
	try {
		const names = new Set<string>();
		for (const root of sessionRoots) {
			for (const file of [
				...(await collectJsonlFiles(root)),
				...(await collectCompressedJsonlFiles(root)),
				...(await collectBackupJsonlFiles(root)),
			]) {
				names.add(file);
			}
		}
		for (const file of await collectRegisteredSessionPaths(getCustomSessionFilesDir(agentDir))) names.add(file);
		for (const file of await collectBreadcrumbSessionFiles(getTerminalSessionsDir(agentDir))) names.add(file);
		const entries = new Map<string, string>();
		for (const name of [...names].sort()) {
			const standing = await fs.lstat(name).catch(() => undefined);
			// `lstat`, so a name that is a link is described as a link, and
			// size and modification time, so an append to a collected
			// session counts as a change even though its identity has not.
			entries.set(
				name,
				standing
					? `${standing.dev}:${standing.ino}:${standing.size}:${standing.mtimeMs}:${standing.isSymbolicLink()}`
					: "absent",
			);
		}
		return { entries };
	} catch (error) {
		return { unresolved: `the sessions tree could not be listed: ${errorMessage(error)}` };
	}
}

function collectBlobHashesFromText(text: string, hashes: Set<string>): void {
	for (const match of text.matchAll(BLOB_REF_RE)) {
		const hash = match[1]?.toLowerCase();
		if (hash && BLOB_HASH_RE.test(hash)) hashes.add(hash);
	}
}

/** The first way `after` differs from `before`, or undefined when it does not. */
function censusChange(before: Map<string, string>, after: Map<string, string>): string | undefined {
	for (const [name, standing] of after) {
		const was = before.get(name);
		if (was === undefined) return `${name} appeared while the sweep was deciding`;
		if (was !== standing) return `${name} changed while the sweep was deciding`;
	}
	for (const name of before.keys()) {
		if (!after.has(name)) return `${name} went while the sweep was deciding`;
	}
	return undefined;
}

/**
 * Blob hashes every session file below these roots refers to, read through
 * descriptors this run holds.
 *
 * Reclaiming a blob means proving no session refers to it. That proof needs
 * to know which files are reachable as sessions, and when a route to one
 * runs through a symlink the proof is not available: the entries on that
 * route are themselves files the sweep may consider, the route can change
 * between any two of its own syscalls, and five successive rounds of review
 * each found a new arrangement a careful resolver got wrong — `..` from the
 * lexical parent, `..` after a symlinked prefix, a link used as a directory
 * component, a blob entry behind one of those, and a directory swapped
 * after the open. Each fix was right about the arrangement in front of it.
 *
 * So this does not resolve such a tree; it refuses to reclaim in one. A
 * session whose opened path differs from the name it was collected under
 * was reached through a link — one comparison per session rather than an
 * enumeration of every route — and the whole blob phase then deletes
 * nothing and says why. Every other phase still runs.
 *
 * Not being able to learn what the kernel opened is the same answer: if
 * `/proc/self/fd` cannot be read, this run does not know what it holds.
 *
 * Lifting the restriction needs a mechanism that makes the proof available
 * — writers participating, a quarantine a reader restores from — not
 * another arrangement handled. Until then the command says what it cannot
 * show rather than guessing, and reclamation is opt-in, because what it
 * cannot show includes the ordinary case: a tree with no links refuses
 * when a session is owned or unreadable, but a session rewritten in place
 * while this runs — same name, same size, same modification time, which a
 * one-second clock makes commonplace — is not seen, and that run exits 0
 * having deleted a blob the session still refers to.
 *
 * The ownership lease is likewise narrower than it sounds: it is taken for
 * sessions whose header id can be read, so a compressed transcript or one
 * with no header is read, counted and reclaimed against without a lease
 * being held for it at all.
 */
async function collectReferencedBlobHashes(
	sessionNames: string[],
	blobDir: string,
	track: ProgressTracker,
): Promise<{ hashes: Set<string>; unresolved: string[]; leases: FileLockHandle[] }> {
	// The names come from the census, so the set this reads is exactly the
	// set that is compared afterwards. They are deduplicated as text and no
	// further: a key that resolved symlinks dropped an alias before anything
	// opened it, and the guard that would have refused over that alias never
	// ran. Two names that turn out to be one file collapse below, on the
	// identity of the file this run holds, which is the only reason two
	// entries should ever be one.
	const names = new Set<string>(sessionNames);
	const decoder = new TextDecoder();

	const blobDirAtStart = await statIfPresent(blobDir);
	const hashes = new Set<string>();
	const unresolved: string[] = [];
	const read = new Set<string>();
	// Held, not probed: released by the caller once the deletions are done.
	const leases: FileLockHandle[] = [];
	/** Session ids this run already holds, so it cannot collide with itself. */
	const leasedIds = new Set<string>();
	for (const file of track.each("Scanning transcripts for blob refs", [...names])) {
		// Opened first, and what this run trusts afterwards is the identity
		// of the object it holds. Not the pathname: `/proc/self/fd/<n>` is
		// read *after* the open and resolves when the `readlink` runs, so a
		// rename in between changes what it reports. It is a signal about
		// how this name was reached, never a snapshot of it, and nothing
		// here is built on it being one.
		const held = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(error => {
			const code = codeOf(error);
			// Nothing at that name, or a name that cannot be a session:
			// there is no session here to protect.
			if (code === "ENOENT" || code === "ENOTDIR" || code === "ENXIO") return undefined;
			unresolved.push(`${file}: ${errorMessage(error)}`);
			return undefined;
		});
		if (!held) continue;
		try {
			// Three independent answers to "was this name reached through a
			// link", any one of which refuses. One of them failing is a
			// refusal too: a check that could not run is not a check that
			// passed, which is how an unreadable `/proc` quietly turned the
			// comparison off and the sweep went on deleting.
			const named = await fs.lstat(file).catch(() => undefined);
			const resolved = await fs.realpath(file).catch(() => undefined);
			const opened = await fs.readlink(`/proc/self/fd/${held.fd}`).catch(() => undefined);
			const lexical = path.resolve(file);
			if (!named || resolved === undefined || opened === undefined) {
				unresolved.push(
					`${file}: this run could not establish how it was reached, so the blobs on that route ` +
						`cannot be shown to be unreferenced`,
				);
			} else if (named.isSymbolicLink() || resolved !== lexical || opened !== lexical) {
				unresolved.push(
					`${file} is reachable as a session through a symlink (${opened}), and reclaiming blobs cannot ` +
						`prove which of them lie on that route`,
				);
			}
			// Identity first, lease second. Taking a lease per *name* made
			// this run collide with itself: a journal and its backup, two
			// hard links to one journal, or two files carrying one header id
			// each had their session claimed twice, and the second claim —
			// blocked by the first, which is this very run — was reported as
			// another running process. Three quiet trees with no writer at
			// all refused that way.
			const identity = await held.stat();
			const key = `${identity.dev}:${identity.ino}`;
			if (read.has(key)) continue;
			read.add(key);
			// A descriptor freezes the file's identity, not its bytes. A
			// writer that owns this session can truncate it and put the same
			// text back between this read and the candidate scan — and omp's
			// own writer does rewrite in place: `FileSessionStorage` rolls a
			// failed append back with `ftruncateSync` on its own handle, and
			// `updateSessionTitle` writes the title slot at offset zero
			// through `r+`. Taking the lease and giving it straight back
			// proves nothing either: the writer simply starts between the
			// release and the deletion. So the lease is taken here and held
			// until the deletions are done — once per session id, because a
			// second file carrying the same id is this run's own claim
			// looking back at it.
			const sessionId = await readSessionHeaderId(file).catch(() => undefined);
			if (sessionId !== undefined && !leasedIds.has(sessionId)) {
				const lease = tryAcquireSessionLease(sessionId);
				if (lease === null) {
					unresolved.push(
						`${file} is owned by a running process, so its references cannot be read as settled; ` +
							`close it and run \`omp gc --blobs --apply\` again`,
					);
					continue;
				}
				leasedIds.add(sessionId);
				leases.push(lease);
			}
			// The format comes from the bytes, not from the name. A
			// compressed transcript at a blob-hash name has no suffix to
			// read, and parsing it as plain text saw none of its references
			// and swept the blobs it owned. Deciding a file's format from
			// its name is the same mistake as deciding its identity that
			// way, and this run is holding the file anyway.
			const magic = Buffer.allocUnsafe(2);
			const { bytesRead } = await held.read(magic, 0, 2, 0);
			const compressed = bytesRead === 2 && magic[0] === 0x1f && magic[1] === 0x8b;
			// Read through the descriptor, not reopened by name. Keep raw-text
			// matching: recoverable malformed records can still own blobs.
			await scanSessionLines(
				Readable.toWeb(held.createReadStream({ autoClose: false, start: 0 })) as ReadableStream<Uint8Array>,
				compressed,
				line => collectBlobHashesFromText(decoder.decode(line), hashes),
			);
		} catch (error) {
			// A decision taken is a decision reported: a read that fails here
			// used to throw out of the whole command, so a caller asking for
			// JSON got a stack trace instead of a refusal.
			unresolved.push(`${file}: ${errorMessage(error)}`);
		} finally {
			await held.close().catch(() => undefined);
		}
	}
	// The blob directory this run was deciding about, asked again now that
	// the reading is done: one replaced mid-run, or one whose inode numbers
	// are not stable, makes the candidate scan an answer about a different
	// directory.
	const standing = await statIfPresent(blobDir);
	if (!standing) unresolved.push(`${blobDir}: the blob directory could not be identified`);
	else if (standing.dev !== blobDirAtStart?.dev || standing.ino !== blobDirAtStart.ino) {
		unresolved.push(`${blobDir}: its identity changed while the sweep was reading`);
	}
	return { hashes, unresolved, leases };
}

/**
 * Paths recorded in the persistent registry (`<agentDir>/custom-session-files/*`).
 * A first save may leave only its staging temp, so the target need not exist
 * when reclaiming crash leftovers.
 */
async function collectRegisteredSessionPaths(registryDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(registryDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	// Deduplicated as text and no further. A map keyed by the
	// symlink-resolving comparison let two markers that name one physical
	// file through different routes collapse to one entry, and the route
	// that would have been refused went with the entry that lost — the same
	// defect as the merge of sources, one level in. Two names become one
	// only after they are opened and found to be one file.
	const files = new Set<string>();
	for (const entry of entries) {
		const recorded = (await readTextIfPresent(path.join(registryDir, entry))).trim();
		if (!recorded) continue;
		files.add(path.resolve(recorded));
	}
	return [...files];
}

/**
 * Exact session files recorded in terminal breadcrumbs. Supplements
 * {@link collectRegisteredSessionFiles}: a breadcrumb holds only that
 * terminal's last session, but catches the current transcript even if its
 * persistent marker write failed.
 */
async function collectBreadcrumbSessionFiles(breadcrumbDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(breadcrumbDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	// As above: names collapse here only when they are the same text.
	const files = new Set<string>();
	for (const entry of entries) {
		const text = await readTextIfPresent(path.join(breadcrumbDir, entry));
		const lines = text.split("\n");
		const breadcrumbCwd = lines[0]?.trim();
		const recordedSessionFile = lines[1]?.trim();
		if (!breadcrumbCwd || !recordedSessionFile) continue;
		files.add(path.resolve(breadcrumbCwd, recordedSessionFile));
	}
	return [...files];
}

async function collectBlobCandidates(blobDir: string, track: ProgressTracker): Promise<BlobScan> {
	let entries: string[];
	try {
		entries = await fs.readdir(blobDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { candidates: [], staging: [] };
		throw error;
	}

	const byHash = new Map<string, BlobCandidate>();
	const staging: BlobStagingFile[] = [];
	for (const entry of track.each("Listing blobs", entries)) {
		const isStaging = BLOB_STAGING_RE.test(entry);
		const hash = isStaging ? undefined : entry.match(BLOB_FILE_RE)?.[1];
		if (!isStaging && !hash) continue;
		const file = path.join(blobDir, entry);
		// `lstat`: these are entries in gc's own store, and the question is
		// what is at the name rather than what it leads to. Following them
		// threw `ELOOP` out of the whole sweep on a looping blob-named link,
		// and read a link whose target had gone as nothing being there —
		// which is how a `.HASH.…tmp` link outlived every later run.
		const stat = await fs.lstat(file).catch(() => undefined);
		if (!stat) continue;
		if (!stat.isFile() && !stat.isSymbolicLink()) continue;
		if (!hash) {
			staging.push({ path: file, bytes: stat.size, mtimeMs: stat.mtimeMs });
			continue;
		}
		const candidate = byHash.get(hash) ?? { hash, paths: [], bytes: 0, mtimeMs: stat.mtimeMs };
		candidate.paths.push(file);
		candidate.bytes += stat.size;
		candidate.mtimeMs = Math.max(candidate.mtimeMs, stat.mtimeMs);
		byHash.set(hash, candidate);
	}
	return { candidates: [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash)), staging };
}

async function unlinkBlobFile(file: string, result: BlobGcResult): Promise<void> {
	try {
		await fs.unlink(file);
		result.deleted += 1;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
		result.errors.push(`${file}: ${errorMessage(error)}`);
	}
}

/**
 * Delete an unreferenced candidate unless a put reused its blob after the
 * candidate scan. `BlobStore.put` refreshes an old reused blob's mtime before
 * its new reference reaches a session file, and rewrites the blob when that
 * touch finds the path gone. The canonical file is therefore moved to a
 * staging name first: a touch that landed before the move shows on the moved
 * file, which goes back; one that lands after misses the path, so the put
 * writes the blob again. Returns whether the candidate was deleted.
 */
async function deleteBlobCandidate(
	candidate: BlobCandidate,
	deleteBeforeMs: number,
	result: BlobGcResult,
): Promise<boolean> {
	const canonical = candidate.paths.find(file => path.basename(file) === candidate.hash);
	const files = candidate.paths.filter(file => file !== canonical);
	if (canonical) {
		const moved = blobStagingPath(canonical);
		try {
			await fs.rename(canonical, moved);
		} catch (error) {
			if (codeOf(error) !== "ENOENT") {
				result.errors.push(`${canonical}: ${errorMessage(error)}`);
				return false;
			}
		}
		// `lstat`, not `stat`: a canonical blob that is itself a symlink has a
		// target that may already be gone, and asking about the target then
		// says "nothing is there" about an entry that is very much there. The
		// renamed link was dropped from the removal list on that answer and
		// every later sweep skipped it, leaving `.HASH.…tmp` links behind for
		// good.
		const stat = await fs.lstat(moved).catch(() => undefined);
		if (stat?.isFile() && stat.mtimeMs > deleteBeforeMs) {
			await restoreReusedBlob(moved, canonical, result);
			return false;
		}
		if (stat) files.unshift(moved);
	}
	for (const file of files) await unlinkBlobFile(file, result);
	return true;
}

/** Put a blob reused mid-sweep back; a put that already rewrote it wins (same bytes). */
async function restoreReusedBlob(moved: string, canonical: string, result: BlobGcResult): Promise<void> {
	try {
		await fs.rename(moved, canonical);
		return;
	} catch (error) {
		if (!(await statIfPresent(canonical))) {
			result.errors.push(`${canonical}: failed to restore reused blob: ${errorMessage(error)}`);
			return;
		}
	}
	try {
		await fs.unlink(moved);
	} catch {
		// The rewritten canonical blob stands; a leftover staging copy ages out.
	}
}

async function runBlobGc(
	options: ResolvedGcOptions,
	archiveSessionsRoot: string,
	storage: SessionStorage,
): Promise<BlobGcResult> {
	const blobDir = getBlobsDir(options.agentDir);
	const sessionsRoot = getSessionsDir(options.agentDir);
	const defaultRoots = [sessionsRoot, archiveSessionsRoot];
	// The baseline census *is* the source set. Gathering the registry and
	// breadcrumb names separately beforehand left a name that appeared
	// between the two steps in both censuses and in neither comparison, so a
	// terminal breadcrumb registering an existing external transcript made
	// that transcript invisible: never opened, never counted, its blob
	// deleted while it stayed registered and readable. One listing answers
	// both questions, so the thing compared is the thing read.
	const before = await sessionTreeCensus(defaultRoots, options.agentDir);
	const referenced = await collectReferencedBlobHashes([...(before.entries?.keys() ?? [])], blobDir, options.track);
	// Every session whose header id could be read is still held, and the
	// decision about which blobs are unreferenced and the deletions that act
	// on it happen inside that hold: a lease taken and given back is only a
	// question about a moment that has passed, since a writer starting
	// between the release and the deletion adds a reference to a blob this
	// run has already judged unreferenced. A compressed or headerless
	// transcript has no id to lease by, so it is read and counted with
	// nothing held for it — one of the reasons this phase is opt-in.
	try {
		// A key-indexed backend (SQL, Redis) never puts transcripts on the local
		// filesystem, so the census above proves nothing about a session stored
		// there: read every path the store holds — subagents at any depth, custom
		// `--session` paths, and rows whose path also names a stale local copy —
		// so a reference in any of them keeps its blob.
		if (!(storage instanceof FileSessionStorage)) {
			const stored = storage.listAllSync?.();
			if (stored === undefined) {
				throw new Error(
					"blob gc cannot enumerate the configured session storage, so it cannot prove a blob unreferenced",
				);
			}
			for (const file of stored) {
				let text: string;
				try {
					text = await storage.readText(file);
				} catch (error) {
					// Removed since the listing: it references nothing anymore.
					if (codeOf(error) === "ENOENT") continue;
					throw error;
				}
				collectBlobHashesFromText(text, referenced.hashes);
			}
		}
		const { candidates, staging } = await collectBlobCandidates(blobDir, options.track);
		const result: BlobGcResult = {
			referenced: referenced.hashes.size,
			candidates: candidates.length,
			wouldDelete: 0,
			deleted: 0,
			bytes: 0,
			errors: [],
		};
		// A sweep that could not finish reading keeps. Every refusal above is a
		// reading this run knows is incomplete — a path it could not follow, a
		// blob directory it could not identify or one that stopped being the
		// directory it had been comparing against — and deleting on the strength
		// of an incomplete reading is how an unreferenced-looking blob turns out
		// to have been a session.
		if (referenced.unresolved.length > 0) {
			for (const reason of referenced.unresolved) {
				result.errors.push(`${reason}; no blob was deleted in this run`);
			}
			return result;
		}
		// The candidate set is final and nothing has been removed yet, so this
		// is the moment to ask whether the room changed. A session that did
		// not exist when the leases were taken cannot be held by one, and
		// `forkFrom` gives a new session the parent's references while a
		// manager that finds its own session collected moves to a sibling —
		// ordinary omp behaviour, no symlink, nothing hostile. Artifacts go
		// the same way: `session-manager.ts:178-200` copies a child's
		// transcript into the tree without claiming that child's lease.
		const after = await sessionTreeCensus(defaultRoots, options.agentDir);
		const change = before.entries && after.entries ? censusChange(before.entries, after.entries) : undefined;
		const unlisted = before.unresolved ?? after.unresolved;
		if (unlisted || change) {
			result.errors.push(`${unlisted ?? change}; no blob was deleted in this run`);
			return result;
		}

		const deleteBeforeMs = Date.now() - GC_WRITE_GRACE_MS;
		for (const candidate of options.track.each("Scanning blobs", candidates)) {
			if (referenced.hashes.has(candidate.hash)) continue;
			if (candidate.mtimeMs > deleteBeforeMs) continue;
			if (options.apply && !(await deleteBlobCandidate(candidate, deleteBeforeMs, result))) continue;
			result.wouldDelete += candidate.paths.length;
			result.bytes += candidate.bytes;
		}
		// A live write renames its staging file away within milliseconds; one past
		// the grace was left by a killed or crashed writer and nothing will claim it.
		for (const file of staging) {
			if (file.mtimeMs > deleteBeforeMs) continue;
			result.wouldDelete += 1;
			result.bytes += file.bytes;
			if (options.apply) await unlinkBlobFile(file.path, result);
		}
		return result;
	} finally {
		for (const lease of referenced.leases) lease.release();
	}
}

interface StaleCandidate {
	kind: "danglingMarkers" | "staleBreadcrumbs" | "expiredReports" | "expiredReplicas";
	/** Removed together; the first path is the entry itself. */
	paths: string[];
	bytes: number;
	/** Session file whose ownership lease must be free (no running writer) to remove it. */
	ownedSession?: string;
}

/**
 * Config-root stores (`reports/`, `collab/`) live beside the agent dir, not in
 * it. The default agent dir resolves them through the dirs resolver (XDG-aware);
 * a custom agent dir named `agent` owns its parent as config root; any other
 * custom agent dir has no config root for gc to maintain.
 */
function resolveConfigRootStores(agentDir: string): { reportsDir: string; collabDir: string } | undefined {
	const configRoot = getConfigRootDir();
	if (normalizePathForComparison(agentDir) === normalizePathForComparison(path.join(configRoot, "agent"))) {
		return { reportsDir: getReportsDir(), collabDir: path.join(configRoot, "collab") };
	}
	if (path.basename(agentDir) !== "agent") return undefined;
	const root = path.dirname(agentDir);
	return { reportsDir: path.join(root, "reports"), collabDir: path.join(root, "collab") };
}

async function listFilesIfPresent(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter(entry => entry.isFile()).map(entry => path.join(dir, entry.name));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

/**
 * Whether a pointer's target is verifiably gone; unreadable targets count as
 * present. A key-indexed store (`session.storage: sql`) is asked first: the
 * session it holds has no file, so the filesystem alone can only ever veto
 * the removal, never authorize it.
 */
async function sessionFileMissing(sessionFile: string, storage: SessionStorage): Promise<boolean> {
	if (!(storage instanceof FileSessionStorage) && (await storage.exists(sessionFile))) return false;
	try {
		return !(await fs.stat(sessionFile)).isFile();
	} catch (error) {
		const code = codeOf(error);
		return code === "ENOENT" || code === "ENOTDIR";
	}
}

/**
 * Pointer files (custom-session markers, terminal breadcrumbs) past
 * {@link STALE_POINTER_GRACE_MS} whose recorded session file is gone.
 * `resolveTarget` returns undefined for unparsable pointers, which are kept.
 */
async function collectDanglingPointers(
	dir: string,
	kind: StaleCandidate["kind"],
	storage: SessionStorage,
	resolveTarget: (text: string) => string | undefined,
): Promise<StaleCandidate[]> {
	const deleteBeforeMs = Date.now() - STALE_POINTER_GRACE_MS;
	const candidates: StaleCandidate[] = [];
	for (const file of await listFilesIfPresent(dir)) {
		const stat = await statIfPresent(file);
		if (!stat || stat.mtimeMs > deleteBeforeMs) continue;
		const target = resolveTarget(await readTextIfPresent(file));
		if (!target || !(await sessionFileMissing(target, storage))) continue;
		candidates.push({ kind, paths: [file], bytes: stat.size });
	}
	return candidates;
}

/**
 * Files beyond the newest `retainNewest` that are also older than
 * `retainDays` (and never inside the write grace).
 */
async function collectExpiredFiles(
	dir: string,
	suffix: string,
	options: ResolvedGcOptions,
): Promise<Array<{ file: string; bytes: number }>> {
	const files: Array<{ file: string; bytes: number; mtimeMs: number }> = [];
	for (const file of await listFilesIfPresent(dir)) {
		if (!file.endsWith(suffix)) continue;
		const stat = await statIfPresent(file);
		if (stat) files.push({ file, bytes: stat.size, mtimeMs: stat.mtimeMs });
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const deleteBeforeMs = Date.now() - Math.max(options.staleRetainDays * DAY_MS, GC_WRITE_GRACE_MS);
	return files.slice(options.staleRetainNewest).filter(entry => entry.mtimeMs < deleteBeforeMs);
}

async function runStaleGc(options: ResolvedGcOptions, storage: SessionStorage): Promise<StaleGcResult> {
	const markersDir = getCustomSessionFilesDir(options.agentDir);
	const breadcrumbDir = getTerminalSessionsDir(options.agentDir);
	const candidates: StaleCandidate[] = [
		...(await collectDanglingPointers(markersDir, "danglingMarkers", storage, text => {
			const recorded = text.trim();
			return recorded ? path.resolve(recorded) : undefined;
		})),
		...(await collectDanglingPointers(breadcrumbDir, "staleBreadcrumbs", storage, text => {
			const crumb = parseTerminalBreadcrumb(text);
			// A fresh crumb is a lazy `/new` boundary that `--continue` honors
			// before its transcript exists. It stays until the session materializes
			// (rewriting it non-fresh) or the terminal's next session replaces it.
			if (!crumb || crumb.fresh) return undefined;
			const cwd = crumb.cwd.trim();
			const sessionFile = crumb.sessionFile.trim();
			return cwd && sessionFile ? path.resolve(cwd, sessionFile) : undefined;
		})),
	];
	const stores = resolveConfigRootStores(options.agentDir);
	if (stores) {
		for (const { file, bytes } of await collectExpiredFiles(stores.reportsDir, ".tar.gz", options)) {
			candidates.push({ kind: "expiredReports", paths: [file], bytes });
		}
		// A replica a terminal's breadcrumb points at is what `--continue` resumes
		// there; one a running guest holds is skipped at removal (ownership lease).
		const resumable = new Set(
			(await collectBreadcrumbSessionFiles(breadcrumbDir)).map(file => normalizePathForComparison(file)),
		);
		for (const { file, bytes } of await collectExpiredFiles(stores.collabDir, SESSION_SUFFIX, options)) {
			if (resumable.has(normalizePathForComparison(file))) continue;
			candidates.push({
				kind: "expiredReplicas",
				// The replica's custom-session marker would only dangle once it is gone.
				paths: [file, sessionArtifactsPath(file), path.join(markersDir, hashPath(file))],
				bytes,
				ownedSession: file,
			});
		}
	}

	const result: StaleGcResult = {
		danglingMarkers: 0,
		staleBreadcrumbs: 0,
		expiredReports: 0,
		expiredReplicas: 0,
		wouldDelete: 0,
		deleted: 0,
		bytes: 0,
		errors: [],
	};
	for (const candidate of options.track.each("Scanning stale entries", candidates)) {
		const lease = candidate.ownedSession ? await tryAcquireSessionFileLease(candidate.ownedSession) : undefined;
		if (lease === null) continue;
		try {
			result[candidate.kind] += 1;
			result.wouldDelete += 1;
			result.bytes += candidate.bytes;
			if (!options.apply) continue;
			try {
				for (const target of candidate.paths) await fs.rm(target, { recursive: true, force: true });
				result.deleted += 1;
			} catch (error) {
				result.errors.push(`${candidate.paths[0]}: ${errorMessage(error)}`);
			}
		} finally {
			// Held through the removal so a guest cannot reopen the replica mid-delete.
			lease?.release();
		}
	}
	return result;
}

/**
 * Take the ownership lease of the session in `sessionFile`, or null while a
 * running process holds it (or the lease cannot be probed: an unknown owner is
 * treated as live). The lease is keyed by the header's session id. Undefined
 * when the file has no session header: omp writes the header with the first
 * bytes of a session, so no running writer owns such a file (and candidates
 * are past the write grace, so none is mid-write).
 */
async function tryAcquireSessionFileLease(sessionFile: string): Promise<FileLockHandle | null | undefined> {
	try {
		const sessionId = await readSessionHeaderId(sessionFile, LOCAL_SESSION_FILES);
		return sessionId === undefined ? undefined : tryAcquireSessionLease(sessionId);
	} catch {
		return null;
	}
}

async function listActiveSessions(sessionsRoot: string, track: ProgressTracker): Promise<SessionInfo[]> {
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}

	const storage = LOCAL_SESSION_FILES;
	const sessions: SessionInfo[] = [];
	for (const entry of track.each(
		"Listing sessions",
		entries.filter(entry => entry.isDirectory()),
	)) {
		sessions.push(...(await listSessionsReadOnly(path.join(sessionsRoot, entry.name), storage)));
	}
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/**
 * Top-level transcripts under `sessionsRoot`, found by name alone. Unlike
 * {@link listActiveSessions}, nothing is read, so phases that need only a
 * transcript's path and mtime start work at once; see {@link isIdleTranscript}.
 */
async function collectTranscriptFiles(sessionsRoot: string): Promise<string[]> {
	try {
		return await Array.fromAsync(TRANSCRIPT_GLOB.scan(sessionsRoot), name => path.join(sessionsRoot, name));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

/** Whether `transcript` is a session (it has a header) last written before `idleBeforeMs`. */
async function isIdleTranscript(transcript: string, idleBeforeMs: number): Promise<boolean> {
	const stat = await statIfPresent(transcript);
	if (!stat?.isFile() || stat.mtimeMs > idleBeforeMs) return false;
	return (await readSessionHeaderId(transcript)) !== undefined;
}

async function listNestedSessionsReadOnly(artifactsRoot: string): Promise<SessionInfo[]> {
	const files = await collectJsonlFiles(artifactsRoot);
	const dirs = [...new Set(files.map(file => path.dirname(file)))].sort();
	const storage = LOCAL_SESSION_FILES;
	const sessions: SessionInfo[] = [];
	for (const dir of dirs) sessions.push(...(await listSessionsReadOnly(dir, storage)));
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

async function hasLiveNestedSessions(session: SessionInfo, archiveBeforeMs: number): Promise<boolean> {
	for (const nested of await listNestedSessionsReadOnly(sessionArtifactsPath(session.path))) {
		if (nested.status && ACTIVE_STATUSES.has(nested.status)) return true;
		if (nested.modified.getTime() > archiveBeforeMs) return true;
	}
	return false;
}

function archiveDestination(
	archiveRoot: string,
	sessionsRoot: string,
	session: SessionInfo,
): Omit<ArchiveCandidate, "session"> | null {
	const sessionPath = session.path;
	const relativePath = path.relative(sessionsRoot, sessionPath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
	if (!relativePath.endsWith(SESSION_SUFFIX)) return null;
	return {
		relativePath,
		destinationPath: path.join(archiveRoot, `${relativePath}.gz`),
	};
}

function sessionCwdKey(sessionsRoot: string, session: SessionInfo): string {
	const relativePath = path.relative(sessionsRoot, session.path);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return session.cwd || ".";
	const dirname = path.dirname(relativePath);
	return dirname === "." ? session.cwd || "." : dirname;
}

async function movePath(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	try {
		await fs.rename(source, destination);
		return;
	} catch (error) {
		if (codeOf(error) !== "EXDEV") throw error;
	}
	const stat = await fs.stat(source);
	if (stat.isDirectory()) {
		await fs.cp(source, destination, { recursive: true });
		await fs.rm(source, { recursive: true, force: true });
		return;
	}
	await fs.copyFile(source, destination);
	await fs.unlink(source);
}

function sessionArtifactsPath(sessionPath: string): string {
	if (sessionPath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
		return sessionPath.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
	}
	return sessionPath.slice(0, -SESSION_SUFFIX.length);
}

/** SHA-256 and byte count of a stream, used to prove an archive inflates to its source. */
async function digestStream(stream: AsyncIterable<Uint8Array>): Promise<{ hash: string; bytes: number }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of stream) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), bytes };
}

/** SHA-256 and byte count of what an archived transcript inflates to. */
async function digestArchivedSessionFile(file: string): Promise<{ hash: string; bytes: number }> {
	let digest: { hash: string; bytes: number } | undefined;
	await pipeline(Bun.file(file).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
		digest = await digestStream(source as AsyncIterable<Uint8Array>);
	});
	if (!digest) throw new Error(`archive produced no bytes: ${file}`);
	return digest;
}

/**
 * Compress `source` into `destination`, and drop the source only once the
 * archive has been read back and proved to inflate to the same bytes. An
 * archive that cannot be read is not an archive, and a run that reports
 * success must not be the thing that lost the session.
 *
 * A transcript is routinely a symlink to a file held elsewhere (transcripts
 * offloaded to another disk behind same-path links). The compressed copy
 * holds the content either way, and the link goes; the file it names is left
 * alone and returned, so the caller can report a copy omp no longer uses.
 * omp deletes nothing outside its own storage: that target may be a file its
 * owner keeps, or a second session's link to the same bytes, and a cleanup
 * that can delete an unrelated file is worse than the defect it cleans up
 * after.
 *
 * Once the source is gone the archive is the only copy, so from that point
 * on a later failure never removes it.
 */
async function gzipSessionFile(source: string, destination: string): Promise<{ orphanedTarget?: string }> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
	// Only the transcript's own link counts. `realpath` would also resolve a
	// symlinked sessions directory and report every transcript under it as an
	// orphan, drowning the lines that name a real one.
	const sourceReal = (await fs.lstat(source).catch(() => undefined))?.isSymbolicLink()
		? await fs.realpath(source).catch(() => source)
		: source;
	let sourceGone = false;
	let renamed = false;
	try {
		const expected = await digestStream(Bun.file(source).stream());
		await pipeline(
			Bun.file(source).stream(),
			createGzip({ level: 9 }),
			(await fs.open(tempPath, "w")).createWriteStream(),
		);
		await fs.rename(tempPath, destination);
		renamed = true;
		const stored = await digestArchivedSessionFile(destination);
		if (stored.hash !== expected.hash) {
			throw new Error(
				`archive verification failed for ${source}: ${expected.bytes} bytes in, ${stored.bytes} bytes back`,
			);
		}
		await fs.unlink(source);
		sourceGone = true;
		return { orphanedTarget: sourceReal === source ? undefined : sourceReal };
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		if (renamed && !sourceGone) await fs.rm(destination, { force: true });
		throw error;
	}
}

/** Undo one `gzipSessionFile`: put the transcript back and drop the archive copy. */
async function restoreGzipSessionFile(source: string, destination: string): Promise<void> {
	await inflateArchivedTranscript(source, destination);
	await fs.unlink(source);
}

/**
 * Copy an artifact tree into the archive with symlinks resolved into real
 * files, then drop the source. The archive must hold the bytes: a link into
 * a tree that is relocated or cleaned later archives a session that cannot
 * come back. `fs.rename` is not an option either — the archive root is
 * routinely a symlink onto another filesystem. `force` lets a run finish a
 * tree that a killed run left half-copied.
 *
 * A link whose target is already gone is skipped and counted: dereferencing
 * it throws, and one broken link must not make a session unarchivable
 * forever. A failure part-way removes what it had copied, so a retry never
 * finds a stray tree in the archive with no transcript beside it.
 */
async function moveArtifactsTree(source: string, destination: string): Promise<{ brokenLinks: number }> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	let brokenLinks = 0;
	try {
		await fs.cp(source, destination, {
			recursive: true,
			dereference: true,
			force: true,
			filter: async entry => {
				const link = await fs.lstat(entry).catch(() => undefined);
				if (!link?.isSymbolicLink()) return true;
				if (await pathExists(entry)) return true;
				brokenLinks += 1;
				return false;
			},
		});
	} catch (error) {
		await fs.rm(destination, { recursive: true, force: true });
		throw error;
	}
	await fs.rm(source, { recursive: true, force: true });
	return { brokenLinks };
}

/**
 * Whether `destination` already holds exactly what archiving `source` would
 * write — the signature of a run killed between the archive landing and the
 * transcript being dropped. Finishing that move is what keeps one session
 * from wedging every later run on `archive destination exists`.
 */
async function archiveAlreadyHolds(source: string, destination: string): Promise<boolean> {
	try {
		const live = await digestStream(Bun.file(source).stream());
		const stored = await digestArchivedSessionFile(destination);
		return live.hash === stored.hash;
	} catch {
		return false;
	}
}

/**
 * Move one session into the archive: the transcript compressed, then its
 * artifact tree. Returns the symlink target the transcript named, if any,
 * which is now a copy omp no longer uses.
 *
 * A destination that already holds this very transcript is a move a killed
 * run did not finish, and is finished here rather than reported forever.
 */
async function moveSessionWithArtifacts(
	candidate: ArchiveCandidate,
): Promise<{ orphanedTarget?: string; brokenLinks: number }> {
	const sourceSession = candidate.session.path;
	const destSession = candidate.destinationPath;
	const legacyDestSession = destSession.endsWith(".gz") ? destSession.slice(0, -".gz".length) : `${destSession}.gz`;
	const sourceArtifacts = sessionArtifactsPath(sourceSession);
	const destArtifacts = sessionArtifactsPath(destSession);
	if (await pathExists(legacyDestSession)) throw new Error(`archive destination exists: ${legacyDestSession}`);
	const alreadyArchived = (await pathExists(destSession)) && (await archiveAlreadyHolds(sourceSession, destSession));
	if ((await pathExists(destSession)) && !alreadyArchived) {
		throw new Error(`archive destination holds a different session: ${destSession}`);
	}

	const moved: Array<{ source: string; destination: string; compressed?: boolean }> = [];
	let orphanedTarget: string | undefined;
	let brokenLinks = 0;
	try {
		if (alreadyArchived) {
			// The archive is verified identical, so dropping the transcript only
			// finishes what the killed run had already proved safe.
			const link = await fs.lstat(sourceSession).catch(() => undefined);
			orphanedTarget = link?.isSymbolicLink() ? await fs.realpath(sourceSession).catch(() => undefined) : undefined;
			await fs.unlink(sourceSession);
		} else {
			orphanedTarget = (await gzipSessionFile(sourceSession, destSession)).orphanedTarget;
		}
		moved.push({ source: sourceSession, destination: destSession, compressed: true });
		if (await pathExists(sourceArtifacts)) {
			brokenLinks = (await moveArtifactsTree(sourceArtifacts, destArtifacts)).brokenLinks;
			moved.push({ source: sourceArtifacts, destination: destArtifacts });
		}
	} catch (error) {
		for (const move of moved.reverse()) {
			try {
				if (move.compressed) {
					await restoreGzipSessionFile(move.destination, move.source);
				} else {
					await movePath(move.destination, move.source);
				}
			} catch {
				// Preserve the original failure; rollback failure is reported by the next scan.
			}
		}
		throw error;
	}
	return { orphanedTarget, brokenLinks };
}

function sqliteNumber(value: number | bigint | null | undefined): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	return 0;
}

/**
 * Staging temps ({@link SESSION_STAGING_RE}) anywhere under `sessionsRoot`,
 * plus those beside exact session files recorded elsewhere (`--session`
 * paths, collab replicas). A transcript is not the only file published this
 * way: restoring an archived session stages every artifact it brings back,
 * and a killed run leaves those behind too.
 */
async function collectSessionStagingFiles(sessionsRoot: string, exactSessionFiles: string[]): Promise<string[]> {
	const files = new Map<string, string>();
	try {
		for await (const name of SESSION_STAGING_GLOB.scan({ cwd: sessionsRoot, dot: true })) {
			if (!SESSION_STAGING_RE.test(path.basename(name))) continue;
			const file = path.join(sessionsRoot, name);
			files.set(normalizePathForComparison(file), file);
		}
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
	for (const sessionFile of exactSessionFiles) {
		const target = path.basename(sessionFile);
		for (const file of await listFilesIfPresent(path.dirname(sessionFile))) {
			if (SESSION_STAGING_RE.exec(path.basename(file))?.[1] === target) {
				files.set(normalizePathForComparison(file), file);
			}
		}
	}
	return [...files.values()];
}

/**
 * Count, and with `--apply` delete, session staging temps past the write
 * grace. A live publish renames its temp away within milliseconds, so an
 * older one was left by a killed or crashed writer and nothing will claim it.
 */
async function sweepSessionStagingFiles(
	options: ResolvedGcOptions,
	sessionsRoot: string,
	registeredSessionPaths: string[],
	result: ArchiveGcResult,
): Promise<void> {
	const exactSessionFiles = [
		...registeredSessionPaths,
		...(await collectBreadcrumbSessionFiles(getTerminalSessionsDir(options.agentDir))),
	];
	const deleteBeforeMs = Date.now() - GC_WRITE_GRACE_MS;
	for (const file of await collectSessionStagingFiles(sessionsRoot, exactSessionFiles)) {
		const stat = await statIfPresent(file);
		if (!stat?.isFile() || stat.mtimeMs > deleteBeforeMs) continue;
		result.wouldDeleteTemps += 1;
		result.tempBytes += stat.size;
		if (!options.apply) continue;
		try {
			await fs.unlink(file);
			result.deletedTemps += 1;
		} catch (error) {
			if (codeOf(error) !== "ENOENT") result.errors.push(`${file}: ${errorMessage(error)}`);
		}
	}
}

async function runArchiveGc(
	options: ResolvedGcOptions,
	archiveRoot: string,
	registeredSessionPaths: string[],
): Promise<ArchiveGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const sessions = await listActiveSessions(sessionsRoot, options.track);
	const cutoffMs = Date.now() - options.coldArchiveAfterDays * DAY_MS;
	const result: ArchiveGcResult = {
		scanned: sessions.length,
		skippedActive: 0,
		keptNewestGlobal: 0,
		keptNewestPerCwd: 0,
		wouldArchive: 0,
		archived: 0,
		wouldDeleteTemps: 0,
		deletedTemps: 0,
		tempBytes: 0,
		brokenLinks: 0,
		orphanedTargets: [],
		errors: [],
	};
	const candidates: ArchiveCandidate[] = [];
	let inactiveSeen = 0;
	const inactiveSeenByCwd = new Map<string, number>();
	const archiveBeforeMs = Date.now() - GC_WRITE_GRACE_MS;

	for (const session of options.track.each("Scanning sessions to archive", sessions)) {
		if (session.status && ACTIVE_STATUSES.has(session.status)) {
			result.skippedActive += 1;
			continue;
		}
		if (session.modified.getTime() > archiveBeforeMs) {
			result.skippedActive += 1;
			continue;
		}
		if (await hasLiveNestedSessions(session, archiveBeforeMs)) {
			result.skippedActive += 1;
			continue;
		}
		const cwdKey = sessionCwdKey(sessionsRoot, session);
		const cwdSeen = inactiveSeenByCwd.get(cwdKey) ?? 0;
		const keepGlobal = inactiveSeen < options.retainNewestGlobal;
		const keepPerCwd = cwdSeen < options.retainNewestPerCwd;
		inactiveSeen += 1;
		inactiveSeenByCwd.set(cwdKey, cwdSeen + 1);
		if (keepGlobal) {
			result.keptNewestGlobal += 1;
			continue;
		}
		if (keepPerCwd) {
			result.keptNewestPerCwd += 1;
			continue;
		}
		if (options.coldArchiveAfterDays > 0 && session.modified.getTime() > cutoffMs) continue;
		const destination = archiveDestination(archiveRoot, sessionsRoot, session);
		if (!destination) continue;
		candidates.push({ ...destination, session });
	}

	// Before archiving moves transcripts away from the temps staged beside them.
	await sweepSessionStagingFiles(options, sessionsRoot, registeredSessionPaths, result);

	// An archived session keeps every row that describes it. Its prompt-history,
	// title and recap rows exist nowhere else, and its stats rows are only
	// re-derivable once the transcript is back in the sessions tree, so a
	// command that moves a session it is keeping must not delete them.
	for (const candidate of options.track.each("Archiving sessions", candidates)) {
		// A session a live process still owns is left alone, the way
		// `--compress` does it: the five-minute write grace alone would archive
		// a session under its writer and lose the turn it was about to append.
		// The dry run takes the lease too, so `wouldArchive` counts what
		// `--apply` would really take.
		let tree: { leases: FileLockHandle[]; transcripts: Set<string> } | null = null;
		try {
			tree = await tryAcquireSessionTreeLeases(
				candidate.session.path,
				await collectSessionFiles(candidate.session.path),
			);
			if (tree === null) {
				result.skippedActive += 1;
				continue;
			}
			result.wouldArchive += 1;
			if (!options.apply) continue;
			const { orphanedTarget, brokenLinks } = await moveSessionWithArtifacts(candidate);
			result.archived += 1;
			result.brokenLinks += brokenLinks;
			if (orphanedTarget) result.orphanedTargets.push(orphanedTarget);
		} catch (error) {
			result.errors.push(`${candidate.session.path}: ${errorMessage(error)}`);
		} finally {
			for (const held of tree?.leases ?? []) held.release();
		}
	}
	return result;
}

/** Every file of a session: its transcript plus its artifact tree (subagent transcripts, tool output). */
async function collectSessionFiles(transcript: string): Promise<string[]> {
	const artifactsDir = sessionArtifactsPath(transcript);
	const files = [transcript];
	try {
		for await (const name of ANY_FILE_GLOB.scan({ cwd: artifactsDir, dot: true, onlyFiles: true })) {
			if (isCompressScratchPath(name)) continue;
			files.push(path.join(artifactsDir, name));
		}
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
	return files;
}

/**
 * Session id in `file`'s header, or undefined when it has none. A file is
 * streamed only when its first byte past JSON whitespace opens a record (the
 * header or the title slot before it), or when its sampled prefix is all
 * whitespace; other binary and plain-text artifacts cost one small read.
 */
async function readArtifactSessionId(file: string): Promise<string | undefined> {
	const prefix = (await Bun.file(file).slice(0, HEADER_SNIFF_BYTES).text()).replace(/^[ \t\r\n]+/, "");
	if (prefix !== "" && prefix[0] !== "{") return undefined;
	return readSessionHeaderId(file, LOCAL_SESSION_FILES);
}

/**
 * Leases of every transcript in a session: its own and those nested in its
 * artifact tree (subagent sessions, or any file a process can open with
 * `--session`), found by their session header rather than their name. Each
 * session id is leased once, so a copied transcript that shares an id does
 * not read as live. Null, with every lease taken so far released, when any of
 * them is live or cannot be probed (an unknown owner counts as live).
 */
async function tryAcquireSessionTreeLeases(
	transcript: string,
	files: string[],
): Promise<{ leases: FileLockHandle[]; transcripts: Set<string> } | null> {
	const leases: FileLockHandle[] = [];
	const leasedIds = new Set<string>();
	const transcripts = new Set<string>([transcript]);
	for (const file of files) {
		let lease: FileLockHandle | null;
		try {
			const sessionId = await readArtifactSessionId(file);
			if (sessionId === undefined) continue;
			transcripts.add(file);
			if (leasedIds.has(sessionId)) continue;
			lease = tryAcquireSessionLease(sessionId);
			if (lease) leasedIds.add(sessionId);
		} catch (error) {
			if (codeOf(error) === "ENOENT") continue;
			lease = null;
		}
		if (lease === null) {
			for (const held of leases) held.release();
			return null;
		}
		leases.push(lease);
	}
	return { leases, transcripts };
}

/**
 * Store idle sessions compressed in place. A session qualifies once its
 * transcript is `compressAfterDays` old and no running process holds its
 * ownership lease; files written more recently than that are left alone.
 * Unlike archiving, an interrupted last turn does not exclude a session:
 * paths, bytes, and mtimes are unchanged and no history or stats rows are
 * deleted, so it stays resumable. Leftover scratch directories from a killed
 * run are removed first. A session that fails is reported and skipped.
 */
async function runCompressGc(options: ResolvedGcOptions, archiveRoot: string): Promise<CompressGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const method = await compressMethod(sessionsRoot);
	const result: CompressGcResult = {
		supported: method !== undefined,
		method,
		scanned: 0,
		skippedLive: 0,
		sessions: 0,
		wouldCompress: 0,
		compressed: 0,
		bytes: 0,
		allocatedBefore: 0,
		allocatedAfter: 0,
		leftoverScratchDirs: 0,
		errors: [],
	};
	if (method === undefined) return result;

	if (method === "apfs") {
		// Only the APFS copy-and-swap uses scratch directories. Archiving can carry a
		// leftover inside an artifact tree into the archive root.
		result.leftoverScratchDirs = await sweepCompressScratch(
			[sessionsRoot, archiveRoot],
			options.apply,
			result.errors,
		);
	}
	if (options.apply) {
		// Without it, a volume that ignores the request would still copy and verify every candidate.
		try {
			if (!(await compressionWorks(sessionsRoot, method))) {
				result.probeFailure = `${method} compression stored a compressible probe file uncompressed`;
				return result;
			}
		} catch (error) {
			result.errors.push(`compression probe: ${errorMessage(error)}`);
			return result;
		}
	}
	const transcripts = await collectTranscriptFiles(sessionsRoot);
	result.scanned = transcripts.length;
	const cutoffMs = Date.now() - Math.max(options.compressAfterDays * DAY_MS, GC_WRITE_GRACE_MS);
	for (const transcript of options.track.each("Scanning sessions to compress", transcripts)) {
		let files: string[];
		try {
			if (!(await isIdleTranscript(transcript, cutoffMs))) continue;
			files = await collectSessionFiles(transcript);
		} catch (error) {
			result.errors.push(`${transcript}: ${errorMessage(error)}`);
			continue;
		}
		const candidates: CompressCandidate[] = [];
		for (const file of files) {
			try {
				const candidate = await compressCandidate(file);
				if (candidate && candidate.mtimeMs <= cutoffMs) candidates.push(candidate);
			} catch (error) {
				if (codeOf(error) !== "ENOENT") result.errors.push(`${file}: ${errorMessage(error)}`);
			}
		}
		if (candidates.length === 0) continue;
		let tree: { leases: FileLockHandle[]; transcripts: Set<string> } | null = null;
		try {
			tree = await tryAcquireSessionTreeLeases(transcript, files);
			if (tree === null) {
				result.skippedLive += 1;
				continue;
			}
			result.sessions += 1;
			result.wouldCompress += candidates.length;
			for (const candidate of candidates) {
				result.bytes += candidate.bytes;
				result.allocatedBefore += candidate.allocated;
			}
			if (!options.apply) continue;
			const batch = await compressFilesInPlace(candidates, method, tree.transcripts);
			result.compressed += batch.compressed;
			result.allocatedAfter += batch.allocatedAfter;
			result.errors.push(...batch.errors);
		} catch (error) {
			result.errors.push(`${transcript}: ${errorMessage(error)}`);
		} finally {
			// Held through the rewrite so no omp process resumes the session mid-swap.
			for (const held of tree?.leases ?? []) held.release();
		}
	}
	return result;
}

/**
 * Plan stripping every transcript among `files` idle since `idleBeforeMs`
 * ({@link planStrip}). `isTranscript` vouches for files known to be
 * transcripts; any other file counts only with a session header.
 */
async function planStrips(
	files: string[],
	idleBeforeMs: number,
	isTranscript: (file: string) => boolean,
	errors: string[],
): Promise<StripPlan[]> {
	const plans: StripPlan[] = [];
	for (const file of files) {
		try {
			if (!isTranscript(file) && (await readArtifactSessionId(file)) === undefined) continue;
			const plan = await planStrip(file, idleBeforeMs);
			if (plan) plans.push(plan);
		} catch (error) {
			if (codeOf(error) !== "ENOENT") errors.push(`${file}: ${errorMessage(error)}`);
		}
	}
	return plans;
}

async function applyStripPlans(
	plans: StripPlan[],
	options: ResolvedGcOptions,
	storage: FileSessionStorage,
	result: StripGcResult,
): Promise<void> {
	for (const plan of plans) {
		result.wouldStrip += 1;
		result.records += plan.records;
		result.bytes += plan.bytes;
		if (!options.apply) continue;
		try {
			if (await applyStrip(plan, storage)) result.stripped += 1;
		} catch (error) {
			result.errors.push(`${plan.file}: ${errorMessage(error)}`);
		}
	}
}

/**
 * Strip provider replay data ({@link planStrip}) from every transcript idle for
 * `stripAfterDays`: active sessions with the subagent transcripts in their
 * artifact trees, then archived sessions. Leases are taken only for sessions
 * with replay data to strip: a session is skipped while a running process
 * holds the lease of any transcript in it, and its leases are held while its
 * transcripts are rewritten. A transcript that fails is reported and skipped.
 * Sessions, then archived transcripts, are processed {@link STRIP_CONCURRENCY}
 * at a time.
 */
async function runStripGc(options: ResolvedGcOptions, archiveRoot: string): Promise<StripGcResult> {
	const transcripts = await collectTranscriptFiles(getSessionsDir(options.agentDir));
	const idleBeforeMs = Date.now() - Math.max(options.stripAfterDays * DAY_MS, GC_WRITE_GRACE_MS);
	const result: StripGcResult = {
		scanned: transcripts.length,
		skippedLive: 0,
		wouldStrip: 0,
		stripped: 0,
		records: 0,
		bytes: 0,
		errors: [],
	};
	const storage = new FileSessionStorage();
	const verb = options.apply ? "Stripping" : "Scanning";
	const pool = {
		concurrency: STRIP_CONCURRENCY,
		detail: () =>
			`${options.apply ? `${result.stripped}/${result.wouldStrip} stripped` : `${result.wouldStrip} to strip`}, ${formatBytes(result.bytes)}`,
	};
	await options.track.pool(`${verb} sessions`, transcripts, pool, async transcript => {
		let tree: { leases: FileLockHandle[]; transcripts: Set<string> } | null = null;
		try {
			if (!(await isIdleTranscript(transcript, idleBeforeMs))) return;
			const files = await collectSessionFiles(transcript);
			const plans = await planStrips(files, idleBeforeMs, file => file === transcript, result.errors);
			if (plans.length === 0) return;
			tree = await tryAcquireSessionTreeLeases(transcript, files);
			if (tree === null) {
				result.skippedLive += 1;
				return;
			}
			await applyStripPlans(plans, options, storage, result);
		} catch (error) {
			result.errors.push(`${transcript}: ${errorMessage(error)}`);
		} finally {
			for (const held of tree?.leases ?? []) held.release();
		}
	});

	const archived = [
		...(await collectCompressedJsonlFiles(archiveRoot)),
		...(await collectJsonlFiles(archiveRoot)),
	].filter(file => !isCompressScratchPath(path.relative(archiveRoot, file)));
	await options.track.pool(`${verb} archive`, archived, pool, async file => {
		const [plan] = await planStrips(
			[file],
			idleBeforeMs,
			name => name.endsWith(COMPRESSED_SESSION_SUFFIX),
			result.errors,
		);
		if (!plan) return;
		// Nothing resumes a gzipped archive; a plain transcript in an archived
		// artifact tree can still be opened by path.
		const lease = file.endsWith(COMPRESSED_SESSION_SUFFIX) ? undefined : await tryAcquireSessionFileLease(file);
		if (lease === null) {
			result.skippedLive += 1;
			return;
		}
		try {
			await applyStripPlans([plan], options, storage, result);
		} finally {
			lease?.release();
		}
	});
	return result;
}

async function checkpointWal(dbPath: string, apply: boolean): Promise<WalCheckpointResult> {
	const walPath = `${dbPath}-wal`;
	let walBytes = 0;
	try {
		walBytes = (await fs.stat(walPath)).size;
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
	const result: WalCheckpointResult = {
		dbPath,
		walBytes,
		wouldCheckpoint: walBytes > 0,
		checkpointed: false,
		busy: 0,
		log: 0,
		checkpointedFrames: 0,
	};
	if (!apply || !(await pathExists(dbPath))) return result;

	const db = new Database(dbPath);
	let checkpointAttempted = false;
	try {
		db.run("PRAGMA busy_timeout = 5000");
		using checkpointStmt = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
		const row = checkpointStmt.get() as WalCheckpointRow | null;
		checkpointAttempted = true;
		result.busy = sqliteNumber(row?.busy);
		result.log = sqliteNumber(row?.log);
		result.checkpointedFrames = sqliteNumber(row?.checkpointed);
	} finally {
		db.close();
	}
	try {
		result.walBytes = (await fs.stat(walPath)).size;
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
		result.walBytes = 0;
	}
	if (checkpointAttempted && (result.busy > 0 || result.walBytes > 0)) {
		throw new Error(`WAL checkpoint failed for ${dbPath}: busy=${result.busy}, walBytes=${result.walBytes}`);
	}
	result.checkpointed = checkpointAttempted;
	return result;
}

async function runWalGc(options: ResolvedGcOptions): Promise<WalGcResult> {
	const databases = await Promise.all(
		[getHistoryDbPath(options.agentDir), getModelDbPath(options.agentDir)].map(dbPath =>
			checkpointWal(dbPath, options.apply),
		),
	);
	return {
		databases,
		walBytes: databases.reduce((total, db) => total + db.walBytes, 0),
		wouldCheckpoint: databases.some(db => db.wouldCheckpoint),
		checkpointed: databases.some(db => db.checkpointed),
	};
}

function renderText(result: GcResult): string {
	const lines = [`GC ${result.apply ? "applied" : "dry-run"} (${result.agentDir})`];
	if (result.stale) {
		const stale = result.stale;
		lines.push(
			`stale: ${stale.deleted}/${stale.wouldDelete} entries, ${formatBytes(stale.bytes)} (${stale.danglingMarkers} session markers, ${stale.staleBreadcrumbs} breadcrumbs, ${stale.expiredReports} reports, ${stale.expiredReplicas} collab replicas)`,
		);
		if (stale.errors.length > 0) lines.push(`stale errors: ${stale.errors.length}`);
	}
	if (result.strip) {
		const strip = result.strip;
		lines.push(
			`strip: ${strip.stripped}/${strip.wouldStrip} transcripts, ${formatBytes(strip.bytes)} of replay data in ${strip.records} records`,
		);
		if (strip.skippedLive > 0) lines.push(`strip skipped live: ${strip.skippedLive}`);
		if (strip.errors.length > 0) lines.push(`strip errors: ${strip.errors.length}`);
	}
	if (result.blobs) {
		lines.push(
			`blobs: ${result.blobs.deleted}/${result.blobs.wouldDelete} files, ${formatBytes(result.blobs.bytes)}, ${result.blobs.referenced} refs`,
		);
		if (result.blobs.errors.length > 0) lines.push(`blob errors: ${result.blobs.errors.length}`);
	}
	if (result.archive) {
		lines.push(`sessions: ${result.archive.archived}/${result.archive.wouldArchive} archived`);
		for (const target of result.archive.orphanedTargets) {
			lines.push(`archived by content, its link target left in place: ${target}`);
		}
		if (result.archive.skippedActive > 0) lines.push(`sessions skipped active: ${result.archive.skippedActive}`);
		if (result.archive.wouldDeleteTemps > 0) {
			lines.push(
				`session staging temps: ${result.archive.deletedTemps}/${result.archive.wouldDeleteTemps} files, ${formatBytes(result.archive.tempBytes)}`,
			);
		}
		if (result.archive.brokenLinks > 0) {
			lines.push(`links inside artifact trees whose target was gone: ${result.archive.brokenLinks}`);
		}
		if (result.archive.errors.length > 0) lines.push(`session errors: ${result.archive.errors.length}`);
	}
	if (result.restore) {
		const restore = result.restore;
		if (restore.sessionPath) {
			const verb = result.apply ? "restored" : "would restore";
			const artifacts = restore.artifactsRestored ? " with its artifacts" : "";
			lines.push(`restore: ${verb} ${restore.archivePath} to ${restore.sessionPath}${artifacts}`);
		}
		for (const note of restore.notRestored) lines.push(`not restored: ${note}`);
		if (restore.errors.length > 0) lines.push(`restore errors: ${restore.errors.length}`);
	}
	if (result.compress) {
		const compress = result.compress;
		if (!compress.supported) {
			lines.push("compress: unsupported on this filesystem (APFS or NTFS only)");
		} else {
			if (compress.probeFailure !== undefined) {
				lines.push(`compress skipped: ${compress.probeFailure}`);
			} else {
				const after = result.apply ? `, ${formatBytes(compress.allocatedAfter)} after` : "";
				lines.push(
					`compress: ${compress.compressed}/${compress.wouldCompress} files in ${compress.sessions} sessions, ${formatBytes(compress.allocatedBefore)} on disk before${after}`,
				);
				if (compress.skippedLive > 0) lines.push(`compress skipped live: ${compress.skippedLive}`);
			}
			if (compress.leftoverScratchDirs > 0) {
				const verb = result.apply ? "removed" : "found";
				lines.push(`compress leftover scratch dirs ${verb}: ${compress.leftoverScratchDirs}`);
			}
			if (compress.errors.length > 0) lines.push(`compress errors: ${compress.errors.length}`);
		}
	}
	for (const refusal of result.refused ?? []) {
		lines.push(`${refusal.phase}: not run, ${refusal.reason}`);
	}
	if (result.wal) {
		const state = result.wal.checkpointed ? "checkpointed" : "checkpoint dry-run";
		lines.push(`wal: ${state}, ${formatBytes(result.wal.walBytes)} across ${result.wal.databases.length} dbs`);
	}
	// From the result, so text and JSON say the same thing from one source.
	for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);
	return `${lines.join("\n")}\n`;
}

/**
 * Bring one archived session back to the sessions tree, and say what coming
 * back does not include. A person should not have to reconstruct the original
 * path and run `gunzip` by hand — and a hand-run `gunzip -c … > …` truncates
 * its destination when the archive turns out to be short.
 */
async function runRestoreGc(options: ResolvedGcOptions, query: string): Promise<RestoreGcResult> {
	const result: RestoreGcResult = { query, bytes: 0, artifactsRestored: false, notRestored: [], errors: [] };
	let matches: string[];
	try {
		matches = isArchivedSessionPath(query)
			? [path.resolve(query)]
			: await findArchivedSessionFiles(query, options.agentDir);
	} catch (error) {
		result.errors.push(errorMessage(error));
		return result;
	}
	if (matches.length === 0) {
		const archived = await listArchivedSessionFiles(options.agentDir);
		result.errors.push(
			`no archived session matches "${query}" among ${archived.length} in ${getArchivedSessionsDir(options.agentDir)}`,
		);
		return result;
	}
	if (matches.length > 1) {
		result.errors.push(
			`"${query}" matches ${matches.length} archived sessions; name one of them:\n${matches.map(file => `  ${file}`).join("\n")}`,
		);
		return result;
	}
	const archiveFile = matches[0];
	if (!(await pathExists(archiveFile))) {
		result.errors.push(`no such archive file: ${archiveFile}`);
		return result;
	}
	result.archivePath = archiveFile;
	const sessionPath = liveSessionPathForArchive(archiveFile, options.agentDir);
	if (!options.apply) {
		// Say now what --apply would refuse, instead of promising a restore.
		if (!sessionPath) {
			result.errors.push(
				`"${archiveFile}" is not in ${getArchivedSessionsDir(options.agentDir)}; inflate it yourself with \`gunzip\``,
			);
			return result;
		}
		if (await pathExists(sessionPath)) {
			result.errors.push(`a session file already exists at ${sessionPath}; nothing would be restored`);
			return result;
		}
		try {
			// A dry run that cannot read the archive must say so, not promise a
			// restore that `--apply` then fails.
			await inflateArchivedBytes(archiveFile);
		} catch (error) {
			result.errors.push(`${archiveFile} cannot be read: ${errorMessage(error)}`);
			return result;
		}
		result.sessionPath = sessionPath;
		return result;
	}
	try {
		// This command already holds the gc lock for the whole run.
		const restored = await restoreArchivedSessionLocked(archiveFile, options.agentDir);
		result.sessionPath = restored.sessionPath;
		result.bytes = restored.bytes;
		result.artifactsRestored = restored.artifactsRestored;
		// An artifact tree left behind is a half-restored session, not a note.
		result.errors.push(...restored.notRestored.map(note => `could not restore ${note}`));
	} catch (error) {
		result.errors.push(errorMessage(error));
		return result;
	}
	// Facts about what a transcript can and cannot carry. This build deletes
	// no rows when it archives; an older one did, and only the stats rows of
	// those come back.
	result.notRestored.push(
		"prompt history, the session title and recaps: they are not in the transcript, so if an older `gc --archive` deleted this session's rows nothing rebuilds them",
		"stats rows: `omp stats` re-reads the restored transcript and puts them back",
	);
	return result;
}

/**
 * Put `text` on stderr and wait until the kernel has it.
 *
 * `process.stderr.write` returns false when the pipe is full and keeps the
 * bytes in a userspace buffer, so a run that carried straight on could
 * delete a blob and then be killed with the warning never delivered —
 * measured at one unlinked blob and zero warning bytes. Awaiting the drain
 * is what makes "before the deletion" a fact about the reader rather than
 * about the order of two statements.
 *
 * A write that fails is the same answer as a write that cannot finish:
 * nothing is deleted. `/dev/full` and a broken pipe already end the run
 * before the blob phase, and that is the behaviour being kept. Not a
 * closed descriptor 2, though: Bun replaces an inherited closed stderr
 * with `/dev/null` before any of this runs, so the write succeeds and the
 * run carries on — an operator who sends the warning to `/dev/null` is
 * suppressing a diagnostic on purpose, and this does not try to outvote
 * them.
 */
async function writeWarningBeforeDeleting(text: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	// `true` means the stream handed the bytes straight to the kernel:
	// nothing is queued, so there is nothing to wait for. `false` means they
	// are sitting in a userspace buffer, which is the case this exists for —
	// wait for the write callback, or for the drain that says the buffer has
	// emptied, whichever the host delivers.
	const accepted = process.stderr.write(text, error => (error ? reject(error) : resolve()));
	if (accepted) return;
	process.stderr.once("drain", resolve);
	process.stderr.once("error", reject);
	await promise;
}
/**
 * Phases that work only on session files on disk, and why each is unavailable
 * while sessions are rows in a key-indexed store (`session.storage: sql`).
 */
const DISK_ONLY_PHASE_REASONS = {
	archive:
		"archiving gzips session files on disk and judges which sessions are cold from those files, but this store keeps sessions as database rows that phase cannot see",
	compress:
		"compression rewrites session files on disk in place, but this store keeps sessions as database rows that phase cannot see",
	restore:
		"a restore writes the archived session back as a file in the sessions tree, but this store reads sessions from database rows",
} as const;

export async function runGcCommand(args: GcCommandArgs): Promise<GcResult> {
	const options = await resolveOptions(args);
	const archiveRoot = getArchivedSessionsDir(options.agentDir);
	if (options.restoreTarget !== undefined && options.explicitPhases.length > 0) {
		// Saying nothing about phases it dropped is how a command reports success
		// for work it never did.
		throw new Error(`--restore runs alone; drop ${options.explicitPhases.map(flag => `--${flag}`).join(" ")}`);
	}
	// Built outside the lock so a phase that throws after an earlier one
	// deleted something still has somewhere to say what was done.
	const next: GcResult = { agentDir: options.agentDir, apply: options.apply, lockPath: "" };
	const report = (): void => {
		process.stdout.write(options.json ? `${JSON.stringify(next, null, 2)}\n` : renderText(next));
	};
	try {
		await withGcLock(options.agentDir, async lockPath => {
			next.lockPath = lockPath;
			// Every phase that judges a session's liveness asks the configured
			// storage, never only the filesystem: under `session.storage: sql` a
			// session the files never show is still live.
			const storage =
				options.restoreTarget !== undefined ||
				options.runStale ||
				options.runBlobs ||
				options.runArchive ||
				options.runCompress
					? await resolveSessionStorage({
							settings: await Settings.loadReadOnly({ agentDir: options.agentDir }),
							env: process.env,
						})
					: undefined;
			const sessionsOnDisk = storage === undefined || storage instanceof FileSessionStorage;
			const refuse = (phase: GcRefusal["phase"], requested: boolean | undefined): void => {
				next.refused ??= [];
				next.refused.push({
					phase,
					requested: requested === true,
					reason: `unavailable with session.storage: sql: ${DISK_ONLY_PHASE_REASONS[phase]}`,
				});
			};
			// Stale cleanup may prune a missing first-save target's registry marker.
			const registeredSessionPaths =
				options.runArchive && sessionsOnDisk
					? await collectRegisteredSessionPaths(getCustomSessionFilesDir(options.agentDir))
					: [];
			// A restore runs alone: no sweep may race a session coming back.
			if (options.restoreTarget !== undefined) {
				if (sessionsOnDisk) next.restore = await runRestoreGc(options, options.restoreTarget);
				else refuse("restore", true);
				return next;
			}
			// Pruned collab replicas release their blobs to this run's sweep.
			if (options.runStale && storage) next.stale = await runStaleGc(options, storage);
			// Before archiving and compressing, which then store the stripped transcripts.
			if (options.runStrip) next.strip = await runStripGc(options, archiveRoot);
			if (options.runBlobs && storage) {
				// On the result, so the JSON route carries it too: the
				// renderer held the only copy and `--json` bypasses it.
				next.warnings = [...(next.warnings ?? []), `blobs: ${GC_BLOBS_WARNING}`];
				// And delivered *before* anything is deleted, which means
				// waiting for the write to drain rather than queueing it:
				// `write` returns false when the pipe is full, and the bytes
				// then sit in a buffer the process can be killed with — one
				// blob unlinked, zero warning bytes delivered. A warning
				// that arrives only when every later phase succeeds is a
				// receipt, and the reader who most needs it is the one whose
				// run then failed.
				if (options.apply) await writeWarningBeforeDeleting(`warning: blobs: ${GC_BLOBS_WARNING}\n`);
				next.blobs = await runBlobGc(options, archiveRoot, storage);
			}
			if (options.runArchive) {
				if (sessionsOnDisk) next.archive = await runArchiveGc(options, archiveRoot, registeredSessionPaths);
				else refuse("archive", args.flags.archive);
			}
			if (options.runCompress) {
				if (sessionsOnDisk) next.compress = await runCompressGc(options, archiveRoot);
				else refuse("compress", args.flags.compress);
			}
			if (options.runWal) next.wal = await runWalGc(options);
			return next;
		});
	} catch (error) {
		// What the run did before it failed, on the same stream and in the
		// same shape as a run that did not.
		report();
		throw error;
	}
	report();
	return next;
}
