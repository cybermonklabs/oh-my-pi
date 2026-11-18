/**
 * PostgreSQL hardening of `SqlSessionStorage` against a login that can make
 * objects in the store's schema (`CREATE` on `public`, as the pods' agent
 * login has) or that once owned the store's tables:
 * - every statement runs with `search_path` locked to `pg_catalog, pg_temp`
 *   and every table qualified, so a function or operator planted in `public`
 *   (the CVE-2018-1058 class) is never picked;
 * - `create()` refuses tables whose columns, triggers, rules, policies,
 *   constraints or indexes would run code the store did not declare.
 * The first describe runs everywhere against a recording fake client; the
 * second against PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL` names one.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import {
	type LeaseDb,
	openLeaseDb,
	TcpProxy,
	transcript,
	unqualifiedNames,
	until,
	type WireRecord,
} from "./sql-session-lease-fixture";

// The heartbeat runs on the store's own interval timer, in real time; the
// timings below keep that wait to a fraction of a second.

const ID = "01a1f300-0000-7000-8000-000000000001";
const OTHER_ID = "01a1f300-0000-7000-8000-000000000002";
const SEARCH_PATH = "SET LOCAL search_path = pg_catalog, pg_temp";
const SESSION_TABLE = "omp_session_files";
const PARTS_TABLE = "omp_session_files_parts";
const LEASE_TABLE = "omp_session_leases";

/** The columns of the store's three tables and their declared types. */
const DECLARED: Record<string, Record<string, string>> = {
	[SESSION_TABLE]: {
		path: "text",
		content: "text",
		mtime_ms: "bigint",
		title: "text",
		title_source: "text",
		title_updated_at: "text",
		byte_len: "bigint",
	},
	[PARTS_TABLE]: { path: "text", start_offset: "bigint", content: "text" },
	[LEASE_TABLE]: {
		session_id: "text",
		holder: "text",
		host: "text",
		pid: "bigint",
		acquired_at: "bigint",
		heartbeat_at: "bigint",
	},
};

interface Sent {
	sql: string;
	values: unknown[] | undefined;
	/** The transaction that sent it, numbered from 1; `null` for the bare client. */
	transaction: number | null;
}

interface FakeServer {
	/** The tables lack every column and the lease index, so `init()` adds them. */
	empty?: boolean;
	/** A column of a table whose type the integrity check reads as something else. */
	plantedType?: { table: string; column: string; type: string };
	/** Objects on the tables the integrity check reads, as `{ kind, name }` rows. */
	plantedObjects?: Array<{ kind: string; name: string }>;
	/** The session paths the session table holds, as its index load reads them. */
	indexed?: string[];
	/** What holds the lease index's name, as the store's probe of that name reads it. */
	holderName?: { oid: string; kind: string; name: string; on_table: string | null };
	/** The `byte_len` the session table holds for a path, as a size read finds it; 0 for any other path. */
	sizes?: Record<string, number>;
}

/** A one-statement read's opening: the lock, then the read, in one simple query. */
const LOCKED = `${SEARCH_PATH}; `;

/** `sql` without a one-statement read's lock. */
function body(sql: string): string {
	return sql.startsWith(LOCKED) ? sql.slice(LOCKED.length) : sql;
}

/** The table a relation argument names, from its qualified spelling `"public".<name>`. */
function tableOf(values: unknown[] | undefined): string {
	const value = String(values?.[0] ?? "");
	return value.slice(value.lastIndexOf(".") + 1);
}

/**
 * A PostgreSQL client that answers enough for the store to run every kind of
 * statement it has, and records each one with the transaction that sent it.
 */
