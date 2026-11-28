import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type FileLockHandle, getBlobsDir, isEnoent, logger, postmortem, toError } from "@oh-my-pi/pi-utils";
import type { SessionBlobSweep, SessionBlobTier } from "./blob-store";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
	type SessionStorageReadTitle,
	type SessionStorageStoredWindow,
	type SessionStorageWindowRead,
} from "./indexed-session-storage";
import {
	type SessionAcquireOptions,
	type SessionClaimHolder,
	SessionLeaseLostError,
	type SessionStorage,
	SessionWriteConflictError,
	sessionLeaseId,
	tryAcquireSessionLease,
} from "./session-storage";
import { eexist, enoent } from "./session-storage-errors";
import { parseTitleSlotFromContent, type SessionTitleUpdate } from "./session-title-slot";
import { PG_CONDITIONAL_PARAMETERS, PG_REPAIR_RETRIES, pgOpening } from "./sql-session-postgres-settings";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / byte-slice syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * SQL executor shared by the pooled client, its transaction-scoped handle and
 * a reserved connection. Bun's SQL client exposes a tagged-template API too,
 * but this implementation intentionally uses `unsafe(query, values)` because
 * the table identifier is validated and then inlined while values remain bound
 * parameters.
 */
export interface SqlSessionStorageTransaction {
	unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult>;
}

/**
 * One server connection that {@link SqlSessionStorageClient.reserve} gives the
 * store alone, until the store calls `release()` (its transaction ended, and
 * the pool may hand the connection to another caller) or `close()` (the
 * store cannot repair the connection, so nobody may use it again). On it the
 * store runs one PostgreSQL transaction that it opens and ends itself, and
 * sends, in order:
 * - the opening: one `unsafe()` call with no values (one simple query), which
 *   begins the transaction (`BEGIN ISOLATION LEVEL READ COMMITTED`, then
 *   `READ WRITE`, or `READ ONLY` for a read) and sets with `SET LOCAL` every
 *   session setting the store's statements depend on (see
 *   `sql-session-postgres-settings.ts`);
 * - for a write, the read of `default_transaction_read_only`, and at start-up
 *   the start-up lock;
 * - the operation's statements, their values bound;
 * - `COMMIT`, or `ROLLBACK` after an error. The store reads the `command` tag
 *   of the `COMMIT` answer, as `Bun.SQL` gives it: `ROLLBACK` there fails the
 *   operation.
 * So a wrapper's `reserve()` must hand back one real server connection that
 * sends each message of the store to that connection, and nothing else:
 * `SET LOCAL`, the transaction and its locks hold only on that connection,
 * and a wrapper that sends each message on any free connection runs the
 * store's statements outside the transaction the store opened.
 */
export interface SqlSessionStorageReservedConnection extends SqlSessionStorageTransaction {
	release(): void | Promise<void>;
	close(): Promise<void>;
}

/**
 * Bun.SQL-compatible client. MySQL writes run in `transaction()` so a session
 * row and its parts change together; on SQLite the store issues
 * `BEGIN IMMEDIATE` / `COMMIT` through `unsafe()` itself and runs one call at a
 * time per client, because Bun's SQLite adapter has a single connection.
 * On PostgreSQL the store sends nothing through the client's own `unsafe()`
 * or `transaction()`: it runs every statement on a connection that
 * `reserve()` gives it (see {@link SqlSessionStorageReservedConnection}), so
 * a PostgreSQL client must provide `reserve()`. MySQL and SQLite never call it.
 */
export interface SqlSessionStorageClient extends SqlSessionStorageTransaction {
	transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void>;
	/** One server connection for the store alone (PostgreSQL); `Bun.SQL` provides it. */
	reserve?(): Promise<SqlSessionStorageReservedConnection>;
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
	/**
	 * The answer's command tag, as `Bun.SQL` gives it. The store reads it on
	 * `COMMIT`, which answers `ROLLBACK` when the transaction rolled back.
	 */
	command?: string;
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
	 * `<table>_parts`, and blobs a session cannot draw again in `<table>_blobs`.
	 * Must match `[A-Za-z_][A-Za-z0-9_]{0,56}`: at most 57 characters, so
	 * `<table>_parts` and `<table>_blobs` fit the 63-character identifier limit.
	 * Both names are inlined into prepared statements, so we accept
	 * identifier-safe inputs only (no quoted/dotted names).
	 */
	table?: string;
	/**
	 * If true, create the tables (the session table, `<table>_parts`, and on
	 * PostgreSQL and MySQL the lease table) and migrate an older session
	 * table during `create()`. Default: true. With false, `create()` runs no
	 * DDL and refuses to start unless the schema docs/session.md ("SQL
	 * session storage") describes is in place; use it when the tables are
	 * owned by an external migration.
	 */
	createTable?: boolean;
	/**
	 * Largest blob one row of `<table>_blobs` holds; a larger one is stored
	 * as parts of at most this size. Default: 512 MiB, or the server's
	 * `max_allowed_packet` less 1 MiB on MySQL and MariaDB when that is smaller.
	 */
	maxBlobBytes?: number;
	/**
	 * Claim the sessions this process writes (`claimSession`,
	 * `acquireSessionClaim`, `sessionClaimLost`), so a second live process
	 * that opens one moves to a sibling instead of writing the same journal.
	 * On PostgreSQL and MySQL a claim is a row of {@link leaseTable} that a
	 * heartbeat keeps fresh and that every content write checks in its own
	 * transaction; on a SQLite file it is an OS lock the kernel drops when
	 * this process dies. An in-memory SQLite database claims nothing. Default:
	 * false, so a store an SDK caller builds from a client behaves as before;
	 * the CLI turns it on.
	 */
	claims?: boolean;
	/**
	 * Lease table name (PostgreSQL and MySQL). Default: `omp_session_leases`.
	 * Rows are keyed by session id, and session ids are UUIDs, so stores with
	 * different session tables may share one. Must match
	 * `[A-Za-z_][A-Za-z0-9_]{0,55}`: at most 56 characters, so its index
	 * `<leaseTable>_holder` fits the 63-character identifier limit.
	 */
	leaseTable?: string;
	/**
	 * Lease timings: a lease whose heartbeat is older than `expiryMs` on the
	 * database clock may be taken over; the holder refreshes it every
	 * `heartbeatMs`. Default: {@link SESSION_LEASE_EXPIRY_MS} and
	 * {@link SESSION_LEASE_HEARTBEAT_MS}; `expiryMs` must exceed `heartbeatMs`.
	 */
	lease?: { expiryMs: number; heartbeatMs: number };
}

/** A lease whose heartbeat is older than this, by the database clock, may be taken over. */
export const SESSION_LEASE_EXPIRY_MS = 30_000;
/** How often a store refreshes the heartbeat of every lease it holds. */
export const SESSION_LEASE_HEARTBEAT_MS = 10_000;
/**
 * How long opening an existing session waits for another process's lease on
 * it to go or expire before it moves off (or, under `OMP_SESSION_EXCLUSIVE=1`,
 * stops): one expiry and 5 s.
 */
export const SESSION_OPEN_CLAIM_WAIT_MS = SESSION_LEASE_EXPIRY_MS + 5000;

/** A dialect-rendered statement and the names of the values it binds, in binding order. */
interface Statement {
	readonly sql: string;
	readonly params: readonly string[];
}

type StatementValues = Readonly<Record<string, string | number | Uint8Array | null>>;

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
	/** Warm the synchronous index from session rows only: path, size and time, never content or title. */
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
	 * case) and exactly those rows' parts. PostgreSQL and MySQL do both in one
	 * statement, so the parts deleted are those of the rows deleted: a row
	 * another client commits between two statements would otherwise keep its
	 * row and lose its parts under READ COMMITTED. SQLite runs the two
	 * statements inside `BEGIN IMMEDIATE`, where no other writer runs.
	 */
	deleteUnder: Statement[];
	insertPart: Statement;
	renameRow: Statement;
	renameParts: Statement;
	exists: Statement;
	/** Update indexed title metadata without touching the content. */
	updateTitle: Statement;
	/**
	 * The session row's content and title columns and every part, in one
	 * statement so they come from one snapshot.
	 */
	readFull: Statement;
	/** Bounded head and tail bytes from the session row and the parts covering each window, and the row's title columns. */
	readSlices: Statement;
	/**
	 * The session's size, its title columns and its bytes from an offset: the
	 * session row's and those of the parts covering the window, the untitled
	 * or the titled one as the row's title time picks.
	 */
	readFrom: Statement;
	/** The blob table, `<table>_blobs`: one row per SHA-256 of a blob a session references and cannot draw again. */
	createBlobsTable: string;
	/** Add a blob row unless its hash has one; answers a row only when it added one (MySQL: `affectedRows`). */
	insertBlob: Statement;
	/** The hash, bytes and size of `count` hashes' rows, bound as `@h0` to `@h<count - 1>`. */
	selectBlobs(count: number): Statement;
	/** The hash and size of `count` hashes' rows, bound as `@h0` to `@h<count - 1>`; reads no content. */
	selectBlobSizes(count: number): Statement;
	/**
	 * PostgreSQL and MySQL: each of `count` hashes' whole rows (not a parted
	 * blob's list of parts) with the hex SHA-256 the server computes of its
	 * bytes; SQLite has no such function, so its rows are read and hashed here.
	 */
	blobDigests: ((count: number) => Statement) | undefined;
	/** Rewrite a row's bytes and size, for a row whose bytes do not hash to its key. */
	repairBlob: Statement;
	/** Delete `count` hashes' rows. */
	deleteBlobs(count: number): Statement;
	/**
	 * Lock `count` hashes' rows in key order: shared for a write that adds a
	 * reference to them, exclusive for a delete that may remove them.
	 */
	lockBlobs(count: number, exclusive: boolean): Statement;
	/** Blob rows created before `@before` that no reference row names, with their sizes. */
	sweepCandidates: Statement;
	/** MySQL and MariaDB: the server's `max_allowed_packet`, which bounds the blob an insert can carry. */
	maxPacket: Statement | undefined;
	/**
	 * The reference table, `<table>_refs`: one row per session path and blob
	 * hash its transcript names, and per parted blob (`blob:sha256:<hash>`)
	 * and each of its parts.
	 */
	createRefsTable: string;
	/** The reference table's index on `sha256` (PostgreSQL and SQLite; MySQL's is in its `CREATE TABLE`). */
	createRefsIndex: string | undefined;
	/** Add the reference of `@path` to `@sha256` unless it is there. */
	insertRef: Statement;
	/** The references of `count` paths (path and hash), bound as `@p0` to `@p<count - 1>`. */
	refsOf(count: number): Statement;
	/** The references (path and hash) of the paths under `@dir` (its first `@len` characters). */
	refsUnder: Statement;
	/** Of `count` hashes, the ones a reference row names (PostgreSQL and SQLite; MySQL's is {@link referencedOne}). */
	referenced(count: number): Statement;
	/**
	 * MySQL: whether a reference row names `@h`, read with a shared lock through the `sha256` index, so it sees
	 * the latest commits, and locks only the first entry of `@h` (or, with none, the gap where it would be).
	 */
	referencedOne: Statement | undefined;
	/** Drop the reference of `@path` to `@sha256`. */
	deleteRef: Statement;
	/** The references (path and hash) of session paths that have no session row (deleted by a build that kept no references). */
	danglingRefs: Statement;
	/** PostgreSQL and SQLite: drop the reference of `@path` to `@sha256` while `@path` has no session row. */
	deleteDanglingRef: Statement;
	/** PostgreSQL and MySQL: lock exclusive, in path order, the session rows of `count` paths, with `under` every row under `@dir` too (MySQL's caller names, without `under`, only rows there are). */
	lockSessionRowsForWrite: ((count: number, under: boolean) => Statement) | undefined;
	/** MySQL: the paths of `count` paths that have a session row, read without a lock. */
	sessionRowsOf: ((count: number) => Statement) | undefined;
	/** MySQL and SQLite: the columns of a table's primary key, in key order (PostgreSQL: {@link PG_PRIMARY_KEY}). */
	primaryKey: Statement | undefined;
	/** MySQL: statements that change no row and need, each, one privilege the store's writes need on the blob and reference tables. */
	privilegeProbes: Array<{ table: string; privilege: string; probe: Statement }>;
	/** The lease table's statements: PostgreSQL and MySQL only; a SQLite claim is an OS lock. */
	lease: LeaseQueries | undefined;
}

/**
 * How a MySQL-family server bounds a lease row's lock wait without session
 * state, as the store finds at start-up: MySQL 8.0 or later (`NOWAIT`
 * locking reads, `FOR SHARE`), or MariaDB 10.3 or later (`NOWAIT` locking
 * reads, `LOCK IN SHARE MODE`, and `SET STATEMENT` for an insert). A store
 * that claims sessions refuses to start on any other (see `mysqlLockForm`).
 */
type MysqlLockForm = "mysql" | "mariadb";

/**
 * The lock form `version` (`SELECT VERSION()`) supports, or `undefined` for
 * MySQL before 8.0 and MariaDB before 10.3, which bound no lock wait except
 * through session state.
 */
function mysqlLockForm(version: string): MysqlLockForm | undefined {
	const [major = 0, minor = 0] = (/^(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
	if (/mariadb/i.test(version)) return major > 10 || (major === 10 && minor >= 3) ? "mariadb" : undefined;
	return major >= 8 ? "mysql" : undefined;
}

/**
 * Statements on the lease table: one row per claimed session (`session_id`,
 * `holder`, `host`, `pid`, `acquired_at`, `heartbeat_at`), every time in
 * milliseconds since the epoch on the database clock, read in the statement
 * that writes or compares it.
 */
interface LeaseQueries {
	createTable: string;
	/**
	 * PostgreSQL's index on `holder`, made only when the lease table has none
	 * (see {@link PG_HOLDER_INDEXES}); MySQL declares it in `createTable`.
	 */
	createIndex: string | undefined;
	/**
	 * PostgreSQL's claim, one statement: insert the lease, or take it over when
	 * its heartbeat expired or `@holder` already holds it. Returns a row when
	 * the claim succeeded.
	 */
	claim: Statement;
	/**
	 * MySQL's claim, one transaction: lock the lease row (`nowait`'s `lock`:
	 * `holder`, and `stale` 1 when its heartbeat expired), then insert or take
	 * it over. `take` sets `acquired_at` first, because MySQL assigns left to
	 * right.
	 */
	insert: Statement;
	take: Statement;
	/**
	 * Refresh `@holder`'s leases of the `count` sessions `@sid0` … this store
	 * still holds a live claim on, and no other row of its: a row whose
	 * release gave up is left to expire. Returns their `session_id` (MySQL
	 * reads them back with `heldBy`).
	 */
	heartbeat(count: number): Statement;
	heldBy(count: number): Statement;
	release: Statement;
	/**
	 * PostgreSQL's session lock beside the lease row, keyed by the lease
	 * table and `@sid` (two tables are two claim domains, so the same session
	 * id in each takes a different lock): taken exclusively by a claim before
	 * its statement, shared by a write's fence of a session this store holds
	 * no claim on. A missing row cannot be locked, so without it a claim's
	 * insert would not wait for such a write in flight (MySQL's share lock of
	 * the missing row takes its gap instead, per table already). The key is a
	 * 32-bit hash: a collision only makes two leases take turns.
	 */
	claimLock: Statement | undefined;
	fenceLock: Statement | undefined;
	/**
	 * PostgreSQL's database fence: `@holder`'s lease row of `@sid`,
	 * share-locked for the rest of the write's transaction, so a takeover's
	 * update waits for the write to commit and then sees it. MySQL's is
	 * `nowait`'s `held`.
	 */
	held: Statement;
	/**
	 * PostgreSQL's fence for a write to a path this store holds no claim on:
	 * another holder's fresh lease row of `@sid`, read after the session's
	 * shared advisory lock (`fenceLock`). MySQL's is `nowait`'s `foreign`.
	 */
	foreign: Statement;
	/**
	 * MySQL's and MariaDB's lease locks, by the form the store found at
	 * start-up: the claim's `lock` of the row, the fences' `held` and
	 * `foreign` (share-locked: a plain read would fix the transaction's
	 * snapshot before the session row lock), and a lock of this store's row
	 * before the release deletes it. Each refuses at once (`NOWAIT`: errno
	 * 3572 on MySQL 8, 1205 on MariaDB) instead of waiting for another
	 * transaction's lock, and the store throws that transaction away and runs
	 * it again within its bound (see {@link retryLockRefusals}): the one
	 * transaction-scoped bound MySQL has
	 * on a row lock wait. Unset on PostgreSQL.
	 */
	nowait:
		| Record<MysqlLockForm, { lock: Statement; held: Statement; foreign: Statement; releaseLock: Statement }>
		| undefined;
	/**
	 * MariaDB's `insert`, whose lock wait ends after `seconds` (rounded up to
	 * a whole second) for that statement alone (`SET STATEMENT
	 * innodb_lock_wait_timeout = … FOR`); MySQL has no statement-scoped bound
	 * for an `INSERT`. Unset on PostgreSQL.
	 */
	insertWithin: ((seconds: number) => Statement) | undefined;
	/** The holder of `@sid`'s lease and whether its heartbeat expired. */
	probe: Statement;
}

/** `lease.lock` row. */
interface LeaseLockRow {
	holder: string;
	stale: number | bigint | string;
}

/** `lease.probe` row. */
interface LeaseProbeRow {
	host: string;
	pid: number | bigint | string;
	stale: number | bigint | string;
}

interface IndexRow {
	path: string;
	byte_len: number | bigint | string | null;
	mtime_ms: number | bigint | string;
}

/**
 * The title metadata columns of the session row a read takes them from, in
 * the statement that reads its bytes; null on a part's row.
 */
interface TitleColumns {
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

/** `readFull` row: kind 0 is the session row's own content, with its title, kind 1 a part. */
interface ContentRow extends TitleColumns {
	kind: number | string;
	start_offset: number | bigint | string;
	content: string;
}

/** `readSlices` row: kind 0 is the session row, with its title, kind 1 a part in the head window, kind 2 a part in the tail window. */
interface SliceRow extends TitleColumns {
	kind: number | string;
	start_offset: number | bigint | string;
	head: Uint8Array | null;
	tail: Uint8Array | null;
}

/** `readFrom` row: kind 0 is the session row (with its size and title), kind 1 a part covering the window. */
interface ReadFromRow extends TitleColumns {
	kind: number | string;
	start_offset: number | bigint | string;
	byte_len: number | bigint | string | null;
	bytes: Uint8Array | null;
}

/** `selectBlobs` row. */
interface BlobRow {
	sha256: string;
	content: Uint8Array;
	byte_len: number | bigint | string;
}

/** `blobDigests` row. */
interface BlobDigestRow {
	sha256: string;
	digest: string | Uint8Array;
}

/** A row with only a hash column. */
interface HashRow {
	sha256: string;
}

/** A row with only a path column. */
interface PathRow {
	path: string;
}

/** A reference row. */
interface RefRow {
	path: string;
	sha256: string;
}

/** `selectBlobSizes` row. */
interface BlobSizeRow {
	sha256: string;
	byte_len: number | bigint | string;
}

const DEFAULT_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,56}$/;
const DEFAULT_LEASE_TABLE = "omp_session_leases";
const LEASE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,55}$/;
/**
 * How long the database may take to delete a released lease row: PostgreSQL's
 * `statement_timeout` for that delete, and on MySQL and MariaDB how long the
 * release retries its `NOWAIT` lock of the row before it deletes it. A delete that
 * takes longer is rolled back, and the row expires on its own.
 */
const LEASE_RELEASE_BOUND_MS = 2000;
/** How much longer than {@link LEASE_RELEASE_BOUND_MS} a release waits for a database that does not answer at all. */
const LEASE_RELEASE_GRACE_MS = 250;
/**
 * How long a claim statement waits for another transaction's lock of the
 * lease row (the holder's write in flight, share-locked by its fence) when
 * its caller set no wait: PostgreSQL's `lock_timeout` for the claim's
 * transaction; on MySQL and MariaDB how long the claim retries its `NOWAIT`
 * lock of the row, and on MariaDB its insert's `SET STATEMENT
 * innodb_lock_wait_timeout`, in whole seconds. MySQL bounds no `INSERT`: a
 * claim's insert of a new row behind a write in flight from a store that
 * holds no claim (its fence's share lock on the row's gap) waits for the
 * server's `innodb_lock_wait_timeout`. An acquire with `waitMs` waits at
 * most what is left of that wait instead, so a write stalled for minutes
 * cannot stretch an open's 35 s. A claim that waited this long is refused,
 * the session held by the other process; a takeover still waits for a write
 * in flight that commits within it, and sees that write.
 */
const LEASE_CLAIM_LOCK_BOUND_MS = 5000;
/**
 * How long a write's fence waits for another transaction's lock of the
 * lease row (a takeover's update in flight): a fence that waited this long
 * refuses the write, the session held by the other process.
 */
const LEASE_FENCE_LOCK_BOUND_MS = 2000;
/**
 * The PostgreSQL heartbeat's local lock wait and idle-in-transaction bounds.
 * Both leave 1.5 s before a fenced write marks its claim lost, so the server
 * ends a heartbeat that cannot commit before its locks can consume that fence.
 */
const LEASE_HEARTBEAT_TRANSACTION_BOUND_MS = 500;
/** How often a whole transaction whose MySQL or MariaDB `NOWAIT` lock read was refused runs again within its bound. */
const NOWAIT_RETRY_MS = 50;
/** The first key of PostgreSQL's two-key advisory locks the claim and the fence of a session take (`'omp'`). */
const PG_SESSION_LOCK_CLASS = 0x6f6d70;

/**
 * Another transaction held the lock a statement waited for past its bound:
 * PostgreSQL `lock_not_available` (SQLSTATE 55P03), MySQL and MariaDB
 * `ER_LOCK_WAIT_TIMEOUT` (errno 1205, also MariaDB's `NOWAIT` refusal), and
 * MySQL's `ER_LOCK_NOWAIT` (errno 3572).
 */
function isLockTimeoutError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const errno = "errno" in error ? error.errno : undefined;
	return errno === "55P03" || errno === 1205 || errno === 3572;
}

/**
 * Run `attempt`, one whole transaction that takes a lease lock with a MySQL
 * or MariaDB `NOWAIT` read, again from its start while a lock wait is
 * refused, until `boundMs` passed; the last refusal is thrown then. A
 * refusal is never retried inside its transaction: on MariaDB with
 * `innodb_rollback_on_timeout` ON a refused `NOWAIT` read (error 1205) rolls
 * the whole transaction back, so a statement sent after it would run on its
 * own, holding no lock (measured on MariaDB 11.4: `probes/rot-forms.ts`).
 * MySQL 8's refusal (error 3572) rolls back only the statement, with the
 * setting ON or OFF, but its waited 1205 rolls back the whole transaction
 * with it ON; the attempt is thrown away in every case. The client rolls the
 * attempt's transaction back, a no-op once the server did. `attempt` gets
 * the bound's deadline, for a statement that waits within it.
 */
async function retryLockRefusals<T>(boundMs: number, attempt: (deadline: number) => Promise<T>): Promise<T> {
	const deadline = performance.now() + boundMs;
	for (;;) {
		try {
			return await attempt(deadline);
		} catch (err) {
			if (!isLockTimeoutError(err) || performance.now() >= deadline) throw err;
			await Bun.sleep(NOWAIT_RETRY_MS);
		}
	}
}

