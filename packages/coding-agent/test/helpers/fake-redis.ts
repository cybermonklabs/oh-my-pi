/**
 * An in-memory double of the Redis server `RedisSessionStorage` talks to, so its tests run without a live server.
 * It mirrors only the surface the storage uses: the client methods, and each script the storage sends, answered by
 * the marker on the script's first line (`-- OMP_…`) with what that script does on a server. A test reads and
 * writes keys as another client would with the few `bun` RedisClient methods it also answers (`exists`, `del`,
 * `hget`, `hset`, `hdel`), or through its two maps. Each key is a string or a hash, as the storage keeps it: the
 * fake does not answer a command on a key of the other type with the WRONGTYPE error a server gives.
 */
import type { RedisSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";

export interface FakeRedisCall {
	method: string;
	args: unknown[];
}

export interface FakeRedis extends RedisSessionStorageClient {
	/** Every call the client got, in order: a script as `send` with its command and arguments. */
	calls: FakeRedisCall[];
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
	/**
	 * Fail the next call to `method` with `error`: a client method, or a write command a script runs (in lower
	 * case), which fails that script at that command: the script's commands before it stay as they ran, as on a
	 * server.
	 */
	failNext(method: string, error: Error): void;
	exists(key: string): Promise<boolean>;
	del(...keys: string[]): Promise<number>;
	hget(key: string, field: string): Promise<string | null>;
	hset(key: string, field: string, value: string): Promise<number>;
	hdel(key: string, ...fields: string[]): Promise<number>;
}

/** A script's run, given its keys and its arguments; a missing hash field is null, as a script's nil reply is. */
type FakeScript = (keys: string[], argv: string[]) => unknown;

/** A write a script runs: its command, in lower case, and what it does. */
type FakeWrite = readonly [command: string, write: () => void];

/**
 * A fake server over two maps. It answers each script the storage sends by the marker on the script's first line,
 * doing in TypeScript what that script does on a server.
 */
export function createFakeRedis(): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();
	const calls: FakeRedisCall[] = [];
	const failures = new Map<string, Error[]>();

	const checkFailure = (method: string): void => {
		const error = failures.get(method)?.shift();
		if (error) throw error;
	};

	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args });
	};

	/** Set `field` of the hash `key`; whether the field is new. */
	const setField = (key: string, field: string, value: string): boolean => {
		let hash = hashes.get(key);
		if (!hash) {
			hash = new Map();
			hashes.set(key, hash);
		}
		const added = !hash.has(field);
		hash.set(field, value);
		return added;
	};

	/** Delete `field` of the hash `key`, and the hash with its last field as Redis does; whether there was one. */
	const deleteField = (key: string, field: string): boolean => {
		const hash = hashes.get(key);
		if (!hash?.delete(field)) return false;
		if (hash.size === 0) hashes.delete(key);
		return true;
	};

	/** Delete `key`, whatever it holds; whether it held anything. */
	const deleteKey = (key: string): boolean => {
		const string = strings.delete(key);
		const hash = hashes.delete(key);
		return string || hash;
	};

	const byteLength = (key: string): number => Buffer.byteLength(strings.get(key) ?? "", "utf-8");

	/**
	 * GETRANGE's bytes of `key` from `start` through `end`, as Redis cuts them: a negative index counts from the end,
	 * then each is clamped to the value.
	 */
	const byteRange = (key: string, start: number, end: number): string => {
		if (!Number.isInteger(start) || !Number.isInteger(end)) {
			throw new Error("ERR value is not an integer or out of range");
		}
		const bytes = Buffer.from(strings.get(key) ?? "", "utf-8");
		if (start < 0 && end < 0 && start > end) return "";
		const from = Math.max(0, start < 0 ? bytes.length + start : start);
		const to = Math.min(bytes.length - 1, Math.max(0, end < 0 ? bytes.length + end : end));
		return from > to ? "" : bytes.subarray(from, to + 1).toString("utf-8");
	};

	/**
	 * The keys a `SCAN MATCH` pattern matches, for the one form the storage sends: a prefix with each of its glob
	 * characters escaped by `\`, then `*`. Any other pattern throws instead of answering as a server might not.
	 */
	const keysMatching = (pattern: string): string[] => {
		if (!/^(?:\\.|[^\\*?[\]])*\*$/s.test(pattern)) {
			throw new Error(`The fake matches only an escaped prefix and "*", not: ${pattern}`);
		}
		const prefix = pattern.slice(0, -1).replace(/\\(.)/gs, "$1");
		return [...new Set([...strings.keys(), ...hashes.keys()])].filter(key => key.startsWith(prefix));
	};

	/**
	 * Run a script's writes in order, each just after it meets the failure a test set for its command. A failure
	 * fails the script there, and the writes before it stay as they ran, as on a server.
	 */
	const runWrites = (writes: readonly FakeWrite[]): void => {
		for (const [command, write] of writes) {
			checkFailure(command);
			write();
		}
	};

	/** What each script does, by its marker, as the storage's script with that marker does it. */
	const scripts: Record<string, FakeScript> = {
		"-- OMP_WRITE_FULL": ([fileKey, metaKey, titleKey], [content, path, mtimeMs, hasTitle, title, expected]) => {
			const actual = strings.has(fileKey) ? byteLength(fileKey) : -1;
			if (expected !== "" && Number(expected) !== actual) return [0, actual];
			runWrites([
				[
					"set",
					() => {
						hashes.delete(fileKey);
						strings.set(fileKey, content);
					},
				],
				["hset", () => setField(metaKey, path, mtimeMs)],
				hasTitle === "1"
					? ["hset", () => setField(titleKey, path, title)]
					: ["hdel", () => deleteField(titleKey, path)],
			]);
			return [1, Buffer.byteLength(content, "utf-8")];
		},
		"-- OMP_APPEND": ([fileKey, metaKey, titleKey], [line, path, mtimeMs]) => {
			const writes: FakeWrite[] = [];
			if (!strings.has(fileKey)) writes.push(["hdel", () => deleteField(titleKey, path)]);
			writes.push(
				["append", () => strings.set(fileKey, (strings.get(fileKey) ?? "") + line)],
				["hset", () => setField(metaKey, path, mtimeMs)],
			);
			runWrites(writes);
			return byteLength(fileKey);
		},
		"-- OMP_UPDATE_TITLE": ([metaKey, titleKey, fileKey], [path, mtimeMs, title]) => {
			if (!strings.has(fileKey)) return 0;
			runWrites([
				["hset", () => setField(metaKey, path, mtimeMs)],
				["hset", () => setField(titleKey, path, title)],
			]);
			return 1;
		},
		"-- OMP_READ_FULL": ([fileKey, titleKey], [path]) => {
			const text = strings.get(fileKey);
			return text === undefined ? null : [text, hashes.get(titleKey)?.get(path) ?? null];
		},
		"-- OMP_READ_SLICES": ([fileKey, titleKey], [path, prefix, suffix]) => {
			if (!strings.has(fileKey)) return null;
			const head = Number(prefix) > 0 ? byteRange(fileKey, 0, Number(prefix) - 1) : "";
			const tail = Number(suffix) > 0 ? byteRange(fileKey, -Number(suffix), -1) : "";
			return [head, tail, hashes.get(titleKey)?.get(path) ?? null];
		},
		"-- OMP_MOVE": ([srcKey, dstKey, metaKey, titleKey], [src, dst, mtimeMs, noReplace]) => {
			if (noReplace === "1" && strings.has(dstKey)) return 0;
			const title = hashes.get(titleKey)?.get(src);
			const content = strings.get(srcKey);
			if (content === undefined) {
				// The RENAME, the script's first write, fails there: as the test set, else as Redis does.
				checkFailure("rename");
				throw new Error("ERR no such key");
			}
			runWrites([
				[
					"rename",
					() => {
						strings.delete(srcKey);
						strings.set(dstKey, content);
					},
				],
				["hdel", () => deleteField(metaKey, src)],
				["hset", () => setField(metaKey, dst, mtimeMs)],
				["hdel", () => deleteField(titleKey, src)],
				title === undefined
					? ["hdel", () => deleteField(titleKey, dst)]
					: ["hset", () => setField(titleKey, dst, title)],
			]);
			return 1;
		},
		"-- OMP_REMOVE": ([metaKey, titleKey], [prefix, pattern, ...given]) => {
			const paths = [...given];
			if (pattern) for (const key of keysMatching(pattern)) paths.push(key.slice(prefix.length));
			runWrites([
				...paths.map((path): FakeWrite => ["del", () => deleteKey(prefix + path)]),
				...paths.flatMap((path): FakeWrite[] => [
					["hdel", () => deleteField(metaKey, path)],
					["hdel", () => deleteField(titleKey, path)],
				]),
			]);
			return paths.length;
		},
	};

	const client: FakeRedis = {
		calls,
		strings,
		hashes,
		failNext(method: string, error: Error): void {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		async send(command, args) {
			record("send", [command, args]);
			checkFailure("send");
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			const [source = "", keyCount = ""] = args;
			const count = Number(keyCount);
			if (!Number.isInteger(count) || count < 0 || count > args.length - 2) {
				throw new Error("ERR Number of keys can't be greater than number of args");
			}
			const marker = source.split("\n")[0];
			if (!Object.hasOwn(scripts, marker)) throw new Error(`Unsupported Redis script: ${marker}`);
			const script = scripts[marker];
			return script(args.slice(2, 2 + count), args.slice(2 + count));
		},
		async get(key) {
			record("get", [key]);
			checkFailure("get");
			return strings.get(key) ?? null;
		},
		async getrange(key, start, end) {
			record("getrange", [key, start, end]);
			checkFailure("getrange");
			return byteRange(key, start, end);
		},
		async strlen(key) {
			record("strlen", [key]);
			checkFailure("strlen");
			return byteLength(key);
		},
		async set(key, value) {
			record("set", [key, value]);
			checkFailure("set");
			hashes.delete(key);
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			record("append", [key, value]);
			checkFailure("append");
			strings.set(key, (strings.get(key) ?? "") + value);
			return byteLength(key);
		},
		/** One batch of every key the pattern matches, so the cursor it replies is always "0". */
		async scan(cursor, ...args) {
			record("scan", [cursor, ...args]);
			checkFailure("scan");
			if (cursor !== "0") throw new Error(`The fake replies no cursor but "0", so it takes no other: ${cursor}`);
			const at = args.findIndex(arg => arg.toUpperCase() === "MATCH");
			const pattern = at < 0 ? "*" : args[at + 1];
			if (pattern === undefined) throw new Error("ERR syntax error");
			return ["0", keysMatching(pattern)];
		},
		async hgetall(key) {
			record("hgetall", [key]);
			checkFailure("hgetall");
			return Object.fromEntries(hashes.get(key) ?? []);
		},
		async exists(key) {
			record("exists", [key]);
			checkFailure("exists");
			return strings.has(key) || hashes.has(key);
		},
		async del(...keys) {
			record("del", keys);
			checkFailure("del");
			return keys.filter(deleteKey).length;
		},
		async hget(key, field) {
			record("hget", [key, field]);
			checkFailure("hget");
			return hashes.get(key)?.get(field) ?? null;
		},
		async hset(key, field, value) {
			record("hset", [key, field, value]);
			checkFailure("hset");
			return setField(key, field, value) ? 1 : 0;
		},
		async hdel(key, ...fields) {
			record("hdel", [key, ...fields]);
			checkFailure("hdel");
			return fields.filter(field => deleteField(key, field)).length;
		},
	};

	return client;
}
