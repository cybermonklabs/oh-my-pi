/**
 * Another process holding a SQLite session claim, for
 * `sql-session-sqlite-claim-release.test.ts`. argv[2] is a JSON
 * {@link HolderConfig}. It claims `sessionId` at `file` through a store of its
 * own and reports `{ "held": boolean }`. On its first line on stdin it waits
 * `releaseAfterMs`, gives the claim up, drains the store, reports
 * `{ "stillHeldAt": ms }`, a time (`performance.timeOrigin + performance.now()`)
 * at which it still held the claim, taken just before it gave the claim up,
 * and exits.
 */
import { SqlSessionStorage } from "../../src/session/sql-session-storage";
import { SQL } from "bun";

interface HolderConfig {
	dsn: string;
	table: string;
	leaseTable: string;
	sessionId: string;
	file: string;
	releaseAfterMs: number;
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
for await (const line of console) {
	if (!line.trim()) continue;
	await Bun.sleep(config.releaseAfterMs);
	const stillHeldAt = performance.timeOrigin + performance.now();
	release?.();
	await storage.drain();
	process.stdout.write(`${JSON.stringify({ stillHeldAt })}\n`);
	break;
}
await client.end();
process.exit(0);
