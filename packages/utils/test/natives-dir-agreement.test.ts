import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// The loader is not a public natives entry point; this test reads its context to prove it
// names the directory pi-utils names. Both imports are relative so a copy of the tree tests
// its own loader and resolver.
import { initLoaderContext } from "../../natives/native/loader-state.js";
import { __resetDirsFromEnvForTests, getNativesDir } from "../src/dirs";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_NATIVES_DIR",
	"OMP_CONFIG_ROOT",
	"OMP_DOWNLOAD_ROOT",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"PI_NATIVE_VARIANT",
	"__PI_NATIVE_VARIANT_CACHE",
] as const;
const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

describe("the natives directory the addon loader and pi-utils name", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dir-agreement-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_NATIVE_VARIANT = "baseline";
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	/** Sets `env`, creates `existing` (relative to the temp root), and reads both sides. */
	async function bothSides(env: Record<string, string>, existing: string[] = []) {
		for (const dir of existing) await fs.mkdir(path.join(tempRoot, dir), { recursive: true });
		for (const [key, value] of Object.entries(env)) process.env[key] = value.replaceAll("<tmp>", tempRoot);
		__resetDirsFromEnvForTests();
		const short = (dir: string) => dir.replace(tempRoot, "<tmp>").split(path.sep).join("/");
		return {
			loader: short(initLoaderContext({ isCompiledBinary: true }).nativesDir),
			piUtils: short(getNativesDir()),
		};
	}

	const xdgCache = (fallback: string) => (xdgPlatform ? "<tmp>/cache/omp/natives" : fallback);
	const cases: [label: string, env: Record<string, string>, existing: string[], expected: string][] = [
		["no override", {}, [], "<tmp>/home/.omp/natives"],
		[
			"XDG data and cache roots both initialized",
			{ XDG_DATA_HOME: "<tmp>/data", XDG_CACHE_HOME: "<tmp>/cache" },
			["data/omp", "cache/omp"],
			xdgCache("<tmp>/home/.omp/natives"),
		],
		["only the XDG data root initialized", { XDG_DATA_HOME: "<tmp>/data" }, ["data/omp"], "<tmp>/home/.omp/natives"],
		[
			"only the XDG cache root initialized",
			{ XDG_CACHE_HOME: "<tmp>/cache" },
			["cache/omp"],
			xdgCache("<tmp>/home/.omp/natives"),
		],
		["XDG cache set but not initialized", { XDG_CACHE_HOME: "<tmp>/cache" }, [], "<tmp>/home/.omp/natives"],
		["a named profile", { OMP_PROFILE: "work" }, [], "<tmp>/home/.omp/natives"],
		[
			"a named profile under XDG",
			{ OMP_PROFILE: "work", XDG_CACHE_HOME: "<tmp>/cache", XDG_DATA_HOME: "<tmp>/data" },
			["cache/omp/profiles/work", "data/omp/profiles/work"],
			xdgCache("<tmp>/home/.omp/natives"),
		],
		[
			"a custom agent dir under XDG cache",
			{ PI_CODING_AGENT_DIR: "<tmp>/agent", XDG_CACHE_HOME: "<tmp>/cache" },
			["cache/omp"],
			xdgCache("<tmp>/home/.omp/natives"),
		],
		["PI_CONFIG_DIR", { PI_CONFIG_DIR: ".alt" }, [], "<tmp>/home/.alt/natives"],
		["OMP_CONFIG_ROOT", { OMP_CONFIG_ROOT: "<tmp>/root", PI_CONFIG_DIR: ".alt" }, [], "<tmp>/root/natives"],
		[
			"OMP_CONFIG_ROOT under XDG cache",
			{ OMP_CONFIG_ROOT: "<tmp>/root", XDG_CACHE_HOME: "<tmp>/cache" },
			["cache/omp"],
			xdgCache("<tmp>/root/natives"),
		],
		[
			"OMP_DOWNLOAD_ROOT",
			{ OMP_DOWNLOAD_ROOT: "<tmp>/downloads", OMP_CONFIG_ROOT: "<tmp>/root", XDG_CACHE_HOME: "<tmp>/cache" },
			["cache/omp"],
			"<tmp>/downloads/natives",
		],
		[
			"PI_NATIVES_DIR",
			{ PI_NATIVES_DIR: "<tmp>/shared", OMP_DOWNLOAD_ROOT: "<tmp>/downloads", XDG_CACHE_HOME: "<tmp>/cache" },
			["cache/omp"],
			"<tmp>/shared",
		],
	];

	it.each(cases)("agree with %s", async (label, env, existing, expected) => {
		const result = await bothSides(env, existing);
		expect({ label, ...result }).toEqual({ label, loader: expected, piUtils: expected });
	});
});

