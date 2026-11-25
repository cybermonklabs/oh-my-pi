/**
 * A full rewrite of a long session on SQL storage keeps the transcript out of
 * memory when the local spool it streams through cannot be used: `os.tmpdir()`
 * read-only, `os.tmpdir()` under a regular file, or a spool directory another
 * account could enter. The storage hands its backend no string and no chunk
 * longer than 16 MiB, and the rewrite either stores the session through a
 * streamed write or fails where the caller sees it, leaving the stored copy
 * as it was. A regression shows as the whole transcript, joined into one
 * string, handed to the backend's `writeFull`.
 *
 * Runs on SQLite always, and on PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL`
 * names a throwaway database; each case uses a table of its own and drops it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { SessionStorageBackend } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageOptions,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { dropSessionStoreTables } from "../helpers/sql-session-storage";

type SqlClient = InstanceType<typeof SQL>;

const MiB = 1024 * 1024;
/** No string or chunk handed to the backend may reach past this. */
const BOUND = 16 * MiB;
/** Size of the rewritten transcript: past {@link BOUND}. */
const TRANSCRIPT_BYTES = 24 * MiB;
const TIMEOUT = 300_000;
const TIMESTAMP = "2026-11-21T00:00:00.000Z";
const SESSION = "/sessions/-project-/2026-11-21T00-00-00-000Z_01a1f000-0000-7000-8000-00000000b001.jsonl";
/** Root ignores directory permissions, so a read-only directory cannot be made for it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

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
 * Ways the spool cannot be used. Each makes `os.tmpdir()` (the directory
 * returned) one the spool cannot write under, starting from the empty
 * directory `scratch`.
 */
const UNUSABLE_SPOOLS: ReadonlyArray<{ name: string; skip: boolean; make: (scratch: TempDir) => string }> = [
	{
		name: "os.tmpdir() is read-only",
		skip: RUNS_AS_ROOT,
		make: scratch => {
			fs.chmodSync(scratch.path(), 0o500);
			return scratch.path();
		},
	},
	{
		name: "os.tmpdir() is under a regular file",
		skip: false,
		make: scratch => {
			const file = scratch.join("not-a-directory");
			fs.writeFileSync(file, "a regular file\n");
			return scratch.join("not-a-directory", "tmp");
		},
	},
	{
		name: "the spool directory is one another account could enter",
		skip: process.getuid === undefined,
		make: scratch => {
			const spool = scratch.join(`omp-spool-${process.getuid?.()}`);
			fs.mkdirSync(spool);
			fs.chmodSync(spool, 0o755);
			return scratch.path();
		},
	},
];

/**
 * A current-version transcript of at least `bytes` UTF-8 bytes, as lines: a
 * title slot, a header, then alternating user and assistant messages of about
 * 20 KiB each.
 */
