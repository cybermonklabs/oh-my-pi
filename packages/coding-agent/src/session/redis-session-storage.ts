import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
	type SessionStorageReadTitle,
} from "./indexed-session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { eexist, enoent } from "./session-storage-errors";
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

// KEYS[1] is the file key, KEYS[2] the meta hash and KEYS[3] the title hash;
// ARGV the content, the session's path, its mtime, "1" with its title metadata
// (else "0" and ""), and the size the write expects the key to have ("" for
// any, -1 for none). A size other than the expected writes nothing and returns
// {0, the size or -1}.
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

// KEYS[1] is the file key, KEYS[2] the meta hash and KEYS[3] the title hash;
// ARGV the line, the session's path and its mtime. An append that creates the
// key first deletes the title metadata the path may still hold for no body (a
// title another store stored after the session there was removed), so the
// session it starts shows no title it never had.
const APPEND_SCRIPT = `-- OMP_APPEND
if redis.call("EXISTS", KEYS[1]) == 0 then
	redis.call("HDEL", KEYS[3], ARGV[2])
end
local size = redis.call("APPEND", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
return size`;

// KEYS[1] is the meta hash, KEYS[2] the title hash and KEYS[3] the file key;
// ARGV the session's path, its mtime and its title metadata. Returns 0, and
// writes nothing, when the key is missing: a store whose index still lists a
// session another store removed stores no title for a body that is gone.
const UPDATE_TITLE_SCRIPT = `-- OMP_UPDATE_TITLE
if redis.call("EXISTS", KEYS[3]) == 0 then
	return 0
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("HSET", KEYS[2], ARGV[1], ARGV[3])
return 1`;

// One script, so the value and its title metadata come from one read: no
// client's write lands between them. KEYS[2] is the title hash and ARGV[1] the
// session's path in it. Returns {the value, its title metadata or nil}; nil
// when the key is missing.
const READ_FULL_SCRIPT = `-- OMP_READ_FULL
local text = redis.call("GET", KEYS[1])
if not text then
	return false
end
return {text, redis.call("HGET", KEYS[2], ARGV[1])}`;

// One script, so both windows and the title metadata come from one read.
// KEYS[2] is the title hash and ARGV[1] the session's path in it; ARGV[2] is
// the head's byte count and ARGV[3] the tail's, each 0 for none. Returns
// {head, tail, title metadata or nil}; nil when the key is missing, read as two
// empty windows and no title: title metadata without a body is no session's.
const READ_SLICES_SCRIPT = `-- OMP_READ_SLICES
if redis.call("EXISTS", KEYS[1]) == 0 then
	return false
end
local head = ""
local prefix = tonumber(ARGV[2])
if prefix > 0 then
	head = redis.call("GETRANGE", KEYS[1], 0, prefix - 1)
end
local tail = ""
local suffix = tonumber(ARGV[3])
if suffix > 0 then
	tail = redis.call("GETRANGE", KEYS[1], -suffix, -1)
end
return {head, tail, redis.call("HGET", KEYS[2], ARGV[1])}`;

// One script, so the key, its mtime and its title move together: no client's
// write to either path can land between them. KEYS are the source and
// destination file keys, the meta hash and the title hash; ARGV the source and
// destination paths, the destination's mtime, and "1" when a taken
// destination leaves everything as it was (returns 0). A destination title the
// source has none for is deleted. A missing source fails the RENAME, its
// first write, so the script changes nothing.
const MOVE_SCRIPT = `-- OMP_MOVE
if ARGV[4] == "1" and redis.call("EXISTS", KEYS[2]) == 1 then
	return 0
end
local title = redis.call("HGET", KEYS[4], ARGV[1])
redis.call("RENAME", KEYS[1], KEYS[2])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("HSET", KEYS[3], ARGV[2], ARGV[3])
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
// SCAN pattern for the directory ("" for none), ARGV[3..] explicit paths. It
// deletes every key it found or was given before any metadata. Files beside
// the store (the artifacts directory on disk) are the caller's, removed after
// the script.
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
end
for _, path in ipairs(paths) do
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

/**
 * The title metadata a value of the title hash holds, as a script returns it (nil as null): none when malformed or
 * without a time. An empty title with a time is a clear.
 */
function decodeTitleMeta(raw: unknown): SessionTitleUpdate | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) return undefined;
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
 * file maps to a Redis STRING key, with per-key metadata (mtime, title)
 * tracked in sibling HASHes. This process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory so synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls remain available without mirroring full content; every
 * read takes the title metadata in the script that reads the bytes.
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
		const meta: Record<string, string> = metaRaw ?? {};
		const seen = await this.#scanFileKeys(filePrefix);

		const fallbackMtimeMs = Date.now();
		return Promise.all(
			Array.from(seen, async key => {
				const path = key.slice(filePrefix.length);
				const size = await this.#client.strlen(key);
				const rawMtime = meta[path];
				const parsedMtime = rawMtime === undefined ? Number.NaN : Number(rawMtime);
				return { path, size, mtimeMs: Number.isFinite(parsedMtime) ? parsedMtime : fallbackMtimeMs };
			}),
		);
	}

	async readFull(path: string): Promise<SessionStorageFullRead | null> {
		const reply = await this.#client.send("EVAL", [
			READ_FULL_SCRIPT,
			"2",
			this.#fileKey(path),
			this.#titleMetaKey(),
			path,
		]);
		if (!Array.isArray(reply)) return null;
		return { text: String(reply[0]), title: decodeTitleMeta(reply[1]) };
	}

	async readSlices(
		path: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[prefix: string, suffix: string, title: SessionStorageReadTitle]> {
		const reply = await this.#client.send("EVAL", [
			READ_SLICES_SCRIPT,
			"2",
			this.#fileKey(path),
			this.#titleMetaKey(),
			path,
			String(prefixBytes),
			String(suffixBytes),
		]);
		if (!Array.isArray(reply)) return ["", "", undefined];
		return [String(reply[0] ?? ""), String(reply[1] ?? ""), decodeTitleMeta(reply[2])];
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

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			APPEND_SCRIPT,
			"3",
			this.#fileKey(path),
			this.#metaKey(),
			this.#titleMetaKey(),
			line,
			path,
			String(mtimeMs),
		]);
	}

	/** Rejects with `ENOENT`, storing nothing, when the store holds no session at `path`. */
	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		const updated = await this.#client.send("EVAL", [
			UPDATE_TITLE_SCRIPT,
			"3",
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#fileKey(path),
			path,
			String(mtimeMs),
			encodeTitleMeta(title),
		]);
		if (Number(updated) !== 1) throw enoent(path);
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
