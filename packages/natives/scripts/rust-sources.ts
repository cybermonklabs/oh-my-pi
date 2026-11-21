/**
 * The build's half of the record of a workspace addon's Rust sources: which source files a
 * native build (`build-bindings.ts`, `scripts/bazel-natives.ts`) compiled, read before the build
 * and settled after it, and the record it writes next to the addon. The workspace loader judges
 * that record with `native/workspace-sources.js`, which holds what both halves share; a
 * compiled binary and an installed package never read this module.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readRegularFileText } from "../native/regular-file.js";
import {
	addonSourcesStampPath,
	CHANGED_DURING_BUILD,
	checkoutId,
	directoryStamp,
	type Glob,
	globsMatch,
	hashSources,
	identities,
	listScannedAgain,
	lstatSource,
	SEEN_STATE_VERSION,
	sameCheckoutKey,
	scanDirectory,
	settledTimes,
	writeStamp,
} from "../native/workspace-sources.js";

/** What a Cargo build of the addon compiles, relative to the repository root. */
export const CARGO_SOURCE_ROOTS: readonly string[] = Object.freeze([
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	".cargo",
	"crates",
]);

/**
 * What a Bazel build of the addon compiles: the Cargo inputs (crate_universe
 * resolves third-party crates from them, and each crate's `BUILD.bazel` is under
 * `crates/`), the root targets, the module, the settings, the Bazel version, and
 * the toolchain and transition definitions under `bazel/`. `MODULE.bazel.lock`
 * is left out: a build rewrites it after `MODULE.bazel` changes, which would make
 * every such build read as other sources, and it follows from `MODULE.bazel`.
 */
export const BAZEL_SOURCE_ROOTS: readonly string[] = Object.freeze([
	...CARGO_SOURCE_ROOTS,
	"BUILD.bazel",
	"MODULE.bazel",
	".bazelrc",
	".bazelversion",
	".bazelignore",
	"bazel",
]);

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
	 * Each listed file's fingerprint line (size, modification time, change time and inode) as
	 * the read of its bytes found it; never written to the record. The settle compares them.
	 */
	stats: Record<string, string>;
	/**
	 * SHA-256 over each listed file's path, size, modification time, change time and inode as
	 * the read of its bytes found them, or null when a file changed while it was read or has a
	 * time too new to trust: the state whose verdict a start may take without reading the
	 * bytes.
	 */
	fingerprint: string | null;
	/**
	 * SHA-256 over each tracked file's path and content (a link's target, for a link), hex; or
	 * `"changed during the build"` after a settle that saw a listed file move during the build,
	 * which no tree matches.
	 */
	digest: string;
	/** Each untracked file's content hash. */
	untrackedHashes: Record<string, string>;
	/**
	 * The directories build scripts scan: each with its `cargo_build_script` globs (patterns
	 * relative to the repository root) and the state of it and its subdirectories (modification
	 * time, change time and inode, `\0`-separated).
	 */
	scanned: { dir: string; globs: Glob[]; dirs: Record<string, string> }[];
	/**
	 * The scanned directories whose state was too new to trust when it was read (as
	 * `fingerprint`). The settle lists them again, and the record keeps for them a state no
	 * directory has, so the first start lists them again.
	 */
	unsettled: string[];
	/** Each package directory and whether it has a `build.rs`. */
	packages: { dir: string; buildScript: boolean }[];
}

/**
 * Sources the build itself rewrites: Cargo updates `Cargo.lock` when a manifest's
 * dependencies changed, so the lock the build compiled against is the one it left.
 */
const REWRITTEN_BY_BUILD = new Set(["Cargo.lock"]);

/**
 * Run git with the caller's environment, less the variables that would point it
 * at another repository; its stdout, or null when it fails or cannot start.
 */
function runGit(args: string[]): string | null {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
	try {
		const git = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
		return git.exitCode === 0 ? git.stdout.toString() : null;
	} catch {
		return null;
	}
}

/** `git ls-files -t -z` output as paths and whether git tracks each. */
function parseListing(output: string): { rel: string; tracked: boolean }[] {
	return output
		.split("\0")
		.filter(Boolean)
		.map(entry => ({ rel: entry.slice(2), tracked: !entry.startsWith("? ") }));
}

/**
 * Every file and link a walk finds under `roots`, for a machine without git:
 * below a root, names starting with a dot and `target` directories are skipped,
 * and a link, to a directory or not, is an entry, never followed.
 */
