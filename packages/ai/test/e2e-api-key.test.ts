import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProductionChildEnv } from "../../../scripts/test-env";

const NAME = "E2E_KEY_PROBE_API_KEY";

/** Each case starts a bun that loads the ai package's OAuth module, as `oauth-barrel-import.test.ts` does. */
const CHILD_TIMEOUT_MS = 60_000;

/**
 * `e2eApiKey(NAME)` and then `Bun.env[NAME]`, as a test child (`PI_TEST_RUNTIME=1`, so the loader
 * reads no home `.env`) whose home's `.env` files set `NAME` as `files` says.
 */
async function probe(env: Record<string, string>, files: Record<string, string>): Promise<unknown> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ai-e2e-key-"));
	try {
		for (const [file, value] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
			fs.writeFileSync(path.join(home, file), `${NAME}=${value}\n`);
		}
		// The working directory is not the home: its `.env` would be the project's, which every process loads.
		const project = path.join(home, "project");
		fs.mkdirSync(project);
		const oauth = path.join(import.meta.dir, "oauth.ts");
		const script = `import { e2eApiKey } from ${JSON.stringify(oauth)}; const key = e2eApiKey(${JSON.stringify(NAME)}); process.stdout.write(JSON.stringify({ key: key ?? null, env: Bun.env[${JSON.stringify(NAME)}] ?? null }));`;
		const childEnv: Record<string, string> = { ...createProductionChildEnv(), HOME: home, USERPROFILE: home };
		delete childEnv.E2E;
		delete childEnv[NAME];
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: project,
			env: { ...childEnv, PI_TEST_RUNTIME: "1", ...env },
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
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("e2eApiKey", () => {
	it(
		"reads a key from the home's .env in an E2E run, which a test process does not load",
		async () => {
			expect(await probe({ E2E: "1" }, { ".env": "from-home" })).toEqual({ key: "from-home", env: "from-home" });
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"takes the agent dir's .env over the config root's and the home's, as the loader does",
		async () => {
			const files = { ".env": "from-home", ".omp/.env": "from-config-root", ".omp/agent/.env": "from-agent" };
			expect(await probe({ E2E: "1" }, files)).toEqual({ key: "from-agent", env: "from-agent" });
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"takes the environment over the files",
		async () => {
			expect(await probe({ E2E: "1", [NAME]: "from-env" }, { ".env": "from-home" })).toEqual({
				key: "from-env",
				env: "from-env",
			});
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"gives no key outside an E2E run",
		async () => {
			expect(await probe({}, { ".env": "from-home" })).toEqual({ key: null, env: null });
		},
		CHILD_TIMEOUT_MS,
	);
});
