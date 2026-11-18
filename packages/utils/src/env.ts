import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnv } from "node:util";
import { isMainThread } from "node:worker_threads";
import { getNativesDir, NATIVES_DIR_HANDOFF_ENV_KEY } from "@oh-my-pi/pi-natives/natives-dir";
import { readRegularFile } from "@oh-my-pi/pi-natives/regular-file";
import { getAgentDir, getConfigRootDir, getProjectDir, refreshDirsFromEnv } from "./dirs";
import * as logger from "./logger";
import { startupEnv } from "./startup-env";
import { isBunTestRuntime } from "./test-runtime";

export * from "./test-runtime";
export * from "./worker-host";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

/**
 * True when running inside a WSL (Windows Subsystem for Linux) distribution.
 *
 * WSL reports `linux` for `process.platform`, so the only reliable signal is
 * the `WSL_DISTRO_NAME`/`WSL_INTEROP` variables the interop layer injects.
 * Callers use this to translate Windows drive paths to their `/mnt/<drive>`
 * mounts and to route clipboard access through `powershell.exe`.
 */
export function isWsl(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
	return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}
/**
 * Git variables that pin a repository location. They describe the checkout the
 * agent process itself was launched from (git hooks, `git --git-dir` wrappers),
 * so forwarding them to a child shell makes `git` ignore the command's `cwd`
 * and mutate the wrong worktree or index. Stripped from child shell envs so git
 * rediscovers the repository from the working directory. Mirrors the
 * `env_remove` list in `crates/pi-vcs/src/git/cli.rs`.
 */
const GIT_REPO_LOCATION_ENV_NAMES = [
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/**
 * Removes {@link GIT_REPO_LOCATION_ENV_NAMES} from a copied child env in place.
 *
 * Windows environment lookups are case-insensitive, so a block that spells a
 * variable `git_dir` is just as binding there; match case-insensitively on
 * win32 and exactly elsewhere (POSIX env names are case-sensitive).
 */
export function stripGitRepoLocationEnv(
	env: Record<string, string>,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32") {
		for (const name of GIT_REPO_LOCATION_ENV_NAMES) {
			delete env[name];
		}
		return;
	}
	const folded = new Set<string>(GIT_REPO_LOCATION_ENV_NAMES.map(name => name.toLowerCase()));
	for (const key of Object.keys(env)) {
		if (folded.has(key.toLowerCase())) {
			delete env[key];
		}
	}
}

// Bun autoloads the project's dotenv files into `process.env` before user code
// runs, so `process.env` as the process first saw it (`startupEnv`) is the launch
// environment only where Bun loaded none: a compiled binary (built with Bun's
// loading off) or a `--no-env-file` start. Linux keeps the original exec
// environment in procfs, which is authoritative everywhere. Elsewhere (a
// non-compiled omp on macOS or Windows started with Bun's loading on) the launch
// environment cannot be read: neither procfs nor the addon gives it.
// `PI_TEST_NO_LAUNCH_ENV=1` in the launch environment itself (never a value a
// `.env` file gave) makes it unreadable here too, for tests of that case.
function readLaunchEnv(): ReadonlyMap<string, string> | undefined {
	const startedWithoutBunEnv = isCompiledBinary() || process.execArgv.includes("--no-env-file");
	let values: Map<string, string> | undefined;
	if (process.platform === "linux") {
		try {
			values = new Map();
			for (const entry of fs.readFileSync("/proc/self/environ", "utf8").split("\0")) {
				const separator = entry.indexOf("=");
				if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
			}
		} catch {
			values = undefined;
		}
	}
	if (!values && startedWithoutBunEnv) values = new Map(Object.entries(startupEnv));
	if (!values) return undefined;
	if (values.get("PI_TEST_NO_LAUNCH_ENV") === "1" && !startedWithoutBunEnv) return undefined;
	return values;
}

const launchEnvValues = readLaunchEnv();
const projectEnvNamesLoadedByOmp = new Set<string>();

/**
 * `name` as omp was started with it, before omp applied its own `.env` files (undefined when
 * it was not set). Where the launch environment cannot be read (see `readLaunchEnv`), the
 * value the process first saw, which includes what Bun's own loading gave it.
 */
export function launchEnvValue(name: string): string | undefined {
	return launchEnvValues ? launchEnvValues.get(name) : startupEnv[name];
}

/**
 * The first line of a relaunch file, by which it names itself (`# omp relaunch file: <its
 * path>`), so a process can tell a file omp wrote from an accidental look-alike or a copy (a
 * user can write the line on a file of their own, which then counts as omp's). A comment, so Bun
 * loads nothing from it: a variable would also reach every program the new process starts
 * without an `env` of its own, whose environment is the one Bun built at the start, whatever
 * `process.env` does.
 */
const RELAUNCH_ENV_MARKER = "# omp relaunch file: ";

