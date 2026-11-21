/**
 * A native build (`scripts/build-bindings.ts`, `scripts/bazel-natives.ts`) puts its addons in
 * place with the record of the sources it compiled. The sources are settled once, first, so a
 * settle that throws (a listed file that cannot be opened) installs nothing: each old addon
 * keeps the record that names it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addonSourcesState,
	addonSourcesStampPath,
	CARGO_SOURCE_ROOTS,
	readRustSources,
	writeAddonSourcesStamp,
} from "../native/workspace-sources.js";
import { installBuiltAddon } from "../scripts/install-addon";

let repo = "";
let addon = "";
let built = "";
/** A second destination, as a Bazel build that installs several outputs has. */
let elsewhere = "";

beforeEach(async () => {
	repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-install-"));
	addon = path.join(repo, "packages/natives/native/pi_natives.linux-x64-modern.node");
	built = path.join(repo, "packages/natives/native/.build/out/pi_natives.linux-x64-gnu.node");
	elsewhere = path.join(repo, "elsewhere/pi_natives.linux-x64-modern.node");
	await Bun.write(path.join(repo, "Cargo.toml"), "[workspace]\n");
	await Bun.write(path.join(repo, "Cargo.lock"), "version = 4\n");
	await Bun.write(path.join(repo, "crates/pi-natives/src/lib.rs"), "pub fn grep() {}\n");
	// The addon of the build before, with its record.
	await Bun.write(addon, "old addon bytes");
	writeAddonSourcesStamp(addon, readRustSources(repo, CARGO_SOURCE_ROOTS), { builder: "cargo" });
	await Bun.write(built, "new addon bytes");
});

afterEach(async () => {
	await fs.rm(repo, { recursive: true, force: true });
});

/**
 * Run the install in a process of its own, with the shared reader's `open` of `lib.rs` failing
 * with `EACCES` when `deny` is set (the seam must not reach another test). Returns the error
 * code the install threw, or `"installed"`.
 */
function installInChild(deny: boolean): unknown {
	const installTs = path.join(import.meta.dir, "../scripts/install-addon.ts");
	const sourcesJs = path.join(import.meta.dir, "../native/workspace-sources.js");
	const regularFileJs = path.join(import.meta.dir, "../native/regular-file.js");
	const lib = path.join(repo, "crates/pi-natives/src/lib.rs");
	const script = `const { installBuiltAddon } = await import(${JSON.stringify(installTs)});
const { readRustSources, CARGO_SOURCE_ROOTS } = await import(${JSON.stringify(sourcesJs)});
const { __setRegularFileIoForTests } = await import(${JSON.stringify(regularFileJs)});
const nodeFs = await import("node:fs");
const sourcesBeforeBuild = readRustSources(${JSON.stringify(repo)}, CARGO_SOURCE_ROOTS);
if (${deny}) {
	__setRegularFileIoForTests({
		openSync(file, flags, mode) {
			if (file === ${JSON.stringify(lib)}) throw Object.assign(new Error(\`EACCES: permission denied, open '\${file}'\`), { code: "EACCES" });
			return nodeFs.openSync(file, flags, mode);
		},
	});
}
let result;
try {
	await installBuiltAddon({
		addons: [
			{ built: ${JSON.stringify(built)}, destination: ${JSON.stringify(addon)} },
			{ built: ${JSON.stringify(built)}, destination: ${JSON.stringify(elsewhere)} },
		],
		repoRoot: ${JSON.stringify(repo)},
		sourcesBeforeBuild,
		build: { builder: "cargo" },
	});
	result = "installed";
} catch (error) {
	result = error.code;
}
console.log(JSON.stringify(result));
process.exit(0);`;
	const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
		stderr: "pipe",
		timeout: 15_000,
		killSignal: "SIGKILL",
	});
	expect(child.stderr.toString()).toBe("");
	return JSON.parse(child.stdout.toString());
}

describe("installing a locally built addon", () => {
	it("puts each addon in place with a record that names it", async () => {
		await fs.mkdir(path.dirname(elsewhere), { recursive: true });
		expect(installInChild(false)).toBe("installed");

		for (const destination of [addon, elsewhere]) {
			expect(await Bun.file(destination).text()).toBe("new addon bytes");
			expect(addonSourcesState(destination, repo)).toBe("current");
		}
	}, 60_000);

	it("installs nothing when the settle throws, so the old addon keeps its record", async () => {
		await fs.mkdir(path.dirname(elsewhere), { recursive: true });
		const recordBefore = await Bun.file(addonSourcesStampPath(addon)).text();

		expect(installInChild(true)).toBe("EACCES");

		expect(await Bun.file(addon).text()).toBe("old addon bytes");
		expect(await Bun.file(addonSourcesStampPath(addon)).text()).toBe(recordBefore);
		expect(addonSourcesState(addon, repo)).toBe("current");
		expect(await Bun.file(elsewhere).exists()).toBe(false);
	}, 60_000);

	it("records other sources for a file edited during the build and put back, times and all", async () => {
		const lib = path.join(repo, "crates/pi-natives/src/lib.rs");
		// A whole-second time, so it can be put back exactly.
		const time = new Date(1_700_000_000_000);
		await fs.utimes(lib, time, time);
		const sourcesBeforeBuild = readRustSources(repo, CARGO_SOURCE_ROOTS);
		// On a kernel whose timestamps are coarse, the clock moves on before the edit.
		await Bun.sleep(25);
		// The compiler reads an edit that is undone before the build ends.
		await Bun.write(lib, "pub fn edited_during_build() {}\n");
		await Bun.write(lib, "pub fn grep() {}\n");
		await fs.utimes(lib, time, time);

		await installBuiltAddon({
			addons: [{ built, destination: addon }],
			repoRoot: repo,
			sourcesBeforeBuild,
			build: { builder: "cargo" },
		});

		expect(await Bun.file(addon).text()).toBe("new addon bytes");
		expect(addonSourcesState(addon, repo)).toBe("other");
	});

	it("removes the record of an addon installed without one", async () => {
		await installBuiltAddon({ addons: [{ built, destination: addon }], repoRoot: repo, build: {} });

		expect(await Bun.file(addon).text()).toBe("new addon bytes");
		expect(await Bun.file(addonSourcesStampPath(addon)).exists()).toBe(false);
	});
});
