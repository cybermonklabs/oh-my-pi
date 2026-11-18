/**
 * Regression test for #7235: Bash auto-background must release the threshold
 * timer once the command finishes first, instead of leaving a live `Bun.sleep`
 * timer that keeps the event loop alive until the threshold expires (delaying
 * SDK/headless shutdown). Timer keep-alive is only observable in a child
 * process, so this spawns the real BashTool auto-background path against a 30s
 * threshold and asserts the process exits on its own.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";

const PROBE_PATH = path.join(import.meta.dir, "fixtures", "bash-autobg-exit-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
// THRESHOLD_MS in the probe. A retained threshold timer holds the child for this long after its
// command starts, so a test timeout no longer than it fails on any machine.
const PROBE_THRESHOLD_MS = 30_000;

let probe: Bun.Subprocess | undefined;

afterEach(() => {
	// A child held by the timer outlives the timed-out test; never leave it running.
	if (probe?.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL");
	probe = undefined;
});

describe("bash auto-background threshold timer (#7235)", () => {
	it(
		"does not keep the event loop alive after a fast command completes",
		async () => {
			// The contract is that the child's event loop empties by itself once the command has won
			// the race, not how soon: the test waits for the exit itself and asserts no wall-clock
			// figure. A loaded host only delays a fixed child's exit; a retained threshold timer holds
			// the child past this test's timeout, which equals the threshold.
			const proc = Bun.spawn([process.execPath, PROBE_PATH], {
				cwd: REPO_ROOT,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			probe = proc;
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.trim())).toEqual({ done: true, output: "hi" });
		},
		PROBE_THRESHOLD_MS,
	);
});
