/**
 * Opening a session at a new path writes its header at once (a subagent's transcript, `--session <new
 * path>`). When the store refuses that first write — a full disk, a SQL store whose connection is
 * read-only or refused — the open still returns, as a session started any other way does: the header
 * and every later entry stay in memory, and the next append's full rewrite writes all of them once
 * the store accepts writes again. The open makes one attempt and does not wait for the store.
 * A write conflict and every error that is not a refused write still reject the open.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function tempDir(): TempDir {
	const dir = TempDir.createSync("@pi-open-refused-first-write-");
	tempDirs.push(dir);
	return dir;
}

function assistant(text: string): AssistantMessage {
	const usage: Usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text", text }],
		usage,
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** The ids a session file holds, header first, in file order (the title slot line carries none). */
function storedIds(content: string): string[] {
	return content
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as { type: string; id?: string })
		.filter(record => record.type !== "title")
		.map(record => record.id as string);
}

/** The ids the manager holds, header first. */
function heldIds(manager: SessionManager): string[] {
	return [manager.getHeader()?.id as string, ...manager.getEntries().map(entry => entry.id)];
}

/** A local disk every file store a test builds on it shares: full until `full` turns false. */
interface Disk {
	full: boolean;
	/** Writes the stores on it refused. */
	refused: number;
	/** Writes they were asked for on the paths they watch, refused or not. */
	attempts: number;
}

/**
 * The default file store on `disk`. While the disk is full it refuses every write to a path `refuses`
 * accepts (every path by default), as a full disk refuses a session file's write.
 */
class FullDiskStorage extends FileSessionStorage {
	constructor(
		readonly disk: Disk = { full: true, refused: 0, attempts: 0 },
		readonly refuses: (fpath: string) => boolean = () => true,
	) {
		super();
	}

	#refuse(fpath: string): void {
		if (!this.refuses(fpath)) return;
		this.disk.attempts++;
		if (!this.disk.full) return;
		this.disk.refused++;
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	}

	override writeTextSync(fpath: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#refuse(fpath);
		super.writeTextSync(fpath, content, options);
	}

	override async writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.#refuse(fpath);
		await super.writeTextAtomic(fpath, content, options);
	}
}

type Refusal = "read-only" | "connection";

/**
 * SQLite behind the client interface the SQL store drives, refusing as a PostgreSQL store does while
 * `refusal` is set: "read-only" refuses every write with 25006 (a pooled backend left in a read-only
 * transaction), "connection" refuses every statement (the pooler is down).
 */
class RefusingSqlClient implements SqlSessionStorageClient {
	readonly options: SqlSessionStorageClient["options"];
	refusal: Refusal | undefined;
	refused = 0;
	readonly #client: InstanceType<typeof SQL>;

	constructor(client: InstanceType<typeof SQL>) {
		this.#client = client;
		this.options = client.options;
	}

