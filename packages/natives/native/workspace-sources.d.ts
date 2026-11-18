/** What a Cargo build of the addon compiles, relative to the repository root. */
export const CARGO_SOURCE_ROOTS: readonly string[];

/** What a Bazel build of the addon compiles: the Cargo inputs plus the Bazel module, targets, settings and toolchains. */
export const BAZEL_SOURCE_ROOTS: readonly string[];

/** A checkout's sources under a build's roots, as a native build records them. */
export interface RustSources {
	/** The roots, relative to the repository root. */
	roots: string[];
	/**
	 * The checkout that built the addon: the id kept in its git directory (`omp-checkout-id`,
	 * made by its first build), or null for a tree with no `.git` of its own.
	 */
	checkout: string | null;
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
	/**
	 * SHA-256 over each listed file's path, size and modification time as the read of its bytes
	 * found them, hex; null when a file no longer matched that once all were read.
	 */
	fingerprint: string | null;
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

/**
 * The id of the checkout at `repoRoot`, kept in its git directory (`omp-checkout-id`) and, with
 * `create`, made there when it has none: one id for every build of a checkout, also builds
 * that start at once. Null for a tree with no `.git` of its own, or a git directory that
 * cannot be written.
 */
export function checkoutId(repoRoot: string, create: boolean): string | null;

/**
 * The checkout's sources under `roots` now, read before a build begins; lists and reads every
 * source file. Throws when a listed regular file cannot be opened.
 */
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
 * `"unknown"` when no build record describes this addon file, or a listed regular file cannot
 * be opened.
 */
export function addonSourcesState(addonPath: string, repoRoot: string): "current" | "other" | "unknown";
