/**
 * The SQL session store on PostgreSQL under each session setting another
 * client of a transaction-mode pool can leave on the server connection the
 * store then gets: for each entry of `PG_SESSION_SETTINGS` the server has,
 * `role` and a temporary table named as each store table, the test leaves the
 * setting with a session-level statement and runs every store operation.
 *
 * Variables:
 * - `OMP_TEST_SQL_POSTGRES_URL`: the store's server. PostgreSQL directly, as a
 *   login without superuser (the direct leg), or PgBouncer 1.25.2 in
 *   transaction mode with one server connection (the pooled leg). The leg is
 *   read, not set: `inet_server_port()` read through this URL is another port
 *   than the URL's own behind a pooler. Unset, only the server-log rule's rows
 *   run and every database test is skipped.
 * - `OMP_TEST_SQL_POSTGRES_ADMIN_URL`: the same database on PostgreSQL
 *   directly, as a superuser. It makes the test's roles and database and reads
 *   what the store wrote. The file's first test fails when it is unset.
 * - `OMP_TEST_SQL_POSTGRES_POOL4_URL`: pooled leg only, a PgBouncer entry of
 *   the same database with four server connections. The file's first test
 *   fails in the pooled leg when it is unset.
 *
 * Every local connection must be trusted: the test logs in as its own roles
 * and to its own database with the store's URL, user or database replaced.
 * The direct leg's last test reads the server log (`log/server.log` in the
 * data directory, written with `log_statement = 'all'`,
 * `log_parameter_max_length = 0` and
 * `log_line_prefix = '%m pid=%p app=%a code=%e '`) through the admin URL. It
 * needs `log_parameter_max_length = 0`: at the default, -1, the server logs
 * each bound value whole after its statement, 8 MiB for the 8 MiB write, and
 * the test reads those lines back with the store's.
 *
 * Each case prints one line, `left-setting case leg=… entry=… operations=…
 * data=… temp=… app=… pid=… pid_before=… pid_after=… left_value=… admin=…`,
 * then asserts each condition; each leg prints a line for each entry the
 * server lacks, and its case count last.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	PG_APPLICATION_NAME,
	PG_REPAIR_RETRIES,
	PG_SESSION_SETTINGS,
	type PgSessionSetting,
	pgOpening,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-postgres-settings";
import type { SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, getBlobsDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { type ReservedSQL, SQL } from "bun";
import {
	checkServerLog,
	LEFT_MARKER,
	type LeftClient,
	type LeftRecord,
	type LeftSetting,
	type LeftStoreClient,
	leftClient,
	leftError,
	logPids,
} from "./postgres-left-settings-harness";
import { rejection, until } from "./sql-session-lease-fixture";

const STORE_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
const ADMIN_URL = process.env.OMP_TEST_SQL_POSTGRES_ADMIN_URL;
/** The two URLs for the leg's tests, which run only when the store's URL is set (and fail on an unset admin URL). */
const STORE = STORE_URL ?? "";
const ADMIN = ADMIN_URL ?? "";
const POOL4_URL = process.env.OMP_TEST_SQL_POSTGRES_POOL4_URL;

/** The parameters PgBouncer 1.25.2 sets back to each client's own value (five fixed names and `track_extra_parameters`). */
const POOLER_RESETS = [
	"DateStyle",
	"client_encoding",
	"TimeZone",
	"standard_conforming_strings",
	"application_name",
	"IntervalStyle",
];

const CASE_TIMEOUT_MS = 180_000;
/** The longest one operation of a case may run before the case reports it failed. */
const STEP_BOUND_MS = 30_000;
/** The after-case read, the server-log reads and the waits for a closed backend to go. */
const READ_BOUND_MS = 15_000;
const SETTLE_BOUND_MS = 10_000;
/** How long the held-row append is given to show waiting in `pg_stat_activity`. */
const HELD_WAIT_MS = 10_000;
/** How long the row stays held once the append waits: past the left 50 ms statement and 1 ms lock timeouts. */
const HELD_HOLD_MS = 1000;
/** A lease heartbeat runs every 500 ms; its row must advance within this. */
const HEARTBEAT_WAIT_MS = 5000;
/** How often a wait polls the live server: a database condition gives no event to wait on. */
const POLL_MS = 50;
const LEASE = { expiryMs: 3000, heartbeatMs: 500 };
const LOG_FILE = "log/server.log";
const LOG_CHUNK_BYTES = 16 * 1024 * 1024;
const REPAIR_WARNING = "SqlSessionStorage closed a PostgreSQL connection it cannot repair";

const STAMP = "2026-11-20T00:00:00.000Z";
const TITLE = { title: "Left setting título ✓", source: "user", updatedAt: STAMP } as const;
/** A line of text with characters of one to four bytes, repeated into the 8 MiB write. */
const BIG_UNIT = "Grüße aus Zürich, 東京と北京 🙂 ñandú ✓\n";
const BIG_UNIT_BYTES = Buffer.byteLength(BIG_UNIT);
const BIG_COUNT = Math.ceil((8 * 1024 * 1024) / BIG_UNIT_BYTES);
const BIG = BIG_UNIT.repeat(BIG_COUNT);
const BIG_BYTES = BIG_COUNT * BIG_UNIT_BYTES;
/** The windows of the two slice reads and the offset of the read from an offset, each on a character boundary. */
const SLICE_UNITS = 64;
const FROM_UNITS = Math.floor(BIG_COUNT / 2);
const BLOB_A = Buffer.alloc(4096, 0x5a);
const BLOB_B = Buffer.alloc(3000, 0x3c);
const BLOB_A_WRONG = Buffer.from(BLOB_A);
BLOB_A_WRONG[0] = 0x00;
const BLOB_A_HASH = sha256(BLOB_A);
const BLOB_B_HASH = sha256(BLOB_B);
const BLOB_MISSING_HASH = sha256(Buffer.from("a blob no store holds"));

/** The store tables a temporary table of each case takes the name of. */
const TEMPORARY_TABLES = ["session", "parts", "blobs", "refs", "lease"] as const;
type TemporaryTable = (typeof TEMPORARY_TABLES)[number];

const READ_ONLY_LOGIN_CASE = "a login whose read-only default the session keeps";
const READ_ONLY_DATABASE_CASE = "a database whose read-only default the session keeps";
const REPAIRLESS_THEN_CLEAN_CASE = "three repairless connections, then a clean one";
const ONLY_REPAIRLESS_CASE = "only repairless connections";
const NO_RESERVE_CASE = "a PostgreSQL client without reserve()";
const POOL_OF_ONE_CASE = "a pool of one server connection left without rights";
const POOL_OF_FOUR_CASE = "a pool of four with three left without rights";

type Leg = "direct" | "pooled";
type Rows = Array<Record<string, unknown>>;

interface Server {
	readonly leg: Leg;
	/** The session user the store's URL logs in as on the server. */
	readonly login: string;
	/** Every `pg_settings` name of the server. */
	readonly names: ReadonlySet<string>;
	/** The `pg_settings` names of context `user`. */
	readonly userNames: readonly string[];
}

