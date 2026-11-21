/**
 * The checkout, the addon and the helpers that the tests of the sources record share: those of
 * the build's half (`rust-sources.test.ts`, `scripts/rust-sources.ts`) and those of the loader's
 * half (`workspace-sources.test.ts`, `native/workspace-sources.js`). A test file runs
 * {@link createSourcesCheckout} before each test and {@link removeSourcesCheckout} after it.
 */
import { expect, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CARGO_SOURCE_ROOTS, readRustSources, writeAddonSourcesStamp } from "../scripts/rust-sources";

export let repo = "";
export let nativeDir = "";
export let addon = "";
/** `Date.now()` as the test began writing its repository, before any file of it existed. */
export let writesBegan = 0;

/** Make a fresh checkout with an addon in it: each test file runs this before each test. */
export async function createSourcesCheckout(): Promise<void> {
	writesBegan = Date.now();
	repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-sources-"));
	nativeDir = path.join(repo, "packages/natives/native");
	addon = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	await Bun.write(path.join(repo, "Cargo.toml"), "[workspace]\n");
	await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n");
	await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep() {}\n");
	await Bun.write(path.join(repo, "MODULE.bazel"), 'module(name = "oh-my-pi")\n');
	await Bun.write(path.join(repo, "bazel/defs.bzl"), "# rules\n");
	await Bun.write(addon, "addon bytes");
}

/** Remove the checkout {@link createSourcesCheckout} made: each test file runs this after each test. */
export async function removeSourcesCheckout(): Promise<void> {
	await fs.rm(repo, { recursive: true, force: true });
}

export const CARGO_BUILD = { builder: "cargo", profile: "local", features: null, rustflags: "-C target-cpu=x86-64-v3" };

/** Build the addon as the native build does: record the sources, then the stamp. */
export async function build(
	roots: readonly string[] = CARGO_SOURCE_ROOTS,
	settings: Record<string, unknown> = CARGO_BUILD,
) {
	writeAddonSourcesStamp(addon, readRustSources(repo, roots), settings);
}

/**
 * Run `fn` with `Date.now()` ten seconds on: a read that comes more than two seconds after every
 * file the test wrote. workspace-sources keeps no state with a time within two seconds of its
 * read (git's racy-clean rule), so a test of what a build or a start keeps reads at such a time.
 */
export async function readLater<T>(fn: () => T | Promise<T>): Promise<T> {
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
	try {
		return await fn();
	} finally {
		clock.mockRestore();
	}
}

/**
 * Run `fn` with `Date.now()` at {@link writesBegan}: a read within two seconds of every file the
 * test wrote, however long a loaded machine took to get to it. A test of what a build or a start
 * keeps from a state too new to trust reads at such a time; {@link pinnedClockSource} does the
 * same in a {@link bounded} process.
 */
export async function readSoon<T>(fn: () => T | Promise<T>): Promise<T> {
	const clock = vi.spyOn(Date, "now").mockReturnValue(writesBegan);
	try {
		return await fn();
	} finally {
		clock.mockRestore();
	}
}

/** JS source for {@link bounded}: `Date.now()` is {@link writesBegan} from here on (see {@link readSoon}). */
export function pinnedClockSource(): string {
	return `Date.now = () => ${writesBegan};`;
}

/** Git with no user or system configuration, so a test repository behaves the same on any machine. */
export const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/**
 * Run `body` (JS source) in a process of its own, bounded, with `readRustSources`,
 * `settleRustSources`, `writeAddonSourcesStamp`, `addonSourcesState`, `copyAddonSourcesStamp`,
 * `checkoutId` and the shared reader's seam (`__setRegularFileIoForTests`) in scope: a read that
 * blocked would hang this test runner otherwise, and a seam set there cannot reach another test.
 * `swapAtOpen(target, replacement)` renames `replacement` over `target` the first time the
 * shared reader opens `target`, between its `lstat` and its `open`; `listenSocket(path)` binds a
 * Unix socket there. Returns what the body printed, or null when the bound killed it.
 */
