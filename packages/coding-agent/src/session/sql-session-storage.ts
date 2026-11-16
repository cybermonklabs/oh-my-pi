import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import { SessionReadConflictError, SessionWriteConflictError } from "./session-storage";
import { eexist, enoent } from "./session-storage-errors";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / byte-slice syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * SQL executor shared by the pooled client and its transaction-scoped handle.
 * Bun's SQL client exposes a tagged-template API too,
 * but this implementation intentionally uses `unsafe(query, values)` because
 * the table identifier is validated and then inlined while values remain bound
 * parameters.
 */
export interface SqlSessionStorageTransaction {
	unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult>;
}

/**
 * Bun.SQL-compatible client. PostgreSQL and MySQL writes run in `transaction()`
 * so a session row and its parts change together; on SQLite the store issues
 * `BEGIN IMMEDIATE` / `COMMIT` through `unsafe()` itself and runs one call at a
 * time per client, because Bun's SQLite adapter has a single connection.
 * On PostgreSQL every write, a single statement included, runs in
 * `transaction()` and starts with `SET TRANSACTION READ WRITE`, which takes
 * effect only as the first statement of a real transaction block, so a
 * wrapper's `transaction()` must open a real transaction before it calls the
 * callback (one that only calls the callback silently loses `READ WRITE`).
 * Such a wrapper also loses the start-up lock: in autocommit,
 * `pg_advisory_xact_lock` is released when its own statement ends, so stores
 * that start together race on `CREATE TABLE` again, and no error shows it.
 */
export interface SqlSessionStorageClient extends SqlSessionStorageTransaction {
	transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void>;
	/**
	 * `Bun.SQL` exposes the parsed connection options here. We only consult
	 * `adapter` to pick the dialect; the field is typed as
	 * `string | undefined` so the real `Bun.SQL` instance type slots in
	 * without casting (it reports `string | undefined` across adapters).
	 */
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
}

/** Array result returned by `Bun.SQL`, including MySQL mutation metadata. */
export interface SqlSessionStorageResult extends Array<unknown> {
	affectedRows?: number;
}

export interface SqlSessionStorageOptions {
	/** Connected `Bun.SQL` instance (PostgreSQL, MySQL, or SQLite). */
	client: SqlSessionStorageClient;
	/**
	 * Override the auto-detected adapter. Useful when the client is wrapped
	 * (e.g. by a pool) and `client.options.adapter` is unreliable.
	 */
	adapter?: SqlSessionStorageAdapter;
	/**
	 * Session table name. Default: `omp_session_files`; appended parts live in
	 * `<table>_parts`. Must match `[A-Za-z_][A-Za-z0-9_]{0,56}`: at most 57
	 * characters, so `<table>_parts` fits the 63-character identifier limit.
	 * Both names are inlined into prepared statements, so we accept
	 * identifier-safe inputs only (no quoted/dotted names).
	 */
	table?: string;
	/**
	 * If true, create both tables and migrate an older session table during
	 * `create()`. Default: true. With false, `create()` runs no DDL and refuses
	 * to start unless the schema docs/session.md ("SQL session storage")
	 * describes is in place; use it when the tables are owned by an external
	 * migration.
	 */
	createTable?: boolean;
}

/** A dialect-rendered statement and the names of the values it binds, in binding order. */
interface Statement {
	readonly sql: string;
	readonly params: readonly string[];
}

type StatementValues = Readonly<Record<string, string | number | null>>;

interface DialectQueries {
	createTable: string;
	createPartsTable: string;
	/** Columns added to session tables created before they existed, each run only when the column is missing. */
	addColumns: ReadonlyArray<{ column: string; ddl: string }>;
	/** Any row written before `byte_len` existed; read without locking. */
	findUnmeasured: string;
	/** Measure rows written before `byte_len` existed. */
	backfillByteLen: string;
	/** Column names of the table named `@table`; none when it does not exist. */
	columns: Statement;
	/** Warm the synchronous index from session rows only, never content. */
	loadIndex: string;
	/**
	 * One append: grow the session row's `byte_len` (taking its row lock), then
	 * insert the line as a part at the old length. PostgreSQL does both in one
	 * statement; every dialect runs its list in one transaction.
	 */
	append: readonly Statement[];
	/** The session's `byte_len`, row-locked for the rest of the transaction where the dialect can. */
	lockSize: Statement;
	/** Insert or replace the session row of a full write. */
	upsertRow: Statement;
	/** Insert the session row of a full write only when `path` has none. */
	insertRowIfMissing: Statement;
	deleteRow: Statement;
	/** Whether `path` has any parts, read without locking. */
	hasParts: Statement;
	deleteParts: Statement;
	/**
	 * Delete every session row whose path starts with `@dir` (its first `@len`
	 * characters equal it; a character comparison, not `LIKE`, so `%` and `_`
	 * stay literal and SQLite's ASCII-insensitive `LIKE` cannot match another
	 * case) and exactly those rows' parts, then the parts under `@dir` that have
	 * no row: the staging parts of a full write. PostgreSQL and MySQL delete the
	 * rows and their parts in one statement, so the parts deleted are those of
	 * the rows deleted: a row another client commits between two statements
	 * would otherwise keep its row and lose its parts under READ COMMITTED; the
	 * second statement deletes only parts whose row it does not see. SQLite runs
	 * its statements inside `BEGIN IMMEDIATE`, where no other writer runs.
	 */
	deleteUnder: Statement[];
	/**
	 * Delete the staging parts named from `@low` (`<path>#staging-`) up to, not
	 * including, `@high`: a primary-key range, and the prefix compared by
	 * characters too, so a collation that orders the range otherwise can never
	 * reach another path's parts.
	 */
	deleteStaging: Statement;
	/** Whether {@link deleteStaging} would find any part, read without locking. */
	hasStaging: Statement;
	/** The byte length of each staging part of `@path`, row-locked where the dialect can, so no peer deletes one before the swap. */
	stagedBytes: Statement;
	insertPart: Statement;
	renameRow: Statement;
	renameParts: Statement;
	exists: Statement;
	/** Update indexed title metadata without touching the content. */
	updateTitle: Statement;
	/** The session row's content and every part, in one statement so they come from one snapshot. */
	readFull: Statement;
	/** Bounded head and tail bytes from the session row and the parts covering each window. */
	readSlices: Statement;
	/** The session's size and its bytes from an offset: the session row's and those of the parts covering the window. */
	readFrom: Statement;
	/**
	 * The session's size, the byte length of the row's own content and its bytes
	 * from `@offset` on, and the part the read starts at: its start
	 * (`first_part`, -1 when there is none) and its row identity (`first_id`,
	 * see {@link partRowids}; null on MySQL, which has none). That part is the
	 * last one starting at or before `@offset`, or, for a read from inside the
	 * row's own content, the first one.
	 */
	readChunksStart: Statement;
	/**
	 * The parts that start from `@next` up to, not including, `@end`, in
	 * `start_offset` order: one page. On PostgreSQL and SQLite the page is
	 * empty unless the part at `@anchor` still has the row identity
	 * `@anchor_id`, checked in the same statement; MySQL does not check it.
	 */
	readParts: Statement;
	/**
	 * SQLite only: the largest rowid of the parts table, and an insert that
	 * sets a part's rowid. A part's row identity, which a chunked read checks,
	 * is its `xmin` on PostgreSQL (the transaction that wrote it) and its
	 * `rowid` on SQLite; SQLite hands the rowid of a deleted last row out
	 * again, so a full write gives its parts rowids above every existing one,
	 * the replaced parts' included.
	 */
	partRowids: { last: Statement; insert: Statement } | undefined;
}

