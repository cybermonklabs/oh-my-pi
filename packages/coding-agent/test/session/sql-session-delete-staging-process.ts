/**
 * A process for `sql-session-delete-staging.test.ts` that is killed in the
 * middle of a staged full write. argv[2] is a JSON configuration: the
 * fixture's `dsn`, `table`, `leaseTable` and `lease`, the session `id` and
 * `sessionFile` to claim, and the `file` to write. It claims the session,
 * then writes `file` whole through `writeLinesAtomic`, which stages it in
 * batches of parts. Once the first batch has committed, it prints
 * `{"staged":true}` and never starts another transaction, so the test can
 * kill it while only staging parts exist.
 */
import { SqlSessionStorage } from "../../src/session/sql-session-storage";
import type { SqlSessionStorageClient, SqlSessionStorageTransaction } from "../../src/session/sql-session-storage";
import { SQL } from "bun";

interface Config {
	dsn: string;
	table: string;
	leaseTable: string;
	lease: { expiryMs: number; heartbeatMs: number };
	id: string;
	sessionFile: string;
	file: string;
}

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const STAGING = "#staging-";
const client = new SQL(config.dsn);
const forever = new Promise<never>(() => {});

/**
 * `inner`, which stops for good once the first transaction that wrote staging
 * parts committed: PostgreSQL and MySQL run a transaction through
 * `transaction()`, SQLite through `BEGIN IMMEDIATE` / `COMMIT` on `unsafe()`.
 */
function stopAfterFirstStagingBatch(inner: SqlSessionStorageClient): SqlSessionStorageClient {
	let staged = false;
	let stagesInOpenSqliteTransaction = false;
	const stop = (): Promise<never> => {
		staged = true;
		process.stdout.write(`${JSON.stringify({ staged: true })}\n`);
		return forever;
	};
	const writesStaging = (values: unknown[] | undefined): boolean =>
		values?.some(value => typeof value === "string" && value.includes(STAGING)) ?? false;
	return {
		options: inner.options,
		async unsafe(query, values) {
			if (staged) return forever;
			if (/^\s*BEGIN/i.test(query)) stagesInOpenSqliteTransaction = false;
			if (writesStaging(values)) stagesInOpenSqliteTransaction = true;
			const result = await inner.unsafe(query, values);
			if (/^\s*COMMIT/i.test(query) && stagesInOpenSqliteTransaction) return stop();
			return result;
		},
		async transaction(callback) {
			if (staged) return forever;
			let stages = false;
			const result = await inner.transaction(transaction =>
				callback({
					unsafe(query, values) {
						if (writesStaging(values)) stages = true;
						return transaction.unsafe(query, values);
					},
				} satisfies SqlSessionStorageTransaction),
			);
			return stages ? stop() : result;
		},
		end: () => inner.end?.() ?? Promise.resolve(),
	};
}

const storage = await SqlSessionStorage.create({
	client: stopAfterFirstStagingBatch(client),
	table: config.table,
	leaseTable: config.leaseTable,
	claims: true,
	lease: config.lease,
});
await storage.refresh();
const release = await storage.acquireSessionClaim?.(config.id, config.sessionFile);
if (typeof release !== "function") {
	process.stdout.write(`${JSON.stringify({ error: "claim refused" })}\n`);
	process.exit(1);
}
const pad = "s".repeat(1024 * 1024);
const timestamp = "2026-11-17T00:00:00.000Z";
// More than one staging batch (16 parts of 1 MiB per transaction).
const lines = [
	`${JSON.stringify({ type: "session", version: 3, id: config.id, timestamp, cwd: "/project" })}\n`,
	...Array.from(
		{ length: 40 },
		(_, n) =>
			`${JSON.stringify({ type: "custom", customType: "pad", id: `s${n}`, parentId: null, timestamp, data: pad })}\n`,
	),
];
await storage.writeLinesAtomic(config.file, lines, { expectedSize: null });
process.stdout.write(`${JSON.stringify({ error: "the staged write finished" })}\n`);
