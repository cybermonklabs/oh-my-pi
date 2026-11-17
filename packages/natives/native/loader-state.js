import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddon } from "./embedded-addon.js";
import { getNativesDir } from "./natives-dir.js";
import { bindingsHaveReleaseIdentity, bindingsReleaseVersion, containsVersionStamp } from "./version-sentinel.js";
import { addonSourcesStampPath, addonSourcesState, uniqueTempPath } from "./workspace-sources.js";

/**
 * Native addon loader for `@oh-my-pi/pi-natives`.
 *
 * Owns every step between "Node imports `native/index.js`" and "the right
 * `pi_natives.<platform>-<arch>*.node` is required, validated, and returned":
 * platform/variant detection, candidate-path resolution, on-disk staging from
 * `node_modules` (Windows update safety), embedded-addon extraction (Bun
 * standalone binaries), release-stamp validation, and the aggregated error
 * surface for diagnostic-friendly failures.
 *
 * `native/index.js` is reduced to one `loadNative()` call plus the generated
 * surface-area exports between `MARKER_START`/`MARKER_END` (rewritten by
 * `scripts/gen-enums.ts`); everything else lives here so the pure helpers stay
 * unit-testable without triggering the side-effectful module-load path.
 *
 * Background (issue #823): `bun build --compile --define PI_COMPILED=true`
 * substitutes the bare identifier `PI_COMPILED`, NOT `process.env.PI_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Older CommonJS loader
 * code also saw the original build-host absolute path in `__filename`; ESM
 * `import.meta.url` is rewritten to the bunfs URL. The embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */

const SUPPORTED_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
];

/**
 * Streaming startup marker, enabled by `PI_DEBUG_STARTUP`. Local copy of the
 * pi-utils helper (this loader cannot depend on pi-utils). Synchronous on
 * purpose: extraction/dlopen hangs must still leave the `:start` marker.
 * @param {string} text
 */
function startupMarker(text) {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}

function resolveLeafPackageDir(platformTag) {
	try {
		const require_ = createRequire(import.meta.url);
		return path.dirname(require_.resolve(`@oh-my-pi/pi-natives-${platformTag}/package.json`));
	} catch {
		return null;
	}
}

/**
 * The addons a native leaf package records in its package.json (`nativeAddons`,
 * written by `scripts/gen-npm-packages.ts` when the package is built): each one's
 * `filename`, `size` and `sha256`, and the set's `digest`. Null when the package
 * records none, records them in another shape, or its package.json cannot be
 * read: a leaf the loader cannot trust to name its addons is loaded where it is
 * installed.
 *
 * @param {string} packageDir
 * @returns {{ digest: string; files: { filename: string; size: number; sha256: string }[] } | null}
 */
function readPackageAddons(packageDir) {
	try {
		const { nativeAddons } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
		const hex = /^[0-9a-f]{64}$/;
		// The digest names a directory, so it must be the hex a build writes.
		if (
			hex.test(nativeAddons?.digest) &&
			Array.isArray(nativeAddons.files) &&
			nativeAddons.files.every(
				file =>
					typeof file?.filename === "string" &&
					Number.isSafeInteger(file.size) &&
					file.size >= 0 &&
					hex.test(file.sha256),
			)
		) {
			return nativeAddons;
		}
	} catch {
		// No package.json, or not JSON: nothing to stage.
	}
	return null;
}

// =========================================================================
// Pure helpers — re-exported for unit tests in `packages/natives/test/`.
// =========================================================================

/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
export function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.PI_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}
/**
 * @param {{ tag: string; arch: string; variant: "modern" | "baseline" | null | undefined }} input
 * @returns {string[]}
 */
export function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `pi_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `pi_natives.${tag}-baseline.node`;
	const modernFilename = `pi_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}

/**
 * Decide whether the loader should mirror the package's `native/<filename>.node`
 * into this install's cache directory (`<natives dir>/<version>-<digest prefix>/`,
 * named by the digest the leaf package records) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `omp`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@oh-my-pi/pi-natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Staging into the digest-named cache:
 *   1. Gives every install's addons their own filesystem path, so concurrent omp
 *      processes never collide on the same file.
 *   2. Makes the running process keep its handle on the cache copy, freeing bun
 *      to overwrite the `node_modules` copy on subsequent updates.
 * Disabled on non-Windows (no file-lock problem), in workspace dev (`nativeDir`
 * is not inside a `node_modules` segment), and for compiled binaries (handled
 * by `maybeExtractEmbeddedAddon`).
 *
 * @param {{ platform: NodeJS.Platform | string; isCompiledBinary: boolean; nativeDir: string }} input
 * @returns {boolean}
 */
export function shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir }) {
	if (platform !== "win32") return false;
	if (isCompiledBinary) return false;
	// Check both separators independently of the host's `path.sep`: this helper
	// is shared by the loader (running on Windows with `\`) and the test suite
	// (typically running on POSIX hosts when CI executes the regression test).
	const normalizedNativeDir = nativeDir.toLowerCase();
	return normalizedNativeDir.includes("\\node_modules\\") || normalizedNativeDir.includes("/node_modules/");
}

/**
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   stageFromNodeModules?: boolean;
 *   nativeDir: string;
 *   leafPackageDir?: string | null;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
export function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	stageFromNodeModules = false,
	nativeDir,
	leafPackageDir = null,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const leafCandidates = leafPackageDir ? addonFilenames.map(filename => path.join(leafPackageDir, filename)) : [];
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	const stagedCandidates = stageFromNodeModules ? addonFilenames.map(filename => path.join(versionedDir, filename)) : [];
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...stagedCandidates, ...leafCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = [...leafCandidates, ...baseReleaseCandidates];
	}
	return [...new Set(releaseCandidates)];
}

// =========================================================================

/**
 * Hex digits of the embedded addons' digest that name a compiled build's cache
 * directory, `<version>-<digest prefix>`: 48 bits, so two builds do not collide by
 * chance.
 */
