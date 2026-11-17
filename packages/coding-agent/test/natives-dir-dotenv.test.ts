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