function sha256(data: Buffer): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function literal(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function readServer(url: string): Promise<Server> {
	const sql = new SQL(url, { max: 1 });
	try {
		const [where] = (await sql.unsafe(
			"SELECT pg_catalog.inet_server_port() AS port, session_user::text AS login",
		)) as Rows;
		const settings = (await sql.unsafe("SELECT name, context FROM pg_catalog.pg_settings")) as Rows;
		const urlPort = Number(new URL(url).port || "5432");
		return {
			leg: Number(where?.port) === urlPort ? "direct" : "pooled",
			login: String(where?.login),
			names: new Set(settings.map(row => String(row.name))),
			userNames: settings.filter(row => row.context === "user").map(row => String(row.name)),
		};
	} finally {
		await sql.close();
	}
}

const server = STORE_URL ? await readServer(STORE_URL) : undefined;
const LEG: Leg = server?.leg ?? "direct";

interface CaseSpec {
	/** The entry the case's line names. */
	readonly label: string;
	readonly setting: PgSessionSetting;
	readonly temporaryTable?: TemporaryTable;
}

/** One case for each entry the server has, for `role`, and for a temporary table named as each store table. */
function buildCases(): CaseSpec[] {
	const cases: CaseSpec[] = [];
	for (const setting of PG_SESSION_SETTINGS) {
		if (setting.name === "temporary table") {
			for (const table of TEMPORARY_TABLES)
				cases.push({ label: `temporary table ${table}`, setting, temporaryTable: table });
			continue;
		}
		if (server && setting.name !== "role" && !server.names.has(setting.name)) {
			console.log(`left-setting server lacks ${setting.name}`);
			continue;
		}
		if (LEG === "pooled" && POOLER_RESETS.includes(setting.name)) {
			console.log(`left-setting pooler resets ${setting.name}`);
			continue;
		}
		cases.push({ label: setting.name, setting });
	}
	return cases;
}

const CASES = buildCases();
const SUFFIX = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const NORIGHTS_ROLE = `omp_left_${SUFFIX}_norights`;
const READ_ONLY_LOGIN = `omp_left_${SUFFIX}_ro`;
const READ_ONLY_DATABASE = `omp_left_${SUFFIX}_ro`;

/** What the leg made with the admin URL, or why it could not; a case that needs one fails with that reason. */
const made = new Map<string, string>();
const failedToMake = new Map<string, unknown>();
let admin: SQL | undefined;
let agentDir: TempDir | undefined;
let originalAgentDir: string | undefined;
let root: TempDir | undefined;
/** Every client's record in this leg, read by the server-log test. */
const records: LeftRecord[] = [];
/** Every case's tables, dropped after the case and again at the end. */
const madeTables: CaseTables[] = [];
let sequence = 0;

function needAdmin(): SQL {
	if (!admin) throw new Error("left-setting: set OMP_TEST_SQL_POSTGRES_ADMIN_URL");
	return admin;
}

function needServer(): Server {
	if (!server) throw new Error("left-setting: set OMP_TEST_SQL_POSTGRES_URL");
	return server;
}

function need(what: string): string {
	const value = made.get(what);
	if (value !== undefined) return value;
	throw new Error(
		`left-setting: the ${what} could not be made: ${errorText(failedToMake.get(what) ?? "no admin URL")}`,
	);
}

async function make(what: string, task: () => Promise<string>): Promise<void> {
	try {
		made.set(what, await task());
	} catch (err) {
		failedToMake.set(what, err);
	}
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

interface CaseTables {
	readonly table: string;
	readonly leaseTable: string;
}

function caseTables(): CaseTables {
	sequence++;
	const tables = { table: `omp_left_${SUFFIX}_${sequence}`, leaseTable: `omp_left_${SUFFIX}_${sequence}_leases` };
	madeTables.push(tables);
	return tables;
}

function temporaryTableName(tables: CaseTables, which: TemporaryTable): string {
	if (which === "session") return tables.table;
	if (which === "lease") return tables.leaseTable;
	return `${tables.table}_${which}`;
}

function storeOptions(client: LeftStoreClient, tables: CaseTables) {
	return { client, table: tables.table, leaseTable: tables.leaseTable, claims: true, lease: LEASE };
}

async function dropTables(tables: CaseTables): Promise<void> {
	const { table, leaseTable } = tables;
	await admin
		?.unsafe(
			`DROP TABLE IF EXISTS public.${table}_refs, public.${table}_blobs, public.${table}_parts, public.${table}, ` +
				`public.${leaseTable}`,
		)
		.catch(() => undefined);
}

function withUrl(url: string, change: (parsed: URL) => void): string {
	const parsed = new URL(url);
	change(parsed);
	return parsed.toString();
}

async function backendGone(db: SQL, pid: number): Promise<boolean> {
	const [row] = (await db.unsafe("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1::int", [
		pid,
	])) as Rows;
	return Number(row?.n) === 0;
}

/** End the pooled leg's server connections a case used, so the next case meets a clean one. */
async function terminate(pids: Iterable<number>): Promise<void> {
	const db = admin;
	if (!db) return;
	for (const pid of new Set(pids)) {
		await db.unsafe("SELECT pg_catalog.pg_terminate_backend($1::int)", [pid]).catch(() => undefined);
		await until(() => backendGone(db, pid), READ_BOUND_MS, {
			what: `the end of backend ${pid}`,
			pollMs: POLL_MS,
		}).catch(() => undefined);
	}
	// PgBouncer drops a server connection when the ended backend's FATAL reaches it; nothing tells the test when it did.
	await Bun.sleep(200);
}

function authorization(role: string): LeftSetting {
	const statement = `SET SESSION AUTHORIZATION ${identifier(role)}`;
	return { statement, again: statement, value: "pg_catalog.current_setting('session_authorization')" };
}

function leftSetting(spec: CaseSpec, tables: CaseTables): LeftSetting {
	if (spec.temporaryTable) {
		const name = temporaryTableName(tables, spec.temporaryTable);
		const statement = spec.setting.left.replaceAll("{table}", name);
		return {
			statement,
			// A second CREATE of a table that is still there would fail the read.
			again: statement.replace(/^CREATE TEMP TABLE /, "CREATE TEMP TABLE IF NOT EXISTS "),
			value: `CASE WHEN pg_catalog.to_regclass(${literal(`pg_temp.${name}`)}) IS NULL THEN 'absent' ELSE 'present' END`,
		};
	}
	const statement = spec.setting.left.includes("{role}")
		? spec.setting.left.replaceAll("{role}", identifier(need("role without rights")))
		: spec.setting.left;
	return { statement, again: statement, value: `pg_catalog.current_setting(${literal(spec.setting.name)})` };
}

/** A transcript of session `id`: its header and one user turn. */
function transcript(id: string, text: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: STAMP, cwd: "/project" })}\n${turn(text, "m1")}`;
}

function turn(text: string, id: string): string {
	return `${JSON.stringify({ type: "message", id, parentId: null, timestamp: STAMP, message: { role: "user", content: text, timestamp: 1 } })}\n`;
}

function blobTranscript(id: string, hashes: readonly string[]): string {
	return transcript(id, `images ${hashes.map(hash => `blob:sha256:${hash}`).join(" ")}`);
}

/** A path whose name makes it session `id`'s file, so a write to it runs behind that session's lease fence. */
function sessionFile(dir: string, second: number, id: string): string {
	return path.join(dir, `2026-11-20T00-00-${String(second).padStart(2, "0")}-000Z_${id}.jsonl`);
}

/** What the store reported writing, as the admin URL must find it. */
interface Model {
	readonly files: Map<string, { content: string; title: string | null }>;
	readonly blobs: Map<string, Buffer>;
	/** `<path>\n<sha256>` */
	readonly refs: Set<string>;
	readonly leases: Set<string>;
}

interface Operations {
	readonly failure: { readonly operation: string; readonly error: unknown } | undefined;
	readonly model: Model;
	/** The `application_name` the store's backend showed while its append waited for the held row. */
	readonly app: string | undefined;
	readonly stores: SqlSessionStorage[];
}

function check(holds: boolean, what: string): void {
	if (!holds) throw new Error(`left-setting: ${what}`);
}

/**
 * Every store operation of the case, in order, each bounded by
 * {@link STEP_BOUND_MS}. The first one that fails ends the list; `model`
 * then holds what the operations before it reported.
 */
async function runOperations(harness: LeftClient, tables: CaseTables): Promise<Operations> {
	const db = needAdmin();
	const { table, leaseTable } = tables;
	const model: Model = { files: new Map(), blobs: new Map(), refs: new Set(), leases: new Set() };
	const stores: SqlSessionStorage[] = [];
	let app: string | undefined;
	const dir = path.join(root?.path() ?? os.tmpdir(), table);
	const id = () => crypto.randomUUID();
	const ids = { claimed: id(), foreign: id(), header: id(), written: id(), deleted: id(), images: id(), big: id() };
	const files = {
		claimed: sessionFile(dir, 1, ids.claimed),
		foreign: sessionFile(dir, 2, ids.foreign),
		written: sessionFile(dir, 3, ids.written),
		moved: sessionFile(dir, 4, ids.written),
		movedAgain: sessionFile(dir, 5, ids.written),
		taken: sessionFile(dir, 6, id()),
		truncated: sessionFile(dir, 7, id()),
		removed: sessionFile(dir, 8, id()),
		deleted: sessionFile(dir, 9, ids.deleted),
		artifact: path.join(sessionFile(dir, 9, ids.deleted).slice(0, -".jsonl".length), "artifact.jsonl"),
		big: sessionFile(dir, 10, ids.big),
		images: sessionFile(dir, 11, ids.images),
	};
	const lines = [
		`${JSON.stringify({ type: "session", version: 3, id: ids.claimed, timestamp: STAMP, cwd: "/project" })}\n`,
		turn("first append, ünïcödé", "m1"),
		turn("held append ✓", "m2"),
	] as const;
	const setFile = (file: string, content: string) => {
		model.files.set(file, { content, title: model.files.get(file)?.title ?? null });
	};
	const moveFile = (from: string, to: string) => {
		const entry = model.files.get(from);
		model.files.delete(from);
		if (entry) model.files.set(to, entry);
	};
	const leaseRows = async (sessionId: string) =>
		(await db.unsafe(`SELECT host, pid, heartbeat_at FROM public.${leaseTable} WHERE session_id = $1`, [
			sessionId,
		])) as Rows;
	let storage: SqlSessionStorage | undefined;
	const store = (): SqlSessionStorage => {
		if (!storage) throw new Error("left-setting: no store is open");
		return storage;
	};
	let release: (() => void) | null | undefined;
	let writer: SessionStorageWriter | undefined;

	const steps: Array<[string, () => Promise<void>]> = [
		[
			"open_missing",
			async () => {
				stores.push(await SqlSessionStorage.create(storeOptions(harness.client, tables)));
			},
		],
		[
			"open_present",
			async () => {
				storage = await SqlSessionStorage.create(storeOptions(harness.client, tables));
				stores.push(storage);
			},
		],
		[
			"claim",
			async () => {
				release = await store().acquireSessionClaim?.(ids.claimed, files.claimed);
				check(typeof release === "function", "the claim of a free session was refused");
				const [row] = await leaseRows(ids.claimed);
				check(
					row !== undefined && Number(row.pid) === process.pid && row.host === os.hostname(),
					"no lease row of this process",
				);
				model.leases.add(ids.claimed);
			},
		],
		[
			"claim_foreign",
			async () => {
				await store().writeText(files.foreign, transcript(ids.header, "a header that names another session"));
				setFile(files.foreign, transcript(ids.header, "a header that names another session"));
				const refused = await store().acquireSessionClaim?.(ids.foreign, files.foreign);
				// A store that claims it reported a lease row of that session.
				if (refused !== null) model.leases.add(ids.foreign);
				check(refused === null, "the claim of a path whose header names another session was not refused");
			},
		],
		[
			"heartbeat",
			async () => {
				const [first] = await leaseRows(ids.claimed);
				const start = Number(first?.heartbeat_at);
				await until(
					async () => Number((await leaseRows(ids.claimed))[0]?.heartbeat_at) > start,
					HEARTBEAT_WAIT_MS,
					{ what: "a heartbeat", pollMs: POLL_MS },
				);
			},
		],
		[
			"append",
			async () => {
				writer = store().openWriter(files.claimed);
				await writer.append(lines[0]);
				await writer.append(lines[1]);
				await writer.flush();
				check(writer.getError() === undefined, `the writer failed: ${writer.getError()?.message}`);
				setFile(files.claimed, `${lines[0]}${lines[1]}`);
			},
		],
		[
			"append_held",
			async () => {
				if (!writer) throw new Error("left-setting: no writer");
				const held = await db.reserve();
				let pending: Promise<void> | undefined;
				let settled = false;
				try {
					await held.unsafe("BEGIN");
					const [me] = (await held.unsafe("SELECT pg_catalog.pg_backend_pid() AS pid")) as Rows;
					await held.unsafe(`SELECT path FROM public.${table} WHERE path = $1 FOR UPDATE`, [files.claimed]);
					pending = writer.append(lines[2]);
					pending.then(
						() => {
							settled = true;
						},
						() => {
							settled = true;
						},
					);
					await until(
						async () => {
							const [waiting] = (await db.unsafe(
								"SELECT application_name FROM pg_catalog.pg_stat_activity " +
									"WHERE $1::int = ANY(pg_catalog.pg_blocking_pids(pid))",
								[Number(me?.pid)],
							)) as Rows;
							if (waiting) app = String(waiting.application_name);
							return waiting !== undefined || settled;
						},
						HELD_WAIT_MS,
						{ what: "the store's append waiting for the held row", pollMs: POLL_MS },
					).catch(() => undefined);
					// The store's append must wait out the hold: its own short timeouts would end the wait inside it.
					if (!settled) await Bun.sleep(HELD_HOLD_MS);
				} finally {
					await held.unsafe("COMMIT").catch(() => undefined);
					held.release();
				}
				await pending;
				await writer.close();
				setFile(files.claimed, lines.join(""));
			},
		],
		[
			"write_full",
			async () => {
				await store().writeText(files.written, transcript(ids.written, "first full write"));
				setFile(files.written, transcript(ids.written, "first full write"));
			},
		],
		[
			"rewrite",
			async () => {
				const content = transcript(ids.written, "the rewrite, longer than the first full write");
				await store().writeTextAtomic(files.written, content, {
					expectedSize: Buffer.byteLength(transcript(ids.written, "first full write")),
				});
				setFile(files.written, content);
			},
		],
		[
			"truncate",
			async () => {
				const content = transcript(id(), "before the truncate");
				await store().writeText(files.truncated, content);
				setFile(files.truncated, content);
				const truncating = store().openWriter(files.truncated, { flags: "w" });
				await truncating.append(turn("after the truncate", "m1"));
				await truncating.close();
				setFile(files.truncated, turn("after the truncate", "m1"));
			},
		],
		[
			"title",
			async () => {
				await store().updateSessionTitle(files.written, TITLE);
				const entry = model.files.get(files.written);
				if (entry) model.files.set(files.written, { ...entry, title: TITLE.title });
			},
		],
		[
			"move",
			async () => {
				await store().rename(files.written, files.moved);
				moveFile(files.written, files.moved);
			},
		],
		[
			"move_no_replace",
			async () => {
				// The first store writes the path, so the second store's view lacks it and only the database refuses.
				const content = transcript(id(), "a path another store wrote");
				const other = stores[0];
				if (!other) throw new Error("left-setting: the first store did not open");
				await other.writeText(files.taken, content);
				setFile(files.taken, content);
				const refused = await store()
					.renameNoReplace(files.moved, files.taken)
					.then(
						() => {
							moveFile(files.moved, files.taken);
							return new Error("the move replaced the taken path");
						},
						(err: unknown) => err,
					);
				check(leftError(refused).code === "EEXIST", `the move onto a taken path: ${errorText(refused)}`);
				await store().renameNoReplace(files.moved, files.movedAgain);
				moveFile(files.moved, files.movedAgain);
			},
		],
		[
			"remove",
			async () => {
				const content = transcript(id(), "removed next");
				await store().writeText(files.removed, content);
				setFile(files.removed, content);
				await store().unlink(files.removed);
				model.files.delete(files.removed);
			},
		],
		[
			"delete_session",
			async () => {
				const session = transcript(ids.deleted, "deleted with its artifact");
				await store().writeText(files.deleted, session);
				setFile(files.deleted, session);
				const artifact = transcript(id(), "an artifact of the deleted session");
				await store().writeText(files.artifact, artifact);
				setFile(files.artifact, artifact);
				await store().deleteSessionWithArtifacts(files.deleted);
				model.files.delete(files.deleted);
				model.files.delete(files.artifact);
			},
		],
		[
			"write_8mib",
			async () => {
				await store().writeText(files.big, BIG);
				setFile(files.big, BIG);
			},
		],
		[
			"read_index",
			async () => {
				await store().refresh();
				check(store().statSync(files.big).size === BIG_BYTES, "the index size of the 8 MiB session");
				const listed = store().listAllSync().sort();
				check(Bun.deepEquals(listed, [...model.files.keys()].sort()), `the index lists ${listed.join(", ")}`);
			},
		],
		[
			"read_text",
			async () => {
				check((await store().readText(files.big)) === BIG, "readText of the 8 MiB session");
			},
		],
		[
			"read_slices",
			async () => {
				const slice = BIG_UNIT_BYTES * SLICE_UNITS;
				const [head, tail] = await store().readTextSlices(files.big, slice, slice);
				const expected = BIG_UNIT.repeat(SLICE_UNITS);
				check(head === expected && tail === expected, "readTextSlices of the 8 MiB session");
			},
		],
		[
			"read_from",
			async () => {
				const read = await store().readTextFrom(files.big, BIG_UNIT_BYTES * FROM_UNITS);
				check(read.size === BIG_BYTES, `readTextFrom's size ${read.size}`);
				check(read.text === BIG_UNIT.repeat(BIG_COUNT - FROM_UNITS), "readTextFrom of the 8 MiB session");
			},
		],
		[
			"blob_land",
			async () => {
				store().blobTier.store(BLOB_A_HASH, BLOB_A, "image/png");
				store().blobTier.store(BLOB_B_HASH, BLOB_B, "image/png");
				// A transcript write lands the blobs it names first.
				await store().writeText(files.images, blobTranscript(ids.images, [BLOB_A_HASH, BLOB_B_HASH]));
				setFile(files.images, blobTranscript(ids.images, [BLOB_A_HASH, BLOB_B_HASH]));
				model.blobs.set(BLOB_A_HASH, BLOB_A);
				model.blobs.set(BLOB_B_HASH, BLOB_B);
				model.refs.add(`${files.images}\n${BLOB_A_HASH}`);
				model.refs.add(`${files.images}\n${BLOB_B_HASH}`);
			},
		],
		[
			"blob_reland",
			async () => {
				// A delete took the row after it landed: the next write naming it lands it again from the local blob store.
				await Bun.write(path.join(getBlobsDir(), BLOB_A_HASH), BLOB_A);
				await db.unsafe(`DELETE FROM public.${table}_refs WHERE sha256 = $1`, [BLOB_A_HASH]);
				await db.unsafe(`DELETE FROM public.${table}_blobs WHERE sha256 = $1`, [BLOB_A_HASH]);
				model.blobs.delete(BLOB_A_HASH);
				model.refs.delete(`${files.images}\n${BLOB_A_HASH}`);
				await store().writeText(files.images, blobTranscript(ids.images, [BLOB_A_HASH]));
				setFile(files.images, blobTranscript(ids.images, [BLOB_A_HASH]));
				model.blobs.set(BLOB_A_HASH, BLOB_A);
				model.refs.delete(`${files.images}\n${BLOB_B_HASH}`);
				model.refs.add(`${files.images}\n${BLOB_A_HASH}`);
			},
		],
		[
			"blob_sizes",
			async () => {
				const sizes = await store().blobTier.sizes([BLOB_A_HASH, BLOB_B_HASH, BLOB_MISSING_HASH]);
				check(
					sizes.size === 2 && sizes.get(BLOB_A_HASH) === BLOB_A.length && sizes.get(BLOB_B_HASH) === BLOB_B.length,
					`blob sizes ${JSON.stringify([...sizes])}`,
				);
			},
		],
		[
			"blob_read",
			async () => {
				const read = new Map<string, Buffer>();
				await store().blobTier.read([BLOB_A_HASH, BLOB_B_HASH], async (hash, data) => {
					read.set(hash, Buffer.from(data));
				});
				check(
					read.size === 2 &&
						read.get(BLOB_A_HASH)?.equals(BLOB_A) === true &&
						read.get(BLOB_B_HASH)?.equals(BLOB_B) === true,
					"the blob bytes read",
				);
			},
		],
		[
			"blob_repair",
			async () => {
				await db.unsafe(`UPDATE public.${table}_blobs SET content = $1 WHERE sha256 = $2`, [
					BLOB_A_WRONG,
					BLOB_A_HASH,
				]);
				model.blobs.set(BLOB_A_HASH, BLOB_A_WRONG);
				const local = new Map([
					[BLOB_A_HASH, BLOB_A],
					[BLOB_B_HASH, BLOB_B],
				]);
				const repaired = await store().blobTier.repair(
					[BLOB_A_HASH, BLOB_B_HASH],
					async hash => local.get(hash) ?? null,
				);
				check(repaired === 1, `repaired ${repaired} blobs`);
				model.blobs.set(BLOB_A_HASH, BLOB_A);
			},
		],
		[
			"blob_reference",
			async () => {
				await store().blobTier.reference(files.big, [BLOB_A_HASH]);
				model.refs.add(`${files.big}\n${BLOB_A_HASH}`);
			},
		],
		[
			"blob_sweep",
			async () => {
				const counted = await store().blobTier.sweep(new Set(), Date.now() + 60_000, false);
				check(
					Bun.deepEquals(counted, { candidates: 1, deleted: 0, bytes: BLOB_B.length }),
					`the sweep without apply counted ${JSON.stringify(counted)}`,
				);
				const swept = await store().blobTier.sweep(new Set(), Date.now() + 60_000, true);
				check(
					Bun.deepEquals(swept, { candidates: 1, deleted: 1, bytes: BLOB_B.length }),
					`the sweep with apply deleted ${JSON.stringify(swept)}`,
				);
				model.blobs.delete(BLOB_B_HASH);
			},
		],
		[
			"release",
			async () => {
				if (typeof release !== "function") throw new Error("left-setting: no claim to release");
				release();
				await store().drain();
				check((await leaseRows(ids.claimed)).length === 0, "the lease row is still there");
				model.leases.delete(ids.claimed);
			},
		],
	];

	for (const [operation, step] of steps) {
		try {
			await within(step(), STEP_BOUND_MS, operation);
		} catch (error) {
			return { failure: { operation, error }, model, app, stores };
		}
	}
	return { failure: undefined, model, app, stores };
}

