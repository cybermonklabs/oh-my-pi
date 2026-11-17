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
 * The record lists the source files the build had: under the build's roots
 * ({@link CARGO_SOURCE_ROOTS} or {@link BAZEL_SOURCE_ROOTS}), the files git
 * tracks or would track (ignored files left out), or, outside a git checkout,
 * every file there except `target` directories and names starting with a dot.
 * A start looks only at the listed files, so a file added later (an editor
 * backup, a new test, a cache) changes nothing, while a new module is seen
 * through the listed file that declares it. Symbolic links are recorded as links,
 * never followed. Two identities are kept:
 * - the digest, SHA-256 over each listed file's path and content (a link's
 *   target, for a link), which decides;
 * - the fingerprint, SHA-256 over each listed file's path, size and modification
 *   time, which stands for a digest already computed. A start reads the sizes and
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
 * Sources the build itself rewrites: Cargo updates `Cargo.lock` when a manifest's
 * dependencies changed, so the lock the build compiled against is the one it left.
 */
const REWRITTEN_BY_BUILD = new Set(["Cargo.lock"]);

/**
 * A path a temporary file next to `target` can take: unique to this process and
 * thread, whatever the clock says, so writers in worker threads of one process
 * never share it.
 * @param {string} target
 */
export function uniqueTempPath(target) {
	return `${target}.tmp.${process.pid}.${crypto.randomUUID()}`;
}

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function lstatSource(repoRoot, rel) {
	return fs.lstatSync(path.join(repoRoot, rel), { throwIfNoEntry: false });
}

/**
 * Every file and link a walk finds under `roots`, for a checkout git cannot list:
 * below a root, names starting with a dot and `target` directories are skipped,
 * and a link, to a directory or not, is an entry, never followed.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 * @returns {string[]}
 */
function walkSources(repoRoot, roots) {
	const files = [];
	const visit = rel => {
		const stat = lstatSource(repoRoot, rel);
		if (!stat) return;
		if (!stat.isDirectory()) {
			files.push(rel);
			return;
		}
		for (const name of fs.readdirSync(path.join(repoRoot, rel))) {
			if (name.startsWith(".") || name === "target") continue;
			visit(`${rel}/${name}`);
		}
	};
	for (const root of roots) visit(root);
	return files;
}

/**
 * The source files under `roots`, at build time, `/`-separated and sorted: git's
 * tracked and untracked-but-not-ignored files, or {@link walkSources} where git
 * cannot list the checkout (no git, or not a git checkout). Directories (a
 * submodule's entry) and listed files that no longer exist are left out.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 * @returns {string[]}
 */