const BUILD_DIGEST_PREFIX_LENGTH = 12;

/**
 * The names of addon cache directories: `<major.minor.patch>-<digest prefix>`, a
 * compiled build's or a Windows install's own, and `<major.minor.patch>`, where
 * loaders before addon digests extracted and staged. Every other entry
 * (`grammars`, prerelease names, files) is never cleaned up.
 */
const NATIVE_CACHE_DIR_NAME = new RegExp(`^\\d+\\.\\d+\\.\\d+(?:-[0-9a-f]{${BUILD_DIGEST_PREFIX_LENGTH}})?$`);

/**
 * A cache directory cleanup has claimed for removal (`.<name>.removing.<pid>.<uuid>`).
 * The leading dot keeps it out of {@link NATIVE_CACHE_DIR_NAME}, so no start reaches it.
 */
const CLAIMED_CACHE_DIR_NAME = /^\..+\.removing\.\d+\.[0-9a-f-]{36}$/;

// Every start marks the directory it loads from as used (`prepareNativeVersionDir`),
// and cleanup keeps each directory used within this window, whatever its version:
// two builds run in turn, of one release or of two, keep both their extracted
// addons instead of extracting one at each switch, and a directory a concurrent
// start is populating is never swept from under it. A build nobody has started
// for a day loses its directory and extracts again if it ever starts.
const NATIVE_CACHE_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Create an addon cache directory and mark it used now, before extraction or
 * staging begins. Recursive mkdir does not update the mtime of an existing
 * directory, so the explicit touch is what keeps a directory in use, or
 * partially populated, out of concurrent cleanup.
 *
 * @param {string} versionedDir
 */
export function prepareNativeVersionDir(versionedDir) {
	fs.mkdirSync(versionedDir, { recursive: true });
	const now = new Date();
	fs.utimesSync(versionedDir, now, now);
}

/**
 * Remove the addon cache directories no omp process has used for a day, other
 * than `currentDir`, the one this process loads from. Best-effort by design:
 * permission errors and concurrent processes must not abort startup after the
 * native addon has already loaded successfully.
 *
 * A start can mark a directory used just after this read its time, so a
 * directory is first renamed to a private name, which a start no longer reaches,
 * and its time read again: one marked used in between is renamed back, the rest
 * removed. Private names left by a cleanup that stopped half-way go once they too
 * are a day old. `io` is `node:fs`; tests pass one that marks a directory used
 * between the reads.
 *
 * @param {{ nativesDir: string; currentDir: string; io?: typeof fs }} input
 * @returns {string[]}
 */
export function cleanupStaleNativeVersions({ nativesDir, currentDir, io = fs }) {
	const removed = [];
	let entries;
	try {
		entries = io.readdirSync(nativesDir, { withFileTypes: true });
	} catch {
		return removed;
	}

	const stale = targetPath => Date.now() - io.statSync(targetPath).mtimeMs >= NATIVE_CACHE_RETENTION_MS;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const targetPath = path.join(nativesDir, entry.name);
		try {
			if (CLAIMED_CACHE_DIR_NAME.test(entry.name)) {
				if (stale(targetPath)) io.rmSync(targetPath, { recursive: true, force: true });
				continue;
			}
			if (!NATIVE_CACHE_DIR_NAME.test(entry.name) || targetPath === currentDir || !stale(targetPath)) continue;
			const claimed = path.join(nativesDir, `.${entry.name}.removing.${process.pid}.${crypto.randomUUID()}`);
			io.renameSync(targetPath, claimed);
			if (!stale(claimed)) {
				try {
					io.renameSync(claimed, targetPath);
				} catch {
					// A start made a new directory there meanwhile; the claimed copy is no one's now.
					io.rmSync(claimed, { recursive: true, force: true });
				}
				continue;
			}
			io.rmSync(claimed, { recursive: true, force: true });
			removed.push(targetPath);
		} catch {
			// Stale caches are opportunistic cleanup only.
		}
	}
	return removed;
}

// Side-effectful loader. Everything below runs only when `loadNative()` is
// called from `native/index.js` — tests that only import the pure helpers
// above pay nothing for variant detection, subprocess spawns, or fs probes.
// =========================================================================

/**
 * Hidden env key for the resolved x64 variant. Once any context (main thread,
 * worker, subprocess) finishes variant detection, the result is written here
 * so every Bun worker and child process spawned afterwards inherits the same
 * verdict and skips re-detection. See `selectCpuVariant` for the lookup order.
 */
const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";

/**
 * Spawn `command` with `args` and capture stdout. Prefers `Bun.spawnSync`
 * because Bun's `child_process.spawnSync` shim has been observed to return
 * non-zero / null in worker threads on macOS even when the same binary works
 * fine from the parent — the failure mode behind issue #3238, where the worker
 * silently falls back to the "baseline" variant. Falls back to the Node shim
 * for non-Bun embeds.
 */
function runCommand(command, args) {
	if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
		try {
			const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
			if (result.exitCode === 0) {
				return result.stdout.toString("utf-8").trim();
			}
		} catch {
			// fall through to childProcess
		}
	}
	try {
		const result = childProcess.spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) return null;
		if (result.status !== 0) return null;
		return (result.stdout || "").trim();
	} catch {
		return null;
	}
}

function getVariantOverride() {
	const value = process.env.PI_NATIVE_VARIANT;
	if (!value) return null;
	if (value === "modern" || value === "baseline") return value;
	return null;
}

