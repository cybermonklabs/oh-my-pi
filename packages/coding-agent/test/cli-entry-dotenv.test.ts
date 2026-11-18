/**
 * A non-compiled omp (the npm package's `omp` script, `bun src/cli.ts`) starts with the `.env`
 * files Bun's own loading read in its start directory. `/restart` replaces the process with
 * `execvp(3)`, which passes the environment the process was started with, not those values;
 * so the command that starts the CLI again (`resolveCliEntryCmd`) must make Bun load the same
 * files, wherever the session has moved since.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

	it.skipIf(process.platform === "win32")(
		"starts with the values of the .env files Bun loaded at the first launch, after the session moved",
		async () => {
			const start = path.join(tempRoot, "start");
			const elsewhere = path.join(tempRoot, "elsewhere");
			const home = path.join(tempRoot, "home");
			await Bun.write(path.join(start, ".env"), "FROM_ENV=start\n");
			await Bun.write(path.join(start, ".env.development"), "FROM_MODE=start\n");
			await Bun.write(path.join(start, ".env.local"), "FROM_LOCAL=start\n");
			await Bun.write(path.join(start, ".env.development.local"), "FROM_MODE_LOCAL=start\n");
			// The directory the session moved into has files of its own, which the first launch never read.
			await Bun.write(path.join(elsewhere, ".env.local"), "FROM_LOCAL=elsewhere\nONLY_ELSEWHERE=yes\n");
			await fs.mkdir(home, { recursive: true });
			const script = path.join(tempRoot, "session.ts");
			await Bun.write(
				script,
				`if (process.argv[2] === "restarted") {
	const names = ["FROM_ENV", "FROM_MODE", "FROM_LOCAL", "FROM_MODE_LOCAL", "ONLY_ELSEWHERE"];
	console.log(JSON.stringify({ cwd: process.cwd(), env: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])) }));
	process.exit(0);
}
const { declareWorkerHostEntry } = await import(${JSON.stringify(workerHostTs)});
const { resolveCliEntryCmd } = await import(${JSON.stringify(workerClientTs)});
const { execReplace } = await import(${JSON.stringify(nativesIndexJs)});
// This script is the CLI entry, as src/cli.ts is.
declareWorkerHostEntry();
// The session moved into another project directory (setProjectDir) before /restart.
process.chdir(${JSON.stringify(elsewhere)});
// As InteractiveMode.restart() does on POSIX.
execReplace([...resolveCliEntryCmd(), "restarted"]);
`,
			);
			const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
			// The default mode, as a developer's shell has it (bun test sets NODE_ENV=test).
			for (const name of [
				"NODE_ENV",
				"BUN_ENV",
				"FROM_ENV",
				"FROM_MODE",
				"FROM_LOCAL",
				"FROM_MODE_LOCAL",
				"ONLY_ELSEWHERE",
			])
				delete env[name];
			// Bun's own `.env` loading on, as the npm package's `#!/usr/bin/env bun` script starts.
			const child = Bun.spawn([process.execPath, script], { cwd: start, env, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

			expect(JSON.parse(stdout)).toEqual({
				cwd: elsewhere,
				env: {
					FROM_ENV: "start",
					FROM_MODE: "start",
					FROM_LOCAL: "start",
					FROM_MODE_LOCAL: "start",
					ONLY_ELSEWHERE: null,
				},
			});
		},
		120_000,
	);
});
