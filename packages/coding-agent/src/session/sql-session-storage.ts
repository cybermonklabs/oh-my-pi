import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type FileLockHandle, getBlobsDir, isEnoent, logger, postmortem, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { digestStream } from "../utils/file-hash";
import { BLOB_PREFIX, type SessionBlobSweep, type SessionBlobTier } from "./blob-store";
import {
	IndexedSessionStorage,
	SessionAppendBatchRolledBackError,
	type SessionStorageBackend,
	type SessionStorageChunk,
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
	type SessionStorageReadTitle,
	type SessionStorageWindowRead,
} from "./indexed-session-storage";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { STALE_STAGING_MS, utf8PartEnd, utf8Parts } from "./session-staging";
import {
	type SessionAcquireOptions,
	type SessionClaimHolder,
	type SessionClaimOptions,
	SessionLeaseLostError,
	SessionReadConflictError,
	type SessionStorage,
	SessionWriteConflictError,
	sessionHeaderIdInPrefix,
	sessionLeaseId,
	tryAcquireSessionLease,
} from "./session-storage";
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
/**
 * How long, from when it begins, a claim of a session on a SQLite file keeps
 * trying to take the session's OS lock while another process holds it: a
 * claim made while that process lets the session go (it closes the session,
 * or exits) then takes the session instead of moving it to a sibling. The
 * native claim of a held lock may itself wait about this long for a live
 * holder to let go (the abstract-socket lock does, in builds that retry a
 * refused bind) or answer "taken" at once (the open-file-description lock of
 * newer builds does). The store tries again from the event loop, every
 * {@link SQLITE_CLAIM_RETRY_MS}, so it never blocks the thread itself; and
 * since the window counts from the claim's start, a native claim that waited
 * has used it up and is not tried again. Never longer than a claim's
 * `waitMs`.
 */
export const SQLITE_CLAIM_RELEASE_WINDOW_MS = 50;

/** A dialect-rendered statement and the names of the values it binds, in binding order. */
interface Statement {
	readonly sql: string;
	readonly params: readonly string[];
}

type StatementValues = Readonly<Record<string, string | number | bigint | Uint8Array | null>>;

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
	 * insert the line as a part at the old length, on SQLite with a rowid from
	 * `@now` (see {@link partRowids}). PostgreSQL does both in one statement;
	 * every dialect runs its list in one transaction.
	 */
	append: readonly Statement[];
	/**
	 * A batch of appends' row: grow the session row's `byte_len` by `@len`
	 * (taking its row lock, inserting the row when it is missing) and set its
	 * `mtime_ms`. PostgreSQL and SQLite return the new `byte_len`; on MySQL,
	 * which returns no rows from a write, {@link lockSize} reads it after. The
	 * batch then inserts its parts ({@link insertPart}) from the old length.
	 */
	growRow: Statement;
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
	 * characters equal it, compared exactly whatever the `path` column's
	 * collation: not by `LIKE`, so `%` and `_` stay literal and SQLite's
	 * ASCII-insensitive `LIKE` cannot match another case; on PostgreSQL as
	 * code points, as a nondeterministic collation finds "R/A/" equal to
	 * "R/a/"; on MySQL and MariaDB as bytes, see below) and exactly those
	 * rows' parts, then every part under `@dir` that has no row:
	 * a staged full write's parts that its killed writer never swapped in, of
	 * a path the delete may not know of (on MySQL, not those of a path too
	 * long for a staging path under `@dir`, staged under its hash, see
	 * `#stagingPrefix`).
	 * PostgreSQL and MySQL delete the rows and their parts in one statement,
	 * so the parts deleted are those of the rows deleted: a row another
	 * client commits between two statements would
	 * otherwise keep its row and lose its parts under READ COMMITTED; the
	 * second statement deletes only parts whose row it does not see, found by
	 * a range of the parts' primary key, from `@stem` (`@dir` without its
	 * final "/") up to `@dir_end` (`@dir` with its final "/" made "0"), with
	 * the prefix compared too. That range holds every path under `@dir` where
	 * the `path` column compares by code point: such a path extends `@stem`,
	 * and differs from `@dir_end` first at its "/". It holds under MySQL's
	 * `utf8mb4_bin` too, which compares two strings as if the shorter were
	 * padded with spaces (PAD SPACE): "/" sorts above the space, while a path
	 * whose character after `@dir` sorts below the space sorts below `@dir`
	 * itself, so the range starts at `@stem`. For the same reason MySQL and
	 * MariaDB compare the prefix as bytes: MariaDB 11.8 finds no such path by
	 * `substr(path, 1, n) = @dir`, as a key range from `@dir` in PAD SPACE
	 * order would not. PostgreSQL takes the range only
	 * under a code-point collation (see
	 * {@link pathCollationKeepsDirectoryRange}). SQLite runs its statements
	 * inside `BEGIN IMMEDIATE`, where no other writer runs; its parts delete
	 * takes every part under `@dir`.
	 */
	deleteUnder: Statement[];
	/**
	 * {@link deleteUnder} without the key range: on PostgreSQL the second
	 * statement compares the prefix alone, a scan of the parts, for a `path`
	 * column whose collation does not compare by code point. Such a collation
	 * can sort a path under `@dir` outside the range: a libc locale such as
	 * `en_US.UTF-8` ignores "/" at its first level, ICU's Thai collation
	 * ignores punctuation there (`'/s/a/b' < '/s/a0'` is false under
	 * `th-x-icu`), and any locale's tailoring or rules can do the same. The
	 * other dialects' statements are {@link deleteUnder}'s.
	 */
	deleteUnderScan: Statement[];
	/**
	 * Delete the staging parts named from `@low` (a path's staging prefix,
	 * `<path>#staging-` or its hashed form, see `#stagingPrefix`) up to, not
	 * including, `@high`: a primary-key range, and the prefix compared exactly
	 * too (on PostgreSQL as code points, on MySQL and MariaDB as bytes, as in
	 * {@link deleteUnder}), so a collation that orders the range otherwise, or
	 * finds two paths equal, can never reach another path's parts. A staging
	 * name has a digit after `@low`, and a "-" after the epoch `@high` ends
	 * with, both above the space, so MySQL's PAD SPACE orders these names as
	 * code-point order does.
	 */
	deleteStaging: Statement;
	/** Whether {@link deleteStaging} would find any part, read without locking. */
	hasStaging: Statement;
	/** The byte length of each staging part of `@path`, row-locked where the dialect can, so no peer deletes one before the swap. */
	stagedBytes: Statement;
	/** Insert a part; on SQLite with a rowid from `@now` (see {@link partRowids}). */
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
	 * session row's and those of the parts covering the window.
	 */
	readFrom: Statement;
	/**
	 * The session's size and title columns, the byte length of the row's own
	 * content and its bytes from `@offset` on, and the part the read starts
	 * at: its start (`first_part`, -1 when there is none) and its row identity
	 * (`first_id`, see {@link partRowids}; null on MySQL, which has none).
	 * That part is the last one starting at or before `@offset`, or, for a
	 * read from inside the row's own content, the first one. On MySQL also the
	 * session's last part, the last one starting before the size: its start
	 * (`tail_part`) and the SHA-256 in hex of its start in decimal, ":" and
	 * its bytes (`tail_digest`), both null when there is none.
	 */
	readChunksStart: Statement;
	/**
	 * The parts that start from `@next` up to, not including, `@end`, in
	 * `start_offset` order: one page. On PostgreSQL and SQLite the page is
	 * empty unless the part at `@anchor` still has the row identity
	 * `@anchor_id`, checked in the same statement. On SQLite it is also empty
	 * unless the part at `@last` (the last one the read has fetched, -1 before
	 * the first page) still holds `@last_content`. MySQL checks neither; its
	 * read checks the session's last part against `tail_digest` when it fetches
	 * it, and what it yielded, when it ends or is closed, with
	 * {@link readChunksDigest}.
	 */
	readParts: Statement;
	/**
	 * MySQL only, which has no row identity: the digest of what a chunked read
	 * yielded, as the parts table holds it now, which the read computes the
	 * same way over what it fetched ({@link addChunkDigest}). Its items are the
	 * row's own content from `@offset` on (`@row_from` as in
	 * {@link readChunksStart}), when `@offset` is inside it, and the parts that
	 * start from `@first` up to, not including, `@end`: the end of the last
	 * part the read yielded. An item's digest is the first 128 bits of the
	 * SHA-256 of its offset in decimal, ":" and its bytes; the digest is their
	 * XOR, in 32 upper-case hex digits (`digest`). One aggregate, so the server
	 * never holds the session whole. SHA-256 rather than MD5, which a MySQL
	 * server in FIPS mode answers with NULL.
	 */
	readChunksDigest: Statement | undefined;
	/**
	 * SQLite only: the first rowid a full write's parts take, as decimal text
	 * (a rowid can reach 2^63 - 1, which a JavaScript number holds exactly only
	 * up to 2^53, so the write counts up in a `bigint`), and an insert that
	 * sets a part's rowid. A part's row identity, which a chunked read
	 * checks, is its `xmin` on PostgreSQL (the transaction that wrote it) and
	 * its `rowid` on SQLite. SQLite gives a new row the largest rowid plus one,
	 * which hands the rowid of a deleted last row out again; so every part
	 * insert on SQLite (the append's, {@link insertPart}'s, and a full write's
	 * through these) takes a rowid above every one handed out before the
	 * current millisecond `@now`: the largest rowid plus one, or `@now * 1024`
	 * when that is more. A full write reads its first rowid before it deletes
	 * the parts it replaces and counts up from there, so none of its parts
	 * takes the rowid of one of those. A part inserted in a later millisecond
	 * than a deleted one never takes its rowid as long as the table takes at
	 * most 1024 rowids a millisecond, far more than SQLite inserts. It can
	 * when the clock goes back (or another process's clock, on a database file
	 * several hosts share, is behind), or when a part is deleted and another
	 * inserted in the millisecond of the deleted part's own insert. A writer
	 * older than this rule still hands out the largest rowid plus one.
	 *
	 * A part whose rowid by the rule would pass {@link SQLITE_MAX_ROWID}, the
	 * largest SQLite has (as when another program stored a row under it), goes
	 * in with no rowid of its own: `next_rowid` is null when the largest rowid
	 * is that already, and a full write binds null for every part it would
	 * count past it. SQLite then picks one, as it does for an older writer: the
	 * largest rowid plus one, or, while the table holds rowid 2^63 - 1, an
	 * unused one at random. The rule does not hold for that table then, and a
	 * new part can take the rowid of a deleted one: what still finds a
	 * replacement during a chunked read is the part at its anchor no longer
	 * having the rowid the read started with, or the last part it fetched no
	 * longer holding the same bytes at its offset (see {@link readParts}).
	 */
	partRowids: { next: Statement; insert: Statement } | undefined;
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
	/** The references (path and hash) of the paths under `@dir` (its first `@len` characters, compared as {@link deleteUnder} compares them). */
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
	/**
	 * PostgreSQL and MySQL: lock exclusive, in path order, the session rows of
	 * `count` paths, with `under` every row under `@dir` too, as
	 * {@link deleteUnder} compares the prefix (MySQL's caller names, without
	 * `under`, only rows there are). On MySQL and MariaDB the rows under
	 * `@dir` are read by {@link deleteUnder}'s key range, from `@stem` up to
	 * `@dir_end`, with the prefix compared as bytes too: a compare as bytes is
	 * no key range, and an `OR` with no key range on one side scans the whole
	 * session table, locking every row and gap until COMMIT.
	 */
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

/**
 * `readChunksStart` row: `head` is the row's own content from the offset on,
 * `first_part` the start of the part the read starts at, -1 when there is none,
 * and `first_id` that part's row identity (a rowid on SQLite, as text past
 * 2^53, which a JavaScript number does not hold exactly; `xmin` as text on
 * PostgreSQL), null on MySQL or when there is no such part; the title
 * columns are the row's.
 */
