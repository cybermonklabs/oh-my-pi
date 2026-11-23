/**
 * Metaharness' SQLite stores take the lock shim (#15586), also in a process that never ran the omp CLI
 * entry. Each row starts a holder process that keeps the store's file open with the shim's
 * open-file-description locks, as an omp process does, then opens the store in a second process. Linux
 * makes the two lock kinds conflict, so there the row also reads `/proc/locks`; gVisor does not, and an
 * open without the shim waits about 10 s per statement, so the row bounds the time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.resolve(import.meta.dir, "fixtures", "sqlite-lock-shim-probe.ts");
const tempDirs: TempDir[] = [];
const hasProcLocks = process.platform === "linux" && existsSync("/proc/locks");

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

/** Reads the holder's stdout up to its `READY` line; the holder's stderr only once it has exited without it. */
async function waitForReady(holder: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	for await (const line of readLines(holder.stdout)) {
		if (new TextDecoder().decode(line).trim() === "READY") return;
	}
	throw new Error(`the holder exited before READY: ${await new Response(holder.stderr).text()}`);
}

async function openNextToHolder(row: string): Promise<{ ms: number; kinds: string[] }> {
	const tempDir = TempDir.createSync("@sqlite-lock-shim-");
	tempDirs.push(tempDir);
	const dir = tempDir.path();
	const cwd = path.resolve(import.meta.dir, "..");
	const holder = Bun.spawn([process.execPath, probePath, "hold", row, dir], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await waitForReady(holder);

		const opener = Bun.spawn([process.execPath, probePath, "open", row, dir], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		// A lock-kind mismatch costs about 10 s per statement; past 15 s the row has failed already.
		const timer = setTimeout(() => opener.kill(), 15_000);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(opener.stdout).text(),
			new Response(opener.stderr).text(),
			opener.exited,
		]);
		clearTimeout(timer);
		expect(opener.signalCode, `${row}: the open did not finish within 15 s`).toBeNull();
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { ms: number; kinds: string[] };
	} finally {
		holder.stdin.end();
		await holder.exited;
	}
}

describe("metaharness' SQLite stores take the lock shim next to an omp process", () => {
	test.each(["run-store", "tb-store"])(
		"%s",
		async row => {
			const { ms, kinds } = await openNextToHolder(row);
			if (hasProcLocks) expect(kinds).toEqual(["OFDLCK"]);
			// Well under a second each; a lock-kind mismatch under gVisor costs about 10 s per statement.
			expect(ms).toBeLessThan(5_000);
		},
		120_000,
	);
});