function detectAvx2Support() {
	if (process.arch !== "x64") {
		return false;
	}

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		// Try the absolute path before bare `sysctl`: PATH may not include
		// `/usr/sbin` in worker/embedded spawn contexts (issue #3238).
		for (const sysctlBin of ["/usr/sbin/sysctl", "sysctl"]) {
			const leaf7 = runCommand(sysctlBin, ["-n", "machdep.cpu.leaf7_features"]);
			if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
			const features = runCommand(sysctlBin, ["-n", "machdep.cpu.features"]);
			if (features && /\bAVX2\b/i.test(features)) return true;
		}
		return false;
	}

	if (process.platform === "win32") {
		// Under Bun, ask the kernel: PF_AVX2_INSTRUCTIONS_AVAILABLE == 40. Exact,
		// and ~0.5 ms against ~270 ms for the PowerShell spawn it replaces on the
		// startup path.
		if (typeof Bun !== "undefined") {
			try {
				const { dlopen, FFIType } = createRequire(import.meta.url)("bun:ffi");
				const kernel32 = dlopen("kernel32.dll", {
					IsProcessorFeaturePresent: { args: [FFIType.u32], returns: FFIType.i32 },
				});
				try {
					return kernel32.symbols.IsProcessorFeaturePresent(40) !== 0;
				} finally {
					kernel32.close();
				}
			} catch {
				// No FFI (embedder policy, unusual host): fall through to the shell probe.
			}
		}
		// Node embeds have no `bun:ffi`. `[System.Runtime.Intrinsics.X86.Avx2]`
		// exists only on .NET Core, so `pwsh` (PowerShell 7) answers correctly
		// while a stock `powershell.exe` (Windows PowerShell 5.1, .NET Framework)
		// raises TypeNotFound and pins such hosts to the baseline addon.
		for (const shell of ["pwsh.exe", "powershell.exe"]) {
			const output = runCommand(shell, [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
			]);
			if (output && output.toLowerCase() === "true") return true;
			if (output && output.toLowerCase() === "false") return false;
		}
		return false;
	}

	return false;
}

/**
 * Pure variant-selection helper, exposed for unit tests. Resolution order:
 *
 *   1. `override` (user-facing `PI_NATIVE_VARIANT` env var). Always wins.
 *   2. The private `__PI_NATIVE_VARIANT_CACHE` env var, populated by the first
 *      context that detected at runtime. Lets child workers / subprocesses
 *      inherit the main thread's verdict instead of re-spawning `sysctl` etc.
 *      from a worker context where the spawn may fail (issue #3238).
 *   3. `detectAvx2()` — the slow path, called at most once per process.
 *
 * Non-x64 architectures return `{ variant: null }` and never set the cache.
 * When detection runs, the result is surfaced as `cacheEnvKey`/`cacheEnvValue`
 * so the caller can write `process.env` (the pure helper itself stays
 * side-effect-free, which keeps it easy to test).
 *
 * @param {{
 *   arch: string;
 *   override: "modern" | "baseline" | null | undefined;
 *   env: Record<string, string | undefined>;
 *   detectAvx2: () => boolean;
 * }} input
 * @returns {{
 *   variant: "modern" | "baseline" | null;
 *   source: "non-x64" | "override" | "cache" | "detect";
 *   cacheEnvKey?: string;
 *   cacheEnvValue?: string;
 * }}
 */
export function selectCpuVariant({ arch, override, env, detectAvx2 }) {
	if (arch !== "x64") return { variant: null, source: "non-x64" };
	if (override === "modern" || override === "baseline") {
		return { variant: override, source: "override" };
	}
	const cached = env[VARIANT_CACHE_ENV_KEY];
	if (cached === "modern" || cached === "baseline") {
		return { variant: cached, source: "cache" };
	}
	const variant = detectAvx2() ? "modern" : "baseline";
	return {
		variant,
		source: "detect",
		cacheEnvKey: VARIANT_CACHE_ENV_KEY,
		cacheEnvValue: variant,
	};
}

function resolveCpuVariant(override) {
	const result = selectCpuVariant({
		arch: process.arch,
		override,
		env: process.env,
		detectAvx2: detectAvx2Support,
	});
	if (result.cacheEnvKey) {
		process.env[result.cacheEnvKey] = result.cacheEnvValue;
	}
	return result.variant;
}

function selectEmbeddedAddonFile(selectedVariant) {
	if (!embeddedAddon) return null;
	const defaultFile = embeddedAddon.files.find(file => file.variant === "default") || null;
	if (process.arch !== "x64") return defaultFile || embeddedAddon.files[0] || null;
	if (selectedVariant === "modern") {
		return (
			embeddedAddon.files.find(file => file.variant === "modern") ||
			embeddedAddon.files.find(file => file.variant === "baseline") ||
			null
		);
	}
	return embeddedAddon.files.find(file => file.variant === "baseline") || null;
}

function isSafeEmbeddedAddonFilename(filename) {
	return filename.length > 0 && path.basename(filename) === filename && !filename.includes("/") && !filename.includes("\\");
}

/**
 * Whether `targetPath` already holds `file`, one addon of a set named by its
 * digest. The directory is that set's own (`<version>-<digest prefix>`), and the
 * loader puts a file in it only by renaming a copy whose SHA-256 it checked; so a
 * regular file of the declared size is that copy, and any other size is a
 * truncated file to replace. Hashing the file instead would read the whole addon
 * at every start.
 */
