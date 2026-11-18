/**
 * Opening a SQL session by path with `throwIfMissing` (as `--resume <path>`,
 * export and share do) reads a transcript under the 8 MiB streaming threshold
 * twice: once whole, then once more in chunks to check that nothing changed
 * in between. Another process that holds the session may rewrite it while the
 * second read runs. The open must then read the transcript again and come up
 * with one whole body (the old or the new), never fail with the read race.
 * Each case runs against SQLite always and against PostgreSQL when
 * `OMP_TEST_SQL_POSTGRES_URL` names a database.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, transcript } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000d1";
/** Timings under which no heartbeat runs during a case. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
const MiB = 1024 * 1024;
const TIMESTAMP = "2026-11-17T00:00:00.000Z";

/** A 3 MiB transcript of session {@link ID}: its header and first turn, then three 1 MiB lines of `fill`. */
function body(fill: string): string[] {
	return [
		transcript(ID, "first"),
		...Array.from(
			{ length: 3 },
			(_, n) =>
				`${JSON.stringify({ type: "custom", customType: "pad", id: `p${n}`, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(MiB) })}\n`,
		),
	];
}

function sessionFile(db: LeaseDb): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`SessionManager.open of a SQL session another process rewrites (${adapter})`, () => {
		it("opens one whole body when the holder rewrites the transcript after the first chunk of the open's re-read", async () => {
			// If this regresses, `omp --resume <path>` (and export, share) of a session another process is
			// compacting fails with "was replaced or removed while it was read; read it again" instead of opening.
			await using db = await openLeaseDb(adapter, url ?? "");
			const holder = await db.open({ lease: STILL });
			const file = sessionFile(db);
			const release = await holder.acquireSessionClaim?.(ID, file);
			await holder.writeText(file, transcript(ID, "before"));
			await holder.writeLinesAtomic(file, body("a"), { expectedSize: holder.statSync(file).size });
			await holder.drain();

			const reader = await db.open({ lease: STILL });
			await reader.refresh();
			const readChunks = reader.readChunks?.bind(reader);
			if (!readChunks) throw new Error("the SQL store reads no chunks");
			let raced = false;
			// The holder's full rewrite lands right after the first chunk any read of the transcript took.
			spyOn(reader, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
				(async function* () {
					for await (const chunk of readChunks(chunkPath, fromByte)) {
						yield chunk;
						if (raced) continue;
						raced = true;
						await holder.writeLinesAtomic(file, body("b"), { expectedSize: holder.statSync(file).size });
						await holder.drain();
					}
				})(),
			);

			const manager = await SessionManager.open(file, undefined, reader, {
				throwIfMissing: true,
				suppressBreadcrumb: true,
			});
			const fills = manager
				.getEntries()
				.filter(entry => entry.type === "custom")
				.map(entry => (JSON.stringify(entry).includes("a".repeat(1024)) ? "a" : "b"))
				.join("");
			await manager.close();
			expect(raced).toBe(true);
			expect(["aaa", "bbb"]).toContain(fills);
			release?.();
		}, 120_000);
	});
}