function transcriptLines(cwd: string, bytes: number): string[] {
	const lines = [
		serializeTitleSlot({ title: "Long session", source: "user", updatedAt: TIMESTAMP }),
		`${JSON.stringify({ type: "session", version: 3, id: "01a1f000-0000-7000-8000-00000000b001", timestamp: TIMESTAMP, cwd })}\n`,
	];
	let total = Buffer.byteLength(lines.join(""));
	let parentId: string | null = null;
	for (let n = 0; total < bytes; n++) {
		const text = `${n} ${"the session keeps working through the module tree; ".repeat(400)}€`;
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

/** The largest string or byte chunk handed to the backend, in UTF-8 bytes, and which call handed it. */
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

async function* noteChunks(chunks: AsyncIterable<unknown>, longest: Longest, what: string): AsyncGenerator<unknown> {
	for await (const chunk of chunks) {
		if (chunk instanceof Uint8Array) longest.note(chunk.byteLength, what);
		yield chunk;
	}
}

/**
 * `backend` behind a proxy that notes every string and buffer argument of
 * its methods and every chunk of a stream argument (a streamed full write's
 * body). Methods run on the backend itself.
 */
function watchBackend(backend: SessionStorageBackend, longest: Longest): SessionStorageBackend {
	return new Proxy(backend, {
		get(target, key) {
			const member: unknown = Reflect.get(target, key, target);
			if (typeof member !== "function") return member;
			const name = String(key);
			return (...args: unknown[]) =>
				member.apply(
					target,
					args.map(arg => {
						if (typeof arg === "string") longest.note(Buffer.byteLength(arg), `a string handed to ${name}`);
						else if (arg instanceof Uint8Array) longest.note(arg.byteLength, `a buffer handed to ${name}`);
						else if (typeof arg === "object" && arg !== null && Symbol.asyncIterator in arg) {
							return noteChunks(arg as AsyncIterable<unknown>, longest, `a chunk streamed to ${name}`);
						}
						return arg;
					}),
				);
		},
	});
}

/**
 * SQL storage whose backend {@link watchBackend} watches. The storage builds
 * its backend privately and hands it to the base class's constructor, so a
 * class slotted in between for this one `create` call hands on the watched
 * backend instead; `create` builds the storage before its first await.
 */
function openWatched(options: SqlSessionStorageOptions, longest: Longest): Promise<SqlSessionStorage> {
	const Base: new (backend: SessionStorageBackend) => object = Object.getPrototypeOf(SqlSessionStorage);
	class Watched extends Base {
		constructor(backend: SessionStorageBackend) {
			super(watchBackend(backend, longest));
		}
	}
	Object.setPrototypeOf(SqlSessionStorage, Watched);
	try {
		return SqlSessionStorage.create(options);
	} finally {
		Object.setPrototypeOf(SqlSessionStorage, Base);
	}
}

function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** The stored bytes of `path` as size and SHA-256, read in chunks; null when the path holds no session. */
async function storedDigest(storage: SqlSessionStorage, path: string): Promise<{ bytes: number; hash: string } | null> {
	if (!storage.existsSync(path)) return null;
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of storage.readChunks(path)) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { bytes, hash: hasher.digest("hex") };
}

let tableSeq = 0;

/** One case's database: a fresh table, a long session stored in it, and the cleanup that drops them. */
class Db {
	readonly table = `omp_spool_streams_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly cwd = TempDir.createSync("@omp-spool-streams-cwd-");
	readonly #dir: TempDir | undefined;

	constructor(adapter: SqlSessionStorageAdapter, url: string) {
		if (adapter === "sqlite") {
			this.#dir = TempDir.createSync("@omp-spool-streams-db-");
			this.client = new SQL(`sqlite:${this.#dir.join("sessions.sqlite")}`);
		} else {
			this.client = new SQL(url);
		}
	}

	open(longest?: Longest): Promise<SqlSessionStorage> {
		const options = { client: this.client, table: this.table };
		return longest ? openWatched(options, longest) : SqlSessionStorage.create(options);
	}

	/** Store a long session at {@link SESSION}; its size and SHA-256. */
	async seed(): Promise<{ bytes: number; hash: string }> {
		const content = transcriptLines(this.cwd.path(), TRANSCRIPT_BYTES).join("");
		const storage = await this.open();
		await storage.writeText(SESSION, content);
		await storage.drain();
		return { bytes: Buffer.byteLength(content), hash: sha256(content) };
	}

	async close(): Promise<void> {
		await dropSessionStoreTables(this.client, this.table);
		await this.client.end();
		this.#dir?.removeSync();
		this.cwd.removeSync();
	}
}

const originalTmpdir = process.env.TMPDIR;

