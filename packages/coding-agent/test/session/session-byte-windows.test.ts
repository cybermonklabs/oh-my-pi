/**
 * Every byte-window read of a session gives, on every backend, the window of
 * the text `readText` gives: the stored bytes with the title slot of the
 * session's title laid over their head. One table of cases runs on each
 * backend and each window read, and each answer it expects comes from one
 * reference, which cuts the text's bytes as every window read cuts them.
 *
 * Where the backends' reads give different answers to one case, each backend
 * keeps its own: those answers are the named exceptions in
 * {@link EXCEPTIONS}, each with its reason.
 *
 * Memory, file and SQLite storage always run, and Redis storage over a fake
 * client whose Lua interpreter runs the store's scripts; PostgreSQL, MySQL (or
 * MariaDB) and a Redis server when `OMP_TEST_SQL_POSTGRES_URL`,
 * `OMP_TEST_SQL_MYSQL_URL` and `OMP_TEST_REDIS_URL` name one.
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
import { assertHashKey, byteRange, type FakeRedisKeyspace, runSessionScript } from "../helpers/fake-redis-windows";
import { dropSessionStoreTables } from "../helpers/sql-session-storage";

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
const REDIS_BACKENDS: readonly BackendName[] = ["redis (fake)", "redis (server)"];
const INDEXED_BACKENDS: readonly BackendName[] = [...SQL_BACKENDS, ...REDIS_BACKENDS];

/** The answers a backend gives that the reference does not, each kept, with why. */
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
		backends: INDEXED_BACKENDS,
		rules: { negativeOffset: "at byte 0" },
		reason:
			"a window is read from a stored position (the backend's own readFrom): a negative offset reads from byte 0, and a window that ends at or before byte 0 reads nothing",
	},
	{
		backends: REDIS_BACKENDS,
		rules: { windowDecoding: "drops a byte-order mark" },
		reason:
			"a window read from a stored position is decoded with a TextDecoder, as SQL storage's is; its slices are the strings the scripts return",
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
 * The reference `readTextFrom`: the bytes `Uint8Array.subarray(offset, offset + maxBytes)` cuts from the text's
 * bytes (a negative limit read as 0), a negative offset placed by the backend's rule, and the text's size.
 */
function expectedWindow(
	body: Body,
	rules: Rules,
	offset: number,
	maxBytes: number | undefined,
): { text: string; size: number } {
	const text = textOf(body);
	const limit = maxBytes === undefined ? undefined : Math.max(0, maxBytes);
	let window = text.subarray(offset, limit === undefined ? undefined : offset + limit);
	if (offset < 0 && rules.negativeOffset === "nowhere") window = text.subarray(0, 0);
	if (offset < 0 && rules.negativeOffset === "at byte 0") {
		window = limit === undefined || offset + limit > 0 ? text.subarray(0, limit) : text.subarray(0, 0);
	}
	return { text: decode(window, rules.windowDecoding === "drops a byte-order mark"), size: text.length };
}

/** One store, written by one storage and read by another opened after the writes, as another process reads it. */
interface Store extends AsyncDisposable {
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
		async [Symbol.asyncDispose]() {},
	};
}

async function fileStore(): Promise<Store> {
	const dir = await TempDir.create("@omp-byte-windows-");
	return {
		writer: new FileSessionStorage(),
		reopen: async () => new FileSessionStorage(),
		path: body => dir.join(`${body.id}.jsonl`),
		forgetTitle: async () => {},
		async [Symbol.asyncDispose]() {
			await dir.remove();
		},
	};
}

