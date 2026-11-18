import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readRegularFile, readRegularFileText } from "./regular-file.js";

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
 * ({@link CARGO_SOURCE_ROOTS} or {@link BAZEL_SOURCE_ROOTS}), the files git tracks
 * or would track, so a gitignored file is never a source. That listing is used
 * only in a repository whose top level is the tree; elsewhere (a Docker build
 * context, a tree with no `.git` inside another repository) the build lists
 * against a throwaway repository, so the tree's `.gitignore` files still apply;
 * only where git fails there too does it list every file, skipping `target`
 * directories and names starting with a dot. Symbolic links are recorded as
 * links, never followed.
 *
 * A start looks at the listed files, and at the two ways a build takes in a file
 * no listed file names:
 * - a directory a build script scans (`crates/pi-shell/build.rs` compiles every
 *   `src/minimizer/defs/*.toml`): the directories each crate's `BUILD.bazel`
 *   gives its `cargo_build_script` through a `glob()`, which Bazel requires and
 *   Cargo's `rerun-if-changed` matches. The record keeps each glob's patterns and
 *   lists the files there they match, gitignored or not, as Bazel gives them to
 *   the build script; it keeps the directories' modification times too. When one
 *   differs, the start lists that directory again, and a matched file added or
 *   removed there means other sources; a file the globs do not match (a README,
 *   a subdirectory, a swap file) changes nothing;
 * - a `build.rs` Cargo finds by itself in a package's directory: the record notes
 *   which packages have one.
 * Any other file added later (an editor backup, a new test, a cache) changes
 * nothing, and a new module is seen through the listed file that declares it.
 *
 * Files git did not track at build time (a new module not yet added, a local
 * cargo config) count: their bytes must match, and in the checkout that built
 * the addon one that moved or went away means other sources. Only in another
 * checkout of the commit, as robomp's cache and the image seed carry a record
 * between checkouts, is a missing one no difference. The record names its
 * checkout by an id the first build keeps in the checkout's git directory
 * (`omp-checkout-id`): it moves with the checkout (a `mv`, a bind mount, a dev
 * container), and a new checkout made where an old one was has none of its own.
 * Two identities are kept:
 * - the digest, SHA-256 over each tracked file's path and content (a link's
 *   target, for a link), and each untracked file's own SHA-256, which decide;
 * - the fingerprint, SHA-256 over each listed file's path, size and modification
 *   time, which stands for a verdict already reached, with whether the judging
 *   checkout is the record's (when it has an untracked file). A start reads the
 *   sizes and times; it reads the bytes only when the fingerprint, or the
 *   checkout, is one it has not seen, and records the verdict for the next start.
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
 * Run git with the caller's environment, less the variables that would point it
 * at another repository; its stdout, or null when it fails or cannot start.
 * @param {string[]} args
 * @returns {string | null}
 */
function runGit(args) {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
	try {
		const git = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
		return git.exitCode === 0 ? git.stdout.toString() : null;
	} catch {
		return null;
	}
}

/**
 * `git ls-files -t -z` output as paths and whether git tracks each.
 * @param {string} output
 */
function parseListing(output) {
	return output
		.split("\0")
		.filter(Boolean)
		.map(entry => ({ rel: entry.slice(2), tracked: !entry.startsWith("? ") }));
}

/**
 * Every file and link a walk finds under `roots`, for a machine without git:
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
 * Whether `repoRoot` is the top level of a git repository or worktree, not a
 * directory inside another one (`git rev-parse --show-toplevel`).
 * @param {string} repoRoot
 */
function isRepositoryRoot(repoRoot) {
	const top = runGit(["-C", repoRoot, "rev-parse", "--show-toplevel"])?.trim();
	if (!top) return false;
	try {
		return fs.realpathSync(top) === fs.realpathSync(repoRoot);
	} catch {
		return false;
	}
}

/**
 * The source files under `roots`, `/`-separated and sorted, and the ones among
 * them git does not track. In a repository whose top level is `repoRoot`: git's
 * tracked files and its untracked, unignored ones. Otherwise (a Docker build
 * context, a tree with no `.git` inside another repository), or when git fails in
 * the repository: git against a throwaway repository, as the Dockerfile's key step
 * does, so `.gitignore` still applies; every file then counts as tracked, since
 * nothing tells a source from a scratch file there. When git fails that way too,
 * or cannot run: {@link walkSources}. Directories (a submodule's entry) and listed
 * files that no longer exist are left out.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 * @returns {{ files: string[]; untracked: string[] }}
 */
