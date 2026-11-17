import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * An absolute directory from an override variable (`~` expanded), or undefined for a
 * relative or empty value.
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function resolveAbsoluteDir(value) {
	let dir = value?.trim();
	if (!dir) return undefined;
	if (dir === "~") dir = os.homedir();
	else if (dir.startsWith("~/") || dir.startsWith("~\\")) dir = os.homedir() + dir.slice(1);
	return path.isAbsolute(dir) ? path.normalize(dir) : undefined;
}

/**
 * The natives directory by the rule below, from the environment as it is now.
 * @returns {string}
 */
function resolveNativesDir() {
	const override = resolveAbsoluteDir(process.env.PI_NATIVES_DIR);
	if (override) return override;
	const downloadRoot = resolveAbsoluteDir(process.env.OMP_DOWNLOAD_ROOT);
	if (downloadRoot) return path.join(downloadRoot, "natives");
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	if ((process.platform === "linux" || process.platform === "darwin") && xdgCacheHome) {
		const appRoot = path.join(xdgCacheHome, "omp");
		if (fs.existsSync(appRoot)) return path.join(appRoot, "natives");
	}
	const configRoot =
		resolveAbsoluteDir(process.env.OMP_CONFIG_ROOT) ?? path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp");
	return path.join(configRoot, "natives");
}

/**
 * Hidden variable carrying this process's answer, `{"pid":…,"ppid":…,"dir":…}`, to its
 * worker threads: a worker starts with a copy of the environment, which may hold directory
 * variables the main thread's first answer predates. A child process has another pid (and
 * a grandchild another parent), so it resolves for itself and a variable set for it still
 * applies.
 */
const NATIVES_DIR_CACHE_ENV_KEY = "__PI_NATIVES_DIR_CACHE";

/** This process's answer, once the first call has given it. */
let processNativesDir;

/**
 * The natives directory: the native addon's cached copies (`<dir>/<version>-<digest prefix>`
 * per compiled build and per Windows install's leaf package) and the
 * tree-sitter grammars the agent downloads (`<dir>/grammars`). The addon loader and
 * `@oh-my-pi/pi-utils` both call this, so the grammars the agent installs are the ones the
 * addon loads.
 *
 * It is one directory per process, never per profile: the first call resolves it and every
 * later call, in that process and its worker threads, returns the same answer. The addon
 * loads once per path, so a second directory would load a second copy of the addon into the
 * process, and the grammars the agent downloads would go where the addon does not look. omp
 * first loads the addon before it reads `.env` files, so set a directory variable in the
 * environment: one set in a `.env` file does not move the natives directory. The first call
 * reads, in order:
 * 1. `PI_NATIVES_DIR`;
 * 2. `<OMP_DOWNLOAD_ROOT>/natives`;
 * 3. on Linux and macOS, `$XDG_CACHE_HOME/omp/natives` when `$XDG_CACHE_HOME/omp` exists;
 * 4. `<config root>/natives`, where the config root is `OMP_CONFIG_ROOT`, else
 *    `~/<PI_CONFIG_DIR>` (default `~/.omp`).
 * Each override is trimmed and `~`-expanded; an empty or relative value is ignored.
 * @returns {string}
 */
export function getNativesDir() {
	if (processNativesDir !== undefined) return processNativesDir;
	try {
		const cached = JSON.parse(process.env[NATIVES_DIR_CACHE_ENV_KEY] ?? "null");
		if (cached?.pid === process.pid && cached.ppid === process.ppid && typeof cached.dir === "string") {
			processNativesDir = cached.dir;
			return processNativesDir;
		}
	} catch {
		// Not this module's value; resolve below and replace it.
	}
	processNativesDir = resolveNativesDir();
	process.env[NATIVES_DIR_CACHE_ENV_KEY] = JSON.stringify({
		pid: process.pid,
		ppid: process.ppid,
		dir: processNativesDir,
	});
	return processNativesDir;
}

/** Forget this process's answer, so a test can resolve again from a changed environment. */
export function __resetNativesDirForTests() {
	processNativesDir = undefined;
	delete process.env[NATIVES_DIR_CACHE_ENV_KEY];
}
