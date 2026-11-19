import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$envExact,
	$otelEnv,
	claimOmpOtelEnvFileEntry,
	filterChildShellEnv,
	filterProcessEnv,
	getDbBusyTimeoutMs,
	parseEnvFile,
	setInteractiveHost,
	stripGitRepoLocationEnv,
	withOmpOtelEnv,
} from "@oh-my-pi/pi-utils/env";
import { createProductionChildEnv } from "../../../scripts/test-env";

const tempDirs: string[] = [];

// Every variable `dirs.ts` consults to pick the profile, agent dir or config/state roots. A probe child
// must not inherit any of them from the developer's shell (e.g. OMP_PROFILE beats PI_PROFILE, and a
// named profile ignores PI_CODING_AGENT_DIR) or from the test preload (OMP_CONFIG_ROOT), or it would
// read a different agent dir or config root than its fixture home.
const DIR_RESOLUTION_ENV_RESET = {
	OMP_PROFILE: undefined,
	PI_PROFILE: undefined,
	PI_CONFIG_DIR: undefined,
	OMP_CONFIG_ROOT: undefined,
	OMP_DOWNLOAD_ROOT: undefined,
	XDG_DATA_HOME: undefined,
	XDG_STATE_HOME: undefined,
	XDG_CACHE_HOME: undefined,
};

const runtimeProbePath = path.join(import.meta.dir, "fixtures", "test-runtime-probe.ts");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, ".env");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("getDbBusyTimeoutMs", () => {
	it("defaults to the bounded headless timeout", () => {
		const previous = setInteractiveHost(false);
		try {
			expect(getDbBusyTimeoutMs()).toBe(1000);
		} finally {
			setInteractiveHost(previous);
		}
	});

	it("keeps the interactive timeout for interactive hosts", () => {
		const previous = setInteractiveHost(true);
		try {
			expect(getDbBusyTimeoutMs()).toBe(5000);
		} finally {
			setInteractiveHost(previous);
		}
	});
});
/**
 * What `isBunTestRuntime()` answers in a child started as production, in a home of its own, with
 * `env` (the runner signals each case sets or removes) on top.
 */
