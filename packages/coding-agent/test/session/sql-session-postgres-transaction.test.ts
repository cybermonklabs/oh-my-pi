/**
 * How `SqlSessionStorage` runs its statements on PostgreSQL. Every case but
 * the last two runs without a server: a fake client hands out reserved
 * connections that record every message, `release()` and `close()`, and
 * answer by a script in the shapes Bun 1.4.4 gives: a simple query answers
 * one result per statement, each with its `command`; a server error has
 * `name` `PostgresError` and the SQLSTATE in `errno`; a lost connection has
 * the code `ERR_POSTGRES_CONNECTION_CLOSED` and no `errno`. The client's own
 * `unsafe()` and `transaction()` refuse and record the call: on PostgreSQL the
 * store sends nothing there. It holds:
 * - the transaction runner's state table, one test per row;
 * - the open (the probe, the openings its answer builds, the schema
 *   statements), the lease's claim, heartbeat, release and fence, and the
 *   client's `reserve()`;
 * - for every operation of the store, that each connection it reserved began
 *   with the opening and ended with COMMIT or ROLLBACK;
 * - on a real server, that a `transaction_timeout` another client left on the
 *   store's connection does not decide when a store transaction ends: a left
 *   value shorter than a positive default for the login ends none, and with a
 *   longer one the default still ends it. Both run only when
 *   `OMP_TEST_SQL_POSTGRES_URL` (the store's database, on PostgreSQL directly)
 *   and `OMP_TEST_SQL_POSTGRES_ADMIN_URL` (the same database, as a login that
 *   may alter the defaults of the store's login there: that login itself or a
 *   superuser) are set. The file then reads the store's server once, when it
 *   loads, since Bun skips a case only on what it knows then. Both are skipped,
 *   and the file logs why once, when the store's URL does not reach PostgreSQL
 *   directly (through a pooler such as PgBouncer a new connection can get a
 *   server connection that started with another default, and the store's
 *   reservation another server connection than the test's `SET`) or the
 *   server is older than PostgreSQL 17. A read no server answers fails these
 *   two cases with its error, and every other case of the file still runs.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { BlobStore, type SessionBlobTier } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionStorageBackend } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	PG_CONDITIONAL_PARAMETERS,
	PG_REPAIR_RETRIES,
	pgOpening,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-postgres-settings";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageOptions,
	type SqlSessionStorageReservedConnection,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { reachesPostgresDirectly } from "./postgres-left-settings-harness";
import { type LeaseDb, openLeaseDb, rejection, until } from "./sql-session-lease-fixture";

const STORE_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
const ADMIN_URL = process.env.OMP_TEST_SQL_POSTGRES_ADMIN_URL;

/** `name` as a quoted identifier. */
function quoted(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

const ID = "01a1f400-0000-7000-8000-000000000001";
const OTHER_ID = "01a1f400-0000-7000-8000-000000000002";
const FILE = `/sessions/p/2026-11-20T00-00-00-000Z_${ID}.jsonl`;
const OTHER_FILE = `/sessions/p/2026-11-20T00-00-00-000Z_${OTHER_ID}.jsonl`;
const MOVED = `/sessions/p/2026-11-20T00-00-00-000Z_${ID}-moved.jsonl`;
const CREATED = `/sessions/p/2026-11-20T00-00-00-000Z_${ID}-created.jsonl`;
/** A subagent's transcript in the artifacts directory of {@link FILE}'s session. */
const ARTIFACT = `/sessions/p/2026-11-20T00-00-00-000Z_${ID}/subagent.jsonl`;
/** A path whose session row is gone while a reference of it is left. */
const GONE = "/sessions/p/2026-11-19T00-00-00-000Z_01a1f400-0000-7000-8000-000000000003.jsonl";
const HEADER = `{"type":"session","id":"${ID}"}\n`;
const TITLE = { title: "title", source: "user", updatedAt: "2026-11-20" } as const;

/** The SHA-256 of `data` in hex: a blob's key. */
function sha256Hex(data: Uint8Array): string {
	return new Bun.SHA256().update(data).digest("hex");
}

/** An image longer than 16 bytes, so a store whose rows hold 16 stores it as parts. */
const IMAGE = Buffer.from("the bytes of a session image, kept as three parts or more");
const IMAGE_HASH = sha256Hex(IMAGE);
const IMAGE_LINE = `{"type":"message","image":"blob:sha256:${IMAGE_HASH}"}\n`;
/** An image of at most 16 bytes, stored whole. */
const ICON = Buffer.from("an icon");
const ICON_HASH = sha256Hex(ICON);

const SESSIONS = '"public".omp_session_files';
const BLOBS = '"public".omp_session_files_blobs';
const REFS = '"public".omp_session_files_refs';
const LEASES = '"public".omp_session_leases';

const READ_ONLY_SETTINGS = "SELECT setting, reset_val FROM pg_settings WHERE name = 'default_transaction_read_only'";
const READ_ONLY_REFUSAL = "keeps a read-only default";
const START_UP_LOCK = "SELECT pg_advisory_xact_lock(8029197265931694963)";
const CONNECTION_CLOSED = "ERR_POSTGRES_CONNECTION_CLOSED";
const REPAIR_WARNING = "SqlSessionStorage closed a PostgreSQL connection it cannot repair";
const NO_RESERVE =
	"SqlSessionStorage: a PostgreSQL client must provide reserve(), which Bun.SQL does: the store runs each transaction on one reserved connection";

const PROBE = /^SELECT name FROM pg_catalog\.pg_settings WHERE name\b/;
const LOOK = /^SELECT pg_catalog\.to_regclass\(\$1\) IS NOT NULL AS session, /;
const TITLE_UPDATE = /^UPDATE "public"\.omp_session_files SET title = /;
/** The index load: every session row's path, time and size. */
const INDEX_LOAD = /^SELECT path, mtime_ms, byte_len FROM "public"\.omp_session_files$/;
/** A whole read: the session row's content, then its parts. */
const FULL_READ = /^SELECT 0 AS kind, 0 AS start_offset, content\b/;
const SLICES = /^SELECT 0 AS kind, 0 AS start_offset, CASE /;
/** A window read: the session row with its size, then the parts the window covers. */
const WINDOW_READ = /^SELECT 0 AS kind, 0 AS start_offset, byte_len, /;
const APPEND = /^WITH s AS \(INSERT INTO "public"\.omp_session_files /;
const UPSERT = /^INSERT INTO "public"\.omp_session_files \(path, content, .* ON CONFLICT \(path\) DO UPDATE SET /;
const LOCK_SIZE = /^SELECT byte_len FROM "public"\.omp_session_files WHERE path = \$1 FOR UPDATE$/;
const DELETE_PARTS = /^DELETE FROM "public"\.omp_session_files_parts WHERE path = \$1$/;
const SELECT_SIZES = /^SELECT sha256, byte_len FROM "public"\.omp_session_files_blobs /;
const LOCK_BLOBS_SHARED = /^SELECT sha256 FROM "public"\.omp_session_files_blobs WHERE .* FOR SHARE$/;
const LOCK_BLOBS_EXCLUSIVE = /^SELECT sha256 FROM "public"\.omp_session_files_blobs WHERE .* FOR UPDATE$/;
const INSERT_REF = /^INSERT INTO "public"\.omp_session_files_refs /;
const CLAIM_BOUND = /^SET LOCAL lock_timeout = \d+$/;
const CLAIM_LOCK = /^SELECT pg_catalog\.pg_advisory_xact_lock\(\d+, /;
const CLAIM = /^INSERT INTO "public"\.omp_session_leases .* RETURNING holder$/;
const FENCE_BOUND = "SET LOCAL lock_timeout = 2000";
const FENCE_RESET = "SET LOCAL lock_timeout TO DEFAULT";
const HELD = /^SELECT holder FROM "public"\.omp_session_leases WHERE session_id = \$1 AND holder = \$2 FOR SHARE$/;
const FENCE_LOCK = /^SELECT pg_catalog\.pg_advisory_xact_lock_shared\(\d+, /;
const FOREIGN = /^SELECT holder FROM "public"\.omp_session_leases WHERE session_id = \$1 AND holder <> \$2 /;
const RELEASE_BOUND = "SET LOCAL statement_timeout = 2000";
const RELEASE = /^DELETE FROM "public"\.omp_session_leases WHERE session_id = \$1 AND holder = \$2$/;
/** The heartbeat's own bounds, after the opening and the read-only check, in one message. */
const HEARTBEAT_BOUNDS = "SET LOCAL lock_timeout = 500; SET LOCAL idle_in_transaction_session_timeout = 500";
const HEARTBEAT = /^UPDATE "public"\.omp_session_leases SET heartbeat_at = .* RETURNING session_id$/;

/** The statements that make the store's tables, exactly as buildQueries gives them. */
const SCHEMA = [
	'CREATE TABLE IF NOT EXISTS "public".omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms BIGINT NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, byte_len BIGINT)',
	'CREATE TABLE IF NOT EXISTS "public".omp_session_files_parts (path TEXT NOT NULL, start_offset BIGINT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (path, start_offset))',
	'CREATE TABLE IF NOT EXISTS "public".omp_session_files_blobs (sha256 TEXT PRIMARY KEY, content BYTEA NOT NULL, byte_len BIGINT NOT NULL, mime_type TEXT, created_ms BIGINT NOT NULL)',
	'CREATE TABLE IF NOT EXISTS "public".omp_session_files_refs (path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (path, sha256))',
	'CREATE INDEX IF NOT EXISTS omp_session_files_rhash ON "public".omp_session_files_refs (sha256)',
	'CREATE TABLE IF NOT EXISTS "public".omp_session_leases (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, host TEXT NOT NULL, pid BIGINT NOT NULL, acquired_at BIGINT NOT NULL, heartbeat_at BIGINT NOT NULL)',
	'CREATE INDEX IF NOT EXISTS omp_session_leases_holder ON "public".omp_session_leases (holder)',
].join("; ");

/** The columns of the store's tables and their declared types. */
const DECLARED: Record<string, Record<string, "text" | "bigint" | "bytea">> = {
	omp_session_files: {
		path: "text",
		content: "text",
		mtime_ms: "bigint",
		title: "text",
		title_source: "text",
		title_updated_at: "text",
		byte_len: "bigint",
	},
	omp_session_files_parts: { path: "text", start_offset: "bigint", content: "text" },
	omp_session_files_blobs: {
		sha256: "text",
		content: "bytea",
		byte_len: "bigint",
		mime_type: "text",
		created_ms: "bigint",
	},
	omp_session_files_refs: { path: "text", sha256: "text" },
	omp_session_leases: {
		session_id: "text",
		holder: "text",
		host: "text",
		pid: "bigint",
		acquired_at: "bigint",
		heartbeat_at: "bigint",
	},
};
/** The OID PostgreSQL gives each declared type. */
const TYPE_OIDS = { text: "25", bigint: "20", bytea: "17" } as const;
/** The primary key of the blob and reference tables. */
const KEYS: Record<string, readonly string[]> = {
	omp_session_files_blobs: ["sha256"],
	omp_session_files_refs: ["path", "sha256"],
};

/** A message a reserved connection received. */
interface Sent {
	readonly sql: string;
	readonly values: unknown[] | undefined;
}

/** A reserved connection, as the fake saw it. */
interface Connection {
	/** Numbered from 1, in `reserve()` order. */
	readonly number: number;
	readonly messages: Sent[];
	releases: number;
	closes: number;
}

/** How one reserved connection fails; one with no script answers everything. */
interface ConnectionScript {
	/** `reserve()` rejects with this error, and reserves nothing. */
	readonly refuseReserve?: Error;
	/** The opening is refused with a server error of this SQLSTATE, or the connection ends before or after its answer. */
	readonly opening?: { readonly sqlstate: string } | "ends before its answer" | "ends after its answer";
	/** The first later statement `match` matches is refused with a server error of `sqlstate`. */
	readonly statement?: { readonly match: RegExp; readonly sqlstate: string };
	/** `COMMIT` answers that the transaction rolled back, or the connection ends while it runs. */
	readonly commit?: "answers ROLLBACK" | "ends";
	/** The connection ends while `ROLLBACK` runs. */
	readonly rollbackFails?: true;
}

/** What the fake server holds. */
interface FakeServer {
	/** The conditional parameters `pg_settings` has, as the probe reads them. */
	parameters: string[];
	/** Whether the store's tables exist; the store's `CREATE TABLE` makes them. */
	tables: boolean;
	/** Whether the lease table has its holder index; the store's `CREATE INDEX` makes it. */
	holderIndex: boolean;
	/** A session table from before the added columns, with rows that lack `byte_len`. */
	legacy: boolean;
	/** `setting` and `reset_val` of `default_transaction_read_only`. */
	readOnly: { setting: string; reset_val: string };
	/** Session rows: each path with its `byte_len`. */
	sessions: Map<string, number>;
	/** Sessions whose lease this store's claim statement took. */
	claimed: Set<string>;
	/** Sessions whose lease another holder keeps fresh. */
	foreign: Set<string>;
	/** Whether the heartbeat's UPDATE finds the lease rows it refreshes. */
	heartbeatFinds: boolean;
	/** Blob rows: each hash with its bytes and `byte_len`. */
	blobs: Map<string, { content: Uint8Array; byteLen: number }>;
	/** Reference rows. */
	refs: Array<{ path: string; sha256: string }>;
	/** Statements every connection refuses with a server error of the SQLSTATE. */
	refuse: Array<{ match: RegExp; sqlstate: string }>;
	/** Statements at which the server ends the connection (a FATAL), each once, on whichever connection runs it first. */
	ends: RegExp[];
}

interface FakePostgres {
	readonly client: SqlSessionStorageClient;
	readonly server: FakeServer;
	readonly connections: Connection[];
	/** Each `reserve()` call: the connection it reserved, or `"refused"`. */
	readonly reserves: Array<number | "refused">;
	/** Each call of the client's own `unsafe()` or `transaction()`. */
	readonly bare: string[];
	/** Script the next reservations, one script each, in order. */
	script(...scripts: ConnectionScript[]): void;
	/** Resolve once every reserved connection was released or closed. */
	settled(): Promise<void>;
}

function serverMessage(sqlstate: string, connection: number): string {
	return `the fake server refused with ${sqlstate} on connection ${connection}`;
}

/** A server's error, as Bun reports it. */
function serverError(sqlstate: string, connection: number): Error {
	return Object.assign(new Error(serverMessage(sqlstate, connection)), {
		name: "PostgresError",
		code: "ERR_POSTGRES_SERVER_ERROR",
		errno: sqlstate,
		severity: "ERROR",
	});
}

/** A connection that ended, as Bun reports it: no `errno`. */
function connectionClosed(): Error {
	return Object.assign(new Error("Connection closed"), { name: "PostgresError", code: CONNECTION_CLOSED });
}

/** One statement's result as Bun gives it: its rows, with the command tag. */
function result(rows: unknown[], command: string): SqlSessionStorageResult {
	return Object.assign(rows, { command, count: rows.length });
}

/** The fake server's answer to one statement. */
function answer(
	server: FakeServer,
	sql: string,
	values: unknown[] | undefined,
	connection: number,
): SqlSessionStorageResult {
	const refusal = server.refuse.find(({ match }) => match.test(sql));
	if (refusal) throw serverError(refusal.sqlstate, connection);
	const bound = values ?? [];
	const first = String(bound[0]);
	const strings = bound.filter((value): value is string => typeof value === "string");
	const table = first.slice(first.lastIndexOf(".") + 1);
	const command = (sql.split(" ", 1)[0] ?? "").toUpperCase();
	const reply = (rows: unknown[]): SqlSessionStorageResult => result(rows, command);
	const session = strings.find(value => server.sessions.has(value));
	const stored = strings.flatMap(hash => {
		const blob = server.blobs.get(hash);
		return blob ? [{ sha256: hash, blob }] : [];
	});

	if (PROBE.test(sql)) {
		return reply(
			bound
				.flat()
				.filter(name => server.parameters.includes(String(name)))
				.map(name => ({ name: String(name) })),
		);
	}
	if (sql === READ_ONLY_SETTINGS) return reply([{ ...server.readOnly }]);
	if (LOOK.test(sql)) {
		const there = server.tables;
		return reply([
			{
				session: there,
				parts: there,
				lease: there,
				blobs: there,
				refs: there,
				read_only_setting: server.readOnly.setting,
				read_only_reset_val: server.readOnly.reset_val,
				in_recovery: false,
			},
		]);
	}
	if (sql.startsWith("CREATE TABLE ")) server.tables = true;
	if (sql.startsWith("CREATE INDEX IF NOT EXISTS omp_session_leases_holder ")) server.holderIndex = true;
	if (sql.startsWith("SELECT attname AS column_name ")) {
		const columns = server.legacy && table === "omp_session_files" ? {} : (DECLARED[table] ?? {});
		return reply(Object.keys(columns).map(column_name => ({ column_name })));
	}
	if (sql.startsWith("SELECT 1 AS unmeasured ")) return reply(server.legacy ? [{ unmeasured: 1 }] : []);
	if (sql.startsWith("SELECT i.indexrelid::text AS oid ")) {
		if (!sql.endsWith("a.attname = 'holder'")) return reply([{ oid: "2" }]);
		return reply(server.holderIndex ? [{ oid: "1" }] : []);
	}
	if (sql.startsWith("SELECT c.oid::text AS oid, c.relkind::text AS kind, ")) {
		return reply(
			server.holderIndex
				? [{ oid: "1", kind: "i", name: "public.omp_session_leases_holder", on_table: "public.omp_session_leases" }]
				: [],
		);
	}
	if (sql.startsWith("SELECT a.attname AS name, ")) {
		return reply(
			Object.entries(DECLARED[table] ?? {}).map(([name, type]) => ({
				name,
				type_oid: TYPE_OIDS[type],
				type_mod: -1,
				type,
				has_default: false,
				generated: "",
				identity: "",
				text_oid: TYPE_OIDS.text,
				bigint_oid: TYPE_OIDS.bigint,
				bytea_oid: TYPE_OIDS.bytea,
			})),
		);
	}
	if (sql.startsWith("SELECT 'trigger' AS kind, ")) return reply([]);
	if (sql.startsWith("SELECT a.attname::text AS name FROM pg_catalog.pg_index ")) {
		return reply((KEYS[table] ?? []).map(name => ({ name })));
	}
	if (sql.startsWith("SELECT pg_catalog.has_table_privilege(")) return reply([{ can: true }]);

	// The index load: each session's path, time and size.
	if (INDEX_LOAD.test(sql)) {
		return reply([...server.sessions].map(([path, size]) => ({ path, mtime_ms: 1, byte_len: size })));
	}
	// The session row of a whole read, of a head and tail read, and of a window read, each with its title columns.
	const untitled = { title: null, title_source: null, title_updated_at: null };
	if (FULL_READ.test(sql)) {
		return reply(session === undefined ? [] : [{ kind: 0, start_offset: 0, content: "", ...untitled }]);
	}
	if (SLICES.test(sql)) {
		return reply(
			session === undefined
				? []
				: [{ kind: 0, start_offset: 0, head: new Uint8Array(), tail: new Uint8Array(), ...untitled }],
		);
	}
	if (WINDOW_READ.test(sql)) {
		return reply(
			session === undefined
				? []
				: [
						{
							kind: 0,
							start_offset: 0,
							byte_len: server.sessions.get(session),
							bytes: new Uint8Array(),
							...untitled,
						},
					],
		);
	}
	if (sql.startsWith(`SELECT path FROM ${SESSIONS} WHERE path IN (`)) {
		return reply(strings.filter(path => server.sessions.has(path)).map(path => ({ path })));
	}
	if (sql.startsWith(`SELECT path FROM ${SESSIONS} WHERE path = `)) {
		return reply(session === undefined ? [] : [{ path: session }]);
	}
	if (sql.startsWith(`SELECT byte_len FROM ${SESSIONS} `)) {
		const size = server.sessions.get(first);
		return reply(size === undefined ? [] : [{ byte_len: size }]);
	}
	if (sql.startsWith(`INSERT INTO ${SESSIONS} (path, content, `)) {
		// A full write's row: values path, mtime, title, title source, title time, byte_len.
		const onlyIfMissing = sql.endsWith(" RETURNING path");
		if (onlyIfMissing && server.sessions.has(first)) return reply([]);
		server.sessions.set(first, Number(bound[5]));
		return reply(onlyIfMissing ? [{ path: first }] : []);
	}
	if (sql.startsWith(`WITH s AS (INSERT INTO ${SESSIONS} `)) {
		// An append: values path, mtime, the line's byte length, the line.
		server.sessions.set(first, (server.sessions.get(first) ?? 0) + Number(bound[2]));
		return reply([]);
	}
	if (sql.startsWith(`DELETE FROM ${SESSIONS} WHERE path = `)) {
		server.sessions.delete(first);
		return reply([]);
	}
	if (sql.startsWith(`WITH gone AS (DELETE FROM ${SESSIONS} `)) {
		for (const path of server.sessions.keys()) {
			if (path.startsWith(String(bound[1]))) server.sessions.delete(path);
		}
		return reply([]);
	}
	if (sql.startsWith(`UPDATE ${SESSIONS} SET path = `)) {
		// A rename: values destination, mtime, source.
		const size = server.sessions.get(String(bound[2]));
		if (size === undefined) return reply([]);
		server.sessions.delete(String(bound[2]));
		server.sessions.set(first, size);
		return reply([{ path: first }]);
	}

	if (sql.startsWith(`INSERT INTO ${LEASES} `)) {
		if (server.foreign.has(first)) return reply([]);
		server.claimed.add(first);
		return reply([{ holder: String(bound[1]) }]);
	}
	if (sql.startsWith(`SELECT holder FROM ${LEASES} `)) {
		if (sql.endsWith(" FOR SHARE")) return reply(server.claimed.has(first) ? [{ holder: String(bound[1]) }] : []);
		return reply(server.foreign.has(first) ? [{ holder: "another holder" }] : []);
	}
	if (sql.startsWith("SELECT host, pid, CASE ")) {
		return reply(server.foreign.has(first) ? [{ host: "elsewhere", pid: 1, stale: 0 }] : []);
	}
	if (sql.startsWith(`DELETE FROM ${LEASES} `)) {
		server.claimed.delete(first);
		return reply([]);
	}
	if (sql.startsWith(`UPDATE ${LEASES} SET heartbeat_at = `)) {
		if (!server.heartbeatFinds) return reply([]);
		const refreshed = [...server.claimed].filter(id => sql.includes(id) || strings.includes(id));
		return reply(refreshed.map(session_id => ({ session_id })));
	}

	if (sql.startsWith(`INSERT INTO ${BLOBS} `)) {
		// Values hash, bytes, byte_len, MIME type, creation time.
		if (server.blobs.has(first)) return reply([]);
		const content = bound[1] instanceof Uint8Array ? bound[1] : new Uint8Array();
		server.blobs.set(first, { content, byteLen: Number(bound[2]) });
		return reply([{ sha256: first }]);
	}
	if (sql.startsWith(`SELECT sha256, byte_len FROM ${BLOBS} `)) {
		return reply(stored.map(({ sha256, blob }) => ({ sha256, byte_len: blob.byteLen })));
	}
	if (sql.startsWith(`SELECT sha256, content, byte_len FROM ${BLOBS} `)) {
		return reply(stored.map(({ sha256, blob }) => ({ sha256, content: blob.content, byte_len: blob.byteLen })));
	}
	if (sql.startsWith("SELECT sha256, encode(sha256(content), 'hex') AS digest ")) {
		return reply(
			stored
				.filter(({ blob }) => blob.content.byteLength === blob.byteLen)
				.map(({ sha256, blob }) => ({ sha256, digest: sha256Hex(blob.content) })),
		);
	}
	if (sql.startsWith(`SELECT sha256 FROM ${BLOBS} `)) return reply(stored.map(({ sha256 }) => ({ sha256 })));
	if (sql.startsWith(`UPDATE ${BLOBS} SET content = `)) {
		// Values bytes, byte_len, hash.
		const content = bound[0] instanceof Uint8Array ? bound[0] : new Uint8Array();
		server.blobs.set(String(bound[2]), { content, byteLen: Number(bound[1]) });
		return reply([]);
	}
	if (sql.startsWith(`DELETE FROM ${BLOBS} `)) {
		for (const hash of strings) server.blobs.delete(hash);
		return reply([]);
	}
	if (sql.startsWith("SELECT b.sha256 AS sha256, b.byte_len AS byte_len ")) {
		return reply(
			[...server.blobs]
				.filter(([hash]) => !server.refs.some(ref => ref.sha256 === hash))
				.map(([sha256, blob]) => ({ sha256, byte_len: blob.byteLen })),
		);
	}

	if (sql.startsWith(`INSERT INTO ${REFS} `)) {
		const sha256 = String(bound[1]);
		if (!server.refs.some(ref => ref.path === first && ref.sha256 === sha256))
			server.refs.push({ path: first, sha256 });
		return reply([]);
	}
	if (sql.startsWith(`SELECT sha256, path FROM ${REFS} WHERE path IN `)) {
		return reply(server.refs.filter(ref => strings.includes(ref.path)).map(ref => ({ ...ref })));
	}
	if (sql.startsWith(`SELECT sha256, path FROM ${REFS} WHERE substr(`)) {
		return reply(server.refs.filter(ref => ref.path.startsWith(String(bound[1]))).map(ref => ({ ...ref })));
	}
	if (sql.startsWith(`SELECT sha256 FROM ${REFS} `)) {
		return reply(server.refs.filter(ref => strings.includes(ref.sha256)).map(ref => ({ sha256: ref.sha256 })));
	}
	if (sql.startsWith(`DELETE FROM ${REFS} `)) {
		const sha256 = String(bound[1]);
		const at = server.refs.findIndex(ref => ref.path === first && ref.sha256 === sha256);
		// A dangling reference goes only while its path has no session row.
		const kept = sql.includes(" NOT EXISTS ") && server.sessions.has(first);
		if (at >= 0 && !kept) server.refs.splice(at, 1);
		return reply([]);
	}
	if (sql.startsWith("SELECT r.path AS path, r.sha256 AS sha256 ")) {
		return reply(
			server.refs
				.filter(ref => !ref.path.startsWith("blob:sha256:") && !server.sessions.has(ref.path))
				.map(ref => ({ ...ref })),
		);
	}
	return reply([]);
}

/** The fake server's answer to one message: a simple query of several statements answers one result each. */
function answerMessage(
	server: FakeServer,
	sql: string,
	values: unknown[] | undefined,
	connection: number,
): SqlSessionStorageResult {
	if (values !== undefined || !sql.includes("; ")) return answer(server, sql, values, connection);
	return sql.split("; ").map(statement => answer(server, statement, undefined, connection));
}

/**
 * How long, and how often, a test polls for a state the store reaches on its
 * own: the lease heartbeat runs on the store's interval timer (20 ms here),
 * and each beat is a chain of promises through the fake connection, which a
 * fake clock would not run.
 */
const STATE_WAIT_MS = 3000;
const STATE_POLL_MS = 5;

/** A fake PostgreSQL client; `reserve: false` makes one without `reserve()`. */
function fakePostgres(server: Partial<FakeServer> = {}, { reserve = true } = {}): FakePostgres {
	const state: FakeServer = {
		parameters: [...PG_CONDITIONAL_PARAMETERS],
		tables: true,
		holderIndex: true,
		legacy: false,
		readOnly: { setting: "off", reset_val: "off" },
		sessions: new Map(),
		claimed: new Set(),
		foreign: new Set(),
		heartbeatFinds: true,
		blobs: new Map(),
		refs: [],
		refuse: [],
		ends: [],
		...server,
	};
	const connections: Connection[] = [];
	const reserves: Array<number | "refused"> = [];
	const bare: string[] = [];
	const scripts: ConnectionScript[] = [];

	const connect = (script: ConnectionScript): SqlSessionStorageReservedConnection => {
		const connection: Connection = { number: connections.length + 1, messages: [], releases: 0, closes: 0 };
		connections.push(connection);
		reserves.push(connection.number);
		// The server ended the connection, or the store gave it back: every later message fails.
		let ended = false;
		let statementRefused = false;
		return {
			async unsafe(sql, values) {
				const opening = connection.messages.length === 0;
				connection.messages.push({ sql, values });
				if (ended) throw connectionClosed();
				if (opening && script.opening === "ends before its answer") {
					ended = true;
					throw connectionClosed();
				}
				if (opening && typeof script.opening === "object") {
					throw serverError(script.opening.sqlstate, connection.number);
				}
				if (opening && script.opening === "ends after its answer") ended = true;
				if (sql === "COMMIT" && script.commit === "ends") {
					ended = true;
					throw connectionClosed();
				}
				if (sql === "COMMIT" && script.commit === "answers ROLLBACK") return result([], "ROLLBACK");
				if (sql === "ROLLBACK" && script.rollbackFails) {
					ended = true;
					throw connectionClosed();
				}
				const end = opening ? -1 : state.ends.findIndex(match => match.test(sql));
				if (end >= 0) {
					state.ends.splice(end, 1);
					ended = true;
					throw connectionClosed();
				}
				if (!opening && !statementRefused && script.statement?.match.test(sql)) {
					statementRefused = true;
					throw serverError(script.statement.sqlstate, connection.number);
				}
				return answerMessage(state, sql, values, connection.number);
			},
			release() {
				connection.releases++;
				ended = true;
			},
			async close() {
				connection.closes++;
				ended = true;
			},
		};
	};

	const client: SqlSessionStorageClient = {
		options: { adapter: "postgres" },
		async unsafe(sql) {
			bare.push(sql);
			throw new Error(`the store sent a statement on the PostgreSQL client itself: ${sql}`);
		},
		async transaction() {
			bare.push("transaction()");
			throw new Error("the store opened a transaction on the PostgreSQL client itself");
		},
	};
	if (reserve) {
		client.reserve = async () => {
			const script = scripts.shift() ?? {};
			if (script.refuseReserve) {
				reserves.push("refused");
				throw script.refuseReserve;
			}
			return connect(script);
		};
	}
	return {
		client,
		server: state,
		connections,
		reserves,
		bare,
		script: (...next) => {
			scripts.push(...next);
		},
		settled: () =>
			until(() => connections.every(finished), STATE_WAIT_MS, {
				what: "every reserved connection to be released or closed",
				pollMs: STATE_POLL_MS,
			}),
	};
}

/** Whether the store gave `connection` back or closed it. */
function finished(connection: Connection | undefined): boolean {
	return connection !== undefined && connection.releases + connection.closes > 0;
}

/** The texts `connection` received, in order. */
function sqls(connection: Connection | undefined): string[] {
	return connection?.messages.map(message => message.sql) ?? [];
}

/** How often `connection` was given back and closed. */
function ends(connection: Connection | undefined): { releases: number | undefined; closes: number | undefined } {
	return { releases: connection?.releases, closes: connection?.closes };
}

/** The first connection that received a message `sql` matches. */
function connectionWith(fake: FakePostgres, sql: RegExp): Connection | undefined {
	return fake.connections.find(connection => connection.messages.some(message => sql.test(message.sql)));
}

/** Spy on the store's warnings; the function returned reads the context of each repair warning so far. */
function watchRepairs(): () => unknown[] {
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	return () => warn.mock.calls.filter(([message]) => message === REPAIR_WARNING).map(([, context]) => context);
}

/** Whether an argument of `calls` (a string, an error's message, or a value of an object) holds `text`. */
function mentions(calls: unknown[][], text: string): boolean {
	const holds = (value: unknown): boolean => {
		if (typeof value === "string") return value.includes(text);
		if (value instanceof Error) return value.message.includes(text);
		if (value !== null && typeof value === "object") return Object.values(value).some(holds);
		return false;
	};
	return calls.some(args => args.some(holds));
}

const PRESENT: ReadonlySet<string> = new Set(PG_CONDITIONAL_PARAMETERS);
const WRITE_OPENING = pgOpening("write", PRESENT);
const READ_OPENING = pgOpening("read", PRESENT);
const PROBE_OPENING = pgOpening("read", new Set());
/** A title update's transaction. */
const TITLE_TRANSACTION = [WRITE_OPENING, READ_ONLY_SETTINGS, expect.stringMatching(TITLE_UPDATE), "COMMIT"];

/** Stores the tests opened; each test's end gives back their claims. */
const opened: SqlSessionStorage[] = [];

async function openStore(
	fake: FakePostgres,
	options: Partial<SqlSessionStorageOptions> = {},
): Promise<SqlSessionStorage> {
	const storage = await SqlSessionStorage.create({ ...options, client: fake.client });
	opened.push(storage);
	return storage;
}

/** A store that claims sessions, opened on `fake`. */
function claiming(fake: FakePostgres, options: Partial<SqlSessionStorageOptions> = {}): Promise<SqlSessionStorage> {
	return openStore(fake, { claims: true, ...options });
}

/** A store opened on a fake server that holds the session at {@link FILE}; `from` is its first connection after the open. */
async function openOnFake(server: Partial<FakeServer> = {}, options: Partial<SqlSessionStorageOptions> = {}) {
	const fake = fakePostgres({ sessions: new Map([[FILE, 0]]), ...server });
	const storage = await openStore(fake, options);
	return { fake, storage, from: fake.connections.length };
}

/**
 * A title update whose first connection fails as `script` says: that
 * connection received `sent` and was closed, with no ROLLBACK; one warning
 * names the failure as `sqlstate` and `message`; a second connection ran the
 * update.
 */
async function expectOneRepair(
	script: ConnectionScript,
	sent: string[],
	sqlstate: string,
	message: (connection: number) => string,
): Promise<void> {
	const repairs = watchRepairs();
	const { fake, storage, from } = await openOnFake();
	fake.script(script);
	await storage.updateSessionTitle(FILE, TITLE);
	const [repairless, next, ...more] = fake.connections.slice(from);
	expect(more).toEqual([]);
	expect(sqls(repairless)).toEqual(sent);
	expect(ends(repairless)).toEqual({ releases: 0, closes: 1 });
	expect(repairs()).toEqual([
		{ operation: "updateSessionTitle", sqlstate, message: message(repairless?.number ?? 0), attempt: 1 },
	]);
	expect(sqls(next)).toEqual(TITLE_TRANSACTION);
	expect(ends(next)).toEqual({ releases: 1, closes: 0 });
}

/** A store that claims sessions and beats every 20 ms, holding the claim of {@link ID} at {@link FILE}. */
async function beating(server: Partial<FakeServer> = {}) {
	const { fake, storage } = await openOnFake(server, { claims: true, lease: { expiryMs: 2000, heartbeatMs: 20 } });
	const release = await storage.acquireSessionClaim?.(ID, FILE);
	expect(release).toBeFunction();
	return { fake, storage, release };
}

/** The connections reserved after the one that claimed the session. */
function afterClaim(fake: FakePostgres): Connection[] {
	const claimed = fake.connections.findIndex(connection => connection.messages.some(({ sql }) => CLAIM.test(sql)));
	return claimed < 0 ? [] : fake.connections.slice(claimed + 1);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const storage of opened.splice(0)) await storage.releaseHeldClaims?.();
});

describe("the transaction runner's state table", () => {
	it("1. committing, COMMIT answers COMMIT: one release(), and the operation resolves", async () => {
		const { fake, storage, from } = await openOnFake();
		await storage.updateSessionTitle(FILE, TITLE);
		const [committed, ...more] = fake.connections.slice(from);
		expect(more).toEqual([]);
		expect(sqls(committed)).toEqual(TITLE_TRANSACTION);
		expect(ends(committed)).toEqual({ releases: 1, closes: 0 });
	});

	it("2. opening, the opening is refused with any SQLSTATE: no ROLLBACK, close(), one warning, a new reserve()", () =>
		expectOneRepair({ opening: { sqlstate: "42704" } }, [WRITE_OPENING], "42704", connection =>
			serverMessage("42704", connection),
		));

	it("3. opening, the connection ends before the opening's answer: close(), one warning, a new reserve()", () =>
		expectOneRepair(
			{ opening: "ends before its answer" },
			[WRITE_OPENING],
			CONNECTION_CLOSED,
			() => "Connection closed",
		));

	it("4. working, a statement answers 25006: no ROLLBACK, close(), one warning, a new reserve()", () =>
		expectOneRepair(
			{ statement: { match: TITLE_UPDATE, sqlstate: "25006" } },
			[WRITE_OPENING, READ_ONLY_SETTINGS, expect.stringMatching(TITLE_UPDATE)],
			"25006",
			connection => serverMessage("25006", connection),
		));

	it("5. working, a statement answers 42501: no ROLLBACK, close(), one warning, a new reserve()", () =>
		expectOneRepair(
			{ statement: { match: TITLE_UPDATE, sqlstate: "42501" } },
			[WRITE_OPENING, READ_ONLY_SETTINGS, expect.stringMatching(TITLE_UPDATE)],
			"42501",
			connection => serverMessage("42501", connection),
		));

	it("6. working, a statement answers another SQLSTATE: ROLLBACK, release(), the error thrown to the loop outside", async () => {
		const repairs = watchRepairs();
		const unique = await openOnFake();
		unique.fake.script({ statement: { match: TITLE_UPDATE, sqlstate: "23505" } });
		await expect(unique.storage.updateSessionTitle(FILE, TITLE)).rejects.toMatchObject({ errno: "23505" });
		const [failed, ...more] = unique.fake.connections.slice(unique.from);
		expect(more).toEqual([]);
		expect(sqls(failed)).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			expect.stringMatching(TITLE_UPDATE),
			"ROLLBACK",
		]);
		expect(ends(failed)).toEqual({ releases: 1, closes: 0 });
		// A deadlock victim: the store's deadlock retry, outside the runner, runs the update again.
		const deadlock = await openOnFake();
		deadlock.fake.script({ statement: { match: TITLE_UPDATE, sqlstate: "40P01" } });
		await deadlock.storage.updateSessionTitle(FILE, TITLE);
		const [victim, again, ...rest] = deadlock.fake.connections.slice(deadlock.from);
		expect(rest).toEqual([]);
		expect(sqls(victim)).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			expect.stringMatching(TITLE_UPDATE),
			"ROLLBACK",
		]);
		expect(ends(victim)).toEqual({ releases: 1, closes: 0 });
		expect(sqls(again)).toEqual(TITLE_TRANSACTION);
		expect(repairs()).toEqual([]);
	});

	it("7. working, the work throws (READ_ONLY_REFUSAL, SessionWriteConflictError): ROLLBACK, release(), no close(), the error thrown", async () => {
		const refused = await openOnFake();
		refused.fake.server.readOnly = { setting: "on", reset_val: "on" };
		await expect(refused.storage.updateSessionTitle(FILE, TITLE)).rejects.toThrow(READ_ONLY_REFUSAL);
		const [readOnly, ...more] = refused.fake.connections.slice(refused.from);
		expect(more).toEqual([]);
		expect(sqls(readOnly)).toEqual([WRITE_OPENING, READ_ONLY_SETTINGS, "ROLLBACK"]);
		expect(ends(readOnly)).toEqual({ releases: 1, closes: 0 });
		// Another writer grew the session after this store read its size.
		const conflict = await openOnFake({ sessions: new Map([[FILE, 5]]) });
		conflict.fake.server.sessions.set(FILE, 9);
		await expect(conflict.storage.writeTextAtomic(FILE, "12345", { expectedSize: 5 })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		const [write] = conflict.fake.connections.slice(conflict.from);
		expect(sqls(write)).toEqual([WRITE_OPENING, READ_ONLY_SETTINGS, expect.stringMatching(LOCK_SIZE), "ROLLBACK"]);
		expect(ends(write)).toEqual({ releases: 1, closes: 0 });
	});

	it("8. committing, COMMIT answers ROLLBACK: release(), an error naming the operation thrown", async () => {
		const { fake, storage, from } = await openOnFake();
		fake.script({ commit: "answers ROLLBACK" });
		const error = await rejection(storage.updateSessionTitle(FILE, TITLE));
		expect(error).toBeInstanceOf(Error);
		const { message } = error as Error;
		expect(message).toContain("updateSessionTitle");
		expect(message).toMatch(/rolled back/i);
		const [committed, ...more] = fake.connections.slice(from);
		expect(more).toEqual([]);
		expect(sqls(committed)).toEqual(TITLE_TRANSACTION);
		expect(ends(committed)).toEqual({ releases: 1, closes: 0 });
	});

	it("9. working, the connection ends after the opening's answer: close(), the error thrown, no retry, no warning", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		fake.script({ opening: "ends after its answer" });
		await expect(storage.updateSessionTitle(FILE, TITLE)).rejects.toMatchObject({ code: CONNECTION_CLOSED });
		const [ended, ...more] = fake.connections.slice(from);
		expect(more).toEqual([]);
		expect(sqls(ended)).toEqual([WRITE_OPENING, READ_ONLY_SETTINGS]);
		expect(ends(ended)).toEqual({ releases: 0, closes: 1 });
		expect(repairs()).toEqual([]);
	});

	it("10. committing, the connection ends during COMMIT: close(), the error thrown, no retry", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		fake.script({ commit: "ends" });
		await expect(storage.updateSessionTitle(FILE, TITLE)).rejects.toMatchObject({ code: CONNECTION_CLOSED });
		const [ended, ...more] = fake.connections.slice(from);
		expect(more).toEqual([]);
		expect(sqls(ended)).toEqual(TITLE_TRANSACTION);
		expect(ends(ended)).toEqual({ releases: 0, closes: 1 });
		expect(repairs()).toEqual([]);
	});

	it("11. rolling back, ROLLBACK fails: close(), the first error thrown", async () => {
		const { fake, storage, from } = await openOnFake();
		fake.script({ statement: { match: TITLE_UPDATE, sqlstate: "23505" }, rollbackFails: true });
		const error = await rejection(storage.updateSessionTitle(FILE, TITLE));
		const [failed, ...more] = fake.connections.slice(from);
		expect(more).toEqual([]);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ errno: "23505", message: serverMessage("23505", failed?.number ?? 0) });
		expect(sqls(failed)).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			expect.stringMatching(TITLE_UPDATE),
			"ROLLBACK",
		]);
		expect(ends(failed)).toEqual({ releases: 0, closes: 1 });
	});

	it("12. any repairless, the fourth attempt too: a close() and a warning for each attempt, the fourth error thrown", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		const attempts = PG_REPAIR_RETRIES + 1;
		fake.script(
			...Array.from({ length: attempts }, () => ({ statement: { match: TITLE_UPDATE, sqlstate: "42501" } })),
		);
		const error = await rejection(storage.updateSessionTitle(FILE, TITLE));
		const tried = fake.connections.slice(from);
		expect(tried).toHaveLength(attempts);
		expect(tried.map(ends)).toEqual(tried.map(() => ({ releases: 0, closes: 1 })));
		expect(repairs()).toEqual(
			tried.map((connection, index) => ({
				operation: "updateSessionTitle",
				sqlstate: "42501",
				message: serverMessage("42501", connection.number),
				attempt: index + 1,
			})),
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ errno: "42501", message: serverMessage("42501", tried.at(-1)?.number ?? 0) });
	});

	it("12, for a blob land: on repairless connections alone, each land reserves and closes PG_REPAIR_RETRIES + 1 connections, no more; a store() and the reference after it are two lands, and the reference rejects with an Error whose cause is the last attempt's error; the image stays queued, and lands once the connections are clean", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		const attempts = PG_REPAIR_RETRIES + 1;
		// From now on every opening is refused, as on connections left with `cloudsql_session_read_only = locked`.
		fake.server.refuse.push({ match: /^BEGIN /, sqlstate: "25006" });
		// The land `store()` starts, then the land the reference waits for.
		storage.blobTier.store(IMAGE_HASH, IMAGE, "image/png");
		const error = await rejection(storage.blobTier.reference(FILE, [IMAGE_HASH]));
		const tried = fake.connections.slice(from);
		const closes = tried.reduce((sum, connection) => sum + connection.closes, 0);
		expect({ reserved: tried.length, closes }).toEqual({ reserved: 2 * attempts, closes: 2 * attempts });
		expect(tried.map(ends)).toEqual(tried.map(() => ({ releases: 0, closes: 1 })));
		expect(tried.map(sqls)).toEqual(tried.map(() => [WRITE_OPENING]));
		expect(repairs()).toEqual(
			tried.map((connection, index) => ({
				operation: "blob.insert",
				sqlstate: "25006",
				message: serverMessage("25006", connection.number),
				attempt: (index % attempts) + 1,
			})),
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toMatchObject({
			errno: "25006",
			message: serverMessage("25006", tried.at(-1)?.number ?? 0),
		});
		// Clean connections again: a drain lands the image, so it was still queued.
		fake.server.refuse.length = 0;
		await storage.drain();
		expect(fake.connections.slice(from + 2 * attempts).map(ends)).toEqual([{ releases: 1, closes: 0 }]);
		expect([...fake.server.blobs.keys()]).toEqual([IMAGE_HASH]);
		expect(repairs()).toHaveLength(2 * attempts);
	});

	it("12, for a write naming two new images: each land stops at its first blob write whose repairs are spent, so the append meets three lands and closes at most 3 × (PG_REPAIR_RETRIES + 1) connections, a drain one land more; both images stay queued, and land once the connections are clean", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		const attempts = PG_REPAIR_RETRIES + 1;
		const tried = () => fake.connections.slice(from);
		const closes = () => tried().reduce((sum, connection) => sum + connection.closes, 0);
		fake.server.refuse.push({ match: /^BEGIN /, sqlstate: "25006" });
		// Each store() starts a land, and the append a third; every pass tries the image first, since it was queued first.
		storage.blobTier.store(IMAGE_HASH, IMAGE, "image/png");
		storage.blobTier.store(ICON_HASH, ICON, "image/png");
		const writer = storage.openWriter(FILE);
		// The line names the icon first, which no pass tries: the append rejects for a named blob, with the image's
		// last error as its cause.
		const line = `{"type":"message","images":["blob:sha256:${ICON_HASH}","blob:sha256:${IMAGE_HASH}"]}\n`;
		const error = await rejection(writer.append(line));
		expect({ reserved: tried().length, closes: closes() }).toEqual({ reserved: 3 * attempts, closes: 3 * attempts });
		expect(tried().map(ends)).toEqual(tried().map(() => ({ releases: 0, closes: 1 })));
		expect(repairs()).toEqual(
			tried().map((connection, index) => ({
				operation: "blob.insert",
				sqlstate: "25006",
				message: serverMessage("25006", connection.number),
				attempt: (index % attempts) + 1,
			})),
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toMatchObject({
			errno: "25006",
			message: serverMessage("25006", tried().at(-1)?.number ?? 0),
		});
		// A drain first reports a failed write it waited for: this one rejects with the append's failure and lands nothing.
		expect(await rejection(storage.drain())).toBe(error);
		expect(closes()).toBe(3 * attempts);
		// The next is one land, whose pass stops at the image: the icon stays queued with it.
		await storage.drain();
		expect({ reserved: tried().length, closes: closes() }).toEqual({ reserved: 4 * attempts, closes: 4 * attempts });
		expect(repairs()).toHaveLength(4 * attempts);
		expect(fake.server.blobs.size).toBe(0);
		// Clean connections again: the next drain lands both, so both were still queued.
		fake.server.refuse.length = 0;
		await storage.drain();
		const landed = tried().slice(4 * attempts);
		expect(landed.map(ends)).toEqual([
			{ releases: 1, closes: 0 },
			{ releases: 1, closes: 0 },
		]);
		expect(new Set(fake.server.blobs.keys())).toEqual(new Set([IMAGE_HASH, ICON_HASH]));
		expect(repairs()).toHaveLength(4 * attempts);
	});

	it("12, for a session open that writes two images back: the open meets three lands (one per image it queues, and its reference's), so it closes 3 × (PG_REPAIR_RETRIES + 1) connections, each with a warning, and still opens with this machine's images", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		const attempts = PG_REPAIR_RETRIES + 1;
		using dir = TempDir.createSync("@sql-session-open-blobs-");
		// This machine's blob store holds both images; the table holds neither.
		const blobs = new BlobStore(dir.path(), storage.blobTier);
		const images = [IMAGE, ICON].map(data => ({
			type: "image" as const,
			data: blobs.putSync(data).ref,
			mimeType: "image/png",
		}));
		const entry: SessionMessageEntry = {
			type: "message",
			id: "images",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "image-read",
				toolName: "read",
				content: images,
				isError: false,
				timestamp: 0,
			},
		};
		// The read of the blobs' sizes answers; from the first land on, every write's opening is refused.
		fake.server.refuse.push({ match: /^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE\b/, sqlstate: "25006" });
		await resolveBlobRefsInEntries([entry], blobs, FILE);
		const [sizes, ...lands] = fake.connections.slice(from);
		expect(sqls(sizes)).toEqual([READ_OPENING, expect.stringMatching(SELECT_SIZES), "COMMIT"]);
		expect(ends(sizes)).toEqual({ releases: 1, closes: 0 });
		const closes = lands.reduce((sum, connection) => sum + connection.closes, 0);
		expect({ reserved: lands.length, closes }).toEqual({ reserved: 3 * attempts, closes: 3 * attempts });
		expect(lands.map(ends)).toEqual(lands.map(() => ({ releases: 0, closes: 1 })));
		expect(repairs()).toEqual(
			lands.map((connection, index) => ({
				operation: "blob.insert",
				sqlstate: "25006",
				message: serverMessage("25006", connection.number),
				attempt: (index % attempts) + 1,
			})),
		);
		// The open did not throw, and resolved both references from this machine's bytes.
		expect(images.map(image => Buffer.from(image.data, "base64"))).toEqual([IMAGE, ICON]);
		// Clean connections again: a drain lands both, so both stayed queued.
		fake.server.refuse.length = 0;
		await storage.drain();
		expect(new Set(fake.server.blobs.keys())).toEqual(new Set([IMAGE_HASH, ICON_HASH]));
	});

	it("13. any repairless, three repairless attempts then a clean one: three close() calls, the operation resolves on the fourth reservation", async () => {
		const repairs = watchRepairs();
		const { fake, storage, from } = await openOnFake();
		const repairless: ConnectionScript[] = [
			{ opening: { sqlstate: "42704" } },
			{ opening: "ends before its answer" },
			{ statement: { match: TITLE_UPDATE, sqlstate: "25006" } },
		];
		fake.script(
			...Array.from({ length: PG_REPAIR_RETRIES }, (_, index) => repairless[index % repairless.length] ?? {}),
		);
		await storage.updateSessionTitle(FILE, TITLE);
		const tried = fake.connections.slice(from);
		expect(tried.map(ends)).toEqual([
			...Array.from({ length: PG_REPAIR_RETRIES }, () => ({ releases: 0, closes: 1 })),
			{ releases: 1, closes: 0 },
		]);
		expect(sqls(tried.at(-1))).toEqual(TITLE_TRANSACTION);
		expect(repairs()).toEqual(
			Array.from({ length: PG_REPAIR_RETRIES }, (_, index) =>
				expect.objectContaining({ operation: "updateSessionTitle", attempt: index + 1 }),
			),
		);
	});

	it("14. probing: a probe whose opening is refused, or whose connection ends before the opening's answer, is repairless; one that ends after it is not", async () => {
		const repairs = watchRepairs();
		const repaired: Array<[ConnectionScript, string, string]> = [
			[{ opening: { sqlstate: "42704" } }, "42704", serverMessage("42704", 1)],
			[{ opening: "ends before its answer" }, CONNECTION_CLOSED, "Connection closed"],
		];
		for (const [script, sqlstate, message] of repaired) {
			const fake = fakePostgres();
			fake.script(script);
			await openStore(fake);
			const [probe, again] = fake.connections;
			expect(sqls(probe)).toEqual([PROBE_OPENING]);
			expect(ends(probe)).toEqual({ releases: 0, closes: 1 });
			expect(sqls(again)).toEqual([PROBE_OPENING, expect.stringMatching(PROBE), "COMMIT"]);
			expect(repairs().at(-1)).toEqual({ operation: "open", sqlstate, message, attempt: 1 });
		}
		expect(repairs()).toHaveLength(2);
		const ended = fakePostgres();
		ended.script({ opening: "ends after its answer" });
		await expect(openStore(ended)).rejects.toMatchObject({ code: CONNECTION_CLOSED });
		expect(ended.connections.map(sqls)).toEqual([[PROBE_OPENING, expect.stringMatching(PROBE)]]);
		expect(ended.connections.map(ends)).toEqual([{ releases: 0, closes: 1 }]);
		expect(repairs()).toHaveLength(2);
	});

	it("15. reserving, reserve() rejects: the error thrown as it is, nothing closed or released", async () => {
		const { fake, storage, from } = await openOnFake();
		const reserved = fake.reserves.length;
		const refusal = new Error("the pool is closed");
		fake.script({ refuseReserve: refusal });
		await expect(storage.updateSessionTitle(FILE, TITLE)).rejects.toBe(refusal);
		expect(fake.reserves.slice(reserved)).toEqual(["refused"]);
		expect(fake.connections.slice(from)).toEqual([]);
		expect(fake.connections.map(ends)).toEqual(fake.connections.map(() => ({ releases: 1, closes: 0 })));
	});

	it("16. heartbeat: the write opening, the read-only check, the heartbeat's bounds, the UPDATE with bound values, then COMMIT and release(); the refreshed sessions are the UPDATE's rows", async () => {
		const { fake, storage, release } = await beating();
		await until(() => finished(afterClaim(fake)[0]), STATE_WAIT_MS, {
			what: "the first heartbeat",
			pollMs: STATE_POLL_MS,
		});
		const [beat] = afterClaim(fake);
		expect(sqls(beat)).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			HEARTBEAT_BOUNDS,
			expect.stringMatching(HEARTBEAT),
			"COMMIT",
		]);
		// The holder token and the session ids are bound parameters.
		expect(beat?.messages[3]?.values).toContain(ID);
		expect(beat?.messages[3]?.sql).not.toContain(ID);
		expect(ends(beat)).toEqual({ releases: 1, closes: 0 });
		expect(storage.sessionClaimLost?.(ID)).toBe(false);
		expect(fake.bare).toEqual([]);
		release?.();
		// An UPDATE that refreshed no lease row: the claim is lost.
		const lost = await beating({ heartbeatFinds: false });
		await until(() => lost.storage.sessionClaimLost?.(ID) === true, STATE_WAIT_MS, {
			what: "the claim to be lost",
			pollMs: STATE_POLL_MS,
		});
		lost.release?.();
	});

	it("17. heartbeat, a heartbeat where setting and reset_val of default_transaction_read_only are both on is refused: ROLLBACK, release(), no close(), no UPDATE", async () => {
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const { fake, release } = await beating();
		fake.server.readOnly = { setting: "on", reset_val: "on" };
		const from = fake.connections.length;
		await until(() => finished(fake.connections[from]), STATE_WAIT_MS, {
			what: "a heartbeat on the read-only default",
			pollMs: STATE_POLL_MS,
		});
		const beat = fake.connections[from];
		expect(sqls(beat)).toEqual([WRITE_OPENING, READ_ONLY_SETTINGS, "ROLLBACK"]);
		expect(ends(beat)).toEqual({ releases: 1, closes: 0 });
		expect(mentions(debug.mock.calls, READ_ONLY_REFUSAL)).toBe(true);
		fake.server.readOnly = { setting: "off", reset_val: "off" };
		release?.();
	});
});