function listBuildSources(repoRoot, roots) {
	const args = ["ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard", "--", ...roots];
	let entries;
	// Only the repository whose top level is this tree: a tree with no `.git` of its own
	// inside another repository is no checkout of that repository.
	const inRepository = isRepositoryRoot(repoRoot) ? runGit(["-C", repoRoot, ...args]) : null;
	if (inRepository !== null) entries = parseListing(inRepository);
	else {
		const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sources-git-"));
		try {
			if (runGit(["init", "-q", "--bare", gitDir]) !== null) {
				// Without a repository's index, a tree with no `.gitignore` for build output
				// would list it: leave out `target` directories, as a walk does.
				const throwaway = runGit([
					"--git-dir",
					gitDir,
					"--work-tree",
					repoRoot,
					"-C",
					repoRoot,
					...args,
					":(exclude,glob)**/target/**",
				]);
				if (throwaway !== null) entries = parseListing(throwaway).map(({ rel }) => ({ rel, tracked: true }));
			}
		} finally {
			fs.rmSync(gitDir, { recursive: true, force: true });
		}
	}
	entries ??= walkSources(repoRoot, roots).map(rel => ({ rel, tracked: true }));
	const kept = new Map();
	for (const { rel, tracked } of entries) {
		const stat = lstatSource(repoRoot, rel);
		if (stat && !stat.isDirectory()) kept.set(rel, (kept.get(rel) ?? false) || tracked);
	}
	const files = [...kept.keys()].sort();
	return { files, untracked: files.filter(rel => !kept.get(rel)) };
}

/**
 * The argument text of the call whose `(` ends just before `start`, comments
 * removed.
 * @param {string} text
 * @param {number} start
 */
function callArguments(text, start) {
	let depth = 1;
	let quote = "";
	let body = "";
	for (let i = start; i < text.length && depth > 0; i++) {
		const char = text[i];
		if (quote) {
			body += char;
			if (char === "\\") body += text[++i] ?? "";
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "#") {
			const end = text.indexOf("\n", i);
			i = end < 0 ? text.length : end - 1;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) break;
		body += char;
	}
	return body;
}

/**
 * The argument text of each top-level call to `name` in a Starlark file.
 * @param {string} text
 * @param {string} name
 */
function* starlarkCalls(text, name) {
	for (const match of text.matchAll(new RegExp(`(?:^|\\n)[ \\t]*${name}\\s*\\(`, "g"))) {
		yield callArguments(text, match.index + match[0].length);
	}
}

/** @param {string} list the text inside a Starlark list's brackets */
function stringsOf(list) {
	return [...list.matchAll(/["']([^"']+)["']/g)].map(([, value]) => value);
}

/**
 * Each `glob()` in `text`: its `include` patterns (the first list, positional or
 * `include = […]`) and its `exclude` patterns.
 * @param {string} text
 * @returns {Generator<{ include: string[]; exclude: string[] }>}
 */
function* globCalls(text) {
	for (const match of text.matchAll(/\bglob\s*\(/g)) {
		const args = callArguments(text, match.index + match[0].length);
		const excludeList = /\bexclude\s*=\s*\[([^\]]*)\]/.exec(args);
		const rest = excludeList ? args.replace(excludeList[0], "") : args;
		const includeList = /\[([^\]]*)\]/.exec(rest);
		yield { include: includeList ? stringsOf(includeList[1]) : [], exclude: excludeList ? stringsOf(excludeList[1]) : [] };
	}
}

/**
 * A Bazel glob pattern as a regular expression over `/`-separated paths: `*` and
 * `?` stay within one segment (and match a leading dot, as Bazel's do), and a
 * `**` segment matches any number of segments.
 * @param {string} pattern
 */
function globRegExp(pattern) {
	const segments = pattern.split("/");
	let source = "";
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1;
		if (segment === "**") {
			source += last ? ".*" : "(?:[^/]+/)*";
			return;
		}
		for (const char of segment) {
			if (char === "*") source += "[^/]*";
			else if (char === "?") source += "[^/]";
			else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
		if (!last) source += "/";
	});
	return new RegExp(`^${source}$`);
}

/**
 * Whether a build script's globs take in `rel`: one glob includes it and does not
 * exclude it.
 * @param {readonly { include: string[]; exclude: string[] }[]} globs
 * @param {string} rel
 */