/**
 * The entries Bun's own `.env` loading gave this process before any JavaScript ran: those of
 * `process.env` as the process first saw it that the launch environment lacks or holds
 * otherwise, whatever rules and files Bun used (its mode, `bunfig.toml`, `BUN_OPTIONS`,
 * `--env-file`s, a pipe). Empty where it loaded none; undefined where the launch environment
 * cannot be read.
 */
const bunLoadedEnv: Readonly<Record<string, string>> | undefined = launchEnvValues
	? Object.freeze(
			Object.fromEntries(Object.entries(startupEnv).filter(([name, value]) => launchEnvValues.get(name) !== value)),
		)
	: undefined;

/** The private file `bunRelaunchArgs` writes: `<base>/omp-bun-env-XXXXXX/loaded.env`. */
const RELAUNCH_ENV_DIR_RE = /^omp-bun-env-[A-Za-z0-9]{6}$/;
const RELAUNCH_ENV_FILE = "loaded.env";
/** Age after which a relaunch file nobody removed counts as left by a start that died. */
const RELAUNCH_ENV_STALE_MS = 10 * 60_000;

/**
 * Where a relaunch file may go, in order: `TMPDIR` as the process was started with it, then the
 * fallback, `/tmp` (`PI_TEST_RELAUNCH_FALLBACK_DIR` from the launch environment names another,
 * for tests). They come from the launch environment, never from `os.tmpdir()`, which follows
 * a `TMPDIR` that omp's own `.env` loading sets later: the writer, a later session's sweep and
 * every relaunched process then name the same directories. Each is either a usable base
 * (absolute, with no comma in its path, as Bun splits an `--env-file` at commas) or the
 * reason it is not.
 */
function relaunchEnvBaseCandidates(): { dir: string; base?: string; problem?: string }[] {
	const tmpdir = launchEnvValue("TMPDIR");
	const fallback = launchEnvValue("PI_TEST_RELAUNCH_FALLBACK_DIR") || "/tmp";
	const candidates: { dir: string; base?: string; problem?: string }[] = [];
	for (const [label, dir] of [
		["TMPDIR", tmpdir],
		["fallback", fallback],
	] as const) {
		if (!dir) candidates.push({ dir: label, problem: "unset" });
		else if (!path.isAbsolute(dir)) candidates.push({ dir, problem: "not an absolute path" });
		else if (path.resolve(dir).includes(",")) candidates.push({ dir, problem: "holds a comma" });
		else candidates.push({ dir, base: path.resolve(dir) });
	}
	return candidates;
}

/** The usable bases of {@link relaunchEnvBaseCandidates}, each once. */
function relaunchEnvBases(): string[] {
	const bases: string[] = [];
	for (const { base } of relaunchEnvBaseCandidates()) if (base && !bases.includes(base)) bases.push(base);
	return bases;
}

/** The marker line a relaunch file at `file` holds, or undefined when its path cannot be one. */
function relaunchEnvMarkerLine(file: string): string | undefined {
	return file.includes("\n") || file.includes("\r") ? undefined : `${RELAUNCH_ENV_MARKER}${file}`;
}

/**
 * Whether `file` is a regular file (not a link, a FIFO or a device) whose first line is
 * `marker`, where the writer puts it. Read through `readRegularFile`, so it never blocks and
 * never throws on what stands there, and only the marker's length and its newline are read.
 */
function startsWithRelaunchMarker(file: string, marker: string): boolean {
	const expected = Buffer.from(`${marker}\n`);
	const read = readRegularFile(file, { length: expected.length });
	return read.kind === "file" && read.content.equals(expected);
}

/**
 * Remove the relaunch directory `dir` with its `loaded.env`, and nothing else: only a real
 * directory (not a link) of this user, named like one, that holds `loaded.env` and nothing
 * besides, where `loaded.env` is a regular file whose first line names its own path
 * ({@link RELAUNCH_ENV_MARKER}), as every relaunch file omp writes does. Any other directory
 * stays whole: an accidental look-alike, a copy (its line names another path), a `loaded.env`
 * that is a link, a FIFO or a device, and a relaunch file of an earlier build that wrote no
 * line. A file whose owner wrote the line on it is treated as omp's: only this user's own
 * directory is then removed.
 */
function removeRelaunchEnvDir(dir: string): void {
	try {
		if (!RELAUNCH_ENV_DIR_RE.test(path.basename(dir))) return;
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return;
		const entries = fs.readdirSync(dir);
		if (entries.length !== 1 || entries[0] !== RELAUNCH_ENV_FILE) return;
		const file = path.join(dir, RELAUNCH_ENV_FILE);
		const marker = relaunchEnvMarkerLine(file);
		if (!marker || !startsWithRelaunchMarker(file, marker)) return;
		fs.unlinkSync(file);
		fs.rmdirSync(dir);
	} catch {
		// Gone already, another user's, not omp's, or not only ours: leave it.
	}
}

