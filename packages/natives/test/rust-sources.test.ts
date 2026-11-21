/**
 * The build's half of the sources record (`scripts/rust-sources.ts`): which source files a native
 * build lists and reads, how it settles them after the build, and the record it writes or copies.
 * The loader's half, which judges a record against the checkout, is `workspace-sources.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addonSourcesState } from "../native/workspace-sources.js";
import {
	BAZEL_SOURCE_ROOTS,
	CARGO_SOURCE_ROOTS,
	copyAddonSourcesStamp,
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
	gitBinary,
	gitEnv,
	mkfifo,
	pinnedClockSource,
	removeSourcesCheckout,
	repo,
} from "./sources-fixture";

beforeEach(createSourcesCheckout);
afterEach(removeSourcesCheckout);

describe("the Rust sources a workspace addon was built from", () => {
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

describe("inputs a build takes in that no listed file names", () => {
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

	it("are other sources until the next build for a matching file added to a scanned directory in the tick of the build's first read", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "README.md"), "# filter defs\n");
		expect(
			bounded(`${pinnedClockSource()}
${freezeDirectory()}
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
			bounded(`${pinnedClockSource()}
${freezeDirectory()}
const before = readRustSources(repo, CARGO_SOURCE_ROOTS);
writeAddonSourcesStamp(addon, settleRustSources(repo, before), {});
const kept = keptFor();
// After the build, in the same tick: the frozen state hides the file from a state check.
nodeFs.writeFileSync(dir + "/zz.toml", "[filters.zz]\\n");
console.log(JSON.stringify({ kept, state: addonSourcesState(addon, repo) }));`),
		).toEqual({ kept: "unsettled", state: "other" });
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