function walkSources(repoRoot: string, roots: readonly string[]): string[] {
	const files: string[] = [];
	const visit = (rel: string) => {
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
 */
function isRepositoryRoot(repoRoot: string): boolean {
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
 */
function listBuildSources(repoRoot: string, roots: readonly string[]): { files: string[]; untracked: string[] } {
	const args = ["ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard", "--", ...roots];
	let entries: { rel: string; tracked: boolean }[] | undefined;
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
	const kept = new Map<string, boolean>();
	for (const { rel, tracked } of entries) {
		const stat = lstatSource(repoRoot, rel);
		if (stat && !stat.isDirectory()) kept.set(rel, (kept.get(rel) ?? false) || tracked);
	}
	const files = [...kept.keys()].sort();
	return { files, untracked: files.filter(rel => !kept.get(rel)) };
}

/** The argument text of the call whose `(` ends just before `start`, comments removed. */
function callArguments(text: string, start: number): string {
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

/** The argument text of each top-level call to `name` in a Starlark file. */
function* starlarkCalls(text: string, name: string): Generator<string> {
	for (const match of text.matchAll(new RegExp(`(?:^|\\n)[ \\t]*${name}\\s*\\(`, "g"))) {
		yield callArguments(text, match.index + match[0].length);
	}
}

/** The strings of a Starlark list, from the text inside its brackets. */
function stringsOf(list: string): string[] {
	return [...list.matchAll(/["']([^"']+)["']/g)].map(([, value]) => value);
}

/**
 * Each `glob()` in `text`: its `include` patterns (the first list, positional or
 * `include = […]`) and its `exclude` patterns.
 */
function* globCalls(text: string): Generator<Glob> {
	for (const match of text.matchAll(/\bglob\s*\(/g)) {
		const args = callArguments(text, match.index + match[0].length);
		const excludeList = /\bexclude\s*=\s*\[([^\]]*)\]/.exec(args);
		const rest = excludeList ? args.replace(excludeList[0], "") : args;
		const includeList = /\[([^\]]*)\]/.exec(rest);
		yield {
			include: includeList ? stringsOf(includeList[1]) : [],
			exclude: excludeList ? stringsOf(excludeList[1]) : [],
		};
	}
}

/**
 * The directories build scripts scan, with the globs that say which of their files
 * a build script takes in: for each listed `BUILD.bazel`, every `glob()` in its
 * `cargo_build_script` calls (patterns made relative to the repository root), each
 * pattern's directory being its part before the first segment with a wildcard.
 * Bazel gives a build script only the files its globs match, so those files, and
 * no others there, are what a build script can read; Cargo's `rerun-if-changed`
 * names the same directories.
 */
function buildScriptScannedDirs(repoRoot: string, files: readonly string[]): { dir: string; globs: Glob[] }[] {
	const byDir = new Map<string, Glob[]>();
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
					const globs = byDir.get(dir) ?? [];
					globs.push({ include: [path.posix.join(pkg, pattern)], exclude });
					byDir.set(dir, globs);
				}
			}
		}
	}
	return [...byDir.keys()].sort().map(dir => ({ dir, globs: byDir.get(dir) ?? [] }));
}

/**
 * Each package directory (one holding a listed `Cargo.toml`) and whether it has a
 * `build.rs`, which Cargo runs without any manifest naming it.
 */
function packageBuildScripts(repoRoot: string, files: readonly string[]): { dir: string; buildScript: boolean }[] {
	return files
		.filter(rel => path.posix.basename(rel) === "Cargo.toml")
		.map(rel => {
			const dir = path.posix.dirname(rel);
			return { dir, buildScript: lstatSource(repoRoot, path.posix.join(dir, "build.rs")) !== undefined };
		});
}

/**
 * The checkout's sources under `roots` now, as a native build records them, read
 * before the build begins. Lists the files once (one `git ls-files`), adds the
 * files of the directories build scripts scan that their globs match, gitignored
 * or not, as sources the build had, and reads every one. Its fingerprint is that
 * of the files it read, or null when one changed while it read them or has a time
 * too new to trust (git's racy-clean rule); `unsettled` names each scanned directory
 * whose times were too new. Throws when a listed regular file cannot be opened.
 */