describe("the open", () => {
	it("the first reservation is the probe: pgOpening('read', empty), then the pg_settings read of the conditional parameters", async () => {
		const fake = fakePostgres();
		await openStore(fake);
		const [probe] = fake.connections;
		expect(sqls(probe)).toEqual([PROBE_OPENING, expect.stringMatching(PROBE), "COMMIT"]);
		expect(probe?.messages[0]?.values).toBeUndefined();
		expect((probe?.messages[1]?.values ?? []).flat().map(String).sort()).toEqual(
			[...PG_CONDITIONAL_PARAMETERS].sort(),
		);
		expect(ends(probe)).toEqual({ releases: 1, closes: 0 });
	});

	const reports: Array<[string, string[]]> = [
		["no conditional parameter", []],
		["every conditional parameter", [...PG_CONDITIONAL_PARAMETERS]],
	];
	for (const [label, parameters] of reports) {
		it(`after the probe reports ${label}, every opening is pgOpening of what it reported`, async () => {
			const fake = fakePostgres({ parameters, sessions: new Map([[FILE, 0]]) });
			const storage = await openStore(fake);
			await storage.updateSessionTitle(FILE, TITLE);
			await storage.readText(FILE);
			const present = new Set(parameters);
			expect(new Set(fake.connections.slice(1).map(connection => connection.messages[0]?.sql))).toEqual(
				new Set([pgOpening("read", present), pgOpening("write", present)]),
			);
		});
	}

	it("on a server without tables, sends buildQueries' schema text unchanged, after the opening", async () => {
		const fake = fakePostgres({ tables: false, holderIndex: false });
		await openStore(fake, { claims: true });
		const made = fake.connections.filter(connection => connection.messages.some(({ sql }) => sql === SCHEMA));
		expect(made).toHaveLength(1);
		expect(sqls(made[0])).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			START_UP_LOCK,
			expect.stringMatching(LOOK),
			SCHEMA,
			"COMMIT",
		]);
		expect(made[0]?.messages[4]?.values ?? []).toEqual([]);
	});
});

