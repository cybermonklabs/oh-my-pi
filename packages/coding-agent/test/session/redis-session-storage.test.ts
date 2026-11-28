/**
 * Functional tests for {@link RedisSessionStorage}. Driven by a hand-rolled
 * fake Redis client (`test/helpers/fake-redis.ts`) so the suite runs without a
 * live server. The fake answers each script the storage sends by the marker on
 * its first line (`-- OMP_…`), doing in TypeScript what that script does; the
 * cases of titles, moves and removals also run through the storage's own
 * scripts on a Redis server when `OMP_TEST_REDIS_URL` names one.
 *
 * The harness mirrors only the surface the storage actually uses; it is *not*
 * a general-purpose mock. Each test exercises one contract:
 *
 * - the metadata index keeps `existsSync`/`statSync`/`listFilesSync`
 *   coherent with `writeText`/`writer.append`;
 * - `drain()` waits for fire-and-forget background writes;
 * - `deleteSessionWithArtifacts` removes both the JSONL key and any sidecar
 *   keys under the artifacts prefix, a key another client set there after the
 *   store's refresh included;
 * - `refresh()` re-loads the keyspace, so a peer process's writes become
 *   visible after an explicit re-scan;
 * - a move takes the key's mtime and title with it, and `renameNoReplace`
 *   leaves a destination another client set as it was;
 * - every read takes a session's title metadata in the script that reads its
 *   bytes, so another store's rename or clear shows at once, and a move or a
 *   rewrite carries no earlier title onto the next body;
 * - a title update for a session another store removed rejects with `ENOENT`
 *   and stores nothing, and a session an append starts at its path shows no
 *   title.
 *
 * Each case and hook has a timeout of its own (30 s: a few writes, reads and
 * scripts, on the fake or on a server).
 */

import { RedisClient } from "bun";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { createFakeRedis, type FakeRedis, type FakeRedisCall } from "../helpers/fake-redis";

const SESSION_HEADER = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;

/** The first line every reader of `storage` gives `path`: its text, its head slice, its head window and its line scan. */
async function headsOf(storage: RedisSessionStorage, path: string): Promise<Record<string, string>> {
	const firstLine = (text: string): string => text.split("\n")[0] ?? "";
	let scanned = "";
	await storage.scanLines(path, line => {
		scanned = line;
		return true;
	});
	return {
		readText: firstLine(await storage.readText(path)),
		readTextSlices: firstLine((await storage.readTextSlices(path, 4096, 0))[0]),
		readTextFrom: firstLine((await storage.readTextFrom(path, 0, 4096)).text),
		scanLines: scanned,
	};
}

/** `line` as the first line of every reader {@link headsOf} asks. */
function everywhere(line: string): Record<string, string> {
	return { readText: line, readTextSlices: line, readTextFrom: line, scanLines: line };
}

/** The title slot `update` makes, as a line. */
function slotLine(update: SessionTitleUpdate): string {
	return serializeTitleSlot(update).slice(0, -1);
}

/** A session's header and one entry naming it, so a read shows whose body it got. */
function bodyOf(name: string): string {
	return `${SESSION_HEADER}${JSON.stringify({ type: "custom", customType: "body", data: name })}\n`;
}

