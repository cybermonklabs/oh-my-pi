import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
	utf8Parts,
} from "./indexed-session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { eexist } from "./session-storage-errors";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Minimal subset of the `bun:redis` `RedisClient` surface used by
 * {@link RedisSessionStorage}. Keeping the contract narrow (and accepting any
 * client that conforms) lets callers swap in test doubles or shared clients
 * without dragging the entire Bun typings into this module.
 */
export interface RedisSessionStorageClient {
	send(command: string, args: string[]): Promise<unknown>;
	get(key: string): Promise<string | null>;
	getrange(key: string, start: number, end: number): Promise<string>;
	strlen(key: string): Promise<number>;
	set(key: string, value: string): Promise<unknown>;
	append(key: string, value: string): Promise<number>;
	scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
	hgetall(key: string): Promise<Record<string, string>>;
}

export interface RedisSessionStorageOptions {
	/** A connected `bun:redis` RedisClient (or any compatible adapter). */
	client: RedisSessionStorageClient;
	/**
	 * Key prefix applied to every Redis key this storage owns. Default `omp:sessions:`.
	 * Trailing colon is preserved verbatim — set to a project-scoped prefix to share
	 * one Redis instance between multiple agents.
	 */
	prefix?: string;
	/**
	 * Maximum number of keys returned per SCAN batch when warming the metadata index.
	 * Default 500.
	 */
	scanCount?: number;
}

const DEFAULT_PREFIX = "omp:sessions:";
const DEFAULT_SCAN_COUNT = 500;
/** Bytes of each part a streamed full write appends to its staging key. */
const STAGING_PART_BYTES = 1024 * 1024;
/** How long a staging key lives after its last part: a live full write finishes far sooner. */
const STALE_STAGING_MS = 60 * 60 * 1000;

const WRITE_FULL_SCRIPT = `-- OMP_WRITE_FULL
local expected = ARGV[6]
if expected ~= "" then
	local actual = -1
	if redis.call("EXISTS", KEYS[1]) == 1 then
		actual = redis.call("STRLEN", KEYS[1])
	end
	if actual ~= tonumber(expected) then
		return {0, actual}
	end
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
if ARGV[4] == "1" then
	redis.call("HSET", KEYS[3], ARGV[2], ARGV[5])
else
	redis.call("HDEL", KEYS[3], ARGV[2])
end
return {1, string.len(ARGV[1])}`;

// One part of a streamed full write: appended to the write's staging key,
// which then expires ARGV[2] ms later, so a killed writer's key goes.
const STAGE_PART_SCRIPT = `-- OMP_STAGE_PART
local size = redis.call("APPEND", KEYS[1], ARGV[1])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return size`;

// One script, so the size check, the swap of the staging key (KEYS[1]) over
// the file key, and its mtime and title run with no other client's command
// between. ARGV[5] is the expected size ("" for none, "-1" for no key),
// ARGV[6] the body's byte length. Returns {1, size} once swapped; {0, actual}
// when the size check refuses, and {-1, staged} when the staging key does not
// hold the body (it expired), both after deleting the staging key.
const WRITE_STAGED_SCRIPT = `-- OMP_WRITE_STAGED
local expected = ARGV[5]
if expected ~= "" then
	local actual = -1
	if redis.call("EXISTS", KEYS[2]) == 1 then
		actual = redis.call("STRLEN", KEYS[2])
	end
	if actual ~= tonumber(expected) then
		redis.call("DEL", KEYS[1])
		return {0, actual}
	end
end
local staged = redis.call("STRLEN", KEYS[1])
if staged ~= tonumber(ARGV[6]) then
	redis.call("DEL", KEYS[1])
	return {-1, staged}
end
if staged == 0 then
	redis.call("SET", KEYS[2], "")
else
	redis.call("RENAME", KEYS[1], KEYS[2])
	redis.call("PERSIST", KEYS[2])
end
redis.call("HSET", KEYS[3], ARGV[1], ARGV[2])
if ARGV[3] == "1" then
	redis.call("HSET", KEYS[4], ARGV[1], ARGV[4])
else
	redis.call("HDEL", KEYS[4], ARGV[1])
end
return {1, staged}`;

