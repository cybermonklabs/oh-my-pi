/**
 * MySQL no-op-update repro: a size-checked replace with a byte-identical body
 * matches the session row but may change nothing, and MySQL reports
 * `affectedRows: 0` for such a row. That must not surface as a
 * `SessionWriteConflictError`; only a real size divergence may.
 *
 * The fake below drives the REAL `mysql` adapter branch of
 * `SqlSessionStorageBackend` on every run, with documented MySQL
 * `affectedRows` semantics: 0 when a matched row is unchanged, 1 when a row
 * is inserted, 2 when an upsert changes one. sql-session-storage-dialects.test.ts
 * covers the same replace against a live MySQL when `OMP_TEST_SQL_MYSQL_URL`
 * is set.
 */

import { describe, expect, it, vi } from "bun:test";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

interface FakeRow {
	byteLen: number;
	mtimeMs: number;
	title: unknown[];
}

function mysqlResult(affectedRows: number, rows: unknown[] = []): SqlSessionStorageResult {
	return Object.assign(rows, { affectedRows });
}

/** In-memory session rows and parts speaking just enough MySQL wire behavior for the test. */
function mysqlFake(): { client: SqlSessionStorageClient; stored(path: string): string | undefined } {
	const rows = new Map<string, FakeRow>();
	const parts = new Map<string, Map<number, string>>();
	const partsOf = (path: string): Map<number, string> => {
		let byOffset = parts.get(path);
		if (!byOffset) {
			byOffset = new Map();
			parts.set(path, byOffset);
		}
		return byOffset;
	};
	const orderedParts = (path: string): Array<[number, string]> =>
		[...(parts.get(path) ?? new Map<number, string>())].sort(([a], [b]) => a - b);

	const client: SqlSessionStorageClient = {
		options: { adapter: "mysql" },
		async unsafe(sql: string, values: unknown[] = []): Promise<SqlSessionStorageResult> {
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return mysqlResult(0);
			// A fresh table: the column probe finds nothing, so the store adds every column.
			if (sql.startsWith("SELECT column_name")) return mysqlResult(0);
			// Every fake row already carries its byte_len, so nothing needs a backfill.
			if (sql.startsWith("SELECT 1 AS unmeasured")) return mysqlResult(0);
			// The blob and reference tables' keys, as docs/session.md gives them.
			if (sql.includes("information_schema.KEY_COLUMN_USAGE")) {
				return mysqlResult(
					0,
					String(values[0]).endsWith("_refs") ? [{ name: "path" }, { name: "sha256" }] : [{ name: "sha256" }],
				);
			}
			if (sql.startsWith("SELECT 1 AS found FROM omp_session_files_parts")) {
				return mysqlResult(0, orderedParts(values[0] as string).length > 0 ? [{ found: 1 }] : []);
			}
			// A title update's look for its row, made when MySQL counted no changed row.
			if (sql === "SELECT path FROM omp_session_files WHERE path = ?") {
				const path = values[0] as string;
				return mysqlResult(0, rows.has(path) ? [{ path }] : []);
			}
			// The index load: each session's path, time and size.
			if (sql.startsWith("SELECT path")) {
				return mysqlResult(
					0,
					[...rows].map(([path, row]) => ({ path, mtime_ms: row.mtimeMs, byte_len: row.byteLen })),
				);
			}
			// A whole read: the session row, with its title columns, then its parts.
			if (sql.startsWith("SELECT 0 AS kind")) {
				const path = values[0] as string;
				const row = rows.get(path);
				if (!row) return mysqlResult(0);
				const [title, title_source, title_updated_at] = row.title;
				return mysqlResult(0, [
					{ kind: 0, start_offset: 0, content: "", title, title_source, title_updated_at },
					...orderedParts(path).map(([offset, content]) => ({ kind: 1, start_offset: offset, content })),
				]);
			}
			if (sql.startsWith("SELECT byte_len")) {
				const row = rows.get(values[0] as string);
				return mysqlResult(0, row ? [{ byte_len: row.byteLen }] : []);
			}
			if (sql.startsWith("INSERT IGNORE INTO omp_session_files ")) {
				const [path, mtimeMs, title, source, updatedAt, byteLen] = values as [string, number, ...unknown[]];
				if (rows.has(path)) return mysqlResult(0);
				rows.set(path, { byteLen: byteLen as number, mtimeMs, title: [title, source, updatedAt] });
				return mysqlResult(1);
			}
			if (sql.startsWith("INSERT INTO omp_session_files_parts")) {
				if (sql.includes(" SELECT ")) {
					const [byteLen, content, path] = values as [number, string, string];
					const row = rows.get(path);
					if (row && byteLen > 0) partsOf(path).set(row.byteLen - byteLen, content);
					return mysqlResult(row && byteLen > 0 ? 1 : 0);
				}
				const [path, offset, content] = values as [string, number, string];
				partsOf(path).set(offset, content);
				return mysqlResult(1);
			}
			if (sql.startsWith("INSERT INTO omp_session_files ")) {
				const path = values[0] as string;
				const existing = rows.get(path);
				if (sql.includes("byte_len = byte_len + ?")) {
					const [, mtimeMs, byteLen] = values as [string, number, number];
					rows.set(
						path,
						existing
							? { ...existing, byteLen: existing.byteLen + byteLen, mtimeMs }
							: { byteLen, mtimeMs, title: [null, null, null] },
					);
					return mysqlResult(existing ? 2 : 1);
				}
				const [, mtimeMs, title, source, updatedAt, byteLen] = values as [string, number, ...unknown[]];
				const next: FakeRow = { byteLen: byteLen as number, mtimeMs, title: [title, source, updatedAt] };
				rows.set(path, next);
				if (!existing) return mysqlResult(1);
				// Matched but unchanged: a real MySQL upsert reports affectedRows 0 here.
				const unchanged = JSON.stringify(existing) === JSON.stringify(next);
				return mysqlResult(unchanged ? 0 : 2);
			}
			if (sql.startsWith("DELETE FROM omp_session_files_parts")) {
				parts.delete(values[0] as string);
				return mysqlResult(1);
			}
			if (sql.startsWith("DELETE FROM omp_session_files ")) {
				return mysqlResult(rows.delete(values[0] as string) ? 1 : 0);
			}
			// A title update: MySQL counts only a row the update changed, so 0 when no row matches and 0 when the
			// matched row already holds every value the update sets.
			if (
				sql ===
				"UPDATE omp_session_files SET title = ?, title_source = ?, title_updated_at = ?, mtime_ms = ? WHERE path = ?"
			) {
				const [title, source, updatedAt, mtimeMs, path] = values as [unknown, unknown, unknown, number, string];
				const existing = rows.get(path);
				if (!existing) return mysqlResult(0);
				const next: FakeRow = { ...existing, mtimeMs, title: [title, source, updatedAt] };
				rows.set(path, next);
				return mysqlResult(JSON.stringify(existing) === JSON.stringify(next) ? 0 : 1);
			}
			// The blob and reference tables, which hold nothing here: start-up's privilege probes, which change
			// no row, a full write's read of the references it replaces, and a delete's look for those it drops.
			if (
				/^(INSERT INTO|DELETE FROM|UPDATE|SELECT sha256(, byte_len|, path)? FROM) omp_session_files_(blobs|refs)\b/.test(
					sql,
				)
			) {
				return mysqlResult(0);
			}
			throw new Error(`mysqlFake: unhandled statement: ${sql.slice(0, 60)}`);
		},
		async transaction(callback) {
			return callback(client);
		},
	};
	return {
		client,
		stored: path =>
			rows.has(path)
				? orderedParts(path)
						.map(([, content]) => content)
						.join("")
				: undefined,
	};
}

