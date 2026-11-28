/**
 * A reader of a SQL or Redis session lays over the session's head the title
 * the store holds for the very bytes it read: one store's read that another
 * client's full write races returns the old title with the old body or the new
 * title with the new body, never one version's title with the other's bytes.
 * The other client's write lands right before or right after each statement
 * (each Redis script) the read sends, on a store the reader opened before it.
 * Runs against SQLite and an in-process Redis double always, against
 * PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database, and against a Redis server when
 * `OMP_TEST_REDIS_URL` names one.
 */
import { describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { type SessionStorage, SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import type { SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { RedisClient } from "bun";
import { byteRange, runSessionScript } from "../helpers/fake-redis-windows";
import { LEASE_BACKENDS, openLeaseDb, reserveWrapped, STILL } from "./sql-session-lease-fixture";

const MiB = 1024 * 1024;
const TIMESTAMP = "2026-11-27T00:00:00.000Z";
const ID = "01a1f000-0000-7000-8000-0000000000a7";
const RACE_TIMEOUT = 120_000;

/** One committed version of the session: the title the store holds for it, and the fill of its pads. */
interface Version {
	readonly title: string;
	readonly fill: string;
}

/** Two versions whose bodies have one size and one line layout, so one rewrite keeps every part boundary. */
const FIRST: Version = { title: "Title of the first version", fill: "f" };
const SECOND: Version = { title: "Title of the other version", fill: "s" };

/** `version`'s body: its title slot, the header, then three pads of 1 MiB of its fill, as one full write stores it. */
function bodyOf(version: Version): string {
	const header = { type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/project" };
	const pads = Array.from({ length: 3 }, (_, n) =>
		JSON.stringify({
			type: "custom",
			customType: "pad",
			id: `p${n}`,
			parentId: null,
			timestamp: TIMESTAMP,
			data: version.fill.repeat(MiB),
		}),
	);
	const slot = serializeTitleSlot({ title: version.title, source: "user", updatedAt: TIMESTAMP });
	return `${slot}${[JSON.stringify(header), ...pads].join("\n")}\n`;
}

/**
 * The pair a read's text shows: the title its head carries and the fill of the
 * pads it holds, as `<title> / <fills>`; a text holding a pad of each version
 * shows both fills.
 */
function pairOf(head: string, rest = head): string {
	const title = /"title":"([^"]*)"/.exec(head)?.[1] ?? "(no title)";
	const fills = [FIRST, SECOND].filter(version => rest.includes(version.fill.repeat(64))).map(({ fill }) => fill);
	return `${title} / ${fills.join("") || "(no pad)"}`;
}

/** The pairs a read may show: one version's title with that version's bytes, or, for a chunked read, a conflict. */
const ONE_VERSION = [`${FIRST.title} / ${FIRST.fill}`, `${SECOND.title} / ${SECOND.fill}`];
const ONE_VERSION_OR_CONFLICT = [...ONE_VERSION, "read conflict"];

/** Where the other client's write lands: right before or right after the read's statement (or command) `at`, from 0. */
interface Point {
	readonly at: number;
	readonly after: boolean;
}

/**
 * Counts the statements, or the Redis commands that read a session, that a
 * store sends from {@link arm} on, and runs the race once, right before or
 * right after the one numbered `point.at`.
 */
class Gate {
	#sent = 0;
	#point: Point | undefined;
	#race: (() => Promise<void>) | undefined;
	ran = false;

	arm(point?: Point, race?: () => Promise<void>): void {
		this.#sent = 0;
		this.#point = point;
		this.#race = race;
		this.ran = false;
	}

	get sent(): number {
		return this.#sent;
	}

	async around<T>(call: () => Promise<T>): Promise<T> {
		const at = this.#sent++;
		if (this.#point?.at === at && !this.#point.after) await this.#run();
		const result = await call();
		if (this.#point?.at === at && this.#point.after) await this.#run();
		return result;
	}

	async #run(): Promise<void> {
		const race = this.#race;
		this.#race = undefined;
		if (!race) return;
		this.ran = true;
		await race();
	}
}

/** `client` with every statement it, its transactions or its reserved connections send passed through `gate`. */
function gatedSql(client: SqlSessionStorageClient, gate: Gate): SqlSessionStorageClient {
	return {
		options: client.options,
		unsafe: (query, values) => gate.around(() => client.unsafe(query, values)),
		transaction: callback =>
			client.transaction(transaction =>
				callback({ unsafe: (query, values) => gate.around(() => transaction.unsafe(query, values)) }),
			),
		end: () => client.end?.() ?? Promise.resolve(),
		...reserveWrapped(client, connection => ({
			unsafe: (query, values) => gate.around(() => connection.unsafe(query, values)),
		})),
	};
}

/** `client` with every command that reads a session (a script, GET, GETRANGE) passed through `gate`. */
function gatedRedis(client: RedisSessionStorageClient, gate: Gate): RedisSessionStorageClient {
	return {
		send: (command, args) => gate.around(() => client.send(command, args)),
		get: key => gate.around(() => client.get(key)),
		getrange: (key, start, end) => gate.around(() => client.getrange(key, start, end)),
		strlen: key => client.strlen(key),
		set: (key, value) => client.set(key, value),
		append: (key, value) => client.append(key, value),
		scan: (cursor, ...args) => client.scan(cursor, ...args),
		hgetall: key => client.hgetall(key),
	};
}

/** A Redis double over one in-process keyspace that runs each script whole, as a server runs it. */
function fakeRedis(): RedisSessionStorageClient {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();
	return {
		async send(command, args) {
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			return runSessionScript({ strings, hashes }, args);
		},
		async get(key) {
			return strings.get(key) ?? null;
		},
		async getrange(key, start, end) {
			return byteRange(Buffer.from(strings.get(key) ?? "", "utf-8"), start, end);
		},
		async strlen(key) {
			return Buffer.byteLength(strings.get(key) ?? "", "utf-8");
		},
		async set(key, value) {
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			const next = (strings.get(key) ?? "") + value;
			strings.set(key, next);
			return Buffer.byteLength(next, "utf-8");
		},
		async scan(_cursor, ...args) {
			const prefix = String(args[args.indexOf("MATCH") + 1] ?? "*").replace(/\*$/, "");
			return ["0", [...strings.keys()].filter(key => key.startsWith(prefix))];
		},
		async hgetall(key) {
			return Object.fromEntries(hashes.get(key) ?? []);
		},
	};
}

/** A store that reads in chunks: SQL or Redis storage. */
interface ChunkedStorage extends SessionStorage {
	readChunks(path: string, fromByte?: number): AsyncIterable<Uint8Array>;
}

/** The writer and the reader (opened before the race, its statements through `gate`). */
interface Stores {
	readonly writer: SessionStorage;
	readonly reader: ChunkedStorage;
	readonly gate: Gate;
	readonly file: string;
}

/** The pair one read of `file` shows, or `read conflict`. */
type Read = (reader: ChunkedStorage, file: string) => Promise<string>;

async function chunked(reader: ChunkedStorage, file: string, stopAfter?: number): Promise<string> {
	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of reader.readChunks(file)) {
			chunks.push(chunk);
			if (chunks.length === stopAfter) break;
		}
	} catch (err) {
		if (err instanceof SessionReadConflictError) return "read conflict";
		throw err;
	}
	return pairOf(Buffer.concat(chunks).toString("utf8"));
}

const READS: ReadonlyArray<{ name: string; read: Read; may: readonly string[] }> = [
	{ name: "readText", read: async (reader, file) => pairOf(await reader.readText(file)), may: ONE_VERSION },
	{
		name: "readTextSlices, the head and the tail",
		read: async (reader, file) => {
			const [head, tail] = await reader.readTextSlices(file, 400, 4096);
			return pairOf(head, tail);
		},
		may: ONE_VERSION,
	},
	{
		name: "readTextFrom the head",
		read: async (reader, file) => pairOf((await reader.readTextFrom?.(file, 0, 800))?.text ?? ""),
		may: ONE_VERSION,
	},
	{
		name: "readTextFrom inside the title slot",
		read: async (reader, file) => pairOf((await reader.readTextFrom?.(file, 20, 800))?.text ?? ""),
		may: ONE_VERSION,
	},
	{ name: "readChunks, read to its end", read: (reader, file) => chunked(reader, file), may: ONE_VERSION_OR_CONFLICT },
	{
		name: "readChunks, closed after two chunks",
		read: (reader, file) => chunked(reader, file, 2),
		may: ONE_VERSION_OR_CONFLICT,
	},
];

/**
 * For each of {@link READS}: an ungated read counts the statements it sends;
 * then, for each point before and after each of them, the session is set to
 * {@link FIRST} and read once while the writer commits {@link SECOND} there.
 * Every read, raced at every point, must show one version's pair. `open`
 * registers each release on the case's `cleanup` as it acquires what it
 * releases, so the case releases it also when the stores fail to open or an
 * assertion fails.
 */
function sameSnapshotCases(open: (cleanup: AsyncDisposableStack) => Promise<Stores>): void {
	for (const { name, read, may } of READS) {
		it(
			`${name} shows one version's title with that version's bytes when another client's full write lands before or after any statement of it`,
			async () => {
				// If this regresses, a reader lays the title of one version of a session over the bytes of another:
				// the picker, the roster and a resume show a title the transcript they show never had, or the
				// transcript's own title never shows.
				await using cleanup = new AsyncDisposableStack();
				const { writer, reader, gate, file } = await open(cleanup);
				const first = bodyOf(FIRST);
				const second = bodyOf(SECOND);
				gate.arm();
				expect(await read(reader, file)).toBe(ONE_VERSION[0]);
				const points = Array.from({ length: gate.sent }, (_, at) => [
					{ at, after: false },
					{ at, after: true },
				]).flat();

				const outcomes: Array<{ point: string; raced: boolean; pair: string }> = [];
				for (const point of points) {
					await writer.writeText(file, first);
					gate.arm(point, () => writer.writeText(file, second));
					const pair = await read(reader, file);
					outcomes.push({ point: `${point.after ? "after" : "before"} #${point.at}`, raced: gate.ran, pair });
				}
				expect(outcomes.filter(({ raced, pair }) => !raced || !may.includes(pair))).toEqual([]);
			},
			RACE_TIMEOUT,
		);
	}
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a SQL read takes the title with the bytes it reads (${adapter})`, () => {
		sameSnapshotCases(async cleanup => {
			const db = await openLeaseDb(adapter, url ?? "");
			cleanup.defer(() => db[Symbol.asyncDispose]());
			const gate = new Gate();
			// The writer queues its SQLite calls on its own, as another process does, so its write can land
			// inside the reader's turn of the call queue.
			const writer = await db.open({
				lease: STILL,
				claims: false,
				wrap: client => ({
					options: { ...client.options, filename: "" },
					unsafe: (query, values) => client.unsafe(query, values),
					transaction: callback => client.transaction(callback),
					end: () => client.end?.() ?? Promise.resolve(),
					...reserveWrapped(client, connection => ({
						unsafe: (query, values) => connection.unsafe(query, values),
					})),
				}),
			});
			const file = `${db.dir.path()}/sessions/-project-/2026-11-27T00-00-00-000Z_${ID}.jsonl`;
			await writer.writeText(file, bodyOf(FIRST));
			const reader = await db.open({ lease: STILL, claims: false, wrap: client => gatedSql(client, gate) });
			return { writer, reader, gate, file };
		});
	});
}

/** A store on `client` under `prefix`, the writer and the reader sharing the keyspace. */
async function redisStores(raw: () => RedisSessionStorageClient, prefix: string): Promise<Stores> {
	const gate = new Gate();
	const writer = await RedisSessionStorage.create({ client: raw(), prefix });
	const file = `/sessions/-project-/2026-11-27T00-00-00-000Z_${ID}.jsonl`;
	await writer.writeText(file, bodyOf(FIRST));
	const reader = await RedisSessionStorage.create({ client: gatedRedis(raw(), gate), prefix });
	return { writer, reader, gate, file };
}

describe("a Redis read takes the title with the bytes it reads (in-process double)", () => {
	sameSnapshotCases(() => {
		const client = fakeRedis();
		return redisStores(() => client, "omp:sessions:");
	});
});

const REDIS_URL = process.env.OMP_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("a Redis read takes the title with the bytes it reads (Redis server)", () => {
	let sequence = 0;
	sameSnapshotCases(cleanup => {
		const url = REDIS_URL ?? "";
		const prefix = `omp-test:${process.pid}:${Date.now().toString(36)}:${sequence++}:`;
		// Each client the case makes and the prefix's keys are released after it, each release tried whatever the
		// others did. The keys' release is registered before any client the stores open, so it runs after they close,
		// on a client of its own.
		cleanup.defer(async () => {
			const cleaner = new RedisClient(url);
			try {
				const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
				if (keys.length > 0) await cleaner.send("DEL", keys);
			} finally {
				cleaner.close();
			}
		});
		const connect = (): RedisClient => {
			const client = new RedisClient(url);
			cleanup.defer(() => client.close());
			return client;
		};
		return redisStores(connect, prefix);
	});
});
