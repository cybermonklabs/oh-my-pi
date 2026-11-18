/**
 * What a reader of a SQL-stored session gets back:
 *
 * - A chunked read (`readChunks`) that a full rewrite of the session races
 *   yields the bytes of one body, the old or the new, or fails with
 *   `SessionReadConflictError`; it never hands back a mix of the two, nor
 *   does the streamed load built on it return an entry neither body holds.
 * - `readChunks` reads the same bytes `readText` reads, also for a titled
 *   session whose stored content is shorter than the title slot.
 * - `omp render` of a stored session longer than 16 MiB passes no string or
 *   buffer longer than 16 MiB to or from the storage.
 *
 * Runs on SQLite always, and on PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL`
 * names a throwaway database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runRenderCommand } from "@oh-my-pi/pi-coding-agent/cli/render-cli";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFileStream, parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	defaultSessionStorage,
	SessionReadConflictError,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { raceAfterFirstChunk } from "./chunked-read-race";

type SqlClient = InstanceType<typeof SQL>;

const MiB = 1024 * 1024;
/** No value handed to or returned by the storage, and no query's returned values together, may reach past this. */
const BOUND = 16 * MiB;
/** Size of the rendered transcript: past {@link BOUND}. */
const RENDER_BYTES = 20 * MiB;
const RACE_TIMEOUT = 30_000;
const RENDER_TIMEOUT = 60_000;
const TIMESTAMP = "2026-11-01T00:00:00.000Z";
/** The outcomes a read that a rewrite raced may have. */
const ONE_BODY_OR_CONFLICT = /^(first body|second body|read conflict)$/;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
];

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function byteSize(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof Uint8Array) return value.byteLength;
	return 0;
}

function sessionHeader(id: string, cwd: string): string {
	return `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd })}\n`;
}

/**
 * A session of a header and six custom entries of 600,000 copies of `fill`:
 * two of them with different fills have the same size, and a full write cuts
 * both at the same offsets.
 */
function sameSizeBody(fill: string): string[] {
	return [
		sessionHeader("same-size", "/work"),
		...[0, 1, 2, 3, 4, 5].map(
			n =>
				`${JSON.stringify({ type: "custom", customType: "fill", id: `c${n}`, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(600_000) })}\n`,
		),
	];
}

/** `count` lines of exactly 1 MiB each, `fill` repeated and a newline. */
function mibLines(fill: string, count: number): string[] {
	return Array.from({ length: count }, () => `${fill.repeat(MiB - 1)}\n`);
}

/** `chunks`, with `meanwhile` run once, after the reader took the first chunk and before it gets the next. */
async function* afterFirstChunk(
	chunks: AsyncIterable<Uint8Array>,
	meanwhile: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
	let first = true;
	for await (const chunk of chunks) {
		yield chunk;
		if (first) {
			first = false;
			await meanwhile();
		}
	}
}

/** Which body a raced read returned, or that it failed as a read conflict. */
async function readOutcome(chunks: AsyncIterable<Uint8Array>, first: string[], second: string[]): Promise<string> {
	const read: Uint8Array[] = [];
	try {
		for await (const chunk of chunks) read.push(chunk);
	} catch (err) {
		if (err instanceof SessionReadConflictError) return "read conflict";
		throw err;
	}
	const bytes = Buffer.concat(read);
	const digest = sha256(bytes);
	if (digest === sha256(first.join(""))) return "first body";
	if (digest === sha256(second.join(""))) return "second body";
	return `${bytes.byteLength} bytes that are neither body, and no error`;
}

/** The largest string or buffer an instrumented path saw, in UTF-8 bytes, and what it was. */
class Longest {
	bytes = 0;
	what = "nothing";

	note(bytes: number, what: string): void {
		if (bytes <= this.bytes) return;
		this.bytes = bytes;
		this.what = what;
	}
}