function recordingPostgres(sent: Sent[], server: FakeServer = {}): SqlSessionStorageClient {
	let transactions = 0;
	/** Set once the store made the lease table's holder index, so the next probe finds it. */
	let indexMade = false;
	const holderIndex = () => !server.empty || indexMade;
	const answer = (sql: string, values: unknown[] | undefined): SqlSessionStorageResult => {
		// Alone, or in the one step that makes the tables.
		if (/\bCREATE INDEX /.test(sql)) indexMade = true;
		if (sql.includes(" AS column_name FROM ")) {
			if (server.empty) return [];
			return Object.keys(DECLARED[tableOf(values)] ?? {}).map(column_name => ({ column_name }));
		}
		if (sql.startsWith("SELECT a.attname AS name, pg_catalog.format_type(")) {
			const table = tableOf(values);
			return Object.entries(DECLARED[table] ?? {}).map(([name, type]) => ({
				name,
				type:
					server.plantedType?.table === table && server.plantedType.column === name
						? server.plantedType.type
						: type,
				has_default: false,
				generated: "",
				identity: "",
			}));
		}
		if (sql.startsWith("SELECT 'trigger' AS kind")) return server.plantedObjects ?? [];
		if (sql.startsWith("SELECT i.indexrelid::text AS oid FROM pg_catalog.pg_index i")) {
			return holderIndex() ? [{ oid: "1" }] : [];
		}
		if (sql.startsWith("SELECT c.oid::text AS oid, c.relkind::text AS kind")) {
			if (server.holderName) return [server.holderName];
			return holderIndex()
				? [{ oid: "1", kind: "i", name: `public.${LEASE_TABLE}_holder`, on_table: `public.${LEASE_TABLE}` }]
				: [];
		}
		if (sql.startsWith("SELECT 1 AS unmeasured FROM")) return [{ unmeasured: 1 }];
		if (sql.includes("RETURNING holder")) return values?.includes(OTHER_ID) ? [] : [{ holder: "fake" }];
		if (sql.startsWith("SELECT host, pid,")) return [{ host: "elsewhere", pid: 1, stale: 0 }];
		// No other holder's fresh lease of a session the store did not claim; its own row of one it did.
		if (sql.startsWith("SELECT holder FROM") && sql.includes(" AND holder <> ")) return [];
		if (sql.startsWith("SELECT holder FROM")) return [{ holder: "fake" }];
		if (sql.includes("SET heartbeat_at = ")) return [{ session_id: ID }];
		if (sql.endsWith("RETURNING path")) return [{ path: "renamed" }];
		if (sql.startsWith("SELECT path, mtime_ms, byte_len")) {
			return (server.indexed ?? []).map(path => ({
				path,
				mtime_ms: 1,
				byte_len: 0,
				title: null,
				title_source: null,
				title_updated_at: null,
			}));
		}
		if (sql.startsWith("SELECT path FROM")) return [{ path: "exists" }];
		if (sql.startsWith("SELECT byte_len FROM")) return [{ byte_len: server.sizes?.[String(values?.[0])] ?? 0 }];
		if (sql.startsWith("SELECT 0 AS kind, 0 AS start_offset, content ")) {
			return [{ kind: 0, start_offset: 0, content: "" }];
		}
		if (sql.startsWith("SELECT 0 AS kind, 0 AS start_offset, CASE")) {
			return [{ kind: 0, start_offset: 0, head: new Uint8Array(), tail: new Uint8Array() }];
		}
		if (sql.startsWith("SELECT 0 AS kind, 0 AS start_offset, byte_len")) {
			return [{ kind: 0, start_offset: 0, byte_len: 0, bytes: new Uint8Array() }];
		}
		return [];
	};
	const handle = (transaction: number | null): SqlSessionStorageTransaction => ({
		async unsafe(sql, values): Promise<SqlSessionStorageResult> {
			sent.push({ sql, values, transaction });
			// A read and its search_path lock in one simple query: one result per statement.
			if (sql.startsWith(LOCKED)) return [[], answer(sql.slice(LOCKED.length), values)];
			return answer(sql, values);
		},
	});
	const bare = handle(null);
	return {
		options: { adapter: "postgres" },
		unsafe: (sql, values) => bare.unsafe(sql, values),
		async transaction(callback) {
			transactions += 1;
			return callback(handle(transactions));
		},
	};
}

const UNQUALIFIED_TABLE = new RegExp(`(?<![".\\w])(${SESSION_TABLE}(?:_parts)?|${LEASE_TABLE})\\b`, "g");
const BARE_RELATION_VALUE = new RegExp(`^(${SESSION_TABLE}(_parts)?|${LEASE_TABLE}(_holder)?)$`);

/**
 * Every way `sent` departs from the rule: a statement outside a transaction
 * that neither opens with the search_path lock (a one-statement read) nor
 * names only `pg_catalog` functions and operators (the heartbeat), a
 * statement of a transaction before its `search_path` lock (its
 * `SET TRANSACTION`s aside), and a table, or a relation argument, without its
 * schema.
 */
function unlockedStatements(sent: readonly Sent[]): string[] {
	const problems: string[] = [];
	const byTransaction = new Map<number, Sent[]>();
	for (const statement of sent) {
		if (statement.transaction === null) {
			const unqualified = statement.sql.startsWith(LOCKED) ? [] : unqualifiedNames(statement.sql);
			if (unqualified.length > 0) {
				problems.push(`outside a transaction, naming ${unqualified.join(" ")} unqualified: ${statement.sql}`);
			}
			continue;
		}
		const statements = byTransaction.get(statement.transaction) ?? [];
		statements.push(statement);
		byTransaction.set(statement.transaction, statements);
	}
	for (const statements of byTransaction.values()) {
		const locked = statements.findIndex(statement => statement.sql === SEARCH_PATH);
		for (const [index, statement] of statements.entries()) {
			if (statement.sql === SEARCH_PATH || statement.sql.startsWith("SET TRANSACTION ")) continue;
			if (locked < 0 || index < locked) problems.push(`before the search_path lock: ${statement.sql}`);
		}
	}
	for (const statement of sent) {
		for (const match of statement.sql.matchAll(UNQUALIFIED_TABLE)) {
			problems.push(`table ${match[1]} without its schema: ${statement.sql}`);
		}
		for (const value of statement.values ?? []) {
			if (typeof value === "string" && BARE_RELATION_VALUE.test(value)) {
				problems.push(`relation ${value} without its schema: ${statement.sql}`);
			}
		}
	}
	return problems;
}