/** Give back what the stores still hold and wait for their queued writes, each within its bound. */
async function settle(stores: readonly SqlSessionStorage[]): Promise<void> {
	for (const storage of stores) {
		await within(storage.releaseHeldClaims?.() ?? Promise.resolve(), SETTLE_BOUND_MS, "release").catch(
			() => undefined,
		);
		await within(storage.drain(), SETTLE_BOUND_MS, "drain").catch(() => undefined);
	}
}

async function tablePresent(db: SQL, name: string): Promise<boolean> {
	const [row] = (await db.unsafe("SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present", [
		`public.${name}`,
	])) as Rows;
	return row?.present === true;
}

/** The store tables of `tables` that exist in `db`'s database. */
async function presentTables(db: SQL, tables: CaseTables): Promise<string[]> {
	const { table, leaseTable } = tables;
	const present: string[] = [];
	for (const name of [table, `${table}_parts`, `${table}_blobs`, `${table}_refs`, leaseTable]) {
		if (await tablePresent(db, name)) present.push(name);
	}
	return present;
}

async function rowsOf(db: SQL, name: string, query: string): Promise<Rows> {
	return (await tablePresent(db, name)) ? ((await db.unsafe(query)) as Rows) : [];
}

/** Compare, on the admin URL, what the store's tables hold with what the store reported writing. */
async function adminCompare(db: SQL, tables: CaseTables, model: Model): Promise<{ pass: boolean; summary: string }> {
	const { table, leaseTable } = tables;
	const sessionRows = await rowsOf(db, table, `SELECT path, content, byte_len, title FROM public.${table}`);
	const partRows = await rowsOf(
		db,
		`${table}_parts`,
		`SELECT path, content FROM public.${table}_parts ORDER BY path, start_offset`,
	);
	const blobRows = await rowsOf(db, `${table}_blobs`, `SELECT sha256, content FROM public.${table}_blobs`);
	const refRows = await rowsOf(db, `${table}_refs`, `SELECT path, sha256 FROM public.${table}_refs`);
	const leaseRows = await rowsOf(db, leaseTable, `SELECT session_id FROM public.${leaseTable}`);

	const parts = new Map<string, string[]>();
	for (const row of partRows)
		parts.set(String(row.path), [...(parts.get(String(row.path)) ?? []), String(row.content)]);
	let pass = sessionRows.length === model.files.size;
	let foundBytes = 0;
	for (const row of sessionRows) {
		const file = String(row.path);
		const byteLen = Number(row.byte_len);
		foundBytes += byteLen;
		const expected = model.files.get(file);
		const content = Buffer.from(String(row.content) + (parts.get(file) ?? []).join(""));
		if (
			!expected ||
			!content.equals(Buffer.from(expected.content)) ||
			byteLen !== Buffer.byteLength(expected.content) ||
			(row.title ?? null) !== expected.title
		) {
			pass = false;
		}
	}
	let reportedBytes = 0;
	for (const { content } of model.files.values()) reportedBytes += Buffer.byteLength(content);

	let foundBlobBytes = 0;
	pass &&= blobRows.length === model.blobs.size;
	for (const row of blobRows) {
		const data = Buffer.from(row.content as Uint8Array);
		foundBlobBytes += data.length;
		if (!model.blobs.get(String(row.sha256))?.equals(data)) pass = false;
	}
	let reportedBlobBytes = 0;
	for (const data of model.blobs.values()) reportedBlobBytes += data.length;

	const refs = new Set(refRows.map(row => `${String(row.path)}\n${String(row.sha256)}`));
	pass &&= refRows.length === model.refs.size && [...model.refs].every(ref => refs.has(ref));
	const leases = new Set(leaseRows.map(row => String(row.session_id)));
	pass &&= leaseRows.length === model.leases.size && [...model.leases].every(lease => leases.has(lease));

	const summary = [
		`rows:${sessionRows.length}/${model.files.size}`,
		`bytes:${foundBytes}/${reportedBytes}`,
		`blobs:${blobRows.length}/${model.blobs.size}`,
		`blob_bytes:${foundBlobBytes}/${reportedBlobBytes}`,
		`refs:${refRows.length}/${model.refs.size}`,
		`leases:${leaseRows.length}/${model.leases.size}`,
	].join(",");
	return { pass, summary };
}

