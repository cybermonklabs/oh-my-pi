/**
 * A full rewrite of a long session whose publish cannot be confirmed (the
 * backend applied the streamed write, then its answer was lost, as a dropped connection loses it) checks
 * whether the store holds the rewrite before it reports the write (FullBody.isStored in session-body.ts). No
 * step of a running session builds the whole transcript in memory as one value, so that check reads the
 * stored copy in parts too: no string or buffer the storage takes back from its backend may hold more than
 * 16 MiB of a 24 MiB transcript, on SQL storage and on Redis alike, with the spool usable and without it.
 *
 * Runs on SQLite always, and on Redis when OMP_TEST_REDIS_URL names a throwaway server; each case uses a key
 * prefix or a database file of its own and removes it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { pathUnderRegularFile } from "../helpers/spool-unusable";
import { BackendWatch, openStore } from "../helpers/watched-session-store";

const MiB = 1024 * 1024;
const BOUND = 16 * MiB;
const TIMEOUT = 300_000;
const TIMESTAMP = "2026-11-24T00:00:00.000Z";
const ID = "01a20f00-0000-7000-8000-00000000c011";
const SESSION = `/sessions/-project-/2026-11-24T00-00-00-000Z_${ID}.jsonl`;

function transcriptLines(title: string, words: string, bytes: number): string[] {
	const lines = [
		serializeTitleSlot({ title, source: "user", updatedAt: TIMESTAMP }),
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: ID, timestamp: TIMESTAMP, cwd: "/project" })}\n`,
	];
	let total = Buffer.byteLength(lines.join(""));
	let parentId: string | null = null;
	for (let n = 0; total < bytes; n++) {
		const text = `${n} ${words.repeat(400)}`;
		const message =
			n % 2 === 0
				? { role: "user", content: text, timestamp: n }
				: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: n };
		const line = `${JSON.stringify({ type: "message", id: `m${n}`, parentId, timestamp: TIMESTAMP, message })}\n`;
		lines.push(line);
		total += Buffer.byteLength(line);
		parentId = `m${n}`;
	}
	return lines;
}

const REWRITE = transcriptLines("Long session", "the session keeps working through the module tree; ", 24 * MiB);
const OLDER = transcriptLines("Older title", "an older copy of the session; ", 2 * MiB).join("");

const BACKENDS: ReadonlyArray<{ kind: "sqlite" | "redis"; url: string | undefined }> = [
	{ kind: "sqlite", url: "sqlite" },
	{ kind: "redis", url: process.env.OMP_TEST_REDIS_URL },
];

const originalTmpdir = process.env.TMPDIR;

for (const { kind, url } of BACKENDS) {
	describe.skipIf(!url)(`a full rewrite whose publish cannot be confirmed (${kind})`, () => {
		const cleanups: Array<() => Promise<void> | void> = [];
		afterEach(async () => {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			vi.restoreAllMocks();
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});

		for (const spool of ["usable", "under a regular file"] as const) {
			it(
				`checks the stored copy in parts, never as one value, with the spool ${spool}`,
				async () => {
					const watch = new BackendWatch();
					const store = await openStore(kind, url ?? "", watch);
					cleanups.push(() => store.close());
					const { storage } = store;
					await storage.writeText(SESSION, OLDER);
					await storage.drain();
					vi.spyOn(logger, "warn").mockImplementation(() => {});
					vi.spyOn(logger, "error").mockImplementation(() => {});
					if (spool !== "usable") {
						const scratch = TempDir.createSync("@omp-unconfirmed-tmp-");
						cleanups.push(() => scratch.removeSync());
						process.env.TMPDIR = pathUnderRegularFile(scratch);
					}

					watch.start();
					watch.loseAnswers.on = true;
					const outcome = await storage
						.writeLinesAtomic(SESSION, REWRITE, { expectedSize: Buffer.byteLength(OLDER) })
						.then(
							() => "stored",
							(err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					watch.loseAnswers.on = false;
					const { bytes, what } = watch.stop();

					// The write landed and its answer was lost; the check found it stored.
					expect({ outcome, lost: watch.loseAnswers.lost }).toEqual({ outcome: "stored", lost: 1 });
					// ... without taking the whole stored transcript back as one value.
					expect({ bytes, what, bounded: bytes <= BOUND }).toMatchObject({ bounded: true });
				},
				TIMEOUT,
			);
		}
	});
}
