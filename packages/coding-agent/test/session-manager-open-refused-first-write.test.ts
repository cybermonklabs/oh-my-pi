/**
 * A session at a new path writes its header at once (a subagent's transcript, a seance fork, a switch
 * to a new path), and a session makes its directory when it starts. When the store refuses either (see
 * isSessionStoreWriteRefusal: a full, quota-exceeded, read-only or denied disk; a SQL store whose
 * connection is refused or whose transaction is read-only), the session still starts, as one started
 * any other way does: the refusal is latched and reported, the entries stay in memory, and a later
 * write sends them once the store accepts writes again. The first write is one attempt, with no wait.
 * A write conflict, a held publish lock, a database permission error and every other error that is not
 * a refusal still stop the session, as before.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	SessionLockError,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import {
	assistant,
	fsError,
	heldIds,
	installFullDisk,
	RefusingSqlClient,
	storedIds,
	storedSqlContent,
} from "./helpers/refusing-session-stores";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function tempDir(): TempDir {
	const dir = TempDir.createSync("@pi-open-refused-first-write-");
	tempDirs.push(dir);
	return dir;
}

const REFUSED_CODES = ["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM"] as const;

describe("a new session file whose first write the store refuses", () => {
	for (const code of REFUSED_CODES) {
		it(`opens after one refused attempt (${code}) and writes every entry once the file store accepts writes`, async () => {
			const dir = tempDir();
			const sessionDir = dir.join("sessions");
			const sessionFile = path.join(sessionDir, "child.jsonl");
			const disk = installFullDisk(fpath => fpath.startsWith(sessionDir + path.sep));
			disk.error = () => fsError(code);

			const manager = await SessionManager.open(sessionFile, sessionDir, undefined, { initialCwd: dir.path() });
			// One attempt: the open neither waits for the store nor retries before it returns.
			expect(disk.attempts).toEqual([path.resolve(sessionFile)]);
			expect(fs.existsSync(sessionFile)).toBe(false);

			manager.appendMessage({ role: "user", content: "while refused", timestamp: Date.now() });
			expect(fs.existsSync(sessionFile)).toBe(false);

			disk.full = false;
			manager.appendMessage(assistant("after the disk accepts writes"));
			await manager.flush();
			expect(storedIds(fs.readFileSync(sessionFile, "utf8"))).toEqual(heldIds(manager));
			expect(manager.getEntries()).toHaveLength(2);
			await manager.close();
		});
	}

	for (const refusal of ["read-only", "connection"] as const) {
		it(`opens and writes every entry once a SQL store that refused with a ${refusal} error accepts writes`, async () => {
			const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
			const storage = await SqlSessionStorage.create({ client });
			const sessionDir = path.resolve(`/sessions/refused-${refusal}`);
			const sessionFile = path.join(sessionDir, "child.jsonl");

			client.refusal = refusal;
			const manager = await SessionManager.open(sessionFile, sessionDir, storage, { initialCwd: "/cwd" });
			const errors: string[] = [];
			manager.onPersistenceError(error => errors.push(error.message));
			expect(errors[0]).toContain(refusal === "connection" ? "Failed to connect" : "read-only");
			expect(await storedSqlContent(client, sessionFile)).toBe("");

			manager.appendMessage({ role: "user", content: "while refused", timestamp: Date.now() });
			await storage.drain().catch(() => undefined);
			client.refusal = undefined;
			manager.appendMessage(assistant("after the store is back"));
			await manager.flush();
			await storage.drain();
			expect(storedIds(await storedSqlContent(client, sessionFile))).toEqual(heldIds(manager));
			await manager.close();
			await client.end();
		});
	}

	it("an open of a new path (a subagent's transcript, a switch to a new path) reports the refusal to an observer that subscribes after it", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const disk = installFullDisk(fpath => fpath.startsWith(sessionDir + path.sep));

		const manager = await SessionManager.open(path.join(sessionDir, "new.jsonl"), sessionDir, undefined, {
			initialCwd: dir.path(),
		});
		const seen: string[] = [];
		manager.onPersistenceError(error => seen.push(error.message));
		expect(seen).toEqual(["ENOSPC: no space left on device, write"]);

		disk.full = false;
		manager.appendMessage(assistant("written"));
		await manager.close();
	});

	it("a seance fork opens with its source's history while the store refuses, and writes it once the store accepts writes", async () => {
		const dir = tempDir();
		const sourceDir = dir.join("source");
		const source = SessionManager.create(dir.path(), sourceDir);
		source.appendMessage({ role: "user", content: "the source's question", timestamp: Date.now() });
		source.appendMessage(assistant("the source's answer"));
		await source.close();
		const forkDir = dir.join("fork");
		const forkFile = path.join(forkDir, "Seance.jsonl");
		const disk = installFullDisk(fpath => fpath.startsWith(forkDir + path.sep));

		const fork = await SessionManager.forkFrom(source.getSessionFile() as string, dir.path(), forkDir, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: forkFile,
		});
		expect(fork.getEntries().length).toBeGreaterThanOrEqual(2);
		expect(fs.existsSync(forkFile)).toBe(false);

		disk.full = false;
		fork.appendMessage(assistant("the seance's answer"));
		await fork.flush();
		expect(storedIds(fs.readFileSync(forkFile, "utf8"))).toEqual(heldIds(fork));
		await fork.close();
	});

	it("kept as before: a seance fork whose first write meets a held publish lock rejects", async () => {
		const dir = tempDir();
		const source = SessionManager.create(dir.path(), dir.join("source"));
		source.appendMessage(assistant("the source's answer"));
		await source.close();
		const forkDir = dir.join("fork");
		fs.mkdirSync(forkDir, { recursive: true });
		const forkFile = path.join(forkDir, "Seance.jsonl");
		const disk = installFullDisk(fpath => fpath === forkFile);
		disk.dirs = false;
		disk.error = () => new SessionLockError(forkFile, "another writer holds the publish lock");

		await expect(
			SessionManager.forkFrom(source.getSessionFile() as string, dir.path(), forkDir, undefined, {
				seance: true,
				suppressBreadcrumb: true,
				sessionFile: forkFile,
			}),
		).rejects.toBeInstanceOf(SessionLockError);
	});
});

describe("errors that are not refusals still reject the open, as before", () => {
	it("a held publish lock on the first write", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionFile = path.join(sessionDir, "locked.jsonl");
		const disk = installFullDisk(fpath => fpath === path.resolve(sessionFile));
		disk.dirs = false;
		disk.error = () => new SessionLockError(sessionFile, "another writer holds the publish lock");

		await expect(
			SessionManager.open(sessionFile, sessionDir, undefined, { initialCwd: dir.path() }),
		).rejects.toBeInstanceOf(SessionLockError);
		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	it("a database permission error on the first write", async () => {
		const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
		const storage = await SqlSessionStorage.create({ client });
		const sessionFile = path.resolve("/sessions/permission/child.jsonl");

		client.refusal = "permission";
		await expect(
			SessionManager.open(sessionFile, path.dirname(sessionFile), storage, { initialCwd: "/cwd" }),
		).rejects.toThrow("permission denied");
		client.refusal = undefined;
		await client.end();
	});

	it("an ownership claim that throws on the first write", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		class ClaimFails extends FileSessionStorage {
			override claimSession(): (() => void) | null {
				throw new Error("the claim store failed");
			}
		}

		await expect(
			SessionManager.open(path.join(sessionDir, "claimed.jsonl"), sessionDir, new ClaimFails(), {
				initialCwd: dir.path(),
			}),
		).rejects.toThrow("the claim store failed");
	});

	it("a write conflict on the first write, keeping the other writer's file", async () => {
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

	it("a resume of an empty file with throwIfMissing, leaving the file unmodified", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "empty.jsonl");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(sessionFile, "");
		const disk = installFullDisk(fpath => fpath.startsWith(sessionDir + path.sep));

		await expect(SessionManager.open(sessionFile, sessionDir, undefined, { throwIfMissing: true })).rejects.toThrow(
			"the session file holds no entries",
		);
		expect(disk.attempts).toEqual([]);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe("");
	});

	it("a session path that cannot be loaded (a directory)", async () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		const sessionFile = path.join(sessionDir, "a-directory.jsonl");
		fs.mkdirSync(sessionFile, { recursive: true });

		await expect(
			SessionManager.open(sessionFile, sessionDir, undefined, { initialCwd: dir.path() }),
		).rejects.toThrow();
		expect(fs.statSync(sessionFile).isDirectory()).toBe(true);
	});
});

describe("a session whose directory the store refuses to make", () => {
	for (const code of REFUSED_CODES) {
		it(`starts (${code}), reports the refusal of its first write, and writes once the location accepts writes`, async () => {
			const dir = tempDir();
			const sessionDir = dir.join("sessions");
			const disk = installFullDisk(fpath => fpath.startsWith(sessionDir + path.sep));
			disk.error = () => fsError(code);

			const manager = SessionManager.create(dir.path(), sessionDir);
			const seen: string[] = [];
			manager.onPersistenceError(error => seen.push(error.message));
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			manager.appendMessage(assistant("the first write is refused"));
			expect(seen).toHaveLength(1);
			expect(fs.existsSync(sessionDir)).toBe(false);

			disk.full = false;
			manager.appendMessage(assistant("the location accepts writes"));
			await manager.flush();
			expect(storedIds(fs.readFileSync(manager.getSessionFile() as string, "utf8"))).toEqual(heldIds(manager));
			await manager.close();
		});
	}

	it("starts when the default session directory is refused (EDQUOT), and writes once the location accepts writes", async () => {
		const dir = tempDir();
		setAgentDir(dir.join("agent"));
		const sessionsRoot = dir.join("agent", "sessions");
		const disk = installFullDisk(fpath => fpath.startsWith(sessionsRoot + path.sep));
		disk.error = () => fsError("EDQUOT", "EDQUOT: disk quota exceeded, mkdir");

		fs.mkdirSync(dir.join("project"));
		const manager = SessionManager.create(dir.join("project"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistant("the first write is refused"));
		const sessionFile = manager.getSessionFile() as string;
		expect(sessionFile.startsWith(sessionsRoot + path.sep)).toBe(true);
		expect(fs.existsSync(sessionFile)).toBe(false);

		disk.full = false;
		manager.appendMessage(assistant("the location accepts writes"));
		await manager.flush();
		expect(storedIds(fs.readFileSync(sessionFile, "utf8"))).toEqual(heldIds(manager));
		await manager.close();
	});

	it("kept as before: a directory path that is a dangling link (EEXIST) stops the start", () => {
		const dir = tempDir();
		const sessionDir = dir.join("sessions");
		fs.symlinkSync(dir.join("gone"), sessionDir, "dir");

		expect(() => SessionManager.create(dir.path(), sessionDir)).toThrow("EEXIST");
	});

	it("kept as before: an error making the directory that is not a refusal (ELOOP) stops the start", () => {
		const dir = tempDir();
		class BrokenDirectoryStorage extends FileSessionStorage {
			override ensureDirSync(_dir: string): void {
				throw fsError("ELOOP", "ELOOP: too many symbolic links encountered, mkdir");
			}
		}
		expect(() => SessionManager.create(dir.path(), dir.join("sessions"), new BrokenDirectoryStorage())).toThrow(
			"ELOOP",
		);
	});

	it("control: a session whose directory can be made writes as before, with no report", async () => {
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
});