/** A table of its own on `url`'s database (a file of its own for SQLite), dropped at the end. */
async function sqlStore(adapter: SqlSessionStorageAdapter, url: string): Promise<Store> {
	const dir = adapter === "sqlite" ? await TempDir.create("@omp-byte-windows-") : undefined;
	const table = `omp_byte_windows_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
	const clients: SQL[] = [];
	const open = (): Promise<SqlSessionStorage> => {
		const client = dir ? new SQL({ adapter: "sqlite", filename: dir.join("sessions.db") }) : new SQL(url);
		clients.push(client);
		return SqlSessionStorage.create({ client, table });
	};
	const writer = await open();
	return {
		writer,
		reopen: open,
		path: sessionPath,
		async forgetTitle(path) {
			const parameter = adapter === "postgres" ? "$1" : "?";
			await clients[0].unsafe(
				`UPDATE ${table} SET title = NULL, title_source = NULL, title_updated_at = NULL WHERE path = ${parameter}`,
				[path],
			);
		},
		async [Symbol.asyncDispose]() {
			await dropSessionStoreTables(clients[0], table);
			for (const client of clients) await client.end();
			await dir?.remove();
		},
	};
}

/** A Redis client over a keyspace whose scripts the fake's Lua interpreter runs, as a server runs them. */
class FakeRedis implements RedisSessionStorageClient {
	readonly keyspace: FakeRedisKeyspace = { strings: new Map(), hashes: new Map() };

	async send(command: string, args: string[]): Promise<unknown> {
		if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
		return runSessionScript(this.keyspace, args);
	}

	async get(key: string): Promise<string | null> {
		return this.keyspace.strings.get(key) ?? null;
	}

	async getrange(key: string, start: number, end: number): Promise<string> {
		return byteRange(Buffer.from(this.keyspace.strings.get(key) ?? "", "utf-8"), start, end);
	}

	async strlen(key: string): Promise<number> {
		return Buffer.byteLength(this.keyspace.strings.get(key) ?? "", "utf-8");
	}

	async set(key: string, value: string): Promise<unknown> {
		this.keyspace.strings.set(key, value);
		return "OK";
	}

	async append(key: string, value: string): Promise<number> {
		const next = `${this.keyspace.strings.get(key) ?? ""}${value}`;
		this.keyspace.strings.set(key, next);
		return Buffer.byteLength(next, "utf-8");
	}

	/** One batch of every key a `MATCH` pattern of a prefix and `*` matches, its glob characters escaped. */
	async scan(_cursor: string, ...args: string[]): Promise<[string, string[]]> {
		const pattern = args[args.findIndex(arg => arg.toUpperCase() === "MATCH") + 1] ?? "*";
		const prefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
		return ["0", [...this.keyspace.strings.keys()].filter(key => key.startsWith(prefix))];
	}

	async hgetall(key: string): Promise<Record<string, string>> {
		assertHashKey(this.keyspace, key);
		return Object.fromEntries(this.keyspace.hashes.get(key) ?? []);
	}
}

/** A key prefix of its own on a server (or on the fake), its keys deleted at the end. */
async function redisStore(url: string | undefined): Promise<Store> {
	const prefix = `omp-test:byte-windows:${crypto.randomUUID()}:`;
	const fake = url === undefined ? new FakeRedis() : undefined;
	const clients: RedisClient[] = [];
	const connect = (): RedisSessionStorageClient => {
		if (fake) return fake;
		const client = new RedisClient(url ?? "");
		clients.push(client);
		return client;
	};
	const open = (): Promise<RedisSessionStorage> => RedisSessionStorage.create({ client: connect(), prefix });
	return {
		writer: await open(),
		reopen: open,
		path: sessionPath,
		async forgetTitle(path) {
			if (fake) fake.keyspace.hashes.get(`${prefix}title`)?.delete(path);
			else await clients[0]?.send("HDEL", [`${prefix}title`, path]);
		},
		async [Symbol.asyncDispose]() {
			const [first] = clients;
			if (first) {
				const keys = (await first.send("KEYS", [`${prefix}*`])) as string[];
				if (keys.length > 0) await first.send("DEL", keys);
			}
			for (const client of clients) client.close();
		},
	};
}

/** Each backend, whether it runs here, and whether its storage reads from an offset itself (`readTextFrom`). */
const BACKENDS: ReadonlyArray<{ name: BackendName; available: boolean; readsFrom: boolean; open(): Promise<Store> }> = [
	{ name: "memory", available: true, readsFrom: false, open: memoryStore },
	{ name: "file", available: true, readsFrom: true, open: fileStore },
	{ name: "sqlite", available: true, readsFrom: true, open: () => sqlStore("sqlite", "sqlite") },
	{
		name: "postgres",
		available: !!process.env.OMP_TEST_SQL_POSTGRES_URL,
		readsFrom: true,
		open: () => sqlStore("postgres", process.env.OMP_TEST_SQL_POSTGRES_URL ?? ""),
	},
	{
		name: "mysql",
		available: !!process.env.OMP_TEST_SQL_MYSQL_URL,
		readsFrom: true,
		open: () => sqlStore("mysql", process.env.OMP_TEST_SQL_MYSQL_URL ?? ""),
	},
	{ name: "redis (fake)", available: true, readsFrom: true, open: () => redisStore(undefined) },
	{
		name: "redis (server)",
		available: !!process.env.OMP_TEST_REDIS_URL,
		readsFrom: true,
		open: () => redisStore(process.env.OMP_TEST_REDIS_URL),
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
	const mismatches: Mismatch[] = [];
	for (const offset of windowOffsets(size)) {
		for (const maxBytes of windowLimits(size)) {
			const expected = expectedWindow(body, rules, offset, maxBytes);
			const actual = await read(offset, maxBytes);
			if (!Bun.deepEquals(actual, expected)) mismatches.push({ args: [offset, maxBytes], expected, actual });
		}
	}
	return mismatches;
}

for (const backend of BACKENDS) {
	describe.skipIf(!backend.available)(`byte windows of a session (${backend.name})`, () => {
		const rules = rulesOf(backend.name);
		let store: Store | undefined;
		let reader: SessionStorage;

		beforeAll(async () => {
			store = await backend.open();
			for (const body of BODIES) {
				const path = store.path(body);
				await store.writer.writeText(path, body.written);
				if (body.retitle) await store.writer.updateSessionTitle(path, body.retitle);
			}
			await store.writer.drain();
			for (const body of BODIES) if (body.forgetTitle) await store.forgetTitle(store.path(body));
			reader = await store.reopen();
		});

		afterAll(async () => {
			await store?.[Symbol.asyncDispose]();
		});

		for (const body of BODIES) {
			it(`readText of ${body.name}`, async () => {
				const text = textOf(body).toString("utf-8");
				const expected = rules.readTextDropsBom && text.startsWith("\uFEFF") ? text.slice(1) : text;
				expect(await reader.readText(store?.path(body) ?? "")).toBe(expected);
			});

			it(`readTextSlices of ${body.name}`, async () => {
				const path = store?.path(body) ?? "";
				const counts = sliceCounts(textOf(body).length);
				const mismatches: Mismatch[] = [];
				for (const prefixBytes of counts) {
					for (const suffixBytes of counts) {
						const expected = expectedSlices(body, rules, prefixBytes, suffixBytes);
						const actual = await reader.readTextSlices(path, prefixBytes, suffixBytes);
						if (!Bun.deepEquals(actual, expected))
							mismatches.push({ args: [prefixBytes, suffixBytes], expected, actual });
					}
				}
				expect(mismatches).toEqual([]);
			});

			it.skipIf(!backend.readsFrom)(`readTextFrom of ${body.name}`, async () => {
				const path = store?.path(body) ?? "";
				const mismatches = await windowMismatches(body, rules, (offset, maxBytes) => {
					if (!reader.readTextFrom) throw new Error(`${backend.name} storage has no readTextFrom`);
					return reader.readTextFrom(path, offset, maxBytes);
				});
				expect(mismatches).toEqual([]);
			});

			it(`readSessionTextFrom of ${body.name}`, async () => {
				const path = store?.path(body) ?? "";
				const mismatches = await windowMismatches(body, rules, (offset, maxBytes) =>
					readSessionTextFrom(reader, path, offset, maxBytes),
				);
				expect(mismatches).toEqual([]);
			});
		}
	});
}
