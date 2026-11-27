import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageChunk,
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
	type SessionStorageReadTitle,
	type SessionStorageWindowRead,
} from "./indexed-session-storage";
import { UNVERSIONED } from "./redis-window-generation";
import { STALE_STAGING_MS, utf8Parts } from "./session-staging";
import { SessionReadConflictError, SessionWriteConflictError } from "./session-storage";
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
/** Bytes of each part a streamed full write appends to its staging key. */
const STAGING_PART_BYTES = 1024 * 1024;
/** Most bytes one window of a chunked read (`readChunks`) fetches. */
const READ_WINDOW_BYTES = 1024 * 1024;

// Redis keeps what a script wrote before one of its commands failed, so each
// script that writes hands every write it makes to `write_all`, after its
// reads. `write_all` takes the writes, each a command and its arguments as
// `redis.call` takes them, and before the first: reads each key a write
// changes with a command that fails on a key of another type (`HGET` of a
// hash, `STRLEN` of a string), and on Redis 7 and later asks the ACL whether
// the account may run each write (`redis.acl_check_cmd`, which runs nothing).
// It returns a NOPERM error reply, having written nothing, when one is
// denied; else it runs them in order. A key of another type or a refused read
// fails the script there, before any write.
const WRITE_ALL_LUA = `local function write_all(writes)
	for _, write in ipairs(writes) do
		if write[1] == "HSET" or write[1] == "HDEL" then
			redis.call("HGET", write[2], write[3])
		else
			redis.call("STRLEN", write[2])
			if write[1] == "RENAME" then
				redis.call("STRLEN", write[3])
			end
		end
	end
	if redis.acl_check_cmd then
		for _, write in ipairs(writes) do
			if not redis.acl_check_cmd(unpack(write)) then
				return redis.error_reply("NOPERM " .. write[1] .. " of " .. write[2] .. " denied; the script wrote nothing")
			end
		end
	end
	for _, write in ipairs(writes) do
		redis.call(unpack(write))
	end
end
`;

// Every script that writes a session's mtime keeps its write generation, the
// value `<token> <mtime>` under its path in the generation hash: a full write
// or a move gives it the new token its caller passes, an append or a title
// update keeps the token (see HELD_TOKEN), and a delete removes it. A
// chunked read compares the generation at each window (READ_WINDOW_SCRIPT).
//
// KEYS[1] is the file key, KEYS[2] the meta hash, KEYS[3] the title hash and
// KEYS[4] the generation hash; ARGV the content, the session's path, its
// mtime, "1" with its title metadata (else "0" and ""), the size the write
// expects the key to have ("" for any, -1 for none) and the new generation's
// token. A size other than the expected writes nothing and returns {0, the
// size or -1}.
const WRITE_FULL_SCRIPT = `-- OMP_WRITE_FULL
${WRITE_ALL_LUA}local expected = ARGV[6]
if expected ~= "" then
	local actual = -1
	if redis.call("EXISTS", KEYS[1]) == 1 then
		actual = redis.call("STRLEN", KEYS[1])
	end
	if actual ~= tonumber(expected) then
		return {0, actual}
	end
end
local title = {"HDEL", KEYS[3], ARGV[2]}
if ARGV[4] == "1" then
	title = {"HSET", KEYS[3], ARGV[2], ARGV[5]}
end
local denied = write_all({
	{"SET", KEYS[1], ARGV[1]},
	{"HSET", KEYS[2], ARGV[2], ARGV[3]},
	title,
	{"HSET", KEYS[4], ARGV[2], ARGV[7] .. " " .. ARGV[3]},
})
if denied then
	return denied
end
return {1, string.len(ARGV[1])}`;

// One part of a streamed full write: appended to the write's staging key,
// which then expires ARGV[2] ms later, so a killed writer's key goes.
const STAGE_PART_SCRIPT = `-- OMP_STAGE_PART
${WRITE_ALL_LUA}local denied = write_all({{"APPEND", KEYS[1], ARGV[1]}, {"PEXPIRE", KEYS[1], ARGV[2]}})
if denied then
	return denied
end
return redis.call("STRLEN", KEYS[1])`;