async function runRuntimeProbe(
	env: Record<string, string | undefined>,
	probePath = runtimeProbePath,
): Promise<boolean> {
	const cwd = path.dirname(writeTempEnv(""));
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd,
		env: { ...createProductionChildEnv(), ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as boolean;
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("mirrors valid OMP_ variables to PI_ variables", () => {
		const filePath = writeTempEnv("OMP_FEATURE=enabled\nOMP_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			OMP_FEATURE: "enabled",
			PI_FEATURE: "enabled",
		});
	});

	it("matches Bun dotenv syntax for export prefixes and inline comments", () => {
		const filePath = writeTempEnv(
			[
				"export EXPORTED=value",
				"COMMENTED=secret # trailing comment",
				'QUOTED_HASH="keep # this"',
				"NO_SPACE=http://host/path#frag",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			EXPORTED: "value",
			COMMENTED: "secret",
			QUOTED_HASH: "keep # this",
			NO_SPACE: "http://host/path",
		});
	});

	it("keeps escaped quotes inside quoted values literal, matching Bun", () => {
		const filePath = writeTempEnv(['JSON="{\\"a\\":1}"', "SINGLE='it\\'s'"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			JSON: '{\\"a\\":1}',
			SINGLE: "it\\'s",
		});
	});

	it("parses quoted multiline and escaped-newline values across the whole file", () => {
		const filePath = writeTempEnv(
			['MULTILINE="first', 'second"', 'ESCAPED_NEWLINE="first\\nsecond"', "BACKTICK=`first", "second`"].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			MULTILINE: "first\nsecond",
			ESCAPED_NEWLINE: "first\nsecond",
			BACKTICK: "first\nsecond",
		});
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("drops macOS malloc stack logging toggles instead of forwarding disabled values", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});

describe("filterChildShellEnv", () => {
	// Every command environment blanks omp's natives-directory handoff (an empty one is none), so
	// it replaces the handoff the native shell's startup environment may hold.
	const NO_HANDOFF = { __PI_NATIVES_DIR_HANDOFF: "" };

	it("removes quoted multiline project values without a launch snapshot", () => {
		const cwd = path.dirname(
			writeTempEnv(['MULTILINE="first', 'second"', 'ESCAPED_NEWLINE="first\\nsecond"'].join("\n")),
		);

		expect(
			filterChildShellEnv(
				{
					MULTILINE: "first\nsecond",
					ESCAPED_NEWLINE: "first\nsecond",
					UNCHANGED: "parent-value",
				},
				cwd,
			),
		).toEqual({ UNCHANGED: "parent-value", ...NO_HANDOFF });
	});

	it("uses the supplied mode for an isolated environment and cwd", async () => {
		const cwd = path.dirname(writeTempEnv(""));
		fs.writeFileSync(
			path.join(cwd, ".env.development.local"),
			"OMP_DOTENV_REPRO_MARKER=synthetic-mode-local-value\n",
		);
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(",
			'  { OMP_DOTENV_REPRO_MARKER: "synthetic-mode-local-value", UNCHANGED: "parent-value" },',
			`  ${JSON.stringify(cwd)},`,
			");",
			"process.stdout.write(JSON.stringify(child));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			env: { ...process.env, NODE_ENV: "test", OMP_DOTENV_REPRO_MARKER: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value", ...NO_HANDOFF });
	});

	it("drops inherited git repo-location overrides", () => {
		const cwd = path.dirname(writeTempEnv(""));
		// A bash call with `cwd` in a secondary worktree must not mutate the
		// primary one: forwarding the agent's own repo-location variables makes
		// child `git` ignore the command's cwd (issue #11082).
		expect(
			filterChildShellEnv(
				{
					GIT_DIR: "/primary/.git",
					GIT_COMMON_DIR: "/primary/.git",
					GIT_WORK_TREE: "/primary",
					GIT_INDEX_FILE: "/primary/.git/index",
					GIT_OBJECT_DIRECTORY: "/primary/.git/objects",
					GIT_ALTERNATE_OBJECT_DIRECTORIES: "/primary/.git/objects",
					GIT_EDITOR: "true",
					GIT_AUTHOR_NAME: "Agent",
				},
				cwd,
			),
		).toEqual({ GIT_EDITOR: "true", GIT_AUTHOR_NAME: "Agent", ...NO_HANDOFF });
	});

	it("uses the launch mode when dotenv changes NODE_ENV", async () => {
		const cwd = path.dirname(writeTempEnv("NODE_ENV=production\n"));
		fs.writeFileSync(
			path.join(cwd, ".env.development.local"),
			"OMP_DOTENV_REPRO_MARKER=synthetic-mode-local-value\n",
		);
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(process.env, process.cwd());",
			"process.stdout.write(JSON.stringify({",
			"  processValue: process.env.OMP_DOTENV_REPRO_MARKER ?? null,",
			"  childValue: child.OMP_DOTENV_REPRO_MARKER ?? null,",
			"  nodeEnv: process.env.NODE_ENV ?? null,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: { ...process.env, NODE_ENV: undefined, OMP_DOTENV_REPRO_MARKER: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			processValue: "synthetic-mode-local-value",
			childValue: null,
			nodeEnv: "production",
		});
	});

	it.skipIf(process.platform === "win32")(
		"keeps filtering after the process working directory is deleted",
		async () => {
			const cwd = path.dirname(writeTempEnv(""));
			const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
			const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
			const script = [
				'import * as fs from "node:fs";',
				`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
				`import { getProjectDir } from ${JSON.stringify(dirsModulePath)};`,
				"getProjectDir();",
				"fs.rmSync(process.cwd(), { recursive: true });",
				'const child = filterChildShellEnv({ UNCHANGED: "parent-value" });',
				"process.stdout.write(JSON.stringify(child));",
			].join("\n");
			const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value", ...NO_HANDOFF });
		},
	);
});

describe.skipIf(process.platform !== "linux")("bunRelaunchArgs", () => {
	const envTs = path.join(import.meta.dir, "../src/env.ts");
	const NAMES = [
		"T_PLAIN",
		"T_DOLLAR",
		"T_BS_DOLLAR",
		"T_QUOTES",
		"T_DOUBLE",
		"T_NEWLINE",
		"T_BACKSLASH",
		"T_HASH",
		"T_SPACES",
		"T_EMPTY",
		"T_UNICODE",
		"T_TRAILING_BACKSLASH",
		// Names Bun's parser reads with characters a shell name lacks.
		"WITH-DASH",
		"DOT.NAME",
		"1DIGIT",
		"LAUNCH_ONLY",
	];
	// A process that reports the flags and the values Bun's own `.env` loading gave it.
	const probe = `const values = Object.fromEntries(${JSON.stringify(NAMES)}.map(name => [name, process.env[name] ?? null]));
const { bunRelaunchArgs } = await import(${JSON.stringify(envTs)});
console.log(JSON.stringify({ args: bunRelaunchArgs(), env: values }));`;

	function run(flags: string[], cwd: string): { args: string[]; env: Record<string, string | null> } {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		tempDirs.push(home);
		const env: Record<string, string | undefined> = {
			...process.env,
			...DIR_RESOLUTION_ENV_RESET,
			HOME: home,
			LAUNCH_ONLY: "from the launch environment",
			// A private stand-in for `/tmp`, the relaunch file's fallback.
			PI_TEST_RELAUNCH_FALLBACK_DIR: home,
		};
		for (const name of NAMES) if (name !== "LAUNCH_ONLY") delete env[name];
		const child = Bun.spawnSync([process.execPath, ...flags, "-e", probe], { cwd, env, stderr: "pipe" });
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return JSON.parse(child.stdout.toString());
	}

	/** Values a lossless writer must keep, as Bun's own `.env` syntax gives them. */
	function trickyDotenvDir(): string {
		return path.dirname(
			writeTempEnv(
				[
					"T_PLAIN=abc",
					// `\${HOME}` written as text: Bun must read it back, not expand it.
					"T_DOLLAR='cost \\$5, \\$" + "{HOME} and \\$HOME'",
					"T_BS_DOLLAR='a\\\\$b'",
					'T_QUOTES="it\'s `odd`"',
					"T_DOUBLE='say \"hi\"'",
					"T_NEWLINE='line1",
					"line2'",
					"T_BACKSLASH='C:\\path\\to\\n'",
					"T_HASH='a # not a comment'",
					"T_SPACES='  padded  '",
					"T_EMPTY=",
					"T_UNICODE=héllo ✓",
					"T_TRAILING_BACKSLASH=x\\",
					"WITH-DASH=dash",
					"DOT.NAME=dot",
					"1DIGIT=digit",
				].join("\n"),
			),
		);
	}

	it("gives a process started with them exactly the values Bun's own loading gave this one, in a private file", () => {
		const first = run([], trickyDotenvDir());
		expect(first.env.T_DOLLAR).toBe("cost $5, $" + "{HOME} and $HOME");
		expect(first.env.T_NEWLINE).toBe("line1\nline2");
		expect([first.env["WITH-DASH"], first.env["DOT.NAME"], first.env["1DIGIT"]]).toEqual(["dash", "dot", "digit"]);
		const [flag] = first.args;
		expect(first.args).toHaveLength(1);
		const file = flag!.slice("--env-file=".length);
		expect(flag).toBe(`--env-file=${file}`);
		expect(file).not.toContain(",");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		// Only what Bun loaded, never the environment the process was started with.
		expect(fs.readFileSync(file, "utf8")).not.toContain("LAUNCH_ONLY");
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-elsewhere-"));
		tempDirs.push(elsewhere);

		const again = run([flag!], elsewhere);
		// The second probe wrote a relaunch file of its own (the values it was given).
		for (const arg of again.args) {
			if (arg.startsWith("--env-file="))
				fs.rmSync(path.dirname(arg.slice("--env-file=".length)), { recursive: true });
		}

		// A value Bun's parser cannot read back (a trailing backslash) is left out; every other is exact.
		expect(again.env).toEqual({ ...first.env, T_TRAILING_BACKSLASH: null });
		expect(first.env.T_TRAILING_BACKSLASH).toBe("x\\");
		// The process started with the file removed it as soon as env.ts loaded.
		expect(fs.existsSync(path.dirname(file))).toBe(false);
	});

	it("is --no-env-file for a process Bun loaded nothing into", () => {
		expect(run(["--no-env-file"], trickyDotenvDir()).args).toEqual(["--no-env-file"]);
	});
});

describe.skipIf(process.platform !== "linux")("the relaunch file's removal", () => {
	const envTs = path.join(import.meta.dir, "../src/env.ts");
	const loggerTs = path.join(import.meta.dir, "../src/logger.ts");

	/** A private temporary directory, standing in for `TMPDIR` or `/tmp`. */
	function tempBase(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-relaunch-"));
		tempDirs.push(dir);
		return dir;
	}

	/** A relaunch directory in `parent`: as `bunRelaunchArgs` makes it, or, unmarked, a look-alike. */
	function relaunchDir(parent: string, name: string, marked = true): { dir: string; file: string } {
		const dir = path.join(parent, name);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "loaded.env");
		fs.writeFileSync(file, `${marked ? `# omp relaunch file: ${file}\n` : ""}LOADED='value'\n`, { mode: 0o600 });
		return { dir, file };
	}

	/**
	 * Start a process that loads `env.ts` from an empty directory, with `base` as its `TMPDIR` and a
	 * private fallback in place of `/tmp`, so it never reads or writes the host's.
	 */
	function loadEnv(base: string, flags: string[] = [], extra: Record<string, string> = {}): void {
		const env: Record<string, string | undefined> = {
			...process.env,
			TMPDIR: base,
			PI_TEST_RELAUNCH_FALLBACK_DIR: tempBase(),
			...extra,
		};
		const child = Bun.spawnSync([process.execPath, ...flags, "-e", `await import(${JSON.stringify(envTs)});`], {
			cwd: tempBase(),
			env,
			stderr: "pipe",
		});
		expect(child.stderr.toString()).toBe("");
		expect(child.exitCode).toBe(0);
	}

	it("removes the relaunch file it was started with, wherever it is, and nothing that is not omp's", () => {
		const base = tempBase();
		const plain = relaunchDir(base, "omp-bun-env-Plain1");
		// Written under another temporary directory than this process's (a fork pane's terminal).
		const elsewhere = relaunchDir(tempBase(), "omp-bun-env-Else01");
		// A user's look-alike outside every base, named in the arguments (c1) or in BUN_OPTIONS (c2).
		const c1 = relaunchDir(path.join(tempBase(), "keep"), "omp-bun-env-Keep01", false);
		const c2 = relaunchDir(path.join(tempBase(), "bo"), "omp-bun-env-Bopt01", false);
		// A copy of a relaunch file in another directory: it names a path that is not its own.
		const copied = relaunchDir(tempBase(), "omp-bun-env-Copy01", false);
		fs.writeFileSync(copied.file, fs.readFileSync(plain.file));
		// The user's own file beside it: the directory is not only the relaunch file's.
		const shared = relaunchDir(base, "omp-bun-env-Share1");
		fs.writeFileSync(path.join(shared.dir, "notes.txt"), "mine\n");
		// Not named like a relaunch directory.
		const misnamed = relaunchDir(base, "omp-bun-env-x");
		// A link named like one is not followed.
		const target = relaunchDir(tempBase(), "omp-bun-env-Tgt001");
		const link = path.join(base, "omp-bun-env-Lnk001");
		fs.symlinkSync(target.dir, link);

		for (const file of [plain.file, elsewhere.file, c1.file, copied.file, shared.file, misnamed.file]) {
			loadEnv(base, [`--env-file=${file}`]);
		}
		loadEnv(base, [`--env-file=${path.join(link, "loaded.env")}`]);
		loadEnv(base, ["--no-env-file"], { BUN_OPTIONS: `--env-file=${c2.file}` });

		expect(fs.existsSync(plain.dir)).toBe(false);
		expect(fs.existsSync(elsewhere.dir)).toBe(false);
		expect(fs.existsSync(c1.file)).toBe(true);
		expect(fs.existsSync(c2.file)).toBe(true);
		expect(fs.existsSync(copied.file)).toBe(true);
		expect(fs.readdirSync(shared.dir).sort()).toEqual(["loaded.env", "notes.txt"]);
		expect(fs.existsSync(misnamed.file)).toBe(true);
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(target.file)).toBe(true);
	});

	it("removes, as a session starts, this user's relaunch directories left for more than ten minutes", () => {
		const base = tempBase();
		const hourAgo = new Date(Date.now() - 60 * 60_000);
		const old = relaunchDir(base, "omp-bun-env-Old123");
		fs.utimesSync(old.dir, hourAgo, hourAgo);
		const fresh = relaunchDir(base, "omp-bun-env-New123");
		// A look-alike that does not name itself stays, however old it is.
		const lookAlike = relaunchDir(base, "omp-bun-env-Lka123", false);
		fs.utimesSync(lookAlike.dir, hourAgo, hourAgo);
		// One that also holds another file stays whole, however old it is.
		const shared = relaunchDir(base, "omp-bun-env-Oth001");
		fs.writeFileSync(path.join(shared.dir, "notes.txt"), "mine\n");
		fs.utimesSync(shared.dir, hourAgo, hourAgo);
		// A link of that name is not followed, however old it is.
		const target = relaunchDir(tempBase(), "omp-bun-env-Tgt123");
		const link = path.join(base, "omp-bun-env-Lnk123");
		fs.symlinkSync(target.dir, link);
		fs.lutimesSync(link, hourAgo, hourAgo);
		// A worker (started with `--no-env-file`) leaves them to its session.
		const forWorker = relaunchDir(tempBase(), "omp-bun-env-Wrk123");
		fs.utimesSync(forWorker.dir, hourAgo, hourAgo);
		loadEnv(path.dirname(forWorker.dir), ["--no-env-file"]);
		expect(fs.existsSync(forWorker.file)).toBe(true);

		loadEnv(base);

		expect(fs.existsSync(old.dir)).toBe(false);
		expect(fs.existsSync(fresh.file)).toBe(true);
		expect(fs.existsSync(lookAlike.file)).toBe(true);
		expect(fs.readdirSync(shared.dir).sort()).toEqual(["loaded.env", "notes.txt"]);
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(target.file)).toBe(true);
	});

	/**
	 * Start a process with `file` as its own `--env-file`, after which `swap` (JS source, run
	 * before `env.ts` loads, so after Bun read the file) replaces it; bounded, as a hang there
	 * would hang every omp start. Then a later session start sweeps `base` with the entry aged.
	 */
	function loadEnvAfterSwap(base: string, file: string, swap: string): { own: number | null; sweep: number | null } {
		const bound = { timeout: 15_000, killSignal: "SIGKILL" as const };
		const env = { ...process.env, TMPDIR: base, PI_TEST_RELAUNCH_FALLBACK_DIR: tempBase() };
		const script = `const fs = require("node:fs");\nconst FILE = ${JSON.stringify(file)};\n${swap}\nawait import(${JSON.stringify(envTs)});`;
		const own = Bun.spawnSync([process.execPath, `--env-file=${file}`, "-e", script], {
			cwd: tempBase(),
			env,
			stderr: "pipe",
			...bound,
		});
		expect(own.stderr.toString()).toBe("");
		const hourAgo = new Date(Date.now() - 60 * 60_000);
		fs.utimesSync(path.dirname(file), hourAgo, hourAgo);
		const sweep = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(envTs)});`], {
			cwd: tempBase(),
			env,
			stderr: "pipe",
			...bound,
		});
		expect(sweep.stderr.toString()).toBe("");
		return { own: own.exitCode, sweep: sweep.exitCode };
	}

	it.each([["a FIFO"], ["a link to a FIFO"], ["a link to a regular file that names the link's path"]])(
		"returns at once and keeps a loaded.env that is %s, in the own-file removal and the sweep",
		label => {
			const base = tempBase();
			const planted = relaunchDir(base, "omp-bun-env-Swap01");
			// Anything a link points at sits outside the directory, which keeps `loaded.env` alone.
			const target = path.join(tempBase(), "target");
			let source = `fs.rmSync(FILE);\nBun.spawnSync(["mkfifo", FILE]);`;
			if (label === "a link to a FIFO") {
				source = `fs.rmSync(FILE);\nBun.spawnSync(["mkfifo", ${JSON.stringify(target)}]);\nfs.symlinkSync(${JSON.stringify(target)}, FILE);`;
			} else if (label !== "a FIFO") {
				// The worst case: the target's first line is the marker for the link's own path.
				fs.writeFileSync(target, fs.readFileSync(planted.file));
				source = `fs.rmSync(FILE);\nfs.symlinkSync(${JSON.stringify(target)}, FILE);`;
			}

			expect(loadEnvAfterSwap(base, planted.file, source)).toEqual({ own: 0, sweep: 0 });

			expect(fs.readdirSync(planted.dir)).toEqual(["loaded.env"]);
			const kept = fs.lstatSync(planted.file);
			expect(label === "a FIFO" ? kept.isFIFO() : kept.isSymbolicLink()).toBe(true);
			if (label.startsWith("a link to a regular file")) expect(fs.existsSync(target)).toBe(true);
		},
		60_000,
	);

	it.each([["a FIFO"], ["a link to a regular file that names the link's path"], ["a socket"]])(
		"returns at once and keeps a loaded.env that turns into %s between its lstat and its open",
		label => {
			const regularFileJs = path.join(import.meta.dir, "../../natives/native/regular-file.js");
			const base = tempBase();
			const planted = relaunchDir(base, "omp-bun-env-Race01");
			const staged = path.join(tempBase(), "staged");
			let prepare = "";
			if (label === "a FIFO") {
				expect(Bun.spawnSync(["mkfifo", staged]).exitCode).toBe(0);
			} else if (label.startsWith("a link")) {
				// The worst case: the target's first line is the marker for the link's own path.
				const target = path.join(tempBase(), "target");
				fs.writeFileSync(target, fs.readFileSync(planted.file));
				fs.symlinkSync(target, staged);
			} else {
				prepare = `const server = (await import("node:net")).createServer();\nawait new Promise(resolve => server.listen(${JSON.stringify(staged)}, resolve));`;
			}
			// Bun reads the regular file at the start; the seam swaps it between the reader's lstat
			// and its open, as env.ts loads and removes the file it was started with.
			const script = `const nodeFs = await import("node:fs");
${prepare}
const { __setRegularFileIoForTests } = await import(${JSON.stringify(regularFileJs)});
let swapped = false;
__setRegularFileIoForTests({
	openSync(file, flags, mode) {
		if (!swapped && file === ${JSON.stringify(planted.file)}) {
			swapped = true;
			nodeFs.renameSync(${JSON.stringify(staged)}, file);
		}
		return nodeFs.openSync(file, flags, mode);
	},
});
await import(${JSON.stringify(envTs)});
console.log(JSON.stringify({ swapped }));
process.exit(0);`;
			const child = Bun.spawnSync([process.execPath, `--env-file=${planted.file}`, "-e", script], {
				cwd: tempBase(),
				env: { ...process.env, TMPDIR: base, PI_TEST_RELAUNCH_FALLBACK_DIR: tempBase() },
				stderr: "pipe",
				timeout: 15_000,
				killSignal: "SIGKILL",
			});

			expect({ timedOut: child.exitedDueToTimeout ?? false, stderr: child.stderr.toString() }).toEqual({
				timedOut: false,
				stderr: "",
			});
			expect(JSON.parse(child.stdout.toString())).toEqual({ swapped: true });
			expect(fs.readdirSync(planted.dir)).toEqual(["loaded.env"]);
			expect(fs.lstatSync(planted.file).isFile()).toBe(false);
		},
		60_000,
	);

	it("keeps a loaded.env whose marker is on a later line, not the first, where the writer puts it", () => {
		const base = tempBase();
		const later = relaunchDir(base, "omp-bun-env-Later1", false);
		fs.writeFileSync(later.file, `LOADED='value'\n# omp relaunch file: ${later.file}\n`, { mode: 0o600 });

		loadEnv(base, [`--env-file=${later.file}`]);

		expect(fs.existsSync(later.file)).toBe(true);
	});

	it("sweeps on a session's main thread only, never in a worker thread", () => {
		const base = tempBase();
		const hourAgo = new Date(Date.now() - 60 * 60_000);
		const old = relaunchDir(base, "omp-bun-env-Thr123");
		fs.utimesSync(old.dir, hourAgo, hourAgo);
		const worker = path.join(tempBase(), "worker.ts");
		fs.writeFileSync(worker, `await import(${JSON.stringify(envTs)});\npostMessage("loaded");\n`);
		// A worker thread loads env.ts first; then the main thread does.
		const script = `const fs = await import("node:fs");
await new Promise(resolve => { const w = new Worker(${JSON.stringify(worker)}); w.onmessage = () => { w.terminate(); resolve(); }; });
const afterWorker = fs.existsSync(${JSON.stringify(old.dir)});
await import(${JSON.stringify(envTs)});
console.log(JSON.stringify({ afterWorker, afterMain: fs.existsSync(${JSON.stringify(old.dir)}) }));`;
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: tempBase(),
			env: { ...process.env, TMPDIR: base, PI_TEST_RELAUNCH_FALLBACK_DIR: tempBase() },
			stderr: "pipe",
		});
		expect(child.stderr.toString()).toBe("");

		expect(JSON.parse(child.stdout.toString())).toEqual({ afterWorker: true, afterMain: false });
	});

	/**
	 * A session that Bun gave one value from its start directory's `.env`, whose launch environment
	 * is `launch` (over the test's, with no TMPDIR and no test-runtime marker, so omp applies
	 * `~/.env`): it writes the relaunch file (`bunRelaunchArgs`) and starts nothing.
	 */
	function writeRelaunchFile(launch: Record<string, string | undefined>): {
		args: string[];
		warnings: { message: string; reasons: string[] }[];
	} {
		const start = tempBase();
		fs.writeFileSync(path.join(start, ".env"), "RELAUNCH_PROBE=loaded\n");
		const script = `const logger = await import(${JSON.stringify(loggerTs)});
const warnings = [];
logger.registerLogSink(event => { if (event.level === "warn") warnings.push({ message: event.message, reasons: event.context?.reasons ?? [] }); });
const { bunRelaunchArgs } = await import(${JSON.stringify(envTs)});
console.log(JSON.stringify({ args: bunRelaunchArgs(), warnings }));`;
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: start,
			env: launchEnv(launch),
			stderr: "pipe",
		});
		expect(child.stderr.toString()).toBe("");
		return JSON.parse(child.stdout.toString());
	}

	function launchEnv(launch: Record<string, string | undefined>): Record<string, string> {
		const env: Record<string, string | undefined> = { ...process.env, ...DIR_RESOLUTION_ENV_RESET, ...launch };
		for (const name of ["TMPDIR", "PI_TEST_RUNTIME", "NODE_ENV", "BUN_ENV"]) if (!(name in launch)) delete env[name];
		return Object.fromEntries(
			Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}

	it("lets a later session sweep the file a dead relaunch left, though `~/.env` set TMPDIR after the launch", () => {
		// TMPDIR unset at the launch and set by `~/.env`: the file goes to the fallback, a private
		// stand-in for `/tmp`, where a later session with the same launch environment looks.
		const home = tempBase();
		const dotenvTmp = tempBase();
		const fallback = tempBase();
		fs.writeFileSync(path.join(home, ".env"), `TMPDIR=${dotenvTmp}\n`);
		const launch = { HOME: home, PI_TEST_RELAUNCH_FALLBACK_DIR: fallback };
		const { args } = writeRelaunchFile(launch);
		const file = args[0]!.slice("--env-file=".length);
		expect(path.dirname(path.dirname(file))).toBe(fallback);
		// Nothing relaunched: the new image died before env.ts loaded. Ten minutes pass.
		const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
		fs.utimesSync(path.dirname(file), elevenMinutesAgo, elevenMinutesAgo);

		const later = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(envTs)});`], {
			cwd: tempBase(),
			env: launchEnv(launch),
			stderr: "pipe",
		});
		expect(later.stderr.toString()).toBe("");

		expect(fs.existsSync(path.dirname(file))).toBe(false);
		expect(fs.readdirSync(dotenvTmp)).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)(
		"writes under the fallback when TMPDIR cannot be written, without a warning",
		() => {
			const readOnly = tempBase();
			const fallback = tempBase();
			fs.chmodSync(readOnly, 0o500);
			try {
				const { args, warnings } = writeRelaunchFile({ TMPDIR: readOnly, PI_TEST_RELAUNCH_FALLBACK_DIR: fallback });
				const file = args[0]!.slice("--env-file=".length);

				expect(path.dirname(path.dirname(file))).toBe(fallback);
				expect(fs.statSync(file).mode & 0o777).toBe(0o600);
				expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
				expect(warnings).toEqual([]);
				fs.rmSync(path.dirname(file), { recursive: true });
			} finally {
				fs.chmodSync(readOnly, 0o700);
			}
		},
	);

	it("removes the directory of a relaunch file it made but could not write, and falls back", () => {
		// A TMPDIR whose path holds a newline: `mkdtemp` makes the directory there, but the file
		// cannot name its own path on one line, so the write is given up after the directory exists.
		const newlineBase = path.join(tempBase(), "a\nb");
		fs.mkdirSync(newlineBase);
		const fallback = tempBase();
		const { args, warnings } = writeRelaunchFile({ TMPDIR: newlineBase, PI_TEST_RELAUNCH_FALLBACK_DIR: fallback });
		const file = args[0]!.slice("--env-file=".length);

		expect(path.dirname(path.dirname(file))).toBe(fallback);
		expect(fs.readdirSync(newlineBase)).toEqual([]);
		expect(warnings).toEqual([]);
		fs.rmSync(path.dirname(file), { recursive: true });
	});

	it.skipIf(process.getuid?.() === 0)(
		"passes --no-env-file, with a warning naming each reason, when neither can be written",
		() => {
			const readOnly = tempBase();
			const readOnlyFallback = tempBase();
			fs.chmodSync(readOnly, 0o500);
			fs.chmodSync(readOnlyFallback, 0o500);
			try {
				const { args, warnings } = writeRelaunchFile({
					TMPDIR: readOnly,
					PI_TEST_RELAUNCH_FALLBACK_DIR: readOnlyFallback,
				});

				expect(args).toEqual(["--no-env-file"]);
				expect(warnings).toEqual([
					{
						message:
							"The relaunch starts without the values Bun loaded from .env files: no relaunch file could be written",
						reasons: [`${readOnly}: EACCES`, `${readOnlyFallback}: EACCES`],
					},
				]);
			} finally {
				fs.chmodSync(readOnly, 0o700);
				fs.chmodSync(readOnlyFallback, 0o700);
			}
		},
	);
});

describe.skipIf(process.platform !== "linux")("bunOptionsWithoutEnvFiles", () => {
	const envTs = path.join(import.meta.dir, "../src/env.ts");

	/** The arguments Bun takes from `BUN_OPTIONS` (`undefined`: unset) in a process it starts. */
	function bunOptionsArgs(value: string | undefined, script = "console.log(JSON.stringify(process.execArgv))") {
		const env: Record<string, string | undefined> = { ...process.env, BUN_OPTIONS: value };
		if (value === undefined) delete env.BUN_OPTIONS;
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-bun-options-"));
		tempDirs.push(cwd);
		const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd, env, stderr: "pipe" });
		expect(child.stderr.toString()).toBe("");
		return child.stdout.toString();
	}

	it.each([
		['--smol --env-file="a b.env"', ["--smol"]],
		["--env-file='a b.env' --smol", ["--smol"]],
		["--env-file a.env --smol", ["--smol"]],
		["--smol\t--env-file=b.env", ["--smol"]],
		["--env-file=a.env,b.env", []],
		["--env-file=a.env --smol --env-file=b.env", ["--smol"]],
		['"--env-file=b.env" --smol', ["--smol"]],
		["--conditions='x y' --env-file=\"a b.env\" --smol", ["--conditions='x y'", "--smol"]],
	] as const)("splits %j as Bun does, and keeps every argument but the env-file ones", (value, kept) => {
		const result = JSON.parse(
			bunOptionsArgs(
				value,
				`const { bunOptionsWithoutEnvFiles } = await import(${JSON.stringify(envTs)}); console.log(JSON.stringify(bunOptionsWithoutEnvFiles() ?? null));`,
			),
		) as string | null;
		expect(result).not.toBeNull();

		// Bun's own arguments from the new value, before the ones on the command line.
		const execArgv = JSON.parse(bunOptionsArgs(result === "" ? undefined : (result ?? undefined))) as string[];
		expect(execArgv.slice(0, execArgv.indexOf("--no-env-file"))).toEqual([...kept]);
	});

	/** Bun's own arguments from `BUN_OPTIONS` (`undefined`: unset), before the command line's. */
	function bunArgs(value: string | undefined): string[] {
		const execArgv = JSON.parse(bunOptionsArgs(value)) as string[];
		return execArgv.slice(0, execArgv.lastIndexOf("--no-env-file"));
	}

	/** `args` without the env-file ones: an `--env-file…` argument, and a bare one's file. */
	function withoutEnvFiles(args: string[]): string[] {
		const kept: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const name = args[i]!.split(/[=\t\n\f\r ]/, 1)[0];
			if (name !== "--env-file") kept.push(args[i]!);
			else if (args[i] === "--env-file") i++;
		}
		return kept;
	}

	it.each([
		// A dropped `--env-file` between a bare flag and a quoted argument: the two must not join.
		`--smol --env-file=.e "--conditions=a b"`,
		`--smol --env-file .e "--conditions=a b"`,
		`--smol --env-file=.e '--conditions=x'`,
		`--smol --env-file=.e "--conditions=a" --conditions=b`,
		`--smol --env-file="x y" '--define=K:1'`,
		// Other shapes.
		`--smol --env-file=.e --conditions='a b'`,
		`--conditions='x y' --env-file="a b.env" --smol`,
		`'--env-file=.e' --smol`,
		`--env-file=".e"--smol`,
		`--title="a=b" --env-file=.e --smol`,
		`--smol --env-file "x"`,
		`--env-file= --smol`,
		`--smol\t--env-file=.e\n--conditions="a\tb"`,
		`--smol --env-file=.e --conditions="a b`,
		`--smol \\--env-file .e`,
		`--smol --env-file \\-x`,
		`--define K:"v w" --env-file=.e`,
		`--smol\v--env-file=.e`,
	])("gives a second Bun process exactly the first one's arguments but the env-file ones: %j", value => {
		const first = bunArgs(value);
		const result = JSON.parse(
			bunOptionsArgs(
				value,
				`const { bunOptionsWithoutEnvFiles } = await import(${JSON.stringify(envTs)}); console.log(JSON.stringify(bunOptionsWithoutEnvFiles() ?? null));`,
			),
		) as string | null;
		const kept = withoutEnvFiles(first);

		if (value.endsWith("\\-x")) {
			// A bare `--env-file` before an option: not certain, so all of `BUN_OPTIONS` is unset,
			// and with it `--smol`.
			expect({ result, kept }).toEqual({ result: "", kept: ["--smol"] });
			return;
		}
		expect(bunArgs(result === null ? value : result === "" ? undefined : result)).toEqual(kept);
	});
});

