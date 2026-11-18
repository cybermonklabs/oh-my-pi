/**
 * Fixtures for the SQL session claim tests: a throwaway database (a SQLite
 * file always; PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name one, the MySQL one MySQL 8 or MariaDB), a
 * TCP proxy that can freeze or delay a store's connection, and another
 * omp-like process (`sql-session-lease-process.ts`) that holds or resumes a
 * session through its own store. Every database fixture makes its own
 * session and lease tables and drops them, and every store gets its own
 * client, so two stores are two lease holders, as two processes are.
 */
import * as path from "node:path";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageOptions,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL, type Socket, type SocketHandler, type TCPSocketListener } from "bun";

type SqlClient = InstanceType<typeof SQL>;

export const LEASE_BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

/** A MySQL 5.7 server, on which a store that claims sessions refuses to start. */
export const MYSQL57_URL = process.env.OMP_TEST_SQL_MYSQL57_URL;

/**
 * A MySQL-family server started with `innodb_rollback_on_timeout=ON`, on which
 * a lock wait timeout (error 1205) rolls back the whole transaction, not only
 * the statement that waited.
 */
export const MYSQL_ROT_URL = process.env.OMP_TEST_SQL_MYSQL_ROT_URL;

/** Which server a fixture's database runs on: the MySQL adapter serves MySQL and MariaDB. */
export type LeaseServer = SqlSessionStorageAdapter | "mariadb";

/** The backends whose claim is a lease row with a heartbeat. */
export const ROW_LEASE_BACKENDS = LEASE_BACKENDS.filter(backend => backend.adapter !== "sqlite");

/** Milliseconds since the epoch on the database clock, as the store writes lease times. */
const DB_NOW: Record<SqlSessionStorageAdapter, string> = {
	postgres: "(extract(epoch from clock_timestamp()) * 1000)::bigint",
	mysql: "CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)",
	sqlite: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
};

let sequence = 0;

export interface LeaseRow {
	holder: string;
	host: string;
	pid: number;
	/** Milliseconds since the row's last heartbeat, on the database clock. */
	ageMs: number;
}

