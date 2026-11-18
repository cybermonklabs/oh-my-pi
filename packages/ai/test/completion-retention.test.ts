import { describe, expect, test } from "bun:test";
import * as path from "node:path";

/** How long a fixture child may run once it has printed its verdict before it counts as stuck. */
const EXIT_AFTER_VERDICT_MS = 5_000;

/**
 * Runs a fixture child to its verdict. It may take as long as the machine's load makes it,
 * up to the test's own timeout; once it has printed `verified`, it must exit within
 * {@link EXIT_AFTER_VERDICT_MS} (a real-time bound on a real process, so no fake clock), or it
 * is killed and its output reported, since a timer left armed after `complete()` settles would
 * keep it alive.
 */
async function runToVerdict(command: string[]) {
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	let stdout = "";
	let lingered = false;
	let exitClock: Timer | undefined;
	const decoder = new TextDecoder();
	const readStdout = (async () => {
		for await (const chunk of child.stdout) {
			stdout += decoder.decode(chunk, { stream: true });
			if (exitClock === undefined && stdout.includes("verified\n")) {
				exitClock = setTimeout(() => {
					lingered = true;
					child.kill("SIGKILL");
				}, EXIT_AFTER_VERDICT_MS);
			}
		}
	})();
	try {
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited, readStdout]);
		return { exitCode, stderr, stdout, lingered };
	} finally {
		clearTimeout(exitClock);
		child.kill("SIGKILL");
	}
}

describe("completion event retention", () => {
	// Each case's verdict is its child's output: the case waits for it however long the machine's
	// load makes the child take, then gives the child a short clock to exit (runToVerdict).
	for (const completion of ["complete", "completeSimple"]) {
		for (const outcome of ["success", "failure"]) {
			test(`${completion} releases events before ${outcome} settles the response`, async () => {
				const result = await runToVerdict([
					process.execPath,
					path.join(import.meta.dir, "fixtures/completion-retention.ts"),
					completion,
					outcome,
				]);
				expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "verified\n", lingered: false });
			}, 15_000);
		}
	}
});
