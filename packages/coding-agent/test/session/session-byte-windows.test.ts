/**
 * Every byte-window read of a session gives, on every backend, the window of
 * the text `readText` gives: the stored bytes with the title slot of the
 * session's title laid over their head. One table of cases runs on each
 * backend and each window read, and each answer it expects comes from one
 * reference, which cuts the text's bytes as every window read cuts them.
 *
 * Where the backends' reads gave different answers to one case before the
 * title moved into the read, each backend keeps its own: those answers are the
 * named exceptions in {@link EXCEPTIONS}, each with its reason. The cases of
 * untitled bodies pass unchanged on the commit before that move.
 *
 * A count or offset that is not a whole number follows one rule on every
 * backend and path (`byteLimit`, `byteOffset`): NaN or a count not above 0
 * covers no bytes, any other count and any offset its whole part, toward zero
 * (an offset NaN as 0), before the read cuts its window. Every caller passes
 * whole numbers, so such a number is outside the rule that an answer equals
 * the one the commit before gave; one row of each read's table
 * ({@link slicePairs}, {@link NOT_WHOLE_WINDOW}) shows the rule.
 *
 * Memory, file and SQLite storage always run, and Redis storage over a fake
 * client; PostgreSQL, MySQL (or MariaDB) and a Redis server when
 * `OMP_TEST_SQL_POSTGRES_URL`, `OMP_TEST_SQL_MYSQL_URL` and
 * `OMP_TEST_REDIS_URL` name one. Each backend's clients, files, table and
 * keys are released after its cases, each release tried whatever the others
 * did, and every case and hook has a timeout of its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import {
	FileSessionStorage,
	MemorySessionStorage,
	readSessionTextFrom,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	type SqlSessionStorageAdapter,
	SqlSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RedisClient, SQL } from "bun";

const WRITTEN: SessionTitleUpdate = { title: "Written title", source: "auto", updatedAt: "2026-11-27T00:00:01.000Z" };
const RENAMED: SessionTitleUpdate = {
	title: "Renamed title é漢",
	source: "user",
	updatedAt: "2026-11-27T00:00:02.000Z",
};
const CLEARED: SessionTitleUpdate = { title: "", source: "user", updatedAt: "2026-11-27T00:00:03.000Z" };
/** A header and an entry: longer than the title slot, without one. */
const LONG = `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/p" })}\n${JSON.stringify({ type: "custom", data: "x".repeat(300) })}\n`;

/** A session the table reads: what its writer writes, then the title it is given or the title metadata it loses. */
interface Body {
	readonly id: string;
	readonly name: string;
	readonly written: string;
	readonly retitle?: SessionTitleUpdate;
	/** The store drops the title metadata it keeps beside the bytes, as a store from before that metadata left it. */
	readonly forgetTitle?: true;
}

const BODIES: readonly Body[] = [
	{ id: "short", name: "a short untitled body", written: "abc" },
	{ id: "long", name: "an untitled body longer than the title slot", written: LONG },
	{ id: "titled", name: "a titled body", written: `${serializeTitleSlot(WRITTEN)}${LONG}`, retitle: RENAMED },
	{ id: "short-titled", name: "a body shorter than the title slot, given a title", written: "abc", retitle: RENAMED },
	{
		id: "cleared",
		name: "a body whose title was cleared",
		written: `${serializeTitleSlot(WRITTEN)}${LONG}`,
		retitle: CLEARED,
	},
	{
		id: "legacy",
		name: "a legacy body with a stored title slot and no title metadata",
		written: `${serializeTitleSlot(WRITTEN)}${LONG}`,
		forgetTitle: true,
	},
	{ id: "bom", name: "an untitled body that starts with a UTF-8 byte-order mark", written: "\uFEFFabc" },
	{ id: "multibyte", name: "untitled multi-byte text", written: "aé漢😀z" },
];

