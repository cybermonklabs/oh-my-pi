/**
 * A chunked read (`readChunks`) of a SQL session, raced by another store's
 * full write that lands between two of the read's pages and holds exactly the
 * bytes of the part the read fetched last, at its offset, while it differs
 * both before that part and after it. The read must still yield one body or
 * fail with `SessionReadConflictError`, never the first pages of one body
 * followed by the rest of the other:
 *
 * - on MySQL, which keeps no row identity the read could check page by page,
 *   for a rewrite of the session (when `OMP_TEST_SQL_MYSQL_URL` names a
 *   database);
 * - on SQLite, which hands a new row the largest rowid plus one, for a full
 *   write, plain or staged, that re-creates the session after a delete took
 *   every part of the table.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { MiB, paddedTranscript, raceAfterFirstChunk, STILL } from "./chunked-read-race";
import { LEASE_BACKENDS, openLeaseDb } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000f7";
const MYSQL_URL = LEASE_BACKENDS.find(backend => backend.adapter === "mysql")?.url;

/**
 * Session {@link ID}'s header and first turn (`prompt`), then three 1 MiB pads
 * of "a" and five of `fill`; written whole, it is stored as parts of 1 MiB.
 * Two such bodies whose prompts have one length have the same size, and hold
 * the same bytes in their third part ([2 MiB, 3 MiB), inside the pads of "a"),
 * while their first part (the turn) and every part from the fourth on (the
 * pads of `fill`) differ.
 */
function body(prompt: string, fill: string): string[] {
	return [...paddedTranscript(ID, prompt, "a", 3), ...paddedTranscript(ID, prompt, fill, 8).slice(5)];
}

/**
 * Read `file` whole through `reader`, running `race` once the read has yielded
 * its first two parts: its first page is the first part, its second the
 * second and third parts, so the third part, the same in `before` and `after`,
 * is the last one the read has fetched when the next page's query runs. What
 * the read gave: "old body", "new body", "read conflict" or "a mix".
 */
async function racedRead(
	reader: SqlSessionStorage,
	file: string,
	race: () => Promise<void>,
	before: string,
	after: string,
): Promise<string> {
	const raced = raceAfterFirstChunk(reader, file, race, 2 * MiB);
	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of reader.readChunks(file)) chunks.push(chunk);
	} catch (err) {
		if (!(err instanceof SessionReadConflictError)) throw err;
		return "read conflict";
	}
	expect(raced.ran).toBe(true);
	const text = Buffer.concat(chunks).toString("utf8");
	return text === before ? "old body" : text === after ? "new body" : "a mix";
}

describe.skipIf(!MYSQL_URL)("a chunked MySQL read raced by a full rewrite that keeps the part it fetched last", () => {
	it("yields the old body, the new one or a read conflict when the rewrite lands between two pages", async () => {
		// If this regresses, loading, copying or forking a MySQL session another process rewrote meanwhile
		// yields the old transcript's first turn followed by the new transcript's later entries.
		await using db = await openLeaseDb("mysql", MYSQL_URL ?? "");
		const writer = await db.open({ lease: STILL });
		const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
		const release = await writer.acquireSessionClaim?.(ID, file);
		const before = body("first", "b").join("");
		const after = body("FIRST", "c").join("");
		await writer.writeText(file, before);
		await writer.drain();
		const reader = await db.open({ lease: STILL });
		await reader.refresh();

		const outcome = await racedRead(
			reader,
			file,
			async () => {
				await writer.writeText(file, after);
				await writer.drain();
			},
			before,
			after,
		);

		expect(["old body", "new body", "read conflict"]).toContain(outcome);
		release?.();
	}, 120_000);
});

describe("a chunked SQLite read raced by a delete and a full write that keeps the part it fetched last", () => {
	// Each case writes both bodies the same way, so each defends the rowids of one kind of part insert.
	const writes: Record<string, (writer: SqlSessionStorage, file: string, lines: string[]) => Promise<void>> = {
		"full write": (writer, file, lines) => writer.writeText(file, lines.join("")),
		"staged full write": (writer, file, lines) => writer.writeLinesAtomic(file, lines),
	};
	for (const [kind, write] of Object.entries(writes)) {
		it(`yields the old body, the new one or a read conflict when a delete and a ${kind} land between two pages`, async () => {
			// If this regresses, a session another process deleted and wrote again meanwhile reads as the old
			// transcript's first turn followed by the new transcript's later entries: the new parts took the
			// rowids of the deleted ones, the table's newest.
			await using db = await openLeaseDb("sqlite", "sqlite");
			const writer = await db.open({ lease: STILL });
			const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
			const release = await writer.acquireSessionClaim?.(ID, file);
			const before = body("first", "b");
			const after = body("FIRST", "c");
			await write(writer, file, before);
			await writer.drain();
			const reader = await db.open({ lease: STILL });
			await reader.refresh();

			const outcome = await racedRead(
				reader,
				file,
				async () => {
					await writer.unlink(file);
					await writer.drain();
					await write(writer, file, after);
					await writer.drain();
				},
				before.join(""),
				after.join(""),
			);

			expect(["old body", "new body", "read conflict"]).toContain(outcome);
			release?.();
		}, 120_000);
	}
});
