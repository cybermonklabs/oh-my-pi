/**
 * A session whose bytes are not all valid UTF-8, on every store that holds such bytes: the file store, SQLite and
 * Redis (another client can store any bytes there; PostgreSQL and MySQL refuse them). Each store decodes an invalid
 * byte to U+FFFD (3 bytes for 1), and so a character cut off at the file's end.
 *
 * The session manager expects the size in stored bytes, the size each store checks a write against. The loader and
 * the manager's recovery from a write conflict took it from the decoded text, so such a session met a size conflict
 * at its first whole rewrite (cut off: at its first append) and after three tries moved to a second file under a new
 * id. The loaded size is checked too: the conflict recovery alone would keep the session one session after a
 * needless conflict.
 *
 * Every delete accepts such a session as the picker lists it: the picker's, `deleteSessionFile` and its own
 * manager's. Redis's delete compares the head it checked with the stored head in its script; it compared the head's
 * decoded text, which does not encode back to the stored bytes, and so refused every such session.
 *
 * Redis runs when `OMP_TEST_REDIS_URL` names a throwaway Redis 7.
 */
import { RedisClient } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { openLeaseDb } from "./sql-session-lease-fixture";

const ID = "0199c0de-0000-7000-8000-0000000000a1";
const utf8 = (text: string) => Buffer.from(text, "utf8");
const headerFields = `"type":"session","version":3,"id":"${ID}","timestamp":"2026-11-21T00:00:00.000Z"`;
const header = `{${headerFields},"cwd":"/w"}\n`;
/** A user message line whose text is `before`, then `raw` bytes as they are, then `after`. */
const userLine = (id: string, parentId: string | null, before: string, raw: number[] = [], after = "") =>
	Buffer.concat([
		utf8(
			`{"type":"message","id":"${id}","parentId":${JSON.stringify(parentId)},"timestamp":"2026-11-21T00:00:01.000Z","message":{"role":"user","content":"${before}`,
		),
		Buffer.from(raw),
		utf8(`${after}","timestamp":1}}\n`),
	]);
/** `bytes` with each line ending in CR LF. */
const crlf = (bytes: Buffer) => Buffer.from(bytes.toString("latin1").replaceAll("\n", "\r\n"), "latin1");

function userTurn(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

interface Store {
	/** A directory the store's session paths go under. */
	readonly root: string;
	/** A store over the data with its index loaded now, so another client's writes before this call are in it. */
	open(): Promise<SessionStorage>;
	/** Store `bytes` as `file`'s content, byte for byte, as another client can. */
	put(file: string, bytes: Buffer): Promise<void>;
	/** Whether the store's backend holds `file`. */
	holds(file: string): Promise<boolean>;
	close(): Promise<void>;
}

async function fileStore(): Promise<Store> {
	const dir = TempDir.createSync("@omp-stored-size-");
	return {
		root: dir.path(),
		open: async () => new FileSessionStorage(),
		put: async (file, bytes) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, bytes);
		},
		holds: async file => fs.existsSync(file),
		close: async () => dir.removeSync(),
	};
}

async function sqliteStore(): Promise<Store> {
	const db = await openLeaseDb("sqlite", "");
	const writer = await db.open({ claims: false });
	return {
		root: db.dir.path(),
		open: () => db.open({}),
		put: async (file, bytes) => {
			// The store's own write makes the row; the content is then replaced as stored, which SQLite keeps as given.
			if (!(await db.row(file))) await writer.writeText(file, "");
			await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [file]);
			await db.sql(`UPDATE ${db.table} SET content = CAST(@1 AS TEXT), byte_len = @2 WHERE path = @3`, [
				bytes,
				bytes.length,
				file,
			]);
		},
		holds: async file => (await db.row(file)) !== undefined,
		close: async () => {
			await db[Symbol.asyncDispose]();
		},
	};
}

