/**
 * The client that `postgres-left-settings.test.ts` hands the SQL
 * session store, and the rule it reads the server log by.
 *
 * {@link leftClient} wraps a Bun `SQL` and routes every call the store makes,
 * `reserve()`, `transaction()` and the pooled `unsafe()`, through one reserved
 * connection whose backend pid it reads first. On a backend it has not seen it
 * sends, once, one message that begins with {@link LEFT_MARKER}: it reads the
 * pid and the setting's value, leaves the setting with a session-level
 * statement, and reads the value again. So the same client drives a store that
 * calls `transaction()` and `unsafe()` and one that calls `reserve()`. It
 * records each message the store sends with the backend pid it went to, and
 * each `close()` and `release()` the store calls on a reserved connection.
 *
 * {@link checkServerLog} judges the lines of the store's backends in a server
 * log written with `log_statement = 'all'` and
 * `log_line_prefix = '%m pid=%p app=%a code=%e '`.
 */
import { PG_APPLICATION_NAME } from "@oh-my-pi/pi-coding-agent/session/sql-session-postgres-settings";
import type {
	SqlSessionStorageClient,
	SqlSessionStorageResult,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { type ReservedSQL, SQL, type TransactionSQL } from "bun";

/** The comment that begins every message the test itself sends on a connection the store gets. */
export const LEFT_MARKER = "/* omp-left-setting-test */";

/**
 * The entries whose left value makes the server write parse trees and plans to
 * its log: on their backends {@link checkServerLog} accepts those lines.
 */
export const DEBUG_PRINT_ENTRIES: readonly string[] = [
	"debug_print_parse",
	"debug_print_rewritten",
	"debug_print_plan",
];

/** What the client leaves on a backend, placeholders already filled. */
export interface LeftSetting {
	/** The session-level statement left on each backend the client has not seen. */
	readonly statement: string;
	/** The statement the after-case read sends again: {@link statement}, or a form that still runs while it is on. */
	readonly again: string;
	/** An SQL expression that reads the setting's value as text. */
	readonly value: string;
}

/** An error a statement met, as Bun reports it: the SQLSTATE in `errno`, Bun's own code in `code`. */
export interface LeftError {
	readonly errno: string | undefined;
	readonly code: string | undefined;
	readonly message: string;
}

/** One message the store sent: how it reached the client, and the backend it went to. */
export interface LeftMessage {
	readonly pid: number;
	readonly via: "reserve" | "transaction" | "unsafe";
	readonly sql: string;
}

/** A `close()` the store called on a reserved connection, with the last error a statement met on it. */
export interface LeftClose {
	readonly pid: number;
	readonly error: LeftError | undefined;
}

/** The test's own read of a backend: its value before the left statement, and after it. */
export interface LeftRead {
	readonly pid: number;
	readonly before: string;
	readonly value: string;
}

/** Everything one client saw. */
export interface LeftRecord {
	/** The case's entry; the server-log rule reads it for the debug print entries. */
	readonly entry: string;
	/** Every backend the client used, in the order it first saw them. */
	readonly pids: number[];
	readonly messages: LeftMessage[];
	readonly errors: Array<LeftError & { readonly pid: number }>;
	readonly closes: LeftClose[];
	/** The backend of each `release()` the store called. */
	readonly releases: number[];
	/** Each left statement the client sent, with the reads around it. */
	readonly lefts: Array<LeftRead & { readonly statement: string }>;
}

/** The reserved connection {@link LeftStoreClient.reserve} hands the store. */
export interface LeftReservedConnection {
	unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult>;
	release(): Promise<void>;
	close(): Promise<void>;
}

/** The client the store gets; `reserve` is absent when {@link LeftClientOptions.reserve} is `false`. */
export interface LeftStoreClient extends SqlSessionStorageClient {
	reserve?(): Promise<LeftReservedConnection>;
}

export interface LeftClientOptions {
	readonly url: string;
	/** The Bun pool's size: 1 in the direct leg, so the store has one backend. */
	readonly max: number;
	/** The case's entry, kept in {@link LeftRecord.entry}. */
	readonly entry: string;
	/** What to leave on the `ordinal`-th backend the client sees (from 1); nothing when unset or `undefined`. */
	readonly left?: (ordinal: number) => LeftSetting | undefined;
	/** `false` gives a client without `reserve()`. */
	readonly reserve?: boolean;
}

/** The after-case read: the backend, the value still on it, and the rows of the temporary table when one was named. */
export interface LeftAfterRead {
	readonly pid: number;
	readonly value: string;
	readonly rows: number | undefined;
}

export interface LeftClient {
	readonly client: LeftStoreClient;
	readonly record: LeftRecord;
	/** Leave the setting before the store runs: take a backend as for the store, and answer the read made on it. */
	prime(): Promise<LeftRead>;
	/**
	 * One message that reads the pid and the value still on the backend and
	 * sends `setting.again`; then, with `temporaryTable`, the rows of that
	 * table on the same backend.
	 */
	readAfter(setting: LeftSetting, temporaryTable?: string): Promise<LeftAfterRead>;
	/** Close the connection the client holds now, so the next reservation gets a new backend. */
	retire(): Promise<void>;
	end(): Promise<void>;
}

/**
 * Whether `url` reaches PostgreSQL directly, read on `sql`, a client of `url`:
 * behind a pooler such as PgBouncer, `inet_server_port()` read through the
 * URL is the server's own port, another than the URL's.
 */
export async function reachesPostgresDirectly(sql: SQL, url: string): Promise<boolean> {
	const [where] = (await sql.unsafe("SELECT pg_catalog.inet_server_port() AS port")) as Array<{ port: unknown }>;
	return Number(where?.port) === Number(new URL(url).port || "5432");
}

/** Times a reservation is taken again when its connection turns out closed (the server ended an idle one). */
const TAKE_ATTEMPTS = 3;

/** `err` as {@link LeftError}: Bun's errors are duck-typed by their `errno` and `code`, as the store reads them. */
export function leftError(err: unknown): LeftError {
	const object = typeof err === "object" && err !== null;
	return {
		errno: object && "errno" in err && typeof err.errno === "string" ? err.errno : undefined,
		code: object && "code" in err && typeof err.code === "string" ? err.code : undefined,
		message: err instanceof Error ? err.message : String(err),
	};
}

function connectionClosed(err: unknown): boolean {
	return leftError(err).code === "ERR_POSTGRES_CONNECTION_CLOSED";
}

type Rows = Array<Record<string, unknown>>;

async function backendPid(connection: ReservedSQL): Promise<number> {
	const [row] = (await connection.unsafe(`${LEFT_MARKER} SELECT pg_catalog.pg_backend_pid() AS pid`)) as Rows;
	return Number(row?.pid);
}

/**
 * One message: read the pid and the value, send `statement`, read the value
 * again. The explicit transaction ends before the last read, so a setting
 * that takes effect from the next transaction (`SET SESSION
 * CHARACTERISTICS`) shows there.
 */
async function leave(connection: ReservedSQL, setting: LeftSetting, statement: string): Promise<LeftRead> {
	const results = (await connection.unsafe(
		`${LEFT_MARKER} BEGIN; SELECT pg_catalog.pg_backend_pid() AS pid, ${setting.value} AS value; ${statement}; ` +
			`COMMIT; SELECT ${setting.value} AS value`,
	)) as unknown as Rows[];
	const [first] = results[1] ?? [];
	const [last] = results[results.length - 1] ?? [];
	return { pid: Number(first?.pid), before: String(first?.value), value: String(last?.value) };
}

/** A client of `options.url` for the store; see the module comment. */
export function leftClient(options: LeftClientOptions): LeftClient {
	const sql = new SQL(options.url, { max: options.max });
	const record: LeftRecord = {
		entry: options.entry,
		pids: [],
		messages: [],
		errors: [],
		closes: [],
		releases: [],
		lefts: [],
	};
	const reads = new Map<number, LeftRead>();

	/** Record `pid`; true the first time. */
	const see = (pid: number): boolean => {
		if (record.pids.includes(pid)) return false;
		record.pids.push(pid);
		return true;
	};

	/** A reserved connection whose backend carries the left setting, and that backend's pid. */
	const take = async (): Promise<{ connection: ReservedSQL; pid: number }> => {
		for (let attempt = 1; ; attempt++) {
			const connection = await sql.reserve();
			try {
				const pid = await backendPid(connection);
				if (see(pid)) {
					const setting = options.left?.(record.pids.length);
					const read = setting
						? await leave(connection, setting, setting.statement)
						: { pid, before: "", value: "" };
					if (setting) record.lefts.push({ ...read, statement: setting.statement });
					reads.set(pid, read);
				}
				return { connection, pid };
			} catch (err) {
				if (attempt < TAKE_ATTEMPTS && connectionClosed(err)) {
					await connection.close().catch(() => undefined);
					continue;
				}
				connection.release();
				throw new Error(
					`left-setting harness: its own message on a store connection failed: ${leftError(err).message}`,
					{
						cause: err,
					},
				);
			}
		}
	};

	/** Send one message of the store's on `executor` and record it. */
	const send = async (
		executor: ReservedSQL | TransactionSQL,
		pid: number,
		via: LeftMessage["via"],
		query: string,
		values: unknown[] | undefined,
		onError?: (error: LeftError) => void,
	): Promise<SqlSessionStorageResult> => {
		record.messages.push({ pid, via, sql: query });
		try {
			return (await executor.unsafe(query, values)) as SqlSessionStorageResult;
		} catch (err) {
			const error = leftError(err);
			record.errors.push({ ...error, pid });
			onError?.(error);
			throw err;
		}
	};

	const unsafe = async (query: string, values?: unknown[]): Promise<SqlSessionStorageResult> => {
		const { connection, pid } = await take();
		try {
			return await send(connection, pid, "unsafe", query, values);
		} finally {
			connection.release();
		}
	};

	// Bun's `begin` sends a bare BEGIN, and COMMIT or ROLLBACK at the end; they are recorded as the store's messages.
	const transaction = async (
		callback: (transaction: SqlSessionStorageTransaction) => Promise<void>,
	): Promise<void> => {
		const { connection, pid } = await take();
		let begun = false;
		try {
			await connection.begin(async tx => {
				begun = true;
				record.messages.push({ pid, via: "transaction", sql: "BEGIN" });
				await callback({ unsafe: (query, values) => send(tx, pid, "transaction", query, values) });
			});
			record.messages.push({ pid, via: "transaction", sql: "COMMIT" });
		} catch (err) {
			if (begun && !connectionClosed(err)) record.messages.push({ pid, via: "transaction", sql: "ROLLBACK" });
			throw err;
		} finally {
			connection.release();
		}
	};

	const reserve = async (): Promise<LeftReservedConnection> => {
		const { connection, pid } = await take();
		let last: LeftError | undefined;
		return {
			unsafe: (query, values) =>
				send(connection, pid, "reserve", query, values, error => {
					last = error;
				}),
			release: async () => {
				record.releases.push(pid);
				connection.release();
			},
			close: async () => {
				record.closes.push({ pid, error: last });
				await connection.close();
			},
		};
	};

	const client: LeftStoreClient = {
		options: sql.options,
		unsafe,
		transaction,
		end: () => sql.close(),
		...(options.reserve === false ? {} : { reserve }),
	};

	return {
		client,
		record,
		async prime() {
			const { connection, pid } = await take();
			connection.release();
			return reads.get(pid) ?? { pid, before: "", value: "" };
		},
		async readAfter(setting, temporaryTable) {
			const connection = await sql.reserve();
			try {
				const read = await leave(connection, setting, setting.again);
				see(read.pid);
				let rows: number | undefined;
				if (temporaryTable !== undefined) {
					try {
						const [row] = (await connection.unsafe(
							`${LEFT_MARKER} SELECT count(*)::int AS rows FROM pg_temp.${temporaryTable}`,
						)) as Rows;
						rows = Number(row?.rows);
					} catch {
						rows = undefined;
					}
				}
				return { pid: read.pid, value: read.before, rows };
			} finally {
				connection.release();
			}
		},
		async retire() {
			const connection = await sql.reserve();
			await connection.close();
		},
		async end() {
			await sql.close({ timeout: 0 });
		},
	};
}

/** A backend the store used, for {@link checkServerLog}: the messages the client recorded it sending there. */
export interface LeftLogPid {
	readonly messages: number;
	/** The entry of the case the backend served. */
	readonly entry?: string;
}

/** Every backend `records` saw, each with the store's messages to it and the entry of its case. */
export function logPids(records: readonly LeftRecord[]): Map<number, LeftLogPid> {
	const pids = new Map<number, LeftLogPid>();
	for (const record of records) {
		for (const pid of record.pids) {
			const messages = record.messages.filter(message => message.pid === pid).length;
			const known = pids.get(pid);
			pids.set(pid, { messages: (known?.messages ?? 0) + messages, entry: known?.entry ?? record.entry });
		}
	}
	return pids;
}

/** One log line, with the lines that continue it (each begins with a tab). */
export interface LeftLogLine {
	readonly pid: number;
	readonly app: string;
	readonly code: string;
	readonly level: string;
	/** The line as the log holds it, continuation lines included. */
	readonly line: string;
}

export interface LeftLogVerdict {
	/** The lines of the store's backends that the rule does not allow. */
	readonly flagged: LeftLogLine[];
	/** Each store backend whose `statement:` and `execute` lines, less the test's own, are not one per message. */
	readonly counts: Array<{ readonly pid: number; readonly lines: number; readonly messages: number }>;
	/** The allowed openings that appear on the store's backends. */
	readonly openings: string[];
	/** The `ERROR` lines of the store's backends. */
	readonly errors: LeftLogLine[];
	/** The store backends of a debug print entry on which the rule accepted a parse tree or plan line. */
	readonly debugPrint: Array<{ readonly pid: number; readonly entry: string }>;
}

const LOG_PREFIX = /^.*? pid=(\d+) app=(.*?) code=([0-9A-Z]{5}) ([A-Z0-9]+): {2}/;
const EXECUTE = /^execute [^:]+: /;
const DEBUG_PRINT_MESSAGES = ["parse tree:", "rewritten parse tree:", "plan:"];
/**
 * The records PostgreSQL writes with a debug print's `LOG` record, in order:
 * the tree or plan as `DETAIL`, then the query as `STATEMENT`.
 */
const DEBUG_PRINT_FOLLOWERS = ["DETAIL", "STATEMENT"];

interface ParsedLine extends LeftLogLine {
	/** The message after the level, continuation lines joined with newlines. */
	message: string;
	line: string;
}

function* logLines(log: string): Generator<ParsedLine> {
	let current: ParsedLine | undefined;
	for (const physical of log.split("\n")) {
		if (physical.startsWith("\t")) {
			if (current) {
				current.message += `\n${physical.slice(1)}`;
				current.line += `\n${physical}`;
			}
			continue;
		}
		if (current) yield current;
		const match = LOG_PREFIX.exec(physical);
		current = match
			? {
					pid: Number(match[1]),
					app: match[2] ?? "",
					code: match[3] ?? "",
					level: match[4] ?? "",
					message: physical.slice(match[0].length),
					line: physical,
				}
			: undefined;
	}
	if (current) yield current;
}

/**
 * Judge each line of the store's backends (`pids`) in `log`. A line is
 * allowed when it shows `app=` {@link PG_APPLICATION_NAME}, or is a
 * `statement:` line whose text is one of `openings`, `COMMIT`, `ROLLBACK` or
 * begins with `marker`. On a backend of a {@link DEBUG_PRINT_ENTRIES} case, a
 * `LOG` line holding a parse tree, a rewritten parse tree or a plan is
 * allowed too, with the `DETAIL` and `STATEMENT` records that directly follow
 * it on that backend. Every other line of those backends is flagged. Each
 * backend's `statement:` and `execute` lines, less those that begin with
 * `marker`, must number its recorded messages. Lines of other backends are
 * not read.
 */
export function checkServerLog(
	log: string,
	pids: ReadonlyMap<number, LeftLogPid>,
	openings: readonly string[],
	marker: string,
): LeftLogVerdict {
	const allowed = new Set(openings);
	const flagged: LeftLogLine[] = [];
	const errors: LeftLogLine[] = [];
	const seen = new Set<string>();
	const accepted = new Map<number, string>();
	/** For a backend whose last record was part of an accepted debug print: the levels its next record may have. */
	const follows = new Map<number, readonly string[]>();
	const lines = new Map<number, number>();
	for (const parsed of logLines(log)) {
		const store = pids.get(parsed.pid);
		if (!store) continue;
		const { message, ...line } = parsed;
		const statement = line.level === "LOG" && message.startsWith("statement: ") ? message.slice(11) : undefined;
		const own = statement?.startsWith(marker) === true;
		if ((statement !== undefined || (line.level === "LOG" && EXECUTE.test(message))) && !own) {
			lines.set(line.pid, (lines.get(line.pid) ?? 0) + 1);
		}
		if (line.level === "ERROR") errors.push(line);
		if (statement !== undefined && allowed.has(statement)) seen.add(statement);
		const followers = follows.get(line.pid) ?? [];
		follows.delete(line.pid);
		const follower = followers.indexOf(line.level);
		if (follower !== -1) {
			follows.set(line.pid, followers.slice(follower + 1));
			continue;
		}
		if (line.app === PG_APPLICATION_NAME) continue;
		if (
			statement !== undefined &&
			(own || statement === "COMMIT" || statement === "ROLLBACK" || allowed.has(statement))
		) {
			continue;
		}
		if (
			store.entry !== undefined &&
			DEBUG_PRINT_ENTRIES.includes(store.entry) &&
			line.level === "LOG" &&
			DEBUG_PRINT_MESSAGES.some(prefix => message.startsWith(prefix))
		) {
			accepted.set(line.pid, store.entry);
			follows.set(line.pid, DEBUG_PRINT_FOLLOWERS);
			continue;
		}
		flagged.push(line);
	}
	const counts: Array<{ pid: number; lines: number; messages: number }> = [];
	for (const [pid, { messages }] of pids) {
		const found = lines.get(pid) ?? 0;
		if (found !== messages) counts.push({ pid, lines: found, messages });
	}
	return {
		flagged,
		counts,
		openings: openings.filter(opening => seen.has(opening)),
		errors,
		debugPrint: [...accepted].map(([pid, entry]) => ({ pid, entry })),
	};
}
