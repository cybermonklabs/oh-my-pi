/**
 * An in-memory double of the Redis server `RedisSessionStorage` talks to, so its tests run without a live server.
 * It mirrors only the surface the storage uses: the client methods, the `DEL` it sends with `send`, and each script
 * the storage sends, answered by the marker on the script's first line (`-- OMP_…`) with what that script does on a
 * server. A test reads and writes keys as another client would with the few `bun` RedisClient methods it also
 * answers (`exists`, `del`, `hget`, `hset`, `hdel`), or through its two maps. Each key is a string or a hash, as the
 * storage keeps it: the fake does not answer a command on a key of the other type with the WRONGTYPE error a server
 * gives, and it keeps no expiry, so a streamed write's staging key stays until a script deletes or renames it.
 */
import type { RedisSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { UNVERSIONED } from "@oh-my-pi/pi-coding-agent/session/redis-window-generation";

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
	 * Fail the next call to `method` with `error`: a client method, or a command a script runs (in lower case). A
	 * script's write command fails the script there, and the script's commands before it stay as they ran, as on a
	 * server, which does not undo them; `hget` fails a move at its title read, before the move's first write. The
	 * expiry commands (`pexpire`, `persist`) are not modeled and never fail.
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
 * GETRANGE's bytes of `bytes` from `start` through `end`, as Redis cuts them: a negative index counts from the end,
 * then each is clamped to the value.
 */
function byteWindow(bytes: Buffer, start: number, end: number): Buffer {
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		throw new Error("ERR value is not an integer or out of range");
	}
	if (start < 0 && end < 0 && start > end) return bytes.subarray(0, 0);
	const from = Math.max(0, start < 0 ? bytes.length + start : start);
	const to = Math.min(bytes.length - 1, Math.max(0, end < 0 ? bytes.length + end : end));
	return from > to ? bytes.subarray(0, 0) : bytes.subarray(from, to + 1);
}

/**
 * The continuation bytes (10xxxxxx), at most three and none before byte `floor`, that run back from byte `at` of
 * `bytes` to the byte that begins their character, as the scripts' `back_to_start` counts them over a GETRANGE; 0
 * when byte `at` begins one, or when no such byte is found.
 */