	#refuses(query: string | undefined): boolean {
		if (this.refusal === "connection") return true;
		return this.refusal === "read-only" && (query === undefined || /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query));
	}

	#error(): Error {
		this.refused++;
		return this.refusal === "connection"
			? Object.assign(new Error("Failed to connect"), {
					name: "PostgresError",
					code: "ERR_POSTGRES_CONNECTION_CLOSED",
				})
			: Object.assign(new Error("cannot execute INSERT in a read-only transaction"), {
					name: "PostgresError",
					code: "ERR_POSTGRES_SERVER_ERROR",
					errno: "25006",
				});
	}

	async unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult> {
		if (this.#refuses(query)) throw this.#error();
		return (await this.#client.unsafe(query, values)) as SqlSessionStorageResult;
	}

	async transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> {
		if (this.#refuses(undefined)) throw this.#error();
		await this.#client.transaction(transaction => callback(transaction));
	}

	async end(): Promise<void> {
		await this.#client.end();
	}
}

/**
 * What the SQL store's tables hold for `sessionFile`, read by a second store on the same database (so
 * through no cache of the store under test, and whatever its row layout), with the refusal lifted.
 */
async function storedSqlContent(client: RefusingSqlClient, sessionFile: string): Promise<string> {
	const refusal = client.refusal;
	client.refusal = undefined;
	try {
		const reader = await SqlSessionStorage.create({ client });
		return reader.existsSync(sessionFile) ? await reader.readText(sessionFile) : "";
	} finally {
		client.refusal = refusal;
	}
}

describe("SessionManager.open of a new session file while the store refuses writes", () => {
	it("returns after one refused attempt and writes every entry once the file store accepts writes", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "child.jsonl");
		const storage = new FullDiskStorage();

		const manager = await SessionManager.open(sessionFile, sessionDir, storage, { initialCwd: dir.path() });
		// One attempt: the open neither waits for the store nor retries before it returns.
		expect(storage.disk.refused).toBe(1);
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(manager.getSessionFile()).toBe(path.resolve(sessionFile));

		manager.appendMessage({ role: "user", content: "while full", timestamp: Date.now() });
		expect(storage.disk.refused).toBe(2);
		expect(fs.existsSync(sessionFile)).toBe(false);

		storage.disk.full = false;
		manager.appendMessage(assistant("after the disk has room"));
		await manager.flush();

		expect(storedIds(fs.readFileSync(sessionFile, "utf8"))).toEqual(heldIds(manager));
		expect(manager.getEntries()).toHaveLength(2);
		await manager.close();
	});

	for (const refusal of ["read-only", "connection"] as const) {
		it(`returns and writes every entry once a SQL store that refused with a ${refusal} error accepts writes`, async () => {
			const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
			const storage = await SqlSessionStorage.create({ client });
			const sessionDir = path.resolve(`/sessions/refused-${refusal}`);
			const sessionFile = path.join(sessionDir, "child.jsonl");

			client.refusal = refusal;
			const manager = await SessionManager.open(sessionFile, sessionDir, storage, { initialCwd: "/cwd" });
			const errors: string[] = [];
			manager.onPersistenceError(error => errors.push(`${error.name}: ${error.message}`));
			expect(client.refused).toBeGreaterThan(0);
			expect(await storedSqlContent(client, sessionFile)).toBe("");

			manager.appendMessage({ role: "user", content: "while refused", timestamp: Date.now() });
			await storage.drain().catch(() => undefined);
			expect(await storedSqlContent(client, sessionFile)).toBe("");

			client.refusal = undefined;
			manager.appendMessage(assistant("after the store is back"));
			await manager.flush();
			await storage.drain();

			// The failures the session reported ride along, so a red names the write that failed.
			expect({ stored: storedIds(await storedSqlContent(client, sessionFile)), errors }).toMatchObject({
				stored: heldIds(manager),
			});
			expect(errors[0]).toContain(refusal === "connection" ? "Failed to connect" : "read-only");
			expect(manager.getEntries()).toHaveLength(2);
			await manager.close();
			await client.end();
		});
	}

	it("control: on a store that accepts writes the header is written at open, as before", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "child.jsonl");
		const storage = new FullDiskStorage();
		storage.disk.full = false;

		const manager = await SessionManager.open(sessionFile, sessionDir, storage, { initialCwd: dir.path() });
		expect(storedIds(fs.readFileSync(sessionFile, "utf8"))).toEqual(heldIds(manager));

		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistant("hi"));
		await manager.flush();
		expect(storedIds(fs.readFileSync(sessionFile, "utf8"))).toEqual(heldIds(manager));
		expect(storage.disk.refused).toBe(0);
		await manager.close();
	});

	it("a resume of an empty file still rejects with throwIfMissing, and the file is not modified", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "empty.jsonl");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(sessionFile, "");
		const storage = new FullDiskStorage();

		await expect(SessionManager.open(sessionFile, sessionDir, storage, { throwIfMissing: true })).rejects.toThrow(
			"the session file holds no entries",
		);
		expect(storage.disk.refused).toBe(0);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe("");
	});

	it("a write conflict on the first write still rejects the open, and the other writer's file is kept", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "raced.jsonl");
		const theirs = `${JSON.stringify({ type: "session", version: 3, id: "another-writer", timestamp: new Date().toISOString(), cwd: "/elsewhere" })}\n`;

		/** Another writer creates the file between this manager's load and its first write. */
		class RacedStorage extends FileSessionStorage {
			override async writeTextAtomic(
				fpath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				if (!fs.existsSync(sessionFile)) {
					fs.mkdirSync(sessionDir, { recursive: true });
					fs.writeFileSync(sessionFile, theirs);
				}
				await super.writeTextAtomic(fpath, content, options);
			}
		}

		await expect(
			SessionManager.open(sessionFile, sessionDir, new RacedStorage(), { initialCwd: dir.path() }),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(theirs);
	});

	it("an error that is not a refused write still rejects the open: a session file that cannot be read", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "a-directory.jsonl");
		fs.mkdirSync(sessionFile, { recursive: true });
		const storage = new FullDiskStorage();
		storage.disk.full = false;

		await expect(SessionManager.open(sessionFile, sessionDir, storage, { initialCwd: dir.path() })).rejects.toThrow();
		expect(fs.statSync(sessionFile).isDirectory()).toBe(true);
		expect(storage.disk.refused).toBe(0);
	});
});