const BODY = "title-slot-line\nheader-line\nentry-one\n";

describe("SqlSessionStorage (MySQL no-op replace)", () => {
	it("does not latch a false conflict when affectedRows is 0 for a byte-identical body", async () => {
		// The sync publish path (`writeTextSync`, used by manager rewrites) has
		// no content readback: a backend `SessionWriteConflictError` lands in
		// the drain error latch. Identical bodies must not produce one.
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		expect(storage.adapter).toBe("mysql");

		await storage.writeText("/s/n.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		storage.writeTextSync("/s/n.jsonl", BODY, { expectedSize: size });
		await storage.drain();
		expect(stored("/s/n.jsonl")).toBe(BODY);
	});

	it("commits a byte-identical writeTextAtomic at the current size", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/a.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		await storage.writeTextAtomic("/s/a.jsonl", BODY, { expectedSize: size });
		expect(stored("/s/a.jsonl")).toBe(BODY);
	});

	it("still throws a genuine conflict when another writer changed the body", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const peer = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/c.jsonl", BODY);
		const staleSize = Buffer.byteLength(BODY, "utf8");
		await peer.refresh();
		await peer.writeText("/s/c.jsonl", `${BODY}peer-line\n`);

		await expect(storage.writeTextAtomic("/s/c.jsonl", BODY, { expectedSize: staleSize })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		expect(stored("/s/c.jsonl")).toBe(`${BODY}peer-line\n`);
	});

	it("still throws when another writer removed the row", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const peer = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/gone.jsonl", BODY);
		await peer.refresh();
		await peer.unlink("/s/gone.jsonl");

		await expect(
			storage.writeTextAtomic("/s/gone.jsonl", BODY, { expectedSize: Buffer.byteLength(BODY, "utf8") }),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(stored("/s/gone.jsonl")).toBeUndefined();
	});
});

const TITLE: SessionTitleUpdate = { title: "Renamed", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" };

// MySQL counts 0 changed rows both for a title update that matched no row and for one that set what the row
// already held, so on 0 the store must look for the row before it reports the session gone.
describe("SqlSessionStorage (MySQL title update)", () => {
	it("resolves a title update that MySQL counts as 0 changed rows when the row exists", async () => {
		const { client, stored } = mysqlFake();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			const storage = await SqlSessionStorage.create({ client });
			const peer = await SqlSessionStorage.create({ client });
			await storage.writeText("/s/titled.jsonl", BODY);
			await peer.refresh();

			// A millisecond later each store, having seen only the write, stamps the clock's time, so the peer's
			// title update leaves the row holding every value this store's then sets.
			clock.mockReturnValue(1_700_000_000_001);
			await peer.updateSessionTitle("/s/titled.jsonl", TITLE);

			await expect(storage.updateSessionTitle("/s/titled.jsonl", TITLE)).resolves.toBeUndefined();
			// Both updates stamped one time: the second changed nothing, which is what MySQL counted as 0.
			expect(storage.statSync("/s/titled.jsonl").mtimeMs).toBe(peer.statSync("/s/titled.jsonl").mtimeMs);
			expect(stored("/s/titled.jsonl")).toBe(BODY);
		} finally {
			clock.mockRestore();
		}
	}, 10_000);

	it("rejects a title update with ENOENT when MySQL counts 0 changed rows and the row is gone", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const peer = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/title-gone.jsonl", BODY);
		await peer.refresh();
		await peer.unlink("/s/title-gone.jsonl");

		await expect(storage.updateSessionTitle("/s/title-gone.jsonl", TITLE)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(stored("/s/title-gone.jsonl")).toBeUndefined();
	}, 10_000);
});
