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
 * The children of omp that are omp get its natives directory; the commands the agent runs
 * resolve their own. One probe process does what omp does: load the addon (the loader
 * resolves the directory), apply the agent's `.env` (here it sets `PI_NATIVES_DIR` and
 * `OMP_DOWNLOAD_ROOT`), then start a subprocess worker with `workerEnvFromParent()` and a
 * command with the environment the bash tool builds (`filterChildShellEnv(Bun.env)`), given a
 * home of its own as a hermetic run would. The launch broker, itself a worker, runs both omp
 * daemons and the agent's commands and services; it takes `PI_NATIVES_DIR` from a spec only.
 */
describe("the natives directory of omp's children", () => {
	let tempRoot = "";

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-children-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("gives a subprocess worker the parent's directory, and a command none, so it resolves its own", async () => {
		const home = path.join(tempRoot, "home");
		const commandHome = path.join(tempRoot, "command-home");
		await Bun.write(
			path.join(home, ".omp/agent/.env"),
			`PI_NATIVES_DIR=${path.join(tempRoot, "from-dotenv")}\nOMP_DOWNLOAD_ROOT=${path.join(tempRoot, "dl")}\n`,
		);
		const nativesDirJs = JSON.stringify(path.join(import.meta.dir, "../../natives/native/natives-dir.js"));
		const printNativesDir = JSON.stringify(`console.log((await import(${nativesDirJs})).getNativesDir())`);
		const script = path.join(tempRoot, "probe.ts");
		await Bun.write(
			script,
			`const { initLoaderContext } = await import(${JSON.stringify(path.join(import.meta.dir, "../../natives/native/loader-state.js"))});
const parent = initLoaderContext({ isCompiledBinary: true }).nativesDir;
// By path: a script outside the repository would take a package name from Bun's install cache.
const { filterChildShellEnv } = await import(${JSON.stringify(path.join(import.meta.dir, "../../utils/src/env.ts"))});
const { managedDaemonEnv, ompDaemonSpecEnv, workerEnvFromParent } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/subprocess/worker-client.ts"))});
const run = env => Bun.spawnSync([process.execPath, "-e", ${printNativesDir}], { env }).stdout.toString().trim();
const workerEnv = workerEnvFromParent();
const commandEnv = filterChildShellEnv(Bun.env);
const hermetic = { ...commandEnv, HOME: ${JSON.stringify(commandHome)}, USERPROFILE: ${JSON.stringify(commandHome)} };
delete hermetic.OMP_CONFIG_ROOT;
delete hermetic.OMP_DOWNLOAD_ROOT;
const applied = process.env.PI_NATIVES_DIR ?? null;
// In the broker, which was started with workerEnvFromParent() and so holds the parent's directory.
process.env.PI_NATIVES_DIR = workerEnv.PI_NATIVES_DIR;
const brokerCommand = managedDaemonEnv(commandEnv);
const brokerDaemon = managedDaemonEnv(ompDaemonSpecEnv({}));
console.log(JSON.stringify({ parent, applied, worker: run(workerEnv), workerEnv: workerEnv.PI_NATIVES_DIR ?? null, commandEnv: commandEnv.PI_NATIVES_DIR ?? null, command: run(hermetic), brokerCommand: brokerCommand.PI_NATIVES_DIR ?? null, brokerDaemon: brokerDaemon.PI_NATIVES_DIR ?? null }));
`,
		);
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		for (const key of DIRECTORY_NAMES) delete env[key];
		const child = Bun.spawn([process.execPath, script], { cwd: tempRoot, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const result = JSON.parse(stdout);

		expect(result.parent).toBe(path.join(home, ".omp", "natives"));
		// The `.env` was applied, so a child that took process.env as it is would name another.
		expect(result.applied).toBe(path.join(tempRoot, "from-dotenv"));
		expect(result.workerEnv).toBe(result.parent);
		expect(result.worker).toBe(result.parent);
		expect(result.commandEnv).toBeNull();
		expect(result.command).toBe(path.join(commandHome, ".omp", "natives"));
		expect(result.brokerCommand).toBeNull();
		expect(result.brokerDaemon).toBe(result.parent);
	}, 120_000);
});
