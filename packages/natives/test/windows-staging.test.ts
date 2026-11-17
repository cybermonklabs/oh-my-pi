/**
 * Regression for the Windows `bun install -g` update path: when an `omp`
 * process is running, bun cannot overwrite a locked
 * `node_modules/@oh-my-pi/pi-natives/native/pi_natives.win32-x64.node` during
 * package update and silently keeps the old binary next to the new ESM
 * wrapper. The next launch then throws `<sym> is not a function` deep inside
 * tool execution (see Discord report, 2026-05-14).
 *
 * The fix has two halves, both pinned by this test:
 *   1. The loader stages the leaf package's `<filename>.node` →
 *      `<natives dir>/<version>-<digest prefix>/<filename>.node`, named by the digest
 *      the leaf package records when it is built (`nativeAddons` in its package.json),
 *      so the running process holds its OS-level handle on a path bun is never asked
 *      to overwrite, and two installs of one release never share a staged copy.
 *      Gated to Windows + node_modules installs + non-compiled mode by
 *      `shouldStageNodeModulesAddon`, and to a leaf package that records its addons.
 *   2. `resolveLoaderCandidates` puts the staged path ahead of the
 *      `node_modules` path so subsequent updates land in node_modules without
 *      contention.
 *
 * Both behaviors are off in workspace dev (`bun --cwd=packages/natives run
 * build`) and on non-Windows so the regular path is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAddonFilenames,
	initLoaderContext,
	maybeStageNodeModulesAddon,
	resolveLoaderCandidates,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import { __resetNativesDirForTests } from "../native/natives-dir.js";
import packageJson from "../package.json" with { type: "json" };
import { generateNpmPackages } from "../scripts/gen-npm-packages";
import { durableWriteCalls, recordingFs } from "./recording-fs";

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@oh-my-pi\\pi-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\oh-my-pi\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@oh-my-pi/pi-natives/native";

describe("windows native addon staging", () => {
	it("stages only on Windows node_modules installs", () => {
		// Windows + node_modules install + npm (not compiled) → stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);

		// Windows workspace dev: nativeDir lives outside node_modules → never stage,
		// otherwise rebuilds via `bun --cwd=packages/natives run build` would be
		// shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);

		// Windows compiled binary: the embedded-addon extractor already populates
		// versionedDir; staging from a non-existent nativeDir would race that.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);

		// Non-Windows: bun's atomic rename works fine, no need to stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "darwin",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("prepends versionedDir candidates ahead of node_modules when staging on Windows", () => {
		const versionedDir = "C:\\Users\\Admin\\.omp\\natives\\15.0.1";
		const userDataDir = "C:\\Users\\Admin\\AppData\\Local\\omp";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir,
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.win32-x64-baseline.node");
		const versionedDefault = path.join(versionedDir, "pi_natives.win32-x64.node");
		const nodeModulesBaseline = path.join(winNodeModulesNativeDir, "pi_natives.win32-x64-baseline.node");

		// Staged paths must be probed first so the running process locks the cache
		// copy and bun is free to replace the node_modules copy on next update.
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(versionedDefault);
		expect(candidates.indexOf(versionedBaseline)).toBeLessThan(candidates.indexOf(nodeModulesBaseline));

		// User-data dir is reserved for compiled-binary mode — staging must not
		// quietly start probing it on npm installs (where it never contains the
		// addon anyway).
		const userDataBaseline = path.join(userDataDir, "pi_natives.win32-x64-baseline.node");
		expect(candidates).not.toContain(userDataBaseline);
	});

	it("classifies only Windows node_modules paths case-insensitively", () => {
		const leafPackageDir = "/tmp/node_modules/@oh-my-pi/pi-natives-darwin-arm64";
		const uppercaseNodeModulesNativeDir = "/tmp/NODE_MODULES/@oh-my-pi/pi-natives/native";
		const variantCacheKey = "__PI_NATIVE_VARIANT_CACHE";
		const previousVariantCache = process.env[variantCacheKey];
		try {
			const workspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/oh-my-pi/packages/natives/native",
				leafPackageDir,
			});
			const installed = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/node_modules/@oh-my-pi/pi-natives/native",
				leafPackageDir,
			});
			const uppercaseWorkspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const uppercaseWindowsInstall = initLoaderContext({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const leafCandidate = path.join(leafPackageDir, installed.addonFilenames[0]);
			const windowsLeafCandidate = path.join(leafPackageDir, uppercaseWindowsInstall.addonFilenames[0]);
			const workspaceCandidate = path.join(uppercaseNodeModulesNativeDir, uppercaseWorkspace.addonFilenames[0]);

			expect(workspace.isWorkspaceLoad).toBe(true);
			expect(workspace.leafPackageDir).toBeNull();
			expect(workspace.candidates).not.toContain(leafCandidate);
			expect(installed.isWorkspaceLoad).toBe(false);
			expect(installed.leafPackageDir).toBe(leafPackageDir);
			expect(installed.candidates).toContain(leafCandidate);
			expect(installed.candidates[0]).toBe(leafCandidate);

			expect(uppercaseWorkspace.isWorkspaceLoad).toBe(true);
			expect(uppercaseWorkspace.leafPackageDir).toBeNull();
			expect(uppercaseWorkspace.candidates[0]).toBe(workspaceCandidate);

			expect(uppercaseWindowsInstall.isWorkspaceLoad).toBe(false);
			expect(uppercaseWindowsInstall.leafPackageDir).toBe(leafPackageDir);
			// This leaf is not on disk, so it records no addons and nothing is staged; the tests
			// below stage from an uppercase `NODE_MODULES` install whose leaf does.
			expect(uppercaseWindowsInstall.stageFromNodeModules).toBe(false);
			expect(uppercaseWindowsInstall.candidates).toContain(windowsLeafCandidate);
		} finally {
			if (previousVariantCache === undefined) delete process.env[variantCacheKey];
			else process.env[variantCacheKey] = previousVariantCache;
		}
	});
});

describe("windows staging into the leaf package's digest directory", () => {
	const ENV_KEYS = ["PI_NATIVES_DIR", "PI_NATIVE_VARIANT", "__PI_NATIVE_VARIANT_CACHE"] as const;
	const tag = `win32-${process.arch}`;
	const leafAddonFilenames =
		process.arch === "x64"
			? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}-modern.node`]
			: [`pi_natives.${tag}.node`];
	let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let root = "";
	let nativesDir = "";

	beforeEach(async () => {
		saved = {};
		for (const key of ENV_KEYS) if (process.env[key] !== undefined) saved[key] = process.env[key];
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-staging-"));
		nativesDir = path.join(root, "natives");
		process.env.PI_NATIVES_DIR = nativesDir;
		process.env.PI_NATIVE_VARIANT = "modern";
		delete process.env.__PI_NATIVE_VARIANT_CACHE;
		// One natives directory per process: resolve it again from this test's environment.
		__resetNativesDirForTests();
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetNativesDirForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	/** Generate a leaf package, as a release does, holding addons whose bytes name `install`. */
	async function leafPackage(install: string) {
		const packageDir = path.join(root, `package-${install}`);
		await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ version: packageJson.version }));
		await Bun.write(path.join(packageDir, "LICENSE"), "MIT\n");
		await Bun.write(path.join(packageDir, "THIRD-PARTY-NOTICES.txt"), "Notices\n");
		const addons = new Map(leafAddonFilenames.map(filename => [filename, `install ${install} ${filename}`]));
		for (const [filename, bytes] of addons) await Bun.write(path.join(packageDir, "native", filename), bytes);
		const [leaf] = await generateNpmPackages({ packageDir, tags: [tag] });
		const digest: string = (await Bun.file(path.join(leaf.dir, "package.json")).json()).nativeAddons.digest;
		return {
			leafDir: leaf.dir,
			addons,
			stagedDir: path.join(nativesDir, `${packageJson.version}-${digest.slice(0, 12)}`),
		};
	}

	function windowsInstall(leafPackageDir: string) {
		return initLoaderContext({
			platform: "win32",
			isCompiledBinary: false,
			nativeDir: path.join(root, "NODE_MODULES/@oh-my-pi/pi-natives/native"),
			leafPackageDir,
		});
	}

	it("stages into its own digest directory and never loads another install's copy", async () => {
		const install = await leafPackage("A");
		const ctx = windowsInstall(install.leafDir);
		const first = ctx.addonFilenames.find(filename => install.addons.has(filename))!;
		// Another install of this release, of the same size: where the loader staged before
		// build digests, and in that install's own digest directory.
		const other = install.addons.get(first)!.replace("install A", "install B");
		await Bun.write(path.join(nativesDir, packageJson.version, first), other);
		await Bun.write(path.join(nativesDir, `${packageJson.version}-bbbbbbbbbbbb`, first), other);
		const errors: string[] = [];

		const staged = maybeStageNodeModulesAddon(ctx, errors);

		expect(errors).toEqual([]);
		expect(staged).toBe(path.join(install.stagedDir, first));
		expect(ctx.candidates[0]).toBe(staged!);
		expect(await Bun.file(staged!).text()).toBe(install.addons.get(first)!);
	});

	it("replaces a truncated copy in its own digest directory", async () => {
		const install = await leafPackage("A");
		const ctx = windowsInstall(install.leafDir);
		const first = ctx.addonFilenames.find(filename => install.addons.has(filename))!;
		await Bun.write(path.join(install.stagedDir, first), install.addons.get(first)!.slice(0, 5));

		const staged = maybeStageNodeModulesAddon(ctx, []);

		expect(await Bun.file(staged!).text()).toBe(install.addons.get(first)!);
	});

	it("reuses its staged copy and marks the directory used", async () => {
		const install = await leafPackage("A");
		const ctx = windowsInstall(install.leafDir);
		const staged = maybeStageNodeModulesAddon(ctx, [])!;
		const { ino } = await fs.stat(staged);
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		await fs.utimes(install.stagedDir, twoDaysAgo, twoDaysAgo);

		expect(maybeStageNodeModulesAddon(ctx, [])).toBe(staged);

		expect((await fs.stat(staged)).ino).toBe(ino);
		expect(Date.now() - (await fs.stat(install.stagedDir)).mtimeMs).toBeLessThan(60_000);
	});

	it("stages nothing from a leaf package that records no addons", async () => {
		const install = await leafPackage("A");
		const manifestPath = path.join(install.leafDir, "package.json");
		const { nativeAddons: _, ...manifest } = await Bun.file(manifestPath).json();
		await Bun.write(manifestPath, JSON.stringify(manifest));
		const ctx = windowsInstall(install.leafDir);

		expect(ctx.stageFromNodeModules).toBe(false);
		expect(maybeStageNodeModulesAddon(ctx, [])).toBeNull();
		expect(ctx.candidates.filter(candidate => candidate.startsWith(nativesDir))).toEqual([]);
		expect(await fs.exists(nativesDir)).toBe(false);
	});

	it.each([
		["a null entry", [null]],
		["an entry without a SHA-256", [{ filename: "pi_natives.win32-x64-modern.node", size: 1 }]],
		["an entry with a fractional size", [{ filename: "x.node", size: 1.5, sha256: "0".repeat(64) }]],
		["a files list that is no list", { filename: "x.node" }],
	])("stages nothing, and never throws, from a leaf whose addon list has %s", async (_label, files) => {
		const install = await leafPackage("A");
		const manifestPath = path.join(install.leafDir, "package.json");
		const manifest = await Bun.file(manifestPath).json();
		await Bun.write(manifestPath, JSON.stringify({ ...manifest, nativeAddons: { ...manifest.nativeAddons, files } }));
		const ctx = windowsInstall(install.leafDir);
		const errors: string[] = [];

		const staged = maybeStageNodeModulesAddon(ctx, errors);

		expect(staged).toBeNull();
		expect(ctx.stageFromNodeModules).toBe(false);
		expect(errors).toEqual([]);
		expect(await fs.exists(nativesDir)).toBe(false);
	});

	it("syncs each staged addon before renaming it into place, and its directory after", async () => {
		const install = await leafPackage("A");
		const ctx = windowsInstall(install.leafDir);
		const { io, calls } = recordingFs();

		maybeStageNodeModulesAddon(ctx, [], io);

		const staged = ctx.addonFilenames.filter(filename => install.addons.has(filename));
		expect(staged.length).toBeGreaterThan(0);
		expect(calls).toEqual(
			staged.flatMap(filename => durableWriteCalls(path.join(install.stagedDir, filename), install.stagedDir)),
		);
	});
});
