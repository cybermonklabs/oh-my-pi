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
		expect(result.commandEnv).toEqual({ PI_NATIVES_DIR: null, handoff: null });
		expect(result.command).toBe(ownDir);
		expect(result.spread.PI_NATIVES_DIR).toBeNull();
		expect(result.spreadOwnHome).toBe(ownDir);
	}, 120_000);

	it("gives a broker service the bash tool's environment, without a project .env value, and an omp daemon the session's directory", async () => {
		const printer = path.join(tempRoot, "print-natives-dir.ts");
		const ownHome = path.join(tempRoot, "own-home");
		const projectDownloads = path.join(tempRoot, "proj-dl");
		// The broker stand-in: reads the specs the session sent, and runs each as the broker does.
		await Bun.write(
			path.join(tempRoot, "broker.ts"),
			`${helpers(printer)}
const { managedDaemonEnv } = await import(${JSON.stringify(workerClientTs)});
const dir = (await import(${JSON.stringify(nativesDirJs)})).getNativesDir();
const specs = JSON.parse(process.argv[2]);
console.log(JSON.stringify({ dir, OMP_DOWNLOAD_ROOT: process.env.OMP_DOWNLOAD_ROOT ?? null, service: run(managedDaemonEnv(specs.service)), daemon: run(managedDaemonEnv(specs.daemon)) }));
`,
		);
		const { home, result } = await session(
			`
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
console.log(JSON.stringify({ first, applied: process.env.OMP_DOWNLOAD_ROOT ?? null, broker: JSON.parse(broker.stdout.toString()) }));
`,
			{ project: `OMP_DOWNLOAD_ROOT=${projectDownloads}\n` },
		);
		const sessionDir = path.join(home, ".omp", "natives");

		expect(result.first).toBe(sessionDir);
		// The project `.env` was applied in the session, so a base that kept it would carry it.
		expect(result.applied).toBe(projectDownloads);
		expect(result.broker.dir).toBe(sessionDir);
		expect(result.broker.service.OMP_DOWNLOAD_ROOT).toBeNull();
		expect(result.broker.service.dir).toBe(path.join(ownHome, ".omp", "natives"));
		expect(result.broker.daemon.dir).toBe(sessionDir);
	}, 120_000);
});
