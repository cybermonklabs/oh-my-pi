import { describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProductionChildEnv } from "../../../scripts/test-env";

/** The key a suite asks `e2eApiKey` for, a setting beside it, and an exporter setting. */
const KEY = "E2E_KEY_PROBE_API_KEY";
const BESIDE = "E2E_KEY_PROBE_SESSION_TOKEN";
const OTEL = "OTEL_E2E_KEY_PROBE";

/** Each case starts a bun that loads the ai package's OAuth module, as `oauth-barrel-import.test.ts` does. */
const CHILD_TIMEOUT_MS = 60_000;

type Files = Partial<Record<".env" | ".omp/.env" | ".omp/agent/.env", string>>;

/**
 * `e2eApiKey(lookup)`, and then the values of {@link KEY}, {@link BESIDE} and {@link OTEL} in
 * `Bun.env`, as a test child (`PI_TEST_RUNTIME=1`, so omp's loader reads no home `.env`) whose
 * home's dotenv files hold `files`.
 */
async function probe(env: Record<string, string>, files: Files, lookup = KEY): Promise<unknown> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ai-e2e-key-"));
	try {
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
			fs.writeFileSync(path.join(home, file), text);
		}
		// The working directory is not the home: its `.env` would be the project's, which every process loads.
		const project = path.join(home, "project");
		fs.mkdirSync(project);
		const oauth = path.join(import.meta.dir, "oauth.ts");
		const script = `import { e2eApiKey } from ${JSON.stringify(oauth)}; const key = e2eApiKey(${JSON.stringify(lookup)}); process.stdout.write(JSON.stringify({ key: key ?? null, ${[KEY, BESIDE, OTEL].map(name => `${JSON.stringify(name)}: Bun.env[${JSON.stringify(name)}] ?? null`).join(", ")} }));`;
		const childEnv: Record<string, string> = { ...createProductionChildEnv(), HOME: home, USERPROFILE: home };
		for (const name of ["E2E", KEY, BESIDE]) delete childEnv[name];
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

describe("an E2E run's environment", () => {
	it(
		"has the home's .env whole, which a test process does not load: the key and the settings beside it",
		async () => {
			const files = { ".env": `${KEY}=from-home\n${BESIDE}=token-from-home\n` };
			expect(await probe({ E2E: "1" }, files)).toEqual({
				key: "from-home",
				[KEY]: "from-home",
				[BESIDE]: "token-from-home",
				[OTEL]: null,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"takes the agent dir's .env over the config root's and the home's, as omp's loader does",
		async () => {
			const files = {
				".env": `${KEY}=from-home\n`,
				".omp/.env": `${KEY}=from-config-root\n`,
				".omp/agent/.env": `${KEY}=from-agent\n`,
			};
			expect(await probe({ E2E: "1" }, files)).toMatchObject({ key: "from-agent" });
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"does not let an empty value hide a later file's, as omp's loader does",
		async () => {
			const files = { ".env": `${KEY}=from-home\n`, ".omp/agent/.env": `${KEY}=\n` };
			expect(await probe({ E2E: "1" }, files)).toMatchObject({ key: "from-home", [KEY]: "from-home" });
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"takes the environment over the files",
		async () => {
			expect(await probe({ E2E: "1", [KEY]: "from-env" }, { ".env": `${KEY}=from-home\n` })).toMatchObject({
				key: "from-env",
			});
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"keeps OTEL_* out of the environment, as omp's loader does",
		async () => {
			expect(await probe({ E2E: "1" }, { ".env": `${OTEL}=http://collector\n` })).toMatchObject({ [OTEL]: null });
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"loads nothing outside an E2E run",
		async () => {
			const files = { ".env": `${KEY}=from-home\n${BESIDE}=token-from-home\n` };
			expect(await probe({}, files)).toEqual({ key: null, [KEY]: null, [BESIDE]: null, [OTEL]: null });
		},
		CHILD_TIMEOUT_MS,
	);

	test.skipIf(process.platform !== "win32")(
		"finds a key by a differently cased name on Windows, as the environment does",
		async () => {
			expect(await probe({ E2E: "1" }, { ".env": `${KEY}=from-home\n` }, KEY.toLowerCase())).toMatchObject({
				key: "from-home",
			});
		},
		CHILD_TIMEOUT_MS,
	);
});
