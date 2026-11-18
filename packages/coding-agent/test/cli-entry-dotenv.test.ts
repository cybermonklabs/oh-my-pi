/**
 * A non-compiled omp (the npm package's `omp` script, `bun src/cli.ts`) starts with whatever Bun's
 * own `.env` loading gave it. `/restart` replaces the process with `execvp(3)`, which passes the
 * environment the process was started with, not those values; so the command that starts the CLI
 * again (`resolveCliEntryCmd`) must give the new process exactly the values the first launch had,
 * whatever rules Bun used to find them, and wherever the session has moved since.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Every name a case's files set, in the start directory or the one the session moves into. */
const NAMES = [
	"FROM_ENV",
	"FROM_MODE",
	"FROM_LOCAL",
	"FROM_MODE_LOCAL",
	"FROM_A",
	"FROM_B",
	"FROM_PIPE",
	"ONLY_ELSEWHERE",
];

/** The start directory: a file for every mode Bun can pick, and `.env.local`. */
const START_FILES: Record<string, string> = {
	".env": "FROM_ENV=start\n",
	".env.development": "FROM_MODE=development\n",
	".env.production": "FROM_MODE=production\n",
	".env.test": "FROM_MODE=test\n",
	".env.staging": "FROM_MODE=staging\n",
	".env.Production": "FROM_MODE=Production\n",
	".env.local": "FROM_LOCAL=start\n",
	".env.development.local": "FROM_MODE_LOCAL=development\n",
	".env.production.local": "FROM_MODE_LOCAL=production\n",
	".env.test.local": "FROM_MODE_LOCAL=test\n",
	"a.env": "FROM_A=start\n",
	"b.env": "FROM_B=start\n",
};

/** The directory the session moves into: other values for every file, and a name of its own. */
const ELSEWHERE_FILES: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(START_FILES).map(([name, text]) => [
			name,
			`${text.replace(/=.*$/m, "=elsewhere")}ONLY_ELSEWHERE=yes\n`,
		]),
	),
	// Where a start path holding a comma would send its second half.
	"v2/.env": "FROM_ENV=hijack\nONLY_ELSEWHERE=yes\n",
};