/**
 * A write's fence met another transaction's lock of a lease row within the
 * fence's bound: the write's transaction is thrown away and runs again from
 * its start (see {@link retryLockRefusals}). Never leaves the store.
 */
class FenceLockRefused extends Error {
	constructor(readonly refusal: unknown) {
		super("SqlSessionStorage: a fence's lock read was refused within its bound", { cause: refusal });
	}
}

/**
 * `work`'s outcome, or `"timeout"` once `ms` passed without one: the caller
 * stops waiting and `work` runs on. The timer never keeps the process alive.
 */
function withinBound(work: Promise<void>, ms: number): Promise<"done" | "timeout"> {
	const { promise, resolve, reject } = Promise.withResolvers<"done" | "timeout">();
	const timer = setTimeout(() => resolve("timeout"), ms);
	timer.unref();
	work.then(
		() => {
			clearTimeout(timer);
			resolve("done");
		},
		(err: unknown) => {
			clearTimeout(timer);
			reject(err);
		},
	);
	return promise;
}
/** Bytes of a session's head a claim reads to check that the path still holds that session. */
const SESSION_HEADER_PREFIX_BYTES = 64 * 1024;
/** How often a claim waiting for another holder's lease reads that lease again. */
const LEASE_WAIT_POLL_MS = 1000;
/** How often a write waiting for its claim's heartbeat to be confirmed again looks. */
const LAPSE_POLL_MS = 50;
/** Largest part a full write stores; an append stores its line as one part. */
const PART_BYTES = 1024 * 1024;
/** Hashes one blob size read asks for. */
const BLOB_READ_BATCH = 100;
/** Bytes one blob read asks for (a larger blob is read alone), so a read holds at most about this much at a time. */
const BLOB_READ_BYTES = 16 * 1024 * 1024;
/**
 * Tries of one blob write before the transcript write waiting for it fails; the blob stays queued for the next.
 * An error whose repairs are spent ends them at once (see {@link SqlSessionStorageBackend.repairsSpent}).
 */
const BLOB_WRITE_ATTEMPTS = 3;
/** Wait before the second try of a blob write, doubled before each later one. */
const BLOB_RETRY_MS = 250;
/** Largest blob the table takes on PostgreSQL and SQLite (both bound one value near 1 GB). */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
/** Room in a MySQL packet for the insert's statement and its other values, beside the blob. */
const MYSQL_PACKET_HEADROOM = 1024 * 1024;
/**
 * The path prefix of a parted blob's references: a blob larger than one row
 * takes is stored as parts, each a blob row under its own hash, and the row
 * of its own hash lists them; `<prefix><hash>` references each part, so no
 * sweep takes a part of a kept blob.
 */
const BLOB_PARTS_PATH = "blob:sha256:";
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
 * each store write (see `#postgres`). `setting` is the session's own value;
 * the opening's `READ WRITE` does not change it. `reset_val` is the
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
/** Why `init()` refuses a PostgreSQL client that has no `reserve()` (see {@link SqlSessionStorageReservedConnection}). */
const PG_NO_RESERVE =
	"SqlSessionStorage: a PostgreSQL client must provide reserve(), which Bun.SQL does: " +
	"the store runs each transaction on one reserved connection";
/** The warning of each PostgreSQL connection the store closes because no transaction can repair it (see `#postgres`). */
const PG_REPAIR_WARNING = "SqlSessionStorage closed a PostgreSQL connection it cannot repair";
/** The operation a PostgreSQL transaction of the store runs for, as {@link PG_REPAIR_WARNING} names it. */
type PgOperation =
	| "open"
	| "loadIndex"
	| "readFull"
	| "readSlices"
	| "readFrom"
	| "writeFull"
	| "append"
	| "updateSessionTitle"
	| "remove"
	| "move"
	| "claim"
	| "heartbeat"
	| "release"
	| "claimHolder"
	| "blob.insert"
	| "blob.sizes"
	| "blob.read"
	| "blob.wrong"
	| "blob.repair"
	| "blob.reference"
	| "blob.sweep";
/** The SQLSTATE of a PostgreSQL server error (Bun's `errno`), or `undefined` for any other error. */
function pgSqlstate(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const errno = "errno" in error ? error.errno : undefined;
	return typeof errno === "string" ? errno : undefined;
}
/** Bun's own code of an error (`ERR_POSTGRES_…`), or `undefined`. */
function pgErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = "code" in error ? error.code : undefined;
	return typeof code === "string" ? code : undefined;
}
const utf8Decoder = new TextDecoder("utf-8");
/** The title metadata columns every content read selects with the bytes. */
const TITLE_COLUMNS = "title, title_source, title_updated_at";
/**
 * Most bytes one `readFrom` piece asks for: PostgreSQL's substr takes integer
 * lengths, and no stored value reaches it (a value is at most 1 GB there).
 */
const MAX_PIECE_BYTES = 0x7fff_ffff;

/** What `readFrom` binds for one window: see {@link readFromBounds}. */
interface ReadFromBounds {
	offset: number;
	end: number;
	take: number;
	row_from: number;
}

/**
 * The bounds `readFrom` binds for a window from byte `offset` of at most
 * `maxBytes` bytes (to the end without them), both whole numbers, the
 * offset signed: `take`, the bytes each piece reads and the window holds;
 * `end`, at or past which no part is read; and `row_from`, the session row's
 * 1-based position of `offset`, clamped where the row cannot reach.
 */
function readFromBounds(offset: number, maxBytes: number | undefined): ReadFromBounds {
	const take = Math.min(maxBytes ?? MAX_PIECE_BYTES, MAX_PIECE_BYTES);
	return {
		offset,
		end: maxBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.min(offset + take, Number.MAX_SAFE_INTEGER),
		take,
		row_from: Math.min(offset, MAX_PIECE_BYTES - 1) + 1,
	};
}

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
 * process for the whole busy timeout, then fails. So calls queue per database
 * file, by its identity ({@link sqliteFileIdentity} of `options.filename`,
 * which `Bun.SQL` sets), so two spellings of one file share a queue, and the
 * busy wait only ever waits on other processes. In-memory databases, and
 * wrappers that hide `options.filename`, queue per client object.
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
	const key = sqliteFileIdentity(path.resolve(filename), true);
	let queue = sqliteFileQueues.get(key);
	if (!queue) {
		queue = { tail: Promise.resolve() };
		sqliteFileQueues.set(key, queue);
	}
	return queue;
}

/**
 * A SQLite database file's identity, which its call queue and its claims' OS
 * locks are keyed by: its device and inode, so every spelling of one file (a
 * symlink, a hard link, another mount of it) gives one key, where a resolved
 * path, or a real path, would still give a hard link or a second mount a key
 * of its own. With `create`, a file that does not exist yet is made first,
 * empty, which SQLite reads as an empty database: an `open` with `O_CREAT`
 * that takes no SQLite lock and needs no call through the queue the key is
 * for, so stores that open the file before any of them wrote it meet one key
 * at once, and no queue is ever re-keyed. Its resolved path when the file
 * cannot be read or made.
 */
function sqliteFileIdentity(file: string, create: boolean): string {
	try {
		let stat: fs.BigIntStats;
		try {
			stat = fs.statSync(file, { bigint: true });
		} catch (err) {
			if (!create || !(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
			fs.closeSync(fs.openSync(file, "a"));
			stat = fs.statSync(file, { bigint: true });
		}
		return `sqlite-inode:${stat.dev}:${stat.ino}`;
	} catch {
		return `sqlite:${file}`;
	}
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

/**
 * Which of the opening's conditional parameters ({@link PG_CONDITIONAL_PARAMETERS})
 * this server has: the probe, the store's first PostgreSQL statement, read in
 * a transaction whose opening holds none of the statements that need them.
 */
const PG_PRESENT_PARAMETERS = statement(
	"postgres",
	`SELECT name FROM pg_catalog.pg_settings WHERE name IN (${inList("p", PG_CONDITIONAL_PARAMETERS.length)})`,
);
/** The read and the write opening on a server that has the conditional parameters `present` (see {@link pgOpening}). */
function pgOpenings(present: ReadonlySet<string>): { readonly read: string; readonly write: string } {
	return { read: pgOpening("read", present), write: pgOpening("write", present) };
}
/** The openings until the probe has read which conditional parameters the server has: with none of their statements. */
const PG_PROBE_OPENINGS = pgOpenings(new Set());
/**
 * The schema of the store's PostgreSQL tables, which every statement names
 * them with. The opening sets `search_path` to `pg_catalog, pg_temp` (see
 * `sql-session-postgres-settings.ts`): every function, operator and type the
 * statements name is then found in `pg_catalog` alone (`pg_temp` is never
 * searched for functions or operators, and comes after `pg_catalog` for
 * relations), so one that a login with `CREATE` on the store's schema
 * planted there, an exact match where `pg_catalog` has only one through an
 * implicit cast, is never picked.
 */
const PG_SCHEMA = "public";
/**
 * The lease table's indexes keyed by `holder` alone, whatever their names: the
 * heartbeat's `WHERE holder = …` uses one. Found through `pg_index`, never by
 * name, since another table's index, or a table, may hold the name.
 */
const PG_HOLDER_INDEXES = statement(
	"postgres",
	"SELECT i.indexrelid::text AS oid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a " +
		"ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = pg_catalog.to_regclass(@table) " +
		"AND i.indnkeyatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL AND a.attname = 'holder'",
);
/** What holds the lease index's name in the store's schema, if anything, and the table it indexes when an index. */
const PG_HOLDER_INDEX_NAME = statement(
	"postgres",
	"SELECT c.oid::text AS oid, c.relkind::text AS kind, c.oid::pg_catalog.regclass::text AS name, " +
		"i.indrelid::pg_catalog.regclass::text AS on_table FROM pg_catalog.pg_class c " +
		"LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid WHERE c.oid = pg_catalog.to_regclass(@index)",
);
/**
 * The reference table's indexes led by `sha256`, whatever their names: a
 * delete's look for the references of the blobs it would take, and the
 * sweep's, read by `sha256` alone (the primary key leads with `path`).
 * Found through `pg_index`, as {@link PG_HOLDER_INDEXES} are.
 */
const PG_RHASH_INDEXES = statement(
	"postgres",
	"SELECT i.indexrelid::text AS oid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a " +
		"ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = pg_catalog.to_regclass(@table) " +
		"AND i.indexprs IS NULL AND i.indpred IS NULL AND a.attname = 'sha256'",
);
/**
 * Whether each of the store's PostgreSQL tables exists, by name, as
 * `CREATE TABLE IF NOT EXISTS` finds it (any relation of that name counts;
 * the table check refuses one that is not an ordinary table),
 * `default_transaction_read_only`'s `setting` and `reset_val`, as
 * {@link READ_ONLY_SETTINGS} reads them inside a write, and whether the
 * server is in recovery (a hot standby or a read replica), which accepts no
 * write at all.
 */
const PG_TABLES_PRESENT = statement(
	"postgres",
	"SELECT pg_catalog.to_regclass(@session) IS NOT NULL AS session, " +
		"pg_catalog.to_regclass(@parts) IS NOT NULL AS parts, pg_catalog.to_regclass(@lease) IS NOT NULL AS lease, " +
		"pg_catalog.to_regclass(@blobs) IS NOT NULL AS blobs, pg_catalog.to_regclass(@refs) IS NOT NULL AS refs, " +
		"s.setting AS read_only_setting, s.reset_val AS read_only_reset_val, " +
		"pg_catalog.pg_is_in_recovery() AS in_recovery " +
		"FROM pg_catalog.pg_settings s WHERE s.name = 'default_transaction_read_only'",
);

/** {@link PG_TABLES_PRESENT} row. */
interface TablesPresentRow {
	session: boolean;
	parts: boolean;
	lease: boolean;
	blobs: boolean;
	refs: boolean;
	read_only_setting: string;
	read_only_reset_val: string;
	in_recovery: boolean;
}

/** A relation's kind (`pg_class.relkind`), with its article, as a refusal names it. */
const PG_RELATION_KINDS: Record<string, string> = {
	r: "a table",
	i: "an index",
	S: "a sequence",
	t: "a TOAST table",
	v: "a view",
	m: "a materialized view",
	c: "a composite type",
	f: "a foreign table",
	p: "a partitioned table",
	I: "a partitioned index",
};

/** {@link PG_HOLDER_INDEX_NAME} row. */
interface HolderIndexNameRow {
	oid: string;
	kind: string;
	name: string;
	on_table: string | null;
}

/**
 * The columns of one of the store's PostgreSQL tables, as {@link SqlSessionStorageBackend}'s table check reads
 * them: each column's type by its OID and modifier, beside the OID this server gives each declared type (see
 * {@link PG_DECLARED_COLUMNS}), so the check compares numbers and answers the same whatever
 * `quote_all_identifiers` is. `type`, the type's name, is for a refusal's text only.
 */
const PG_TABLE_COLUMNS = statement(
	"postgres",
	"SELECT a.attname AS name, a.atttypid::text AS type_oid, a.atttypmod AS type_mod, " +
		"pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, " +
		"a.atthasdef AS has_default, a.attgenerated::text AS generated, a.attidentity::text AS identity, " +
		"'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid::text AS text_oid, " +
		"'pg_catalog.int8'::pg_catalog.regtype::pg_catalog.oid::text AS bigint_oid, " +
		"'pg_catalog.bytea'::pg_catalog.regtype::pg_catalog.oid::text AS bytea_oid " +
		"FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass(@table) AND a.attnum > 0 " +
		"AND NOT a.attisdropped",
);
/**
 * Everything on one of the store's PostgreSQL tables, or above it, that runs
 * code on its writes and is not the store's: a trigger, a rule, a row-level
 * security policy or the security itself, a relation that is not an ordinary
 * table, a constraint other than a primary key, unique or not-null one, an
 * index on an expression or with a predicate, a table that inherits from it
 * (the store's updates and deletes reach a child's rows, and so its
 * triggers), a table it is a partition or an inheritance child of: each
 * insert into a partition checks the partition constraint, which evaluates
 * the parent's partition key, a function of the parent's owner's choosing,
 * as the writer. A partition that `pg_inherits` does not name (`relispartition`
 * alone) is refused too, so the check fails closed. And a foreign key of
 * another table that references it: the store's updates and deletes fire that
 * key's referential action on the other table, and so the other table's
 * triggers.
 */
const PG_TABLE_OBJECTS = statement(
	"postgres",
	"SELECT 'trigger' AS kind, t.tgname::text AS name FROM pg_catalog.pg_trigger t " +
		"WHERE t.tgrelid = pg_catalog.to_regclass(@table) AND NOT t.tgisinternal " +
		"UNION ALL SELECT 'rule', r.rulename::text FROM pg_catalog.pg_rewrite r " +
		"WHERE r.ev_class = pg_catalog.to_regclass(@table) " +
		"UNION ALL SELECT 'policy', p.polname::text FROM pg_catalog.pg_policy p " +
		"WHERE p.polrelid = pg_catalog.to_regclass(@table) " +
		"UNION ALL SELECT 'row-level security', c.relname::text FROM pg_catalog.pg_class c " +
		"WHERE c.oid = pg_catalog.to_regclass(@table) AND (c.relrowsecurity OR c.relforcerowsecurity) " +
		"UNION ALL SELECT 'relation kind', c.relkind::text FROM pg_catalog.pg_class c " +
		"WHERE c.oid = pg_catalog.to_regclass(@table) AND c.relkind <> 'r' " +
		"UNION ALL SELECT 'constraint', k.conname::text FROM pg_catalog.pg_constraint k " +
		"WHERE k.conrelid = pg_catalog.to_regclass(@table) AND k.contype NOT IN ('p', 'u', 'n') " +
		"UNION ALL SELECT 'index', i.indexrelid::pg_catalog.regclass::text FROM pg_catalog.pg_index i " +
		"WHERE i.indrelid = pg_catalog.to_regclass(@table) AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL) " +
		"UNION ALL SELECT 'inheritance', h.inhrelid::pg_catalog.regclass::text FROM pg_catalog.pg_inherits h " +
		"WHERE h.inhparent = pg_catalog.to_regclass(@table) " +
		"UNION ALL SELECT CASE WHEN c.relispartition THEN 'partition of' ELSE 'inherits from' END, " +
		"h.inhparent::pg_catalog.regclass::text FROM pg_catalog.pg_inherits h " +
		"JOIN pg_catalog.pg_class c ON c.oid = h.inhrelid WHERE h.inhrelid = pg_catalog.to_regclass(@table) " +
		"UNION ALL SELECT 'partition of', 'a parent pg_inherits does not name' FROM pg_catalog.pg_class c " +
		"WHERE c.oid = pg_catalog.to_regclass(@table) AND c.relispartition " +
		"AND NOT EXISTS (SELECT FROM pg_catalog.pg_inherits h WHERE h.inhrelid = c.oid) " +
		"UNION ALL SELECT 'referenced by', k.conrelid::pg_catalog.regclass::text || ' (' || k.conname::text || ')' " +
		"FROM pg_catalog.pg_constraint k WHERE k.confrelid = pg_catalog.to_regclass(@table) AND k.contype = 'f' " +
		"AND k.conrelid <> k.confrelid",
);
/**
 * The columns of a table's primary key. The blob table's insert names its
 * `sha256` key in `ON CONFLICT`, which refuses a table without that key.
 */
const PG_PRIMARY_KEY = statement(
	"postgres",
	"SELECT a.attname::text AS name FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a " +
		"ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) " +
		"WHERE i.indrelid = pg_catalog.to_regclass(@table) AND i.indisprimary",
);
/** Whether the store's login holds `@privilege` on a table, through a grant to it, to PUBLIC or to a role it is a member of. */
const PG_HAS_PRIVILEGE = statement(
	"postgres",
	"SELECT pg_catalog.has_table_privilege(pg_catalog.to_regclass(@table), @privilege) AS can",
);
/**
 * What the blob writes, reference writes and session deletes need of the
 * blob and reference tables (by suffix): the key their `ON CONFLICT` names,
 * and the privileges they use.
 */
const BLOB_TABLE_NEEDS = {
	blobs: { key: ["sha256"], privileges: ["INSERT", "UPDATE", "DELETE"] },
	refs: { key: ["path", "sha256"], privileges: ["INSERT", "DELETE", "UPDATE"] },
} as const;

/** What is wrong with a table's primary key `found`, compared as a set with `wanted`; undefined when nothing. */
function primaryKeyProblem(found: readonly string[], wanted: readonly string[]): string | undefined {
	if ([...found].sort().join(", ") === [...wanted].sort().join(", ")) return undefined;
	return found.length === 0 ? "no primary key" : `primary key (${found.join(", ")}), not (${wanted.join(", ")})`;
}
/** A type the store declares a PostgreSQL column with. */
type PgDeclaredType = "text" | "bigint" | "bytea";
/**
 * The columns of the store's PostgreSQL tables and their declared types: a column must have the OID of its
 * type, as {@link PG_TABLE_COLUMNS} reads it, and no type modifier.
 */
const PG_DECLARED_COLUMNS = {
	session: {
		path: "text",
		content: "text",
		mtime_ms: "bigint",
		title: "text",
		title_source: "text",
		title_updated_at: "text",
		byte_len: "bigint",
	},
	parts: { path: "text", start_offset: "bigint", content: "text" },
	blobs: { sha256: "text", content: "bytea", byte_len: "bigint", mime_type: "text", created_ms: "bigint" },
	refs: { path: "text", sha256: "text" },
	lease: {
		session_id: "text",
		holder: "text",
		host: "text",
		pid: "bigint",
		acquired_at: "bigint",
		heartbeat_at: "bigint",
	},
} satisfies Record<string, Record<string, PgDeclaredType>>;

/** {@link PG_TABLE_COLUMNS} row. */
interface TableColumnRow {
	name: string;
	type_oid: string;
	type_mod: number | string;
	type: string;
	has_default: boolean;
	generated: string;
	identity: string;
	text_oid: string;
	bigint_oid: string;
	bytea_oid: string;
}

/** {@link PG_TABLE_OBJECTS} row. */
interface TableObjectRow {
	kind: string;
	name: string;
}

/** `schema` as a PostgreSQL identifier, quoted. */
function quoteIdentifier(schema: string): string {
	return `"${schema.replaceAll('"', '""')}"`;
}

function buildQueries(
	adapter: SqlSessionStorageAdapter,
	name: string,
	leaseName: string,
	leaseExpiryMs: number,
	schema?: string,
): DialectQueries {
	// PostgreSQL statements name every table with its schema: the opening sets search_path to pg_catalog, pg_temp.
	const relation = (relationName: string): string =>
		schema === undefined ? relationName : `${quoteIdentifier(schema)}.${relationName}`;
	const table = relation(name);
	const parts = relation(`${name}_parts`);
	const blobs = relation(`${name}_blobs`);
	const refs = relation(`${name}_refs`);
	const sql = (template: string): Statement => statement(adapter, template);
	const blobByteLength = adapter === "postgres" ? "octet_length(content)" : "length(content)";
	const mysql = adapter === "mysql";
	const integer = adapter === "sqlite" ? "INTEGER" : "BIGINT";
	const mysqlTable = ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";
	const contentBytes = {
		postgres: "convert_to(content, 'UTF8')",
		mysql: "cast(content AS binary)",
		sqlite: "cast(content AS blob)",
	}[adapter];
	const contentByteLength = {
		postgres: "octet_length(content)",
		mysql: "length(content)",
		sqlite: "length(cast(content AS blob))",
	}[adapter];
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
	// `readFrom` binds two windows: `@offset`, `@end`, `@take` and `@row_from` for a session without a title time,
	// from the caller's offset, and `@titled_*` for a titled one, the window its title slot needs. The session row's
	// title time picks one, in the statement that reads the bytes, by its byte length: a title time is one when it
	// holds a byte, as `rowTitle` takes it. (MySQL and MariaDB compare `' '` equal to `''` under the table's
	// collation, so a comparison with `''` would take a space for no title time.)
	const titleTimeBytes = {
		postgres: "octet_length(title_updated_at)",
		mysql: "length(title_updated_at)",
		sqlite: "length(cast(title_updated_at AS blob))",
	}[adapter];
	const untitledSession = `coalesce((SELECT ${titleTimeBytes} FROM ${table} WHERE path = @path), 0) = 0`;
	const windowBound = (name: string, cast: (expr: string) => string): string =>
		`CASE WHEN ${untitledSession} THEN ${cast(`@${name}`)} ELSE ${cast(`@titled_${name}`)} END`;

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
		loadIndex: `SELECT path, mtime_ms, byte_len FROM ${table}`,
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
			],
			mysql: [
				sql(
					`DELETE r, p FROM ${table} AS r LEFT JOIN ${parts} AS p ON p.path = r.path ` +
						`WHERE substr(r.path, 1, @len) = @dir`,
				),
			],
			sqlite: [
				sql(`DELETE FROM ${parts} WHERE substr(path, 1, @len) = @dir`),
				sql(`DELETE FROM ${table} WHERE substr(path, 1, @len) = @dir`),
			],
		}[adapter],
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
		// The title columns are the session row's; a part's row has none.
		readFull: sql(
			`SELECT 0 AS kind, 0 AS start_offset, content, ${TITLE_COLUMNS} FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, content, NULL, NULL, NULL FROM ${parts} WHERE path = @path`,
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
				`ELSE ${emptyBytes} END AS tail, ${TITLE_COLUMNS} FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, substr(${contentBytes}, 1, ${position("@prefix - start_offset")}), NULL, ` +
				`NULL, NULL, NULL FROM ${parts} WHERE path = @path AND start_offset < @prefix ` +
				`UNION ALL SELECT 2, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${tailStart} - start_offset) + 1`)}), NULL, NULL, NULL ` +
				`FROM ${parts} WHERE @suffix > 0 AND path = @path AND start_offset >= (` +
				`SELECT coalesce(max(start_offset), -1) FROM ${parts} WHERE path = @path AND start_offset <= ${tailStart})`,
		),
		// The session row holds bytes [0, length(content)), its parts the rest. The
		// parts read are those that end after the window's offset and start before
		// its end, from the last one starting at or before the offset (every part
		// when none does, i.e. the window starts in the row's own content). Each
		// piece is at most the window's take from where the window enters it; its
		// row position is the 1-based `offset + 1`, clamped where the row cannot
		// reach. Each is the untitled or the titled window's, as the session row's
		// title time picks.
		readFrom: sql(
			`SELECT 0 AS kind, 0 AS start_offset, byte_len, CASE WHEN coalesce(${titleTimeBytes}, 0) = 0 ` +
				`THEN CASE WHEN ${bigint("@offset")} < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position("@row_from")}, ${position("@take")}) ELSE ${emptyBytes} END ` +
				`ELSE CASE WHEN ${bigint("@titled_offset")} < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position("@titled_row_from")}, ${position("@titled_take")}) ` +
				`ELSE ${emptyBytes} END END AS bytes, ${TITLE_COLUMNS} FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${windowBound("offset", bigint)} - start_offset) + 1`)}, ` +
				`${windowBound("take", position)}), NULL, NULL, NULL ` +
				`FROM ${parts} WHERE path = @path AND start_offset < ${windowBound("end", bigint)} ` +
				`AND start_offset + ${contentByteLength} > ${windowBound("offset", bigint)} AND start_offset >= (` +
				`SELECT coalesce(max(start_offset), -1) FROM ${parts} WHERE path = @path ` +
				`AND start_offset <= ${windowBound("offset", bigint)})`,
		),
		createBlobsTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${blobs} (` +
				`sha256 CHAR(64) NOT NULL PRIMARY KEY, ` +
				`content LONGBLOB NOT NULL, ` +
				`byte_len BIGINT NOT NULL, ` +
				`mime_type VARCHAR(127) NULL, ` +
				`created_ms BIGINT NOT NULL` +
				mysqlTable
			: `CREATE TABLE IF NOT EXISTS ${blobs} (` +
				`sha256 TEXT PRIMARY KEY, ` +
				`content ${adapter === "sqlite" ? "BLOB" : "BYTEA"} NOT NULL, ` +
				`byte_len ${integer} NOT NULL, ` +
				`mime_type TEXT, ` +
				`created_ms ${integer} NOT NULL` +
				`)`,
		insertBlob: sql(
			`INSERT INTO ${blobs} (sha256, content, byte_len, mime_type, created_ms) ` +
				`VALUES (@sha256, @content, @len, @mime, @created) ` +
				(mysql ? "ON DUPLICATE KEY UPDATE sha256 = sha256" : "ON CONFLICT (sha256) DO NOTHING RETURNING sha256"),
		),
		selectBlobs: count =>
			sql(`SELECT sha256, content, byte_len FROM ${blobs} WHERE sha256 IN (${inList("h", count)})`),
		selectBlobSizes: count => sql(`SELECT sha256, byte_len FROM ${blobs} WHERE sha256 IN (${inList("h", count)})`),
		blobDigests:
			adapter === "sqlite"
				? undefined
				: count =>
						sql(
							`SELECT sha256, ${mysql ? "SHA2(content, 256)" : "encode(sha256(content), 'hex')"} AS digest ` +
								`FROM ${blobs} WHERE sha256 IN (${inList("h", count)}) AND byte_len = ${blobByteLength}`,
						),
		repairBlob: sql(`UPDATE ${blobs} SET content = @content, byte_len = @len WHERE sha256 = @sha256`),
		deleteBlobs: count => sql(`DELETE FROM ${blobs} WHERE sha256 IN (${inList("h", count)})`),
		lockBlobs: (count, exclusive) =>
			sql(
				`SELECT sha256 FROM ${blobs} WHERE sha256 IN (${inList("h", count)}) ORDER BY sha256` +
					(adapter === "sqlite" ? "" : exclusive ? " FOR UPDATE" : mysql ? " LOCK IN SHARE MODE" : " FOR SHARE"),
			),
		sweepCandidates: sql(
			`SELECT b.sha256 AS sha256, b.byte_len AS byte_len FROM ${blobs} AS b WHERE b.created_ms < @before ` +
				`AND NOT EXISTS (SELECT 1 FROM ${refs} AS r WHERE r.sha256 = b.sha256)`,
		),
		// Not through `sql`, which reads `@name` as a bound value.
		maxPacket: mysql ? { sql: "SELECT @@max_allowed_packet AS max_packet", params: [] } : undefined,
		createRefsTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${refs} (` +
				`path VARCHAR(512) NOT NULL, sha256 CHAR(64) NOT NULL, PRIMARY KEY (path, sha256), ` +
				`INDEX ${name}_rhash (sha256)` +
				mysqlTable
			: `CREATE TABLE IF NOT EXISTS ${refs} (path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (path, sha256))`,
		createRefsIndex: mysql ? undefined : `CREATE INDEX IF NOT EXISTS ${name}_rhash ON ${refs} (sha256)`,
		insertRef: sql(
			`INSERT INTO ${refs} (path, sha256) VALUES (@path, @sha256) ` +
				(mysql ? "ON DUPLICATE KEY UPDATE path = path" : "ON CONFLICT (path, sha256) DO NOTHING"),
		),
		refsOf: count => sql(`SELECT sha256, path FROM ${refs} WHERE path IN (${inList("p", count)})`),
		refsUnder: sql(`SELECT sha256, path FROM ${refs} WHERE substr(path, 1, @len) = @dir`),
		referenced: count => sql(`SELECT sha256 FROM ${refs} WHERE sha256 IN (${inList("h", count)})`),
		referencedOne: mysql ? sql(`SELECT sha256 FROM ${refs} WHERE sha256 = @h LIMIT 1 LOCK IN SHARE MODE`) : undefined,
		deleteRef: sql(`DELETE FROM ${refs} WHERE path = @path AND sha256 = @sha256`),
		danglingRefs: sql(
			`SELECT r.path AS path, r.sha256 AS sha256 FROM ${refs} AS r ` +
				`WHERE substr(r.path, 1, ${BLOB_PARTS_PATH.length}) <> '${BLOB_PARTS_PATH}' ` +
				`AND NOT EXISTS (SELECT 1 FROM ${table} AS f WHERE f.path = r.path)`,
		),
		// The statement looks for the session row again: PostgreSQL's look sees every commit before it, and SQLite
		// runs one writer at a time. MySQL's sweep reads the rows itself and drops each reference by its key (see
		// #dropDanglingRefs).
		deleteDanglingRef: sql(
			`DELETE FROM ${refs} WHERE path = @path AND sha256 = @sha256 ` +
				`AND NOT EXISTS (SELECT 1 FROM ${table} AS f WHERE f.path = @path)`,
		),
		lockSessionRowsForWrite:
			adapter === "sqlite"
				? undefined
				: (count, under) =>
						sql(
							`SELECT path FROM ${table} WHERE path IN (${inList("p", count)})` +
								(under ? " OR substr(path, 1, @len) = @dir" : "") +
								" ORDER BY path FOR UPDATE",
						),
		sessionRowsOf: mysql
			? count => sql(`SELECT path FROM ${table} WHERE path IN (${inList("p", count)})`)
			: undefined,
		primaryKey: {
			postgres: undefined,
			mysql: sql(
				"SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() " +
					"AND TABLE_NAME = @table AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
			),
			sqlite: sql("SELECT name FROM pragma_table_info(@table) WHERE pk > 0 ORDER BY pk"),
		}[adapter],
		privilegeProbes: mysql
			? [
					{
						table: `${name}_blobs`,
						privilege: "INSERT",
						probe: sql(
							`INSERT INTO ${blobs} (sha256, content, byte_len, mime_type, created_ms) ` +
								`SELECT sha256, content, byte_len, mime_type, created_ms FROM ${blobs} WHERE 1 = 0`,
						),
					},
					{
						table: `${name}_blobs`,
						privilege: "UPDATE",
						probe: sql(`UPDATE ${blobs} SET sha256 = sha256 WHERE 1 = 0`),
					},
					{ table: `${name}_blobs`, privilege: "DELETE", probe: sql(`DELETE FROM ${blobs} WHERE 1 = 0`) },
					{
						table: `${name}_refs`,
						privilege: "INSERT",
						probe: sql(`INSERT INTO ${refs} (path, sha256) SELECT path, sha256 FROM ${refs} WHERE 1 = 0`),
					},
					{ table: `${name}_refs`, privilege: "DELETE", probe: sql(`DELETE FROM ${refs} WHERE 1 = 0`) },
					{ table: `${name}_refs`, privilege: "UPDATE", probe: sql(`UPDATE ${refs} SET path = path WHERE 1 = 0`) },
				]
			: [],
		lease:
			adapter === "sqlite"
				? undefined
				: buildLeaseQueries(
						adapter,
						relation(leaseName),
						relation(foldIdentifier(leaseName)),
						leaseName,
						leaseExpiryMs,
					),
	};
}

