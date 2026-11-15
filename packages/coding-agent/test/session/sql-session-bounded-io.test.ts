/**
 * SQL session storage reads and rewrites a long transcript without holding it
 * whole: a read streams the session's parts a page at a time, and a full
 * rewrite spools its lines to a temporary file and swaps staged parts in. The
 * other readers of a stored transcript (the debug report, memories stage 1,
 * blob gc, the RPC subagent read and the Agent Hub viewer) read it in chunks
 * or windows. A regression shows as a string or buffer as long as the
 * transcript handed to, or returned by, the SQL client or the storage.
 *
 * Runs on SQLite always, and on PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL`
 * names a throwaway database. Cases that call the streamed storage methods
 * skip where the storage lacks them; the reader and `SessionManager` cases use
 * only APIs that predate them, so on a storage that reads and writes whole
 * they fail by recording a value as long as the transcript.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { buildStage1RolloutItems } from "@oh-my-pi/pi-coding-agent/memories";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	loadSessionFile,
	loadSessionMessagesReadOnly,
	parseSessionContent,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as sessionStorageConfig from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { copyTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import * as piUtils from "@oh-my-pi/pi-utils";
import { getBlobsDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { readStoredSession } from "../helpers/sql-session-storage";

type SqlClient = InstanceType<typeof SQL>;

const MiB = 1024 * 1024;
/** No value, and no query's returned values together, may reach past this. */
const BOUND = 16 * MiB;
/** Size of the transcript the readers stream. */
const READ_BYTES = 64 * MiB;
/** Size of a rewritten transcript: past {@link BOUND}, and more than 16 parts of 1 MiB. */
const WRITE_BYTES = 20 * MiB;
const TIMEOUT = 300_000;
const TIMESTAMP = "2026-11-01T00:00:00.000Z";
const STAGING = "#staging-";
const HOUR_MS = 60 * 60 * 1000;

/** Whether SQL storage reads in chunks: a storage has `readChunks` when its backend reads in pieces. */
const streamsReads = await (async () => {
	const client = new SQL("sqlite::memory:");
	try {
		return typeof (await SqlSessionStorage.create({ client })).readChunks === "function";
	} finally {
		await client.end();
	}
})();
const streamsWrites =
	typeof SqlSessionStorage.prototype.writeLinesAtomic === "function" &&
	typeof SqlSessionStorage.prototype.writeLinesSync === "function";

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

/**
 * A current-version transcript of at least `bytes` UTF-8 bytes, as lines: a
 * title slot, a header, then alternating user and assistant messages of about
 * 100 KiB of one-, three- and four-byte characters, each a little longer than
 * the one before, so 1 MiB cuts fall inside lines and inside characters.
 */
function transcriptLines(cwd: string, bytes: number): string[] {
	const lines = [
		serializeTitleSlot({ title: "Bounded transcript", source: "user", updatedAt: TIMESTAMP }),
		`${JSON.stringify({ type: "session", version: 3, id: "bounded-io", timestamp: TIMESTAMP, cwd })}\n`,
	];
	let total = Buffer.byteLength(lines.join(""));
	let parentId: string | null = null;
	for (let n = 0; total < bytes; n++) {
		const text = `${n} ${"a€😀b".repeat(11_000 + n)}`;
		const message =
			n % 2 === 0
				? { role: "user", content: text, timestamp: n }
				: {
						role: "assistant",
						content: [{ type: "text", text }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test-model",
						usage: USAGE,
						stopReason: "stop",
						timestamp: n,
					};
		const line = `${JSON.stringify({ type: "message", id: `m${n}`, parentId, timestamp: TIMESTAMP, message })}\n`;
		lines.push(line);
		total += Buffer.byteLength(line);
		parentId = `m${n}`;
	}
	return lines;
}

function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function byteSize(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof Uint8Array) return value.byteLength;
	return 0;
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

	reset(): void {
		this.bytes = 0;
		this.what = "nothing";
	}
}

function expectBounded(longest: Longest): void {
	expect({ largest: longest.what, bytes: longest.bytes, bounded: longest.bytes <= BOUND }).toMatchObject({
		bounded: true,
	});
}

/**
 * `client` behind a wrapper that notes every bound value, every returned value,
 * and every query's returned values together; `before` runs ahead of each
 * statement, inside its transaction.
 */
