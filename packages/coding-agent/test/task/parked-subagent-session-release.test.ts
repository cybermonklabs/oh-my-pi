/**
 * A kept-alive subagent that parks must release its AgentSession while its
 * adoption (and therefore revivability) survives. The lifecycle manager holds
 * the run's reviver closure for as long as the agent stays adopted, so anything
 * that closure keeps reachable is retained for the life of the process; a
 * reviver that pins the disposed session leaks one full session graph per
 * spawned subagent.
 *
 * Each check runs in a process of its own with concurrent JIT compilation off:
 * in a process that has warmed the session code, an optimizing-JIT plan on a
 * background thread can keep the watched object reachable for seconds, so a
 * collection there says little about what the reviver holds.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";

const probePath = path.join(import.meta.dir, "../fixtures/parked-subagent-release-probe.ts");

interface ProbeResult {
	collected: boolean;
	waitedMs: number;
	parked?: { status?: string; session: unknown };
	adoptedAtPark?: boolean;
	adoptedAfter?: boolean;
	revivedSetting?: boolean;
}

/** Runs the probe for `watched` in a process of its own; `held` keeps the watched object (the control). */
async function probe(watched: "session" | "settings", reference: "dropped" | "held"): Promise<ProbeResult> {
	const child = Bun.spawn([process.execPath, probePath, watched, reference], {
		cwd: path.join(import.meta.dir, "../../../.."),
		env: { ...process.env, BUN_JSC_useConcurrentJIT: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as ProbeResult;
}

it("releases a parked keep-alive subagent's session while the agent stays revivable", async () => {
	const result = await probe("session", "dropped");
	expect(result.parked).toEqual({ status: "parked", session: null });
	expect(result.adoptedAtPark).toBe(true);
	expect(result.collected, `the parked session is still reachable after ${result.waitedMs} ms of collections`).toBe(
		true,
	);
	// Still adopted after collection: the release did not come from dropping the reviver.
	expect(result.adoptedAfter).toBe(true);
}, 30_000);

it("parks without retaining the run's settings overlay and revives with the settings it wrote", async () => {
	const result = await probe("settings", "dropped");
	// The reviver held the run's whole overlay — merged view, memoized values, listener buckets —
	// for as long as the parked agent stayed adopted.
	expect(
		result.collected,
		`the run's settings overlay is still reachable after ${result.waitedMs} ms of collections`,
	).toBe(true);
	expect(result.revivedSetting).toBe(true);
}, 30_000);

it("keeps a parked session something else still holds (control)", async () => {
	expect((await probe("session", "held")).collected).toBe(false);
}, 30_000);

it("keeps a run's settings overlay something else still holds (control)", async () => {
	expect((await probe("settings", "held")).collected).toBe(false);
}, 30_000);
