/**
 * Integration: `SessionManager` driven by `RedisSessionStorage` instead of a
 * file-backed store. Verifies that the storage substrate is genuinely
 * pluggable — message append, persistence, reload via `open()`, and
 * `SessionManager.list()` all behave the same against Redis-backed keys.
 *
 * Driven by the same hand-rolled in-memory Redis double used in
 * `redis-session-storage.test.ts`; we don't require a live server.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

interface FakeRedis extends RedisSessionStorageClient {
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
}

function createFakeRedis(): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();

	const getHash = (key: string): Map<string, string> => {
		let h = hashes.get(key);
		if (!h) {
			h = new Map();
			hashes.set(key, h);
		}
		return h;
	};

	/** GETRANGE's bytes of `key`, with its negative offsets counted from the end. */
	const byteRange = (key: string, start: number, end: number): string => {
		const bytes = Buffer.from(strings.get(key) ?? "", "utf-8");
		if (bytes.length === 0) return "";
		const from = Math.max(0, start < 0 ? bytes.length + start : start);
		const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
		if (to < from) return "";
		return bytes.subarray(from, to + 1).toString("utf-8");
	};

	return {
		strings,
		hashes,
		async send(command, args) {
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			const script = args[0] ?? "";
			const keyCount = Number(args[1] ?? "0");
			const keys = args.slice(2, 2 + keyCount);
			const argv = args.slice(2 + keyCount);
			if (script.includes("OMP_WRITE_FULL")) {
				const [fileKey, metaKey, titleKey] = keys;
				const [content, filePath, mtimeMs, hasTitle, title, expectedSize] = argv;
				const current = strings.get(fileKey);
				const actualSize = current === undefined ? -1 : Buffer.byteLength(current, "utf8");
				if (expectedSize !== "" && actualSize !== Number(expectedSize)) return [0, actualSize];
				strings.set(fileKey, content);
				getHash(metaKey).set(filePath, mtimeMs);
				if (hasTitle === "1") getHash(titleKey).set(filePath, title);
				else getHash(titleKey).delete(filePath);
				return [1, Buffer.byteLength(content, "utf8")];
			}
			if (script.includes("OMP_APPEND")) {
				const [fileKey, metaKey, titleKey] = keys;
				const [line, filePath, mtimeMs] = argv;
				// An append that creates the key first drops the title the path holds for no body.
				if (!strings.has(fileKey)) getHash(titleKey).delete(filePath);
				const next = (strings.get(fileKey) ?? "") + line;
				strings.set(fileKey, next);
				getHash(metaKey).set(filePath, mtimeMs);
				return Buffer.byteLength(next, "utf-8");
			}
			if (script.includes("OMP_UPDATE_TITLE")) {
				const [metaKey, titleKey, fileKey] = keys;
				const [filePath, mtimeMs, title] = argv;
				// A title update for a missing body writes nothing and replies 0.
				if (!strings.has(fileKey)) return 0;
				getHash(metaKey).set(filePath, mtimeMs);
				getHash(titleKey).set(filePath, title);
				return 1;
			}
			if (script.includes("OMP_READ_FULL")) {
				const [fileKey, titleKey] = keys;
				const [filePath] = argv;
				const text = strings.get(fileKey);
				return text === undefined ? null : [text, hashes.get(titleKey)?.get(filePath) ?? null];
			}
			if (script.includes("OMP_READ_SLICES")) {
				const [fileKey, titleKey] = keys;
				const [filePath, prefix, suffix] = argv;
				return [
					Number(prefix) > 0 ? byteRange(fileKey, 0, Number(prefix) - 1) : "",
					Number(suffix) > 0 ? byteRange(fileKey, -Number(suffix), -1) : "",
					hashes.get(titleKey)?.get(filePath) ?? null,
				];
			}
			if (script.includes("OMP_MOVE")) {
				const [srcKey, dstKey, metaKey, titleKey] = keys;
				const [src, dst, mtimeMs, noReplace] = argv;
				if (noReplace === "1" && strings.has(dstKey)) return 0;
				const content = strings.get(srcKey);
				if (content === undefined) throw new Error("ERR no such key");
				strings.delete(srcKey);
				strings.set(dstKey, content);
				getHash(metaKey).delete(src);
				getHash(metaKey).set(dst, mtimeMs);
				const titles = getHash(titleKey);
				const title = titles.get(src);
				titles.delete(src);
				if (title === undefined) titles.delete(dst);
				else titles.set(dst, title);
				return 1;
			}
			if (script.includes("OMP_REMOVE")) {
				const [metaKey, titleKey] = keys;
				const [filePrefix, pattern, ...paths] = argv;
				if (pattern) {
					const keyPrefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
					for (const key of strings.keys()) {
						if (key.startsWith(keyPrefix)) paths.push(key.slice(filePrefix.length));
					}
				}
				for (const filePath of paths) {
					strings.delete(filePrefix + filePath);
					getHash(metaKey).delete(filePath);
					getHash(titleKey).delete(filePath);
				}
				return paths.length;
			}
			throw new Error("Unsupported Redis script");
		},
		async get(key) {
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async getrange(key, start, end) {
			return byteRange(key, start, end);
		},
		async strlen(key) {
			return Buffer.byteLength(strings.get(key) ?? "", "utf-8");
		},
		async set(key, value) {
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			const current = strings.get(key) ?? "";
			const next = current + value;
			strings.set(key, next);
			return Buffer.byteLength(next, "utf-8");
		},
		async scan(_cursor, ...rest) {
			let pattern = "*";
			for (let i = 0; i < rest.length; i++) {
				if (String(rest[i]).toUpperCase() === "MATCH") {
					pattern = String(rest[i + 1] ?? "*");
				}
			}
			const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			const matches = Array.from(strings.keys()).filter(k => regex.test(k));
			return ["0", matches];
		},
		async hgetall(key) {
			const h = hashes.get(key);
			if (!h) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of h) out[k] = v;
			return out;
		},
	};
}

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// `path.resolve` makes the virtual dirs absolute on every platform: on Windows
// `/sessions/x` is drive-relative, and `SessionManager` resolves it when reopening.
const sessionRoot = path.resolve("/sessions");