const APPEND_SCRIPT = `-- OMP_APPEND
local size = redis.call("APPEND", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
return size`;

const UPDATE_TITLE_SCRIPT = `-- OMP_UPDATE_TITLE
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("HSET", KEYS[2], ARGV[1], ARGV[3])
return 1`;

// One script, so the size and the bytes come from one read: no client's write
// lands between them. ARGV[1] is the first byte, ARGV[2] the last ("-1" for
// the end, "" for none); a missing key returns nil.
const READ_FROM_SCRIPT = `-- OMP_READ_FROM
if redis.call("EXISTS", KEYS[1]) == 0 then
	return false
end
local text = ""
if ARGV[2] ~= "" then
	text = redis.call("GETRANGE", KEYS[1], ARGV[1], ARGV[2])
end
return {redis.call("STRLEN", KEYS[1]), text}`;

// One script, so the key, its mtime and its title move together: no client's
// write to either path can land between them. With ARGV[4] == "1" a taken
// destination leaves everything as it was (returns 0).
const MOVE_SCRIPT = `-- OMP_MOVE
if ARGV[4] == "1" and redis.call("EXISTS", KEYS[2]) == 1 then
	return 0
end
redis.call("RENAME", KEYS[1], KEYS[2])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("HSET", KEYS[3], ARGV[2], ARGV[3])
local title = redis.call("HGET", KEYS[4], ARGV[1])
redis.call("HDEL", KEYS[4], ARGV[1])
if title then
	redis.call("HSET", KEYS[4], ARGV[2], title)
else
	redis.call("HDEL", KEYS[4], ARGV[2])
end
return 1`;

// One script, so finding the keys under a directory, deleting them and
// deleting their mtime and title run with no other client's command between:
// a child set after the scan cannot survive, and a replacement written after
// the delete keeps its metadata. ARGV[1] is the file-key prefix, ARGV[2] a
// SCAN pattern for the directory ("" for none), ARGV[3..] explicit paths.
const REMOVE_SCRIPT = `-- OMP_REMOVE
local prefix = ARGV[1]
local paths = {}
for i = 3, #ARGV do
	paths[#paths + 1] = ARGV[i]
end
if ARGV[2] ~= "" then
	local cursor = "0"
	repeat
		local reply = redis.call("SCAN", cursor, "MATCH", ARGV[2], "COUNT", 1000)
		cursor = reply[1]
		for _, key in ipairs(reply[2]) do
			paths[#paths + 1] = string.sub(key, #prefix + 1)
		end
	until cursor == "0"
end
for _, path in ipairs(paths) do
	redis.call("DEL", prefix .. path)
	redis.call("HDEL", KEYS[1], path)
	redis.call("HDEL", KEYS[2], path)
end
return #paths`;

/** A `SCAN MATCH` glob for the keys starting with `prefix`, its glob characters escaped. */
function keysStartingWith(prefix: string): string {
	return `${prefix.replace(/[*?[\]\\]/g, "\\$&")}*`;
}

function encodeTitleMeta(title: SessionTitleUpdate): string {
	return JSON.stringify(title);
}

function decodeTitleMeta(raw: string | undefined): SessionTitleUpdate | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.updatedAt !== "string") return undefined;
		const source = record.source === "auto" || record.source === "user" ? record.source : undefined;
		return {
			title: typeof record.title === "string" ? record.title : undefined,
			source,
			updatedAt: record.updatedAt,
		};
	} catch {
		return undefined;
	}
}

/**
 * Redis-backed implementation of {@link SessionStorage}. Each session JSONL
 * file maps to a Redis STRING key, with per-key metadata (mtime) tracked in a
 * single sibling HASH. This process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory so synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls remain available without mirroring full content. A
 * full rewrite streams in parts to a staging key of its own and swaps it in
 * (see `writeFullStream`), so the transcript is never one value here.
 */