/**
 * Remove the private relaunch file a command names (`--env-file=…/omp-bun-env-XXXXXX/
 * loaded.env`) with its directory, wherever it is, when it is one omp wrote
 * (`removeRelaunchEnvDir`): for a start that failed, and by the new process as it starts,
 * which may see another temporary directory than its writer did (a fork pane's terminal, say).
 * A look-alike named in the arguments, or passed on by a failed `/restart` or `/fork`, stays.
 */
export function discardBunRelaunchFile(args: readonly string[]): void {
	for (const arg of args) {
		if (!arg.startsWith("--env-file=")) continue;
		const file = path.resolve(arg.slice("--env-file=".length));
		if (path.basename(file) === RELAUNCH_ENV_FILE) removeRelaunchEnvDir(path.dirname(file));
	}
}

/**
 * Remove this user's relaunch directories older than {@link RELAUNCH_ENV_STALE_MS} under the
 * bases, each only when its file names itself: those of a new process that died before this
 * module loaded, or of a fork pane that never ran omp. Only a non-compiled omp on Linux writes
 * them, so only such a session start looks, on its main thread: not a worker thread, and not a
 * subprocess worker, which starts with `--no-env-file`.
 */
function sweepStaleRelaunchEnvDirs(): void {
	if (process.platform !== "linux" || isCompiledBinary() || process.execArgv.includes("--no-env-file")) return;
	if (!isMainThread) return;
	const now = Date.now();
	for (const base of relaunchEnvBases()) {
		let names: string[];
		try {
			names = fs.readdirSync(base);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!RELAUNCH_ENV_DIR_RE.test(name)) continue;
			const dir = path.join(base, name);
			const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
			if (stat && now - stat.mtimeMs > RELAUNCH_ENV_STALE_MS) removeRelaunchEnvDir(dir);
		}
	}
}

// A process started with a relaunch file (`/restart`, a `/fork` session) removes it now: Bun
// read it before any JavaScript ran, and nothing needs it again. Then the ones nobody removed.
discardBunRelaunchFile(process.execArgv);
sweepStaleRelaunchEnvDirs();

/** Whether `ch` is whitespace to Bun's `BUN_OPTIONS` splitter (Rust's `is_ascii_whitespace`). */
function isBunOptionsSpace(ch: string | undefined): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

/** One argument as Bun 1.4.4 splits it out of `BUN_OPTIONS`. */
interface BunOptionsToken {
	/** The argument Bun's argument parser receives. */
	arg: string;
}

/**
 * `arg` written so that Bun's `BUN_OPTIONS` splitter (`splitBunOptions`) reads it back as
 * exactly that one argument, whatever stands next to it: as a word, where a backslash keeps the
 * next character. Each whitespace character, quote and backslash is escaped, and so is a
 * leading `-`, so the text never starts with `--` and never takes a neighbour as its value.
 * An empty argument is `''`.
 */
function bunOptionsWord(arg: string): string {
	if (arg === "") return "''";
	let word = "";
	for (let i = 0; i < arg.length; i++) {
		const ch = arg[i]!;
		const special = isBunOptionsSpace(ch) || ch === "'" || ch === '"' || ch === "\\" || (i === 0 && ch === "-");
		word += special ? `\\${ch}` : ch;
	}
	return word;
}

/**
 * `BUN_OPTIONS` split as Bun 1.4.4 splits it (`append_options_env`, `src/bun_core/util.rs`).
 * A token that starts with `--` runs to the first whitespace or `=`; after `=`, or after
 * whitespace when a quote follows, it takes a value: a quoted span, kept with its quotes and
 * ended by its closing quote, or after `=` the text up to the next whitespace. Any other token
 * is read shell-like: quotes group and are dropped, and a backslash keeps the next character.
 */
function splitBunOptions(value: string): BunOptionsToken[] {
	const tokens: BunOptionsToken[] = [];
	let i = 0;
	while (i < value.length) {
		while (i < value.length && isBunOptionsSpace(value[i])) i++;
		if (i >= value.length) break;
		const start = i;
		if (value.startsWith("--", i)) {
			let j = i;
			while (j < value.length && !isBunOptionsSpace(value[j]) && value[j] !== "=") j++;
			const endOfFlag = j;
			let foundEquals = false;
			if (value[j] === "=") {
				foundEquals = true;
				j++;
			} else if (isBunOptionsSpace(value[j])) {
				while (j < value.length && isBunOptionsSpace(value[j])) j++;
			}
			if (value[j] === "'" || value[j] === '"') {
				const quote = value[j];
				j++;
				while (j < value.length && value[j] !== quote) j++;
				if (j < value.length) j++;
			} else if (foundEquals) {
				while (j < value.length && !isBunOptionsSpace(value[j])) j++;
			} else {
				j = endOfFlag;
			}
			tokens.push({ arg: value.slice(start, j) });
			i = j;
			continue;
		}
		let arg = "";
		let inSingle = false;
		let inDouble = false;
		let escape = false;
		while (i < value.length) {
			const ch = value[i]!;
			i++;
			if (escape) {
				arg += ch;
				escape = false;
			} else if (ch === "\\") {
				escape = true;
			} else if (inSingle) {
				if (ch === "'") inSingle = false;
				else arg += ch;
			} else if (inDouble) {
				if (ch === '"') inDouble = false;
				else arg += ch;
			} else if (ch === "'") {
				inSingle = true;
			} else if (ch === '"') {
				inDouble = true;
			} else if (isBunOptionsSpace(ch)) {
				i--;
				break;
			} else {
				arg += ch;
			}
		}
		tokens.push({ arg });
	}
	return tokens;
}