function globsMatch(globs, rel) {
	return globs.some(
		glob =>
			glob.include.some(pattern => globRegExp(pattern).test(rel)) &&
			!glob.exclude.some(pattern => globRegExp(pattern).test(rel)),
	);
}

/**
 * The directories build scripts scan, with the globs that say which of their files
 * a build script takes in: for each listed `BUILD.bazel`, every `glob()` in its
 * `cargo_build_script` calls (patterns made relative to the repository root), each
 * pattern's directory being its part before the first segment with a wildcard.
 * Bazel gives a build script only the files its globs match, so those files, and
 * no others there, are what a build script can read; Cargo's `rerun-if-changed`
 * names the same directories.
 * @param {string} repoRoot
 * @param {readonly string[]} files
 * @returns {{ dir: string; globs: { include: string[]; exclude: string[] }[] }[]}
 */
function buildScriptScannedDirs(repoRoot, files) {
	const byDir = new Map();
	for (const rel of files) {
		if (path.posix.basename(rel) !== "BUILD.bazel") continue;
		// A `BUILD.bazel` that is not a regular file (a FIFO, say) has no globs to give.
		const text = readRegularFileText(path.join(repoRoot, rel));
		if (text === undefined) continue;
		const pkg = path.posix.dirname(rel);
		for (const call of starlarkCalls(text, "cargo_build_script")) {
			for (const glob of globCalls(call)) {
				const exclude = glob.exclude.map(pattern => path.posix.join(pkg, pattern));
				for (const pattern of glob.include) {
					const segments = pattern.split("/");
					const wildcard = segments.findIndex(segment => /[*?]/.test(segment));
					if (wildcard < 0) continue;
					const dir = path.posix.join(pkg, ...segments.slice(0, wildcard));
					if (!lstatSource(repoRoot, dir)?.isDirectory()) continue;
					if (!byDir.has(dir)) byDir.set(dir, []);
					byDir.get(dir).push({ include: [path.posix.join(pkg, pattern)], exclude });
				}
			}
		}
	}
	return [...byDir.keys()].sort().map(dir => ({ dir, globs: byDir.get(dir) }));
}

/**
 * Walk a directory a build script scans, with no filter: Bazel's `glob()` and a
 * Cargo `build.rs` both read every file there, gitignored, dot-named or not. A
 * link, to a directory or not, is an entry, never followed.
 * @param {string} repoRoot
 * @param {string} dir
 * @returns {{ times: Record<string, number>; files: string[] }} the modification
 *   time of `dir` and of every directory below it, and every file and link there
 */
function scanDirectory(repoRoot, dir) {
	const times = {};
	const files = [];
	const visit = rel => {
		const stat = lstatSource(repoRoot, rel);
		if (!stat) return;
		if (!stat.isDirectory()) {
			files.push(rel);
			return;
		}
		times[rel] = stat.mtimeMs;
		for (const name of fs.readdirSync(path.join(repoRoot, rel))) visit(`${rel}/${name}`);
	};
	visit(dir);
	return { times, files: files.sort() };
}

/**
 * Each package directory (one holding a listed `Cargo.toml`) and whether it has a
 * `build.rs`, which Cargo runs without any manifest naming it.
 * @param {string} repoRoot
 * @param {readonly string[]} files
 */