export function bounded(body: string): unknown {
	const rustSourcesTs = path.join(import.meta.dir, "../scripts/rust-sources.ts");
	const sourcesJs = path.join(import.meta.dir, "../native/workspace-sources.js");
	const regularFileJs = path.join(import.meta.dir, "../native/regular-file.js");
	const script = `const { readRustSources, settleRustSources, writeAddonSourcesStamp, copyAddonSourcesStamp, CARGO_SOURCE_ROOTS } = await import(${JSON.stringify(rustSourcesTs)});
const { addonSourcesState, checkoutId } = await import(${JSON.stringify(sourcesJs)});
const { __setRegularFileIoForTests } = await import(${JSON.stringify(regularFileJs)});
const nodeFs = await import("node:fs");
const repo = ${JSON.stringify(repo)};
const addon = ${JSON.stringify(addon)};
const swapAtOpen = (target, replacement) => {
	let swapped = false;
	__setRegularFileIoForTests({
		openSync(file, flags, mode) {
			if (!swapped && file === target) {
				swapped = true;
				nodeFs.renameSync(replacement, target);
			}
			return nodeFs.openSync(file, flags, mode);
		},
	});
};
const listenSocket = async socketPath => {
	const server = (await import("node:net")).createServer();
	await new Promise(resolve => server.listen(socketPath, resolve));
	return server;
};
${body}
process.exit(0);`;
	const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
		env: gitEnv,
		stderr: "pipe",
		timeout: 15_000,
		killSignal: "SIGKILL",
	});
	if (child.exitedDueToTimeout) return null;
	expect(child.stderr.toString()).toBe("");
	return JSON.parse(child.stdout.toString());
}

/** Make a FIFO at `file`. */
export function mkfifo(file: string): void {
	expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
}

/**
 * JS source for {@link bounded}: the shared reader's `open` of `file` fails with `EACCES`, as a
 * file this user cannot read, or an `open` with no descriptor left, fails; the file itself stays
 * a regular file with its bytes.
 */
export function denyOpen(file: string): string {
	return `__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (file === ${JSON.stringify(file)}) throw Object.assign(new Error(\`EACCES: permission denied, open '\${file}'\`), { code: "EACCES" });
		return nodeFs.openSync(file, flags, mode);
	},
});`;
}

/** The real git, resolved once: a test below puts a fake one first on PATH. */
export const gitBinary = Bun.which("git") ?? "git";

/** Run git in `cwd` with no user or system configuration and a fixed identity. */
export function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync([gitBinary, "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		env: gitEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
}

/** A directory pi-shell's build script scans, in {@link checkout}'s checkout. */
export const defs = "crates/pi-shell/src/minimizer/defs";

/** A checkout like this one: pi-shell's build script compiles every defs `.toml`, as its BUILD.bazel declares. */
export async function checkout() {
	await Bun.write(path.join(repo, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n');
	await Bun.write(path.join(repo, "crates/pi-shell/Cargo.toml"), '[package]\nname = "pi-shell"\n');
	await Bun.write(path.join(repo, "crates/pi-shell/build.rs"), "fn main() {}\n");
	await Bun.write(
		path.join(repo, "crates/pi-shell/BUILD.bazel"),
		[
			'# build.rs concatenates the defs (a comment naming glob(["ignored/*"]) is no input).',
			"cargo_build_script(",
			'    name = "build_script",',
			'    srcs = ["build.rs"],',
			'    data = glob(["src/minimizer/defs/*.toml"]),',
			")",
			"",
			"rust_library(",
			'    name = "pi-shell",',
			'    compile_data = glob(["src/process/*.txt"]),',
			")",
			"",
		].join("\n"),
	);
	await Bun.write(path.join(repo, "crates/pi-shell/src/lib.rs"), "pub fn shell() {}\n");
	await Bun.write(path.join(repo, "crates/pi-shell/src/process/a.txt"), "text\n");
	await Bun.write(path.join(repo, defs, "a.toml"), "[filters.a]\n");
	await Bun.write(path.join(repo, "crates/pi-ast/Cargo.toml"), '[package]\nname = "pi-ast"\n');
	await Bun.write(path.join(repo, "crates/pi-ast/src/lib.rs"), "pub fn ast() {}\n");
	git(repo, "init", "-q");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "base");
	await build();
}

/**
 * JS source for {@link bounded}: the shared reader's `lstat` gives the scanned directory the
 * state it has now, from then on, as a kernel whose clock is coarse does for every change made
 * in the same tick as a look at it.
 */
export function freezeDirectory(): string {
	const dir = path.join(repo, defs);
	return `const dir = ${JSON.stringify(dir)};
const frozen = nodeFs.lstatSync(dir);
__setRegularFileIoForTests({
	lstatSync(file, options) {
		return file === dir ? frozen : nodeFs.lstatSync(file, options);
	},
});
const stampPath = addon + ".sources.json";
const keptFor = () => JSON.parse(nodeFs.readFileSync(stampPath, "utf8")).scanned[0].dirs[${JSON.stringify(defs)}];`;
}
