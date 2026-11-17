import type * as nodeFs from "node:fs";

export interface EmbeddedAddonFile {
	variant: "modern" | "baseline" | "default";
	/** Basename of the extracted `.node` file. */
	filename: string;
	/** Decompressed addon size in bytes. */
	size: number;
	/** SHA-256 of the decompressed addon, hex; extraction writes no other bytes. */
	sha256: string;
	/** Embedded zstd frame holding the addon bytes. */
	zstdPath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	version: string;
	/**
	 * SHA-256 over every file's name and `sha256`, hex: the build's identity. Its first
	 * 12 digits name the extraction directory, `<natives dir>/<version>-<digest prefix>`.
	 */
	digest: string;
	files: EmbeddedAddonFile[];
}

export interface DetectCompiledBinaryInput {
	embeddedAddon: EmbeddedAddon | null | undefined;
	env: Record<string, string | undefined>;
	importMetaUrl: string | null | undefined;
}

export function detectCompiledBinary(input: DetectCompiledBinaryInput): boolean;


export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export interface ShouldStageNodeModulesAddonInput {
	platform: NodeJS.Platform | string;
	isCompiledBinary: boolean;
	nativeDir: string;
}

export function shouldStageNodeModulesAddon(input: ShouldStageNodeModulesAddonInput): boolean;