/**
 * omp loads the addon (its SQLite lock shim) before pi-utils' `env.ts` applies `.env` files,
 * so a directory variable from a `.env` file arrives after the loader has resolved the
 * natives directory. The loader and pi-utils must still name one directory, and the commands
 * the agent runs (the bash tool builds their environment with `filterChildShellEnv(Bun.env)`)
 * get `PI_NATIVES_DIR` only as omp was started with it, so an omp they start resolves for
 * itself. Each case runs in its own process, as omp does: the loader first, then `env.ts`,
 * then pi-utils.
 */
describe("the natives directory when a directory variable comes from a .env file", () => {
	const DIRECTORY_NAMES = [
		"PI_NATIVES_DIR",
		"OMP_DOWNLOAD_ROOT",
		"OMP_CONFIG_ROOT",
		"PI_CONFIG_DIR",
		"PI_CODING_AGENT_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"__PI_NATIVES_DIR_CACHE",
	];
	let tempRoot = "";

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dir-dotenv-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	const cases: [name: string, value: string, existing: string[]][] = [
		["PI_NATIVES_DIR", "<tmp>/post", []],
		["OMP_DOWNLOAD_ROOT", "<tmp>/dl", []],
		["PI_CONFIG_DIR", ".alt", []],
		...(xdgPlatform ? ([["XDG_CACHE_HOME", "<tmp>/xdg", ["xdg/omp"]]] as [string, string, string[]][]) : []),
	];

	/** Run the probe with `launch` added to its environment; returns what it saw. */
	async function probe(dotenv: string, launch: Record<string, string> = {}) {
		const home = path.join(tempRoot, "home");
		await Bun.write(path.join(home, ".omp/agent/.env"), dotenv);
		const script = path.join(tempRoot, "probe.ts");
		await Bun.write(
			script,
			`const { initLoaderContext } = await import(${JSON.stringify(path.join(import.meta.dir, "../../natives/native/loader-state.js"))});
const loaderFirst = initLoaderContext({ isCompiledBinary: true }).nativesDir;
const { filterChildShellEnv } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/env.ts"))});
const { getNativesDir } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/dirs.ts"))});
console.log(JSON.stringify({ marker: process.env.NATIVES_DOTENV_PROBE, loaderFirst, loaderLater: initLoaderContext({ isCompiledBinary: true }).nativesDir, piUtils: getNativesDir(), applied: process.env.PI_NATIVES_DIR ?? null, command: filterChildShellEnv(Bun.env).PI_NATIVES_DIR ?? null }));
`,
		);
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		for (const key of DIRECTORY_NAMES) delete env[key];
		Object.assign(env, launch);
		const child = Bun.spawn([process.execPath, script], { cwd: tempRoot, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		return JSON.parse(stdout);
	}

	it.each(cases)("names one directory when the agent's .env sets %s", async (name, value, existing) => {
		for (const dir of existing) await fs.mkdir(path.join(tempRoot, dir), { recursive: true });
		// The marker shows the `.env` file was read, so the case can fail.
		const result = await probe(`${name}=${value.replaceAll("<tmp>", tempRoot)}\nNATIVES_DOTENV_PROBE=read\n`);

		expect(result.marker).toBe("read");
		expect(result.loaderLater).toBe(result.loaderFirst);
		expect(result.piUtils).toBe(result.loaderFirst);
		// omp was started without PI_NATIVES_DIR, so a command gets none, whatever `.env` set.
		expect(result.command).toBeNull();
	});

	it("gives the commands the agent runs PI_NATIVES_DIR as omp was started with it", async () => {
		const launch = path.join(tempRoot, "launch");
		const result = await probe(`PI_NATIVES_DIR=${path.join(tempRoot, "post")}\nNATIVES_DOTENV_PROBE=read\n`, {
			PI_NATIVES_DIR: launch,
		});

		expect(result.marker).toBe("read");
		expect(result.loaderFirst).toBe(launch);
		expect(result.command).toBe(launch);
	});

	it("never applies a .env file's PI_NATIVES_DIR, so no program omp starts can carry it", async () => {
		const result = await probe(`PI_NATIVES_DIR=${path.join(tempRoot, "post")}\nNATIVES_DOTENV_PROBE=read\n`);

		// The `.env` file was read (its other value applied), its PI_NATIVES_DIR was not.
		expect(result.marker).toBe("read");
		expect(result.applied).toBeNull();
		expect(result.command).toBeNull();
	});
});