interface ChunksStartRow extends TitleColumns {
	byte_len: number | bigint | string | null;
	content_len: number | bigint | string;
	head: Uint8Array | null;
	first_part: number | bigint | string;
	first_id: number | string | null;
	/** MySQL: the start of the session's last part (see `DialectQueries.readChunksStart`), null when there is none. */
	tail_part?: number | bigint | string | null;
	/** MySQL: the SHA-256 in hex of that part's start in decimal, ":" and its bytes. */
	tail_digest?: string | null;
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

/** `readChunksDigest` row: the digest in upper-case hex. */
interface ChunksDigestRow {
	digest: string;
}

/** `partRowids.next` row: the rowid in decimal, or null when SQLite is to pick it (see `DialectQueries.partRowids`). */
interface RowidRow {
	next_rowid: string | null;
}

/** `PRAGMA data_version` row (SQLite). */
interface DataVersionRow {
	data_version: number | bigint | string;
}

/** What one pass of a chunked read read (see `SqlSessionStorageBackend.readChunks`), which the checks at its end compare. */
interface ChunksPass {
	/** MySQL: the digest of the head and of every part the pass read, each part whole (see `DialectQueries.readChunksDigest`). */
	readonly digest?: Buffer;
	/** SQLite, the read's own pass: the SHA-256 of the bytes the pass yielded. */
	readonly hash?: Bun.CryptoHasher;
	/**
	 * SQLite, the pass with `hash`: the read's start mark (see
	 * `SqlSessionStorageBackend.#sqliteMark`), which the pass takes in the call
	 * queue's turn of its first query, right before it.
	 */
	mark?: string;
	/**
	 * MySQL, a read from inside the title slot (see `SqlSessionStorageBackend.readChunks`): the
	 * transaction whose snapshot every statement of the read reads.
	 */
	readonly snapshot?: SqlSessionStorageTransaction;
	/** The title metadata the first query read with the size: what the read's start record gives. */
	title?: SessionTitleUpdate;
	/**
	 * MySQL: the session's last part as the first query saw it, its start and
	 * its {@link partDigest}, and whether the pass fetched it.
	 */
	tail?: { readonly start: number; readonly digest: Buffer; fetched: boolean };
	/** Bytes the pass yielded. */
	yielded: number;
	/** Where the parts the pass read start: the part it started in, or the end of the row's own content. */
	first: number;
	/** The end of the last part the pass read. */
	next: number;
	/**
	 * The queries whose bytes, or title, the pass yielded: the first one's head,
	 * or its title for a read from inside the title slot, and each page.
	 */
	sources: number;
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

/** The values a directory delete binds (see `DialectQueries.deleteUnder`); a type, so it binds as statement values. */
type UnderDirectory = {
	/** The directory, with its final "/". */
	dir: string;
	/** Its length in characters. */
	len: number;
	/** The directory without its final "/": where its key range starts. */
	stem: string;
	/** The directory with its final "/" made "0": where its key range ends. */
	dir_end: string;
};

/** What `#lockSessionRowsForWrite` answers. */
interface LockedSessionRows {
	/** MySQL and MariaDB without `under`: the paths whose rows it locked, the only ones the caller changes. Elsewhere `undefined`. */
	present: ReadonlySet<string> | undefined;
	/** PostgreSQL and MySQL with `under`: every row it locked, of the paths named and under the directory. Elsewhere none. */
	locked: readonly PathRow[];
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
/** How often a SQLite claim tries a lock another process holds again, within {@link SQLITE_CLAIM_RELEASE_WINDOW_MS}. */
const SQLITE_CLAIM_RETRY_MS = 5;
/** How often a write waiting for its claim's heartbeat to be confirmed again looks. */
const LAPSE_POLL_MS = 50;
/**
 * Largest part a full write, or a batch of appends, stores: a batch's short
 * lines share a part and a long one spans several. A line appended alone is
 * one part of its own length.
 */
const PART_BYTES = 1024 * 1024;
/** The largest rowid SQLite has, 2^63 - 1 (see `DialectQueries.partRowids`). */
const SQLITE_MAX_ROWID = 2n ** 63n - 1n;
/**
 * Bytes the first page of a `readChunks` read spans, from the byte it starts
 * at. A reader that stops within this window (the Agent Hub roster's
 * metadata read stops after a transcript's first records) fetches about this
 * much plus the part the window ends in, and the head of the part it starts
 * in; each next page spans twice the last, up to {@link PAGE_SPAN_BYTES}, so
 * a whole read takes only a few more queries.
 */
const FIRST_PAGE_SPAN_BYTES = 1024 * 1024;
/**
 * Most bytes one `readChunks` page spans: a later page holds the parts that
 * start within its span of where the read is, so at most this much plus the
 * part that starts last. The parts of a full write and of a batch of appends
 * are at most {@link PART_BYTES}; a line appended alone is one part of its own
 * length, so a page stays within 16 MiB while no line appended alone is
 * longer than 4 MiB.
 */
const PAGE_SPAN_BYTES = 12 * 1024 * 1024;
/**
 * Characters MySQL's `path` columns hold (`VARCHAR(512)` in both tables).
 * PostgreSQL and SQLite store `path` as `TEXT`, with no such limit.
 */
const MYSQL_PATH_CHARS = 512;
/** Staging parts one transaction of a streamed full write inserts. */
const STAGING_PARTS_PER_TRANSACTION = 16;
/** Starts a staging path's suffix: `<staging prefix><epoch ms, STAGING_EPOCH_DIGITS wide>-<id>`. */
const STAGING_MARK = "#staging-";
/** Digits of the epoch in a staging path, fixed so that the names of one path sort by age. */
const STAGING_EPOCH_DIGITS = 13;
/** Characters a staging path adds to its prefix: the epoch, "-" and a 16-hex Snowflake id. */
const STAGING_ID_CHARS = STAGING_EPOCH_DIGITS + 1 + 16;
/**
 * The longest path whose staging path, `<path>#staging-<epoch>-<id>`, fits
 * MySQL's `path` column; a longer one stages under its hash (see
 * `#stagingPrefix`).
 */
const MYSQL_PLAIN_STAGING_CHARS = MYSQL_PATH_CHARS - STAGING_MARK.length - STAGING_ID_CHARS;
/**
 * Starts the staging prefix of a path longer than
 * {@link MYSQL_PLAIN_STAGING_CHARS} on MySQL, followed by the path's SHA-256
 * in hex and {@link STAGING_MARK}. No session path starts with "#".
 */
const HASHED_STAGING = "#omp-staging/";
/** Hashes one blob size read asks for. */
const BLOB_READ_BATCH = 100;
/** Bytes one blob read asks for (a larger blob is read alone), so a read holds at most about this much at a time. */
const BLOB_READ_BYTES = 16 * 1024 * 1024;
/** Tries of one blob write before the transcript write waiting for it fails; the blob stays queued for the next. */
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
 * of its own hash lists them; `<prefix><hash>`, the parted blob's own
 * reference, references each part, so no sweep takes a part of a kept blob.
 */
const BLOB_PARTS_PATH = BLOB_PREFIX;
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
 * Whether a SQLite `filename` opens a database that only its own connection
 * sees: `":memory:"`, an in-memory database, or `""`, a private temporary one
 * that SQLite deletes when the connection closes. No other connection can
 * open it, so none can commit to it.
 */
function isPrivateSqliteDatabase(filename: unknown): boolean {
	return filename === "" || filename === ":memory:";
}

/**
 * The call queue every store in this process shares for `client`'s database.
 * Bun's SQLite adapter runs each client's statements on one connection, so a
 * statement issued while another call's transaction is open would join that
 * transaction. And SQLite's busy wait blocks the thread: a client of a file
 * waiting for a lock that another client in this process holds freezes the
 * process for the whole busy timeout, then fails. So calls queue per database
 * file, by its identity ({@link sqliteFileIdentity} of `options.filename`,
 * which `Bun.SQL` sets), so two spellings of one file share a queue, and the
 * busy wait only ever waits on other processes. Private databases
 * ({@link isPrivateSqliteDatabase}), and wrappers that hide
 * `options.filename`, queue per client object.
 */
function sqliteQueue(client: SqlSessionStorageClient): SqliteQueue {
	const filename = client.options.filename;
	if (typeof filename !== "string" || isPrivateSqliteDatabase(filename)) {
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

/** Slots of {@link SqliteWrites.slots}: a client keeps this many write counts, however many paths it writes. */
const SQLITE_WRITE_SLOTS = 1024;

/**
 * SQLite: the writes one client made that can change the bytes of a session
 * path. A chunked read compares them, with `PRAGMA data_version`, before its
 * first query and at its end (see `SqlSessionStorageBackend.readChunks`). The
 * pragma moves when another connection, of this process or another, commits
 * to the database file, and never for the connection's own commits; these
 * counts cover those. A write counts in the slot of its path
 * ({@link sqliteWriteSlot}), one of {@link SQLITE_WRITE_SLOTS}, so the counts
 * hold the same memory however many paths a process writes in its life. Two
 * paths that share a slot only cause extra check passes of a read (at most
 * two), never a missed one: a parent's appends make its subagents' reads check again only
 * when their paths share a slot. A slot's count wraps at 2^32, which makes a
 * read's end mark equal its start mark only when 2^32 writes of its slot land
 * between them. A directory delete, which can change every path under the
 * directory, counts once for every path.
 */
interface SqliteWrites {
	/** Writes that can change every path: directory deletes. */
	every: number;
	/** Writes of the paths of each slot: appends, full writes and the swaps of staged ones, deletes, both paths of a rename. */
	readonly slots: Uint32Array;
}

/** The slot of {@link SqliteWrites.slots} that counts the writes of `path`. */
function sqliteWriteSlot(path: string): number {
	return Bun.hash.xxHash32(path) % SQLITE_WRITE_SLOTS;
}

/** {@link SqliteWrites} by client: a store has one client, and stores that share a client share its connection. */
const sqliteClientWrites = new WeakMap<SqlSessionStorageClient, SqliteWrites>();

/** The write counts of `client`'s connection (see {@link SqliteWrites}), shared by every store on that client. */
function sqliteWrites(client: SqlSessionStorageClient): SqliteWrites {
	let writes = sqliteClientWrites.get(client);
	if (!writes) {
		writes = { every: 0, slots: new Uint32Array(SQLITE_WRITE_SLOTS) };
		sqliteClientWrites.set(client, writes);
	}
	return writes;
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
 * The first statement of every PostgreSQL transaction the store runs, and of
 * every read it sends on its own: every function, operator and type its
 * statements name is then found in `pg_catalog` alone (`pg_temp` is never
 * searched for functions or operators, and comes after `pg_catalog` for
 * relations), so one that a login with `CREATE` on the store's schema planted
 * there, an exact match where `pg_catalog` has only one through an implicit
 * cast (the CVE-2018-1058 class), is never picked. The store's own tables are
 * named `public.<table>` ({@link PG_SCHEMA}). `SET LOCAL` ends with the
 * transaction, so a transaction-mode pooler hands nothing on. The CLI's
 * client sets no connection-level `search_path` (PgBouncer before 1.26
 * refuses one), so this lock is what every statement runs under.
 */
const PG_SEARCH_PATH = "SET LOCAL search_path = pg_catalog, pg_temp";
/** The heartbeat's opening: search_path lock and both bounds in one simple query, so they cost one round trip. */
const PG_HEARTBEAT_OPENING = `${PG_SEARCH_PATH}; SET LOCAL lock_timeout = ${LEASE_HEARTBEAT_TRANSACTION_BOUND_MS}; SET LOCAL idle_in_transaction_session_timeout = ${LEASE_HEARTBEAT_TRANSACTION_BOUND_MS}`;
/** The schema of the store's PostgreSQL tables, which every statement names them with. */
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

/** {@link PG_TABLES_PRESENT} row. A boolean arrives as `true` bound and as `t` in a simple query's text. */
interface TablesPresentRow {
	session: boolean | string;
	parts: boolean | string;
	lease: boolean | string;
	blobs: boolean | string;
	refs: boolean | string;
	read_only_setting: string;
	read_only_reset_val: string;
	in_recovery: boolean | string;
}

/** A PostgreSQL boolean as {@link PG_TABLES_PRESENT} returns it: `true` bound, `t` in a simple query's text. */
function pgTrue(value: boolean | string | undefined): boolean {
	return value === true || value === "t";
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
 * `query` with each bound value written into it as an untyped literal, so it
 * can go in one simple query with {@link PG_SEARCH_PATH}: Bun neither
 * pipelines nor binds values in a multi-statement query, and one round trip
 * per read is what a read cost before the lock. A value is dollar-quoted with
 * a tag that occurs nowhere in it and that its end cannot make with the
 * closing `$` (a value ending in `$omp` would close `$omp$…$omp$` early), so
 * nothing in it is read as SQL whatever `standard_conforming_strings` is; a
 * space on each side keeps the quote apart from the text around it. As an
 * untyped literal it takes its type from where it is used, as an unbound
 * parameter does from its first use. Numbers go in as their decimal digits;
 * only integers are bound. A string holding NUL, which a simple query cannot
 * carry, is refused, as PostgreSQL refuses it as a bound text value.
 */
function inlinePostgres(query: Statement, values: StatementValues): string {
	const literals = query.params.map(name => {
		const value = values[name];
		if (value === undefined) throw new Error(`SqlSessionStorage: no value bound for @${name}`);
		if (value === null) return "NULL";
		let text: string;
		if (typeof value === "string") text = value;
		else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
		else throw new Error(`SqlSessionStorage: cannot write @${name} into a read (${typeof value})`);
		if (text.includes("\0")) throw new Error(`SqlSessionStorage: @${name} holds a NUL character`);
		let tag = "omp";
		for (let n = 0; `${text}$`.includes(`$${tag}$`); n++) tag = `omp${n}`;
		return ` $${tag}$${text}$${tag}$ `;
	});
	// One pass over the statement's own text: a written value is never read again.
	return query.sql.replace(/\$(\d+)/g, (_marker, index: string) => {
		const literal = literals[Number(index) - 1];
		if (literal === undefined) throw new Error(`SqlSessionStorage: no value bound for $${index}`);
		return literal;
	});
}

/** The columns of one of the store's PostgreSQL tables, as {@link SqlSessionStorageBackend}'s table check reads them. */
const PG_TABLE_COLUMNS = statement(
	"postgres",
	"SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, " +
		"a.atthasdef AS has_default, a.attgenerated::text AS generated, a.attidentity::text AS identity " +
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
/** The columns of the store's PostgreSQL tables and their declared types, as `format_type` prints them. */
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
} satisfies Record<string, Record<string, string>>;

/** {@link PG_TABLE_COLUMNS} row. */
interface TableColumnRow {
	name: string;
	type: string;
	has_default: boolean;
	generated: string;
	identity: string;
}

/** {@link PG_TABLE_OBJECTS} row. */
interface TableObjectRow {
	kind: string;
	name: string;
}

/**
 * The collation the parts table's `path` column compares with, and the
 * database's, as `to_jsonb` prints their catalog rows: the column's own
 * collation, or for the default collation (provider `d`) the database's. The
 * rows are read whole so the columns of every version since PostgreSQL 10
 * can be read by name (`datlocprovider` exists since 15).
 */
const PG_PATH_COLLATION = statement(
	"postgres",
	"SELECT pg_catalog.to_jsonb(c)::pg_catalog.text AS collation, pg_catalog.to_jsonb(d)::pg_catalog.text AS database " +
		"FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_collation c ON c.oid = a.attcollation " +
		"JOIN pg_catalog.pg_database d ON d.datname = pg_catalog.current_database() " +
		"WHERE a.attrelid = pg_catalog.to_regclass(@table) AND a.attname = 'path' AND NOT a.attisdropped",
);

/** {@link PG_PATH_COLLATION} row. */
interface PathCollationRow {
	collation: string;
	database: string;
}

/**
 * Whether the collation of {@link PG_PATH_COLLATION}'s row compares by code
 * point, so that it sorts every path under a directory `<stem>/` above
 * `<stem>` and below `<stem>0`, and the directory delete may find them by a
 * key range (see `deleteUnder`): the builtin provider, and libc's `C` and
 * `POSIX`. Any other collation may sort a path under the directory outside
 * that range, and the delete then compares the prefix alone. A libc locale
 * such as `en_US.UTF-8` ignores "/" at its first level; ICU's Thai collation
 * makes punctuation ignorable at its first level (`'/s/a/b' < '/s/a0'` is
 * false under `th-x-icu`), and any ICU locale's tailoring, extension keywords
 * (`-u-ka-shifted`, `-u-kr-`) or rules can do the same.
 */
function pathCollationKeepsDirectoryRange(row: PathCollationRow | undefined): boolean {
	if (!row) return false;
	const collation = JSON.parse(row.collation) as Record<string, unknown>;
	const database = JSON.parse(row.database) as Record<string, unknown>;
	const own = collation.collprovider !== "d";
	const provider = own ? collation.collprovider : (database.datlocprovider ?? "c");
	if (provider === "b") return true;
	if (provider !== "c") return false;
	const locale = own ? collation.collcollate : database.datcollate;
	return locale === "C" || locale === "POSIX";
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
	// PostgreSQL statements name every table with its schema, since they run under PG_SEARCH_PATH.
	const relation = (relationName: string): string =>
		schema === undefined ? relationName : `${quoteIdentifier(schema)}.${relationName}`;
	const table = relation(name);
	const parts = relation(`${name}_parts`);
	const blobs = relation(`${name}_blobs`);
	const refs = relation(`${name}_refs`);
	const sql = (template: string): Statement => statement(adapter, template);
	/** `@<prefix>0, …, @<prefix><count - 1>`, an IN list's bound values. */
	const inList = (prefix: string, count: number): string =>
		Array.from({ length: count }, (_unused, index) => `@${prefix}${index}`).join(", ");
	const blobByteLength = adapter === "postgres" ? "octet_length(content)" : "length(content)";
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
	// A part's row identity (see DialectQueries.partRowids), which readChunksStart reads and readParts compares with
	// what it read; MySQL has none. A SQLite rowid past 2^53, which a JavaScript number does not hold exactly, is text.
	const partId = {
		postgres: "CAST(p.xmin AS text)",
		mysql: undefined,
		sqlite:
			`CASE WHEN p.rowid BETWEEN ${-Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER} THEN p.rowid ` +
			"ELSE CAST(p.rowid AS text) END",
	}[adapter];
	const emptyBytes = { postgres: "''::bytea", mysql: "cast('' AS binary)", sqlite: "x''" }[adapter];
	const greatest = adapter === "sqlite" ? "max" : "greatest";
	// PostgreSQL's substr takes integer positions; offsets within one value always fit.
	const position = (expr: string): string => (adapter === "postgres" ? `CAST(${expr} AS integer)` : expr);
	// PostgreSQL types a bare parameter from its first use; offsets past 2^31 need bigint.
	const bigint = (expr: string): string => (adapter === "postgres" ? `CAST(${expr} AS bigint)` : expr);
	const rowColumns = "path, content, mtime_ms, title, title_source, title_updated_at, byte_len";
	const rowValues = "@path, '', @mtime, @title, @title_source, @title_updated_at, @len";
	// Grow the session row by `@len` bytes, inserting it when missing: the first step of an append and of a batch.
	const growRow =
		`INSERT INTO ${table} (path, content, mtime_ms, byte_len) VALUES (@path, '', @mtime, @len) ` +
		(mysql
			? "ON DUPLICATE KEY UPDATE byte_len = byte_len + @len, mtime_ms = @mtime"
			: `ON CONFLICT (path) DO UPDATE SET byte_len = ${table}.byte_len + excluded.byte_len, mtime_ms = excluded.mtime_ms`);
	// Scalar subqueries rather than a CTE, so MySQL 5.7 runs this too.
	const tailStart = `(SELECT byte_len FROM ${table} WHERE path = @path) - @suffix`;
	// The parts of `r`'s session that start at or before where a chunked read
	// starts, or, when that is inside `r`'s own content, where that content ends.
	const startPart =
		`FROM ${parts} AS p WHERE p.path = @path ` +
		`AND p.start_offset <= ${greatest}(${bigint("@offset")}, ${byteLengthOf("r.content")})`;
	// MySQL: the last part of `r`'s session that starts before its size, the one a chunked read to the end fetches last.
	const tailPart = `FROM ${parts} AS t WHERE t.path = @path AND t.start_offset < r.byte_len ORDER BY t.start_offset DESC LIMIT 1`;
	// MySQL: the SHA-256 in hex of `offset` in decimal, ":" and `bytes`, which partDigest computes on the client.
	const partDigestOf = (offset: string, bytes: string): string => `SHA2(CONCAT(${offset}, ':', ${bytes}), 256)`;
	// `<column>` starts with `<value>`: its first `@len` characters equal it, exactly, whatever the column's collation.
	// On PostgreSQL as code points (`COLLATE "C"`): `substr` of a column takes the column's collation, and under a
	// nondeterministic one (a case-insensitive ICU collation, say) "R/A/" equals "R/a/". On MySQL and MariaDB as bytes,
	// so that no collation, and no key range the server makes of the compare, answers it: MariaDB 11.8 finds no path
	// whose character after the prefix sorts below the space by `substr(path, 1, n) = …`, as utf8mb4_bin's PAD SPACE
	// orders it. SQLite compares a function's result, which is not a column, with BINARY (memcmp), whatever the
	// column's collation (https://www.sqlite.org/datatype3.html#assigning_collating_sequences_from_sql).
	const startsWith = (column: string, value: string): string =>
		({
			postgres: `substr(${column}, 1, @len) COLLATE "C" = ${value}`,
			mysql: `CAST(substr(${column}, 1, @len) AS BINARY) = CAST(${value} AS BINARY)`,
			sqlite: `substr(${column}, 1, @len) = ${value}`,
		})[adapter];
	// `<column>` is a path under `@dir`: with `range`, within the directory's key range from `@stem` up to
	// `@dir_end` first, so the server reads (and a locking statement locks) only that range, then the prefix itself
	// (see deleteUnder).
	const underDirectory = (column: string, range: boolean): string =>
		`${range ? `${column} >= @stem AND ${column} < @dir_end AND ` : ""}${startsWith(column, "@dir")}`;
	// SQLite only: the rowid a part inserted at `@now` (ms since the epoch) takes, see DialectQueries.partRowids; null,
	// for SQLite to pick one, when the largest rowid is SQLITE_MAX_ROWID already, whose `+ 1` is a REAL no rowid takes.
	// `@now * 1024` stays below 2^63 for every date a `Date` holds.
	const nextRowid =
		`CASE WHEN coalesce(max(rowid), 0) < ${SQLITE_MAX_ROWID} ` +
		"THEN max(coalesce(max(rowid), 0) + 1, CAST(@now AS INTEGER) * 1024) END";
	const deleteUnder = (range: boolean): Statement[] =>
		({
			postgres: [
				sql(
					`WITH gone AS (DELETE FROM ${table} WHERE ${startsWith("path", "@dir")} RETURNING path) ` +
						`DELETE FROM ${parts} WHERE path IN (SELECT path FROM gone)`,
				),
				sql(
					`DELETE FROM ${parts} AS p WHERE ${underDirectory("p.path", range)} ` +
						`AND NOT EXISTS (SELECT 1 FROM ${table} AS r WHERE r.path = p.path)`,
				),
			],
			mysql: [
				sql(
					`DELETE r, p FROM ${table} AS r LEFT JOIN ${parts} AS p ON p.path = r.path ` +
						// The key range first, so the delete reads and locks only the rows under `@dir`.
						`WHERE ${underDirectory("r.path", range)}`,
				),
				sql(
					`DELETE p FROM ${parts} AS p LEFT JOIN ${table} AS r ON r.path = p.path ` +
						`WHERE ${underDirectory("p.path", range)} AND r.path IS NULL`,
				),
			],
			sqlite: [
				sql(`DELETE FROM ${parts} WHERE ${startsWith("path", "@dir")}`),
				sql(`DELETE FROM ${table} WHERE ${startsWith("path", "@dir")}`),
			],
		})[adapter];

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
							`WITH s AS (${growRow} RETURNING byte_len) ` +
								`INSERT INTO ${parts} (path, start_offset, content) ` +
								`SELECT @path, s.byte_len - @len, @content FROM s WHERE @len > 0`,
						),
					]
				: [
						sql(growRow),
						sql(
							mysql
								? `INSERT INTO ${parts} (path, start_offset, content) ` +
										`SELECT path, byte_len - @len, @content FROM ${table} WHERE path = @path AND @len > 0`
								: `INSERT INTO ${parts} (rowid, path, start_offset, content) ` +
										`SELECT (SELECT ${nextRowid} FROM ${parts}), path, byte_len - @len, @content ` +
										`FROM ${table} WHERE path = @path AND @len > 0`,
						),
					],
		growRow: sql(mysql ? growRow : `${growRow} RETURNING byte_len`),
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
		deleteUnder: deleteUnder(true),
		// Only PostgreSQL's `path` column can carry a collation the range misses: MySQL's tables are `utf8mb4_bin`,
		// whose PAD SPACE the range's start at `@stem` allows for (see DialectQueries.deleteUnder).
		deleteUnderScan: deleteUnder(adapter !== "postgres"),
		deleteStaging: sql(`DELETE FROM ${parts} WHERE path >= @low AND path < @high AND ${startsWith("path", "@low")}`),
		hasStaging: sql(
			`SELECT 1 AS found FROM ${parts} WHERE path >= @low AND path < @high AND ${startsWith("path", "@low")} LIMIT 1`,
		),
		stagedBytes: sql(
			`SELECT ${contentByteLength} AS len FROM ${parts} WHERE path = @path${adapter === "sqlite" ? "" : " FOR UPDATE"}`,
		),
		insertPart: sql(
			adapter === "sqlite"
				? `INSERT INTO ${parts} (rowid, path, start_offset, content) ` +
						`VALUES ((SELECT ${nextRowid} FROM ${parts}), @path, @offset, @content)`
				: `INSERT INTO ${parts} (path, start_offset, content) VALUES (@path, @offset, @content)`,
		),
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
			`SELECT 0 AS kind, 0 AS start_offset, content, title, title_source, title_updated_at FROM ${table} ` +
				`WHERE path = @path UNION ALL SELECT 1, start_offset, content, NULL, NULL, NULL FROM ${parts} ` +
				"WHERE path = @path",
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
				`ELSE ${emptyBytes} END AS tail, title, title_source, title_updated_at FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, substr(${contentBytes}, 1, ${position("@prefix - start_offset")}), NULL, ` +
				`NULL, NULL, NULL FROM ${parts} WHERE path = @path AND start_offset < @prefix ` +
				`UNION ALL SELECT 2, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${tailStart} - start_offset) + 1`)}), NULL, NULL, NULL ` +
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
				`ELSE ${emptyBytes} END AS bytes, title, title_source, title_updated_at FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${bigint("@offset")} - start_offset) + 1`)}, ` +
				`${position("@take")}), NULL, NULL, NULL ` +
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
			`SELECT byte_len, ${contentByteLength} AS content_len, title, title_source, title_updated_at, ` +
				`CASE WHEN ${bigint("@offset")} < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position("@row_from")}) ELSE ${emptyBytes} END AS head, ` +
				`(SELECT coalesce(max(p.start_offset), -1) ${startPart}) AS first_part, ` +
				`${partId ? `(SELECT ${partId} ${startPart} ORDER BY p.start_offset DESC LIMIT 1)` : "NULL"} AS first_id` +
				(mysql
					? `, (SELECT t.start_offset ${tailPart}) AS tail_part, ` +
						`(SELECT ${partDigestOf("t.start_offset", "cast(t.content AS binary)")} ${tailPart}) AS tail_digest`
					: "") +
				` FROM ${table} AS r WHERE r.path = @path`,
		),
		readParts: sql(
			`SELECT start_offset, content FROM ${parts} WHERE path = @path AND start_offset >= ${bigint("@next")} ` +
				`AND start_offset < ${bigint("@end")} ` +
				(partId
					? `AND EXISTS (SELECT 1 FROM ${parts} AS p WHERE p.path = @path ` +
						`AND p.start_offset = ${bigint("@anchor")} AND ${partId} = @anchor_id) `
					: "") +
				// PostgreSQL's `xmin` changes with every insert, so the first part's identity is enough there. SQLite
				// also finds the last part fetched unchanged, as a writer older than its rowid rule reuses rowids, and so
				// does SQLite for a part the rule has no room for (see DialectQueries.partRowids).
				(adapter === "sqlite"
					? `AND (@last < 0 OR EXISTS (SELECT 1 FROM ${parts} AS q WHERE q.path = @path AND q.start_offset = @last ` +
						"AND q.content = @last_content)) "
					: "") +
				"ORDER BY start_offset",
		),
		// The halves of each item's SHA-256 in hex, read as unsigned 64-bit integers, XORed and printed in hex
		// again. `CAST(content AS binary)` keeps the bytes (utf8mb4_bin's PAD SPACE only affects comparisons).
		readChunksDigest: mysql
			? sql(
					"SELECT CONCAT(LPAD(HEX(BIT_XOR(CAST(CONV(SUBSTR(d.h, 1, 16), 16, 10) AS UNSIGNED))), 16, '0'), " +
						"LPAD(HEX(BIT_XOR(CAST(CONV(SUBSTR(d.h, 17, 16), 16, 10) AS UNSIGNED))), 16, '0')) AS digest FROM (" +
						`SELECT ${partDigestOf("CAST(@offset AS SIGNED)", `substr(${contentBytes}, @row_from)`)} AS h ` +
						`FROM ${table} WHERE path = @path AND @offset < ${contentByteLength} ` +
						`UNION ALL SELECT ${partDigestOf("start_offset", contentBytes)} FROM ${parts} ` +
						"WHERE path = @path AND start_offset >= @first AND start_offset < @end) AS d",
				)
			: undefined,
		partRowids:
			adapter === "sqlite"
				? {
						next: sql(`SELECT CAST(${nextRowid} AS TEXT) AS next_rowid FROM ${parts}`),
						insert: sql(
							`INSERT INTO ${parts} (rowid, path, start_offset, content) VALUES (@rowid, @path, @offset, @content)`,
						),
					}
				: undefined,
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
		// Exactly the paths whose rows the directory delete takes (see deleteUnder), whatever the column's collation.
		refsUnder: sql(`SELECT sha256, path FROM ${refs} WHERE ${startsWith("path", "@dir")}`),
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
								// The rows under `@dir` that the directory delete takes: those whose prefix is exactly
								// `@dir`, whatever the column's collation (see deleteUnder), on MySQL and MariaDB within its
								// key range, so the lock reads and locks only those rows and the gaps around them.
								(under ? ` OR (${underDirectory("path", mysql)})` : "") +
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
 * The title metadata a session row's title columns hold: `undefined` when no
 * title update or titled full write set its time (`title_updated_at`), as on a
 * row from before the columns existed, which keeps the title slot it stores.
 */
function rowTitle(row: TitleColumns): SessionTitleUpdate | undefined {
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

/** Bytes of a chunked read's digest on MySQL (see `DialectQueries.readChunksDigest`). */
const CHUNKS_DIGEST_BYTES = 16;

/**
 * The digest of the bytes a chunked read fetched at `offset` on MySQL, a part
 * or the row's own content from there, as `DialectQueries.readChunksStart`
 * (`tail_digest`) and `DialectQueries.readChunksDigest` compute it: the
 * SHA-256 of `offset` in decimal, ":" and `bytes`.
 */
function partDigest(offset: number, bytes: Uint8Array): Buffer {
	return new Bun.CryptoHasher("sha256").update(`${offset}:`).update(bytes).digest();
}

/**
 * XOR into `digest` the first {@link CHUNKS_DIGEST_BYTES} of the
 * {@link partDigest} of one item a chunked read yielded, as
 * `DialectQueries.readChunksDigest` folds it.
 */
function addChunkDigest(digest: Buffer, item: Buffer): void {
	for (let i = 0; i < CHUNKS_DIGEST_BYTES; i++) digest[i] ^= item[i];
}

/**
 * The parts a batch of appends stores for `lines`, in order, each at most
 * {@link PART_BYTES}: whole lines share a part while they fit, and a longer
 * line is cut at character boundaries, its last piece starting the next part.
 * No part, and no string made, is longer than that. A part holds each line's
 * own UTF-8 encoding, so its bytes are the sum the batch adds to `byte_len`.
 */
function* appendedParts(lines: readonly string[]): Generator<{ content: string; bytes: number }> {
	let pieces: string[] = [];
	let size = 0;
	for (const line of lines) {
		const bytes = Buffer.byteLength(line, "utf8");
		if (size > 0 && size + bytes > PART_BYTES) {
			yield { content: pieces.join(""), bytes: size };
			pieces = [];
			size = 0;
		}
		if (bytes <= PART_BYTES) {
			// Well formed, as its UTF-8 encoding is (a lone surrogate as U+FFFD): joined raw, a line that ends in a
			// lone high surrogate and the next, starting with the lone low one, would make one 4-byte character of
			// the 6 bytes their lengths count.
			pieces.push(line.toWellFormed());
			size += bytes;
			continue;
		}
		const encoded = Buffer.from(line, "utf8");
		let start = 0;
		for (let end = utf8PartEnd(encoded, start, PART_BYTES); end < encoded.byteLength;) {
			yield { content: encoded.toString("utf8", start, end), bytes: end - start };
			start = end;
			end = utf8PartEnd(encoded, start, PART_BYTES);
		}
		pieces.push(encoded.toString("utf8", start));
		size = encoded.byteLength - start;
	}
	if (size > 0) yield { content: pieces.join(""), bytes: size };
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file is a row of the session table keyed by `path`, holding
 * its metadata (`byte_len`, `mtime_ms`, title fields), plus rows of
 * `<table>_parts` keyed by (`path`, `start_offset`): an append inserts its
 * line as one part, a batch of appends its lines as parts of at most 1 MiB,
 * a full write replaces them with parts of at most 1 MiB (a streamed
 * one stages them under `<path>#staging-…`, or on MySQL for a path too long
 * for that a name made from its hash, first and swaps them in). A
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
	/** {@link SessionStorage.retargetWriterClaim}, set as {@link claimSession} is. */
	readonly retargetWriterClaim: SessionStorage["retargetWriterClaim"];
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
		// One writer slot per session in this store; it goes first and comes back last, and a refused claim gives it back at once.
		const writers: SqlWriterSlots = new Map();
		const withWriterSlot =
			(free: () => void, release: () => void): (() => void) =>
			() => {
				release();
				free();
			};
		this.claimSession = (sessionId, sessionPath, options) => {
			const file = path.resolve(sessionPath);
			const free = takeSqlWriterSlot(writers, sessionId, file, options);
			if (!free) return null;
			const claim = backend.claim(sessionId, file, options?.onLost);
			if (!claim) {
				free();
				return null;
			}
			return withWriterSlot(free, releaser(claim, file, options?.onLost));
		};
		this.acquireSessionClaim = async (sessionId, sessionPath, options) => {
			const file = path.resolve(sessionPath);
			const free = takeSqlWriterSlot(writers, sessionId, file, options);
			if (!free) return null;
			const claim = await backend.acquire(sessionId, file, options ?? {}, settle).catch((err: unknown) => {
				free();
				throw err;
			});
			if (!claim) {
				free();
				return null;
			}
			return withWriterSlot(free, releaser(claim, file, options?.onLost));
		};
		this.sessionClaimLost = sessionId => backend.claimLost(sessionId);
		this.sessionClaimHolder = sessionId => backend.claimHolder(sessionId);
		this.retargetWriterClaim = (sessionId, sessionPath) => {
			const slot = writers.get(sessionId);
			if (slot && slot.count > 0) slot.path = path.resolve(sessionPath);
		};
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
			// A blob that still does not land was warned about, and failed the transcript write that named it.
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
 * waits for none. A blob write is tried {@link BLOB_WRITE_ATTEMPTS} times;
 * one that still fails stays queued and fails the transcript writes naming
 * it, which the session reports as a persistence error, and the next such
 * write tries it again. Writes run one after another, so a burst of images
 * holds one connection at a time; one that fails does not stop the others.
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
	 * `hashes` did not land in {@link BLOB_WRITE_ATTEMPTS} tries; it stays
	 * queued. Another blob that fails does not reject it.
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

	async #landQueued(): Promise<void> {
		for (const [hash, blob] of [...this.#queued]) {
			if (this.#queued.get(hash) !== blob) continue;
			try {
				await this.#landOne(hash, blob.data, blob.mimeType);
				this.#failed.delete(hash);
			} catch (err) {
				this.#failed.set(hash, toError(err));
			}
		}
	}

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
				if (attempt < BLOB_WRITE_ATTEMPTS) {
					await Bun.sleep(BLOB_RETRY_MS * 2 ** (attempt - 1));
					continue;
				}
				const error = toError(err);
				logger.warn("Storing a session blob in the session database failed; the next write naming it tries again", {
					hash,
					bytes: data.byteLength,
					attempts: attempt,
					error: error.message,
				});
				throw new Error(
					`SqlSessionStorage: session image ${hash} did not reach ${this.#backend.table}_blobs, ` +
						`so no transcript naming it is written yet: ${error.message}`,
					{ cause: error },
				);
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

/** `items` bound as `@<prefix>0` … for an IN list built with the same prefix. */
function listValues(prefix: string, items: readonly string[]): StatementValues {
	return Object.fromEntries(items.map((item, index) => [`${prefix}${index}`, item]));
}

const BLOB_REF_IN_TEXT = new RegExp(`${BLOB_PREFIX}([0-9a-f]{64})`, "g");

/** The blob hashes `text` (a transcript, or one line of it) names. */
function namedBlobHashes(text: string): Set<string> {
	const hashes = new Set<string>();
	if (!text.includes(BLOB_PREFIX)) return hashes;
	for (const match of text.matchAll(BLOB_REF_IN_TEXT)) hashes.add(match[1] ?? "");
	return hashes;
}

/** Characters a blob reference spans in text: {@link BLOB_PREFIX} and its 64 hex digits. */
const BLOB_REF_CHARS = BLOB_PREFIX.length + 64;

/**
 * The blob hashes a text that arrives in pieces names, as {@link namedBlobHashes} finds them in the whole text: a
 * reference that straddles two pieces too, found where the end of the text so far meets the next piece.
 */
class StreamedBlobHashes {
	readonly hashes = new Set<string>();
	/** The last characters of the text so far, where a reference that ends in a later piece can start. */
	#tail = "";

	add(piece: string): void {
		for (const hash of namedBlobHashes(this.#tail + piece.slice(0, BLOB_REF_CHARS))) this.hashes.add(hash);
		for (const hash of namedBlobHashes(piece)) this.hashes.add(hash);
		this.#tail =
			piece.length >= BLOB_REF_CHARS ? piece.slice(-BLOB_REF_CHARS) : (this.#tail + piece).slice(-BLOB_REF_CHARS);
	}
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
 * The writer slot of each session one SQL store writes, by the transcript's
 * own session id (a subagent transcript's, not its lease's): one journal has
 * one writer per store, as file storage's lease `writers` count keeps one per
 * process (see {@link SessionClaimOptions.writer}). The CLI opens one store
 * per process, so that is one writer per process; two stores are two lease
 * holders, as two processes are. A claim without `writer` (a transfer guard)
 * takes no slot and shares the lease.
 */
type SqlWriterSlots = Map<string, { count: number; path: string }>;

/**
 * Take `sessionId`'s writer slot in `writers` at `file` for a claim with
 * `options.writer`, returning the function that gives it back; `null` while
 * another writer of this store holds the session, unless `options.handover`
 * takes a slot beside the writer of that same file. A claim without `writer`
 * gets a no-op.
 */
function takeSqlWriterSlot(
	writers: SqlWriterSlots,
	sessionId: string,
	file: string,
	options: SessionClaimOptions | undefined,
): (() => void) | null {
	if (options?.writer !== true) return () => {};
	const held = writers.get(sessionId);
	if (held && held.count > 0 && !(options.handover === true && held.path === file)) return null;
	const slot = held ?? { count: 0, path: file };
	slot.count++;
	slot.path = file;
	writers.set(sessionId, slot);
	let freed = false;
	return () => {
		if (freed) return;
		freed = true;
		if (--slot.count === 0 && writers.get(sessionId) === slot) writers.delete(sessionId);
	};
}

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
	/** This client's writes of session paths on SQLite (see {@link SqliteWrites}); unset on other dialects. */
	readonly #sqliteWrites: SqliteWrites | undefined;
	/** Whether the SQLite database is private ({@link isPrivateSqliteDatabase}): its connection's alone, where no other connection commits. */
	readonly #sqlitePrivate: boolean;
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
	/**
	 * Whether the directory delete finds the parts under a directory by a key
	 * range ({@link DialectQueries.deleteUnder}) or by the prefix alone
	 * ({@link DialectQueries.deleteUnderScan}); on PostgreSQL set at start-up
	 * from the `path` column's collation ({@link pathCollationKeepsDirectoryRange}).
	 */
	#directoryRange = true;
	/** The largest blob the table takes on this server, once read (see {@link maxBlobBytes}). */
	#maxBlobBytes: Promise<number> | undefined;
	/** The `maxBlobBytes` option, or {@link MAX_BLOB_BYTES}. */
	readonly #maxRowBlobBytes: number;
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
		this.#sqliteWrites = this.#adapter === "sqlite" ? sqliteWrites(options.client) : undefined;
		const filename = options.client.options.filename;
		this.#sqliteFile =
			this.#adapter === "sqlite" && typeof filename === "string" && !isPrivateSqliteDatabase(filename)
				? path.resolve(filename)
				: undefined;
		this.#sqlitePrivate = this.#adapter === "sqlite" && isPrivateSqliteDatabase(filename);
		if (options.claims === true) {
			if (this.#adapter !== "sqlite") this.#gate = "row";
			// A private database is this connection's alone: nobody else can open its sessions.
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
			// One look at the PostgreSQL tables and the server, for a store that
			// would write there (claims, or makes tables): a server in recovery
			// accepts no write, so the store refuses to start on it.
			const look =
				this.#adapter === "postgres" && (this.#gate === "row" || this.#createTable)
					? (((await this.#readOne(PG_TABLES_PRESENT, this.#pgTableNames())) as TablesPresentRow[])[0] ??
						undefined)
					: undefined;
			if (look && pgTrue(look.in_recovery)) {
				throw new Error(
					`SqlSessionStorage: the PostgreSQL server is in recovery (a hot standby or a read replica), which accepts no write, so a store that ${this.#gate === "row" ? "claims sessions" : "makes its tables"} cannot start on it. Point the DSN at the primary.`,
				);
			}
			if (!this.#createTable) {
				await this.#assertSchema();
				await this.#checkTables();
				await this.#readPathCollation();
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
			const { columns, holder } = await this.#read(async executor => ({
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
			if ((await this.#readOne(this.#q.findUnmeasured)).length > 0) {
				await this.#setup(this.#q.backfillByteLen);
			}
			if (createIndex && holder && !holder.indexed && !holder.nameTakenBy) await this.#setup(createIndex);
			await this.#checkTables();
			await this.#readPathCollation();
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
	 * the session. On a SQLite file, whose claim is an OS lock, the claim of
	 * a lock another process holds keeps trying it until
	 * {@link SQLITE_CLAIM_RELEASE_WINDOW_MS} after the claim began, so a
	 * holder that lets the session go meanwhile does not move it: the store
	 * tries again every {@link SQLITE_CLAIM_RETRY_MS}, never past `waitMs`,
	 * after a native claim that answered at once, and not after one that
	 * itself waited out the window. A SQLite claim waits about that long at
	 * most, and `onWait` never hears a holder there, since the lock names
	 * none. Elsewhere, with `waitMs`, a holder's lease is read again every
	 * second until it is gone or expired on the database clock, `onWait`
	 * hearing the holder once, and the session claimed then, all within
	 * `waitMs`: a claim statement that waited past its lock bound behind
	 * another process's write is refused, and tried again only while the
	 * wait lasts. A claim statement that fails for another reason (the
	 * database is unreachable) counts as held, as a file claim that cannot be
	 * probed does: it never refuses a session, and the first write under it
	 * runs the statement again.
	 */
	async acquire(
		sessionId: string,
		file: string,
		options: SessionAcquireOptions,
		settle: (paths: readonly string[]) => Promise<void>,
	): Promise<LeaseClaim | null> {
		const started = performance.now();
		const deadline = started + (options.waitMs ?? 0);
		const lockDeadline =
			started + Math.min(SQLITE_CLAIM_RELEASE_WINDOW_MS, options.waitMs ?? Number.POSITIVE_INFINITY);
		let waiting = false;
		for (;;) {
			const lockBound = options.waitMs === undefined ? LEASE_CLAIM_LOCK_BOUND_MS : deadline - performance.now();
			const claim = this.claim(sessionId, file, options.onLost, lockBound);
			if (!claim) {
				// Only a SQLite claim's OS lock refuses here: another process holds it, and may be letting it go.
				const left = lockDeadline - performance.now();
				if (left <= 0) return null;
				await Bun.sleep(Math.min(SQLITE_CLAIM_RETRY_MS, left));
				continue;
			}
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
			await this.#readWrite(async transaction => {
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
			const [head] = await this.readSlices(file, SESSION_HEADER_PREFIX_BYTES, 0).catch(() => [""]);
			const id = sessionHeaderIdInPrefix(head ?? "");
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
				await this.#readWrite(async transaction => {
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
	 * store lives. PostgreSQL sends every heartbeat through {@link #readWrite}
	 * on its first try: its lock and idle-in-transaction timeouts are `SET
	 * LOCAL`, so no session setting crosses a transaction-mode pool. Its row
	 * locks can last through one COMMIT round trip, but the server ends a
	 * stalled transaction 1.5 s before a fence would mark its claim lost. A
	 * heartbeat whose transaction or COMMIT answer is lost is a failed beat:
	 * it leaves every claim as it is until another database answer proves it
	 * held or lost.
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
				await this.#readWrite(async transaction => {
					refreshed = (await run(transaction, lease.heartbeat(live.length), values)) as Array<{
						session_id: string;
					}>;
				}, "heartbeat");
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
		return this.#readOne(lease.probe, { sid: sessionId }) as Promise<LeaseProbeRow[]>;
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
		fences: readonly LeaseFence[],
		work: (transaction: SqlSessionStorageTransaction) => Promise<void>,
	): Promise<void> {
		const lease = this.#q.lease;
		if (!lease || this.#gate !== "row" || fences.length === 0) return this.#transaction(work);
		const deadline = performance.now() + LEASE_FENCE_LOCK_BOUND_MS;
		for (;;) {
			try {
				await this.#transaction(async transaction => {
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
	 * run under the fence's lock bound: the transaction's own `lock_timeout`
	 * (a client's session setting, or the server's) is read as the bound is
	 * set, in one statement, and set back after them, so the write that
	 * follows waits as the client asked. On MySQL and MariaDB a refused read
	 * before `deadline` throws {@link FenceLockRefused}, so the caller runs the
	 * whole transaction again; one at or past it refuses the write.
	 */
	async #runFences(
		transaction: SqlSessionStorageTransaction,
		lease: LeaseQueries,
		fences: readonly LeaseFence[],
		deadline: number,
	): Promise<void> {
		const postgres = this.#adapter === "postgres";
		let prior: string | undefined;
		if (postgres) {
			const [row] = (await transaction.unsafe(
				"SELECT p.prior, pg_catalog.set_config('lock_timeout', $1, true) AS bound " +
					"FROM (SELECT pg_catalog.current_setting('lock_timeout') AS prior OFFSET 0) AS p",
				[String(LEASE_FENCE_LOCK_BOUND_MS)],
			)) as Array<{ prior?: unknown }>;
			prior = typeof row?.prior === "string" ? row.prior : "0";
		}
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
		if (prior !== undefined) {
			await transaction.unsafe("SELECT pg_catalog.set_config('lock_timeout', $1, true)", [prior]);
		}
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
	 * {@link #readWrite}), though it makes nothing. On MySQL and SQLite each
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
		if (
			pgTrue(look?.session) &&
			pgTrue(look?.parts) &&
			pgTrue(look?.lease) &&
			pgTrue(look?.blobs) &&
			pgTrue(look?.refs)
		) {
			return false;
		}
		let indexMade = false;
		await this.#readWrite(async transaction => {
			const [now] = (await run(transaction, PG_TABLES_PRESENT, this.#pgTableNames())) as TablesPresentRow[];
			const missing: string[] = [];
			if (!pgTrue(now?.session)) missing.push(this.#q.createTable);
			if (!pgTrue(now?.parts)) missing.push(this.#q.createPartsTable);
			if (!pgTrue(now?.blobs)) missing.push(this.#q.createBlobsTable);
			// The index goes with the table, so the login that makes the table owns both.
			if (!pgTrue(now?.refs)) {
				missing.push(this.#q.createRefsTable);
				if (this.#q.createRefsIndex) missing.push(this.#q.createRefsIndex);
			}
			if (lease && !pgTrue(now?.lease)) {
				missing.push(lease.createTable);
				if (lease.createIndex) {
					missing.push(lease.createIndex);
					indexMade = true;
				}
			}
			if (missing.length > 0) await transaction.unsafe(missing.join("; "));
		}, "start-up");
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
	 * statement runs in its own transaction behind the start-up opening of
	 * `#readWrite`, which takes one transaction-scoped advisory lock; they run
	 * one after another, and the lock ends with the transaction. Each
	 * statement keeps its own transaction, so a duplicate-column error still
	 * fails only its own ALTER. The tables themselves are made together, by
	 * {@link #createTables}. On MySQL and SQLite the statement runs straight
	 * on the client.
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
	 * must already hold `#exclusive` (`init` does), or
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
	 *
	 * The three openings differ in what else they send:
	 *
	 * - `"write"` (default): `SET LOCAL search_path` alone.
	 * - `"start-up"`: `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`
	 *   before the read, and the start-up advisory lock after it.
	 * - `"heartbeat"`: `SET LOCAL search_path`, `SET LOCAL lock_timeout`
	 *   and `SET LOCAL idle_in_transaction_session_timeout` in one simple
	 *   query ({@link PG_HEARTBEAT_OPENING}), so the beat shares the
	 *   store's read-only refusal and cannot drift from it.
	 */
	#readWrite(
		work: (transaction: SqlSessionStorageTransaction) => Promise<unknown>,
		opening: "write" | "start-up" | "heartbeat" = "write",
	): Promise<void> {
		return this.#client.transaction(async transaction => {
			await transaction.unsafe("SET TRANSACTION READ WRITE");
			if (opening === "start-up") await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
			await transaction.unsafe(opening === "heartbeat" ? PG_HEARTBEAT_OPENING : PG_SEARCH_PATH);
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
		const rows = (await this.#read(executor =>
			run(executor, this.#q.columns, { table: this.#relation(table) }),
		)) as ColumnRow[];
		return new Set(rows.map(row => row.column_name.toLowerCase()));
	}

	/** `name` as the store's statements spell it: with its schema on PostgreSQL once start-up read it. */
	#relation(name: string): string {
		return this.#schema === undefined ? name : `${quoteIdentifier(this.#schema)}.${name}`;
	}

	/**
	 * Run a read: on PostgreSQL in a transaction of its own that starts with
	 * {@link PG_SEARCH_PATH}, as every other statement does; elsewhere
	 * straight on the client.
	 */
	async #read<T>(work: (executor: SqlSessionStorageTransaction) => Promise<T>): Promise<T> {
		if (this.#adapter !== "postgres") return work(this.#client);
		let result!: T;
		await this.#client.transaction(async transaction => {
			await transaction.unsafe(PG_SEARCH_PATH);
			result = await work(transaction);
		});
		return result;
	}

	/**
	 * Run one read statement: on PostgreSQL in one simple query behind
	 * {@link PG_SEARCH_PATH}, which holds for the query's implicit
	 * transaction, so the read costs the one round trip it did before the lock
	 * (see {@link inlinePostgres}); elsewhere straight on the client.
	 */
	async #readOne(query: Statement | string, values: StatementValues = {}): Promise<SqlSessionStorageResult> {
		const statement = typeof query === "string" ? { sql: query, params: [] } : query;
		if (this.#adapter !== "postgres") return run(this.#client, statement, values);
		const results = await this.#client.unsafe(`${PG_SEARCH_PATH}; ${inlinePostgres(statement, values)}`);
		const rows = results[1];
		if (!Array.isArray(rows)) throw new Error("SqlSessionStorage: a PostgreSQL read answered no rows for its query");
		return rows as SqlSessionStorageResult;
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

	/** On PostgreSQL, read once whether the parts' `path` collation keeps the directory delete's key range ({@link #directoryRange}). */
	async #readPathCollation(): Promise<void> {
		if (this.#adapter !== "postgres") return;
		const rows = (await this.#readOne(PG_PATH_COLLATION, {
			table: this.#relation(`${this.#table}_parts`),
		})) as PathCollationRow[];
		this.#directoryRange = pathCollationKeepsDirectoryRange(rows[0]);
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
	 * {@link PG_SEARCH_PATH} does not stop them. So every column must be the
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
		const tables: Array<[string, Record<string, string>]> = [
			[this.#table, PG_DECLARED_COLUMNS.session],
			[`${this.#table}_parts`, PG_DECLARED_COLUMNS.parts],
			[`${this.#table}_blobs`, PG_DECLARED_COLUMNS.blobs],
			[`${this.#table}_refs`, PG_DECLARED_COLUMNS.refs],
		];
		if (this.#q.lease) tables.push([this.#leaseTable, PG_DECLARED_COLUMNS.lease]);
		const problems: string[] = [];
		await this.#read(async executor => {
			for (const [name, declared] of tables) {
				const relation = this.#relation(name);
				const columns = (await run(executor, PG_TABLE_COLUMNS, { table: relation })) as TableColumnRow[];
				if (columns.length === 0) continue;
				const found: string[] = [];
				for (const [column, type] of Object.entries(declared)) {
					const row = columns.find(candidate => candidate.name === column);
					if (!row) found.push(`no column ${column}`);
					else if (row.type !== type) found.push(`column ${column} of type ${row.type}, not ${type}`);
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
				const rows = (await this.#read(executor => run(executor, keyQuery, { table }))) as Array<{ name: unknown }>;
				const keyProblem = primaryKeyProblem(
					rows.map(row => String(row.name).toLowerCase()),
					needs.key,
				);
				if (keyProblem) problems.push(`table ${table} has ${keyProblem}`);
			}
		}
		for (const { table, privilege, probe } of this.#q.privilegeProbes) {
			try {
				await this.#fencedTransaction([], transaction => run(transaction, probe, {}).then(() => undefined));
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
		const rows = (await this.#exclusive(() => this.#readOne(this.#q.loadIndex))) as IndexRow[];
		return rows.map(row => {
			if (row.byte_len === null) throw this.#unmeasured(row.path);
			return { path: row.path, size: rowNumber(row.byte_len), mtimeMs: rowNumber(row.mtime_ms) };
		});
	}

	async readFull(path: string): Promise<SessionStorageFullRead | null> {
		const rows = (await this.#exclusive(() => this.#readOne(this.#q.readFull, { path }))) as ContentRow[];
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
			this.#readOne(this.#q.readSlices, { path, prefix: prefixBytes, suffix: suffixBytes }),
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

	async readFrom(path: string, offset: number, maxBytes?: number): Promise<SessionStorageWindowRead | null> {
		const take = Math.min(
			maxBytes === undefined ? MAX_PIECE_BYTES : Math.max(0, Math.trunc(maxBytes)),
			MAX_PIECE_BYTES,
		);
		const rows = (await this.#exclusive(() =>
			this.#readOne(this.#q.readFrom, {
				path,
				offset,
				end: maxBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.min(offset + take, Number.MAX_SAFE_INTEGER),
				take,
				row_from: Math.min(offset, MAX_PIECE_BYTES - 1) + 1,
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
			if (row.byte_len === null) throw this.#unmeasured(path);
			size = rowNumber(row.byte_len);
			session = row;
		}
		if (size === undefined || session === undefined) return null;
		const bytes = joinSliceBytes(session.bytes, pieces);
		// Each piece is capped on its own; the window is capped as a whole.
		// Buffer.toString preserves a leading U+FEFF (TextDecoder strips it), so
		// byte offsets stay aligned with the stored bytes.
		const window = maxBytes === undefined ? bytes : bytes.subarray(0, take);
		return {
			text: window.toString("utf-8"),
			size,
			title: rowTitle(session),
		};
	}

	/**
	 * The read's start record, with the title metadata its first query reads
	 * with the session's size, then the stored bytes from `fromByte`: the row's
	 * own content from there when it holds any, then the parts in
	 * `start_offset` order, one page per query: the parts that start within
	 * the page's span of where the read is, each part a chunk of its own. The
	 * first page spans {@link FIRST_PAGE_SPAN_BYTES} from `fromByte` and each
	 * next one twice the last, up to {@link PAGE_SPAN_BYTES}, so a reader that
	 * stops early fetches little past where it stopped. The read stops at the
	 * size its first query saw, so an append made meanwhile, which only adds
	 * parts past it, is left out.
	 *
	 * A full write or a delete replaces every part of the session, the one the
	 * read starts at included. So on PostgreSQL and SQLite the query of each
	 * page also checks, in the same statement, that this part still has the row
	 * identity the first query saw, and finds no parts when it does not: its
	 * `xmin`, which changes with every insert, or its rowid, which no part
	 * inserted in a later millisecond takes over (see
	 * `DialectQueries.partRowids`). A page with no part where the read is, a
	 * part that does not start where the previous one ended, or parts that end
	 * short of the size mean a full write or a delete replaced the parts during
	 * the read; it then fails with {@link SessionReadConflictError} instead of
	 * yielding a mix of two bodies.
	 *
	 * A writer older than SQLite's rowid rule still hands a new part the
	 * largest rowid plus one, which after a delete or a truncate can be the
	 * rowid of the part the read started at; so does SQLite itself for a part
	 * the rule finds no room for below 2^63, and so can the rule in the cases
	 * `partRowids` names (a part deleted and another inserted in the same
	 * millisecond, a clock that went back). So on SQLite the query of each
	 * page also checks, in the same statement, that the last part already
	 * fetched is still at its offset with the same bytes. A re-create that
	 * gives the part the read started at its rowid back and holds exactly the
	 * bytes of that last part at its offset, while it differs before and
	 * after it, passes both page checks; the check at the read's end catches
	 * it. Right before its first query, in the same turn of the call queue,
	 * the read takes `PRAGMA data_version`, which moves when any other
	 * connection commits to the database file and never for this
	 * connection's own commits (a private database has no other connection,
	 * so there the read takes no pragma), and this client's counts of its
	 * writes, of every path and of the path's hashed slot (see
	 * {@link SqliteWrites}); at its end it takes
	 * them again. When any of them moved, it reads exactly the bytes it yielded
	 * again, from `fromByte` for as many bytes, with the same page checks,
	 * and compares their SHA-256 with that of the bytes it yielded: a
	 * difference, a page check that fails, or a range that is no longer all
	 * there is a read conflict; an append past the range is not. When they
	 * moved again during that check pass, a write may have made it read the
	 * same mix the read yielded, so it reads the range once more and accepts
	 * it only when that second check pass matches too: at most two check
	 * passes, and a pass that differs is a read conflict at once.
	 *
	 * MySQL has no row identity. Its first query also takes the session's last
	 * part, the last one starting before the size, in the same statement and so
	 * from the same state as the size: its start and its SHA-256. When the read
	 * fetches the part at that start it must hold those bytes, and a read that
	 * ends must have fetched it, or the read is a conflict: a full write between
	 * two pages that grows the session past the old size, a part of the new
	 * body ending right there, passes the page checks and holds the bytes the
	 * read fetched, but it changes that last part, as does any rewrite that
	 * grows or shifts it. The read also checks what it yielded with one query,
	 * which computes the digest of those bytes as the database holds them then
	 * (`DialectQueries.readChunksDigest`): the head, and every part from the one
	 * the read started at to the last one it yielded, whole even where the read
	 * yielded it from `fromByte` on. One that differs from the digest the read
	 * computed over the same parts, each added before it went out, is a read
	 * conflict too. Neither sees a full write between two pages that keeps
	 * every part boundary up to the old size and the old last part byte for
	 * byte and differs only in same-length bytes of parts fetched after it; the
	 * read then yields the start of the new body as a whole one. Taking the
	 * digest of the whole read in the first query would see it, but makes every
	 * read, a probe that stops after its first page included, hash the whole
	 * session on the server (a probe of a 256 MiB session took 5,723 ms instead
	 * of 49 ms on MySQL 8.4). PostgreSQL and SQLite see it by row identity.
	 *
	 * Both end checks run once what the read gives comes from more than one
	 * query (the first query's head and a page, or two pages): when the read
	 * ends, and also when its consumer closes it before that (a `break` out of
	 * its loop, which resumes the read at its `yield` to return). A closed read
	 * rejects its `return()` with the conflict, so the consumer's loop throws
	 * it. Bytes from one query alone come from one snapshot and need no check.
	 *
	 * A read from inside the title slot (before {@link SESSION_TITLE_SLOT_BYTES})
	 * gives its title too, which its storage lays over those bytes, so it must
	 * give one snapshot's title with them. On PostgreSQL the page checks see
	 * every rewrite since the first query. On SQLite the first query of such a
	 * read of a titled session counts as a query of what it gives, so the
	 * check at its end also runs for one page alone, and a check pass must
	 * find the same title. On MySQL, whose checks miss a rewrite that keeps
	 * the part boundaries and the last part, such a read runs in one
	 * transaction of its own ({@link #inReadSnapshot}), so every statement of
	 * it reads the snapshot its first one fixed; it ends with the read.
	 */
	async *readChunks(path: string, fromByte: number): AsyncGenerator<SessionStorageChunk> {
		if (this.#adapter === "mysql" && fromByte < SESSION_TITLE_SLOT_BYTES) {
			yield* this.#inReadSnapshot(snapshot => this.#readChunksIn(path, fromByte, snapshot));
			return;
		}
		yield* this.#readChunksIn(path, fromByte, undefined);
	}

	/** {@link readChunks}, its statements in `snapshot` when it has one (MySQL). */
	async *#readChunksIn(
		path: string,
		fromByte: number,
		snapshot: SqlSessionStorageTransaction | undefined,
	): AsyncGenerator<SessionStorageChunk> {
		const digestQuery = this.#q.readChunksDigest;
		const pass: ChunksPass = {
			digest: digestQuery ? Buffer.alloc(CHUNKS_DIGEST_BYTES) : undefined,
			// SQLite: with it the pass takes the mark the check at the read's end compares (see above).
			hash: this.#sqliteWrites ? new Bun.CryptoHasher("sha256") : undefined,
			snapshot,
			yielded: 0,
			first: 0,
			next: 0,
			sources: 0,
		};
		let failed = false;
		try {
			const start = await this.#startPass(path, fromByte, pass);
			yield { title: pass.title };
			yield* this.#passBytes(path, fromByte, pass, start);
		} catch (err) {
			failed = true;
			throw err;
		} finally {
			// At the read's end, or where its consumer closed it, unless it is failing already.
			if (!failed && pass.sources > 1) {
				if (digestQuery && pass.digest) {
					await this.#confirmChunksDigest(path, pass, digestQuery, {
						path,
						offset: fromByte,
						row_from: Math.min(fromByte, MAX_PIECE_BYTES - 1) + 1,
						first: pass.first,
						end: pass.next,
					});
				} else if (pass.mark !== undefined) {
					await this.#confirmChunks(path, fromByte, pass);
				}
			}
		}
	}

	/**
	 * MySQL: what `read` yields, its statements run in one transaction, whose
	 * first consistent read fixes the REPEATABLE READ snapshot (the server's
	 * default, which the store's writes take too) that every later one reads.
	 * The transaction ends when the read ends, fails, or its consumer closes
	 * it, and holds no lock.
	 */
	async *#inReadSnapshot(
		read: (snapshot: SqlSessionStorageTransaction) => AsyncGenerator<SessionStorageChunk>,
	): AsyncGenerator<SessionStorageChunk> {
		const opened = Promise.withResolvers<SqlSessionStorageTransaction>();
		const ended = Promise.withResolvers<void>();
		const transaction = this.#client.transaction(async snapshot => {
			opened.resolve(snapshot);
			await ended.promise;
		});
		// A transaction that fails before it opens fails the read; one that fails later fails it where it ends.
		transaction.catch((err: unknown) => opened.reject(err));
		const snapshot = await opened.promise;
		try {
			yield* read(snapshot);
		} finally {
			ended.resolve();
			await transaction;
		}
	}

	/** A statement of a chunked read: in the read's snapshot transaction when it has one (MySQL). */
	#readChunksOne(pass: ChunksPass, query: Statement, values: StatementValues): Promise<SqlSessionStorageResult> {
		return pass.snapshot ? run(pass.snapshot, query, values) : this.#readOne(query, values);
	}

	/**
	 * The first query of a pass of {@link readChunks} over `path` from
	 * `fromByte`: its row, with the session's size, and the title it read,
	 * recorded in `pass`.
	 */
	async #startPass(path: string, fromByte: number, pass: ChunksPass): Promise<{ row: ChunksStartRow; size: number }> {
		const rowFrom = Math.min(fromByte, MAX_PIECE_BYTES - 1) + 1;
		const [row] = (await this.#exclusive(async () => {
			// The read's own pass on SQLite: its start mark, with no write of this client between it and the query.
			if (pass.hash) pass.mark = await this.#sqliteMark(path);
			return this.#readChunksOne(pass, this.#q.readChunksStart, { path, offset: fromByte, row_from: rowFrom });
		})) as ChunksStartRow[];
		if (!row) throw enoent(path);
		if (row.byte_len === null) throw this.#unmeasured(path);
		pass.title = rowTitle(row);
		return { row, size: rowNumber(row.byte_len) };
	}

	/** A pass of {@link readChunks} without its start record: what the SQLite end check reads again. */
	async *#readPass(path: string, fromByte: number, pass: ChunksPass, length: number): AsyncGenerator<Uint8Array> {
		yield* this.#passBytes(path, fromByte, pass, await this.#startPass(path, fromByte, pass), length);
	}

	/**
	 * The bytes of one pass of {@link readChunks} over `path` from `fromByte`,
	 * after its first query (`start`), with the checks of every page,
	 * recording in `pass` what the checks at the read's end compare. It ends
	 * at the size its first query saw; with `length` (the SQLite end check),
	 * after `length` bytes, or where the session ends when that is sooner.
	 */
	async *#passBytes(
		path: string,
		fromByte: number,
		pass: ChunksPass,
		{ row, size }: { row: ChunksStartRow; size: number },
		length?: number,
	): AsyncGenerator<Uint8Array> {
		if (row.tail_digest && row.tail_part !== null && row.tail_part !== undefined) {
			pass.tail = { start: rowNumber(row.tail_part), digest: Buffer.from(row.tail_digest, "hex"), fetched: false };
		}
		const stop = length === undefined ? size : Math.min(size, fromByte + length);
		const firstPart = rowNumber(row.first_part);
		const anchor = { anchor: firstPart, anchor_id: row.first_id };
		pass.first = firstPart < 0 ? rowNumber(row.content_len) : firstPart;
		pass.next = pass.first;
		let skip = Math.max(0, fromByte - pass.next);
		// SQLite: the last part fetched, which the next page's query finds unchanged; none yet.
		let last = this.#adapter === "sqlite" ? { last: -1, last_content: "" } : undefined;
		const head = row.head && row.head.byteLength > 0 ? row.head : undefined;
		// The first query gave the head, or, for a read whose storage lays the title over its bytes and that
		// runs in no snapshot, the title: the end check pairs it with the pages, as a head.
		if (head || (pass.title && fromByte < SESSION_TITLE_SLOT_BYTES && !pass.snapshot)) pass.sources++;
		if (head) {
			if (pass.digest) addChunkDigest(pass.digest, partDigest(fromByte, head));
			const out = head.subarray(0, Math.max(0, stop - fromByte));
			pass.hash?.update(out);
			pass.yielded += out.byteLength;
			yield out;
		}
		if (fromByte >= stop) return;
		for (let span = FIRST_PAGE_SPAN_BYTES; pass.next < stop; span = Math.min(span * 2, PAGE_SPAN_BYTES)) {
			// The first page starts at the part `fromByte` lies in, but spans from `fromByte` itself.
			const end = Math.max(pass.next, fromByte) + span;
			const parts = (await this.#exclusive(() =>
				this.#readChunksOne(pass, this.#q.readParts, { path, next: pass.next, end, ...anchor, ...last }),
			)) as PartRow[];
			if (parts.length === 0) throw new SessionReadConflictError(path);
			pass.sources++;
			for (const part of parts) {
				const start = rowNumber(part.start_offset);
				if (start !== pass.next) throw new SessionReadConflictError(path);
				if (start >= stop) break;
				if (last) last = { last: start, last_content: part.content };
				const bytes = Buffer.from(part.content, "utf8");
				// MySQL: the part's digest, computed once when the tail check and the read's digest both take it.
				let digest: Buffer | undefined;
				if (pass.tail?.start === start) {
					digest = partDigest(start, bytes);
					if (!digest.equals(pass.tail.digest)) throw new SessionReadConflictError(path);
					pass.tail.fetched = true;
				}
				// Whole, before the part goes out: the read may be closed at its `yield`.
				if (pass.digest) addChunkDigest(pass.digest, digest ?? partDigest(start, bytes));
				pass.next = start + bytes.byteLength;
				if (skip >= bytes.byteLength) {
					skip -= bytes.byteLength;
					continue;
				}
				// The end check's range can end inside a part.
				const out = skip > 0 || pass.next > stop ? bytes.subarray(skip, stop - start) : bytes;
				skip = 0;
				pass.hash?.update(out);
				pass.yielded += out.byteLength;
				yield out;
			}
		}
		if (length === undefined && pass.next !== size) throw new SessionReadConflictError(path);
		// MySQL: a read that reached the size through another last part than the first query saw read another body.
		if (pass.tail && !pass.tail.fetched) throw new SessionReadConflictError(path);
	}

	/**
	 * SQLite: what a chunked read of `path` compares right before its first
	 * query and at its end (see {@link readChunks}): this client's writes of
	 * every path and of `path`'s slot (see {@link SqliteWrites}), and
	 * `PRAGMA data_version` of the store's connection. Its caller holds the
	 * call queue, so no write of this client runs between the counts and the
	 * pragma. A private database ({@link isPrivateSqliteDatabase}) is the
	 * connection's alone, where no other connection commits: there the counts
	 * are all.
	 */
	async #sqliteMark(path: string): Promise<string> {
		const writes = this.#sqliteWrites;
		const counts = `${writes?.every ?? 0}:${writes?.slots[sqliteWriteSlot(path)] ?? 0}`;
		if (this.#sqlitePrivate) return counts;
		const [row] = (await this.#readOne("PRAGMA data_version")) as DataVersionRow[];
		if (!row) throw new Error("SqlSessionStorage: SQLite answered PRAGMA data_version with no row");
		return `${counts}:${row.data_version}`;
	}

	/**
	 * SQLite: fail with {@link SessionReadConflictError} unless the bytes a
	 * chunked read yielded (`read`, from `fromByte`) are still stored there,
	 * and, for a read from inside the title slot, with the title it gave,
	 * when the database or this client's writes of `path` moved since the read
	 * took `read.mark` (see {@link #sqliteMark}). A check pass then reads exactly
	 * that range again, with the checks of every page, and must give as many
	 * bytes with the same SHA-256 (and that title), or the read is a conflict at
	 * once. A write during that pass can make it read the same mix the read
	 * yielded, so when the mark moved during it a second check pass must match
	 * too: a read end runs at most two check passes.
	 */
	async #confirmChunks(path: string, fromByte: number, read: ChunksPass): Promise<void> {
		const before = await this.#exclusive(() => this.#sqliteMark(path));
		if (before === read.mark) return;
		const yieldedHash = read.hash?.digest("hex");
		const titled = fromByte < SESSION_TITLE_SLOT_BYTES;
		const check = async (): Promise<void> => {
			const checked: ChunksPass = { yielded: 0, first: 0, next: 0, sources: 0 };
			let stored: { hash: string; bytes: number };
			try {
				stored = await digestStream(this.#readPass(path, fromByte, checked, read.yielded));
			} catch (err) {
				// The session is gone: what the read yielded is no longer all there.
				if (isEnoent(err)) throw new SessionReadConflictError(path);
				throw err;
			}
			if (stored.bytes !== read.yielded || stored.hash !== yieldedHash) throw new SessionReadConflictError(path);
			const { title } = checked;
			if (
				titled &&
				(title?.title !== read.title?.title ||
					title?.source !== read.title?.source ||
					title?.updatedAt !== read.title?.updatedAt)
			) {
				throw new SessionReadConflictError(path);
			}
		};
		await check();
		// A write that made this pass read the read's mix again would have to do it once more to pass a second one.
		if ((await this.#exclusive(() => this.#sqliteMark(path))) !== before) await check();
	}

	/**
	 * MySQL: fail with {@link SessionReadConflictError} unless the database
	 * computes `pass.digest`, the digest of what a chunked read yielded, over
	 * what it holds now (`query`, `DialectQueries.readChunksDigest`).
	 */
	async #confirmChunksDigest(
		path: string,
		pass: ChunksPass,
		query: Statement,
		values: StatementValues,
	): Promise<void> {
		const [stored] = (await this.#exclusive(() => this.#readChunksOne(pass, query, values))) as ChunksDigestRow[];
		if (stored?.digest !== pass.digest?.toString("hex").toUpperCase()) throw new SessionReadConflictError(path);
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
		// The blobs this content names land first (see SqlBlobTier); no other blob holds it up.
		const named = namedBlobHashes(content);
		await this.blobs.land(named);
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#withBlobRefs(named, allowGone =>
			this.#fencedTransaction(fences, async transaction => {
				this.#wrote(path);
				await this.#replaceRow(transaction, path, mtimeMs, title, bytes.byteLength, expectedSize);
				// A created session also drops parts orphaned under its path.
				await this.#replaceParts(transaction, path, bytes);
				// The content is replaced whole, and so are its references: dropped only after the blob rows' locks.
				await this.#addRefs(transaction, path, named, allowGone, true);
			}),
		);
	}

	/**
	 * {@link writeFull} from a stream. The parts go in under a staging path,
	 * `<staging prefix><epoch ms>-<id>` (see {@link #stagingPrefix}),
	 * {@link STAGING_PARTS_PER_TRANSACTION} per transaction; then one
	 * transaction checks the session's size, deletes the path's staging sets
	 * older than {@link STALE_STAGING_MS} (a dead writer's), checks that every
	 * staged byte is still there (a staging set another writer removed is a
	 * conflict), and swaps the staged parts in for the session's. Staging parts
	 * have no row, so no listing or index sees them. On failure it removes its
	 * own. Each of these transactions writes under `path`'s lease, as
	 * {@link writeFull}'s one transaction does: behind the claim fence, so the
	 * swap commits only while this store may write the session.
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
		const prefix = this.#stagingPrefix(path);
		const stagingAt = (epochMs: number): string => `${prefix}${String(epochMs).padStart(STAGING_EPOCH_DIGITS, "0")}`;
		const staging = `${stagingAt(now)}-${Snowflake.next()}`;
		const fences = this.#fencesOf([path]);
		const fenced = async (work: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> => {
			await this.#awaitClaims(fences);
			await this.#fencedTransaction(fences, work);
		};
		try {
			let staged = 0;
			let batch: Array<{ offset: number; content: string }> = [];
			// The blobs the content names, as writeFull finds them in its whole text.
			const named = new StreamedBlobHashes();
			const insertBatch = async (): Promise<void> => {
				const parts = batch;
				batch = [];
				await fenced(async transaction => {
					for (const part of parts) {
						await run(transaction, this.#q.insertPart, { path: staging, ...part, now: Date.now() });
					}
				});
			};
			for await (const part of utf8Parts(chunks, PART_BYTES)) {
				named.add(part.text);
				batch.push({ offset: staged, content: part.text });
				staged += part.byteLength;
				if (batch.length === STAGING_PARTS_PER_TRANSACTION) await insertBatch();
			}
			if (batch.length > 0) await insertBatch();
			if (staged !== byteLength) {
				throw new Error(`SqlSessionStorage: a full write of ${path} streamed ${staged} bytes, not ${byteLength}`);
			}
			// As in writeFull, the blobs this content names land first (see SqlBlobTier); no other blob holds it up.
			await this.blobs.land(named.hashes);
			await this.#withBlobRefs(named.hashes, allowGone =>
				fenced(async transaction => {
					this.#wrote(path);
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
					// As a rename moves `src`'s parts (see #moveOnce), only when there are some: on MySQL an update
					// that finds no row still locks a gap.
					if (stagedParts.length > 0) await run(transaction, this.#q.renameParts, { src: staging, dst: path });
					// As in writeFull, the content is replaced whole, and so are its references: dropped only after
					// the blob rows' locks.
					await this.#addRefs(transaction, path, named.hashes, allowGone, true);
				}),
			);
		} catch (err) {
			try {
				await fenced(transaction => this.#deleteParts(transaction, staging));
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
	 * the new parts take rowids counting up, exactly in a `bigint`, from the
	 * first one free above every part's and the clock's floor, read before the
	 * old ones go, so none takes the rowid of a part it replaces. A part the
	 * count would take past {@link SQLITE_MAX_ROWID}, and every part when the
	 * largest rowid is that already, goes in with none, for SQLite to pick
	 * (see `DialectQueries.partRowids`).
	 */
	async #replaceParts(transaction: SqlSessionStorageTransaction, path: string, bytes: Buffer): Promise<void> {
		const rowids = this.#q.partRowids;
		const [first] = rowids ? ((await run(transaction, rowids.next, { now: Date.now() })) as RowidRow[]) : [];
		const next = first?.next_rowid;
		let rowid = typeof next === "string" ? BigInt(next) : undefined;
		await this.#deleteParts(transaction, path);
		for (let start = 0; start < bytes.byteLength;) {
			const end = utf8PartEnd(bytes, start, PART_BYTES);
			await run(transaction, rowids ? rowids.insert : this.#q.insertPart, {
				path,
				offset: start,
				content: bytes.toString("utf8", start, end),
				rowid: rowid !== undefined && rowid <= SQLITE_MAX_ROWID ? rowid++ : null,
			});
			start = end;
		}
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#fencedTransaction(fences, async transaction => {
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
		// The blobs this line names land first (see SqlBlobTier); no other blob holds it up.
		const named = namedBlobHashes(line);
		await this.blobs.land(named);
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		await this.#withBlobRefs(named, allowGone =>
			this.#fencedTransaction(fences, async transaction => {
				this.#wrote(path);
				await this.#checkAppendSize(transaction, path, expectedSize);
				// On SQLite the part's rowid comes from the clock read here, after any delete it follows (see partRowids).
				for (const query of this.#q.append) await run(transaction, query, { ...values, now: Date.now() });
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
			this.#fencedTransaction(fences, transaction => this.#addRefs(transaction, path, named, allowGone)),
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
		await this.#fencedTransaction([], async transaction => {
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
		this.#maxBlobBytes ??= this.#exclusive(() => this.#readOne(query, {})).then(
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
			const rows = (await this.#exclusive(() => this.#readOne(query, listValues("h", batch)))) as BlobSizeRow[];
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
			const rows = (await this.#exclusive(() => this.#readOne(query, values))) as BlobRow[];
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
			const rows = (await this.#exclusive(() => this.#readOne(query, listValues("h", batch)))) as BlobRow[];
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
				for (const row of (await this.#exclusive(() => this.#readOne(query, values))) as BlobDigestRow[]) {
					const digest = typeof row.digest === "string" ? row.digest : Buffer.from(row.digest).toString("latin1");
					if (digest.toLowerCase() !== row.sha256) wrong.push(row.sha256);
				}
				continue;
			}
			const query = this.#q.selectBlobs(batch.length);
			for (const row of (await this.#exclusive(() => this.#readOne(query, values))) as BlobRow[]) {
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
		await this.#fencedTransaction([], transaction =>
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
			const dangling = (await this.#exclusive(() => this.#readOne(this.#q.danglingRefs, {}))) as RefRow[];
			const byHash = new Map<string, string[]>();
			for (const row of dangling) byHash.set(row.sha256, [...(byHash.get(row.sha256) ?? []), row.path]);
			for (const batch of batches([...byHash.keys()].sort(), BLOB_READ_BATCH)) {
				await this.#fencedTransaction([], async transaction => {
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
			this.#readOne(this.#q.sweepCandidates, { before: beforeMs }),
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
			await this.#fencedTransaction([], async transaction => {
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

	/**
	 * {@link SessionStorageBackend.appendBatch}: as {@link append} does for
	 * one line, the blobs the lines name land first, then one transaction
	 * behind the write fence checks the size once, grows the session row by
	 * the bytes of every line, inserts the lines from its old length as parts
	 * ({@link appendedParts}) and references the blobs they name. It throws
	 * {@link SessionAppendBatchRolledBackError} when a statement of the
	 * transaction failed, which rolled it back before COMMIT. Any other
	 * failure (the COMMIT's own, which may have landed; the fence's or the
	 * claim's, which have their own errors) is thrown as it is.
	 */
	async appendBatch(path: string, lines: readonly string[], mtimeMs: number, expectedSize?: number): Promise<void> {
		// The blobs these lines name land first (see SqlBlobTier), as each line's own append lands its own.
		const named = new Set<string>();
		for (const line of lines) for (const hash of namedBlobHashes(line)) named.add(hash);
		await this.blobs.land(named);
		const fences = this.#fencesOf([path]);
		await this.#awaitClaims(fences);
		// What a statement of the transaction's last attempt threw, which rolled it back before COMMIT.
		let statementFailure: { error: unknown } | undefined;
		try {
			await this.#withBlobRefs(named, allowGone =>
				this.#fencedTransaction(fences, async transaction => {
					statementFailure = undefined;
					try {
						this.#wrote(path);
						await this.#checkAppendSize(transaction, path, expectedSize);
						let len = 0;
						for (const line of lines) len += Buffer.byteLength(line, "utf8");
						const [grown] = (await run(transaction, this.#q.growRow, { path, mtime: mtimeMs, len })) as SizeRow[];
						const size =
							this.#adapter === "mysql"
								? await this.#lockSize(transaction, path)
								: grown
									? rowNumber(grown.byte_len)
									: null;
						if (size === null) throw new Error(`SqlSessionStorage: an append batch found no row of ${path}`);
						let offset = size - len;
						for (const part of appendedParts(lines)) {
							// On SQLite each part's rowid comes from the clock read here (see partRowids).
							await run(transaction, this.#q.insertPart, {
								path,
								offset,
								content: part.content,
								now: Date.now(),
							});
							offset += part.bytes;
						}
						await this.#addRefs(transaction, path, named, allowGone);
					} catch (err) {
						statementFailure = { error: err };
						throw err;
					}
				}),
			);
		} catch (err) {
			if (statementFailure?.error === err) throw new SessionAppendBatchRolledBackError(path, err);
			throw err;
		}
	}

	/**
	 * A store that claims sessions refuses to append onto bytes it did not
	 * write (another writer that claims nothing, such as an older omp, changed
	 * or replaced the file), so `SessionManager` can read the file back and
	 * keep that writer's entries, or move off, instead of mixing this
	 * session's lines into whatever the file now holds.
	 */
	async #checkAppendSize(
		transaction: SqlSessionStorageTransaction,
		path: string,
		expectedSize: number | undefined,
	): Promise<void> {
		if (expectedSize === undefined || !this.#gate) return;
		const actualSize = await this.#lockSize(transaction, path);
		if ((actualSize ?? 0) !== expectedSize) throw new SessionWriteConflictError(path, expectedSize, actualSize);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[], dir?: string): Promise<void> {
		// The key range under `dir` runs from `dir` without its final "/" up to `dir` with that "/" made "0": in
		// code-point order and under MySQL's PAD SPACE every path under `dir` sorts within it, whatever follows the
		// "/" (see DialectQueries.deleteUnder). On MySQL the lock of the rows under `dir` reads that range too
		// (#lockSessionRowsForWrite). On PostgreSQL the parts delete takes the range only under a code-point
		// collation, and compares the prefix alone under any other (#directoryRange).
		const under: UnderDirectory | undefined =
			dir === undefined
				? undefined
				: { dir, len: [...dir].length, stem: dir.slice(0, -1), dir_end: `${dir.slice(0, -1)}0` };
		const fences = this.#fencesOf(paths);
		await this.#awaitClaims(fences);
		const there = under ? undefined : await this.#sessionRowsThere(paths);
		await this.#fencedTransaction(fences, async transaction => {
			// Every session row first, in path order, those under `dir` with them (see #lockSessionRowsForWrite);
			// all their locks are then held before the first parts look (see #deleteParts).
			const { present, locked } = await this.#lockSessionRowsForWrite(transaction, paths, there, under);
			const ordered = [...new Set(paths)].sort();
			// Only rows there are: a delete that finds no row still locks a gap on MySQL.
			for (const path of ordered) {
				this.#wrote(path);
				if (!present || present.has(path)) await run(transaction, this.#q.deleteRow, { path });
			}
			// The staging sets the directory delete does not take: those of a path not under `dir`, and on
			// MySQL those of a path too long for `<path>#staging-` names, named by its hash instead
			// (#stagingPrefix): the explicit paths', and those of every row under `dir`, locked above.
			const staged = new Set(
				paths.filter(path => !under || !path.startsWith(under.dir) || this.#hashesStaging(path)),
			);
			if (under) {
				if (this.#sqliteWrites) this.#sqliteWrites.every++;
				for (const { path } of locked) {
					if (path.startsWith(under.dir) && this.#hashesStaging(path)) staged.add(path);
				}
				const deletes = this.#directoryRange ? this.#q.deleteUnder : this.#q.deleteUnderScan;
				for (const query of deletes) await run(transaction, query, under);
			}
			for (const path of ordered) await this.#deleteParts(transaction, path);
			// In ascending order of the key ranges they lock, each from a path's staging prefix (#stagingPrefix),
			// as every other delete of this transaction takes its locks.
			for (const prefix of [...staged].map(path => this.#stagingPrefix(path)).sort()) {
				await this.#deleteStagingFrom(transaction, prefix);
			}
			// Then the blobs only the deleted sessions named: their rows are locked before their references go.
			await this.#deleteOrphans(transaction, await this.#takeRefs(transaction, ordered, under));
		});
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		if (src === dst) {
			const rows = await this.#exclusive(() => this.#readOne(this.#q.exists, { path: src }));
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
		const there = await this.#sessionRowsThere([src, dst]);
		await this.#fencedTransaction(fences, async transaction => {
			this.#wrote(src);
			this.#wrote(dst);
			// Both session rows first, in path order, before either changes; only rows there are change. A `dst`
			// with no row is taken by the UPDATE below, after `src`'s (see docs/session.md, "Races").
			const { present } = await this.#lockSessionRowsForWrite(transaction, [src, dst], there);
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
			// Staging sets stay under the name their writer staged them for: the
			// source's are left with no session, and so are a replaced destination's.
			// They are parts under those paths, so they go before any blob row is locked.
			await this.#deleteStagingFrom(transaction, this.#stagingPrefix(src));
			if (!noReplace) await this.#deleteStagingFrom(transaction, this.#stagingPrefix(dst));
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
	async #sessionRowsThere(paths: readonly string[]): Promise<ReadonlySet<string> | undefined> {
		const look = this.#q.sessionRowsOf;
		if (!look) return undefined;
		const ordered = [...new Set(paths)].sort();
		const rows = (await this.#readOne(look(ordered.length), listValues("p", ordered))) as PathRow[];
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
	 * would wait for it. Then it answers, as `present`, the paths whose rows
	 * it locked, and the caller changes only those. With `under` it answers,
	 * as `locked`, every row it locked, and no `present`: the caller changes
	 * every path. On MySQL and MariaDB the rows under the directory are read
	 * by the directory's key range (see
	 * {@link DialectQueries.lockSessionRowsForWrite}): the lock takes those
	 * rows, the gaps between them and the gaps at either end of the range, up
	 * to the nearest row outside it (MariaDB locks the first row past the
	 * range too), and no other row or gap. PostgreSQL locks no gap.
	 * Elsewhere nothing is answered; SQLite runs one writer at a time.
	 */
	async #lockSessionRowsForWrite(
		transaction: SqlSessionStorageTransaction,
		paths: readonly string[],
		there: ReadonlySet<string> | undefined,
		under?: UnderDirectory,
	): Promise<LockedSessionRows> {
		const lock = this.#q.lockSessionRowsForWrite;
		if (!lock) return { present: undefined, locked: [] };
		const ordered = [...new Set(paths)].sort();
		if (!there || under) {
			const rows = (await run(transaction, lock(ordered.length, under !== undefined), {
				...listValues("p", ordered),
				...under,
			})) as PathRow[];
			return { present: undefined, locked: under ? rows : [] };
		}
		// One key per statement (see #lockBlobRows): MySQL may plan an IN list as a scan, which locks other rows.
		const present = new Set<string>();
		for (const path of ordered) {
			if (!there.has(path)) continue;
			const rows = (await run(transaction, lock(1, false), listValues("p", [path]))) as PathRow[];
			for (const row of rows) present.add(row.path);
		}
		return { present, locked: [] };
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

	/**
	 * SQLite: count a write of `path` by this client, in its slot (wrapping at
	 * 2^32). Called inside the write's transaction, which holds the call
	 * queue, so a chunked read of `path` that this write lands within takes
	 * another count at its end (see {@link SqliteWrites}).
	 */
	#wrote(path: string): void {
		const slots = this.#sqliteWrites?.slots;
		if (slots) slots[sqliteWriteSlot(path)]++;
	}

	/**
	 * Whether `path`'s staging sets are named by its hash: on MySQL, a path
	 * longer than {@link MYSQL_PLAIN_STAGING_CHARS} characters, whose
	 * `<path>#staging-<epoch>-<id>` would not fit the 512-character `path`
	 * column.
	 */
	#hashesStaging(path: string): boolean {
		return this.#adapter === "mysql" && [...path].length > MYSQL_PLAIN_STAGING_CHARS;
	}

	/**
	 * Starts the names of `path`'s staging sets: `<path>#staging-`, or, where
	 * {@link #hashesStaging}, {@link HASHED_STAGING}, the SHA-256 of `path` in
	 * hex and `#staging-` (86 characters, so every staging path of it fits).
	 * Either is `path`'s alone, so a range from it reaches no other path's
	 * staging sets.
	 */
	#stagingPrefix(path: string): string {
		if (!this.#hashesStaging(path)) return `${path}${STAGING_MARK}`;
		return `${HASHED_STAGING}${new Bun.CryptoHasher("sha256").update(path).digest("hex")}${STAGING_MARK}`;
	}

	/**
	 * Delete every staging set named from `prefix`, a path's staging prefix
	 * ({@link #stagingPrefix}), whatever its age: a path that goes takes its
	 * unfinished full writes with it.
	 */
	#deleteStagingFrom(transaction: SqlSessionStorageTransaction, prefix: string): Promise<void> {
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
