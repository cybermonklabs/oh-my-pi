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
 * configuration of its own ({@link createTestEnv}), and with the real `git` and `jj` first on
 * PATH ({@link createTestPath}). A test that needs one of these names sets its own value.
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
	removeWhenProcessEnds(root);
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

/**
 * The PATH a test process starts with: the developer's own, with directories put first for each
 * of {@link WRAPPED_TOOLS} whose first copy on it is a wrapper ({@link planTestPath}), so every
 * other tool on PATH resolves as before. Undefined when PATH needs no change.
 */
export function createTestPath(searchPath: string | undefined): string | undefined {
	if (!searchPath) return undefined;
	const probe: PathProbe = {
		find: (directory, tool) => Bun.which(tool, { PATH: directory }),
		realpath: file => fs.realpathSync(file),
		list: directory => fs.readdirSync(directory),
	};
	const first: string[] = [];
	let links: string | undefined;
	for (const tool of WRAPPED_TOOLS) {
		const plan = planTestPath(searchPath, process.platform, probe, tool);
		if (plan === undefined) continue;
		if (plan.kind === "directory") {
			first.push(plan.directory);
			continue;
		}
		if (links === undefined) {
			links = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-bin-"));
			removeWhenProcessEnds(links);
			first.unshift(links);
		}
		if (plan.kind === "link") fs.symlinkSync(plan.file, path.join(links, tool));
		else fs.writeFileSync(path.join(links, `${tool}.cmd`), windowsLauncher(plan.file));
	}
	return first.length === 0 ? undefined : [...first, searchPath].join(path.delimiter);
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
 * past the wrappers. On POSIX it goes first as a link. On Windows, where a link needs a
 * privilege, git's own directory goes first when that holds only git's programs (Git for
 * Windows' `cmd`), else a `<tool>.cmd` launcher. Undefined when the first `tool` is not a
 * wrapper or none follows the wrappers.
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
	let wrapped = false;
	for (const entry of searchPath.split(paths.delimiter)) {
		if (!entry) continue;
		const file = probe.find(entry, tool);
		if (file === null) continue;
		if (isShims(entry) || isShims(paths.dirname(probe.realpath(file)))) {
			wrapped = true;
			continue;
		}
		if (!wrapped) return undefined;
		if (platform !== "win32") return { kind: "link", file };
		const directory = paths.dirname(file);
		return tool === "git" && probe.list(directory).every(name => WINDOWS_GIT_PROGRAM.test(name))
			? { kind: "directory", directory }
			: { kind: "launcher", file };
	}
	return undefined;
}

/**
 * A `<tool>.cmd` that runs `file` with the arguments it was given and exits with its status. `cmd`
 * passes the arguments on as `%*` writes them; a `%` in the path is doubled, as a batch file
 * reads `%%` as one, and a `file` that is itself a batch file is run with `call`, which returns.
 */
export function windowsLauncher(file: string): string {
	const quoted = `"${file.replaceAll("%", "%%")}"`;
	const run = /\.(?:cmd|bat)$/i.test(file) ? `call ${quoted}` : quoted;
	return `@${run} %*\r\n@exit /b %ERRORLEVEL%\r\n`;
}

/**
 * The environment a child starts with that no preload sets up: cargo's tests under
 * `scripts/run-rs-task.ts test:rs`, and the `bun test` processes `scripts/ci-test-ts.ts` starts
 * (their preload applies the same again). `base` without the machine's names, with the real
 * `git` and `jj` first on PATH ({@link createTestPath}), the omp directories and git and jj configuration
 * of {@link createTestEnv}, and the test-runtime marker.
 */
export function createTestChildEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(base)) {
		if (!isMachineEnvName(name)) env[name] = value;
	}
	// Windows names it `Path`; a plain object's keys keep that case.
	const pathName = Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
	const testPath = createTestPath(env[pathName]);
	return {
		...env,
		...(testPath === undefined ? {} : { [pathName]: testPath }),
		...createTestEnv(),
		PI_TEST_RUNTIME: "1",
	};
}

/**
 * Removes `dir` when this process ends. In the test runner, `afterAll` from a preload runs after
 * the process's last test, whatever the file is named or `NODE_ENV` says, and the runner emits no
 * `exit` event (Bun 1.4.4). Outside it, as in a `bun --preload … -e` child, `afterAll` refuses
 * with "outside of the test runner" and the process's `exit` event removes the directory instead;
 * any other error is thrown.
 */
function removeWhenProcessEnds(dir: string): void {
	const remove = () => fs.rmSync(dir, { recursive: true, force: true });
	try {
		afterAll(remove);
	} catch (error) {
		if (!(error instanceof Error && error.message.includes("outside of the test runner"))) throw error;
		process.on("exit", remove);
	}
}
