/**
 * A disposed session lets go of the messages its newest main request recorded (the request's prompt cache arm), as it
 * lets go of the rest of its conversation: a parked subagent's lifecycle record still reaches the disposed session
 * object, and the arm's copy of the messages would keep every one of them.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * The check runs in a process of its own with concurrent JIT compilation off: in a process that has warmed the
 * session code, an optimizing-JIT plan on a background thread can keep the reply reachable.
 */
async function probeReply(reference: "dropped" | "held"): Promise<boolean> {
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "fixtures/prompt-cache-arm-release-probe.ts"), reference],
		{
			cwd: path.join(import.meta.dir, "../../.."),
			env: { ...process.env, BUN_JSC_useConcurrentJIT: "0" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const result = JSON.parse(stdout) as { collected: boolean; held: boolean; disposed: boolean };
	expect(result.disposed).toBe(true);
	expect(result.held).toBe(reference === "held");
	return result.collected;
}

describe("the newest main request's record of a disposed session", () => {
	it("lets the turn's reply be collected while the disposed session is still reachable", async () => {
		expect(await probeReply("dropped")).toBe(true);
	}, 30_000);

	it("keeps a reply something else still holds (control)", async () => {
		expect(await probeReply("held")).toBe(false);
	}, 30_000);
});
