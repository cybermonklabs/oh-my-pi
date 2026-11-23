/**
 * One process of a two-process check that a store's open path takes the SQLite lock shim (#15586) in a
 * process that never ran the omp CLI entry (an SDK host, a script, a test's child process).
 *
 * - `hold <row> <dir>` plays an omp session: it installs the shim, runs the row's open path, keeps the
 *   row's file open with open-file-description locks, writes `READY`, and waits for stdin to close.
 * - `open <row> <dir>` runs the row's open path without installing the shim itself, times it, then
 *   reports the kind of record lock a database opened afterwards in this process takes: the shim covers
 *   the whole process once installed, so `OFDLCK` means the open path installed it, `POSIX` that it did not.
 *   Prints `{"ms":…,"kinds":[…]}` as its last line; `kinds` is empty where `/proc/locks` is missing.
 *
 * Where the two lock kinds do not see each other (gVisor), an open without the shim next to the holder
 * waits about 10 s per statement.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

const [mode, row, dir] = process.argv.slice(2);
if ((mode !== "hold" && mode !== "open") || !row || !dir) {
	throw new Error("usage: sqlite-lock-shim-probe <hold|open> <row> <scratch dir>");
}

interface Row {
	/** The file the row's store opens. */
	file: () => Promise<string>;
	/** The store's open path. */
	open: () => Promise<unknown>;
	/** Run by the holder before it holds the file, when `open` alone does not create it. */
	prepare?: () => Promise<unknown>;
}

/** Modules load only inside a row, so nothing installs the shim before the row's open path runs. */
const rows: Record<string, Row> = {
	stats: {
		file: async () => (await import("@oh-my-pi/pi-utils")).getStatsDbPath(),
		open: async () => {
			const { initDb } = await import("../../src/db");
			await initDb();
		},
	},
	"usage-windows": {
		file: async () => (await import("@oh-my-pi/pi-utils")).getAgentDbPath(),
		prepare: async () => {
			const agentDb = (await import("@oh-my-pi/pi-utils")).getAgentDbPath();
			fs.mkdirSync(path.dirname(agentDb), { recursive: true });
			const db = new Database(agentDb, { create: true });
			db.run("PRAGMA journal_mode=WAL");
			db.run("CREATE TABLE IF NOT EXISTS probe (x)");
			db.close();
		},
		open: async () => {
			const { readUsageSnapshots } = await import("../../src/usage-windows");
			readUsageSnapshots(0);
		},
	},
};

const entry = rows[row];
if (!entry) throw new Error(`unknown row ${row}`);

if (mode === "hold") {
	(await import("@oh-my-pi/pi-utils")).ensureSqliteLockShim();
	await entry.prepare?.();
	await entry.open();
	const held = new Database(await entry.file());
	held.query("PRAGMA user_version").get();
	process.stdout.write("READY\n");
	for await (const _ of process.stdin) {
		// Hold the file until the test closes stdin.
	}
	held.close();
	process.exit(0);
}

const start = performance.now();
try {
	await entry.open();
} catch {
	// A failed open still counts its time; the lock-kind check below decides the rest.
}
const ms = Math.round(performance.now() - start);

// A database opened now takes whatever record locks this process's SQLite takes. The write makes the
// WAL and its index; the open read transaction holds their locks while the table is read.
const kinds = new Set<string>();
if (fs.existsSync("/proc/locks")) {
	const scratch = path.join(dir, "lock-kind.db");
	const db = new Database(scratch, { create: true });
	db.run("PRAGMA journal_mode=WAL");
	db.run("CREATE TABLE IF NOT EXISTS t (x)");
	db.run("INSERT INTO t VALUES (1)");
	db.run("BEGIN");
	db.query("SELECT count(*) FROM t").get();
	const inodes = new Set([scratch, `${scratch}-shm`].map(file => String(fs.statSync(file).ino)));
	// Each line: `<id>: <kind> <ADVISORY|MANDATORY> <READ|WRITE> <pid> <major>:<minor>:<inode> <start> <end>`.
	for (const line of fs.readFileSync("/proc/locks", "utf8").split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 6 || fields[1] === "->") continue;
		const [kind, , , pid, device] = fields.slice(1);
		const inode = device?.split(":").at(-1);
		if (!inode || !inodes.has(inode)) continue;
		// OFD locks list no owner (-1); POSIX locks list their process.
		if (kind === "OFDLCK" || (kind === "POSIX" && pid === String(process.pid))) kinds.add(kind);
	}
	db.close();
}
process.stdout.write(`\n${JSON.stringify({ ms, kinds: [...kinds].sort() })}\n`);
process.exit(0);