export interface ResolveLoaderCandidatesInput {
	addonFilenames: string[];
	isCompiledBinary: boolean;
	stageFromNodeModules?: boolean;
	nativeDir: string;
	leafPackageDir?: string | null;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export interface InitLoaderContextOverrides {
	nativeDir?: string;
	platform?: NodeJS.Platform | string;
	isCompiledBinary?: boolean;
	leafPackageDir?: string | null;
}

/**
 * The addons a native leaf package records in its package.json (`nativeAddons`), written
 * when the package is built by `scripts/gen-npm-packages.ts`.
 */
export interface PackageAddons {
	/** SHA-256 over every file's name and `sha256`, hex; names the staging directory. */
	digest: string;
	files: { filename: string; size: number; sha256: string }[];
}

export interface NativeLoaderContext {
	platformTag: string;
	packageVersion: string;
	nativeDir: string;
	leafPackageDir: string | null;
	/**
	 * This process's addon cache directory: `<nativesDir>/<version>-<digest prefix>` for a
	 * compiled binary with an embedded addon (the embedded manifest's digest) and for a
	 * Windows install that stages (its leaf package's digest), `<nativesDir>/<version>`
	 * otherwise.
	 */
	versionedDir: string;
	isCompiledBinary: boolean;
	/** A Windows `node_modules` install whose leaf package records its addons. */
	stageFromNodeModules: boolean;
	/** The addons staging copies; null when nothing is staged. */
	stagedAddons: PackageAddons | null;
	selectedVariant: "modern" | "baseline" | null;
	addonFilenames: string[];
	addonLabel: string;
	candidates: string[];
	isWorkspaceLoad: boolean;
	nativesDir: string;
}

export function initLoaderContext(overrides?: InitLoaderContextOverrides): NativeLoaderContext;

export interface CleanupStaleNativeVersionsInput {
	nativesDir: string;
	/** The cache directory this process loads from; never removed. */
	currentDir: string;
	/** `node:fs`; tests pass one that marks a directory used between cleanup's reads. */
	io?: typeof nodeFs;
}

/**
 * Remove the addon cache directories (`<version>` and `<version>-<digest prefix>`) in
 * `nativesDir` that no omp process has used for a day, other than `currentDir`; returns
 * the paths removed.
 */
export function cleanupStaleNativeVersions(input: CleanupStaleNativeVersionsInput): string[];

/** Create an addon cache directory and mark it used now. */
export function prepareNativeVersionDir(versionedDir: string): void;

/**
 * The `node:fs` calls that write an addon into the cache; the loader uses `node:fs`, and
 * tests pass one that records the calls.
 */
export type AddonFileIo = Pick<
	typeof nodeFs,
	"openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync" | "statSync" | "existsSync"
>;

export interface ExtractEmbeddedAddonsInput {
	files: EmbeddedAddonFile[];
	targetDir: string;
	io?: AddonFileIo;
}

/**
 * Decompress every manifest addon missing from `targetDir` or of the wrong size, check it
 * against its `size` and `sha256`, and write it durably (a synced temporary file renamed
 * into place, then the directory synced where the platform allows); returns the paths
 * written.
 */
export function extractEmbeddedAddons(input: ExtractEmbeddedAddonsInput): string[];

/**
 * On a Windows `node_modules` install, copy the leaf package's addons into `versionedDir`
 * (checked against `stagedAddons` and written as {@link extractEmbeddedAddons} writes),
 * reuse a copy of the recorded size, and mark the directory used. Returns the first staged
 * path in candidate order, or null; failures are appended to `errors`.
 */
export function maybeStageNodeModulesAddon(
	ctx: NativeLoaderContext,
	errors: string[],
	io?: AddonFileIo,
): string | null;

export interface SelectCpuVariantInput {
	arch: string;
	override: "modern" | "baseline" | null | undefined;
	env: Record<string, string | undefined>;
	detectAvx2: () => boolean;
}

export interface SelectCpuVariantResult {
	variant: "modern" | "baseline" | null;
	source: "non-x64" | "override" | "cache" | "detect";
	cacheEnvKey?: string;
	cacheEnvValue?: string;
}

export function selectCpuVariant(input: SelectCpuVariantInput): SelectCpuVariantResult;

export interface ValidateLoadedBindingsContext {
	isWorkspaceLoad: boolean;
	packageVersion: string;
}

export function validateLoadedBindings(
	ctx: ValidateLoadedBindingsContext,
	bindings: Record<string, unknown>,
	candidate: string,
): void;

/** Identity of the addon `loadNative()` returned, for missing-export diagnostics. */
export interface NativeAddonStatus {
	/** Absolute path of the loaded `.node`. */
	path: string;
	/** Release the loaded addon reports (post-link stamp or legacy sentinel), or `null` when unidentified. */
	version: string | null;
	/** `package.json#version` of the loader that loaded it. */
	packageVersion: string;
	/**
	 * True when the addon carries a different release than this package, or (on a workspace
	 * load) {@link NativeAddonStatus.builtFromOtherSources}.
	 */
	stale: boolean;
	/**
	 * True on a workspace load whose addon, of this release, was built from Rust sources other
	 * than the checkout's, as the build's `<addon>.sources.json` record shows. False without a
	 * record, and on every other load.
	 */
	builtFromOtherSources: boolean;
}

export interface DescribeLoadedAddonContext {
	packageVersion: string;
	isWorkspaceLoad: boolean;
	/** `<checkout>/packages/natives/native` on a workspace load. */
	nativeDir: string;
}

/** The identity `loadNative()` records for the addon it loaded from `candidate`. */
export function describeLoadedAddon(
	bindings: Record<string, unknown>,
	candidate: string,
	ctx: DescribeLoadedAddonContext,
): NativeAddonStatus;

/** The addon behind this process's exports; `null` before a successful load. */
export function nativeAddonStatus(): NativeAddonStatus | null;

/**
 * Stub for an export the addon does not provide: `undefined` on a current
 * addon, a throwing function on a stale one.
 */
export function missingNativeExport(
	symbolName: string,
	addon?: NativeAddonStatus | null,
): (() => never) | undefined;

/**
 * Stub for a class the addon does not provide: `undefined` on a current addon,
 * a class whose constructor throws on a stale one.
 */
export function missingNativeClass(
	symbolName: string,
	addon?: NativeAddonStatus | null,
): (new (...args: unknown[]) => never) | undefined;

/** Notice a workspace tree prints when its addon is from another release. */
export function staleWorkspaceAddonNotice(addon: NativeAddonStatus): string;

/**
 * Write {@link staleWorkspaceAddonNotice} once, from the main thread, and only
 * on a workspace load. The latch is per loaded copy of this module. Returns
 * whether this call wrote it.
 */
export function reportStaleWorkspaceAddon(
	ctx: { isWorkspaceLoad: boolean },
	addon: NativeAddonStatus,
	deps?: { write?: (text: string) => void; state?: { reported: boolean } },
): boolean;

/** Actionable text for {@link missingNativeExport}. */
export function missingNativeExportMessage(symbolName: string, addon?: NativeAddonStatus | null): string;

/**
 * Load the native addon. `io` (default `node:fs`) is used for the cache checks and writes:
 * extraction, staging, and the one retry of a cache file that vanished between the check that
 * found it and its load, as it does while cleanup in another process holds its directory renamed
 * away. Tests pass one that does that rename.
 */
export function loadNative(options?: { io?: typeof nodeFs }): Record<string, unknown>;