describe("RedisSessionStorage", () => {
	let redis: FakeRedis;

	beforeEach(() => {
		redis = createFakeRedis();
	}, 30_000);

	it("indexes writeText metadata and reads content asynchronously", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
	}, 30_000);

	it("commits file content and metadata through one atomic Redis script", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/atomic.jsonl";
		await storage.writeText(sessionPath, "old\n");
		const oldMtime = redis.hashes.get("omp:sessions:meta")?.get(sessionPath);
		redis.failNext("send", new Error("EVAL transport failed"));

		await expect(storage.writeTextAtomic(sessionPath, "new\n")).rejects.toThrow("EVAL transport failed");

		expect(redis.strings.get(`omp:sessions:file:${sessionPath}`)).toBe("old\n");
		expect(redis.hashes.get("omp:sessions:meta")?.get(sessionPath)).toBe(oldMtime);
		expect(storage.statSync(sessionPath).size).toBe(4);
		expect(redis.calls.some(call => call.method === "send" && call.args[0] === "EVAL")).toBe(true);
	}, 30_000);

	it("create() warms the metadata index with STRLEN and never reads full content", async () => {
		redis.strings.set("omp:sessions:file:/sessions/p/huge.jsonl", "0123456789");
		redis.hashes.set("omp:sessions:meta", new Map([["/sessions/p/huge.jsonl", String(Date.now())]]));

		const storage = await RedisSessionStorage.create({ client: redis });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		// Every content read is a script (`send`), as `get` was before.
		expect(redis.calls.some(call => call.method === "get" || call.method === "send")).toBe(false);
		expect(redis.calls.some(call => call.method === "strlen")).toBe(true);
	}, 30_000);

	it("listFilesSync returns only direct children matching the glob", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		const jsonl = storage.listFilesSync("/dir", "*.jsonl").sort();
		expect(jsonl).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);

		const bak = storage.listFilesSync("/dir", "*.bak");
		expect(bak).toEqual(["/dir/note.bak"]);
	}, 30_000);

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");

		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	}, 30_000);

	it("writer.append appends to Redis after drain", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from Redis.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		// Redis has not necessarily caught up yet — drain to force.
		await storage.drain();
		expect(redis.strings.get("omp:sessions:file:/sessions/p/session.jsonl")).toBe(
			'{"type":"session"}\n{"type":"message"}\n',
		);

		await writer.close();
	}, 30_000);

	it("flags='w' truncates both index metadata and Redis", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/keep.jsonl")).toBe("fresh\n");
	}, 30_000);

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");
		redis.failNext("append", new Error("redis exploded"));
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow("redis exploded");
		expect(writer.getError()?.message).toBe("redis exploded");
	}, 30_000);

	it("rename rolls back the index when Redis RENAME fails", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "keep\n");
		redis.failNext("rename", new Error("ERR redis rejected rename"));

		await expect(storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl")).rejects.toThrow(
			"ERR redis rejected rename",
		);

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.existsSync("/sessions/p/b.jsonl")).toBe(false);
	}, 30_000);

	it("refresh() reloads the metadata index from Redis after out-of-band writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		// Simulate a peer process writing directly to Redis.
		redis.strings.set("omp:sessions:file:/peer/x.jsonl", "from peer\n");
		const peerHash = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
		peerHash.set("/peer/x.jsonl", String(Date.now() + 5_000));
		redis.hashes.set("omp:sessions:meta", peerHash);

		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);
		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
	}, 30_000);

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
	}, 30_000);

	// If this regresses, a title update the server never stored shows on this store (or its time does) until a
	// refresh, or a later update after a failed one is lost on another store.
	it("keeps the durable title and time on this store and another when a title write fails before it runs, and a later one wins", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const peer = await RedisSessionStorage.create({ client: redis });
		const path = "/s/failed-title.jsonl";
		const durable: SessionTitleUpdate = { title: "Durable", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(durable)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = storage.statSync(path).mtimeMs;

		// The title script's first write; the fake fails it before the script changes anything.
		redis.failNext("hset", new Error("title write refused before it ran"));
		await expect(
			storage.updateSessionTitle(path, { title: "Lost", source: "user", updatedAt: "t2" }),
		).rejects.toThrow("title write refused before it ran");
		const afterFailure = {
			local: await headsOf(storage, path),
			peer: await headsOf(peer, path),
			time: storage.statSync(path).mtimeMs,
		};
		const later: SessionTitleUpdate = { title: "Later", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, later);
		expect({
			afterFailure,
			afterLater: { local: await headsOf(storage, path), peer: await headsOf(peer, path) },
		}).toEqual({
			afterFailure: { local: everywhere(slotLine(durable)), peer: everywhere(slotLine(durable)), time: before },
			afterLater: { local: everywhere(slotLine(later)), peer: everywhere(slotLine(later)) },
		});
	}, 30_000);

	it("custom prefix isolates keyspaces", async () => {
		const storage = await RedisSessionStorage.create({ client: redis, prefix: "proj-a:" });
		await storage.writeText("/sessions/x.jsonl", "hello\n");
		expect(redis.strings.has("proj-a:file:/sessions/x.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/x.jsonl")).toBe(false);
	}, 30_000);
});