interface IndexRow {
	path: string;
	byte_len: number | bigint | string | null;
	mtime_ms: number | bigint | string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface ColumnRow {
	column_name: string;
}

interface SizeRow {
	byte_len: number | bigint | string;
}

interface BusyTimeoutRow {
	timeout: number | bigint | string;
}

/** {@link READ_ONLY_SETTINGS} row. */
interface ReadOnlySettingsRow {
	setting: string;
	reset_val: string;
}

/** `readFull` row: kind 0 is the session row's own content, kind 1 a part. */
interface ContentRow {
	kind: number | string;
	start_offset: number | bigint | string;
	content: string;
}

/** `readSlices` row: kind 0 is the session row, kind 1 a part in the head window, kind 2 a part in the tail window. */
interface SliceRow {
	kind: number | string;
	start_offset: number | bigint | string;
	head: Uint8Array | null;
	tail: Uint8Array | null;
}

/** `readFrom` row: kind 0 is the session row (with its size), kind 1 a part covering the window. */
interface ReadFromRow {
	kind: number | string;
	start_offset: number | bigint | string;
	byte_len: number | bigint | string | null;
	bytes: Uint8Array | null;
}

/**
 * `readChunksStart` row: `head` is the row's own content from the offset on,
 * `first_part` the start of the part the read starts at, -1 when there is none,
 * and `first_id` that part's row identity (a rowid on SQLite, `xmin` as text
 * on PostgreSQL), null on MySQL or when there is no such part.
 */
interface ChunksStartRow {
	byte_len: number | bigint | string | null;
	content_len: number | bigint | string;
	head: Uint8Array | null;
	first_part: number | bigint | string;
	first_id: number | string | null;
}

/** `readParts` row. */
interface PartRow {
	start_offset: number | bigint | string;
	content: string;
}

/** `stagedBytes` row. */
interface StagedPartRow {
	len: number | bigint | string;
}

/** `partRowids.last` row. */
interface RowidRow {
	last_rowid: number | bigint | string;
}

const DEFAULT_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,56}$/;
/** Largest part a full write stores; an append stores its line as one part. */
const PART_BYTES = 1024 * 1024;
/**
 * Bytes the first page of a `readChunks` read spans, from the byte it starts
 * at. A reader that stops after a window this long (memories stage 1 reads
 * 1 MiB windows) fetches about this much plus the part the window ends in,
 * and the head of the part it starts in; each next page spans twice the last,
 * up to {@link PAGE_SPAN_BYTES}, so a whole read takes only a few more queries.
 */
const FIRST_PAGE_SPAN_BYTES = 1024 * 1024;
/**
 * Most bytes one `readChunks` page spans: a later page holds the parts that
 * start within its span of where the read is, so at most this much plus the
 * part that starts last. A full write's parts are at most {@link PART_BYTES};
 * an appended line is one part of its own length, so a page stays within
 * 16 MiB while no appended line is longer than 4 MiB.
 */
const PAGE_SPAN_BYTES = 12 * 1024 * 1024;
/**
 * Characters MySQL's `path` columns hold (`VARCHAR(512)` in both tables).
 * PostgreSQL and SQLite store `path` as `TEXT`, with no such limit.
 */
const MYSQL_PATH_CHARS = 512;
/** Staging parts one transaction of a streamed full write inserts. */
const STAGING_PARTS_PER_TRANSACTION = 16;
/** Starts a staging path's suffix: `<path>#staging-<epoch ms, STAGING_EPOCH_DIGITS wide>-<id>`. */
const STAGING_MARK = "#staging-";
/** Digits of the epoch in a staging path, fixed so that the names of one path sort by age. */
const STAGING_EPOCH_DIGITS = 13;
/** Age at which a staging set is a dead writer's: a live full write finishes far sooner. */
const STALE_STAGING_MS = 60 * 60 * 1000;
const SCHEMA_DOCS = 'docs/session.md ("SQL session storage")';
/** How long a SQLite connection waits for another process's write lock, when the client sets no wait itself. */
const SQLITE_BUSY_TIMEOUT_MS = 5000;
/** Attempts per write when PostgreSQL or MySQL picks it as a deadlock victim. */
const WRITE_ATTEMPTS = 5;
/**
 * Key of the PostgreSQL advisory lock every start-up statement takes (see
 * `#setup`): the ASCII bytes of "omp_sess" read as one big-endian 64-bit
 * integer, a value other users of advisory locks are unlikely to pick.
 */
const SETUP_LOCK_KEY = 0x6f6d705f73657373n;
/**
 * `default_transaction_read_only` of this PostgreSQL connection, read inside
 * each store transaction (see `#readWrite`). `setting` is the session's own
 * value; `SET TRANSACTION READ WRITE` does not change it. `reset_val` is the
 * default the backend session started from: what the database, the role, the
 * server or the backend connection's start parameters set. Three cases:
 * - `setting` on, `reset_val` off: a session set read-only over a default
 *   that is off. The store overrides it and writes.
 * - both on: the session keeps a read-only default. The store honours it and
 *   refuses with {@link READ_ONLY_REFUSAL}.
 * - `setting` off, `reset_val` on: a session turned such a default off. The
 *   store writes, as it did before it read this setting.
 * A transaction-mode pooler applies a client's start parameters and its
 * `connect_query` to the backend with `SET`, so they show as a session value,
 * which the store overrides.
 */
const READ_ONLY_SETTINGS = "SELECT setting, reset_val FROM pg_settings WHERE name = 'default_transaction_read_only'";
const READ_ONLY_REFUSAL =
	"SqlSessionStorage: this session keeps a read-only default (default_transaction_read_only = on) " +
	"that a database, role, server or connection-start setting gives it; the store overrides only " +
	"a read-only value that a session set over a default that is off, so nothing was written.";
const utf8Decoder = new TextDecoder("utf-8");
/**
 * Most bytes one `readFrom` piece asks for: PostgreSQL's substr takes integer
 * lengths, and no stored value reaches it (a value is at most 1 GB there).
 */
const MAX_PIECE_BYTES = 0x7fff_ffff;

/** Tail of one SQLite database's call queue; see {@link sqliteQueue}. */
interface SqliteQueue {
	tail: Promise<void>;
}

const sqliteFileQueues = new Map<string, SqliteQueue>();
const sqliteClientQueues = new WeakMap<SqlSessionStorageClient, SqliteQueue>();

/**
 * The call queue every store in this process shares for `client`'s database.
 * Bun's SQLite adapter runs each client's statements on one connection, so a
 * statement issued while another call's transaction is open would join that
 * transaction. And SQLite's busy wait blocks the thread: a client of a file
 * waiting for a lock that another client in this process holds freezes the
 * process for the whole busy timeout, then fails. So calls queue per file
 * (from `options.filename`, which `Bun.SQL` sets) and the busy wait only ever
 * waits on other processes. In-memory databases, and wrappers that hide
 * `options.filename`, queue per client object.
 */
function sqliteQueue(client: SqlSessionStorageClient): SqliteQueue {
	const filename = client.options.filename;
	if (typeof filename !== "string" || filename === "" || filename === ":memory:") {
		let queue = sqliteClientQueues.get(client);
		if (!queue) {
			queue = { tail: Promise.resolve() };
			sqliteClientQueues.set(client, queue);
		}
		return queue;
	}
	const file = path.resolve(filename);
	let queue = sqliteFileQueues.get(file);
	if (!queue) {
		queue = { tail: Promise.resolve() };
		sqliteFileQueues.set(file, queue);
	}
	return queue;
}

function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

/**
 * Render `@name` markers as the dialect's placeholders: numbered and reused
 * on PostgreSQL (`$1`) and SQLite (`?1`), one positional `?` per use on MySQL.
 */
function statement(adapter: SqlSessionStorageAdapter, template: string): Statement {
	const params: string[] = [];
	const sql = template.replace(/@(\w+)/g, (_marker, name: string) => {
		if (adapter === "mysql") {
			params.push(name);
			return "?";
		}
		let index = params.indexOf(name);
		if (index < 0) index = params.push(name) - 1;
		return adapter === "postgres" ? `$${index + 1}` : `?${index + 1}`;
	});
	return { sql, params };
}