export function readRustSources(repoRoot: string, roots: readonly string[]): RustSources {
	const startedAt = Date.now();
	const listed = listBuildSources(repoRoot, roots);
	const scans = buildScriptScannedDirs(repoRoot, listed.files).map(({ dir, globs }) => {
		const scan = scanDirectory(repoRoot, dir, startedAt);
		return {
			dir,
			globs,
			times: scan.times,
			racy: scan.racy,
			files: scan.files.filter(rel => globsMatch(globs, rel)),
		};
	});
	const scannedFiles = new Set(scans.flatMap(scan => scan.files));
	const files = [...new Set([...listed.files, ...scannedFiles])].sort();
	// A scanned directory's matched files are compiled whether git tracks them or not.
	const untracked = listed.untracked.filter(rel => !scannedFiles.has(rel));
	const { hashes, stats, fingerprint } = hashSources(repoRoot, files, startedAt);
	return {
		roots: [...roots],
		checkout: checkoutId(repoRoot, true),
		files,
		untracked,
		hashes,
		stats,
		fingerprint,
		...identities(files, untracked, hashes),
		scanned: scans.map(({ dir, globs, times }) => ({ dir, globs, dirs: times })),
		unsettled: scans.flatMap(({ racy }) => racy),
		packages: packageBuildScripts(repoRoot, files),
	};
}

/**
 * The sources to record once the build is done: `before` ({@link readRustSources}
 * before the build), except that a file the build itself rewrites
 * ({@link REWRITTEN_BY_BUILD}: `Cargo.lock`) takes the content the build left. If
 * any other listed file moved while the build ran (its bytes, or its size, times or
 * inode, as a file edited and put back as it was has), or a directory a build script
 * scans did (a file added there and removed again), the record names no sources
 * (`changed during the build`), so the addon reads as built from other sources
 * until the next build. A scanned directory whose state was too new to trust before
 * the build (`unsettled`: a file added after that read, in its tick, leaves the state
 * as it was) is also listed again, and a matched file added or removed there counts as
 * moved.
 */
export function settleRustSources(repoRoot: string, before: RustSources): RustSources {
	const startedAt = Date.now();
	const read = hashSources(repoRoot, before.files, startedAt);
	const fileMoved = before.files.some(
		rel =>
			!REWRITTEN_BY_BUILD.has(rel) &&
			(read.stats[rel] !== before.stats[rel] || read.hashes[rel] !== before.hashes[rel]),
	);
	const directoryMoved = before.scanned.some(
		entry =>
			Object.entries(entry.dirs).some(([rel, stamp]) => {
				const stat = lstatSource(repoRoot, rel);
				return !stat?.isDirectory() || directoryStamp(stat) !== stamp;
			}) ||
			(Object.keys(entry.dirs).some(rel => before.unsettled.includes(rel)) &&
				!listScannedAgain(repoRoot, entry, before.files, startedAt).same),
	);
	if (fileMoved || directoryMoved) return { ...before, digest: CHANGED_DURING_BUILD, fingerprint: null };
	if (before.files.every(rel => read.hashes[rel] === before.hashes[rel])) return before;
	return {
		...before,
		hashes: read.hashes,
		stats: read.stats,
		fingerprint: read.fingerprint,
		...identities(before.files, before.untracked, read.hashes),
	};
}

/**
 * The addon's identity in a record: its size and a whole-second modification time.
 * The time is set to the whole second first, because copies that keep times often
 * keep only seconds (a Docker layer `COPY`, tar), and the record must still name
 * the addon after one.
 */
function addonIdentity(addonPath: string): { size: number; mtimeMs: number } {
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
 */
export function writeAddonSourcesStamp(addonPath: string, sources: RustSources, build: Record<string, unknown>): void {
	writeStamp(addonPath, {
		addon: addonIdentity(addonPath),
		roots: sources.roots,
		checkout: sources.checkout,
		files: sources.files,
		untracked: sources.untrackedHashes,
		sources: sources.digest,
		// A scanned directory whose state was too new to trust is listed again at the first start.
		scanned: sources.scanned.map(entry => ({ ...entry, dirs: settledTimes(entry.dirs, sources.unsettled) })),
		packages: sources.packages,
		// The checkout that built the addon is the one judging it now. A fingerprint of null (a file
		// changed while the build read it, or one too new to trust) matches no state: the first start
		// reads the bytes.
		seen: {
			version: SEEN_STATE_VERSION,
			fingerprint: sources.fingerprint,
			sameCheckout: sameCheckoutKey(sources.untracked.length > 0, sources.checkout, sources.checkout),
			verdict: sources.digest === CHANGED_DURING_BUILD ? "other" : "current",
		},
		build,
	});
}

/**
 * Give `toAddonPath`, a copy of `fromAddonPath`, the record of the addon it was
 * copied from, naming the copy's own size and modification time.
 */
export function copyAddonSourcesStamp(fromAddonPath: string, toAddonPath: string): void {
	const recordPath = addonSourcesStampPath(fromAddonPath);
	const text = readRegularFileText(recordPath);
	if (text === undefined) throw new Error(`${recordPath} is not a regular file`);
	writeStamp(toAddonPath, { ...JSON.parse(text), addon: addonIdentity(toAddonPath) });
}
