/**
 * Sessions whose writes the store refused wait, oldest first, for a write that lands on the same store,
 * and that write sends one of them again: a live session writes the entries it keeps in memory (an idle
 * subagent has no next append of its own), and a closed one sends the transcript its refused close kept.
 * A close that lands sends every one of them once and waits. A send never replaces a stored file another
 * writer changed. Every case opens while the store accepts writes, so each fails before the change at
 * the behaviour it names, not at the open.
 *
 * All file stores share one queue (they write the one local file system), and other test files in the
 * same process can leave sessions in it; so the cases on the file store observe a close, which sends
 * every queued session, and the cases that count sends per landed write use a SQL store, whose queue is
 * its own.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import {
	assistant,
	type FullDisk,
	fsError,
	heldIds,
	installFullDisk,
	nextTurn,
	RefusingSqlClient,
	storedIds,
	storedSqlContent,
	until,
} from "./helpers/refusing-session-stores";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function tempDir(): TempDir {
	const dir = TempDir.createSync("@pi-refused-store-queue-");
	tempDirs.push(dir);
	return dir;
}

/** A disk on which only the subagents' directory refuses writes, accepting them at first. */
function subagentDisk(dir: TempDir): { disk: FullDisk; childDir: string } {
	const childDir = dir.join("parent");
	return { disk: installFullDisk(fpath => fpath.startsWith(childDir + path.sep), false), childDir };
}

/** A subagent session opened while the store accepts writes, with one answer stored. */
async function openChild(dir: TempDir, childDir: string, name: string): Promise<SessionManager> {
	const child = await SessionManager.open(path.join(childDir, `${name}.jsonl`), undefined, undefined, {
		initialCwd: dir.path(),
	});
	child.appendMessage({ role: "user", content: `${name}: first question`, timestamp: Date.now() });
	child.appendMessage(assistant(`${name}: first answer`));
	return child;
}

/** A subagent session on a SQL store, opened while the store accepts writes, with one answer stored. */
async function openSqlChild(storage: SqlSessionStorage, name: string): Promise<SessionManager> {
	const child = await SessionManager.open(path.resolve(`/sessions/parent/${name}.jsonl`), undefined, storage, {
		initialCwd: "/cwd",
	});
	child.appendMessage(assistant(`${name}: first answer`));
	await storage.drain();
	return child;
}

/** Close `child` as session dispose does (seal, then close), while the store refuses it. */
async function closeRefused(child: SessionManager, seal: { keepEntries?: boolean } = {}): Promise<string[]> {
	const ids = heldIds(child);
	child.seal(seal);
	await expect(child.close()).rejects.toThrow();
	return ids;
}

/** Whether another holder can take `sessionId`'s claim now (the OS lease a file store's claim holds). */
function claimFree(sessionId: string): boolean {
	const contender = tryAcquireSessionLease(sessionId);
	contender?.release();
	return contender !== null;
}

function storedFile(file: string): string[] {
	return fs.existsSync(file) ? storedIds(fs.readFileSync(file, "utf8")) : [];
}