export class RedisSessionStorage extends IndexedSessionStorage {
	/**
	 * Warm the metadata index with every existing session key under the configured
	 * prefix and return the ready-to-use storage. Must be awaited before passing
	 * the storage into `SessionManager.create()` so synchronous lookups (session
	 * resume, recent sessions, EPERM-backup recovery) see the existing keyspace.
	 */
	static async create(options: RedisSessionStorageOptions): Promise<RedisSessionStorage> {
		const storage = new RedisSessionStorage(new RedisSessionStorageBackend(options));
		await storage.initialize();
		return storage;
	}
}

class RedisSessionStorageBackend implements SessionStorageBackend {
	readonly #client: RedisSessionStorageClient;
	readonly #prefix: string;
	readonly #scanCount: number;

	constructor(options: RedisSessionStorageOptions) {
		this.#client = options.client;
		this.#prefix = options.prefix ?? DEFAULT_PREFIX;
		this.#scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const filePrefix = this.#fileKey("");
		const metaRaw = await this.#client.hgetall(this.#metaKey());
		const titleRaw = await this.#client.hgetall(this.#titleMetaKey());
		const meta: Record<string, string> = metaRaw ?? {};
		const titles: Record<string, string> = titleRaw ?? {};
		const seen = await this.#scanFileKeys(filePrefix);

		const fallbackMtimeMs = Date.now();
		return Promise.all(
			Array.from(seen, async key => {
				const path = key.slice(filePrefix.length);
				const size = await this.#client.strlen(key);
				const rawMtime = meta[path];
				const parsedMtime = rawMtime === undefined ? Number.NaN : Number(rawMtime);
				const title = decodeTitleMeta(titles[path]);
				return {
					path,
					size,
					mtimeMs: Number.isFinite(parsedMtime) ? parsedMtime : fallbackMtimeMs,
					title: title?.title,
					titleSource: title?.source,
					titleUpdatedAt: title?.updatedAt,
				};
			}),
		);
	}

	readFull(path: string): Promise<string | null> {
		return this.#client.get(this.#fileKey(path));
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const key = this.#fileKey(path);
		const head = prefixBytes > 0 ? this.#client.getrange(key, 0, prefixBytes - 1) : Promise.resolve("");
		const tail = suffixBytes > 0 ? this.#client.getrange(key, -suffixBytes, -1) : Promise.resolve("");
		return Promise.all([head, tail]);
	}