/** The text `readText` gives: the stored bytes, with the slot of the title the session was given over their head. */
function textOf(body: Body): Buffer {
	const stored = Buffer.from(body.written, "utf-8");
	if (!body.retitle) return stored;
	const slot = Buffer.from(serializeTitleSlot(body.retitle), "utf-8");
	return Buffer.concat([slot, stored.subarray(slot.length)]);
}

/** How a backend's reads cut and decode a session's bytes, where it differs from the reference's rules. */
interface Rules {
	/** `readText` drops a byte-order mark that starts the text. */
	readonly readTextDropsBom: boolean;
	/** How a slice's bytes become text: as they are, or with a byte-order mark that starts them dropped (always, or unless the slice is the whole text). */
	readonly sliceDecoding:
		| "keeps a byte-order mark"
		| "drops a byte-order mark"
		| "drops a byte-order mark unless whole";
	/** A slice's suffix is cut from the stored bytes, not from the text with its title slot. */
	readonly storedSuffix: boolean;
	/** Where a window read (`readTextFrom`, `readSessionTextFrom`) places a negative offset. */
	readonly negativeOffset: "from the end" | "at byte 0" | "nowhere";
	/** How a window's bytes become text: as they are, or with a byte-order mark that starts them dropped. */
	readonly windowDecoding: "keeps a byte-order mark" | "drops a byte-order mark";
}

const REFERENCE_RULES: Rules = {
	readTextDropsBom: false,
	sliceDecoding: "keeps a byte-order mark",
	storedSuffix: false,
	negativeOffset: "from the end",
	windowDecoding: "keeps a byte-order mark",
};

type BackendName = "memory" | "file" | "sqlite" | "postgres" | "mysql" | "redis (fake)" | "redis (server)";
const SQL_BACKENDS: readonly BackendName[] = ["sqlite", "postgres", "mysql"];
const INDEXED_BACKENDS: readonly BackendName[] = [...SQL_BACKENDS, "redis (fake)", "redis (server)"];

/**
 * The answers a backend gives that the reference does not, each what that backend's reads gave before the title
 * moved into the read, kept, with why.
 */
const EXCEPTIONS: ReadonlyArray<{ backends: readonly BackendName[]; rules: Partial<Rules>; reason: string }> = [
	{
		backends: ["file"],
		rules: { readTextDropsBom: true },
		reason: "Bun's file text() drops a byte-order mark that starts the file; its windows still count the mark",
	},
	{
		backends: ["file", ...SQL_BACKENDS],
		rules: { sliceDecoding: "drops a byte-order mark", windowDecoding: "drops a byte-order mark" },
		reason:
			"slices and windows are decoded with a TextDecoder (Bun's file text() for file windows), which drops a byte-order mark that starts its input",
	},
	{
		backends: ["file"],
		rules: { negativeOffset: "nowhere" },
		reason: "a window from a negative offset reads nothing: Bun's file slice reads nothing from a negative start",
	},
	{
		backends: SQL_BACKENDS,
		rules: { negativeOffset: "at byte 0" },
		reason:
			"a window is read from a stored position: a negative offset reads from byte 0, and a window that ends at or before byte 0 reads nothing",
	},
	{
		backends: ["memory"],
		rules: { sliceDecoding: "drops a byte-order mark unless whole" },
		reason: "a slice shorter than the text is decoded with a TextDecoder; a whole one is the stored string",
	},
	{
		backends: INDEXED_BACKENDS,
		rules: { storedSuffix: true },
		reason:
			"the title slot is laid over the prefix only: the suffix is stored bytes, whose head holds the slot stored",
	},
];

function rulesOf(backend: BackendName): Rules {
	return Object.assign(
		{},
		REFERENCE_RULES,
		...EXCEPTIONS.filter(exception => exception.backends.includes(backend)).map(exception => exception.rules),
	);
}

function decode(bytes: Buffer, dropsBom: boolean): string {
	return dropsBom ? new TextDecoder().decode(bytes) : bytes.toString("utf-8");
}

