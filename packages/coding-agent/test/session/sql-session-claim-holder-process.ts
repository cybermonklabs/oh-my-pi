/**
 * Another process holding a SQLite session claim, for
 * `sql-session-sqlite-claim-release.test.ts`. argv[2] is a JSON
 * {@link HolderConfig}. It claims `sessionId` at `file` through a store of its
 * own, reports `{ "held": boolean }`, and keeps the claim until its stdin
 * closes or it is killed.
 */
import { SqlSessionStorage } from "../../src/session/sql-session-storage";
import { SQL } from "bun";

interface HolderConfig {
	dsn: string;
	table: string;
	leaseTable: string;
	sessionId: string;
	file: string;
}

const config = JSON.parse(process.argv[2] ?? "{}") as HolderConfig;
const client = new SQL(config.dsn);
const storage = await SqlSessionStorage.create({
	client,
	table: config.table,
	leaseTable: config.leaseTable,
	claims: true,
});
const release = await storage.acquireSessionClaim?.(config.sessionId, config.file);
process.stdout.write(`${JSON.stringify({ held: Boolean(release) })}\n`);
await Bun.stdin.text();
process.exit(0);