describe("SqlSessionStorage on PostgreSQL, without a server", () => {
	it("sends every statement under the pg_catalog search_path lock, with every table qualified", async () => {
		const sent: Sent[] = [];
		const file = `/sessions/p/2026-11-17T00-00-00-000Z_${ID}.jsonl`;
		const moved = `/sessions/p/2026-11-17T00-00-00-000Z_${ID}-moved.jsonl`;
		const created = `/sessions/p/2026-11-17T00-00-00-000Z_${ID}-created.jsonl`;
		const storage = await SqlSessionStorage.create({
			// The append below is checked against the size the full write left.
			client: recordingPostgres(sent, {
				indexed: [moved],
				sizes: { [file]: Buffer.byteLength(transcript(ID, "full write")) },
			}),
			claims: true,
			lease: { expiryMs: 2000, heartbeatMs: 20 },
		});
		// A store on tables that lack their columns and the lease index adds them.
		await SqlSessionStorage.create({ client: recordingPostgres(sent, { empty: true }), claims: true });
		const release = await storage.acquireSessionClaim?.(ID, file);
		expect(release).toBeFunction();
		await storage.writeText(file, transcript(ID, "full write"));
		const writer = storage.openWriter(file);
		await writer.append('{"type":"append"}\n');
		await writer.close();
		await storage.updateSessionTitle(file, { title: "title", source: "user", updatedAt: "2026-11-17" });
		const truncating = storage.openWriter(file, { flags: "w" });
		await truncating.flush();
		await truncating.close();
		storage.writeTextSync(created, transcript(ID, "created"), { expectedSize: null });
		storage.writeTextSync(created, transcript(ID, "replaced"), {
			expectedSize: Buffer.byteLength(transcript(ID, "created")),
		});
		await storage.drain().catch(() => undefined);
		await storage.readText(file);
		await storage.readTextSlices(file, 64, 64);
		await storage.readTextFrom(file, 0, 64);
		await storage.rename(file, moved);
		await storage.rename(moved, moved);
		await storage.deleteSessionWithArtifacts(moved);
		await storage.refresh();
		await until(() => sent.some(statement => statement.sql.includes("SET heartbeat_at = ")), 5000);
		// A claim another holder has: refused, then the holder is read while it waits.
		expect(
			await storage.acquireSessionClaim?.(OTHER_ID, `/sessions/p/x_${OTHER_ID}.jsonl`, { waitMs: 50 }),
		).toBeNull();
		release?.();
		await storage.drain();

		const kinds = [
			/^CREATE TABLE IF NOT EXISTS /,
			/^ALTER TABLE /,
			// Made in the one step that makes the tables, after them.
			/(^|; )CREATE INDEX IF NOT EXISTS /,
			/^UPDATE \S+ SET byte_len = /,
			/^SELECT a\.attname AS name/,
			/^SELECT 'trigger' AS kind/,
			/RETURNING holder$/,
			/^SELECT holder FROM \S+ WHERE session_id = \$1 AND holder = \$2 FOR SHARE$/,
			/^SELECT holder FROM \S+ WHERE session_id = \$1 AND holder <> \$2 AND NOT \(heartbeat_at < .* OR heartbeat_at > /,
			/SET heartbeat_at = /,
			/^SELECT host, pid,/,
			/^DELETE FROM \S+ WHERE session_id = /,
			/^SELECT 0 AS kind, 0 AS start_offset, content /,
			/^SELECT 0 AS kind, 0 AS start_offset, CASE/,
			/^SELECT 0 AS kind, 0 AS start_offset, byte_len/,
			/^SELECT path, mtime_ms/,
			/^SELECT path FROM/,
			/^SELECT byte_len FROM/,
			/ON CONFLICT \(path\) DO NOTHING RETURNING path$/,
			/^WITH gone AS \(DELETE FROM/,
		];
		expect(kinds.filter(kind => !sent.some(statement => kind.test(body(statement.sql)))).map(String)).toEqual([]);
		expect(unlockedStatements(sent)).toEqual([]);
		// The holder token is always a bound parameter: every comparison with it names a placeholder.
		expect(
			sent
				.filter(statement => /\bholder\s*(?:=|<>)\s*(?![\s$]|excluded\.holder\b)/.test(statement.sql))
				.map(s => s.sql),
		).toEqual([]);
		expect(sent.some(statement => statement.sql.includes(" AND holder = $"))).toBe(true);
	});

	it("sends each data read as one statement outside a transaction: the search_path lock, then the read", async () => {
		const file = `/sessions/p/2026-11-17T00-00-00-000Z_${ID}.jsonl`;
		const sent: Sent[] = [];
		const storage = await SqlSessionStorage.create({ client: recordingPostgres(sent, { indexed: [file] }) });
		const reads: Array<[string, () => Promise<unknown>]> = [
			["readText", () => storage.readText(file)],
			["readTextSlices", () => storage.readTextSlices(file, 64, 64)],
			["readTextFrom", () => storage.readTextFrom(file, 0, 64)],
			["refresh", () => storage.refresh()],
		];
		const rounds: Record<string, Array<{ transaction: number | null; locked: boolean }>> = {};
		for (const [name, read] of reads) {
			const start = sent.length;
			await read();
			rounds[name] = sent
				.slice(start)
				.map(statement => ({ transaction: statement.transaction, locked: statement.sql.startsWith(LOCKED) }));
		}
		const one = [{ transaction: null, locked: true }];
		expect(rounds).toEqual({ readText: one, readTextSlices: one, readTextFrom: one, refresh: one });
		expect(unlockedStatements(sent)).toEqual([]);
	});

	it("refuses to open on a table whose column has a type the store did not declare", async () => {
		const sent: Sent[] = [];
		const error = await SqlSessionStorage.create({
			client: recordingPostgres(sent, {
				plantedType: { table: LEASE_TABLE, column: "heartbeat_at", type: "public.ts" },
			}),
			claims: true,
		}).then(
			() => undefined,
			(err: unknown) => String(err),
		);
		expect(error ?? "opened").toContain(`"public".${LEASE_TABLE}`);
		expect(error ?? "opened").toContain("column heartbeat_at of type public.ts, not bigint");
	});

	it("refuses to open on a table with an object that runs code on its writes", async () => {
		const error = await SqlSessionStorage.create({
			client: recordingPostgres([], { plantedObjects: [{ kind: "trigger", name: "planted" }] }),
			claims: true,
		}).then(
			() => undefined,
			(err: unknown) => String(err),
		);
		expect(error ?? "opened").toContain("trigger planted");
	});

	it("refuses to open when the lease index's name belongs to something other than its holder index", async () => {
		const error = await SqlSessionStorage.create({
			client: recordingPostgres([], {
				holderName: { oid: "2", kind: "i", name: `public.${LEASE_TABLE}_holder`, on_table: "public.decoy" },
			}),
			claims: true,
		}).then(
			() => undefined,
			(err: unknown) => String(err),
		);
		expect(error ?? "opened").toContain(`.${LEASE_TABLE}_holder taken by an index on table public.decoy`);
	});
});

/** Run `statements` on `client`, one at a time. */
async function runAll(client: InstanceType<typeof SQL>, statements: readonly string[]): Promise<void> {
	for (const statement of statements) await client.unsafe(statement);
}

/** A PostgreSQL URL for `role` on `db`'s server (trust authentication over the scratch socket). */
function urlAs(db: LeaseDb, role: string): string {
	const url = new URL(db.dsn);
	url.username = role;
	return url.toString();
}

/** Session {@link ID}'s path in `db`'s directory. */
function sessionPath(db: LeaseDb): string {
	return `${db.dir.path()}/sessions/p/2026-11-17T00-00-00-000Z_${ID}.jsonl`;
}

const pgUrl = process.env.OMP_TEST_SQL_POSTGRES_URL;

/** A database of its own, for one test, with a login that may use the store's tables there but not make objects. */
interface NoCreateLogin extends AsyncDisposable {
	readonly dir: TempDir;
	/** The login's connection URL for that database. */
	readonly agentUrl: string;
	/** Open the store as the CLI does, through the login's DSN file, with `OMP_SESSION_SQL_CREATE_TABLE` so (or unset). */
	open(createTable: string | undefined): Promise<Awaited<ReturnType<typeof resolveSessionStorage>>>;
	/** Whether `table` exists in `public` there, as the tables' owner sees it. */
	exists(table: string): Promise<boolean>;
}

let noCreateDatabases = 0;

/**
 * A database where the tables' owner (the test's own login) made the store's
 * tables with the store's own DDL, then dropped the ones `without` names, and
 * a login with row access on the tables that remain and no `CREATE` on `public`.
 */
async function noCreateLogin(without: readonly string[] = []): Promise<NoCreateLogin> {
	const n = noCreateDatabases++;
	const database = `omp_nocreate_${process.pid}_${n}`;
	const agent = `nocreate_agent_${process.pid}_${n}`;
	const admin = new SQL(pgUrl ?? "");
	const dir = TempDir.createSync("@omp-sql-nocreate-");
	const urlFor = (role: string): string => {
		const url = new URL(pgUrl ?? "");
		url.pathname = `/${database}`;
		url.username = role;
		return url.toString();
	};
	const owner = new SQL(urlFor(new URL(pgUrl ?? "").username));
	const cleanUp = async () => {
		await owner.end();
		await admin.unsafe(
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`,
		);
		await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
		await admin.unsafe(`DROP ROLE IF EXISTS ${agent}`);
		await admin.end();
		dir.removeSync();
	};
	await admin.unsafe(`CREATE DATABASE ${database}`);
	try {
		await (await SqlSessionStorage.create({ client: owner, claims: true })).drain();
		for (const table of without) await owner.unsafe(`DROP TABLE ${table}`);
		const kept = [SESSION_TABLE, PARTS_TABLE, LEASE_TABLE].filter(table => !without.includes(table));
		for (const statement of [
			`CREATE ROLE ${agent} LOGIN`,
			`GRANT CONNECT ON DATABASE ${database} TO ${agent}`,
			`GRANT USAGE ON SCHEMA public TO ${agent}`,
			`GRANT SELECT, INSERT, UPDATE, DELETE ON ${kept.join(", ")} TO ${agent}`,
		]) {
			await owner.unsafe(statement);
		}
		expect((await owner.unsafe(`SELECT has_schema_privilege('${agent}', 'public', 'CREATE') AS can`))[0]).toEqual({
			can: false,
		});
	} catch (err) {
		await cleanUp();
		throw err;
	}
	const dsnFile = dir.join("dsn");
	await Bun.write(dsnFile, urlFor(agent));
	return {
		dir,
		agentUrl: urlFor(agent),
		open: createTable =>
			resolveSessionStorage({
				settings: Settings.isolated(),
				env: {
					OMP_SESSION_STORAGE: "sql",
					OMP_SESSION_SQL_DSN_FILE: dsnFile,
					...(createTable === undefined ? {} : { OMP_SESSION_SQL_CREATE_TABLE: createTable }),
				},
			}),
		async exists(table) {
			const [row] = (await owner.unsafe(`SELECT to_regclass('public.' || $1) IS NOT NULL AS present`, [
				table,
			])) as Array<{ present: boolean }>;
			return row?.present === true;
		},
		[Symbol.asyncDispose]: cleanUp,
	};
}

/** How an open of the store ended: `opened` (the store drained), or the refusal's text. */
function outcome(opening: Promise<{ drain(): Promise<void> }>): Promise<string> {
	return opening.then(
		async opened => {
			await opened.drain();
			return "opened";
		},
		(err: unknown) => String(err),
	);
}

describe.skipIf(!pgUrl)("OMP_SESSION_SQL_CREATE_TABLE on PostgreSQL", () => {
	it("lets a login with row access on owner-made tables, and no CREATE on public, open the store and run a turn", async () => {
		await using login = await noCreateLogin();
		// Start-up looks for the tables first and makes none that exists, so the login needs no CREATE on
		// public, with OMP_SESSION_SQL_CREATE_TABLE=0 or without it.
		const withoutTheVariable = await outcome(login.open(undefined));
		const storage = await login.open("0");
		const manager = SessionManager.create(login.dir.path(), login.dir.join("sessions"), storage);
		// A new session's file exists once it is made durable; a lone user turn would stay in memory.
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "a turn as the agent", timestamp: Date.now() });
		await manager.flush();
		const file = manager.getSessionFile() ?? "";
		await manager.close();

		expect({
			withoutTheVariable,
			written: (await storage.readText(file)).includes("a turn as the agent"),
		}).toEqual({ withoutTheVariable: "opened", written: true });
		await storage.drain();
	}, 60_000);

	it("refuses the login, with the variable unset, on owner-made tables that lack omp_session_files_parts: it may not make it", async () => {
		await using login = await noCreateLogin([PARTS_TABLE]);

		const permissionDenied = "permission denied for schema public";
		const refused = await outcome(login.open(undefined));

		// A refusal that does not match shows whole.
		expect({
			refusal: refused.includes(permissionDenied) ? permissionDenied : refused,
			made: await login.exists(PARTS_TABLE),
		}).toEqual({ refusal: permissionDenied, made: false });
	}, 60_000);

	it("refuses the login, with OMP_SESSION_SQL_CREATE_TABLE=0, at the table check naming omp_session_files_parts, and sends no CREATE", async () => {
		await using login = await noCreateLogin([PARTS_TABLE]);
		const tableCheck = `createTable is false, but the database has no table ${PARTS_TABLE}.`;

		// The CLI's path, which reads the variable.
		const refused = await outcome(login.open("0"));
		// The store the CLI builds for =0 (resolveSessionStorage makes its own client), with every statement it sends.
		const sent: string[] = [];
		const client = new SQL(login.agentUrl);
		const recorded = await outcome(
			SqlSessionStorage.create({
				client: recording(client as unknown as SqlSessionStorageClient, sent),
				claims: true,
				createTable: false,
			}),
		);
		await client.end();

		// A refusal that does not match shows whole.
		expect({
			refusal: refused.includes(tableCheck) ? tableCheck : refused,
			recorded: recorded.includes(tableCheck) ? tableCheck : recorded,
			creates: sent.filter(sql => /\bCREATE\b/i.test(sql)),
			made: await login.exists(PARTS_TABLE),
		}).toEqual({ refusal: tableCheck, recorded: tableCheck, creates: [], made: false });
	}, 60_000);
});

/** The transaction-control statements a client sends around its own, which name no relation and no function. */
const TRANSACTION_CONTROL = /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * Every statement `record` saw that ran without the search_path lock: outside
 * a transaction, or in one before its `SET LOCAL search_path`, unless it is
 * one simple query that opens with the lock (a one-statement read), a
 * transaction-control statement, or a statement alone outside a transaction
 * that names only `pg_catalog` functions and operators (the heartbeat).
 * Tracked per connection, in the order sent.
 */
function unlockedOnTheWire(record: WireRecord): string[] {
	const problems: string[] = [];
	const state = new Map<number, { inTransaction: boolean; locked: boolean }>();
	for (const { connection, protocol, sql } of record.statements) {
		const text = sql.trim();
		const current = state.get(connection) ?? { inTransaction: false, locked: false };
		state.set(connection, current);
		if (/^(BEGIN|START TRANSACTION)\b/i.test(text)) {
			current.inTransaction = true;
			current.locked = false;
		} else if (/^(COMMIT|END|ROLLBACK)\b(?! TO)/i.test(text)) {
			current.inTransaction = false;
			current.locked = false;
		} else if (text === SEARCH_PATH && current.inTransaction) {
			current.locked = true;
		} else if (protocol === "query" && text.startsWith(`${SEARCH_PATH}; `)) {
			// One simple query runs as one implicit transaction, its lock first.
		} else if (!current.inTransaction && unqualifiedNames(text).length === 0) {
			// Alone, and nothing in it is found through the connection's search_path.
		} else if (!TRANSACTION_CONTROL.test(text) && !/^SET TRANSACTION\b/i.test(text) && !current.locked) {
			const unqualified = current.inTransaction ? "" : ` (naming ${unqualifiedNames(text).join(" ")} unqualified)`;
			problems.push(`connection ${connection} (${protocol})${unqualified}: ${text}`);
		}
	}
	return problems;
}

describe.skipIf(!pgUrl)("SqlSessionStorage on PostgreSQL, on the wire", () => {
	it("runs every statement the CLI's store and its driver send under the search_path lock, and sets no startup search_path", async () => {
		const database = `omp_wire_${process.pid}`;
		const admin = new SQL(pgUrl ?? "");
		const dir = TempDir.createSync("@omp-sql-wire-");
		const proxy = TcpProxy.for(pgUrl ?? "");
		const record = proxy.recordPostgres();
		const url = new URL(proxy.urlFor(pgUrl ?? ""));
		url.pathname = `/${database}`;
		await admin.unsafe(`CREATE DATABASE ${database}`);
		try {
			const dsnFile = dir.join("dsn");
			await Bun.write(dsnFile, url.toString());
			const env = { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile };
			const storage = await resolveSessionStorage({ settings: Settings.isolated(), env });
			const other = await resolveSessionStorage({ settings: Settings.isolated(), env });
			const file = `${dir.path()}/sessions/p/2026-11-17T00-00-00-000Z_${ID}.jsonl`;
			const moved = `${dir.path()}/sessions/p/2026-11-17T00-00-00-000Z_${ID}-moved.jsonl`;
			const release = await storage.acquireSessionClaim?.(ID, file);
			await storage.writeText(file, transcript(ID, "full write"));
			const writer = storage.openWriter(file);
			await writer.append('{"type":"append"}\n');
			await writer.close();
			await storage.updateSessionTitle(file, { title: "title", source: "user", updatedAt: "2026-11-17" });
			await storage.drain();
			await storage.readText(file);
			await storage.readTextSlices(file, 64, 64);
			await storage.readTextFrom?.(file, 0, 64);
			await storage.refresh?.();
			// Another store's claim while this one holds the session: refused, after reading the holder.
			const refused = await other.acquireSessionClaim?.(ID, file, { waitMs: 50 });
			// The CLI's store heartbeats every 10 s.
			await until(() => record.statements.some(statement => /SET heartbeat_at = /.test(statement.sql)), 15_000);
			await storage.rename(file, moved);
			release?.();
			await storage.drain();
			await other.deleteSessionWithArtifacts(moved);
			await other.drain();

			expect({
				refused: refused ?? null,
				statements: record.statements.length > 20,
				startupSearchPath: record.startups.filter(startup => "search_path" in startup || "options" in startup),
			}).toEqual({ refused: null, statements: true, startupSearchPath: [] });
			expect(unlockedOnTheWire(record)).toEqual([]);
		} finally {
			proxy.stop();
			await admin.unsafe(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`,
			);
			await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
			await admin.end();
			dir.removeSync();
		}
	}, 60_000);
});