function listBuildSources(repoRoot, roots) {
	let listed;
	try {
		const git = Bun.spawnSync(
			["git", "-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (git.exitCode === 0) listed = git.stdout.toString().split("\0").filter(Boolean);
	} catch {
		// No git on this machine.
	}
	return [...new Set(listed ?? walkSources(repoRoot, roots))]
		.filter(rel => {
			const stat = lstatSource(repoRoot, rel);
			return stat !== undefined && !stat.isDirectory();
		})
		.sort();
}

/**
 * @param {string} repoRoot
 * @param {readonly string[]} files
 */
function fingerprintOf(repoRoot, files) {
	return new Bun.CryptoHasher("sha256")
		.update(
			files
				.map(rel => {
					const stat = lstatSource(repoRoot, rel);
					return stat ? `${rel}\0${stat.size}\0${stat.mtimeMs}\n` : `${rel}\0missing\n`;
				})
				.join(""),
		)
		.digest("hex");
}

/**
 * SHA-256 of one source as the record identifies it: its bytes, a link's target,
 * or `missing`.
 * @param {string} repoRoot
 * @param {string} rel
 */
function hashSource(repoRoot, rel) {
	const stat = lstatSource(repoRoot, rel);
	if (!stat) return "missing";
	const hasher = new Bun.CryptoHasher("sha256");
	const file = path.join(repoRoot, rel);
	if (stat.isSymbolicLink()) hasher.update(`symlink\0${fs.readlinkSync(file)}`);
	else hasher.update(fs.readFileSync(file));
	return hasher.digest("hex");
}

/**
 * @param {readonly string[]} files
 * @param {Record<string, string>} hashes
 */
function digestOf(files, hashes) {
	return new Bun.CryptoHasher("sha256").update(files.map(rel => `${rel}\0${hashes[rel]}\n`).join("")).digest("hex");
}

/**
 * @param {string} repoRoot
 * @param {readonly string[]} files
 * @returns {Record<string, string>}
 */
function hashSources(repoRoot, files) {
	return Object.fromEntries(files.map(rel => [rel, hashSource(repoRoot, rel)]));
}

/**
 * The checkout's sources under `roots` now, as a native build records them, read
 * before the build begins. Lists the files once (one `git ls-files`) and reads
 * every one.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 * @returns {{ roots: string[]; files: string[]; fingerprint: string; digest: string; hashes: Record<string, string> }}
 */
export function readRustSources(repoRoot, roots) {
	const files = listBuildSources(repoRoot, roots);
	const hashes = hashSources(repoRoot, files);
	return { roots: [...roots], files, fingerprint: fingerprintOf(repoRoot, files), digest: digestOf(files, hashes), hashes };
}

/**
 * The sources to record once the build is done: `before` ({@link readRustSources}
 * before the build), except that a file the build itself rewrites
 * ({@link REWRITTEN_BY_BUILD}: `Cargo.lock`) takes the content the build left. If
 * any other listed file changed while the build ran, `before` stands, so the
 * addon reads as built from other sources until the next build.
 * @param {string} repoRoot
 * @param {ReturnType<typeof readRustSources>} before
 * @returns {ReturnType<typeof readRustSources>}
 */
export function settleRustSources(repoRoot, before) {
	const hashes = hashSources(repoRoot, before.files);
	const changed = before.files.filter(rel => hashes[rel] !== before.hashes[rel]);
	if (changed.length === 0 || !changed.every(rel => REWRITTEN_BY_BUILD.has(rel))) return before;
	return {
		...before,
		fingerprint: fingerprintOf(repoRoot, before.files),
		digest: digestOf(before.files, hashes),
		hashes,
	};
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
	const tempPath = uniqueTempPath(stampPath);
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(stamp)}\n`);
		fs.renameSync(tempPath, stampPath);
	} catch (err) {
		fs.rmSync(tempPath, { force: true });
		throw err;
	}
}

/**
 * The addon's identity in a record: its size and a whole-second modification time.
 * The time is set to the whole second first, because copies that keep times often
 * keep only seconds (a Docker layer `COPY`, tar), and the record must still name
 * the addon after one.
 * @param {string} addonPath
 * @returns {{ size: number; mtimeMs: number }}
 */
function addonIdentity(addonPath) {
	const before = fs.statSync(addonPath);
	if (before.mtimeMs % 1000 !== 0) fs.utimesSync(addonPath, before.atime, Math.floor(before.mtimeMs / 1000));
	const addon = fs.statSync(addonPath);
	return { size: addon.size, mtimeMs: addon.mtimeMs };
}

/**
 * Record that the addon at `addonPath`, as it is now on disk, was built from
 * `sources` ({@link readRustSources} before the build began, then
 * {@link settleRustSources}, so an edit made during the build reads as other
 * sources, never as current) with the settings `build`, kept for diagnosis only.
 * The record names the addon file by its size and modification time, so an addon
 * put there later by anything else is not taken for this one.
 * @param {string} addonPath
 * @param {{ roots: string[]; files: string[]; fingerprint: string; digest: string }} sources
 * @param {Record<string, unknown>} build
 */
export function writeAddonSourcesStamp(addonPath, sources, build) {
	writeStamp(addonPath, {
		addon: addonIdentity(addonPath),
		roots: sources.roots,
		files: sources.files,
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
 * Files a record may list: non-empty paths inside the checkout.
 * @param {unknown} files
 * @returns {files is string[]}
 */
function isCheckoutFileList(files) {
	return (
		Array.isArray(files) &&
		files.length > 0 &&
		files.every(
			rel => typeof rel === "string" && rel !== "" && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."),
		)
	);
}

/**
 * Whether the addon at `addonPath` was built from the sources now in the
 * checkout at `repoRoot`: `"current"`, `"other"`, or `"unknown"` when no build
 * record describes this addon file (an addon built before records existed, one
 * copied in from elsewhere, or an unreadable record). Reads the record, the
 * addon's size and time, and every listed file's size and time; reads the
 * listed files' bytes only for a state it has not seen, then records the answer
 * (best-effort) so the next start does not.
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
			!isCheckoutFileList(stamp.files) ||
			stamp.addon?.size !== addon.size ||
			stamp.addon.mtimeMs !== addon.mtimeMs
		) {
			return "unknown";
		}
		const fingerprint = fingerprintOf(repoRoot, stamp.files);
		let digest = stamp.seen.sources;
		if (fingerprint !== stamp.seen.fingerprint) {
			digest = digestOf(stamp.files, hashSources(repoRoot, stamp.files));
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
