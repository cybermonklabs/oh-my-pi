import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getAgentDir, getNativesDir } from "@oh-my-pi/pi-utils/dirs";

/**
 * The natives directory under the rule, from the environment as it is now. A process keeps
 * its first answer (a `.env` file applied later moves nothing), so each read of the rule
 * resolves afresh.
 */
function nativesDirNow(): string {
	__resetDirsFromEnvForTests();
	return getNativesDir();
}

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
] as const;
const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

describe("native directory override", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-utils-natives-dir-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		__resetDirsFromEnvForTests();
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

	it("overrides the cached XDG/profile path without relocating agent state", async () => {
		const cache = path.join(tempRoot, "cache");
		const data = path.join(tempRoot, "data");
		const shared = path.join(tempRoot, "shared");
		await fs.mkdir(path.join(cache, "omp", "profiles", "isolated"), { recursive: true });
		await fs.mkdir(path.join(data, "omp", "profiles", "isolated"), { recursive: true });
		process.env.XDG_CACHE_HOME = cache;
		process.env.XDG_DATA_HOME = data;
		process.env.PI_CONFIG_DIR = ".alternate";
		process.env.OMP_PROFILE = "isolated";
		__resetDirsFromEnvForTests();
		// One natives directory per machine: a named profile shares the base root's (here the
		// initialized XDG cache root), the directory the addon loader also uses.
		const defaultNatives = path.join(
			xdgPlatform ? path.join(cache, "omp") : path.join(home, ".alternate"),
			"natives",
		);
		const agent = getAgentDir();
		expect(nativesDirNow()).toBe(defaultNatives);

		process.env.PI_NATIVES_DIR = " " + shared + " ";
		expect(nativesDirNow()).toBe(shared);
		expect(getAgentDir()).toBe(agent);

		delete process.env.PI_NATIVES_DIR;
		expect(nativesDirNow()).toBe(defaultNatives);
	});

	it("expands home-relative overrides instead of treating tilde as a cwd-relative path", () => {
		process.env.PI_NATIVES_DIR = "~";
		expect(nativesDirNow()).toBe(home);
		process.env.PI_NATIVES_DIR = " ~/unused/../shared ";
		expect(nativesDirNow()).toBe(path.join(home, "shared"));
	});

	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/natives"],
	])("keeps the existing cache root when the override is %s", (_label, override) => {
		process.env.PI_NATIVES_DIR = override;
		expect(nativesDirNow()).toBe(path.join(home, ".omp", "natives"));
	});

	it("takes the download root's natives below PI_NATIVES_DIR", () => {
		const downloads = path.join(tempRoot, "downloads");
		process.env.OMP_DOWNLOAD_ROOT = downloads;
		process.env.OMP_CONFIG_ROOT = path.join(tempRoot, "config");
		expect(nativesDirNow()).toBe(path.join(downloads, "natives"));
		process.env.PI_NATIVES_DIR = path.join(tempRoot, "shared");
		expect(nativesDirNow()).toBe(path.join(tempRoot, "shared"));
	});
});
