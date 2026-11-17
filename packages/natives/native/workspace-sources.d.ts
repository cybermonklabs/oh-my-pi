/** What a Cargo build of the addon compiles, relative to the repository root. */
export const CARGO_SOURCE_ROOTS: readonly string[];

/** What a Bazel build of the addon compiles: the Cargo inputs plus the Bazel module, targets, settings and toolchains. */
export const BAZEL_SOURCE_ROOTS: readonly string[];

/** A checkout's sources under a build's roots, as a native build records them. */
export interface RustSources {
	/** The roots, relative to the repository root. */
	roots: string[];
	/** The checkout that built the addon: its real path, and its directory's device and inode. */
	checkout: { path: string; dev: string; ino: string };
	/**
	 * The source files, `/`-separated and sorted: under the roots, git's tracked and unignored
	 * files (or a throwaway listing's, or a walk's), and in each scanned directory the files its
	 * globs match, gitignored or not.
	 */
	files: string[];
	/**
	 * The listed files git did not track at build time. Their bytes must match; one may be
	 * missing only when the record is judged in another checkout.
	 */
	untracked: string[];
	/** Each listed file's content hash; never written to the record. */
	hashes: Record<string, string>;
	/** SHA-256 over each listed file's path, size and modification time, hex. */
	fingerprint: string;
	/** SHA-256 over each tracked file's path and content (a link's target, for a link), hex. */
	digest: string;
	/** Each untracked file's content hash. */
	untrackedHashes: Record<string, string>;
	/**
	 * The directories build scripts scan: each with its `cargo_build_script` globs (patterns
	 * relative to the repository root) and the modification times of it and its subdirectories.
	 */
	scanned: { dir: string; globs: { include: string[]; exclude: string[] }[]; dirs: Record<string, number> }[];
	/** Each package directory and whether it has a `build.rs`. */
	packages: { dir: string; buildScript: boolean }[];
}

/** A path for a temporary file next to `target`, unique to this process and thread. */
export function uniqueTempPath(target: string): string;

/** The checkout's sources under `roots` now, read before a build begins; lists and reads every source file. */
export function readRustSources(repoRoot: string, roots: readonly string[]): RustSources;

/**
 * The sources to record after the build: `before`, with `Cargo.lock` as the build left it
 * when it is the only listed file that changed; `before` itself when anything else changed.
 */
export function settleRustSources(repoRoot: string, before: RustSources): RustSources;

/** Where a native build records the sources of the addon at `addonPath` (`<addon>.sources.json`). */
export function addonSourcesStampPath(addonPath: string): string;

/**
 * Record that the addon at `addonPath`, as it is now on disk (its size and modification
 * time, set to the whole second), was built from `sources` with the settings `build`
 * (profile, features, flags), kept for diagnosis and never compared.
 */
export function writeAddonSourcesStamp(addonPath: string, sources: RustSources, build: Record<string, unknown>): void;

/** Give `toAddonPath`, a copy of `fromAddonPath`, the record of the addon it was copied from. */
export function copyAddonSourcesStamp(fromAddonPath: string, toAddonPath: string): void;

/**
 * Whether the addon at `addonPath` was built from the sources now in `repoRoot`;
 * `"unknown"` when no build record describes this addon file.
 */
export function addonSourcesState(addonPath: string, repoRoot: string): "current" | "other" | "unknown";
