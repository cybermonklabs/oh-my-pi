import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createTestPath,
	isMachineEnvName,
	type PathProbe,
	planTestPath,
	TEST_ENV_NAMES,
	windowsLauncher,
} from "./test-env";

const REPO_ROOT = path.join(import.meta.dir, "..");
const ENV_MODULE = path.join(REPO_ROOT, "packages", "utils", "src", "env.ts");
const PRELOAD = path.join(import.meta.dir, "test-preload.ts");

/** A Bun process that runs `script` as `bun test` runs a test file: the repository's preload first. */
function preloadedEval(script: string): string[] {
	return [process.execPath, "--no-install", "--no-env-file", "--preload", PRELOAD, "--eval", script];
}

/** Runs `argv`, expects it to exit 0 with nothing on stderr, and parses what it printed as JSON. */
async function probe<T>(
	argv: string[],
	options: { cwd?: string; env: Record<string, string | undefined> },
): Promise<T> {
	const child = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		return JSON.parse(stdout) as T;
	} finally {
		child.kill();
		await child.exited;
	}
}

/** What each name reads in a fresh process that loads `@oh-my-pi/pi-utils/env`, `null` when unset. */
interface DotenvProbe {
	processEnv: Record<string, string | null>;
	env: Record<string, string | null>;
	otelEnv: string | null;
}

/**
 * Starts a process whose home holds the dotenv files a developer's machine has: `~/.env` and the
 * config root's `~/.omp/.env`, naming an auth broker, its token and a provider key. `marker` is
 * its `PI_TEST_RUNTIME`: "1" as the preload gives every child, or undefined for a production child.
 */