/** The whole bytes a window of at most `maxBytes` holds: none for a count that is not positive. */
function windowBytes(maxBytes: number): number {
	return maxBytes > 0 ? Math.trunc(maxBytes) : 0;
}

/** The reference `readTextSlices`: the first `prefixBytes` and last `suffixBytes` of the text's bytes. */
function expectedSlices(body: Body, rules: Rules, prefixBytes: number, suffixBytes: number): [string, string] {
	const text = textOf(body);
	const suffixOf = rules.storedSuffix ? Buffer.from(body.written, "utf-8") : text;
	const head = Math.min(windowBytes(prefixBytes), text.length);
	const tail = Math.min(windowBytes(suffixBytes), suffixOf.length);
	const dropsBom = (whole: boolean): boolean =>
		rules.sliceDecoding === "drops a byte-order mark" ||
		(rules.sliceDecoding === "drops a byte-order mark unless whole" && !whole);
	return [
		decode(text.subarray(0, head), dropsBom(head === text.length)),
		decode(suffixOf.subarray(suffixOf.length - tail), dropsBom(tail === suffixOf.length)),
	];
}

/** Byte counts of a slice: negative, zero, small, inside the title slot, at its end, past it, and at or past the end. */
function sliceCounts(size: number): number[] {
	return [...new Set([-3, 0, 1, 2, 5, 100, 255, 256, 300, size - 1, size, size + 100])];
}

/**
 * The `[prefixBytes, suffixBytes]` pairs of a slice: each of {@link sliceCounts} with each, then the one row of
 * counts that are not whole numbers, which every backend and path cuts by one rule (`byteLimit`): NaN or a count not
 * above 0 covers no bytes, any other its whole part, toward zero. The row asks the whole text and a suffix of 1.5
 * bytes, which covers one byte; the file storage of the commit before took that suffix's start from the count as
 * given and answered two bytes.
 */
function slicePairs(size: number): Array<readonly [number, number]> {
	const counts = sliceCounts(size);
	return [
		...counts.flatMap(prefixBytes => counts.map(suffixBytes => [prefixBytes, suffixBytes] as const)),
		[size, 1.5],
	];
}

/** A session no store holds: every read of it rejects with `ENOENT`, whatever its byte counts. */
const MISSING: Body = { id: "missing", name: "a missing session", written: "" };

/** Offsets of a window: past the start, negative, zero, inside the title slot, at its end, past it, at and past the end. */
function windowOffsets(size: number): number[] {
	return [
		...new Set([
			-(size + 2),
			-5,
			-1,
			0,
			1,
			2,
			5,
			100,
			255,
			256,
			300,
			size - 1,
			size,
			size + 7,
			Number.MAX_SAFE_INTEGER,
		]),
	];
}

/** Limits of a window: none, negative, zero, small, and more than the rest. */
function windowLimits(size: number): Array<number | undefined> {
	return [undefined, -3, 0, 1, 2, 5, size + 100];
}

/**
 * The one row of a window whose offset and limit are not whole numbers, which every backend and path makes whole by
 * one rule (`byteOffset`, `byteLimit`) before it cuts the window: from byte 1, one byte. `Uint8Array.subarray(1.75,
 * 3.5)`, which the full reads of the commit before cut, takes two.
 */
const NOT_WHOLE_WINDOW: readonly [number, number] = [1.75, 1.75];

/**
 * The reference `readTextFrom`: the bytes `Uint8Array.subarray(offset, offset + maxBytes)` cuts from the text's
 * bytes, the offset and the limit made whole first (a limit not above 0 read as 0, an offset NaN as 0), a negative
 * offset placed by the backend's rule, and the text's size.
 */