function instrument(
	client: SqlClient,
	longest: Longest,
	before?: (query: string, values: unknown[] | undefined) => Promise<void>,
): SqlSessionStorageClient {
	const exec = async (
		executor: SqlSessionStorageTransaction,
		query: string,
		values: unknown[] | undefined,
	): Promise<SqlSessionStorageResult> => {
		await before?.(query, values);
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
 * its methods, each element of an array argument (a full write's lines), the
 * text of a `{ text, size }` result (a ranged read), and each chunk a returned
 * stream yields. Methods run on the storage itself.
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

let tableSeq = 0;

/** One backend's database: a fresh table name, and the cleanup that drops it. */
class Db {
	readonly table = `omp_bounded_io_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly #dir: TempDir | undefined;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		url: string,
	) {
		if (adapter === "sqlite") {
			this.#dir = TempDir.createSync("@omp-sql-bounded-io-");
			this.client = new SQL(`sqlite:${this.#dir.join("sessions.sqlite")}`);
		} else {
			this.client = new SQL(url);
		}
	}

	open(client: SqlSessionStorageClient = this.client): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client, table: this.table });
	}

	/** Run fixture SQL written with `?` placeholders on either dialect. */
	async sql<Row>(query: string, values: unknown[] = []): Promise<Row[]> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		return (await this.client.unsafe(text, values)) as Row[];
	}

	stored(path: string): Promise<string | null> {
		return readStoredSession(this.client, this.table, path, this.adapter);
	}

	/** Every staging path that holds parts, sorted. */
	async stagingPaths(): Promise<string[]> {
		const rows = await this.sql<{ path: string }>(`SELECT DISTINCT path FROM ${this.table}_parts`);
		return rows
			.map(row => row.path)
			.filter(path => path.includes(STAGING))
			.sort();
	}

	/** Insert a staging set by hand, as a writer killed between its staging writes and its swap leaves one. */
	async stage(path: string, epochMs: number, id: string): Promise<string> {
		const staging = `${path}${STAGING}${String(epochMs).padStart(13, "0")}-${id}`;
		await this.sql(`INSERT INTO ${this.table}_parts (path, start_offset, content) VALUES (?, 0, ?), (?, 6, ?)`, [
			staging,
			"stale\n",
			staging,
			"bytes\n",
		]);
		return staging;
	}

	async close(): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
		this.#dir?.removeSync();
	}
}

/**
 * Store `lines` as a long session stores them: most as one full write, cut
 * into 1 MiB parts at character boundaries rather than line ends, and the
 * rest as appends of about 3 MiB, so the parts differ in size.
 */
async function storeTranscript(storage: SqlSessionStorage, path: string, lines: readonly string[]): Promise<void> {
	const split = Math.floor((lines.length * 3) / 4);
	await storage.writeText(path, lines.slice(0, split).join(""));
	const writer = storage.openWriter(path);
	let chunk = "";
	let chunkBytes = 0;
	for (const line of lines.slice(split)) {
		chunk += line;
		chunkBytes += Buffer.byteLength(line);
		if (chunkBytes < 3 * MiB) continue;
		await writer.append(chunk);
		chunk = "";
		chunkBytes = 0;
	}
	if (chunk) await writer.append(chunk);
	await writer.close();
	await storage.drain();
}

/** Bytes of a reference {@link blobRefTranscript} puts before the end of its first part. */
const REF_CUT_AT = 30;

/**
 * A transcript of more than 2 MiB of one-byte characters, so a full write's
 * 1 MiB parts end at exact multiples of 1 MiB: the first part ends
 * {@link REF_CUT_AT} bytes into a reference to the blob `cut`, and the second
 * part holds a whole reference to the blob `whole`.
 */
