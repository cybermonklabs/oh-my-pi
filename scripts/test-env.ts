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
 * and the directories omp reads Claude's, Copilot's, gh's and glab's configuration from.
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
};

/**
 * The environment of a child a test starts as production: an omp CLI, fixture or probe that must not
 * count as a test child. It is `base` (the test's own environment, unless a site passes less)
 * without the names that point it at the developer's configuration ({@link DEVELOPER_ENV_PREFIXES},
 * {@link DEVELOPER_ENV_NAMES}), the test-runtime marker among them. A site that needs one sets it on
 * the result. It is the child's whole environment, as `Bun.spawn` takes `env`.
 *
 * HOME (and USERPROFILE on Windows) is a new empty directory of the child's own, removed when the
 * scope that made it ends ({@link removeWhenScopeEnds}): the test, or the `describe` block. Made in
 * a `beforeAll` hook, it is removed right after the hook, before the first test.
 *
 * A version manager's shims on PATH (mise's, asdf's) choose a version from the home's
 * configuration, and fail in a new one ("No version is set for shim: bun"). So this Bun goes on
 * PATH as `bun` and `bunx`, and the real `git`, `jj` and `node` go before their wrappers
 * ({@link productionChildPath}).
 */
export function createProductionChildEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined || DEVELOPER_ENV_NAMES[name] === true) continue;
		if (!DEVELOPER_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) env[name] = value;
	}
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-"));
	removeWhenScopeEnds(home);
	env.HOME = home;
	if (process.platform === "win32") env.USERPROFILE = home;
	// Windows names PATH `Path`, and a plain object's keys keep that case.
	const pathName = Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
	env[pathName] = productionChildPath(env[pathName] ?? "");
	return env;
}

/** The tools a production child runs by name whose wrappers find their version through the home. */
const WRAPPED_TOOLS = ["git", "jj", "node"];

/** The names Bun answers to, with the arguments that make Bun each one: `bunx` is `bun x`. */
const BUN_NAMES: Record<string, readonly string[]> = { bun: [], bunx: ["x"] };

/**
 * `searchPath` with a directory of its own first when it needs one. That directory holds this Bun
 * (`process.execPath`) as `bun` and `bunx` when the first of each on `searchPath` is not this Bun,
 * and the real one of each of {@link WRAPPED_TOOLS} whose first copy on `searchPath` is a wrapper
 * ({@link findRealTool}). Each is linked alone, so every other name resolves as on `searchPath`.
 */
function productionChildPath(searchPath: string): string {
	const links = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-bin-"));
	removeWhenScopeEnds(links);
	let linked = false;
	const link = (name: string, file: string, args: readonly string[] = []) => {
		if (process.platform === "win32") {
			fs.writeFileSync(path.join(links, `${name}.cmd`), windowsLauncher(file, args));
		} else {
			fs.symlinkSync(file, path.join(links, name));
		}
		linked = true;
	};
	const thisBun = fs.realpathSync(process.execPath);
	for (const [name, args] of Object.entries(BUN_NAMES)) {
		const found = Bun.which(name, { PATH: searchPath });
		if (found === null || fs.realpathSync(found) !== thisBun) link(name, process.execPath, args);
	}
	for (const tool of WRAPPED_TOOLS) {
		const file = findRealTool(searchPath, tool);
		if (file !== undefined) link(tool, file);
	}
	return linked ? [links, searchPath].filter(Boolean).join(path.delimiter) : searchPath;
}

/** A wrapper is a file in a directory named `shims`, or whose real path is in one. */
function isWrapper(file: string): boolean {
	const isShims = (directory: string) => path.basename(directory).toLowerCase() === "shims";
	return isShims(path.dirname(file)) || isShims(path.dirname(fs.realpathSync(file)));
}

/**
 * The real `tool` when the first one on `searchPath` is a wrapper: the first past the wrappers (where
 * a version manager's activation puts its installs), or, when none follows them (a PATH with mise's
 * shims alone), the file the first wrapper says it runs ({@link askWrapper}). Undefined when the
 * first `tool` is not a wrapper, or no real one is found.
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
 * A `<tool>.cmd` that runs `file` with `args` and then the arguments it was given, and exits with its
 * status: Windows needs a privilege to make a link. A `%` in the path is doubled, as a batch file
 * reads `%%` as one, and a `file` that is itself a batch file is run with `call`, which returns.
 */
function windowsLauncher(file: string, args: readonly string[]): string {
	const quoted = `"${file.replaceAll("%", "%%")}"`;
	const run = /\.(?:cmd|bat)$/i.test(file) ? `call ${quoted}` : quoted;
	return `@${[run, ...args].join(" ")} %*\r\n@exit /b %ERRORLEVEL%\r\n`;
}

/**
 * Removes `dir` when the scope that calls this ends: the scope of the `afterAll` it registers. From
 * inside a test, that test, so the directory is gone at the next test; from a `describe` body, that
 * block; from a `beforeAll` hook, the hook itself. Outside the test runner (a fixture that imports
 * this), `afterAll` refuses with "outside of the test runner" and the process's `exit` event removes
 * the directory instead.
 */
function removeWhenScopeEnds(dir: string): void {
	const remove = () => fs.rmSync(dir, { recursive: true, force: true });
	try {
		afterAll(remove);
	} catch (error) {
		if (!(error instanceof Error && error.message.includes("outside of the test runner"))) throw error;
		process.on("exit", remove);
	}
}