/** A client of the pool other than the store's: it reads the backend it gets and the value on it. */
async function secondClientRead(value: string, seen: number[]): Promise<{ pid: number; value: string }> {
	const second = new SQL(STORE, { max: 1 });
	try {
		const [row] = (await second.unsafe(
			`${LEFT_MARKER} SELECT pg_catalog.pg_backend_pid() AS pid, ${value} AS value`,
		)) as Rows;
		seen.push(Number(row?.pid));
		return { pid: Number(row?.pid), value: String(row?.value) };
	} finally {
		await second.close();
	}
}

interface Verdict {
	operations: string;
	data: "pass" | "fail";
	temp: "pass" | "fail" | "none";
	app: "pass" | "fail";
	pid: "pass" | "fail";
	pidBefore: number;
	pidAfter: number;
	leftValue: string;
	admin: string;
}

async function runCase(spec: CaseSpec): Promise<void> {
	const tables = caseTables();
	const verdict: Verdict = {
		operations: "pass",
		data: "fail",
		temp: spec.temporaryTable ? "fail" : "none",
		app: "fail",
		pid: "fail",
		pidBefore: 0,
		pidAfter: 0,
		leftValue: "",
		admin: "none",
	};
	let failure: { operation: string; error: unknown } | undefined;
	let harness: LeftClient | undefined;
	const seen: number[] = [];
	// What a throw below interrupted: the test's own left statement, or its read of the store's tables.
	let stage = "left_setting";
	try {
		const db = needAdmin();
		const setting = leftSetting(spec, tables);
		const client = leftClient({
			url: STORE,
			max: LEG === "direct" ? 1 : 2,
			entry: spec.setting.name,
			left: () => setting,
		});
		harness = client;
		records.push(client.record);
		const primed = await within(client.prime(), READ_BOUND_MS, "the left statement");
		const before =
			LEG === "direct" ? { pid: primed.pid, value: primed.value } : await secondClientRead(setting.value, seen);
		verdict.pidBefore = before.pid;
		if (LEG === "pooled") verdict.leftValue = before.value;

		stage = "operations";
		const run = await runOperations(client, tables);
		failure = run.failure;
		verdict.operations = failure ? `fail:${failure.operation}` : "pass";
		verdict.app = run.app === PG_APPLICATION_NAME ? "pass" : "fail";
		// What the operations reported, read before the settling below gives back a claim a failed list left.
		stage = "admin_read";
		const data = await adminCompare(db, tables, run.model);
		verdict.data = data.pass ? "pass" : "fail";
		verdict.admin = data.summary;
		await settle(run.stores);

		const temporaryTable = spec.temporaryTable ? temporaryTableName(tables, spec.temporaryTable) : undefined;
		const after = await within(client.readAfter(setting, temporaryTable), READ_BOUND_MS, "the after-case read").catch(
			(err: unknown) => {
				failure ??= { operation: "after_read", error: err };
				return undefined;
			},
		);
		if (temporaryTable !== undefined) verdict.temp = after?.rows === 0 ? "pass" : "fail";
		if (LEG === "direct") {
			verdict.pidAfter = after?.pid ?? 0;
			verdict.leftValue = after?.value ?? "";
			verdict.pid =
				after !== undefined && after.pid === primed.pid && after.value === primed.value ? "pass" : "fail";
		} else {
			const second = await secondClientRead(setting.value, seen).catch(() => undefined);
			verdict.pidAfter = second?.pid ?? 0;
			verdict.pid = before.value === primed.value && second?.pid === before.pid ? "pass" : "fail";
		}
	} catch (err) {
		failure ??= { operation: stage, error: err };
		if (stage === "left_setting") verdict.operations = `fail:${stage}`;
	} finally {
		console.log(
			`left-setting case leg=${LEG} entry=${spec.label} operations=${verdict.operations} data=${verdict.data} ` +
				`temp=${verdict.temp} app=${verdict.app} pid=${verdict.pid} pid_before=${verdict.pidBefore} ` +
				`pid_after=${verdict.pidAfter} left_value=${JSON.stringify(verdict.leftValue)} admin=${verdict.admin}`,
		);
		if (failure) {
			console.log(
				`left-setting failure leg=${LEG} entry=${spec.label} operation=${failure.operation} ` +
					`error=${JSON.stringify(errorText(failure.error))}`,
			);
		}
		await harness?.end().catch(() => undefined);
		if (LEG === "pooled") await terminate([...(harness?.record.pids ?? []), ...seen]);
		await dropTables(tables);
	}
	expect({
		operations: verdict.operations,
		data: verdict.data,
		temp: verdict.temp,
		app: verdict.app,
		pid: verdict.pid,
	}).toEqual({
		operations: "pass",
		data: "pass",
		temp: spec.temporaryTable ? "pass" : "none",
		app: "pass",
		pid: "pass",
	});
}