/** A client of the Redis a case runs on: what the store uses, and the reads and writes a case makes as another client. */
type CaseClient = RedisSessionStorageClient & Pick<FakeRedis, "exists" | "del" | "hget" | "hset">;

/** The Redis a case runs on: a client of it, a key prefix of the case's own for its stores, and more clients of it. */
interface CaseRedis {
	readonly client: CaseClient;
	readonly prefix: string;
	/** Another client of the same Redis, as another process holds one. */
	connect(): CaseClient;
}

/** Whether the hash `key` holds `field`, read by `client`. */
async function hasField(client: CaseClient, key: string, field: string): Promise<boolean> {
	return (await client.hget(key, field)) !== null;
}

/** `client`, with each call a store makes through it recorded in `calls`, as the fake records the calls it gets. */
function recording(client: RedisSessionStorageClient, calls: FakeRedisCall[]): RedisSessionStorageClient {
	const record = <T>(method: string, args: unknown[], call: () => Promise<T>): Promise<T> => {
		calls.push({ method, args });
		return call();
	};
	return {
		send: (command, args) => record("send", [command, args], () => client.send(command, args)),
		get: key => record("get", [key], () => client.get(key)),
		getrange: (key, start, end) => record("getrange", [key, start, end], () => client.getrange(key, start, end)),
		strlen: key => record("strlen", [key], () => client.strlen(key)),
		set: (key, value) => record("set", [key, value], () => client.set(key, value)),
		append: (key, value) => record("append", [key, value], () => client.append(key, value)),
		scan: (cursor, ...args) => record("scan", [cursor, ...args], () => client.scan(cursor, ...args)),
		hgetall: key => record("hgetall", [key], () => client.hgetall(key)),
	};
}

/**
 * The cases of titles, moves and removals, on the Redis `open` gives each case. A case writes the keys of an older
 * build or another client with the client's own `set`, `hset` and `del`, and reads them with `get`, `exists`, `hget`
 * and `hgetall`.
 */
