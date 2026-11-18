/**
 * A chunked read (`readChunks`) of a SQL session fetches its parts one page
 * at a time. When the parts are replaced between two pages, the read must
 * notice and fail with `SessionReadConflictError` (the loaders then read
 * again), or finish with one whole body: never the first pages of one body
 * followed by the rest of another. Here the session goes (a delete, or a
 * truncate to "") and is appended again with lines of the same lengths, so
 * every part starts where an old one did. Each case runs against SQLite
 * always and against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { LEASE_BACKENDS, openLeaseDb, transcript } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-000000000071";
/** Timings under which no heartbeat runs during a case. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
const MiB = 1024 * 1024;
const TIMESTAMP = "2026-11-17T00:00:00.000Z";

/** Session {@link ID}'s header and first turn, then eight 1 MiB lines of `fill`: over 8 MiB, past several pages. */
function body(fill: string): string[] {
	return [
		transcript(ID, "first"),
		...Array.from(
			{ length: 8 },
			(_, n) =>
				`${JSON.stringify({ type: "custom", customType: "pad", id: `p${n}`, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(MiB) })}\n`,
		),
	];
}

/** Append `lines` to `file` one by one, as a session's writer does, and wait until they are stored. */
async function appendLines(storage: SqlSessionStorage, file: string, lines: string[]): Promise<void> {
	const writer = storage.openWriter(file, { flags: "a" });
	for (const line of lines) await writer.append(line);
	await writer.close();
	await storage.drain();
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a chunked SQL read raced by a re-created body (${adapter})`, () => {
		for (const replace of ["delete", "truncate"] as const) {
			it(`yields the old body, the new one or a read conflict when a ${replace} and same-length appends land between two pages`, async () => {
				// If this regresses, loading, copying or forking a session another process re-created meanwhile
				// silently yields its first lines from the old transcript and the rest from the new one.
				await using db = await openLeaseDb(adapter, url ?? "");
				const writer = await db.open({ lease: STILL });
				const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
				const release = await writer.acquireSessionClaim?.(ID, file);
				const before = body("a");
				const after = body("b");
				await appendLines(writer, file, before);

				const reader = await db.open({ lease: STILL });
				await reader.refresh();
				if (!reader.readChunks) throw new Error("the SQL store reads no chunks");
				const chunks: Uint8Array[] = [];
				let outcome: string;
				try {
					for await (const chunk of reader.readChunks(file)) {
						chunks.push(chunk);
						if (chunks.length !== 1) continue;
						if (replace === "delete") await writer.unlink(file);
						else await writer.writeText(file, "");
						await writer.drain();
						await appendLines(writer, file, after);
					}
					const text = Buffer.concat(chunks).toString("utf8");
					outcome = text === before.join("") ? "old body" : text === after.join("") ? "new body" : "a mix";
				} catch (err) {
					if (!(err instanceof SessionReadConflictError)) throw err;
					outcome = "read conflict";
				}
				expect(["old body", "new body", "read conflict"]).toContain(outcome);
				release?.();
			}, 120_000);
		}
	});
}
