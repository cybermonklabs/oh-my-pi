/**
 * `SqlSessionStorage` records each completed schema check in `<table>_meta`,
 * then checks for newly invalid rows through indexed probes, independent of
 * planner statistics. With `createTable: false` it still refuses such rows.
 * These run against SQLite always, and against PostgreSQL and
 * MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database; every test makes its own tables and drops them.
 */
import { describe, expect, it } from "bun:test";
import {
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	SqlSessionStorage,
	sessionRowKey,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SQL } from "bun";
import { sessionSqlTestClient } from "../helpers/session-sql-client";

type SqlClient = InstanceType<typeof SQL>;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

const ROOT = "/home/meta/.omp/agent/sessions";

let tableSeq = 0;

class Db implements AsyncDisposable {
	readonly table = `omp_meta_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		this.client = sessionSqlTestClient(url);
	}

	open(options: { createTable?: boolean; client?: SqlSessionStorageClient } = {}): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({
			client: options.client ?? this.client,
			table: this.table,
			sessionsRoot: ROOT,
			adapter: this.adapter,
			createTable: options.createTable,
		});
	}

	/** A client over this database that records every statement it runs. */
	recording(statements: string[]): SqlSessionStorageClient {
		return {
			options: this.client.options,
			unsafe: (sql, values) => {
				statements.push(sql);
				return this.client.unsafe(sql, values);
			},
			transaction: work =>
				this.client.transaction(transaction =>
					work({
						unsafe: (sql, values) => {
							statements.push(sql);
							return transaction.unsafe(sql, values);
						},
					}),
				),
		};
	}

	async sql(query: string, values: unknown[] = []): Promise<void> {
		let n = 0;
		await this.client.unsafe(this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query, values);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_meta`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage schema checks (${adapter})`, () => {
		it("start-up probes never scan the session table, even without planner statistics", async () => {
			await using db = new Db(adapter, url ?? "");
			await db.open();
			if (adapter === "postgres") {
				await db.sql(`ALTER TABLE ${db.table} SET (autovacuum_enabled = false)`);
				await db.sql(`ALTER TABLE ${db.table}_parts SET (autovacuum_enabled = false)`);
			}
			const select = "'sessions/p/' || n || '.jsonl'";
			const numbers = adapter === "postgres" ? "generate_series(1, 150000) AS numbers(n)" : "numbers";
			// No ANALYZE: PostgreSQL must not depend on statistics to avoid a full scan.
			if (adapter === "mysql") {
				const digits =
					"(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
				await db.sql(
					`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) SELECT CONCAT('sessions/p/', a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n + 100000*f.n, '.jsonl'), 'x', 1, 1 FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} c CROSS JOIN ${digits} d CROSS JOIN ${digits} e CROSS JOIN ${digits} f WHERE f.n < 2 AND a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n + 100000*f.n < 150000`,
				);
			} else {
				const cte =
					adapter === "sqlite"
						? "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 150000) "
						: "";
				await db.sql(
					`${cte}INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) SELECT ${select}, 'x', 1, 1 FROM ${numbers}`,
				);
			}
			const count = await db.client.unsafe(`SELECT count(*) AS n FROM ${db.table}`);
			expect(Number(count[0].n)).toBe(150000);
			await db.sql(
				`INSERT INTO ${db.table}_parts (path, start_offset, content) SELECT path, 0, 'x' FROM ${db.table}`,
			);
			const partsCount = await db.client.unsafe(`SELECT count(*) AS n FROM ${db.table}_parts`);
			expect(Number(partsCount[0].n)).toBe(150000);
			if (adapter === "postgres") {
				const stats = await db.client.unsafe(`SELECT reltuples FROM pg_class WHERE oid = '${db.table}'::regclass`);
				expect(Number(stats[0].reltuples)).toBe(-1);
				const partsStats = await db.client.unsafe(
					`SELECT reltuples FROM pg_class WHERE oid = '${db.table}_parts'::regclass`,
				);
				expect(Number(partsStats[0].reltuples)).toBe(-1);
			}

			const statements: string[] = [];
			await db.open({ client: db.recording(statements) });
			const probes = statements.filter(sql =>
				new RegExp(`^SELECT path FROM ${db.table}(?:_parts)? WHERE `).test(sql),
			);
			expect(probes).toHaveLength(3);
			for (const probe of probes) {
				const explain =
					adapter === "postgres"
						? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
						: adapter === "sqlite"
							? "EXPLAIN QUERY PLAN "
							: "EXPLAIN ";
				const plan = await db.client.unsafe(explain + probe);
				expect(plan.length).toBeGreaterThan(0);
				if (adapter === "postgres") {
					const text = JSON.stringify(plan);
					expect(text).toContain('"Node Type":');
					expect(text).not.toMatch(/"Node Type":"Seq Scan"/);
					// A full key-index walk can avoid Seq Scan but still discard every canonical key.
					expect(text).not.toMatch(/"Rows Removed by (?:Filter|Index Recheck)":[1-9]/);
				} else if (adapter === "sqlite") {
					for (const row of plan) {
						expect(typeof row.detail).toBe("string");
						const detail = String(row.detail);
						// SQLite calls walking an empty partial index SCAN too; it reads no table rows.
						if (new RegExp(`\\bSCAN ${db.table}(?:_parts)?\\b`).test(detail)) {
							expect(detail).toContain(`USING INDEX ${db.table}_nolen`);
						}
					}
				} else {
					for (const row of plan) {
						expect(typeof row.type).toBe("string");
						expect(row.type).not.toBe("ALL");
					}
				}
			}
		}, 120_000);

		for (const createTable of [true, false]) {
			it(`createTable: ${createTable} refuses a row an older omp wrote with no byte_len after the check was recorded`, async () => {
				await using db = new Db(adapter, url ?? "");
				await (await db.open()).drain();
				const key = sessionRowKey(`${ROOT}/-p/unmeasured.jsonl`, ROOT);
				await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) VALUES (?, ?, 1, NULL)`, [
					key,
					"older omp\n",
				]);

				await expect(db.open({ createTable })).rejects.toThrow(`row ${JSON.stringify(key)} has no byte_len`);
			});

			it(`createTable: ${createTable} refuses a legacy key an older omp wrote after the check was recorded`, async () => {
				await using db = new Db(adapter, url ?? "");
				await (await db.open()).drain();
				await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) VALUES (?, '', 1, 0)`, [
					"/home/old/.omp/agent/sessions/-p/legacy.jsonl",
				]);

				await expect(db.open({ createTable })).rejects.toThrow(
					'holds the row key "/home/old/.omp/agent/sessions/-p/legacy.jsonl"',
				);
			});

			it(`createTable: ${createTable} refuses a legacy key stored only in parts after the check was recorded`, async () => {
				await using db = new Db(adapter, url ?? "");
				await db.open();
				const key = "/home/old/.omp/agent/sessions/-p/parts-only.jsonl";
				await db.sql(`INSERT INTO ${db.table}_parts (path, start_offset, content) VALUES (?, 0, 'orphan')`, [key]);
				expect((await db.client.unsafe(`SELECT path FROM ${db.table}`)).length).toBe(0);
				await expect(db.open({ createTable })).rejects.toThrow(`holds the row key ${JSON.stringify(key)}`);
			});
		}

		it("createTable: false starts on a checked table with both checks recorded", async () => {
			await using db = new Db(adapter, url ?? "");
			const first = await db.open();
			await first.writeText(`${ROOT}/-p/s.jsonl`, "body\n");
			await first.drain();

			const storage = await db.open({ createTable: false });
			expect(await storage.readText(`${ROOT}/-p/s.jsonl`)).toBe("body\n");
		});
	});
}