export interface LeaseDb extends AsyncDisposable {
	readonly adapter: SqlSessionStorageAdapter;
	/** The server behind `adapter`, read from the database (`SELECT VERSION()` on MySQL). */
	readonly server: LeaseServer;
	/** The connection URL every store of this fixture opens. */
	readonly dsn: string;
	readonly table: string;
	readonly leaseTable: string;
	readonly dir: TempDir;
	/**
	 * A new store on its own client. `dsn` overrides the URL (a proxy's);
	 * `wrap` wraps the client the store sends its statements through;
	 * `leaseTable` names the fixture's lease table another way (its spelling).
	 */
	open(
		options?: Partial<
			Pick<SqlSessionStorageOptions, "claims" | "lease" | "createTable" | "leaseTable" | "maxBlobBytes">
		> & {
			dsn?: string;
			wrap?: (client: SqlSessionStorageClient) => SqlSessionStorageClient;
		},
	): Promise<SqlSessionStorage>;
	/** Run `query` on the fixture's own client; `@1`, `@2` … are the dialect's placeholders. */
	sql(query: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>;
	/** The stored content of `file` (row and parts), its `byte_len` and its title, or `undefined` when it has no row. */
	row(file: string): Promise<{ content: string; byteLen: number; title: string | null } | undefined>;
	/** Every session path the table holds, in order. */
	paths(): Promise<string[]>;
	/** The lease rows of `sessionId`. */
	leases(sessionId: string): Promise<LeaseRow[]>;
	/** Move `sessionId`'s heartbeat back by `ms` on the database clock. */
	ageLease(sessionId: string, ms: number): Promise<void>;
	/**
	 * Lock `sessionId`'s lease row `FOR UPDATE` in a transaction of another
	 * connection, held until the returned function runs, as a slow or stuck
	 * client would.
	 */
	lockLeaseRow(sessionId: string): Promise<() => Promise<void>>;
}

export async function openLeaseDb(adapter: SqlSessionStorageAdapter, url: string): Promise<LeaseDb> {
	const dir = TempDir.createSync(`@omp-sql-lease-${adapter}-`);
	const dsn = adapter === "sqlite" ? `sqlite://${dir.join("sessions.db")}` : url;
	const table = `sl_${process.pid}_${Date.now().toString(36)}_${sequence++}`;
	const leaseTable = `${table}_leases`;
	const admin = new SQL(dsn);
	// Another process may hold the SQLite write lock for a moment.
	if (adapter === "sqlite") await admin.unsafe("PRAGMA busy_timeout = 5000");
	const stores: Array<{ storage: SqlSessionStorage; client: SqlClient }> = [];
	const [version] =
		adapter === "mysql" ? ((await admin.unsafe("SELECT VERSION() AS version")) as Array<{ version: string }>) : [];
	const server: LeaseServer = /mariadb/i.test(version?.version ?? "") ? "mariadb" : adapter;
	const placeholder = (index: number): string => (adapter === "postgres" ? `$${index}` : "?");
	const sql = async (query: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
		(await admin.unsafe(
			query.replace(/@(\d+)/g, (_match, index: string) => placeholder(Number(index))),
			values,
		)) as Array<Record<string, unknown>>;
	return {
		adapter,
		server,
		dsn,
		table,
		leaseTable,
		dir,
		sql,
		async open(options = {}) {
			const { dsn: storeDsn, wrap, ...storeOptions } = options;
			const client = new SQL(storeDsn ?? dsn);
			const storage = await SqlSessionStorage.create({
				client: wrap ? wrap(client) : client,
				table,
				leaseTable,
				claims: true,
				...storeOptions,
			});
			stores.push({ storage, client });
			return storage;
		},
		async row(file) {
			const [row] = await sql(`SELECT content, byte_len, title FROM ${table} WHERE path = @1`, [file]);
			if (!row) return undefined;
			const parts = await sql(`SELECT content FROM ${table}_parts WHERE path = @1 ORDER BY start_offset`, [file]);
			return {
				content: String(row.content) + parts.map(part => String(part.content)).join(""),
				byteLen: Number(row.byte_len),
				title: row.title === null || row.title === undefined ? null : String(row.title),
			};
		},
		async paths() {
			return (await sql(`SELECT path FROM ${table} ORDER BY path`)).map(row => String(row.path));
		},
		async leases(sessionId) {
			const rows = await sql(
				`SELECT holder, host, pid, ${DB_NOW[adapter]} - heartbeat_at AS age FROM ${leaseTable} WHERE session_id = @1`,
				[sessionId],
			);
			return rows.map(row => ({
				holder: String(row.holder),
				host: String(row.host),
				pid: Number(row.pid),
				ageMs: Number(row.age),
			}));
		},
		async ageLease(sessionId, ms) {
			await sql(`UPDATE ${leaseTable} SET heartbeat_at = heartbeat_at - @1 WHERE session_id = @2`, [ms, sessionId]);
		},
		async lockLeaseRow(sessionId) {
			const locker = new SQL(dsn);
			const locked = Promise.withResolvers<void>();
			const unlock = Promise.withResolvers<void>();
			const held = locker.transaction(async transaction => {
				await transaction.unsafe(
					`SELECT holder FROM ${leaseTable} WHERE session_id = ${placeholder(1)} FOR UPDATE`,
					[sessionId],
				);
				locked.resolve();
				await unlock.promise;
			});
			held.catch((err: unknown) => locked.reject(err));
			await locked.promise;
			return async () => {
				unlock.resolve();
				await held.catch(() => undefined);
				await locker.end();
			};
		},
		async [Symbol.asyncDispose]() {
			try {
				for (const { storage, client } of stores) {
					await storage.drain().catch(() => undefined);
					await client.end();
				}
				for (const name of [`${table}_parts`, `${table}_blobs`, `${table}_refs`, table, leaseTable]) {
					await admin.unsafe(`DROP TABLE IF EXISTS ${name}`);
				}
			} finally {
				await admin.end();
				dir.removeSync();
			}
		},
	};
}

/** A current-version transcript of session `id`: its header and one user turn. */
export function transcript(id: string, text: string, cwd = "/project"): string {
	const timestamp = "2026-11-17T00:00:00.000Z";
	return `${[
		{ type: "session", version: 3, id, timestamp, cwd },
		{ type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: text, timestamp: 1 } },
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

/**
 * A database of its own on the server `url` names, under the CLI's default table names, the DSN that reaches it and
 * a client on it, for tests that run the CLI against it.
 */
export async function cliDatabase(
	adapter: SqlSessionStorageAdapter,
	url: string,
): Promise<AsyncDisposable & { dsn: string; sql: SqlClient }> {
	const name = `omp_cli_${process.pid}_${Date.now().toString(36)}_${sequence++}`;
	const admin = new SQL(url);
	await admin.unsafe(`CREATE DATABASE ${name}`);
	const dsn = new URL(url);
	dsn.pathname = `/${name}`;
	const sql = new SQL(dsn.toString());
	return {
		dsn: dsn.toString(),
		sql,
		async [Symbol.asyncDispose]() {
			await sql.end();
			await admin.unsafe(`DROP DATABASE IF EXISTS ${name}${adapter === "postgres" ? " WITH (FORCE)" : ""}`);
			await admin.end();
		},
	};
}

/**
 * A stored session `id` for a CLI run in `dir`, written through `dsn`: the CLI's home, whose default model is a
 * loopback that fails any request (none at all with `model: false`), the session directory, the session's file,
 * and a DSN file naming `dsn`.
 */
export async function cliSession(dir: TempDir, dsn: string, id: string, options: { model?: boolean } = {}) {
	const cwd = dir.path();
	const home = dir.join("home");
	const sessionDir = dir.join("sessions");
	const file = path.join(sessionDir, `2026-11-17T00-00-00-000Z_${id}.jsonl`);
	const agentDir = path.join(home, ".omp", "agent");
	if (options.model !== false) {
		await Bun.write(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					loopback: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						auth: "none",
						models: [
							{
								id: "default-model",
								name: "Default Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 131072,
								maxTokens: 1024,
							},
						],
					},
				},
			}),
		);
	}
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify(
			options.model === false
				? { retry: { enabled: false } }
				: { modelRoles: { default: "loopback/default-model" }, retry: { enabled: false } },
		),
	);
	const dsnFile = dir.join("dsn");
	await Bun.write(dsnFile, `${dsn}\n`);
	const client = new SQL(dsn);
	try {
		const store = await SqlSessionStorage.create({ client, claims: false });
		await store.writeText(file, transcript(id, "before", cwd));
		await store.drain();
	} finally {
		await client.end();
	}
	return { cwd, home, sessionDir, file, dsnFile };
}

/** The error `promise` rejects with; fails when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(err: unknown) => err,
	);
}

/** Wait until `check` holds, polling; fails after `ms`. */
export async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`the condition did not hold within ${ms} ms`);
		await Bun.sleep(25);
	}
}

/** SQL words that open a parenthesis without calling a function. */
const SQL_PAREN_WORDS: Record<string, true> = {
	AND: true,
	OR: true,
	NOT: true,
	IN: true,
	ANY: true,
	ALL: true,
	EXISTS: true,
	VALUES: true,
	WHERE: true,
	AS: true,
	ON: true,
	RETURNING: true,
};

/**
 * The functions, operators and casts `sql` names without `pg_catalog`: what
 * a connection's own `search_path` could resolve to another login's object
 * when the statement runs outside a transaction that locks it. String
 * literals, quoted identifiers, parameters, `OPERATOR(pg_catalog.…)`,
 * `pg_catalog.<function>(` and `::pg_catalog.<type>` are set aside first;
 * what is left must name nothing a search can find. `SET <column> =` is an
 * assignment, not an operator.
 */
export function unqualifiedNames(sql: string): string[] {
	const rest = sql
		.replace(/'(?:[^']|'')*'/g, " ")
		.replace(/"(?:[^"]|"")*"/g, "X")
		.replace(/OPERATOR\(pg_catalog\.[^)]+\)/g, " ")
		.replace(/::pg_catalog\.\w+(?:\[\])?/g, " ")
		.replace(/pg_catalog\.\w+\s*\(/g, "(")
		.replace(/\$\d+/g, " ")
		.replace(/\bSET\s+\w+\s*=/gi, " ; ");
	const found: string[] = [];
	for (const match of rest.matchAll(/::\s*[\w.]+|[=<>!~*/%^&|#@+-]+/g)) found.push(match[0]);
	for (const match of rest.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
		const word = match[1] as string;
		if (!SQL_PAREN_WORDS[word.toUpperCase()]) found.push(`${word}(`);
	}
	return found;
}

/** A client from {@link gatedClient} and the gate that holds its transactions open. */
export interface GatedClient {
	readonly client: SqlSessionStorageClient;
	/** Hold the next transaction that runs a matching statement right after it. */
	close(): void;
	/** Resolves once a transaction waits at the closed gate. */
	paused(): Promise<void>;
	/** Let the waiting transaction go on. */
	open(): void;
}

/**
 * `client`, whose transactions pause right after (or, with `when: "before"`,
 * right before) the statement `pause` matches, until the test opens the gate:
 * so a write transaction stays open with the test choosing how long.
 */
export function gatedClient(
	client: SqlSessionStorageClient,
	pause: RegExp,
	when: "before" | "after" = "after",
): GatedClient {
	let gate: PromiseWithResolvers<void> | undefined;
	let reached = Promise.withResolvers<void>();
	const hold = async (query: string): Promise<void> => {
		if (!gate || !pause.test(query)) return;
		reached.resolve();
		await gate.promise;
	};
	const gated = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		async unsafe(query, values) {
			if (when === "before") await hold(query);
			const result = await executor.unsafe(query, values);
			if (when === "after") await hold(query);
			return result;
		},
	});
	const wrapped: SqlSessionStorageClient = {
		options: client.options,
		unsafe: (query, values) => client.unsafe(query, values),
		transaction: callback => client.transaction(transaction => callback(gated(transaction))),
		end: () => client.end?.() ?? Promise.resolve(),
	};
	return {
		client: wrapped,
		close() {
			gate = Promise.withResolvers<void>();
			reached = Promise.withResolvers<void>();
		},
		paused: () => reached.promise,
		open() {
			gate?.resolve();
			gate = undefined;
		},
	};
}

type Upstream = { unix: string } | { hostname: string; port: number };

interface ProxySide {
	socket: Socket<ProxyPair> | undefined;
	/** Bytes not yet written to `socket`, in order: queued while frozen, delayed, or refused by back-pressure. */
	pending: Uint8Array[];
}

interface ProxyPair {
	toUpstream: ProxySide;
	toClient: ProxySide;
	/** Responses held back by {@link TcpProxy.delayResponses}, each with the time it may go. */
	delayed: Array<{ at: number; data: Uint8Array }>;
	timer: Timer | undefined;
	/** The parser of what this connection's client sends, while the proxy records (see {@link TcpProxy.recordPostgres}). */
	wire: PostgresFrontendParser | undefined;
}

/** One statement a PostgreSQL client ran through a recording {@link TcpProxy}, as the wire carried it. */
export interface WireStatement {
	/** The connection it ran on, numbered from 1 in the order the proxy accepted them. */
	readonly connection: number;
	/** `query`: a simple-protocol Query; `execute`: an Execute of a statement the client parsed (prepared) earlier. */
	readonly protocol: "query" | "execute";
	readonly sql: string;
}

/** What a recording {@link TcpProxy} saw: every statement, and each connection's startup parameters. */
export interface WireRecord {
	readonly statements: WireStatement[];
	readonly startups: Array<Record<string, string>>;
}

/** The PostgreSQL protocol 3.0 version code, and the SSL and GSS encryption request codes a client may send first. */
const PG_PROTOCOL_3 = 196608;
const PG_ENCRYPTION_REQUESTS = new Set([80877103, 80877104]);

/**
 * Reads the frontend half of one PostgreSQL connection: the startup message
 * (after any SSL or GSS request), then typed messages. A simple Query is a
 * statement; a Parse names a statement's text, a Bind ties a portal to it,
 * and an Execute of that portal runs it.
 */
class PostgresFrontendParser {
	#buffer = new Uint8Array(0);
	#starting = true;
	readonly #parsed = new Map<string, string>();
	readonly #portals = new Map<string, string>();

	constructor(
		readonly connection: number,
		readonly record: WireRecord,
	) {}

	feed(bytes: Uint8Array): void {
		const joined = new Uint8Array(this.#buffer.byteLength + bytes.byteLength);
		joined.set(this.#buffer);
		joined.set(bytes, this.#buffer.byteLength);
		this.#buffer = joined;
		for (;;) {
			const buffer = this.#buffer;
			const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
			if (this.#starting) {
				if (buffer.byteLength < 8) return;
				const length = view.getInt32(0);
				if (buffer.byteLength < length) return;
				const code = view.getInt32(4);
				if (!PG_ENCRYPTION_REQUESTS.has(code)) {
					this.#starting = false;
					if (code === PG_PROTOCOL_3) this.record.startups.push(startupParameters(buffer.subarray(8, length)));
				}
				this.#buffer = buffer.subarray(length);
				continue;
			}
			if (buffer.byteLength < 5) return;
			const length = view.getInt32(1);
			if (buffer.byteLength < 1 + length) return;
			this.#message(String.fromCharCode(buffer[0] as number), buffer.subarray(5, 1 + length));
			this.#buffer = buffer.subarray(1 + length);
		}
	}

	#message(type: string, body: Uint8Array): void {
		const [first, afterFirst] = cString(body, 0);
		if (type === "Q") this.record.statements.push({ connection: this.connection, protocol: "query", sql: first });
		else if (type === "P") this.#parsed.set(first, cString(body, afterFirst)[0]);
		else if (type === "B") this.#portals.set(first, cString(body, afterFirst)[0]);
		else if (type === "E") {
			const sql = this.#parsed.get(this.#portals.get(first) ?? "") ?? "";
			this.record.statements.push({ connection: this.connection, protocol: "execute", sql });
		}
	}
}

/** The NUL-terminated string at `start` of `bytes`, and the offset just past its NUL. */
function cString(bytes: Uint8Array, start: number): [string, number] {
	let end = bytes.indexOf(0, start);
	if (end === -1) end = bytes.byteLength;
	return [new TextDecoder().decode(bytes.subarray(start, end)), end + 1];
}

/** A startup message's parameters: name and value pairs, each NUL-terminated, ending at an empty name. */
function startupParameters(bytes: Uint8Array): Record<string, string> {
	const parameters: Record<string, string> = {};
	let offset = 0;
	for (;;) {
		const [name, afterName] = cString(bytes, offset);
		if (name === "") return parameters;
		const [value, afterValue] = cString(bytes, afterName);
		parameters[name] = value;
		offset = afterValue;
	}
}

/**
 * A TCP proxy in front of a database, so a store's connection can be frozen
 * (nothing passes either way) or its responses delayed while requests pass,
 * and what PostgreSQL clients send through it recorded.
 */
export class TcpProxy {
	readonly #server: TCPSocketListener<ProxyPair>;
	readonly #pairs = new Set<ProxyPair>();
	#frozen = false;
	#delayMs = 0;
	#record: WireRecord | undefined;
	#connections = 0;

	private constructor(upstream: Upstream) {
		this.#server = Bun.listen<ProxyPair>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: client => {
					const pair: ProxyPair = {
						toUpstream: { socket: undefined, pending: [] },
						toClient: { socket: client, pending: [] },
						delayed: [],
						timer: undefined,
						wire: this.#record ? new PostgresFrontendParser(++this.#connections, this.#record) : undefined,
					};
					client.data = pair;
					this.#pairs.add(pair);
					const handler: SocketHandler<ProxyPair> = {
						data: (_socket, data) => this.#fromUpstream(pair, new Uint8Array(data)),
						drain: socket => this.#flush(pair.toUpstream, socket),
						close: () => {
							pair.toClient.socket?.end();
						},
						error: () => {
							pair.toClient.socket?.end();
						},
					};
					const connecting =
						"unix" in upstream
							? Bun.connect<ProxyPair>({ unix: upstream.unix, data: pair, socket: handler })
							: Bun.connect<ProxyPair>({
									hostname: upstream.hostname,
									port: upstream.port,
									data: pair,
									socket: handler,
								});
					void connecting.then(
						socket => {
							pair.toUpstream.socket = socket;
							if (!this.#frozen) this.#flush(pair.toUpstream);
						},
						() => client.end(),
					);
				},
				data: (client, data) => {
					const side = client.data.toUpstream;
					client.data.wire?.feed(new Uint8Array(data));
					side.pending.push(new Uint8Array(data));
					if (!this.#frozen) this.#flush(side);
				},
				drain: client => this.#flush(client.data.toClient, client),
				close: client => {
					client.data.toUpstream.socket?.end();
					this.#pairs.delete(client.data);
				},
				error: client => {
					client.data.toUpstream.socket?.end();
				},
			},
		});
	}

	static start(upstream: Upstream): TcpProxy {
		return new TcpProxy(upstream);
	}

	/** A proxy in front of the database `url` names (a PostgreSQL URL may name a Unix socket with `?host=`). */
	static for(url: string): TcpProxy {
		const parsed = new URL(url);
		const socketDir = parsed.searchParams.get("host");
		if (socketDir?.startsWith("/")) {
			return TcpProxy.start({ unix: path.join(socketDir, `.s.PGSQL.${parsed.port || "5432"}`) });
		}
		return TcpProxy.start({ hostname: parsed.hostname, port: Number(parsed.port) });
	}

	/** `url` with its host and port replaced by this proxy's. */
	urlFor(url: string): string {
		const parsed = new URL(url);
		parsed.searchParams.delete("host");
		parsed.hostname = "127.0.0.1";
		parsed.port = String(this.#server.port);
		return parsed.toString();
	}

	/**
	 * Record what every PostgreSQL connection opened through this proxy from
	 * now on sends: its startup parameters, and each statement it runs, in the
	 * order it sends them.
	 */
	recordPostgres(): WireRecord {
		this.#record = { statements: [], startups: [] };
		return this.#record;
	}

	/** Stop passing bytes either way; they queue until {@link thaw}. */
	freeze(): void {
		this.#frozen = true;
	}

	/** Bytes the clients sent that wait to reach the database: what a frozen connection was asked to carry. */
	queuedToUpstreamBytes(): number {
		let bytes = 0;
		for (const pair of this.#pairs) for (const chunk of pair.toUpstream.pending) bytes += chunk.byteLength;
		return bytes;
	}

	thaw(): void {
		this.#frozen = false;
		for (const pair of this.#pairs) {
			this.#flush(pair.toUpstream);
			this.#releaseDelayed(pair);
		}
	}

	/** Hold every response back by `ms` (0 stops delaying); requests still pass at once. */
	delayResponses(ms: number): void {
		this.#delayMs = ms;
		for (const pair of this.#pairs) this.#releaseDelayed(pair);
	}

	stop(): void {
		for (const pair of this.#pairs) {
			clearTimeout(pair.timer);
			pair.toClient.socket?.end();
			pair.toUpstream.socket?.end();
		}
		this.#server.stop(true);
	}

	#fromUpstream(pair: ProxyPair, data: Uint8Array): void {
		pair.delayed.push({ at: Date.now() + this.#delayMs, data });
		this.#releaseDelayed(pair);
	}

	/** Move every delayed response whose time has come to the client, in order, and wait for the next. */
	#releaseDelayed(pair: ProxyPair): void {
		clearTimeout(pair.timer);
		pair.timer = undefined;
		if (this.#frozen) return;
		const now = Date.now();
		// A lowered delay lets a held response go no later than a new one would.
		const cap = now + this.#delayMs;
		while (pair.delayed.length > 0) {
			const next = pair.delayed[0];
			if (next && Math.min(next.at, cap) > now) break;
			pair.toClient.pending.push((pair.delayed.shift() as { data: Uint8Array }).data);
		}
		this.#flush(pair.toClient);
		const next = pair.delayed[0];
		if (next) pair.timer = setTimeout(() => this.#releaseDelayed(pair), Math.max(1, Math.min(next.at, cap) - now));
	}

	#flush(side: ProxySide, socket = side.socket): void {
		if (!socket || this.#frozen) return;
		while (side.pending.length > 0) {
			const chunk = side.pending[0] as Uint8Array;
			const written = socket.write(chunk);
			if (written < chunk.byteLength) {
				side.pending[0] = chunk.subarray(Math.max(0, written));
				return;
			}
			side.pending.shift();
		}
	}
}

const PROCESS_SCRIPT = path.join(import.meta.dir, "sql-session-lease-process.ts");

/** The configuration a {@link LeaseProcess} opens its store with. */
export interface LeaseProcessConfig {
	dsn: string;
	table: string;
	leaseTable: string;
	lease?: { expiryMs: number; heartbeatMs: number };
	/** `file`: the process runs on file storage instead, for the paths only it has; the other fields are unused. */
	storage?: "file";
	/**
	 * The store answers the holder lookup (`sessionClaimHolder`) only after this many ms, as a database slow to
	 * answer does, so an `OMP_SESSION_EXCLUSIVE=1` stop exits that much later; file storage, which names no holder,
	 * gets one that answers nothing.
	 */
	holderLookupMs?: number;
}

/** What a {@link LeaseProcess} answers each command with. */
export interface LeaseProcessReport {
	/** The session id its manager writes, or the outcome of a bare claim. */
	sessionId?: string;
	sessionFile?: string;
	held?: boolean;
	/** The session's stored content a `claim` with `read` saw right after claiming, `null` when there was none. */
	content?: string | null;
	/** Persistence notices its manager raised, in order. */
	notices?: Array<{ reason: string; from: string; to: string }>;
	/** The session id an extension saw at `session_start`. */
	sessionStartId?: string;
	/** The session events a `switch` saw, each with the id and how long after the switch began. */
	events?: Array<{ type: string; id: string; afterSwitchStartMs: number }>;
	/** The manager ids a `switch` read once a second while it switched, and the session it switched from. */
	polled?: string[];
	scratchId?: string;
	/** A `defaultSessionDir`'s answer. */
	sessionDir?: string;
	/** Milliseconds the command took. */
	elapsedMs?: number;
	/** What the command wrote to stderr. */
	stderr?: string;
	error?: string;
}

/**
 * Another omp-like process with its own store on a fixture database. Each
 * command is one JSON line on stdin and one {@link LeaseProcessReport} line
 * on stdout (see `sql-session-lease-process.ts` for the commands).
 */
export class LeaseProcess implements AsyncDisposable {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	/** Start the process; `home` isolates its agent directory and breadcrumbs; `env` adds to its environment. */
	static async start(
		config: LeaseProcessConfig,
		home: string,
		env: Record<string, string> = {},
	): Promise<LeaseProcess> {
		const child = Bun.spawn([process.execPath, PROCESS_SCRIPT, JSON.stringify(config)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// The live environment, so a SQLite claim meets this test's session-owner locks.
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_STATE_HOME: path.join(home, "state"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				PI_NO_TITLE: "1",
				...env,
			},
		});
		const started = new LeaseProcess(child);
		await started.#next();
		return started;
	}

	get pid(): number {
		return this.#child.pid;
	}

	get exited(): Promise<number> {
		return this.#child.exited;
	}

	/** The command's answer; it fails when the process exits first. */
	run(command: Record<string, unknown>): Promise<LeaseProcessReport> {
		this.#child.stdin.write(`${JSON.stringify(command)}\n`);
		this.#child.stdin.flush();
		return this.#next();
	}

	/** A crash: the dead process releases nothing itself. */
	async kill(): Promise<void> {
		this.#child.kill("SIGKILL");
		await this.#child.exited;
	}

	async stderr(): Promise<string> {
		return new Response(this.#child.stderr).text();
	}

	async #next(): Promise<LeaseProcessReport> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The lease process exited early: ${await this.stderr()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return JSON.parse(line) as LeaseProcessReport;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		this.#child.stdin.end();
		const exited = await Promise.race([this.#child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
		if (!exited) this.#child.kill("SIGKILL");
		await this.#child.exited;
	}
}
