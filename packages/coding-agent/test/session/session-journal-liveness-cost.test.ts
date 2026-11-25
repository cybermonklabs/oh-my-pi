import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { sessionJournalLiveness } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/session-storage.ts");
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Sessions another omp process runs while this one checks their journals. */
const LIVE_ELSEWHERE = 20;
/**
 * Checking one journal reads its header and asks the kernel about one lease:
 * well under a millisecond, a few milliseconds for all 20 on a loaded host.
 * The bound leaves tenfold room above that. A check that waits about 50 ms
 * for each lease another process holds needs over 1,000 ms for the 20.
 */
const CHECK_BOUND_MS = 250;

/** A journal holding only the header of session `id`, as a fresh session writes it. */
async function writeJournal(dir: TempDir, id: string): Promise<string> {
	const file = dir.join(`${id}.jsonl`);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: TIMESTAMP,
		cwd: dir.path(),
	};
	await Bun.write(file, `${JSON.stringify(header)}\n`);
	return file;
}

/**
 * Another process that claims each journal for writing, exactly as an omp
 * running that session does, and holds the claims until its stdin closes.
 */
async function runOwner(dir: TempDir, journals: Array<{ id: string; file: string }>) {
	const script = dir.join("owner.ts");
	await Bun.write(
		script,
		[
			`import { FileSessionStorage } from ${JSON.stringify(SESSION_STORAGE_MODULE)};`,
			"const storage = new FileSessionStorage();",
			"const journals = JSON.parse(process.argv[2]);",
			"const claims = journals.map(({ id, file }) => storage.claimSession(id, file, { writer: true }));",
			'process.stdout.write("claimed " + claims.filter(Boolean).length + "\\n");',
			"for await (const _ of console) {}",
			"for (const release of claims) release?.();",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, script, JSON.stringify(journals)], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		// The live `process.env` (Bun.spawn defaults to the launch env), so the
		// other process meets this test's private session-owner leases.
		env: process.env,
	});
	const reader = child.stdout.getReader();
	const { done, value } = await reader.read();
	reader.releaseLock();
	const line = done ? "" : new TextDecoder().decode(value).trim();
	if (line !== `claimed ${journals.length}`) {
		throw new Error(
			`The owner process did not claim every journal (${line}): ${await new Response(child.stderr).text()}`,
		);
	}
	return {
		async exit(): Promise<void> {
			child.stdin.end();
			await child.exited;
		},
	};
}

describe("liveness of journals another process runs", () => {
	// The agent-list scan and `omp gc` check every journal they meet. When that
	// check blocks about 50 ms for each session another omp pane runs, a user
	// with 20 sibling panes sees the terminal freeze for a second on each scan.
	it("answers 'elsewhere' for 20 such journals without blocking the caller per journal", async () => {
		using dir = TempDir.createSync("@omp-journal-liveness-");
		const journals = await Promise.all(
			Array.from({ length: LIVE_ELSEWHERE }, async (_, index) => {
				const id = `liveness-${index}-${process.pid}-${Bun.nanoseconds()}`;
				return { id, file: await writeJournal(dir, id) };
			}),
		);
		const owner = await runOwner(dir, journals);
		try {
			// The quickest of three passes, so one stall of the host does not decide it.
			let quickestMs = Number.POSITIVE_INFINITY;
			for (let pass = 0; pass < 3; pass++) {
				const start = Bun.nanoseconds();
				const answers = journals.map(({ file }) => sessionJournalLiveness(file));
				quickestMs = Math.min(quickestMs, (Bun.nanoseconds() - start) / 1e6);
				expect(answers).toEqual(journals.map(() => "elsewhere"));
			}
			expect(quickestMs).toBeLessThanOrEqual(CHECK_BOUND_MS);
		} finally {
			await owner.exit();
		}
		// Once that process has exited, the same journals are parked transcripts.
		expect(journals.map(({ file }) => sessionJournalLiveness(file))).toEqual(journals.map(() => "free"));
	}, 30_000);
});
