/**
 * An unsubscribed worker subscription no longer holds its listener, though the worker still holds the
 * unsubscribe. Each row runs in its own process with concurrent JIT compilation off: in a process that
 * has warmed the subscription code, an optimizing-JIT plan on a background thread can keep the listener
 * reachable, so a collection there says little about what the subscription holds.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const probePath = path.join(import.meta.dir, "../fixtures/worker-subscription-release-probe.ts");

interface ProbeResult {
	aliveWhileSubscribed: boolean;
	remaining?: number;
	runs: number;
	collected: boolean;
}

async function probe(route: "set" | "peer-cleanups", reference: "dropped" | "held"): Promise<ProbeResult> {
	const child = Bun.spawn([process.execPath, probePath, route, reference], {
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

describe("worker subscriptions on main", () => {
	it("forget their listener once unsubscribed, though the worker still holds the unsubscribe", async () => {
		const result = await probe("set", "dropped");
		expect(result.aliveWhileSubscribed).toBe(true);
		expect(result.remaining).toBe(0);
		// A held unsubscribe that kept its listener would pin the worker's listener scope through the link.
		expect(result.collected, "the unsubscribed listener is still reachable from the held unsubscribe").toBe(true);
	}, 30_000);

	it("do the same through PeerCleanups, and run each cleanup once", async () => {
		const result = await probe("peer-cleanups", "dropped");
		expect(result.aliveWhileSubscribed).toBe(true);
		expect(result.runs).toBe(1);
		expect(result.collected, "the unsubscribed listener is still reachable from the released cleanup").toBe(true);
	}, 30_000);

	it("keep a listener something else still holds (control)", async () => {
		expect((await probe("set", "held")).collected).toBe(false);
		expect((await probe("peer-cleanups", "held")).collected).toBe(false);
	}, 30_000);
});