function isCachedAddonCurrent(targetPath, file, io) {
	try {
		const stat = io.statSync(targetPath);
		if (!stat.isFile()) return false;
		return stat.size === file.size;
	} catch (err) {
		if (err && err.code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Throw unless `content` has the size and SHA-256 its manifest records for `file`;
 * `kind` names the manifest (`Embedded`, `Staged`) in the error.
 */
function checkAddonBytes(kind, file, content) {
	if (content.length !== file.size) {
		throw new Error(`${kind} addon size mismatch for ${file.filename}: expected ${file.size}, got ${content.length}`);
	}
	const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex");
	if (digest !== file.sha256) {
		throw new Error(`${kind} addon digest mismatch for ${file.filename}: expected sha256 ${file.sha256}, got ${digest}`);
	}
}

/**
 * Write `content` to `targetPath` so that a file there is whole, even after a
 * crash: a temporary file synced to disk, renamed over the target, then the
 * directory synced so the rename survives too (not on Windows, which cannot open
 * a directory). `io` is `node:fs`; tests pass one that records the calls.
 */
function writeCachedAddon(targetPath, content, io) {
	try {
		writeCachedAddonOnce(targetPath, content, io);
	} catch (err) {
		// Cleanup can claim a directory a start marked used a moment before
		// (`cleanupStaleNativeVersions` renames it away, then back): write once
		// more into the directory there now.
		if (err?.code !== "ENOENT") throw err;
		prepareNativeVersionDir(path.dirname(targetPath));
		writeCachedAddonOnce(targetPath, content, io);
	}
}

/** @see writeCachedAddon */
function writeCachedAddonOnce(targetPath, content, io) {
	// Unique per write: worker threads share this process's pid, and may share its clock's millisecond.
	const tempPath = uniqueTempPath(targetPath);
	try {
		const fd = io.openSync(tempPath, "w", 0o755);
		try {
			io.writeFileSync(fd, content);
			io.fsyncSync(fd);
		} finally {
			io.closeSync(fd);
		}
		io.renameSync(tempPath, targetPath);
	} catch (err) {
		try {
			io.unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup only.
		}
		throw err;
	}
	if (process.platform === "win32") return;
	try {
		const dirFd = io.openSync(path.dirname(targetPath), "r");
		try {
			io.fsyncSync(dirFd);
		} finally {
			io.closeSync(dirFd);
		}
	} catch {
		// The file is whole and in place; a directory that cannot be synced only
		// leaves the rename to the file system's own schedule.
	}
}

export function extractEmbeddedAddons({ files, targetDir, io = fs }) {
	for (const file of files) {
		if (!isSafeEmbeddedAddonFilename(file.filename)) {
			throw new Error(`Unsafe embedded addon filename: ${file.filename}`);
		}
	}
	const writtenPaths = [];
	for (const file of files) {
		const targetPath = path.join(targetDir, file.filename);
		if (isCachedAddonCurrent(targetPath, file, io)) continue;
		const content = Bun.zstdDecompressSync(fs.readFileSync(file.zstdPath));
		checkAddonBytes("Embedded", file, content);
		writeCachedAddon(targetPath, content, io);
		writtenPaths.push(targetPath);
	}
	return writtenPaths;
}

function maybeExtractEmbeddedAddon(ctx, errors, file = selectEmbeddedAddonFile(ctx.selectedVariant), io = fs) {
	if (!ctx.isCompiledBinary || !embeddedAddon) return null;
	if (embeddedAddon.platformTag !== ctx.platformTag || embeddedAddon.version !== ctx.packageVersion) return null;
	if (!file) return null;
	const targetPath = path.join(ctx.versionedDir, file.filename);

	startupMarker("native:extractEmbeddedAddon:start");
	try {
		prepareNativeVersionDir(ctx.versionedDir);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon dir: ${message}`);
		return null;
	}

	try {
		extractEmbeddedAddons({ files: [file], targetDir: ctx.versionedDir, io });
		return targetPath;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon extraction (${file.filename}): ${message}`);
		return null;
	}
}

/**
 * On a Windows install, copy the addons the leaf package records
 * (`ctx.stagedAddons`, from its package.json) into `versionedDir`, named by the
 * digest the leaf records, so the running process holds its OS-level handle on
 * that copy, never on the `node_modules` one bun must overwrite on update. Each
 * copy is checked against the SHA-256 the leaf records and written durably; a
 * copy already there of the recorded size is reused. Every start marks the
 * directory used, so cleanup keeps it while this install runs. No-op on
 * non-Windows, in workspace dev, for compiled binaries, and for a leaf that
 * records no addons — see `shouldStageNodeModulesAddon` and `initLoaderContext`.
 */
export function maybeStageNodeModulesAddon(ctx, errors, io = fs) {
	if (!ctx.stageFromNodeModules) return null;
	try {
		prepareNativeVersionDir(ctx.versionedDir);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`staged addon dir: ${message}`);
		return null;
	}

	let stagedPath = null;
	for (const filename of ctx.addonFilenames) {
		const file = ctx.stagedAddons.files.find(entry => entry.filename === filename);
		if (!file) continue;
		const targetPath = path.join(ctx.versionedDir, filename);
		try {
			if (!isCachedAddonCurrent(targetPath, file, io)) {
				const content = fs.readFileSync(path.join(ctx.leafPackageDir, filename));
				checkAddonBytes("Staged", file, content);
				writeCachedAddon(targetPath, content, io);
			}
			stagedPath = stagedPath || targetPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon copy (${filename}): ${message}`);
		}
	}
	return stagedPath;
}

/**
 * Before release identities existed, published native addons still shared
 * this stable core ABI. Let those on-disk addons bridge a package-version bump
 * when they expose the signature; keep every identified addon and a current
 * on-disk file paired with resident old exports on the strict path below.
 */
function isCompatiblePreSentinelNativeAddon(bindings, diskHasExpectedStamp) {
	if (diskHasExpectedStamp) return false;
	if (bindingsHaveReleaseIdentity(bindings)) return false;
	return (
		typeof bindings.countTokens === "function" &&
		typeof bindings.executeShell === "function" &&
		typeof bindings.visibleWidth === "function" &&
		typeof bindings.DesktopSession === "function" &&
		typeof bindings.DesktopSession.prototype?.capture === "function" &&
		typeof bindings.DesktopSession.prototype?.execute === "function" &&
		typeof bindings.DesktopSession.prototype?.close === "function"
	);
}

export function validateLoadedBindings(ctx, bindings, candidate) {
	// In workspace dev (running out of `packages/natives/native/` rather than a
	// `node_modules` install or a compiled bundle) the local `.node` only gains
	// the new release stamp after `bun --cwd=packages/natives run build`. Skip
	// validation there so a stale post-pull dev tree boots while the rebuild
	// completes; install and compiled-binary paths still validate. The mismatch
	// is not swallowed silently: `native/index.js` exports `missingNativeExport`
	// for every symbol the stale addon predates, so the first call through one
	// reports the addon, both releases, and the rebuild command.
	if (ctx.isWorkspaceLoad) return;
	const residentVersion = bindingsReleaseVersion(bindings);
	if (residentVersion === ctx.packageVersion) return;

	// The bindings report another release (or none). Distinguish two failure
	// modes by what the file on disk carries:
	//   - disk stale: the `.node` on disk predates this loader (its own build);
	//     reinstalling re-syncs the file.
	//   - process stale: an in-place upgrade landed a new release on disk while
	//     this process still holds the previous addon generation resident in the
	//     dynamic-loader's native-module cache. `require` returns those old
	//     exports, which report the PRIOR release — disk is already consistent,
	//     so reinstall is a no-op and only restarting the process re-syncs.
	// Resident exports alone cannot tell these apart: `require` returns the
	// same exports in both cases. The restart diagnosis is valid only when the
	// selected file itself carries the current stamp; otherwise a restart would
	// simply reload stale disk.
	let diskHasExpectedStamp = false;
	try {
		diskHasExpectedStamp = containsVersionStamp(fs.readFileSync(candidate), ctx.packageVersion);
	} catch {
		// The successful require above normally guarantees readability. If the
		// file disappears concurrently, retain the safe reinstall diagnosis.
	}
	if (isCompatiblePreSentinelNativeAddon(bindings, diskHasExpectedStamp)) return;
	if (residentVersion && diskHasExpectedStamp) {
		throw new Error(
			`Loaded ${candidate}, which reports @oh-my-pi/pi-natives@${residentVersion}, but this loader is ` +
				`@${ctx.packageVersion}. omp was upgraded to ${ctx.packageVersion} while this session was running; ` +
				`the ${residentVersion} addon is still resident in this process. Disk is already consistent — ` +
				`restart omp to pick up ${ctx.packageVersion} (reinstalling changes nothing).`,
		);
	}
	throw new Error(
		`Loaded ${candidate} but it reports ${residentVersion ? `@oh-my-pi/pi-natives@${residentVersion}` : "no release version"}, ` +
			`not the @${ctx.packageVersion} this loader expects. The .node file on disk is from a different ` +
			"release than this loader — reinstall to re-sync.",
	);
}

/**
 * Identity of the addon `loadNative()` returned, in the shape the
 * missing-export diagnostic reports. Null until a load succeeds.
 * @type {{ path: string; version: string | null; packageVersion: string; stale: boolean; builtFromOtherSources: boolean } | null}
 */
let loadedAddon = null;

/**
 * Describe a loaded addon so a symbol it predates can name the file, the
 * release the file came from, and the release this tree expects.
 *
 * A workspace load also asks whether the addon of this release was built from
 * the checkout's own Rust sources (`workspace-sources.js`): the checkout skips
 * release validation, so an addon built before its Rust sources changed would
 * otherwise load as current. Only an addon whose build record names other
 * sources is stale; one without a record (built before records existed, or
 * copied in, as CI's prebuilt addons are) is not judged. Compiled binaries and
 * package installs never ask.
 * @param {Record<string, unknown>} bindings
 * @param {string} candidate
 * @param {{ packageVersion: string; isWorkspaceLoad: boolean; nativeDir: string }} ctx
 */
export function describeLoadedAddon(bindings, candidate, ctx) {
	const version = bindingsReleaseVersion(bindings);
	const otherRelease = version !== ctx.packageVersion;
	// `nativeDir` is `<checkout>/packages/natives/native` on a workspace load.
	const builtFromOtherSources =
		!otherRelease &&
		ctx.isWorkspaceLoad &&
		addonSourcesState(candidate, path.resolve(ctx.nativeDir, "..", "..", "..")) === "other";
	return {
		path: candidate,
		version,
		packageVersion: ctx.packageVersion,
		stale: otherRelease || builtFromOtherSources,
		builtFromOtherSources,
	};
}

/**
 * The addon behind this process's `@oh-my-pi/pi-natives` exports.
 * @returns {{ path: string; version: string | null; packageVersion: string; stale: boolean; builtFromOtherSources: boolean } | null}
 */
export function nativeAddonStatus() {
	return loadedAddon;
}

/**
 * Stand-in for an export the loaded addon does not provide.
 *
 * A workspace tree tolerates a release mismatch on purpose: a checkout that
 * pulled a new release keeps running until `bun run build:native` finishes
 * (see `validateLoadedBindings`), and PR CI loads release addons under a newer
 * checkout the same way. Such an addon has no value for any symbol added after
 * its build, so a bare `undefined` export surfaced as `<symbol> is not a
 * function` — every `write` call in a tree that pulled the read-projection
 * guard, for one — with nothing naming the stale addon.
 *
 * Only a stale addon gets the stub. On a current addon an absent export is not
 * version drift but a symbol this build does not implement, and callers probe
 * for exactly that (`typeof native.x === "function"`); they must keep seeing
 * `undefined`.
 * @param {string} symbolName
 * @param {ReturnType<typeof nativeAddonStatus>} [addon]
 * @returns {((...args: unknown[]) => never) | undefined}
 */
export function missingNativeExport(symbolName, addon = loadedAddon) {
	if (!addon?.stale) return undefined;
	return () => {
		throw new Error(missingNativeExportMessage(symbolName, addon));
	};
}

/**
 * Static reads a {@link missingNativeClass} stand-in answers normally rather
 * than throwing: the function-object intrinsics every caller and inspector
 * touches, and `then`, so an accidental `await` on the export resolves to the
 * class instead of exploding somewhere unrelated.
 */
const CLASS_STUB_PLAIN_STATICS = new Set(["prototype", "name", "length", "constructor", "then"]);

/**
 * Class counterpart of {@link missingNativeExport}: a stand-in that fails with
 * the addon's identity attached instead of as a bare `undefined` export, which
 * surfaces as `undefined is not a constructor` at the callsite and names
 * nothing.
 *
 * Same staleness rule as the function stub: only a stale addon gets a
 * stand-in, so `typeof native.Thing === "function"` capability probes against
 * a current addon keep their meaning.
 *
 * Several of these classes are entered through a static rather than a
 * constructor — `FileLock.tryAcquire`, `IpcServer.listen`, `Process.fromPid`,
 * `PowerAssertion.start` — so the stand-in answers any other static read with
 * the same diagnostic. Only a stale addon reaches it, and only for a class
 * that addon does not carry, so nothing on a healthy tree meets a proxy.
 * @param {string} symbolName
 * @param {ReturnType<typeof nativeAddonStatus>} [addon]
 * @returns {(new (...args: unknown[]) => never) | undefined}
 */
export function missingNativeClass(symbolName, addon = loadedAddon) {
	if (!addon?.stale) return undefined;
	const stub = class MissingNativeClass {
		constructor() {
			throw new Error(missingNativeExportMessage(symbolName, addon));
		}
	};
	return new Proxy(stub, {
		get(target, key, receiver) {
			if (typeof key === "symbol" || CLASS_STUB_PLAIN_STATICS.has(key)) return Reflect.get(target, key, receiver);
			throw new Error(missingNativeExportMessage(`${symbolName}.${key}`, addon));
		},
	});
}

/**
 * Actionable text for {@link missingNativeExport}. `addon` is injectable so the
 * wording can be pinned without a stale `.node` on disk.
 * @param {string} symbolName
 * @param {ReturnType<typeof nativeAddonStatus>} [addon]
 * @returns {string}
 */
export function missingNativeExportMessage(symbolName, addon = loadedAddon) {
	const rebuild = "rebuild it with `bun run build:native`";
	if (!addon) return `@oh-my-pi/pi-natives does not export \`${symbolName}\`; ${rebuild}.`;
	if (!addon.stale) {
		return `@oh-my-pi/pi-natives export \`${symbolName}\` is missing from ${addon.path}; ${rebuild}.`;
	}
	if (addon.builtFromOtherSources) {
		return (
			`@oh-my-pi/pi-natives export \`${symbolName}\` is missing: ${addon.path} was built from Rust sources ` +
			`other than this checkout's — ${rebuild}.`
		);
	}
	const loaded = addon.version
		? `the @oh-my-pi/pi-natives@${addon.version} addon`
		: "an addon without a release stamp";
	return (
		`@oh-my-pi/pi-natives export \`${symbolName}\` is missing: ${addon.path} is ${loaded}, not ` +
		`@${addon.packageVersion} — ${rebuild}.`
	);
}

/**
 * One-line notice for a workspace tree running an addon from another release,
 * or of this release built from other Rust sources than the checkout's.
 *
 * The missing-symbol stubs only speak when a caller touches a symbol the addon
 * does not carry. A symbol it does carry runs that build's behaviour — an
 * older shell, an older grep — with no marker at all, so this notice is the
 * only provenance those failures get.
 *
 * `stale` is any release or source difference, so the wording must not assume
 * the addon is the older side.
 * @param {NonNullable<ReturnType<typeof nativeAddonStatus>>} addon
 * @returns {string}
 */
export function staleWorkspaceAddonNotice(addon) {
	const loaded = addon.builtFromOtherSources
		? `${addon.path} was built from Rust sources other than this checkout's (its build recorded them in ` +
			`${addonSourcesStampPath(addon.path)}).`
		: `${addon.path} is ${addon.version ? `@oh-my-pi/pi-natives@${addon.version}` : "an addon without a release stamp"}, ` +
			`but this checkout is @${addon.packageVersion}.`;
	return (
		`[pi-natives] ${loaded} ` +
		"Symbols this checkout expects may be missing and shared ones may behave differently; " +
		"run `bun run build:native` before trusting results from this tree.\n"
	);
}

/**
 * Whether the copy of this module running on the current thread has already
 * written the mismatched-addon notice. One per loaded copy, which is one per
 * main thread in every shape this package ships; the write itself is confined
 * to the main thread by {@link onMainThread}.
 */
const staleNoticeState = { reported: false };

/** Memoized answer from {@link onMainThread}; `undefined` until first asked. */
let mainThreadAnswer;

/**
 * True on a process's main thread, false inside a worker thread.
 *
 * Resolved through `createRequire` on first use rather than imported at module
 * scope: `packages/coding-agent/src/cli.ts` keeps `node:worker_threads` out of
 * ordinary startup on purpose, and this module is reached statically from
 * `sqlite-locks` on launches that never load an addon. Asking only when a
 * mismatch has already been found keeps that boundary. A runtime without the
 * builtin answers "main thread", which is the safe side: the notice prints.
 * @returns {boolean}
 */
function onMainThread() {
	if (mainThreadAnswer === undefined) {
		try {
			mainThreadAnswer = createRequire(import.meta.url)("node:worker_threads").isMainThread !== false;
		} catch {
			mainThreadAnswer = true;
		}
	}
	return mainThreadAnswer;
}

/**
 * Write {@link staleWorkspaceAddonNotice} once, from the main thread, when a
 * workspace tree loads an addon of another release.
 *
 * Three guards, each load-bearing.
 *
 * Main thread only, because fd 2 is shared and a worker reaches `loadNative()`
 * long after interactive mode owns the terminal — the subagent, JS-eval and
 * tab workers all start then, so a per-worker write paints into a rendered
 * frame. The main thread has already said it at startup; a worker repeating it
 * adds nothing and costs the display. A worker *process* keeps the notice: it
 * has its own main thread, and `subprocess/worker-client.ts` captures its
 * stderr to a file rather than the terminal.
 *
 * Latched, because `loadNative()` is not a startup-only call: the lazy
 * entrypoints in `clipboard.js` and friends call it on every invocation.
 *
 * Workspace loads only, because {@link validateLoadedBindings} has a second
 * success path — it accepts a pre-sentinel addon on an installed load
 * (`isCompatiblePreSentinelNativeAddon`), which reports no release and so
 * counts as `stale`. That user has no repository to build.
 *
 * The write is a synchronous `fs.writeSync` to fd 2 for the same reason as
 * {@link startupMarker}: it must survive a crash that follows it. `write` and
 * `state` are injectable so a test can exercise the guards without consuming
 * this copy's latch.
 * @param {{ isWorkspaceLoad: boolean }} ctx
 * @param {NonNullable<ReturnType<typeof nativeAddonStatus>>} addon
 * @param {{ write?: (text: string) => void; state?: { reported: boolean } }} [deps]
 * @returns {boolean} whether this call wrote the notice
 */
export function reportStaleWorkspaceAddon(ctx, addon, deps = {}) {
	const state = deps.state ?? staleNoticeState;
	// Thread identity last: the three cheap gates reject every ordinary launch
	// before `node:worker_threads` is resolved at all.
	if (!ctx.isWorkspaceLoad || !addon.stale || state.reported || !onMainThread()) return false;
	state.reported = true;
	try {
		(deps.write ?? (text => fs.writeSync(2, text)))(staleWorkspaceAddonNotice(addon));
	} catch {
		// stderr unavailable; the notice is best-effort, the stubs still speak
	}
	return true;
}

/**
 * Install the addon's bounded Tokio runtime now that `dlopen` has returned and
 * the dynamic-loader lock is released. The Rust `#[module_init]` deliberately
 * does NOT build the runtime — spawning worker threads under the loader lock
 * deadlocks on some hosts — so it exposes `__ompInstallTokioRuntime` for the
 * loader to call once, before any async native runs. Best-effort: older addons
 * predating this export simply fall back to napi-rs's default runtime.
 */
function installNativeTokioRuntime(bindings) {
	const install = bindings.__ompInstallTokioRuntime;
	if (typeof install !== "function") return;
	try {
		install();
		startupMarker("native:tokioRuntime:installed");
	} catch (err) {
		startupMarker(`native:tokioRuntime:failed:${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Point the addon at `<nativesDir>/grammars`, where the agent downloads the
 * tree-sitter grammars that load as WebAssembly on demand (pi-utils
 * `getNativeGrammarsDir()` resolves the same path). Cache cleanup never
 * touches it: it removes only addon cache directories. Older addons
 * predating the export link every grammar and need no directory.
 */
function configureGrammarDir(bindings, nativesDir) {
	const setGrammarDir = bindings.__ompSetGrammarDir;
	if (typeof setGrammarDir === "function") setGrammarDir(path.join(nativesDir, "grammars"));
}


function buildHelpMessage(ctx) {
	if (ctx.isCompiledBinary) {
		const expectedPaths = ctx.addonFilenames.map(filename => `  ${path.join(ctx.versionedDir, filename)}`).join("\n");
		const downloadHints = ctx.addonFilenames
			.map(filename => {
				const downloadUrl = `https://github.com/can1357/oh-my-pi/releases/latest/download/${filename}`;
				const targetPath = path.join(ctx.versionedDir, filename);
				return `  curl -fsSL "${downloadUrl}" -o "${targetPath}"`;
			})
			.join("\n");
		return (
			`The compiled binary should extract one of:\n${expectedPaths}\n\n` +
			`If missing, delete ${ctx.versionedDir} and re-run, or download manually:\n${downloadHints}`
		);
	}
	return (
		"If installed via npm/bun, try reinstalling: bun install @oh-my-pi/pi-natives\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"Explicit targets: bun scripts/bazel-natives.ts <target> --dest packages/natives/native"
	);
}

/**
 * Initialize the loader context: resolves every path, variant, and policy
 * decision once so the inner load loop stays a pure require/validate pipeline.
 * Called from `loadNative()` rather than at module scope so importing pure
 * helpers from this file doesn't trigger AVX2 detection or filesystem probes.
 */
/**
 * @param {{ nativeDir?: string; platform?: NodeJS.Platform | string; isCompiledBinary?: boolean; leafPackageDir?: string | null }} [overrides]
 */
export function initLoaderContext(overrides = {}) {
	const platform = overrides.platform ?? process.platform;
	const platformTag = `${platform}-${process.arch}`;
	const packageVersion = packageJson.version;
	const nativeDir = overrides.nativeDir ?? path.join(import.meta.dir, "..", "native");
	const execDir = path.dirname(process.execPath);
	const nativesDir = getNativesDir();
	const userDataDir =
		platform === "win32"
			? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "omp")
			: path.join(os.homedir(), ".local", "bin");

	const isCompiledBinary =
		overrides.isCompiledBinary ??
		detectCompiledBinary({
			embeddedAddon,
			env: process.env,
			importMetaUrl: import.meta.url,
		});
	const normalizedNativeDir = platform === "win32" ? nativeDir.toLowerCase() : nativeDir;
	const isWorkspaceLoad =
		!isCompiledBinary &&
		!normalizedNativeDir.includes("\\node_modules\\") &&
		!normalizedNativeDir.includes("/node_modules/");
	const leafPackageDir =
		isCompiledBinary || isWorkspaceLoad
			? null
			: overrides.leafPackageDir === undefined
				? resolveLeafPackageDir(platformTag)
				: overrides.leafPackageDir;
	// A Windows install stages the addons its leaf package records, with their digest,
	// in its package.json; a leaf that records none is loaded where it is installed,
	// never from a directory another install could have filled.
	const stagedAddons =
		leafPackageDir && shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir: normalizedNativeDir })
			? readPackageAddons(leafPackageDir)
			: null;
	const stageFromNodeModules = stagedAddons !== null;
	// A compiled binary extracts, and a Windows install stages, into a directory named
	// by the digest of the addons it carries, computed when it was built
	// (`scripts/embed-native.ts`, `scripts/gen-npm-packages.ts`): every build of a
	// release carries one version, and only the digest tells two apart.
	const addonDigest = isCompiledBinary ? embeddedAddon?.digest : stagedAddons?.digest;
	const versionedDir = path.join(
		nativesDir,
		addonDigest ? `${packageVersion}-${addonDigest.slice(0, BUILD_DIGEST_PREFIX_LENGTH)}` : packageVersion,
	);

	const selectedVariant = resolveCpuVariant(getVariantOverride());
	const addonFilenames = getAddonFilenames({ tag: platformTag, arch: process.arch, variant: selectedVariant });
	const addonLabel = selectedVariant ? `${platformTag} (${selectedVariant})` : platformTag;

	const candidates = resolveLoaderCandidates({
		addonFilenames,
		isCompiledBinary,
		stageFromNodeModules,
		nativeDir,
		leafPackageDir,
		execDir,
		versionedDir,
		userDataDir,
	});

	// Release validation compares `__piNativesBuildVersion()` — the version the
	// build pipeline stamps into the addon after linking
	// (`scripts/stamp-native-version.ts`) — with `package.json#version`, so a
	// `.node` from a different release is rejected at load time instead of
	// surfacing later as a silent `<sym> is not a function` crash from a
	// Windows locked-file update.

	return {
		platformTag,
		packageVersion,
		nativeDir,
		leafPackageDir,
		versionedDir,
		isCompiledBinary,
		stageFromNodeModules,
		stagedAddons,
		selectedVariant,
		addonFilenames,
		addonLabel,
		candidates,
		isWorkspaceLoad,
		nativesDir,
	};
}

