/**
 * The real CLI loads the native addon (its SQLite lock shim) before it applies the agent's
 * `.env`, and loads it again later. With `PI_NATIVES_DIR` set only in that `.env`, both loads
 * must use one natives directory: a second one would load a second copy of the addon into the
 * process, and grammars would be downloaded where the addon does not look. Each load runs
 * cache cleanup in the directory it used, so an aged cache directory planted in every
 * candidate shows which directories the process used.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = path.join(import.meta.dir, "../src/cli.ts");
const DIRECTORY_NAMES = [
	"PI_NATIVES_DIR",
	"OMP_DOWNLOAD_ROOT",
	"OMP_CONFIG_ROOT",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"__PI_NATIVES_DIR_CACHE",
	"__PI_NATIVES_DIR_HANDOFF",
];

describe("the CLI with PI_NATIVES_DIR set in the agent's .env", () => {
	let tempRoot = "";

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dotenv-cli-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses one natives directory for every load in the process", async () => {
		const home = path.join(tempRoot, "home");
		const fromDotenv = path.join(tempRoot, "from-dotenv");
		const candidates = { home: path.join(home, ".omp/natives"), dotenv: fromDotenv };
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		for (const dir of Object.values(candidates)) {
			await fs.mkdir(path.join(dir, "18.0.0"), { recursive: true });
			await fs.utimes(path.join(dir, "18.0.0"), twoDaysAgo, twoDaysAgo);
		}
		await Bun.write(path.join(home, ".omp/agent/.env"), `PI_NATIVES_DIR=${fromDotenv}\n`);
		const project = path.join(tempRoot, "project");
		await Bun.write(path.join(project, "a.txt"), "needle here\n");

		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PI_DEBUG_STARTUP: "1",
		};
		for (const key of DIRECTORY_NAMES) delete env[key];
		const child = Bun.spawn([process.execPath, cli, "grep", "needle", project], {
			cwd: project,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect({ exitCode, found: stdout.includes("needle here") }).toEqual({ exitCode: 0, found: true });
		// The process loaded the addon more than once, so a second directory had its chance.
		expect(stderr.split("native:loadNative:start").length - 1).toBeGreaterThan(1);
		const used = [];
		for (const [name, dir] of Object.entries(candidates)) {
			if (!(await fs.exists(path.join(dir, "18.0.0")))) used.push(name);
		}
		expect(used).toHaveLength(1);
	}, 180_000);
});

/**
 * Which natives directory omp's children use. Each case runs stand-ins as real processes, so
 * each child has its own parent and environment: a session (loads the addon, then applies its
 * `.env` files), a subprocess worker such as the JS eval kernel (`workerEnvFromParent()`), the
 * programs that worker starts, a command as the bash tool builds it (`filterChildShellEnv`), a
 * `{...Bun.env}` child as the debugger, MCP and language-server spawns build theirs, and the
 * launch broker (`brokerEnvFromParent`) with a service and an omp daemon it runs
 * (`managedDaemonEnv`). Children that are omp take the session's directory from a handoff;
 * every other program resolves its own.
 */