function run(
	executor: SqlSessionStorageTransaction,
	query: Statement,
	values: StatementValues,
): Promise<SqlSessionStorageResult> {
	return executor.unsafe(
		query.sql,
		query.params.map(name => {
			const value = values[name];
			if (value === undefined) throw new Error(`SqlSessionStorage: no value bound for @${name}`);
			return value;
		}),
	);
}

function buildQueries(adapter: SqlSessionStorageAdapter, table: string): DialectQueries {
	const parts = `${table}_parts`;
	const sql = (template: string): Statement => statement(adapter, template);
	const mysql = adapter === "mysql";
	const integer = adapter === "sqlite" ? "INTEGER" : "BIGINT";
	const mysqlTable = ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";
	const contentBytes = {
		postgres: "convert_to(content, 'UTF8')",
		mysql: "cast(content AS binary)",
		sqlite: "cast(content AS blob)",
	}[adapter];
	const byteLengthOf = (column: string): string =>
		({
			postgres: `octet_length(${column})`,
			mysql: `length(${column})`,
			sqlite: `length(cast(${column} AS blob))`,
		})[adapter];
	const contentByteLength = byteLengthOf("content");
	// A part's row identity (see DialectQueries.partRowids); MySQL has none.
	const partId = { postgres: "CAST(p.xmin AS text)", mysql: undefined, sqlite: "p.rowid" }[adapter];
	const emptyBytes = { postgres: "''::bytea", mysql: "cast('' AS binary)", sqlite: "x''" }[adapter];
	const greatest = adapter === "sqlite" ? "max" : "greatest";
	// PostgreSQL's substr takes integer positions; offsets within one value always fit.
	const position = (expr: string): string => (adapter === "postgres" ? `CAST(${expr} AS integer)` : expr);
	// PostgreSQL types a bare parameter from its first use; offsets past 2^31 need bigint.
	const bigint = (expr: string): string => (adapter === "postgres" ? `CAST(${expr} AS bigint)` : expr);
	const rowColumns = "path, content, mtime_ms, title, title_source, title_updated_at, byte_len";
	const rowValues = "@path, '', @mtime, @title, @title_source, @title_updated_at, @len";
	const appendRow = `INSERT INTO ${table} (path, content, mtime_ms, byte_len) VALUES (@path, '', @mtime, @len) `;
	// Scalar subqueries rather than a CTE, so MySQL 5.7 runs this too.
	const tailStart = `(SELECT byte_len FROM ${table} WHERE path = @path) - @suffix`;
	// The parts of `r`'s session that start at or before where a chunked read
	// starts, or, when that is inside `r`'s own content, where that content ends.
	const startPart =
		`FROM ${parts} AS p WHERE p.path = @path ` +
		`AND p.start_offset <= ${greatest}(${bigint("@offset")}, ${byteLengthOf("r.content")})`;

	return {
		createTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL, ` +
				`title TEXT NULL, ` +
				`title_source VARCHAR(16) NULL, ` +
				`title_updated_at VARCHAR(64) NULL, ` +
				`byte_len BIGINT NULL` +
				mysqlTable
			: `CREATE TABLE IF NOT EXISTS ${table} (` +
				`path TEXT PRIMARY KEY, ` +
				`content TEXT NOT NULL, ` +
				`mtime_ms ${integer} NOT NULL, ` +
				`title TEXT, ` +
				`title_source TEXT, ` +
				`title_updated_at TEXT, ` +
				`byte_len ${integer}` +
				`)`,
		createPartsTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${parts} (` +
				`path VARCHAR(512) NOT NULL, ` +
				`start_offset BIGINT NOT NULL, ` +
				`content LONGTEXT NOT NULL, ` +
				`PRIMARY KEY (path, start_offset)` +
				mysqlTable
			: `CREATE TABLE IF NOT EXISTS ${parts} (` +
				`path TEXT NOT NULL, ` +
				`start_offset ${integer} NOT NULL, ` +
				`content TEXT NOT NULL, ` +
				`PRIMARY KEY (path, start_offset)` +
				`)`,
		addColumns: [
			{ column: "title", ddl: `ALTER TABLE ${table} ADD COLUMN title TEXT${mysql ? " NULL" : ""}` },
			{
				column: "title_source",
				ddl: `ALTER TABLE ${table} ADD COLUMN title_source ${mysql ? "VARCHAR(16) NULL" : "TEXT"}`,
			},
			{
				column: "title_updated_at",
				ddl: `ALTER TABLE ${table} ADD COLUMN title_updated_at ${mysql ? "VARCHAR(64) NULL" : "TEXT"}`,
			},
			{ column: "byte_len", ddl: `ALTER TABLE ${table} ADD COLUMN byte_len ${integer}${mysql ? " NULL" : ""}` },
		],
		findUnmeasured: `SELECT 1 AS unmeasured FROM ${table} WHERE byte_len IS NULL LIMIT 1`,
		backfillByteLen: `UPDATE ${table} SET byte_len = ${contentByteLength} WHERE byte_len IS NULL`,
		columns: sql(
			{
				postgres:
					"SELECT attname AS column_name FROM pg_attribute " +
					"WHERE attrelid = to_regclass(@table) AND attnum > 0 AND NOT attisdropped",
				mysql:
					"SELECT column_name AS column_name FROM information_schema.columns " +
					"WHERE table_schema = DATABASE() AND table_name = @table",
				sqlite: "SELECT name AS column_name FROM pragma_table_info(@table)",
			}[adapter],
		),
		loadIndex: `SELECT path, mtime_ms, byte_len, title, title_source, title_updated_at FROM ${table}`,
		append:
			adapter === "postgres"
				? [
						sql(
							`WITH s AS (${appendRow}` +
								`ON CONFLICT (path) DO UPDATE SET byte_len = ${table}.byte_len + excluded.byte_len, ` +
								`mtime_ms = excluded.mtime_ms RETURNING byte_len) ` +
								`INSERT INTO ${parts} (path, start_offset, content) ` +
								`SELECT @path, s.byte_len - @len, @content FROM s WHERE @len > 0`,
						),
					]
				: [
						sql(
							appendRow +
								(mysql
									? "ON DUPLICATE KEY UPDATE byte_len = byte_len + @len, mtime_ms = @mtime"
									: `ON CONFLICT (path) DO UPDATE SET byte_len = ${table}.byte_len + excluded.byte_len, ` +
										"mtime_ms = excluded.mtime_ms"),
						),
						sql(
							`INSERT INTO ${parts} (path, start_offset, content) ` +
								`SELECT path, byte_len - @len, @content FROM ${table} WHERE path = @path AND @len > 0`,
						),
					],
		lockSize: sql(`SELECT byte_len FROM ${table} WHERE path = @path${adapter === "sqlite" ? "" : " FOR UPDATE"}`),
		upsertRow: sql(
			`INSERT INTO ${table} (${rowColumns}) VALUES (${rowValues}) ` +
				(mysql
					? "ON DUPLICATE KEY UPDATE content = '', mtime_ms = @mtime, title = @title, " +
						"title_source = @title_source, title_updated_at = @title_updated_at, byte_len = @len"
					: "ON CONFLICT (path) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms, " +
						"title = excluded.title, title_source = excluded.title_source, " +
						"title_updated_at = excluded.title_updated_at, byte_len = excluded.byte_len"),
		),
		insertRowIfMissing: sql(
			mysql
				? `INSERT IGNORE INTO ${table} (${rowColumns}) VALUES (${rowValues})`
				: `INSERT INTO ${table} (${rowColumns}) VALUES (${rowValues}) ON CONFLICT (path) DO NOTHING RETURNING path`,
		),
		deleteRow: sql(`DELETE FROM ${table} WHERE path = @path`),
		hasParts: sql(`SELECT 1 AS found FROM ${parts} WHERE path = @path LIMIT 1`),
		deleteParts: sql(`DELETE FROM ${parts} WHERE path = @path`),
		deleteUnder: {
			postgres: [
				sql(
					`WITH gone AS (DELETE FROM ${table} WHERE substr(path, 1, @len) = @dir RETURNING path) ` +
						`DELETE FROM ${parts} WHERE path IN (SELECT path FROM gone)`,
				),
				sql(
					`DELETE FROM ${parts} AS p WHERE substr(p.path, 1, @len) = @dir ` +
						`AND NOT EXISTS (SELECT 1 FROM ${table} AS r WHERE r.path = p.path)`,
				),
			],
			mysql: [
				sql(
					`DELETE r, p FROM ${table} AS r LEFT JOIN ${parts} AS p ON p.path = r.path ` +
						`WHERE substr(r.path, 1, @len) = @dir`,
				),
				sql(
					`DELETE p FROM ${parts} AS p LEFT JOIN ${table} AS r ON r.path = p.path ` +
						`WHERE substr(p.path, 1, @len) = @dir AND r.path IS NULL`,
				),
			],
			sqlite: [
				sql(`DELETE FROM ${parts} WHERE substr(path, 1, @len) = @dir`),
				sql(`DELETE FROM ${table} WHERE substr(path, 1, @len) = @dir`),
			],
		}[adapter],
		deleteStaging: sql(`DELETE FROM ${parts} WHERE path >= @low AND path < @high AND substr(path, 1, @len) = @low`),
		hasStaging: sql(
			`SELECT 1 AS found FROM ${parts} WHERE path >= @low AND path < @high AND substr(path, 1, @len) = @low LIMIT 1`,
		),
		stagedBytes: sql(
			`SELECT ${contentByteLength} AS len FROM ${parts} WHERE path = @path${adapter === "sqlite" ? "" : " FOR UPDATE"}`,
		),
		insertPart: sql(`INSERT INTO ${parts} (path, start_offset, content) VALUES (@path, @offset, @content)`),
		renameRow: sql(
			`UPDATE ${table} SET path = @dst, mtime_ms = @mtime WHERE path = @src${mysql ? "" : " RETURNING path"}`,
		),
		renameParts: sql(`UPDATE ${parts} SET path = @dst WHERE path = @src`),
		exists: sql(`SELECT path FROM ${table} WHERE path = @path`),
		updateTitle: sql(
			`UPDATE ${table} SET title = @title, title_source = @title_source, title_updated_at = @title_updated_at, ` +
				"mtime_ms = @mtime WHERE path = @path",
		),
		readFull: sql(
			`SELECT 0 AS kind, 0 AS start_offset, content FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, content FROM ${parts} WHERE path = @path`,
		),
		// The session row holds bytes [0, length(content)), its parts the rest.
		// A head part starts before `@prefix`; the tail starts in the last part
		// starting at or before `byte_len - @suffix` (every part when none
		// does, i.e. the tail reaches into the row's own content).
		readSlices: sql(
			`SELECT 0 AS kind, 0 AS start_offset, ` +
				`CASE WHEN @prefix > 0 THEN substr(${contentBytes}, 1, @prefix) ELSE ${emptyBytes} END AS head, ` +
				`CASE WHEN @suffix > 0 AND byte_len - @suffix < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position(`${greatest}(0, byte_len - @suffix) + 1`)}) ` +
				`ELSE ${emptyBytes} END AS tail FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, substr(${contentBytes}, 1, ${position("@prefix - start_offset")}), NULL ` +
				`FROM ${parts} WHERE path = @path AND start_offset < @prefix ` +
				`UNION ALL SELECT 2, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${tailStart} - start_offset) + 1`)}) ` +
				`FROM ${parts} WHERE @suffix > 0 AND path = @path AND start_offset >= (` +
				`SELECT coalesce(max(start_offset), -1) FROM ${parts} WHERE path = @path AND start_offset <= ${tailStart})`,
		),
		// The session row holds bytes [0, length(content)), its parts the rest. The
		// parts read are those that end after `@offset` and start before `@end`,
		// from the last one starting at or before `@offset` (every part when none
		// does, i.e. the window starts in the row's own content). Each piece is
		// at most `@take` bytes from where the window enters it; `@row_from` is
		// the 1-based row position `@offset + 1`, clamped where the row cannot reach.
		readFrom: sql(
			`SELECT 0 AS kind, 0 AS start_offset, byte_len, ` +
				`CASE WHEN ${bigint("@offset")} < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position("@row_from")}, ${position("@take")}) ` +
				`ELSE ${emptyBytes} END AS bytes FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${bigint("@offset")} - start_offset) + 1`)}, ` +
				`${position("@take")}) ` +
				`FROM ${parts} WHERE path = @path AND start_offset < ${bigint("@end")} ` +
				`AND start_offset + ${contentByteLength} > ${bigint("@offset")} AND start_offset >= (` +
				`SELECT coalesce(max(start_offset), -1) FROM ${parts} WHERE path = @path ` +
				`AND start_offset <= ${bigint("@offset")})`,
		),
		// Only the row's own bytes from `@offset` on (`@row_from` is the 1-based
		// `@offset + 1`, clamped as in readFrom), so a read from inside the content
		// of a row an older version wrote never fetches what precedes it. The part
		// the read starts at is the last one starting at or before `@offset`, or,
		// when `@offset` is inside the row's own content, the one starting where
		// that content ends.
		readChunksStart: sql(
			`SELECT byte_len, ${contentByteLength} AS content_len, ` +
				`CASE WHEN ${bigint("@offset")} < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position("@row_from")}) ELSE ${emptyBytes} END AS head, ` +
				`(SELECT coalesce(max(p.start_offset), -1) ${startPart}) AS first_part, ` +
				`${partId ? `(SELECT ${partId} ${startPart} ORDER BY p.start_offset DESC LIMIT 1)` : "NULL"} AS first_id ` +
				`FROM ${table} AS r WHERE r.path = @path`,
		),
		readParts: sql(
			`SELECT start_offset, content FROM ${parts} WHERE path = @path AND start_offset >= ${bigint("@next")} ` +
				`AND start_offset < ${bigint("@end")} ` +
				(partId
					? `AND EXISTS (SELECT 1 FROM ${parts} AS p WHERE p.path = @path ` +
						`AND p.start_offset = ${bigint("@anchor")} AND ${partId} = @anchor_id) `
					: "") +
				"ORDER BY start_offset",
		),
		partRowids:
			adapter === "sqlite"
				? {
						last: sql(`SELECT coalesce(max(rowid), 0) AS last_rowid FROM ${parts}`),
						insert: sql(
							`INSERT INTO ${parts} (rowid, path, start_offset, content) VALUES (@rowid, @path, @offset, @content)`,
						),
					}
				: undefined,
	};
}