describe("a session the store refused is sent again once another session's write lands", () => {
	it("a live session's refused entries (an idle subagent's) are written once another session's write and close land", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Idle");
		disk.full = true;
		child.appendMessage(assistant("Idle: refused answer"));
		const file = child.getSessionFile() as string;
		expect(storedFile(file)).not.toEqual(heldIds(child));

		disk.full = false;
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		// The child appended nothing since the store came back.
		expect(storedFile(file)).toEqual(heldIds(child));
		await child.close();
	});

	for (const refusal of ["read-only", "connection"] as const) {
		it(`a live session's entries a SQL store refused (${refusal}) are written by the next write another session lands`, async () => {
			const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
			const storage = await SqlSessionStorage.create({ client });
			const child = await openSqlChild(storage, "Idle");
			client.refusal = refusal;
			child.appendMessage(assistant("Idle: refused answer"));
			await storage.drain().catch(() => undefined);
			const file = child.getSessionFile() as string;

			client.refusal = undefined;
			client.writes.splice(0);
			const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
			parent.appendMessage(assistant("the parent's write lands"));
			await until(() => client.writes.includes(file), "the child's entries sent after the parent's write");
			// The send is on the store's queue now; the drain waits for it to land.
			await storage.drain();

			expect(storedIds(await storedSqlContent(client, file))).toEqual(heldIds(child));
			await parent.close();
			await child.close();
			await client.end();
		});
	}

	it("a transcript whose close the file store refused is kept, written once another session's write and close land, and then released", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Closed");
		disk.full = true;
		child.appendMessage(assistant("Closed: refused answer"));
		const ids = await closeRefused(child);
		const file = child.getSessionFile() as string;
		// Held: the transcript stays in memory while the store refuses it.
		expect(child.getEntries()).toHaveLength(ids.length - 1);

		disk.full = false;
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		expect(storedFile(file)).toEqual(ids);
		// Sent: the sealed session drops its transcript.
		expect(child.getEntries()).toHaveLength(0);
	});

	it("a transcript sealed with keepEntries stays in memory after its held send lands, until it is released", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Kept");
		disk.full = true;
		child.appendMessage(assistant("Kept: refused answer"));
		const ids = await closeRefused(child, { keepEntries: true });
		const file = child.getSessionFile() as string;
		expect(child.holdsTranscript()).toBe(true);

		disk.full = false;
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		expect(storedFile(file)).toEqual(ids);
		// Sent, and the hold is over; the entries stay for the owner that asked to keep them.
		expect({ holds: child.holdsTranscript(), held: heldIds(child) }).toEqual({ holds: false, held: ids });
		child.releaseRetainedEntries();
		expect(child.getEntries()).toHaveLength(0);
	});

	it("a close that lands releases the session's claim at once (control)", async () => {
		const dir = tempDir();
		const { childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Landed");
		const id = child.getSessionId();
		expect(claimFree(id)).toBe(false);

		child.seal();
		await child.close();

		expect(claimFree(id)).toBe(true);
	});

	it("a close the store refused for an outage keeps the session's claim while the transcript is held, and the hold's end releases it", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Claimed");
		const id = child.getSessionId();
		expect(claimFree(id)).toBe(false);
		disk.full = true;
		child.appendMessage(assistant("Claimed: refused answer"));
		const ids = await closeRefused(child);
		const file = child.getSessionFile() as string;

		// Held: no other holder may take the session while its transcript waits to be sent.
		expect({ holds: child.holdsTranscript(), free: claimFree(id) }).toEqual({ holds: true, free: false });

		disk.full = false;
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		// Sent: the hold is over, and with it the claim.
		expect(storedFile(file)).toEqual(ids);
		expect({ holds: child.holdsTranscript(), free: claimFree(id) }).toEqual({ holds: false, free: true });
	});

	for (const refusal of ["read-only", "connection"] as const) {
		it(`a transcript whose close a SQL store refused (${refusal}) is kept, and written once another session's write and close land`, async () => {
			const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
			const storage = await SqlSessionStorage.create({ client });
			const child = await openSqlChild(storage, "Closed");
			client.refusal = refusal;
			child.appendMessage(assistant("Closed: refused answer"));
			await storage.drain().catch(() => undefined);
			const ids = await closeRefused(child);
			const file = child.getSessionFile() as string;

			client.refusal = undefined;
			const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
			parent.appendMessage(assistant("the parent's write lands"));
			await parent.close();

			expect(storedIds(await storedSqlContent(client, file))).toEqual(ids);
			await client.end();
		});
	}

	it("a close that lands sends every refused session once and waits, held and live alike", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const closed = await openChild(dir, childDir, "Closed");
		const live = await openChild(dir, childDir, "Live");
		disk.full = true;
		closed.appendMessage(assistant("Closed: refused answer"));
		live.appendMessage(assistant("Live: refused answer"));
		const closedIds = await closeRefused(closed);

		disk.full = false;
		// The parent wrote nothing: only its close sends them.
		await SessionManager.create(dir.path(), dir.join("main")).close();

		expect(storedFile(closed.getSessionFile() as string)).toEqual(closedIds);
		expect(storedFile(live.getSessionFile() as string)).toEqual(heldIds(live));
		await live.close();
	});

	it("each landed write starts one send, in queue order, and a refused one goes to the back; once the store accepts, one landed write drains the queue", async () => {
		const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
		const storage = await SqlSessionStorage.create({ client });
		const children: SessionManager[] = [];
		for (const name of ["A", "B", "C"]) children.push(await openSqlChild(storage, name));
		client.refusal = "read-only";
		client.refusesPath = sessionPath => sessionPath.startsWith(path.resolve("/sessions/parent") + path.sep);
		const ids: string[][] = [];
		for (const child of children) {
			child.appendMessage(assistant("refused answer"));
			await storage.drain().catch(() => undefined);
			ids.push(await closeRefused(child));
		}
		// A send can take several statements (a SQL store that keeps a transcript in parts): a run of
		// statements on one path is one send.
		const sends = (): string[] =>
			client.writes
				.filter(write => client.refusesPath?.(write))
				.map(write => path.basename(write))
				.filter((name, index, all) => index === 0 || all[index - 1] !== name);
		client.writes.splice(0);

		const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
		for (let landed = 1; landed <= 4; landed++) {
			parent.appendMessage(assistant(`landed write ${landed}`));
			await until(() => sends().length >= landed, `the send of landed write ${landed}`);
			// The refused send settles in the microtasks after its write failed.
			await nextTurn();
		}
		expect(sends()).toEqual(["A.jsonl", "B.jsonl", "C.jsonl", "A.jsonl"]);

		client.refusal = undefined;
		client.writes.splice(0);
		parent.appendMessage(assistant("the store accepts writes"));
		await until(() => sends().length >= 3, "every held transcript sent");
		await storage.drain();
		expect(sends()).toEqual(["B.jsonl", "C.jsonl", "A.jsonl"]);
		for (const [i, child] of children.entries()) {
			expect(storedIds(await storedSqlContent(client, child.getSessionFile() as string))).toEqual(ids[i]!);
		}
		await parent.close();
		await client.end();
	});

	it("a send starts after the write that landed returns, never inside it", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Held");
		disk.full = true;
		child.appendMessage(assistant("Held: refused answer"));
		const ids = await closeRefused(child);
		const file = child.getSessionFile() as string;
		disk.full = false;

		// A held send's first step reads its stored file, in parts: note each read of the child's file, inside
		// a landing write or after it. All file stores share one queue, and sessions other test files left in
		// it can come before this child, so writes land until the child's send has started.
		let landing = false;
		const inside: string[] = [];
		const after: string[] = [];
		const readChunks = FileSessionStorage.prototype.readChunks;
		vi.spyOn(FileSessionStorage.prototype, "readChunks").mockImplementation(function (
			this: FileSessionStorage,
			fpath: string,
			fromByte?: number,
		) {
			if (fpath === file) (landing ? inside : after).push(fpath);
			return readChunks.call(this, fpath, fromByte);
		});
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		for (let landed = 0; landed < 200 && inside.length + after.length === 0; landed++) {
			landing = true;
			parent.appendMessage(assistant(`the parent's write ${landed} lands`));
			landing = false;
			await nextTurn();
		}
		await until(() => inside.length + after.length > 0, "the held send after a landing write");

		expect({ inside: inside.length, after: after.length > 0 }).toEqual({ inside: 0, after: true });
		await parent.close();
		expect(storedFile(file)).toEqual(ids);
	});

	it("a refused session whose own next write fails for another reason leaves the queue: other sessions' writes no longer send it", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Refused");
		disk.full = true;
		child.appendMessage(assistant("Refused: refused answer"));
		disk.error = () => fsError("EISDIR", "EISDIR: illegal operation on a directory, open");
		child.appendMessage(assistant("Refused: broken answer"));
		disk.full = false;
		disk.attempts.splice(0);

		const parent = SessionManager.create(dir.path(), dir.join("main"));
		for (let landed = 1; landed <= 3; landed++) {
			parent.appendMessage(assistant(`landed write ${landed}`));
			await nextTurn();
		}
		await parent.close();

		expect(disk.attempts).toEqual([]);
		await child.close().catch(() => undefined);
	});

	it("a session whose write failed for a reason other than a refusal is not sent by other sessions' writes or closes", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Broken");
		disk.error = () => fsError("EISDIR", "EISDIR: illegal operation on a directory, open");
		disk.full = true;
		child.appendMessage(assistant("Broken: failed answer"));
		disk.attempts.splice(0);
		disk.full = false;

		const parent = SessionManager.create(dir.path(), dir.join("main"));
		for (let landed = 1; landed <= 3; landed++) {
			parent.appendMessage(assistant(`landed write ${landed}`));
			await nextTurn();
		}
		await parent.close();

		expect(disk.attempts).toEqual([]);
		await child.close().catch(() => undefined);
	});

	it("held transcripts stay in memory until the store accepts them: 25 closed while it refused all land, are released, and none is left", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const children: SessionManager[] = [];
		for (let i = 0; i < 25; i++) children.push(await openChild(dir, childDir, `Child${i}`));
		disk.full = true;
		const ids: string[][] = [];
		for (const child of children) {
			child.appendMessage(assistant("refused answer"));
			ids.push(await closeRefused(child));
		}
		// Held: every transcript is still in memory.
		expect(children.map(child => child.getEntries().length)).toEqual(ids.map(own => own.length - 1));

		disk.full = false;
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		parent.appendMessage(assistant("the store accepts writes"));
		await parent.close();
		for (const [i, child] of children.entries()) {
			expect(storedFile(child.getSessionFile() as string)).toEqual(ids[i]!);
		}
		// Sent: every one is released.
		expect(children.map(child => child.getEntries().length)).toEqual(ids.map(() => 0));

		// Nothing is left to send: a later close sends none of them.
		disk.attempts.splice(0);
		await SessionManager.create(dir.path(), dir.join("main2")).close();
		expect(disk.attempts).toEqual([]);
	});
});