async function probeHomeDotenv(marker: "1" | undefined): Promise<DotenvProbe> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-dotenv-"));
	try {
		const project = path.join(home, "project");
		const agentDir = path.join(home, ".omp", "agent");
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		// Made-up values, marked `not-a-secret` as the public leak check reads placeholders.
		fs.writeFileSync(
			path.join(home, ".env"),
			"OMP_AUTH_BROKER_URL=http://127.0.0.1:9\nANTHROPIC_API_KEY=home-key-not-a-secret\n",
		);
		fs.writeFileSync(
			path.join(home, ".omp", ".env"),
			"OMP_AUTH_BROKER_TOKEN=config-root-token-not-a-secret\nOTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9/otel\n",
		);
		// The child's own files, which load either way: they show the probe ran the loader.
		fs.writeFileSync(path.join(agentDir, ".env"), "HOME_DOTENV_PROBE_AGENT=agent\n");
		fs.writeFileSync(path.join(project, ".env"), "HOME_DOTENV_PROBE_PROJECT=project\n");
		const names = [
			"OMP_AUTH_BROKER_URL",
			"PI_AUTH_BROKER_URL",
			"OMP_AUTH_BROKER_TOKEN",
			"PI_AUTH_BROKER_TOKEN",
			"ANTHROPIC_API_KEY",
			"HOME_DOTENV_PROBE_AGENT",
			"HOME_DOTENV_PROBE_PROJECT",
		];
		const script = [
			`import { $env, $otelEnv } from ${JSON.stringify(ENV_MODULE)};`,
			`const names = ${JSON.stringify(names)};`,
			"const pick = read => Object.fromEntries(names.map(name => [name, read(name) ?? null]));",
			"process.stdout.write(JSON.stringify({",
			"  processEnv: pick(name => process.env[name]),",
			"  env: pick(name => $env[name]),",
			'  otelEnv: $otelEnv("OTEL_EXPORTER_OTLP_ENDPOINT") ?? null,',
			"}));",
		].join("\n");
		return await probe<DotenvProbe>([process.execPath, "--no-install", "--no-env-file", "--eval", script], {
			cwd: project,
			env: {
				...process.env,
				HOME: home,
				// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				// The config root is this home's `.omp`, not the test's own.
				OMP_CONFIG_ROOT: undefined,
				OMP_DOWNLOAD_ROOT: undefined,
				PI_CONFIG_DIR: undefined,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
				OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
				...Object.fromEntries(names.map(name => [name, undefined])),
				PI_TEST_RUNTIME: marker,
			},
		});
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** Every path under `dir`, relative to it and sorted; empty when `dir` does not exist. */
function listTree(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return (fs.readdirSync(dir, { recursive: true }) as string[]).map(entry => entry.split(path.sep).join("/")).sort();
}

/** Where a test child that starts with the preload puts omp's directories, and what it wrote. */
interface OmpDirsProbe {
	configRoot: string;
	downloads: Record<string, string>;
	logsDir: string;
	wrote: Record<string, { path: string; exists: boolean }>;
	triples: { path: string; copied: boolean };
}

/**
 * Starts a test process the way `bun test` starts one (the repository's preload, then code),
 * with `home` as its home directory. It makes the real omp calls that write state, data and
 * caches: the install id, a state database, the extension parse cache, mnemopi's banks, cost
 * log and default triples store, and a log line from a child it runs as production (the
 * marker removed, as a test does to run an omp CLI as a user would). It reports the download
 * directories it would use.
 */
async function probeOmpDirs(home: string, cwd: string): Promise<OmpDirsProbe> {
	const module = (...segments: string[]) => JSON.stringify(path.join(REPO_ROOT, "packages", ...segments));
	const logScript = [
		`import * as logger from ${module("utils", "src", "logger.ts")};`,
		`import { getLogPath } from ${module("utils", "src", "dirs.ts")};`,
		'logger.warn("omp dirs probe");',
		"logger.flush();",
		"process.stdout.write(getLogPath());",
	].join("\n");
	const script = [
		'import { Database } from "bun:sqlite";',
		'import * as fs from "node:fs";',
		'import * as path from "node:path";',
		`import * as dirs from ${module("utils", "src", "dirs.ts")};`,
		`import { BankManager } from ${module("mnemopi", "src", "core", "banks.ts")};`,
		`import { initCostLog } from ${module("mnemopi", "src", "core", "cost-log.ts")};`,
		`import { resolveDefaultTripleDb } from ${module("mnemopi", "src", "core", "triples.ts")};`,
		"const openDb = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); new Database(file).close(); return file; };",
		"const installId = path.join(dirs.getBaseConfigRoot(), 'install-id');",
		"dirs.getInstallId();",
		"const banks = new BankManager().banksDir;",
		"initCostLog();",
		"const costLog = fs.readdirSync(process.env.OMP_CONFIG_ROOT, { recursive: true }).find(entry => entry.endsWith('cost_log.db'));",
		"const wrote = {",
		"  installId,",
		"  statsDb: openDb(dirs.getStatsDbPath()),",
		"  extensionCache: openDb(dirs.getLegacyPiExtensionCacheDbPath()),",
		"  agentDb: openDb(dirs.getAgentDbPath()),",
		"  mnemopiBanks: banks,",
		"  costLog: costLog === undefined ? 'cost_log.db not under OMP_CONFIG_ROOT' : path.join(process.env.OMP_CONFIG_ROOT, costLog),",
		`  productionLog: Bun.spawnSync([process.execPath, "--no-install", "--no-env-file", "--eval", ${JSON.stringify(logScript)}], { env: { ...process.env, PI_TEST_RUNTIME: undefined }, stdout: "pipe" }).stdout.toString(),`,
		"};",
		"const triples = resolveDefaultTripleDb();",
		"process.stdout.write(JSON.stringify({",
		"  configRoot: process.env.OMP_CONFIG_ROOT,",
		"  downloads: {",
		"    puppeteer: dirs.getPuppeteerDir(),",
		"    natives: dirs.getNativesDir(),",
		"    grammars: dirs.getNativeGrammarsDir(),",
		"    fastembed: dirs.getFastembedCacheDir(),",
		"    fastembedRuntime: dirs.getFastembedRuntimeDir(),",
		"    tinyModels: dirs.getTinyModelsCacheDir(),",
		"  },",
		"  logsDir: dirs.getLogsDir(),",
		"  wrote: Object.fromEntries(Object.entries(wrote).map(([name, file]) => [name, { path: file, exists: fs.existsSync(file) }])),",
		"  triples: { path: triples, copied: fs.existsSync(triples) },",
		"}));",
	].join("\n");
	return probe<OmpDirsProbe>(preloadedEval(script), {
		cwd,
		// A developer's box, as far as omp can tell: the ambient environment of a test, whose
		// home is `home`. The preload replaces every omp name in it, as it does for `bun test`.
		env: { ...process.env, HOME: home, USERPROFILE: home },
	});
}

/** What a test child that starts with the preload got when it ran `git` by name. */
interface GitProbe {
	which: string | null;
	versions: Record<string, string>;
	processPath: string;
	cPath: string | null;
}

/**
 * Starts a test process the way `bun test` starts one (the repository's preload, then code),
 * with `searchPath` as its PATH, and runs `git --version` from each place a child takes its
 * environment: a `Bun.spawnSync` without `env` (the default child environment), one with
 * `{ ...process.env, HOME }` as the git tests pass, and `node:child_process`. It reports the
 * PATH of `process.env` and of the C environment, which native children copy.
 */
async function probeGit(searchPath: string, home: string): Promise<GitProbe> {
	const libc = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
	const script = [
		'import { spawnSync } from "node:child_process";',
		'import { dlopen, FFIType, ptr } from "bun:ffi";',
		`const libc = dlopen(${JSON.stringify(libc)}, { getenv: { args: [FFIType.ptr], returns: FFIType.cstring } });`,
		'const cPath = libc.symbols.getenv(ptr(Buffer.from("PATH\\0")));',
		'const out = result => String(result.stdout).trim() || "exit " + (result.status ?? result.exitCode) + ": " + result.stderr;',
		"process.stdout.write(JSON.stringify({",
		'  which: Bun.which("git"),',
		"  versions: {",
		'    defaultEnv: out(Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" })),',
		`    homeEnv: out(Bun.spawnSync(["git", "--version"], { env: { ...process.env, HOME: ${JSON.stringify(home)} }, stdout: "pipe", stderr: "pipe" })),`,
		'    nodeChild: out(spawnSync("git", ["--version"], { encoding: "utf8" })),',
		"  },",
		"  processPath: process.env.PATH,",
		"  cPath: cPath === null ? null : String(cPath),",
		"}));",
	].join("\n");
	return probe<GitProbe>(preloadedEval(script), { env: { ...process.env, PATH: searchPath } });
}

/** A `git` in `dir` that records each call in `calls` and fails, as a wrapper that refuses a test's commit. */
function writeRefusingGit(dir: string, calls: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\necho "$0 $*" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
}

/** What a test child that starts with the preload read of git's and jj's configuration. */
interface ToolConfigProbe {
	gitConfigGlobal: string | undefined;
	jjConfig: string | undefined;
	/** `git config --show-origin --list` in a fresh repository. */
	gitOrigins: string;
	commit: { exitCode: number; stderr: string };
	commitObject: string;
	/** `git check-ignore` of a name the home's global ignore file lists: 1 when not ignored. */
	homeIgnoreExit: number;
	/**
	 * omp's native git (`commitCreate`) committing in a fresh repository: with no identity
	 * configured there, and with the test's own identity in its configuration.
	 */
	native: Record<"noIdentity" | "ownIdentity", { error: string | null; commitObject: string | null }>;
	/** `jj config path --user` and `jj config list --user`, or null where jj is not installed. */
	jj: { userPath: string; userConfig: string } | null;
}

/**
 * Starts a test process the way `bun test` starts one, in a developer's environment as far as
 * git and jj can tell: `home` holds their configuration, `JJ_CONFIG` names it, and
 * `GIT_CONFIG_COUNT` includes a file from it, as an omp session's does. The child commits with
 * git and with omp's native git in fresh repositories and reports what git and jj read.
 */
async function probeToolConfig(home: string): Promise<ToolConfigProbe> {
	const script = [
		'import * as fs from "node:fs";',
		'import * as os from "node:os";',
		'import * as path from "node:path";',
		`import * as vcs from ${JSON.stringify(path.join(REPO_ROOT, "packages", "natives", "native", "vcs.js"))};`,
		"const run = (cmd, cwd) => {",
		'  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });',
		"  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };",
		"};",
		"const nativeCommit = async ownIdentity => {",
		'  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-native-commit-"));',
		"  try {",
		'    run(["git", "init", "-q", "-b", "main"], dir);',
		"    if (ownIdentity) {",
		'      run(["git", "config", "user.name", "Test"], dir);',
		'      run(["git", "config", "user.email", "test@example.com"], dir);',
		"    }",
		'    fs.writeFileSync(path.join(dir, "a.txt"), "a\\n");',
		'    run(["git", "add", "a.txt"], dir);',
		"    try {",
		'      await vcs.requireGit(dir).commitCreate("probe", {});',
		"    } catch (error) {",
		"      return { error: String(error), commitObject: null };",
		"    }",
		'    return { error: null, commitObject: run(["git", "cat-file", "commit", "HEAD"], dir).stdout };',
		"  } finally {",
		"    fs.rmSync(dir, { recursive: true, force: true });",
		"  }",
		"};",
		"const native = { noIdentity: await nativeCommit(false), ownIdentity: await nativeCommit(true) };",
		'const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-tool-config-"));',
		"try {",
		'  run(["git", "init", "-q", "-b", "main"], repo);',
		'  const commit = run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "probe"], repo);',
		'  const jj = Bun.which("jj");',
		"  process.stdout.write(JSON.stringify({",
		"    gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,",
		"    jjConfig: process.env.JJ_CONFIG,",
		'    gitOrigins: run(["git", "config", "--show-origin", "--list"], repo).stdout,',
		"    commit: { exitCode: commit.exitCode, stderr: commit.stderr },",
		'    commitObject: run(["git", "cat-file", "commit", "HEAD"], repo).stdout,',
		'    homeIgnoreExit: run(["git", "check-ignore", "-q", "probe.home-ignored"], repo).exitCode,',
		"    native,",
		"    jj: jj === null ? null : {",
		'      userPath: run([jj, "config", "path", "--user"], repo).stdout.trim(),',
		'      userConfig: run([jj, "config", "list", "--user"], repo).stdout,',
		"    },",
		"  }));",
		"} finally {",
		"  fs.rmSync(repo, { recursive: true, force: true });",
		"}",
	].join("\n");
	return probe<ToolConfigProbe>(preloadedEval(script), {
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GIT_CONFIG_GLOBAL: undefined,
			GIT_CONFIG_NOSYSTEM: undefined,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "include.path",
			GIT_CONFIG_VALUE_0: path.join(home, "included.gitconfig"),
			JJ_CONFIG: path.join(home, ".jjconfig.toml"),
			EMAIL: "home@example.invalid",
		},
	});
}