function scriptCases(open: (cleanup: AsyncDisposableStack) => CaseRedis): void {
	it("persists title updates as indexed fields across storage reloads", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await RedisSessionStorage.create({ client, prefix });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
	}, 30_000);

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);
		expect(await client.exists(`${prefix}file:/sessions/p/s1.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/sessions/p/s1/draft.txt`)).toBe(false);
		expect(await client.exists(`${prefix}file:/sessions/p/other.jsonl`)).toBe(true);
	}, 30_000);

	it("rename moves content and meta atomically inside the index", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);
		expect(await client.get(`${prefix}file:/sessions/p/renamed.jsonl`)).toBe("payload\n");
		expect(await client.exists(`${prefix}file:/sessions/p/orig.jsonl`)).toBe(false);
	}, 30_000);

	it("renameNoReplace refuses a destination key another client set, leaving both keys", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		// Another process sets the destination after this store loaded its index.
		await client.set(`${prefix}file:/sessions/p/b.jsonl`, "theirs\n");

		const error = await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl").then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toMatchObject({ code: "EEXIST", path: "/sessions/p/b.jsonl" });
		expect(await client.get(`${prefix}file:/sessions/p/a.jsonl`)).toBe("ours\n");
		expect(await client.get(`${prefix}file:/sessions/p/b.jsonl`)).toBe("theirs\n");
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("ours\n");
	}, 30_000);

	it("renameNoReplace moves to a free key", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/c.jsonl");

		expect(await client.exists(`${prefix}file:/sessions/p/a.jsonl`)).toBe(false);
		expect(await storage.readText("/sessions/p/c.jsonl")).toBe("ours\n");
	}, 30_000);

	it("moves a key with its mtime and title in one script, dropping a stale title at the destination", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: FakeRedisCall[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		await client.hset(`${prefix}title`, "/sessions/p/a.jsonl", JSON.stringify({ title: "Ours", updatedAt: "t1" }));
		await client.hset(`${prefix}title`, "/sessions/p/b.jsonl", JSON.stringify({ title: "Stale", updatedAt: "t0" }));
		calls.length = 0;

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");

		// Nothing runs after the script, so no other client's write can land between the parts.
		expect(calls.map(call => call.method)).toEqual(["send"]);
		expect(await client.hget(`${prefix}title`, "/sessions/p/b.jsonl")).toBe(
			JSON.stringify({ title: "Ours", updatedAt: "t1" }),
		);
		expect(await hasField(client, `${prefix}title`, "/sessions/p/a.jsonl")).toBe(false);
		expect(await hasField(client, `${prefix}meta`, "/sessions/p/a.jsonl")).toBe(false);
		expect(await hasField(client, `${prefix}meta`, "/sessions/p/b.jsonl")).toBe(true);
	}, 30_000);

	it("deleteSessionWithArtifacts removes a child key another client set after the refresh", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		const refresh = storage.refresh.bind(storage);
		let injected = false;
		storage.refresh = async () => {
			await refresh();
			// Another process commits a subagent transcript once this view is loaded.
			await client.set(`${prefix}file:/sessions/p/s1/Late.jsonl`, "late\n");
			injected = true;
		};

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(injected).toBe(true);
		expect(await client.exists(`${prefix}file:/sessions/p/s1.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/sessions/p/s1/Late.jsonl`)).toBe(false);
	}, 30_000);

	// If this regresses, a head read of a long Redis session fetches its whole value, or reads its windows without
	// the title metadata the store holds, showing the title its stored head carries. The red control for a title
	// read from another version than the bytes is the gated rewrite case in indexed-session-index-entry.test.ts.
	it("readTextSlices reads both windows and the title metadata in one script, never the whole value", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: FakeRedisCall[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		const path = "/sessions/p/big.jsonl";
		const stored = `${serializeTitleSlot({ title: "Stored title", source: "auto", updatedAt: "t1" })}${bodyOf("big")}`;
		await storage.writeText(path, stored);
		const renamed: SessionTitleUpdate = { title: "Renamed title", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const slot = Buffer.from(serializeTitleSlot(renamed), "utf-8");
		const text = Buffer.concat([slot, Buffer.from(stored, "utf-8").subarray(slot.length)]);

		calls.length = 0;
		expect({
			slices: await storage.readTextSlices(path, 300, 20),
			commands: calls.map(call => (call.method === "send" ? call.args[0] : call.method)),
		}).toEqual({
			slices: [
				text.subarray(0, 300).toString("utf-8"),
				Buffer.from(stored, "utf-8").subarray(-20).toString("utf-8"),
			],
			commands: ["EVAL"],
		});
	}, 30_000);

	// If this regresses, a store that opened a session before another store renamed or cleared its title shows the
	// old title until it refreshes, a key an older build wrote shows a title it never had, a cleared title shows
	// the one the stored head carries, or a title hash value the decoder refuses is laid over the head anyway.
	it("reads another store's rename and clear without a refresh, a key without title metadata as stored, and malformed metadata as none", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const peer = await RedisSessionStorage.create({ client, prefix });
		const path = "/s/peer.jsonl";
		const old: SessionTitleUpdate = { title: "Old", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(old)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = await headsOf(peer, path);
		const renamed: SessionTitleUpdate = { title: "New", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const afterRename = await headsOf(peer, path);
		const cleared: SessionTitleUpdate = { title: "", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, cleared);
		const afterClear = await headsOf(peer, path);

		// Keys as a build before title metadata wrote them: a value and an mtime, no title hash entry.
		const put = async (key: string, body: string): Promise<void> => {
			await client.set(`${prefix}file:${key}`, body);
			await client.hset(`${prefix}meta`, key, "1");
		};
		const storedSlot = serializeTitleSlot({ title: "Stored", source: "auto", updatedAt: "t0" });
		await put("/s/stored-slot.jsonl", `${storedSlot}${SESSION_HEADER}`);
		await put("/s/legacy.jsonl", SESSION_HEADER);
		await put("/s/malformed.jsonl", `${storedSlot}${SESSION_HEADER}`);
		await client.hset(`${prefix}title`, "/s/malformed.jsonl", '{"title":"Not decoded"');
		await peer.refresh();
		expect({
			before,
			afterRename,
			afterClear,
			storedSlot: await headsOf(peer, "/s/stored-slot.jsonl"),
			legacy: await peer.readText("/s/legacy.jsonl"),
			legacyHeads: await headsOf(peer, "/s/legacy.jsonl"),
			malformed: await headsOf(peer, "/s/malformed.jsonl"),
		}).toEqual({
			before: everywhere(slotLine(old)),
			afterRename: everywhere(slotLine(renamed)),
			afterClear: everywhere(slotLine(cleared)),
			storedSlot: everywhere(storedSlot.slice(0, -1)),
			legacy: SESSION_HEADER,
			legacyHeads: everywhere(SESSION_HEADER.slice(0, -1)),
			malformed: everywhere(storedSlot.slice(0, -1)),
		});
	}, 30_000);

	// If this regresses, the title of what a path held before shows over what it holds next: after a rewrite with
	// no title slot, after its writer empties it, or on the path a session was moved onto.
	it("carries no earlier title over a rewrite without one, a truncation, or a move onto a titled path", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const peer = await RedisSessionStorage.create({ client, prefix });
		const titled = `${serializeTitleSlot({ title: "Before", source: "user", updatedAt: "t1" })}${SESSION_HEADER}`;
		for (const path of ["/s/rewritten.jsonl", "/s/truncated.jsonl", "/s/target.jsonl"]) {
			await storage.writeText(path, titled);
			await storage.updateSessionTitle(path, { title: "Renamed before", source: "user", updatedAt: "t2" });
		}
		await storage.writeText("/s/moved.jsonl", SESSION_HEADER);

		await storage.writeText("/s/rewritten.jsonl", SESSION_HEADER);
		const writer = storage.openWriter("/s/truncated.jsonl", { flags: "w" });
		// Closed whatever the append does; a second close does nothing.
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		await storage.rename("/s/moved.jsonl", "/s/target.jsonl");
		await storage.drain();

		await peer.refresh();
		const header = everywhere(SESSION_HEADER.slice(0, -1));
		for (const view of [storage, peer]) {
			expect({
				rewritten: await headsOf(view, "/s/rewritten.jsonl"),
				truncated: await headsOf(view, "/s/truncated.jsonl"),
				target: await headsOf(view, "/s/target.jsonl"),
			}).toEqual({ rewritten: header, truncated: header, target: header });
		}
	}, 30_000);

	// If this regresses, a stale store reading slices of a deleted session whose path still has a title hash entry
	// synthesizes that title into the head slice instead of returning empty slices.
	it("readTextSlices returns empty slices with no synthesized title when the body key is missing and a title hash entry survives", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const path = "/s/deleted-with-title.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		// Another store removed the body key while a stale update left a title hash entry behind.
		await client.del(`${prefix}file:${path}`);
		await client.hset(
			`${prefix}title`,
			path,
			JSON.stringify({ title: "Stale title", source: "user", updatedAt: "t2" }),
		);

		expect(await storage.readTextSlices(path, 256, 64)).toEqual(["", ""]);
	}, 30_000);

	// If this regresses, a store whose index still lists a session another store removed writes a title for a body
	// that is gone, and the session a third store starts at that path shows that title over its own header.
	it("refuses a title update for a session another store removed, and a session started at its path later shows no title", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const stale = await RedisSessionStorage.create({ client, prefix });
		const path = "/s/removed.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await stale.refresh();
		await storage.unlink(path);

		await expect(
			stale.updateSessionTitle(path, { title: "Too late", source: "user", updatedAt: "t2" }),
		).rejects.toMatchObject({ code: "ENOENT" });

		const starter = await RedisSessionStorage.create({ client, prefix });
		const writer = starter.openWriter(path);
		await writer.append(SESSION_HEADER);
		await writer.close();
		expect(await headsOf(starter, path)).toEqual(everywhere(SESSION_HEADER.slice(0, -1)));
	}, 30_000);

	// If this regresses, a title left at a path with no body (by a build that did not refuse such an update) shows
	// over the header of the session an append then starts there.
	it("starts a session by append with its own header over a title left at a path with no body", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const path = "/s/orphaned.jsonl";
		await client.hset(`${prefix}title`, path, JSON.stringify({ title: "Orphan", source: "user", updatedAt: "t2" }));
		const storage = await RedisSessionStorage.create({ client, prefix });
		const writer = storage.openWriter(path);
		await writer.append(SESSION_HEADER);
		await writer.close();

		expect(await headsOf(storage, path)).toEqual(everywhere(SESSION_HEADER.slice(0, -1)));
		expect(await hasField(client, `${prefix}title`, path)).toBe(false);
	}, 30_000);

	// If this regresses, a title hash value with an empty time overlays a title on a transcript that never had
	// one (replacing a short header whole), or an empty title with a time stops clearing the stored one.
	it("ignores title metadata with an empty time and reads an empty title with a time as a clear", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const cleared: SessionTitleUpdate = { title: "", updatedAt: "2026-01-01T00:00:00.000Z" };
		const entries: Array<[string, string]> = [
			["/s/untimed.jsonl", JSON.stringify({ title: "Ignored", updatedAt: "" })],
			["/s/cleared.jsonl", JSON.stringify(cleared)],
		];
		for (const [path, title] of entries) {
			await client.set(`${prefix}file:${path}`, SESSION_HEADER);
			await client.hset(`${prefix}meta`, path, "1");
			await client.hset(`${prefix}title`, path, title);
		}
		const storage = await RedisSessionStorage.create({ client, prefix });

		expect({
			untimed: await headsOf(storage, "/s/untimed.jsonl"),
			cleared: await headsOf(storage, "/s/cleared.jsonl"),
		}).toEqual({
			untimed: everywhere(SESSION_HEADER.slice(0, -1)),
			cleared: everywhere(slotLine(cleared)),
		});
	}, 30_000);

	it("unlink on a missing key throws ENOENT", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	it("a refused move leaves both keys and both hashes as they were", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix, connect } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const other = await RedisSessionStorage.create({ client: connect(), prefix });
		await storage.writeText("/s/a.jsonl", "ours\n");
		await other.writeText("/s/b.jsonl", "theirs\n");
		const before = [await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)];

		await expect(storage.renameNoReplace("/s/a.jsonl", "/s/b.jsonl")).rejects.toMatchObject({
			code: "EEXIST",
			path: "/s/b.jsonl",
		});

		expect(await client.get(`${prefix}file:/s/a.jsonl`)).toBe("ours\n");
		expect(await client.get(`${prefix}file:/s/b.jsonl`)).toBe("theirs\n");
		expect([await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)]).toEqual(before);
	}, 30_000);

	it("a move carries the title metadata and drops a stale title at the destination", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/s/a.jsonl", "ours\n");
		await client.hset(`${prefix}title`, "/s/a.jsonl", '{"title":"Ours","updatedAt":"t1"}');
		await client.hset(`${prefix}title`, "/s/c.jsonl", '{"title":"Stale","updatedAt":"t0"}');

		await storage.renameNoReplace("/s/a.jsonl", "/s/c.jsonl");

		expect(await client.get(`${prefix}file:/s/c.jsonl`)).toBe("ours\n");
		expect(await client.hget(`${prefix}title`, "/s/c.jsonl")).toBe('{"title":"Ours","updatedAt":"t1"}');
		expect(await client.hget(`${prefix}title`, "/s/a.jsonl")).toBeNull();
		expect(await client.hget(`${prefix}meta`, "/s/a.jsonl")).toBeNull();
		expect(await client.hget(`${prefix}meta`, "/s/c.jsonl")).not.toBeNull();
	}, 30_000);

	it("deleting a session removes, in one command, every key and its metadata under the directory", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix, connect } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const other = await RedisSessionStorage.create({ client: connect(), prefix });
		await storage.writeText("/s/p.jsonl", "parent\n");
		// Set by another client after this store loaded its view, and never refreshed into it.
		await other.writeText("/s/p/Late*[x].jsonl", "late\n");
		await other.writeText("/s/p-sibling.jsonl", "sibling\n");
		const send = client.send.bind(client);
		const commands: string[] = [];
		client.send = (command: string, args: string[]) => {
			commands.push(command);
			return send(command, args);
		};
		storage.refresh = async () => {};

		await storage.deleteSessionWithArtifacts("/s/p.jsonl");

		expect(commands).toEqual(["EVAL"]);
		expect(await client.exists(`${prefix}file:/s/p.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/s/p/Late*[x].jsonl`)).toBe(false);
		expect(await client.hget(`${prefix}meta`, "/s/p/Late*[x].jsonl")).toBeNull();
		expect(await client.get(`${prefix}file:/s/p-sibling.jsonl`)).toBe("sibling\n");
	}, 30_000);

	it("refuses a title update for a removed session and clears a title left at a path before an append starts a session there", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix, connect } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const stale = await RedisSessionStorage.create({ client: connect(), prefix });
		const path = "/s/removed.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await stale.refresh();
		await storage.unlink(path);

		await expect(
			stale.updateSessionTitle(path, { title: "Too late", source: "user", updatedAt: "t2" }),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await client.hget(`${prefix}title`, path)).toBeNull();

		// A title another build left at the path with no body.
		await client.hset(`${prefix}title`, path, JSON.stringify({ title: "Orphan", source: "user", updatedAt: "t2" }));
		const writer = storage.openWriter(path);
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();

		expect(await client.hget(`${prefix}title`, path)).toBeNull();
		expect((await storage.readText(path)).split("\n")[0]).toBe(SESSION_HEADER.slice(0, -1));
	}, 30_000);
}