function restoreTmpdir(): void {
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SQL session storage rewrites a long session in full without its spool (${adapter})`, () => {
		const cleanups: Array<() => Promise<void> | void> = [];

		afterEach(async () => {
			restoreTmpdir();
			vi.restoreAllMocks();
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});

		/** A seeded database and a scratch directory made before `os.tmpdir()` changes, both cleaned up after the case. */
		async function setUp(): Promise<{ db: Db; scratch: TempDir; seeded: { bytes: number; hash: string } }> {
			const db = new Db(adapter, url ?? "");
			cleanups.push(() => db.close());
			const scratch = TempDir.createSync("@omp-spool-streams-tmp-");
			cleanups.push(() => {
				fs.chmodSync(scratch.path(), 0o700);
				scratch.removeSync();
			});
			const seeded = await db.seed();
			vi.spyOn(logger, "warn").mockImplementation(() => {});
			return { db, scratch, seeded };
		}

		for (const spool of UNUSABLE_SPOOLS) {
			// If this regresses, a long session resumed on SQL storage in a container whose temporary
			// directory cannot hold the spool joins its whole transcript into one string at every full
			// rewrite (a header change, a recovery), and the process's memory grows with the session's
			// age until the container is killed.
			it.skipIf(spool.skip)(
				`rewrites a resumed session in place without a value as long as the transcript when ${spool.name}`,
				async () => {
					const { db, scratch, seeded } = await setUp();
					const longest = new Longest();
					const storage = await db.open(longest);
					const manager = await SessionManager.open(SESSION, undefined, storage, { suppressBreadcrumb: true });
					cleanups.push(() => manager.close().catch(() => {}));
					const entries = manager.getEntries().length;
					longest.reset();
					process.env.TMPDIR = spool.make(scratch);

					const outcome = await manager.rewriteEntries().then(
						() => "stored",
						(err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					await storage.drain().catch(() => {});
					restoreTmpdir();

					expect({ largest: longest.what, bytes: longest.bytes, bounded: longest.bytes <= BOUND }).toMatchObject({
						bounded: true,
					});
					const stored = await storedDigest(await db.open(), SESSION);
					if (outcome === "stored") {
						const reopened = await SessionManager.open(SESSION, undefined, await db.open(), {
							suppressBreadcrumb: true,
						});
						cleanups.push(() => reopened.close().catch(() => {}));
						expect(reopened.getEntries().length).toBe(entries);
					} else {
						// A rewrite that cannot stream fails where the caller sees it and leaves the stored copy whole.
						expect(stored).toEqual(seeded);
					}
				},
				TIMEOUT,
			);

			// If this regresses, branching a long session on SQL storage in a container whose temporary
			// directory cannot hold the spool joins the whole branch into one string, and the process's
			// memory grows with the session's age until the container is killed.
			it.skipIf(spool.skip)(
				`writes a branched session without a value as long as the transcript when ${spool.name}`,
				async () => {
					const { db, scratch, seeded } = await setUp();
					const longest = new Longest();
					const storage = await db.open(longest);
					const manager = await SessionManager.open(SESSION, undefined, storage, { suppressBreadcrumb: true });
					cleanups.push(() => manager.close().catch(() => {}));
					const entries = manager.getEntries().length;
					const leaf = manager.getLeafId();
					if (!leaf) throw new Error("Expected a leaf entry");
					longest.reset();
					process.env.TMPDIR = spool.make(scratch);

					let branch: string | undefined;
					const outcome = await (async () => {
						branch = manager.createBranchedSession(leaf);
						await manager.flush();
						await storage.drain();
						const failure = manager.getPersistenceFailure();
						return failure ? `failed: ${failure.message}` : "stored";
					})().catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`);
					restoreTmpdir();

					expect({ largest: longest.what, bytes: longest.bytes, bounded: longest.bytes <= BOUND }).toMatchObject({
						bounded: true,
					});
					const fresh = await db.open();
					// The session it branched from is never touched.
					expect(await storedDigest(fresh, SESSION)).toEqual(seeded);
					if (outcome === "stored") {
						if (!branch) throw new Error("Expected a branched session path");
						const reopened = await SessionManager.open(branch, undefined, fresh, { suppressBreadcrumb: true });
						cleanups.push(() => reopened.close().catch(() => {}));
						expect(reopened.getEntries().length).toBe(entries);
					} else {
						// A branch that cannot stream fails where the caller sees it, and stores no part of itself.
						expect(branch === undefined || !fresh.existsSync(branch)).toBe(true);
					}
				},
				TIMEOUT,
			);
		}
	});
}