describe("startupEnv", () => {
	it("is taken once per process, so a second evaluation of its module (a --hot reload) keeps it", () => {
		const startupEnvTs = path.join(import.meta.dir, "../src/startup-env.ts");
		const script = `const first = await import(${JSON.stringify(startupEnvTs)});
process.env.STARTUP_ENV_LATE_PROBE = "late";
const second = await import(${JSON.stringify(`${startupEnvTs}?again`)});
console.log(JSON.stringify({ twoModules: first !== second, same: first.startupEnv === second.startupEnv, late: second.startupEnv.STARTUP_ENV_LATE_PROBE ?? null }));`;
		const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { stderr: "pipe" });
		expect(child.stderr.toString()).toBe("");

		expect(JSON.parse(child.stdout.toString())).toEqual({ twoModules: true, same: true, late: null });
	});
});

describe("stripGitRepoLocationEnv", () => {
	it("matches case-insensitively on win32 and exactly on POSIX", () => {
		// Windows env lookups are case-insensitive, so a `git_dir` block binds
		// there; POSIX names are case-sensitive and must not be over-stripped.
		const win32Env: Record<string, string> = { GIT_DIR: "a", git_dir: "b", GIT_WORK_TREE: "c", KEEP: "d" };
		stripGitRepoLocationEnv(win32Env, "win32");
		expect(win32Env).toEqual({ KEEP: "d" });

		const posixEnv: Record<string, string> = { GIT_DIR: "a", git_dir: "b", KEEP: "d" };
		stripGitRepoLocationEnv(posixEnv, "linux");
		expect(posixEnv).toEqual({ git_dir: "b", KEEP: "d" });
	});
});