describe("a session the store refused", () => {
	it("opened at a new path (`--session <new path>`) starts, and an observer that subscribes after the open gets the failure", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const storage = new FullDiskStorage();

		const manager = await SessionManager.open(path.join(sessionDir, "new.jsonl"), sessionDir, storage, {
			initialCwd: dir.path(),
		});
		const seen: string[] = [];
		manager.onPersistenceError(error => seen.push(error.message));
		expect(seen).toEqual(["ENOSPC: no space left on device, write"]);
	});

	it("keeps a transcript its close could not write, and the next write another session lands on the store sends it", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const disk: Disk = { full: true, refused: 0, attempts: 0 };
		const childFile = path.join(sessionDir, "parent", "child.jsonl");

		const child = await SessionManager.open(childFile, undefined, new FullDiskStorage(disk), {
			initialCwd: dir.path(),
		});
		child.appendMessage({ role: "user", content: "while full", timestamp: Date.now() });
		child.appendMessage(assistant("closing while full"));
		const childIds = heldIds(child);
		child.seal();
		await expect(child.close()).rejects.toThrow("ENOSPC");
		// Session dispose releases the entries after the close; a held transcript keeps them until it is sent.
		child.releaseRetainedEntries();
		expect(child.getEntries()).toHaveLength(2);
		expect(fs.existsSync(childFile)).toBe(false);

		disk.full = false;
		const parent = SessionManager.create(dir.path(), sessionDir, new FullDiskStorage(disk));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		expect(storedIds(fs.readFileSync(childFile, "utf8"))).toEqual(childIds);
		expect(child.getEntries()).toHaveLength(0);
	});

	it("writes an idle session's unsaved entries once another session's write lands on the store", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const disk: Disk = { full: true, refused: 0, attempts: 0 };
		const childFile = path.join(sessionDir, "parent", "child.jsonl");

		const child = await SessionManager.open(childFile, undefined, new FullDiskStorage(disk), {
			initialCwd: dir.path(),
		});
		child.appendMessage({ role: "user", content: "while full", timestamp: Date.now() });
		child.appendMessage(assistant("idle after this"));
		expect(fs.existsSync(childFile)).toBe(false);

		disk.full = false;
		const parent = SessionManager.create(dir.path(), sessionDir, new FullDiskStorage(disk));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.flush();

		// The child appended nothing since the store came back.
		expect(storedIds(fs.readFileSync(childFile, "utf8"))).toEqual(heldIds(child));
		await child.close();
		await parent.close();
	});

	for (const refusal of ["read-only", "connection"] as const) {
		it(`keeps a transcript a SQL store refused at close with a ${refusal} error, and sends it after the next write lands`, async () => {
			const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
			const storage = await SqlSessionStorage.create({ client });
			const sessionDir = path.resolve(`/sessions/held-${refusal}`);
			const childFile = path.join(sessionDir, "parent", "child.jsonl");

			client.refusal = refusal;
			const child = await SessionManager.open(childFile, undefined, storage, { initialCwd: "/cwd" });
			child.appendMessage({ role: "user", content: "while refused", timestamp: Date.now() });
			child.appendMessage(assistant("closing while refused"));
			const childIds = heldIds(child);
			child.seal();
			await expect(child.close()).rejects.toThrow();
			child.releaseRetainedEntries();
			expect(child.getEntries()).toHaveLength(2);
			expect(await storedSqlContent(client, childFile)).toBe("");

			client.refusal = undefined;
			const parent = SessionManager.create("/cwd", sessionDir, storage);
			parent.appendMessage(assistant("the parent's write lands"));
			await parent.close();

			expect(storedIds(await storedSqlContent(client, childFile))).toEqual(childIds);
			expect(child.getEntries()).toHaveLength(0);
			await client.end();
		});
	}

	it("sends a held transcript once per landed write, drops it only once it lands, and never holds up the sender", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const disk: Disk = { full: true, refused: 0, attempts: 0 };
		const childFile = path.join(sessionDir, "parent", "child.jsonl");
		// The child's directory stays full after the parent's has room again.
		const childStorage = new FullDiskStorage(disk, fpath => fpath.startsWith(path.dirname(childFile)));

		const child = await SessionManager.open(childFile, undefined, childStorage, { initialCwd: dir.path() });
		child.appendMessage(assistant("closing while full"));
		child.seal();
		await expect(child.close()).rejects.toThrow("ENOSPC");
		const attemptsAtClose = disk.attempts;

		const parentStorage = new FullDiskStorage(disk, fpath => fpath.startsWith(path.dirname(childFile)));
		const parent = SessionManager.create(dir.path(), sessionDir, parentStorage);
		parent.appendMessage(assistant("one"));
		await parent.flush();
		await parent.close();
		// The parent's writes all landed; each sent the child's transcript at most once, and it is still held.
		expect(storedIds(fs.readFileSync(parent.getSessionFile() as string, "utf8"))).toEqual(heldIds(parent));
		const sentWhileFull = disk.attempts - attemptsAtClose;
		expect(sentWhileFull).toBeGreaterThan(0);
		expect(sentWhileFull).toBeLessThanOrEqual(2);
		expect(fs.existsSync(childFile)).toBe(false);

		disk.full = false;
		const next = SessionManager.create(dir.path(), sessionDir, parentStorage);
		next.appendMessage(assistant("two"));
		await next.close();
		expect(storedIds(fs.readFileSync(childFile, "utf8"))).toEqual(heldIds(child));
		const attemptsWhenSent = disk.attempts;

		// Sent, so no longer held: a later landed write does not send it again.
		const last = SessionManager.create(dir.path(), sessionDir, parentStorage);
		last.appendMessage(assistant("three"));
		await last.close();
		expect(disk.attempts).toBe(attemptsWhenSent);
	});

	it("never overwrites a held transcript's file that another writer changed", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const disk: Disk = { full: true, refused: 0, attempts: 0 };
		const childFile = path.join(sessionDir, "parent", "child.jsonl");

		const child = await SessionManager.open(childFile, undefined, new FullDiskStorage(disk), {
			initialCwd: dir.path(),
		});
		child.appendMessage(assistant("closing while full"));
		child.seal();
		await expect(child.close()).rejects.toThrow("ENOSPC");

		disk.full = false;
		const theirs = `${JSON.stringify({ type: "session", version: 3, id: "another-writer", timestamp: new Date().toISOString(), cwd: "/elsewhere" })}\n`;
		fs.mkdirSync(path.dirname(childFile), { recursive: true });
		fs.writeFileSync(childFile, theirs);
		const parent = SessionManager.create(dir.path(), sessionDir, new FullDiskStorage(disk));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		expect(fs.readFileSync(childFile, "utf8")).toBe(theirs);
	});

	it("a main session whose session directory cannot be made starts and warns, and writes once the location accepts writes", async () => {
		const dir = tempDir();
		const target = dir.join("store");
		const sessionDir = dir.join("sessions");
		// A dangling link: making the directory fails (EEXIST) until its target exists.
		fs.symlinkSync(target, sessionDir, "dir");

		const manager = SessionManager.create(dir.path(), sessionDir);
		const seen: string[] = [];
		manager.onPersistenceError(error => seen.push(error.message));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistant("the first write fails"));
		expect(seen).toHaveLength(1);

		fs.mkdirSync(target);
		manager.appendMessage(assistant("the location accepts writes"));
		await manager.flush();
		expect(storedIds(fs.readFileSync(manager.getSessionFile() as string, "utf8"))).toEqual(heldIds(manager));
		await manager.close();
	});

	it("an error making the session directory that is not a refusal still stops the start", async () => {
		const dir = tempDir();
		class BrokenDirectoryStorage extends FileSessionStorage {
			override ensureDirSync(_dir: string): void {
				throw Object.assign(new Error("ELOOP: too many symbolic links encountered, mkdir"), { code: "ELOOP" });
			}
		}
		expect(() => SessionManager.create(dir.path(), dir.join("sessions"), new BrokenDirectoryStorage())).toThrow(
			"ELOOP",
		);
	});

	it("control: a main session in a directory that can be made writes as before, with no warning", async () => {
		const dir = tempDir();
		const manager = SessionManager.create(dir.path(), dir.join("sessions"));
		const seen: string[] = [];
		manager.onPersistenceError(error => seen.push(error.message));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistant("hi"));
		await manager.flush();
		expect(storedIds(fs.readFileSync(manager.getSessionFile() as string, "utf8"))).toEqual(heldIds(manager));
		expect(seen).toEqual([]);
		await manager.close();
	});

	it("control: a session closed on a store that accepts writes is written by its close, and nothing is held", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const disk: Disk = { full: false, refused: 0, attempts: 0 };
		const childFile = path.join(sessionDir, "parent", "child.jsonl");

		const child = await SessionManager.open(childFile, undefined, new FullDiskStorage(disk), {
			initialCwd: dir.path(),
		});
		child.appendMessage(assistant("closing"));
		child.seal();
		await child.close();
		const closed = fs.readFileSync(childFile, "utf8");
		expect(storedIds(closed)).toEqual(heldIds(child));
		child.releaseRetainedEntries();
		expect(child.getEntries()).toHaveLength(0);

		const parent = SessionManager.create(dir.path(), sessionDir, new FullDiskStorage(disk));
		parent.appendMessage(assistant("later"));
		await parent.close();
		expect(fs.readFileSync(childFile, "utf8")).toBe(closed);
		expect(disk.refused).toBe(0);
	});
});
