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
 * A process's state and start time on Linux (`/proc/<pid>/stat` fields 3 and 22, the start in
 * clock ticks since boot), this process's by default: with the pid, the start time names one
 * process for its whole life, in every thread. Undefined elsewhere, or when `/proc` cannot be
 * read (the process has been reaped).
 * @param {number | "self"} [pid]
 * @returns {{ state: string; start: string | undefined } | undefined}
 */
function processStat(pid = "self") {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// The fields after the command name, which is in parentheses and may hold spaces,
		// start at field 3; field 22 is the 20th of them.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { state: fields[0] ?? "", start: fields[19] };
	} catch {
		return undefined;
	}
}

/**
 * A process's start time on Linux (see {@link processStat}), this process's by default.
 * @param {number | "self"} [pid]
 * @returns {string | undefined}
 */
function processStartTime(pid = "self") {
	return processStat(pid)?.start;
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
 * given the same pid has a parent that runs, since that parent started it. Without a start
 * time only `kill(pid, 0)` tells, and a zombie parent counts as running: a re-parented process
 * whose old parent is unreaped refuses its own answer and resolves again.
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
 * through {@link NATIVES_DIR_CACHE_ENV_KEY}. `PI_NATIVES_DIR` is left as it is, so the
 * commands the agent runs carry it as omp was started with it.
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
 * Hidden variable by which omp hands its answer to a child process that is omp (a subprocess
 * worker, an omp daemon its launch broker runs, a forked session),
 * `{"dir":…,"parent":…,"inputs":{…}}`. Only this module reads it, and `PI_NATIVES_DIR` stays
 * as omp was started with it, so the commands such a child runs never carry the directory.
 *
 * A process takes the answer only when it is the one it was written for:
 * - `inputs`, the values the rule reads ({@link nativesDirInputNames}), match its own
 *   environment, so a program started with a home or directory variables of its own resolves
 *   its own directory;
 * - `parent`, when not null, is the process that started it: its parent now, or, after that
 *   parent exited and it was re-parented, a recorded parent (`parent` and its start time
 *   `parentStart`) that no longer runs. A program the child starts (one the agent's code starts
 *   in the JS eval kernel, say) resolves for itself even with the same environment, since the
 *   recorded parent still runs. A forked session's handoff has no parent: the terminal starts
 *   the fork.
 */
export const NATIVES_DIR_HANDOFF_ENV_KEY = "__PI_NATIVES_DIR_HANDOFF";

/**
 * The environment variables the rule reads, the home directory's included (`HOME`, or
 * `USERPROFILE` on Windows): a handoff is taken only by a process whose values of these are the
 * recorded ones.
 * @returns {string[]}
 */
export function nativesDirInputNames() {
	return [
		"PI_NATIVES_DIR",
		"OMP_DOWNLOAD_ROOT",
		"XDG_CACHE_HOME",
		"OMP_CONFIG_ROOT",
		"PI_CONFIG_DIR",
		process.platform === "win32" ? "USERPROFILE" : "HOME",
	];
}

/**
 * The {@link NATIVES_DIR_HANDOFF_ENV_KEY} value for a child process whose environment is `env`
 * (its values of the rule's inputs are recorded from it): this process's answer, or `dir`, for
 * a process whose parent is `parent` (this process's pid; null: any parent).
 * @param {Record<string, string | undefined>} env
 * @param {{ parent: number | null; dir?: string }} options
 * @returns {string}
 */
export function nativesDirHandoff(env, { parent, dir = getNativesDir() }) {
	const inputs = {};
	for (const name of nativesDirInputNames()) inputs[name] = env[name] ?? null;
	const parentStart = parent === null ? null : (processStartTime(parent === process.pid ? "self" : parent) ?? null);
	return JSON.stringify({ dir, parent, parentStart, inputs });
}

/**
 * Whether the process a handoff names as the child's parent started this process: it is this
 * process's parent, or it no longer runs (it exited, and this process was re-parented). A
 * recorded parent that still runs and is not this process's parent started another process.
 * On Linux a process has stopped running once it is a zombie (`Z`, exited but not yet waited
 * for by its own parent, which can take a while) or dead (`X`), and a pid another process
 * reuses carries another start time. Elsewhere only `kill(pid, 0)` tells, and a zombie counts
 * as running there, so a child re-parented while its old parent is unreaped resolves for itself.
 * @param {{ parent: unknown; parentStart?: unknown }} handoff
 * @param {number} ppid this process's parent now
 */
function isStartedByRecordedParent(handoff, ppid) {
	const { parent, parentStart } = handoff;
	if (parent === ppid) return true;
	if (!Number.isInteger(parent) || parent <= 0) return false;
	if (typeof parentStart === "string" && process.platform === "linux") {
		const stat = processStat(parent);
		return stat === undefined || stat.state === "Z" || stat.state === "X" || stat.start !== parentStart;
	}
	return !isLiveProcess(parent);
}

/**
 * The directory a {@link NATIVES_DIR_HANDOFF_ENV_KEY} value hands over, or undefined for a
 * value this module did not write (an empty one included). With `addressee`, also undefined
 * unless the value was written for a process whose environment is `env` and whose parent is,
 * or was, the recorded one.
 * @param {string | undefined} value
 * @param {{ env: Record<string, string | undefined>; ppid: number }} [addressee]
 * @returns {string | undefined}
 */
export function nativesDirHandoffDir(value, addressee) {
	let handoff;
	try {
		handoff = JSON.parse(value || "null");
	} catch {
		return undefined;
	}
	if (typeof handoff?.dir !== "string" || !path.isAbsolute(handoff.dir)) return undefined;
	if (!addressee) return handoff.dir;
	if (handoff.parent !== null && !isStartedByRecordedParent(handoff, addressee.ppid)) return undefined;
	const inputs = handoff.inputs;
	if (inputs === null || typeof inputs !== "object") return undefined;
	const names = nativesDirInputNames();
	if (Object.keys(inputs).length !== names.length) return undefined;
	for (const name of names) {
		if (!(name in inputs) || (addressee.env[name] ?? null) !== inputs[name]) return undefined;
	}
	return handoff.dir;
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
 * environment: omp's own `.env` loading never applies `PI_NATIVES_DIR`, and another directory
 * variable set in a `.env` file does not move the natives directory. (Bun's own `.env` loading,
 * in a non-compiled omp, runs before any omp code: what it applies counts as the environment
 * omp was started with.) A child process that is omp takes its parent's answer from a handoff
 * ({@link NATIVES_DIR_HANDOFF_ENV_KEY}); any other child resolves for itself. The first call
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
		if (isThisProcess(cached) && typeof cached.dir === "string") return adopt(cached.dir);
	} catch {
		// Not this module's value; resolve below and replace it.
	}
	const handedOver = nativesDirHandoffDir(process.env[NATIVES_DIR_HANDOFF_ENV_KEY], {
		env: process.env,
		ppid: process.ppid,
	});
	// Read once: the children this process starts with `process.env` must not take it. A
	// spawn with no `env`, and the native shell, start from the startup environment, which
	// keeps it: commands get it empty (`filterChildShellEnv`); a program started with no `env`
	// keeps it, which the parent check refuses while the recorded parent runs (a fork's
	// names no parent).
	delete process.env[NATIVES_DIR_HANDOFF_ENV_KEY];
	return adopt(handedOver ?? resolveNativesDir());
}

/** Forget this process's answer, so a test can resolve again from a changed environment. */
export function __resetNativesDirForTests() {
	processNativesDir = undefined;
	delete process.env[NATIVES_DIR_CACHE_ENV_KEY];
}