function rowNumber(value: number | bigint | string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}
function rowTitleSource(value: string | null | undefined): SessionTitleUpdate["source"] | undefined {
	return value === "auto" || value === "user" ? value : undefined;
}
function isDuplicateColumnError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("duplicate column") || message.includes("already exists");
}
/** SQLite's refusal of a ROLLBACK after an error that already rolled the transaction back. */
function isNoActiveTransactionError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("no transaction is active");
}
/** MySQL `ER_LOCK_DEADLOCK` (errno 1213, SQLSTATE 40001) or PostgreSQL `deadlock_detected` / `serialization_failure`. */
function isDeadlockError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const errno = "errno" in error ? error.errno : undefined;
	const sqlState = "sqlState" in error ? error.sqlState : undefined;
	return errno === 1213 || errno === "40P01" || errno === "40001" || sqlState === "40001";
}
/**
 * A primary-key collision, as each dialect reports it: PostgreSQL
 * `unique_violation` (SQLSTATE 23505), MySQL `ER_DUP_ENTRY` (errno 1062,
 * SQLSTATE 23000), SQLite `SQLITE_CONSTRAINT_PRIMARYKEY` (extended code 1555).
 */
function isPrimaryKeyViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const errno = "errno" in error ? error.errno : undefined;
	const code = "code" in error ? error.code : undefined;
	return errno === "23505" || errno === 1062 || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/** Concatenate a window's pieces in byte-offset order; the session row's own bytes come first. */
