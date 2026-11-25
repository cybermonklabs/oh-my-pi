/**
 * Another process that writes a session of a SQLite session table the way an
 * omp release older than the store's SQLite rowid rule does (as
 * `olderWriterWrites` in `chunked-read-race.ts` does on the test's own
 * connection), through a connection of its own (`bun:sqlite`): in one
 * transaction it deletes the session's parts and row, inserts its row, then
 * inserts each line as a part whose rowid is the parts table's largest rowid
 * plus one, so a session it deletes and writes again gives its new parts the
 * rowids of the old ones. It reads one JSON object on stdin: the database
 * `file`, the session `table`, the session `path` and its `lines`. It exits 0
 * once the transaction has committed.
 */
import { Database } from "bun:sqlite";

interface Config {
	file: string;
	table: string;
	path: string;
	lines: string[];
}

const config = (await Bun.stdin.json()) as Config;
const db = new Database(config.file);
// The test's stores may hold the write lock for a moment.
db.run("PRAGMA busy_timeout = 5000");
const parts = `${config.table}_parts`;
const write = db.transaction(() => {
	db.query(`DELETE FROM ${parts} WHERE path = ?`).run(config.path);
	db.query(`DELETE FROM ${config.table} WHERE path = ?`).run(config.path);
	const size = config.lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
	db.query(`INSERT INTO ${config.table} (path, content, mtime_ms, byte_len) VALUES (?, '', ?, ?)`).run(
		config.path,
		Date.now(),
		size,
	);
	const insert = db.query(
		`INSERT INTO ${parts} (rowid, path, start_offset, content) ` +
			`VALUES ((SELECT coalesce(max(rowid), 0) + 1 FROM ${parts}), ?, ?, ?)`,
	);
	let offset = 0;
	for (const line of config.lines) {
		insert.run(config.path, offset, line);
		offset += Buffer.byteLength(line);
	}
});
write.immediate();
db.close();
