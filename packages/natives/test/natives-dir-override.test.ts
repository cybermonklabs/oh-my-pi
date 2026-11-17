import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initLoaderContext, prepareNativeVersionDir } from "../native/loader-state.js";
import { __resetNativesDirForTests, getNativesDir } from "../native/natives-dir.js";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"PI_NATIVES_DIR",
	"PI_CONFIG_DIR",
	"OMP_CONFIG_ROOT",
	"OMP_DOWNLOAD_ROOT",
	"XDG_CACHE_HOME",
	"PI_NATIVE_VARIANT",
	"__PI_NATIVE_VARIANT_CACHE",
] as const;
const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

/**
 * The loader's versioned directory under the rule, from the environment as it is now. A
 * process keeps its first answer, so each read of the rule resolves afresh.
 */
function versionedDirNow() {
	__resetNativesDirForTests();
	return initLoaderContext({ isCompiledBinary: true }).versionedDir;
}

describe("native addon directory override", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dir-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_NATIVE_VARIANT = "baseline";
		vi.spyOn(os, "homedir").mockReturnValue(home);
		__resetNativesDirForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetNativesDirForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("places the versioned cache outside a fresh HOME and takes precedence over initialized XDG", async () => {
		const shared = path.join(tempRoot, "shared");
		const xdgCache = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(xdgCache, "omp"), { recursive: true });
		process.env.PI_NATIVES_DIR = ` ${shared} `;

		__resetNativesDirForTests();
		const ctx = initLoaderContext({ isCompiledBinary: true });
		prepareNativeVersionDir(ctx.versionedDir);

		expect(ctx.versionedDir).toBe(path.join(shared, packageJson.version));
		process.env.XDG_CACHE_HOME = xdgCache;
		expect(versionedDirNow()).toBe(ctx.versionedDir);
		expect(await fs.readdir(shared)).toEqual([packageJson.version]);
		expect(await fs.readdir(home)).toEqual([]);
		expect(await fs.readdir(path.join(xdgCache, "omp"))).toEqual([]);
	});

	it("expands home-relative overrides before appending the package version", () => {
		process.env.PI_NATIVES_DIR = "~";
		expect(versionedDirNow()).toBe(path.join(home, packageJson.version));

		process.env.PI_NATIVES_DIR = " ~/unused/../shared ";
		expect(versionedDirNow()).toBe(path.join(home, "shared", packageJson.version));
	});

	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/natives"],
	])("falls back to the XDG cache root when the override is %s", async (_label, override) => {
		const xdgCache = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(xdgCache, "omp"), { recursive: true });
		process.env.XDG_CACHE_HOME = xdgCache;
		process.env.PI_NATIVES_DIR = override;

		expect(versionedDirNow()).toBe(
			path.join(xdgPlatform ? path.join(xdgCache, "omp") : path.join(home, ".omp"), "natives", packageJson.version),
		);
	});

	it("takes PI_NATIVES_DIR, then the download root, then the XDG cache root, then the config root", async () => {
		const downloads = path.join(tempRoot, "downloads");
		const configRoot = path.join(tempRoot, "config");
		const xdgCache = path.join(tempRoot, "cache");
		const versioned = versionedDirNow;
		process.env.OMP_CONFIG_ROOT = configRoot;
		expect(versioned()).toBe(path.join(configRoot, "natives", packageJson.version));
		await fs.mkdir(path.join(xdgCache, "omp"), { recursive: true });
		process.env.XDG_CACHE_HOME = xdgCache;
		expect(versioned()).toBe(
			path.join(xdgPlatform ? path.join(xdgCache, "omp") : configRoot, "natives", packageJson.version),
		);
		process.env.OMP_DOWNLOAD_ROOT = downloads;
		expect(versioned()).toBe(path.join(downloads, "natives", packageJson.version));
		process.env.PI_NATIVES_DIR = path.join(tempRoot, "shared");
		expect(versioned()).toBe(path.join(tempRoot, "shared", packageJson.version));
	});
});

describe("one natives directory per process", () => {
	let tempRoot = "";
	let saved: string | undefined;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dir-process-"));
		saved = process.env.PI_NATIVES_DIR;
		process.env.PI_NATIVES_DIR = path.join(tempRoot, "first");
		__resetNativesDirForTests();
	});

	afterEach(async () => {
		if (saved === undefined) delete process.env.PI_NATIVES_DIR;
		else process.env.PI_NATIVES_DIR = saved;
		__resetNativesDirForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("keeps its first answer when a directory variable changes later, as applying a .env file does", () => {
		const first = initLoaderContext({ isCompiledBinary: true }).nativesDir;
		process.env.PI_NATIVES_DIR = path.join(tempRoot, "from-dotenv");

		expect(first).toBe(path.join(tempRoot, "first"));
		expect(initLoaderContext({ isCompiledBinary: true }).nativesDir).toBe(first);
		expect(getNativesDir()).toBe(first);
	});

	it("gives a worker thread the main thread's answer", async () => {
		const first = getNativesDir();
		// The worker starts with a copy of this environment, variable changed and all.
		process.env.PI_NATIVES_DIR = path.join(tempRoot, "from-dotenv");
		const worker = new Worker(new URL("./fixtures/natives-dir-worker.ts", import.meta.url).href, { type: "module" });
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		worker.onmessage = event => resolve(event.data);
		worker.onerror = event => reject(event);
		const answer = await promise;
		worker.terminate();

		expect(answer).toBe(first);
	});

	it("lets a child process resolve for itself", async () => {
		getNativesDir();
		const childDir = path.join(tempRoot, "child");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`console.log((await import(${JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"))})).getNativesDir())`,
			],
			{ env: { ...process.env, PI_NATIVES_DIR: childDir }, stdout: "pipe", stderr: "inherit" },
		);
		const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

		expect(exitCode).toBe(0);
		expect(output.trim()).toBe(childDir);
	});

	it("takes an inherited answer only from its own process and parent", () => {
		const elsewhere = path.join(tempRoot, "elsewhere");
		// A process whose pid was reused: same pid, another parent.
		process.env.__PI_NATIVES_DIR_CACHE = JSON.stringify({ pid: process.pid, ppid: process.ppid + 1, dir: elsewhere });
		expect(getNativesDir()).toBe(path.join(tempRoot, "first"));

		__resetNativesDirForTests();
		// The main thread of this process, as a worker thread sees it.
		process.env.__PI_NATIVES_DIR_CACHE = JSON.stringify({ pid: process.pid, ppid: process.ppid, dir: elsewhere });
		expect(getNativesDir()).toBe(elsewhere);
	});
});
