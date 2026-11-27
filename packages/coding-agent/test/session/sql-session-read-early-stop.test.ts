/**
 * A reader of a chunked read (`readChunks`) of a SQL session that stops before
 * the read's end, by leaving its loop, once another store's full rewrite has
 * landed between two of the read's pages: what it took must still be the
 * start of one body, or the read fails with `SessionReadConflictError` where
 * the reader leaves its loop. The advisor cost restore reads a transcript up
 * to its size and stops right after the last chunk, the session listing's
 * line scan once it found what it looks for. On MySQL, which keeps no row
 * identity the read could check page by page, nothing but the read's check of
 * what it yielded stands between such a reader and two bodies. Each case runs
 * against SQLite always and against PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { padFills, paddedTranscript, raceAfterFirstChunk } from "./chunked-read-race";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, STILL } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000f8";
/**
 * The two bodies: written whole, each is stored as parts of 1 MiB, of one
 * size, and every part differs between them. A read's first page is the
 * first part, its second page the next two.
 */
const BEFORE = paddedTranscript(ID, "first", "b", 8).join("");
const AFTER = paddedTranscript(ID, "FIRST", "c", 8).join("");
/**
 * The same two bodies under title slots of their own, whose titles have one
 * length: still of one size, with one part layout. The store holds each one's
 * title as its title metadata.
 */
const TITLED_BEFORE = `${serializeTitleSlot({ title: "Title before", source: "user", updatedAt: "t1" })}${BEFORE}`;
const TITLED_AFTER = `${serializeTitleSlot({ title: "Title after!", source: "user", updatedAt: "t2" })}${AFTER}`;

/** Session {@link ID} written whole as `body` by a store that claims it, and a second store that reads it. */
async function sessionOf(
	db: LeaseDb,
	body = BEFORE,
): Promise<{ writer: SqlSessionStorage; reader: SqlSessionStorage; file: string; release?: () => void }> {
	const writer = await db.open({ lease: STILL });
	const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
	const release = await writer.acquireSessionClaim?.(ID, file);
	await writer.writeText(file, body);
	await writer.drain();
	const reader = await db.open({ lease: STILL });
	await reader.refresh();
	return { writer, reader, file, release: release ?? undefined };
}

/** Rewrite `file` whole as `body` and wait until it is stored. */
async function rewrite(writer: SqlSessionStorage, file: string, body = AFTER): Promise<void> {
	await writer.writeText(file, body);
	await writer.drain();
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a chunked SQL read its reader stops early, past a rewrite (${adapter})`, () => {
		it("gives the start of one body, or a read conflict, to a reader that leaves its loop after the second chunk", async () => {
			// If this regresses, a reader that stops partway through a session another process rewrote meanwhile
			// takes the old transcript's first entries followed by the new transcript's next ones.
			await using db = await openLeaseDb(adapter, url ?? "");
			const { writer, reader, file, release } = await sessionOf(db);

			const chunks: Uint8Array[] = [];
			let outcome: string;
			try {
				// The first chunk is the first page; the second comes from the second page, after the rewrite.
				for await (const chunk of reader.readChunks(file)) {
					chunks.push(chunk);
					if (chunks.length === 2) break;
					await rewrite(writer, file);
				}
				const text = Buffer.concat(chunks).toString("utf8");
				outcome = BEFORE.startsWith(text)
					? "the old body's start"
					: AFTER.startsWith(text)
						? "the new body's start"
						: "a mix";
			} catch (err) {
				if (!(err instanceof SessionReadConflictError)) throw err;
				outcome = "read conflict";
			}

			expect(["the old body's start", "the new body's start", "read conflict"]).toContain(outcome);
			release?.();
		}, 120_000);

		it("visits one body's entries, or fails as a read conflict, when the visit stops at the size it was given", async () => {
			// If this regresses, the advisor cost restore of a transcript another process rewrote meanwhile adds up
			// the old transcript's first entries and the new transcript's later ones.
			await using db = await openLeaseDb(adapter, url ?? "");
			const { writer, reader, file, release } = await sessionOf(db);
			const race = raceAfterFirstChunk(reader, file, () => rewrite(writer, file));

			let outcome: string;
			try {
				const entries: FileEntry[] = [];
				await visitEntriesFromFileStream(
					file,
					entry => {
						entries.push(entry);
					},
					{ storage: reader, maxBytes: reader.statSync(file).size },
				);
				outcome = padFills(entries);
			} catch (err) {
				if (!(err instanceof SessionReadConflictError)) throw err;
				outcome = "read conflict";
			}

			expect(race.ran).toBe(true);
			expect(["bbbbbbbb", "cccccccc", "read conflict"]).toContain(outcome);
			release?.();
		}, 120_000);

		// The first chunk of a titled read is the title slot its first query's title makes; the bytes after it come
		// from the pages. The rewrite lands between that query and the first page, or between two pages.
		for (const { rewriteAfter, stopAfter } of [
			{ rewriteAfter: 1, stopAfter: 2 },
			{ rewriteAfter: 2, stopAfter: 3 },
			{ rewriteAfter: 1, stopAfter: undefined },
		]) {
			it(`gives one version's title with that version's bytes, or a read conflict, when a titled rewrite lands after chunk ${rewriteAfter} of a read ${stopAfter === undefined ? "read to its end" : `left after chunk ${stopAfter}`}`, async () => {
				// If this regresses, a reader of a session another process rewrote meanwhile, under another title,
				// shows the old title over the new transcript's entries, or the new title over the old ones.
				await using db = await openLeaseDb(adapter, url ?? "");
				const { writer, reader, file, release } = await sessionOf(db, TITLED_BEFORE);

				const chunks: Uint8Array[] = [];
				let outcome: string;
				try {
					for await (const chunk of reader.readChunks(file)) {
						chunks.push(chunk);
						if (chunks.length === stopAfter) break;
						if (chunks.length === rewriteAfter) await rewrite(writer, file, TITLED_AFTER);
					}
					const text = Buffer.concat(chunks).toString("utf8");
					outcome = TITLED_BEFORE.startsWith(text)
						? "the old version's start"
						: TITLED_AFTER.startsWith(text)
							? "the new version's start"
							: "a mix";
				} catch (err) {
					if (!(err instanceof SessionReadConflictError)) throw err;
					outcome = "read conflict";
				}

				expect(["the old version's start", "the new version's start", "read conflict"]).toContain(outcome);
				release?.();
			}, 120_000);
		}
	});
}