// One script, so the size check, the swap of the staging key (KEYS[1]) over
// the file key, and its mtime, title and generation run with no other
// client's command between. ARGV[5] is the expected size ("" for none, "-1"
// for no key), ARGV[6] the body's byte length, ARGV[7] the new generation's
// token. Returns {1, size} once swapped; {0, actual} when the size check
// refuses, and {-1, staged} when the staging key does not hold the body (it
// expired), both after deleting the staging key.
const WRITE_STAGED_SCRIPT = `-- OMP_WRITE_STAGED
${WRITE_ALL_LUA}local expected = ARGV[5]
if expected ~= "" then
	local actual = -1
	if redis.call("EXISTS", KEYS[2]) == 1 then
		actual = redis.call("STRLEN", KEYS[2])
	end
	if actual ~= tonumber(expected) then
		local denied = write_all({{"DEL", KEYS[1]}})
		if denied then
			return denied
		end
		return {0, actual}
	end
end
local staged = redis.call("STRLEN", KEYS[1])
if staged ~= tonumber(ARGV[6]) then
	local denied = write_all({{"DEL", KEYS[1]}})
	if denied then
		return denied
	end
	return {-1, staged}
end
local writes = {{"RENAME", KEYS[1], KEYS[2]}, {"PERSIST", KEYS[2]}}
if staged == 0 then
	writes = {{"SET", KEYS[2], ""}}
end
writes[#writes + 1] = {"HSET", KEYS[3], ARGV[1], ARGV[2]}
if ARGV[3] == "1" then
	writes[#writes + 1] = {"HSET", KEYS[4], ARGV[1], ARGV[4]}
else
	writes[#writes + 1] = {"HDEL", KEYS[4], ARGV[1]}
end
writes[#writes + 1] = {"HSET", KEYS[5], ARGV[1], ARGV[7] .. " " .. ARGV[2]}
local denied = write_all(writes)
if denied then
	return denied
end
return {1, staged}`;

// The token a session's generation holds: the one the generation hash holds,
// while the mtime recorded beside it is the one the meta hash holds; nil when
// not, because a write that keeps no generation (an earlier version's)
// changed the session since. An append or a title update keeps it, or takes
// the new token it was passed, before it sets the new mtime.
const HELD_TOKEN = `local function held_token(meta, generation, path)
	local held = redis.call("HGET", generation, path)
	if held then
		local token, mtime = string.match(held, "^(%S+) (.*)$")
		if token and mtime == redis.call("HGET", meta, path) then
			return token
		end
	end
	return nil
end`;

// KEYS[1] is the file key, KEYS[2] the meta hash, KEYS[3] the generation hash
// and KEYS[4] the title hash. An append that creates the key first deletes
// the title metadata its path may hold for no body (one an older build's
// title update stored after the session there was removed), so the session
// it starts shows no title it never had.
const APPEND_SCRIPT = `-- OMP_APPEND
${WRITE_ALL_LUA}${HELD_TOKEN}
local token = held_token(KEYS[2], KEYS[3], ARGV[2]) or ARGV[4]
local writes = {}
if redis.call("EXISTS", KEYS[1]) == 0 then
	writes[#writes + 1] = {"HDEL", KEYS[4], ARGV[2]}
end
writes[#writes + 1] = {"APPEND", KEYS[1], ARGV[1]}
writes[#writes + 1] = {"HSET", KEYS[2], ARGV[2], ARGV[3]}
writes[#writes + 1] = {"HSET", KEYS[3], ARGV[2], token .. " " .. ARGV[3]}
local denied = write_all(writes)
if denied then
	return denied
end
return redis.call("STRLEN", KEYS[1])`;

