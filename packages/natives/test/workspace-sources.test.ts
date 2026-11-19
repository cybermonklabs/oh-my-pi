/**
 * A workspace checkout loads the addon its own native build left in `native/`, and skips
 * release validation there (`validateLoadedBindings`), so an addon built before the checkout's
 * Rust sources changed used to load as current: same release, other code. The build now
 * records which Rust sources it compiled (`<addon>.sources.json`), and a workspace load
 * compares that record with the checkout, reporting a mismatch through the stale-addon notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { describeLoadedAddon, type NativeAddonStatus, reportStaleWorkspaceAddon } from "../native/loader-state.js";
import {
	addonSourcesState,
	BAZEL_SOURCE_ROOTS,
	CARGO_SOURCE_ROOTS,
	checkoutId,
	copyAddonSourcesStamp,
	readRustSources,
	settleRustSources,
	uniqueTempPath,
	writeAddonSourcesStamp,
} from "../native/workspace-sources.js";
import packageJson from "../package.json" with { type: "json" };

let repo = "";
let nativeDir = "";
let addon = "";

beforeEach(async () => {
	repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-sources-"));
	nativeDir = path.join(repo, "packages/natives/native");
	addon = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	await Bun.write(path.join(repo, "Cargo.toml"), "[workspace]\n");
	await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n");
	await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep() {}\n");
	await Bun.write(path.join(repo, "MODULE.bazel"), 'module(name = "oh-my-pi")\n');
	await Bun.write(path.join(repo, "bazel/defs.bzl"), "# rules\n");
	await Bun.write(addon, "addon bytes");
});

afterEach(async () => {
	await fs.rm(repo, { recursive: true, force: true });
});

const CARGO_BUILD = { builder: "cargo", profile: "local", features: null, rustflags: "-C target-cpu=x86-64-v3" };

/** Build the addon as the native build does: record the sources, then the stamp. */
async function build(roots: readonly string[] = CARGO_SOURCE_ROOTS, settings: Record<string, unknown> = CARGO_BUILD) {
	writeAddonSourcesStamp(addon, readRustSources(repo, roots), settings);
}

/**
 * Run `fn` with `Date.now()` ten seconds on: a read that comes more than two seconds after every
 * file the test wrote. workspace-sources keeps no state with a time within two seconds of its
 * read (git's racy-clean rule), so a test of what a build or a start keeps reads at such a time.
 */
async function readLater<T>(fn: () => T | Promise<T>): Promise<T> {
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
	try {
		return await fn();
	} finally {
		clock.mockRestore();
	}
}

/** Git with no user or system configuration, so a test repository behaves the same on any machine. */
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/**
 * Run `body` (JS source) in a process of its own, bounded, with `readRustSources`,
 * `settleRustSources`, `writeAddonSourcesStamp`, `addonSourcesState`, `copyAddonSourcesStamp`,
 * `checkoutId` and the shared reader's seam (`__setRegularFileIoForTests`) in scope: a read that
 * blocked would hang this test runner otherwise, and a seam set there cannot reach another test.
 * `swapAtOpen(target, replacement)` renames `replacement` over `target` the first time the
 * shared reader opens `target`, between its `lstat` and its `open`; `listenSocket(path)` binds a
 * Unix socket there. Returns what the body printed, or null when the bound killed it.
 */
