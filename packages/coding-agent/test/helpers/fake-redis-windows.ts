/**
 * `RedisSessionStorage`'s Lua scripts as a Redis 7 server runs them, for the
 * hand-rolled Redis doubles that run no Lua: what each script answers, what
 * it writes to the file keys and to the meta, title and generation hashes,
 * and what its chunked-read scripts (`OMP_READ_WINDOW` and
 * `OMP_CHECK_WINDOWS`) return.
 */

/** The keyspace a Redis double holds: its string keys and its hashes. */
export interface FakeRedisKeyspace {
	readonly strings: Map<string, string>;
	readonly hashes: Map<string, Map<string, string>>;
}

/** Whether `byte` continues a UTF-8 character (10xxxxxx). */
function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * The continuation bytes, at most three and none before byte `floor`, that run
 * back from byte `at` of `bytes` to the byte that begins their character; 0
 * when byte `at` begins one, or when no such byte is found.
 */
function backToStart(bytes: Buffer, at: number, floor: number): number {
	let back = 0;
	while (back < 3 && at - back > Math.max(floor, at - 3) && isContinuation(bytes[at - back])) back++;
	const lead = bytes[at - back];
	return back > 0 && lead !== undefined && lead >= 0xc0 ? back : 0;
}

/**
 * The token a generation hash value `held` (`<token> <mtime>`) holds while the
 * mtime recorded beside it is the meta hash's `mtime`, as `HELD_TOKEN` reads
 * it; `undefined` when it holds none.
 */
function heldToken(held: string | undefined, mtime: string | undefined): string | undefined {
	const match = held === undefined ? null : /^(\S+) (.*)$/.exec(held);
	return match && match[2] === mtime ? match[1] : undefined;
}

/** What GETRANGE returns for `bytes` from `start` to `end`, both inclusive, a negative one counted from the end. */
export function byteRange(bytes: Buffer, start: number, end: number): string {
	if (bytes.length === 0) return "";
	const from = Math.max(0, start < 0 ? bytes.length + start : start);
	const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
	if (to < from) return "";
	return bytes.subarray(from, to + 1).toString("utf-8");
}

/**
 * The window script's reply for `bytes` at `generation`, `argv` being its
 * first byte, most bytes and the size the read stops at ("" for the first
 * window): a first window from inside a character starts at the byte that
 * begins it, and a window that stops short of the read's end ends before the
 * character its next byte continues, never as nothing; its SHA-1 when the
 * generation is "?" (no token), else ""; `[size]` alone when the key is
 * shorter than that end.
 */
function readWindow(bytes: Buffer | undefined, generation: string, [first, most, until]: string[]): unknown[] | null {
	if (!bytes) return null;
	if (until !== "" && bytes.length < Number(until)) return [bytes.length];
	const stop = until === "" ? bytes.length : Number(until);
	const from = Number(first);
	if (from >= stop) return [bytes.length, generation, 0, "", "", 0];
	const start = from > 0 && until === "" ? from - backToStart(bytes, from, 0) : from;
	let end = Math.min(start + Number(most), stop);
	if (end < stop) end -= backToStart(bytes, end, start + 1);
	const window = bytes.subarray(start, end);
	const digest = generation === "?" ? new Bun.CryptoHasher("sha1").update(window).digest("hex") : "";
	return [bytes.length, generation, window.length, digest, window.toString("utf-8"), from - start];
}

/** The end check script's reply: 1 when `bytes` holds, from `argv[0]` on, each window given as its length and SHA-1. */
function holdsWindows(bytes: Buffer | undefined, [first, ...windows]: string[]): number {
	if (!bytes) return 0;
	let at = Number(first);
	for (let i = 0; i < windows.length; i += 2) {
		const window = bytes.subarray(at, at + Number(windows[i]));
		if (window.length !== Number(windows[i])) return 0;
		if (new Bun.CryptoHasher("sha1").update(window).digest("hex") !== windows[i + 1]) return 0;
		at += window.length;
	}
	return 1;
}

/**
 * Run the script an `EVAL` names (`args`: the script, the key count, the keys,
 * then its arguments, as `RedisSessionStorage` sends them; the script is told
 * by its `-- OMP_<NAME>` tag) on `keyspace`, as Redis 7 runs it, and return
 * its reply. Before a script changes anything it calls `checkFailure` with
 * each Redis command it runs (`set`, `hset`, `append`, `rename`, `del`,
 * `getrange`), so a double can make one of them fail.
 */
