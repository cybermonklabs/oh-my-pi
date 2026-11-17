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
import { describeLoadedAddon, type NativeAddonStatus, reportStaleWorkspaceAddon } from "../native/loader-state.js";
import {
	addonSourcesState,
	BAZEL_SOURCE_ROOTS,
	CARGO_SOURCE_ROOTS,
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