async function redisStore(): Promise<Store> {
	const client = new RedisClient(process.env.OMP_TEST_REDIS_URL!);
	const prefix = `omp-test-stored-size:${process.pid}:${Date.now().toString(36)}:`;
	const dir = TempDir.createSync("@omp-stored-size-redis-");
	return {
		root: dir.path(),
		open: () => RedisSessionStorage.create({ client, prefix }),
		put: async (file, bytes) => {
			// The client sends text; the script stores the bytes its hex names.
			await client.send("EVAL", [
				"redis.call('SET', KEYS[1], (ARGV[1]:gsub('..', function(h) return string.char(tonumber(h, 16)) end))) return 1",
				"1",
				`${prefix}file:${file}`,
				bytes.toString("hex"),
			]);
		},
		holds: async file => Number(await client.send("EXISTS", [`${prefix}file:${file}`])) === 1,
		close: async () => {
			for (const key of (await client.send("KEYS", [`${prefix}*`])) as string[]) await client.send("DEL", [key]);
			client.close();
			dir.removeSync();
		},
	};
}

/**
 * `recovers`: a whole rewrite takes another writer's append into the session. The key-indexed stores fail such a
 * rewrite instead, a valid line too, so the cases with another writer run on the file store only.
 */
const STORES: ReadonlyArray<{ name: string; make: () => Promise<Store>; skip: boolean; recovers: boolean }> = [
	{ name: "file", make: fileStore, skip: false, recovers: true },
	{ name: "SQLite", make: sqliteStore, skip: false, recovers: false },
	{ name: "Redis", make: redisStore, skip: !process.env.OMP_TEST_REDIS_URL, recovers: false },
];

/**
 * Each test opens a few sessions through a manager, and each store closes its database at the end, which takes
 * seconds on a loaded machine.
 */
const TIMEOUT = 60_000;

