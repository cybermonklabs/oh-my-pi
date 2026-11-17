/**
 * A workspace checkout loads the addon its own native build left in `native/`, and skips
 * release validation there (`validateLoadedBindings`), so an addon built before the checkout's
 * Rust sources changed used to load as current: same release, other code. The build now
 * records which Rust sources it compiled (`<addon>.sources.json`), and a workspace load
 * compares that record with the checkout, reporting a mismatch through the stale-addon notice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

describe("the Rust sources a workspace addon was built from", () => {
	it("are current until a source file's content changes", async () => {
		await build();
		expect(addonSourcesState(addon, repo)).toBe("current");

		await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep2() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("are other sources when a file is added, removed, or the lock file changes", async () => {
		await build();
		await Bun.write(path.join(repo, "crates/pi-natives/src/new.rs"), "pub fn new() {}\n");
		expect(addonSourcesState(addon, repo)).toBe("other");
		await fs.rm(path.join(repo, "crates/pi-natives/src/new.rs"));
		expect(addonSourcesState(addon, repo)).toBe("current");
		await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n# changed\n");
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