describe("the lease", () => {
	it("a claim sends the opening, then SET LOCAL lock_timeout", async () => {
		const { fake, storage } = await openOnFake({}, { claims: true });
		const release = await storage.acquireSessionClaim?.(ID, FILE);
		expect(sqls(connectionWith(fake, CLAIM))).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			expect.stringMatching(CLAIM_BOUND),
			expect.stringMatching(CLAIM_LOCK),
			expect.stringMatching(CLAIM),
			"COMMIT",
		]);
		release?.();
	});

	it("a release sends the opening, then SET LOCAL statement_timeout = 2000", async () => {
		const { fake, storage } = await openOnFake({}, { claims: true });
		const release = await storage.acquireSessionClaim?.(ID, FILE);
		release?.();
		await storage.drain();
		expect(sqls(connectionWith(fake, RELEASE))).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			RELEASE_BOUND,
			expect.stringMatching(RELEASE),
			"COMMIT",
		]);
	});

	it("a fenced write sends SET LOCAL lock_timeout = 2000 and SET LOCAL lock_timeout TO DEFAULT before its work", async () => {
		const sessions = new Map([
			[FILE, 0],
			[OTHER_FILE, 0],
		]);
		const { fake, storage } = await openOnFake({ sessions }, { claims: true });
		const release = await storage.acquireSessionClaim?.(ID, FILE);
		const claimed = fake.connections.length;
		await storage.updateSessionTitle(FILE, TITLE);
		expect(sqls(fake.connections[claimed])).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			FENCE_BOUND,
			expect.stringMatching(HELD),
			FENCE_RESET,
			expect.stringMatching(TITLE_UPDATE),
			"COMMIT",
		]);
		// A session this store holds no claim on: its shared lock, then the other holders' leases.
		const unclaimed = fake.connections.length;
		await storage.updateSessionTitle(OTHER_FILE, TITLE);
		expect(sqls(fake.connections[unclaimed])).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			FENCE_BOUND,
			expect.stringMatching(FENCE_LOCK),
			expect.stringMatching(FOREIGN),
			FENCE_RESET,
			expect.stringMatching(TITLE_UPDATE),
			"COMMIT",
		]);
		release?.();
	});

	it("a header read that fails with a server error rejects the claim with that error, and no claim statement is sent", async () => {
		const { fake, storage } = await openOnFake({ refuse: [{ match: SLICES, sqlstate: "57014" }] }, { claims: true });
		const release = storage.claimSession?.(ID, FILE);
		await expect(storage.updateSessionTitle(FILE, TITLE)).rejects.toMatchObject({ errno: "57014" });
		expect(sqls(connectionWith(fake, SLICES))).toEqual([READ_OPENING, expect.stringMatching(SLICES), "ROLLBACK"]);
		expect(
			fake.connections.filter(connection =>
				connection.messages.some(({ sql }) => CLAIM_LOCK.test(sql) || CLAIM.test(sql)),
			),
		).toEqual([]);
		release?.();
	});

	it("a header read that finds no row claims the session", async () => {
		const { fake, storage } = await openOnFake({ sessions: new Map() }, { claims: true });
		const release = await storage.acquireSessionClaim?.(ID, FILE);
		expect(sqls(connectionWith(fake, SLICES))).toEqual([READ_OPENING, expect.stringMatching(SLICES), "COMMIT"]);
		expect(sqls(connectionWith(fake, CLAIM)).at(-1)).toBe("COMMIT");
		expect(fake.server.claimed).toEqual(new Set([ID]));
		release?.();
	});

	it("a heartbeat whose transaction the server ends after the opening is a failed beat: close(), no warning, the claim kept, the next beat on a new connection", async () => {
		const repairs = watchRepairs();
		const { fake, storage, release } = await beating();
		// As the server's idle-in-transaction clock ends a stalled beat: its next message finds the connection gone.
		fake.server.ends.push(HEARTBEAT);
		await until(() => fake.server.ends.length === 0, STATE_WAIT_MS, {
			what: "the server to end a heartbeat",
			pollMs: STATE_POLL_MS,
		});
		const ended = fake.connections.find(connection => connection.closes > 0);
		expect(sqls(ended)).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			HEARTBEAT_BOUNDS,
			expect.stringMatching(HEARTBEAT),
		]);
		expect(ends(ended)).toEqual({ releases: 0, closes: 1 });
		const after = ended ? fake.connections.indexOf(ended) + 1 : fake.connections.length;
		await until(() => finished(fake.connections[after]), STATE_WAIT_MS, {
			what: "the next heartbeat",
			pollMs: STATE_POLL_MS,
		});
		expect(sqls(fake.connections[after])).toEqual([
			WRITE_OPENING,
			READ_ONLY_SETTINGS,
			HEARTBEAT_BOUNDS,
			expect.stringMatching(HEARTBEAT),
			"COMMIT",
		]);
		expect(storage.sessionClaimLost?.(ID)).toBe(false);
		expect(repairs()).toEqual([]);
		release?.();
	});
});

