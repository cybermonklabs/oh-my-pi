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

/** Git with no user or system configuration, so a test repository behaves the same on any machine. */
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

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
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(path.join(repo, "crates/pi-natives/src/lib.rs"), later, later);

		expect(addonSourcesState(addon, repo)).toBe("current");
		// The content check ran once for this state of the tree; its answer is kept, so the
		// next start reads only file sizes and times.
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.seen.fingerprint).toBe(readRustSources(repo, CARGO_SOURCE_ROOTS).fingerprint);
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

	/**
	 * Run `body` (JS source) in a process of its own, bounded, with `readRustSources`,
	 * `writeAddonSourcesStamp` and `addonSourcesState` in scope: a read that blocked would hang
	 * this test runner otherwise. Returns what the body printed, or null when the bound killed it.
	 */
	function bounded(body: string): unknown {
		const sourcesJs = path.join(import.meta.dir, "../native/workspace-sources.js");
		const script = `const { readRustSources, writeAddonSourcesStamp, addonSourcesState, CARGO_SOURCE_ROOTS } = await import(${JSON.stringify(sourcesJs)});
const repo = ${JSON.stringify(repo)};
const addon = ${JSON.stringify(addon)};
${body}`;
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

	it("are other sources when a file is added to a scanned directory, committed or not", async () => {
		await checkout();
		await Bun.write(path.join(repo, defs, "zz-probe.toml"), "[filters.zz_probe]\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "new filter");
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
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(path.join(repo, defs), later, later);
		expect(addonSourcesState(addon, repo)).toBe("current");
		// The start remembers the directory's new time, so the next start lists nothing.
		const stamp = await Bun.file(`${addon}.sources.json`).json();
		expect(stamp.scanned[0].dirs[defs]).toBe((await fs.stat(path.join(repo, defs))).mtimeMs);
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
		for (const suffix of ["-moved", "-origin", "-saved", "-gitdir", "-super", "-link"])
			await fs.rm(`${repo}${suffix}`, { recursive: true, force: true });
	});

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
