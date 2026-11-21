/**
 * The environment of a child a test starts as production ({@link createProductionChildEnv}).
 *
 * A test process never reads the developer's `~/.env`, `~/.omp/.env` or `~/.omp/agent/.env`
 * (`packages/utils/src/env.ts`), but a child that a test starts without the test-runtime marker
 * (`isBunTestRuntime`) runs as a user would, and reads them from its HOME. With the developer's
 * HOME, such a child takes their provider keys, auth broker and collector, and a test can pass on
 * a clean machine and fail on theirs.
 */
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Prefixes of the names that point a process at the developer's own configuration: omp's settings
 * (`PI_*`, `OMP_*`: the agent dir, config root, profile, config overlays, auth broker, and the
 * test-runtime marker `PI_TEST_RUNTIME`), mnemopi's, and the OpenTelemetry exporter's.
 */
const DEVELOPER_ENV_PREFIXES = ["PI_", "OMP_", "MNEMOPI_", "OTEL_"];

/**
 * The other names that do: the XDG roots omp's directories follow (`packages/utils/src/dirs.ts`),
 * the directories omp reads Claude's, Copilot's, gh's and glab's configuration from, and the
 * credential files, profile and endpoints the AWS and Google providers read.
 */
const DEVELOPER_ENV_NAMES: Record<string, true> = {
	XDG_CONFIG_HOME: true,
	XDG_DATA_HOME: true,
	XDG_STATE_HOME: true,
	XDG_CACHE_HOME: true,
	CLAUDE_CONFIG_DIR: true,
	COPILOT_HOME: true,
	GH_CONFIG_DIR: true,
	GLAB_CONFIG_DIR: true,
	AWS_PROFILE: true,
	AWS_CONFIG_FILE: true,
	AWS_SHARED_CREDENTIALS_FILE: true,
	AWS_WEB_IDENTITY_TOKEN_FILE: true,
	AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: true,
	AWS_CONTAINER_CREDENTIALS_FULL_URI: true,
	AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: true,
	GOOGLE_APPLICATION_CREDENTIALS: true,
};

/**
 * Whether `name` points a process at the developer's configuration ({@link DEVELOPER_ENV_PREFIXES},
 * {@link DEVELOPER_ENV_NAMES}). Windows compares environment names without case, so there
 * `pi_coding_agent_dir` is `PI_CODING_AGENT_DIR`.
 */
export function isDeveloperEnvName(name: string, platform: NodeJS.Platform = process.platform): boolean {
	const key = platform === "win32" ? name.toUpperCase() : name;
	return DEVELOPER_ENV_NAMES[key] === true || DEVELOPER_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * The environment of a child a test starts as production: an omp CLI, fixture or probe that must not
 * count as a test child. It is `base` (the test's own environment, unless a site passes less)
 * without the names that point it at the developer's configuration ({@link isDeveloperEnvName}),
 * the test-runtime marker among them. A site that needs one sets it on the result. It is the child's
 * whole environment, as `Bun.spawn` takes `env`.
 *
 * HOME (and USERPROFILE on Windows) is a new empty directory of the child's own, removed when the
 * scope that made it ends ({@link removeWhenScopeEnds}): the test, or the `describe` block. Made in
 * a `beforeAll` hook, it is removed right after the hook, before the first test. Made in a
 * concurrent test, it is removed when the process exits.
 *
 * A version manager's shims on PATH (mise's, asdf's) choose a version from the home's
 * configuration, and fail in a new one ("No version is set for shim: bun"). So this Bun answers to
 * `bun` and `bunx`, and the real `git`, `jj` and `node`, where one is found past their wrappers, go
 * before them ({@link productionChildPath}).
 */
export function createProductionChildEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const win32 = process.platform === "win32";
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined || isDeveloperEnvName(name)) continue;
		// The home is replaced below; on Windows a differently cased copy would be a second name.
		const key = win32 ? name.toUpperCase() : name;
		if (key === "HOME" || (win32 && key === "USERPROFILE")) continue;
		env[name] = value;
	}
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-"));
	removeWhenScopeEnds(home);
	env.HOME = home;
	if (win32) env.USERPROFILE = home;
	// Windows names PATH `Path`, and a plain object's keys keep that case.
	const pathName = Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
	env[pathName] = productionChildPath(env[pathName] ?? "");
	return env;
}

/** The tools a production child runs by name whose wrappers find their version through the home. */
const WRAPPED_TOOLS = ["git", "jj", "node"];

/** The names Bun answers to. A Bun run as `bunx` is `bun x`, on every platform. */
const BUN_NAMES = ["bun", "bunx"];

/**
 * `searchPath` with directories of its own first when it needs them, so that `bun` and `bunx` are
 * this Bun (`process.execPath`) when the first of each on `searchPath` is not, and each of
 * {@link WRAPPED_TOOLS} is the real one when its first copy on `searchPath` is a wrapper and a real
 * one is found ({@link findRealTool}). Every other name resolves as on `searchPath`.
 *
 * On POSIX, one directory holds a link to each, so only that name moves ahead. On Windows a link
 * needs a privilege, and a `.cmd` launcher cannot pass an argument that holds `"` or `%` (Bun
 * refuses such an argument for a batch file). So this Bun is hard-linked there as `bun.exe` and
 * `bunx.exe`, and a real tool's own directory goes ahead instead of a link to it: Git for
 * Windows' `git.exe` finds the rest of Git from its own path.
 */
