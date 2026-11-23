/**
 * Each store open path in coding-agent that can share its file with another omp process takes the SQLite
 * lock shim (#15586), also in a process that never ran the CLI entry (an SDK host, a script, a test's
 * child process). Each row starts a holder process that keeps the store's file open with the shim's
 * open-file-description locks, as an omp session does, then runs the store's open path in a second
 * process. Linux makes the two lock kinds conflict, so there the row also reads `/proc/locks`; gVisor
 * does not, and an open without the shim waits about 10 s per statement, so the row bounds the time.
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

function probeEnv(dir: string, row: string): Record<string, string | undefined> {
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
	// XDG relocates the hint store only for the default agent dir (~/.omp/agent): that is the adoption case.
	if (row === "hint-store-adoption") delete env.PI_CODING_AGENT_DIR;
	return env;
}

/** Reads the holder's stdout up to its `READY` line; the holder's stderr only once it has exited without it. */
async function waitForReady(holder: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	for await (const line of readLines(holder.stdout)) {
		if (new TextDecoder().decode(line).trim() === "READY") return;
	}
	throw new Error(`the holder exited before READY: ${await new Response(holder.stderr).text()}`);
}

async function openNextToHolder(row: string): Promise<{ ms: number; error: string; kinds: string[] }> {
	const tempDir = TempDir.createSync("@sqlite-lock-shim-");
	tempDirs.push(tempDir);
	const dir = tempDir.path();
	const cwd = path.resolve(import.meta.dir, "..");
	const holder = Bun.spawn([process.execPath, probePath, "hold", row, dir], {
		cwd,
		env: probeEnv(dir, row),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await waitForReady(holder);

		const opener = Bun.spawn([process.execPath, probePath, "open", row, dir], {
			cwd,
			env: probeEnv(dir, row),
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
		return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { ms: number; error: string; kinds: string[] };
	} finally {
		holder.stdin.end();
		await holder.exited;
	}
}

describe("coding-agent's SQLite opens take the lock shim next to an omp session", () => {
	test.each([
		"autoresearch",
		"legacy-auth",
		"skill-descriptions",
		"memories",
		"mnemopi-legacy-bank",
		"session-index",
		"approvals",
		"approvals-clear",
		"github-cache",
		"auto-qa",
		"sqlite-reader",
		"write-tool",
		"commit-cache",
		"gc",
		// On Linux the lock kind read here is the store's open, which follows the adoption; the time bound,
		// which holds under gVisor, is what covers the adoption's read of the legacy file.
		"hint-store-adoption",
	])(
		"%s",
		async row => {
			const { ms, error, kinds } = await openNextToHolder(row);
			expect(error).toBe("");
			if (hasProcLocks) expect(kinds).toEqual(["OFDLCK"]);
			// Well under a second each; a lock-kind mismatch under gVisor costs about 10 s per statement.
			expect(ms).toBeLessThan(5_000);
		},
		120_000,
	);
});