describe("isBunTestRuntime", () => {
	it("does not treat shared application env names as a test runner signal", async () => {
		expect(await runRuntimeProbe({ NODE_ENV: "test", BUN_ENV: undefined, PI_TEST_RUNTIME: undefined })).toBe(false);
		expect(await runRuntimeProbe({ NODE_ENV: undefined, BUN_ENV: "test", PI_TEST_RUNTIME: undefined })).toBe(false);
	});

	it("honors the private test runner signal", async () => {
		expect(await runRuntimeProbe({ NODE_ENV: undefined, BUN_ENV: undefined, PI_TEST_RUNTIME: "1" })).toBe(true);
	});

	it("recognizes Bun's underscore test entrypoints", async () => {
		const dir = path.dirname(writeTempEnv(""));
		const underscoreProbePath = path.join(dir, "runtime_test.ts");
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		fs.writeFileSync(
			underscoreProbePath,
			`import { isBunTestRuntime } from ${JSON.stringify(envModulePath)};\nprocess.stdout.write(JSON.stringify(isBunTestRuntime()));\n`,
		);
		expect(
			await runRuntimeProbe(
				{ NODE_ENV: "test", BUN_ENV: undefined, PI_TEST_RUNTIME: undefined },
				underscoreProbePath,
			),
		).toBe(true);
	});
});