// KEYS[1] is the meta hash, KEYS[2] the title hash, KEYS[3] the generation
// hash and KEYS[4] the file key. Returns 0, and writes nothing, when the file
// key is missing: a store whose index still lists a session another store
// removed stores no title for a body that is gone.
const UPDATE_TITLE_SCRIPT = `-- OMP_UPDATE_TITLE
${WRITE_ALL_LUA}${HELD_TOKEN}
if redis.call("EXISTS", KEYS[4]) == 0 then
	return 0
end
local token = held_token(KEYS[1], KEYS[3], ARGV[1]) or ARGV[4]
local denied = write_all({
	{"HSET", KEYS[1], ARGV[1], ARGV[2]},
	{"HSET", KEYS[2], ARGV[1], ARGV[3]},
	{"HSET", KEYS[3], ARGV[1], token .. " " .. ARGV[2]},
})
if denied then
	return denied
end
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
// {head, tail, title metadata or nil}; nil when the key is missing, which
// reads as two empty windows and no title: title metadata without a body is
// no session's.
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

// The continuation bytes (10xxxxxx), at most three and none before byte
// floor, that run back from byte at to the byte that begins their character;
// 0 when byte at begins one, or when no such byte is found.
const BACK_TO_START = `local function back_to_start(at, floor)
	local probe = redis.call("GETRANGE", KEYS[1], math.max(floor, at - 3), at)
	local back = 0
	while back < 3 and #probe - back > 1 do
		local byte = string.byte(probe, #probe - back)
		if byte < 128 or byte >= 192 then
			break
		end
		back = back + 1
	end
	if back > 0 and string.byte(probe, #probe - back) >= 192 then
		return back
	end
	return 0
end`;

// One script, so the size, the bytes and the title metadata come from one
// read: no client's write lands between them. ARGV[1] is the first byte,
// ARGV[2] the most bytes to read ("" for the rest); KEYS[2] is the title hash
// and ARGV[3] the session's path in it. The bytes it returns start and end
// between characters, so they decode to a string and encode back to the same
// bytes: from the byte that begins the character byte ARGV[1] is in, through
// the continuation bytes that end the character the window's last byte is in
// (at most three each way, and none where the bytes are not UTF-8). Returns
// {size, those bytes, the title metadata or nil, the bytes they start before
// ARGV[1]}; nil when the key is missing.
const READ_FROM_SCRIPT = `-- OMP_READ_FROM
${BACK_TO_START}
if redis.call("EXISTS", KEYS[1]) == 0 then
	return false
end
local size = redis.call("STRLEN", KEYS[1])
local first = tonumber(ARGV[1])
local stop = size
if ARGV[2] ~= "" then
	stop = math.min(first + tonumber(ARGV[2]), size)
end
local text = ""
local before = 0
if first < stop then
	before = back_to_start(first, 0)
	local after = 0
	local rest = redis.call("GETRANGE", KEYS[1], stop, stop + 2)
	while after < #rest do
		local byte = string.byte(rest, after + 1)
		if byte < 128 or byte >= 192 then
			break
		end
		after = after + 1
	end
	text = redis.call("GETRANGE", KEYS[1], first - before, stop + after - 1)
end
return {size, text, redis.call("HGET", KEYS[2], ARGV[3]), before}`;

// One window of a chunked read: the key's size, the session's generation, and
// from byte ARGV[1] at most ARGV[2] bytes, up to ARGV[3], the size the read's
// first window saw ("" for the first window, which reads up to the size it
// finds). KEYS[2] is the meta hash, KEYS[3] the generation hash, KEYS[4] the
// title hash and ARGV[4] the session's path in them. The generation is its
// held token (see
// `HELD_TOKEN`), and `UNVERSIONED` when it holds none (a write that keeps no
// generation, an earlier version's, came after the last one that did):
// every write moves the mtime or the token, except an append or a title
// update made while the token holds, and an earlier version's write that
// sets the very mtime recorded, or that sets the bytes and the mtime in two
// commands with this window between
// them: a full write or an append of a release before v17.1.0 (commit
// 4bc68b45e25 made them one script), or a move onto the session by a build
// whose move is not one script (every upstream release through v19.1.1; this
// fork's since commit 3b60887237b is). Without a token the window also
// returns its SHA-1, which the check at the read's end (CHECK_WINDOWS_SCRIPT)
// compares; with one, "". A window starts and ends between characters, so
// its bytes decode to a string and encode back to the same bytes: a first
// window from inside a character starts at the byte that begins it (a later
// one starts where the last one ended), and a window that stops short of the
// read's end ends before the character its next byte continues, never as
// nothing (each backs over at most three continuation bytes, and not at all
// where the bytes are not UTF-8). Returns {size, generation, the window's
// byte length, its SHA-1 or "", the window, the bytes it starts before
// ARGV[1], the title metadata or nil}, the title read by the first window
// only (the read's start record gives it; a later window's reply has nil);
// {size} alone when the key is shorter than ARGV[3] now, and nil when it is
// missing.
const READ_WINDOW_SCRIPT = `-- OMP_READ_WINDOW
${HELD_TOKEN}
${BACK_TO_START}
if redis.call("EXISTS", KEYS[1]) == 0 then
	return false
end
local size = redis.call("STRLEN", KEYS[1])
local stop = size
if ARGV[3] ~= "" then
	stop = tonumber(ARGV[3])
	if size < stop then
		return {size}
	end
end
local generation = held_token(KEYS[2], KEYS[3], ARGV[4]) or "${UNVERSIONED}"
local title = false
if ARGV[3] == "" then
	title = redis.call("HGET", KEYS[4], ARGV[4])
end
local first = tonumber(ARGV[1])
if first >= stop then
	return {size, generation, 0, "", "", 0, title}
end
local start = first
if first > 0 and ARGV[3] == "" then
	start = first - back_to_start(first, 0)
end
local last = math.min(start + tonumber(ARGV[2]), stop) - 1
if last + 1 < stop then
	last = last - back_to_start(last + 1, start + 1)
end
local text = redis.call("GETRANGE", KEYS[1], start, last)
local digest = ""
if generation == "${UNVERSIONED}" then
	digest = redis.sha1hex(text)
end
return {size, generation, string.len(text), digest, text, first - start, title}`;

// The check at the end of a chunked read that found no generation, in one
// script, so it compares one state of the key: 1 when the key holds, from
// byte ARGV[4] on, the windows the read yielded, given as each one's byte
// length and SHA-1 in order (ARGV[5], ARGV[6], then the next window's), and
// its title hash (KEYS[2]) holds for the path ARGV[1] the title metadata the
// first window found (ARGV[2] "1" and the value ARGV[3]) or none (ARGV[2]
// "0"); 0 when it does not, or is gone.
const CHECK_WINDOWS_SCRIPT = `-- OMP_CHECK_WINDOWS
if redis.call("EXISTS", KEYS[1]) == 0 then
	return 0
end
local title = redis.call("HGET", KEYS[2], ARGV[1])
if (title ~= false) ~= (ARGV[2] == "1") or (title and title ~= ARGV[3]) then
	return 0
end
local at = tonumber(ARGV[4])
for i = 5, #ARGV, 2 do
	local length = tonumber(ARGV[i])
	local text = redis.call("GETRANGE", KEYS[1], at, at + length - 1)
	if string.len(text) ~= length or redis.sha1hex(text) ~= ARGV[i + 1] then
		return 0
	end
	at = at + length
end
return 1`;

// One script, so the key, its mtime, its title and its generation move
// together: no client's write to either path can land between them. KEYS are
// the source and destination file keys, the meta hash, the title hash and the
// generation hash; ARGV the source and destination paths, the destination's
// mtime, "1" when a taken destination leaves everything as it was (returns
// 0), and the destination's new generation token. A destination title the
// source has none for is deleted. A missing source fails the RENAME, its
// first write, so the script changes nothing.
const MOVE_SCRIPT = `-- OMP_MOVE
${WRITE_ALL_LUA}if ARGV[4] == "1" and redis.call("EXISTS", KEYS[2]) == 1 then
	return 0
end
local title = redis.call("HGET", KEYS[4], ARGV[1])
local destination = {"HDEL", KEYS[4], ARGV[2]}
if title then
	destination = {"HSET", KEYS[4], ARGV[2], title}
end
local denied = write_all({
	{"RENAME", KEYS[1], KEYS[2]},
	{"HDEL", KEYS[3], ARGV[1]},
	{"HSET", KEYS[3], ARGV[2], ARGV[3]},
	{"HDEL", KEYS[4], ARGV[1]},
	destination,
	{"HDEL", KEYS[5], ARGV[1]},
	{"HSET", KEYS[5], ARGV[2], ARGV[5] .. " " .. ARGV[3]},
})
if denied then
	return denied
end
return 1`;

// One script, so finding the keys under a directory, deleting them and
// deleting their mtime, title and generation run with no other client's
// command between: a child set after the scan cannot survive, a replacement
// written after the delete keeps its metadata, and a removal that fails
// removes no path (a session and its artifacts stay together for a retry).
// ARGV[1] is the file-key prefix, ARGV[2] a SCAN pattern for the directory
// ("" for none), ARGV[3..] explicit paths.
const REMOVE_SCRIPT = `-- OMP_REMOVE
${WRITE_ALL_LUA}local prefix = ARGV[1]
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
local writes = {}
for _, path in ipairs(paths) do
	writes[#writes + 1] = {"DEL", prefix .. path}
	writes[#writes + 1] = {"HDEL", KEYS[1], path}
	writes[#writes + 1] = {"HDEL", KEYS[2], path}
	writes[#writes + 1] = {"HDEL", KEYS[3], path}
end
local denied = write_all(writes)
if denied then
	return denied
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
 * without a time, as a SQL store's row without a title time has none. An empty title with a time is a clear.
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
 * The conflict a write script reports as `{0, actual}`: `actual` is the
 * session's byte length, or -1 when it has none; a reply that carries no
 * number there (NaN) reads as none too.
 */
function sizeConflict(path: string, expectedSize: number | null, actual: number): SessionWriteConflictError {
	return new SessionWriteConflictError(path, expectedSize, actual === -1 || !Number.isFinite(actual) ? null : actual);
}

/** A write script's `{status, size}` reply as two numbers, each NaN where the reply has no number. */
function writeReply(result: unknown): [status: number, size: number] {
	return Array.isArray(result) ? [Number(result[0]), Number(result[1])] : [Number.NaN, Number.NaN];
}

/**
 * Redis-backed implementation of {@link SessionStorage}. Each session JSONL
 * file maps to a Redis STRING key, with per-key metadata (mtime, title, and
 * the write generation a chunked read checks) tracked in sibling HASHes. This
 * process keeps only a metadata index (`size`, `mtimeMs`) in memory so
 * synchronous `existsSync` / `statSync` / `listFilesSync` calls remain
 * available without mirroring full content; every read takes the title
 * metadata in the script that reads the bytes. A full rewrite streams its body
 * in parts to a staging key of its own and swaps it in (see
 * `writeFullStream`), and a chunked read (`readChunks`), which the check
 * after a failed publish and the loaders of long sessions take, fetches the
 * stored text in windows of at most {@link READ_WINDOW_BYTES}, so neither
 * holds the body as one value.
 */
export class RedisSessionStorage extends IndexedSessionStorage {
	/** Always set: the Redis backend reads a session window by window. */
	declare readonly readChunks: (path: string, fromByte?: number) => AsyncIterable<Uint8Array>;
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

	/**
	 * The script's window, which starts and ends between characters so its
	 * text encodes back to its bytes, cut back to the bytes from `start`, at
	 * most `maxBytes` of them.
	 */
	async readFrom(path: string, start: number, maxBytes?: number): Promise<SessionStorageWindowRead | null> {
		const result = await this.#client.send("EVAL", [
			READ_FROM_SCRIPT,
			"2",
			this.#fileKey(path),
			this.#titleMetaKey(),
			String(start),
			maxBytes === undefined ? "" : String(maxBytes),
			path,
		]);
		if (!Array.isArray(result)) return null;
		const size = Number(result[0]);
		const end = maxBytes === undefined ? size : Math.min(start + maxBytes, size);
		const before = Number(result[3]);
		const bytes = Buffer.from(String(result[1]), "utf-8").subarray(before, before + Math.max(0, end - start));
		return { bytes, size, title: decodeTitleMeta(result[2]) };
	}

	/**
	 * The read's start record, with the title metadata its first window read,
	 * then the stored bytes from `fromByte`, a window of at most
	 * {@link READ_WINDOW_BYTES} per script (`READ_WINDOW_SCRIPT`), each window
	 * one chunk. A window starts and ends between characters, so its text
	 * decodes and encodes back to its bytes; a read from inside a character
	 * fetches that character whole and yields its bytes from `fromByte` on.
	 *
	 * The read stops at the size its first window saw, so an append made
	 * meanwhile is left out. Each later window fails the read with
	 * {@link SessionReadConflictError}, before it yields anything, when the key
	 * is gone or shorter than that size. When the first window found the
	 * session's generation token, a later window at another generation fails
	 * it too: a full write, a move or a delete gives the session a new token
	 * whatever bytes it leaves, and a write of an earlier version takes the
	 * token away (with the exceptions `READ_WINDOW_SCRIPT` names), so the
	 * windows the read yields come from the session as its first window saw
	 * it, title included (a title update keeps the token but no byte), and a
	 * read that its consumer stops early needs no check.
	 *
	 * When the first window found none (an earlier version wrote the session
	 * last), the read runs as it did before generations: a later window that
	 * finds a token (this version wrote since) fails it, an earlier version's
	 * append does not, and once the bytes the read yielded come from more than
	 * one window, one script at its end (`CHECK_WINDOWS_SCRIPT`) checks that
	 * the key holds them still, by each window's byte length and SHA-1, with
	 * the title the first window read. That check runs when the read ends, and
	 * also when its consumer closes it before that (a `break` out of its loop),
	 * whose `return()` then rejects with the conflict; a read that fails runs
	 * none. Such a read does not see an earlier version's rewrite to more bytes
	 * that keeps the windows it read and the title.
	 */
	async *readChunks(path: string, fromByte: number): AsyncGenerator<SessionStorageChunk> {
		const key = this.#fileKey(path);
		// The size, the generation and the title metadata (as the title hash holds it) the first window saw.
		let first: { stop: number; generation: string; title: unknown } | undefined;
		// The end check's arguments: the byte the first window starts at, then each window's byte length and SHA-1.
		const windows: string[] = [];
		let failed = false;
		try {
			let at = Math.max(0, Math.trunc(fromByte));
			do {
				const reply = await this.#client.send("EVAL", [
					READ_WINDOW_SCRIPT,
					"4",
					key,
					this.#metaKey(),
					this.#generationKey(),
					this.#titleMetaKey(),
					String(at),
					String(READ_WINDOW_BYTES),
					first === undefined ? "" : String(first.stop),
					path,
				]);
				if (!Array.isArray(reply)) {
					if (first === undefined) throw enoent(path);
					throw new SessionReadConflictError(path);
				}
				const size = Number(reply[0]);
				const generation = String(reply[1]);
				if (first === undefined) {
					first = { stop: size, generation, title: reply[6] };
					yield { title: decodeTitleMeta(first.title) };
				} else if (size < first.stop || generation !== first.generation) {
					// Without a token at either window both read `UNVERSIONED`, and the check at the read's end decides.
					throw new SessionReadConflictError(path);
				}
				const length = Number(reply[2]);
				if (length === 0) return;
				// Only a first window from inside a character starts before `at`.
				const before = Number(reply[5]);
				if (windows.length === 0) windows.push(String(at - before));
				windows.push(String(length), String(reply[3]));
				at += length - before;
				const bytes = Buffer.from(String(reply[4]), "utf8");
				yield before > 0 ? bytes.subarray(before) : bytes;
			} while (at < first.stop);
		} catch (err) {
			failed = true;
			throw err;
		} finally {
			// Without a token, more than one window: at the read's end, or where its consumer closed it, unless failing.
			if (!failed && first?.generation === UNVERSIONED && windows.length > 3) {
				await this.#confirmWindows(path, key, first.title, windows);
			}
		}
	}

	/**
	 * Fail with {@link SessionReadConflictError} unless `key` still holds the
	 * windows a {@link readChunks} of `path` yielded, and the title hash the
	 * `title` its first window read (a value, or none): `windows` is the byte
	 * the first one starts at, then each one's byte length and SHA-1.
	 */
	async #confirmWindows(path: string, key: string, title: unknown, windows: string[]): Promise<void> {
		const held = await this.#client.send("EVAL", [
			CHECK_WINDOWS_SCRIPT,
			"2",
			key,
			this.#titleMetaKey(),
			path,
			typeof title === "string" ? "1" : "0",
			typeof title === "string" ? title : "",
			...windows,
		]);
		if (Number(held) !== 1) throw new SessionReadConflictError(path);
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
			"4",
			this.#fileKey(path),
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#generationKey(),
			content,
			path,
			String(mtimeMs),
			title ? "1" : "0",
			title ? encodeTitleMeta(title) : "",
			expectedSize === undefined ? "" : String(expectedSize ?? -1),
			crypto.randomUUID(),
		]);
		if (expectedSize === undefined) return;
		const [status, size] = writeReply(result);
		if (status === 1) return;
		throw sizeConflict(path, expectedSize, size);
	}

	/**
	 * {@link writeFull} from a stream. Each part of at most
	 * {@link STAGING_PART_BYTES}, ending on a character boundary, is appended
	 * to a staging key of this write's alone, `<prefix>staging:<path>#<random
	 * UUID>`, which expires {@link STALE_STAGING_MS} after its last part, so a
	 * killed writer's goes; then one script checks the session's size, checks
	 * that the staging key holds the whole body, renames it over the file key
	 * and sets the mtime, title and generation. No other write knows the
	 * staging key, so none can rename it, and no listing sees it (they scan
	 * file keys). A failure deletes it and leaves the session as it was.
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
				"5",
				staging,
				this.#fileKey(path),
				this.#metaKey(),
				this.#titleMetaKey(),
				this.#generationKey(),
				path,
				String(mtimeMs),
				title ? "1" : "0",
				title ? encodeTitleMeta(title) : "",
				expectedSize === undefined ? "" : String(expectedSize ?? -1),
				String(byteLength),
				crypto.randomUUID(),
			]);
		} catch (err) {
			try {
				await this.#client.send("DEL", [staging]);
			} catch {
				// The write's own failure is the one to report; the staging key expires.
			}
			throw err;
		}
		const [status, size] = writeReply(result);
		if (status === 1) return;
		if (status === 0) throw sizeConflict(path, expectedSize ?? null, size);
		throw new Error(
			`RedisSessionStorage: the staging key of a full write of ${path} held ${size} bytes, not ${byteLength}`,
		);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			APPEND_SCRIPT,
			"4",
			this.#fileKey(path),
			this.#metaKey(),
			this.#generationKey(),
			this.#titleMetaKey(),
			line,
			path,
			String(mtimeMs),
			crypto.randomUUID(),
		]);
	}

	/** Rejects with `ENOENT`, storing nothing, when the store holds no session at `path`. */
	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		const updated = await this.#client.send("EVAL", [
			UPDATE_TITLE_SCRIPT,
			"4",
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#generationKey(),
			this.#fileKey(path),
			path,
			String(mtimeMs),
			encodeTitleMeta(title),
			crypto.randomUUID(),
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
			"3",
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#generationKey(),
			this.#fileKey(""),
			dir === undefined ? "" : keysStartingWith(this.#fileKey(dir)),
			...paths,
		]);
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		const moved = await this.#client.send("EVAL", [
			MOVE_SCRIPT,
			"5",
			this.#fileKey(src),
			this.#fileKey(dst),
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#generationKey(),
			src,
			dst,
			String(mtimeMs),
			noReplace ? "1" : "0",
			crypto.randomUUID(),
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

	/** The hash of each session's write generation, `<token> <mtime>`; see `WRITE_FULL_SCRIPT`. */
	#generationKey(): string {
		return `${this.#prefix}generation`;
	}
}
