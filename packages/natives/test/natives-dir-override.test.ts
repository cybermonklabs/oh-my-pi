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

	it("gives the child processes it starts its answer, whatever the variables say since", async () => {
		const savedDownloadRoot = process.env.OMP_DOWNLOAD_ROOT;
		// A first answer from a fallback root, with no PI_NATIVES_DIR set.
		delete process.env.PI_NATIVES_DIR;
		process.env.OMP_DOWNLOAD_ROOT = path.join(tempRoot, "first-root");
		__resetNativesDirForTests();
		try {
			const first = getNativesDir();
			// What a `.env` file read after the first call can set.
			process.env.OMP_DOWNLOAD_ROOT = path.join(tempRoot, "from-dotenv");
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`console.log((await import(${JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"))})).getNativesDir())`,
				],
				{ env: process.env, stdout: "pipe", stderr: "inherit" },
			);
			const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

			expect(first).toBe(path.join(tempRoot, "first-root", "natives"));
			expect(exitCode).toBe(0);
			expect(output.trim()).toBe(first);
		} finally {
			if (savedDownloadRoot === undefined) delete process.env.OMP_DOWNLOAD_ROOT;
			else process.env.OMP_DOWNLOAD_ROOT = savedDownloadRoot;
		}
	});

	it("takes an inherited answer only from this process", () => {
		const elsewhere = path.join(tempRoot, "elsewhere");
		getNativesDir();
		const own = JSON.parse(process.env.__PI_NATIVES_DIR_CACHE!);
		__resetNativesDirForTests();
		// Another process given this pid later: same pid, another start time (Linux), or a
		// recorded parent that still runs and is not this process's parent.
		const other =
			own.start === undefined
				? { pid: process.pid, ppid: process.pid, dir: elsewhere }
				: { pid: process.pid, ppid: process.ppid, start: `${Number(own.start) + 1}`, dir: elsewhere };
		process.env.__PI_NATIVES_DIR_CACHE = JSON.stringify(other);
		expect(getNativesDir()).toBe(path.join(tempRoot, "first"));

		__resetNativesDirForTests();
		// This process, as its worker threads see it.
		process.env.__PI_NATIVES_DIR_CACHE = JSON.stringify({ ...own, dir: elsewhere });
		expect(getNativesDir()).toBe(elsewhere);
	});

	it("without a start time, takes the answer of a process whose recorded parent has exited", async () => {
		const exited = Bun.spawn([process.execPath, "-e", ""]);
		await exited.exited;
		const elsewhere = path.join(tempRoot, "elsewhere");
		// Re-parented: the parent recorded at the first call is gone, and the live one differs.
		process.env.__PI_NATIVES_DIR_CACHE = JSON.stringify({ pid: process.pid, ppid: exited.pid, dir: elsewhere });
		expect(getNativesDir()).toBe(elsewhere);

		__resetNativesDirForTests();
		// A recorded parent that still runs and is not this process's parent: another process.
		process.env.__PI_NATIVES_DIR_CACHE = JSON.stringify({ pid: process.pid, ppid: process.pid, dir: elsewhere });
		expect(getNativesDir()).toBe(path.join(tempRoot, "first"));
	});

	it.each(["parent alive", "parent exited"] as const)(
		"gives a worker thread started later the process's answer (%s)",
		async arm => {
			const natives = JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"));
			const worker = path.join(tempRoot, "worker.ts");
			const child = path.join(tempRoot, "child.ts");
			const parent = path.join(tempRoot, "parent.ts");
			await Bun.write(worker, `postMessage((await import(${natives})).getNativesDir());\n`);
			// The child resolves, has the variable changed (as a `.env` file can), tells its parent
			// it is ready, and in the "parent exited" arm waits to be re-parented before it starts
			// a worker. Re-parenting is the kernel's, with no event to await, so the child polls
			// its parent pid. It prints its result on the stdout it shares with the parent.
			await Bun.write(
				child,
				[
					`const first = (await import(${natives})).getNativesDir();`,
					`const ppidAtFirst = process.ppid;`,
					`process.env.PI_NATIVES_DIR = ${JSON.stringify(path.join(tempRoot, "from-dotenv"))};`,
					`process.stderr.write("ready\\n");`,
					`if (process.argv[2] === "parent exited") { const until = Date.now() + 20_000; while (process.ppid === ppidAtFirst && Date.now() < until) await Bun.sleep(20); }`,
					`const w = new Worker(${JSON.stringify(worker)}, { type: "module" });`,
					`const answer = await new Promise(resolve => { w.onmessage = e => resolve(e.data); });`,
					`w.terminate();`,
					`console.log(JSON.stringify({ first, answer, reparented: process.ppid !== ppidAtFirst }));`,
				].join("\n"),
			);
			// The parent starts the child detached, waits for its "ready", and exits at once in the
			// "parent exited" arm, so the child outlives it.
			await Bun.write(
				parent,
				[
					`const arm = process.argv[2];`,
					`const child = Bun.spawn([process.execPath, ${JSON.stringify(child)}, arm], { stdio: ["ignore", "inherit", "pipe"], detached: true });`,
					`child.unref();`,
					`await child.stderr.getReader().read();`,
					`if (arm === "parent alive") await child.exited;`,
				].join("\n"),
			);

			const run = Bun.spawn([process.execPath, parent, arm], {
				env: process.env,
				stdout: "pipe",
				stderr: "inherit",
			});
			// The pipe closes when its last writer, the child, exits.
			const output = await new Response(run.stdout).text();
			expect(await run.exited).toBe(0);
			const { first, answer, reparented } = JSON.parse(output.trim().split("\n").at(-1)!);

			expect(reparented).toBe(arm === "parent exited");
			expect(first).toBe(path.join(tempRoot, "first"));
			expect(answer).toBe(first);
		},
		60_000,
	);
});