/**
 * Faithful model of Windows `process.env`: case-insensitive reads, but
 * enumeration (`ownKeys`) preserves the real key casing — exactly Node
 * (`uv_os_getenv` + `uv_os_environ`) and Bun (`CaseInsensitiveASCIIStringArrayHashMap`).
 */
function windowsLikeEnv(backing: Record<string, string>): Record<string, string | undefined> {
	return new Proxy(backing, {
		get(target, prop) {
			if (typeof prop !== "string") return Reflect.get(target, prop);
			for (const key in target) {
				if (key.toLowerCase() === prop.toLowerCase()) return target[key];
			}
			return undefined;
		},
		has(target, prop) {
			if (typeof prop !== "string") return Reflect.has(target, prop);
			for (const key in target) {
				if (key.toLowerCase() === prop.toLowerCase()) return true;
			}
			return false;
		},
	}) as Record<string, string | undefined>;
}

describe("$envExact", () => {
	it("does not hijack a literal via a case-differing Windows system var", () => {
		// Windows ships PUBLIC=C:\Users\Public and reads are case-insensitive, so
		// a bare `env["public"]` returns it — the /login #7361 401 root cause.
		const env = windowsLikeEnv({ PUBLIC: "C:\\Users\\Public" });
		expect(env.public).toBe("C:\\Users\\Public");
		expect($envExact("public", env)).toBeUndefined();
	});

	it("still resolves a genuine exact-case reference on a case-insensitive env", () => {
		const env = windowsLikeEnv({ MY_KEY: "secret" });
		expect($envExact("MY_KEY", env)).toBe("secret");
		expect($envExact("my_key", env)).toBeUndefined();
	});

	it("reads process.env by default", () => {
		const name = `PI_ENVEXACT_TEST_${Date.now()}`;
		process.env[name] = "value";
		try {
			expect($envExact(name)).toBe("value");
		} finally {
			delete process.env[name];
		}
		expect($envExact(name)).toBeUndefined();
	});
});