function joinSliceBytes(first: Uint8Array | null, pieces: Array<{ offset: number; bytes: Uint8Array | null }>): Buffer {
	pieces.sort((a, b) => a.offset - b.offset);
	const chunks: Uint8Array[] = [];
	for (const bytes of [first, ...pieces.map(piece => piece.bytes)]) {
		if (bytes) chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

/**
 * Where a part of `bytes` that starts at `start` and holds at most `maxBytes`
 * ends: at the end of `bytes` when it is that close, otherwise `maxBytes` on,
 * backed off continuation bytes (0b10xxxxxx) so no character straddles two
 * parts. A run of continuation bytes that long, never in valid UTF-8, is cut
 * at `maxBytes`.
 */
function utf8PartEnd(bytes: Uint8Array, start: number, maxBytes: number): number {
	const limit = start + maxBytes;
	if (limit >= bytes.byteLength) return bytes.byteLength;
	let end = limit;
	while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
	return end === start ? limit : end;
}

/**
 * Cut the UTF-8 bytes `chunks` yields into parts of at most `maxBytes`, each
 * ending on a character boundary, also where a character straddles two
 * chunks: a cut is made only once the byte after it has arrived.
 */
async function* utf8Parts(
	chunks: AsyncIterable<Uint8Array>,
	maxBytes: number,
): AsyncGenerator<{ text: string; byteLength: number }> {
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	for await (const chunk of chunks) {
		pending.push(chunk);
		pendingBytes += chunk.byteLength;
		if (pendingBytes <= maxBytes) continue;
		const bytes = Buffer.concat(pending, pendingBytes);
		let start = 0;
		while (bytes.byteLength - start > maxBytes) {
			const end = utf8PartEnd(bytes, start, maxBytes);
			yield { text: bytes.toString("utf8", start, end), byteLength: end - start };
			start = end;
		}
		pending = [bytes.subarray(start)];
		pendingBytes = bytes.byteLength - start;
	}
	if (pendingBytes > 0)
		yield { text: Buffer.concat(pending, pendingBytes).toString("utf8"), byteLength: pendingBytes };
}

/** The UTF-8 text `chunks` yields, decoded as it arrives, and its byte count. */
async function decodeChunks(chunks: AsyncIterable<Uint8Array>): Promise<{ text: string; bytes: number }> {
	// A leading byte order mark is content here, as Buffer#toString keeps it.
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let text = "";
	let bytes = 0;
	for await (const chunk of chunks) {
		text += decoder.decode(chunk, { stream: true });
		bytes += chunk.byteLength;
	}
	return { text: text + decoder.decode(), bytes };
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file is a row of the session table keyed by `path`, holding
 * its metadata (`byte_len`, `mtime_ms`, title fields), plus rows of
 * `<table>_parts` keyed by (`path`, `start_offset`): an append inserts one
 * part, a full write replaces them with parts of at most 1 MiB (a streamed
 * one stages them under `<path>#staging-…` first and swaps them in). A
 * session's content is the row's `content` (non-empty only for rows an older
 * version wrote) followed by its parts in offset order, which reads stream in
 * pages of parts. This process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory for synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls.
 *
 * Works against PostgreSQL, MySQL/MariaDB, and SQLite by selecting the
 * dialect-correct DDL, upsert, row-lock, byte-length, and byte-slice syntax
 * at construction.
 */
export class SqlSessionStorage extends IndexedSessionStorage {
	/** Always set: the SQL backend reads a session part by part. */
	declare readonly readChunks: (path: string, fromByte?: number) => AsyncIterable<Uint8Array>;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;

	constructor(backend: SqlSessionStorageBackend, adapter: SqlSessionStorageAdapter, table: string) {
		super(backend);
		this.#adapter = adapter;
		this.#table = table;
	}

	/**
	 * Apply the dialect-correct DDL and migration (unless `createTable: false`
	 * is set, which instead verifies the schema is in place) and warm the
	 * metadata index with every existing row. Must be awaited before passing
	 * the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const backend = new SqlSessionStorageBackend(options);
		const storage = new SqlSessionStorage(backend, backend.adapter, backend.table);
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #q: DialectQueries;
	readonly #createTable: boolean;
	/** The shared call queue for this client's SQLite database; unset on other dialects. */
	readonly #sqliteQueue: SqliteQueue | undefined;
	/** Longest path, staging paths included, the dialect's `path` columns hold, in characters. */
	readonly #pathChars: number;

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(
				`SqlSessionStorage: table name must match ${IDENT_RE.source}, at most 57 characters so ` +
					`${JSON.stringify(`${table}_parts`)} stays a valid identifier (got ${JSON.stringify(table)})`,
			);
		}
		this.#table = table;
		this.#q = buildQueries(this.#adapter, table);
		this.#createTable = options.createTable !== false;
		this.#sqliteQueue = this.#adapter === "sqlite" ? sqliteQueue(options.client) : undefined;
		this.#pathChars = this.#adapter === "mysql" ? MYSQL_PATH_CHARS : Number.POSITIVE_INFINITY;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	init(): Promise<void> {
		return this.#exclusive(async () => {
			if (this.#adapter === "sqlite") {
				// Another process's write lock then makes this one wait instead of failing at once.
				const [setting] = (await this.#client.unsafe("PRAGMA busy_timeout")) as BusyTimeoutRow[];
				if (setting && rowNumber(setting.timeout) === 0) {
					await this.#client.unsafe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
				}
			}
			if (!this.#createTable) {
				await this.#assertSchema();
				return;
			}
			await this.#setup(this.#q.createTable);
			// Probe before altering: PostgreSQL's ALTER TABLE waits for every open
			// transaction on the table even when the column exists.
			const columns = await this.#columns(this.#table);
			for (const { column, ddl } of this.#q.addColumns) {
				if (columns.has(column)) continue;
				try {
					await this.#setup(ddl);
				} catch (err) {
					// Another process starting at the same moment added it first.
					if (!isDuplicateColumnError(err)) throw err;
				}
			}
			// MySQL's UPDATE locks every row it scans, so a no-op backfill would
			// still wait for, and block, every write in flight.
			if ((await this.#client.unsafe(this.#q.findUnmeasured)).length > 0) {
				await this.#setup(this.#q.backfillByteLen);
			}
			await this.#setup(this.#q.createPartsTable);
		});
	}

	/**
	 * Run one start-up statement of `init`. Stores that start at the same
	 * moment on a PostgreSQL database without the tables would race: two
	 * `CREATE TABLE IF NOT EXISTS` of one name both find no table, and one
	 * fails (SQLSTATE 23505, 42P07 or 42710). So there every start-up
	 * statement runs in its own transaction behind the start-up opening of
	 * `#readWrite`, which takes one transaction-scoped advisory lock; they run
	 * one after another, and the lock ends with the transaction. Each
	 * statement keeps its own transaction, so a duplicate-column error still
	 * fails only its own ALTER. On MySQL and SQLite the statement runs
	 * straight on the client.
	 */
	async #setup(query: string): Promise<void> {
		if (this.#adapter !== "postgres") {
			await this.#writeAlone(executor => executor.unsafe(query));
			return;
		}
		await this.#readWrite(transaction => transaction.unsafe(query), "start-up");
	}

	/**
	 * Run one write outside any store transaction: on PostgreSQL in a
	 * read-write transaction of its own (see `#readWrite`), elsewhere straight
	 * on the client. On SQLite it does not use the call queue, so the caller
	 * must already hold `#exclusive` (`init` and `updateSessionTitle` do), or
	 * the statement can join another call's `BEGIN IMMEDIATE` on SQLite's one
	 * connection.
	 */
	async #writeAlone(write: (executor: SqlSessionStorageTransaction) => Promise<unknown>): Promise<void> {
		if (this.#adapter === "postgres") await this.#readWrite(write);
		else await write(this.#client);
	}

	/**
	 * Run `work` in one PostgreSQL transaction that starts with `opening`.
	 * Used on PostgreSQL only.
	 *
	 * The write opening is `SET TRANSACTION READ WRITE`, then a read of
	 * `setting` and `reset_val` of `default_transaction_read_only` (see
	 * {@link READ_ONLY_SETTINGS}). A pooled connection can carry another
	 * client's session-level `default_transaction_read_only = on` (a
	 * transaction-mode pooler hands one backend to many clients, and a session
	 * `SET` stays on it); PostgreSQL then refuses every write, even
	 * `CREATE TABLE IF NOT EXISTS` on a table that exists (SQLSTATE 25006),
	 * but honours `READ WRITE` set as a transaction's first statement whatever
	 * that default is. The read gives three cases:
	 * - A session value over a default that is off (`setting` on, `reset_val`
	 *   off): the store overrides it, and `work` runs.
	 * - A read-only default that the backend session keeps (both on): the
	 *   store honours it. The database, the role, the server or the backend
	 *   connection's start parameters set it, so it is an operator's or a
	 *   provider's decision (a provider can make a database read-only when its
	 *   disk is nearly full). The transaction fails before `work` runs, with
	 *   nothing written.
	 * - A session that turned such a default off (`setting` off, `reset_val`
	 *   on): `work` runs, as it did before the store read this setting.
	 * A transaction-mode pooler applies a client's start parameters and its
	 * `connect_query` to the backend with `SET`, so the store overrides them
	 * like any session value. Any other answer, no row included, lets `work`
	 * run.
	 *
	 * The start-up opening (see `#setup`) adds `READ COMMITTED` before the
	 * read and the start-up advisory lock after it. Under a `repeatable read`
	 * default the snapshot would be taken before the lock wait, and a
	 * backfill would then fail with SQLSTATE 40001. The lock comes after the
	 * read, so an honoured default refuses before any wait.
	 */
	#readWrite(
		work: (transaction: SqlSessionStorageTransaction) => Promise<unknown>,
		opening: "write" | "start-up" = "write",
	): Promise<void> {
		return this.#client.transaction(async transaction => {
			await transaction.unsafe("SET TRANSACTION READ WRITE");
			if (opening === "start-up") await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
			const [readOnly] = (await transaction.unsafe(READ_ONLY_SETTINGS)) as ReadOnlySettingsRow[];
			if (readOnly?.setting === "on" && readOnly.reset_val === "on") throw new Error(READ_ONLY_REFUSAL);
			if (opening === "start-up") await transaction.unsafe(`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
			await work(transaction);
		});
	}

	/**
	 * Run `task` alone on its SQLite database: every backend call of every
	 * store in this process on that database goes through one queue (see
	 * {@link sqliteQueue}). Other dialects run statements on pooled
	 * connections and need no queue.
	 */
	#exclusive<T>(task: () => Promise<T>): Promise<T> {
		const queue = this.#sqliteQueue;
		if (!queue) return task();
		const result = queue.tail.then(task);
		// The queue only orders tasks; each caller receives its own task's failure.
		queue.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	/**
	 * Run `work` in one transaction. On SQLite it opens with `BEGIN IMMEDIATE`,
	 * taking the write lock up front, so a writer in another process makes it
	 * wait (busy timeout) or fail before anything ran. On PostgreSQL it starts
	 * with the write opening of `#readWrite`. On PostgreSQL and MySQL a
	 * transaction the database aborts as a deadlock victim runs again; each
	 * one recomputes everything under its own locks. A refused read-only
	 * default is no deadlock and does not run again.
	 */
	#transaction(work: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> {
		if (this.#adapter === "postgres") return this.#retryDeadlocks(() => this.#readWrite(work));
		if (this.#adapter === "mysql") return this.#retryDeadlocks(() => this.#client.transaction(work));
		return this.#exclusive(async () => {
			await this.#client.unsafe("BEGIN IMMEDIATE");
			try {
				await work(this.#client);
				await this.#client.unsafe("COMMIT");
			} catch (err) {
				// A failed COMMIT (a reader in another process held the file past
				// the busy timeout) leaves the transaction open, so roll back here.
				// SQLite refuses the ROLLBACK when the error already rolled the
				// transaction back (SQLITE_FULL, SQLITE_IOERR, ...); `err` is then
				// the whole story. Any other ROLLBACK failure leaves the connection
				// inside a transaction, so it is reported beside `err`.
				try {
					await this.#client.unsafe("ROLLBACK");
				} catch (rollbackErr) {
					if (!isNoActiveTransactionError(rollbackErr)) {
						throw new AggregateError(
							[err, rollbackErr],
							"SqlSessionStorage: a SQLite transaction failed and its ROLLBACK failed too",
						);
					}
				}
				throw err;
			}
		});
	}

	async #retryDeadlocks(write: () => Promise<unknown>): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await write();
				return;
			} catch (err) {
				if (attempt >= WRITE_ATTEMPTS || !isDeadlockError(err)) throw err;
				await Bun.sleep(Math.random() * 20 * attempt);
			}
		}
	}

	/**
	 * Delete `path`'s parts inside a write transaction. On MySQL, a DELETE that
	 * matches nothing still takes a gap lock, and two transactions inserting
	 * into the gaps each other locked deadlock; so look first, without locking.
	 * Every writer of a path's parts first locks that path's session row. The
	 * look is a consistent read, and under REPEATABLE READ the transaction's
	 * first consistent read fixes its snapshot: a caller must lock the row of
	 * every path it will look at before the first look, or a part a peer
	 * commits in between is invisible to the look and is left orphaned.
	 */
	async #deleteParts(transaction: SqlSessionStorageTransaction, path: string): Promise<void> {
		if (this.#adapter === "mysql" && (await run(transaction, this.#q.hasParts, { path })).length === 0) return;
		await run(transaction, this.#q.deleteParts, { path });
	}

	/** Refuse to start against a schema an external migration has not brought up to date. */
	async #assertSchema(): Promise<void> {
		const partsTable = `${this.#table}_parts`;
		const missing: string[] = [];
		const sessionColumns = await this.#columns(this.#table);
		if (sessionColumns.size === 0) missing.push(`table ${this.#table}`);
		else if (!sessionColumns.has("byte_len")) missing.push(`column ${this.#table}.byte_len`);
		if ((await this.#columns(partsTable)).size === 0) missing.push(`table ${partsTable}`);
		if (missing.length === 0) return;
		throw new Error(
			`SqlSessionStorage: createTable is false, but the database has no ${missing.join(" and no ")}. ` +
				`Apply the schema in ${SCHEMA_DOCS}, or let create() apply it.`,
		);
	}

	async #columns(table: string): Promise<Set<string>> {
		const rows = (await run(this.#client, this.#q.columns, { table })) as ColumnRow[];
		return new Set(rows.map(row => row.column_name.toLowerCase()));
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const rows = (await this.#exclusive(() => this.#client.unsafe(this.#q.loadIndex))) as IndexRow[];
		return rows.map(row => {
			if (row.byte_len === null) throw this.#unmeasured(row.path);
			return {
				path: row.path,
				size: rowNumber(row.byte_len),
				mtimeMs: rowNumber(row.mtime_ms),
				title: row.title ?? undefined,
				titleSource: rowTitleSource(row.title_source),
				titleUpdatedAt: row.title_updated_at ?? undefined,
			};
		});
	}

	async readFull(path: string): Promise<string | null> {
		const rows = (await this.#exclusive(() => run(this.#client, this.#q.readFull, { path }))) as ContentRow[];
		let head: string | undefined;
		const parts: Array<{ offset: number; content: string }> = [];
		for (const row of rows) {
			if (rowNumber(row.kind) === 0) head = row.content;
			else parts.push({ offset: rowNumber(row.start_offset), content: row.content });
		}
		if (head === undefined) return null;
		parts.sort((a, b) => a.offset - b.offset);
		return head + parts.map(part => part.content).join("");
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const rows = (await this.#exclusive(() =>
			run(this.#client, this.#q.readSlices, { path, prefix: prefixBytes, suffix: suffixBytes }),
		)) as SliceRow[];
		let session: SliceRow | undefined;
		const headParts: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		const tailParts: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		for (const row of rows) {
			const kind = rowNumber(row.kind);
			if (kind === 0) session = row;
			else if (kind === 1) headParts.push({ offset: rowNumber(row.start_offset), bytes: row.head });
			else tailParts.push({ offset: rowNumber(row.start_offset), bytes: row.tail });
		}
		if (!session) throw enoent(path);
		return [
			utf8Decoder.decode(joinSliceBytes(session.head, headParts)),
			utf8Decoder.decode(joinSliceBytes(session.tail, tailParts)),
		];
	}

	async readFrom(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null> {
		const take = Math.min(
			maxBytes === undefined ? MAX_PIECE_BYTES : Math.max(0, Math.trunc(maxBytes)),
			MAX_PIECE_BYTES,
		);
		const rows = (await this.#exclusive(() =>
			run(this.#client, this.#q.readFrom, {
				path,
				offset,
				end: maxBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.min(offset + take, Number.MAX_SAFE_INTEGER),
				take,
				row_from: Math.min(offset, MAX_PIECE_BYTES - 1) + 1,
			}),
		)) as ReadFromRow[];
		let size: number | undefined;
		let head: Uint8Array | null = null;
		const pieces: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		for (const row of rows) {
			if (rowNumber(row.kind) !== 0) {
				pieces.push({ offset: rowNumber(row.start_offset), bytes: row.bytes });
				continue;
			}
			if (row.byte_len === null) throw this.#unmeasured(path);
			size = rowNumber(row.byte_len);
			head = row.bytes;
		}
		if (size === undefined) return null;
		const bytes = joinSliceBytes(head, pieces);
		// Each piece is capped on its own; the window is capped as a whole.
		return { text: utf8Decoder.decode(maxBytes === undefined ? bytes : bytes.subarray(0, take)), size };
	}

	/**
	 * The stored bytes from `fromByte`: the row's own content from there when
	 * it holds any, then the parts in `start_offset` order, one page per query:
	 * the parts that start within the page's span of where the read is, each
	 * part a chunk of its own. The first page spans
	 * {@link FIRST_PAGE_SPAN_BYTES} from `fromByte` and each next one twice the
	 * last, up to {@link PAGE_SPAN_BYTES}, so a reader that stops early fetches
	 * little past where it stopped. The read stops at the size its first query
	 * saw, so an append made meanwhile, which only adds parts past it, is left
	 * out.
	 *
	 * A full write or a delete replaces every part of the session, the one the
	 * read starts at included. So on PostgreSQL and SQLite the query of each
	 * page also checks, in the same statement, that this part still has the row
	 * identity the first query saw (its `xmin`; or its rowid, which a full
	 * write never hands to a new part, see `DialectQueries.partRowids`), and
	 * finds no parts when it does not. A page with no part where the read is,
	 * a part that does not start where the previous one ended, or parts that
	 * end short of the size mean a full write or a delete replaced the parts
	 * during the read; it then fails with {@link SessionReadConflictError}
	 * instead of yielding a mix of two bodies. MySQL has no row identity, so
	 * there only those checks apply, and a full write that keeps the size and
	 * every part's start, made between two pages, goes unseen. SQLite gives a
	 * new row the largest rowid plus one, so a delete followed by a re-create
	 * at the same path, made between two pages, can give the new parts the
	 * rowids of the deleted ones when those were the table's newest; then only
	 * those checks apply there too, and a re-created body that keeps the size
	 * and every part's start goes unseen.
	 */
	async *readChunks(path: string, fromByte: number): AsyncGenerator<Uint8Array> {
		const [row] = (await this.#exclusive(() =>
			run(this.#client, this.#q.readChunksStart, {
				path,
				offset: fromByte,
				row_from: Math.min(fromByte, MAX_PIECE_BYTES - 1) + 1,
			}),
		)) as ChunksStartRow[];
		if (!row) throw enoent(path);
		if (row.byte_len === null) throw this.#unmeasured(path);
		const size = rowNumber(row.byte_len);
		if (row.head && row.head.byteLength > 0) yield row.head;
		if (fromByte >= size) return;
		const firstPart = rowNumber(row.first_part);
		const anchor = { anchor: firstPart, anchor_id: row.first_id };
		let next = firstPart < 0 ? rowNumber(row.content_len) : firstPart;
		let skip = Math.max(0, fromByte - next);
		for (let span = FIRST_PAGE_SPAN_BYTES; next < size; span = Math.min(span * 2, PAGE_SPAN_BYTES)) {
			// The first page starts at the part `fromByte` lies in, but spans from `fromByte` itself.
			const end = Math.max(next, fromByte) + span;
			const parts = (await this.#exclusive(() =>
				run(this.#client, this.#q.readParts, { path, next, end, ...anchor }),
			)) as PartRow[];
			if (parts.length === 0) throw new SessionReadConflictError(path);
			for (const part of parts) {
				const start = rowNumber(part.start_offset);
				if (start !== next) throw new SessionReadConflictError(path);
				if (start >= size) break;
				const bytes = Buffer.from(part.content, "utf8");
				next = start + bytes.byteLength;
				if (skip >= bytes.byteLength) {
					skip -= bytes.byteLength;
					continue;
				}
				yield skip > 0 ? bytes.subarray(skip) : bytes;
				skip = 0;
			}
		}
		if (next !== size) throw new SessionReadConflictError(path);
	}

	#unmeasured(path: string): Error {
		return new Error(
			`SqlSessionStorage: ${this.#table} row ${JSON.stringify(path)} has no byte_len; ` +
				`run the byte_len backfill in ${SCHEMA_DOCS}.`,
		);
	}

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const bytes = Buffer.from(content, "utf8");
		await this.#transaction(async transaction => {
			await this.#replaceRow(transaction, path, mtimeMs, title, bytes.byteLength, expectedSize);
			// A created session also drops parts orphaned under its path.
			await this.#replaceParts(transaction, path, bytes);
		});
	}

	/**
	 * {@link writeFull} from a stream. The parts go in under a staging path,
	 * `<path>#staging-<epoch ms>-<id>`, {@link STAGING_PARTS_PER_TRANSACTION}
	 * per transaction; then one transaction checks the session's size, deletes
	 * the path's staging sets older than {@link STALE_STAGING_MS} (a dead
	 * writer's), checks that every staged byte is still there (a staging set
	 * another writer removed is a conflict), and swaps the staged parts in for
	 * the session's. Staging parts have no row, so no listing or index sees
	 * them. On failure it removes its own. A path whose staging path would not
	 * fit the dialect's path column (MySQL's 512 characters) is written whole
	 * through {@link writeFull} instead.
	 */
	async writeFullStream(
		path: string,
		chunks: AsyncIterable<Uint8Array>,
		byteLength: number,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const now = Date.now();
		const prefix = `${path}${STAGING_MARK}`;
		const stagingAt = (epochMs: number): string => `${prefix}${String(epochMs).padStart(STAGING_EPOCH_DIGITS, "0")}`;
		const staging = `${stagingAt(now)}-${Snowflake.next()}`;
		if ([...staging].length > this.#pathChars) {
			const { text, bytes } = await decodeChunks(chunks);
			if (bytes !== byteLength) {
				throw new Error(`SqlSessionStorage: a full write of ${path} streamed ${bytes} bytes, not ${byteLength}`);
			}
			await this.writeFull(path, text, mtimeMs, title, expectedSize);
			return;
		}
		try {
			let staged = 0;
			let batch: Array<{ offset: number; content: string }> = [];
			const insertBatch = async (): Promise<void> => {
				const parts = batch;
				batch = [];
				await this.#transaction(async transaction => {
					for (const part of parts) await run(transaction, this.#q.insertPart, { path: staging, ...part });
				});
			};
			for await (const part of utf8Parts(chunks, PART_BYTES)) {
				batch.push({ offset: staged, content: part.text });
				staged += part.byteLength;
				if (batch.length === STAGING_PARTS_PER_TRANSACTION) await insertBatch();
			}
			if (batch.length > 0) await insertBatch();
			if (staged !== byteLength) {
				throw new Error(`SqlSessionStorage: a full write of ${path} streamed ${staged} bytes, not ${byteLength}`);
			}
			await this.#transaction(async transaction => {
				// The session's size as this write finds it under the row lock: the
				// size check's, or, for a write without one, read here.
				const sessionSize = expectedSize === undefined ? await this.#lockSize(transaction, path) : expectedSize;
				await this.#replaceRow(transaction, path, mtimeMs, title, byteLength, expectedSize);
				await this.#deleteStaging(transaction, prefix, stagingAt(now - STALE_STAGING_MS));
				const stagedParts = (await run(transaction, this.#q.stagedBytes, { path: staging })) as StagedPartRow[];
				const found = stagedParts.reduce((total, part) => total + rowNumber(part.len), 0);
				// A delete or rename of the session deleted this write's staging parts after they were written.
				if (found !== byteLength) throw new SessionWriteConflictError(path, sessionSize, sessionSize);
				await this.#deleteParts(transaction, path);
				await run(transaction, this.#q.renameParts, { src: staging, dst: path });
			});
		} catch (err) {
			try {
				await this.#transaction(transaction => this.#deleteParts(transaction, staging));
			} catch {
				// The write's own failure is the one to report; the path's next full write removes this set once it is stale.
			}
			throw err;
		}
	}

	/**
	 * Lock `path`'s row for a full write and give it the new metadata: insert
	 * it when `expectedSize` is null (a conflict when it exists), otherwise
	 * check its `byte_len` against `expectedSize` when given, then upsert it.
	 */
	async #replaceRow(
		transaction: SqlSessionStorageTransaction,
		path: string,
		mtimeMs: number,
		title: SessionTitleUpdate | undefined,
		byteLength: number,
		expectedSize: number | null | undefined,
	): Promise<void> {
		const row = {
			path,
			mtime: mtimeMs,
			title: title?.title ?? null,
			title_source: title?.source ?? null,
			title_updated_at: title?.updatedAt ?? null,
			len: byteLength,
		};
		if (expectedSize === null) {
			const result = await run(transaction, this.#q.insertRowIfMissing, row);
			const inserted = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			if (!inserted) throw new SessionWriteConflictError(path, null, await this.#lockSize(transaction, path));
			return;
		}
		// The size check reads `byte_len` under the row lock rather than
		// trusting a conditional UPDATE's row count, which MySQL reports
		// as 0 for a matched row whose values did not change.
		if (expectedSize !== undefined) {
			const actualSize = await this.#lockSize(transaction, path);
			if (actualSize !== expectedSize) throw new SessionWriteConflictError(path, expectedSize, actualSize);
		}
		await run(transaction, this.#q.upsertRow, row);
	}

	async #lockSize(transaction: SqlSessionStorageTransaction, path: string): Promise<number | null> {
		const rows = (await run(transaction, this.#q.lockSize, { path })) as SizeRow[];
		const row = rows[0];
		return row ? rowNumber(row.byte_len) : null;
	}

	/**
	 * Replace `path`'s parts with `bytes`, as parts of at most
	 * {@link PART_BYTES}, each ending on a UTF-8 character boundary. On SQLite
	 * the new parts take rowids above every part's, read before the old ones
	 * go, so none takes the rowid of a part it replaces (see
	 * {@link readChunks}).
	 */
	async #replaceParts(transaction: SqlSessionStorageTransaction, path: string, bytes: Buffer): Promise<void> {
		const rowids = this.#q.partRowids;
		const [last] = rowids ? ((await run(transaction, rowids.last, {})) as RowidRow[]) : [];
		let rowid = last ? rowNumber(last.last_rowid) : 0;
		await this.#deleteParts(transaction, path);
		for (let start = 0; start < bytes.byteLength;) {
			const end = utf8PartEnd(bytes, start, PART_BYTES);
			await run(transaction, rowids ? rowids.insert : this.#q.insertPart, {
				path,
				offset: start,
				content: bytes.toString("utf8", start, end),
				rowid: ++rowid,
			});
			start = end;
		}
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#exclusive(() =>
			this.#writeAlone(executor =>
				run(executor, this.#q.updateTitle, {
					path,
					title: title.title ?? null,
					title_source: title.source ?? null,
					title_updated_at: title.updatedAt,
					mtime: mtimeMs,
				}),
			),
		);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		const values = { path, content: line, mtime: mtimeMs, len: Buffer.byteLength(line, "utf8") };
		await this.#transaction(async transaction => {
			for (const query of this.#q.append) await run(transaction, query, values);
		});
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[], dir?: string): Promise<void> {
		const under = dir === undefined ? undefined : { dir, len: [...dir].length };
		await this.#transaction(async transaction => {
			// Every row first: their locks must all be held before the first parts look (see #deleteParts).
			for (const path of paths) await run(transaction, this.#q.deleteRow, { path });
			if (under) for (const query of this.#q.deleteUnder) await run(transaction, query, under);
			for (const path of paths) {
				await this.#deleteParts(transaction, path);
				await this.#deleteStagingOf(transaction, path);
			}
		});
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		if (src === dst) {
			const rows = await this.#exclusive(() => run(this.#client, this.#q.exists, { path: src }));
			if (rows.length === 0) throw enoent(src);
			return;
		}
		await this.#transaction(async transaction => {
			if (!noReplace) await run(transaction, this.#q.deleteRow, { path: dst });
			// One statement renames the row, so the primary key refuses a `dst`
			// row that exists, or that another client inserts concurrently (the
			// UPDATE waits on its uncommitted key); the thrown error rolls the
			// transaction back with both paths untouched.
			let result: SqlSessionStorageResult;
			try {
				result = await run(transaction, this.#q.renameRow, { src, dst, mtime: mtimeMs });
			} catch (err) {
				if (noReplace && isPrimaryKeyViolation(err)) throw eexist(dst);
				throw err;
			}
			const moved = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			if (!moved) throw enoent(src);
			// Both rows are locked now, before the parts look (see #deleteParts):
			// parts orphaned under `dst` go, then `src`'s follow its row.
			await this.#deleteParts(transaction, dst);
			await run(transaction, this.#q.renameParts, { src, dst });
			// Staging sets stay under the name their writer staged them for: the
			// source's are left with no session, and so are a replaced destination's.
			await this.#deleteStagingOf(transaction, src);
			if (!noReplace) await this.#deleteStagingOf(transaction, dst);
		});
	}

	/** Delete every staging set of `path`, whatever its age: a path that goes takes its unfinished full writes with it. */
	#deleteStagingOf(transaction: SqlSessionStorageTransaction, path: string): Promise<void> {
		const prefix = `${path}${STAGING_MARK}`;
		// The largest epoch bounds every name: code-point and locale collations alike order
		// staging names by their epoch digits, while a punctuation bound sorts before digits
		// in some (ICU puts ":" before "0").
		return this.#deleteStaging(transaction, prefix, `${prefix}${"9".repeat(STAGING_EPOCH_DIGITS)}`);
	}

	/** Delete the staging parts whose names run from `low` (a path's staging prefix) up to, not including, `high`. */
	async #deleteStaging(transaction: SqlSessionStorageTransaction, low: string, high: string): Promise<void> {
		const range = { low, high, len: [...low].length };
		// As in #deleteParts: on MySQL a DELETE that matches nothing still takes a gap lock.
		if (this.#adapter === "mysql" && (await run(transaction, this.#q.hasStaging, range)).length === 0) return;
		await run(transaction, this.#q.deleteStaging, range);
	}
}