describe("the CLI started again by /restart", () => {
	let tempRoot = "";
	// By path: a script outside the repository would take a package name from Bun's install cache.
	const workerClientTs = path.join(import.meta.dir, "../src/subprocess/worker-client.ts");
	const workerHostTs = path.join(import.meta.dir, "../../utils/src/worker-host.ts");
	const nativesIndexJs = path.join(import.meta.dir, "../../natives/native/index.js");

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-entry-dotenv-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	interface Case {
		/** The start directory's name. */
		dir?: string;
		/** Start files to leave out at launch. */
		without?: string[];
		/** Files the session writes into its start directory after it started. */
		late?: Record<string, string>;
		/** Start files besides the usual ones. */
		extra?: Record<string, string>;
		/** The session's environment, over the test's (`undefined` unsets). */
		env?: Record<string, string | undefined>;
		/** Bun runtime flags, before the script. */
		flags?: string[];
		/** A bash command line that starts the session (`$SESSION` is the script), for a pipe. */
		shell?: string;
	}

	/** Start a session as the case says, let it move and `/restart` itself; both views of its values. */
	async function restart(c: Case) {
		const start = path.join(tempRoot, c.dir ?? "start");
		const elsewhere = path.join(tempRoot, "elsewhere");
		const home = path.join(tempRoot, "home");
		for (const [name, text] of Object.entries({ ...START_FILES, ...c.extra })) {
			if (!c.without?.includes(name)) await Bun.write(path.join(start, name), text);
		}
		for (const [name, text] of Object.entries(ELSEWHERE_FILES)) await Bun.write(path.join(elsewhere, name), text);
		await fs.mkdir(home, { recursive: true });
		const firstOut = path.join(tempRoot, "first.json");
		const script = path.join(tempRoot, "session.ts");
		await Bun.write(
			script,
			`// Before any import: what Bun's own loading gave this process.
const values = () => Object.fromEntries(${JSON.stringify(NAMES)}.map(name => [name, process.env[name] ?? null]));
const seen = values();
if (process.argv[2] === "restarted") {
	// omp's env.ts removes the private file it was started with as soon as it loads.
	await import(${JSON.stringify(workerClientTs)});
	const fs = await import("node:fs");
	const envFiles = process.execArgv.filter(arg => arg.startsWith("--env-file=")).map(arg => arg.slice(11));
	const keptFlags = process.execArgv.filter(arg => !arg.startsWith("--env-file") && !arg.startsWith("--no-env-file"));
	console.log(JSON.stringify({ restarted: seen, keptFlags, privateFilesLeft: envFiles.filter(file => /omp-bun-env-/.test(file) && fs.existsSync(file)) }));
	process.exit(0);
}
await Bun.write(${JSON.stringify(firstOut)}, JSON.stringify({ seen, flags: process.execArgv.filter(arg => !arg.startsWith("--env-file") && !arg.startsWith("--no-env-file")) }));
for (const [name, text] of Object.entries(${JSON.stringify(c.late ?? {})})) await Bun.write(${JSON.stringify(start)} + "/" + name, text);
const { declareWorkerHostEntry } = await import(${JSON.stringify(workerHostTs)});
const { resolveCliEntryCmd } = await import(${JSON.stringify(workerClientTs)});
const { execReplace } = await import(${JSON.stringify(nativesIndexJs)});
// This script is the CLI entry, as src/cli.ts is.
declareWorkerHostEntry();
// The session moved into another project directory (setProjectDir) before /restart.
process.chdir(${JSON.stringify(elsewhere)});
const command = resolveCliEntryCmd();
await Bun.write(${JSON.stringify(path.join(tempRoot, "command.json"))}, JSON.stringify(command));
// As InteractiveMode.restart() does on POSIX.
execReplace([...command, "restarted"]);
`,
		);
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		// The default mode, as a developer's shell has it (bun test sets NODE_ENV=test).
		for (const name of ["NODE_ENV", "BUN_ENV", "BUN_OPTIONS", ...NAMES]) delete env[name];
		Object.assign(env, c.env);
		for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
		// Bun's own `.env` loading on, as the npm package's `#!/usr/bin/env bun` script starts.
		const command = c.shell
			? [
					"bash",
					"-c",
					c.shell
						.replaceAll("$BUN", JSON.stringify(process.execPath))
						.replaceAll("$SESSION", JSON.stringify(script)),
				]
			: [process.execPath, ...(c.flags ?? []), script];
		const child = Bun.spawn(command, { cwd: start, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const { restarted, keptFlags, privateFilesLeft } = JSON.parse(stdout);
		const first = JSON.parse(await fs.readFile(firstOut, "utf8"));
		const relaunch: string[] = JSON.parse(await fs.readFile(path.join(tempRoot, "command.json"), "utf8"));
		return {
			first: first.seen,
			firstFlags: first.flags,
			restarted,
			keptFlags,
			privateFilesLeft,
			relaunch,
			script,
			elsewhere,
			env,
		};
	}

	const cases: [string, Case][] = [
		["NODE_ENV unset", {}],
		["NODE_ENV=staging (Bun's development mode)", { env: { NODE_ENV: "staging" } }],
		["NODE_ENV=Production (Bun's development mode)", { env: { NODE_ENV: "Production" } }],
		["BUN_ENV=production, NODE_ENV unset", { env: { BUN_ENV: "production" } }],
		["BUN_ENV empty, NODE_ENV=production", { env: { BUN_ENV: "", NODE_ENV: "production" } }],
		["BUN_ENV=test, NODE_ENV=production", { env: { BUN_ENV: "test", NODE_ENV: "production" } }],
		["a start directory whose path holds a comma", { dir: "proj,v2" }],
		["--env-file=a.env,b.env", { flags: ["--env-file=a.env,b.env"] }],
		["a .env.local made after the launch", { without: [".env.local"], late: { ".env.local": "FROM_LOCAL=late\n" } }],
		["bunfig.toml env = false", { extra: { "bunfig.toml": "env = false\n" } }],
		["an --env-file that is a pipe", { shell: `exec $BUN --env-file=<(printf 'FROM_PIPE=pipe\\n') $SESSION` }],
		// BUN_OPTIONS applies in every process Bun starts: its other flags stay, its --env-file goes.
		["BUN_OPTIONS=--smol --env-file=b.env", { env: { BUN_OPTIONS: "--smol --env-file=b.env" } }],
	];

	for (const [label, c] of cases) {
		it.skipIf(process.platform !== "linux")(
			`starts with the values Bun's own loading gave the first launch: ${label}`,
			async () => {
				const { first, firstFlags, restarted, keptFlags, privateFilesLeft } = await restart(c);

				expect(restarted).toEqual(first);
				expect(keptFlags).toEqual(firstFlags);
				expect(privateFilesLeft).toEqual([]);
			},
			120_000,
		);
	}

	it.skipIf(process.platform === "win32")(
		"where the launch environment cannot be read (as on macOS or Windows), runs the pre-PR command: Bun loads the .env files of the directory the session is in",
		async () => {
			// The seam: env.ts reads no launch environment, as a non-compiled omp on macOS or Windows.
			const { restarted, privateFilesLeft, relaunch, script, elsewhere, env } = await restart({
				env: { PI_TEST_NO_LAUNCH_ENV: "1" },
			});
			// What the pre-PR command, `[bun, entry]`, gives in that directory: Bun's own loading there.
			const probe = path.join(tempRoot, "pre-pr-probe.ts");
			await Bun.write(
				probe,
				`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(NAMES)}.map(name => [name, process.env[name] ?? null]))));\n`,
			);
			const direct = Bun.spawnSync([process.execPath, probe], { cwd: elsewhere, env, stderr: "pipe" });
			expect(direct.stderr.toString()).toBe("");
			const prePr = JSON.parse(direct.stdout.toString());
			expect(prePr.ONLY_ELSEWHERE).toBe("yes");

			expect(restarted).toEqual(prePr);
			expect(relaunch).toEqual([process.execPath, script]);
			expect(privateFilesLeft).toEqual([]);
		},
		120_000,
	);
});
