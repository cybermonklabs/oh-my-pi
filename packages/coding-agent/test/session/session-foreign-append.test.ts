/**
 * Another writer appends to a session a manager has open: an omp, or an SDK host's store, that claims nothing, or a
 * client that writes the store's rows or keys itself.
 *
 * A rewrite the manager queued itself (the rewrite an entry starts after a record the loader skipped, which a store
 * that defers publishes confirms later) meets the longer file. The manager reads it back once its own queued writes
 * settle, keeps the other writer's entries and publishes the whole transcript again, on every store. Only SQL storage
 * that claims sessions recovered it: on Redis and on SQL without claims the conflict was left, and every later write
 * failed with it, so the session saved nothing more.
 *
 * A rewrite a caller asks for (`rewriteEntries()`) was computed from a stale view: on the file store it is recovered
 * the same way; on a store that defers publishes it rejects with `SessionWriteConflictError` and changes nothing, as
 * docs/session.md says, and the session is kept as the other writer left it.
 *
 * Every store: the file store, SQLite, PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL`
 * name a database (each claiming sessions, as the CLI's store does, and claiming nothing, as an SDK host's may), and
 * Redis when `OMP_TEST_REDIS_URL` names a throwaway Redis 7.
 */
import { RedisClient } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorage,
	SessionWriteConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { LEASE_BACKENDS, openLeaseDb } from "./sql-session-lease-fixture";

const ID = "0199c0de-0000-7000-8000-0000000000c3";
const header = `${JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-11-21T00:00:00.000Z", cwd: "/w" })}\n`;
const userLine = (id: string, parentId: string | null, text: string) =>
	`${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-21T00:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } })}\n`;

interface Store {
	readonly root: string;
	/** A store over the data with its index loaded now. */
	open(): Promise<SessionStorage>;
	/** Write `text` as `file`'s content, as another client would. */
	put(file: string, text: string): Promise<void>;
	/** Append `text` to `file` as another writer that claims nothing does, through its own store. */
	append(file: string, text: string): Promise<void>;
	close(): Promise<void>;
}

async function fileStore(): Promise<Store> {
	const dir = TempDir.createSync("@omp-foreign-append-");
	return {
		root: dir.path(),
		open: async () => new FileSessionStorage(),
		put: async (file, text) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		},
		append: async (file, text) => fs.appendFileSync(file, text),
		close: async () => dir.removeSync(),
	};
}

/** SQL storage; the manager's store claims sessions as the CLI's does, or claims nothing as an SDK host's does. */
async function sqlStore(adapter: "sqlite" | "postgres" | "mysql", url: string, claims: boolean): Promise<Store> {
	const db = await openLeaseDb(adapter, url);
	const writer = await db.open({ claims: false });
	return {
		root: db.dir.path(),
		open: () => db.open({ claims }),
		put: (file, text) => writer.writeText(file, text),
		append: async (file, text) => {
			// Another client, as an older omp is: a store of its own, opened when it writes.
			const other = await db.open({ claims: false });
			const w = other.openWriter(file);
			await w.append(text);
			await w.close();
			await other.drain();
		},
		close: async () => {
			await db[Symbol.asyncDispose]();
		},
	};
}

async function redisStore(): Promise<Store> {
	const client = new RedisClient(process.env.OMP_TEST_REDIS_URL!);
	const prefix = `omp-test-foreign-append:${process.pid}:${Date.now().toString(36)}:`;
	const dir = TempDir.createSync("@omp-foreign-append-redis-");
	const writer = await RedisSessionStorage.create({ client, prefix });
	return {
		root: dir.path(),
		open: () => RedisSessionStorage.create({ client, prefix }),
		put: (file, text) => writer.writeText(file, text),
		append: async (file, text) => {
			const other = await RedisSessionStorage.create({ client, prefix });
			const w = other.openWriter(file);
			await w.append(text);
			await w.close();
			await other.drain();
		},
		close: async () => {
			for (const key of (await client.send("KEYS", [`${prefix}*`])) as string[]) await client.send("DEL", [key]);
			client.close();
			dir.removeSync();
		},
	};
}