describe("a session the store refuses for permission waits only on its own writes", () => {
	it("is not sent by other sessions' landed writes, and its own next append writes once the permission is back", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Denied");
		disk.error = () => fsError("EACCES", "EACCES: permission denied, open");
		disk.full = true;
		child.appendMessage(assistant("Denied: refused answer"));
		const file = child.getSessionFile() as string;
		expect(storedFile(file)).not.toEqual(heldIds(child));
		// The permission is back, but no other session's write can show it.
		disk.full = false;
		disk.attempts.splice(0);

		const parent = SessionManager.create(dir.path(), dir.join("main"));
		for (let landed = 1; landed <= 3; landed++) {
			parent.appendMessage(assistant(`landed write ${landed}`));
			await nextTurn();
		}
		await parent.close();
		expect(disk.attempts).toEqual([]);

		child.appendMessage(assistant("Denied: its own next answer"));
		await child.flush();
		expect(storedFile(file)).toEqual(heldIds(child));
		await child.close();
	});

	it("a close it refuses is not held: no later write sends it", async () => {
		const dir = tempDir();
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Denied");
		disk.error = () => fsError("EACCES", "EACCES: permission denied, open");
		disk.full = true;
		child.appendMessage(assistant("Denied: refused answer"));
		const ids = await closeRefused(child);
		const file = child.getSessionFile() as string;

		disk.full = false;
		disk.attempts.splice(0);
		const parent = SessionManager.create(dir.path(), dir.join("main"));
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		expect(disk.attempts).toEqual([]);
		expect(storedFile(file)).not.toEqual(ids);
	});
});