/**
 * `BUN_OPTIONS` for a process that starts the CLI again (`/restart`, a `/fork` session), without
 * the `--env-file`s it names: undefined to leave it as the process was started with it (it
 * names none, or the launch environment cannot be read and the relaunch is the pre-PR command,
 * `bunRelaunchArgs`), or the value to give it, where an empty one means unset. Bun reads
 * `BUN_OPTIONS` in every process it starts and would read such a file again, from the
 * directory the new process starts in; the values it gave this process are in the relaunch
 * file already (`bunRelaunchArgs`). The value is split as Bun splits it (`splitBunOptions`):
 * an argument `--env-file=…` goes, and so does a bare `--env-file` with the argument after it,
 * its value. Each argument kept is written as a word Bun reads back as exactly that argument
 * (`bunOptionsWord`), so no two of them join, as a bare flag and a quoted argument would once
 * the `--env-file` between them is gone. A bare `--env-file` with no argument after it, or with
 * an option there, is one whose meaning to Bun is not certain: then all of `BUN_OPTIONS` is
 * unset.
 */
export function bunOptionsWithoutEnvFiles(): string | undefined {
	if (!launchEnvValues) return undefined;
	const tokens = splitBunOptions(launchEnvValue("BUN_OPTIONS") ?? "");
	// The flag an argument names: its text up to `=` or whitespace, as Bun's parser reads it.
	const isEnvFileFlag = (token: BunOptionsToken) => {
		let end = 0;
		while (end < token.arg.length && token.arg[end] !== "=" && !isBunOptionsSpace(token.arg[end])) end++;
		return token.arg.slice(0, end) === "--env-file";
	};
	if (!tokens.some(isEnvFileFlag)) return undefined;
	const kept: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!isEnvFileFlag(token)) {
			kept.push(bunOptionsWord(token.arg));
			continue;
		}
		if (token.arg !== "--env-file") continue;
		// A bare flag takes the next argument as its file; an option there, or none, is not certain.
		const next = tokens[i + 1];
		if (next === undefined || next.arg.startsWith("-")) return "";
		i++;
	}
	return kept.join(" ");
}

/**
 * Whether Bun's `.env` parser reads `name` back as written: letters, digits, `_`, `-` and `.`,
 * in any order (measured on Bun 1.4.4; a name with any other character comes back otherwise,
 * or not at all).
 */
const BUN_DOTENV_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * `value` as Bun's `.env` parser reads back exactly, or undefined where it cannot. Bun expands
 * `$NAME` in every quoting style and reads `\$` as `$`, so each `$` is written `\$`; it reads
 * `\n` as a newline inside double quotes only, so double quotes serve only a value with no
 * backslash. It drops a carriage return and reads a backslash before the closing quote as an
 * escaped quote, so neither can be carried.
 */
function quoteDotenvValue(value: string): string | undefined {
	if (value.includes("\r") || value.endsWith("\\")) return undefined;
	const text = value.replaceAll("$", "\\$");
	for (const quote of ["'", "`"]) if (!value.includes(quote)) return `${quote}${text}${quote}`;
	return value.includes('"') || value.includes("\\") ? undefined : `"${text}"`;
}

/** `name`'s line in the relaunch file, or undefined for an entry it cannot carry. */
function relaunchEnvLine(name: string, value: string): string | undefined {
	const quoted = BUN_DOTENV_NAME_RE.test(name) ? quoteDotenvValue(value) : undefined;
	return quoted === undefined ? undefined : `${name}=${quoted}`;
}

/**
 * The value the relaunch file gives `name` (`bunRelaunchArgs`), or undefined when it gives none:
 * Bun did not load it, cannot carry it, or there is no relaunch file (the launch environment
 * cannot be read). Bun applies it in the new process only where its environment leaves `name`
 * unset.
 */
export function bunRelaunchValue(name: string): string | undefined {
	const value = bunLoadedEnv && Object.hasOwn(bunLoadedEnv, name) ? bunLoadedEnv[name] : undefined;
	return value !== undefined && relaunchEnvLine(name, value) !== undefined ? value : undefined;
}