function packageBuildScripts(repoRoot, files) {
	return files
		.filter(rel => path.posix.basename(rel) === "Cargo.toml")
		.map(rel => {
			const dir = path.posix.dirname(rel);
			return { dir, buildScript: lstatSource(repoRoot, path.posix.join(dir, "build.rs")) !== undefined };
		});
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
 * SHA-256 of one source as the record identifies it: its bytes, a link's target, a file of
 * another kind (a FIFO, a socket, a device, a directory) by its kind alone, or `missing`. It
 * never blocks and never throws on what it finds: the file is read through
 * `readRegularFile`, which opens only a regular file, without following a link or waiting, and
 * names anything else, also a file swapped for another kind between its `lstat` and its `open`,
 * by what stands there.
 * @param {string} repoRoot
 * @param {string} rel
 */
function hashSource(repoRoot, rel) {
	const file = path.join(repoRoot, rel);
	const read = readRegularFile(file);
	if (read.kind === "missing") return "missing";
	const hasher = new Bun.CryptoHasher("sha256");
	if (read.kind === "file") {
		hasher.update(read.content);
	} else if (read.kind === "symlink") {
		let target;
		try {
			target = fs.readlinkSync(file);
		} catch {
			// Changed again since: no target to name.
		}
		hasher.update(target === undefined ? "special\0changed" : `symlink\0${target}`);
	} else {
		hasher.update(`special\0${read.kind}`);
	}
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
 * The record's identities of a tree whose files hash to `hashes`: the digest of
 * the tracked files, and each untracked file's own hash.
 * @param {readonly string[]} files
 * @param {readonly string[]} untracked
 * @param {Record<string, string>} hashes
 */
function identities(files, untracked, hashes) {
	const optional = new Set(untracked);
	return {
		digest: digestOf(
			files.filter(rel => !optional.has(rel)),
			hashes,
		),
		untrackedHashes: Object.fromEntries(untracked.map(rel => [rel, hashes[rel]])),
	};
}

/** The file, in a checkout's git directory, that names the checkout. */
const CHECKOUT_ID_FILE = "omp-checkout-id";

/**
 * The git directory of the checkout at `repoRoot`: its `.git` directory (also
 * through a link, as git follows one), or the one its `.git` file names
 * (`gitdir: …`, as a worktree's or a submodule's does), resolved as git resolves
 * it, against the checkout's real directory; undefined when `repoRoot` has no
 * `.git` of its own.
 * @param {string} repoRoot
 * @returns {string | undefined}
 */
function checkoutGitDir(repoRoot) {
	const dotGit = path.join(repoRoot, ".git");
	const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
	if (stat?.isDirectory()) return dotGit;
	if (!stat?.isFile()) return undefined;
	// Read through the link git follows, without blocking on what it may have become.
	const text = readRegularFileText(fs.realpathSync(dotGit));
	const named = text === undefined ? null : /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
	// A submodule's `gitdir: ../.git/modules/sub` reached through a link to it: the
	// `..` is the real parent's, not the link's.
	return named ? path.resolve(fs.realpathSync(repoRoot), named[1]) : undefined;
}

/**
 * The id of the checkout at `repoRoot`: a random UUID kept in its git directory
 * ({@link CHECKOUT_ID_FILE}), made there by the first build when `create` is set.
 * It moves with the checkout (a `mv`, a bind mount at another path, a dev
 * container), and a new checkout, even one made where an old one was, has none
 * of its own until it builds. Builds that start at once agree on one id: each
 * writes its id whole under a temporary name and links it into place, so the
 * file never exists empty, and a build that loses the race reads the winner's.
 * Null for a tree with no `.git` of its own (a Docker build context, an export),
 * and for a git directory that cannot be written: no record names it as its
 * checkout.
 * @param {string} repoRoot
 * @param {boolean} create
 * @returns {string | null}
 */
export function checkoutId(repoRoot, create) {
	let idPath;
	try {
		const gitDir = checkoutGitDir(repoRoot);
		if (!gitDir) return null;
		idPath = path.join(gitDir, CHECKOUT_ID_FILE);
	} catch {
		return null;
	}
	// An id file that is not a regular file (a FIFO, say) is no id, and is never opened.
	const read = () => {
		const id = readRegularFileText(idPath)?.trim();
		return id !== undefined && /^[0-9a-f-]{36}$/.test(id) ? id : null;
	};
	const existing = read();
	if (existing || !create) return existing;
	const temp = uniqueTempPath(idPath);
	try {
		fs.writeFileSync(temp, `${crypto.randomUUID()}\n`, { flag: "wx" });
		fs.linkSync(temp, idPath);
	} catch (err) {
		// Another build linked its id first, or the git directory cannot be written.
		if (err?.code !== "EEXIST") return null;
	} finally {
		fs.rmSync(temp, { force: true });
	}
	return read();
}

/**
 * The checkout's sources under `roots` now, as a native build records them, read
 * before the build begins. Lists the files once (one `git ls-files`), adds the
 * files of the directories build scripts scan that their globs match, gitignored
 * or not, as sources the build had, and reads every one.
 * @param {string} repoRoot
 * @param {readonly string[]} roots
 */
export function readRustSources(repoRoot, roots) {
	const listed = listBuildSources(repoRoot, roots);
	const scans = buildScriptScannedDirs(repoRoot, listed.files).map(({ dir, globs }) => {
		const scan = scanDirectory(repoRoot, dir);
		return { dir, globs, times: scan.times, files: scan.files.filter(rel => globsMatch(globs, rel)) };
	});
	const scannedFiles = new Set(scans.flatMap(scan => scan.files));
	const files = [...new Set([...listed.files, ...scannedFiles])].sort();
	// A scanned directory's matched files are compiled whether git tracks them or not.
	const untracked = listed.untracked.filter(rel => !scannedFiles.has(rel));
	const hashes = hashSources(repoRoot, files);
	return {
		roots: [...roots],
		checkout: checkoutId(repoRoot, true),
		files,
		untracked,
		hashes,
		fingerprint: fingerprintOf(repoRoot, files),
		...identities(files, untracked, hashes),
		scanned: scans.map(({ dir, globs, times }) => ({ dir, globs, dirs: times })),
		packages: packageBuildScripts(repoRoot, files),
	};
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
		hashes,
		fingerprint: fingerprintOf(repoRoot, before.files),
		...identities(before.files, before.untracked, hashes),
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
 * @param {ReturnType<typeof readRustSources>} sources
 * @param {Record<string, unknown>} build
 */
export function writeAddonSourcesStamp(addonPath, sources, build) {
	writeStamp(addonPath, {
		addon: addonIdentity(addonPath),
		roots: sources.roots,
		checkout: sources.checkout,
		files: sources.files,
		untracked: sources.untrackedHashes,
		sources: sources.digest,
		scanned: sources.scanned,
		packages: sources.packages,
		// The checkout that built the addon is the one judging it now.
		seen: {
			fingerprint: sources.fingerprint,
			sameCheckout: sameCheckoutKey(sources.untracked.length > 0, sources.checkout, sources.checkout),
			verdict: "current",
		},
		build,
	});
}

/**
 * Whether the checkout judging a record is the one that wrote it, as the cached
 * verdict is keyed by it: null when the record has no untracked file, for which
 * it cannot matter.
 * @param {boolean} hasUntracked
 * @param {string | null} recorded the record's checkout id
 * @param {string | null} current the judging checkout's id
 * @returns {boolean | null}
 */
function sameCheckoutKey(hasUntracked, recorded, current) {
	return hasUntracked ? recorded !== null && recorded === current : null;
}

/**
 * Give `toAddonPath`, a copy of `fromAddonPath`, the record of the addon it was
 * copied from, naming the copy's own size and modification time.
 * @param {string} fromAddonPath
 * @param {string} toAddonPath
 */
export function copyAddonSourcesStamp(fromAddonPath, toAddonPath) {
	const recordPath = addonSourcesStampPath(fromAddonPath);
	const text = readRegularFileText(recordPath);
	if (text === undefined) throw new Error(`${recordPath} is not a regular file`);
	writeStamp(toAddonPath, { ...JSON.parse(text), addon: addonIdentity(toAddonPath) });
}

/**
 * A path a record may name: non-empty and inside the checkout.
 * @param {unknown} rel
 * @returns {rel is string}
 */
function isCheckoutPath(rel) {
	return typeof rel === "string" && rel !== "" && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

/**
 * The record's shape, checked before a start trusts any of it.
 * @param {any} stamp
 */
function isWellFormedStamp(stamp) {
	const isTimes = dirs =>
		dirs !== null &&
		typeof dirs === "object" &&
		Object.entries(dirs).every(([rel, time]) => isCheckoutPath(rel) && typeof time === "number");
	const isPatterns = patterns => Array.isArray(patterns) && patterns.every(isCheckoutPath);
	const isGlobs = globs =>
		Array.isArray(globs) &&
		globs.length > 0 &&
		globs.every(glob => isPatterns(glob?.include) && glob.include.length > 0 && isPatterns(glob.exclude));
	return (
		typeof stamp?.sources === "string" &&
		typeof stamp.seen?.fingerprint === "string" &&
		(stamp.seen.verdict === "current" || stamp.seen.verdict === "other") &&
		(stamp.seen.sameCheckout === null || typeof stamp.seen.sameCheckout === "boolean") &&
		(stamp.checkout === null || (typeof stamp.checkout === "string" && /^[0-9a-f-]{36}$/.test(stamp.checkout))) &&
		Array.isArray(stamp.files) &&
		stamp.files.length > 0 &&
		stamp.files.every(isCheckoutPath) &&
		stamp.untracked !== null &&
		typeof stamp.untracked === "object" &&
		Object.entries(stamp.untracked).every(([rel, hash]) => isCheckoutPath(rel) && typeof hash === "string") &&
		Array.isArray(stamp.scanned) &&
		stamp.scanned.every(entry => isCheckoutPath(entry?.dir) && isGlobs(entry.globs) && isTimes(entry.dirs)) &&
		Array.isArray(stamp.packages) &&
		stamp.packages.every(entry => typeof entry?.dir === "string" && typeof entry.buildScript === "boolean") &&
		stamp.packages.every(entry => entry.dir === "." || isCheckoutPath(entry.dir))
	);
}

/**
 * Whether the addon at `addonPath` was built from the sources now in the
 * checkout at `repoRoot`: `"current"`, `"other"`, or `"unknown"` when no build
 * record describes this addon file (an addon built before records existed, one
 * copied in from elsewhere, or an unreadable record). Reads the record, the
 * addon's size and time, each package's `build.rs`, each scanned directory's time,
 * and every listed file's size and time. It lists a scanned directory again only
 * when its time changed, and reads the listed files' bytes only for a state it
 * has not seen; then it records what it learned (best-effort), so the next start
 * does neither.
 * @param {string} addonPath
 * @param {string} repoRoot
 * @returns {"current" | "other" | "unknown"}
 */
export function addonSourcesState(addonPath, repoRoot) {
	let stamp;
	try {
		// A record that is not a regular file (a FIFO, say) is no record, and is never opened.
		const text = readRegularFileText(addonSourcesStampPath(addonPath));
		if (text === undefined) return "unknown";
		stamp = JSON.parse(text);
		const addon = fs.statSync(addonPath);
		if (!isWellFormedStamp(stamp) || stamp.addon?.size !== addon.size || stamp.addon.mtimeMs !== addon.mtimeMs) {
			return "unknown";
		}
	} catch {
		return "unknown";
	}
	try {
		for (const { dir, buildScript } of stamp.packages) {
			if ((lstatSource(repoRoot, path.posix.join(dir, "build.rs")) !== undefined) !== buildScript) return "other";
		}
		let learned = false;
		const scanned = [];
		for (const entry of stamp.scanned) {
			const unchanged = Object.entries(entry.dirs).every(([rel, time]) => {
				const stat = lstatSource(repoRoot, rel);
				return stat?.isDirectory() && stat.mtimeMs === time;
			});
			if (unchanged) {
				scanned.push(entry);
				continue;
			}
			// The files there its globs match, gitignored or not, as the build script reads them.
			const recorded = stamp.files.filter(rel => rel.startsWith(`${entry.dir}/`) && globsMatch(entry.globs, rel));
			const now = scanDirectory(repoRoot, entry.dir);
			const matched = now.files.filter(rel => globsMatch(entry.globs, rel));
			if (matched.length !== recorded.length || matched.some((rel, i) => rel !== recorded[i])) return "other";
			scanned.push({ dir: entry.dir, globs: entry.globs, dirs: now.times });
			learned = true;
		}
		const fingerprint = fingerprintOf(repoRoot, stamp.files);
		const untracked = Object.keys(stamp.untracked);
		// Which checkout judges matters only for an untracked file, and the cached
		// verdict is keyed by it as well as by the files' state.
		const sameCheckout = sameCheckoutKey(
			untracked.length > 0,
			stamp.checkout,
			untracked.length > 0 ? checkoutId(repoRoot, false) : null,
		);
		let verdict = stamp.seen.verdict;
		if (fingerprint !== stamp.seen.fingerprint || sameCheckout !== stamp.seen.sameCheckout) {
			const hashes = hashSources(repoRoot, stamp.files);
			const now = identities(stamp.files, untracked, hashes);
			// A file untracked at build time may be missing only in another checkout of the
			// commit (robomp's cache, the image seed); where it was built, missing is a change.
			const sameUntracked = untracked.every(
				rel => (hashes[rel] === "missing" && !sameCheckout) || hashes[rel] === stamp.untracked[rel],
			);
			verdict = now.digest === stamp.sources && sameUntracked ? "current" : "other";
			learned = true;
		}
		if (learned) {
			try {
				writeStamp(addonPath, { ...stamp, scanned, seen: { fingerprint, sameCheckout, verdict } });
			} catch {
				// A checkout that cannot be written checks again next start.
			}
		}
		return verdict;
	} catch {
		return "unknown";
	}
}