function expectedWindow(
	body: Body,
	rules: Rules,
	offset: number,
	maxBytes: number | undefined,
): { text: string; size: number } {
	const text = textOf(body);
	const from = Math.trunc(offset) || 0;
	const limit = maxBytes === undefined ? undefined : windowBytes(maxBytes);
	let window = text.subarray(from, limit === undefined ? undefined : from + limit);
	if (from < 0 && rules.negativeOffset === "nowhere") window = text.subarray(0, 0);
	if (from < 0 && rules.negativeOffset === "at byte 0") {
		window = limit === undefined || from + limit > 0 ? text.subarray(0, limit) : text.subarray(0, 0);
	}
	return { text: decode(window, rules.windowDecoding === "drops a byte-order mark"), size: text.length };
}

/** One store, written by one storage and read by another opened after the writes, as another process reads it. */
interface Store {
	readonly writer: SessionStorage;
	reopen(): Promise<SessionStorage>;
	path(body: Body): string;
	/** Drop the title metadata the store keeps for `path` beside its bytes (none where the title is the stored slot). */
	forgetTitle(path: string): Promise<void>;
}

function sessionPath(body: Body): string {
	return `/sessions/-project-/2026-11-27T00-00-00-000Z_${body.id}.jsonl`;
}

async function memoryStore(): Promise<Store> {
	const storage = new MemorySessionStorage();
	return {
		writer: storage,
		reopen: async () => storage,
		path: sessionPath,
		forgetTitle: async () => {},
	};
}

/** A directory of its own, removed by `cleanup`. */
async function fileStore(cleanup: AsyncDisposableStack): Promise<Store> {
	const dir = await TempDir.create("@omp-byte-windows-");
	cleanup.defer(() => dir.remove());
	return {
		writer: new FileSessionStorage(),
		reopen: async () => new FileSessionStorage(),
		path: body => dir.join(`${body.id}.jsonl`),
		forgetTitle: async () => {},
	};
}

/**
 * A table of its own on `url`'s database (a file of its own for SQLite). `cleanup` ends each client as it is made,
 * then drops each table, every drop tried whatever the others did, on a client of its own, which it ends after
 * them, then removes the file's directory.
 */