/** `defers`: the store defers publishes, so a caller's stale rewrite rejects (docs/session.md). */
const STORES: ReadonlyArray<{ name: string; make: () => Promise<Store>; skip: boolean; defers: boolean }> = [
	{ name: "file", make: fileStore, skip: false, defers: false },
	...LEASE_BACKENDS.flatMap(({ adapter, url }) =>
		[true, false].map(claims => ({
			name: claims ? adapter : `${adapter} (claims nothing)`,
			make: () => sqlStore(adapter as "sqlite" | "postgres" | "mysql", url ?? "", claims),
			skip: !url,
			defers: true,
		})),
	),
	{ name: "Redis", make: redisStore, skip: !process.env.OMP_TEST_REDIS_URL, defers: true },
];

/** Each test opens a session through a manager and closes its store, which takes seconds on a loaded machine. */
const TIMEOUT = 60_000;

for (const { name, make, skip, defers } of STORES) {
	describe.skipIf(skip)(`a ${name} session another writer appends to`, () => {
		const stores: Store[] = [];
		afterAll(async () => {
			for (const store of stores.splice(0)) await store.close();
		}, TIMEOUT);
		let sequence = 0;

		async function open(before: string) {
			const store = await make();
			stores.push(store);
			const dir = path.join(store.root, `sessions-${sequence++}`);
			const file = path.join(dir, "s.jsonl");
			await store.put(file, before);
			const storage = await store.open();
			const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
			return { store, dir, file, storage, manager };
		}

		/** The other writer's entry `f1` is stored once, in the one session listed there. */
		async function expectStoredOnce(s: Awaited<ReturnType<typeof open>>): Promise<string> {
			const listed = (await listSessions(s.dir, await s.store.open())).map(info => [info.path, info.id]);
			expect(listed).toEqual([[s.file, ID]]);
			const stored = await (await s.store.open()).readText(s.file);
			expect(stored.split('"id":"f1"').length - 1).toBe(1);
			return stored;
		}

		/** The manager kept its file and id and holds `f1`, and a later entry is saved as well. */
		async function expectOneSession(s: Awaited<ReturnType<typeof open>>) {
			expect([s.manager.getSessionFile(), s.manager.getSessionId()]).toEqual([s.file, ID]);
			expect(s.manager.getEntries().map(entry => entry.id)).toContain("f1");
			s.manager.appendMessage({ role: "user", content: "a later turn", timestamp: Date.now() });
			await s.manager.flush();
			expect(await expectStoredOnce(s)).toContain("a later turn");
		}

		it(
			defers
				? "rejects a caller's stale rewrite and keeps the other writer's entry, as documented"
				: "keeps the other writer's entry through a caller's stale rewrite",
			async () => {
				const s = await open(`${header}${userLine("m1", null, "a turn")}`);
				try {
					await s.store.append(s.file, userLine("f1", "m1", "another writer's turn"));
					const rejected = await s.manager.rewriteEntries().then(
						() => undefined,
						(err: unknown) => err,
					);
					if (defers) {
						expect(rejected).toBeInstanceOf(SessionWriteConflictError);
						await expectStoredOnce(s);
						return;
					}
					expect(rejected).toBeUndefined();
					await s.manager.flush();
					await expectOneSession(s);
				} finally {
					await s.manager.close().catch(() => undefined);
				}
			},
			TIMEOUT,
		);

		it(
			"keeps the other writer's entry through the rewrite it queued at the next entry, and saves later entries",
			async () => {
				// A record the loader skips makes the next entry rewrite the whole file.
				const s = await open(`${header}not json\n${userLine("m1", null, "a turn")}`);
				try {
					await s.store.append(s.file, userLine("f1", "m1", "another writer's turn"));
					s.manager.appendMessage({ role: "user", content: "a second turn", timestamp: Date.now() });
					s.manager.appendMessage(createAssistantMessage("a reply"));
					await s.manager.flush();
					await expectOneSession(s);
				} finally {
					await s.manager.close();
				}
			},
			TIMEOUT,
		);
	});
}