for (const { name, make, skip, recovers } of STORES) {
	describe.skipIf(skip)(`a ${name} session whose bytes are not all valid UTF-8`, () => {
		const stores: Store[] = [];
		afterAll(async () => {
			for (const store of stores.splice(0)) await store.close();
		}, TIMEOUT);
		const newStore = async () => {
			const store = await make();
			stores.push(store);
			return store;
		};
		let sequence = 0;

		/** `bytes` stored as a new session file, loaded with its stored size, and opened by a manager. */
		async function open(
			store: Store,
			bytes: Buffer,
		): Promise<{ file: string; dir: string; storage: SessionStorage; manager: SessionManager }> {
			const dir = path.join(store.root, `sessions-${sequence++}`);
			const file = path.join(dir, "s.jsonl");
			await store.put(file, bytes);
			const storage = await store.open();
			expect((await loadSessionFile(file, storage)).sourceSize).toBe(bytes.length);
			const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
			return { file, dir, storage, manager };
		}

		/** The session is still one session: the manager kept its file and id, and the listing names only it. */
		async function expectOneSession(dir: string, storage: SessionStorage, file: string, manager: SessionManager) {
			expect([manager.getSessionFile(), manager.getSessionId()]).toEqual([file, ID]);
			const listed = (await listSessions(dir, storage)).map(info => [info.path, info.id]);
			expect(listed).toEqual([[file, ID]]);
		}

		describe("stays one session", () => {
			it(
				"through an append and a whole rewrite, with an invalid byte in a message",
				async () => {
					const store = await newStore();
					const s = await open(store, Buffer.concat([utf8(header), userLine("m1", null, "a", [0xff], "b")]));
					try {
						s.manager.appendMessage(userTurn("a second turn"));
						s.manager.appendMessage(createAssistantMessage("a reply"));
						await s.manager.flush();
						await s.manager.rewriteEntries();
						await s.manager.flush();
						await expectOneSession(s.dir, s.storage, s.file, s.manager);
					} finally {
						await s.manager.close();
					}
				},
				TIMEOUT,
			);

			it(
				"through an append, with a character cut off at the end of the file",
				async () => {
					const store = await newStore();
					// The last line stops after the first byte of a two-byte character (é is C3 A9), with no newline.
					const cut = userLine("m2", "m1", "caf", [0xc3]).subarray(0, -utf8(`","timestamp":1}}\n`).length);
					const s = await open(store, Buffer.concat([utf8(header), userLine("m1", null, "a turn"), cut]));
					try {
						s.manager.appendMessage(userTurn("a second turn"));
						s.manager.appendMessage(createAssistantMessage("a reply"));
						await s.manager.flush();
						await expectOneSession(s.dir, s.storage, s.file, s.manager);
					} finally {
						await s.manager.close();
					}
				},
				TIMEOUT,
			);

			if (!recovers) return;

			it(
				"through a whole rewrite after another writer appended a line with an invalid byte",
				async () => {
					const store = await newStore();
					const before = Buffer.concat([utf8(header), userLine("m1", null, "a turn")]);
					const s = await open(store, before);
					try {
						await store.put(s.file, Buffer.concat([before, userLine("f1", "m1", "x", [0xff], "y")]));
						await s.manager.rewriteEntries();
						await s.manager.flush();
						await expectOneSession(s.dir, s.storage, s.file, s.manager);
						expect(s.manager.getEntries().map(entry => entry.id)).toContain("f1");
					} finally {
						await s.manager.close();
					}
				},
				TIMEOUT,
			);

			// A record the loader skips makes the next entry rewrite the whole file at once, from the call that adds
			// it: on the file store, through the manager's synchronous recovery when another writer appended meanwhile.
			it(
				"through a rewrite at the next entry after another writer appended a line with an invalid byte",
				async () => {
					const store = await newStore();
					const before = Buffer.concat([utf8(header), utf8("not json\n"), userLine("m1", null, "a turn")]);
					const s = await open(store, before);
					try {
						await store.put(s.file, Buffer.concat([before, userLine("f1", "m1", "x", [0xff], "y")]));
						s.manager.appendMessage(userTurn("a second turn"));
						await s.manager.flush();
						await expectOneSession(s.dir, s.storage, s.file, s.manager);
						expect(s.manager.getEntries().map(entry => entry.id)).toContain("f1");
					} finally {
						await s.manager.close();
					}
				},
				TIMEOUT,
			);
		});

		const PLACES: Record<string, Buffer> = {
			"in a message": Buffer.concat([utf8(header), userLine("m1", null, "a", [0xff], "b")]),
			"in the header": Buffer.concat([
				utf8(`{${headerFields},"cwd":"/w`),
				Buffer.from([0xff]),
				utf8(`"}\n`),
				userLine("m1", null, "a turn"),
			]),
			"after a byte order mark": Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				utf8(header),
				userLine("m1", null, "a", [0xff], "b"),
			]),
			"next to a real U+FFFD": Buffer.concat([utf8(header), userLine("m1", null, "a\uFFFD", [0xff], "b")]),
			"with CR LF line ends": crlf(Buffer.concat([utf8(header), userLine("m1", null, "a", [0xff], "b")])),
		};

		describe("is deleted as listed", () => {
			for (const [place, bytes] of Object.entries(PLACES)) {
				it(
					`with the byte ${place}, by the picker, deleteSessionFile and its own manager`,
					async () => {
						const store = await newStore();
						const deletes: Record<string, (file: string, dir: string, storage: SessionStorage) => Promise<void>> =
							{
								picker: (file, _dir, storage) =>
									SessionManager.deleteListedSession({ path: file, id: ID }, storage),
								deleteSessionFile: (file, _dir, storage) => SessionManager.deleteSessionFile(file, storage),
								own: async (file, dir, storage) => {
									const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
									try {
										await manager.dropSession(file);
									} finally {
										await manager.close();
									}
								},
							};
						const outcomes: Record<string, string> = {};
						for (const [how, remove] of Object.entries(deletes)) {
							const dir = path.join(store.root, `sessions-${sequence++}`);
							const file = path.join(dir, "s.jsonl");
							await store.put(file, bytes);
							const storage = await store.open();
							const listed = (await listSessions(dir, storage)).map(info => info.id);
							const outcome = await remove(file, dir, storage).then(
								() => "deleted",
								(err: unknown) => `refused: ${err instanceof Error ? err.message : String(err)}`,
							);
							outcomes[how] = `${listed.join(",")} ${outcome}, held: ${await store.holds(file)}`;
						}
						const expected = `${ID} deleted, held: false`;
						expect(outcomes).toEqual({ picker: expected, deleteSessionFile: expected, own: expected });
					},
					TIMEOUT,
				);
			}
		});
	});
}