async function sqlStore(adapter: SqlSessionStorageAdapter, url: string, cleanup: AsyncDisposableStack): Promise<Store> {
	const table = `omp_byte_windows_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
	const dir = adapter === "sqlite" ? await TempDir.create("@omp-byte-windows-") : undefined;
	if (dir) cleanup.defer(() => dir.remove());
	const client = (): SQL => (dir ? new SQL({ adapter: "sqlite", filename: dir.join("sessions.db") }) : new SQL(url));
	// Registered before any client the store opens, so they run after those end; the stack runs them last first, so
	// the drops run in the order `_parts`, `_blobs`, `_refs`, the session table, and the dropping client ends after.
	let dropper: SQL | undefined;
	cleanup.defer(async () => {
		await dropper?.end();
	});
	for (const name of [table, `${table}_refs`, `${table}_blobs`, `${table}_parts`]) {
		cleanup.defer(async () => {
			dropper ??= client();
			await dropper.unsafe(`DROP TABLE IF EXISTS ${name}`);
		});
	}
	const connect = (): SQL => {
		const opened = client();
		cleanup.defer(() => opened.end());
		return opened;
	};
	const first = connect();
	return {
		writer: await SqlSessionStorage.create({ client: first, table }),
		reopen: () => SqlSessionStorage.create({ client: connect(), table }),
		path: sessionPath,
		async forgetTitle(path) {
			const parameter = adapter === "postgres" ? "$1" : "?";
			await first.unsafe(
				`UPDATE ${table} SET title = NULL, title_source = NULL, title_updated_at = NULL WHERE path = ${parameter}`,
				[path],
			);
		},
	};
}

/** A Redis client over two maps that runs the commands and scripts Redis storage sends, as a server runs them. */
class FakeRedis implements RedisSessionStorageClient {
	readonly #strings = new Map<string, string>();
	readonly #hashes = new Map<string, Map<string, string>>();

	#hash(key: string): Map<string, string> {
		let hash = this.#hashes.get(key);
		if (!hash) {
			hash = new Map();
			this.#hashes.set(key, hash);
		}
		return hash;
	}

	/** GETRANGE: the bytes from `start` through `end`, a negative one counted from the end. */
	#range(key: string, start: number, end: number): string {
		const bytes = Buffer.from(this.#strings.get(key) ?? "", "utf-8");
		const from = Math.max(0, start < 0 ? bytes.length + start : start);
		const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
		return to < from ? "" : bytes.subarray(from, to + 1).toString("utf-8");
	}

	/** Runs a script by the marker on its first line: each of those a read or a write of these cases sends. */
	async send(command: string, args: string[]): Promise<unknown> {
		if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
		const [script = "", count = "0"] = args;
		const keys = args.slice(2, 2 + Number(count));
		const argv = args.slice(2 + Number(count));
		const marker = script.slice(0, script.indexOf("\n"));
		if (marker === "-- OMP_WRITE_FULL") {
			const [file, meta, title] = keys;
			const [content, path, mtime, titled, titleMeta, expected] = argv;
			const actual = this.#strings.has(file) ? Buffer.byteLength(this.#strings.get(file) ?? "", "utf-8") : -1;
			if (expected !== "" && Number(expected) !== actual) return [0, actual];
			this.#strings.set(file, content);
			this.#hash(meta).set(path, mtime);
			if (titled === "1") this.#hash(title).set(path, titleMeta);
			else this.#hash(title).delete(path);
			return [1, Buffer.byteLength(content, "utf-8")];
		}
		if (marker === "-- OMP_UPDATE_TITLE") {
			const [meta, title, file] = keys;
			const [path, mtime, titleMeta] = argv;
			if (file !== undefined && !this.#strings.has(file)) return 0;
			this.#hash(meta).set(path, mtime);
			this.#hash(title).set(path, titleMeta);
			return 1;
		}
		if (marker === "-- OMP_READ_FULL") {
			const [file, title] = keys;
			const text = this.#strings.get(file);
			return text === undefined ? null : [text, this.#hashes.get(title)?.get(argv[0]) ?? null];
		}
		if (marker === "-- OMP_READ_SLICES") {
			const [file, title] = keys;
			const [path, prefix, suffix] = argv;
			if (!this.#strings.has(file)) return null;
			const head = Number(prefix) > 0 ? this.#range(file, 0, Number(prefix) - 1) : "";
			const tail = Number(suffix) > 0 ? this.#range(file, -Number(suffix), -1) : "";
			return [head, tail, this.#hashes.get(title)?.get(path) ?? null];
		}
		throw new Error(`Unsupported Redis script: ${marker}`);
	}

	async get(key: string): Promise<string | null> {
		return this.#strings.get(key) ?? null;
	}

	async getrange(key: string, start: number, end: number): Promise<string> {
		return this.#range(key, start, end);
	}

	async strlen(key: string): Promise<number> {
		return Buffer.byteLength(this.#strings.get(key) ?? "", "utf-8");
	}

	async set(key: string, value: string): Promise<unknown> {
		this.#strings.set(key, value);
		return "OK";
	}

	async append(key: string, value: string): Promise<number> {
		const next = `${this.#strings.get(key) ?? ""}${value}`;
		this.#strings.set(key, next);
		return Buffer.byteLength(next, "utf-8");
	}

	async del(...keys: string[]): Promise<number> {
		return keys.filter(key => this.#strings.delete(key) || this.#hashes.delete(key)).length;
	}

	async rename(src: string, dst: string): Promise<unknown> {
		const value = this.#strings.get(src);
		if (value === undefined) throw new Error("ERR no such key");
		this.#strings.delete(src);
		this.#strings.set(dst, value);
		return "OK";
	}

	/** One batch of every key a `MATCH` pattern of a prefix and `*` matches, its glob characters escaped. */
	async scan(_cursor: string, ...args: string[]): Promise<[string, string[]]> {
		const pattern = args[args.findIndex(arg => arg.toUpperCase() === "MATCH") + 1] ?? "*";
		const prefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
		return ["0", [...this.#strings.keys()].filter(key => key.startsWith(prefix))];
	}

	async hset(key: string, field: string, value: string): Promise<unknown> {
		this.#hash(key).set(field, value);
		return 1;
	}

	async hgetall(key: string): Promise<Record<string, string>> {
		return Object.fromEntries(this.#hashes.get(key) ?? []);
	}

	async hdel(key: string, ...fields: string[]): Promise<unknown> {
		return fields.filter(field => this.#hashes.get(key)?.delete(field)).length;
	}
}

/**
 * A key prefix of its own on a server (or on the fake). `cleanup` closes each client as it is made, then deletes the
 * prefix's keys on a client of its own.
 */
async function redisStore(url: string | undefined, cleanup: AsyncDisposableStack): Promise<Store> {
	const prefix = `omp-test:byte-windows:${crypto.randomUUID()}:`;
	const fake = url === undefined ? new FakeRedis() : undefined;
	if (url !== undefined) {
		// Registered before any client the store opens, so it runs after they close.
		cleanup.defer(async () => {
			const cleaner = new RedisClient(url);
			try {
				const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
				if (keys.length > 0) await cleaner.send("DEL", keys);
			} finally {
				cleaner.close();
			}
		});
	}
	const connect = (): RedisSessionStorageClient => {
		if (fake) return fake;
		const client = new RedisClient(url ?? "");
		cleanup.defer(() => client.close());
		return client;
	};
	const first = connect();
	return {
		writer: await RedisSessionStorage.create({ client: first, prefix }),
		reopen: () => RedisSessionStorage.create({ client: connect(), prefix }),
		path: sessionPath,
		async forgetTitle(path) {
			if (fake) await fake.hdel(`${prefix}title`, path);
			else await first.send("HDEL", [`${prefix}title`, path]);
		},
	};
}

/** Each backend, whether it runs here, and whether its storage reads from an offset itself (`readTextFrom`). */
const BACKENDS: ReadonlyArray<{
	name: BackendName;
	available: boolean;
	readsFrom: boolean;
	open(cleanup: AsyncDisposableStack): Promise<Store>;
}> = [
	{ name: "memory", available: true, readsFrom: false, open: memoryStore },
	{ name: "file", available: true, readsFrom: true, open: fileStore },
	{ name: "sqlite", available: true, readsFrom: true, open: cleanup => sqlStore("sqlite", "sqlite", cleanup) },
	{
		name: "postgres",
		available: !!process.env.OMP_TEST_SQL_POSTGRES_URL,
		readsFrom: true,
		open: cleanup => sqlStore("postgres", process.env.OMP_TEST_SQL_POSTGRES_URL ?? "", cleanup),
	},
	{
		name: "mysql",
		available: !!process.env.OMP_TEST_SQL_MYSQL_URL,
		readsFrom: true,
		open: cleanup => sqlStore("mysql", process.env.OMP_TEST_SQL_MYSQL_URL ?? "", cleanup),
	},
	{ name: "redis (fake)", available: true, readsFrom: true, open: cleanup => redisStore(undefined, cleanup) },
	{
		name: "redis (server)",
		available: !!process.env.OMP_TEST_REDIS_URL,
		readsFrom: true,
		open: cleanup => redisStore(process.env.OMP_TEST_REDIS_URL, cleanup),
	},
];

/** A case the read answered otherwise than the reference, with both answers. */
interface Mismatch {
	readonly args: ReadonlyArray<number | undefined>;
	readonly expected: unknown;
	readonly actual: unknown;
}

/** Every window case `read` answers otherwise than the reference does for `body`. */
async function windowMismatches(
	body: Body,
	rules: Rules,
	read: (offset: number, maxBytes: number | undefined) => Promise<{ text: string; size: number }>,
): Promise<Mismatch[]> {
	const size = textOf(body).length;
	const windows = windowOffsets(size).flatMap(offset =>
		windowLimits(size).map((maxBytes): readonly [number, number | undefined] => [offset, maxBytes]),
	);
	windows.push(NOT_WHOLE_WINDOW);
	const mismatches: Mismatch[] = [];
	for (const [offset, maxBytes] of windows) {
		const expected = expectedWindow(body, rules, offset, maxBytes);
		const actual = await read(offset, maxBytes);
		if (!Bun.deepEquals(actual, expected)) mismatches.push({ args: [offset, maxBytes], expected, actual });
	}
	return mismatches;
}

for (const backend of BACKENDS) {
	describe.skipIf(!backend.available)(`byte windows of a session (${backend.name})`, () => {
		const rules = rulesOf(backend.name);
		// Each resource the backend's store takes, released by `afterAll` whether or not the setup finished.
		const cleanup = new AsyncDisposableStack();
		let store: Store | undefined;
		let reader: SessionStorage;

		beforeAll(async () => {
			const opened = await backend.open(cleanup);
			store = opened;
			for (const body of BODIES) {
				const path = opened.path(body);
				await opened.writer.writeText(path, body.written);
				if (body.retitle) await opened.writer.updateSessionTitle(path, body.retitle);
			}
			await opened.writer.drain();
			for (const body of BODIES) if (body.forgetTitle) await opened.forgetTitle(opened.path(body));
			reader = await opened.reopen();
		}, 60_000);

		afterAll(() => cleanup.disposeAsync(), 60_000);

		for (const body of BODIES) {
			it(`readText of ${body.name}`, async () => {
				const text = textOf(body).toString("utf-8");
				const expected = rules.readTextDropsBom && text.startsWith("\uFEFF") ? text.slice(1) : text;
				expect(await reader.readText(store?.path(body) ?? "")).toBe(expected);
			}, 60_000);

			it(`readTextSlices of ${body.name}`, async () => {
				const path = store?.path(body) ?? "";
				const mismatches: Mismatch[] = [];
				for (const [prefixBytes, suffixBytes] of slicePairs(textOf(body).length)) {
					const expected = expectedSlices(body, rules, prefixBytes, suffixBytes);
					const actual = await reader.readTextSlices(path, prefixBytes, suffixBytes);
					if (!Bun.deepEquals(actual, expected))
						mismatches.push({ args: [prefixBytes, suffixBytes], expected, actual });
				}
				expect(mismatches).toEqual([]);
			}, 60_000);

			it.skipIf(!backend.readsFrom)(
				`readTextFrom of ${body.name}`,
				async () => {
					const path = store?.path(body) ?? "";
					const mismatches = await windowMismatches(body, rules, (offset, maxBytes) => {
						if (!reader.readTextFrom) throw new Error(`${backend.name} storage has no readTextFrom`);
						return reader.readTextFrom(path, offset, maxBytes);
					});
					expect(mismatches).toEqual([]);
				},
				60_000,
			);

			it(`readSessionTextFrom of ${body.name}`, async () => {
				const path = store?.path(body) ?? "";
				const mismatches = await windowMismatches(body, rules, (offset, maxBytes) =>
					readSessionTextFrom(reader, path, offset, maxBytes),
				);
				expect(mismatches).toEqual([]);
			}, 60_000);
		}

		// If this regresses, a slice of a session that is gone, asked with counts that leave no window to read (NaN, a
		// fraction under 1), answers two empty windows instead of rejecting as missing.
		it(`readTextSlices of ${MISSING.name}`, async () => {
			const path = store?.path(MISSING) ?? "";
			const answers: unknown[] = [];
			for (const [prefixBytes, suffixBytes] of [
				[Number.NaN, 0],
				[0.5, 0],
				[0, Number.NaN],
				[0, 0.5],
			] as const) {
				answers.push(
					await reader.readTextSlices(path, prefixBytes, suffixBytes).then(
						slices => slices,
						(error: NodeJS.ErrnoException) => error.code,
					),
				);
			}
			expect(answers).toEqual(["ENOENT", "ENOENT", "ENOENT", "ENOENT"]);
		}, 60_000);
	});
}