/** The repairless warnings among `calls` (a spy's on `logger.warn`), with the fields the store gives them. */
function repairWarnings(
	calls: ReadonlyArray<readonly [string, Record<string, unknown>?]>,
): Array<Record<string, unknown>> {
	return calls
		.filter(([message]) => message === REPAIR_WARNING)
		.map(([, fields]) => ({
			operation: fields?.operation,
			sqlstate: fields?.sqlstate,
			message: fields?.message,
			attempt: fields?.attempt,
		}));
}

async function adminTitle(db: SQL, tables: CaseTables, file: string): Promise<unknown> {
	const [row] = (await db.unsafe(`SELECT title FROM public.${tables.table} WHERE path = $1`, [file])) as Rows;
	return row?.title;
}

/**
 * The store's client logs in as the superuser (the admin URL); the client
 * leaves `SET SESSION AUTHORIZATION` to the store's login on the first
 * backend, where the store opens and writes a session, and on each later
 * backend to the role without rights while `repairless(ordinal)` holds, else
 * to the store's login. `expectOutcome` gets the title update's error, if any.
 */
async function repairlessCase(
	label: string,
	repairless: (ordinal: number) => boolean,
	expectOutcome: (outcome: {
		error: unknown;
		harness: LeftClient;
		warnings: Array<Record<string, unknown>>;
	}) => Promise<void>,
): Promise<void> {
	const db = needAdmin();
	const norights = need("role without rights");
	const login = needServer().login;
	const tables = caseTables();
	const harness = leftClient({
		url: ADMIN,
		max: 1,
		entry: label,
		left: ordinal => authorization(ordinal > 1 && repairless(ordinal) ? norights : login),
	});
	records.push(harness.record);
	const warn = vi.spyOn(logger, "warn");
	try {
		await harness.prime();
		const storage = await SqlSessionStorage.create(storeOptions(harness.client, tables));
		const file = path.join(root?.path() ?? os.tmpdir(), tables.table, "repairless.jsonl");
		await storage.writeText(file, transcript(crypto.randomUUID(), "before the title"));
		await harness.retire();
		warn.mockClear();
		const error = await storage.updateSessionTitle(file, TITLE).then(
			() => undefined,
			(err: unknown) => err ?? new Error("rejected"),
		);
		await expectOutcome({ error, harness, warnings: repairWarnings(warn.mock.calls) });
		if (error === undefined) expect(await adminTitle(db, tables, file)).toBe(TITLE.title);
		await settle([storage]);
	} finally {
		warn.mockRestore();
		await harness.end();
		await dropTables(tables);
	}
}

