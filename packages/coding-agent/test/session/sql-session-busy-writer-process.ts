/**
 * Another omp process that keeps writing one session of a SQLite session
 * table while a test reads another session of the same file (see
 * `sql-session-read-busy-file.test.ts`). argv[2] is a JSON `Config`. Through
 * a store of this release on a connection of its own, it claims session
 * `sessionId` at `path` and appends `header`; then, on its own clock, it
 * appends one entry every `everyMs` milliseconds, as a running agent writes
 * its turns, until its stdin ends. It exits 0 once its last append is stored.
 */
import { SqlSessionStorage } from "../../src/session/sql-session-storage";
import { SQL } from "bun";

interface Config {
	dsn: string;
	table: string;
	leaseTable: string;
	lease: { expiryMs: number; heartbeatMs: number };
	sessionId: string;
	path: string;
	header: string;
	everyMs: number;
}

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const client = new SQL(config.dsn);
const storage = await SqlSessionStorage.create({
	client,
	table: config.table,
	leaseTable: config.leaseTable,
	claims: true,
	lease: config.lease,
});
const release = await storage.acquireSessionClaim?.(config.sessionId, config.path);
const writer = storage.openWriter(config.path, { flags: "a" });
await writer.append(config.header);
// The test stops the process by ending its stdin.
let stopping = false;
const stopped = Bun.stdin.text().then(() => {
	stopping = true;
});
for (let tick = 0; ; tick++) {
	await Promise.race([Bun.sleep(config.everyMs), stopped]);
	if (stopping) break;
	await writer.append(
		`${JSON.stringify({ type: "custom", customType: "tick", id: `t${tick}`, parentId: null, timestamp: new Date().toISOString() })}\n`,
	);
}
await writer.close();
release?.();
await storage.drain();
await client.end();
process.exit(0);
