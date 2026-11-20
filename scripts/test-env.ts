/**
 * The environment a test process starts with, shared by `scripts/test-preload.ts` (every
 * `bun test` process), `scripts/ci-test-ts.ts` (the children it starts) and
 * `scripts/run-rs-task.ts` (cargo's tests, which no preload reaches).
 *
 * The product reads its configuration, the terminal it runs in and other tools' locations
 * from the environment. A developer's shell, terminal or omp launcher sets many of those
 * names (an omp config overlay, `CLAUDE_CONFIG_DIR`, `TMUX`, an SSH session, an auth broker
 * and its token), so a suite that passes in CI read the developer's machine and failed, or
 * called their services, when they ran it. A test process therefore starts without every
 * name the product reads, except those in {@link KEEP}, with omp directories and git and jj
 * configuration of its own ({@link createTestEnv}), and with this Bun as `bun` and the real `git`
 * and `jj` first on PATH ({@link createTestPath}). A test that needs one of these names sets its
 * own value. A child a test runs as production starts without the machine's names too, but with
 * neither the marker nor the test's omp directories, and in a home of its own
 * ({@link createProductionChildEnv}).
 *
 * The names come from `scripts/test-env-census.ts` (`test-env-names.json`), plus
 * {@link MACHINE_ENV_PREFIXES} and {@link UNSEEN} for the reads the census cannot see.
 */
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import censusByFile from "./test-env-names.json" with { type: "json" };

/** Every name the census found, from its file-by-file record. */
const CENSUS_NAMES: ReadonlySet<string> = new Set(Object.values(censusByFile).flat());

/**
 * Whole namespaces: omp's own settings (`PI_*`, `OMP_*`; the Python eval prelude and
 * names built at run time read some the census cannot see), mnemopi's settings, the
 * OpenTelemetry exporters that would send a test's spans to the developer's collector, and
 * git's and jj's settings (an omp session's `GIT_CONFIG_COUNT` include, `GIT_EDITOR`,
 * `JJ_CONFIG`), which {@link createTestEnv} replaces with configuration of its own.
 */
const MACHINE_ENV_PREFIXES = ["PI_", "OMP_", "MNEMOPI_", "OTEL_", "GIT_", "JJ_"];

/** Names the census cannot see, each with what reads it. */
const UNSEEN: Record<string, string> = {
	CONDA_DEFAULT_ENV: "an active conda environment, passed to the Python kernel by name (eval/py/runtime.ts)",
	EMAIL: "git's committer address when its configuration names none",
};

/** Names a test process keeps, each with why it needs the developer's own value. */
const KEEP: Record<string, string> = {
	HOME: "Bun reads it once at startup (os.homedir() ignores later changes); tests that need a home build one",
	PATH: "how a test finds the tools it runs",
	PWD: "the directory the run started in",
	SHELL: "the shell a test's child starts",
	LANG: "the locale every child runs in",
	LC_ALL: "the locale every child runs in",
	TEMP: "the temporary directory (Windows)",
	TMP: "the temporary directory (Windows)",
	APPDATA: "where Windows programs keep their data; a child cannot run without it",
	LOCALAPPDATA: "where Windows programs keep their data; a child cannot run without it",
	USERPROFILE: "the Windows home directory, as HOME",
	SYSTEMROOT: "the Windows directory; a child cannot run without it",
	COMSPEC: "the Windows command interpreter",
	PSMODULEPATH: "where PowerShell finds its modules",
	SCOOP: "where Scoop installs the tools on PATH (Windows)",
	GIT_INSTALL_ROOT: "where Git for Windows is installed",
	DEVELOPER_DIR: "the Xcode toolchain (macOS)",
	LD_LIBRARY_PATH: "where the dynamic linker finds native libraries",
	MISE_DATA_DIR: "where the version-manager shims on PATH find their tools",
	NODE_ENV: "the runtime's test signal",
	BUN_ENV: "the runtime's test signal",
	BUN_BE_BUN: "Bun's own re-exec marker",
	OMP_FORCE_RUST_TASKS: "the test runner's own control (scripts/run-rs-task.ts)",
	OMP_APPLEFM_SWIFTC: "the Swift compiler pi-natives' build.rs builds the macOS bridge with; test:rs builds first",
	OMP_APPLEFM_MODULE_CACHE: "the Swift module cache pi-natives' build.rs builds the macOS bridge with",
	APPVEYOR: "the CI system the run is on",
	BUILDKITE: "the CI system the run is on",
	CIRCLECI: "the CI system the run is on",
	GITEA_ACTIONS: "the CI system the run is on",
	GITHUB_ACTIONS: "the CI system the run is on",
	GITLAB_CI: "the CI system the run is on",
	TRAVIS: "the CI system the run is on",
};