/**
 * Put back a file of this process's own cache directory that vanished between
 * the check that found it and its load: cleanup in another process renames a
 * stale directory away for a moment while it checks whether a start marked it
 * used (`cleanupStaleNativeVersions`). Extracting or staging again makes the
 * directory and writes the file, unless cleanup renamed the directory back
 * first. Returns whether `candidate` is there now.
 */
function restoreCachedAddon(ctx, errors, candidate, io) {
	const filename = path.basename(candidate);
	const embeddedFile = ctx.isCompiledBinary && embeddedAddon?.files.find(file => file.filename === filename);
	if (embeddedFile) maybeExtractEmbeddedAddon(ctx, errors, embeddedFile, io);
	else if (ctx.stageFromNodeModules) maybeStageNodeModulesAddon(ctx, errors, io);
	else return false;
	return io.existsSync(candidate);
}

/**
 * Load the native addon. `io` is `node:fs` for the cache checks and writes
 * (extraction, staging, the retry below); tests pass one that renames a cache
 * directory away between the check and the load, as a cleanup in another
 * process can.
 *
 * @param {{ io?: typeof fs }} [options]
 */
export function loadNative({ io = fs } = {}) {
	startupMarker("native:loadNative:start");
	const ctx = initLoaderContext();
	const require_ = createRequire(import.meta.url);

	const errors = [];
	const embeddedCandidate = maybeExtractEmbeddedAddon(ctx, errors, undefined, io);
	const stagedCandidate = embeddedCandidate ? null : maybeStageNodeModulesAddon(ctx, errors, io);
	const prepended = [embeddedCandidate, stagedCandidate].filter(c => typeof c === "string");
	const runtimeCandidates = prepended.length > 0 ? [...prepended, ...ctx.candidates] : ctx.candidates;
	const fallbackEmbeddedFile =
		ctx.selectedVariant === "modern" && embeddedAddon
			? embeddedAddon.files.find(file => file.variant === "baseline")
			: null;
	const fallbackEmbeddedPath = fallbackEmbeddedFile && path.join(ctx.versionedDir, fallbackEmbeddedFile.filename);
	const load = candidate => {
		startupMarker(`native:require:${path.basename(candidate)}`);
		const bindings = require_(candidate);
		validateLoadedBindings(ctx, bindings, candidate);
		installNativeTokioRuntime(bindings);
		configureGrammarDir(bindings, ctx.nativesDir);
		// The lazy entrypoints call `loadNative()` on every use, and the resident addon does
		// not change while the process runs, so it is described (its sources judged) once.
		if (loadedAddon?.path !== candidate) loadedAddon = describeLoadedAddon(bindings, candidate, ctx);
		reportStaleWorkspaceAddon(ctx, loadedAddon);
		cleanupStaleNativeVersions({ nativesDir: ctx.nativesDir, currentDir: ctx.versionedDir });
		startupMarker("native:loadNative:done");
		return bindings;
	};

	for (const candidate of runtimeCandidates) {
		if (fallbackEmbeddedFile && candidate === fallbackEmbeddedPath) {
			maybeExtractEmbeddedAddon(ctx, errors, fallbackEmbeddedFile, io);
		}
		try {
			return load(candidate);
		} catch (err) {
			let failure = err;
			// Once: a file of this process's cache directory that vanished since it was found.
			if (
				path.dirname(candidate) === ctx.versionedDir &&
				!io.existsSync(candidate) &&
				restoreCachedAddon(ctx, errors, candidate, io)
			) {
				try {
					return load(candidate);
				} catch (retryErr) {
					failure = retryErr;
				}
			}
			const message = failure instanceof Error ? failure.message : String(failure);
			errors.push(`${candidate}: ${message}`);
		}
	}

	if (!SUPPORTED_PLATFORMS.includes(ctx.platformTag)) {
		throw new Error(
			`Unsupported platform: ${ctx.platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}\n` +
				"If you need support for this platform, please open an issue.",
		);
	}
	const details = errors.map(error => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load pi_natives native addon for ${ctx.addonLabel}.\n\nTried:\n${details}\n\n${buildHelpMessage(ctx)}`,
	);
}