function backToStart(bytes: Buffer, at: number, floor: number): number {
	const probe = byteWindow(bytes, Math.max(floor, at - 3), at);
	let back = 0;
	while (back < 3 && probe.length - back > 1) {
		const byte = probe[probe.length - 1 - back];
		if (byte < 0x80 || byte >= 0xc0) break;
		back++;
	}
	return back > 0 && probe[probe.length - 1 - back] >= 0xc0 ? back : 0;
}

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

	/** Make `key` the string `value`, whatever it held. */
	const setString = (key: string, value: string): void => {
		hashes.delete(key);
		strings.set(key, value);
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

	/** The UTF-8 bytes of the string `key`; `undefined` when it holds none. */
	const bytesOf = (key: string): Buffer | undefined => {
		const value = strings.get(key);
		return value === undefined ? undefined : Buffer.from(value, "utf-8");
	};

	/** GETRANGE of `key` from `start` through `end`, as text. */
	const byteRange = (key: string, start: number, end: number): string =>
		byteWindow(Buffer.from(strings.get(key) ?? "", "utf-8"), start, end).toString("utf-8");

	/** The title metadata the hash `titleKey` holds for `path`, as a script's HGET replies it. */
	const titleOf = (titleKey: string, path: string): string | null => hashes.get(titleKey)?.get(path) ?? null;

	/**
	 * The token `path`'s generation holds (`<token> <mtime>` in the hash `generationKey`) while the mtime beside it
	 * is the one the hash `metaKey` holds, as the scripts' `held_token` reads it; `undefined` when it holds none.
	 */
	const heldToken = (metaKey: string, generationKey: string, path: string): string | undefined => {
		const held = hashes.get(generationKey)?.get(path);
		const match = held === undefined ? null : /^(\S+) (.*)$/s.exec(held);
		return match && match[2] === hashes.get(metaKey)?.get(path) ? match[1] : undefined;
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
	 * Run a script's writes in the order the script runs its commands. Each write first meets the failure a test set
	 * for its command, which fails the script there: the writes before it stay as they ran, as on a server.
	 */
	const runWrites = (writes: readonly FakeWrite[]): void => {
		for (const [command, write] of writes) {
			checkFailure(command);
			write();
		}
	};

	/** What each script does, by its marker, as the storage's script with that marker does it. */
	const scripts: Record<string, FakeScript> = {
		"-- OMP_WRITE_FULL": (
			[fileKey, metaKey, titleKey, generationKey],
			[content, path, mtimeMs, hasTitle, title, expected, token],
		) => {
			const actual = strings.has(fileKey) ? byteLength(fileKey) : -1;
			if (expected !== "" && Number(expected) !== actual) return [0, actual];
			runWrites([
				["set", () => setString(fileKey, content)],
				["hset", () => setField(metaKey, path, mtimeMs)],
				hasTitle === "1"
					? ["hset", () => setField(titleKey, path, title)]
					: ["hdel", () => deleteField(titleKey, path)],
				["hset", () => setField(generationKey, path, `${token} ${mtimeMs}`)],
			]);
			return [1, Buffer.byteLength(content, "utf-8")];
		},
		"-- OMP_STAGE_PART": ([stagingKey], [part]) => {
			runWrites([["append", () => strings.set(stagingKey, (strings.get(stagingKey) ?? "") + part)]]);
			return byteLength(stagingKey);
		},
		"-- OMP_WRITE_STAGED": (
			[stagingKey, fileKey, metaKey, titleKey, generationKey],
			[path, mtimeMs, hasTitle, title, expected, size, token],
		) => {
			const actual = strings.has(fileKey) ? byteLength(fileKey) : -1;
			if (expected !== "" && Number(expected) !== actual) {
				runWrites([["del", () => deleteKey(stagingKey)]]);
				return [0, actual];
			}
			const staged = byteLength(stagingKey);
			if (staged !== Number(size)) {
				runWrites([["del", () => deleteKey(stagingKey)]]);
				return [-1, staged];
			}
			const body = strings.get(stagingKey) ?? "";
			runWrites([
				staged === 0
					? ["set", () => setString(fileKey, "")]
					: [
							"rename",
							() => {
								strings.delete(stagingKey);
								setString(fileKey, body);
							},
						],
				["hset", () => setField(metaKey, path, mtimeMs)],
				hasTitle === "1"
					? ["hset", () => setField(titleKey, path, title)]
					: ["hdel", () => deleteField(titleKey, path)],
				["hset", () => setField(generationKey, path, `${token} ${mtimeMs}`)],
			]);
			return [1, staged];
		},
		"-- OMP_APPEND": ([fileKey, metaKey, generationKey, titleKey], [line, path, mtimeMs, token]) => {
			const kept = heldToken(metaKey, generationKey, path) ?? token;
			const writes: FakeWrite[] = [];
			if (!strings.has(fileKey)) writes.push(["hdel", () => deleteField(titleKey, path)]);
			writes.push(
				["append", () => strings.set(fileKey, (strings.get(fileKey) ?? "") + line)],
				["hset", () => setField(metaKey, path, mtimeMs)],
				["hset", () => setField(generationKey, path, `${kept} ${mtimeMs}`)],
			);
			runWrites(writes);
			return byteLength(fileKey);
		},
		"-- OMP_UPDATE_TITLE": ([metaKey, titleKey, generationKey, fileKey], [path, mtimeMs, title, token]) => {
			if (!strings.has(fileKey)) return 0;
			const kept = heldToken(metaKey, generationKey, path) ?? token;
			runWrites([
				["hset", () => setField(metaKey, path, mtimeMs)],
				["hset", () => setField(titleKey, path, title)],
				["hset", () => setField(generationKey, path, `${kept} ${mtimeMs}`)],
			]);
			return 1;
		},
		"-- OMP_READ_FULL": ([fileKey, titleKey], [path]) => {
			const text = strings.get(fileKey);
			return text === undefined ? null : [text, titleOf(titleKey, path)];
		},
		"-- OMP_READ_SLICES": ([fileKey, titleKey], [path, prefix, suffix]) => {
			if (!strings.has(fileKey)) return null;
			const head = Number(prefix) > 0 ? byteRange(fileKey, 0, Number(prefix) - 1) : "";
			const tail = Number(suffix) > 0 ? byteRange(fileKey, -Number(suffix), -1) : "";
			return [head, tail, titleOf(titleKey, path)];
		},
		"-- OMP_READ_FROM": ([fileKey, titleKey], [first, most, path]) => {
			const bytes = bytesOf(fileKey);
			if (!bytes) return null;
			const from = Number(first);
			const stop = most === "" ? bytes.length : Math.min(from + Number(most), bytes.length);
			let text = "";
			let before = 0;
			if (from < stop) {
				before = backToStart(bytes, from, 0);
				const rest = byteWindow(bytes, stop, stop + 2);
				let after = 0;
				while (after < rest.length && rest[after] >= 0x80 && rest[after] < 0xc0) after++;
				text = byteWindow(bytes, from - before, stop + after - 1).toString("utf-8");
			}
			return [bytes.length, text, titleOf(titleKey, path), before];
		},
		"-- OMP_READ_WINDOW": ([fileKey, metaKey, generationKey, titleKey], [first, most, until, path]) => {
			const bytes = bytesOf(fileKey);
			if (!bytes) return null;
			let stop = bytes.length;
			if (until !== "") {
				stop = Number(until);
				if (bytes.length < stop) return [bytes.length];
			}
			const generation = heldToken(metaKey, generationKey, path) ?? UNVERSIONED;
			const title = until === "" ? titleOf(titleKey, path) : null;
			const from = Number(first);
			if (from >= stop) return [bytes.length, generation, 0, "", "", 0, title];
			const start = from > 0 && until === "" ? from - backToStart(bytes, from, 0) : from;
			let last = Math.min(start + Number(most), stop) - 1;
			if (last + 1 < stop) last -= backToStart(bytes, last + 1, start + 1);
			const window = byteWindow(bytes, start, last);
			const digest = generation === UNVERSIONED ? new Bun.CryptoHasher("sha1").update(window).digest("hex") : "";
			return [bytes.length, generation, window.length, digest, window.toString("utf-8"), from - start, title];
		},
		"-- OMP_CHECK_WINDOWS": ([fileKey, titleKey], [path, titled, title, first, ...windows]) => {
			const bytes = bytesOf(fileKey);
			if (!bytes) return 0;
			const held = titleOf(titleKey, path);
			if ((held !== null) !== (titled === "1") || (held !== null && held !== title)) return 0;
			let at = Number(first);
			for (let i = 0; i < windows.length; i += 2) {
				const length = Number(windows[i]);
				const window = byteWindow(bytes, at, at + length - 1);
				if (window.length !== length) return 0;
				if (new Bun.CryptoHasher("sha1").update(window).digest("hex") !== windows[i + 1]) return 0;
				at += length;
			}
			return 1;
		},
		"-- OMP_MOVE": ([srcKey, dstKey, metaKey, titleKey, generationKey], [src, dst, mtimeMs, noReplace, token]) => {
			if (noReplace === "1" && strings.has(dstKey)) return 0;
			// The title read, before the script's first write: it fails the script there, as the test set.
			checkFailure("hget");
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
				["hdel", () => deleteField(generationKey, src)],
				["hset", () => setField(generationKey, dst, `${token} ${mtimeMs}`)],
			]);
			return 1;
		},
		"-- OMP_REMOVE": ([metaKey, titleKey, generationKey], [prefix, pattern, ...given]) => {
			const paths = [...given];
			if (pattern) for (const key of keysMatching(pattern)) paths.push(key.slice(prefix.length));
			runWrites([
				...paths.map((path): FakeWrite => ["del", () => deleteKey(prefix + path)]),
				...paths.flatMap((path): FakeWrite[] => [
					["hdel", () => deleteField(metaKey, path)],
					["hdel", () => deleteField(titleKey, path)],
					["hdel", () => deleteField(generationKey, path)],
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
			// A streamed full write that fails deletes its staging key with a DEL of its own.
			if (command === "DEL") return args.filter(deleteKey).length;
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
			setString(key, value);
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
