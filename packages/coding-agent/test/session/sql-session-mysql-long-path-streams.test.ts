/**
 * A full rewrite of a long session on MySQL storage keeps the transcript out
 * of memory when the session's path is long. A streamed full write stages
 * its parts under `<path>#staging-<13-digit epoch>-<16-hex id>`, 39
 * characters past the path, and MySQL's `path` columns hold 512 characters,
 * so a session path of 474 to 512 characters has no room for a staging path.
 * The rewrite of such a session hands its backend no string and no chunk
 * longer than 16 MiB, and the session reads back whole. A regression shows as
 * the whole transcript, decoded into one string, handed to the backend's
 * `writeFull`.
 *
 * Runs when `OMP_TEST_SQL_MYSQL_URL` names a throwaway MySQL or MariaDB
 * database; the case uses a table of its own and drops it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { SessionStorageBackend } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageOptions,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const MYSQL_URL = process.env.OMP_TEST_SQL_MYSQL_URL;
const SKIP = MYSQL_URL ? undefined : "OMP_TEST_SQL_MYSQL_URL is not set";
if (SKIP) console.warn(`sql-session-mysql-long-path-streams: skipped: ${SKIP}`);

const MiB = 1024 * 1024;
/** No string or chunk handed to the backend may reach past this. */
const BOUND = 16 * MiB;
/** Size of the rewritten transcript: past {@link BOUND}. */
const TRANSCRIPT_BYTES = 24 * MiB;
const TIMEOUT = 300_000;
const TIMESTAMP = "2026-11-21T00:00:00.000Z";
/** Characters MySQL's `path` columns hold. */
const MYSQL_PATH_CHARS = 512;
/** Characters a staging path adds to its session's: `#staging-`, 13 epoch digits, `-` and a 16-hex id. */
const STAGING_SUFFIX_CHARS = 39;
const SESSION_ID = "01a1f000-0000-7000-8000-00000000c001";
/** A session path of 488 characters: a row fits, a staging path of it does not. */
const SESSION = `/sessions/-${"workspace-".repeat(41).slice(0, 408)}-/2026-11-21T00-00-00-000Z_${SESSION_ID}.jsonl`;

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
 * 20 KiB each.
 */
function transcriptLines(cwd: string, bytes: number): string[] {
	const lines = [
		serializeTitleSlot({ title: "Long session", source: "user", updatedAt: TIMESTAMP }),
		`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: TIMESTAMP, cwd })}\n`,
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
 * Make every method of `backend` note its string and buffer arguments and
 * each chunk of a stream argument (a streamed full write's body). The notes
 * are the backend's own properties, so a call the backend makes to one of its
 * own methods (`writeFullStream` calling `writeFull`) is noted too.
 */
function watchBackend(backend: SessionStorageBackend, longest: Longest): void {
	const methods = backend as unknown as Record<string, (...args: unknown[]) => unknown>;
	const names = new Set<string>();
	for (let proto: object | null = Object.getPrototypeOf(backend); proto && proto !== Object.prototype;) {
		for (const name of Object.getOwnPropertyNames(proto)) {
			if (name !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function") {
				names.add(name);
			}
		}
		proto = Object.getPrototypeOf(proto);
	}
	for (const name of names) {
		const method = methods[name];
		methods[name] = (...args: unknown[]) =>
			method.apply(
				backend,
				args.map(arg => {
					if (typeof arg === "string") longest.note(Buffer.byteLength(arg), `a string handed to ${name}`);
					else if (arg instanceof Uint8Array) longest.note(arg.byteLength, `a buffer handed to ${name}`);
					else if (typeof arg === "object" && arg !== null && Symbol.asyncIterator in arg) {
						return noteChunks(arg as AsyncIterable<unknown>, longest, `a chunk streamed to ${name}`);
					}
					return arg;
				}),
			);
	}
}

/**
 * SQL storage whose backend {@link watchBackend} watches. The storage builds
 * its backend privately and hands it to the base class's constructor, so a
 * class slotted in between for this one `create` call watches it on the way;
 * `create` builds the storage before its first await.
 */
function openWatched(options: SqlSessionStorageOptions, longest: Longest): Promise<SqlSessionStorage> {
	const Base: new (backend: SessionStorageBackend) => object = Object.getPrototypeOf(SqlSessionStorage);
	class Watched extends Base {
		constructor(backend: SessionStorageBackend) {
			watchBackend(backend, longest);
			super(backend);
		}
	}
	Object.setPrototypeOf(SqlSessionStorage, Watched);
	try {
		return SqlSessionStorage.create(options);
	} finally {
		Object.setPrototypeOf(SqlSessionStorage, Base);
	}
}

/** The stored bytes of `path` as size and SHA-256, read in chunks. */
async function storedDigest(storage: SqlSessionStorage, path: string): Promise<{ bytes: number; hash: string }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of storage.readChunks(path)) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { bytes, hash: hasher.digest("hex") };
}

describe.skipIf(SKIP !== undefined)(
	`SQL session storage rewrites a long session with a long path in full on MySQL${SKIP ? ` (skipped: ${SKIP})` : ""}`,
	() => {
		const cleanups: Array<() => Promise<void> | void> = [];

		afterEach(async () => {
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});

		// If this regresses, a long session on MySQL storage whose project directory gives it a long
		// path joins its whole transcript into one string at every full rewrite (a header change, a
		// recovery), and the process's memory grows with the session's age until it is killed.
		it(
			"rewrites a resumed session whose staging path would not fit without a value as long as the transcript",
			async () => {
				expect(SESSION.length).toBeGreaterThan(MYSQL_PATH_CHARS - STAGING_SUFFIX_CHARS);
				expect(SESSION.length).toBeLessThanOrEqual(MYSQL_PATH_CHARS);
				const table = `omp_mysql_long_path_${process.pid}_${Date.now().toString(36)}`;
				const client = new SQL(MYSQL_URL ?? "");
				const cwd = TempDir.createSync("@omp-mysql-long-path-cwd-");
				cleanups.push(async () => {
					for (const suffix of ["_refs", "_blobs", "_parts", ""]) {
						await client.unsafe(`DROP TABLE IF EXISTS ${table}${suffix}`);
					}
					await client.end();
					cwd.removeSync();
				});
				const seeding = await SqlSessionStorage.create({ client, table });
				expect(seeding.adapter).toBe("mysql");
				await seeding.writeText(SESSION, transcriptLines(cwd.path(), TRANSCRIPT_BYTES).join(""));
				await seeding.drain();

				const longest = new Longest();
				const storage = await openWatched({ client, table }, longest);
				const manager = await SessionManager.open(SESSION, undefined, storage, { suppressBreadcrumb: true });
				cleanups.push(() => manager.close().catch(() => {}));
				const ids = manager.getEntries().map(entry => entry.id);
				longest.reset();

				await manager.rewriteEntries();
				await storage.drain();

				expect({ largest: longest.what, bytes: longest.bytes, bounded: longest.bytes <= BOUND }).toMatchObject({
					bounded: true,
				});
				const fresh = await SqlSessionStorage.create({ client, table });
				const stored = await storedDigest(fresh, SESSION);
				const reopened = await SessionManager.open(SESSION, undefined, fresh, { suppressBreadcrumb: true });
				cleanups.push(() => reopened.close().catch(() => {}));
				expect({ bytes: stored.bytes, ids: reopened.getEntries().map(entry => entry.id) }).toEqual({
					bytes: fresh.statSync(SESSION).size,
					ids,
				});
			},
			TIMEOUT,
		);
	},
);