/** A store opened on a clean pool, with one session written, for the pooled close cases. */
async function openOnPool(url: string, label: string, tables: CaseTables) {
	const harness = leftClient({ url, max: 2, entry: label });
	const storage = await SqlSessionStorage.create(storeOptions(harness.client, tables));
	const file = path.join(root?.path() ?? os.tmpdir(), tables.table, "pooled.jsonl");
	await storage.writeText(file, transcript(crypto.randomUUID(), "before the title"));
	return { harness, storage, file };
}

/** The size of the server log, in bytes. */
async function logSize(db: SQL): Promise<number> {
	return Number(((await db.unsafe(`SELECT size FROM pg_catalog.pg_stat_file('${LOG_FILE}')`)) as Rows)[0]?.size);
}

/** Read the server log from `start`, keeping only the lines of `keep`'s backends and the lines that continue them. */
async function readServerLog(db: SQL, start: number, keep: ReadonlySet<number>): Promise<string> {
	// The logging collector writes a moment after the backend, and announces nothing: watch the size settle.
	let end = await logSize(db);
	for (let look = 0; look < 10; look++) {
		await Bun.sleep(500);
		const next = await logSize(db);
		if (next === end) break;
		end = next;
	}
	const kept: string[] = [];
	let keeping = false;
	const take = (text: string) => {
		for (const line of text.split("\n")) {
			if (!line.startsWith("\t")) {
				const pid = / pid=(\d+) /.exec(line)?.[1];
				keeping = pid !== undefined && keep.has(Number(pid));
			}
			if (keeping) kept.push(line);
		}
	};
	let carry = Buffer.alloc(0);
	for (let offset = start; offset < end;) {
		const [row] = (await db.unsafe(
			`SELECT pg_catalog.pg_read_binary_file('${LOG_FILE}', $1::bigint, $2::bigint) AS chunk`,
			[offset, Math.min(LOG_CHUNK_BYTES, end - offset)],
		)) as Rows;
		const chunk = Buffer.from(row?.chunk as Uint8Array);
		if (chunk.length === 0) break;
		offset += chunk.length;
		const bytes = Buffer.concat([carry, chunk]);
		const cut = bytes.lastIndexOf(10) + 1;
		carry = Buffer.from(bytes.subarray(cut));
		take(bytes.subarray(0, cut).toString("utf8"));
	}
	if (carry.length > 0) take(carry.toString("utf8"));
	return kept.join("\n");
}

