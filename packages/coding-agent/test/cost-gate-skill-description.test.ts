import { afterAll, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fixture = path.join(import.meta.dir, "fixtures/cost-gate-skill-description.ts");
// Removed after all tests, including one that timed out, which never reaches its own cleanup.
const homes = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cost-gate-homes-"));
afterAll(() => fs.rmSync(homes, { recursive: true, force: true }));

async function run(mode: "supplied" | "root" | "metered" | "queued"): Promise<{ calls: number; spent: number }> {
	// The fixture must run outside the test runtime, which the CI runner marks on every child via PI_TEST_RUNTIME.
	// As production it reads its home's `.env` files (an OTEL collector, a broker) and writes its logs there,
	// so it gets a home of its own.
	const home = fs.mkdtempSync(path.join(homes, "home-"));
	// `Bun.spawn`, not `Bun.$`: a fixture still waiting when its test times out is killed with the test.
	const child = Bun.spawn([process.execPath, fixture, mode], {
		env: {
			...process.env,
			PI_TEST_RUNTIME: undefined,
			HOME: home,
			USERPROFILE: home,
			// Bun keeps its transpiled modules under the home; without them each fixture compiles omp anew.
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(os.homedir(), ".bun", "install", "cache", "@t@"),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return JSON.parse(stdout);
}

it("refuses startup skill compression when the supplied session-tree gate is exhausted", async () => {
	expect(await run("supplied")).toEqual({ calls: 0, spent: 1 });
});

it("refuses startup skill compression when the root gate starts at the cap", async () => {
	expect(await run("root")).toEqual({ calls: 0, spent: 1 });
});

it("meters completed background skill compression against the session tree", async () => {
	expect(await run("metered")).toEqual({ calls: 1, spent: 1.25 });
});

it("refuses queued skill compression on a non-fetch provider when another request reaches the cap", async () => {
	expect(await run("queued")).toEqual({ calls: 1, spent: 1 });
});
