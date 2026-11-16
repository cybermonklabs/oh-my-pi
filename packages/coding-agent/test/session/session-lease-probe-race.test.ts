import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { probeSessionLeases } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { type FileLockHandle, isFileLockHeld, TempDir, tryAcquireFileLock } from "@oh-my-pi/pi-utils";

const FILE_LOCK_MODULE = path.join(import.meta.dir, "../../../utils/src/file-lock.ts");

/**
 * Release-then-claim rounds of one run. Where a probe disturbs claims (seen
 * under gVisor), it fails a few in 100,000 and at times hundreds, so a run
 * this long meets a failure almost surely; the two runs take about a minute.
 */
const CLAIM_ROUNDS = 250_000;
/** Leases other sessions hold while this one probes. */
const OTHER_LEASES = 1000;
const FREE_IDS = 200;
/**
 * A probe that asks the kernel about one name costs tens of microseconds an id
 * whatever else is held (under 10 ms for the 200), and one read of the names
 * held costs a few milliseconds for the whole call. This bound leaves either
 * thirty-fold room; a probe that walks every held name again for each id takes
 * several times longer than it.
 */
const PROBE_BOUND_MS = 300;

function uniqueId(label: string): string {
	return `lease-race-${label}-${process.pid}-${Bun.nanoseconds()}`;
}

/**
 * Another process claims and releases the lease of `target` `rounds` times as
 * fast as it can; with `probe`, this process probes that lease in a loop
 * meanwhile. Returns the claims that process lost and how often the probe saw
 * the lease held (proving the two overlapped).
 */
async function raceClaims(dir: TempDir, target: string, rounds: number, probe: boolean) {
	const script = dir.join("claimer.ts");
	await Bun.write(
		script,
		[
			`import { tryAcquireFileLock } from ${JSON.stringify(FILE_LOCK_MODULE)};`,
			"const [target, rounds] = process.argv.slice(2);",
			"let failures = 0;",
			"for (let i = 0; i < Number(rounds); i++) {",
			"	const lease = tryAcquireFileLock(target);",
			"	if (lease) lease.release();",
			"	else failures++;",
			"}",
			'process.stdout.write(JSON.stringify({ failures }) + "\\n");',
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, script, target, String(rounds)], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const output = new Response(child.stdout).text();
	const errors = new Response(child.stderr).text();
	let sawHeld = 0;
	if (probe) {
		let exited = false;
		void child.exited.then(() => {
			exited = true;
		});
		while (!exited) {
			for (let i = 0; i < 100; i++) {
				if (isFileLockHeld(target)) sawHeld++;
			}
			// A zero-delay yield, not a wait: lets the event loop deliver the child's exit.
			await Bun.sleep(0);
		}
	}
	expect(await child.exited, await errors).toBe(0);
	const { failures } = JSON.parse((await output).trim().split("\n").at(-1) ?? "{}") as { failures: number };
	return { failures, sawHeld };
}

describe("session lease probe beside claims", () => {
	// A lease that was released is free: the next claim takes it. A claim a
	// probe makes fail reads as "another process writes this session", and the
	// claimant moves its session to another file.
	it("never makes a claim that follows a release fail", async () => {
		using dir = TempDir.createSync("@omp-lease-race-");
		const control = await raceClaims(dir, dir.join("unprobed"), CLAIM_ROUNDS, false);
		const probed = await raceClaims(dir, dir.join("probed"), CLAIM_ROUNDS, true);
		expect(probed.sawHeld).toBeGreaterThan(0);
		expect({ failedWithoutProbe: control.failures, failedWithProbe: probed.failures }).toEqual({
			failedWithoutProbe: 0,
			failedWithProbe: 0,
		});
	}, 120_000);

	// `omp session lease` and RPC `get_session_lease` probe many ids in one
	// synchronous call. Its time must not grow with the leases other sessions
	// hold, or a busy host blocks the caller for seconds.
	it("probes 200 free ids within the bound while 1,000 other leases are held", () => {
		using dir = TempDir.createSync("@omp-lease-load-");
		const ids = Array.from({ length: FREE_IDS }, (_, index) => uniqueId(`free-${index}`));
		const held: FileLockHandle[] = [];
		try {
			for (let index = 0; index < OTHER_LEASES; index++) {
				const lease = tryAcquireFileLock(dir.join(`other-${index}`));
				if (!lease) throw new Error(`lease other-${index} is held already`);
				held.push(lease);
			}
			// The quickest of three calls, so one stall of the host does not decide it.
			let quickestMs = Number.POSITIVE_INFINITY;
			for (let call = 0; call < 3; call++) {
				const start = Bun.nanoseconds();
				const report = probeSessionLeases(ids);
				quickestMs = Math.min(quickestMs, (Bun.nanoseconds() - start) / 1e6);
				expect(report).toEqual({ held: [], unknown: [] });
			}
			expect(quickestMs).toBeLessThanOrEqual(PROBE_BOUND_MS);
		} finally {
			for (const lease of held) lease.release();
		}
	}, 60_000);
});
