/**
 * A SQLite session database can hold part rows whose rowid another program
 * chose, as large as SQLite allows (2^63 - 1). The store must go on appending
 * to and rewriting a session whatever rowids the parts table already holds,
 * as stores before its rowid rule did: a rowid above 2^53 is past what a
 * JavaScript number holds exactly, and 2^63 - 1 is the largest rowid there is.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { openLeaseDb, transcript } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000a3";
const MiB = 1024 * 1024;
const TIMESTAMP = "2026-11-17T00:00:00.000Z";

/** A custom entry of session {@link ID} holding `fill` repeated `bytes` times. */
function pad(id: string, fill: string, bytes: number): string {
	return `${JSON.stringify({ type: "custom", customType: "pad", id, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(bytes) })}\n`;
}

/** Append `lines` to `file` one by one, as a session's writer does, and wait until they are stored. */
async function appendLines(storage: SqlSessionStorage, file: string, lines: string[]): Promise<void> {
	const writer = storage.openWriter(file, { flags: "a" });
	for (const line of lines) await writer.append(line);
	await writer.close();
	await storage.drain();
}

/** "done" when `work` resolves, else its error's name and message. */
async function outcome(work: () => Promise<void>): Promise<string> {
	try {
		await work();
		return "done";
	} catch (err) {
		return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	}
}

describe("a SQLite session whose parts table holds a rowid above 2^53", () => {
	// Both as decimal text: neither is a JavaScript number exactly.
	for (const rowid of ["4611686018427387904", "9223372036854775807"] as const) {
		it(`appends to and rewrites the session when one of its parts has rowid ${rowid}`, async () => {
			// If this regresses, once another program has stored a row with a large rowid in the session database,
			// every new line of the session and every rewrite of it (a compaction, say) fails with a SQLite error.
			await using db = await openLeaseDb("sqlite", "sqlite");
			const store = await db.open({ claims: false });
			const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const first = [transcript(ID, "first"), pad("p0", "a", 64)];
			await appendLines(store, file, first);
			// This raw SQL on the fixture's connection stands in for another program sharing the database file
			// that stores rows under rowids of its own choosing (a copy or restore tool that keeps the rowids of
			// its source, say): it moves the session's last part to `rowid`, the largest in the table.
			await db.sql(
				`UPDATE ${db.table}_parts SET rowid = ${rowid} WHERE path = @1 AND start_offset = ` +
					`(SELECT max(start_offset) FROM ${db.table}_parts WHERE path = @2)`,
				[file, file],
			);
			const [moved] = await db.sql(`SELECT CAST(max(rowid) AS TEXT) AS rowid FROM ${db.table}_parts`);
			expect(String(moved?.rowid)).toBe(rowid);

			const appended = pad("p1", "b", 64);
			const append = await outcome(() => appendLines(store, file, [appended]));
			const appendedBody = (await db.row(file))?.content;
			// A rewrite of three parts of 1 MiB, as a full write cuts a body of over 2 MiB.
			const rewritten = [transcript(ID, "rewritten"), pad("q0", "c", 3 * MiB - 2048)];
			const rewrite = await outcome(async () => {
				await store.writeText(file, rewritten.join(""));
				await store.drain();
			});

			expect({ append, rewrite }).toEqual({ append: "done", rewrite: "done" });
			expect(appendedBody).toBe([...first, appended].join(""));
			const reader = await db.open({ claims: false });
			await reader.refresh();
			expect(await reader.readText(file)).toBe(rewritten.join(""));
		}, 60_000);
	}
});
