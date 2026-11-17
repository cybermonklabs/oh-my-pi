import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Which Rust sources a workspace checkout's addon was built from.
 *
 * A workspace checkout loads the addon its own native build left in
 * `packages/natives/native/`, and skips release validation there, so an addon
 * built before the checkout's Rust sources changed would load as current: same
 * release, other code. The native build (`scripts/bazel-natives.ts`,
 * `scripts/build-bindings.ts`) records the sources it compiled next to the addon
 * (`<addon>.sources.json`), and the loader compares that record with the checkout
 * on a workspace load. Compiled binaries and package installs never read it.
 *
 * The sources are every file under the build's roots ({@link CARGO_SOURCE_ROOTS}
 * or {@link BAZEL_SOURCE_ROOTS}, named in the record), except `target`
 * directories and entries below a root whose name starts with a dot (editor
 * swap files, `.DS_Store`; no compiled input is one). Two identities are kept:
 * - the digest, SHA-256 over each file's path, size and bytes, which decides;
 * - the fingerprint, SHA-256 over each file's path, size and modification time,
 *   which stands for a digest already computed. A start reads the sizes and
 *   times; it reads the bytes only when the fingerprint is one it has not seen,
 *   and records the answer for the next start.
 * A file changed without a new size or modification time (a copy that keeps
 * both) is not seen, as git and cargo do not see it either. The record also
 * carries the build's settings (`build`: profile, features, flags) to explain an
 * addon; they are never compared.
 */

/** What a Cargo build of the addon compiles, relative to the repository root. */
export const CARGO_SOURCE_ROOTS = Object.freeze(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "crates"]);

/**
 * What a Bazel build of the addon compiles: the Cargo inputs (crate_universe
 * resolves third-party crates from them, and each crate's `BUILD.bazel` is under
 * `crates/`), the root targets, the module, the settings, the Bazel version, and
 * the toolchain and transition definitions under `bazel/`. `MODULE.bazel.lock`
 * is left out: a build rewrites it after `MODULE.bazel` changes, which would make
 * every such build read as other sources, and it follows from `MODULE.bazel`.
 */
export const BAZEL_SOURCE_ROOTS = Object.freeze([
	...CARGO_SOURCE_ROOTS,
	"BUILD.bazel",
	"MODULE.bazel",
	".bazelrc",
	".bazelversion",
	".bazelignore",
	"bazel",
]);

/**
 * Every source file under `roots`, with its `/`-separated path relative to
 * `repoRoot`, in a fixed order: the roots in turn, each directory's entries
 * sorted by name.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 * @returns {{ rel: string; size: number; mtimeMs: number }[]}
 */
function listRustSources(repoRoot, roots) {
	const files = [];
	const visit = rel => {
		const stat = fs.statSync(path.join(repoRoot, rel), { throwIfNoEntry: false });
		if (!stat) return;
		if (stat.isFile()) {
			files.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
			return;
		}
		if (!stat.isDirectory()) return;
		for (const name of fs.readdirSync(path.join(repoRoot, rel)).sort()) {
			if (name.startsWith(".") || name === "target") continue;
			visit(`${rel}/${name}`);
		}
	};
	for (const root of roots) visit(root);
	return files;
}

/** @param {{ rel: string; size: number; mtimeMs: number }[]} files */
function fingerprintOf(files) {
	return new Bun.CryptoHasher("sha256")
		.update(files.map(file => `${file.rel}\0${file.size}\0${file.mtimeMs}\n`).join(""))
		.digest("hex");
}

/**
 * @param {string} repoRoot
 * @param {{ rel: string; size: number }[]} files
 */
function digestOf(repoRoot, files) {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const file of files) {
		const bytes = fs.readFileSync(path.join(repoRoot, file.rel));
		hasher.update(`${file.rel}\0${bytes.length}\0`).update(bytes);
	}
	return hasher.digest("hex");
}

/**
 * The checkout's sources under `roots` now, as a native build records them.
 * Reads every source file.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 * @returns {{ roots: string[]; fingerprint: string; digest: string }}
 */
export function readRustSources(repoRoot, roots) {
	const files = listRustSources(repoRoot, roots);
	return { roots: [...roots], fingerprint: fingerprintOf(files), digest: digestOf(repoRoot, files) };
}

/**
 * Where a native build records the sources of the addon at `addonPath`.
 * @param {string} addonPath
 */
