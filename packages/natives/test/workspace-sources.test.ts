/**
 * A workspace checkout loads the addon its own native build left in `native/`, and skips
 * release validation there (`validateLoadedBindings`), so an addon built before the checkout's
 * Rust sources changed used to load as current: same release, other code. The build now
 * records which Rust sources it compiled (`<addon>.sources.json`), and a workspace load
 * compares that record with the checkout, reporting a mismatch through the stale-addon notice.
 * These are the loader's half (`native/workspace-sources.js`); the build's half
 * (`scripts/rust-sources.ts`) is `rust-sources.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { describeLoadedAddon, type NativeAddonStatus, reportStaleWorkspaceAddon } from "../native/loader-state.js";
import { addonSourcesState, checkoutId, uniqueTempPath } from "../native/workspace-sources.js";
import packageJson from "../package.json" with { type: "json" };
import {
	CARGO_SOURCE_ROOTS,
	readRustSources,
	settleRustSources,
	writeAddonSourcesStamp,
} from "../scripts/rust-sources";
import {
	addon,
	bounded,
	build,
	CARGO_BUILD,
	checkout,
	createSourcesCheckout,
	defs,
	denyOpen,
	freezeDirectory,
	git,
	mkfifo,
	nativeDir,
	pinnedClockSource,
	readLater,
	readSoon,
	removeSourcesCheckout,
	repo,
} from "./sources-fixture";

beforeEach(createSourcesCheckout);
afterEach(removeSourcesCheckout);

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
		// The build reads files it has just written, so it keeps no fingerprint, and the first
		// start reads the bytes.
		await readSoon(() => build());
		const recorded = async () => (await Bun.file(`${addon}.sources.json`).json()).seen.fingerprint;
		expect(await recorded()).toBeNull();
		expect(await readSoon(() => addonSourcesState(addon, repo))).toBe("current");
		expect(await recorded()).toBeNull();
		// Control: a start more than two seconds after the writes keeps the state it read.
		expect(await readLater(() => addonSourcesState(addon, repo))).toBe("current");
		expect(await recorded()).toEqual(expect.any(String));
	});

	it("see a same-size edit made in the timestamp tick of the start that read the file (git's racy case)", async () => {
		await readSoon(() => build());
		const target = path.join(repo, "crates/pi-natives/src/lib.rs");
		// On a kernel whose clock is coarse, a file read and then edited in one tick keeps its
		// times. The seam gives the file the times it had at the read, for the read and after the
		// edit, as such a kernel does; the edit keeps the size and the inode. Both starts read
		// within two seconds of the writes, as in one tick.
		expect(
			bounded(`${pinnedClockSource()}
const target = ${JSON.stringify(target)};
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

	it("read a record of another shape as unknown until the next build", async () => {
		await readLater(() => build());
		const stampPath = `${addon}.sources.json`;
		const stamp = await Bun.file(stampPath).json();
		// A kept state under no rule, or under another one, as only earlier commits of this
		// change wrote.
		for (const version of [undefined, 0, 1]) {
			await Bun.write(stampPath, JSON.stringify({ ...stamp, seen: { ...stamp.seen, version } }));
			expect(addonSourcesState(addon, repo)).toBe("unknown");
		}
		// A scanned directory's time kept as a number.
		const scanned = [
			{
				dir: "crates/pi-natives",
				globs: [{ include: ["src/*.rs"], exclude: [] }],
				dirs: { "crates/pi-natives/src": 1 },
			},
		];
		await Bun.write(stampPath, JSON.stringify({ ...stamp, scanned }));
		expect(addonSourcesState(addon, repo)).toBe("unknown");

		// Control: the record as the build wrote it.
		await Bun.write(stampPath, JSON.stringify(stamp));
		expect(addonSourcesState(addon, repo)).toBe("current");
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
});

describe("inputs a build takes in that no listed file names", () => {
	it("are other sources, at once, when a recorded file is replaced by a FIFO", async () => {
		await checkout();
		const recorded = path.join(repo, "crates/pi-shell/src/lib.rs");
		await fs.rm(recorded);
		expect(Bun.spawnSync(["mkfifo", recorded]).exitCode).toBe(0);

		expect(bounded("console.log(JSON.stringify(addonSourcesState(addon, repo)));")).toBe("other");
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

	it("see a matching file added to a scanned directory in the timestamp tick of the start that listed it (git's racy case)", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "README.md"), "# filter defs\n");
		expect(
			bounded(`${pinnedClockSource()}
${freezeDirectory()}
const first = addonSourcesState(addon, repo);
const kept = keptFor();
nodeFs.writeFileSync(dir + "/zz.toml", "[filters.zz]\\n");
const second = addonSourcesState(addon, repo);
console.log(JSON.stringify({ first, kept, second }));`),
		).toEqual({ first: "current", kept: "unsettled", second: "other" });
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