/**
 * Runtime flags that give a new Bun process the values Bun's own `.env` loading gave this one
 * at its start, for a non-compiled omp that starts the CLI again (`/restart`, a `/fork`
 * session): `execvp(3)`, which `/restart` uses, and a terminal that starts a fork pass the
 * environment the process was started with, which those values are not in. The values, never
 * the whole environment (a fork leaves things out on purpose), go to a private file, mode 0600
 * in a `mkdtemp` directory of mode 0700, with a line naming the file itself
 * (`RELAUNCH_ENV_MARKER`), directly under `TMPDIR` as the process was started with it; where
 * that is unset, missing, not absolute, or cannot be written, under `/tmp`
 * (`relaunchEnvBaseCandidates`). The flag names only it, so Bun loads no other `.env` file,
 * and the new process removes it as soon as this module loads (`discardBunRelaunchFile`
 * removes it when the start fails, and a later start removes one left older than ten
 * minutes). An entry Bun's parser cannot read back (see `BUN_DOTENV_NAME_RE`,
 * `quoteDotenvValue`) is left out. `--no-env-file` when Bun loaded nothing, or, with a logged
 * warning that names each reason, when no base takes the file: the new process then starts
 * without those values. No flag at all where the launch environment cannot be read (a
 * non-compiled omp on macOS or Windows started with Bun's loading on): the relaunch is then the
 * command it was before, and Bun loads the `.env` files of the directory the new process
 * starts in.
 */