describe("a held send never replaces a file another writer changed", () => {
	/** A child whose close was refused after "Held: first answer" was stored, and its file. */
	async function heldChild(dir: TempDir): Promise<{ disk: FullDisk; file: string; child: SessionManager }> {
		const { disk, childDir } = subagentDisk(dir);
		const child = await openChild(dir, childDir, "Held");
		disk.full = true;
		child.appendMessage(assistant("Held: refused answer"));
		await closeRefused(child);
		return { disk, file: child.getSessionFile() as string, child };
	}

	for (const [what, replacement] of [
		["in place, at the same length", "Held: FIRST ANSWER"],
		["keeping its entries, at another length", "Held: first answer, pruned by maintenance"],
	] as const) {
		it(`another writer rewrote it ${what}: kept, and the dropped transcript is released`, async () => {
			const dir = tempDir();
			const { disk, file, child } = await heldChild(dir);
			const theirs = fs.readFileSync(file, "utf8").replace("Held: first answer", replacement);
			fs.writeFileSync(file, theirs);

			disk.full = false;
			disk.attempts.splice(0);
			const parent = SessionManager.create(dir.path(), dir.join("main"));
			parent.appendMessage(assistant("the parent's write lands"));
			await parent.close();

			expect(fs.readFileSync(file, "utf8")).toBe(theirs);
			expect(disk.attempts).toEqual([]);
			expect(child.getEntries()).toHaveLength(0);
		});
	}

	it("unreadable at the send: kept without a write; readable later as another writer's: dropped, and kept", async () => {
		const dir = tempDir();
		const { disk, file } = await heldChild(dir);
		const theirs = fs.readFileSync(file, "utf8").replace("Held: first answer", "another writer's answer, longer");
		fs.writeFileSync(file, theirs);
		let unreadable = true;
		const reads: string[] = [];
		const readChunks = FileSessionStorage.prototype.readChunks;
		vi.spyOn(FileSessionStorage.prototype, "readChunks").mockImplementation(function (
			this: FileSessionStorage,
			fpath: string,
			fromByte?: number,
		) {
			if (fpath === file) {
				reads.push(fpath);
				if (unreadable)
					return {
						[Symbol.asyncIterator]: () => ({
							next: () => Promise.reject(fsError("EIO", "EIO: i/o error, read")),
						}),
					};
			}
			return readChunks.call(this, fpath, fromByte);
		});

		disk.full = false;
		disk.attempts.splice(0);
		await SessionManager.create(dir.path(), dir.join("main")).close();
		expect(reads.length).toBeGreaterThan(0);
		expect(fs.readFileSync(file, "utf8")).toBe(theirs);

		unreadable = false;
		await SessionManager.create(dir.path(), dir.join("main2")).close();
		expect(fs.readFileSync(file, "utf8")).toBe(theirs);

		// Dropped: a later close no longer reads it.
		reads.splice(0);
		await SessionManager.create(dir.path(), dir.join("main3")).close();
		expect(reads).toEqual([]);
		expect(disk.attempts).toEqual([]);
	});

	it("a SQL store's row another process rewrote at another length while the close was refused", async () => {
		const sqlite = new SQL("sqlite::memory:");
		const client = new RefusingSqlClient(sqlite);
		const storage = await SqlSessionStorage.create({ client });
		const child = await openSqlChild(storage, "Held");
		const file = child.getSessionFile() as string;
		client.refusal = "connection";
		child.appendMessage(assistant("Held: refused answer"));
		await storage.drain().catch(() => undefined);
		await closeRefused(child);

		const other = await SqlSessionStorage.create({ client: new RefusingSqlClient(sqlite) });
		const theirs = (await storedSqlContent(client, file)).replace("Held: first answer", "pruned by another process");
		await other.writeTextAtomic(file, theirs);
		await other.drain();

		client.refusal = undefined;
		const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();

		expect(await storedSqlContent(client, file)).toBe(theirs);
		await client.end();
	});

	it("a SQL store's row another process made where this session's own never landed: kept, and the send stops", async () => {
		const sqlite = new SQL("sqlite::memory:");
		const client = new RefusingSqlClient(sqlite);
		const storage = await SqlSessionStorage.create({ client });
		const file = path.resolve("/sessions/parent/Late.jsonl");
		client.refusal = "connection";
		const child = await SessionManager.open(file, undefined, storage, { initialCwd: "/cwd" });
		child.appendMessage(assistant("Late: refused answer"));
		await storage.drain().catch(() => undefined);
		await closeRefused(child);

		const theirs = `${JSON.stringify({ type: "session", version: 3, id: "another-process", timestamp: new Date().toISOString(), cwd: "/elsewhere" })}\n`;
		const other = await SqlSessionStorage.create({ client: new RefusingSqlClient(sqlite) });
		await other.writeTextAtomic(file, theirs);
		await other.drain();

		client.refusal = undefined;
		const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
		parent.appendMessage(assistant("the parent's write lands"));
		await parent.close();
		expect(await storedSqlContent(client, file)).toBe(theirs);

		// Dropped: later landed writes and closes send it no more.
		const writes = client.writes.filter(write => write === file).length;
		const next = SessionManager.create("/cwd", path.resolve("/sessions/main2"), storage);
		next.appendMessage(assistant("a later write"));
		await next.close();
		expect(client.writes.filter(write => write === file).length).toBe(writes);
		await client.end();
	});
});