export function runSessionScript(
	keyspace: FakeRedisKeyspace,
	args: string[],
	checkFailure: (command: string) => void = () => undefined,
): unknown {
	const { strings, hashes } = keyspace;
	const hash = (key: string): Map<string, string> => {
		let held = hashes.get(key);
		if (!held) {
			held = new Map();
			hashes.set(key, held);
		}
		return held;
	};
	const bytesOf = (key: string): Buffer | undefined => {
		const value = strings.get(key);
		return value === undefined ? undefined : Buffer.from(value, "utf-8");
	};
	// The hash fields a full write, a staged one and a move leave: the mtime, the title, and a new generation.
	const setWritten = (
		[metaKey, titleKey, generationKey]: string[],
		filePath: string,
		mtimeMs: string,
		title: string | undefined,
		token: string,
	): void => {
		hash(metaKey).set(filePath, mtimeMs);
		if (title !== undefined) hash(titleKey).set(filePath, title);
		else hash(titleKey).delete(filePath);
		hash(generationKey).set(filePath, `${token} ${mtimeMs}`);
	};
	const script = args[0] ?? "";
	const keyCount = Number(args[1] ?? "0");
	const keys = args.slice(2, 2 + keyCount);
	const argv = args.slice(2 + keyCount);
	if (script.includes("OMP_WRITE_FULL")) {
		checkFailure("set");
		checkFailure("hset");
		const [fileKey, ...hashKeys] = keys;
		const [content, filePath, mtimeMs, hasTitle, title, expectedSize, token] = argv;
		const current = strings.get(fileKey);
		const actualSize = current === undefined ? -1 : Buffer.byteLength(current, "utf-8");
		if (expectedSize !== "" && actualSize !== Number(expectedSize)) return [0, actualSize];
		strings.set(fileKey, content);
		setWritten(hashKeys, filePath, mtimeMs, hasTitle === "1" ? title : undefined, token);
		return [1, Buffer.byteLength(content, "utf-8")];
	}
	if (script.includes("OMP_STAGE_PART")) {
		checkFailure("append");
		const [stagingKey] = keys;
		const next = (strings.get(stagingKey) ?? "") + argv[0];
		strings.set(stagingKey, next);
		return Buffer.byteLength(next, "utf-8");
	}
	if (script.includes("OMP_WRITE_STAGED")) {
		// Refused ({0, actual} or {-1, staged}) after deleting the staging key.
		checkFailure("rename");
		checkFailure("hset");
		const [stagingKey, fileKey, ...hashKeys] = keys;
		const [filePath, mtimeMs, hasTitle, title, expectedSize, byteLength, token] = argv;
		const current = strings.get(fileKey);
		const actualSize = current === undefined ? -1 : Buffer.byteLength(current, "utf-8");
		const staged = strings.get(stagingKey) ?? "";
		const stagedSize = Buffer.byteLength(staged, "utf-8");
		strings.delete(stagingKey);
		if (expectedSize !== "" && actualSize !== Number(expectedSize)) return [0, actualSize];
		if (stagedSize !== Number(byteLength)) return [-1, stagedSize];
		strings.set(fileKey, staged);
		setWritten(hashKeys, filePath, mtimeMs, hasTitle === "1" ? title : undefined, token);
		return [1, stagedSize];
	}
	if (script.includes("OMP_APPEND")) {
		checkFailure("append");
		checkFailure("hset");
		const [fileKey, metaKey, generationKey] = keys;
		const [line, filePath, mtimeMs, token] = argv;
		const kept = heldToken(hash(generationKey).get(filePath), hash(metaKey).get(filePath)) ?? token;
		const next = (strings.get(fileKey) ?? "") + line;
		strings.set(fileKey, next);
		hash(metaKey).set(filePath, mtimeMs);
		hash(generationKey).set(filePath, `${kept} ${mtimeMs}`);
		return Buffer.byteLength(next, "utf-8");
	}
	if (script.includes("OMP_UPDATE_TITLE")) {
		checkFailure("hset");
		const [metaKey, titleKey, generationKey] = keys;
		const [filePath, mtimeMs, title, token] = argv;
		const kept = heldToken(hash(generationKey).get(filePath), hash(metaKey).get(filePath)) ?? token;
		hash(metaKey).set(filePath, mtimeMs);
		hash(titleKey).set(filePath, title);
		hash(generationKey).set(filePath, `${kept} ${mtimeMs}`);
		return 1;
	}
	if (script.includes("OMP_MOVE")) {
		// 0 when a no-replace destination exists.
		checkFailure("rename");
		const [srcKey, dstKey, metaKey, titleKey, generationKey] = keys;
		const [src, dst, mtimeMs, noReplace, token] = argv;
		if (noReplace === "1" && strings.has(dstKey)) return 0;
		if (!strings.has(srcKey)) throw new Error("ERR no such key");
		strings.set(dstKey, strings.get(srcKey) as string);
		if (srcKey !== dstKey) strings.delete(srcKey);
		const title = hash(titleKey).get(src);
		hash(metaKey).delete(src);
		hash(titleKey).delete(src);
		hash(generationKey).delete(src);
		setWritten([metaKey, titleKey, generationKey], dst, mtimeMs, title, token);
		return 1;
	}
	if (script.includes("OMP_REMOVE")) {
		checkFailure("del");
		const [metaKey, titleKey, generationKey] = keys;
		const [filePrefix, pattern, ...paths] = argv;
		if (pattern) {
			// The pattern is an escaped key prefix followed by `*`.
			const keyPrefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
			for (const key of strings.keys()) {
				if (key.startsWith(keyPrefix)) paths.push(key.slice(filePrefix.length));
			}
		}
		for (const filePath of paths) {
			strings.delete(filePrefix + filePath);
			hash(metaKey).delete(filePath);
			hash(titleKey).delete(filePath);
			hash(generationKey).delete(filePath);
		}
		return paths.length;
	}
	if (script.includes("OMP_READ_FROM")) {
		checkFailure("getrange");
		const [first, last] = argv;
		const bytes = bytesOf(keys[0]);
		if (!bytes) return null;
		return [bytes.length, last === "" ? "" : byteRange(bytes, Number(first), Number(last))];
	}
	if (script.includes("OMP_READ_WINDOW")) {
		checkFailure("getrange");
		const [fileKey, metaKey, generationKey] = keys;
		const filePath = argv[3];
		const generation = heldToken(hash(generationKey).get(filePath), hash(metaKey).get(filePath)) ?? "?";
		return readWindow(bytesOf(fileKey), generation, argv);
	}
	if (script.includes("OMP_CHECK_WINDOWS")) return holdsWindows(bytesOf(keys[0]), argv);
	throw new Error("Unsupported Redis script");
}
