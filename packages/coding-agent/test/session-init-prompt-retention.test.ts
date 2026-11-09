import { expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	revisions: number;
	initCount: number;
	catalogue: number;
	skill: number;
	blockBytes: number;
	heapUsed: number;
	rss: number;
}

const probePath = path.join(import.meta.dir, "fixtures", "session-init-prompt-retention-probe.ts");

// The probe's own module constants hold one instance of each repeated block,
// and the first live revision has no earlier contract to share with, so three
// cells per block is the floor a correct run reaches. Before the fix the count
// tracked the revision count (201 of each at 100 revisions); a regression
// cannot land anywhere near the floor.
const MAX_LIVE_BLOCKS = 3;
// `Bun.gc(true)` before the snapshot does not guarantee every dropped copy has
// been reclaimed at the moment it is taken, so a single raw count is a timing
// observation (see mcp-refresh-retention.test.ts for the same hazard). GC
// residue is per-process, so a fresh process clears it: take the first run
// that settles, and only assert on the last if none do.
const MAX_ATTEMPTS = 4;

async function runProbe(): Promise<ProbeResult> {
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd: path.join(import.meta.dir, "../../.."),
		env: { ...process.env, BUN_JSC_useConcurrentJIT: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as ProbeResult;
}

test("repeated session_init prompt blocks are retained once, not once per revision", async () => {
	let last: ProbeResult | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const result = await runProbe();
		last = result;
		// Both halves of the session really recorded their revisions.
		expect(result.initCount).toBe(result.revisions * 2);
		if (result.catalogue <= MAX_LIVE_BLOCKS && result.skill <= MAX_LIVE_BLOCKS) return;
	}
	expect(last!.catalogue, `unsettled after ${MAX_ATTEMPTS} attempts`).toBeLessThanOrEqual(MAX_LIVE_BLOCKS);
	expect(last!.skill, `unsettled after ${MAX_ATTEMPTS} attempts`).toBeLessThanOrEqual(MAX_LIVE_BLOCKS);
}, 120_000);