describe("SessionManager + RedisSessionStorage", () => {
	it("persists appended assistant messages into Redis and reloads them via open()", async () => {
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionDir = path.join(sessionRoot, "proj");

		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "hi" }],
			usage: fakeUsage(10, 5),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const sessionFilePath = sessionFile as string;
		expect(sessionFilePath.startsWith(sessionDir)).toBe(true);

		// `appendMessage` queues the cold-path rewrite onto SessionManager's
		// internal persist chain via a fire-and-forget call. `flush()` awaits
		// that chain; `drain()` mops up the storage-level pending tail.
		await manager.flush();
		await storage.drain();
		await manager.close();

		// Redis now contains the JSONL — title slot + header + one message entry.
		const stored = redis.strings.get(`omp:sessions:file:${sessionFilePath}`);
		expect(stored).toBeDefined();
		const lines = (stored as string).trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		const slot = JSON.parse(lines[0]);
		expect(slot.type).toBe("title");
		const header = JSON.parse(lines[1]);
		expect(header.type).toBe("session");
		const msg = JSON.parse(lines[lines.length - 1]);
		expect(msg.type).toBe("message");
		expect(msg.message.role).toBe("assistant");
		expect(msg.message.content[0].text).toBe("hi");

		// Reopening the session through SessionManager.open should recover the leaf.
		const reopened = await SessionManager.open(sessionFilePath, sessionDir, storage);
		const leaf = reopened.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf?.type).toBe("message");
		await reopened.close();
	}, 30_000);

	it("SessionManager.list returns Redis-backed sessions for the cwd", async () => {
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionDir = path.join(sessionRoot, "list-proj");

		const a = SessionManager.create("/cwd", sessionDir, storage);
		a.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "alpha" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await a.flush();
		await storage.drain();
		await a.close();

		const b = SessionManager.create("/cwd", sessionDir, storage);
		b.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "beta" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await b.flush();
		await storage.drain();
		await b.close();

		const aFile = a.getSessionFile();
		const bFile = b.getSessionFile();
		expect(aFile).toBeDefined();
		expect(bFile).toBeDefined();

		const sessions = await SessionManager.list("/cwd", sessionDir, storage);
		const sessionFiles = sessions.map(s => s.path).sort();
		expect(sessionFiles).toContain(aFile as string);
		expect(sessionFiles).toContain(bFile as string);
	}, 30_000);

	it("rejects a stale rewrite after another Redis storage appends", async () => {
		const redis = createFakeRedis();
		const firstStorage = await RedisSessionStorage.create({ client: redis });
		const sharedDir = path.join(sessionRoot, "shared");
		const first = SessionManager.create("/cwd", sharedDir, firstStorage);
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await RedisSessionStorage.create({ client: redis });
		const second = await SessionManager.open(sessionFile, sharedDir, secondStorage);
		second.appendMessage({ role: "user", content: "durable Redis peer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(redis.strings.get(`omp:sessions:file:${sessionFile}`)).toContain("durable Redis peer turn");
	}, 30_000);

	it("does not count a session as resumable while its Redis removal is in flight", async () => {
		// The removal script has run on the server but its reply has not arrived; an exit-time
		// resume hint read meanwhile would advertise a session whose content is already gone.
		const redis = createFakeRedis();
		const removalRan = Promise.withResolvers<void>();
		const allowReply = Promise.withResolvers<void>();
		const send = redis.send.bind(redis);
		redis.send = async (command, args) => {
			const result = await send(command, args);
			if (args[0]?.includes("OMP_REMOVE")) {
				removalRan.resolve();
				await allowReply.promise;
			}
			return result;
		};
		const storage = await RedisSessionStorage.create({ client: redis });
		const manager = SessionManager.create("/cwd", path.join(sessionRoot, "removing"), storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(manager.isSessionConfirmedOnDisk()).toBe(true);

		const removal = manager.dropSession(sessionFile);
		// Never rejects, so the case waits for the removal however it ends, after the reply is let through.
		const settled = removal.then(
			() => undefined,
			(error: unknown) => error,
		);
		let held: { stored: boolean; confirmed: boolean } | undefined;
		try {
			await Promise.race([removalRan.promise, settled]);
			held = {
				stored: redis.strings.has(`omp:sessions:file:${sessionFile}`),
				confirmed: manager.isSessionConfirmedOnDisk(),
			};
		} finally {
			allowReply.resolve();
		}
		expect({ held, error: await settled, after: manager.isSessionConfirmedOnDisk() }).toEqual({
			held: { stored: false, confirmed: false },
			error: undefined,
			after: false,
		});
	}, 30_000);

	it("keeps a session unconfirmed after a Redis removal fails past its file delete", async () => {
		// The removal script ran, then its reply was lost: the rollback restores the index entry,
		// but the content is gone, so an exit-time resume hint must not offer it.
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const manager = SessionManager.create("/cwd", path.join(sessionRoot, "failed-removal"), storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const send = redis.send.bind(redis);
		redis.send = async (command, args) => {
			const result = await send(command, args);
			if (args[0]?.includes("OMP_REMOVE")) throw new Error("connection lost");
			return result;
		};

		await expect(manager.dropSession(sessionFile)).rejects.toThrow("connection lost");
		expect(redis.strings.has(`omp:sessions:file:${sessionFile}`)).toBe(false);
		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);

		// An append extends whatever the backend holds, which no longer includes the header.
		const writer = storage.openWriter(sessionFile);
		try {
			await writer.append("{}\n");
		} finally {
			await writer.close();
		}
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);

		// A later full write replaces the content, so the backend confirms the path again.
		storage.writeTextSync(sessionFile, "rewritten\n");
		await storage.drain();
		expect(manager.isSessionConfirmedOnDisk()).toBe(true);
	}, 30_000);
});