describe("the natives directory of omp's children", () => {
	let tempRoot = "";
	const nativesDirJs = path.join(import.meta.dir, "../../natives/native/natives-dir.js");
	const loaderStateJs = path.join(import.meta.dir, "../../natives/native/loader-state.js");
	// By path: a script outside the repository would take a package name from Bun's install cache.
	const envTs = path.join(import.meta.dir, "../../utils/src/env.ts");
	const workerClientTs = path.join(import.meta.dir, "../src/subprocess/worker-client.ts");
	const workerHostTs = path.join(import.meta.dir, "../../utils/src/worker-host.ts");
	const nativesIndexJs = path.join(import.meta.dir, "../../natives/native/index.js");

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-children-"));
		await Bun.write(
			path.join(tempRoot, "print-natives-dir.ts"),
			`console.log(JSON.stringify({ dir: (await import(${JSON.stringify(nativesDirJs)})).getNativesDir(), PI_NATIVES_DIR: process.env.PI_NATIVES_DIR ?? null, OMP_DOWNLOAD_ROOT: process.env.OMP_DOWNLOAD_ROOT ?? null }));\n`,
		);
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	/** Shared by the stand-ins: run the printer with `env`, and a home of its own when `home` is set. */
	const helpers = (printer: string) => `
const run = (env, home) => {
	const own = { ...env };
	if (home) {
		own.HOME = own.USERPROFILE = home;
		delete own.OMP_CONFIG_ROOT;
		delete own.OMP_DOWNLOAD_ROOT;
	}
	const child = Bun.spawnSync([process.execPath, "--no-env-file", ${JSON.stringify(printer)}], { env: own });
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	return JSON.parse(child.stdout.toString());
};
`;

	/** Run `script` as the session: a fresh home whose agent `.env` and project `.env` are given. */
	async function session(script: string, dotenv: { agent?: string; project?: string }) {
		const home = path.join(tempRoot, "home");
		const project = path.join(tempRoot, "project");
		await Bun.write(path.join(home, ".omp/agent/.env"), dotenv.agent ?? "");
		await Bun.write(path.join(project, ".env"), dotenv.project ?? "");
		await Bun.write(path.join(tempRoot, "session.ts"), script);
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		for (const key of DIRECTORY_NAMES) delete env[key];
		// Without Bun's own `.env` loading, as a compiled omp starts: omp's env.ts applies them.
		const child = Bun.spawn([process.execPath, "--no-env-file", path.join(tempRoot, "session.ts")], {
			cwd: project,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		return { home, result: JSON.parse(stdout) };
	}

	it("gives a worker the session's directory, and its programs, the commands and {...Bun.env} children their own", async () => {
		const printer = path.join(tempRoot, "print-natives-dir.ts");
		const ownHome = path.join(tempRoot, "own-home");
		// The worker stand-in: the JS eval kernel, which runs agent code that starts programs.
		await Bun.write(
			path.join(tempRoot, "worker.ts"),
			`${helpers(printer)}
const dir = (await import(${JSON.stringify(nativesDirJs)})).getNativesDir();
console.log(JSON.stringify({ dir, PI_NATIVES_DIR: process.env.PI_NATIVES_DIR ?? null, program: run(process.env).dir, programOwnHome: run(process.env, ${JSON.stringify(ownHome)}).dir }));
`,
		);
		const { home, result } = await session(
			`${helpers(printer)}
const { initLoaderContext } = await import(${JSON.stringify(loaderStateJs)});
const first = initLoaderContext({ isCompiledBinary: true }).nativesDir;
const { filterChildShellEnv } = await import(${JSON.stringify(envTs)});
const { workerEnvFromParent } = await import(${JSON.stringify(workerClientTs)});
const worker = Bun.spawnSync([process.execPath, "--no-env-file", ${JSON.stringify(path.join(tempRoot, "worker.ts"))}], { env: workerEnvFromParent() });
if (worker.exitCode !== 0) throw new Error(worker.stderr.toString());
const commandEnv = filterChildShellEnv(Bun.env);
console.log(JSON.stringify({
	first,
	applied: process.env.PI_NATIVES_DIR ?? null,
	worker: JSON.parse(worker.stdout.toString()),
	commandEnv: { PI_NATIVES_DIR: commandEnv.PI_NATIVES_DIR ?? null, handoff: commandEnv.__PI_NATIVES_DIR_HANDOFF ?? null },
	command: run(commandEnv, ${JSON.stringify(ownHome)}).dir,
	spread: run({ ...Bun.env }),
	spreadOwnHome: run({ ...Bun.env }, ${JSON.stringify(ownHome)}).dir,
}));
`,
			{
				agent: `PI_NATIVES_DIR=${path.join(tempRoot, "from-dotenv")}\nOMP_DOWNLOAD_ROOT=${path.join(tempRoot, "dl")}\n`,
			},
		);
		const sessionDir = path.join(home, ".omp", "natives");
		const ownDir = path.join(ownHome, ".omp", "natives");

		expect(result.first).toBe(sessionDir);
		// omp never applies a `.env` file's PI_NATIVES_DIR.
		expect(result.applied).toBeNull();
		// The worker takes the session's directory; its environment has PI_NATIVES_DIR as launched.
		expect(result.worker.dir).toBe(sessionDir);
		expect(result.worker.PI_NATIVES_DIR).toBeNull();
		// The programs it starts resolve their own: with its environment (the agent `.env`'s
		// OMP_DOWNLOAD_ROOT), and with a home of their own.
		expect(result.worker.program).toBe(path.join(tempRoot, "dl", "natives"));
		expect(result.worker.programOwnHome).toBe(ownDir);
		expect(result.commandEnv).toEqual({ PI_NATIVES_DIR: null, handoff: "" });
		expect(result.command).toBe(ownDir);
		expect(result.spread.PI_NATIVES_DIR).toBeNull();
		expect(result.spreadOwnHome).toBe(ownDir);
	}, 120_000);

	it("gives a broker service the bash tool's environment, without a project .env value, and the broker and an omp daemon the session's directory", async () => {
		const printer = path.join(tempRoot, "print-natives-dir.ts");
		const ownHome = path.join(tempRoot, "own-home");
		const projectDownloads = path.join(tempRoot, "proj-dl");
		// An input the agent `.env` sets, which the bash tool's environment keeps: a broker or a
		// daemon that resolved for itself would name `<agentCache>/omp/natives`.
		const agentCache = path.join(tempRoot, "agent-cache");
		await fs.mkdir(path.join(agentCache, "omp"), { recursive: true });
		// The broker stand-in: reads the specs the session sent, and runs each as the broker does.
		await Bun.write(
			path.join(tempRoot, "broker.ts"),
			`${helpers(printer)}
const { managedDaemonEnv } = await import(${JSON.stringify(workerClientTs)});
const dir = (await import(${JSON.stringify(nativesDirJs)})).getNativesDir();
const specs = JSON.parse(process.argv[2]);
console.log(JSON.stringify({ dir, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null, service: run(managedDaemonEnv(specs.service)), daemon: run(managedDaemonEnv(specs.daemon)) }));
`,
		);
		const { home, result } = await session(
			`${helpers(printer)}
const { initLoaderContext } = await import(${JSON.stringify(loaderStateJs)});
const first = initLoaderContext({ isCompiledBinary: true }).nativesDir;
const { filterChildShellEnv } = await import(${JSON.stringify(envTs)});
const { brokerEnvFromParent, ompDaemonSpecEnv } = await import(${JSON.stringify(workerClientTs)});
// A launch-tool service's spec is the shell environment (launch/services.ts), here an omp with
// a home of its own; an omp daemon's spec is an overlay with the handoff.
const shellEnv = filterChildShellEnv(Bun.env);
const service = { ...shellEnv, HOME: ${JSON.stringify(ownHome)}, USERPROFILE: ${JSON.stringify(ownHome)} };
delete service.OMP_CONFIG_ROOT;
const specs = JSON.stringify({ service, daemon: ompDaemonSpecEnv({}) });
const broker = Bun.spawnSync([process.execPath, "--no-env-file", ${JSON.stringify(path.join(tempRoot, "broker.ts"))}, specs], { env: brokerEnvFromParent({}) });
if (broker.exitCode !== 0) throw new Error(broker.stderr.toString());
console.log(JSON.stringify({ first, applied: process.env.OMP_DOWNLOAD_ROOT ?? null, direct: run(service), broker: JSON.parse(broker.stdout.toString()) }));
`,
			{ agent: `XDG_CACHE_HOME=${agentCache}\n`, project: `OMP_DOWNLOAD_ROOT=${projectDownloads}\n` },
		);
		const sessionDir = path.join(home, ".omp", "natives");

		expect(result.first).toBe(sessionDir);
		// The project `.env` was applied in the session, so a base that kept it would carry it.
		expect(result.applied).toBe(projectDownloads);
		// The broker has the agent `.env`'s input, so it names the session's directory only
		// through its handoff; so does the daemon, through the handoff the broker re-issues.
		expect(result.broker.XDG_CACHE_HOME).toBe(agentCache);
		expect(result.broker.dir).toBe(sessionDir);
		expect(result.broker.daemon.dir).toBe(sessionDir);
		// The service gets what the same command run directly gets: the agent `.env`'s input,
		// not the project `.env`'s.
		expect(result.direct.dir).toBe(path.join(agentCache, "omp", "natives"));
		expect(result.broker.service.OMP_DOWNLOAD_ROOT).toBeNull();
		expect(result.broker.service.dir).toBe(result.direct.dir);
	}, 120_000);

	it("gives a worker started in a directory whose .env sets an input the session's directory", async () => {
		// A non-compiled omp starts its workers with Bun's runtime; Bun's own `.env` loading would
		// apply the worker directory's `.env` before any omp code runs.
		const elsewhere = path.join(tempRoot, "elsewhere");
		await Bun.write(
			path.join(elsewhere, ".env"),
			`PI_NATIVES_DIR=${path.join(tempRoot, "elsewhere-natives")}\nOMP_DOWNLOAD_ROOT=${path.join(tempRoot, "elsewhere-dl")}\n`,
		);
		const workerArg = "__omp_worker_natives_dir_probe";
		const { home, result } = await session(
			`
const { getNativesDir } = await import(${JSON.stringify(nativesDirJs)});
if (process.argv[2] === ${JSON.stringify(workerArg)}) {
	// This script is also the worker host, as the CLI is: the worker branch.
	console.log(JSON.stringify({ dir: getNativesDir(), PI_NATIVES_DIR: process.env.PI_NATIVES_DIR ?? null }));
	process.exit(0);
}
const { initLoaderContext } = await import(${JSON.stringify(loaderStateJs)});
const first = initLoaderContext({ isCompiledBinary: true }).nativesDir;
await import(${JSON.stringify(envTs)});
const { declareWorkerHostEntry } = await import(${JSON.stringify(workerHostTs)});
const { resolveWorkerSpawnCmd, workerEnvFromParent } = await import(${JSON.stringify(workerClientTs)});
declareWorkerHostEntry();
// setProjectDir moves the session into another directory (a cwd move, a session worktree),
// and a worker of a non-compiled omp starts there.
process.chdir(${JSON.stringify(elsewhere)});
const spawn = resolveWorkerSpawnCmd(${JSON.stringify(workerArg)});
const worker = Bun.spawnSync(spawn.cmd, { cwd: spawn.cwd, env: workerEnvFromParent(), stderr: "pipe" });
if (worker.exitCode !== 0) throw new Error(worker.stderr.toString());
console.log(JSON.stringify({ first, cwd: spawn.cwd ?? null, worker: JSON.parse(worker.stdout.toString()) }));
`,
			{},
		);
		const sessionDir = path.join(home, ".omp", "natives");

		expect(result.first).toBe(sessionDir);
		expect(result.cwd).toBeNull();
		expect(result.worker).toEqual({ dir: sessionDir, PI_NATIVES_DIR: null });
	}, 120_000);

	it("gives a forked session's commands no handoff, though the fork was started with one", async () => {
		// A fork starts with a handoff that names no parent (the terminal starts it). omp removes
		// it from process.env at its first call, but the bash tool's native shell starts from the
		// process's C environment, where it remains.
		const printer = path.join(tempRoot, "print-natives-dir.ts");
		const handedOver = path.join(tempRoot, "handed-over");
		const home = path.join(tempRoot, "home");
		const project = path.join(tempRoot, "project");
		await fs.mkdir(project, { recursive: true });
		await Bun.write(path.join(home, ".omp/agent/.env"), "");
		await Bun.write(
			path.join(tempRoot, "fork.ts"),
			`const { getNativesDir } = await import(${JSON.stringify(nativesDirJs)});
const dir = getNativesDir();
const { filterChildShellEnv } = await import(${JSON.stringify(envTs)});
const { Shell } = await import(${JSON.stringify(nativesIndexJs)});
// The bash tool's way: the command environment as the session env, and as the run's.
const env = filterChildShellEnv(Bun.env, ${JSON.stringify(project)});
const shell = new Shell({ sessionEnv: env });
let out = "";
const command = 'echo "handoff=\${__PI_NATIVES_DIR_HANDOFF:+present}"; ' + ${JSON.stringify(`"${process.execPath}" --no-env-file "${printer}"`)};
await shell.run({ command, cwd: ${JSON.stringify(project)}, env }, (err, chunk) => { if (!err) out += chunk; });
const [seen, omp] = out.trim().split("\\n");
console.log(JSON.stringify({ dir, seen, command: JSON.parse(omp) }));
`,
		);
		const forkEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		for (const key of DIRECTORY_NAMES) delete forkEnv[key];
		const { nativesDirHandoff } = await import(nativesDirJs);
		forkEnv.__PI_NATIVES_DIR_HANDOFF = nativesDirHandoff(forkEnv, { parent: null, dir: handedOver });
		const child = Bun.spawn([process.execPath, "--no-env-file", path.join(tempRoot, "fork.ts")], {
			cwd: project,
			env: forkEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const result = JSON.parse(stdout);

		// The fork takes its handoff; a command it runs sees none, and an omp the command starts
		// resolves its own directory, though its inputs are the fork's.
		expect(result.dir).toBe(handedOver);
		expect(result.seen).toBe("handoff=");
		expect(result.command.dir).toBe(path.join(home, ".omp", "natives"));
	}, 120_000);
});