function productionChildPath(searchPath: string): string {
	const win32 = process.platform === "win32";
	let links: string | undefined;
	const link = (name: string, file: string) => {
		if (links === undefined) {
			links = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-bin-"));
			removeWhenScopeEnds(links);
		}
		if (win32) hardLinkOrCopy(file, path.join(links, `${name}.exe`));
		else fs.symlinkSync(file, path.join(links, name));
	};
	const thisBun = fs.realpathSync(process.execPath);
	for (const name of BUN_NAMES) {
		const found = Bun.which(name, { PATH: searchPath });
		if (found === null || fs.realpathSync(found) !== thisBun) link(name, process.execPath);
	}
	const toolDirs = new Set<string>();
	for (const tool of WRAPPED_TOOLS) {
		const file = findRealTool(searchPath, tool);
		if (file === undefined) continue;
		if (win32) toolDirs.add(path.dirname(file));
		else link(tool, file);
	}
	return [links, ...toolDirs, searchPath].filter(Boolean).join(path.delimiter);
}

/** A hard link to `file` at `target`, or a copy when they are on different volumes. */
function hardLinkOrCopy(file: string, target: string): void {
	try {
		fs.linkSync(file, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		fs.copyFileSync(file, target);
	}
}

/** A wrapper is a file in a directory named `shims`, or whose real path is in one. */
function isWrapper(file: string): boolean {
	const isShims = (directory: string) => path.basename(directory).toLowerCase() === "shims";
	return isShims(path.dirname(file)) || isShims(path.dirname(fs.realpathSync(file)));
}

/**
 * The real `tool` when the first one on `searchPath` is a wrapper: the first past the wrappers (where
 * a version manager's activation puts its installs), or, when none follows them (a PATH with mise's
 * shims alone), the file the first wrapper says it runs ({@link askWrapper}; only node can say).
 * Undefined when the first `tool` is not a wrapper, or no real one is found.
 */
function findRealTool(searchPath: string, tool: string): string | undefined {
	let wrapper: string | undefined;
	for (const entry of searchPath.split(path.delimiter)) {
		if (!entry) continue;
		const file = Bun.which(tool, { PATH: entry });
		if (file === null) continue;
		if (isWrapper(file)) {
			wrapper ??= file;
			continue;
		}
		return wrapper === undefined ? undefined : file;
	}
	if (wrapper === undefined) return undefined;
	const answer = askWrapper(wrapper, tool, searchPath);
	return answer === null || isWrapper(answer) ? undefined : answer;
}

/** How a tool says which file it runs from: node prints its own executable. */
const SELF_REPORT: Record<string, readonly string[]> = { node: ["-p", "process.execPath"] };

/** How long a wrapper has to say which file it runs. */
const ASK_TIMEOUT_MS = 3_000;

/** Each wrapper's answer, by wrapper, tool and PATH: a process asks each wrapper once. */
const wrapperAnswers = new Map<string, string | null>();

/**
 * Runs `wrapper` with {@link SELF_REPORT}'s arguments for `tool`, with this process's environment,
 * whose home the wrapper reads, and `searchPath` as PATH, and takes the file it prints when that file
 * exists. A wrapper that fails has no such tool to give; one that does not answer within
 * {@link ASK_TIMEOUT_MS} is no answer either, and is named on stderr, since the child then runs it.
 */
function askWrapper(wrapper: string, tool: string, searchPath: string): string | null {
	const args = SELF_REPORT[tool];
	if (args === undefined) return null;
	const key = [wrapper, tool, searchPath].join("\0");
	if (wrapperAnswers.has(key)) return wrapperAnswers.get(key) ?? null;
	const pathName = Object.keys(process.env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
	const child = Bun.spawnSync([wrapper, ...args], {
		env: { ...process.env, [pathName]: searchPath },
		stdout: "pipe",
		stderr: "ignore",
		timeout: ASK_TIMEOUT_MS,
	});
	if (child.exitCode === null) {
		process.stderr.write(
			`scripts/test-env.ts: ${wrapper} did not say which ${tool} it runs within ${ASK_TIMEOUT_MS / 1000} s\n`,
		);
	}
	const file = child.exitCode === 0 ? child.stdout.toString().trim() : "";
	const answer = file !== "" && fs.existsSync(file) ? file : null;
	wrapperAnswers.set(key, answer);
	return answer;
}

/**
 * Removes `dir` when the scope that calls this ends: the scope of the `afterAll` it registers. From
 * inside a test, that test, so the directory is gone at the next test; from a `describe` body, that
 * block; from a `beforeAll` hook, the hook itself. Where Bun gives no such scope, the process's
 * `exit` event removes the directory instead: outside the test runner (a fixture that imports this),
 * where `afterAll` refuses with "outside of the test runner", and in a concurrent test, where Bun
 * refuses `afterAll` and `onTestFinished` alike ("cannot be called inside a concurrent test").
 */
function removeWhenScopeEnds(dir: string): void {
	const remove = () => fs.rmSync(dir, { recursive: true, force: true });
	try {
		afterAll(remove);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (!message.includes("outside of the test runner") && !message.includes("inside a concurrent test")) throw error;
		process.on("exit", remove);
	}
}