export function addonSourcesStampPath(addonPath) {
	return `${addonPath}.sources.json`;
}

/**
 * @param {string} addonPath
 * @param {unknown} stamp
 */
function writeStamp(addonPath, stamp) {
	const stampPath = addonSourcesStampPath(addonPath);
	const tempPath = `${stampPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(stamp)}\n`);
		fs.renameSync(tempPath, stampPath);
	} catch (err) {
		fs.rmSync(tempPath, { force: true });
		throw err;
	}
}

/**
 * @param {string} addonPath
 * @returns {{ size: number; mtimeMs: number }}
 */
function addonIdentity(addonPath) {
	const addon = fs.statSync(addonPath);
	return { size: addon.size, mtimeMs: addon.mtimeMs };
}

/**
 * Record that the addon at `addonPath`, as it is now on disk, was built from
 * `sources` (read with {@link readRustSources} before the build began, so an
 * edit made during the build reads as other sources, never as current) with the
 * settings `build`, kept for diagnosis only. The record names the addon file by
 * its size and modification time, so an addon put there later by anything else
 * is not taken for this one.
 * @param {string} addonPath
 * @param {{ roots: string[]; fingerprint: string; digest: string }} sources
 * @param {Record<string, unknown>} build
 */
export function writeAddonSourcesStamp(addonPath, sources, build) {
	writeStamp(addonPath, {
		addon: addonIdentity(addonPath),
		roots: sources.roots,
		sources: sources.digest,
		seen: { fingerprint: sources.fingerprint, sources: sources.digest },
		build,
	});
}

/**
 * Give `toAddonPath`, a copy of `fromAddonPath`, the record of the addon it was
 * copied from, naming the copy's own size and modification time.
 * @param {string} fromAddonPath
 * @param {string} toAddonPath
 */
export function copyAddonSourcesStamp(fromAddonPath, toAddonPath) {
	const record = JSON.parse(fs.readFileSync(addonSourcesStampPath(fromAddonPath), "utf8"));
	writeStamp(toAddonPath, { ...record, addon: addonIdentity(toAddonPath) });
}

/**
 * Roots a record may name: non-empty paths inside the checkout.
 * @param {unknown} roots
 * @returns {roots is string[]}
 */
function isCheckoutRoots(roots) {
	return (
		Array.isArray(roots) &&
		roots.length > 0 &&
		roots.every(
			root =>
				typeof root === "string" && root !== "" && !path.isAbsolute(root) && !root.split(/[\\/]/).includes(".."),
		)
	);
}

/**
 * Whether the addon at `addonPath` was built from the sources now in the
 * checkout at `repoRoot`: `"current"`, `"other"`, or `"unknown"` when no build
 * record describes this addon file (an addon built before records existed, one
 * copied in from elsewhere, or an unreadable record). Reads the record, the
 * addon's size and time, and every source file's size and time; reads the
 * sources' bytes only for a state of the tree it has not seen, then records the
 * answer (best-effort) so the next start does not.
 * @param {string} addonPath
 * @param {string} repoRoot
 * @returns {"current" | "other" | "unknown"}
 */
export function addonSourcesState(addonPath, repoRoot) {
	try {
		const stamp = JSON.parse(fs.readFileSync(addonSourcesStampPath(addonPath), "utf8"));
		const addon = fs.statSync(addonPath);
		if (
			typeof stamp?.sources !== "string" ||
			typeof stamp.seen?.fingerprint !== "string" ||
			typeof stamp.seen.sources !== "string" ||
			!isCheckoutRoots(stamp.roots) ||
			stamp.addon?.size !== addon.size ||
			stamp.addon.mtimeMs !== addon.mtimeMs
		) {
			return "unknown";
		}
		const files = listRustSources(repoRoot, stamp.roots);
		if (files.length === 0) return "unknown";
		const fingerprint = fingerprintOf(files);
		let digest = stamp.seen.sources;
		if (fingerprint !== stamp.seen.fingerprint) {
			digest = digestOf(repoRoot, files);
			try {
				writeStamp(addonPath, { ...stamp, seen: { fingerprint, sources: digest } });
			} catch {
				// A checkout that cannot be written checks the bytes again next start.
			}
		}
		return digest === stamp.sources ? "current" : "other";
	} catch {
		return "unknown";
	}
}