describe("OTEL_* from omp's own .env files", () => {
	interface ProbeResult {
		bunEnv: Record<string, string | null>;
		otelEnv: Record<string, string | null>;
		insideWindow: Record<string, string | null>;
		afterWindow: Record<string, string | null>;
		bashChildEnv: Record<string, string>;
	}

	// The dotenv loader runs at module load, so each case needs a fresh process
	// whose agent dir and HOME are temp dirs. It runs as production (no
	// PI_TEST_RUNTIME): a test process never reads the home or config-root .env.
	async function runProbe(shellEnv: Record<string, string>): Promise<ProbeResult> {
		const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-utils-otel-home-"));
		const agentDir = path.join(home, "agent");
		const cwd = path.join(home, "project");
		tempDirs.push(home);
		await Bun.write(
			path.join(agentDir, ".env"),
			[
				"OTEL_PROBE_AGENT=agent",
				"OTEL_PROBE_SHELL=agent-file",
				"OTEL_PROBE_BOTH=agent",
				"PLAIN_PROBE_AGENT=plain",
			].join("\n"),
		);
		await Bun.write(
			path.join(home, ".env"),
			["OTEL_PROBE_HOME=home", "OTEL_PROBE_AGENT=home-loses", "OTEL_PROBE_CONFIG=home-loses"].join("\n"),
		);
		await Bun.write(path.join(home, ".omp", ".env"), ["OTEL_PROBE_CONFIG=config-root"].join("\n"));
		await Bun.write(path.join(cwd, ".env"), ["OTEL_PROBE_PROJECT=project", "OTEL_PROBE_BOTH=project"].join("\n"));
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const names = [
			"OTEL_PROBE_AGENT",
			"OTEL_PROBE_HOME",
			"OTEL_PROBE_SHELL",
			"OTEL_PROBE_BOTH",
			"OTEL_PROBE_PROJECT",
			"OTEL_PROBE_CONFIG",
			"PLAIN_PROBE_AGENT",
		];
		const script = [
			`import { $otelEnv, withOmpOtelEnv } from ${JSON.stringify(envModulePath)};`,
			`const names = ${JSON.stringify(names)};`,
			"const pick = read => Object.fromEntries(names.map(name => [name, read(name) ?? null]));",
			"const insideWindow = withOmpOtelEnv(() => pick(name => process.env[name]));",
			"const bash = Bun.spawn(['bash', '-c', 'env'], { env: process.env, stdout: 'pipe' });",
			"const bashText = await new Response(bash.stdout).text();",
			"const bashChildEnv = Object.fromEntries(bashText.split('\\n').filter(line => line.startsWith('OTEL_PROBE_') || line.startsWith('PLAIN_PROBE_')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));",
			"process.stdout.write(JSON.stringify({",
			"  bunEnv: pick(name => Bun.env[name]),",
			"  otelEnv: pick(name => $otelEnv(name)),",
			"  insideWindow,",
			"  afterWindow: pick(name => process.env[name]),",
			"  bashChildEnv,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--eval", script], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				...DIR_RESOLUTION_ENV_RESET,
				PI_TEST_RUNTIME: undefined,
				OTEL_PROBE_CONFIG: undefined,
				OTEL_PROBE_AGENT: undefined,
				OTEL_PROBE_HOME: undefined,
				OTEL_PROBE_SHELL: undefined,
				OTEL_PROBE_BOTH: undefined,
				OTEL_PROBE_PROJECT: undefined,
				PLAIN_PROBE_AGENT: undefined,
				...shellEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout);
	}

	it.skipIf(process.platform === "win32")(
		"keeps agent/home .env OTEL_* out of Bun.env and any child, but readable through $otelEnv",
		async () => {
			const result = await runProbe({});
			// Neither the agent nor the home file reaches the process environment;
			// the project .env keeps its existing behavior (loaded into Bun.env), and
			// non-OTEL names from the agent file are untouched.
			expect(result.bunEnv).toEqual({
				OTEL_PROBE_AGENT: null,
				OTEL_PROBE_HOME: null,
				OTEL_PROBE_SHELL: null,
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				OTEL_PROBE_CONFIG: null,
				PLAIN_PROBE_AGENT: "plain",
			});
			// agent beats home; config root beats home; project beats agent.
			expect(result.otelEnv).toEqual({
				OTEL_PROBE_AGENT: "agent",
				OTEL_PROBE_HOME: "home",
				OTEL_PROBE_SHELL: "agent-file",
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				OTEL_PROBE_CONFIG: "config-root",
				PLAIN_PROBE_AGENT: "plain",
			});
			// The SDK-facing window exposes the file values, then removes them.
			expect(result.insideWindow).toMatchObject({
				OTEL_PROBE_AGENT: "agent",
				OTEL_PROBE_HOME: "home",
				OTEL_PROBE_SHELL: "agent-file",
				OTEL_PROBE_BOTH: "project",
			});
			expect(result.afterWindow).toEqual(result.bunEnv);
			// A bash child handed the live environment sees none of the file-owned values.
			expect(result.bashChildEnv).toEqual({
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				PLAIN_PROBE_AGENT: "plain",
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"lets a shell-exported OTEL_* win in Bun.env and $otelEnv",
		async () => {
			const result = await runProbe({ OTEL_PROBE_SHELL: "from-shell" });
			expect(result.bunEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.otelEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.insideWindow.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.afterWindow.OTEL_PROBE_SHELL).toBe("from-shell");
			// Still visible to children, as any exported variable is.
			expect(result.bashChildEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			// The agent-file-only names stay private.
			expect(result.bashChildEnv.OTEL_PROBE_AGENT).toBeUndefined();
		},
		20_000,
	);

	describe("claimOmpOtelEnvFileEntry", () => {
		it("claims only OTEL_* names and applies the live value first", () => {
			expect(claimOmpOtelEnvFileEntry("PLAIN_CLAIM_PROBE", "x", "linux")).toBe(false);
			expect(claimOmpOtelEnvFileEntry("otel_lower_claim_probe", "x", "linux")).toBe(false);
			expect($otelEnv("PLAIN_CLAIM_PROBE")).toBeUndefined();

			process.env.OTEL_CLAIM_LIVE_PROBE = "live";
			try {
				expect(claimOmpOtelEnvFileEntry("OTEL_CLAIM_LIVE_PROBE", "file", "linux")).toBe(true);
				expect($otelEnv("OTEL_CLAIM_LIVE_PROBE")).toBe("live");
			} finally {
				delete process.env.OTEL_CLAIM_LIVE_PROBE;
			}
			// The file value was dropped, not deferred.
			expect($otelEnv("OTEL_CLAIM_LIVE_PROBE")).toBeUndefined();
		});

		it("keeps the first non-empty value across files", () => {
			claimOmpOtelEnvFileEntry("OTEL_CLAIM_ORDER_PROBE", "first", "linux");
			claimOmpOtelEnvFileEntry("OTEL_CLAIM_ORDER_PROBE", "second", "linux");
			expect($otelEnv("OTEL_CLAIM_ORDER_PROBE")).toBe("first");
		});

		it("folds a lowercase name to its upper-case form on win32 only", () => {
			expect(claimOmpOtelEnvFileEntry("otel_claim_win_probe", "win", "win32")).toBe(true);
			expect(Bun.env.otel_claim_win_probe).toBeUndefined();
			expect(Bun.env.OTEL_CLAIM_WIN_PROBE).toBeUndefined();
			withOmpOtelEnv(() => {
				expect(process.env.OTEL_CLAIM_WIN_PROBE).toBe("win");
			});
			expect(process.env.OTEL_CLAIM_WIN_PROBE).toBeUndefined();
		});
	});

	describe("withOmpOtelEnv", () => {
		it("exposes file values only inside the callback and returns its result", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_A", "a", "linux");
			expect(process.env.OTEL_WINDOW_PROBE_A).toBeUndefined();
			const result = withOmpOtelEnv(() => {
				expect(process.env.OTEL_WINDOW_PROBE_A).toBe("a");
				return 42;
			});
			expect(result).toBe(42);
			expect(process.env.OTEL_WINDOW_PROBE_A).toBeUndefined();
		});

		it("removes the values when the callback throws", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_THROW", "t", "linux");
			expect(() =>
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_THROW).toBe("t");
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(process.env.OTEL_WINDOW_PROBE_THROW).toBeUndefined();
		});

		it("restores a name that was set to the empty string instead of deleting it", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_EMPTY", "file", "linux");
			process.env.OTEL_WINDOW_PROBE_EMPTY = "";
			try {
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_EMPTY).toBe("file");
				});
				expect(process.env.OTEL_WINDOW_PROBE_EMPTY).toBe("");
			} finally {
				delete process.env.OTEL_WINDOW_PROBE_EMPTY;
			}
		});

		it("never overwrites or deletes a name that is already set", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_SET", "file", "linux");
			process.env.OTEL_WINDOW_PROBE_SET = "live";
			try {
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_SET).toBe("live");
				});
				expect(process.env.OTEL_WINDOW_PROBE_SET).toBe("live");
			} finally {
				delete process.env.OTEL_WINDOW_PROBE_SET;
			}
		});
	});
});