/** The test runner's own controls: the test-runtime marker and the knobs a test reads. */
const KEEP_PREFIXES = ["PI_TEST_", "OMP_TEST_"];

/** Whether a test process starts without `name`. */
export function isMachineEnvName(name: string): boolean {
	if (name in KEEP || KEEP_PREFIXES.some(prefix => name.startsWith(prefix))) return false;
	return CENSUS_NAMES.has(name) || name in UNSEEN || MACHINE_ENV_PREFIXES.some(prefix => name.startsWith(prefix));
}

/** The names {@link createTestEnv} sets. */
export const TEST_ENV_NAMES = [
	"OMP_CONFIG_ROOT",
	"OMP_DOWNLOAD_ROOT",
	"PI_CODING_AGENT_DIR",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"JJ_CONFIG",
] as const;

/**
 * The omp directories and the git and jj configuration a test process starts with. omp roots
 * its state at the home directory (`~/.omp`, and mnemopi's `~/.hermes`), which a test cannot
 * move: Bun fixes `os.homedir()` when it starts, and a temporary HOME loses the
 * version-manager shims on PATH. So every process gets an empty config root of its own
 * (`OMP_CONFIG_ROOT`), removed when it exits, with the agent directory inside it; mnemopi puts
 * its data and blobs in the root's `mnemopi` directory itself (`stateDir` in
 * packages/mnemopi/src/config.ts). The one thing it shares is `~/.omp` as `OMP_DOWNLOAD_ROOT`:
 * the downloads whose bytes their version fixes (the Chromium build, the native addon and its
 * grammars, the embedding and tiny models), which cannot change what a test sees and cost minutes
 * to fetch again.
 *
 * git and jj read the home's configuration too: a developer's identity, commit signing with
 * their key, hooks and default branch, none of which CI has. In the root, git's global
 * configuration names no identity and only moves its global ignore and attributes files off
 * `~/.config/git` (`GIT_CONFIG_GLOBAL` moves the configuration files alone), the system file is
 * not read, and jj's user configuration is empty, so a test that commits names its own author,
 * as it must in CI. A test that sets its own `GIT_CONFIG_*` or `JJ_CONFIG` for a child keeps
 * it; one that gives a child a home whose git or jj configuration it wants read removes
 * `GIT_CONFIG_GLOBAL` or `JJ_CONFIG` from that child.
 */
export function createTestEnv(): Record<(typeof TEST_ENV_NAMES)[number], string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-root-"));
	removeWhenScopeEnds(root);
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	// Git reads backslashes in a value as escapes; forward slashes name the same Windows path.
	const gitDir = path.join(root, "git").split(path.sep).join("/");
	const gitConfig = path.join(root, "gitconfig");
	fs.writeFileSync(gitConfig, `[core]\n\texcludesFile = ${gitDir}/ignore\n\tattributesFile = ${gitDir}/attributes\n`);
	const jjConfig = path.join(root, "jj-config.toml");
	fs.writeFileSync(jjConfig, "");
	return {
		OMP_CONFIG_ROOT: root,
		// `CONFIG_DIR_NAME` in @oh-my-pi/pi-utils/dirs, which this file cannot import: its module
		// state would be fixed from the developer's environment before the preload clears it.
		OMP_DOWNLOAD_ROOT: path.join(os.homedir(), ".omp"),
		PI_CODING_AGENT_DIR: agentDir,
		GIT_CONFIG_GLOBAL: gitConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		JJ_CONFIG: jjConfig,
	};
}

/** The tools a test runs from PATH whose wrappers read the developer's machine. */
const WRAPPED_TOOLS = ["git", "jj"] as const;

/** The names Bun answers to, with the arguments that make Bun each one: `bunx` is `bun x`. */
const BUN_NAMES: Record<string, readonly string[]> = { bun: [], bunx: ["x"] };