/**
 * `name` as PostgreSQL resolves it unquoted: ASCII `A`-`Z` folded to lower case and
 * every other character kept (`downcase_identifier` in a multibyte encoding). The
 * names the store takes ({@link IDENT_RE}, {@link LEASE_IDENT_RE}) are unquoted ASCII,
 * so `OMP_X` and `omp_x` are one table; folding `A`-`Z` alone keeps this true if
 * those patterns ever admit other letters.
 */
function foldIdentifier(name: string): string {
	return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function buildLeaseQueries(
	adapter: "postgres" | "mysql",
	leases: string,
	/** `leases` as PostgreSQL resolves it ({@link foldIdentifier}): its session lock's key. Unused on MySQL. */
	resolvedLeases: string,
	leaseName: string,
	expiryMs: number,
): LeaseQueries {
	const sql = (template: string): Statement => statement(adapter, template);
	const mysql = adapter === "mysql";
	// Milliseconds since the epoch on the database clock, read when the
	// statement runs: PostgreSQL's now() would be the transaction's start.
	const now = mysql
		? "CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)"
		: "(extract(epoch from clock_timestamp()) * 1000)::bigint";
	const expired = `${now} - ${Math.trunc(expiryMs)}`;
	// A heartbeat more than one expiry ahead of the database clock (another
	// login wrote it, a clock jumped) is expired too. Written as `now + expiry`:
	// subtracting `now` from a `bigint` heartbeat near its maximum overflows.
	const future = `${now} + ${Math.trunc(expiryMs)}`;
	const stale = (column: string) => `(${column} < ${expired} OR ${column} > ${future})`;
	const columns = "session_id, holder, host, pid, acquired_at, heartbeat_at";
	const values = `@sid, @holder, @host, @pid, ${now}, ${now}`;
	const sessions = (count: number): string => Array.from({ length: count }, (_, index) => `@sid${index}`).join(", ");
	// The lock is per lease table: its qualified name as PostgreSQL resolves it, as a literal, goes before the session
	// id, so two spellings of one table take one lock.
	const leaseKey = `'${resolvedLeases.replace(/'/g, "''")}:'`;
	const sessionLock = (fn: string): string =>
		`SELECT pg_catalog.${fn}(${PG_SESSION_LOCK_CLASS}, pg_catalog.hashtext(pg_catalog.textcat(${leaseKey}, @sid)))`;
	const lockRow = `SELECT holder, CASE WHEN ${stale("heartbeat_at")} THEN 1 ELSE 0 END AS stale FROM ${leases} WHERE session_id = @sid`;
	const heldRow = `SELECT holder FROM ${leases} WHERE session_id = @sid AND holder = @holder`;
	const foreignRow = `SELECT holder FROM ${leases} WHERE session_id = @sid AND holder <> @holder AND NOT ${stale("heartbeat_at")}`;
	return {
		// `session_id` is declared as the session table declares `path`.
		createTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${leases} (` +
				`session_id VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`holder VARCHAR(64) NOT NULL, ` +
				`host VARCHAR(255) NOT NULL, ` +
				`pid BIGINT NOT NULL, ` +
				`acquired_at BIGINT NOT NULL, ` +
				`heartbeat_at BIGINT NOT NULL, ` +
				// The heartbeat updates one holder's rows; without this index
				// MySQL's UPDATE would lock every lease row it scans.
				`INDEX ${leaseName}_holder (holder)` +
				") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin"
			: `CREATE TABLE IF NOT EXISTS ${leases} (` +
				`session_id TEXT PRIMARY KEY, ` +
				`holder TEXT NOT NULL, ` +
				`host TEXT NOT NULL, ` +
				`pid BIGINT NOT NULL, ` +
				`acquired_at BIGINT NOT NULL, ` +
				`heartbeat_at BIGINT NOT NULL)`,
		createIndex: mysql ? undefined : `CREATE INDEX IF NOT EXISTS ${leaseName}_holder ON ${leases} (holder)`,
		claim: sql(
			`INSERT INTO ${leases} (${columns}) VALUES (${values}) ` +
				"ON CONFLICT (session_id) DO UPDATE SET holder = excluded.holder, host = excluded.host, pid = excluded.pid, " +
				`acquired_at = CASE WHEN ${leases}.holder = excluded.holder THEN ${leases}.acquired_at ` +
				"ELSE excluded.acquired_at END, heartbeat_at = excluded.heartbeat_at " +
				`WHERE ${stale(`${leases}.heartbeat_at`)} OR ${leases}.holder = excluded.holder RETURNING holder`,
		),
		insert: sql(`INSERT INTO ${leases} (${columns}) VALUES (${values})`),
		take: sql(
			`UPDATE ${leases} SET acquired_at = CASE WHEN holder = @holder THEN acquired_at ELSE ${now} END, ` +
				`holder = @holder, host = @host, pid = @pid, heartbeat_at = ${now} WHERE session_id = @sid`,
		),
		heartbeat: count =>
			sql(
				`UPDATE ${leases} SET heartbeat_at = ${now} WHERE holder = @holder AND session_id IN (${sessions(count)})` +
					(mysql ? "" : " RETURNING session_id"),
			),
		heldBy: count =>
			sql(`SELECT session_id FROM ${leases} WHERE holder = @holder AND session_id IN (${sessions(count)})`),
		release: sql(`DELETE FROM ${leases} WHERE session_id = @sid AND holder = @holder`),
		claimLock: mysql ? undefined : sql(sessionLock("pg_advisory_xact_lock")),
		fenceLock: mysql ? undefined : sql(sessionLock("pg_advisory_xact_lock_shared")),
		held: sql(`${heldRow} FOR SHARE`),
		foreign: sql(foreignRow),
		// MySQL 8 and MariaDB refuse a NOWAIT locking read at once instead of waiting; the store retries it within its
		// bound. MySQL 8 spells the share lock FOR SHARE NOWAIT, MariaDB LOCK IN SHARE MODE NOWAIT.
		nowait: mysql
			? {
					mysql: {
						lock: sql(`${lockRow} FOR UPDATE NOWAIT`),
						held: sql(`${heldRow} FOR SHARE NOWAIT`),
						foreign: sql(`${foreignRow} FOR SHARE NOWAIT`),
						releaseLock: sql(`${heldRow} FOR UPDATE NOWAIT`),
					},
					mariadb: {
						lock: sql(`${lockRow} FOR UPDATE NOWAIT`),
						held: sql(`${heldRow} LOCK IN SHARE MODE NOWAIT`),
						foreign: sql(`${foreignRow} LOCK IN SHARE MODE NOWAIT`),
						releaseLock: sql(`${heldRow} FOR UPDATE NOWAIT`),
					},
				}
			: undefined,
		insertWithin: mysql
			? seconds =>
					sql(
						`SET STATEMENT innodb_lock_wait_timeout = ${Math.max(1, Math.ceil(seconds))} FOR ` +
							`INSERT INTO ${leases} (${columns}) VALUES (${values})`,
					)
			: undefined,
		probe: sql(
			`SELECT host, pid, CASE WHEN ${stale("heartbeat_at")} THEN 1 ELSE 0 END AS stale ` +
				`FROM ${leases} WHERE session_id = @sid`,
		),
	};
}

function rowNumber(value: number | bigint | string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}
/**
 * The title metadata a row's title columns hold: `undefined` when no title
 * update or titled full write set its time (`title_updated_at`), as on a row
 * from before the columns existed, which keeps the title slot it stores.
 */
function rowTitle(row: TitleColumns): SessionStorageReadTitle {
	if (!row.title_updated_at) return undefined;
	const source = row.title_source === "auto" || row.title_source === "user" ? row.title_source : undefined;
	return { title: row.title ?? undefined, source, updatedAt: row.title_updated_at };
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

/**
 * A replacing rename met, on every one of its `attempts`, a destination row
 * another client created after the attempt read which rows there are: each
 * attempt's rename of the source's row collided with it on the primary key
 * (`cause` is the last collision), and nothing changed.
 */
export class SessionRenameRaceError extends Error {
	readonly src: string;
	readonly dst: string;
	readonly attempts: number;

	constructor(src: string, dst: string, attempts: number, cause: unknown) {
		super(`Session rename of ${src} met a new session at ${dst} on each of ${attempts} attempts; nothing changed.`, {
			cause,
		});
		this.name = "SessionRenameRaceError";
		this.src = src;
		this.dst = dst;
		this.attempts = attempts;
	}
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
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file is a row of the session table keyed by `path`, holding
 * its metadata (`byte_len`, `mtime_ms`, title fields), plus rows of
 * `<table>_parts` keyed by (`path`, `start_offset`): an append inserts one
 * part, a full write replaces them with parts of at most 1 MiB. A session's
 * content is the row's `content` (non-empty only for rows an older version
 * wrote) followed by its parts in offset order. This process keeps only a
 * metadata index (`size`, `mtimeMs`) in memory for synchronous `existsSync` /
 * `statSync` / `listFilesSync` calls. A read takes the session row's title
 * columns in the statement that reads its bytes.
 *
 * Works against PostgreSQL, MySQL/MariaDB, and SQLite by selecting the
 * dialect-correct DDL, upsert, row-lock, byte-length, and byte-slice syntax
 * at construction.
 */
export class SqlSessionStorage extends IndexedSessionStorage {
	readonly #backend: SqlSessionStorageBackend;
	/**
	 * Set only when the store claims sessions (`claims` on a database other
	 * processes can open): {@link SessionStorage.claimSession}. A claim on
	 * PostgreSQL or MySQL is optimistic: its claim statement runs in the
	 * background, every write under it waits for that statement, and
	 * `onLost` hears when it found another holder.
	 */
	readonly claimSession: SessionStorage["claimSession"];
	/** {@link SessionStorage.acquireSessionClaim}, set as {@link claimSession} is. */
	readonly acquireSessionClaim: SessionStorage["acquireSessionClaim"];
	/** {@link SessionStorage.sessionClaimLost}, set as {@link claimSession} is. */
	readonly sessionClaimLost: SessionStorage["sessionClaimLost"];
	/** {@link SessionStorage.sessionClaimHolder}, set as {@link claimSession} is. */
	readonly sessionClaimHolder: SessionStorage["sessionClaimHolder"];
	/** {@link SessionStorage.releaseHeldClaims}, set as {@link claimSession} is: within the release's bound. */
	readonly releaseHeldClaims: SessionStorage["releaseHeldClaims"];

	private constructor(backend: SqlSessionStorageBackend) {
		super(backend);
		this.#backend = backend;
		if (!backend.claims) return;
		// The last release of a claim waits for this store's queued writes under it.
		const settle = (paths: readonly string[]) =>
			Promise.all(paths.map(file => this.confirmWrites(file).catch(() => undefined))).then(() => undefined);
		backend.bindExitSettle(settle);
		const releaser = (claim: LeaseClaim, file: string, onLost: (() => void) | undefined): (() => void) => {
			let released = false;
			return () => {
				if (released) return;
				released = true;
				backend.release(claim, file, onLost, settle);
			};
		};
		this.claimSession = (sessionId, sessionPath, options) => {
			const file = path.resolve(sessionPath);
			const claim = backend.claim(sessionId, file, options?.onLost);
			return claim ? releaser(claim, file, options?.onLost) : null;
		};
		this.acquireSessionClaim = async (sessionId, sessionPath, options) => {
			const file = path.resolve(sessionPath);
			const claim = await backend.acquire(sessionId, file, options ?? {}, settle);
			return claim ? releaser(claim, file, options?.onLost) : null;
		};
		this.sessionClaimLost = sessionId => backend.claimLost(sessionId);
		this.sessionClaimHolder = sessionId => backend.claimHolder(sessionId);
		this.releaseHeldClaims = async () => {
			await withinBound(backend.releaseHeld(), LEASE_RELEASE_BOUND_MS + LEASE_RELEASE_GRACE_MS);
		};
	}

	/**
	 * Apply the dialect-correct DDL and migration (unless `createTable: false`
	 * is set, which instead verifies the schema is in place) and warm the
	 * metadata index with every existing row. Must be awaited before passing
	 * the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const storage = new SqlSessionStorage(new SqlSessionStorageBackend(options));
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#backend.adapter;
	}

	get table(): string {
		return this.#backend.table;
	}

	/** {@link SessionStorage.blobTier}: the blob table, `<table>_blobs`. */
	get blobTier(): SessionBlobTier {
		return this.#backend.blobs;
	}

	/**
	 * {@link IndexedSessionStorage.drain}, then the blob writes queued so far,
	 * then the claim releases in flight, so a closed session's lease is gone.
	 */
	override async drain(): Promise<void> {
		try {
			await super.drain();
			// A blob this land tries and still cannot land is warned about; one its pass did not try (see SqlBlobTier)
			// gets no warning line of its own, since its failure names the blob whose write ended the pass. Either
			// stays queued, and the drain does not reject for it.
			await this.#backend.blobs.land().catch(() => undefined);
		} finally {
			await this.#backend.releasesSettled();
		}
	}
}

/**
 * {@link SessionBlobTier} over the blob table. A blob it is handed lands in
 * a transaction of its own, outside every session's write fence: rows are
 * keyed by content hash and never change, so a fence would only lose an
 * image a takeover raced. A transcript write first waits for the queued
 * blobs its content names ({@link land}), so no committed transcript names a
 * blob the table lacks, whatever stops the writer; a write that names none
 * waits for none. A blob write is tried {@link BLOB_WRITE_ATTEMPTS} times. A
 * blob write that still fails stays queued and fails the transcript writes
 * naming it, which the session reports as a persistence error, and the next
 * such write tries it again. Each land is one pass over the queued blobs,
 * one write after another, so a burst of images holds one connection at a
 * time; a blob that fails does not stop the others, but an error whose
 * repairs are spent ({@link SqlSessionStorageBackend.repairsSpent}) fails
 * its blob at once and ends the pass: each queued blob the pass did not try
 * fails with that error as its cause and stays queued.
 *
 * So on PostgreSQL connections no transaction can repair, each land makes at
 * most {@link PG_REPAIR_RETRIES} + 1 attempts (4) and closes as many
 * connections. A transcript write that names n newly stored images meets at
 * most n + 1 lands (each image's own, which {@link store} starts, and the
 * write's), so it closes at most 4(n + 1); one whose transaction then finds
 * k of the blobs it names gone meets at most k + 1 more, which land them
 * again ({@link reland}). A session open that writes m images back to the
 * table (`restoreTierBlobs` in session-loader.ts) meets at most m + 1 lands
 * (one per image it queues, and its reference's), so it closes at most
 * 4(m + 1) from lands; its reference transaction, like a transcript
 * write's, meets k + 1 more when it finds k of the blobs gone. Its other
 * calls are operations of their own, at most 4 closes each: each batch it
 * reads (blob sizes, rows whose bytes do not hash to their key, blob bytes),
 * each row it rewrites, and the reference transaction. On connections that
 * are all repairless its first read, of blob sizes, fails, so it queues no
 * image and writes no reference: it closes 4. A drain
 * ({@link SqlSessionStorage.drain}, which lands every queued blob) is a call
 * of its own and one land, so it closes at most 4 more, however many blobs
 * stay queued.
 *
 * Bytes that do not hash to their reference are never stored. A blob larger
 * than one row takes is stored as parts (see {@link BLOB_PARTS_PATH}).
 */
class SqlBlobTier implements SessionBlobTier {
	readonly #backend: SqlSessionStorageBackend;
	/** Hashes the table holds, each with its MIME type when known: written by this store, or found there. */
	readonly #landed = new Map<string, string | undefined>();
	readonly #queued = new Map<string, { data: Buffer; mimeType: string | undefined }>();
	/** The last error of each queued blob whose write failed. */
	readonly #failed = new Map<string, Error>();
	#tail: Promise<void> = Promise.resolve();

	constructor(backend: SqlSessionStorageBackend) {
		this.#backend = backend;
	}

	store(hash: string, data: Buffer, mimeType: string | undefined): void {
		if (this.#landed.has(hash) || this.#queued.has(hash)) return;
		this.#queued.set(hash, { data, mimeType });
		// Start now, ahead of the transcript write that names it; that write tries a failure again.
		this.land([hash]).catch(() => undefined);
	}

	/** Whether `hash` is a blob of this store's: landed by it, found in the table, or queued. A write naming one needs its row. */
	knows(hash: string): boolean {
		return this.#landed.has(hash) || this.#queued.has(hash);
	}

	/** Forget `hashes` as landed: a delete took their rows. */
	forget(hashes: Iterable<string>): void {
		for (const hash of hashes) this.#landed.delete(hash);
	}

	/**
	 * Land the queued blobs among `hashes` (every queued blob, without
	 * `hashes`), behind the ones queued before them. Rejects when one of
	 * `hashes` did not land in its tries, and also for one the pass did not
	 * try: a blob queued before it whose write's repairs are spent ends the
	 * pass, and the rejection has that write's error as its cause (see
	 * {@link SqlBlobTier}, which states the rule). Either way it stays
	 * queued. Another blob's failure rejects it in no other way.
	 */
	async land(hashes?: Iterable<string>): Promise<void> {
		const wanted =
			hashes === undefined ? [...this.#queued.keys()] : [...hashes].filter(hash => this.#queued.has(hash));
		if (wanted.length === 0) return;
		const landing = this.#tail.then(() => this.#landQueued());
		this.#tail = landing;
		await landing;
		for (const hash of wanted) {
			if (!this.#queued.has(hash)) continue;
			throw this.#failed.get(hash) ?? new Error(`SqlSessionStorage: session image ${hash} is still queued`);
		}
	}

	/**
	 * Queue again, from this machine's blob store, each of `hashes` whose row a
	 * delete took after it landed. Answers the hashes it queued; one this
	 * machine no longer holds is not among them.
	 */
	async reland(hashes: readonly string[]): Promise<string[]> {
		const queued: string[] = [];
		for (const hash of hashes) {
			const mimeType = this.#landed.get(hash);
			this.#landed.delete(hash);
			const data = await localBlob(hash);
			if (!data) continue;
			this.store(hash, data, mimeType);
			queued.push(hash);
		}
		return queued;
	}

	/** One land's pass over the queued blobs, in the order they were queued (see {@link SqlBlobTier}). */
	async #landQueued(): Promise<void> {
		const failure = (hash: string, reason: string, cause: Error) =>
			new Error(
				`SqlSessionStorage: session image ${hash} did not reach ${this.#backend.table}_blobs, ` +
					`so no transcript naming it is written yet: ${reason}`,
				{ cause },
			);
		const queued = [...this.#queued];
		// The blob whose write's repairs are spent, with that write's error: the pass tries no blob after it.
		let spent: { hash: string; error: Error } | undefined;
		for (const [hash, blob] of queued) {
			if (this.#queued.get(hash) !== blob) continue;
			if (spent !== undefined) {
				const reason =
					`it was not tried after session image ${spent.hash} ` +
					`met only PostgreSQL connections no transaction can repair: ${spent.error.message}`;
				this.#failed.set(hash, failure(hash, reason, spent.error));
				continue;
			}
			try {
				await this.#landOne(hash, blob.data, blob.mimeType);
				this.#failed.delete(hash);
			} catch (err) {
				const error = toError(err);
				this.#failed.set(hash, failure(hash, error.message, error));
				if (this.#backend.repairsSpent(err)) spent = { hash, error };
			}
		}
	}

	/**
	 * Write one blob, in at most {@link BLOB_WRITE_ATTEMPTS} tries. Throws the
	 * last try's error as the runner threw it, so {@link #landQueued} can ask
	 * {@link SqlSessionStorageBackend.repairsSpent} about it.
	 */
	async #landOne(hash: string, data: Buffer, mimeType: string | undefined): Promise<void> {
		// A row is never replaced by a later write, so bytes that do not hash to their key are kept out.
		if (blobSha256(data) !== hash) {
			this.#queued.delete(hash);
			logger.warn(
				"A session image's bytes do not hash to its reference, so the session database does not store them",
				{
					hash,
					bytes: data.byteLength,
				},
			);
			return;
		}
		for (let attempt = 1; ; attempt++) {
			try {
				const limit = await this.#backend.maxBlobBytes();
				const added = await this.#backend.insertBlob(hash, data, mimeType, limit);
				this.#queued.delete(hash);
				this.#landed.set(hash, mimeType);
				if (added) {
					logger.info("Stored a session blob in the session database", {
						hash,
						bytes: data.byteLength,
						mimeType,
						parts: data.byteLength > limit ? Math.ceil(data.byteLength / limit) : 1,
						attempts: attempt,
					});
				}
				return;
			} catch (err) {
				// An error whose repairs are spent is not tried again (see SqlSessionStorageBackend.repairsSpent).
				if (attempt < BLOB_WRITE_ATTEMPTS && !this.#backend.repairsSpent(err)) {
					await Bun.sleep(BLOB_RETRY_MS * 2 ** (attempt - 1));
					continue;
				}
				logger.warn("Storing a session blob in the session database failed; the next write naming it tries again", {
					hash,
					bytes: data.byteLength,
					attempts: attempt,
					error: toError(err).message,
				});
				throw err;
			}
		}
	}

	async sizes(hashes: readonly string[]): Promise<Map<string, number>> {
		const sizes = await this.#backend.blobSizes(hashes);
		for (const hash of sizes.keys()) if (!this.#landed.has(hash)) this.#landed.set(hash, undefined);
		return sizes;
	}

	read(hashes: readonly string[], visit: (hash: string, data: Buffer) => Promise<void>): Promise<void> {
		return this.#backend.readBlobs(hashes, visit);
	}

	async repair(hashes: readonly string[], local: (hash: string) => Promise<Buffer | null>): Promise<number> {
		let repaired = 0;
		for (const hash of await this.#backend.wrongBlobs(hashes)) {
			const data = await local(hash);
			if (!data || blobSha256(data) !== hash) continue;
			if (!(await this.#backend.repairBlob(hash, data, await this.#backend.maxBlobBytes()))) continue;
			repaired++;
			logger.warn("Repaired a session blob whose bytes in the session database did not hash to its key", {
				hash,
				bytes: data.byteLength,
			});
		}
		return repaired;
	}

	async reference(sessionPath: string, hashes: readonly string[]): Promise<void> {
		await this.land(hashes);
		await this.#backend.addReferences(sessionPath, hashes);
	}

	sweep(referenced: ReadonlySet<string>, beforeMs: number, apply: boolean): Promise<SessionBlobSweep> {
		return this.#backend.sweepBlobs(referenced, beforeMs, apply);
	}
}

/** The SHA-256 of `data`, in hex: the key of its blob row. */
function blobSha256(data: Uint8Array): string {
	return new Bun.SHA256().update(data).digest("hex");
}

/** This machine's copy of the blob `hash`, when its local blob store holds bytes that hash to it. */
async function localBlob(hash: string): Promise<Buffer | null> {
	try {
		const data = Buffer.from(await Bun.file(path.join(getBlobsDir(), hash)).arrayBuffer());
		return blobSha256(data) === hash ? data : null;
	} catch {
		return null;
	}
}

/** `items` in runs of at most `size`. */
function batches<T>(items: readonly T[], size: number): T[][] {
	const runs: T[][] = [];
	for (let start = 0; start < items.length; start += size) runs.push(items.slice(start, start + size));
	return runs;
}

/** `@<prefix>0, …, @<prefix><count - 1>`, an IN list's bound values. */
function inList(prefix: string, count: number): string {
	return Array.from({ length: count }, (_unused, index) => `@${prefix}${index}`).join(", ");
}

/** `items` bound as `@<prefix>0` … for an IN list built with the same prefix. */
function listValues(prefix: string, items: readonly string[]): StatementValues {
	return Object.fromEntries(items.map((item, index) => [`${prefix}${index}`, item]));
}

const BLOB_REF_IN_TEXT = /blob:sha256:([0-9a-f]{64})/g;

/** The blob hashes `text` (a transcript, or one line of it) names. */
function namedBlobHashes(text: string): Set<string> {
	const hashes = new Set<string>();
	if (!text.includes("blob:sha256:")) return hashes;
	for (const match of text.matchAll(BLOB_REF_IN_TEXT)) hashes.add(match[1] ?? "");
	return hashes;
}

/** A write names blobs of this store's that a delete took after they landed; they are landed again, and the write runs once more. */
class BlobsGoneError extends Error {
	constructor(readonly hashes: readonly string[]) {
		super(`SqlSessionStorage: ${hashes.length} session image(s) this write names were deleted meanwhile`);
		this.name = "BlobsGoneError";
	}
}

/**
 * This store's claim on one session's lease. Every claim of the session
 * through this store shares it (`refs`), as do the paths it was claimed at,
 * a subagent transcript under the session's artifacts directory among them:
 * such a transcript is claimed under its enclosing session's lease (see
 * {@link sessionLeaseId}), never under an id of its own.
 */
interface LeaseClaim {
	/** The lease's id: the session the claimed paths belong to. */
	readonly sessionId: string;
	/** The paths written under the claim, each with the number of claims made at it. */
	readonly paths: Map<string, number>;
	/** The session id each claimed path's header must name: its own transcript's, which a subagent's differs from the lease's. */
	readonly headers: Map<string, string>;
	/** Release callbacks not yet run. */
	refs: number;
	/**
	 * `pending` until the claim statement answers; `held` once it claimed;
	 * `lost` once it, a fenced write or a heartbeat found another holder, or
	 * found the path holding another session (`foreign`).
	 */
	state: "pending" | "held" | "lost";
	foreign: boolean;
	/** The claim statement in flight, or the one that answered. */
	attempt: Promise<boolean> | undefined;
	/** Heartbeat round current when the claim statement answered: only a later round can find the lease gone. */
	heldRound: number;
	/**
	 * `performance.now()` until which the claim is proven: the send time of the
	 * last heartbeat (or claim statement) the database answered, plus the
	 * expiry less one heartbeat interval. A claim past it is lapsed, not lost:
	 * its writes wait for the next answered heartbeat.
	 */
	validUntil: number;
	/** How long the claim statement waits for another transaction's lock of the lease row (see {@link LEASE_CLAIM_LOCK_BOUND_MS}). */
	readonly lockBoundMs: number;
	/** A SQLite claim's OS lock, shared with every store of this process on that database file. */
	readonly lock: SqliteLock | undefined;
	/** The release of this session's previous claim, in flight when this one was made: its delete lands first. */
	readonly after: Promise<void> | undefined;
	readonly listeners: Set<() => void>;
}

/** One OS lock of a SQLite session claim, counted across this process's stores. */
interface SqliteLock {
	readonly key: string;
	readonly lease: FileLockHandle;
	holders: number;
}

/** SQLite claims' OS locks by database file and session id, shared by every store of this process. */
const sqliteLocks = new Map<string, SqliteLock>();

/**
 * One lease a write is fenced under: this store's claim on the session when it
 * holds one, else none, and the write is refused only while another holder's
 * lease of the session is fresh.
 */
interface LeaseFence {
	readonly claim: LeaseClaim | undefined;
	readonly sessionId: string;
	readonly file: string;
}

/** The session id in the header at the start of `prefix` (past the title slot), or `undefined` when it has none. */
function headerSessionId(prefix: string): string | undefined {
	const text = parseTitleSlotFromContent(prefix) ? prefix.slice(prefix.indexOf("\n") + 1) : prefix;
	const end = text.indexOf("\n");
	if (end === -1) return undefined;
	try {
		const entry: unknown = JSON.parse(text.slice(0, end));
		if (entry && typeof entry === "object" && "type" in entry && entry.type === "session" && "id" in entry) {
			return typeof entry.id === "string" ? entry.id : undefined;
		}
	} catch {}
	return undefined;
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #leaseTable: string;
	readonly #q: DialectQueries;
	/** The schema of the store's PostgreSQL tables ({@link PG_SCHEMA}); unset on other dialects. */
	readonly #schema: string | undefined;
	readonly #createTable: boolean;
	/** The shared call queue for this client's SQLite database; unset on other dialects. */
	readonly #sqliteQueue: SqliteQueue | undefined;
	/**
	 * How this store claims sessions: `row`, a lease row (PostgreSQL, MySQL);
	 * `lock`, an OS lock on the database file and session id (a SQLite file);
	 * unset when it claims nothing.
	 */
	readonly #gate: "row" | "lock" | undefined;
	/** The SQLite database file a `lock` claim is keyed by. */
	readonly #sqliteFile: string | undefined;
	readonly #expiryMs: number;
	readonly #heartbeatMs: number;
	/** This store's lease holder token: 128 random bits, made once per store, never the host or the pid. */
	readonly #holder = randomBytes(16).toString("hex");
	/** The sessions this store claimed, by session id. */
	readonly #leases = new Map<string, LeaseClaim>();
	/**
	 * The claim each claimed path is written under. A path its claim no longer holds leaves at once while other
	 * references to the claim remain; the claim's last release removes the rest once its queued writes settle.
	 */
	readonly #leasedPaths = new Map<string, LeaseClaim>();
	/** Claim releases in flight, by session id; a new claim of the id waits for its release. */
	readonly #releases = new Map<string, Promise<void>>();
	/**
	 * Cancels this store's exit release (see {@link #armExitRelease}): set while it holds a lease row, unset once it
	 * holds none.
	 */
	#cancelExitRelease: (() => void) | undefined;
	/** How the store waits for its queued writes under a claim; the exit release waits for them as a release does. */
	#exitSettle: ((paths: readonly string[]) => Promise<void>) | undefined;
	#heartbeat: Timer | undefined;
	#heartbeatRound = 0;
	#beating = false;
	/** How this MySQL-family server bounds a lease row's lock wait (see {@link MysqlLockForm}); set at start-up. */
	#mysqlLocks: MysqlLockForm | undefined;
	/** The version a MySQL-family server reported at start-up, as a refusal names it. */
	#mysqlVersion = "";
	/** The largest blob the table takes on this server, once read (see {@link maxBlobBytes}). */
	#maxBlobBytes: Promise<number> | undefined;
	/** The `maxBlobBytes` option, or {@link MAX_BLOB_BYTES}. */
	readonly #maxRowBlobBytes: number;
	/**
	 * The read and the write opening of every PostgreSQL transaction (see
	 * {@link #postgres}): without the conditional statements until the probe
	 * has read at start-up which of them this server takes, then with those.
	 */
	#openings = PG_PROBE_OPENINGS;
	/** The errors {@link #postgres} threw after its last repairless attempt (see {@link repairsSpent}). */
	readonly #spentRepairs = new WeakSet<object>();
	/** The blob table's writes and reads; every content write below waits for the blobs queued before it. */
	readonly blobs: SqlBlobTier = new SqlBlobTier(this);

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(
				`SqlSessionStorage: table name must match ${IDENT_RE.source}, at most 57 characters so ` +
					`${JSON.stringify(`${table}_parts`)} and ${JSON.stringify(`${table}_blobs`)} stay valid identifiers (got ${JSON.stringify(table)})`,
			);
		}
		const leaseTable = options.leaseTable ?? DEFAULT_LEASE_TABLE;
		if (!LEASE_IDENT_RE.test(leaseTable)) {
			throw new Error(
				`SqlSessionStorage: leaseTable must match ${LEASE_IDENT_RE.source}, at most 56 characters so ` +
					`${JSON.stringify(`${leaseTable}_holder`)} stays a valid identifier (got ${JSON.stringify(leaseTable)})`,
			);
		}
		const lease = options.lease ?? { expiryMs: SESSION_LEASE_EXPIRY_MS, heartbeatMs: SESSION_LEASE_HEARTBEAT_MS };
		if (!(lease.heartbeatMs > 0 && lease.expiryMs > lease.heartbeatMs)) {
			throw new Error(
				`SqlSessionStorage: lease.expiryMs must exceed lease.heartbeatMs, which must be positive (got ${JSON.stringify(lease)})`,
			);
		}
		this.#table = table;
		this.#leaseTable = leaseTable;
		this.#expiryMs = lease.expiryMs;
		this.#heartbeatMs = lease.heartbeatMs;
		this.#schema = this.#adapter === "postgres" ? PG_SCHEMA : undefined;
		this.#q = buildQueries(this.#adapter, table, leaseTable, lease.expiryMs, this.#schema);
		this.#createTable = options.createTable !== false;
		this.#maxRowBlobBytes = options.maxBlobBytes ?? MAX_BLOB_BYTES;
		this.#sqliteQueue = this.#adapter === "sqlite" ? sqliteQueue(options.client) : undefined;
		const filename = options.client.options.filename;
		this.#sqliteFile =
			this.#adapter === "sqlite" && typeof filename === "string" && filename !== "" && filename !== ":memory:"
				? path.resolve(filename)
				: undefined;
		if (options.claims === true) {
			if (this.#adapter !== "sqlite") this.#gate = "row";
			// An in-memory database is this process's alone: nobody else can open its sessions.
			else if (this.#sqliteFile) this.#gate = "lock";
		}
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	/** Whether this store claims sessions. */
	get claims(): boolean {
		return this.#gate !== undefined;
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
			if (this.#adapter === "mysql" && this.#gate === "row") {
				// A claim's every lock wait must end within its bound, without session
				// state a pooled connection would carry to another client.
				const [row] = (await this.#client.unsafe("SELECT VERSION() AS version")) as Array<{ version: string }>;
				const version = String(row?.version ?? "");
				this.#mysqlVersion = version;
				this.#mysqlLocks = mysqlLockForm(version);
				if (!this.#mysqlLocks) {
					throw new Error(
						`SqlSessionStorage: claiming sessions needs MySQL 8.0 or later, or MariaDB 10.3 or later; this server is ${version || "of an unknown version"}, which bounds no lock wait without session state. Upgrade the server, or open the store without claims.`,
					);
				}
			}
			if (this.#adapter === "postgres") {
				// The probe, with no conditional statement in its opening: which of them this server takes. It is
				// the first statement, so a client without reserve() is refused (see #postgres) before any is sent.
				const present = (await this.#readOne(
					"open",
					PG_PRESENT_PARAMETERS,
					listValues("p", PG_CONDITIONAL_PARAMETERS),
				)) as Array<{ name: string }>;
				this.#openings = pgOpenings(new Set(present.map(row => row.name)));
			}
			// One look at the PostgreSQL tables and the server, for a store that
			// would write there (claims, or makes tables): a server in recovery
			// accepts no write, so the store refuses to start on it.
			const look =
				this.#adapter === "postgres" && (this.#gate === "row" || this.#createTable)
					? (((await this.#readOne("open", PG_TABLES_PRESENT, this.#pgTableNames())) as TablesPresentRow[])[0] ??
						undefined)
					: undefined;
			if (look?.in_recovery) {
				throw new Error(
					`SqlSessionStorage: the PostgreSQL server is in recovery (a hot standby or a read replica), which accepts no write, so a store that ${this.#gate === "row" ? "claims sessions" : "makes its tables"} cannot start on it. Point the DSN at the primary.`,
				);
			}
			if (!this.#createTable) {
				await this.#assertSchema();
				await this.#checkTables();
				await this.#checkLockSyntax();
				return;
			}
			// Every table first, in one step (see #createTables). The lease table
			// is made here with the others, by the same login, whether or not this
			// store claims: never at a first claim.
			const lease = this.#q.lease;
			const indexMade = await this.#createTables(look);
			// Probe before altering: PostgreSQL's ALTER TABLE waits for every open
			// transaction on the table even when the column exists. PostgreSQL also
			// checks that the caller owns the table before it reads IF NOT EXISTS, so
			// a login that does not own the lease table (an external migration's
			// owner made it) may not run even a no-op CREATE INDEX: look first, in
			// the same read. The look is by catalog, not by name: IF NOT EXISTS skips
			// when anything holds the name, so an index of another table, or a
			// table, under it would leave the lease table without one. #checkTables
			// then refuses whatever holds the name.
			const createIndex = indexMade ? undefined : lease?.createIndex;
			const { columns, holder } = await this.#read("open", async executor => ({
				columns: new Set(
					((await run(executor, this.#q.columns, { table: this.#relation(this.#table) })) as ColumnRow[]).map(
						row => row.column_name.toLowerCase(),
					),
				),
				holder: createIndex ? await this.#holderIndex(executor) : undefined,
			}));
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
			if ((await this.#readOne("open", this.#q.findUnmeasured)).length > 0) {
				await this.#setup(this.#q.backfillByteLen);
			}
			if (createIndex && holder && !holder.indexed && !holder.nameTakenBy) await this.#setup(createIndex);
			await this.#checkTables();
			await this.#checkLockSyntax();
		});
	}

	/**
	 * Register a claim of `sessionId` at `file` and start its claim statement
	 * unless this store already claimed the session; `null` when a SQLite
	 * claim's OS lock is held by another process. `onLost` is called when the
	 * claim is found lost, at once when it already is.
	 */
	claim(
		sessionId: string,
		file: string,
		onLost: (() => void) | undefined,
		lockBoundMs = LEASE_CLAIM_LOCK_BOUND_MS,
	): LeaseClaim | null {
		const leaseId = sessionLeaseId(file) ?? sessionId;
		let claim = this.#leases.get(leaseId);
		if (!claim) {
			let lock: SqliteLock | undefined;
			if (this.#gate === "lock") {
				const taken = this.#takeSqliteLock(leaseId);
				if (taken === null) return null;
				lock = taken;
			}
			claim = {
				sessionId: leaseId,
				paths: new Map(),
				headers: new Map(),
				refs: 0,
				state: "pending",
				foreign: false,
				attempt: undefined,
				heldRound: 0,
				validUntil: Number.POSITIVE_INFINITY,
				lockBoundMs: Math.max(1, Math.ceil(lockBoundMs)),
				lock,
				after: this.#releases.get(leaseId),
				listeners: new Set(),
			};
			this.#leases.set(leaseId, claim);
			if (this.#gate === "row") {
				this.#startHeartbeat();
				this.#armExitRelease();
			}
			const started = claim;
			void this.#ensureClaimed(started).catch(err => {
				// The first write under the claim runs the statement again and reports its failure.
				logger.debug("SqlSessionStorage could not claim a session", {
					sessionId: started.sessionId,
					error: toError(err).message,
				});
			});
		}
		claim.paths.set(file, (claim.paths.get(file) ?? 0) + 1);
		claim.headers.set(file, sessionId);
		this.#leasedPaths.set(file, claim);
		claim.refs++;
		if (onLost) {
			claim.listeners.add(onLost);
			if (claim.state === "lost") queueMicrotask(onLost);
		}
		return claim;
	}

	/**
	 * Claim `sessionId` at `file` and wait for the answer: the claim when it
	 * is held, `null` when `file` holds another session or another holder has
	 * the session. With `waitMs`, a holder's lease is read again every second
	 * until it is gone or expired on the database clock, `onWait` hearing the
	 * holder once, and the session claimed then, all within `waitMs`: a claim
	 * statement that waited past its lock bound behind another process's
	 * write is refused, and tried again only while the wait lasts. A claim
	 * statement that fails for another reason (the database is unreachable)
	 * counts as held, as a file claim that cannot be probed does: it never
	 * refuses a session, and the first write under it runs the statement again.
	 */
	async acquire(
		sessionId: string,
		file: string,
		options: SessionAcquireOptions,
		settle: (paths: readonly string[]) => Promise<void>,
	): Promise<LeaseClaim | null> {
		const deadline = performance.now() + (options.waitMs ?? 0);
		let waiting = false;
		for (;;) {
			const lockBound = options.waitMs === undefined ? LEASE_CLAIM_LOCK_BOUND_MS : deadline - performance.now();
			const claim = this.claim(sessionId, file, options.onLost, lockBound);
			if (!claim) return null;
			try {
				if (await this.#ensureClaimed(claim)) return claim;
			} catch (err) {
				logger.debug("SqlSessionStorage could not claim a session", { sessionId, error: toError(err).message });
				return claim;
			}
			// Refused: drop this registration; a later claim starts a statement of its own.
			// A claim another caller of this store still shares stays lost until they release it.
			const shared = claim.refs > 1;
			this.release(claim, file, options.onLost, settle);
			await this.#releases.get(claim.sessionId);
			if (shared || claim.foreign || options.waitMs === undefined || this.#gate !== "row") return null;
			let holder: LeaseProbeRow | undefined;
			try {
				holder = (await this.#probeLease(claim.sessionId))[0];
			} catch (err) {
				logger.debug("SqlSessionStorage could not read a session lease", {
					sessionId,
					error: toError(err).message,
				});
				return null;
			}
			const remaining = deadline - performance.now();
			// A claim refused behind a lock (a holder's write in flight) finds the
			// lease stale or gone and tries again, but only while the wait lasts.
			if (!holder || rowNumber(holder.stale) === 1) {
				if (remaining <= 0) return null;
				continue;
			}
			if (remaining <= 0) return null;
			if (!waiting) {
				waiting = true;
				options.onWait?.({ host: holder.host, pid: rowNumber(holder.pid) });
			}
			await Bun.sleep(Math.min(LEASE_WAIT_POLL_MS, remaining));
		}
	}

	/**
	 * Drop one reference to `claim`, made at `file`. Where other references
	 * to the claim remain and this was the last one made at `file`, the path
	 * leaves the claim at once: a write still queued there is fenced by the
	 * session its name belongs to (see {@link sessionLeaseId}), which for a
	 * subagent transcript under the session's artifacts directory is this
	 * same claim. The last reference waits until `settle` reports this
	 * store's queued writes under the claim settled, then deletes the lease
	 * row this store holds (or releases the SQLite lock), unless a new claim
	 * revived it meanwhile; `drain()` waits for that delete, so a clean exit
	 * frees the session at once.
	 *
	 * The release callback itself never waits. `SessionManager.close()` gives
	 * its claim up before it drains, so writes are still queued, and some in
	 * flight hold the lease row share-locked: a delete it waited for at once
	 * would wait on this process's own open transactions, and a delete made
	 * before the queued writes ran would have the fence refuse them.
	 */
	release(
		claim: LeaseClaim,
		file: string,
		onLost: (() => void) | undefined,
		settle: (paths: readonly string[]) => Promise<void>,
	): void {
		if (onLost) claim.listeners.delete(onLost);
		const count = (claim.paths.get(file) ?? 1) - 1;
		if (count > 0) claim.paths.set(file, count);
		else {
			claim.paths.delete(file);
			claim.headers.delete(file);
		}
		if (--claim.refs > 0) {
			if (count <= 0 && this.#leasedPaths.get(file) === claim) this.#leasedPaths.delete(file);
			return;
		}
		const { sessionId } = claim;
		const previous = this.#releases.get(sessionId) ?? Promise.resolve();
		const released = previous
			.then(async () => {
				// The claim's paths stay fenced while their queued writes settle.
				await settle([...new Set([file, ...claim.paths.keys()])]);
				if (claim.refs > 0 || this.#leases.get(sessionId) !== claim) return;
				this.#leases.delete(sessionId);
				for (const [leased, owner] of this.#leasedPaths) {
					if (owner === claim) this.#leasedPaths.delete(leased);
				}
				this.#stopHeartbeatIfIdle();
				if (claim.lock) {
					this.#releaseSqliteLock(claim.lock);
					return;
				}
				const held = await (claim.attempt ?? Promise.resolve(false)).catch(() => false);
				const lease = this.#q.lease;
				if (!held || claim.state === "lost" || !lease) return;
				// The database gives the delete up after 2 s (see #deleteLease); this
				// stops waiting shortly after, should the database not answer at all.
				// Either way the unrefreshed row expires on its own.
				const outcome = await withinBound(
					this.#deleteLease(lease, sessionId),
					LEASE_RELEASE_BOUND_MS + LEASE_RELEASE_GRACE_MS,
				);
				if (outcome === "timeout") {
					logger.warn("SqlSessionStorage stopped waiting to release a session lease; it expires on its own", {
						sessionId,
					});
				}
			})
			.catch(err => {
				// The row expires on its own once its heartbeat stops.
				logger.warn("SqlSessionStorage could not release a session lease", {
					sessionId,
					error: toError(err).message,
				});
			});
		this.#releases.set(sessionId, released);
		void released.finally(() => {
			if (this.#releases.get(sessionId) === released) this.#releases.delete(sessionId);
			if (this.#leases.size === 0 && this.#releases.size === 0) {
				this.#cancelExitRelease?.();
				this.#cancelExitRelease = undefined;
			}
		});
	}

	/** How the store waits for its queued writes under a claim, for {@link #releaseAtExit}. */
	bindExitSettle(settle: (paths: readonly string[]) => Promise<void>): void {
		this.#exitSettle = settle;
	}

	/**
	 * Register, once while this store holds a lease row, the release a signal or exit runs: whatever took the
	 * lease (an opened session, a subagent's, a delete, a rename, a move's destination) may never reach the release
	 * it owns, since a signal ends the process from postmortem without running a `finally`. The callback is
	 * `afterOthers`, so the modes' own teardowns, which dispose their sessions (`session_shutdown`, then the
	 * manager's close, which releases its claim), run first and their writes keep the lease; it finds those claims
	 * released and gives back only what is still held. Its `deadlineMs` is the release's own bound: the pass waits
	 * that long for it once the others settle, also past postmortem's 10 s deadline when another callback's
	 * `deadlineMs` held the pass open that long. When another callback never settles, it does not start: a release
	 * before that callback (a mode's dispose) settled would let it write after the release, so the row stays and
	 * expires. `exitOnly`: a keep-alive cleanup releases nothing.
	 */
	#armExitRelease(): void {
		if (this.#cancelExitRelease) return;
		this.#cancelExitRelease = postmortem.register("sql-session-leases", () => this.releaseHeld(), {
			exitOnly: true,
			afterOthers: true,
			deadlineMs: LEASE_RELEASE_BOUND_MS + LEASE_RELEASE_GRACE_MS,
		});
	}

	/**
	 * Release every claim this store still holds, however many references its holders keep: at exit (the postmortem
	 * callback {@link #armExitRelease} registers), and before an exclusive stop's `process.exit` (the facade's
	 * `releaseHeldClaims`). Each release waits for the store's queued writes under the claim, then deletes the lease
	 * row within the release bound, and logs a release that fails or is not answered (the row then expires on its
	 * own). Entries a session manager holds but never handed to the store are not written.
	 */
	async releaseHeld(): Promise<void> {
		const settle = this.#exitSettle ?? (async () => {});
		for (const claim of [...this.#leases.values()]) {
			// A claim whose last reference is gone is releasing already.
			if (claim.refs <= 0) continue;
			const [file] = claim.paths.keys();
			if (file === undefined) continue;
			claim.listeners.clear();
			claim.refs = 1;
			this.release(claim, file, undefined, settle);
		}
		await this.releasesSettled();
	}

	/**
	 * Delete this store's lease row of `sessionId`, which the database gives up
	 * after {@link LEASE_RELEASE_BOUND_MS} (waiting on another transaction's
	 * lock of the row, a stalled server): PostgreSQL's `statement_timeout` set
	 * for this transaction alone; on MySQL and MariaDB a `NOWAIT` lock of the
	 * row first, the whole transaction run again from its start while that
	 * lock is refused within the bound (see {@link retryLockRefusals}), so the
	 * delete itself never waits. A delete given up rolls back and rejects.
	 */
	async #deleteLease(lease: LeaseQueries, sessionId: string): Promise<void> {
		const values = { sid: sessionId, holder: this.#holder };
		if (this.#adapter === "postgres") {
			await this.#postgres("release", "write", async transaction => {
				await transaction.unsafe(`SET LOCAL statement_timeout = ${LEASE_RELEASE_BOUND_MS}`);
				await run(transaction, lease.release, values);
			});
			return;
		}
		const releaseLock = this.#mysqlForms(lease).releaseLock;
		await retryLockRefusals(LEASE_RELEASE_BOUND_MS, () =>
			this.#client.transaction(async transaction => {
				await run(transaction, releaseLock, values);
				await run(transaction, lease.release, values);
			}),
		);
	}

	/** Resolve once every claim release in flight has finished. */
	async releasesSettled(): Promise<void> {
		while (this.#releases.size > 0) await Promise.allSettled(this.#releases.values());
	}

	/** Whether this store's claim on the lease `leaseId` (see {@link sessionLeaseId}) is lost to another holder. */
	claimLost(leaseId: string): boolean {
		return this.#leases.get(leaseId)?.state === "lost";
	}

	/** The process that holds `sessionId`'s lease now, as its row names it. */
	async claimHolder(sessionId: string): Promise<SessionClaimHolder | undefined> {
		try {
			const [row] = await this.#probeLease(sessionId);
			return row ? { host: row.host, pid: rowNumber(row.pid) } : undefined;
		} catch (err) {
			logger.debug("SqlSessionStorage could not read a session lease", { sessionId, error: toError(err).message });
			return undefined;
		}
	}

	/** Take the SQLite OS lock of `sessionId`, or share this process's; `null` while another process holds it. */
	#takeSqliteLock(sessionId: string): SqliteLock | null {
		const key = `${sqliteFileIdentity(this.#sqliteFile ?? "", false)}\n${sessionId}`;
		let lock = sqliteLocks.get(key);
		if (!lock) {
			let lease: FileLockHandle | null;
			try {
				lease = tryAcquireSessionLease(key);
			} catch (err) {
				// As a file claim that cannot be probed: counts as held, guards nothing.
				logger.debug("SqlSessionStorage could not take a session lock", { sessionId, error: toError(err).message });
				lease = { release: () => {} };
			}
			if (!lease) return null;
			lock = { key, lease, holders: 0 };
			sqliteLocks.set(key, lock);
		}
		lock.holders++;
		return lock;
	}

	#releaseSqliteLock(lock: SqliteLock): void {
		if (--lock.holders > 0) return;
		if (sqliteLocks.get(lock.key) === lock) sqliteLocks.delete(lock.key);
		lock.lease.release();
	}

	/** Whether `claim` holds its session, running its claim statement first when it has not answered. */
	#ensureClaimed(claim: LeaseClaim): Promise<boolean> {
		if (claim.state !== "pending") return Promise.resolve(claim.state === "held");
		claim.attempt ??= this.#runClaim(claim).then(
			held => {
				if (claim.state === "pending") {
					claim.heldRound = this.#heartbeatRound;
					if (held) claim.state = "held";
					else this.#markLost(claim);
				}
				return claim.state === "held";
			},
			(err: unknown) => {
				claim.attempt = undefined;
				throw err;
			},
		);
		return claim.attempt;
	}

	/**
	 * Run `claim`'s statement: `false` when one of its paths holds another
	 * session (marked `foreign`), else insert the lease row or take it over
	 * when its heartbeat expired or this store holds it. A SQLite claim holds
	 * its OS lock already. PostgreSQL claims in one statement, behind the
	 * session's exclusive advisory lock (see `claimLock`); MySQL locks the row
	 * in a transaction, since it assigns `ON DUPLICATE KEY UPDATE` values left
	 * to right and could not test the old holder after replacing it. Every
	 * lock wait is bounded (the claim's `lockBoundMs`, see
	 * {@link LEASE_CLAIM_LOCK_BOUND_MS}): a claim that waited that long behind
	 * another transaction (the holder's write in flight) is refused, the
	 * session held by that process.
	 */
	async #runClaim(claim: LeaseClaim): Promise<boolean> {
		await claim.after;
		for (const file of claim.paths.keys()) {
			const [head] = await this.readSlices(file, SESSION_HEADER_PREFIX_BYTES, 0).catch((err: unknown) => {
				// On PostgreSQL only a path with no session row yet has no header; any other failed read fails the claim.
				if (this.#adapter === "postgres" && !isEnoent(err)) throw err;
				return [""];
			});
			const id = headerSessionId(head ?? "");
			if (id !== undefined && id !== (claim.headers.get(file) ?? claim.sessionId)) {
				claim.foreign = true;
				return false;
			}
		}
		const lease = this.#q.lease;
		if (!lease) return true;
		const values = { sid: claim.sessionId, holder: this.#holder, host: os.hostname(), pid: process.pid };
		const sentAt = performance.now();
		let held = false;
		try {
			if (this.#adapter === "postgres") {
				await this.#postgres("claim", "write", async transaction => {
					await transaction.unsafe(`SET LOCAL lock_timeout = ${claim.lockBoundMs}`);
					if (lease.claimLock) await run(transaction, lease.claimLock, values);
					held = (await run(transaction, lease.claim, values)).length > 0;
				});
			} else {
				for (let attempt = 1; ; attempt++) {
					try {
						// A refused lock read throws the transaction away and runs it again within the claim's bound.
						await retryLockRefusals(claim.lockBoundMs, deadline =>
							this.#client.transaction(async transaction => {
								held = false;
								const [row] = (await this.#lockingRead(transaction, "lock", values)) as LeaseLockRow[];
								if (row && row.holder !== this.#holder && rowNumber(row.stale) !== 1) return;
								// MariaDB's insert waits at most what is left of the bound.
								const insert =
									this.#mysqlLocks === "mariadb" && lease.insertWithin
										? lease.insertWithin(Math.max(0, deadline - performance.now()) / 1000)
										: lease.insert;
								await run(transaction, row ? lease.take : insert, values);
								held = true;
							}),
						);
						break;
					} catch (err) {
						// Two claims of a missing row both insert: one deadlocks or meets the other's row, and runs again.
						if (attempt >= WRITE_ATTEMPTS || !(isDeadlockError(err) || isPrimaryKeyViolation(err))) throw err;
						held = false;
						await Bun.sleep(Math.random() * 20 * attempt);
					}
				}
			}
		} catch (err) {
			if (!isLockTimeoutError(err)) throw err;
			// Another transaction holds the lease row (or the session's lock) for longer than a claim waits: its process holds the session.
			logger.debug("SqlSessionStorage claim waited past its lock bound", { sessionId: claim.sessionId });
			return false;
		}
		if (held) claim.validUntil = sentAt + this.#expiryMs - this.#heartbeatMs;
		return held;
	}

	/** Mark `claim` lost, once, and tell every caller under it. */
	#markLost(claim: LeaseClaim): void {
		if (claim.state === "lost") return;
		claim.state = "lost";
		logger.warn(
			claim.foreign ? "Session path holds another session; not claimed" : "Session claim lost to another process",
			{ sessionId: claim.sessionId, leaseTable: this.#leaseTable },
		);
		for (const listener of claim.listeners) queueMicrotask(listener);
	}

	#startHeartbeat(): void {
		if (this.#heartbeat) return;
		this.#heartbeat = setInterval(() => void this.#beat(), this.#heartbeatMs);
		this.#heartbeat.unref();
	}

	#stopHeartbeatIfIdle(): void {
		if (this.#leases.size > 0 || !this.#heartbeat) return;
		clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
	}

	/**
	 * Refresh the lease rows of every claim this store still holds, in one
	 * statement, and no other row of its: a row whose release gave up (see
	 * {@link release}) is left to expire instead of staying held while the
	 * store lives. On PostgreSQL a heartbeat is a write of {@link #postgres}
	 * from its first try, so the read-only check refuses it as it refuses every
	 * write; then one message sets its lock and idle-in-transaction bounds with
	 * `SET LOCAL` (see {@link LEASE_HEARTBEAT_TRANSACTION_BOUND_MS}), so no
	 * session setting crosses a transaction-mode pool, and the update binds
	 * the holder token and the session ids. Its row locks can last through the
	 * runner's COMMIT round trip, but the server ends a stalled transaction
	 * 1.5 s before a fence would mark its claim lost. A heartbeat whose
	 * transaction or COMMIT answer is lost (the server ended a stalled one, and
	 * the runner closed its connection) is a failed beat: it leaves every claim
	 * as it is until another database answer proves it held or lost, and the
	 * next beat runs on a new connection.
	 */
	async #beat(): Promise<void> {
		const lease = this.#q.lease;
		if (this.#beating || !lease) return;
		const live = [...this.#leases.values()].filter(claim => claim.state === "held");
		if (live.length === 0) return;
		this.#beating = true;
		const round = ++this.#heartbeatRound;
		const sentAt = performance.now();
		try {
			const values: Record<string, string> = { holder: this.#holder };
			for (const [index, claim] of live.entries()) values[`sid${index}`] = claim.sessionId;
			let refreshed: Array<{ session_id: string }> = [];
			if (this.#adapter === "postgres") {
				refreshed = await this.#postgres("heartbeat", "write", async transaction => {
					await transaction.unsafe(
						`SET LOCAL lock_timeout = ${LEASE_HEARTBEAT_TRANSACTION_BOUND_MS}; ` +
							`SET LOCAL idle_in_transaction_session_timeout = ${LEASE_HEARTBEAT_TRANSACTION_BOUND_MS}`,
					);
					return (await run(transaction, lease.heartbeat(live.length), values)) as Array<{ session_id: string }>;
				});
			} else {
				// Two statements on their own, in no transaction: a lock wait timeout of the update (with
				// `innodb_rollback_on_timeout` ON or OFF) fails this heartbeat alone, and leaves no transaction
				// for the read after it to run outside. The read takes no lock.
				await run(this.#client, lease.heartbeat(live.length), values);
				refreshed = (await run(this.#client, lease.heldBy(live.length), values)) as Array<{ session_id: string }>;
			}
			const alive = new Set(refreshed.map(row => row.session_id));
			const validUntil = sentAt + this.#expiryMs - this.#heartbeatMs;
			for (const claim of this.#leases.values()) {
				if (claim.state !== "held" || claim.heldRound >= round) continue;
				if (alive.has(claim.sessionId)) claim.validUntil = Math.max(claim.validUntil, validUntil);
				else this.#markLost(claim);
			}
		} catch (err) {
			logger.debug("SqlSessionStorage lease heartbeat failed", { error: toError(err).message });
		} finally {
			this.#beating = false;
		}
	}

	/**
	 * The lease's locking read `which`, once: on MySQL and MariaDB its `NOWAIT`
	 * form, whose refusal the caller answers by throwing the whole transaction
	 * away (see {@link retryLockRefusals}); on PostgreSQL the fence's read,
	 * whose wait the transaction's `lock_timeout` bounds (PostgreSQL claims in
	 * one statement, and takes no `lock`).
	 */
	#lockingRead(
		executor: SqlSessionStorageTransaction,
		which: "lock" | "held" | "foreign",
		values: StatementValues,
	): Promise<SqlSessionStorageResult> {
		const lease = this.#q.lease;
		if (!lease) throw new Error("SqlSessionStorage: a locking read of a lease without a lease table");
		if (this.#adapter === "mysql") return run(executor, this.#mysqlForms(lease)[which], values);
		if (which === "lock")
			throw new Error("SqlSessionStorage: PostgreSQL claims in one statement, with no lease lock");
		return run(executor, lease[which], values);
	}

	/** This MySQL-family server's lease locks; start-up refused a claiming store on a server that has none. */
	#mysqlForms(lease: LeaseQueries): NonNullable<LeaseQueries["nowait"]>[MysqlLockForm] {
		if (!this.#mysqlLocks || !lease.nowait) {
			throw new Error("SqlSessionStorage: a MySQL lease lock before start-up found how the server bounds one");
		}
		return lease.nowait[this.#mysqlLocks];
	}

	#probeLease(sessionId: string): Promise<LeaseProbeRow[]> {
		const lease = this.#q.lease;
		if (!lease) return Promise.resolve([]);
		return this.#readOne("claimHolder", lease.probe, { sid: sessionId }) as Promise<LeaseProbeRow[]>;
	}

	/**
	 * The lease each of `files` is written under, once each: this store's
	 * claim on the path, else the session the path belongs to by its name (see
	 * {@link sessionLeaseId}), which this store may hold no claim on. A path
	 * with neither (no session's file or artifact) is under no lease.
	 */
	#fencesOf(files: readonly string[]): LeaseFence[] {
		const fences: LeaseFence[] = [];
		for (const file of files) {
			const claim = this.#leasedPaths.get(path.resolve(file));
			const sessionId = claim?.sessionId ?? sessionLeaseId(file);
			if (sessionId === undefined || fences.some(fence => fence.sessionId === sessionId)) continue;
			fences.push({ claim: claim ?? this.#leases.get(sessionId), sessionId, file });
		}
		return fences;
	}

	/**
	 * Before a write's transaction: wait for each claim's statement, refusing
	 * a claim another holder has; then, while a claim is lapsed (its last
	 * answered heartbeat too old to prove it), wait for the next one to be
	 * answered, at most one expiry. A longer wait would hold the write for an
	 * outage; past it the write runs, and the lease row it checks decides.
	 */
	async #awaitClaims(fences: readonly LeaseFence[]): Promise<void> {
		for (const { claim, file } of fences) {
			if (!claim) continue;
			if (!(await this.#ensureClaimed(claim))) throw new SessionLeaseLostError(file, claim.sessionId);
			if (this.#gate !== "row") continue;
			const until = performance.now() + this.#expiryMs;
			while (claim.state === "held" && performance.now() > claim.validUntil && performance.now() < until) {
				await Bun.sleep(LAPSE_POLL_MS);
			}
			if (claim.state === "lost") throw new SessionLeaseLostError(file, claim.sessionId);
		}
	}

	/**
	 * Run `work` in a write transaction behind the database fence, the first
	 * statements of the transaction: refuse the write unless this store's
	 * lease row of each claim is still there, and, for a session this store
	 * holds no claim on, unless no other holder's lease of it is fresh. A
	 * claimed row stays share-locked until the write commits, so a takeover's
	 * update of it waits for the write, and its new holder sees it. A session
	 * this store holds no claim on is share-locked too: on MySQL its missing
	 * row's gap, on PostgreSQL the session's advisory lock (see `fenceLock`),
	 * so a claim of it waits for the write and the write never lands after the
	 * claim. A fence waits at most {@link LEASE_FENCE_LOCK_BOUND_MS} for
	 * another transaction's lock (a takeover in flight), then refuses the
	 * write: another process holds the session. On MySQL and MariaDB a fence
	 * read refused by another transaction's lock throws the whole transaction
	 * away, and the write runs again from its start within that bound, so no
	 * statement of the write ever runs after a refusal in the same
	 * transaction, which MariaDB with `innodb_rollback_on_timeout` ON has
	 * already rolled back (see {@link retryLockRefusals}). PostgreSQL's fence
	 * reads wait within its `lock_timeout`, in one attempt. A SQLite claim has
	 * no lease row: `BEGIN IMMEDIATE` already keeps every other writer out,
	 * and its OS lock keeps every other claimant.
	 */
	async #fencedTransaction(
		operation: PgOperation,
		fences: readonly LeaseFence[],
		work: (transaction: SqlSessionStorageTransaction) => Promise<void>,
	): Promise<void> {
		const lease = this.#q.lease;
		if (!lease || this.#gate !== "row" || fences.length === 0) return this.#transaction(operation, work);
		const deadline = performance.now() + LEASE_FENCE_LOCK_BOUND_MS;
		for (;;) {
			try {
				await this.#transaction(operation, async transaction => {
					await this.#runFences(transaction, lease, fences, deadline);
					await work(transaction);
				});
				return;
			} catch (err) {
				if (!(err instanceof FenceLockRefused)) throw err;
				await Bun.sleep(NOWAIT_RETRY_MS);
			}
		}
	}

	/**
	 * The fence statements of {@link #fencedTransaction}. On PostgreSQL they alone
	 * run under the fence's lock bound: `SET LOCAL lock_timeout` sets it before
	 * them and sets it back `TO DEFAULT` after them, the value the opening gave
	 * the transaction (the login's, the database's or the server's), so the
	 * write that follows waits as that default says. On MySQL and MariaDB a
	 * refused read before `deadline` throws {@link FenceLockRefused}, so the
	 * caller runs the whole transaction again; one at or past it refuses the write.
	 */
	async #runFences(
		transaction: SqlSessionStorageTransaction,
		lease: LeaseQueries,
		fences: readonly LeaseFence[],
		deadline: number,
	): Promise<void> {
		const postgres = this.#adapter === "postgres";
		if (postgres) await transaction.unsafe(`SET LOCAL lock_timeout = ${LEASE_FENCE_LOCK_BOUND_MS}`);
		for (const { claim, sessionId, file } of fences) {
			const values = { sid: sessionId, holder: this.#holder };
			try {
				if (claim) {
					if ((await this.#lockingRead(transaction, "held", values)).length > 0) continue;
				} else {
					if (lease.fenceLock) await run(transaction, lease.fenceLock, values);
					if ((await this.#lockingRead(transaction, "foreign", values)).length === 0) continue;
				}
			} catch (err) {
				if (!isLockTimeoutError(err)) throw err;
				// Nothing more runs in this transaction: MariaDB may have rolled it back already.
				if (!postgres && performance.now() < deadline) throw new FenceLockRefused(err);
				logger.debug("SqlSessionStorage fence waited past its lock bound", { sessionId });
			}
			if (claim) this.#markLost(claim);
			throw new SessionLeaseLostError(file, sessionId);
		}
		if (postgres) await transaction.unsafe("SET LOCAL lock_timeout TO DEFAULT");
	}

	/**
	 * After a move: the claim that holds `src` now covers `dst`. A path its
	 * claim no longer holds (released, its claim's last release settling)
	 * leaves the claim instead, and `dst` is left under no claim of this store's.
	 */
	#moveLease(src: string, dst: string): void {
		const from = path.resolve(src);
		const to = path.resolve(dst);
		const claim = this.#leasedPaths.get(from);
		if (!claim) return;
		this.#leasedPaths.delete(from);
		const count = claim.paths.get(from);
		if (count === undefined) return;
		const header = claim.headers.get(from);
		claim.paths.delete(from);
		claim.headers.delete(from);
		claim.paths.set(to, (claim.paths.get(to) ?? 0) + count);
		if (header !== undefined) claim.headers.set(to, header);
		this.#leasedPaths.set(to, claim);
	}

	/**
	 * Make whichever of the store's tables are missing, and the lease
	 * table's holder index with a lease table this start-up makes; returns
	 * whether it made that index. On PostgreSQL one look at which tables exist
	 * goes first, outside any lock: when all of them do, nothing more runs, so a
	 * store starting on made tables never queues on the database-wide start-up
	 * lock (see {@link #setup}), where a busy database makes every turn slow.
	 * Else one start-up transaction takes that lock, looks again under it
	 * (another store may have made them meanwhile), and makes what is still
	 * missing in one round trip. The index goes with the lease table only when
	 * this transaction makes that table, so this login owns it; on a lease
	 * table that was there, init looks for the index first. The look (init's,
	 * `look`) also reads the connection's read-only default, and refuses to
	 * start on one the session keeps, as a write would (see
	 * {@link #postgres}), though it makes nothing. On MySQL and SQLite each
	 * table is made on its own, as before.
	 */
	async #createTables(look: TablesPresentRow | undefined): Promise<boolean> {
		const lease = this.#q.lease;
		if (this.#adapter !== "postgres") {
			await this.#setup(this.#q.createTable);
			await this.#setup(this.#q.createPartsTable);
			await this.#setup(this.#q.createBlobsTable);
			await this.#setup(this.#q.createRefsTable);
			if (this.#q.createRefsIndex) await this.#setup(this.#q.createRefsIndex);
			if (lease) await this.#setup(lease.createTable);
			return false;
		}
		if (look?.read_only_setting === "on" && look.read_only_reset_val === "on") throw new Error(READ_ONLY_REFUSAL);
		if (look?.session && look.parts && look.lease && look.blobs && look.refs) {
			return false;
		}
		let indexMade = false;
		await this.#postgres("open", "start-up", async transaction => {
			const [now] = (await run(transaction, PG_TABLES_PRESENT, this.#pgTableNames())) as TablesPresentRow[];
			const missing: string[] = [];
			if (!now?.session) missing.push(this.#q.createTable);
			if (!now?.parts) missing.push(this.#q.createPartsTable);
			if (!now?.blobs) missing.push(this.#q.createBlobsTable);
			// The index goes with the table, so the login that makes the table owns both.
			if (!now?.refs) {
				missing.push(this.#q.createRefsTable);
				if (this.#q.createRefsIndex) missing.push(this.#q.createRefsIndex);
			}
			if (lease && !now?.lease) {
				missing.push(lease.createTable);
				if (lease.createIndex) {
					missing.push(lease.createIndex);
					indexMade = true;
				}
			}
			if (missing.length > 0) await transaction.unsafe(missing.join("; "));
		});
		return indexMade;
	}

	/** The names {@link PG_TABLES_PRESENT} looks up: the session, parts, lease, blob and reference tables (the session table without a lease table). */
	#pgTableNames(): StatementValues {
		return {
			session: this.#relation(this.#table),
			parts: this.#relation(`${this.#table}_parts`),
			lease: this.#relation(this.#q.lease ? this.#leaseTable : this.#table),
			blobs: this.#relation(`${this.#table}_blobs`),
			refs: this.#relation(`${this.#table}_refs`),
		};
	}

	/**
	 * For a MySQL-family store that claims sessions: run, once, each lock
	 * statement whose syntax only the server family the reported version
	 * names accepts, on the lease table and matching no row (MySQL 8's
	 * `FOR SHARE NOWAIT`; MariaDB's `LOCK IN SHARE MODE NOWAIT` and
	 * `SET STATEMENT`), and refuse to start, naming the version and the
	 * syntax, when the server rejects one: a server reporting another family's
	 * version (a proxy, a fork) would otherwise fail every claim and fence. A
	 * lock refusal is no syntax error: the statement parsed.
	 */
	async #checkLockSyntax(): Promise<void> {
		const lease = this.#q.lease;
		if (this.#adapter !== "mysql" || this.#gate !== "row" || !lease) return;
		const forms = this.#mysqlForms(lease);
		const none = { sid: "", holder: "" };
		const checks: Array<{ syntax: string; check: () => Promise<unknown> }> =
			this.#mysqlLocks === "mariadb"
				? [
						{ syntax: "LOCK IN SHARE MODE NOWAIT", check: () => run(this.#client, forms.held, none) },
						{
							syntax: "SET STATEMENT innodb_lock_wait_timeout = <seconds> FOR",
							check: () =>
								this.#client.unsafe(
									`SET STATEMENT innodb_lock_wait_timeout = 1 FOR SELECT holder FROM ${this.#relation(this.#leaseTable)} WHERE false`,
								),
						},
					]
				: [{ syntax: "FOR SHARE NOWAIT", check: () => run(this.#client, forms.held, none) }];
		for (const { syntax, check } of checks) {
			try {
				await check();
			} catch (err) {
				if (isLockTimeoutError(err)) continue;
				throw new Error(
					`SqlSessionStorage: the server reports version ${this.#mysqlVersion}, so claims would lock lease rows with ${syntax}, which it refuses (${toError(err).message}). Is it the server family its version names? Open the store without claims, or point the DSN at MySQL 8.0 or later or MariaDB 10.3 or later.`,
				);
			}
		}
	}

	/**
	 * Run one start-up statement of `init`. Stores that start at the same
	 * moment on a PostgreSQL database without the tables would race: two
	 * `CREATE TABLE IF NOT EXISTS` of one name both find no table, and one
	 * fails (SQLSTATE 23505, 42P07 or 42710). So there every start-up
	 * statement runs in its own start-up transaction of {@link #postgres},
	 * which takes one transaction-scoped advisory lock; they run
	 * one after another, and the lock ends with the transaction. Each
	 * statement keeps its own transaction, so a duplicate-column error still
	 * fails only its own ALTER. The tables themselves are made together, by
	 * {@link #createTables}. On MySQL and SQLite the statement runs straight
	 * on the client, outside any store transaction. On SQLite that skips the
	 * call queue, so the caller must already hold `#exclusive` (`init` does),
	 * or the statement can join another call's `BEGIN IMMEDIATE` on SQLite's
	 * one connection.
	 */
	async #setup(query: string): Promise<void> {
		if (this.#adapter !== "postgres") {
			await this.#client.unsafe(query);
			return;
		}
		await this.#postgres("open", "start-up", transaction => transaction.unsafe(query));
	}

	/**
	 * Run `work` in one PostgreSQL transaction on a connection of its own: the
	 * only way the store sends a statement on PostgreSQL, so no session
	 * setting that another client of a transaction-mode pool left on a server
	 * connection reaches one. Each attempt:
	 * 1. `reserve()` a connection.
	 * 2. The opening of `mode` ({@link #openings}) as one simple query: `BEGIN
	 *    ISOLATION LEVEL READ COMMITTED`, `READ ONLY` for a read and `READ
	 *    WRITE` otherwise, then `SET LOCAL` of every session setting the
	 *    store's statements depend on (see `sql-session-postgres-settings.ts`).
	 *    `SET LOCAL` ends with the transaction, so the store leaves nothing on
	 *    the connection either.
	 * 3. For a write, the read of `setting` and `reset_val` of
	 *    `default_transaction_read_only` ({@link READ_ONLY_SETTINGS}). A pooled
	 *    connection can carry another client's session-level
	 *    `default_transaction_read_only = on` (a transaction-mode pooler hands
	 *    one backend to many clients, and a session `SET` stays on it);
	 *    PostgreSQL then refuses every write, even `CREATE TABLE IF NOT EXISTS`
	 *    on a table that exists (SQLSTATE 25006), but honours a transaction's
	 *    own `READ WRITE`, which the opening's `BEGIN ... READ WRITE` sets,
	 *    whatever that default is. The read gives three cases:
	 *    - A session value over a default that is off (`setting` on,
	 *      `reset_val` off): the store overrides it, and `work` runs.
	 *    - A read-only default that the backend session keeps (both on): the
	 *      store honours it. The database, the role, the server or the backend
	 *      connection's start parameters set it, so it is an operator's or a
	 *      provider's decision (a provider can make a database read-only when
	 *      its disk is nearly full). The transaction fails with
	 *      {@link READ_ONLY_REFUSAL} before `work` runs, with nothing written.
	 *    - A session that turned such a default off (`setting` off,
	 *      `reset_val` on): `work` runs, as it did before the store read this
	 *      setting.
	 *    A transaction-mode pooler applies a client's start parameters and its
	 *    `connect_query` to the backend with `SET`, so the store overrides them
	 *    like any session value. Any other answer, no row included, lets
	 *    `work` run. At start-up (see `#setup`) the start-up advisory lock
	 *    comes after the read, so an honoured default refuses before any
	 *    wait. The opening's `READ COMMITTED`, set in `BEGIN` before the read,
	 *    holds whatever `default_transaction_isolation` is: under
	 *    `repeatable read` a start-up transaction's snapshot would be taken
	 *    before its lock wait, and a backfill would then fail with SQLSTATE
	 *    40001.
	 * 4. `work`, on the reserved connection alone.
	 * 5. `COMMIT`, then `release()`. A `COMMIT` that answers `ROLLBACK` fails
	 *    with an error naming `operation`.
	 *
	 * A failure:
	 * - Repairless: an error in answer to the opening (a pooler's own refusal
	 *   included), a connection that ended before that answer, or SQLSTATE
	 *   25006 (`read_only_sql_transaction`) or 42501 (`insufficient_privilege`)
	 *   from a later statement: the connection carries something no
	 *   transaction sets back (`cloudsql_session_read_only = locked`, a `SET
	 *   SESSION AUTHORIZATION`). The store sends no `ROLLBACK`, closes the
	 *   connection, so no caller gets it again, writes
	 *   {@link PG_REPAIR_WARNING}, and runs the attempt again on a new one, at
	 *   most {@link PG_REPAIR_RETRIES} times. The last attempt's error is
	 *   thrown, marked for {@link repairsSpent}.
	 * - The connection ended after the opening's answer, `COMMIT` included:
	 *   the store closes it and throws, and runs nothing again, since whether
	 *   `work` committed is unknown and an append is not idempotent.
	 * - Any other error, `work`'s own included: `ROLLBACK`, `release()`, and
	 *   the error thrown. When the `ROLLBACK` fails, the store closes the
	 *   connection and throws the first error.
	 * - A refused `reserve()` is thrown as it is.
	 * `work` must never wait for another transaction of this store: in a pool
	 * of one server connection it would wait for its own.
	 */
	async #postgres<T>(
		operation: PgOperation,
		mode: "read" | "write" | "start-up",
		work: (transaction: SqlSessionStorageTransaction) => Promise<T>,
	): Promise<T> {
		const opening = mode === "read" ? this.#openings.read : this.#openings.write;
		for (let attempt = 1; ; attempt++) {
			const reserving = this.#client.reserve?.();
			if (!reserving) throw new Error(PG_NO_RESERVE);
			const reserved = await reserving;
			let opened = false;
			let result: T;
			let committed: SqlSessionStorageResult;
			try {
				await reserved.unsafe(opening);
				opened = true;
				if (mode !== "read") {
					const [readOnly] = (await reserved.unsafe(READ_ONLY_SETTINGS)) as ReadOnlySettingsRow[];
					if (readOnly?.setting === "on" && readOnly.reset_val === "on") throw new Error(READ_ONLY_REFUSAL);
					if (mode === "start-up") await reserved.unsafe(`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
				}
				result = await work(reserved);
				committed = await reserved.unsafe("COMMIT");
			} catch (err) {
				const sqlstate = pgSqlstate(err);
				if (!opened || sqlstate === "25006" || sqlstate === "42501") {
					await reserved.close();
					logger.warn(PG_REPAIR_WARNING, {
						operation,
						sqlstate: sqlstate ?? pgErrorCode(err),
						message: toError(err).message,
						attempt,
					});
					if (attempt <= PG_REPAIR_RETRIES) continue;
					if (typeof err === "object" && err !== null) this.#spentRepairs.add(err);
					throw err;
				}
				if (pgErrorCode(err) === "ERR_POSTGRES_CONNECTION_CLOSED") {
					await reserved.close();
					throw err;
				}
				try {
					await reserved.unsafe("ROLLBACK");
				} catch {
					await reserved.close();
					throw err;
				}
				await reserved.release();
				throw err;
			}
			await reserved.release();
			if (committed.command === "ROLLBACK") {
				throw new Error(
					`SqlSessionStorage: PostgreSQL rolled back the ${operation} transaction; its COMMIT answered ROLLBACK`,
				);
			}
			return result;
		}
	}

	/**
	 * Whether `err` is the error {@link #postgres} threw after its last
	 * repairless attempt. Its operation then ran on {@link PG_REPAIR_RETRIES}
	 * + 1 connections and closed each, so no retry of the store runs it
	 * again: its blob write is not tried again, and the land of that write
	 * tries no other queued blob (see {@link SqlBlobTier}). The store's other
	 * retries, a deadlock victim's and a move's key collision's, never meet
	 * such an error: PostgreSQL answers no opening with a deadlock or a key
	 * collision, and 25006, 42501 and a closed connection are neither. Only
	 * `#postgres` marks an error, so on MySQL and SQLite no error is one. The
	 * mark is on the error object as `#postgres` threw it, and each layer
	 * between it and the tier rethrows that same object: {@link #retryDeadlocks}
	 * (a marked error is no deadlock), {@link #transaction},
	 * {@link #fencedTransaction} (nor a fence refusal) and {@link insertBlob}.
	 * The tier reads the mark on the runner's own error, which its blob write
	 * rethrows as it is, and only then wraps that error, as the cause, in the
	 * blob's failure.
	 */
	repairsSpent(err: unknown): boolean {
		return typeof err === "object" && err !== null && this.#spentRepairs.has(err);
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
	 * wait (busy timeout) or fail before anything ran. On PostgreSQL it is a
	 * write of {@link #postgres}. On PostgreSQL and MySQL a
	 * transaction the database aborts as a deadlock victim runs again; each
	 * one recomputes everything under its own locks. A refused read-only
	 * default is no deadlock and does not run again.
	 */
	#transaction(
		operation: PgOperation,
		work: (transaction: SqlSessionStorageTransaction) => Promise<void>,
	): Promise<void> {
		if (this.#adapter === "postgres") return this.#retryDeadlocks(() => this.#postgres(operation, "write", work));
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
		const blobsTable = `${this.#table}_blobs`;
		const refsTable = `${this.#table}_refs`;
		const missing: string[] = [];
		const sessionColumns = await this.#columns(this.#table);
		if (sessionColumns.size === 0) missing.push(`table ${this.#table}`);
		else if (!sessionColumns.has("byte_len")) missing.push(`column ${this.#table}.byte_len`);
		if ((await this.#columns(partsTable)).size === 0) missing.push(`table ${partsTable}`);
		if ((await this.#columns(blobsTable)).size === 0) missing.push(`table ${blobsTable}`);
		if ((await this.#columns(refsTable)).size === 0) missing.push(`table ${refsTable}`);
		// Only a store that claims reads the lease table; one that does not, as before, needs none.
		if (this.#gate === "row" && (await this.#columns(this.#leaseTable)).size === 0) {
			missing.push(`table ${this.#leaseTable}`);
		}
		if (missing.length === 0) return;
		throw new Error(
			`SqlSessionStorage: createTable is false, but the database has no ${missing.join(" and no ")}. ` +
				`Apply the schema in ${SCHEMA_DOCS}, or let create() apply it.`,
		);
	}

	async #columns(table: string): Promise<Set<string>> {
		const rows = (await this.#read("open", executor =>
			run(executor, this.#q.columns, { table: this.#relation(table) }),
		)) as ColumnRow[];
		return new Set(rows.map(row => row.column_name.toLowerCase()));
	}

	/** `name` as the store's statements spell it: with its schema on PostgreSQL once start-up read it. */
	#relation(name: string): string {
		return this.#schema === undefined ? name : `${quoteIdentifier(this.#schema)}.${name}`;
	}

	/**
	 * Run a read: on PostgreSQL in a `READ ONLY` transaction of its own (see
	 * {@link #postgres}), as every other statement there; elsewhere straight
	 * on the client.
	 */
	async #read<T>(operation: PgOperation, work: (executor: SqlSessionStorageTransaction) => Promise<T>): Promise<T> {
		if (this.#adapter !== "postgres") return work(this.#client);
		return this.#postgres(operation, "read", work);
	}

	/** Run one read statement through {@link #read}, its values bound. */
	async #readOne(
		operation: PgOperation,
		query: Statement | string,
		values: StatementValues = {},
	): Promise<SqlSessionStorageResult> {
		const statement = typeof query === "string" ? { sql: query, params: [] } : query;
		return this.#read(operation, executor => run(executor, statement, values));
	}

	/**
	 * The lease table's holder index on PostgreSQL: whether one exists
	 * ({@link PG_HOLDER_INDEXES}), and what holds its name `<leaseTable>_holder`
	 * when that is not one of them.
	 */
	async #holderIndex(
		executor: SqlSessionStorageTransaction,
	): Promise<{ indexed: boolean; nameTakenBy: string | undefined }> {
		const table = this.#relation(this.#leaseTable);
		const indexes = new Set(
			((await run(executor, PG_HOLDER_INDEXES, { table })) as Array<{ oid: string }>).map(row => row.oid),
		);
		const [holder] = (await run(executor, PG_HOLDER_INDEX_NAME, {
			index: this.#relation(`${this.#leaseTable}_holder`),
		})) as HolderIndexNameRow[];
		const nameTakenBy =
			holder && !indexes.has(holder.oid)
				? `${PG_RELATION_KINDS[holder.kind] ?? `a relation of kind ${holder.kind}`}` +
					(holder.on_table ? ` on table ${holder.on_table}` : ` ${holder.name}`)
				: undefined;
		return { indexed: indexes.size > 0, nameTakenBy };
	}

	/**
	 * PostgreSQL: refuse to start on tables that would run code the store did
	 * not declare on its writes. A login that owned a table (before an
	 * external migration moved it to its owner) can give a column a type of its
	 * own whose assignment cast runs its function, or add a trigger, a rule, a
	 * row-level security policy, a CHECK constraint or an expression index, or
	 * make the table a partition of a table of its own whose partition key
	 * calls its function;
	 * PostgreSQL finds those through its catalogs, not through search_path, so
	 * the opening's `search_path` does not stop them. So every column must be the
	 * store's, of its declared built-in type, with no default, generation or
	 * identity, and no other column may exist: the store's inserts leave every
	 * other column to its default, which the store cannot vet cheaply, and the
	 * store reads none of them. The blob table must also have its `sha256`
	 * primary key and let this login insert: every transcript write waits for
	 * the blobs it names to land there. Runs whatever `createTable` is; a table
	 * that does not exist is `#assertSchema`'s to report, or one this store never reads.
	 */
	async #checkTables(): Promise<void> {
		if (this.#adapter !== "postgres") {
			await this.#checkKeysAndGrants();
			return;
		}
		const tables: Array<[string, Record<string, PgDeclaredType>]> = [
			[this.#table, PG_DECLARED_COLUMNS.session],
			[`${this.#table}_parts`, PG_DECLARED_COLUMNS.parts],
			[`${this.#table}_blobs`, PG_DECLARED_COLUMNS.blobs],
			[`${this.#table}_refs`, PG_DECLARED_COLUMNS.refs],
		];
		if (this.#q.lease) tables.push([this.#leaseTable, PG_DECLARED_COLUMNS.lease]);
		const problems: string[] = [];
		await this.#read("open", async executor => {
			for (const [name, declared] of tables) {
				const relation = this.#relation(name);
				const columns = (await run(executor, PG_TABLE_COLUMNS, { table: relation })) as TableColumnRow[];
				if (columns.length === 0) continue;
				const found: string[] = [];
				for (const [column, type] of Object.entries(declared)) {
					const row = columns.find(candidate => candidate.name === column);
					if (!row) found.push(`no column ${column}`);
					else if (row.type_oid !== row[`${type}_oid` as const] || Number(row.type_mod) !== -1) {
						found.push(`column ${column} of type ${row.type}, not ${type}`);
					}
				}
				for (const row of columns) {
					if (!(row.name in declared)) found.push(`column ${row.name}, which the store does not declare`);
					if (row.has_default) found.push(`a default on column ${row.name}`);
					if (row.generated !== "") found.push(`column ${row.name} generated from an expression`);
					if (row.identity !== "") found.push(`identity column ${row.name}`);
				}
				for (const object of (await run(executor, PG_TABLE_OBJECTS, { table: relation })) as TableObjectRow[]) {
					// A parent is not on the table: say what the table is, as its own problem.
					if (object.kind === "partition of" || object.kind === "inherits from") {
						const is = object.kind === "partition of" ? "is a partition of" : "inherits from";
						problems.push(`table ${relation} ${is} ${object.name}`);
						continue;
					}
					found.push(
						{
							trigger: `trigger ${object.name}`,
							rule: `rule ${object.name}`,
							policy: `row-level security policy ${object.name}`,
							"row-level security": "row-level security enabled",
							"relation kind": `relation kind ${object.name}, not an ordinary table`,
							constraint: `constraint ${object.name}, not a primary key, unique or not-null constraint`,
							index: `index ${object.name} on an expression or with a predicate`,
							inheritance: `table ${object.name} inheriting from it`,
							"referenced by": `a foreign key of table ${object.name} referencing it`,
						}[object.kind] ?? `${object.kind} ${object.name}`,
					);
				}
				const needs =
					declared === PG_DECLARED_COLUMNS.blobs
						? BLOB_TABLE_NEEDS.blobs
						: declared === PG_DECLARED_COLUMNS.refs
							? BLOB_TABLE_NEEDS.refs
							: undefined;
				if (needs) {
					const key = ((await run(executor, PG_PRIMARY_KEY, { table: relation })) as TableObjectRow[]).map(
						row => row.name,
					);
					const keyProblem = primaryKeyProblem(key, needs.key);
					if (keyProblem) found.push(keyProblem);
					for (const privilege of needs.privileges) {
						const [grant] = (await run(executor, PG_HAS_PRIVILEGE, { table: relation, privilege })) as Array<{
							can: unknown;
						}>;
						if (grant?.can !== true) found.push(`no ${privilege} privilege for the store's login`);
					}
				}
				// A delete reads a blob's references by sha256; without the index each read scans the table, under the delete's locks.
				if (declared === PG_DECLARED_COLUMNS.refs) {
					const indexes = (await run(executor, PG_RHASH_INDEXES, { table: relation })) as unknown[];
					if (indexes.length === 0) found.push("no index on column sha256");
				}
				// The lease entry by its role, not its name: a lease table that names another of the store's is one table.
				if (declared === PG_DECLARED_COLUMNS.lease) {
					const { indexed, nameTakenBy } = await this.#holderIndex(executor);
					if (nameTakenBy) {
						found.push(
							`its index name ${this.#relation(`${this.#leaseTable}_holder`)} taken by ${nameTakenBy}, ` +
								"not by an index of it on holder",
						);
					} else if (!indexed) found.push("no index on column holder");
				}
				if (found.length > 0) problems.push(`table ${relation} has ${found.join(", ")}`);
			}
		});
		if (problems.length === 0) return;
		throw new Error(
			`SqlSessionStorage: ${problems.join("; ")}. The store starts only on tables as ${SCHEMA_DOCS} gives them, ` +
				"with nothing else on them that could run code on its writes, and blob and reference tables " +
				"this login can write.",
		);
	}

	/**
	 * MySQL and SQLite: the blob and reference tables' primary keys, and on
	 * MySQL the privileges the store's blob writes and deletes need, each
	 * proved by a statement that changes no row ({@link DialectQueries.privilegeProbes}).
	 * A table without its key would take duplicate rows (MySQL) or refuse
	 * every insert (`ON CONFLICT` names the key); a missing grant would fail
	 * every write that names an image, or every session delete.
	 */
	async #checkKeysAndGrants(): Promise<void> {
		const problems: string[] = [];
		const keyQuery = this.#q.primaryKey;
		if (keyQuery) {
			for (const [suffix, needs] of Object.entries(BLOB_TABLE_NEEDS)) {
				const table = `${this.#table}_${suffix}`;
				// Start-up already holds the SQLite queue (see init), so this reads straight through.
				const rows = (await this.#read("open", executor => run(executor, keyQuery, { table }))) as Array<{
					name: unknown;
				}>;
				const keyProblem = primaryKeyProblem(
					rows.map(row => String(row.name).toLowerCase()),
					needs.key,
				);
				if (keyProblem) problems.push(`table ${table} has ${keyProblem}`);
			}
		}
		for (const { table, privilege, probe } of this.#q.privilegeProbes) {
			try {
				await this.#fencedTransaction("open", [], transaction => run(transaction, probe, {}).then(() => undefined));
			} catch (err) {
				problems.push(`the store's login cannot ${privilege} on table ${table} (${toError(err).message})`);
			}
		}
		if (problems.length === 0) return;
		throw new Error(
			`SqlSessionStorage: ${problems.join("; ")}. The store starts only on blob and reference tables as ` +
				`${SCHEMA_DOCS} gives them, which this login can write.`,
		);
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const rows = (await this.#exclusive(() => this.#readOne("loadIndex", this.#q.loadIndex))) as IndexRow[];
		return rows.map(row => {
			if (row.byte_len === null) {
				throw new Error(
					`SqlSessionStorage: ${this.#table} row ${JSON.stringify(row.path)} has no byte_len; ` +
						`run the byte_len backfill in ${SCHEMA_DOCS}.`,
				);
			}
			return { path: row.path, size: rowNumber(row.byte_len), mtimeMs: rowNumber(row.mtime_ms) };
		});
	}

	async readFull(path: string): Promise<SessionStorageFullRead | null> {
		const rows = (await this.#exclusive(() => this.#readOne("readFull", this.#q.readFull, { path }))) as ContentRow[];
		let session: ContentRow | undefined;
		const parts: Array<{ offset: number; content: string }> = [];
		for (const row of rows) {
			if (rowNumber(row.kind) === 0) session = row;
			else parts.push({ offset: rowNumber(row.start_offset), content: row.content });
		}
		if (session === undefined) return null;
		parts.sort((a, b) => a.offset - b.offset);
		return { text: session.content + parts.map(part => part.content).join(""), title: rowTitle(session) };
	}

	async readSlices(
		path: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[prefix: string, suffix: string, title: SessionStorageReadTitle]> {
		const rows = (await this.#exclusive(() =>
			this.#readOne("readSlices", this.#q.readSlices, { path, prefix: prefixBytes, suffix: suffixBytes }),
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
			rowTitle(session),
		];
	}

	async readFrom(
		path: string,
		offset: number,
		maxBytes: number | undefined,
		titled: SessionStorageStoredWindow,
	): Promise<SessionStorageWindowRead | null> {
		const untitledBounds = readFromBounds(offset, maxBytes);
		const titledBounds = readFromBounds(titled.start, titled.maxBytes);
		const rows = (await this.#exclusive(() =>
			this.#readOne("readFrom", this.#q.readFrom, {
				path,
				...untitledBounds,
				titled_offset: titledBounds.offset,
				titled_end: titledBounds.end,
				titled_take: titledBounds.take,
				titled_row_from: titledBounds.row_from,
			}),
		)) as ReadFromRow[];
		let size: number | undefined;
		let session: ReadFromRow | undefined;
		const pieces: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		for (const row of rows) {
			if (rowNumber(row.kind) !== 0) {
				pieces.push({ offset: rowNumber(row.start_offset), bytes: row.bytes });
				continue;
			}
			if (row.byte_len === null) {
				throw new Error(
					`SqlSessionStorage: ${this.#table} row ${JSON.stringify(path)} has no byte_len; ` +
						`run the byte_len backfill in ${SCHEMA_DOCS}.`,
				);
			}
			size = rowNumber(row.byte_len);
			session = row;
		}
		if (size === undefined || session === undefined) return null;
		const bytes = joinSliceBytes(session.bytes, pieces);
		// The statement read the window the row's title time picked: the one its title picks here.
		const title = rowTitle(session);
		const bounds = title ? titledBounds : untitledBounds;
		// Each piece is capped on its own; the window is capped as a whole.
		const capped = (title ? titled.maxBytes : maxBytes) !== undefined;
		return { bytes: capped ? bytes.subarray(0, bounds.take) : bytes, size, title };
	}

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const bytes = Buffer.from(content, "utf8");
		const row = {
			path,
			mtime: mtimeMs,
			title: title?.title ?? null,
			title_source: title?.source ?? null,
			title_updated_at: title?.updatedAt ?? null,
			len: bytes.byteLength,
		};
		// The blobs this content names land first (see SqlBlobTier). A blob queued before them whose write's
		// repairs are spent ends that land's pass, so this write is rejected for a named blob the pass did not try.
		const named = namedBlobHashes(content);
		await this.blobs.land(named);
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#withBlobRefs(named, allowGone =>
			this.#fencedTransaction("writeFull", fences, async transaction => {
				if (expectedSize === null) {
					const result = await run(transaction, this.#q.insertRowIfMissing, row);
					const inserted = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
					if (!inserted) throw new SessionWriteConflictError(path, null, await this.#lockSize(transaction, path));
				} else {
					// The size check reads `byte_len` under the row lock rather than
					// trusting a conditional UPDATE's row count, which MySQL reports
					// as 0 for a matched row whose values did not change.
					if (expectedSize !== undefined) {
						const actualSize = await this.#lockSize(transaction, path);
						if (actualSize !== expectedSize) throw new SessionWriteConflictError(path, expectedSize, actualSize);
					}
					await run(transaction, this.#q.upsertRow, row);
				}
				// A created session also drops parts orphaned under its path.
				await this.#deleteParts(transaction, path);
				await this.#insertParts(transaction, path, bytes);
				// The content is replaced whole, and so are its references: dropped only after the blob rows' locks.
				await this.#addRefs(transaction, path, named, allowGone, true);
			}),
		);
	}

	async #lockSize(transaction: SqlSessionStorageTransaction, path: string): Promise<number | null> {
		const rows = (await run(transaction, this.#q.lockSize, { path })) as SizeRow[];
		const row = rows[0];
		return row ? rowNumber(row.byte_len) : null;
	}

	/** Store `bytes` as parts of at most {@link PART_BYTES}, each ending on a UTF-8 character boundary. */
	async #insertParts(transaction: SqlSessionStorageTransaction, path: string, bytes: Buffer): Promise<void> {
		for (let start = 0; start < bytes.byteLength;) {
			let end = Math.min(start + PART_BYTES, bytes.byteLength);
			// Back off continuation bytes (0b10xxxxxx) so no character straddles two parts.
			while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
			await run(transaction, this.#q.insertPart, {
				path,
				offset: start,
				content: bytes.toString("utf8", start, end),
			});
			start = end;
		}
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#fencedTransaction("updateSessionTitle", fences, async transaction => {
			await run(transaction, this.#q.updateTitle, {
				path,
				title: title.title ?? null,
				title_source: title.source ?? null,
				title_updated_at: title.updatedAt,
				mtime: mtimeMs,
			});
		});
	}

	async append(path: string, line: string, mtimeMs: number, expectedSize?: number): Promise<void> {
		const values = { path, content: line, mtime: mtimeMs, len: Buffer.byteLength(line, "utf8") };
		// The blobs this line names land first (see SqlBlobTier). A blob queued before them whose write's
		// repairs are spent ends that land's pass, so this write is rejected for a named blob the pass did not try.
		const named = namedBlobHashes(line);
		await this.blobs.land(named);
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#withBlobRefs(named, allowGone =>
			this.#fencedTransaction("append", fences, async transaction => {
				// A store that claims sessions refuses to append onto bytes it did not
				// write (another writer that claims nothing, such as an older omp,
				// changed or replaced the file), so `SessionManager` can read the file
				// back and keep that writer's entries, or move off, instead of mixing
				// this session's lines into whatever the file now holds.
				if (expectedSize !== undefined && this.#gate) {
					const actualSize = await this.#lockSize(transaction, path);
					if ((actualSize ?? 0) !== expectedSize)
						throw new SessionWriteConflictError(path, expectedSize, actualSize);
				}
				for (const query of this.#q.append) await run(transaction, query, values);
				await this.#addRefs(transaction, path, named, allowGone);
			}),
		);
	}

	/**
	 * Reference `hashes` from `path` in a transaction of their own under the
	 * session's fence, as a transcript write does (see {@link #addRefs}): for a
	 * session written before the reference table, whose blobs the open wrote
	 * back, so a delete of another session keeps them.
	 */
	async addReferences(path: string, hashes: readonly string[]): Promise<void> {
		const named = new Set(hashes);
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#withBlobRefs(named, allowGone =>
			this.#fencedTransaction("blob.reference", fences, transaction =>
				this.#addRefs(transaction, path, named, allowGone),
			),
		);
	}

	/**
	 * Run `write` (a transcript write that adds references to `named`). When a
	 * delete took a blob of this store's that it names after the blob landed
	 * ({@link BlobsGoneError}), land the blob again from this machine's blob
	 * store and run `write` once more, then with no such check.
	 */
	async #withBlobRefs(named: ReadonlySet<string>, write: (allowGone: boolean) => Promise<void>): Promise<void> {
		try {
			await write(named.size === 0);
		} catch (err) {
			if (!(err instanceof BlobsGoneError)) throw err;
			await this.blobs.land(await this.blobs.reland(err.hashes));
			await write(true);
		}
	}

	/**
	 * Reference, from `path`, each of `named` the blob table holds, with its
	 * row locked shared until this transaction ends: a delete that would take
	 * the row waits for this write and then sees its reference (see
	 * {@link #deleteOrphans}); a delete that came first leaves no row, so the
	 * write throws {@link BlobsGoneError} for the blobs of this store's it
	 * names, unless `allowGone`, which only warns. With `replace`, `path`'s
	 * references are replaced: they are read first, the rows of the blobs
	 * they name are locked shared together with those of `named` (see
	 * {@link #lockBlobRows}), and only then are those `named` lacks deleted,
	 * each by its key, and `named`'s inserted. So every reference this deletes or inserts
	 * names a row this transaction holds, as on every other path that
	 * changes references.
	 */
	async #addRefs(
		transaction: SqlSessionStorageTransaction,
		path: string,
		named: ReadonlySet<string>,
		allowGone: boolean,
		replace = false,
	): Promise<void> {
		const current = replace ? (await this.#refsOf(transaction, [path])).map(row => row.sha256) : [];
		const locked = await this.#lockBlobRows(transaction, [...named, ...current]);
		// Only the references the content no longer names (or whose blob is gone) go, each by its key: a delete of
		// the path's whole range locks, on MySQL, the gap after it, even when the content names the same blobs.
		for (const sha256 of current) {
			if (!named.has(sha256) || !locked.has(sha256)) await run(transaction, this.#q.deleteRef, { path, sha256 });
		}
		for (const sha256 of named) if (locked.has(sha256)) await run(transaction, this.#q.insertRef, { path, sha256 });
		const gone = [...named].filter(hash => !locked.has(hash) && this.blobs.knows(hash));
		if (gone.length === 0) return;
		if (!allowGone) throw new BlobsGoneError(gone);
		logger.warn("Session images this transcript names are gone from the session database and from this machine", {
			path,
			hashes: gone,
		});
	}

	/**
	 * Add the blob row of `hash` unless the table has one, in a transaction of
	 * its own under no session's fence: the row is keyed by its content and
	 * never changes. A blob larger than `limit` is stored as parts, each a row
	 * of its own hash referenced from `blob:sha256:<hash>`; the row of `hash`
	 * lists the parts' keys, and its `byte_len` is the whole blob's (see
	 * {@link BLOB_PARTS_PATH}). The rows go in one pass in `sha256` order, the
	 * store's lock order (see {@link #lockBlobRows}): the row of `hash` is
	 * inserted in its place, and each part is locked shared where the table
	 * holds it (a part can be another blob's too), else inserted. Then the
	 * parts' references. Answers whether this call added the row of `hash`.
	 */
	async insertBlob(hash: string, data: Uint8Array, mimeType: string | undefined, limit: number): Promise<boolean> {
		const created = Date.now();
		let added = false;
		await this.#fencedTransaction("blob.insert", [], async transaction => {
			const parts = new Map<string, Uint8Array>();
			const keys: string[] = [];
			if (data.byteLength > limit) {
				for (let start = 0; start < data.byteLength; start += limit) {
					const part = data.subarray(start, Math.min(start + limit, data.byteLength));
					const key = blobSha256(part);
					keys.push(key);
					parts.set(key, part);
				}
			}
			const content = keys.length > 0 ? Buffer.from(keys.join(""), "latin1") : data;
			const insert = async (sha256: string, bytes: Uint8Array, len: number, mime: string | null) => {
				const result = await run(transaction, this.#q.insertBlob, { sha256, content: bytes, len, mime, created });
				return this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			};
			// Which parts the table holds, read without a lock, so a part there is not sent again.
			const there = new Set<string>();
			for (const batch of batches([...parts.keys()], BLOB_READ_BATCH)) {
				const rows = (await run(
					transaction,
					this.#q.selectBlobSizes(batch.length),
					listValues("h", batch),
				)) as HashRow[];
				for (const row of rows) there.add(row.sha256);
			}
			for (const key of [hash, ...parts.keys()].sort()) {
				if (key === hash) {
					added = await insert(hash, content, data.byteLength, mimeType ?? null);
					continue;
				}
				if (!parts.has(key)) continue;
				// A part there is locked shared, so no delete takes it; one that went meanwhile is inserted.
				if (there.has(key) && (await this.#lockBlobRows(transaction, [key])).has(key)) continue;
				const part = parts.get(key) ?? new Uint8Array();
				// Inserted by another blob meanwhile: the insert took no lock on PostgreSQL, so lock it shared.
				if (!(await insert(key, part, part.byteLength, null))) await this.#lockBlobRows(transaction, [key]);
			}
			for (const key of parts.keys()) {
				await run(transaction, this.#q.insertRef, { path: `${BLOB_PARTS_PATH}${hash}`, sha256: key });
			}
		});
		return added;
	}

	/**
	 * The largest blob one row of the table holds: the `maxBlobBytes` option,
	 * else {@link MAX_BLOB_BYTES}, or less where MySQL's or MariaDB's
	 * `max_allowed_packet` is smaller (16 MiB by default on MariaDB, 64 MiB on
	 * MySQL 8). Read once; a failed read is tried again by the next call.
	 */
	maxBlobBytes(): Promise<number> {
		const bound = Math.min(this.#maxRowBlobBytes, MAX_BLOB_BYTES);
		const query = this.#q.maxPacket;
		if (!query) return Promise.resolve(bound);
		this.#maxBlobBytes ??= this.#exclusive(() => this.#readOne("blob.insert", query, {})).then(
			rows => {
				const packet = Number((rows as Array<{ max_packet?: unknown }>)[0]?.max_packet);
				if (!Number.isFinite(packet) || packet <= 0) {
					throw new Error("SqlSessionStorage: the server answered no max_allowed_packet");
				}
				return Math.min(bound, packet - MYSQL_PACKET_HEADROOM);
			},
			err => {
				this.#maxBlobBytes = undefined;
				throw err;
			},
		);
		return this.#maxBlobBytes;
	}

	/** Of `hashes`, the ones the table holds, each with its size; reads no blob's bytes. */
	async blobSizes(hashes: readonly string[]): Promise<Map<string, number>> {
		const sizes = new Map<string, number>();
		for (const batch of batches(hashes, BLOB_READ_BATCH)) {
			const query = this.#q.selectBlobSizes(batch.length);
			const rows = (await this.#exclusive(() =>
				this.#readOne("blob.sizes", query, listValues("h", batch)),
			)) as BlobSizeRow[];
			for (const row of rows) sizes.set(row.sha256, rowNumber(row.byte_len));
		}
		return sizes;
	}

	/**
	 * Read the rows of `hashes` the table holds, in batches of at most
	 * {@link BLOB_READ_BYTES} (a larger blob alone), handing each blob to
	 * `visit` before the next batch is read, so a read holds one batch. A
	 * parted blob is read from its parts and handed on whole.
	 */
	async readBlobs(hashes: readonly string[], visit: (hash: string, data: Buffer) => Promise<void>): Promise<void> {
		let batch: string[] = [];
		let bytes = 0;
		const readBatch = async (): Promise<void> => {
			const query = this.#q.selectBlobs(batch.length);
			const values = listValues("h", batch);
			batch = [];
			bytes = 0;
			const rows = (await this.#exclusive(() => this.#readOne("blob.read", query, values))) as BlobRow[];
			for (const row of rows) await visit(row.sha256, await this.#wholeBlob(row));
		};
		for (const [hash, size] of await this.blobSizes(hashes)) {
			if (batch.length > 0 && (bytes + size > BLOB_READ_BYTES || batch.length >= BLOB_READ_BATCH)) await readBatch();
			batch.push(hash);
			bytes += size;
		}
		if (batch.length > 0) await readBatch();
	}

	/** A blob row's bytes; for a parted blob, its parts' bytes in order (a missing part leaves bytes that do not hash to the key). */
	async #wholeBlob(row: BlobRow): Promise<Buffer> {
		const content = Buffer.from(row.content.buffer, row.content.byteOffset, row.content.byteLength);
		if (rowNumber(row.byte_len) === content.byteLength) return content;
		const keys = content.toString("latin1").match(/[0-9a-f]{64}/g) ?? [];
		const parts = new Map<string, Buffer>();
		for (const batch of batches(keys, BLOB_READ_BATCH)) {
			const query = this.#q.selectBlobs(batch.length);
			const rows = (await this.#exclusive(() =>
				this.#readOne("blob.read", query, listValues("h", batch)),
			)) as BlobRow[];
			for (const part of rows) {
				parts.set(part.sha256, Buffer.from(part.content.buffer, part.content.byteOffset, part.content.byteLength));
			}
		}
		return Buffer.concat(keys.map(key => parts.get(key) ?? Buffer.alloc(0)));
	}

	/** Of `hashes`, the rows whose bytes do not hash to their key (a parted blob's row is not checked). */
	async wrongBlobs(hashes: readonly string[]): Promise<string[]> {
		const wrong: string[] = [];
		const digests = this.#q.blobDigests;
		for (const batch of batches(hashes, BLOB_READ_BATCH)) {
			const values = listValues("h", batch);
			if (digests) {
				const query = digests(batch.length);
				for (const row of (await this.#exclusive(() =>
					this.#readOne("blob.wrong", query, values),
				)) as BlobDigestRow[]) {
					const digest = typeof row.digest === "string" ? row.digest : Buffer.from(row.digest).toString("latin1");
					if (digest.toLowerCase() !== row.sha256) wrong.push(row.sha256);
				}
				continue;
			}
			const query = this.#q.selectBlobs(batch.length);
			for (const row of (await this.#exclusive(() => this.#readOne("blob.wrong", query, values))) as BlobRow[]) {
				if (rowNumber(row.byte_len) === row.content.byteLength && blobSha256(row.content) !== row.sha256) {
					wrong.push(row.sha256);
				}
			}
		}
		return wrong;
	}

	/** Rewrite the row of `hash` with `data`, bytes that hash to it; answers false for one over `limit`, left as it is. */
	async repairBlob(hash: string, data: Uint8Array, limit: number): Promise<boolean> {
		if (data.byteLength > limit) return false;
		await this.#fencedTransaction("blob.repair", [], transaction =>
			run(transaction, this.#q.repairBlob, { sha256: hash, content: data, len: data.byteLength }).then(
				() => undefined,
			),
		);
		return true;
	}

	/**
	 * `omp gc`'s sweep of the blob table: drop the references of session paths
	 * that have no session row, then delete each blob row created before
	 * `beforeMs` that no reference names and `referenced` (the hashes gc found
	 * named in any session's transcript) lacks, as a session delete does (see
	 * {@link #deleteOrphans}). Without `apply`, only counts.
	 */
	async sweepBlobs(referenced: ReadonlySet<string>, beforeMs: number, apply: boolean): Promise<SessionBlobSweep> {
		if (apply) {
			// The references of paths that have no session row, each dropped with its blob's row locked exclusive.
			const dangling = (await this.#exclusive(() =>
				this.#readOne("blob.sweep", this.#q.danglingRefs, {}),
			)) as RefRow[];
			const byHash = new Map<string, string[]>();
			for (const row of dangling) byHash.set(row.sha256, [...(byHash.get(row.sha256) ?? []), row.path]);
			for (const batch of batches([...byHash.keys()].sort(), BLOB_READ_BATCH)) {
				await this.#fencedTransaction("blob.sweep", [], async transaction => {
					const look = this.#q.sessionRowsOf;
					if (look) {
						await this.#dropDanglingRefs(transaction, look, batch, byHash);
						return;
					}
					// PostgreSQL's delete looks for the session row itself (see deleteDanglingRef); SQLite runs one
					// writer at a time.
					await this.#lockBlobRows(transaction, [], batch);
					for (const sha256 of batch) {
						for (const path of byHash.get(sha256) ?? []) {
							await run(transaction, this.#q.deleteDanglingRef, { path, sha256 });
						}
					}
				});
			}
		}
		const rows = (await this.#exclusive(() =>
			this.#readOne("blob.sweep", this.#q.sweepCandidates, { before: beforeMs }),
		)) as BlobSizeRow[];
		const sizes = new Map(
			rows.filter(row => !referenced.has(row.sha256)).map(row => [row.sha256, rowNumber(row.byte_len)]),
		);
		const sweep: SessionBlobSweep = { candidates: sizes.size, deleted: 0, bytes: 0 };
		if (!apply) {
			for (const size of sizes.values()) sweep.bytes += size;
			return sweep;
		}
		for (const batch of batches([...sizes.keys()], BLOB_READ_BATCH)) {
			let deleted: string[] = [];
			await this.#fencedTransaction("blob.sweep", [], async transaction => {
				// The candidates' rows and their parts' rows, in one pass, before any reference goes.
				const locked = await this.#lockBlobRows(
					transaction,
					[],
					[...batch, ...(await this.#partsOf(transaction, batch))],
				);
				deleted = await this.#deleteOrphans(
					transaction,
					batch.filter(hash => locked.has(hash)),
				);
			});
			for (const hash of deleted) {
				const size = sizes.get(hash);
				if (size === undefined) continue;
				sweep.deleted++;
				sweep.bytes += size;
			}
		}
		return sweep;
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[], dir?: string): Promise<void> {
		const under = dir === undefined ? undefined : { dir, len: [...dir].length };
		const fences = this.#fencesOf(paths);
		await this.#awaitClaims(fences);
		const there = under ? undefined : await this.#sessionRowsThere("remove", paths);
		await this.#fencedTransaction("remove", fences, async transaction => {
			// Every session row first, in path order, those under `dir` with them (see #lockSessionRowsForWrite);
			// all their locks are then held before the first parts look (see #deleteParts).
			const present = await this.#lockSessionRowsForWrite(transaction, paths, there, under);
			const ordered = [...new Set(paths)].sort();
			// Only rows there are: a delete that finds no row still locks a gap on MySQL.
			for (const path of ordered) {
				if (!present || present.has(path)) await run(transaction, this.#q.deleteRow, { path });
			}
			if (under) for (const query of this.#q.deleteUnder) await run(transaction, query, under);
			for (const path of ordered) await this.#deleteParts(transaction, path);
			// Then the blobs only the deleted sessions named: their rows are locked before their references go.
			await this.#deleteOrphans(transaction, await this.#takeRefs(transaction, ordered, under));
		});
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		if (src === dst) {
			const rows = await this.#exclusive(() => this.#readOne("move", this.#q.exists, { path: src }));
			if (rows.length === 0) throw enoent(src);
			return;
		}
		const fences = this.#fencesOf([src, dst]);
		await this.#awaitClaims(fences);
		// A replacing rename whose `dst` another client creates after the read of which rows there are (on MySQL a
		// `dst` with no row is not locked; PostgreSQL locks no row that is not there) meets that row in its
		// UPDATE, on the primary key. It runs again, bounded as a deadlock's retry: the next attempt reads `dst`,
		// locks it in path order, and replaces it; past the bound it throws SessionRenameRaceError. `noReplace`
		// rejects with EEXIST instead.
		for (let attempt = 1; ; attempt++) {
			try {
				await this.#moveOnce(src, dst, mtimeMs, noReplace, fences);
				break;
			} catch (err) {
				if (!isPrimaryKeyViolation(err)) throw err;
				if (noReplace) throw eexist(dst);
				if (attempt >= WRITE_ATTEMPTS) throw new SessionRenameRaceError(src, dst, attempt, err);
			}
		}
		this.#moveLease(src, dst);
	}

	async #moveOnce(
		src: string,
		dst: string,
		mtimeMs: number,
		noReplace: boolean,
		fences: readonly LeaseFence[],
	): Promise<void> {
		const there = await this.#sessionRowsThere("move", [src, dst]);
		await this.#fencedTransaction("move", fences, async transaction => {
			// Both session rows first, in path order, before either changes; only rows there are change. A `dst`
			// with no row is taken by the UPDATE below, after `src`'s (see docs/session.md, "Races").
			const present = await this.#lockSessionRowsForWrite(transaction, [src, dst], there);
			if (present && !present.has(src)) throw enoent(src);
			if (!noReplace && (!present || present.has(dst))) await run(transaction, this.#q.deleteRow, { path: dst });
			// One statement renames the row, so the primary key refuses a `dst`
			// row that exists, or that another client inserts concurrently (the
			// UPDATE waits on its uncommitted key); the thrown error rolls the
			// transaction back with both paths untouched.
			const result = await run(transaction, this.#q.renameRow, { src, dst, mtime: mtimeMs });
			const moved = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			if (!moved) throw enoent(src);
			// Both rows are locked now, before the parts look (see #deleteParts):
			// parts orphaned under `dst` go, then `src`'s follow its row.
			await this.#deleteParts(transaction, dst);
			// On MySQL only when `src` has parts, as #deleteParts: an update that finds no row still locks a gap.
			if (this.#adapter !== "mysql" || (await run(transaction, this.#q.hasParts, { path: src })).length > 0) {
				await run(transaction, this.#q.renameParts, { src, dst });
			}
			// The references change last, the rows of every blob they name locked first: the replaced session's
			// (exclusive, since its blobs may go with it) and `src`'s, which move to `dst` (shared). Each moves by
			// its key: an UPDATE of `src`'s range would lock, on MySQL, next-key ranges over it and the gap after,
			// then insert into `dst`'s gap, where another rename's range can lie. `src`'s row is locked before this
			// transaction's first read, and every write that adds a path's references takes its row first (the
			// open-time write-back aside, which adds what the transcript names already), so the read misses none.
			const moving = (await this.#refsOf(transaction, [src])).map(row => row.sha256);
			const replaced = await this.#takeRefs(transaction, [dst], undefined, moving);
			for (const sha256 of moving) {
				await run(transaction, this.#q.deleteRef, { path: src, sha256 });
				await run(transaction, this.#q.insertRef, { path: dst, sha256 });
			}
			await this.#deleteOrphans(transaction, replaced);
		});
	}

	/**
	 * Delete the references of `paths` (and of every path under `under`),
	 * answering the blob rows they named that the table holds. Those rows,
	 * and the rows of their parts, are locked exclusive in one pass before any
	 * reference goes, with the rows of `alsoShared` (blobs whose references
	 * the caller changes next) locked shared in the same pass (see
	 * {@link #lockBlobRows}). Each reference goes by its key: a delete of a
	 * path's range, or of a directory's (a scan of the whole table), locks on
	 * MySQL every row and gap it passes. The caller locked the paths' session
	 * rows before the read, so it misses no reference a write of them added.
	 */
	async #takeRefs(
		transaction: SqlSessionStorageTransaction,
		paths: readonly string[],
		under?: { dir: string; len: number },
		alsoShared: readonly string[] = [],
	): Promise<string[]> {
		const rows = await this.#refsOf(transaction, paths);
		const below = under ? ((await run(transaction, this.#q.refsUnder, under)) as RefRow[]) : [];
		const hashes = [...new Set([...rows, ...below].map(row => row.sha256))];
		const locked = await this.#lockBlobRows(transaction, alsoShared, [
			...hashes,
			...(await this.#partsOf(transaction, hashes)),
		]);
		const taken = new Map([...rows, ...below].map(row => [`${row.sha256} ${row.path}`, row]));
		for (const row of taken.values()) {
			await run(transaction, this.#q.deleteRef, { path: row.path, sha256: row.sha256 });
		}
		return hashes.filter(hash => locked.has(hash));
	}

	/**
	 * The parts of the parted blobs among `hashes`, read from their parts'
	 * references without a lock: a delete locks them in the same pass as
	 * their parents. The list cannot change once the parent's row is locked,
	 * since only the parent's own insert writes it.
	 */
	async #partsOf(transaction: SqlSessionStorageTransaction, hashes: readonly string[]): Promise<string[]> {
		return (
			await this.#refsOf(
				transaction,
				hashes.map(hash => `${BLOB_PARTS_PATH}${hash}`),
			)
		).map(row => row.sha256);
	}

	/**
	 * MySQL and MariaDB: which of `paths` have a session row, read without a
	 * lock before the transaction that locks them (see
	 * {@link #lockSessionRowsForWrite}). Read outside it, so that
	 * transaction's first consistent read, which fixes its REPEATABLE READ
	 * snapshot, comes after its locks: the parts and references it then reads
	 * hold every write of those paths that committed. Elsewhere `undefined`.
	 */
	async #sessionRowsThere(operation: PgOperation, paths: readonly string[]): Promise<ReadonlySet<string> | undefined> {
		const look = this.#q.sessionRowsOf;
		if (!look) return undefined;
		const ordered = [...new Set(paths)].sort();
		const rows = (await this.#readOne(operation, look(ordered.length), listValues("p", ordered))) as PathRow[];
		return new Set(rows.map(row => row.path));
	}

	/**
	 * Lock exclusive, in path order, the session rows of `paths` and, with
	 * `under`, every row under its directory, before a delete or a rename
	 * changes any of them: the store's lock order (see {@link #lockBlobRows}).
	 * On MySQL and MariaDB, without `under`, only the rows `there` names are
	 * locked (see {@link #sessionRowsThere}), as {@link #lockBlobRows} does for
	 * blob rows: a locking read of a missing path locks its gap, and an insert
	 * into that gap at another path (a rename's destination, a new session)
	 * would wait for it. Then it answers the paths whose rows it locked, and
	 * the caller changes only those. With `under` MySQL can use no index
	 * (`substr`), so the lock scans and locks every row, gaps too, in path
	 * order, as the directory's `DELETE` that follows does anyway. PostgreSQL
	 * locks no gap. Elsewhere nothing is answered; SQLite runs one writer at a
	 * time.
	 */
	async #lockSessionRowsForWrite(
		transaction: SqlSessionStorageTransaction,
		paths: readonly string[],
		there: ReadonlySet<string> | undefined,
		under?: { dir: string; len: number },
	): Promise<ReadonlySet<string> | undefined> {
		const lock = this.#q.lockSessionRowsForWrite;
		if (!lock) return undefined;
		const ordered = [...new Set(paths)].sort();
		if (!there || under) {
			await run(transaction, lock(ordered.length, under !== undefined), {
				...listValues("p", ordered),
				...(under ?? {}),
			});
			return undefined;
		}
		// One key per statement (see #lockBlobRows): MySQL may plan an IN list as a scan, which locks other rows.
		const present = new Set<string>();
		for (const path of ordered) {
			if (!there.has(path)) continue;
			const rows = (await run(transaction, lock(1, false), listValues("p", [path]))) as PathRow[];
			for (const row of rows) present.add(row.path);
		}
		return present;
	}

	/** The references of `paths`, read without a lock. */
	async #refsOf(transaction: SqlSessionStorageTransaction, paths: readonly string[]): Promise<RefRow[]> {
		const rows: RefRow[] = [];
		for (const batch of batches(paths, BLOB_READ_BATCH)) {
			rows.push(...((await run(transaction, this.#q.refsOf(batch.length), listValues("p", batch))) as RefRow[]));
		}
		return rows;
	}

	/**
	 * MySQL and MariaDB: drop the references of `batch`'s blobs from the
	 * paths `byHash` lists for each, paths that had no session row when the
	 * sweep read them. The blobs' rows are locked exclusive first, with no
	 * read before the locks (see {@link #lockBlobRows}); only then are the
	 * paths' session rows (by `look`) and references read, without a lock.
	 * Those reads are the transaction's first consistent read, so its
	 * REPEATABLE READ snapshot is taken after the locks. Every write that
	 * adds, moves or deletes a reference to one of these blobs takes the
	 * blob's row before and keeps it until it commits, so the snapshot holds
	 * each such write that committed, and none runs until this one commits.
	 * A reference is dropped only where the snapshot has it and has no
	 * session row at its path: a write creating the path meanwhile, not yet
	 * committed, then waits for the blob's row and references it again.
	 *
	 * No session row is locked, nor a gap. A dangling path's row is often one
	 * that was just deleted, which InnoDB keeps, delete-marked, until purge
	 * removes it. A lock on that row made a write that creates the path again
	 * wait in its insert's duplicate check; when purge removed the row, InnoDB
	 * turned the waiting lock into a gap lock granted to the write (it keeps a
	 * constraint check's lock that way), and two writes creating paths in one
	 * gap each waited to insert into the gap the other held: a deadlock.
	 */
	async #dropDanglingRefs(
		transaction: SqlSessionStorageTransaction,
		look: (count: number) => Statement,
		batch: readonly string[],
		byHash: ReadonlyMap<string, readonly string[]>,
	): Promise<void> {
		await this.#lockBlobRows(transaction, [], batch, false);
		const paths = [...new Set(batch.flatMap(sha256 => byHash.get(sha256) ?? []))];
		const present = new Set<string>();
		for (const group of batches(paths, BLOB_READ_BATCH)) {
			for (const row of (await run(transaction, look(group.length), listValues("p", group))) as PathRow[]) {
				present.add(row.path);
			}
		}
		// Only references there are: a delete that finds no row still locks a gap on MySQL.
		const there = new Set((await this.#refsOf(transaction, paths)).map(row => `${row.sha256} ${row.path}`));
		for (const sha256 of batch) {
			for (const path of byHash.get(sha256) ?? []) {
				if (present.has(path) || !there.has(`${sha256} ${path}`)) continue;
				await run(transaction, this.#q.deleteRef, { path, sha256 });
			}
		}
	}

	/**
	 * The store's lock order, which every transaction that changes the
	 * session, blob or reference tables follows, so that on MySQL and MariaDB
	 * none of them deadlocks another:
	 *   1. the lease rows of a fenced write (the member's fence);
	 *   2. session rows (and the parts under them), in path order, all locked
	 *      before any of them changes: a write's own row, a delete's and a
	 *      rename's rows (see {@link #lockSessionRowsForWrite}), but for a
	 *      rename's destination with no row, which its UPDATE takes after the
	 *      source's (see docs/session.md, "Races"); the sweep locks none (see
	 *      {@link #dropDanglingRefs});
	 *   3. blob rows, here, in one pass in `sha256` order, parents and parts
	 *      together (shared for `shared`, exclusive for `exclusive`; a hash in
	 *      both is locked exclusive); a delete reads a parted blob's part list
	 *      first, without a lock (see {@link #partsOf}), and a parted blob's
	 *      insert takes its own row in its place among its parts';
	 *   4. reference rows.
	 * No statement after step 3 takes a lock in the session table, and no
	 * statement after step 4's first takes a blob row's lock it does not
	 * hold. A transaction locks every blob row the references it inserts or
	 * deletes name before the first of them; a statement that deletes a
	 * path's references reads them first, without a lock, so their blobs are
	 * among these. `sql-session-storage-lock-order.test.ts` checks each
	 * transaction's statements against this order on every engine.
	 * Answers the hashes whose rows the table holds and this locked; only rows
	 * there are are locked, since a locking read of a missing key locks a gap
	 * on MySQL. On MySQL and MariaDB each row is locked by a statement of its
	 * own, a `const` read of one key: MySQL may plan an `IN` list over a small,
	 * changing table as a scan of the whole primary key, which waits for and
	 * locks every row it passes, rows of other keys too, from the lowest key.
	 * SQLite runs one write at a time, and only reads which rows there are.
	 * Without `look`, every key is locked with no read before, for a caller
	 * whose first consistent read must come after the locks (see
	 * {@link #dropDanglingRefs}); its keys are rows a reference named when it
	 * read them, and a key whose row went since locks only the gap where the
	 * row was, keeping out an insert of a blob there until this commits.
	 */
	async #lockBlobRows(
		transaction: SqlSessionStorageTransaction,
		shared: Iterable<string>,
		exclusive: Iterable<string> = [],
		look = true,
	): Promise<Set<string>> {
		const modes = new Map<string, boolean>();
		for (const hash of shared) modes.set(hash, false);
		for (const hash of exclusive) modes.set(hash, true);
		const locked = new Set<string>();
		for (const batch of batches([...modes.keys()].sort(), BLOB_READ_BATCH)) {
			let there = new Set(batch);
			if (look) {
				const rows = await run(transaction, this.#q.selectBlobSizes(batch.length), listValues("h", batch));
				there = new Set((rows as HashRow[]).map(row => row.sha256));
			}
			// One statement per run of rows of one mode, so the rows are locked in `sha256` order across modes; on
			// MySQL one statement per row.
			let group: string[] = [];
			const flush = async (): Promise<void> => {
				if (group.length === 0) return;
				const exclusiveGroup = modes.get(group[0] ?? "") === true;
				const rows = (await run(
					transaction,
					this.#q.lockBlobs(group.length, exclusiveGroup),
					listValues("h", group),
				)) as HashRow[];
				for (const row of rows) locked.add(row.sha256);
				group = [];
			};
			for (const hash of batch) {
				if (!there.has(hash)) continue;
				const next = this.#adapter === "mysql" || modes.get(group[0] ?? "") !== modes.get(hash);
				if (group.length > 0 && next) await flush();
				group.push(hash);
			}
			await flush();
		}
		return locked;
	}

	/**
	 * Delete each blob row of `locked` (rows {@link #lockBlobRows} locked in
	 * this transaction, with their parts) that no reference names any more,
	 * with the parts of a parted one; answers the hashes deleted. Every write
	 * that adds a reference to one of them has committed before the lock was
	 * granted, or locks it after this commits, so the read of the references
	 * sees each one that committed (PostgreSQL reads at each statement's
	 * start; MySQL reads the references with a shared lock, so it sees the
	 * latest); a write that locks after this commits finds the row gone and
	 * lands it again. The parts' rows were locked in the same pass as their
	 * parents, so taking their references locks nothing new. MySQL reads one
	 * hash per statement, its first entry in the `sha256` index: a read of
	 * several hashes, or of all of one hash's entries, locks next-key ranges
	 * (or, on a small table, scans the primary key) into other blobs'
	 * entries, which other transactions change under their own blob locks.
	 * This one's row lock alone keeps every reference to it from changing.
	 */
	async #deleteOrphans(transaction: SqlSessionStorageTransaction, locked: readonly string[]): Promise<string[]> {
		if (locked.length === 0) return [];
		const referenced = new Set<string>();
		const one = this.#q.referencedOne;
		if (one) {
			for (const hash of [...locked].sort()) {
				if ((await run(transaction, one, { h: hash })).length > 0) referenced.add(hash);
			}
		} else {
			for (const batch of batches(locked, BLOB_READ_BATCH)) {
				const rows = (await run(
					transaction,
					this.#q.referenced(batch.length),
					listValues("h", batch),
				)) as HashRow[];
				for (const row of rows) referenced.add(row.sha256);
			}
		}
		const orphans = locked.filter(hash => !referenced.has(hash));
		if (orphans.length === 0) return [];
		const partPaths = orphans.map(hash => `${BLOB_PARTS_PATH}${hash}`);
		const parts = await this.#takeRefs(transaction, partPaths);
		for (const batch of batches(orphans, BLOB_READ_BATCH)) {
			await run(transaction, this.#q.deleteBlobs(batch.length), listValues("h", batch));
		}
		this.blobs.forget(orphans);
		logger.info("Deleted session blobs no session names any more", { blobs: orphans.length });
		return [...orphans, ...(await this.#deleteOrphans(transaction, parts))];
	}
}
