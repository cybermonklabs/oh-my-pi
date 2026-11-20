import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initLoaderContext, prepareNativeVersionDir } from "../native/loader-state.js";
import {
	__resetNativesDirForTests,
	getNativesDir,
	nativesDirHandoff,
	nativesDirHandoffDir,
	nativesDirInputNames,
} from "../native/natives-dir.js";
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

	it("puts nothing of its answer in the environment of a child process", async () => {
		// omp resolves at start, then starts commands and programs with copies of its environment
		// (`{ ...process.env }`, as the debugger, MCP and language-server spawns do).
		const nativesDirJs = JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"));
		const printer =
			"console.log(JSON.stringify(Object.keys(process.env).filter(name => name.startsWith('__PI_NATIVES_DIR'))))";
		const report = [
			`const { getNativesDir } = await import(${nativesDirJs});`,
			"getNativesDir();",
			`const child = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(printer)}], { env: { ...process.env } });`,
			"console.log(child.stdout.toString().trim());",
		].join("\n");
		const env: Record<string, string | undefined> = { ...process.env };
		for (const name of Object.keys(env)) if (name.startsWith("__PI_NATIVES_DIR")) delete env[name];
		const child = Bun.spawn([process.execPath, "-e", report], { env, stdout: "pipe", stderr: "inherit" });
		const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

		expect(exitCode).toBe(0);
		expect(JSON.parse(output.trim())).toEqual([]);
	});

	describe("a handoff to a child that is omp", () => {
		const nativesDirJs = JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"));
		// The child prints its answer, then the answer of a program it starts with its own
		// environment, as Bun does when a spawn names no `env`.
		const probe = [
			`const mod = await import(${nativesDirJs});`,
			"const own = mod.getNativesDir();",
			`const grandchild = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(`console.log((await import(${nativesDirJs})).getNativesDir())`)}]);`,
			"console.log(JSON.stringify({ own, grandchild: grandchild.stdout.toString().trim(), handoffLeft: process.env.__PI_NATIVES_DIR_HANDOFF ?? null }));",
		].join("\n");

		async function runChild(env: Record<string, string | undefined>) {
			const child = Bun.spawn([process.execPath, "-e", probe], { env, stdout: "pipe", stderr: "inherit" });
			const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			expect(exitCode).toBe(0);
			return JSON.parse(output.trim()) as { own: string; grandchild: string; handoffLeft: string | null };
		}

		it("is taken by the child it was written for, and by no program that child starts", async () => {
			const handedOver = path.join(tempRoot, "handed-over");
			const env: Record<string, string | undefined> = {
				...process.env,
				PI_NATIVES_DIR: path.join(tempRoot, "child"),
			};
			env.__PI_NATIVES_DIR_HANDOFF = nativesDirHandoff(env, { parent: process.pid, dir: handedOver });

			const result = await runChild(env);

			expect(result.own).toBe(handedOver);
			// Its own child resolves from the same variables: the handoff names another parent.
			expect(result.grandchild).toBe(path.join(tempRoot, "child"));
			expect(result.handoffLeft).toBeNull();
		});

		it("is not taken by a child whose directory variables differ from the recorded ones", async () => {
			const recorded: Record<string, string | undefined> = {
				...process.env,
				PI_NATIVES_DIR: path.join(tempRoot, "child"),
			};
			const handoff = nativesDirHandoff(recorded, { parent: process.pid, dir: path.join(tempRoot, "handed-over") });
			const ownHome = path.join(tempRoot, "own-home");
			const env = {
				...recorded,
				HOME: ownHome,
				USERPROFILE: ownHome,
				PI_NATIVES_DIR: undefined,
				OMP_DOWNLOAD_ROOT: undefined,
				OMP_CONFIG_ROOT: undefined,
				XDG_CACHE_HOME: undefined,
				__PI_NATIVES_DIR_HANDOFF: handoff,
			};

			expect((await runChild(env)).own).toBe(path.join(ownHome, ".omp", "natives"));
		});

		it("is known to have been given, taken or not, in the process and its worker threads", async () => {
			const report = `const mod = await import(${nativesDirJs});
const main = mod.startedWithNativesDirHandoff();
const worker = await new Promise(resolve => {
	const w = new Worker(URL.createObjectURL(new Blob([\`const mod = await import(${nativesDirJs.replaceAll("`", "\\`")}); postMessage(mod.startedWithNativesDirHandoff());\`], { type: "application/javascript" })));
	w.onmessage = event => { w.terminate(); resolve(event.data); };
});
console.log(JSON.stringify({ main, worker }));`;
			const run = async (handoff: string | undefined) => {
				const env: Record<string, string | undefined> = {
					...process.env,
					PI_NATIVES_DIR: path.join(tempRoot, "child"),
				};
				if (handoff === undefined) delete env.__PI_NATIVES_DIR_HANDOFF;
				else env.__PI_NATIVES_DIR_HANDOFF = handoff;
				const child = Bun.spawn([process.execPath, "-e", report], { env, stdout: "pipe", stderr: "inherit" });
				const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
				expect(exitCode).toBe(0);
				return JSON.parse(output.trim());
			};
			const recorded = { ...process.env, PI_NATIVES_DIR: path.join(tempRoot, "child") };
			const taken = nativesDirHandoff(recorded, { parent: process.pid, dir: path.join(tempRoot, "handed-over") });
			const refused = nativesDirHandoff(
				{ ...recorded, PI_NATIVES_DIR: path.join(tempRoot, "other") },
				{ parent: process.pid },
			);

			expect(await run(taken)).toEqual({ main: true, worker: true });
			// A handoff the child refuses still stands in the environment it was started with.
			expect(await run(refused)).toEqual({ main: true, worker: true });
			expect(await run(undefined)).toEqual({ main: false, worker: false });
			expect(await run("")).toEqual({ main: false, worker: false });
		});

		it("is not taken when it names no parent, even with the recorded variables", async () => {
			const handedOver = path.join(tempRoot, "handed-over");
			const env: Record<string, string | undefined> = {
				...process.env,
				PI_NATIVES_DIR: path.join(tempRoot, "child"),
			};
			// Every handoff omp writes names its parent; one with none is not omp's.
			const handoff = JSON.parse(nativesDirHandoff(env, { parent: process.pid, dir: handedOver }));
			env.__PI_NATIVES_DIR_HANDOFF = JSON.stringify({ ...handoff, parent: null, parentStart: null });

			expect((await runChild(env)).own).toBe(path.join(tempRoot, "child"));
		});

		it("is taken by a child its parent left before the child's first call (re-parented)", async () => {
			// A detached worker can outlive the session that started it; the session may exit
			// before the worker's first call, and the worker is then re-parented.
			const handedOver = path.join(tempRoot, "handed-over");
			const out = path.join(tempRoot, "reparented.json");
			const child = [
				"const parentAtStart = Number(process.env.PARENT_AT_START);",
				"const until = Date.now() + 60_000;",
				"while (process.ppid === parentAtStart && Date.now() < until) await Bun.sleep(20);",
				`const own = (await import(${nativesDirJs})).getNativesDir();`,
				"const result = JSON.stringify({ own, reparented: process.ppid !== parentAtStart });",
				'await Bun.write(process.env.OUT + ".tmp", result);',
				'(await import("node:fs")).renameSync(process.env.OUT + ".tmp", process.env.OUT);',
			].join("\n");
			// The parent writes the child's handoff naming itself, starts it detached, and exits.
			const parent = [
				`const { nativesDirHandoff } = await import(${nativesDirJs});`,
				`const env = { ...process.env, PARENT_AT_START: String(process.pid), OUT: ${JSON.stringify(out)} };`,
				`env.__PI_NATIVES_DIR_HANDOFF = nativesDirHandoff(env, { parent: process.pid, dir: ${JSON.stringify(handedOver)} });`,
				`Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { env, detached: true, stdio: ["ignore", "ignore", "inherit"] }).unref();`,
			].join("\n");
			const env: Record<string, string | undefined> = {
				...process.env,
				PI_NATIVES_DIR: path.join(tempRoot, "child"),
			};
			const starter = Bun.spawn([process.execPath, "-e", parent], { env, stdout: "ignore", stderr: "inherit" });
			expect(await starter.exited).toBe(0);
			const deadline = Date.now() + 90_000;
			while (!(await fs.exists(out)) && Date.now() < deadline) await Bun.sleep(50);

			expect(JSON.parse(await fs.readFile(out, "utf8"))).toEqual({ own: handedOver, reparented: true });
		}, 120_000);

		it.skipIf(process.platform !== "linux")(
			"is taken by a re-parented child while its old parent is an unreaped zombie",
			async () => {
				// The parent's own parent never waits for it (`exec sleep`), so once the parent exits
				// it stays a zombie: its /proc entry and start time remain.
				const handedOver = path.join(tempRoot, "handed-over");
				const out = path.join(tempRoot, "zombie-parent.json");
				const child = [
					"const parentAtStart = Number(process.env.PARENT_AT_START);",
					"const until = Date.now() + 60_000;",
					"while (process.ppid === parentAtStart && Date.now() < until) await Bun.sleep(20);",
					'const fs = await import("node:fs");',
					"let parentState = 'gone';",
					'try { const stat = fs.readFileSync("/proc/" + parentAtStart + "/stat", "utf8"); parentState = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]; } catch {}',
					`const own = (await import(${nativesDirJs})).getNativesDir();`,
					'fs.writeFileSync(process.env.OUT + ".tmp", JSON.stringify({ own, parentState }));',
					'fs.renameSync(process.env.OUT + ".tmp", process.env.OUT);',
				].join("\n");
				const parent = [
					`const { nativesDirHandoff } = await import(${nativesDirJs});`,
					`const env = { ...process.env, PARENT_AT_START: String(process.pid), OUT: ${JSON.stringify(out)} };`,
					`env.__PI_NATIVES_DIR_HANDOFF = nativesDirHandoff(env, { parent: process.pid, dir: ${JSON.stringify(handedOver)} });`,
					`Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { env, detached: true, stdio: ["ignore", "ignore", "inherit"] }).unref();`,
				].join("\n");
				const env: Record<string, string | undefined> = {
					...process.env,
					PI_NATIVES_DIR: path.join(tempRoot, "child"),
					BUN: process.execPath,
					PARENT_SCRIPT: parent,
				};
				// This test's own child; it is signalled only through its handle, which holds its pid.
				const holder = Bun.spawn(["sh", "-c", '"$BUN" -e "$PARENT_SCRIPT" & exec sleep 60'], {
					env,
					stdout: "ignore",
					stderr: "inherit",
				});
				try {
					const deadline = Date.now() + 90_000;
					while (!(await fs.exists(out)) && Date.now() < deadline) await Bun.sleep(50);

					expect(JSON.parse(await fs.readFile(out, "utf8"))).toEqual({ own: handedOver, parentState: "Z" });
				} finally {
					holder.kill();
					await holder.exited;
				}
			},
			120_000,
		);

		it.skipIf(process.platform !== "linux")(
			"is refused while the recorded parent runs, and taken once its pid names a process with another start time",
			() => {
				const handedOver = path.join(tempRoot, "handed-over");
				const env: Record<string, string | undefined> = {
					...process.env,
					PI_NATIVES_DIR: path.join(tempRoot, "child"),
				};
				// This process, which runs, is the recorded parent; the child's parent is another one.
				const written = nativesDirHandoff(env, { parent: process.pid, dir: handedOver });
				expect(process.pid).not.toBe(1);
				expect(nativesDirHandoffDir(written, { env, ppid: 1 })).toBeUndefined();

				// The same pid with another start time: the recorded parent exited and its pid was reused.
				const reused = JSON.stringify({ ...JSON.parse(written), parentStart: "1" });
				expect(nativesDirHandoffDir(reused, { env, ppid: 1 })).toBe(handedOver);
			},
		);

		it("names every variable the rule reads, so a new one cannot be left out of it", async () => {
			// A handoff is taken when the recorded inputs match, so a variable the rule reads and
			// the list omits would let a child with its own value of it take the parent's answer.
			const source = await Bun.file(path.join(import.meta.dir, "../native/natives-dir.js")).text();
			const rule = /function resolveNativesDir\(\) \{\n(?<body>[\s\S]*?)\n\}/.exec(source)?.groups?.body;
			if (!rule) throw new Error("resolveNativesDir not found in natives-dir.js");
			const read = new Set(rule.match(/process\.env\.([A-Z0-9_]+)/g)?.map(hit => hit.slice("process.env.".length)));
			// `os.homedir()` reads the home directory's variable, which the list names as well.
			if (rule.includes("os.homedir()")) read.add(process.platform === "win32" ? "USERPROFILE" : "HOME");

			expect([...read].sort()).toEqual([...nativesDirInputNames()].sort());
		});
	});

	it("leaves the environment alone, so a child with its own HOME resolves its own, before and after the first call", async () => {
		const savedDownloadRoot = process.env.OMP_DOWNLOAD_ROOT;
		delete process.env.PI_NATIVES_DIR;
		process.env.OMP_DOWNLOAD_ROOT = path.join(tempRoot, "parent-root");
		__resetNativesDirForTests();
		const childHome = path.join(tempRoot, "child-home");
		// As scripts/test-preload.ts tells a test to start a child with a home of its own.
		const childNativesDir = async () => {
			const env: Record<string, string | undefined> = { ...process.env, HOME: childHome, USERPROFILE: childHome };
			for (const name of ["OMP_CONFIG_ROOT", "OMP_DOWNLOAD_ROOT", "XDG_CACHE_HOME"]) delete env[name];
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`console.log((await import(${JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"))})).getNativesDir())`,
				],
				{ env, stdout: "pipe", stderr: "inherit" },
			);
			const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			expect(exitCode).toBe(0);
			return output.trim();
		};
		try {
			expect(await childNativesDir()).toBe(path.join(childHome, ".omp", "natives"));

			expect(getNativesDir()).toBe(path.join(tempRoot, "parent-root", "natives"));

			expect(process.env.PI_NATIVES_DIR).toBeUndefined();
			expect(await childNativesDir()).toBe(path.join(childHome, ".omp", "natives"));
		} finally {
			if (savedDownloadRoot === undefined) delete process.env.OMP_DOWNLOAD_ROOT;
			else process.env.OMP_DOWNLOAD_ROOT = savedDownloadRoot;
		}
	});

	it("gives the worker threads of a worker thread the process's answer", async () => {
		const natives = JSON.stringify(path.join(import.meta.dir, "../native/natives-dir.js"));
		const inner = path.join(tempRoot, "inner.ts");
		const outer = path.join(tempRoot, "outer.ts");
		await Bun.write(inner, `postMessage((await import(${natives})).getNativesDir());\n`);
		// The outer worker loads the module (every omp thread does, through @oh-my-pi/pi-utils),
		// changes a directory variable, as a `.env` file can, then starts its own worker before
		// any call of its own.
		await Bun.write(
			outer,
			[
				`await import(${natives});`,
				`process.env.PI_NATIVES_DIR = ${JSON.stringify(path.join(tempRoot, "from-dotenv"))};`,
				`const w = new Worker(${JSON.stringify(inner)}, { type: "module" });`,
				"w.onmessage = event => { w.terminate(); postMessage(event.data); };",
			].join("\n"),
		);
		const first = getNativesDir();
		const worker = new Worker(outer, { type: "module" });
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		worker.onmessage = event => resolve(event.data);
		worker.onerror = event => reject(event);
		const answer = await promise;
		worker.terminate();

		expect(answer).toBe(first);
	});
});