function expectBounded(longest: Longest): void {
	expect({ largest: longest.what, bytes: longest.bytes, bounded: longest.bytes <= BOUND }).toMatchObject({
		bounded: true,
	});
}

/** `client` behind a wrapper that notes every bound value, every returned value, and every query's returned values together. */
function instrument(client: SqlClient, longest: Longest): SqlSessionStorageClient {
	const exec = async (
		executor: SqlSessionStorageTransaction,
		query: string,
		values: unknown[] | undefined,
	): Promise<SqlSessionStorageResult> => {
		for (const value of values ?? []) longest.note(byteSize(value), "a value bound to a statement");
		const rows = await executor.unsafe(query, values);
		let returned = 0;
		for (const row of rows as Array<Record<string, unknown>>) {
			for (const value of Object.values(row)) {
				longest.note(byteSize(value), "a value a statement returned");
				returned += byteSize(value);
			}
		}
		longest.note(returned, "the values one statement returned");
		return rows;
	};
	return {
		options: client.options,
		unsafe: (query, values) => exec(client, query, values),
		transaction: callback =>
			client.transaction(async transaction =>
				callback({ unsafe: (query, values) => exec(transaction, query, values) }),
			),
	};
}

async function* noteChunks(chunks: AsyncIterable<unknown>, longest: Longest, name: string): AsyncGenerator<unknown> {
	for await (const chunk of chunks) {
		longest.note(byteSize(chunk), `a chunk ${name} yielded`);
		yield chunk;
	}
}

/**
 * `storage` behind a proxy that notes every string handed to or returned by
 * its methods, each element of an array argument, the text of a `{ text,
 * size }` result, and each chunk a returned stream yields.
 */
function recordStorage(storage: SqlSessionStorage, longest: Longest): SqlSessionStorage {
	const noteValue = (value: unknown, what: string): void => {
		if (Array.isArray(value)) for (const item of value) longest.note(byteSize(item), `an element of ${what}`);
		else if (typeof value === "object" && value !== null && "text" in value) {
			longest.note(byteSize(value.text), `the text of ${what}`);
		} else longest.note(byteSize(value), what);
	};
	return new Proxy(storage, {
		get(target, key) {
			const member: unknown = Reflect.get(target, key, target);
			if (typeof member !== "function") return member;
			const name = String(key);
			return (...args: unknown[]) => {
				for (const arg of args) noteValue(arg, `an argument of ${name}`);
				const result: unknown = member.apply(target, args);
				if (result instanceof Promise) {
					return result.then((value: unknown) => {
						noteValue(value, `the result of ${name}`);
						return value;
					});
				}
				if (typeof result === "object" && result !== null && Symbol.asyncIterator in result) {
					return noteChunks(result as AsyncIterable<unknown>, longest, name);
				}
				noteValue(result, `the result of ${name}`);
				return result;
			};
		},
	});
}

/**
 * A long compacted session: a title slot, a header, alternating user and
 * assistant messages of about 100 KiB of one-, three- and four-byte
 * characters until `bytes`, a compaction that keeps the last user message
 * on, and a short user message `tail` after it.
 */
function longSession(id: string, cwd: string, bytes: number, tail: string): string[] {
	const lines = [
		serializeTitleSlot({ title: "Long render", source: "user", updatedAt: TIMESTAMP }),
		sessionHeader(id, cwd),
	];
	let total = Buffer.byteLength(lines.join(""));
	let parentId: string | null = null;
	let lastUser = "";
	const push = (entry: Record<string, unknown>): void => {
		const line = `${JSON.stringify({ ...entry, parentId, timestamp: TIMESTAMP })}\n`;
		lines.push(line);
		total += Buffer.byteLength(line);
		parentId = String(entry.id);
	};
	for (let n = 0; total < bytes; n++) {
		const text = `${n} ${"a€😀b".repeat(11_000 + n)}`;
		if (n % 2 === 0) {
			push({ type: "message", id: `m${n}`, message: { role: "user", content: text, timestamp: n } });
			lastUser = `m${n}`;
			continue;
		}
		push({
			type: "message",
			id: `m${n}`,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: USAGE,
				stopReason: "stop",
				timestamp: n,
			},
		});
	}
	push({ type: "compaction", id: "c1", summary: "Earlier turns.", firstKeptEntryId: lastUser, tokensBefore: 1000 });
	push({ type: "message", id: "tail", message: { role: "user", content: tail, timestamp: 1_000_000 } });
	return lines;
}

