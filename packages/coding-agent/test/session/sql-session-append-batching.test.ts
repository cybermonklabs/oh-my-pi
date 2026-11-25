/**
 * SQL session storage sends the transcript lines a path queues behind an
 * append in flight to the database together: one transaction checks the size
 * once and stores them all, as parts of at most 1 MiB, with no string past
 * 16 MiB. A batch whose transaction rolled back runs again one transaction a
 * line, each line taking the outcome it would have had alone; a batch whose
 * COMMIT may have landed is not sent again.
 *
 * Runs on SQLite always, on PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL` names
 * a throwaway database, and on MySQL when `OMP_TEST_SQL_MYSQL_URL` does.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type {
	SqlSessionStorage,
	SqlSessionStorageClient,
	SqlSessionStorageResult,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { byteSize, Longest } from "../helpers/longest-value";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, transcript } from "./sql-session-lease-fixture";

const MiB = 1024 * 1024;
/** The largest part SQL storage stores for a batch of appends. */
const PART_BYTES = MiB;
/** No statement text or bound value may reach past this. */
const STRING_BOUND = 16 * MiB;
const ID = "5f0c9a3e-7b21-4d8e-9c64-2a1b3d4e5f60";
const TIMESTAMP = "2026-11-23T00:00:00.000Z";
const TIMEOUT = 120_000;

/** One write transaction the store ran through the test's client. */
interface TransactionRecord {
	readonly statements: string[];
	/** Every value bound to its statements, including the statement a hook failed. */
	readonly values: unknown[];
	committed: boolean;
}

/**
 * The store's client as the test sees it: each transaction recorded, the
 * longest statement text and bound value noted, and hooks that run before a
 * statement of a transaction (a throw fails it unsent), just before a
 * transaction's COMMIT (it stays open until the hook settles), and once its
 * COMMIT landed (a throw reports the COMMIT failed, as a connection lost right
 * after it would). On SQLite the store sends `BEGIN IMMEDIATE` and `COMMIT`
 * itself; on PostgreSQL and MySQL `transaction()` sends them.
 */
class TestClient {
	readonly transactions: TransactionRecord[] = [];
	readonly longest = new Longest();
	beforeStatement: ((query: string, values: readonly unknown[]) => void) | undefined;
	beforeCommit: ((record: TransactionRecord) => Promise<void>) | undefined;
	afterCommit: ((record: TransactionRecord) => Promise<void>) | undefined;
	#sqliteOpen: TransactionRecord | undefined;

	wrap(client: SqlSessionStorageClient): SqlSessionStorageClient {
		const note = (query: string, values: readonly unknown[]): void => {
			this.longest.note(byteSize(query), "the text of a statement");
			for (const value of values) this.longest.note(byteSize(value), "a value bound to a statement");
		};
		const inTransaction = async (
			executor: SqlSessionStorageTransaction,
			record: TransactionRecord,
			query: string,
			values: unknown[] | undefined,
		): Promise<SqlSessionStorageResult> => {
			note(query, values ?? []);
			record.statements.push(query);
			record.values.push(...(values ?? []));
			this.beforeStatement?.(query, values ?? []);
			return executor.unsafe(query, values);
		};
		const begin = (): TransactionRecord => {
			const record: TransactionRecord = { statements: [], values: [], committed: false };
			this.transactions.push(record);
			return record;
		};
		return {
			options: client.options,
			unsafe: async (query, values) => {
				const open = this.#sqliteOpen;
				if (query === "BEGIN IMMEDIATE") {
					this.#sqliteOpen = begin();
				} else if (open && query === "COMMIT") {
					await this.beforeCommit?.(open);
					const result = await client.unsafe(query, values);
					open.committed = true;
					this.#sqliteOpen = undefined;
					await this.afterCommit?.(open);
					return result;
				} else if (open && query === "ROLLBACK") {
					this.#sqliteOpen = undefined;
				} else if (open) {
					return inTransaction(client, open, query, values);
				}
				note(query, values ?? []);
				return client.unsafe(query, values);
			},
			transaction: async callback => {
				const record = begin();
				await client.transaction(async transaction => {
					await callback({ unsafe: (query, values) => inTransaction(transaction, record, query, values) });
					await this.beforeCommit?.(record);
				});
				record.committed = true;
				await this.afterCommit?.(record);
			},
			end: () => client.end?.() ?? Promise.resolve(),
		};
	}
}

