import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getBaseConfigRoot,
	getBrowserStateDir,
	getConfigRootDir,
	getConfigRootOverride,
	getFastembedCacheDir,
	getFastembedRuntimeDir,
	getLegacyPiExtensionCacheDbPath,
	getNativeGrammarsDir,
	getNativesDir,
	getPuppeteerDir,
	getStatsDbPath,
	getTinyModelsCacheDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";

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

describe("config and download root overrides", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-utils-config-root-"));
		home = path.join(tempRoot, "home");
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

	it("moves the config root, its profiles and the default agent dir, ignoring PI_CONFIG_DIR", () => {
		const root = path.join(tempRoot, "config");
		process.env.OMP_CONFIG_ROOT = root;
		process.env.PI_CONFIG_DIR = ".ignored";
		__resetDirsFromEnvForTests();

		expect(getBaseConfigRoot()).toBe(root);
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		expect(getStatsDbPath()).toBe(path.join(root, "stats.db"));
		expect(getLegacyPiExtensionCacheDbPath()).toBe(path.join(root, "cache", "legacy-pi-extension-cache.db"));
		expect(getBrowserStateDir()).toBe(path.join(root, "browser-state"));
		// Without a download root, the downloads are the config root's too.
		expect(getPuppeteerDir()).toBe(path.join(root, "puppeteer"));
		expect(getTinyModelsCacheDir()).toBe(path.join(root, "agent", "cache", "tiny-models"));

		setProfile("work");
		expect(getConfigRootDir()).toBe(path.join(root, "profiles", "work"));
		expect(getAgentDir()).toBe(path.join(root, "profiles", "work", "agent"));
		setProfile(undefined);
	});

	it("expands a home-relative root and ignores a relative or empty one", () => {
		process.env.OMP_CONFIG_ROOT = "~/isolated";
		expect(getConfigRootOverride()).toBe(path.join(home, "isolated"));
		expect(getBaseConfigRoot()).toBe(path.join(home, "isolated"));
		for (const ignored of ["", "  ", "relative/root"]) {
			process.env.OMP_CONFIG_ROOT = ignored;
			expect({ ignored, root: getBaseConfigRoot() }).toEqual({ ignored, root: path.join(home, ".omp") });
		}
		expect(getConfigRootOverride({ OMP_CONFIG_ROOT: path.join(tempRoot, "other") })).toBe(
			path.join(tempRoot, "other"),
		);
	});

	it("keeps the downloads in the download root while state moves with the config root", () => {
		const root = path.join(tempRoot, "config");
		const downloads = path.join(tempRoot, "downloads");
		process.env.OMP_CONFIG_ROOT = root;
		process.env.OMP_DOWNLOAD_ROOT = downloads;
		__resetDirsFromEnvForTests();

		expect({
			puppeteer: getPuppeteerDir(),
			natives: getNativesDir(),
			grammars: getNativeGrammarsDir(),
			fastembed: getFastembedCacheDir(),
			fastembedRuntime: getFastembedRuntimeDir(),
			tinyModels: getTinyModelsCacheDir(),
		}).toEqual({
			puppeteer: path.join(downloads, "puppeteer"),
			natives: path.join(downloads, "natives"),
			grammars: path.join(downloads, "natives", "grammars"),
			fastembed: path.join(downloads, "cache", "fastembed"),
			fastembedRuntime: path.join(downloads, "cache", "fastembed-runtime"),
			tinyModels: path.join(downloads, "agent", "cache", "tiny-models"),
		});
		// An agent dir passed explicitly keeps its own tiny models.
		const agent = path.join(tempRoot, "agent");
		expect(getTinyModelsCacheDir(agent)).toBe(path.join(agent, "cache", "tiny-models"));
		// State is not a download.
		expect(getStatsDbPath()).toBe(path.join(root, "stats.db"));
		expect(getLegacyPiExtensionCacheDbPath()).toBe(path.join(root, "cache", "legacy-pi-extension-cache.db"));
	});
});