let tableSeq = 0;

/** One backend's database: a fresh table name, and the cleanup that drops it. */
class Db {
	readonly table = `omp_read_consistency_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly #url: string;
	readonly #dir: TempDir | undefined;
	readonly #others: SqlClient[] = [];

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		url: string,
	) {
		if (adapter === "sqlite") {
			this.#dir = TempDir.createSync("@omp-sql-read-consistency-");
			this.#url = `sqlite:${this.#dir.join("sessions.sqlite")}`;
		} else {
			this.#url = url;
		}
		this.client = new SQL(this.#url);
	}

	open(client: SqlSessionStorageClient = this.client): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client, table: this.table });
	}

	/**
	 * A store of the same database as another process opens one: its own
	 * connection, and on SQLite its own call queue (a client that shows no
	 * file name queues on its own), so its writes run between this process's
	 * statements as another process's do.
	 */
	openElsewhere(): Promise<SqlSessionStorage> {
		const client = new SQL(this.#url);
		this.#others.push(client);
		return this.open({
			options: { adapter: this.adapter },
			unsafe: (query, values) => client.unsafe(query, values),
			transaction: async callback => {
				await client.transaction(async transaction =>
					callback({ unsafe: (query, values) => transaction.unsafe(query, values) }),
				);
			},
		});
	}

	async close(): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		for (const client of this.#others) await client.end();
		await this.client.end();
		this.#dir?.removeSync();
	}
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SQL session reads stay consistent (${adapter})`, () => {
		let db: Db;

		beforeAll(async () => {
			db = new Db(adapter, url ?? "");
			await db.open();
		});

		afterAll(async () => {
			await db?.close();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		// A reader that a rewrite raced and that got no error trusts what it read:
		// a mix of two bodies is a transcript nobody wrote.
		it(
			"a chunked read that a rewrite of the same size races yields one body or fails as a read conflict",
			async () => {
				const file = "/sessions/p/same-size.jsonl";
				const first = sameSizeBody("a");
				const second = sameSizeBody("b");
				expect(Buffer.byteLength(second.join(""))).toBe(Buffer.byteLength(first.join("")));
				const owner = await db.openElsewhere();
				await owner.writeLinesAtomic(file, first, { expectedSize: null });
				const reader = await db.open();

				const outcome = await readOutcome(
					afterFirstChunk(reader.readChunks(file), () =>
						owner.writeLinesAtomic(file, second, { expectedSize: Buffer.byteLength(first.join("")) }),
					),
					first,
					second,
				);
				expect(outcome).toMatch(ONE_BODY_OR_CONFLICT);
			},
			RACE_TIMEOUT,
		);

		it(
			"a chunked read of a session of whole MiB that a rewrite to a longer body races yields one body or fails as a read conflict",
			async () => {
				const file = "/sessions/p/whole-mib.jsonl";
				const first = mibLines("a", 3);
				const second = [...mibLines("b", 4), "tail\n"];
				const owner = await db.openElsewhere();
				await owner.writeLinesAtomic(file, first, { expectedSize: null });
				const reader = await db.open();

				const outcome = await readOutcome(
					afterFirstChunk(reader.readChunks(file), () =>
						owner.writeLinesAtomic(file, second, { expectedSize: 3 * MiB }),
					),
					first,
					second,
				);
				expect(outcome).toMatch(ONE_BODY_OR_CONFLICT);
			},
			RACE_TIMEOUT,
		);

		// A resume or fork that loads entries out of two bodies builds a session
		// from records its transcript never held.
		it(
			"the streamed load of a session that a rewrite of the same size races returns one body's entries or fails as a read conflict",
			async () => {
				const file = "/sessions/p/same-size-load.jsonl";
				const first = sameSizeBody("a");
				const second = sameSizeBody("b");
				const owner = await db.openElsewhere();
				await owner.writeLinesAtomic(file, first, { expectedSize: null });
				const reader = await db.open();
				const entriesOf = (lines: string[]): string[] =>
					parseSessionContent(lines.join("")).entries.map(entry => JSON.stringify(entry));
				const firstEntries = entriesOf(first);
				const secondEntries = entriesOf(second);

				let outcome: string;
				try {
					const loaded = await loadEntriesFromFileStream(file, {
						chunks: afterFirstChunk(reader.readChunks(file), () =>
							owner.writeLinesAtomic(file, second, { expectedSize: Buffer.byteLength(first.join("")) }),
						),
					});
					const entries = loaded.entries.map(entry => JSON.stringify(entry));
					const digest = sha256(entries.join("\n"));
					if (digest === sha256(firstEntries.join("\n"))) outcome = "first body";
					else if (digest === sha256(secondEntries.join("\n"))) outcome = "second body";
					else {
						const known = new Set([...firstEntries, ...secondEntries]);
						outcome = `${entries.length} entries, ${entries.filter(entry => !known.has(entry)).length} of them in neither body`;
					}
				} catch (err) {
					if (!(err instanceof SessionReadConflictError)) throw err;
					outcome = "read conflict";
				}
				expect(outcome).toMatch(ONE_BODY_OR_CONFLICT);
			},
			RACE_TIMEOUT,
		);

		// A read waits only for the writes its own store queued before it began. A
		// full write the same store queues after that (a session compacting while
		// its export, fork or copy reads it) lands between two of the read's pages;
		// a mix of the two bodies would hand the reader a transcript nobody wrote.
		it(
			"a chunked read that its own store's full write, queued after its first chunk, races yields one body or fails as a read conflict",
			async () => {
				const file = "/sessions/p/own-write.jsonl";
				const first = sameSizeBody("a");
				const second = sameSizeBody("b");
				const storage = await db.open();
				await storage.writeLinesAtomic(file, first, { expectedSize: null });
				let landed = false;

				const outcome = await readOutcome(
					afterFirstChunk(storage.readChunks(file), async () => {
						storage.writeLinesSync(file, second, { expectedSize: Buffer.byteLength(first.join("")) });
						// The queued publish lands before the read takes its next page.
						await storage.confirmWrites(file);
						landed = true;
					}),
					first,
					second,
				);
				expect(landed).toBe(true);
				expect(outcome).toMatch(ONE_BODY_OR_CONFLICT);
			},
			RACE_TIMEOUT,
		);

		// `omp render` copies the stored session before it opens the copy; a copy
		// that a rewrite raced reads the session again from its start.
		it(
			"omp render of a stored session another process rewrites after the copy's first chunk renders one body",
			async () => {
				// If this regresses, `omp render` of a SQL session another process is compacting fails with a
				// read conflict instead of rendering it.
				using dir = TempDir.createSync("@omp-sql-render-race-");
				const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
				const originalStorage = defaultSessionStorage();
				setAgentDir(dir.join("agent"));
				try {
					const file = path.join(dir.path(), "sessions", "raced-render.jsonl");
					const id = `render-race-${adapter}-${Date.now().toString(36)}`;
					const first = longSession(id, dir.path(), 3 * MiB, "render tail of the first body");
					const second = longSession(id, dir.path(), 3 * MiB, "render tail of the other body");
					const owner = await db.openElsewhere();
					await owner.writeLinesAtomic(file, first, { expectedSize: null });
					const reader = await db.open();
					setDefaultSessionStorage(reader);
					const race = raceAfterFirstChunk(reader, file, () =>
						owner.writeLinesAtomic(file, second, { expectedSize: Buffer.byteLength(first.join("")) }),
					);
					let printed = "";
					vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
						printed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
						return true;
					});
					vi.spyOn(process.stderr, "write").mockImplementation(() => true);

					const code = await runRenderCommand({ session: file, plain: true, width: 100, height: 30 });
					vi.restoreAllMocks();

					const tails = ["render tail of the first body", "render tail of the other body"].filter(tail =>
						printed.includes(tail),
					);
					expect({ raced: race.ran, code, tails: tails.length }).toEqual({ raced: true, code: 0, tails: 1 });
				} finally {
					setDefaultSessionStorage(originalStorage);
					if (originalAgentDir) {
						setAgentDir(originalAgentDir);
					} else {
						setAgentDir(path.join(getConfigRootDir(), "agent"));
						delete process.env.PI_CODING_AGENT_DIR;
					}
				}
			},
			RENDER_TIMEOUT,
		);

		// The loader, a transcript copy and a digest read through readChunks; a
		// whole read through readText. Both must see the same title slot.
		it("readChunks reads a titled session shorter than its title slot as readText reads it", async () => {
			const storage = await db.open();
			for (const content of ["", "short header\n"]) {
				const file = `/sessions/p/short-${content.length}.jsonl`;
				await storage.writeText(file, content);
				await storage.updateSessionTitle(file, { title: "Renamed", source: "user", updatedAt: TIMESTAMP });
				const text = Buffer.from(await storage.readText(file), "utf8");
				for (const from of [0, 5]) {
					const chunks: Uint8Array[] = [];
					for await (const chunk of storage.readChunks(file, from)) chunks.push(chunk);
					expect({ content, from, read: Buffer.concat(chunks).toString("utf8") }).toEqual({
						content,
						from,
						read: text.subarray(from).toString("utf8"),
					});
				}
			}
		});

		// A render of a long stored session must not cost a transcript-sized
		// string, as no resume or other reader of it does.
		it(
			"omp render of a stored session longer than 16 MiB hands no value over 16 MiB to or from the storage",
			async () => {
				using dir = TempDir.createSync("@omp-sql-render-");
				const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
				const originalStorage = defaultSessionStorage();
				setAgentDir(dir.join("agent"));
				try {
					const file = path.join(dir.path(), "sessions", "long.jsonl");
					const tail = "render tail marker";
					const lines = longSession(
						`render-${adapter}-${Date.now().toString(36)}`,
						dir.path(),
						RENDER_BYTES,
						tail,
					);
					const source = new Bun.CryptoHasher("sha256");
					for (const line of lines) source.update(line);
					const sourceDigest = source.digest("hex");
					await (await db.open()).writeLinesAtomic(file, lines, { expectedSize: null });

					const longest = new Longest();
					setDefaultSessionStorage(recordStorage(await db.open(instrument(db.client, longest)), longest));
					let printed = "";
					vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
						printed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
						return true;
					});
					vi.spyOn(process.stderr, "write").mockImplementation(() => true);

					const code = await runRenderCommand({ session: file, plain: true, width: 100, height: 30 });
					vi.restoreAllMocks();
					expect(code).toBe(0);
					expect(printed).toContain(tail);
					// Rendering never changes the session it renders.
					const stored = new Bun.CryptoHasher("sha256");
					for await (const chunk of (await db.open()).readChunks(file)) stored.update(chunk);
					expect(stored.digest("hex")).toBe(sourceDigest);
					expectBounded(longest);
				} finally {
					setDefaultSessionStorage(originalStorage);
					if (originalAgentDir) {
						setAgentDir(originalAgentDir);
					} else {
						setAgentDir(path.join(getConfigRootDir(), "agent"));
						delete process.env.PI_CODING_AGENT_DIR;
					}
				}
			},
			RENDER_TIMEOUT,
		);
	});
}
