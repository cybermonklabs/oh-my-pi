import type * as fs from "node:fs";

/**
 * The workspace loader's half of the record of a workspace addon's Rust sources, and what the
 * build's half (`scripts/rust-sources.ts`) shares with it.
 */

/** A `glob()` of a build script: its include and exclude patterns, relative to the repository root. */
export interface Glob {
	include: string[];
	exclude: string[];
}

/** The rule a record's kept state (`seen`) was kept under; a record that names another is not well formed. */
export const SEEN_STATE_VERSION: number;

/** The digest a record holds when a listed file moved while the build ran, which no tree matches. */
export const CHANGED_DURING_BUILD: string;

/** A path for a temporary file next to `target`, unique to this process and thread. */
export function uniqueTempPath(target: string): string;

/** The `lstat` of a path in the checkout, through the shared reader's calls. */
export function lstatSource(repoRoot: string, rel: string): fs.Stats | undefined;

/** Whether a build script's globs take in `rel`: one glob includes it and does not exclude it. */
export function globsMatch(globs: readonly Glob[], rel: string): boolean;

/** A directory's state as a scan keeps it: its modification time, change time and inode. */
export function directoryStamp(stat: fs.Stats): string;

/** A walk of a directory a build script scans, with no filter. */
export interface DirectoryScan {
	/** The state of the directory and of every directory below it ({@link directoryStamp}). */
	times: Record<string, string>;
	/** The directories whose times are too new to trust for the read. */
	racy: string[];
	/** Every file and link there. */
	files: string[];
}

/** Walk a directory a build script scans, for a read that began at `startedAt`. */
export function scanDirectory(repoRoot: string, dir: string, startedAt: number): DirectoryScan;

/** `times` as a record keeps them: a directory in `racy` gets a state no directory has. */
export function settledTimes(times: Record<string, string>, racy: readonly string[]): Record<string, string>;

/**
 * List a scanned directory again and compare the files its globs match now with those of
 * `files` (a record's, or a build's listing).
 */
export function listScannedAgain(
	repoRoot: string,
	entry: { dir: string; globs: Glob[] },
	files: readonly string[],
	startedAt: number,
): { same: boolean; now: DirectoryScan };

/**
 * Hash every listed file, and take the fingerprint of the state those bytes came from, or null
 * when a file changed during the read or has a time too new to trust. Throws when a regular file
 * cannot be opened.
 */
export function hashSources(
	repoRoot: string,
	files: readonly string[],
	startedAt: number,
): { hashes: Record<string, string>; stats: Record<string, string>; fingerprint: string | null };

/** The record's identities of a tree whose files hash to `hashes`: the tracked files' digest, and each untracked file's hash. */
export function identities(
	files: readonly string[],
	untracked: readonly string[],
	hashes: Record<string, string>,
): { digest: string; untrackedHashes: Record<string, string> };

/**
 * The id of the checkout at `repoRoot`, kept in its git directory (`omp-checkout-id`) and, with
 * `create`, made there when it has none: one id for every build of a checkout, also builds
 * that start at once. Null for a tree with no `.git` of its own, or a git directory that
 * cannot be written.
 */
export function checkoutId(repoRoot: string, create: boolean): string | null;

/** Where a native build records the sources of the addon at `addonPath` (`<addon>.sources.json`). */
export function addonSourcesStampPath(addonPath: string): string;

/** Write `stamp` as the record of the addon at `addonPath`, through a temporary file renamed into place. */
export function writeStamp(addonPath: string, stamp: unknown): void;

/**
 * Whether the checkout judging a record is the one that wrote it, as the cached verdict is keyed
 * by it: null when the record has no untracked file, for which it cannot matter.
 */
export function sameCheckoutKey(hasUntracked: boolean, recorded: string | null, current: string | null): boolean | null;

/**
 * Whether the addon at `addonPath` was built from the sources now in `repoRoot`;
 * `"unknown"` when no build record describes this addon file, or a listed regular file cannot
 * be opened.
 */
export function addonSourcesState(addonPath: string, repoRoot: string): "current" | "other" | "unknown";
