/**
 * A resumed session's memory follows its live context, not its age. Two sessions differ only in how
 * many tool turns lie before their latest compaction (the live context of each is the last turn and
 * three after the compaction), and each is resumed in a fresh process. The heap the opened session
 * keeps may grow by at most a tenth of what the transcript grows: older entries keep their small
 * fields in memory (under 1 KB each), and their large values are read back on access. A build that
 * keeps every entry's body keeps more than the whole growth.
 *
 * Runs on file storage and on SQL storage over SQLite. The probe runs with the JIT off, so compiled
 * code does not count as session memory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.join(import.meta.dir, "../fixtures/resume-memory-probe.ts");
/** Tool turns before the compaction in the short and the long session: 6 MB and 32 MB of transcript. */
const SHORT_TURNS = 20;
const LONG_TURNS = 120;
/** The most the kept heap may grow, as a share of the transcript's growth. */
const MAX_GROWTH_SHARE = 0.1;
const TIMEOUT = 120_000;

let tempDir: TempDir | undefined;

afterEach(async () => {
	await tempDir?.remove();
	tempDir = undefined;
});

/** Runs the probe in a fresh process and returns the JSON object its last stdout line holds. */
async function probe(args: string[], root: string): Promise<Record<string, number>> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		BUN_JSC_useJIT: "0",
	};
	delete env.OMP_SESSION_STORAGE;
	delete env.OMP_SESSION_SQL_DSN_FILE;
	const child = Bun.spawn([process.execPath, probePath, ...args], {
		cwd: path.join(import.meta.dir, "../../../.."),
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`probe ${args.join(" ")} exited ${exitCode}:\n${stderr}`);
	const last = stdout.trim().split("\n").at(-1);
	if (!last) throw new Error(`probe ${args.join(" ")} printed nothing:\n${stderr}`);
	return JSON.parse(last);
}

interface Resumed {
	bytes: number;
	retained: number;
	entries: number;
}

async function writeAndResume(storage: "file" | "sqlite", root: string, turns: number): Promise<Resumed> {
	const { bytes } = await probe(["write", storage, root, String(turns)], root);
	const { retained, entries } = await probe(["resume", storage, root], root);
	return { bytes, retained, entries };
}

describe("resumed session memory against transcript length", () => {
	for (const storage of ["file", "sqlite"] as const) {
		it(
			`keeps about the same heap for a five times longer transcript on ${storage} storage`,
			async () => {
				tempDir = await TempDir.create("@omp-resume-memory-");
				const short = await writeAndResume(storage, tempDir.join("short"), SHORT_TURNS);
				const long = await writeAndResume(storage, tempDir.join("long"), LONG_TURNS);
				expect(long.entries).toBeGreaterThan(short.entries);
				const transcriptGrowth = long.bytes - short.bytes;
				const heapGrowth = long.retained - short.retained;
				expect(heapGrowth).toBeLessThan(transcriptGrowth * MAX_GROWTH_SHARE);
			},
			TIMEOUT,
		);
	}
});