	async readFrom(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null> {
		const take = maxBytes === undefined ? undefined : Math.max(0, Math.trunc(maxBytes));
		const last = take === undefined ? "-1" : take === 0 ? "" : String(offset + take - 1);
		const result = await this.#client.send("EVAL", [
			READ_FROM_SCRIPT,
			"1",
			this.#fileKey(path),
			String(offset),
			last,
		]);
		if (!Array.isArray(result)) return null;
		return { text: String(result[1]), size: Number(result[0]) };
	}

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const result = await this.#client.send("EVAL", [
			WRITE_FULL_SCRIPT,
			"3",
			this.#fileKey(path),
			this.#metaKey(),
			this.#titleMetaKey(),
			content,
			path,
			String(mtimeMs),
			title ? "1" : "0",
			title ? encodeTitleMeta(title) : "",
			expectedSize === undefined ? "" : String(expectedSize ?? -1),
		]);
		if (expectedSize === undefined) return;
		const written = Array.isArray(result) && Number(result[0]) === 1;
		if (written) return;
		const encodedActual = Array.isArray(result) ? Number(result[1]) : Number.NaN;
		const actualSize = encodedActual === -1 ? null : Number.isFinite(encodedActual) ? encodedActual : null;
		throw new SessionWriteConflictError(path, expectedSize, actualSize);
	}

	/**
	 * {@link writeFull} from a stream. Each part of at most
	 * {@link STAGING_PART_BYTES}, ending on a character boundary, is appended
	 * to a staging key of this write's alone, `<prefix>staging:<path>#<random
	 * UUID>`, which expires {@link STALE_STAGING_MS} after its last part, so a
	 * killed writer's goes; then one script checks the session's size, checks
	 * that the staging key holds the whole body, renames it over the file key
	 * and sets the mtime and title. No other write knows the staging key, so
	 * none can rename it, and no listing sees it (they scan file keys). A
	 * failure deletes it and leaves the session as it was.
	 */
	async writeFullStream(
		path: string,
		chunks: AsyncIterable<Uint8Array>,
		byteLength: number,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const staging = `${this.#prefix}staging:${path}#${crypto.randomUUID()}`;
		let result: unknown;
		try {
			let staged = 0;
			for await (const part of utf8Parts(chunks, STAGING_PART_BYTES)) {
				await this.#client.send("EVAL", [STAGE_PART_SCRIPT, "1", staging, part.text, String(STALE_STAGING_MS)]);
				staged += part.byteLength;
			}
			if (staged !== byteLength) {
				throw new Error(`RedisSessionStorage: a full write of ${path} streamed ${staged} bytes, not ${byteLength}`);
			}
			result = await this.#client.send("EVAL", [
				WRITE_STAGED_SCRIPT,
				"4",
				staging,
				this.#fileKey(path),
				this.#metaKey(),
				this.#titleMetaKey(),
				path,
				String(mtimeMs),
				title ? "1" : "0",
				title ? encodeTitleMeta(title) : "",
				expectedSize === undefined ? "" : String(expectedSize ?? -1),
				String(byteLength),
			]);
		} catch (err) {
			try {
				await this.#client.send("DEL", [staging]);
			} catch {
				// The write's own failure is the one to report; the staging key expires.
			}
			throw err;
		}
		const [status, size] = Array.isArray(result) ? result.map(Number) : [Number.NaN, Number.NaN];
		if (status === 1) return;
		if (status === 0) throw new SessionWriteConflictError(path, expectedSize ?? null, size === -1 ? null : size);
		throw new Error(
			`RedisSessionStorage: the staging key of a full write of ${path} held ${size} bytes, not ${byteLength}`,
		);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			APPEND_SCRIPT,
			"2",
			this.#fileKey(path),
			this.#metaKey(),
			line,
			path,
			String(mtimeMs),
		]);
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			UPDATE_TITLE_SCRIPT,
			"2",
			this.#metaKey(),
			this.#titleMetaKey(),
			path,
			String(mtimeMs),
			encodeTitleMeta(title),
		]);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[], dir?: string): Promise<void> {
		if (paths.length === 0 && dir === undefined) return;
		await this.#client.send("EVAL", [
			REMOVE_SCRIPT,
			"2",
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#fileKey(""),
			dir === undefined ? "" : keysStartingWith(this.#fileKey(dir)),
			...paths,
		]);
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		const moved = await this.#client.send("EVAL", [
			MOVE_SCRIPT,
			"4",
			this.#fileKey(src),
			this.#fileKey(dst),
			this.#metaKey(),
			this.#titleMetaKey(),
			src,
			dst,
			String(mtimeMs),
			noReplace ? "1" : "0",
		]);
		if (Number(moved) !== 1) throw eexist(dst);
	}

	/** Every file key starting with `keyPrefix`. */
	async #scanFileKeys(keyPrefix: string): Promise<Set<string>> {
		const pattern = keysStartingWith(keyPrefix);
		const keys = new Set<string>();
		let cursor = "0";
		do {
			const [next, batch] = await this.#client.scan(cursor, "MATCH", pattern, "COUNT", String(this.#scanCount));
			cursor = next;
			for (const key of batch) keys.add(key);
		} while (cursor !== "0");
		return keys;
	}

	#fileKey(path: string): string {
		return `${this.#prefix}file:${path}`;
	}

	#metaKey(): string {
		return `${this.#prefix}meta`;
	}

	#titleMetaKey(): string {
		return `${this.#prefix}title`;
	}
}
