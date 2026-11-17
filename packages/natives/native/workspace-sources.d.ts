/** What a Cargo build of the addon compiles, relative to the repository root. */
export const CARGO_SOURCE_ROOTS: readonly string[];

/** What a Bazel build of the addon compiles: the Cargo inputs plus the Bazel module, targets, settings and toolchains. */
export const BAZEL_SOURCE_ROOTS: readonly string[];

/** A checkout's sources under a build's roots, as a native build records them. */
export interface RustSources {
	/** The roots, relative to the repository root. */
	roots: string[];
	/** SHA-256 over each source file's path, size and modification time, hex. */
	fingerprint: string;
	/** SHA-256 over each source file's path, size and bytes, hex. */
	digest: string;
}

/** The checkout's sources under `roots` now; reads every source file. */
export function readRustSources(repoRoot: string, roots: readonly string[]): RustSources;

/** Where a native build records the sources of the addon at `addonPath` (`<addon>.sources.json`). */
export function addonSourcesStampPath(addonPath: string): string;

/**
 * Record that the addon at `addonPath`, as it is now on disk (its size and modification
 * time), was built from `sources`, read before the build began, with the settings `build`
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