describe("test environment", () => {
	it("lists every environment name the product source reads (test-env-names.json is current)", () => {
		const census = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "test-env-census.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect({ exitCode: census.exitCode, stderr: census.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
	});

	it("removes the machine's names and keeps what a process needs to run", () => {
		for (const name of [
			"PI_CONFIG_FILES",
			"OMP_AUTH_BROKER_TOKEN",
			"CLAUDE_CONFIG_DIR",
			"TMUX",
			"SSH_CONNECTION",
			"GIT_CONFIG_COUNT",
			"GIT_EDITOR",
			"JJ_CONFIG",
			"EMAIL",
		]) {
			expect({ name, removed: isMachineEnvName(name) }).toEqual({ name, removed: true });
		}
		for (const name of ["PATH", "HOME", "PI_TEST_RUNTIME", "OMP_TEST_TIMEOUT", "GITHUB_ACTIONS"]) {
			expect({ name, removed: isMachineEnvName(name) }).toEqual({ name, removed: false });
		}
	});

	it.skipIf(process.platform === "win32")("starts this process and its children without them", () => {
		// The preload ran in this process: the ambient names are gone from every place a child
		// reads, and the only machine names left are the omp directories and git and jj
		// configuration it set itself.
		const ownNames = new Set<string>(TEST_ENV_NAMES);
		const leaked = Object.keys(process.env).filter(isMachineEnvName);
		expect(leaked.filter(name => !ownNames.has(name))).toEqual([]);
		const child = Bun.spawnSync(["/usr/bin/env"], { stdout: "pipe" });
		const childNames = child.stdout
			.toString()
			.split("\n")
			.map(line => line.slice(0, line.indexOf("=")))
			.filter(name => name !== "" && !ownNames.has(name) && isMachineEnvName(name));
		expect(childNames).toEqual([]);
	});

	it("keeps omp's state, data and caches out of the home's .omp, except the shared downloads", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-dirs-"));
		try {
			const cwd = path.join(home, "project");
			// A home with omp in use: settings, a log, the downloads, and mnemopi's legacy triples.
			const seeded: Record<string, string> = {
				".omp/agent/config.yml": "theme: dark\n",
				".omp/logs/omp.2026-01-01.1.log": "old log\n",
				".omp/puppeteer/chrome/BUILD": "shared chromium\n",
				".omp/natives/grammars/tree-sitter-x.wasm": "shared grammar\n",
				".omp/cache/fastembed/MODEL": "shared model\n",
				"project/README.md": "project\n",
			};
			for (const [file, content] of Object.entries(seeded)) {
				fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
				fs.writeFileSync(path.join(home, file), content);
			}
			const legacyTriples = path.join(home, ".hermes", "mnemopi", "data", "triples.db");
			fs.mkdirSync(path.dirname(legacyTriples), { recursive: true });
			new Database(legacyTriples).close();
			const stateRoots = [".omp", ".hermes", ".mnemopi"];
			const before = stateRoots.map(root => ({ root, paths: listTree(path.join(home, root)) }));

			const result = await probeOmpDirs(home, cwd);

			// Nothing new in the home's omp and mnemopi roots: what a run writes went elsewhere.
			expect(stateRoots.map(root => ({ root, paths: listTree(path.join(home, root)) }))).toEqual(before);
			// Each write landed in the child's own config root, outside the home.
			const root = result.configRoot;
			expect(path.relative(home, root).startsWith("..")).toBe(true);
			for (const [name, file] of Object.entries(result.wrote)) {
				const inRoot = !path.relative(root, file.path).startsWith("..");
				expect({ name, ...file, inRoot }).toEqual({ name, ...file, exists: true, inRoot: true });
			}
			// The default triples store is the root's too, and the legacy one was not copied in.
			expect(result.triples).toEqual({ path: path.join(root, "mnemopi", "data", "triples.db"), copied: false });
			expect(path.relative(home, result.logsDir).startsWith("..")).toBe(true);
			// The downloads resolve to the home's own copies, so a run reuses them.
			const shared = (...segments: string[]) => path.join(home, ".omp", ...segments);
			expect(result.downloads).toEqual({
				puppeteer: shared("puppeteer"),
				natives: shared("natives"),
				grammars: shared("natives", "grammars"),
				fastembed: shared("cache", "fastembed"),
				fastembedRuntime: shared("cache", "fastembed-runtime"),
				tinyModels: shared("agent", "cache", "tiny-models"),
			});
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 30_000);

	it.skipIf(process.platform === "win32")(
		"reads no git or jj configuration of the home, so a commit names its own author and is not signed",
		async () => {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-tools-"));
			try {
				// A developer's git: an identity, signing with a key this machine lacks, a default
				// branch, a global ignore file, and a file an omp session's GIT_CONFIG_COUNT includes.
				const seeded: Record<string, string> = {
					".gitconfig": `[user]\n\tname = Home Person\n\temail = home@example.invalid\n\tsigningkey = ${home}/.ssh/no-such-key\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n`,
					".config/git/config": "[init]\n\tdefaultBranch = home-branch\n",
					".config/git/ignore": "*.home-ignored\n",
					"included.gitconfig": "[core]\n\thooksPath = /nonexistent/home-hooks\n",
					".jjconfig.toml": `[user]\nname = "Home Person"\nemail = "home@example.invalid"\n[signing]\nbehavior = "own"\nbackend = "ssh"\nkey = "${home}/.ssh/no-such-key"\n`,
					".config/jj/config.toml": '[user]\nname = "Home Person"\n',
				};
				for (const [file, content] of Object.entries(seeded)) {
					fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
					fs.writeFileSync(path.join(home, file), content);
				}

				const result = await probeToolConfig(home);

				// git read the child's own global file and the repository's, nothing else.
				const origins = new Set(
					result.gitOrigins
						.split("\n")
						.filter(Boolean)
						.map(line => line.split("\t")[0]),
				);
				expect([...origins].sort()).toEqual([`file:${result.gitConfigGlobal}`, "file:.git/config"].sort());
				expect(result.commit).toEqual({ exitCode: 0, stderr: "" });
				expect(result.commitObject).toContain("\nauthor Test <test@example.com> ");
				expect(result.commitObject).not.toContain("gpgsig");
				expect(result.homeIgnoreExit).toBe(1);
				// omp's native git reads the same files: no identity it was not given, and no signing.
				expect(result.native.noIdentity.error).toContain("committer identity is not configured");
				expect(result.native.noIdentity.commitObject).toBeNull();
				expect(result.native.ownIdentity.error).toBeNull();
				expect(result.native.ownIdentity.commitObject).toContain("\nauthor Test <test@example.com> ");
				expect(result.native.ownIdentity.commitObject).not.toContain("gpgsig");
				if (result.jj !== null) {
					expect(result.jj).toEqual({ userPath: result.jjConfig ?? "JJ_CONFIG unset", userConfig: "" });
				}
			} finally {
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it("keeps the home and config-root .env files from a test child", async () => {
		const result = await probeHomeDotenv("1");
		const expected = {
			OMP_AUTH_BROKER_URL: null,
			PI_AUTH_BROKER_URL: null,
			OMP_AUTH_BROKER_TOKEN: null,
			PI_AUTH_BROKER_TOKEN: null,
			ANTHROPIC_API_KEY: null,
			HOME_DOTENV_PROBE_AGENT: "agent",
			HOME_DOTENV_PROBE_PROJECT: "project",
		};
		expect(result).toEqual({ processEnv: expected, env: expected, otelEnv: null });
	}, 20_000);

	it("still loads them in a production child", async () => {
		const result = await probeHomeDotenv(undefined);
		const expected = {
			OMP_AUTH_BROKER_URL: "http://127.0.0.1:9",
			PI_AUTH_BROKER_URL: "http://127.0.0.1:9",
			OMP_AUTH_BROKER_TOKEN: "config-root-token-not-a-secret",
			PI_AUTH_BROKER_TOKEN: "config-root-token-not-a-secret",
			ANTHROPIC_API_KEY: "home-key-not-a-secret",
			HOME_DOTENV_PROBE_AGENT: "agent",
			HOME_DOTENV_PROBE_PROJECT: "project",
		};
		expect(result).toEqual({ processEnv: expected, env: expected, otelEnv: "http://127.0.0.1:9/otel" });
	}, 20_000);

	it.skipIf(process.platform === "win32")(
		"runs the real git in a test and its children, not a wrapper first on PATH",
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-git-wrapper-"));
			try {
				const shims = path.join(dir, "shims");
				const calls = path.join(dir, "calls");
				writeRefusingGit(shims, calls);
				const searchPath = `${shims}${path.delimiter}${process.env.PATH}`;

				const result = await probeGit(searchPath, dir);

				// Each call the wrapper took is a line naming it.
				const wrapperCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
				expect({ wrapperCalls }).toEqual({ wrapperCalls: [] });
				// The machine's own git answered each call: the version this process's git prints.
				const version = Bun.spawnSync(["git", "--version"], { stdout: "pipe" }).stdout.toString().trim();
				expect(version).toMatch(/^git version /);
				expect(result.versions).toEqual({ defaultEnv: version, homeEnv: version, nodeChild: version });
				// One directory of the child's own went first, holding the git it ran; every entry
				// of the PATH it was given follows, in order, and native children see the same PATH.
				const [first, ...rest] = result.processPath.split(path.delimiter);
				expect(rest.join(path.delimiter)).toBe(searchPath);
				expect(result.which).toBe(path.join(first, "git"));
				expect(result.cPath).toBe(result.processPath);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"finds the real git past each kind of wrapper and changes nothing else",
		() => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-git-path-"));
			const made = [dir];
			try {
				const realGit = fs.realpathSync(Bun.which("git") ?? "no git on this PATH");
				// A wrapper in a directory named `shims` (mise's are links there to mise itself), and a
				// link elsewhere whose target is in one (a link to a dotfiles shim can sit anywhere).
				const shims = path.join(dir, "shims");
				const linked = path.join(dir, "bin");
				writeRefusingGit(shims, path.join(dir, "calls"));
				fs.mkdirSync(linked);
				fs.symlinkSync(path.join(shims, "git"), path.join(linked, "git"));
				const searchPath = [linked, shims, process.env.PATH].join(path.delimiter);

				const testPath = createTestPath(searchPath);

				const [first, ...rest] = (testPath ?? "").split(path.delimiter);
				if (testPath !== undefined) made.push(first);
				expect(rest.join(path.delimiter)).toBe(searchPath);
				// The developer's own PATH may wrap jj too; its link then sits beside git's.
				expect(fs.readdirSync(first).filter(name => name !== "jj")).toEqual(["git"]);
				expect(fs.realpathSync(path.join(first, "git"))).toBe(realGit);
				// A PATH whose first git is already the real one stays as it is.
				expect(createTestPath(`${path.dirname(realGit)}${path.delimiter}${searchPath}`)).toBeUndefined();
			} finally {
				for (const madeDir of made) fs.rmSync(madeDir, { recursive: true, force: true });
			}
		},
	);

	it("decides the test PATH for Windows and POSIX alike, on any system", () => {
		// A file system of directories and their names, and links from one file to another.
		const fakeProbe = (
			platform: NodeJS.Platform,
			dirs: Record<string, string[]>,
			links: Record<string, string> = {},
		) => {
			const paths = platform === "win32" ? path.win32 : path.posix;
			const probe: PathProbe = {
				find: (dir, tool) => {
					const toolName =
						platform === "win32" ? new RegExp(`^${tool}\\.(?:exe|com|cmd|bat)$`, "i") : new RegExp(`^${tool}$`);
					const name = dirs[dir]?.find(entry => toolName.test(entry));
					return name === undefined ? null : paths.join(dir, name);
				},
				realpath: file => links[file] ?? file,
				list: dir => dirs[dir] ?? [],
			};
			return probe;
		};
		const gitForWindows = {
			"C:\\Users\\dev\\scoop\\shims": ["git.exe", "bun.exe"],
			"C:\\Users\\dev\\AppData\\Local\\mise\\Shims": ["git.exe"],
			"C:\\Program Files\\Git\\cmd": ["git.exe", "gitk.exe", "git-gui.exe"],
			"C:\\Program Files\\Git\\mingw64\\bin": ["git.exe", "bash.exe", "curl.exe"],
			"C:\\Windows\\System32": ["cmd.exe"],
		};
		const win = fakeProbe("win32", gitForWindows);
		// Git for Windows' `cmd` holds only git's programs: it goes first itself.
		expect(
			planTestPath("C:\\Users\\dev\\scoop\\shims;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32", "win32", win),
		).toEqual({ kind: "directory", directory: "C:\\Program Files\\Git\\cmd" });
		// A directory with other tools would shadow them: a launcher runs its git instead. A
		// `Shims` directory is one in any case, as Windows names are.
		const misePath = "C:\\Users\\dev\\AppData\\Local\\mise\\Shims;C:\\Program Files\\Git\\mingw64\\bin";
		expect(planTestPath(misePath, "win32", win)).toEqual({
			kind: "launcher",
			file: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
		});
		// The first git is the real one, or no git follows the wrappers: nothing changes.
		expect(planTestPath("C:\\Program Files\\Git\\cmd;C:\\Users\\dev\\scoop\\shims", "win32", win)).toBeUndefined();
		expect(planTestPath("C:\\Users\\dev\\scoop\\shims;C:\\Windows\\System32", "win32", win)).toBeUndefined();
		// A git elsewhere whose real path is in a `shims` directory is a wrapper too.
		const linked = fakeProbe(
			"win32",
			{ "C:\\tools": ["git.cmd"], "C:\\Program Files\\Git\\cmd": ["git.exe"] },
			{ "C:\\tools\\git.cmd": "C:\\Users\\dev\\.dotfiles\\shims\\git.cmd" },
		);
		expect(planTestPath("C:\\tools;C:\\Program Files\\Git\\cmd", "win32", linked)).toEqual({
			kind: "directory",
			directory: "C:\\Program Files\\Git\\cmd",
		});

		const posix = fakeProbe(
			"linux",
			{
				"/home/dev/bin": ["git"],
				"/home/dev/.dotfiles/shims": ["git", "jj"],
				"/home/dev/.mise/installs/jj/0.46/bin": ["jj"],
				"/usr/bin": ["git", "ls"],
			},
			{ "/home/dev/bin/git": "/home/dev/.dotfiles/shims/git" },
		);
		expect(planTestPath("/home/dev/bin:/home/dev/.dotfiles/shims:/usr/bin", "linux", posix)).toEqual({
			kind: "link",
			file: "/usr/bin/git",
		});
		expect(planTestPath("/usr/bin:/home/dev/.dotfiles/shims", "linux", posix)).toBeUndefined();
		// jj the same way: past the dotfiles shim, which finds the real jj through the home.
		const jjPath = "/home/dev/.dotfiles/shims:/home/dev/.mise/installs/jj/0.46/bin:/usr/bin";
		expect(planTestPath(jjPath, "linux", posix, "jj")).toEqual({
			kind: "link",
			file: "/home/dev/.mise/installs/jj/0.46/bin/jj",
		});
		expect(planTestPath("/usr/bin:/home/dev/.dotfiles/shims", "linux", posix, "jj")).toBeUndefined();
		// On Windows a jj gets a launcher: only git's own directory may go first as it is.
		const winJj = fakeProbe("win32", {
			"C:\\Users\\dev\\scoop\\shims": ["jj.exe"],
			"C:\\Users\\dev\\scoop\\apps\\jj\\current": ["jj.exe"],
		});
		expect(
			planTestPath("C:\\Users\\dev\\scoop\\shims;C:\\Users\\dev\\scoop\\apps\\jj\\current", "win32", winJj, "jj"),
		).toEqual({
			kind: "launcher",
			file: "C:\\Users\\dev\\scoop\\apps\\jj\\current\\jj.exe",
		});
	});

	it("writes a Windows launcher that passes its arguments and exit status on", () => {
		expect(windowsLauncher("C:\\Program Files\\Git\\mingw64\\bin\\git.exe")).toBe(
			'@"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" %*\r\n@exit /b %ERRORLEVEL%\r\n',
		);
		expect(windowsLauncher("C:\\100%\\git.cmd")).toBe('@call "C:\\100%%\\git.cmd" %*\r\n@exit /b %ERRORLEVEL%\r\n');
	});

	it("leaves none of its temporary directories behind, in or out of the test runner", async () => {
		// Each process records the config root its preload made; it must be under the child's own
		// TMPDIR, so an empty count below cannot come from a root made somewhere else.
		const record = 'require("node:fs").writeFileSync("root.txt", process.env.OMP_CONFIG_ROOT ?? "")';
		const testFile = `import { it } from "bun:test";\nit("runs", () => { ${record}; });\n`;
		const modes: { name: string; argv: string[]; file?: string; nodeEnv?: string }[] = [
			{
				name: "bun test, a test file",
				argv: [process.execPath, "test", "--preload", PRELOAD, "./a.test.ts"],
				file: "a.test.ts",
			},
			{
				name: "bun test, a file not named as a test",
				argv: [process.execPath, "test", "--preload", PRELOAD, "./fixture.ts"],
				file: "fixture.ts",
			},
			{
				name: "bun test under NODE_ENV=production",
				argv: [process.execPath, "test", "--preload", PRELOAD, "./a.test.ts"],
				file: "a.test.ts",
				nodeEnv: "production",
			},
			{ name: "a preloaded --eval child", argv: preloadedEval(record) },
		];
		const left: Record<string, string[]> = {};
		for (const mode of modes) {
			const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-leftovers-"));
			try {
				const tmp = path.join(base, "tmp");
				const cwd = path.join(base, "work");
				fs.mkdirSync(tmp);
				fs.mkdirSync(cwd);
				if (mode.file) fs.writeFileSync(path.join(cwd, mode.file), testFile);
				const env: Record<string, string | undefined> = { ...process.env, TMPDIR: tmp };
				delete env.NODE_ENV;
				if (mode.nodeEnv) env.NODE_ENV = mode.nodeEnv;
				const child = Bun.spawn(mode.argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
				const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
				expect({ mode: mode.name, exitCode }, stderr).toEqual({ mode: mode.name, exitCode: 0 });
				const root = fs.readFileSync(path.join(cwd, "root.txt"), "utf8");
				expect({ mode: mode.name, madeUnderTmp: root.startsWith(tmp + path.sep) }).toEqual({
					mode: mode.name,
					madeUnderTmp: true,
				});
				left[mode.name] = fs.readdirSync(tmp).filter(entry => entry.startsWith("omp-test-"));
			} finally {
				fs.rmSync(base, { recursive: true, force: true });
			}
		}
		expect(left).toEqual(Object.fromEntries(modes.map(mode => [mode.name, []])));
	});
});