/** The name `env` gives PATH: Windows names it `Path`, and a plain object's keys keep that case. */
function pathKey(env: Record<string, unknown>): string {
	return Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * The PATH a test process starts with: `searchPath` with one directory of its own first when it
 * needs one. That directory holds this Bun (`process.execPath`) as `bun` and `bunx` when the
 * first of each on `searchPath` is not this Bun, so a child that runs `bun` by name (an RPC
 * child's `bun <cli>`) runs this one, never a version manager's shim, which fails in a home of a
 * test's own ("No version is set for shim: bun"). It also holds the real one of each of `tools`
 * ({@link WRAPPED_TOOLS} unless given) whose first copy on `searchPath` is a wrapper
 * ({@link planTestPath}); on Windows Git for Windows' own `cmd` directory can go first instead.
 * Each is linked alone, and Bun's own directory is not put on PATH, so every other name resolves
 * as on `searchPath`: the tools beside Bun (Homebrew's, `/usr/local/bin`'s, the global binaries in
 * `~/.bun/bin`) keep their place. A PATH this returned comes back unchanged, since its first
 * `bun` is this Bun and its first tools are the real ones.
 */
export function createTestPath(searchPath: string, tools: readonly string[] = WRAPPED_TOOLS): string {
	const probe: PathProbe = {
		find: (directory, tool) => Bun.which(tool, { PATH: directory }),
		realpath: file => fs.realpathSync(file),
		list: directory => fs.readdirSync(directory),
		ask: (wrapper, tool) => askWrapper(wrapper, tool, searchPath),
	};
	const first: string[] = [];
	let links: string | undefined;
	const linksDirectory = (): string => {
		if (links === undefined) {
			links = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-bin-"));
			removeWhenScopeEnds(links);
			first.unshift(links);
		}
		return links;
	};
	const thisBun = fs.realpathSync(process.execPath);
	for (const [name, args] of Object.entries(BUN_NAMES)) {
		const found = Bun.which(name, { PATH: searchPath });
		// A launcher this wrote for an earlier PATH is this Bun too (Windows).
		const isThisBun =
			found !== null &&
			(/\.cmd$/i.test(found)
				? fs.readFileSync(found, "utf8") === windowsLauncher(process.execPath, args)
				: fs.realpathSync(found) === thisBun);
		if (isThisBun) continue;
		if (process.platform === "win32") {
			fs.writeFileSync(path.join(linksDirectory(), `${name}.cmd`), windowsLauncher(process.execPath, args));
		} else {
			fs.symlinkSync(process.execPath, path.join(linksDirectory(), name));
		}
	}
	for (const tool of tools) {
		const plan = planTestPath(searchPath, process.platform, probe, tool);
		if (plan === undefined) continue;
		if (plan.kind === "directory") {
			first.push(plan.directory);
			continue;
		}
		if (plan.kind === "link") fs.symlinkSync(plan.file, path.join(linksDirectory(), tool));
		else fs.writeFileSync(path.join(linksDirectory(), `${tool}.cmd`), windowsLauncher(plan.file));
	}
	return [...first, searchPath].filter(Boolean).join(path.delimiter);
}

/** What {@link createTestPath} puts first on PATH for one tool. */
export type TestPathPlan =
	/** The real `git`'s own directory, which holds nothing but git's programs (Windows). */
	| { kind: "directory"; directory: string }
	/** A new directory holding a link named for the tool to its real file (POSIX). */
	| { kind: "link"; file: string }
	/** A new directory holding `<tool>.cmd`, which runs the real file with its arguments (Windows). */
	| { kind: "launcher"; file: string };

/** The file system as {@link planTestPath} reads it, so a test can decide for any platform. */
export interface PathProbe {
	/** The `tool` a lookup in `directory` alone finds (on Windows, by `PATHEXT`), or null. */
	find(directory: string, tool: string): string | null;
	/** `file` with every link resolved. */
	realpath(file: string): string;
	/** The names in `directory`. */
	list(directory: string): string[];
	/**
	 * The file the wrapper `wrapper` runs for `tool`, as the tool itself says when the wrapper runs
	 * with this process's environment, whose home the wrapper reads; null when the tool cannot say
	 * ({@link SELF_REPORT}) or the wrapper fails.
	 */
	ask(wrapper: string, tool: string): string | null;
}

/** How a tool says which file it runs from: node and Python print their own executable. */
const SELF_REPORT: Record<string, readonly string[]> = {
	node: ["-p", "process.execPath"],
	python3: ["-c", "import sys; print(sys.executable)"],
	python: ["-c", "import sys; print(sys.executable)"],
};

/** How long a wrapper has to say which file it runs. */
const ASK_TIMEOUT_MS = 3_000;

/** Each wrapper's answer, by wrapper, tool and PATH: a process asks each wrapper once. */
const wrapperAnswers = new Map<string, string | null>();

/**
 * {@link PathProbe.ask} on this system: runs `wrapper` with {@link SELF_REPORT}'s arguments for
 * `tool`, this process's environment and `searchPath` as PATH, and takes the file it prints when
 * that file exists. A wrapper that fails (a shim with no version selected) has no such tool to
 * give; one that does not answer within {@link ASK_TIMEOUT_MS} is no answer either, and is named
 * on stderr, since the child then runs that wrapper.
 */
function askWrapper(wrapper: string, tool: string, searchPath: string): string | null {
	const args = SELF_REPORT[tool];
	if (args === undefined) return null;
	const key = [wrapper, tool, searchPath].join("\0");
	if (wrapperAnswers.has(key)) return wrapperAnswers.get(key) ?? null;
	const env = { ...process.env, [pathKey(process.env)]: searchPath };
	const child = Bun.spawnSync([wrapper, ...args], { env, stdout: "pipe", stderr: "ignore", timeout: ASK_TIMEOUT_MS });
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

/** git's own programs, as Git for Windows installs them in its `cmd` directory. */
const WINDOWS_GIT_PROGRAM = /^(?:git|gitk|git-gui)(?:\.(?:exe|com|cmd|bat))?$/i;

/**
 * Decides what {@link createTestPath} puts first on `searchPath` for `tool` on `platform`. The
 * first `tool` on PATH is a wrapper when it is in a directory named `shims` or its real path is
 * in one: a dotfiles shim (one scans every git commit for terms it decrypts with the
 * developer's key; the jj one finds the real jj through the home), or mise's, asdf's or Scoop's,
 * which choose a version from the home's config. Each reads the developer's machine, and each
 * failed once a test gave the tool a home of its own (`HOME: dir`). The real one is the first
 * past the wrappers. When none follows them (a login PATH that holds mise's shims but not its
 * installs), a tool that can say which file it runs (node, Python) is asked through the first wrapper
 * ({@link PathProbe.ask}). On POSIX the real one goes first as a link. On Windows, where a link
 * needs a privilege, git's own directory goes first when that holds only git's programs (Git for
 * Windows' `cmd`), else a `<tool>.cmd` launcher. Undefined when the first `tool` is not a
 * wrapper, or when no real one follows the wrappers and none is found by asking.
 */
export function planTestPath(
	searchPath: string,
	platform: NodeJS.Platform,
	probe: PathProbe,
	tool = "git",
): TestPathPlan | undefined {
	const paths = platform === "win32" ? path.win32 : path.posix;
	const isShims = (directory: string) =>
		platform === "win32"
			? paths.basename(directory).toLowerCase() === "shims"
			: paths.basename(directory) === "shims";
	const isWrapper = (file: string) => isShims(paths.dirname(file)) || isShims(paths.dirname(probe.realpath(file)));
	const plan = (file: string): TestPathPlan => {
		if (platform !== "win32") return { kind: "link", file };
		const directory = paths.dirname(file);
		return tool === "git" && probe.list(directory).every(name => WINDOWS_GIT_PROGRAM.test(name))
			? { kind: "directory", directory }
			: { kind: "launcher", file };
	};
	let wrapper: string | undefined;
	for (const entry of searchPath.split(paths.delimiter)) {
		if (!entry) continue;
		const file = probe.find(entry, tool);
		if (file === null) continue;
		if (isWrapper(file)) {
			wrapper ??= file;
			continue;
		}
		return wrapper === undefined ? undefined : plan(file);
	}
	const answer = wrapper === undefined ? null : probe.ask(wrapper, tool);
	return answer === null || isWrapper(answer) ? undefined : plan(answer);
}

/**
 * A `<tool>.cmd` that runs `file` with `args` and then the arguments it was given, and exits with
 * its status. `cmd` passes the arguments on as `%*` writes them; a `%` in the path is doubled, as
 * a batch file reads `%%` as one, and a `file` that is itself a batch file is run with `call`,
 * which returns.
 */
export function windowsLauncher(file: string, args: readonly string[] = []): string {
	const quoted = `"${file.replaceAll("%", "%%")}"`;
	const run = /\.(?:cmd|bat)$/i.test(file) ? `call ${quoted}` : quoted;
	return `@${[run, ...args].join(" ")} %*\r\n@exit /b %ERRORLEVEL%\r\n`;
}

/**
 * The environment a child starts with that no preload sets up: cargo's tests under
 * `scripts/run-rs-task.ts test:rs`, and the `bun test` processes `scripts/ci-test-ts.ts` starts
 * (their preload applies the same again, and changes nothing more). `base` without the machine's
 * names, with this Bun as `bun` and the real `git` and `jj` first on PATH ({@link createTestPath}),
 * the omp directories and git and jj configuration of {@link createTestEnv}, and the test-runtime
 * marker.
 */
export function createTestChildEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(base)) {
		if (!isMachineEnvName(name)) env[name] = value;
	}
	const name = pathKey(env);
	return {
		...env,
		[name]: createTestPath(env[name] ?? ""),
		...createTestEnv(),
		PI_TEST_RUNTIME: "1",
	};
}

/** The tools a production child runs from PATH: those a test process runs, node and Python. */
const PRODUCTION_CHILD_TOOLS = [...WRAPPED_TOOLS, "node", "python3", "python"] as const;

/**
 * The environment of a child a test starts as production, as a user would run it: an omp CLI,
 * fixture or `--eval` probe that must not count as a test child (`isBunTestRuntime`). It is
 * `base` (the test's own environment, unless a site passes less) without the machine's names
 * ({@link isMachineEnvName}), which takes the test process's own omp directories and git and jj
 * configuration too, and without the test-runtime marker `PI_TEST_RUNTIME`. A site that needs
 * one of those, or any other name, sets it on the result. It is the child's whole environment,
 * as `Bun.spawn` and `node:child_process` take `env`; a native `PtySession` or `Shell` lays `env`
 * over this process's own environment, which an overlay cannot take a name out of, so a site
 * that starts one sets `PI_TEST_RUNTIME: "0"` on the result.
 *
 * HOME (and USERPROFILE on Windows) is a new empty directory of the child's own, removed when the
 * scope that made it ends: the test, or the `describe` block ({@link removeWhenScopeEnds}).
 * Called from a `beforeAll` hook it is removed right after the hook, before the first test, so a
 * site makes it in the test or the `describe` body. As production, omp loads `~/.env`,
 * `~/.omp/.env` and `~/.omp/agent/.env` (`packages/utils/src/env.ts`), and writes its logs and
 * state under `~/.omp`: with the developer's HOME it would take their auth broker and token,
 * provider keys and collector, and leave its logs in their home, none of which a clean machine
 * has. A shell started with it reads no `~/.bash_profile` or `~/.bashrc` of theirs, and Python
 * none of their user site-packages. A test process keeps the developer's HOME
 * ({@link createTestEnv}) because it cannot change its own: Bun fixed `os.homedir()` when it
 * started, before the preload ran, and a marked test process reads none of those files. A child
 * reads HOME when it starts, so it can have its own.
 *
 * What the preload keeps HOME for, the version-manager shims on PATH that find their tool through
 * the home, this keeps through PATH, as a test process's own PATH does ({@link createTestPath}):
 * this Bun is `bun`, and the real `git`, `jj`, `node` and Python go before their wrappers. omp finds
 * node on PATH (`dap/config.ts` resolves it, and `mcp/transports/stdio.ts` runs it by name), so a
 * real node on the child's PATH covers those uses. Each is the first past the wrappers (where a
 * version manager's activation puts it: mise's installs directory after its shims), or, where none
 * follows them (a login PATH with mise's shims alone), the file the first wrapper says it runs
 * (`node -p process.execPath`, Python's `sys.executable`), asked with this process's environment,
 * whose home the wrapper reads. With no such tool on PATH at all, the child has none, as on a
 * machine without it.
 */
export function createProductionChildEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== undefined && name !== "PI_TEST_RUNTIME" && !isMachineEnvName(name)) env[name] = value;
	}
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-"));
	removeWhenScopeEnds(home);
	env.HOME = home;
	if (process.platform === "win32") env.USERPROFILE = home;
	const name = pathKey(env);
	env[name] = createTestPath(env[name] ?? "", PRODUCTION_CHILD_TOOLS);
	return env;
}

/**
 * Removes `dir` when the scope that calls this ends. In the test runner that is the scope of the
 * `afterAll` it registers (Bun 1.4.4, measured): from inside a test, that test, so the directory
 * is gone at the next test; from a `describe` body, that block; from a preload or a test file's
 * top level, the whole run, whatever the file is named or `NODE_ENV` says; from a `beforeAll`
 * hook, the hook itself, so the directory is gone before the first test. The runner emits no
 * `exit` event. Outside it, as in a `bun --preload … -e` child, `afterAll` refuses with "outside
 * of the test runner" and the process's `exit` event removes the directory instead; any other
 * error is thrown.
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
