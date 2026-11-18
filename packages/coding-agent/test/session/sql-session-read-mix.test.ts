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
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, transcript } from "./sql-session-lease-fixture";

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

/** `count` lines of 1 MiB of `fill` that session {@link ID} appends after its body. */
function laterLines(fill: string, count: number): string[] {
	return Array.from(
		{ length: count },
		(_, n) =>
			`${JSON.stringify({ type: "custom", customType: "pad", id: `q${n}`, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(MiB) })}\n`,
	);
}

/**
 * Read `file` through `reader` from `fromByte`, running `race` once, right
 * after the first chunk. What the read gave: the name of the entry of `bodies`
 * its bytes equal, "read conflict", "a short body" (the start of one of
 * `bodies`) or "a mix".
 */
async function racedRead(
	reader: SqlSessionStorage,
	file: string,
	fromByte: number,
	race: () => Promise<void>,
	bodies: Record<string, string>,
): Promise<string> {
	if (!reader.readChunks) throw new Error("the SQL store reads no chunks");
	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of reader.readChunks(file, fromByte)) {
			chunks.push(chunk);
			if (chunks.length === 1) await race();
		}
	} catch (err) {
		if (!(err instanceof SessionReadConflictError)) throw err;
		return "read conflict";
	}
	const text = Buffer.concat(chunks).toString("utf8");
	const named = Object.entries(bodies).find(([, body]) => body === text);
	if (named) return named[0];
	return Object.values(bodies).some(body => body.startsWith(text)) ? "a short body" : "a mix";
}

// Another store writes the session between two pages of a chunked read: an
// append, a rename, or a full rewrite of the same size under a read from an
// offset (`readChunks(path, fromByte)`, which starts inside the transcript).
for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a chunked SQL read raced by another store (${adapter})`, () => {
		async function sessionOf(
			db: LeaseDb,
		): Promise<{ writer: SqlSessionStorage; file: string; release?: () => void }> {
			const writer = await db.open({ lease: STILL });
			const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const release = await writer.acquireSessionClaim?.(ID, file);
			return { writer, file, release: release ?? undefined };
		}

		async function readerOf(db: LeaseDb): Promise<SqlSessionStorage> {
			const reader = await db.open({ lease: STILL });
			await reader.refresh();
			return reader;
		}

		it("yields exactly the body its first query saw when the other store appends lines between two pages", async () => {
			// If this regresses, a resume of a session another process keeps appending to fails as raced, or
			// ends in the middle of a line the read never finished.
			await using db = await openLeaseDb(adapter, url ?? "");
			const { writer, file, release } = await sessionOf(db);
			const before = body("a");
			await appendLines(writer, file, before);
			const reader = await readerOf(db);

			const outcome = await racedRead(reader, file, 0, () => appendLines(writer, file, laterLines("c", 2)), {
				"old body": before.join(""),
				"old body and the appended lines": [...before, ...laterLines("c", 2)].join(""),
			});

			expect(outcome).toBe("old body");
			release?.();
		}, 120_000);

		it("fails as a read conflict or yields the old body when the other store renames the session between two pages", async () => {
			// If this regresses, a session moved away during a read loads as its first pages only.
			await using db = await openLeaseDb(adapter, url ?? "");
			const { writer, file, release } = await sessionOf(db);
			const before = body("a");
			await appendLines(writer, file, before);
			const reader = await readerOf(db);
			const moved = path.join(db.dir.path(), "sessions", "-moved-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);

			const outcome = await racedRead(reader, file, 0, () => writer.rename(file, moved), {
				"old body": before.join(""),
			});

			expect(["old body", "read conflict"]).toContain(outcome);
			release?.();
		}, 120_000);

		it("yields one body's bytes from the read's offset, or a read conflict, when the other store rewrites the session to the same size between two pages", async () => {
			// If this regresses, a read from an offset of a session rewritten meanwhile reads the start of one body
			// and the rest of another. Both bodies are full writes, so every part of one starts where a part of
			// the other does, and the parts' offsets and the size cannot tell them apart.
			await using db = await openLeaseDb(adapter, url ?? "");
			const { writer, file, release } = await sessionOf(db);
			const before = body("a").join("");
			const after = body("b").join("");
			await writer.writeText(file, before);
			const reader = await readerOf(db);
			const fromByte = 2 * MiB + MiB / 2;

			const outcome = await racedRead(reader, file, fromByte, () => writer.writeText(file, after), {
				"old body": Buffer.from(before).subarray(fromByte).toString("utf8"),
				"new body": Buffer.from(after).subarray(fromByte).toString("utf8"),
			});

			expect(["old body", "new body", "read conflict"]).toContain(outcome);
			release?.();
		}, 120_000);
	});
}