function bounded(body: string): unknown {
	const sourcesJs = path.join(import.meta.dir, "../native/workspace-sources.js");
	const regularFileJs = path.join(import.meta.dir, "../native/regular-file.js");
	const script = `const { readRustSources, settleRustSources, writeAddonSourcesStamp, addonSourcesState, copyAddonSourcesStamp, checkoutId, CARGO_SOURCE_ROOTS } = await import(${JSON.stringify(sourcesJs)});
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
function mkfifo(file: string): void {
	expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
}

/**
 * JS source for {@link bounded}: the shared reader's `open` of `file` fails with `EACCES`, as a
 * file this user cannot read, or an `open` with no descriptor left, fails; the file itself stays
 * a regular file with its bytes.
 */
function denyOpen(file: string): string {
	return `__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (file === ${JSON.stringify(file)}) throw Object.assign(new Error(\`EACCES: permission denied, open '\${file}'\`), { code: "EACCES" });
		return nodeFs.openSync(file, flags, mode);
	},
});`;
}

describe("the Rust sources a workspace addon was built from", () => {
	it("are current until a source file's content changes", async () => {
		await build();
		expect(addonSourcesState(addon, repo)).toBe("current");

		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("are other sources when a recorded file is removed or the lock file changes", async () => {
		await build();
		await fs.rm(path.join(repo, "crates/pi-natives/src/lib.rs"));
		expect(addonSourcesState(addon, repo)).toBe("other");
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n# changed\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("are unknown, at once, when the record is a FIFO", async () => {
		await build();
		const record = `${addon}.sources.json`;
		await fs.rm(record);
		mkfifo(record);

		expect(bounded("console.log(JSON.stringify(addonSourcesState(addon, repo)));")).toBe("unknown");
	}, 60_000);

	it("are unknown, and keep no verdict, while a recorded file cannot be opened, and current once it can", async () => {
		await build();
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		// A new time on the same bytes: the start reads the sources again, and so opens this one.
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(target, later, later);

		// No permission, or no descriptor left, at this one start; the bytes never changed.
		expect(
			bounded(`${denyOpen(target)}
console.log(JSON.stringify(addonSourcesState(addon, repo)));`),
		).toBe("unknown");
		expect(addonSourcesState(addon, repo)).toBe("current");
	}, 60_000);

	it("stop a build that cannot open a listed file, with the error", () => {
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");

		expect(
			bounded(`${denyOpen(target)}
try {
	readRustSources(repo, CARGO_SOURCE_ROOTS);
	console.log(JSON.stringify("recorded"));
} catch (error) {
	console.log(JSON.stringify(error.code));
}`),
		).toBe("EACCES");
	}, 60_000);

	it("keep no verdict for a source edited while a start read it, so it is current once put back", async () => {
		await build();
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(target, later, later);
		const edited = path.join(repo, "crates/pi-natives/src/edited");
		const aside = path.join(repo, "crates/pi-natives/src/aside");
		await Bun.write(edited, "pub fn edited_while_read() {}\n");

		// The start reads the edited bytes; then the original is put back as it was (the same
		// file, size and time), as a `mv` back does.
		expect(
			bounded(`let done = false;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (!done && file === ${JSON.stringify(target)}) {
			done = true;
			nodeFs.renameSync(file, ${JSON.stringify(aside)});
			nodeFs.renameSync(${JSON.stringify(edited)}, file);
		}
		return nodeFs.openSync(file, flags, mode);
	},
});
console.log(JSON.stringify(addonSourcesState(addon, repo)));`),
		).toBe("other");
		await fs.rename(aside, target);

		expect(addonSourcesState(addon, repo)).toBe("current");
	}, 60_000);

	it("keep no verdict for a source that was a FIFO only while a start read it", async () => {
		await build();
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(target, later, later);
		const fifo = path.join(repo, "crates/pi-natives/src/fifo");
		const aside = path.join(repo, "crates/pi-natives/src/aside");
		mkfifo(fifo);

		// Between the start's lstat and its open the source is a FIFO, and it is back (the same
		// file, size and time) before the start takes the files' sizes and times again.
		expect(
			bounded(`let done = false;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (done || file !== ${JSON.stringify(target)}) return nodeFs.openSync(file, flags, mode);
		done = true;
		nodeFs.renameSync(file, ${JSON.stringify(aside)});
		nodeFs.renameSync(${JSON.stringify(fifo)}, file);
		try {
			return nodeFs.openSync(file, flags, mode);
		} finally {
			nodeFs.renameSync(file, ${JSON.stringify(fifo)});
			nodeFs.renameSync(${JSON.stringify(aside)}, file);
		}
	},
});
console.log(JSON.stringify({ state: addonSourcesState(addon, repo), back: nodeFs.lstatSync(${JSON.stringify(target)}).isFile() }));`),
		).toEqual({ state: "other", back: true });

		expect(addonSourcesState(addon, repo)).toBe("current");
	}, 60_000);

	it.each([["a link"], ["a socket"]])(
		"read other, keep no verdict, and never throw, for a source that was %s only for the start's open",
		async label => {
			await build();
			const target = path.join(repo, "crates/pi-natives/src/lib.rs");
			const later = new Date(Date.now() + 60_000);
			await fs.utimes(target, later, later);
			const staged = path.join(repo, "crates/pi-natives/src/staged");
			const aside = path.join(repo, "crates/pi-natives/src/aside");
			let prepare = "";
			if (label === "a link") await fs.symlink("lib.rs.orig", staged);
			else prepare = `const server = await listenSocket(${JSON.stringify(staged)});`;

			// The open meets the link or the socket, and the file is back before the reader looks
			// again: no kind to name, and no reason to call the file unreadable either.
			const result = bounded(`${prepare}
let done = false;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (done || file !== ${JSON.stringify(target)}) return nodeFs.openSync(file, flags, mode);
		done = true;
		nodeFs.renameSync(file, ${JSON.stringify(aside)});
		nodeFs.renameSync(${JSON.stringify(staged)}, file);
		try {
			return nodeFs.openSync(file, flags, mode);
		} finally {
			nodeFs.renameSync(file, ${JSON.stringify(staged)});
			nodeFs.renameSync(${JSON.stringify(aside)}, file);
		}
	},
});
const state = addonSourcesState(addon, repo);
done = false;
let built;
try {
	built = { fingerprint: readRustSources(repo, CARGO_SOURCE_ROOTS).fingerprint };
} catch (error) {
	built = { threw: error.code };
}
console.log(JSON.stringify({ state, built }));`);

			expect(result).toEqual({ state: "other", built: { fingerprint: null } });
			expect(addonSourcesState(addon, repo)).toBe("current");
		},
		60_000,
	);

	it("keep no state for a source that was changed at its open and is gone when the read looks again", async () => {
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		const staged = path.join(repo, "crates/pi-natives/src/staged");
		const aside = path.join(repo, "crates/pi-natives/src/aside");
		await fs.symlink("lib.rs.orig", staged);

		// The build's open meets a link, the file is back for the reader's second look (`changed`),
		// and it is gone when the read takes every listed file's size and time again.
		const result = bounded(`let opened = false;
let gone = false;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (opened || file !== ${JSON.stringify(target)}) return nodeFs.openSync(file, flags, mode);
		opened = true;
		nodeFs.renameSync(file, ${JSON.stringify(aside)});
		nodeFs.renameSync(${JSON.stringify(staged)}, file);
		try {
			return nodeFs.openSync(file, flags, mode);
		} finally {
			nodeFs.renameSync(file, ${JSON.stringify(staged)});
			nodeFs.renameSync(${JSON.stringify(aside)}, file);
		}
	},
	lstatSync(file, options) {
		const stat = nodeFs.lstatSync(file, options);
		if (opened && !gone && file === ${JSON.stringify(target)}) {
			gone = true;
			nodeFs.renameSync(file, ${JSON.stringify(aside)});
		}
		return stat;
	},
});
const sources = readRustSources(repo, CARGO_SOURCE_ROOTS);
writeAddonSourcesStamp(addon, sources, {});
console.log(JSON.stringify({ fingerprint: sources.fingerprint, gone: !nodeFs.existsSync(${JSON.stringify(target)}) }));`);

		expect(result).toEqual({ fingerprint: null, gone: true });
		// So the record names no state of a tree without lib.rs: a start reads the files, and the
		// recorded lib.rs is missing.
		expect(addonSourcesState(addon, repo)).toBe("other");
	}, 60_000);

	it("read other and keep nothing for a listed link removed between its lstat and its readlink", async () => {
		const link = path.join(repo, "crates/pi-natives/src/link.rs");
		await fs.symlink("lib.rs", link);
		await build();
		// A new time on lib.rs: the start reads the sources again, and so reads the link.
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(path.join(repo, "crates/pi-natives/src/lib.rs"), later, later);

		expect(
			bounded(`let removed = false;
__setRegularFileIoForTests({
	lstatSync(file, options) {
		const stat = nodeFs.lstatSync(file, options);
		if (!removed && file === ${JSON.stringify(link)}) {
			removed = true;
			nodeFs.unlinkSync(file);
		}
		return stat;
	},
});
console.log(JSON.stringify(addonSourcesState(addon, repo)));`),
		).toBe("other");
		await fs.symlink("lib.rs", link);
		expect(addonSourcesState(addon, repo)).toBe("current");
	}, 60_000);

	it.each([
		["no longer a link", "EINVAL", "other"],
		["unreadable", "EIO", "unknown"],
	])(
		"keep no verdict for a listed link that is %s at its readlink and the same link again after",
		async (_label, code, state) => {
			const link = path.join(repo, "crates/pi-natives/src/link.rs");
			await fs.symlink("lib.rs", link);
			await build();
			const later = new Date(Date.now() + 60_000);
			await fs.utimes(path.join(repo, "crates/pi-natives/src/lib.rs"), later, later);

			// The link itself never changes: its `readlink` fails as one does on a path that held
			// another kind for that moment (a mount over it and back) or on an I/O error.
			expect(
				bounded(`__setRegularFileIoForTests({
	readlinkSync(file, options) {
		if (file === ${JSON.stringify(link)}) throw Object.assign(new Error(\`${code}: readlink '\${file}'\`), { code: ${JSON.stringify(code)} });
		return nodeFs.readlinkSync(file, options);
	},
});
console.log(JSON.stringify(addonSourcesState(addon, repo)));`),
			).toBe(state);
			expect(addonSourcesState(addon, repo)).toBe("current");
		},
		60_000,
	);

	it("keep no verdict for a source rewritten in place while a start read it, also once its bytes and time are back", async () => {
		await build();
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(target, later, later);

		// The same file is rewritten after the start opened it and before it read the bytes.
		expect(
			bounded(`let fd;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		const opened = nodeFs.openSync(file, flags, mode);
		if (file === ${JSON.stringify(target)}) fd = opened;
		return opened;
	},
	readFileSync(reading, options) {
		if (reading === fd) {
			fd = undefined;
			nodeFs.writeFileSync(${JSON.stringify(target)}, "pub fn rewritten_in_place() {}\\n");
		}
		return nodeFs.readFileSync(reading, options);
	},
});
console.log(JSON.stringify(addonSourcesState(addon, repo)));`),
		).toBe("other");
		await Bun.write(target, "pub fn grep() {}\n");
		await fs.utimes(target, later, later);

		expect(addonSourcesState(addon, repo)).toBe("current");
	}, 60_000);

	it("change nothing when a file is added after the build, and see a new module through its parent", async () => {
		await build();
		// Editor backups, merge leftovers, a new test, snapshot drafts, caches: none was compiled.
		for (const added of [
			"crates/pi-natives/src/lib.rs~",
			"crates/pi-natives/src/#lib.rs#",
			"crates/pi-natives/src/lib.rs.orig",
			"crates/pi-shell/tests/zz_probe_test.rs",
			"crates/pi-natives/src/snapshots/a.snap.new",
			"crates/pi-natives/tools/cache/blob",
			"crates/pi-natives/tools/__pycache__/x.pyc",
		]) {
			await Bun.write(path.join(repo, added), "added after the build\n");
		}
		expect(addonSourcesState(addon, repo)).toBe("current");

		// A module the addon compiles is declared in a file the build recorded.
		await Bun.write(path.join(repo, "crates/pi-natives/src/zz.rs"), "pub fn zz() {}\n");
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "mod zz;\npub fn grep() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("stay current when files are rewritten with the same content, and remember that", async () => {
		await build();
		const earlier = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(repo, "crates/pi-natives/src/lib.rs"), earlier, earlier);

		// A start more than two seconds after the rewrite, so the state it read can be kept.
		expect(await readLater(() => addonSourcesState(addon, repo))).toBe("current");
		// The content check ran once for this state of the tree; its answer is kept, so the
		// next start reads only file sizes and times, and opens no source.
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.seen.fingerprint).toEqual(expect.any(String));
		expect(stamp.seen.fingerprint).toBe(await readLater(() => readRustSources(repo, CARGO_SOURCE_ROOTS).fingerprint));
		expect(
			bounded(`const opened = [];
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		opened.push(file);
		return nodeFs.openSync(file, flags, mode);
	},
});
const state = addonSourcesState(addon, repo);
console.log(JSON.stringify({ state, sourcesOpened: opened.filter(file => !file.endsWith(".sources.json")).length }));`),
		).toEqual({ state: "current", sourcesOpened: 0 });
	}, 60_000);

	it("keep no state whose times are within two seconds of the read, and keep it once they are older", async () => {
		await build();
		// The build read files it had just written, so it keeps no fingerprint, and the first
		// start reads the bytes.
		const recorded = async () => (await Bun.file(`${addon}.sources.json`).json()).seen.fingerprint;
		expect(await recorded()).toBeNull();
		expect(addonSourcesState(addon, repo)).toBe("current");
		expect(await recorded()).toBeNull();
		// Control: a start more than two seconds after the writes keeps the state it read.
		expect(await readLater(() => addonSourcesState(addon, repo))).toBe("current");
		expect(await recorded()).toEqual(expect.any(String));
	});

	it("see a same-size edit made in the timestamp tick of the start that read the file (git's racy case)", async () => {
		await build();
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		// On a kernel whose clock is coarse, a file read and then edited in one tick keeps its
		// times. The seam gives the file the times it had at the read, for the read and after the
		// edit, as such a kernel does; the edit keeps the size and the inode.
		expect(
			bounded(`const target = ${JSON.stringify(target)};
const frozen = nodeFs.lstatSync(target);
let fd;
__setRegularFileIoForTests({
	lstatSync(file, options) {
		return file === target ? frozen : nodeFs.lstatSync(file, options);
	},
	openSync(file, flags, mode) {
		const opened = nodeFs.openSync(file, flags, mode);
		if (file === target) fd = opened;
		return opened;
	},
	fstatSync(descriptor) {
		return descriptor === fd ? frozen : nodeFs.fstatSync(descriptor);
	},
});
const first = addonSourcesState(addon, repo);
nodeFs.writeFileSync(target, "pub fn grop() {}\\n");
const second = addonSourcesState(addon, repo);
console.log(JSON.stringify({ first, second, sameSize: nodeFs.statSync(target).size === frozen.size }));`),
		).toEqual({ first: "current", second: "other", sameSize: true });
	});

	it.each([["a new record"], ["a new addon"]])(
		"write back nothing when a build left %s while the start read the sources",
		async what => {
			await build();
			const target = path.join(repo, "crates/pi-natives/src/lib.rs");
			// A time the build did not record, so the start reads the bytes and learns a state.
			const earlier = new Date(Date.now() - 60_000);
			await fs.utimes(target, earlier, earlier);
			expect(
				bounded(`// A start more than two seconds after the writes, so it learns the state it reads.
const realNow = Date.now;
Date.now = () => realNow.call(Date) + 10_000;
const stampPath = addon + ".sources.json";
const before = nodeFs.readFileSync(stampPath, "utf8");
let built = false;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (!built && file === ${JSON.stringify(target)}) {
			built = true;
			// A build installs its addon, or writes its record, while this start reads the sources.
			if (${JSON.stringify(what)} === "a new addon") nodeFs.writeFileSync(addon, "another addon's bytes");
			else nodeFs.writeFileSync(stampPath, JSON.stringify({ ...JSON.parse(before), build: { builder: "the new build" } }));
		}
		return nodeFs.openSync(file, flags, mode);
	},
});
const state = addonSourcesState(addon, repo);
const after = nodeFs.readFileSync(stampPath, "utf8");
console.log(JSON.stringify({ state, built, writtenBack: after !== before && JSON.parse(after).build.builder !== "the new build" }));`),
			).toEqual({ state: "current", built: true, writtenBack: false });
		},
	);

	it.each([["in place"], ["by a rename over it"]])(
		"see a same-size edit whose modification time is put back (%s), as git does",
		async how => {
			const target = path.join(repo, "crates/pi-natives/src/lib.rs");
			// A whole-second time, so it can be put back exactly.
			const time = new Date(1_700_000_000_000);
			await fs.utimes(target, time, time);
			await build();
			const before = await fs.lstat(target);
			if (how === "in place") {
				await Bun.write(target, "pub fn grop() {}\n");
			} else {
				await Bun.write(`${target}.new`, "pub fn grop() {}\n");
				await fs.rename(`${target}.new`, target);
			}
			await fs.utimes(target, time, time);
			const after = await fs.lstat(target);

			// The size and the modification time are the build's; the change time and, after a
			// rename, the inode are not, and on Linux only a change of the clock sets a change time.
			expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
			expect(addonSourcesState(addon, repo)).toBe("other");
		},
	);

	it.each([
		["no rule", undefined],
		["another rule", 0],
		["the rule before times within two seconds of the read were distrusted", 1],
	])("read the bytes again for a verdict a record kept under %s", async (_label, version) => {
		await readLater(() => build());
		const stampPath = `${addon}.sources.json`;
		const stamp = await Bun.file(stampPath).json();
		// A verdict this tree does not have, kept as an earlier build of this loader kept one:
		// under its own fingerprint rule, which this one cannot vouch for.
		await Bun.write(stampPath, JSON.stringify({ ...stamp, seen: { ...stamp.seen, version, verdict: "other" } }));
		expect(addonSourcesState(addon, repo)).toBe("current");

		// Control: the same verdict under this rule is taken as it stands.
		await Bun.write(stampPath, JSON.stringify({ ...stamp, seen: { ...stamp.seen, verdict: "other" } }));
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("ignore build output and dot files in the source tree", async () => {
		await build();
		await Bun.write(path.join(repo, "crates/pi-natives/target/debug/out.o"), "object");
		await Bun.write(path.join(repo, "crates/pi-natives/src/.lib.rs.swp"), "swap");
		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("are unknown without a stamp, or when the stamp describes another addon file", async () => {
		expect(addonSourcesState(addon, repo)).toBe("unknown");
		await build();
		await Bun.write(addon, "another build's addon bytes");
		expect(addonSourcesState(addon, repo)).toBe("unknown");
	});

	it("of a Bazel build include Bazel's inputs, and of a Cargo build do not", async () => {
		await build(BAZEL_SOURCE_ROOTS, { builder: "bazel", labels: ["//:natives-linux-x64-modern"], args: [] });
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "MODULE.bazel"), 'module(name = "oh-my-pi", version = "2")\n');
		expect(addonSourcesState(addon, repo)).toBe("other");
		await Bun.write(path.join(repo, "MODULE.bazel"), 'module(name = "oh-my-pi")\n');
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "bazel/defs.bzl"), "# rules, changed\n");
		expect(addonSourcesState(addon, repo)).toBe("other");

		await build();
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "MODULE.bazel"), 'module(name = "oh-my-pi", version = "3")\n');
		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("record the build's settings without comparing them", async () => {
		await build();
		const stampPath = `${addon}.sources.json`;
		const stamp = await Bun.file(stampPath).json();
		expect(stamp.build).toEqual(CARGO_BUILD);
		expect(stamp.roots).toEqual([...CARGO_SOURCE_ROOTS]);

		await Bun.write(stampPath, JSON.stringify({ ...stamp, build: { builder: "cargo", profile: "ci" } }));
		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("are unknown when the record names roots outside the checkout", async () => {
		// A sibling of this test's own checkout, named after it, so no other run shares it.
		const outside = `../${path.basename(repo)}-outside`;
		await Bun.write(path.join(repo, outside, "lib.rs"), "outside\n");
		await build([outside]);
		try {
			expect(addonSourcesState(addon, repo)).toBe("unknown");
		} finally {
			await fs.rm(path.join(repo, outside), { recursive: true, force: true });
		}
	});

	it("follow an installed copy of the addon", async () => {
		await build();
		const copy = path.join(repo, "dest/pi_natives.linux-x64-modern.node");
		await fs.mkdir(path.dirname(copy), { recursive: true });
		await fs.copyFile(addon, copy);

		copyAddonSourcesStamp(addon, copy);

		expect(addonSourcesState(copy, repo)).toBe("current");
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");
		expect(addonSourcesState(copy, repo)).toBe("other");
	});

	it("refuse, at once, to copy a record that is a FIFO", async () => {
		await build();
		const record = `${addon}.sources.json`;
		await fs.rm(record);
		mkfifo(record);
		const copy = path.join(repo, "dest/pi_natives.linux-x64-modern.node");
		await fs.mkdir(path.dirname(copy), { recursive: true });
		await fs.copyFile(addon, copy);

		expect(
			bounded(`try {
	copyAddonSourcesStamp(addon, ${JSON.stringify(copy)});
	console.log(JSON.stringify("copied"));
} catch (error) {
	console.log(JSON.stringify(error.message));
}`),
		).toBe(`${record} is not a regular file`);
		expect(await Bun.file(`${copy}.sources.json`).exists()).toBe(false);
	}, 60_000);

	it("of a git checkout are the files git tracks or would track, never ignored ones", async () => {
		await Bun.write(path.join(repo, ".gitignore"), "crates/pi-natives/tools/cache/\n");
		await Bun.write(path.join(repo, "crates/pi-natives/tools/cache/blob"), "cache v1\n");
		// Not yet added to git, not ignored: the build compiles it.
		await Bun.write(path.join(repo, "crates/pi-natives/src/zz.rs"), "pub fn zz() {}\n");
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv });
		expect(git("init", "-q").exitCode).toBe(0);
		expect(git("add", "Cargo.toml", "Cargo.lock", "crates/pi-natives/src/lib.rs").exitCode).toBe(0);
		await build();

		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.files).toEqual([
			"Cargo.lock",
			"Cargo.toml",
			"crates/pi-natives/src/lib.rs",
			"crates/pi-natives/src/zz.rs",
		]);
		await Bun.write(path.join(repo, "crates/pi-natives/tools/cache/blob"), "cache v2\n");
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "crates/pi-natives/src/zz.rs"), "pub fn zz2() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it.each(["git", "walk"] as const)(
		"record a symbolic link as a link and never follow it (%s listing)",
		async listing => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-outside-"));
			try {
				await Bun.write(path.join(outside, "lib.rs"), "outside v1\n");
				await fs.symlink(".", path.join(repo, "crates/loop"));
				await fs.symlink(outside, path.join(repo, "crates/outside"));
				if (listing === "git") {
					const init = Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: gitEnv });
					expect(init.exitCode).toBe(0);
				}
				await build();

				const stamp = await Bun.file(`${addon}.sources.json`).json();
				expect(stamp.files).toContain("crates/loop");
				expect(stamp.files).toContain("crates/outside");
				expect(stamp.files.filter((rel: string) => rel.startsWith("crates/loop/"))).toEqual([]);
				expect(stamp.files.filter((rel: string) => rel.startsWith("crates/outside/"))).toEqual([]);
				expect(addonSourcesState(addon, repo)).toBe("current");
				// The target's content is not this checkout's; the link itself is.
				await Bun.write(path.join(outside, "lib.rs"), "outside v2\n");
				expect(addonSourcesState(addon, repo)).toBe("current");
				await fs.rm(path.join(repo, "crates/outside"));
				await fs.symlink(path.join(outside, "lib.rs"), path.join(repo, "crates/outside"));
				expect(addonSourcesState(addon, repo)).toBe("other");
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
			}
		},
	);

	it("take Cargo.lock as the build left it when the build rewrote it", async () => {
		const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
		// cargo updates the lock when a manifest's dependencies changed.
		await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n# rewritten by cargo\n");

		writeAddonSourcesStamp(addon, settleRustSources(repo, before), CARGO_BUILD);

		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("still name other sources when a file other than the lock changed during the build", async () => {
		const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
		await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n# rewritten by cargo\n");
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn edited_during_build() {}\n");

		writeAddonSourcesStamp(addon, settleRustSources(repo, before), CARGO_BUILD);

		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it.each([["in place"], ["by a rename over it, as git does"]])(
		"name other sources until the next build for a file edited during the build and put back, times and all (%s)",
		async how => {
			const target = path.join(repo, "crates/pi-natives/src/lib.rs");
			// A whole-second time, so it can be put back exactly.
			const time = new Date(1_700_000_000_000);
			await fs.utimes(target, time, time);
			const original = await Bun.file(target).text();
			const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
			// On a kernel whose timestamps are coarse, the clock moves on before the edit.
			await Bun.sleep(25);

			// The build runs, and the compiler reads the edit.
			await Bun.write(target, "pub fn edited_during_build() {}\n");
			// The edit is put back before the build ends (an editor's undo, `git stash` and
			// `stash pop`), with the time it had (`touch -r`).
			if (how === "in place") {
				await Bun.write(target, original);
			} else {
				await Bun.write(`${target}.new`, original);
				await fs.rename(`${target}.new`, target);
			}
			await fs.utimes(target, time, time);
			writeAddonSourcesStamp(addon, settleRustSources(repo, before), CARGO_BUILD);

			expect((await fs.lstat(target)).mtimeMs).toBe(time.getTime());
			expect(await Bun.file(target).text()).toBe(original);
			expect(addonSourcesState(addon, repo)).toBe("other");
			expect(addonSourcesState(addon, repo)).toBe("other");
			// The next build reads the tree as it is.
			await build();
			expect(addonSourcesState(addon, repo)).toBe("current");
		},
	);

	it("stay current when the build rewrote Cargo.lock with the same bytes", async () => {
		const lock = path.join(repo, "Cargo.lock");
		const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
		await Bun.write(lock, await Bun.file(lock).text());
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(lock, later, later);

		writeAddonSourcesStamp(addon, settleRustSources(repo, before), CARGO_BUILD);

		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("keep no verdict for a state the build's read did not see: a source edited just after the settle read it", async () => {
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		const edited = path.join(repo, "crates/pi-natives/src/edited");
		await Bun.write(edited, "pub fn edited_after_the_build() {}\n");

		// The settle reads lib.rs as the build compiled it, and the edit lands before it takes
		// the files' sizes and times.
		expect(
			bounded(`const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
nodeFs.writeFileSync(${JSON.stringify(path.join(repo, "Cargo.lock"))}, "version = 4\\n# rewritten by cargo\\n");
let fd;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		const opened = nodeFs.openSync(file, flags, mode);
		if (file === ${JSON.stringify(target)}) fd = opened;
		return opened;
	},
	closeSync(closing) {
		nodeFs.closeSync(closing);
		if (closing !== fd) return;
		fd = undefined;
		nodeFs.renameSync(${JSON.stringify(edited)}, ${JSON.stringify(target)});
	},
});
writeAddonSourcesStamp(addon, settleRustSources(repo, before), {});
console.log(JSON.stringify("recorded"));`),
		).toBe("recorded");

		expect(addonSourcesState(addon, repo)).toBe("other");
	}, 60_000);

	it("name the addon by a whole-second time, so a copy that keeps only seconds still matches", async () => {
		await fs.utimes(addon, new Date(1_700_000_000_123), new Date(1_700_000_000_456));
		await build();
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.addon.mtimeMs % 1000).toBe(0);
		expect((await fs.stat(addon)).mtimeMs).toBe(stamp.addon.mtimeMs);

		// A Docker layer copy (or tar) of the checkout: bytes and record as they are, the
		// addon's time cut to the second.
		const copy = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-layer-"));
		try {
			await fs.cp(repo, copy, { recursive: true });
			const copied = path.join(copy, path.relative(repo, addon));
			const seconds = Math.floor((await fs.stat(addon)).mtimeMs / 1000);
			await fs.utimes(copied, seconds, seconds);

			expect(addonSourcesState(copied, copy)).toBe("current");
		} finally {
			await fs.rm(copy, { recursive: true, force: true });
		}
	});
});

/** The real git, resolved once: a test below puts a fake one first on PATH. */
const gitBinary = Bun.which("git") ?? "git";

/** Run git in `cwd` with no user or system configuration and a fixed identity. */
function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync([gitBinary, "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		env: gitEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
}

describe("inputs a build takes in that no listed file names", () => {
	const defs = "crates/pi-shell/src/minimizer/defs";

	/** A checkout like this one: pi-shell's build script compiles every defs `.toml`, as its BUILD.bazel declares. */
	async function checkout() {
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

	it("record the directories build scripts scan and the packages' build scripts", async () => {
		await checkout();
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.scanned.map((entry: { dir: string }) => entry.dir)).toEqual([defs]);
		expect(stamp.packages).toEqual([
			{ dir: ".", buildScript: false },
			{ dir: "crates/pi-ast", buildScript: false },
			{ dir: "crates/pi-shell", buildScript: true },
		]);
	});

	it("record a FIFO a scanned directory holds by its type, without opening it, and stay current", async () => {
		await checkout();
		// A FIFO the glob matches: a build that opened it would wait for a writer forever.
		const fifo = `${defs}/pipe.toml`;
		expect(Bun.spawnSync(["mkfifo", path.join(repo, fifo)]).exitCode).toBe(0);

		const result = bounded(`const first = readRustSources(repo, CARGO_SOURCE_ROOTS);
const second = readRustSources(repo, CARGO_SOURCE_ROOTS);
writeAddonSourcesStamp(addon, first, {});
console.log(JSON.stringify({ listed: first.files.includes(${JSON.stringify(fifo)}), first: first.hashes[${JSON.stringify(fifo)}], second: second.hashes[${JSON.stringify(fifo)}], state: addonSourcesState(addon, repo) }));`);

		expect(result).not.toBeNull();
		const { listed, first, second, state } = result as Record<string, unknown>;
		expect(listed).toBe(true);
		expect(first).toBe(second);
		// Not the hash of the bytes of an empty file, nor `missing`.
		expect(first).not.toBe(new Bun.CryptoHasher("sha256").update("").digest("hex"));
		expect(first).not.toBe("missing");
		expect(state).toBe("current");
	}, 60_000);

	it("are other sources, at once, when a recorded file is replaced by a FIFO", async () => {
		await checkout();
		const recorded = path.join(repo, "crates/pi-shell/src/lib.rs");
		await fs.rm(recorded);
		expect(Bun.spawnSync(["mkfifo", recorded]).exitCode).toBe(0);

		expect(bounded("console.log(JSON.stringify(addonSourcesState(addon, repo)));")).toBe("other");
	}, 60_000);

	it("list a BUILD.bazel that became a FIFO, with no globs, at once", async () => {
		await checkout();
		// git lists a tracked path whatever now stands there.
		const buildFile = "crates/pi-shell/BUILD.bazel";
		await fs.rm(path.join(repo, buildFile));
		mkfifo(path.join(repo, buildFile));

		expect(
			bounded(`const sources = readRustSources(repo, CARGO_SOURCE_ROOTS);
console.log(JSON.stringify({ listed: sources.files.includes(${JSON.stringify(buildFile)}), scanned: sources.scanned.map(entry => entry.dir) }));`),
		).toEqual({ listed: true, scanned: [] });
	}, 60_000);

	it.each([["a FIFO"], ["a link"], ["a socket"]])(
		"are other sources, at once, when a source turns into %s between its lstat and its open",
		async label => {
			await checkout();
			const target = path.join(repo, "crates/pi-shell/src/lib.rs");
			// A new time on the same bytes: the start reads the sources again, and so opens this one.
			const later = new Date(Date.now() + 60_000);
			await fs.utimes(target, later, later);
			const staged = path.join(repo, "crates/pi-shell/src/staged");
			let prepare = "";
			if (label === "a FIFO") mkfifo(staged);
			else if (label === "a link") await fs.symlink("lib.rs.orig", staged);
			else prepare = `const server = await listenSocket(${JSON.stringify(staged)});`;

			const result = bounded(`${prepare}
swapAtOpen(${JSON.stringify(target)}, ${JSON.stringify(staged)});
console.log(JSON.stringify({ state: addonSourcesState(addon, repo), now: nodeFs.lstatSync(${JSON.stringify(target)}).isFile() ? "file" : "other kind" }));`);

			// The swap happened (the source is no longer a regular file), and the start said so at once.
			expect(result).toEqual({ state: "other", now: "other kind" });
		},
		60_000,
	);

	it("are other sources when a file is added to a scanned directory, committed or not", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "zz-probe.toml"), "[filters.zz_probe]\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "new filter");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("are other sources when a file is added to a scanned directory whose modification time is put back", async () => {
		const dir = path.join(repo, defs);
		// A whole-second time, so it can be put back exactly.
		const time = new Date(1_700_000_000_000);
		await checkout();
		await fs.utimes(dir, time, time);
		await build();
		await Bun.write(path.join(dir, "zz-probe.toml"), "[filters.zz_probe]\n");
		await fs.utimes(dir, time, time);

		expect((await fs.lstat(dir)).mtimeMs).toBe(time.getTime());
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("judge a record whose directory times an earlier build kept as numbers, listing those directories again", async () => {
		await checkout();
		const stampPath = `${addon}.sources.json`;
		const stamp = await Bun.file(stampPath).json();
		const mtime = (await fs.lstat(path.join(repo, defs))).mtimeMs;
		const scanned = stamp.scanned.map((entry: { dirs: Record<string, string> }) => ({
			...entry,
			dirs: Object.fromEntries(Object.keys(entry.dirs).map(rel => [rel, mtime])),
		}));
		await Bun.write(stampPath, JSON.stringify({ ...stamp, scanned }));

		expect(await readLater(() => addonSourcesState(addon, repo))).toBe("current");
		const now = await fs.lstat(path.join(repo, defs));
		expect((await Bun.file(stampPath).json()).scanned[0].dirs[defs]).toBe(
			`${now.mtimeMs}\0${now.ctimeMs}\0${now.ino}`,
		);
	});

	it("are other sources until the next build for a file added to a scanned directory during the build and removed before its end", async () => {
		await checkout();
		const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
		// On a kernel whose timestamps are coarse, the clock moves on before the file comes.
		await Bun.sleep(25);
		// The build script compiles every `.toml` there, this one too, while it stands.
		await Bun.write(path.join(repo, defs, "zz-during.toml"), "[filters.zz_during]\n");
		await fs.rm(path.join(repo, defs, "zz-during.toml"));

		writeAddonSourcesStamp(addon, settleRustSources(repo, before), CARGO_BUILD);

		expect(addonSourcesState(addon, repo)).toBe("other");
		await build();
		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("are other sources when a file leaves a scanned directory", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "b.toml"), "[filters.b]\n");
		await build();
		await fs.rm(path.join(repo, defs, "b.toml"));
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("are other sources when a package gains a build.rs", async () => {
		await checkout();
		await Bun.write(path.join(repo, "crates/pi-ast/build.rs"), 'fn main() { println!("cargo:rustc-cfg=zz"); }\n');
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("stay current for an unrelated new file, and for a scanned directory touched with the same files", async () => {
		await checkout();
		for (const added of [
			"crates/pi-shell/tests/zz_probe_test.rs",
			"crates/pi-shell/src/lib.rs~",
			"crates/pi-shell/src/process/b.txt",
			"crates/pi-ast/README.md",
		]) {
			await Bun.write(path.join(repo, added), "added after the build\n");
		}
		expect(addonSourcesState(addon, repo)).toBe("current");

		// A file made and removed in a scanned directory moves its time and nothing else.
		await Bun.write(path.join(repo, defs, "a.toml.swp-like"), "scratch\n");
		await fs.rm(path.join(repo, defs, "a.toml.swp-like"));
		const earlier = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(repo, defs), earlier, earlier);
		// A start more than two seconds after the change, so the state it lists can be kept.
		expect(await readLater(() => addonSourcesState(addon, repo))).toBe("current");
		// The start remembers the directory's new state, so the next start lists nothing.
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		const now = await fs.stat(path.join(repo, defs));
		expect(stamp.scanned[0].dirs[defs]).toBe(`${now.mtimeMs}\0${now.ctimeMs}\0${now.ino}`);
	});

	it("are other sources when a listed file in a scanned directory changes (control)", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "a.toml"), "[filters.a]\n# edited\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("are other sources when a gitignored file is added to a scanned directory", async () => {
		// Bazel's glob and pi-shell's build.rs read every `.toml` there, gitignored or not.
		await checkout();
		await Bun.write(path.join(repo, ".gitignore"), "crates/pi-shell/src/minimizer/defs/local-*.toml\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "ignore local defs");
		await build();
		expect(addonSourcesState(addon, repo)).toBe("current");

		await Bun.write(path.join(repo, defs, "local-probe.toml"), "[filters.local_probe]\n");

		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("record a gitignored file a scanned directory held at build time, and see its edits", async () => {
		await checkout();
		await Bun.write(path.join(repo, ".gitignore"), "crates/pi-shell/src/minimizer/defs/local-*.toml\n");
		await Bun.write(path.join(repo, defs, "local-a.toml"), "[filters.local_a]\n");
		await build();
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.files).toContain(`${defs}/local-a.toml`);
		expect(addonSourcesState(addon, repo)).toBe("current");

		await Bun.write(path.join(repo, defs, "local-a.toml"), "[filters.local_a]\n# edited\n");

		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("stay current for a file added to a scanned directory that its glob does not match", async () => {
		// pi-shell's glob is `src/minimizer/defs/*.toml`: top-level `.toml` files only.
		await checkout();
		await Bun.write(path.join(repo, defs, "README.md"), "# filter defs\n");
		await Bun.write(path.join(repo, defs, "old/a.toml"), "[filters.archived]\n");
		await Bun.write(path.join(repo, defs, ".a.toml.swp"), "swap\n");
		await Bun.write(path.join(repo, defs, "a.toml~"), "backup\n");

		expect(addonSourcesState(addon, repo)).toBe("current");
		// And a matching file is still seen (control).
		await Bun.write(path.join(repo, defs, "zz.toml"), "[filters.zz]\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	/**
	 * JS source for {@link bounded}: the shared reader's `lstat` gives the scanned directory the
	 * state it has now, from then on, as a kernel whose clock is coarse does for every change made
	 * in the same tick as a look at it.
	 */
	function freezeDirectory(): string {
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

	it("see a matching file added to a scanned directory in the timestamp tick of the start that listed it (git's racy case)", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "README.md"), "# filter defs\n");
		expect(
			bounded(`${freezeDirectory()}
const first = addonSourcesState(addon, repo);
const kept = keptFor();
nodeFs.writeFileSync(dir + "/zz.toml", "[filters.zz]\\n");
const second = addonSourcesState(addon, repo);
console.log(JSON.stringify({ first, kept, second }));`),
		).toEqual({ first: "current", kept: "unsettled", second: "other" });
	});

	it("are other sources until the next build for a matching file added to a scanned directory in the tick of the build's first read", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "README.md"), "# filter defs\n");
		expect(
			bounded(`${freezeDirectory()}
const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
// The build script compiles every matching file there, this one too.
nodeFs.writeFileSync(dir + "/zz.toml", "[filters.zz]\\n");
writeAddonSourcesStamp(addon, settleRustSources(repo, before), {});
const sources = JSON.parse(nodeFs.readFileSync(stampPath, "utf8")).sources;
console.log(JSON.stringify({ unsettled: before.unsettled, sources, state: addonSourcesState(addon, repo) }));`),
		).toEqual({ unsettled: [defs], sources: "changed during the build", state: "other" });
	});

	it("record a scanned directory whose state was too new at the build's first read as unsettled, so the first start lists it", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "README.md"), "# filter defs\n");
		expect(
			bounded(`${freezeDirectory()}
const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
writeAddonSourcesStamp(addon, settleRustSources(repo, before), {});
const kept = keptFor();
// After the build, in the same tick: the frozen state hides the file from a state check.
nodeFs.writeFileSync(dir + "/zz.toml", "[filters.zz]\\n");
console.log(JSON.stringify({ kept, state: addonSourcesState(addon, repo) }));`),
		).toEqual({ kept: "unsettled", state: "other" });
	});

	it("list a scanned directory again when its state was kept under an earlier rule", async () => {
		await checkout();
		expect(
			bounded(`${freezeDirectory()}
// A build more than two seconds after the writes keeps the directory's state.
const realNow = Date.now;
Date.now = () => realNow.call(Date) + 10_000;
writeAddonSourcesStamp(addon, readRustSources(repo, CARGO_SOURCE_ROOTS), {});
Date.now = realNow;
const record = JSON.parse(nodeFs.readFileSync(stampPath, "utf8"));
nodeFs.writeFileSync(dir + "/zz.toml", "[filters.zz]\\n");
// Control: under this rule the kept state stands, and the frozen state hides the file.
const sameRule = addonSourcesState(addon, repo);
nodeFs.writeFileSync(stampPath, JSON.stringify({ ...record, seen: { ...record.seen, version: 1 } }));
const earlierRule = addonSourcesState(addon, repo);
console.log(JSON.stringify({ kept: keptFor() !== "unsettled", sameRule, earlierRule }));`),
		).toEqual({ kept: true, sameRule: "current", earlierRule: "other" });
	});

	it("record only the files a scanned directory's glob matches, honouring exclude", async () => {
		await Bun.write(
			path.join(repo, "crates/pi-gen/BUILD.bazel"),
			[
				"cargo_build_script(",
				'    name = "build_script",',
				'    srcs = ["build.rs"],',
				'    data = glob(include = ["assets/**/*.json"], exclude = ["assets/**/draft-*.json"]),',
				")",
				"",
			].join("\n"),
		);
		await Bun.write(path.join(repo, "crates/pi-gen/Cargo.toml"), '[package]\nname = "pi-gen"\n');
		await Bun.write(path.join(repo, "crates/pi-gen/build.rs"), "fn main() {}\n");
		await Bun.write(path.join(repo, "crates/pi-gen/assets/top.json"), "{}\n");
		await Bun.write(path.join(repo, "crates/pi-gen/assets/deep/nested.json"), "{}\n");
		await Bun.write(path.join(repo, "crates/pi-gen/assets/deep/draft-wip.json"), "{}\n");
		await Bun.write(path.join(repo, "crates/pi-gen/assets/deep/notes.txt"), "notes\n");
		await Bun.write(path.join(repo, ".gitignore"), "crates/pi-gen/assets/\n");
		git(repo, "init", "-q");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		await build();
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.files.filter((rel: string) => rel.startsWith("crates/pi-gen/assets/"))).toEqual([
			"crates/pi-gen/assets/deep/nested.json",
			"crates/pi-gen/assets/top.json",
		]);

		await Bun.write(path.join(repo, "crates/pi-gen/assets/deep/draft-next.json"), "{}\n");
		await Bun.write(path.join(repo, "crates/pi-gen/assets/deep/more.txt"), "more\n");
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "crates/pi-gen/assets/deeper/still/new.json"), "{}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});
	it("record a link in a scanned directory as a link, never followed", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-outside-def-"));
		try {
			await Bun.write(path.join(outside, "shared.toml"), "[filters.shared]\n");
			await checkout();
			await fs.symlink(path.join(outside, "shared.toml"), path.join(repo, defs, "shared.toml"));
			// A link to a directory, and one that loops: entries, never walked into.
			await fs.symlink(outside, path.join(repo, defs, "vendored"));
			await fs.symlink(".", path.join(repo, defs, "loop"));
			await build();
			const stamp = await Bun.file(`${addon}.sources.json`).json();
			expect(stamp.files.filter((rel: string) => rel.startsWith(`${defs}/`))).toEqual([
				`${defs}/a.toml`,
				`${defs}/loop`,
				`${defs}/shared.toml`,
				`${defs}/vendored`,
			]);

			// The target is not this checkout's; the link is.
			await Bun.write(path.join(outside, "shared.toml"), "[filters.shared]\n# edited elsewhere\n");
			expect(addonSourcesState(addon, repo)).toBe("current");
			await fs.rm(path.join(repo, defs, "shared.toml"));
			await fs.symlink(path.join(outside, "other.toml"), path.join(repo, defs, "shared.toml"));
			expect(addonSourcesState(addon, repo)).toBe("other");
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("a build where git will not list the repository", () => {
	let savedPath: string | undefined;
	let bin = "";

	beforeEach(async () => {
		savedPath = process.env.PATH;
		bin = `${repo}-bin`;
		// git refusing a repository it does not trust, as `safe.directory` makes it: with
		// FAKE_GIT_REFUSE=repo it refuses a listing of the checkout (`git -C <checkout> …`) and
		// runs the throwaway repository's commands; with FAKE_GIT_REFUSE=all it refuses all.
		await Bun.write(
			path.join(bin, "git"),
			[
				"#!/bin/sh",
				'if [ "$FAKE_GIT_REFUSE" = all ] || { [ "$FAKE_GIT_REFUSE" = repo ] && [ "$1" = "-C" ]; }; then',
				"  echo \"fatal: detected dubious ownership in repository at '$2'\" >&2",
				'  echo "To add an exception for this directory, call:" >&2',
				'  echo "" >&2',
				'  echo "	git config --global --add safe.directory $2" >&2',
				"  exit 128",
				"fi",
				`exec ${JSON.stringify(gitBinary)} "$@"`,
				"",
			].join("\n"),
		);
		await fs.chmod(path.join(bin, "git"), 0o755);
		await Bun.write(path.join(repo, ".gitignore"), "crates/pi-natives/tools/cache/\n");
		await Bun.write(path.join(repo, "crates/pi-natives/tools/cache/raw.json"), "download v1\n");
		await Bun.write(path.join(repo, "crates/pi-natives/src/.lib.rs.swp"), "swap\n");
		await Bun.write(path.join(repo, "crates/pi-natives/target/debug/out.o"), "object\n");
		git(repo, "init", "-q");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
	});

	afterEach(async () => {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		delete process.env.FAKE_GIT_REFUSE;
		await fs.rm(bin, { recursive: true, force: true });
	});

	it("lists against a throwaway repository, so .gitignore still applies, when git refuses the checkout", async () => {
		process.env.FAKE_GIT_REFUSE = "repo";
		await build();

		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.files).toEqual([
			"Cargo.lock",
			"Cargo.toml",
			"crates/pi-natives/src/.lib.rs.swp",
			"crates/pi-natives/src/lib.rs",
		]);
		// Every listed file counts as tracked there.
		expect(stamp.untracked).toEqual({});
		await Bun.write(path.join(repo, "crates/pi-natives/tools/cache/raw.json"), "download v2\n");
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("walks the tree when git refuses every listing", async () => {
		process.env.FAKE_GIT_REFUSE = "all";
		await build();

		const stamp = await Bun.file(`${addon}.sources.json`).json();
		// Every file, `.gitignore` or not, without names starting with a dot or `target`.
		expect(stamp.files).toEqual([
			"Cargo.lock",
			"Cargo.toml",
			"crates/pi-natives/src/lib.rs",
			"crates/pi-natives/tools/cache/raw.json",
		]);
		await Bun.write(path.join(repo, "crates/pi-natives/tools/cache/raw.json"), "download v2\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});
});

describe("a record judged in another checkout of the same commit", () => {
	/** A commit of the sources, and a clean clone of it to judge records in. */
	async function commitAndClone() {
		await Bun.write(path.join(repo, ".gitignore"), "crates/pi-natives/tools/cache/\n");
		git(repo, "init", "-q");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		const clean = `${repo}-clean`;
		git(path.dirname(repo), "clone", "-q", repo, clean);
		return clean;
	}

	/** Write the record in `tree`, then judge it in `clean`, with the addon copied as robomp copies it. */
	async function judgeIn(tree: string, clean: string) {
		const built = path.join(tree, "addon.node");
		await Bun.write(built, "addon bytes");
		writeAddonSourcesStamp(built, settleRustSources(tree, readRustSources(tree, CARGO_SOURCE_ROOTS)), CARGO_BUILD);
		const copied = path.join(clean, "addon.node");
		await fs.copyFile(built, copied);
		await fs.copyFile(`${built}.sources.json`, `${copied}.sources.json`);
		const { mtime, atime } = await fs.stat(built);
		await fs.utimes(copied, atime, mtime);
		return addonSourcesState(copied, clean);
	}

	afterEach(async () => {
		await fs.rm(`${repo}-clean`, { recursive: true, force: true });
		await fs.rm(`${repo}-context`, { recursive: true, force: true });
	});

	it("is current when it was written outside a repository holding a gitignored file", async () => {
		const clean = await commitAndClone();
		// A Docker build context: the tree without its `.git`, plus a gitignored download.
		const context = `${repo}-context`;
		await fs.cp(repo, context, { recursive: true, filter: source => path.basename(source) !== ".git" });
		await Bun.write(path.join(context, "crates/pi-natives/tools/cache/raw.json"), "token\n");

		expect(await judgeIn(context, clean)).toBe("current");
	});

	it("is current when it was written with an untracked file the other checkout lacks", async () => {
		const clean = await commitAndClone();
		await Bun.write(path.join(repo, "crates/pi-natives/NOTES.txt"), "scratch\n");

		expect(await judgeIn(repo, clean)).toBe("current");
	});

	it("is other when a listed file differs in the other checkout (control)", async () => {
		const clean = await commitAndClone();
		await Bun.write(path.join(clean, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");

		expect(await judgeIn(repo, clean)).toBe("other");
	});

	it("still sees its own edits to a file untracked at build time", async () => {
		await commitAndClone();
		await Bun.write(path.join(repo, "crates/pi-natives/src/zz.rs"), "pub fn zz() {}\n");
		await build();
		await Bun.write(path.join(repo, "crates/pi-natives/src/zz.rs"), "pub fn zz2() {}\n");

		expect(addonSourcesState(addon, repo)).toBe("other");
	});
});

describe("a file untracked at build time, judged in the checkout that built it", () => {
	it("reads other when it moves or goes away there", async () => {
		await Bun.write(path.join(repo, ".cargo/config.toml"), '[build]\nrustflags = ["-C", "target-cpu=native"]\n');
		git(repo, "init", "-q");
		git(repo, "add", "Cargo.toml", "Cargo.lock", "crates/pi-natives/src/lib.rs");
		git(repo, "commit", "-qm", "base");
		await Bun.write(path.join(repo, "crates/pi-natives/src/foo.rs"), "pub fn foo() {}\n");
		await build();
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(Object.keys(stamp.untracked).sort()).toEqual([".cargo/config.toml", "crates/pi-natives/src/foo.rs"]);
		expect(addonSourcesState(addon, repo)).toBe("current");

		// The module moves to `foo/mod.rs`, with other code.
		await fs.rm(path.join(repo, "crates/pi-natives/src/foo.rs"));
		await Bun.write(path.join(repo, "crates/pi-natives/src/foo/mod.rs"), "pub fn foo() { /* moved */ }\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("reads other when an untracked cargo config is deleted there", async () => {
		await Bun.write(path.join(repo, ".cargo/config.toml"), '[build]\nrustflags = ["-C", "target-cpu=native"]\n');
		git(repo, "init", "-q");
		git(repo, "add", "Cargo.toml", "Cargo.lock", "crates/pi-natives/src/lib.rs");
		git(repo, "commit", "-qm", "base");
		await build();

		await fs.rm(path.join(repo, ".cargo/config.toml"));

		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("reads other in a new checkout made where the old one was (another directory, same path)", async () => {
		git(repo, "init", "-q");
		git(repo, "add", "Cargo.toml", "Cargo.lock", "crates/pi-natives/src/lib.rs");
		git(repo, "commit", "-qm", "base");
		await Bun.write(path.join(repo, "crates/pi-natives/src/foo.rs"), "pub fn foo() {}\n");
		await build();
		// Its directory replaced by a fresh one holding the same commit (no foo.rs), record and addon kept.
		const moved = `${repo}-old`;
		await fs.rename(repo, moved);
		try {
			git(path.dirname(repo), "clone", "-q", moved, repo);
			await fs.mkdir(path.dirname(addon), { recursive: true });
			await fs.cp(path.join(moved, path.relative(repo, addon)), addon, { preserveTimestamps: true });
			await fs.cp(`${path.join(moved, path.relative(repo, addon))}.sources.json`, `${addon}.sources.json`);

			// Not the checkout that built it, so the missing untracked file is no difference.
			expect(addonSourcesState(addon, repo)).toBe("current");
		} finally {
			await fs.rm(moved, { recursive: true, force: true });
		}
	});
});

describe("the checkout a record names", () => {
	/** A commit without `src/foo.rs`. */
	function commitBase() {
		git(repo, "init", "-q");
		git(repo, "add", "Cargo.toml", "Cargo.lock", "crates/pi-natives/src/lib.rs");
		git(repo, "commit", "-qm", "base");
	}

	/** A build with `src/foo.rs` untracked: the record's one untracked file. */
	async function buildUntrackedModule() {
		await Bun.write(path.join(repo, "crates/pi-natives/src/foo.rs"), "pub fn foo() {}\n");
		await build();
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(Object.keys(stamp.untracked)).toEqual(["crates/pi-natives/src/foo.rs"]);
		expect(stamp.checkout).toBe((await Bun.file(path.join(repo, ".git/omp-checkout-id")).text()).trim());
	}

	async function buildWithUntrackedModule() {
		commitBase();
		await buildUntrackedModule();
	}

	afterEach(async () => {
		for (const suffix of ["-moved", "-origin", "-saved", "-gitdir", "-gitfile", "-super", "-link"])
			await fs.rm(`${repo}${suffix}`, { recursive: true, force: true });
	});

	it("is no id, at once, when the id file is a FIFO, and a start still judges the sources", async () => {
		await buildWithUntrackedModule();
		const idFile = path.join(repo, ".git/omp-checkout-id");
		await fs.rm(idFile);
		mkfifo(idFile);

		expect(
			bounded(
				"console.log(JSON.stringify({ read: checkoutId(repo, false), create: checkoutId(repo, true), state: addonSourcesState(addon, repo) }));",
			),
		).toEqual({ read: null, create: null, state: "current" });
	}, 60_000);

	it("is one id for builds that start at once, and its file is never seen without it", async () => {
		// Threads released together at a gate stand in for builds that start at once in a fresh
		// checkout: each makes or reads the id, and every one must read the same id. Readers
		// watch the file meanwhile: a build that read it while it held no whole id would record
		// no checkout.
		const builders = 6;
		const watchers = 2;
		const rounds = 25;
		const gate = new SharedArrayBuffer(12);
		const view = new Int32Array(gate);
		const workers = Array.from(
			{ length: builders + watchers },
			() => new Worker(new URL("./fixtures/checkout-id-worker.ts", import.meta.url), { workerData: { gate } }),
		);
		const next = (worker: Worker) => new Promise<string | number | null>(resolve => worker.once("message", resolve));
		try {
			for (let round = 0; round < rounds; round++) {
				const checkout = path.join(repo, `race-${round}`);
				await fs.mkdir(path.join(checkout, ".git"), { recursive: true });
				Atomics.store(view, 1, 0);
				const results = workers.map(next);
				workers.forEach((worker, i) => {
					worker.postMessage({ repo: checkout, round, role: i < builders ? "build" : "watch" });
				});
				while (Atomics.load(view, 1) < workers.length) await Bun.sleep(1);
				Atomics.store(view, 0, round + 1);
				Atomics.notify(view, 0);
				const ids = await Promise.all(results.slice(0, builders));
				Atomics.store(view, 2, round + 1);
				const incomplete = await Promise.all(results.slice(builders));

				expect({
					round,
					ids: new Set(ids).size,
					missing: ids.filter(id => id === null).length,
					incompleteReads: incomplete.reduce<number>((sum, n) => sum + Number(n), 0),
				}).toEqual({ round, ids: 1, missing: 0, incompleteReads: 0 });
			}
		} finally {
			await Promise.all(workers.map(worker => worker.terminate()));
		}
	}, 120_000);

	it("is the checkout's own through a .git that is a link to its git directory", async () => {
		commitBase();
		// git follows the link: `git rev-parse` and every build work through it.
		await fs.rename(path.join(repo, ".git"), `${repo}-gitdir`);
		await fs.symlink(`${repo}-gitdir`, path.join(repo, ".git"));
		await buildUntrackedModule();
		await fs.rm(path.join(repo, "crates/pi-natives/src/foo.rs"));

		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("is one checkout by a submodule's real path and through a link to it", async () => {
		// A submodule's `.git` file names its git directory relative to the submodule's real
		// directory, which is what git resolves it against.
		const superproject = `${repo}-super`;
		const submodule = path.join(superproject, "sub");
		await fs.mkdir(path.join(superproject, ".git/modules/sub"), { recursive: true });
		await fs.mkdir(submodule, { recursive: true });
		await Bun.write(path.join(submodule, ".git"), "gitdir: ../.git/modules/sub\n");
		const link = `${repo}-link`;
		await fs.symlink(submodule, link);
		const id = checkoutId(submodule, true);

		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(checkoutId(link, false)).toBe(id);
	});

	it("is the checkout's own through a .git that is a link to a .git file", async () => {
		commitBase();
		// A worktree's `.git` file reached through a link: git follows the link, then the file.
		await fs.rename(path.join(repo, ".git"), `${repo}-gitdir`);
		await Bun.write(`${repo}-gitfile`, `gitdir: ${repo}-gitdir\n`);
		await fs.symlink(`${repo}-gitfile`, path.join(repo, ".git"));
		const id = checkoutId(repo, true);

		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(id).toBe((await Bun.file(`${repo}-gitdir/omp-checkout-id`).text()).trim());
		expect(checkoutId(repo, false)).toBe(id);
	});

	it("is the same checkout after it moves, so its missing untracked file reads other", async () => {
		await buildWithUntrackedModule();
		const moved = `${repo}-moved`;
		// A `mv`, or a bind mount at another path: the checkout keeps its `.git`.
		await fs.rename(repo, moved);
		try {
			await fs.rm(path.join(moved, "crates/pi-natives/src/foo.rs"));

			expect(addonSourcesState(path.join(moved, path.relative(repo, addon)), moved)).toBe("other");
		} finally {
			await fs.rename(moved, repo);
		}
	});

	it("is another checkout when the checkout is deleted and cloned again at the same path", async () => {
		await buildWithUntrackedModule();
		const origin = `${repo}-origin`;
		git(path.dirname(repo), "clone", "-q", "--bare", repo, origin);
		const saved = `${repo}-saved`;
		await fs.mkdir(saved);
		await fs.cp(addon, path.join(saved, "addon.node"), { preserveTimestamps: true });
		await fs.cp(`${addon}.sources.json`, path.join(saved, "addon.node.sources.json"));
		// No rename: the directory is removed, and a new one made where it was.
		await fs.rm(repo, { recursive: true, force: true });
		git(path.dirname(repo), "clone", "-q", origin, repo);
		await fs.mkdir(path.dirname(addon), { recursive: true });
		await fs.cp(path.join(saved, "addon.node"), addon, { preserveTimestamps: true });
		await fs.cp(path.join(saved, "addon.node.sources.json"), `${addon}.sources.json`);

		expect(await fs.exists(path.join(repo, ".git/omp-checkout-id"))).toBe(false);
		// The fresh clone never had foo.rs: no difference.
		expect(addonSourcesState(addon, repo)).toBe("current");
	});

	it("keys the cached verdict by whether the checkout is the record's", async () => {
		await buildWithUntrackedModule();
		await fs.rm(path.join(repo, "crates/pi-natives/src/foo.rs"));
		expect(addonSourcesState(addon, repo)).toBe("other");

		// The same files and times, judged as another checkout would judge them.
		await fs.rm(path.join(repo, ".git/omp-checkout-id"));

		expect(addonSourcesState(addon, repo)).toBe("current");
	});
});

describe("a tree with no .git of its own inside another repository", () => {
	afterEach(async () => {
		await fs.rm(`${repo}-outer`, { recursive: true, force: true });
		await fs.rm(`${repo}-judge`, { recursive: true, force: true });
	});

	/** Move the tree to `<outer>/export`, inside a repository at `outer` that does not track it. */
	async function nest(ignoredByOuter: boolean) {
		const outer = `${repo}-outer`;
		await fs.mkdir(outer, { recursive: true });
		await Bun.write(path.join(outer, "README.md"), "outer\n");
		if (ignoredByOuter) await Bun.write(path.join(outer, ".gitignore"), "export/\n");
		git(outer, "init", "-q");
		git(outer, "add", "-A");
		git(outer, "commit", "-qm", "outer");
		const tree = path.join(outer, "export");
		await fs.cp(repo, tree, { recursive: true });
		return tree;
	}

	it.each([
		["does not ignore it", false],
		["ignores it", true],
	] as const)(
		"lists against a throwaway repository, its files tracked, when the outer repository %s",
		async (_label, ignoredByOuter) => {
			const tree = await nest(ignoredByOuter);
			const built = path.join(tree, "addon.node");
			await Bun.write(built, "addon bytes");
			writeAddonSourcesStamp(built, readRustSources(tree, CARGO_SOURCE_ROOTS), CARGO_BUILD);
			const stamp = await Bun.file(`${built}.sources.json`).json();
			expect(stamp.files).toEqual(["Cargo.lock", "Cargo.toml", "crates/pi-natives/src/lib.rs"]);
			expect(stamp.untracked).toEqual({});

			// Judged in another checkout: a deleted Cargo.lock is a difference, as for any tracked file.
			const judge = `${repo}-judge`;
			await fs.cp(tree, judge, { recursive: true });
			const { atime, mtime } = await fs.stat(built);
			await fs.utimes(path.join(judge, "addon.node"), atime, mtime);
			await fs.rm(path.join(judge, "Cargo.lock"));
			expect(addonSourcesState(path.join(judge, "addon.node"), judge)).toBe("other");
		},
	);
});

describe("temporary files", () => {
	it("are unique to each writer in one process and one millisecond", () => {
		// Worker threads share the pid, and a clock can return one millisecond to several.
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			const target = "/natives/18.18.6-aaaaaaaaaaaa/pi_natives.node";
			const [first, second] = [uniqueTempPath(target), uniqueTempPath(target)];
			expect(first).not.toBe(second);
			expect(first.startsWith(`${target}.tmp.${process.pid}.`)).toBe(true);
		} finally {
			now.mockRestore();
		}
	});
});

describe("a workspace load of an addon built from other sources", () => {
	const bindings = { __piNativesBuildVersion: () => packageJson.version };
	const workspace = () => ({ isWorkspaceLoad: true, nativeDir, packageVersion: packageJson.version });

	function notices(ctx: { isWorkspaceLoad: boolean }, status: NativeAddonStatus) {
		const written: string[] = [];
		reportStaleWorkspaceAddon(ctx, status, { write: text => written.push(text), state: { reported: false } });
		return written;
	}

	it("is stale and gets the notice", async () => {
		await build();
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");

		const status = describeLoadedAddon(bindings, addon, workspace());

		expect(status).toMatchObject({ stale: true, builtFromOtherSources: true, version: packageJson.version });
		const written = notices(workspace(), status);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(addon);
		expect(written[0]).toContain("built from Rust sources other than this checkout's");
		expect(written[0]).toContain("bun run build:native");
	});

	it("is current, and silent, when its stamp matches the checkout", async () => {
		await build();

		const status = describeLoadedAddon(bindings, addon, workspace());

		expect(status).toMatchObject({ stale: false, builtFromOtherSources: false });
		expect(notices(workspace(), status)).toEqual([]);
	});

	it("is never checked outside a workspace load", async () => {
		await build();
		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");
		const installed = { isWorkspaceLoad: false, nativeDir, packageVersion: packageJson.version };

		expect(describeLoadedAddon(bindings, addon, installed)).toMatchObject({
			stale: false,
			builtFromOtherSources: false,
		});
	});
});
