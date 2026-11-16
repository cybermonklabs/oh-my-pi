import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/session-storage.ts");
const CLI = path.join(import.meta.dir, "../../src/cli.ts");
/** Sessions another process writes while this one asks for their leases. */
const HELD_ELSEWHERE = 20;
/**
 * Asking for one lease another process holds is one probe of the kernel, well
 * under a millisecond; the bound leaves room for a loaded host. A claim waits
 * about 50 ms on each lease another process holds: over 1,000 ms for the 20.
 */
const HELD_ELSEWHERE_BOUND_MS = 250;

function uniqueId(label: string): string {
	return `lease-probe-${label}-${process.pid}-${Bun.nanoseconds()}`;
}

/**
 * Run a script in another process with this test's environment, so it meets
 * the same private session-owner directory (exported when session-storage loads).
 */
function spawnScript(tempDir: TempDir, name: string, body: string[], args: string[]) {
	const script = tempDir.join(name);
	return Bun.write(
		script,
		[`import { FileSessionStorage } from ${JSON.stringify(SESSION_STORAGE_MODULE)};`, ...body].join("\n"),
	).then(() =>
		Bun.spawn([process.execPath, script, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		}),
	);
}

/** Another process that claims each of `sessionIds` like a writing omp, reports `claimed`, and holds them until stdin closes. */
async function spawnOwner(tempDir: TempDir, ...sessionIds: string[]) {
	const child = await spawnScript(
		tempDir,
		"owner.ts",
		[
			"const [sessionPath, ...ids] = process.argv.slice(2);",
			"const storage = new FileSessionStorage();",
			"const releases = ids.map(id => storage.claimSession(id, sessionPath));",
			'process.stdout.write(releases.every(Boolean) ? "claimed\\n" : "refused\\n");',
			"for await (const _ of console) {}",
		],
		[tempDir.join("owner-session.jsonl"), ...sessionIds],
	);
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	expect(new TextDecoder().decode(value).trim()).toBe("claimed");
	return child;
}

/**
 * Probe `sessionId` in a tight loop while another process claims and releases
 * it `rounds` times. Returns that process's failed claims and how often the
 * probe saw the lease held (proving the two actually overlapped).
 */
async function raceProbeAgainstClaims(tempDir: TempDir, sessionId: string, rounds: number) {
	const child = await spawnScript(
		tempDir,
		"claimer.ts",
		[
			"const [id, sessionPath, rounds] = process.argv.slice(2);",
			"const storage = new FileSessionStorage();",
			"let failures = 0;",
			"for (let i = 0; i < Number(rounds); i++) {",
			"	const release = storage.claimSession(id, sessionPath);",
			"	if (release) release();",
			"	else failures++;",
			"}",
			'process.stdout.write(JSON.stringify({ failures }) + "\\n");',
		],
		[sessionId, tempDir.join("claimer-session.jsonl"), String(rounds)],
	);
	const output = new Response(child.stdout).text();
	let probes = 0;
	let sawHeld = 0;
	let exited = false;
	void child.exited.then(() => {
		exited = true;
	});
	while (!exited) {
		for (let i = 0; i < 500; i++) {
			probes++;
			if (isSessionLeaseHeld(sessionId)) sawHeld++;
		}
		// A zero-delay yield, not a wait: lets the event loop deliver the child's exit.
		await Bun.sleep(0);
	}
	const stdout = await output;
	expect(child.exitCode, await new Response(child.stderr).text()).toBe(0);
	const { failures } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { failures: number };
	return { failures, probes, sawHeld };
}

describe("session lease probe", () => {
	it("reports a lease another process holds, and frees it when that process exits", async () => {
		using tempDir = TempDir.createSync("@omp-lease-probe-");
		const sessionId = uniqueId("owner");
		expect(isSessionLeaseHeld(sessionId)).toBe(false);

		const owner = await spawnOwner(tempDir, sessionId);
		expect(isSessionLeaseHeld(sessionId)).toBe(true);

		owner.stdin.end();
		await owner.exited;
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	}, 30_000);

	it("refuses at once each of 20 leases another process holds, and grants them once it exits", async () => {
		// `omp gc` and the checks of whether a journal is running ask for the
		// lease of every session they meet. Answering a lease held elsewhere
		// after a claim's wait blocks them about 50 ms for each session another
		// omp runs: about a second beside 20 of them.
		using tempDir = TempDir.createSync("@omp-lease-elsewhere-");
		const sessionIds = Array.from({ length: HELD_ELSEWHERE }, (_, index) => uniqueId(`elsewhere-${index}`));
		const owner = await spawnOwner(tempDir, ...sessionIds);
		try {
			// The quickest of three passes, so one stall of the host does not decide it.
			let quickestMs = Number.POSITIVE_INFINITY;
			for (let pass = 0; pass < 3; pass++) {
				const start = Bun.nanoseconds();
				const leases = sessionIds.map(id => tryAcquireSessionLease(id));
				quickestMs = Math.min(quickestMs, (Bun.nanoseconds() - start) / 1e6);
				for (const lease of leases) lease?.release();
				expect(leases).toEqual(sessionIds.map(() => null));
			}
			expect(quickestMs).toBeLessThanOrEqual(HELD_ELSEWHERE_BOUND_MS);
		} finally {
			owner.stdin.end();
			await owner.exited;
		}
		const leases = sessionIds.map(id => tryAcquireSessionLease(id));
		for (const lease of leases) lease?.release();
		expect(leases.map(lease => lease !== null)).toEqual(sessionIds.map(() => true));
	}, 30_000);

	it("counts a lease this process holds as held", () => {
		using tempDir = TempDir.createSync("@omp-lease-self-");
		const sessionId = uniqueId("self");
		const release = new FileSessionStorage().claimSession(sessionId, tempDir.join("self.jsonl"));
		expect(release).not.toBeNull();
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		release?.();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("never makes a concurrent claim fail", async () => {
		using tempDir = TempDir.createSync("@omp-lease-race-");
		const { failures, probes, sawHeld } = await raceProbeAgainstClaims(tempDir, uniqueId("claim"), 3000);
		expect(failures).toBe(0);
		expect(sawHeld).toBeGreaterThan(0);
		expect(probes).toBeGreaterThan(sawHeld);
	}, 60_000);

	it("`omp session lease --json` lists held ids and treats free and garbage ids as not held", async () => {
		using tempDir = TempDir.createSync("@omp-lease-cli-");
		const heldId = uniqueId("held");
		// Not a plain token, so claim and probe must agree on the hashed lease name.
		const hashedHeldId = `${uniqueId("hashed")} with space/../x`;
		const owner = await spawnOwner(tempDir, heldId);
		const hashedOwner = await spawnOwner(tempDir, hashedHeldId);
		try {
			const ids = [heldId, uniqueId("free"), "../../etc/passwd", "", "-dash", "x".repeat(300), hashedHeldId];
			const result = Bun.spawnSync([process.execPath, CLI, "session", "lease", "--json", "--", ...ids], {
				env: { ...process.env, PI_CODING_AGENT_DIR: tempDir.join("agent") },
			});
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(JSON.parse(result.stdout.toString())).toEqual({ held: [heldId, hashedHeldId], unknown: [] });
		} finally {
			for (const child of [owner, hashedOwner]) {
				child.stdin.end();
				await child.exited;
			}
		}
	}, 60_000);
});