/**
 * A key prefix of the case's own on `url`'s server, and clients of it. `cleanup` closes each client as it is made,
 * then deletes the prefix's keys on a client of its own.
 */
function serverRedis(url: string, cleanup: AsyncDisposableStack): CaseRedis {
	const prefix = `omp-test:redis-session:${crypto.randomUUID()}:`;
	// Registered before any client, so it runs after they close.
	cleanup.defer(async () => {
		const cleaner = new RedisClient(url);
		try {
			const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
			if (keys.length > 0) await cleaner.send("DEL", keys);
		} finally {
			cleaner.close();
		}
	});
	const connect = (): CaseClient => {
		const client = new RedisClient(url);
		cleanup.defer(() => client.close());
		return client;
	};
	return { client: connect(), prefix, connect };
}

const REDIS_URL = process.env.OMP_TEST_REDIS_URL;

describe("RedisSessionStorage titles, moves and removals (fake)", () => {
	scriptCases(() => {
		const fake = createFakeRedis();
		return { client: fake, prefix: "omp:sessions:", connect: () => fake };
	});
});

describe.skipIf(!REDIS_URL)("RedisSessionStorage titles, moves and removals (Redis server)", () => {
	scriptCases(cleanup => serverRedis(REDIS_URL ?? "", cleanup));
});
