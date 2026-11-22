/**
 * A process that runs many task subagents keeps, for each subagent it has parked, only the plain data of its
 * registry record: no Map, function or closure of the finished run. The probe runs real kept-alive subagents under
 * a root session in its own process and reports the heap growth per parked subagent of its second batch; its first
 * batch pays every once-per-process cost.
 *
 * Compiled code is counted in the heap, so the probe runs with the JIT off and has the engine drop the code of
 * functions that stopped running at the next collection instead of seconds later. With the JIT on, tier-ups and
 * aged-out code moved the heap by up to 1 MB between two readings (up to 25 KB per subagent at 40 a batch); with
 * the JIT off alone, code that ran only in the first batch was still counted in its reading in a fast run, and the
 * growth per subagent ranged from -115 to +4 KB. With both, five runs gave 696, 743, 812, 769 and 762 B (see
 * {@link MAX_HEAP_BYTES_PER_PARKED_SUBAGENT}).
 */
import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.join(import.meta.dir, "../fixtures/parked-subagent-heap-probe.ts");
/** Subagents per batch: after 20 the process is warm, and the next 20 each add the same amount. */
const SUBAGENTS_PER_BATCH = 20;
/**
 * Measured per parked subagent at 20 a batch: 2.9 KB while the lifecycle kept each run's reviver closure, 2.0 KB
 * with no closure kept, 45 KB when each run's transcript stays reachable, 389 KB when its session does. With its
 * revive inputs in its transcript, five runs gave 696, 743, 812, 769 and 762 B; with them in memory again, 1,485
 * and 1,541 B (the executor from before they moved to the transcript) and 1,528 and 1,592 B (each record also held
 * in a module-level array). This probe runs with the JIT off and reads about two thirds of what the compiled
 * build's heap check measures, so a bound of 2,000 B here would let through a parked subagent that check's 2,048 B
 * bar fails; 1,200 B leaves the largest reading 32% below it and fails both of those.
 */
const MAX_HEAP_BYTES_PER_PARKED_SUBAGENT = 1_200;

interface PerParkedSubagent {
	heapSize: number;
	Map: number;
	Function: number;
	AsyncFunction: number;
	ModuleRecord: number;
	CommonJSModule: number;
}

function isPerParkedSubagent(value: unknown): value is PerParkedSubagent {
	if (typeof value !== "object" || value === null) return false;
	const fields: Record<string, unknown> = { ...value };
	return ["heapSize", "Map", "Function", "AsyncFunction", "ModuleRecord", "CommonJSModule"].every(
		key => typeof fields[key] === "number",
	);
}

/** Runs the probe; returns its JSON line and the growth per parked subagent it reports. */
async function probe(root: string): Promise<{ output: string; perParkedSubagent: PerParkedSubagent }> {
	const child = Bun.spawn([process.execPath, probePath, root, String(SUBAGENTS_PER_BATCH)], {
		cwd: path.join(import.meta.dir, "../../../.."),
		env: {
			...process.env,
			HOME: path.join(root, "home"),
			USERPROFILE: path.join(root, "home"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			BUN_JSC_useJIT: "0",
			BUN_JSC_useEagerCodeBlockJettisonTiming: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const output = stdout.trim();
	const result: unknown = JSON.parse(output);
	if (typeof result !== "object" || result === null || !("perParkedSubagent" in result)) {
		throw new Error(`Unexpected probe output: ${output}`);
	}
	const { perParkedSubagent } = result;
	if (!isPerParkedSubagent(perParkedSubagent)) throw new Error(`Unexpected probe output: ${output}`);
	return { output, perParkedSubagent };
}

// If this regresses, the memory of a long session that runs many subagents grows with every subagent it parks and
// is never given back: each parked subagent keeps a closure, and whatever the closure reaches, for the rest of the
// process.
it("keeps no Map, function or closure for each parked subagent", async () => {
	using tempDir = TempDir.createSync("@omp-parked-subagent-heap-");
	const { output, perParkedSubagent } = await probe(tempDir.path());
	expect(perParkedSubagent.Map, output).toBeLessThan(0.5);
	expect(perParkedSubagent.Function, output).toBeLessThan(0.5);
	expect(perParkedSubagent.AsyncFunction, output).toBeLessThan(0.5);
	// A module a subagent's session loads (an extension, a plugin) is loaded once per process, not per subagent.
	expect(perParkedSubagent.ModuleRecord, output).toBeLessThan(0.5);
	expect(perParkedSubagent.CommonJSModule, output).toBeLessThan(0.5);
	expect(perParkedSubagent.heapSize, output).toBeLessThan(MAX_HEAP_BYTES_PER_PARKED_SUBAGENT);
}, 180_000);