/** `client` with every statement it and its transactions send pushed onto `sent`, in order. */
function recording(client: SqlSessionStorageClient, sent: string[]): SqlSessionStorageClient {
	const wrap = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		unsafe(sql, values) {
			sent.push(sql);
			return executor.unsafe(sql, values);
		},
	});
	return {
		options: client.options,
		unsafe: wrap(client).unsafe,
		transaction: callback => client.transaction(transaction => callback(wrap(transaction))),
		end: () => client.end?.() ?? Promise.resolve(),
	};
}

/** How many times `sent` took the database-wide start-up lock, and how many tables and indexes it made. */
function startUpLocks(sent: readonly string[]): { locks: number; creates: number } {
	return {
		locks: sent.filter(sql => /^SELECT pg_advisory_xact_lock\(\d+\)$/.test(sql)).length,
		creates: sent.reduce(
			(count, sql) => count + (sql.match(/\bCREATE (TABLE|INDEX) IF NOT EXISTS\b/g)?.length ?? 0),
			0,
		),
	};
}

describe.skipIf(!pgUrl)("SqlSessionStorage start-up on PostgreSQL", () => {
	// Every store start-up on a database queues on one advisory lock; a busy database makes each turn there slow.
	it("takes the database-wide start-up lock once to make missing tables, and not at all on tables that exist", async () => {
		await using db = await openLeaseDb("postgres", pgUrl ?? "");
		const first: string[] = [];
		await db.open({ wrap: client => recording(client as unknown as SqlSessionStorageClient, first) });
		const again: string[] = [];
		await db.open({ wrap: client => recording(client as unknown as SqlSessionStorageClient, again) });

		expect({ first: startUpLocks(first), again: startUpLocks(again) }).toEqual({
			// The session, parts and lease tables, and the lease table's holder index.
			first: { locks: 1, creates: 4 },
			again: { locks: 0, creates: 0 },
		});
	});
});