/** A transcript line: a user message with `text`. */
function message(id: string, text: string): string {
	return `${JSON.stringify({ type: "message", id, parentId: null, timestamp: TIMESTAMP, message: { role: "user", content: text, timestamp: 0 } })}\n`;
}

/** Whether `record` wrote parts of a session: an append, a batch, or a full write. */
function writesParts(db: LeaseDb, record: TransactionRecord): boolean {
	const insert = new RegExp(`\\bINSERT INTO \\S*\\b${db.table}_parts\\b`);
	return record.statements.some(statement => insert.test(statement));
}

/** Whether `record` read or wrote the session table or its parts, not only the lease table. */
function touchesSession(db: LeaseDb, record: TransactionRecord): boolean {
	const table = new RegExp(`\\b${db.table}(?:_parts)?\\b`);
	return record.statements.some(statement => table.test(statement));
}

/** Which of the lines `ids` names (see {@link message}) `record` bound: whole, or a part that holds its start. */
function carried(record: TransactionRecord, ids: readonly string[]): string[] {
	return ids.filter(id =>
		record.values.some(value => typeof value === "string" && value.includes(`"id":${JSON.stringify(id)}`)),
	);
}

/** Hold the next transaction that writes parts just before its COMMIT; `reached` resolves once it waits there. */
function holdNextPartWrite(db: LeaseDb, client: TestClient): { reached: Promise<void>; release: () => void } {
	const gate = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	let armed = true;
	client.beforeCommit = async record => {
		if (!armed || !writesParts(db, record)) return;
		armed = false;
		reached.resolve();
		await gate.promise;
	};
	return { reached: reached.promise, release: () => gate.resolve() };
}

