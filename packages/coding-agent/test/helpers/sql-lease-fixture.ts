/**
 * One throwaway database for the session lease tests: a SQLite file always,
 * and PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name one (a PostgreSQL URL may name a transaction
 * pooler with `?pool_mode=transaction`). Every fixture makes its own session
 * and lease tables and drops them, and gives each store its own client, so
 * two stores are two lease holders as two processes are.
 */
import * as path from "node:path";
import { createSessionSqlClient } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageOptions,
	type SqlSessionStorageTransaction,
	sessionRowKey,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { SQL } from "bun";

type SqlClient = InstanceType<typeof SQL>;

export const LEASE_BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let sequence = 0;

export interface LeaseDb extends AsyncDisposable {
	readonly adapter: SqlSessionStorageAdapter;
	readonly dsn: string;
	readonly table: string;
	readonly leaseTable: string;
	/** The sessions root every store of the fixture keys rows against. */
	readonly root: string;
	readonly dir: TempDir;
	/**
	 * A new store on its own client: a lease holder of its own. `record`
	 * collects the text of every statement the store sends after it started.
	 */
	open(options?: {
		leaseHeartbeatMs?: number;
		redact?: (text: string) => string;
		wrapBackend?: SqlSessionStorageOptions["wrapBackend"];
		record?: string[];
	}): Promise<SqlSessionStorage>;
	/** Run `query` on the fixture's own client; `@1`, `@2` … are the dialect's placeholders. */
	sql(query: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>;
	/** The row key of local path `file`. */
	key(file: string): string;
	/** The session row of `file`: its content (row and parts) and `byte_len`, or `undefined`. */
	row(file: string): Promise<{ content: string; byteLen: number } | undefined>;
	/** Every row key under the key of local directory `dir`. */
	keysUnder(dir: string): Promise<string[]>;
	/** The lease rows of `sessionId`. */
	leases(sessionId: string): Promise<Array<{ holder: string; ageMs: number }>>;
	/** Move `sessionId`'s heartbeat back by `ms` on the database clock. */
	ageLease(sessionId: string, ms: number): Promise<void>;
}

export async function openLeaseDb(adapter: SqlSessionStorageAdapter, url: string): Promise<LeaseDb> {
	const dir = TempDir.createSync(`@omp-sql-lease-${adapter}-`);
	const previousAgentDir = getAgentDir();
	setAgentDir(dir.join("agent"));
	const dsn = adapter === "sqlite" ? `sqlite:${dir.join("sessions.db")}` : url;
	const table = `sl_${process.pid}_${sequence++}`;
	const leaseTable = `${table}_lease`;
	const root = dir.join("sessions");
	const admin = createSessionSqlClient(dsn);
	// A holder process may hold the SQLite write lock for a moment.
	if (adapter === "sqlite") await admin.unsafe("PRAGMA busy_timeout = 5000");
	const stores: Array<{ storage: SqlSessionStorage; client: SqlClient }> = [];
	const placeholder = (index: number): string => (adapter === "postgres" ? `$${index}` : "?");
	const sql = async (query: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
		(await admin.unsafe(
			query.replace(/@(\d+)/g, (_match, index: string) => placeholder(Number(index))),
			values,
		)) as Array<Record<string, unknown>>;
	const key = (file: string): string => sessionRowKey(file, root);
	const now = {
		postgres: "now()",
		mysql: "UTC_TIMESTAMP(6)",
		sqlite: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
	}[adapter];
	const ageOf = {
		postgres: `CAST(EXTRACT(EPOCH FROM (${now} - heartbeat_at)) * 1000 AS BIGINT)`,
		mysql: `TIMESTAMPDIFF(MICROSECOND, heartbeat_at, ${now}) DIV 1000`,
		sqlite: `${now} - heartbeat_at`,
	}[adapter];
	return {
		adapter,
		dsn,
		table,
		leaseTable,
		root,
		dir,
		key,
		sql,
		async open(options = {}) {
			const client = createSessionSqlClient(dsn);
			const { record, ...storeOptions } = options;
			let recording = false;
			const sent = (query: string): void => {
				if (recording) record?.push(query);
			};
			const storage = await SqlSessionStorage.create({
				client: record ? recordingClient(client, sent) : client,
				table,
				leaseTable,
				sessionsRoot: root,
				...storeOptions,
			});
			recording = true;
			stores.push({ storage, client });
			return storage;
		},
		async row(file) {
			const [row] = await sql(`SELECT content, byte_len FROM ${table} WHERE path = @1`, [key(file)]);
			if (!row) return undefined;
			const parts = await sql(`SELECT content FROM ${table}_parts WHERE path = @1 ORDER BY start_offset`, [
				key(file),
			]);
			return {
				content: String(row.content) + parts.map(part => String(part.content)).join(""),
				byteLen: Number(row.byte_len),
			};
		},
		async keysUnder(prefixDir) {
			const prefix = `${key(path.join(prefixDir, "x")).slice(0, -1)}`;
			const rows = await sql(`SELECT path FROM ${table} ORDER BY path`);
			return rows.map(row => String(row.path)).filter(rowKey => rowKey.startsWith(prefix));
		},
		async leases(sessionId) {
			const rows = await sql(`SELECT holder, ${ageOf} AS age FROM ${leaseTable} WHERE session_id = @1`, [sessionId]);
			return rows.map(row => ({ holder: String(row.holder), ageMs: Number(row.age) }));
		},
		async ageLease(sessionId, ms) {
			const earlier = {
				postgres: `${now} - interval '${ms / 1000} seconds'`,
				mysql: `${now} - INTERVAL ${ms * 1000} MICROSECOND`,
				sqlite: `${now} - ${ms}`,
			}[adapter];
			await sql(`UPDATE ${leaseTable} SET heartbeat_at = ${earlier} WHERE session_id = @1`, [sessionId]);
		},
		async [Symbol.asyncDispose]() {
			try {
				for (const { storage, client } of stores) {
					await storage.drain().catch(() => undefined);
					await client.end();
				}
				for (const name of [`${table}_parts`, `${table}_meta`, table, leaseTable]) {
					await admin.unsafe(`DROP TABLE IF EXISTS ${name}`);
				}
			} finally {
				await admin.end();
				setAgentDir(previousAgentDir);
				dir.removeSync();
			}
		},
	};
}

const CONFIG_MODULE = path.join(import.meta.dir, "../../src/session/session-storage-config.ts");
const STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/sql-session-storage.ts");
const MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

/** What a holder process answers each command with. */
export interface HolderReport {
	/** The session file it saves to. */
	file: string;
	/** Its session id. */
	id: string;
	/** The failure `flush()` (or `close()`, for `exit`) reported, if any. */
	error?: string;
}

/** What {@link SqlSessionHolder.open} opens beside the session. */
export interface HolderOptions {
	/** A subagent transcript under the session, opened by a second manager on the same store, as the task tool does. */
	subagent?: string;
	/** The store's heartbeat interval; a long one keeps a test's own heartbeat ageing in place. */
	leaseHeartbeatMs?: number;
}

/**
 * Another omp process with `file` open through its own `SqlSessionStorage`
 * on the fixture's database, and optionally a subagent transcript on the
 * same store. Commands, one per line: `append <text>` writes a user turn to
 * the session and flushes; `subagent <text>` does the same on the subagent
 * transcript; `exit` closes both and ends the client. Each answers one
 * {@link HolderReport} line for the manager it wrote.
 */
export class SqlSessionHolder {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";
	#exited = false;

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	/** Start the process and wait until it has opened `file` (and the subagent transcript). */
	static async open(
		db: LeaseDb,
		file: string,
		options: HolderOptions = {},
	): Promise<{ holder: SqlSessionHolder; opened: HolderReport }> {
		const script = db.dir.join("sql-session-holder.ts");
		await Bun.write(
			script,
			[
				`import { createSessionSqlClient } from ${JSON.stringify(CONFIG_MODULE)};`,
				`import { SqlSessionStorage } from ${JSON.stringify(STORAGE_MODULE)};`,
				`import { SessionManager } from ${JSON.stringify(MANAGER_MODULE)};`,
				"const [dsn, table, leaseTable, sessionsRoot, file, subagentFile, heartbeat] = process.argv.slice(2);",
				"const client = createSessionSqlClient(dsn);",
				"const storage = await SqlSessionStorage.create({",
				"	client, table, leaseTable, sessionsRoot,",
				"	...(heartbeat ? { leaseHeartbeatMs: Number(heartbeat) } : {}),",
				"});",
				"const open = target => SessionManager.open(target, undefined, storage, { suppressBreadcrumb: true });",
				"const manager = await open(file);",
				"const subagent = subagentFile ? await open(subagentFile) : undefined;",
				"const report = (target, error) => process.stdout.write(JSON.stringify({ file: target.getSessionFile(), id: target.getSessionId(), error }) + '\\n');",
				"const message = err => (err instanceof Error ? err.message : String(err));",
				"report(manager);",
				"for await (const line of console) {",
				"	if (line === 'exit') break;",
				"	const space = line.indexOf(' ');",
				"	const target = line.slice(0, space) === 'subagent' ? subagent : manager;",
				"	target.appendMessage({ role: 'user', content: line.slice(space + 1), timestamp: Date.now() });",
				"	let error;",
				"	try { await target.flush(); } catch (err) { error = message(err); }",
				"	report(target, error);",
				"}",
				"let closeError;",
				"for (const target of [subagent, manager]) {",
				"	try { await target?.close(); } catch (err) { closeError ??= message(err); }",
				"}",
				"await storage.drain().catch(() => undefined);",
				"await client.end();",
				"report(manager, closeError);",
			].join("\n"),
		);
		const args = [
			db.dsn,
			db.table,
			db.leaseTable,
			db.root,
			file,
			options.subagent ?? "",
			String(options.leaseHeartbeatMs ?? ""),
		];
		const holder = new SqlSessionHolder(
			Bun.spawn([process.execPath, script, ...args], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			}),
		);
		return { holder, opened: await holder.#next() };
	}

	async #next(): Promise<HolderReport> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The holder process exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return JSON.parse(line) as HolderReport;
	}

	/** Append one user turn to the session and flush it; answers where it was saved. */
	append(text: string): Promise<HolderReport> {
		return this.#command(`append ${text}`);
	}

	/** Append one user turn to the subagent transcript and flush it; answers where it was saved. */
	appendSubagent(text: string): Promise<HolderReport> {
		return this.#command(`subagent ${text}`);
	}

	#command(line: string): Promise<HolderReport> {
		this.#child.stdin.write(`${line}\n`);
		this.#child.stdin.flush();
		return this.#next();
	}

	/** Close the session and wait for the process to exit. */
	async exit(): Promise<HolderReport> {
		this.#exited = true;
		this.#child.stdin.write("exit\n");
		this.#child.stdin.flush();
		const report = await this.#next();
		await this.#child.exited;
		return report;
	}

	/** Kill the process unless it exited. */
	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#exited) return;
		this.#child.kill();
		await this.#child.exited;
	}
}

/** `client`, telling `sent` the text of every statement it runs, in transactions too. */
function recordingClient(client: SqlClient, sent: (query: string) => void): SqlSessionStorageClient {
	const recorded = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		unsafe(query, values) {
			sent(query);
			return executor.unsafe(query, values);
		},
	});
	return new Proxy(client as unknown as SqlSessionStorageClient, {
		get(target, property, receiver) {
			if (property === "unsafe") return recorded(target).unsafe;
			if (property === "transaction") {
				return (callback: (transaction: SqlSessionStorageTransaction) => Promise<void>) =>
					target.transaction(transaction => callback(recorded(transaction)));
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