describe.skipIf(!pgUrl)("SqlSessionStorage on PostgreSQL against planted objects", () => {
	it("never runs a function or an operator another login planted in public", async () => {
		await using db = await openLeaseDb("postgres", pgUrl ?? "");
		const attacker = `shadow_attacker_${process.pid}`;
		const log = `public.shadow_log_${process.pid}`;
		await db.sql(`CREATE TABLE ${log} (what TEXT)`);
		await db.sql(`GRANT INSERT, SELECT ON ${log} TO PUBLIC`);
		await db.sql(`CREATE ROLE ${attacker} LOGIN`);
		await db.sql(`GRANT USAGE, CREATE ON SCHEMA public TO ${attacker}`);
		const planter = new SQL(urlAs(db, attacker));
		const record = (what: string) => `INSERT INTO ${log} VALUES ('${what}')`;
		try {
			// Each shadow is an exact match for argument types the store's statements use where
			// pg_catalog has only a match through an implicit cast.
			await runAll(planter, [
				`CREATE FUNCTION public.shadow_mul(a numeric, b integer) RETURNS numeric LANGUAGE plpgsql AS $$ BEGIN ${record("*(numeric,integer)")}; RETURN a * b::numeric; END $$`,
				"CREATE OPERATOR public.* (LEFTARG = numeric, RIGHTARG = integer, FUNCTION = public.shadow_mul)",
				`CREATE FUNCTION public.convert_to(t text, e text) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN ${record("convert_to(text,text)")}; RETURN pg_catalog.convert_to(t, e::name); END $$`,
				`CREATE FUNCTION public.shadow_oideq(a oid, b regclass) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN ${record("=(oid,regclass)")}; RETURN a = b::oid; END $$`,
				"CREATE OPERATOR public.= (LEFTARG = oid, RIGHTARG = regclass, FUNCTION = public.shadow_oideq)",
				`CREATE FUNCTION public.substr(b bytea, s integer, n bigint) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN ${record("substr(bytea,integer,bigint)")}; RETURN pg_catalog.substr(b, s, n::integer); END $$`,
				`CREATE FUNCTION public.substr(b bytea, s bigint, n bigint) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN ${record("substr(bytea,bigint,bigint)")}; RETURN pg_catalog.substr(b, s::integer, n::integer); END $$`,
				`CREATE FUNCTION public.substr(b bytea, s bigint) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN ${record("substr(bytea,bigint)")}; RETURN pg_catalog.substr(b, s::integer); END $$`,
			]);
			// An owner-member login with the default search_path runs every kind of statement.
			const lease = { expiryMs: 3000, heartbeatMs: 100 };
			const storage = await db.open({ lease });
			const file = `${db.dir.path()}/sessions/p/2026-11-17T00-00-00-000Z_${ID}.jsonl`;
			const release = await storage.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			await storage.writeText(file, transcript(ID, "full write ✓"));
			const writer = storage.openWriter(file);
			await writer.append('{"type":"append","text":"€"}\n');
			await writer.close();
			await storage.updateSessionTitle(file, { title: "title", source: "user", updatedAt: "2026-11-17" });
			await storage.readText(file);
			await storage.readTextSlices(file, 64, 64);
			await storage.readTextFrom(file, 3, 16);
			await storage.refresh();
			// A heartbeat has run: the row's time moves. Read as a plain column, since the
			// fixture's own age arithmetic would meet the planted operator itself.
			const heartbeatAt = async () =>
				String(
					(await db.sql(`SELECT heartbeat_at FROM ${db.leaseTable} WHERE session_id = @1`, [ID]))[0]?.heartbeat_at,
				);
			const before = await heartbeatAt();
			await until(async () => (await heartbeatAt()) !== before);
			const moved = `${file.slice(0, -".jsonl".length)}-moved.jsonl`;
			await storage.rename(file, moved);
			const truncating = storage.openWriter(moved, { flags: "w" });
			await truncating.flush();
			await truncating.close();
			await storage.unlink(moved);
			release?.();
			await storage.drain();

			expect((await db.sql(`SELECT what FROM ${log} ORDER BY what`)).map(row => row.what)).toEqual([]);
		} finally {
			await planter.end();
			await db.sql(`DROP OWNED BY ${attacker}`);
			await db.sql(`DROP ROLE ${attacker}`);
			await db.sql(`DROP TABLE IF EXISTS ${log}`);
		}
	}, 60_000);

	/** Something another login made under the lease index's name before the store first started. */
	const DECOYS: Array<{ name: string; statements(db: LeaseDb): string[]; named: string[] }> = [
		{
			name: "an index of that name on another table",
			statements: db => [
				`CREATE TABLE ${db.table}_decoy (holder TEXT)`,
				`CREATE INDEX ${db.leaseTable}_holder ON ${db.table}_decoy (holder)`,
			],
			named: ["_holder taken by an index on table", "_decoy"],
		},
		{
			name: "a table of that name",
			statements: db => [`CREATE TABLE ${db.leaseTable}_holder (holder TEXT)`],
			named: ["_holder taken by a table"],
		},
	];

	for (const decoy of DECOYS) {
		it(`refuses to open when ${decoy.name} holds the lease index's name, and names it`, async () => {
			await using db = await openLeaseDb("postgres", pgUrl ?? "");
			try {
				for (const statement of decoy.statements(db)) await db.sql(statement);
				const client = new SQL(db.dsn);
				let outcome: string;
				try {
					outcome = await SqlSessionStorage.create({
						client,
						table: db.table,
						leaseTable: db.leaseTable,
						claims: true,
					}).then(
						() => "opened",
						(err: unknown) => String(err),
					);
				} finally {
					await client.end();
				}
				// The lease table's indexes on holder, whatever their names.
				const holderIndexes = await db.sql(
					"SELECT i.indexrelid FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid " +
						"AND a.attnum = i.indkey[0] WHERE i.indrelid = to_regclass('public.' || @1) AND a.attname = 'holder'",
					[db.leaseTable],
				);
				expect({
					refused: decoy.named.every(words => outcome.includes(words)) ? "names it" : outcome,
					holderIndexes: holderIndexes.length,
				}).toEqual({ refused: "names it", holderIndexes: 0 });
			} finally {
				await db.sql(`DROP TABLE IF EXISTS ${db.table}_decoy`);
				await db.sql(`DROP TABLE IF EXISTS ${db.leaseTable}_holder`);
			}
		});
	}

	it("reads a session whose path holds quotes, backslashes, dollar quotes and placeholders", async () => {
		await using db = await openLeaseDb("postgres", pgUrl ?? "");
		const writer = await db.open({ claims: false });
		const files = [
			`${db.dir.path()}/it's \\ $omp$ $omp0$ $q$ $1 ;-- é.jsonl`,
			// Its end and a closing `$omp$` would make an earlier `$omp$`.
			`${db.dir.path()}/ends-with-the-tag $omp`,
		];
		const text = transcript(ID, "a path that needs quoting");
		for (const file of files) await writer.writeText(file, text);
		await writer.drain();
		const reader = await db.open({ claims: false });
		const read = async (file: string) => ({
			full: await reader.readText(file).catch((err: unknown) => String(err)),
			slices: await reader.readTextSlices(file, 8, 8).catch((err: unknown) => String(err)),
			from: await reader.readTextFrom(file, 4).then(
				result => result.text,
				(err: unknown) => String(err),
			),
		});
		const expected = {
			full: text,
			slices: [text.slice(0, 8), text.slice(-8)] as [string, string],
			from: text.slice(4),
		};
		expect([await read(files[0] ?? ""), await read(files[1] ?? "")]).toEqual([expected, expected]);
	});

	/** One object a login that owns the store's tables can plant on them, and the words the refusal must name. */
	interface Plant {
		name: string;
		statements(db: LeaseDb, log: string): string[];
		named: string[];
	}

	const PLANTS: Plant[] = [
		{
			name: "a column of a type with a planted assignment cast",
			// On acquired_at, which the claim only assigns: its insert reaches the cast.
			statements: (db, log) => [
				`CREATE TYPE public.planted_ts_${process.pid} AS (v bigint)`,
				`CREATE FUNCTION public.planted_to_ts_${process.pid}(v bigint) RETURNS public.planted_ts_${process.pid} LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${log} VALUES ('cast'); RETURN ROW(v)::public.planted_ts_${process.pid}; END $$`,
				`CREATE CAST (bigint AS public.planted_ts_${process.pid}) WITH FUNCTION public.planted_to_ts_${process.pid}(bigint) AS ASSIGNMENT`,
				`ALTER TABLE ${db.leaseTable} ALTER COLUMN acquired_at TYPE public.planted_ts_${process.pid} USING ROW(acquired_at)::public.planted_ts_${process.pid}`,
			],
			named: ["column acquired_at of type public.planted_ts_", "not bigint"],
		},
		{
			name: "a trigger",
			statements: (db, log) => [
				`CREATE FUNCTION public.planted_trigger_${process.pid}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${log} VALUES ('trigger'); RETURN NEW; END $$`,
				`CREATE TRIGGER planted BEFORE INSERT OR UPDATE ON ${db.table} FOR EACH ROW EXECUTE FUNCTION public.planted_trigger_${process.pid}()`,
			],
			named: ["trigger planted"],
		},
		{
			name: "a rule",
			statements: (db, log) => [
				`CREATE RULE planted AS ON INSERT TO ${db.table}_parts DO ALSO INSERT INTO ${log} VALUES ('rule')`,
			],
			named: ["rule planted"],
		},
		{
			name: "a row-level security policy",
			statements: (db, log) => [
				`CREATE FUNCTION public.planted_policy_${process.pid}() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${log} VALUES ('policy'); RETURN true; END $$`,
				`ALTER TABLE ${db.leaseTable} ENABLE ROW LEVEL SECURITY`,
				// The table's owner, and its members, bypass the policy unless it is forced.
				`ALTER TABLE ${db.leaseTable} FORCE ROW LEVEL SECURITY`,
				`CREATE POLICY planted ON ${db.leaseTable} USING (public.planted_policy_${process.pid}()) WITH CHECK (public.planted_policy_${process.pid}())`,
			],
			named: ["row-level security policy planted", "row-level security enabled"],
		},
		{
			name: "a table that inherits from it",
			// A delete from the session table reaches the child's row, and its trigger.
			statements: (db, log) => [
				`CREATE TABLE ${db.table}_child () INHERITS (${db.table})`,
				`CREATE FUNCTION public.planted_child_${process.pid}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${log} VALUES ('inheritance'); RETURN OLD; END $$`,
				`CREATE TRIGGER planted BEFORE DELETE ON ${db.table}_child FOR EACH ROW EXECUTE FUNCTION public.planted_child_${process.pid}()`,
				`INSERT INTO ${db.table}_child (path, content, mtime_ms, byte_len) VALUES ('${sessionPath(db)}', '', 0, 0)`,
			],
			named: ["has table", "_child inheriting from it"],
		},
	];

	for (const plant of PLANTS) {
		it(`refuses to open on tables with ${plant.name}, and runs none of its code`, async () => {
			await using db = await openLeaseDb("postgres", pgUrl ?? "");
			const log = `public.planted_log_${process.pid}`;
			// The store runs as a login with row access only, not as the scratch server's
			// superuser, which no row-level security policy binds.
			const storeRole = `planted_store_${process.pid}`;
			await db.sql(`CREATE TABLE ${log} (what TEXT)`);
			await db.sql(`GRANT INSERT ON ${log} TO PUBLIC`);
			try {
				// The store made the tables as this login, which owns them, and plants as their owner.
				await (await db.open()).drain();
				for (const statement of plant.statements(db, log)) await db.sql(statement);
				await db.sql(`CREATE ROLE ${storeRole} LOGIN`);
				await db.sql(`GRANT USAGE, CREATE ON SCHEMA public TO ${storeRole}`);
				await db.sql(
					`GRANT SELECT, INSERT, UPDATE, DELETE ON ${db.table}, ${db.table}_parts, ${db.leaseTable} TO ${storeRole}`,
				);
				const client = new SQL(urlAs(db, storeRole));
				let outcome: string;
				try {
					outcome = await SqlSessionStorage.create({
						client,
						table: db.table,
						leaseTable: db.leaseTable,
						claims: true,
						lease: { expiryMs: 3000, heartbeatMs: 100 },
					}).then(
						async storage => {
							// What a store that opens does next: a claim, writes, heartbeats, a release.
							const file = sessionPath(db);
							const release = await storage.acquireSessionClaim?.(ID, file);
							await storage.writeText(file, transcript(ID, "after opening")).catch(() => undefined);
							await storage.unlink(file).catch(() => undefined);
							await Bun.sleep(400);
							release?.();
							await storage.drain().catch(() => undefined);
							return "opened";
						},
						(err: unknown) => String(err),
					);
				} finally {
					await client.end();
				}
				const ran = (await db.sql(`SELECT what FROM ${log}`)).map(row => String(row.what));
				expect({
					refused: plant.named.every(words => outcome.includes(words)) ? "names it" : outcome,
					ran,
				}).toEqual({ refused: "names it", ran: [] });
			} finally {
				await db.sql(`DROP TABLE IF EXISTS ${db.leaseTable}, ${db.table}_parts, ${db.table} CASCADE`);
				await db.sql(`DROP TABLE IF EXISTS ${log}`);
				await db.sql(
					`DROP FUNCTION IF EXISTS public.planted_to_ts_${process.pid}(bigint), public.planted_trigger_${process.pid}(), public.planted_policy_${process.pid}(), public.planted_child_${process.pid}() CASCADE`,
				);
				await db.sql(`DROP TYPE IF EXISTS public.planted_ts_${process.pid} CASCADE`);
				await db.sql(`DROP OWNED BY ${storeRole}`).catch(() => undefined);
				await db.sql(`DROP ROLE IF EXISTS ${storeRole}`);
			}
		}, 30_000);
	}
});
