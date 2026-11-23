/**
 * One process of a two-process check that a store's open path takes the SQLite lock shim (#15586) in a
 * process that never ran the CLI entry (an SDK host, a script, a test's child process).
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
const agentDir = path.join(dir, "agent");

interface Row {
	/** The file the row's store opens. */
	file: () => Promise<string>;
	/** The store's open path. */
	open: () => Promise<unknown>;
	/** Run by the holder before it holds the file, when `open` alone does not create it. */
	prepare?: () => Promise<unknown>;
	/** What the holder runs in place of `open`, when the two sides of a row open differently. */
	holderOpen?: () => Promise<unknown>;
}

const utils = () => import("@oh-my-pi/pi-utils");

/** Modules load only inside a row, so nothing installs the shim before the row's open path runs. */
const rows: Record<string, Row> = {
	autoresearch: {
		file: async () => path.join(dir, "autoresearch.db"),
		open: async () => {
			const { AutoresearchStorage } = await import("../../src/autoresearch/storage");
			new AutoresearchStorage(path.join(dir, "autoresearch.db"), dir);
		},
	},
	"legacy-auth": {
		file: async () => (await utils()).getAgentDbPath(),
		open: async () => {
			const { AuthStorage } = await import("../../src/extensibility/legacy-pi-coding-agent-shim");
			AuthStorage.create().get("probe");
		},
	},
	"skill-descriptions": {
		file: async () => path.join(dir, "skill-descriptions.db"),
		open: async () => {
			const { SkillDescriptionStore } = await import("../../src/extensibility/skill-descriptions");
			SkillDescriptionStore.open(path.join(dir, "skill-descriptions.db"));
		},
	},
	memories: {
		file: async () => path.join(dir, "memories.db"),
		open: async () => {
			const { openMemoryDb } = await import("../../src/memories/storage");
			openMemoryDb(path.join(dir, "memories.db"));
		},
	},
	"mnemopi-legacy-bank": {
		file: async () => path.join(dir, "banks", "bank-1", "mnemopi.db"),
		prepare: async () => {
			const bank = path.join(dir, "banks", "bank-1", "mnemopi.db");
			fs.mkdirSync(path.dirname(bank), { recursive: true });
			const db = new Database(bank, { create: true });
			db.run("PRAGMA journal_mode=WAL");
			db.run("CREATE TABLE IF NOT EXISTS working_memory (id INTEGER PRIMARY KEY, metadata_json TEXT)");
			db.close();
		},
		open: async () => {
			const { extendRecallWithLegacyBanks } = await import("../../src/mnemopi/config");
			extendRecallWithLegacyBanks([], path.join(dir, "mnemopi.db"), dir);
		},
	},
	"session-index": {
		file: async () => (await utils()).getHistoryDbPath(),
		open: async () => {
			const { recordSessionTitle } = await import("../../src/session/session-index");
			recordSessionTitle("probe", "probe");
		},
	},
	approvals: {
		file: async () => path.join(dir, "approval-cache.db"),
		prepare: async () => {
			const { ApprovalCache } = await import("../../src/tools/approval-cache");
			new ApprovalCache(dir).record("probe", "probe");
		},
		open: async () => {
			const { ApprovalCache } = await import("../../src/tools/approval-cache");
			const cache = new ApprovalCache(dir);
			cache.present(["probe"]);
			cache.record("probe-2", "probe");
			cache.clear();
		},
	},
	"github-cache": {
		file: async () => (await utils()).getGithubCacheDbPath(),
		open: async () => {
			const { openDb } = await import("../../src/tools/github-cache");
			openDb();
		},
	},
	"auto-qa": {
		file: async () => (await utils()).getAutoQaDbPath(),
		open: async () => {
			const { openAutoQaDb } = await import("../../src/tools/report-tool-issue");
			openAutoQaDb();
		},
	},
	"sqlite-reader": {
		file: async () => path.join(dir, "read-tool.db"),
		prepare: async () => {
			const db = new Database(path.join(dir, "read-tool.db"), { create: true });
			db.run("PRAGMA journal_mode=WAL");
			db.run("CREATE TABLE IF NOT EXISTS t (x)");
			db.close();
		},
		open: async () => {
			const { openSqliteReadConnection } = await import("../../src/tools/sqlite-reader");
			const db = await openSqliteReadConnection(path.join(dir, "read-tool.db"));
			db.query("SELECT count(*) FROM t").get();
			db.close();
		},
	},
	"commit-cache": {
		file: async () => path.join(dir, "commit-cache.db"),
		open: async () => {
			const { CommitInferenceCache } = await import("../../src/commit/conventional/cache");
			await CommitInferenceCache.open(path.join(dir, "commit-cache.db"), 1);
		},
	},
	gc: {
		file: async () => (await utils()).getHistoryDbPath(agentDir),
		prepare: async () => {
			const db = new Database((await utils()).getHistoryDbPath(agentDir), { create: true });
			db.run("PRAGMA journal_mode=WAL");
			db.run("CREATE TABLE IF NOT EXISTS t (x)");
			db.close();
		},
		open: async () => {
			const { runGcCommand } = await import("../../src/cli/gc-cli");
			await runGcCommand({ flags: { wal: true, apply: true, json: true, agentDir } });
		},
	},
	// The hint store's legacy file (<agent dir>/skill-descriptions.db) that an omp session without XDG
	// holds, adopted by an omp process whose XDG data dir relocates the store (the test's env for this row).
	"hint-store-adoption": {
		file: async () => path.join(dir, ".omp", "agent", "skill-descriptions.db"),
		prepare: async () => {
			fs.mkdirSync(path.join(dir, "xdg-data", "omp"), { recursive: true });
		},
		holderOpen: async () => {
			const { SkillDescriptionStore } = await import("../../src/extensibility/skill-descriptions");
			const store = SkillDescriptionStore.open(path.join(dir, ".omp", "agent", "skill-descriptions.db"));
			store.put("adopted", "yes");
			store.close();
		},
		open: async () => {
			const { SkillDescriptionStore } = await import("../../src/extensibility/skill-descriptions");
			// The default path argument adopts the legacy file before the store opens.
			const store = SkillDescriptionStore.open();
			const adopted = store.get("adopted");
			store.close();
			if (adopted !== "yes") throw new Error("the legacy hint store was not adopted");
		},
	},
};

const entry = rows[row];
if (!entry) throw new Error(`unknown row ${row}`);
fs.mkdirSync(agentDir, { recursive: true });

if (mode === "hold") {
	(await utils()).ensureSqliteLockShim();
	await entry.prepare?.();
	await (entry.holderOpen ?? entry.open)();
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
let error = "";
try {
	await entry.open();
} catch (caught) {
	error = String(caught).slice(0, 200);
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
// Some rows print their own output (gc's report); the result is the last line.
process.stdout.write(`\n${JSON.stringify({ ms, error, kinds: [...kinds].sort() })}\n`);
process.exit(0);