describe("a read-only default the session keeps", () => {
	it("a write (append) where setting and reset_val are both on is refused: ROLLBACK, release(), no close()", async () => {
		const { fake, storage, from } = await openOnFake();
		fake.server.readOnly = { setting: "on", reset_val: "on" };
		const writer = storage.openWriter(FILE);
		await expect(writer.append("line\n")).rejects.toThrow(READ_ONLY_REFUSAL);
		await expect(writer.close()).rejects.toThrow(READ_ONLY_REFUSAL);
		const [refused, ...more] = fake.connections.slice(from);
		expect(more).toEqual([]);
		expect(sqls(refused)).toEqual([WRITE_OPENING, READ_ONLY_SETTINGS, "ROLLBACK"]);
		expect(ends(refused)).toEqual({ releases: 1, closes: 0 });
	});
});

describe("the client", () => {
	it("a PostgreSQL client without reserve() is refused at open, before any statement", async () => {
		const fake = fakePostgres({}, { reserve: false });
		await expect(SqlSessionStorage.create({ client: fake.client })).rejects.toMatchObject({ message: NO_RESERVE });
		expect(fake.bare).toEqual([]);
	});

	it("a MySQL client without reserve() opens", async () => {
		const sent: string[] = [];
		const client: SqlSessionStorageClient = {
			options: { adapter: "mysql" },
			async unsafe(sql, values = []) {
				sent.push(sql);
				// The blob and reference tables' keys, as docs/session.md gives them.
				if (sql.includes("information_schema.KEY_COLUMN_USAGE")) {
					return String(values[0]).endsWith("_refs")
						? [{ name: "path" }, { name: "sha256" }]
						: [{ name: "sha256" }];
				}
				return Object.assign([], { affectedRows: 0 });
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		const storage = await SqlSessionStorage.create({ client });
		expect(storage.adapter).toBe("mysql");
		expect(sent).toContainEqual(expect.stringMatching(/^CREATE TABLE IF NOT EXISTS omp_session_files /));
	});
});

type Operation = keyof SessionStorageBackend | keyof SessionBlobTier | "claim" | "acquire" | "heartbeat" | "release";

/** How the inventory drives the store to one operation's send sites. */
interface Driver {
	drive(fake: FakePostgres): Promise<void>;
	/** A statement each send site sends, with whether its transaction reads or writes. */
	readonly sites: ReadonlyArray<readonly [RegExp, "read" | "write"]>;
}

/** Every operation of the store's backend and blob tier, and the lease's, each driven through the facade. */
const OPERATIONS = {
	init: {
		async drive(fake) {
			// Tables missing: one start-up transaction makes them.
			fake.server.tables = false;
			fake.server.holderIndex = false;
			await claiming(fake);
			// Tables from before the added columns, with rows lacking byte_len and no holder index: start-up adds each.
			fake.server.legacy = true;
			fake.server.holderIndex = false;
			await claiming(fake);
			// Tables an external migration owns: start-up only checks them.
			fake.server.legacy = false;
			await claiming(fake, { createTable: false });
		},
		sites: [
			[LOOK, "read"],
			[/^CREATE TABLE IF NOT EXISTS /, "write"],
			[/^SELECT pg_advisory_xact_lock\(\d+\)$/, "write"],
			[/^SELECT attname AS column_name FROM pg_attribute /, "read"],
			[/^SELECT i\.indexrelid::text AS oid FROM .* a\.attname = 'holder'$/, "read"],
			[/^SELECT c\.oid::text AS oid, c\.relkind::text AS kind, /, "read"],
			[/^ALTER TABLE "public"\.omp_session_files ADD COLUMN /, "write"],
			[/^SELECT 1 AS unmeasured FROM /, "read"],
			[/^UPDATE "public"\.omp_session_files SET byte_len = /, "write"],
			[/^CREATE INDEX IF NOT EXISTS omp_session_leases_holder ON /, "write"],
			[/^SELECT a\.attname AS name, /, "read"],
			[/^SELECT 'trigger' AS kind, /, "read"],
			[/^SELECT a\.attname::text AS name FROM pg_catalog\.pg_index /, "read"],
			[/^SELECT pg_catalog\.has_table_privilege\(/, "read"],
			[/^SELECT i\.indexrelid::text AS oid FROM .* a\.attname = 'sha256'$/, "read"],
		],
	},
	loadIndex: {
		async drive(fake) {
			await (await claiming(fake)).refresh();
		},
		sites: [[INDEX_LOAD, "read"]],
	},
	readFull: {
		async drive(fake) {
			await (await claiming(fake)).readText(FILE);
		},
		sites: [[FULL_READ, "read"]],
	},
	readSlices: {
		async drive(fake) {
			await (await claiming(fake)).readTextSlices(FILE, 64, 64);
		},
		sites: [[SLICES, "read"]],
	},
	readFrom: {
		async drive(fake) {
			await (await claiming(fake)).readTextFrom(FILE, 0, 64);
		},
		sites: [[WINDOW_READ, "read"]],
	},
	writeFull: {
		async drive(fake) {
			const storage = await claiming(fake);
			const release = await storage.acquireSessionClaim?.(ID, FILE);
			storage.blobTier.store(IMAGE_HASH, IMAGE, "image/png");
			await storage.writeText(FILE, `${HEADER}${IMAGE_LINE}`);
			// A rewrite at the size it had, naming the image no more.
			await storage.writeTextAtomic(FILE, HEADER, { expectedSize: Buffer.byteLength(`${HEADER}${IMAGE_LINE}`) });
			storage.writeTextSync(CREATED, HEADER, { expectedSize: null });
			await storage.drain();
			release?.();
			await storage.drain();
		},
		sites: [
			[UPSERT, "write"],
			[/^INSERT INTO "public"\.omp_session_files \(path, content, .* DO NOTHING RETURNING path$/, "write"],
			[LOCK_SIZE, "write"],
			[DELETE_PARTS, "write"],
			[/^INSERT INTO "public"\.omp_session_files_parts \(path, start_offset, content\) VALUES /, "write"],
			[/^SELECT sha256, path FROM "public"\.omp_session_files_refs WHERE path IN /, "write"],
			[LOCK_BLOBS_SHARED, "write"],
			[INSERT_REF, "write"],
			[/^DELETE FROM "public"\.omp_session_files_refs WHERE path = \$1 AND sha256 = \$2$/, "write"],
			[HELD, "write"],
			[FENCE_LOCK, "write"],
			[FOREIGN, "write"],
			[new RegExp(`^${FENCE_BOUND}$`), "write"],
			[new RegExp(`^${FENCE_RESET}$`), "write"],
		],
	},
	append: {
		async drive(fake) {
			const storage = await claiming(fake);
			const release = await storage.acquireSessionClaim?.(ID, FILE);
			storage.blobTier.store(IMAGE_HASH, IMAGE, "image/png");
			const writer = storage.openWriter(FILE);
			await writer.append(IMAGE_LINE);
			await writer.close();
			release?.();
			await storage.drain();
		},
		sites: [
			[APPEND, "write"],
			[LOCK_SIZE, "write"],
			[LOCK_BLOBS_SHARED, "write"],
			[INSERT_REF, "write"],
		],
	},
	updateSessionTitle: {
		async drive(fake) {
			await (await claiming(fake)).updateSessionTitle(FILE, TITLE);
		},
		sites: [[TITLE_UPDATE, "write"]],
	},
	truncate: {
		async drive(fake) {
			const writer = (await claiming(fake)).openWriter(FILE, { flags: "w" });
			await writer.flush();
			await writer.close();
		},
		sites: [
			[UPSERT, "write"],
			[DELETE_PARTS, "write"],
		],
	},
	remove: {
		async drive(fake) {
			fake.server.sessions.set(OTHER_FILE, 0).set(ARTIFACT, 0);
			fake.server.blobs.set(ICON_HASH, { content: ICON, byteLen: ICON.byteLength });
			fake.server.refs.push({ path: OTHER_FILE, sha256: ICON_HASH });
			const storage = await claiming(fake);
			await storage.unlink(OTHER_FILE);
			await storage.deleteSessionWithArtifacts(FILE);
		},
		sites: [
			[/^SELECT path FROM "public"\.omp_session_files WHERE path IN \(\$1\) ORDER BY path FOR UPDATE$/, "write"],
			[/^SELECT path FROM "public"\.omp_session_files WHERE .* OR substr\(path, 1, /, "write"],
			[/^DELETE FROM "public"\.omp_session_files WHERE path = \$1$/, "write"],
			[/^WITH gone AS \(DELETE FROM "public"\.omp_session_files /, "write"],
			[/^SELECT sha256, path FROM "public"\.omp_session_files_refs WHERE substr\(/, "write"],
			[LOCK_BLOBS_EXCLUSIVE, "write"],
			[/^SELECT sha256 FROM "public"\.omp_session_files_refs WHERE sha256 IN /, "write"],
			[/^DELETE FROM "public"\.omp_session_files_blobs WHERE sha256 IN /, "write"],
		],
	},
	move: {
		async drive(fake) {
			// The session names an image: its reference moves with it.
			fake.server.blobs.set(ICON_HASH, { content: ICON, byteLen: ICON.byteLength });
			fake.server.refs.push({ path: FILE, sha256: ICON_HASH });
			const storage = await claiming(fake);
			await storage.rename(FILE, MOVED);
			await storage.rename(MOVED, MOVED);
			await storage.renameNoReplace(MOVED, FILE);
		},
		sites: [
			[
				/^UPDATE "public"\.omp_session_files SET path = \$1, mtime_ms = \$2 WHERE path = \$3 RETURNING path$/,
				"write",
			],
			[/^UPDATE "public"\.omp_session_files_parts SET path = /, "write"],
			[/^DELETE FROM "public"\.omp_session_files WHERE path = \$1$/, "write"],
			[LOCK_BLOBS_SHARED, "write"],
			[/^DELETE FROM "public"\.omp_session_files_refs WHERE path = \$1 AND sha256 = \$2$/, "write"],
			[INSERT_REF, "write"],
			[/^SELECT path FROM "public"\.omp_session_files WHERE path = \$1$/, "read"],
		],
	},
	store: {
		async drive(fake) {
			const storage = await claiming(fake, { maxBlobBytes: 16 });
			storage.blobTier.store(IMAGE_HASH, IMAGE, "image/png");
			await storage.drain();
		},
		sites: [
			[/^INSERT INTO "public"\.omp_session_files_blobs \(sha256, content, /, "write"],
			[SELECT_SIZES, "write"],
			[INSERT_REF, "write"],
		],
	},
	sizes: {
		async drive(fake) {
			fake.server.blobs.set(ICON_HASH, { content: ICON, byteLen: ICON.byteLength });
			const sizes = await (await claiming(fake)).blobTier.sizes([ICON_HASH, IMAGE_HASH]);
			expect(sizes).toEqual(new Map([[ICON_HASH, ICON.byteLength]]));
		},
		sites: [[SELECT_SIZES, "read"]],
	},
	read: {
		async drive(fake) {
			const storage = await claiming(fake, { maxBlobBytes: 16 });
			storage.blobTier.store(IMAGE_HASH, IMAGE, "image/png");
			storage.blobTier.store(ICON_HASH, ICON, "image/png");
			await storage.drain();
			const read = new Map<string, Buffer>();
			await storage.blobTier.read([IMAGE_HASH, ICON_HASH], async (hash, data) => {
				read.set(hash, data);
			});
			expect(read).toEqual(
				new Map([
					[IMAGE_HASH, IMAGE],
					[ICON_HASH, ICON],
				]),
			);
		},
		sites: [
			[SELECT_SIZES, "read"],
			[/^SELECT sha256, content, byte_len FROM "public"\.omp_session_files_blobs /, "read"],
		],
	},
	repair: {
		async drive(fake) {
			// The row's bytes do not hash to its key.
			fake.server.blobs.set(ICON_HASH, { content: Buffer.from("an ic0n"), byteLen: ICON.byteLength });
			const storage = await claiming(fake);
			expect(await storage.blobTier.repair([ICON_HASH], async () => ICON)).toBe(1);
		},
		sites: [
			[/^SELECT sha256, encode\(sha256\(content\), 'hex'\) AS digest FROM /, "read"],
			[/^UPDATE "public"\.omp_session_files_blobs SET content = /, "write"],
		],
	},
	reference: {
		async drive(fake) {
			fake.server.blobs.set(ICON_HASH, { content: ICON, byteLen: ICON.byteLength });
			await (await claiming(fake)).blobTier.reference(FILE, [ICON_HASH]);
		},
		sites: [
			[LOCK_BLOBS_SHARED, "write"],
			[INSERT_REF, "write"],
		],
	},
	sweep: {
		async drive(fake) {
			fake.server.blobs
				.set(ICON_HASH, { content: ICON, byteLen: ICON.byteLength })
				.set(IMAGE_HASH, { content: IMAGE, byteLen: IMAGE.byteLength });
			// A reference a session deleted without its references left, and an image nothing references.
			fake.server.refs.push({ path: GONE, sha256: ICON_HASH });
			const storage = await claiming(fake);
			expect(await storage.blobTier.sweep(new Set(), Date.now() + 60_000, true)).toEqual({
				candidates: 2,
				deleted: 2,
				bytes: ICON.byteLength + IMAGE.byteLength,
			});
		},
		sites: [
			[/^SELECT r\.path AS path, r\.sha256 AS sha256 FROM /, "read"],
			[LOCK_BLOBS_EXCLUSIVE, "write"],
			[/^DELETE FROM "public"\.omp_session_files_refs WHERE path = \$1 AND sha256 = \$2 AND NOT EXISTS /, "write"],
			[/^SELECT b\.sha256 AS sha256, b\.byte_len AS byte_len FROM /, "read"],
			[/^DELETE FROM "public"\.omp_session_files_blobs WHERE sha256 IN /, "write"],
		],
	},
	claim: {
		async drive(fake) {
			const storage = await claiming(fake);
			const release = storage.claimSession?.(ID, FILE);
			// A write under the claim waits for its statement.
			await storage.updateSessionTitle(FILE, TITLE);
			release?.();
			await storage.drain();
		},
		sites: [
			[SLICES, "read"],
			[CLAIM_BOUND, "write"],
			[CLAIM_LOCK, "write"],
			[CLAIM, "write"],
		],
	},
	acquire: {
		async drive(fake) {
			fake.server.foreign.add(OTHER_ID);
			const storage = await claiming(fake);
			const release = await storage.acquireSessionClaim?.(ID, FILE);
			expect(await storage.acquireSessionClaim?.(OTHER_ID, OTHER_FILE, { waitMs: 50 })).toBeNull();
			expect(await storage.sessionClaimHolder?.(OTHER_ID)).toEqual({ host: "elsewhere", pid: 1 });
			release?.();
			await storage.drain();
		},
		sites: [
			[CLAIM, "write"],
			[/^SELECT host, pid, CASE /, "read"],
		],
	},
	heartbeat: {
		async drive(fake) {
			const storage = await claiming(fake, { lease: { expiryMs: 2000, heartbeatMs: 20 } });
			const release = await storage.acquireSessionClaim?.(ID, FILE);
			await until(
				() =>
					fake.connections.some(
						connection => finished(connection) && connection.messages.some(({ sql }) => HEARTBEAT.test(sql)),
					),
				STATE_WAIT_MS,
				{ what: "a heartbeat", pollMs: STATE_POLL_MS },
			);
			release?.();
			await storage.drain();
		},
		sites: [[HEARTBEAT, "write"]],
	},
	release: {
		async drive(fake) {
			const storage = await claiming(fake);
			const release = await storage.acquireSessionClaim?.(ID, FILE);
			release?.();
			await storage.drain();
			// At exit: every claim the store still holds.
			await storage.acquireSessionClaim?.(ID, FILE);
			await storage.releaseHeldClaims?.();
		},
		sites: [
			[new RegExp(`^${RELEASE_BOUND}$`), "write"],
			[RELEASE, "write"],
		],
	},
} satisfies Record<Operation, Driver>;

/** Each way a reserved connection of `fake` departs from the runner's shape. */
function transactionProblems(fake: FakePostgres): string[] {
	const present = new Set(fake.server.parameters);
	const openings = [pgOpening("read", present), pgOpening("write", present)];
	const problems: string[] = [];
	for (const connection of fake.connections) {
		const [first, second] = connection.messages;
		const last = connection.messages.at(-1);
		const allowed = second !== undefined && PROBE.test(second.sql) ? [PROBE_OPENING] : openings;
		if (!first || !allowed.includes(first.sql) || first.values !== undefined) {
			problems.push(`connection ${connection.number} opened with ${first?.sql}`);
		}
		if (!last || !(last.sql === "COMMIT" || last.sql === "ROLLBACK")) {
			problems.push(`connection ${connection.number} ended with ${last?.sql}`);
		}
		if (connection.releases + connection.closes !== 1) {
			problems.push(
				`connection ${connection.number} released ${connection.releases} and closed ${connection.closes} times`,
			);
		}
	}
	return problems;
}

/** The sites no connection of `fake` opened in the site's mode carried. */
function missingSites(fake: FakePostgres, sites: Driver["sites"]): string[] {
	const present = new Set(fake.server.parameters);
	return sites
		.filter(
			([sql, mode]) =>
				!fake.connections.some(
					connection =>
						connection.messages[0]?.sql === pgOpening(mode, present) &&
						connection.messages.some(message => sql.test(message.sql)),
				),
		)
		.map(([sql, mode]) => `${mode} ${sql}`);
}

describe("every operation runs on reserved connections that begin with the opening and end with COMMIT or ROLLBACK, and the client itself receives nothing", () => {
	for (const [operation, driver] of Object.entries(OPERATIONS)) {
		it(operation, async () => {
			// A claim another holder has is reported lost.
			vi.spyOn(logger, "warn").mockImplementation(() => {});
			const fake = fakePostgres({ sessions: new Map([[FILE, 0]]) });
			await driver.drive(fake);
			await fake.settled();
			expect(fake.bare).toEqual([]);
			expect(transactionProblems(fake)).toEqual([]);
			expect(missingSites(fake, driver.sites)).toEqual([]);
		});
	}
});

/** A connection a store reserved: how many times the store released it, and how many times it closed it. */
interface Reservation {
	releases: number;
	closes: number;
}

/** `client` for a store, recording in `reservations` each connection the store reserves, in order. */
function countingReservations(client: SQL): { client: SqlSessionStorageClient; reservations: Reservation[] } {
	const reservations: Reservation[] = [];
	return {
		reservations,
		client: {
			options: client.options,
			unsafe: (query, values) => client.unsafe(query, values),
			transaction: callback => client.transaction(callback),
			async reserve() {
				const connection = await client.reserve();
				const reservation: Reservation = { releases: 0, closes: 0 };
				reservations.push(reservation);
				return {
					unsafe: (query, values) => connection.unsafe(query, values),
					release() {
						reservation.releases++;
						connection.release();
					},
					close() {
						reservation.closes++;
						return connection.close();
					},
				};
			},
		},
	};
}

/** The store's URL, as the server cases read it. */
interface StoreServer {
	/** The store's login in its database alone, as `ALTER ROLE` names it: the server may serve other databases. */
	readonly target: string;
	/** Why the server cases cannot use this URL, when they cannot: they are skipped. */
	readonly unfit?: string;
}

async function readStoreServer(url: string): Promise<StoreServer> {
	// A server that never answers holds the file's load 5 s at most, well under the cases' 30 s.
	const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
	try {
		const direct = await reachesPostgresDirectly(sql, url);
		const [where] = (await sql.unsafe(
			"SELECT pg_catalog.current_setting('server_version_num')::int AS version, session_user::text AS login, pg_catalog.current_database()::text AS database",
		)) as Array<Record<string, unknown>>;
		const target = `${quoted(String(where?.login))} IN DATABASE ${quoted(String(where?.database))}`;
		if (!direct) return { target, unfit: "OMP_TEST_SQL_POSTGRES_URL does not reach PostgreSQL directly" };
		const version = Number(where?.version);
		if (version < 170000) return { target, unfit: `server_version_num ${version} is older than PostgreSQL 17` };
		return { target };
	} finally {
		await sql.close();
	}
}

/**
 * The store's server, read once when the file loads and only when both URLs
 * are set. A read no server answers keeps its error, which fails the two
 * server cases alone: the file still loads and every other case runs.
 */
const storeServer: { readonly read: StoreServer } | { readonly failed: unknown } | undefined =
	STORE_URL && ADMIN_URL
		? await readStoreServer(STORE_URL).then(
				read => ({ read }),
				(failed: unknown) => ({ failed }),
			)
		: undefined;
const unfit = storeServer && "read" in storeServer ? storeServer.read.unfit : undefined;
if (unfit) console.log(`transaction_timeout cases skipped: ${unfit}`);
/** Neither URL or one of them unset, or a server the cases cannot use. */
const skipServerCases = !storeServer || unfit !== undefined;

/** What a server case runs on: a store of {@link LeaseDb}'s tables that wrote {@link FILE}. */
interface LeftTimeout {
	readonly db: LeaseDb;
	/** The store's client: its one connection holds the left value. */
	readonly client: SQL;
	readonly storage: SqlSessionStorage;
	/** Each connection the store reserved, in order. */
	readonly reservations: readonly Reservation[];
	/** Lock {@link FILE}'s session row for `ms` in a transaction of the admin URL; resolves once it is locked. */
	lockRow(ms: number): Promise<{ ended: Promise<void> }>;
}

/**
 * Run `check` on a store whose login's default `transaction_timeout` in its
 * database is `loginDefault` and whose one connection holds `left`, set with
 * `SET` as another client of a pool leaves it. It takes the server the file
 * read when it loaded, and throws that read's error when no server answered.
 */
async function withLeftTimeout(
	loginDefault: string,
	left: string,
	check: (setup: LeftTimeout) => Promise<void>,
): Promise<void> {
	if (!storeServer) throw new Error("set OMP_TEST_SQL_POSTGRES_URL and OMP_TEST_SQL_POSTGRES_ADMIN_URL");
	if ("failed" in storeServer) throw storeServer.failed;
	const { target } = storeServer.read;
	const storeUrl = STORE_URL ?? "";
	await using db = await openLeaseDb("postgres", storeUrl);
	const admin = new SQL(ADMIN_URL ?? "", { max: 2 });
	let client: SQL | undefined;
	let storage: SqlSessionStorage | undefined;
	const held: Array<Promise<void>> = [];
	try {
		await admin.unsafe(`ALTER ROLE ${target} SET transaction_timeout = '${loginDefault}'`);
		// One connection, opened after that, so the store reserves the one this client leaves its setting on.
		client = new SQL(storeUrl, { max: 1 });
		const [fresh] = (await client.unsafe("SHOW transaction_timeout")) as Array<Record<string, unknown>>;
		expect(fresh?.transaction_timeout).toBe(loginDefault);
		await client.unsafe(`SET transaction_timeout = '${left}'`);
		const counted = countingReservations(client);
		storage = await SqlSessionStorage.create({ client: counted.client, table: db.table, leaseTable: db.leaseTable });
		await storage.writeText(FILE, HEADER);
		await check({
			db,
			client,
			storage,
			reservations: counted.reservations,
			async lockRow(ms) {
				const locked = Promise.withResolvers<void>();
				const ended = admin.transaction(async transaction => {
					// The admin URL may log in as the store's login, whose default this case sets: none ends this lock.
					await transaction.unsafe("SET LOCAL transaction_timeout = 0");
					await transaction.unsafe(`SELECT path FROM "public".${db.table} WHERE path = $1 FOR UPDATE`, [FILE]);
					locked.resolve();
					// A real wait: the server's transaction timer runs on the server's clock.
					await Bun.sleep(ms);
				});
				held.push(ended);
				ended.catch((err: unknown) => locked.reject(err));
				await locked.promise;
				return { ended };
			},
		});
	} finally {
		// The login's default stays on a shared server until this reset; every later step runs whatever it does.
		try {
			await admin.unsafe(`ALTER ROLE ${target} RESET transaction_timeout`);
		} finally {
			for (const lock of held) await lock.catch(() => undefined);
			await storage?.drain().catch(() => undefined);
			await client?.close();
			await admin.close();
		}
	}
}

describe("on a PostgreSQL server", () => {
	it.skipIf(skipServerCases)(
		"transaction_timeout: a left value shorter than a positive default ends no store transaction",
		() =>
			withLeftTimeout("10min", "1s", async ({ db, client, storage, lockRow }) => {
				const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
				const [before] = (await client.unsafe("SELECT pg_catalog.pg_backend_pid() AS pid")) as Array<{
					pid: number;
				}>;
				// The session's row, locked by another transaction for 2 s: longer than the 1 s left on the connection.
				const { ended } = await lockRow(2000);
				const content = `${HEADER}{"type":"message","id":"m1"}\n`;
				const started = Date.now();
				// A full write, which waits on the row's lock in its transaction; its error is read below.
				const written = storage.writeText(FILE, content).then(
					() => undefined,
					(err: unknown) => err,
				);
				await ended;
				expect(await written).toBeUndefined();
				expect(Date.now() - started).toBeGreaterThan(1000);
				expect((await db.row(FILE))?.content).toBe(content);
				const [after] = (await client.unsafe("SELECT pg_catalog.pg_backend_pid() AS pid")) as Array<{
					pid: number;
				}>;
				expect(after?.pid).toBe(before?.pid);
				expect(mentions(warn.mock.calls, "25P04")).toBe(false);
			}),
		30_000,
	);

	it.skipIf(skipServerCases)(
		"transaction_timeout: a left value longer than a positive default leaves the default to end a store transaction",
		() =>
			withLeftTimeout("1s", "10min", async ({ db, storage, reservations, lockRow }) => {
				const stored = await db.row(FILE);
				// The session's row, locked by another transaction for 3 s: longer than the login's 1 s default.
				const { ended } = await lockRow(3000);
				const from = reservations.length;
				const refused = await rejection(storage.writeText(FILE, `${HEADER}{"type":"message","id":"m1"}\n`));
				await ended;
				expect(refused).toMatchObject({ errno: "25P04" });
				// The server ended the connection: the store closed it and ran nothing again, since whether a write
				// the server ended committed is unknown.
				expect(reservations.slice(from)).toEqual([{ releases: 0, closes: 1 }]);
				expect(await db.row(FILE)).toEqual(stored);
			}),
		30_000,
	);
});
