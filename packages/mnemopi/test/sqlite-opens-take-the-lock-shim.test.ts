/**
 * Mnemopi's bank open takes the SQLite lock shim (#15586), also in a process that never ran the omp CLI
 * entry. A holder process keeps the bank open with the shim's open-file-description locks, as an omp
 * session does, then a second process opens the bank. Linux makes the two lock kinds conflict, so there
 * the test also reads `/proc/locks`; gVisor does not, and an open without the shim waits about 10 s per
 * statement, so the test bounds the time.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.resolve(import.meta.dir, "fixtures", "sqlite-lock-shim-probe.ts");
const tempDirs: TempDir[] = [];
const hasProcLocks = process.platform === "linux" && existsSync("/proc/locks");

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

function probeEnv(dir: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: dir,
		PI_CODING_AGENT_DIR: path.join(dir, "agent"),
		XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
		XDG_DATA_HOME: path.join(dir, "xdg-data"),
		XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
		XDG_STATE_HOME: path.join(dir, "xdg-state"),
	};
	for (const key of ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "OMP_CONFIG_ROOT"]) delete env[key];
	return env;
}

/** Reads the holder's stdout up to its `READY` line; the holder's stderr only once it has exited without it. */
async function waitForReady(holder: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	for await (const line of readLines(holder.stdout)) {
		if (new TextDecoder().decode(line).trim() === "READY") return;
	}
	throw new Error(`the holder exited before READY: ${await new Response(holder.stderr).text()}`);
}

test("a bank opens next to an omp session holding it, with the session's lock kind", async () => {
	const tempDir = TempDir.createSync("@sqlite-lock-shim-");
	tempDirs.push(tempDir);
	const dir = tempDir.path();
	const cwd = path.resolve(import.meta.dir, "..");
	const holder = Bun.spawn([process.execPath, probePath, "hold", "bank", dir], {
		cwd,
		env: probeEnv(dir),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await waitForReady(holder);

		const opener = Bun.spawn([process.execPath, probePath, "open", "bank", dir], {
			cwd,
			env: probeEnv(dir),
			stdout: "pipe",
			stderr: "pipe",
		});
		// A lock-kind mismatch costs about 10 s per statement; past 15 s the open has failed already.
		const timer = setTimeout(() => opener.kill(), 15_000);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(opener.stdout).text(),
			new Response(opener.stderr).text(),
			opener.exited,
		]);
		clearTimeout(timer);
		expect(opener.signalCode, "the bank's open did not finish within 15 s").toBeNull();
		expect(exitCode, stderr).toBe(0);
		const { ms, kinds } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { ms: number; kinds: string[] };
		if (hasProcLocks) expect(kinds).toEqual(["OFDLCK"]);
		// Well under a second; a lock-kind mismatch under gVisor costs about 10 s per statement.
		expect(ms).toBeLessThan(5_000);
	} finally {
		holder.stdin.end();
		await holder.exited;
	}
}, 120_000);