/** A claimed session through `client`, with its header written. */
async function openSession(
	db: LeaseDb,
	client: TestClient,
): Promise<{ storage: SqlSessionStorage; file: string; header: string; release: () => void }> {
	const storage = await db.open({ wrap: inner => client.wrap(inner) });
	const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-23T00-00-00-000Z_${ID}.jsonl`);
	const release = await storage.acquireSessionClaim?.(ID, file);
	if (!release) throw new Error("the store did not claim the session");
	const header = transcript(ID, "batched appends");
	await storage.writeText(file, header);
	return { storage, file, header, release };
}

/** The byte length of each stored part of `file`. */
async function partBytes(db: LeaseDb, file: string): Promise<number[]> {
	const parts = await db.sql(`SELECT content FROM ${db.table}_parts WHERE path = @1 ORDER BY start_offset`, [file]);
	return parts.map(part => Buffer.byteLength(String(part.content)));
}

/**
 * Append, as another writer that claims nothing (an older omp) does: grow the
 * row and add a part, through the fixture's own client, outside the store.
 */
async function foreignAppend(db: LeaseDb, file: string, line: string): Promise<void> {
	const [row] = await db.sql(`SELECT byte_len FROM ${db.table} WHERE path = @1`, [file]);
	await db.sql(`INSERT INTO ${db.table}_parts (path, start_offset, content) VALUES (@1, @2, @3)`, [
		file,
		Number(row?.byte_len),
		line,
	]);
	await db.sql(`UPDATE ${db.table} SET byte_len = byte_len + @1 WHERE path = @2`, [Buffer.byteLength(line), file]);
}

/** What `promise` settled as: fulfilled, or the error it rejected with. */
function outcome(promise: Promise<unknown>): Promise<{ ok: true } | { error: unknown }> {
	return promise.then(
		() => ({ ok: true }) as const,
		(error: unknown) => ({ error }),
	);
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`SQL session storage appends a path's queued lines together (${adapter})`, () => {
		it(
			"appends a path's queued lines in one transaction, in order, and settles each line with its batch",
			async () => {
				// If this regresses, a busy session sends each transcript line in its own transaction, so ten
				// subagents' lines outrun the connection pool and pile up in memory; or a batch stores a part,
				// or builds a string, as long as everything it carries.
				await using db = await openLeaseDb(adapter, url ?? "");
				const client = new TestClient();
				const { storage, file, header, release } = await openSession(db, client);
				try {
					const writer = storage.openWriter(file);
					const mark = client.transactions.length;
					const commits = () =>
						client.transactions.slice(mark).filter(record => record.committed && writesParts(db, record)).length;
					const held = holdNextPartWrite(db, client);
					const first = message("first", "the line in flight");
					const settledAt: number[] = [];
					const appends = [writer.append(first).then(() => settledAt.push(commits()))];
					await held.reached;
					// Queued while the first line's transaction runs: about 17 MiB of ~100 KiB lines of one-,
					// three- and four-byte characters, and in the middle one of 3 MiB, longer than a part.
					const queued: string[] = [];
					for (let n = 0; n < 170; n++) {
						if (n === 85) queued.push(message("long", "€😀".repeat(Math.ceil((3 * MiB) / 7))));
						queued.push(message(`m${n}`, `${n} ${"a€😀b".repeat(11_000 + n)}`));
					}
					for (const line of queued) appends.push(writer.append(line).then(() => settledAt.push(commits())));
					held.release();
					await Promise.all(appends);
					await writer.close();

					const parts = await partBytes(db, file);
					expect({
						commits: commits(),
						settledAt,
						partsWithinPartBytes: Math.max(...parts) <= PART_BYTES,
						longestString: client.longest.bytes <= STRING_BOUND ? "bounded" : client.longest.what,
					}).toEqual({
						// The first line alone, then every line queued behind it in one transaction.
						commits: 2,
						settledAt: [1, ...queued.map(() => 2)],
						partsWithinPartBytes: true,
						longestString: "bounded",
					});
					const body = header + first + queued.join("");
					expect(Buffer.byteLength(body)).toBeGreaterThan(STRING_BOUND);
					const reader = await db.open({ claims: false });
					const read = await reader.readText(file);
					expect({ bytes: Buffer.byteLength(read), sha256: sha256(read) }).toEqual({
						bytes: Buffer.byteLength(body),
						sha256: sha256(body),
					});
					expect(storage.statSync(file).size).toBe(Buffer.byteLength(body));
				} finally {
					release();
				}
			},
			TIMEOUT,
		);

		it(
			"runs a failed batch's lines again one transaction each, so the lines before a failing size check commit and the lines after it fail as they did",
			async () => {
				// If this regresses, one failed statement loses every line of a batch that would have landed
				// alone, or lands lines behind a size check that refused the line before them, mixing this
				// session's lines into another writer's.
				await using db = await openLeaseDb(adapter, url ?? "");
				const client = new TestClient();
				const { storage, file, header, release } = await openSession(db, client);
				try {
					const writer = storage.openWriter(file);
					const mark = client.transactions.length;
					const lines = {
						zero: message("zero", "the line in flight"),
						one: message("one", "first queued line"),
						two: message("two", "second queued line"),
						three: message("three", "third queued line"),
					};
					const foreign = message("foreign", "a line another writer appended");
					const held = holdNextPartWrite(db, client);
					const zero = writer.append(lines.zero);
					await held.reached;
					// The batch's part insert fails, unsent, after its row grew: the transaction rolls back.
					const batched = lines.one + lines.two + lines.three;
					client.beforeStatement = (_query, values) => {
						if (!values.includes(batched)) return;
						client.beforeStatement = undefined;
						throw new Error("canceling statement due to statement timeout");
					};
					// Once the first line committed again, alone, another writer appends: the second line's size
					// check, and so the second line, fails.
					client.afterCommit = async record => {
						if (!record.values.includes(lines.one)) return;
						client.afterCommit = undefined;
						await foreignAppend(db, file, foreign);
					};
					const queued = [lines.one, lines.two, lines.three].map(line => outcome(writer.append(line)));
					held.release();
					await zero;
					const [one, two, three] = await Promise.all(queued);

					const conflict = two && "error" in two ? two.error : undefined;
					expect({
						one,
						two: conflict instanceof SessionWriteConflictError,
						three: three && "error" in three && three.error === conflict,
						writerError: writer.getError() === conflict,
					}).toEqual({ one: { ok: true }, two: true, three: true, writerError: true });
					expect(
						client.transactions
							.slice(mark)
							.filter(record => touchesSession(db, record))
							.map(record => ({ committed: record.committed, lines: carried(record, Object.keys(lines)) })),
					).toEqual([
						{ committed: true, lines: ["zero"] },
						{ committed: false, lines: ["one", "two", "three"] },
						{ committed: true, lines: ["one"] },
						// Refused at its size check, before it bound its line; the third line sends nothing.
						{ committed: false, lines: [] },
					]);
					const stored = header + lines.zero + lines.one + foreign;
					expect({ row: await db.row(file), indexed: storage.statSync(file).size }).toEqual({
						row: { content: stored, byteLen: Buffer.byteLength(stored), title: null },
						// The index ends where failed appends leave it: after the last line this store stored.
						indexed: Buffer.byteLength(header + lines.zero + lines.one),
					});
				} finally {
					release();
					await storage.drain().catch(() => undefined);
				}
			},
			TIMEOUT,
		);

		it(
			"fails a batch whose COMMIT outcome is unknown without replaying its lines",
			async () => {
				// If this regresses, a batch whose connection dropped as it committed is sent again, and a
				// store that does not check sizes appends its lines twice; or such a batch stores a part past
				// 1 MiB.
				await using db = await openLeaseDb(adapter, url ?? "");
				const client = new TestClient();
				const { storage, file, header, release } = await openSession(db, client);
				try {
					const writer = storage.openWriter(file);
					const mark = client.transactions.length;
					const lines = {
						zero: message("zero", "the line in flight"),
						one: message("one", "first queued line"),
						two: message("two", `a line longer than a part ${"€😀".repeat(Math.ceil((2.5 * MiB) / 7))}`),
						three: message("three", "third queued line"),
					};
					const held = holdNextPartWrite(db, client);
					const zero = writer.append(lines.zero);
					await held.reached;
					// The batch's COMMIT lands, and then its connection is lost: the store cannot tell it landed.
					const commitLost = new Error("Connection closed after COMMIT was sent");
					client.afterCommit = async record => {
						if (!carried(record, ["three"]).length) return;
						client.afterCommit = undefined;
						throw commitLost;
					};
					const queued = [lines.one, lines.two, lines.three].map(line => outcome(writer.append(line)));
					held.release();
					await zero;

					expect(await Promise.all(queued)).toEqual([
						{ error: commitLost },
						{ error: commitLost },
						{ error: commitLost },
					]);
					expect({
						transactions: client.transactions
							.slice(mark)
							.filter(record => touchesSession(db, record))
							.map(record => ({ committed: record.committed, lines: carried(record, Object.keys(lines)) })),
						writerError: writer.getError(),
					}).toEqual({
						// No transaction after the batch's: none of its lines runs again.
						transactions: [
							{ committed: true, lines: ["zero"] },
							{ committed: true, lines: ["one", "two", "three"] },
						],
						writerError: commitLost,
					});
					const stored = header + lines.zero + lines.one + lines.two + lines.three;
					const row = await db.row(file);
					expect({
						stored: row?.content === stored,
						byteLen: row?.byteLen,
						partsWithinPartBytes: Math.max(...(await partBytes(db, file))) <= PART_BYTES,
						// Each line failed as a failed append fails: the index rolls back past them.
						indexed: storage.statSync(file).size,
					}).toEqual({
						stored: true,
						byteLen: Buffer.byteLength(stored),
						partsWithinPartBytes: true,
						indexed: Buffer.byteLength(header + lines.zero),
					});
				} finally {
					release();
					await storage.drain().catch(() => undefined);
				}
			},
			TIMEOUT,
		);
	});
}