describe("SQL session store under a session setting another client left on PostgreSQL", () => {
	describe.skipIf(!STORE_URL)(`the ${LEG} leg`, () => {
		beforeAll(async () => {
			if (!ADMIN_URL || !server) return;
			admin = new SQL(ADMIN_URL, { max: 4 });
			const db = admin;
			originalAgentDir = getAgentDir();
			agentDir = TempDir.createSync("@omp-left-setting-agent-");
			setAgentDir(agentDir.path());
			root = TempDir.createSync("@omp-left-setting-");
			await make("role without rights", async () => {
				await db.unsafe(`CREATE ROLE ${identifier(NORIGHTS_ROLE)} NOLOGIN`);
				await db.unsafe(`GRANT ${identifier(NORIGHTS_ROLE)} TO ${identifier(server.login)}`);
				return NORIGHTS_ROLE;
			});
			if (LEG !== "direct") return;
			// The two read-only cases log in with every right the store's login has, so only the read-only default
			// can stop the store's write: without the store's refusal its tables would land.
			await make("read-only login", async () => {
				await db.unsafe(`CREATE ROLE ${identifier(READ_ONLY_LOGIN)} LOGIN`);
				// It inherits every right of the store's login, so it may create the store's tables where that login
				// may: in a database that login owns, through pg_database_owner, which owns `public`.
				await db.unsafe(`GRANT ${identifier(server.login)} TO ${identifier(READ_ONLY_LOGIN)} WITH INHERIT TRUE`);
				await db.unsafe(`ALTER ROLE ${identifier(READ_ONLY_LOGIN)} SET default_transaction_read_only = on`);
				return READ_ONLY_LOGIN;
			});
			await make("read-only database", async () => {
				// Owned by the store's login, which may then create its tables in its `public`.
				await db.unsafe(`CREATE DATABASE ${identifier(READ_ONLY_DATABASE)} OWNER ${identifier(server.login)}`);
				await db.unsafe(`ALTER DATABASE ${identifier(READ_ONLY_DATABASE)} SET default_transaction_read_only = on`);
				return READ_ONLY_DATABASE;
			});
			await make("server log offset", async () => String(await logSize(db)));
		});

		afterAll(async () => {
			const db = admin;
			if (db) {
				for (const tables of madeTables) await dropTables(tables);
				if (made.has("read-only database")) {
					await db
						.unsafe(`DROP DATABASE IF EXISTS ${identifier(READ_ONLY_DATABASE)} WITH (FORCE)`)
						.catch(() => undefined);
				}
				// The case tables dropped above include any the read-only login made, so it owns nothing; DROP ROLE
				// also revokes its membership in the store's login.
				for (const role of [READ_ONLY_LOGIN, NORIGHTS_ROLE]) {
					await db.unsafe(`DROP ROLE IF EXISTS ${identifier(role)}`).catch(() => undefined);
				}
				await db.close();
			}
			if (originalAgentDir !== undefined) setAgentDir(originalAgentDir);
			agentDir?.removeSync();
			root?.removeSync();
			console.log(`left-setting leg=${LEG} cases=${CASES.length}`);
		});

		test("the admin URL is set, and every user setting of the server is listed", () => {
			const unset = [
				...(ADMIN_URL ? [] : ["OMP_TEST_SQL_POSTGRES_ADMIN_URL"]),
				...(LEG === "pooled" && !POOL4_URL ? ["OMP_TEST_SQL_POSTGRES_POOL4_URL"] : []),
			];
			if (unset.length > 0) throw new Error(`left-setting: set ${unset.join(" and ")}`);
			const listed = new Set(PG_SESSION_SETTINGS.map(setting => setting.name));
			const unlisted = (server?.userNames ?? []).filter(name => !listed.has(name));
			if (unlisted.length > 0) throw new Error(`left-setting: PG_SESSION_SETTINGS lacks ${unlisted.join(", ")}`);
		});

		for (const spec of CASES) test(`case ${spec.label}`, () => runCase(spec), CASE_TIMEOUT_MS);

		if (LEG === "direct") {
			const readOnlyDefault = async (
				label: string,
				url: (store: string) => string,
				adminDatabase: string | undefined,
			) => {
				const db = needAdmin();
				const tables = caseTables();
				const harness = leftClient({ url: url(STORE), max: 1, entry: label });
				records.push(harness.record);
				const look = adminDatabase
					? new SQL(
							withUrl(ADMIN, parsed => {
								parsed.pathname = `/${adminDatabase}`;
							}),
							{ max: 1 },
						)
					: db;
				try {
					const error = await rejection(SqlSessionStorage.create(storeOptions(harness.client, tables)));
					expect(errorText(error)).toContain("keeps a read-only default");
					expect(await presentTables(look, tables)).toEqual([]);
					expect(harness.record.closes).toEqual([]);
				} finally {
					await harness.end();
					if (look !== db) await look.close();
					await dropTables(tables);
				}
			};

			test(
				READ_ONLY_LOGIN_CASE,
				async () => {
					const login = need("read-only login");
					await readOnlyDefault(
						READ_ONLY_LOGIN_CASE,
						store =>
							withUrl(store, parsed => {
								parsed.username = encodeURIComponent(login);
								parsed.password = "";
							}),
						undefined,
					);
				},
				CASE_TIMEOUT_MS,
			);

			test(
				READ_ONLY_DATABASE_CASE,
				async () => {
					const database = need("read-only database");
					await readOnlyDefault(
						READ_ONLY_DATABASE_CASE,
						store =>
							withUrl(store, parsed => {
								parsed.pathname = `/${database}`;
							}),
						database,
					);
				},
				CASE_TIMEOUT_MS,
			);

			test(
				`${REPAIRLESS_THEN_CLEAN_CASE}: the title update succeeds after ${PG_REPAIR_RETRIES} closes`,
				() =>
					repairlessCase(
						REPAIRLESS_THEN_CLEAN_CASE,
						ordinal => ordinal <= PG_REPAIR_RETRIES + 1,
						async ({ error, harness, warnings }) => {
							expect(error).toBeUndefined();
							const closes = harness.record.closes;
							expect(closes.map(close => close.error?.errno)).toEqual(Array(PG_REPAIR_RETRIES).fill("42501"));
							expect(warnings).toEqual(
								closes.map((close, index) => ({
									operation: "updateSessionTitle",
									sqlstate: "42501",
									message: close.error?.message,
									attempt: index + 1,
								})),
							);
						},
					),
				CASE_TIMEOUT_MS,
			);

			test(
				`${ONLY_REPAIRLESS_CASE}: the title update fails with 42501 after ${PG_REPAIR_RETRIES + 1} closes`,
				() =>
					repairlessCase(
						ONLY_REPAIRLESS_CASE,
						() => true,
						async ({ error, harness, warnings }) => {
							expect(leftError(error).errno).toBe("42501");
							const closes = harness.record.closes;
							expect(closes.map(close => close.error?.errno)).toEqual(
								Array(PG_REPAIR_RETRIES + 1).fill("42501"),
							);
							expect(warnings).toEqual(
								closes.map((close, index) => ({
									operation: "updateSessionTitle",
									sqlstate: "42501",
									message: close.error?.message,
									attempt: index + 1,
								})),
							);
						},
					),
				CASE_TIMEOUT_MS,
			);

			test(
				`${NO_RESERVE_CASE}: the open fails naming reserve()`,
				async () => {
					needAdmin();
					const tables = caseTables();
					const harness = leftClient({ url: STORE, max: 1, entry: NO_RESERVE_CASE, reserve: false });
					records.push(harness.record);
					try {
						const error = await rejection(SqlSessionStorage.create(storeOptions(harness.client, tables)));
						expect(errorText(error)).toContain("reserve()");
					} finally {
						await harness.end();
						await dropTables(tables);
					}
				},
				CASE_TIMEOUT_MS,
			);

			test(
				"the server log: a line for each statement the store sent, each an opening, COMMIT, ROLLBACK, the test's own or app=omp-session-store",
				async () => {
					const db = needAdmin();
					const start = Number(need("server log offset"));
					const pids = logPids(records);
					const log = await within(
						readServerLog(db, start, new Set(pids.keys())),
						CASE_TIMEOUT_MS / 2,
						"the log read",
					);
					const names = needServer().names;
					const write = pgOpening("write", names);
					const read = pgOpening("read", names);
					// The open's first transaction, the probe, sends the read opening with no conditional statement.
					const verdict = checkServerLog(log, pids, [write, read, pgOpening("read", new Set())], LEFT_MARKER);
					for (const { pid, entry } of verdict.debugPrint) {
						console.log(`left-setting log-rule accepts debug print lines on ${pid} (${entry})`);
					}
					for (const line of verdict.flagged.slice(0, 20)) console.log(`left-setting log-rule flags ${line.line}`);
					expect({ flagged: verdict.flagged.length, counts: verdict.counts.slice(0, 20) }).toEqual({
						flagged: 0,
						counts: [],
					});
					expect(verdict.openings).toEqual(expect.arrayContaining([write, read]));
					const repairless = new Set(
						[...pids]
							.filter(([, { entry }]) => entry === REPAIRLESS_THEN_CLEAN_CASE || entry === ONLY_REPAIRLESS_CASE)
							.map(([pid]) => pid),
					);
					expect(
						verdict.errors.some(
							line => repairless.has(line.pid) && line.code === "42501" && line.app === PG_APPLICATION_NAME,
						),
					).toBe(true);
				},
				CASE_TIMEOUT_MS,
			);
		} else {
			test(
				`${POOL_OF_ONE_CASE}: one close with 42501, that backend gone, the title stored`,
				async () => {
					const db = needAdmin();
					const norights = need("role without rights");
					const tables = caseTables();
					const seen: number[] = [];
					let harness: LeftClient | undefined;
					try {
						const opened = await openOnPool(STORE, POOL_OF_ONE_CASE, tables);
						harness = opened.harness;
						const second = new SQL(STORE, { max: 1 });
						let left: { pid: number; role: string };
						try {
							const results = (await second.unsafe(
								`${LEFT_MARKER} SET SESSION AUTHORIZATION ${identifier(norights)}; ` +
									"SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.current_setting('session_authorization') AS role",
							)) as unknown as Rows[];
							const [row] = results[1] ?? [];
							left = { pid: Number(row?.pid), role: String(row?.role) };
						} finally {
							await second.close();
						}
						seen.push(left.pid);
						expect(left.role).toBe(norights);
						await opened.storage.updateSessionTitle(opened.file, TITLE);
						expect(harness.record.closes.map(close => ({ pid: close.pid, errno: close.error?.errno }))).toEqual([
							{ pid: left.pid, errno: "42501" },
						]);
						await until(() => backendGone(db, left.pid), READ_BOUND_MS, {
							what: `the end of backend ${left.pid}`,
							pollMs: POLL_MS,
						});
						expect(harness.record.releases.length).toBeGreaterThan(0);
						expect(await adminTitle(db, tables, opened.file)).toBe(TITLE.title);
						await settle([opened.storage]);
					} finally {
						await harness?.end();
						await terminate([...(harness?.record.pids ?? []), ...seen]);
						await dropTables(tables);
					}
				},
				CASE_TIMEOUT_MS,
			);

			test(
				`${POOL_OF_FOUR_CASE}: the title stored after at most ${PG_REPAIR_RETRIES} closes, each closed backend gone`,
				async () => {
					const db = needAdmin();
					const norights = need("role without rights");
					if (!POOL4_URL) throw new Error("left-setting: set OMP_TEST_SQL_POSTGRES_POOL4_URL");
					const tables = caseTables();
					const holders: Array<{ sql: SQL; connection: ReservedSQL; pid: number }> = [];
					let harness: LeftClient | undefined;
					try {
						const opened = await openOnPool(POOL4_URL, POOL_OF_FOUR_CASE, tables);
						harness = opened.harness;
						// Four clients each hold a server connection in a transaction; three leave the authorization on theirs.
						for (let index = 0; index < 4; index++) {
							const sql = new SQL(POOL4_URL, { max: 1 });
							const connection = await sql.reserve();
							await connection.unsafe(`${LEFT_MARKER} BEGIN`);
							const [row] = (await connection.unsafe(
								`${LEFT_MARKER} SELECT pg_catalog.pg_backend_pid() AS pid`,
							)) as Rows;
							holders.push({ sql, connection, pid: Number(row?.pid) });
						}
						expect(new Set(holders.map(holder => holder.pid)).size).toBe(4);
						for (const holder of holders.slice(1)) {
							const results = (await holder.connection.unsafe(
								`${LEFT_MARKER} SET SESSION AUTHORIZATION ${identifier(norights)}; ` +
									"SELECT pg_catalog.current_setting('session_authorization') AS role",
							)) as unknown as Rows[];
							expect(String(results[1]?.[0]?.role)).toBe(norights);
						}
						// The clean one goes back first, so PgBouncer (server_round_robin = 0) hands out the three left ones first.
						for (const holder of holders) await holder.connection.unsafe(`${LEFT_MARKER} COMMIT`);
						await opened.storage.updateSessionTitle(opened.file, TITLE);
						const closes = harness.record.closes;
						expect(closes.length).toBeLessThanOrEqual(PG_REPAIR_RETRIES);
						expect(closes.map(close => close.error?.errno)).toEqual(Array(closes.length).fill("42501"));
						for (const close of closes) {
							await until(() => backendGone(db, close.pid), READ_BOUND_MS, {
								what: `the end of backend ${close.pid}`,
								pollMs: POLL_MS,
							});
						}
						expect(await adminTitle(db, tables, opened.file)).toBe(TITLE.title);
						await settle([opened.storage]);
					} finally {
						for (const holder of holders) {
							holder.connection.release();
							await holder.sql.close({ timeout: 0 }).catch(() => undefined);
						}
						await harness?.end();
						await terminate([...(harness?.record.pids ?? []), ...holders.map(holder => holder.pid)]);
						await dropTables(tables);
					}
				},
				CASE_TIMEOUT_MS,
			);
		}
	});

	describe("the server-log rule", () => {
		const fixture = path.join(import.meta.dir, "fixtures", "postgres-settings", "pg16-statement-log.txt");
		const FIXTURE_MARKER = "/* left-setting-test */";

		const load = async () => {
			const log = await Bun.file(fixture).text();
			const openings = [...log.matchAll(/ statement: (BEGIN ISOLATION LEVEL .*)$/gm)].map(match => match[1] ?? "");
			const lineOf = (pattern: RegExp) => log.split("\n").find(line => pattern.test(line)) ?? "";
			return { log, openings, lineOf };
		};
		/** `log` with `records` put right after pid 46's opening line. */
		const afterOpening = (log: string, records: readonly string[]) => {
			const physical = log.split("\n");
			const opening = physical.findIndex(line => line.includes("pid=46 ") && line.includes(" statement: BEGIN"));
			return [...physical.slice(0, opening + 1), ...records, ...physical.slice(opening + 1)].join("\n");
		};
		/** Pid 46 as a store backend of a case of `entry`, with the fixture's other store backends. */
		const storePids = (entry: string) =>
			new Map([
				[46, { messages: 3, entry }],
				[52, { messages: 2 }],
				[64, { messages: 2 }],
				[70, { messages: 0 }],
			]);
		const debugLog = "2026-11-20 03:36:19.267 UTC pid=46 app=psql code=00000 LOG:  parse tree:";
		const debugDetail =
			"2026-11-20 03:36:19.267 UTC pid=46 app=[unknown] code=00000 DETAIL:     {QUERY \n" +
			"\t   :commandType 5 \n" +
			"\t   }";
		const debugStatement = (openings: readonly string[]) =>
			`2026-11-20 03:36:19.267 UTC pid=46 app=[unknown] code=00000 STATEMENT:  ${openings[0]}`;

		test("passes every line of the store's backends in the captured log, and their counts", async () => {
			const { log, openings } = await load();
			expect(openings).toHaveLength(4);
			const pids = new Map([
				[46, { messages: 3 }],
				[52, { messages: 2 }],
				[64, { messages: 2 }],
				[70, { messages: 0 }],
			]);
			const verdict = checkServerLog(log, pids, openings, FIXTURE_MARKER);
			expect(verdict.flagged).toEqual([]);
			expect(verdict.counts).toEqual([]);
			expect(verdict.openings).toEqual([openings[0], openings[1], openings[3]]);
			expect(verdict.errors.map(line => [line.pid, line.code, line.app])).toEqual([
				[64, "42704", PG_APPLICATION_NAME],
			]);
		});

		test("flags another client's statement and a FATAL on store backends, and a count short of the lines", async () => {
			const { log, openings, lineOf } = await load();
			const pids = new Map([
				[46, { messages: 3 }],
				[52, { messages: 2 }],
				[58, { messages: 3 }],
				[64, { messages: 2 }],
				[70, { messages: 0 }],
				[78, { messages: 1 }],
			]);
			const verdict = checkServerLog(log, pids, openings, FIXTURE_MARKER);
			expect(verdict.flagged.map(line => line.line)).toEqual([
				lineOf(/pid=58 .*statement: SET SESSION AUTHORIZATION/),
				lineOf(/pid=78 .*statement: SET idle_session_timeout/),
				lineOf(/pid=78 .*FATAL:/),
			]);
			expect(verdict.counts).toEqual([{ pid: 58, lines: 4, messages: 3 }]);
		});

		test("flags a backend whose lines do not number the messages sent to it", async () => {
			const { log, openings } = await load();
			const pids = new Map([
				[46, { messages: 2 }],
				[52, { messages: 2 }],
				[64, { messages: 2 }],
				[70, { messages: 0 }],
			]);
			const verdict = checkServerLog(log, pids, openings, FIXTURE_MARKER);
			expect(verdict.flagged).toEqual([]);
			expect(verdict.counts).toEqual([{ pid: 46, lines: 3, messages: 2 }]);
		});

		test("accepts a parse tree line only on a backend of a debug print case", async () => {
			const { log, openings } = await load();
			const records = [debugLog, debugDetail, debugStatement(openings)];
			const withTree = afterOpening(log, records);

			const elsewhere = checkServerLog(withTree, storePids("statement_timeout"), openings, FIXTURE_MARKER);
			expect(elsewhere.flagged.map(line => line.line)).toEqual(records);
			expect(elsewhere.debugPrint).toEqual([]);
			expect(elsewhere.counts).toEqual([]);

			const debugPrint = checkServerLog(withTree, storePids("debug_print_parse"), openings, FIXTURE_MARKER);
			expect(debugPrint.flagged).toEqual([]);
			expect(debugPrint.debugPrint).toEqual([{ pid: 46, entry: "debug_print_parse" }]);
			expect(debugPrint.counts).toEqual([]);
		});

		test("flags a STATEMENT record on a debug print backend that no accepted debug print LOG record directly precedes", async () => {
			const { log, openings, lineOf } = await load();
			const statement = debugStatement(openings);

			const alone = checkServerLog(
				afterOpening(log, [statement]),
				storePids("debug_print_parse"),
				openings,
				FIXTURE_MARKER,
			);
			expect(alone.flagged.map(line => line.line)).toEqual([statement]);
			expect(alone.debugPrint).toEqual([]);
			expect(alone.counts).toEqual([]);

			// Another record of the same backend between the debug print and the STATEMENT ends what follows it.
			const execute = lineOf(/pid=46 .* execute /);
			const physical = afterOpening(log, [debugLog, debugDetail]).split("\n");
			const at = physical.indexOf(execute);
			const broken = [...physical.slice(0, at + 1), statement, ...physical.slice(at + 1)].join("\n");
			const after = checkServerLog(broken, storePids("debug_print_parse"), openings, FIXTURE_MARKER);
			expect(after.flagged.map(line => line.line)).toEqual([statement]);
			expect(after.debugPrint).toEqual([{ pid: 46, entry: "debug_print_parse" }]);
			expect(after.counts).toEqual([]);
		});
	});
});