function blobRefTranscript(cwd: string, cut: string, whole: string): string {
	const header = `${JSON.stringify({ type: "session", version: 3, id: "blob-refs", timestamp: TIMESTAMP, cwd })}\n`;
	const line = (id: string, content: string): string =>
		`${JSON.stringify({ type: "message", id, parentId: null, timestamp: TIMESTAMP, message: { role: "user", content, timestamp: 0 } })}\n`;
	const textAt = header.length + line("b1", "TEXT").indexOf("TEXT");
	const first = line("b1", `${"x".repeat(MiB - REF_CUT_AT - textAt - 1)} blob:sha256:${cut} ${"y".repeat(1000)}`);
	const second = line("b2", ` blob:sha256:${whole} ${"z".repeat(MiB + MiB / 2)}`);
	return header + first + second;
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SQL session storage keeps a long transcript out of memory (${adapter})`, () => {
		const artifactsDir = "/sessions/p/long";
		const readPath = `${artifactsDir}/Child.jsonl`;
		let cwd: TempDir;
		let db: Db;
		let readLines: string[];
		let readContent: string;

		beforeAll(async () => {
			cwd = TempDir.createSync("@omp-sql-bounded-io-cwd-");
			db = new Db(adapter, url ?? "");
			readLines = transcriptLines(cwd.path(), READ_BYTES);
			readContent = readLines.join("");
			await storeTranscript(await db.open(), readPath, readLines);
		}, TIMEOUT);

		afterAll(async () => {
			await db?.close();
			cwd?.removeSync();
		});

		it.skipIf(!streamsReads)(
			"reads a transcript stored as parts not cut at line ends back byte for byte, a part at a time",
			async () => {
				const longest = new Longest();
				const storage = await db.open(instrument(db.client, longest));
				const hasher = new Bun.CryptoHasher("sha256");
				let bytes = 0;
				let largestChunk = 0;
				for await (const chunk of storage.readChunks(readPath)) {
					hasher.update(chunk);
					bytes += chunk.byteLength;
					largestChunk = Math.max(largestChunk, chunk.byteLength);
				}
				expect({ bytes, digest: hasher.digest("hex") }).toEqual({
					bytes: Buffer.byteLength(readContent),
					digest: sha256(readContent),
				});
				expect(largestChunk).toBeLessThanOrEqual(BOUND);
				expectBounded(longest);
			},
			TIMEOUT,
		);

		it(
			"loads the entries a parse of the whole text gives, without a whole read",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const loaded = await loadSessionFile(readPath, storage);
				expectBounded(longest);
				expect(loaded.entries).toEqual(parseSessionContent(readContent).entries);
			},
			TIMEOUT,
		);

		it(
			"scans every line without a whole read",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const hasher = new Bun.CryptoHasher("sha256");
				let lines = 0;
				await storage.scanLines(readPath, line => {
					if (lines > 0) hasher.update("\n");
					hasher.update(line);
					lines++;
					return false;
				});
				expectBounded(longest);
				// The lines `split("\n")` gives: one per newline, and the empty text after the last.
				expect({ lines, digest: hasher.digest("hex") }).toEqual({
					lines: readLines.length + 1,
					digest: sha256(readContent),
				});
			},
			TIMEOUT,
		);

		it(
			"builds the read-only transcript without a whole read",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const messages = await loadSessionMessagesReadOnly(readPath, storage);
				expectBounded(longest);
				expect(messages).toHaveLength(readLines.length - 2);
			},
			TIMEOUT,
		);

		it(
			"peeks a subagent's recorded directory without a whole read",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const peek = await SessionManager.peekSessionInit(readPath, storage);
				expectBounded(longest);
				expect(peek).toMatchObject({ cwd: cwd.path(), init: null });
			},
			TIMEOUT,
		);

		it(
			"copies a subagent transcript tree byte for byte, title included, without a whole read",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const copyDir = "/sessions/p/long-copy";
				const copied = await copyTranscriptTree(storage, artifactsDir, copyDir);
				expectBounded(longest);
				const copy = `${copyDir}/Child.jsonl`;
				expect(copied).toEqual([{ from: readPath, to: copy }]);
				expect(sha256((await db.stored(copy)) ?? "")).toBe(sha256(readContent));
				expect(await db.sql(`SELECT title, title_source FROM ${db.table} WHERE path = ?`, [copy])).toEqual([
					{ title: "Bounded transcript", title_source: "user" },
				]);
				await storage.unlink(copy);
			},
			TIMEOUT,
		);

		it(
			"resumes through SessionManager.open without a value as long as the transcript",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const manager = await SessionManager.open(readPath, undefined, storage, { suppressBreadcrumb: true });
				try {
					expectBounded(longest);
					expect(manager.getEntries()).toHaveLength(readLines.length - 2);
				} finally {
					await manager.close();
				}
			},
			TIMEOUT,
		);

		it(
			"rewrites a resumed session for a header change without a value as long as the transcript",
			async () => {
				const path = "/sessions/p/rewritten.jsonl";
				await (await db.open()).writeText(path, transcriptLines(cwd.path(), WRITE_BYTES).join(""));
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const manager = await SessionManager.open(path, undefined, storage, { suppressBreadcrumb: true });
				try {
					longest.reset();
					await manager.setTaskPromptCacheKey("bounded-io-cache-key");
					expectBounded(longest);
				} finally {
					await manager.close();
				}
				const [head] = await (await db.open()).readTextSlices(path, 64 * 1024, 0);
				expect(JSON.parse(head.split("\n")[1] ?? "null")).toMatchObject({
					id: "bounded-io",
					taskPromptCacheKey: "bounded-io-cache-key",
				});
			},
			TIMEOUT,
		);

		it(
			"bundles the transcript into a debug report without a whole read",
			async () => {
				const reports = TempDir.createSync("@omp-sql-bounded-io-reports-");
				const reportsDir = spyOn(piUtils, "getReportsDir").mockReturnValue(reports.path());
				try {
					const longest = new Longest();
					const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
					const bundle = await createReportBundle({ sessionFile: readPath, storage });
					expectBounded(longest);
					const members = await new Bun.Archive(await Bun.file(bundle.path).bytes()).files();
					const session = await members.get("session.jsonl")?.bytes();
					expect(sha256(session ?? "")).toBe(sha256(readContent));
				} finally {
					reportsDir.mockRestore();
					reports.removeSync();
				}
			},
			TIMEOUT,
		);

		it(
			"pages an RPC subagent transcript read in windows that reach every entry",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				let fromByte = 0;
				let messages = 0;
				for (;;) {
					const page = await readRpcSubagentTranscript(readPath, fromByte, storage);
					messages += page.messages.length;
					if (page.nextByte === fromByte) break;
					fromByte = page.nextByte;
				}
				expectBounded(longest);
				expect({ fromByte, messages }).toEqual({
					fromByte: Buffer.byteLength(readContent),
					messages: readLines.length - 2,
				});
			},
			TIMEOUT,
		);

		it(
			"reads an Agent Hub transcript in windows that reach every entry",
			async () => {
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const { transcript } = createAgentHubRuntime({ storage, registry: new AgentRegistry() });
				let offset = 0;
				let messages = 0;
				for (;;) {
					const text = await transcript.readFrom(readPath, offset);
					const complete = text.slice(0, text.lastIndexOf("\n") + 1);
					if (!complete) break;
					messages += transcript.parseEntries(complete).length;
					offset += Buffer.byteLength(complete);
				}
				expectBounded(longest);
				expect({ offset, messages }).toEqual({
					offset: Buffer.byteLength(readContent),
					messages: readLines.length - 2,
				});
			},
			TIMEOUT,
		);

		it(
			"builds memories stage 1 input from a long rollout without a whole read",
			async () => {
				const local = cwd.join("rollout.jsonl");
				await Bun.write(local, readContent);
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				// A payload of a few head and tail windows, then one of most of the rollout.
				for (const tokenLimit of [4_000, 4_000_000]) {
					const built = await buildStage1RolloutItems(readPath, tokenLimit, storage);
					const fromFile = await buildStage1RolloutItems(local, tokenLimit, new FileSessionStorage());
					expect({ tokenLimit, digest: sha256(built) }).toEqual({ tokenLimit, digest: sha256(fromFile) });
				}
				expectBounded(longest);
				await fs.rm(local, { force: true });
			},
			TIMEOUT,
		);

		it(
			"finds the blob references of every stored transcript, one cut by a chunk edge included, without a whole read",
			async () => {
				const agentDir = TempDir.createSync("@omp-sql-bounded-io-gc-");
				const refsPath = "/sessions/p/blob-refs.jsonl";
				const blobs = { cut: sha256("cut"), whole: sha256("whole"), orphan: sha256("orphan") };
				const content = blobRefTranscript(cwd.path(), blobs.cut, blobs.whole);
				expect(content.indexOf(`blob:sha256:${blobs.cut}`)).toBe(MiB - REF_CUT_AT);
				await (await db.open()).writeText(refsPath, content);
				const aged = new Date(Date.now() - 86_400_000);
				for (const [label, hash] of Object.entries(blobs)) {
					const blob = `${getBlobsDir(agentDir.path())}/${hash}`;
					await Bun.write(blob, label);
					await fs.utimes(blob, aged, aged);
				}
				const longest = new Longest();
				const storage = recordStorage(await db.open(instrument(db.client, longest)), longest);
				const resolve = spyOn(sessionStorageConfig, "resolveSessionStorage").mockResolvedValue(storage);
				const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
				try {
					const result = await runGcCommand({ flags: { agentDir: agentDir.path(), blobs: true } });
					expectBounded(longest);
					// The cut reference keeps its blob as the whole one does: only the orphan would go.
					expect(result.blobs).toMatchObject({ referenced: 2, candidates: 3, wouldDelete: 1 });
				} finally {
					stdout.mockRestore();
					resolve.mockRestore();
					await (await db.open()).unlink(refsPath);
					agentDir.removeSync();
				}
			},
			TIMEOUT,
		);

		for (const variant of ["writeLinesAtomic", "writeLinesSync"] as const) {
			it.skipIf(!streamsWrites)(
				`${variant} stores the bytes a whole write of the joined lines stores, with no value over 16 MiB`,
				async () => {
					const lines = transcriptLines(cwd.path(), WRITE_BYTES);
					const reference = `/sessions/p/${variant}-whole.jsonl`;
					const streamed = `/sessions/p/${variant}-streamed.jsonl`;
					await (await db.open()).writeText(reference, lines.join(""));
					const longest = new Longest();
					const storage = await db.open(instrument(db.client, longest));
					if (variant === "writeLinesAtomic") {
						await storage.writeLinesAtomic(streamed, lines, { expectedSize: null });
					} else {
						storage.writeLinesSync(streamed, lines, { expectedSize: null });
						await storage.drain();
					}
					expectBounded(longest);
					expect(sha256((await db.stored(streamed)) ?? "")).toBe(sha256((await db.stored(reference)) ?? ""));
					const rows = await db.sql<Record<string, unknown>>(
						`SELECT path, byte_len, title, title_source, title_updated_at FROM ${db.table} WHERE path IN (?, ?)`,
						[reference, streamed],
					);
					const row = (path: string) => {
						const { path: _path, ...rest } = rows.find(found => found.path === path) ?? {};
						return rest;
					};
					expect(row(streamed)).toEqual(row(reference));
					expect(await db.stagingPaths()).toEqual([]);
				},
				TIMEOUT,
			);
		}

		it.skipIf(!streamsWrites)(
			"refuses a full write whose expected size no longer matches, leaving the bytes and no staging parts",
			async () => {
				const path = "/sessions/p/conflict.jsonl";
				const base = transcriptLines(cwd.path(), 2 * MiB).join("");
				const writer = await db.open();
				await writer.writeText(path, base);
				const stale = await db.open();
				const appended = `${JSON.stringify({ type: "custom", customType: "other-writer", id: "x1", parentId: null, timestamp: TIMESTAMP })}\n`;
				const append = writer.openWriter(path);
				await append.append(appended);
				await append.close();
				await writer.drain();

				const rewrite = stale.writeLinesAtomic(path, transcriptLines(cwd.path(), WRITE_BYTES), {
					expectedSize: Buffer.byteLength(base),
				});
				await expect(rewrite).rejects.toBeInstanceOf(SessionWriteConflictError);
				expect(sha256((await db.stored(path)) ?? "")).toBe(sha256(base + appended));
				expect(await db.stagingPaths()).toEqual([]);
			},
			TIMEOUT,
		);

		it.skipIf(!streamsWrites)(
			"deletes a killed writer's staging set over an hour old at the next full write, and never lists one",
			async () => {
				const path = "/sessions/p/staged.jsonl";
				const other = "/sessions/p/other.jsonl";
				const writer = await db.open();
				await writer.writeText(path, "before\n");
				await writer.writeText(other, "other\n");
				const dead = await db.stage(path, Date.now() - 2 * HOUR_MS, "dead");
				const live = await db.stage(path, Date.now(), "live");
				const othersDead = await db.stage(other, Date.now() - 2 * HOUR_MS, "dead");

				const storage = await db.open();
				expect(storage.listAllSync().sort()).not.toContain(dead);
				expect(storage.listFilesSync("/sessions/p", "*").filter(listed => listed.includes(STAGING))).toEqual([]);
				expect(storage.existsSync(dead)).toBe(false);

				const lines = transcriptLines(cwd.path(), 2 * MiB);
				await storage.writeLinesAtomic(path, lines, { expectedSize: Buffer.byteLength("before\n") });
				expect(sha256((await db.stored(path)) ?? "")).toBe(sha256(lines.join("")));
				// A younger set may be a live writer's, and another path's sets are its own writer's to clear.
				expect(await db.stagingPaths()).toEqual([live, othersDead].sort());
				await db.sql(`DELETE FROM ${db.table}_parts WHERE path IN (?, ?)`, [live, othersDead]);
			},
			TIMEOUT,
		);

		it.skipIf(!streamsWrites)(
			"refuses, as a conflict, a swap whose staging parts were deleted after they were written",
			async () => {
				const path = "/sessions/p/swept.jsonl";
				await (await db.open()).writeText(path, "kept\n");
				let swept = false;
				// The swap's first statement naming the staging path reads it back; delete the set just before.
				const sweepStaging = async (query: string, values: unknown[] | undefined): Promise<void> => {
					if (swept || !query.trimStart().toUpperCase().startsWith("SELECT")) return;
					const staging = values?.find(value => typeof value === "string" && /#staging-\d{13}-./.test(value));
					if (typeof staging !== "string") return;
					swept = true;
					await db.sql(`DELETE FROM ${db.table}_parts WHERE path = ?`, [staging]);
				};
				const storage = await db.open(instrument(db.client, new Longest(), sweepStaging));
				const rewrite = storage.writeLinesAtomic(path, transcriptLines(cwd.path(), 2 * MiB), {
					expectedSize: Buffer.byteLength("kept\n"),
				});
				const error = await rewrite.then(
					() => undefined,
					(err: unknown) => err,
				);
				expect(error).toBeInstanceOf(SessionWriteConflictError);
				// The session still has the size the write expected; what changed under it is its staging parts.
				expect(error).toMatchObject({
					path,
					expectedSize: Buffer.byteLength("kept\n"),
					actualSize: Buffer.byteLength("kept\n"),
				});
				expect(swept).toBe(true);
				expect(await db.stored(path)).toBe("kept\n");
				expect(await db.stagingPaths()).toEqual([]);
			},
			TIMEOUT,
		);

		// Every transaction of a staged full write opens read-write on PostgreSQL, as
		// sql-session-storage-read-write.test.ts shows for the other writes. Each
		// connection here sets its read-only default itself, so the URL must be a
		// direct connection, not one through a transaction-mode pooler.
		it.skipIf(!streamsWrites || adapter !== "postgres")(
			"stages a full write where a session SET made the connection read-only, and refuses one where the session keeps a read-only default",
			async () => {
				const path = "/sessions/p/read-only.jsonl";
				const refused = "/sessions/p/read-only-refused.jsonl";
				const plainWrite = `DELETE FROM ${db.table}_parts WHERE path = '${refused}'`;
				const readOnly = async (client: SqlClient) =>
					(
						(await client.unsafe(
							"SELECT setting, reset_val FROM pg_settings WHERE name = 'default_transaction_read_only'",
						)) as Array<{ setting: string; reset_val: string }>
					)[0];
				const stagingOf = async (session: string): Promise<string[]> =>
					(await db.stagingPaths()).filter(staged => staged.startsWith(`${session}${STAGING}`));
				const sessionSet = new SQL(url ?? "", { max: 1, idleTimeout: 0 });
				const kept = new SQL(url ?? "", {
					max: 1,
					idleTimeout: 0,
					connection: { default_transaction_read_only: "on" },
				});
				try {
					const lines = transcriptLines(cwd.path(), 2 * MiB);
					await (await db.open()).writeText(path, "before\n");
					await db.stage(path, Date.now() - 2 * HOUR_MS, "dead");
					await sessionSet.unsafe("SET default_transaction_read_only = on");
					expect(await readOnly(sessionSet)).toEqual({ setting: "on", reset_val: "off" });
					await expect(sessionSet.unsafe(plainWrite)).rejects.toMatchObject({ errno: "25006" });

					// The stale staging delete, the staging inserts and the swap.
					const storage = await db.open(sessionSet);
					await storage.writeLinesAtomic(path, lines, { expectedSize: Buffer.byteLength("before\n") });
					expect(sha256((await db.stored(path)) ?? "")).toBe(sha256(lines.join("")));
					expect(await stagingOf(path)).toEqual([]);

					// The staging delete after a failure: another store appends, so this store's size is stale.
					const appended = `${JSON.stringify({ type: "custom", customType: "other-writer", id: "r1", parentId: null, timestamp: TIMESTAMP })}\n`;
					const other = await db.open();
					const append = other.openWriter(path);
					await append.append(appended);
					await append.close();
					await other.drain();
					const stale = storage.writeLinesAtomic(path, lines, { expectedSize: storage.statSync(path).size });
					await expect(stale).rejects.toBeInstanceOf(SessionWriteConflictError);
					expect(sha256((await db.stored(path)) ?? "")).toBe(sha256(lines.join("") + appended));
					expect(await stagingOf(path)).toEqual([]);
					expect(await readOnly(sessionSet)).toEqual({ setting: "on", reset_val: "off" });

					expect(await readOnly(kept)).toEqual({ setting: "on", reset_val: "on" });
					await expect(kept.unsafe(plainWrite)).rejects.toMatchObject({ errno: "25006" });
					const refusing = await SqlSessionStorage.create({ client: kept, table: db.table, createTable: false });
					await expect(refusing.writeLinesAtomic(refused, lines, { expectedSize: null })).rejects.toThrow(
						"default_transaction_read_only",
					);
					expect(await db.stored(refused)).toBeNull();
					expect(await stagingOf(refused)).toEqual([]);
				} finally {
					// Best effort: a RESET that fails on a broken connection must not hide the error that broke it.
					await sessionSet.unsafe("RESET default_transaction_read_only").catch(() => {});
					await Promise.all([sessionSet.end(), kept.end()]);
				}
			},
			TIMEOUT,
		);

		it("deletes the staging parts under a session's artifacts directory with the session", async () => {
			const session = "/sessions/p/doomed.jsonl";
			const storage = await db.open();
			await storage.writeText(session, "session\n");
			await storage.writeText("/sessions/p/doomed/Sub.jsonl", "sub\n");
			const own = await db.stage(session, Date.now(), "own");
			const unfinished = await db.stage("/sessions/p/doomed/Sub.jsonl", Date.now(), "unfinished");
			const neighbour = await db.stage("/sessions/p/doomed-not/Sub.jsonl", Date.now(), "neighbour");

			await storage.deleteSessionWithArtifacts(session);

			const remaining = await db.stagingPaths();
			expect(remaining).not.toContain(own);
			expect(remaining).not.toContain(unfinished);
			expect(remaining).toContain(neighbour);
			await db.sql(`DELETE FROM ${db.table}_parts WHERE path = ?`, [neighbour]);
		});

		it("deletes every staging set of a path, whatever its age, when the path is deleted", async () => {
			const path = "/sessions/p/unlinked.jsonl";
			const storage = await db.open();
			await storage.writeText(path, "session\n");
			await db.stage(path, Date.now() - 2 * HOUR_MS, "dead");
			await db.stage(path, Date.now(), "live");
			// A longer path that starts with this one names another session.
			const neighbour = await db.stage(`${path}x`, Date.now(), "neighbour");

			await storage.unlink(path);

			const remaining = await db.stagingPaths();
			expect(remaining.filter(staged => staged.startsWith(`${path}${STAGING}`))).toEqual([]);
			expect(remaining).toContain(neighbour);
			await db.sql(`DELETE FROM ${db.table}_parts WHERE path = ?`, [neighbour]);
		});

		it("deletes the staging sets of a renamed path and of the destination the rename replaces", async () => {
			const src = "/sessions/p/renamed-from.jsonl";
			const dst = "/sessions/p/renamed-to.jsonl";
			const storage = await db.open();
			await storage.writeText(src, "source\n");
			await storage.writeText(dst, "replaced\n");
			await db.stage(src, Date.now() - 2 * HOUR_MS, "dead");
			await db.stage(src, Date.now(), "live");
			await db.stage(dst, Date.now(), "replaced");

			await storage.rename(src, dst);

			const remaining = await db.stagingPaths();
			expect(remaining.filter(staged => staged.startsWith(`${src}${STAGING}`))).toEqual([]);
			expect(remaining.filter(staged => staged.startsWith(`${dst}${STAGING}`))).toEqual([]);
			expect(await db.stored(dst)).toBe("source\n");
		});

		it("deletes the staging sets of a path renamed without replacing", async () => {
			const src = "/sessions/p/moved-from.jsonl";
			const dst = "/sessions/p/moved-to.jsonl";
			const storage = await db.open();
			await storage.writeText(src, "source\n");
			await db.stage(src, Date.now(), "live");

			await storage.renameNoReplace(src, dst);

			expect((await db.stagingPaths()).filter(staged => staged.startsWith(`${src}${STAGING}`))).toEqual([]);
			expect(await db.stored(dst)).toBe("source\n");
		});
	});
}