export function bunRelaunchArgs(): string[] {
	if (!bunLoadedEnv) return [];
	const lines: string[] = [];
	for (const [name, value] of Object.entries(bunLoadedEnv)) {
		const line = relaunchEnvLine(name, value);
		if (line !== undefined) lines.push(line);
	}
	if (lines.length === 0) return ["--no-env-file"];
	const reasons: string[] = [];
	const tried: string[] = [];
	for (const { dir: named, base, problem } of relaunchEnvBaseCandidates()) {
		if (!base) {
			reasons.push(`${named}: ${problem}`);
			continue;
		}
		// `TMPDIR` may be `/tmp` itself: one attempt there.
		if (tried.includes(base)) continue;
		tried.push(base);
		let dir: string | undefined;
		try {
			dir = fs.mkdtempSync(path.join(base, "omp-bun-env-"));
			const file = path.join(dir, RELAUNCH_ENV_FILE);
			const marker = relaunchEnvMarkerLine(file);
			if (!marker) throw new Error("its path cannot be written on one line");
			fs.writeFileSync(file, `${[marker, ...lines].join("\n")}\n`, { mode: 0o600, flag: "wx" });
			return [`--env-file=${file}`];
		} catch (error) {
			reasons.push(`${base}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
			if (dir) {
				// Our own directory, made a moment ago: remove whatever the failed write left, never
				// recursively. A removal that fails leaves it to the sweep; the next base is tried.
				try {
					fs.rmSync(path.join(dir, RELAUNCH_ENV_FILE), { force: true });
					fs.rmdirSync(dir);
				} catch {}
			}
		}
	}
	logger.warn("The relaunch starts without the values Bun loaded from .env files: no relaunch file could be written", {
		reasons,
	});
	return ["--no-env-file"];
}

/**
 * `PI_NATIVES_DIR` as omp was started with it. The commands the agent runs get this value,
 * never the directory omp resolved, so a command, and an omp it starts with its own `HOME`,
 * resolves the natives directory for itself. omp's children that are omp take the resolved
 * directory from a handoff instead (`NATIVES_DIR_HANDOFF_ENV_KEY`), which commands never get.
 */
const nativesDirAtLaunch = launchEnvValue("PI_NATIVES_DIR");

/**
 * Whether `name` is `PI_NATIVES_DIR`, which omp's own `.env` loading never applies: the natives
 * directory is fixed before `.env` files are read, so the value could only mislead the
 * programs omp starts. (Bun's own loading, in a non-compiled omp, runs before this module; the
 * workers and the broker omp starts run with it off, and `/restart` and a `/fork` session get
 * the values it loaded at the first launch, `bunRelaunchArgs`.)
 */
function isNativesDirEnvName(name: string): boolean {
	return process.platform === "win32" ? name.toUpperCase() === "PI_NATIVES_DIR" : name === "PI_NATIVES_DIR";
}

function expandDotenvValues(values: Record<string, string>, env: Record<string, string>): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const key in values) {
		expanded[key] = values[key].replace(
			/(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
			(match, escaped: string | undefined, braced: string | undefined, bare: string | undefined) => {
				if (escaped) return match.slice(1);
				const name = braced ?? bare;
				if (!name) return match;
				return env[name] ?? expanded[name] ?? "";
			},
		);
	}
	return expanded;
}

function filterChildShellEnvInternal(
	env: Record<string, string | undefined>,
	cwd: string,
	onDotenvValue?: (value: string) => void,
): Record<string, string> {
	const runtimeLaunchEnvValues = env === Bun.env || env === process.env ? launchEnvValues : undefined;
	const result = filterProcessEnv(env);
	if (env === Bun.env || env === process.env) {
		// Before the dotenv merge below, which still removes a value the project's `.env` set.
		if (nativesDirAtLaunch === undefined) delete result.PI_NATIVES_DIR;
		else result.PI_NATIVES_DIR = nativesDirAtLaunch;
	}
	// omp's own handoff to a child that is omp; a command is no such child. Empty, not
	// absent: the native shell starts from the process's own C environment, where the
	// handoff omp was started with remains (a forked session's has no parent), and this
	// value replaces it there. An empty handoff is none.
	result[NATIVES_DIR_HANDOFF_ENV_KEY] = "";
	const projectEnv = parseEnvFile(path.join(cwd, ".env"));
	const launchNodeEnv = runtimeLaunchEnvValues ? runtimeLaunchEnvValues.get("NODE_ENV") : env.NODE_ENV;
	const nodeEnvName = `.env.${launchNodeEnv || "development"}`;
	const modeEnv = parseEnvFile(path.join(cwd, nodeEnvName));
	const localEnv = parseEnvFile(path.join(cwd, ".env.local"));
	const modeLocalEnv = parseEnvFile(path.join(cwd, `${nodeEnvName}.local`));
	const launchEnv = { ...projectEnv, ...modeEnv, ...localEnv, ...modeLocalEnv };
	const expandedLaunchEnv = {
		...expandDotenvValues(projectEnv, result),
		...expandDotenvValues(modeEnv, result),
		...expandDotenvValues(localEnv, result),
		...expandDotenvValues(modeLocalEnv, result),
	};
	let fallbackLaunchEnv: Record<string, string> | undefined;
	let expandedFallbackLaunchEnv: Record<string, string> | undefined;
	if (!runtimeLaunchEnvValues && nodeEnvName !== ".env.development") {
		const fallbackModeEnv = parseEnvFile(path.join(cwd, ".env.development"));
		const fallbackModeLocalEnv = parseEnvFile(path.join(cwd, ".env.development.local"));
		const candidate = { ...projectEnv, ...fallbackModeEnv, ...localEnv, ...fallbackModeLocalEnv };
		const expandedCandidate = {
			...expandDotenvValues(projectEnv, result),
			...expandDotenvValues(fallbackModeEnv, result),
			...expandDotenvValues(localEnv, result),
			...expandDotenvValues(fallbackModeLocalEnv, result),
		};
		if (candidate.NODE_ENV === env.NODE_ENV || expandedCandidate.NODE_ENV === env.NODE_ENV) {
			// Without a launch snapshot, NODE_ENV may itself have come from dotenv.
			// Bun chose the default mode before loading it, so retain both candidates.
			fallbackLaunchEnv = candidate;
			expandedFallbackLaunchEnv = expandedCandidate;
		}
	}
	const allLaunchEnv = fallbackLaunchEnv ? { ...launchEnv, ...fallbackLaunchEnv } : launchEnv;
	if (onDotenvValue) {
		// Every value the project's dotenv files define is dotenv-sourced, whether
		// or not this process loaded it (a `--cwd` launch never did).
		for (const key in allLaunchEnv) onDotenvValue(allLaunchEnv[key]!);
		for (const key in expandedLaunchEnv) onDotenvValue(expandedLaunchEnv[key]!);
	}
	for (const key in allLaunchEnv) {
		const launchValue = runtimeLaunchEnvValues?.get(key);
		if (launchValue !== undefined) {
			// Launcher-owned name: it keeps the launcher's own value. Bun overwrites
			// an empty launcher value with the dotenv one, so restore the launcher
			// value whenever what survived is exactly what the dotenv file defines.
			if (
				result[key] !== launchValue &&
				(result[key] === launchEnv[key] ||
					result[key] === expandedLaunchEnv[key] ||
					result[key] === fallbackLaunchEnv?.[key] ||
					result[key] === expandedFallbackLaunchEnv?.[key])
			) {
				result[key] = launchValue;
			}
			continue;
		}
		if (runtimeLaunchEnvValues || projectEnvNamesLoadedByOmp.has(key)) {
			// Strong provenance: the launch environment is known and this name is
			// absent from it, or OMP itself injected the value — either way it came
			// from a project dotenv file, not the parent shell.
			const value = result[key];
			if (value !== undefined) onDotenvValue?.(value);
			delete result[key];
		} else if (
			result[key] === launchEnv[key] ||
			result[key] === expandedLaunchEnv[key] ||
			result[key] === fallbackLaunchEnv?.[key] ||
			result[key] === expandedFallbackLaunchEnv?.[key]
		) {
			// No launch-env snapshot (dotenv autoloaded without procfs): best-effort
			// value match against the Bun-parsed dotenv.
			const value = result[key];
			if (value !== undefined) onDotenvValue?.(value);
			delete result[key];
		}
	}
	// Last, after dotenv merging: no source (inherited, launcher, or dotenv) may
	// pin the child shell to the agent's own repository.
	stripGitRepoLocationEnv(result);
	return result;
}

/** Filters process env for child shells without launch-cwd dotenv values. */
export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = getProjectDir(),
): Record<string, string> {
	return filterChildShellEnvInternal(env, cwd);
}

/** Return every value defined by `cwd`'s dotenv files, plus environment values that came from them. */
export function getDotenvEnvValues(
	cwd: string = getProjectDir(),
	env: Record<string, string | undefined> = process.env,
): string[] {
	const values = new Set<string>();
	filterChildShellEnvInternal(env, cwd, value => values.add(value));
	return [...values];
}

/**
 * Parses a complete .env file with the runtime's dotenv grammar, then retains
 * only shell-identifier names and spawn-safe values before mirroring valid
 * `OMP_` variables to their `PI_` aliases.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const parsed = parseEnv(fs.readFileSync(filePath, "utf-8"));
		for (const key in parsed) {
			const value = parsed[key];
			if (value !== undefined && isValidEnvName(key) && isSafeEnvValue(value)) result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

// Eagerly parse the user's $HOME/.env, the config root's .env, the agent dir's .env and the
// current project's .env (from cwd). A test process reads neither of the first two: they are
// the developer's own (an auth broker and its token, provider keys, a telemetry collector) and
// would refill every name the test preload removed. Its agent dir and project are its own.
const readsHomeDotenv = !isBunTestRuntime();
const homeEnv = readsHomeDotenv ? parseEnvFile(path.join(os.homedir(), ".env")) : {};
const piEnv = readsHomeDotenv ? parseEnvFile(path.join(getConfigRootDir(), ".env")) : {};
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(getProjectDir(), ".env"));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

/**
 * `OTEL_*` values from OMP's own (non-project) dotenv files: the agent dir,
 * config root, and home `.env`. Those files configure OMP's exporter (endpoint,
 * auth headers, GenAI content capture), so the values are kept here instead of
 * in `Bun.env`/`process.env`: no child process or in-process extension
 * inherits them. Read through {@link $otelEnv}; {@link withOmpOtelEnv} exposes
 * them to the OpenTelemetry SDK for the synchronous span of its construction.
 *
 * Keys are folded with {@link foldOtelEnvName}.
 */
const ompOtelEnvFileValues = new Map<string, string>();

/**
 * Environment names compare case-insensitively on Windows, so a file that spells
 * `otel_exporter_otlp_headers` configures the same variable as the upper-case
 * name; match and key them folded there, exactly on POSIX (names are
 * case-sensitive).
 */
function foldOtelEnvName(name: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? name.toUpperCase() : name;
}

/**
 * @internal Loader seam, exported for tests only. Claims an `OTEL_*` entry from one of OMP's own dotenv files: the value is
 * kept in a private map, never in the process environment. Returns `false` for
 * any other name, which the caller handles as usual.
 *
 * Precedence matches the process-environment loader: a non-empty live value
 * (shell export, project `.env`) wins, and an earlier non-empty file value wins
 * over a later file.
 *
 * @param platform - Name-folding semantics; injectable for tests.
 */
export function claimOmpOtelEnvFileEntry(
	name: string,
	value: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const key = foldOtelEnvName(name, platform);
	if (!key.startsWith("OTEL_")) return false;
	if (!Bun.env[name] && !ompOtelEnvFileValues.get(key)) ompOtelEnvFileValues.set(key, value);
	return true;
}

/**
 * `OTEL_*` lookup for OMP's own telemetry: the live environment wins (a shell
 * export or project `.env`), then OMP's own `.env` files. Use this instead of
 * `process.env` for any `OTEL_*` setting OMP reads itself.
 */
export function $otelEnv(name: string): string | undefined {
	const live = Bun.env[name];
	if (live) return live;
	return ompOtelEnvFileValues.get(foldOtelEnvName(name, process.platform)) ?? live;
}

/**
 * Runs `fn` with OMP's `.env`-sourced `OTEL_*` values temporarily present in
 * `process.env` (only for names with no live value), then removes them again in
 * a `finally`. For code that reads the environment itself, such as the
 * OpenTelemetry SDK constructors.
 *
 * Synchronous only: awaiting inside would let other code, including child
 * process spawns, run while the values are set.
 */
export function withOmpOtelEnv<T>(fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of ompOtelEnvFileValues) {
		if (process.env[name]) continue;
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	try {
		return fn();
	} finally {
		for (const [name, prior] of previous) {
			if (prior === undefined) delete process.env[name];
			else process.env[name] = prior;
		}
	}
}

// The natives directory is one answer per process, from the environment omp was started
// with (or the handoff its parent gave it): fix it before the `.env` files below can change a
// variable the rule reads, in every omp process, whichever module loads first.
getNativesDir();

for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
	for (const key in file) {
		if (isMacosMallocStackLoggingEnvName(key) || isNativesDirEnvName(key)) continue;
		if (file !== projectEnv && claimOmpOtelEnvFileEntry(key, file[key])) continue;
		if (!Bun.env[key]) {
			Bun.env[key] = file[key];
			if (file === projectEnv) projectEnvNamesLoadedByOmp.add(key);
		}
	}
}

// Directory-affecting keys (XDG_*_HOME, and in default mode PI_CODING_AGENT_DIR)
// may have just arrived from the profile/agent `.env` applied above. The dirs
// resolver cached its paths at module load — before this file ran — so rebuild
// it now from the updated env. `getAgentDir()` already located the `.env` from
// the profile name + home, so this re-reads only the directory vars.
refreshDirsFromEnv();

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@oh-my-pi/pi-utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Read an environment variable by its EXACT, case-sensitive name.
 *
 * `process.env` / `Bun.env` lookups are case-insensitive on Windows (Node backs
 * them with `uv_os_getenv`, Bun with a `CaseInsensitiveASCIIStringArrayHashMap`),
 * so a lowercase literal like `public` silently resolves to a differently-cased
 * system variable — Windows ships `PUBLIC=C:\Users\Public`. Enumerated keys are
 * the only signal that preserves the real casing, so this trusts the lookup only
 * when a key with identical casing is actually present. On POSIX (case-sensitive
 * env) it is equivalent to a direct lookup.
 *
 * Use this instead of `process.env[name] ?? literal` wherever `name` may be a
 * user-supplied literal (e.g. a stored API key) rather than a genuine env-var
 * reference — otherwise the literal gets hijacked by a same-named system var.
 *
 * @param name - Environment variable name to look up.
 * @param env - Environment source; defaults to `process.env`.
 */
export function $envExact(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	// Enumeration preserves real key casing on Windows, unlike the getter; the
	// value is trusted only when an exact-case entry actually exists.
	for (const key in env) {
		if (key === name) return value;
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, NaN, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

let terminalHeadless = isBunTestRuntime();

/**
 * True when real-terminal side effects must be suppressed: stdout escape/frame
 * writes, stdin raw-mode + resume, CSI/OSC capability probes, SIGWINCH, window
 * title changes, and emergency restore. Defaults to {@link isBunTestRuntime} so
 * `bun test` launched inside a real TTY never paints the TUI, leaks probe
 * queries, or hijacks the developer's stdin; production runtimes stay
 * interactive.
 *
 * Terminal-contract tests that must exercise the real I/O path opt out with
 * `setTerminalHeadless(false)` and restore it afterwards.
 */
export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

/**
 * Override the {@link isTerminalHeadless} default and return the previous value
 * so callers can restore exact prior state (`const prev = setTerminalHeadless(false); … setTerminalHeadless(prev);`).
 */
export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

let interactiveHost = false;

/**
 * True when this process runs an interactive coding-agent host — the only
 * context where the operator can browse the Agent Hub and focus a live
 * subagent's session (`SessionFocusController`), so a subagent's session title
 * can become operator-visible. Off by default (print/RPC/ACP/eval/SDK/`bun
 * test` never render a focusable session tree); the interactive entrypoint
 * flips it on with {@link setInteractiveHost}.
 */
export function isInteractiveHost(): boolean {
	return interactiveHost;
}

/**
 * Set the interactive-host flag and return the previous value so callers can
 * restore exact prior state. See {@link isInteractiveHost}.
 */
export function setInteractiveHost(interactive: boolean): boolean {
	const previous = interactiveHost;
	interactiveHost = interactive;
	return previous;
}

/**
 * SQLite `busy_timeout` for the session-critical databases (agent.db,
 * history.db, stats.db).
 *
 * Interactive hosts tolerate a longer synchronous wait on lock contention
 * (SQLITE_BUSY during WAL recovery/checkpoint — see oh-my-pi#2421): the
 * operator sees a brief freeze and the statement eventually completes.
 * Headless hosts (print/RPC/ACP/eval/SDK) run a protocol on the same thread —
 * a multi-second synchronous busy-wait freezes their event loop and stalls
 * every in-flight frame with no liveness signal, so they use a short timeout
 * and rely on the existing asynchronous open/retry paths to recover from
 * contention instead of blocking.
 */
export function getDbBusyTimeoutMs(): number {
	return isInteractiveHost() ? 5000 : 1000;
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `PI_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (process.env.PI_COMPILED || Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
/** Parse a boolean-ish env value ("1", "yes", "on", …); `def` when unset/empty. */
export function parseFlag(value: string | undefined, def = false): boolean {
	if (!value) return def;
	return TRUTHY[value] === true;
}

export function $flag(name: string, def: boolean = false): boolean {
	return parseFlag($env[name], def);
}
