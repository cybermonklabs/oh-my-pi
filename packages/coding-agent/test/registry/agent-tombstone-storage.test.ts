/**
 * An explicit kill leaves a `<transcript>.tombstone` sidecar so a later
 * persisted-subagent scan lists the agent as killed, not parked. The sidecar
 * is a local file whatever the session storage. Under `session.storage: sql`
 * the transcript is a row, so the directory the sidecar goes in may not exist
 * yet; the kill must still record it. Under file storage the transcript's own
 * directory holds it, and a missing one means the transcript is gone: the
 * kill fails, as it always has, and makes no directory. Which of the two
 * holds is said by the storage that holds the agent's transcript, never by
 * the process default.
 *
 * The SQL cases run against SQLite always, and against PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a server,
 * each in a database of its own.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { cliDatabase, LEASE_BACKENDS } from "../session/sql-session-lease-fixture";

describe("agent kill tombstone storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** A SQL store on `backend`: SQLite in memory, else a database of its own on the server. */
	async function sqlStorage(backend: (typeof LEASE_BACKENDS)[number]): Promise<SqlSessionStorage> {
		if (backend.adapter === "sqlite") {
			const client = new SQL("sqlite::memory:");
			cleanups.push(() => client.end());
			return SqlSessionStorage.create({ client });
		}
		const db = await cliDatabase(backend.adapter, backend.url!);
		cleanups.push(async () => await db[Symbol.asyncDispose]());
		const storage = await SqlSessionStorage.create({ client: db.sql });
		cleanups.push(() => storage.drain());
		return storage;
	}

	function useDefault(storage: SessionStorage): void {
		const previous = defaultSessionStorage();
		setDefaultSessionStorage(storage);
		cleanups.push(() => setDefaultSessionStorage(previous));
	}

	function tempDir(prefix: string): TempDir {
		const dir = TempDir.createSync(prefix);
		cleanups.push(() => dir.removeSync());
		return dir;
	}

	function transcript(id: string): string {
		const header = { type: "session", version: 3, id, timestamp: "2026-11-02T00:00:00.000Z", cwd: "/tmp" };
		const prompt = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-11-02T00:00:01.000Z",
			message: { role: "user", content: "work", timestamp: 1 },
		};
		return `${JSON.stringify(header)}\n${JSON.stringify(prompt)}\n`;
	}

	/** A live subagent whose session reads its transcript through `storage`. */
	function registerLive(workerId: string, sessionFile: string, storage: SessionStorage, onDispose = () => {}) {
		const session = {
			dispose: async () => onDispose(),
			sessionManager: { getStorage: () => storage },
		} as unknown as AgentSession;
		return AgentRegistry.global().register({
			id: workerId,
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session,
			sessionFile,
			status: "running",
		});
	}

	it("records the kill of a subagent whose transcript file storage holds", async () => {
		const storage = new FileSessionStorage();
		useDefault(storage);
		const dir = tempDir("@omp-tombstone-storage-");
		const workerId = "Killed-Sub";
		const sessionFile = dir.join("main", `${workerId}.jsonl`);
		await storage.writeText(sessionFile, transcript(workerId));
		let disposed = 0;
		const ref = registerLive(workerId, sessionFile, storage, () => disposed++);

		expect(await AgentLifecycleManager.global().release(workerId, ref, { tombstone: true })).toBe(true);

		expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
		expect(disposed).toBe(1);
		expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
	});

	// A file-backed transcript whose directory is gone (removed by hand or by a
	// sweep) has nothing to mark: the write fails with ENOENT and the kill
	// reports it, as rpc-cancel-subagent.test.ts expects, whatever the process
	// default is. Making the directory would leave an empty transcript tree
	// behind with only a sidecar in it.
	describe("a file-backed subagent whose transcript directory is gone", () => {
		const defaults = [
			{ name: "a file-storage default", storage: async () => new FileSessionStorage() as SessionStorage },
			{
				name: "a SQL-storage default",
				storage: async () => sqlStorage(LEASE_BACKENDS[0]!) as Promise<SessionStorage>,
			},
		];
		for (const { name, storage: makeDefault } of defaults) {
			it(`fails the kill and makes no directory under ${name}`, async () => {
				useDefault(await makeDefault());
				const dir = tempDir("@omp-tombstone-gone-");
				const workerId = "Gone-Sub";
				const sessionFile = dir.join("gone", `${workerId}.jsonl`);
				let disposed = 0;
				const ref = registerLive(workerId, sessionFile, new FileSessionStorage(), () => disposed++);

				await expect(
					AgentLifecycleManager.global().release(workerId, ref, { tombstone: true }),
				).rejects.toMatchObject({ code: "ENOENT" });

				expect(fs.existsSync(dir.join("gone"))).toBe(false);
				// The kill still stops the agent: the session is disposed and the ref is terminal.
				expect(disposed).toBe(1);
				expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
			});
		}
	});

	for (const backend of LEASE_BACKENDS) {
		// The process default is file storage (an SDK host that never installs another),
		// while the subagent's transcript is a row in the SQL storage its session uses.
		// Only that storage says whether the directory beside the transcript exists.
		describe.skipIf(!backend.url)(`a SQL-backed subagent on ${backend.adapter}`, () => {
			it("records the kill of a subagent whose transcript the default SQL storage holds", async () => {
				const storage = await sqlStorage(backend);
				useDefault(storage);
				const dir = tempDir("@omp-tombstone-storage-");
				const workerId = "Killed-Sub";
				const sessionFile = dir.join("main", `${workerId}.jsonl`);
				await storage.writeText(sessionFile, transcript(workerId));
				expect(fs.existsSync(dir.join("main"))).toBe(false);
				let disposed = 0;
				const session = {
					dispose: async () => {
						disposed++;
					},
				} as unknown as AgentSession;
				const ref = AgentRegistry.global().register({
					id: workerId,
					displayName: "task",
					kind: "sub",
					parentId: MAIN_AGENT_ID,
					session,
					sessionFile,
					status: "running",
				});

				expect(await AgentLifecycleManager.global().release(workerId, ref, { tombstone: true })).toBe(true);

				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
				expect(disposed).toBe(1);
				expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
			});

			it("records the kill of a live subagent from its session's storage under a file-storage default", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-child-");
				const workerId = "Live-Sub";
				const sessionFile = dir.join("main", `${workerId}.jsonl`);
				await storage.writeText(sessionFile, transcript(workerId));
				expect(fs.existsSync(dir.join("main"))).toBe(false);
				const ref = registerLive(workerId, sessionFile, storage);

				expect(await AgentLifecycleManager.global().release(workerId, ref, { tombstone: true })).toBe(true);

				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
			});

			it("records the kill of a parked subagent from the storage its roster scan read under a file-storage default", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-child-");
				const root = dir.join("main.jsonl");
				await storage.writeText(root, transcript("main"));
				const workerId = "Parked-Sub";
				const sessionFile = dir.join("main", `${workerId}.jsonl`);
				await storage.writeText(sessionFile, transcript(workerId));
				await ensurePersistedRoster(AgentRegistry.global(), root, storage);
				const ref = AgentRegistry.global().get(workerId);
				expect(ref).toMatchObject({ status: "parked", session: null, sessionFile });
				expect(fs.existsSync(dir.join("main"))).toBe(false);

				expect(await AgentLifecycleManager.global().release(workerId, ref!, { tombstone: true })).toBe(true);

				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
			});
		});
	}
});
