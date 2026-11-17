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
 * Hidden variable carrying this process's answer to its worker threads,
 * `{"pid":…,"ppid":…,"start":…,"dir":…}`: a worker starts with a copy of the environment,
 * which may hold directory variables the main thread's first answer predates. It is keyed to
 * this process's life (see {@link isThisProcess}), so a child process, with another pid,
 * never takes it.
 */
const NATIVES_DIR_CACHE_ENV_KEY = "__PI_NATIVES_DIR_CACHE";

/** This process's answer, once the first call has given it. */
let processNativesDir;

/**
 * This process's start time on Linux (`/proc/self/stat` field 22, in clock ticks since
 * boot): with the pid it names one process for its whole life, in every thread. Undefined
 * elsewhere, or when `/proc` cannot be read.
 * @returns {string | undefined}
 */
function processStartTime() {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync("/proc/self/stat", "utf8");
		// The fields after the command name, which is in parentheses and may hold spaces,
		// start at field 3; field 22 is the 20th of them.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

/** @param {number} pid */
function isLiveProcess(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/**
 * Whether an inherited answer was written by this process (by its main thread or another of
 * its threads). With a start time (Linux): the same pid and start time. Without one: the same
 * pid, and either the same parent or a recorded parent that no longer runs. A process whose
 * parent exits is re-parented, so its live parent changes while it lives; a later process
 * given the same pid has a parent that runs, since that parent started it.
 * @param {{ pid?: unknown; ppid?: unknown; start?: unknown }} cached
 */
function isThisProcess(cached) {
	if (cached?.pid !== process.pid) return false;
	const start = processStartTime();
	if (start !== undefined && typeof cached.start === "string") return cached.start === start;
	return cached.ppid === process.ppid || (typeof cached.ppid === "number" && !isLiveProcess(cached.ppid));
}

/**
 * Make `dir` this process's answer: kept for later calls, and carried to worker threads
 * through {@link NATIVES_DIR_CACHE_ENV_KEY}. `PI_NATIVES_DIR` is left as it is: a child
 * process resolves for itself, unless omp gives it the answer (its subprocess workers, the
 * omp daemons its launch broker runs, and a forked session get `PI_NATIVES_DIR`; the commands
 * the agent runs do not).
 * @param {string} dir
 */
function adopt(dir) {
	processNativesDir = dir;
	process.env[NATIVES_DIR_CACHE_ENV_KEY] = JSON.stringify({
		pid: process.pid,
		ppid: process.ppid,
		start: processStartTime(),
		dir,
	});
	return dir;
}

/**
 * The natives directory: the native addon's cached copies (`<dir>/<version>-<digest prefix>`
 * per compiled build and per Windows install's leaf package) and the
 * tree-sitter grammars the agent downloads (`<dir>/grammars`). The addon loader and
 * `@oh-my-pi/pi-utils` both call this, so the grammars the agent installs are the ones the
 * addon loads.
 *
 * It is one directory per process, never per profile: the first call resolves it, and every
 * later call in that process and its worker threads returns the same answer. The addon loads
 * once per path, so a second directory would load a second copy of the addon into the
 * process, and the grammars the agent downloads would go where the addon does not look. omp
 * first loads the addon before it reads `.env` files, so set a directory variable in the
 * environment: one set in a `.env` file does not move the natives directory. A child process
 * resolves for itself; omp passes the answer as `PI_NATIVES_DIR` to the children that are
 * omp (its subprocess workers, its omp daemons, a forked session), not to the commands the
 * agent runs. The first call reads, in order:
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
		if (isThisProcess(cached) && typeof cached.dir === "string") return adopt(cached.dir);
	} catch {
		// Not this module's value; resolve below and replace it.
	}
	return adopt(resolveNativesDir());
}

/** Forget this process's answer, so a test can resolve again from a changed environment. */
export function __resetNativesDirForTests() {
	processNativesDir = undefined;
	delete process.env[NATIVES_DIR_CACHE_ENV_KEY];
}
