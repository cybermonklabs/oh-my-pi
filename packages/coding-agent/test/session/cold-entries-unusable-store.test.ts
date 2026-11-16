/**
 * A resumed or running session keeps working when the place it keeps older
 * entry bodies in cannot be used: `os.tmpdir()` read-only or impossible to
 * create, or every write to it failing (a full disk). The entries read back
 * as the session file holds them, and a full disk does not make a resume do
 * more work than the transcript's size calls for.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Root ignores directory permissions, so a read-only directory cannot be made for it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;
const HAS_PROC_FD = fs.existsSync("/proc/self/fd");

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

/** Write `entries` after a header; the session id is the directory's name. */
async function writeSession(dir: string, entries: object[]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	await Bun.write(file, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

/** `u1` and `a1` lie before the cut of `c1`, which keeps `u2` on; `a2` follows the compaction. */
function compactedSession(): object[] {
	return [
		{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user(`u1 ${BODY}`) },
		{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: assistant(`a1 ${BODY}`) },
		{ type: "message", id: "u2", parentId: "a1", timestamp: TIMESTAMP, message: user(`u2 ${BODY}`) },
		{
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp: TIMESTAMP,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "u2",
			tokensBefore: 1000,
		},
		{ type: "message", id: "a2", parentId: "c1", timestamp: TIMESTAMP, message: assistant(`a2 ${BODY}`) },
	];
}

/** `count` assistant turns before a compaction that keeps only the last user turn on. */
function longCompactedSession(count: number): object[] {
	const entries: object[] = [];
	let parentId: string | null = null;
	for (let index = 0; index < count; index++) {
		entries.push({
			type: "message",
			id: `a${index}`,
			parentId,
			timestamp: TIMESTAMP,
			message: assistant(`a${index} ${BODY}`),
		});
		parentId = `a${index}`;
	}
	entries.push(
		{ type: "message", id: "keep", parentId, timestamp: TIMESTAMP, message: user(`keep ${BODY}`) },
		{
			type: "compaction",
			id: "c1",
			parentId: "keep",
			timestamp: TIMESTAMP,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "keep",
			tokensBefore: 1000,
		},
	);
	return entries;
}

function open(file: string): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true });
}

/** The entries of `file` as its lines hold them, the header left out. */
async function entriesInFile(file: string): Promise<unknown[]> {
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.length > 0);
	return lines.map(line => JSON.parse(line) as SessionEntry | SessionHeader).filter(entry => entry.type !== "session");
}

/** What a caller of the accessors reads: every entry, as plain data. */
function readEntries(manager: SessionManager): unknown[] {
	return JSON.parse(JSON.stringify(manager.getEntries()));
}

/** A directory path under a regular file: nothing can create it. */
function uncreatableDir(dir: string): string {
	const blocker = path.join(dir, "not-a-directory");
	fs.writeFileSync(blocker, "");
	return path.join(blocker, "tmp");
}

/** Whether descriptor `fd` of this process is open on a file under `dir`. */
function isUnder(fd: number, dir: string): boolean {
	try {
		return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}${path.sep}`);
	} catch {
		return false;
	}
}

/** Bytes a `writeSync`/`writevSync` call asks to write. */
function requestedBytes(data: unknown, offset: unknown, length: unknown): number {
	if (typeof data === "string") return Buffer.byteLength(data);
	if (Array.isArray(data))
		return data.reduce((sum: number, item) => sum + requestedBytes(item, undefined, undefined), 0);
	if (ArrayBuffer.isView(data)) {
		if (typeof length === "number") return length;
		return data.byteLength - (typeof offset === "number" ? offset : 0);
	}
	return 0;
}

/**
 * Fail every write to a file under `dir` with ENOSPC, as a full disk does, and
 * count the bytes those writes asked for. Writes elsewhere go through.
 */
function failWritesUnder(dir: string): { requested: () => number } {
	let requested = 0;
	const refuse = (fd: number, data: unknown, offset: unknown, length: unknown): boolean => {
		if (!isUnder(fd, dir)) return false;
		requested += requestedBytes(data, offset, length);
		return true;
	};
	const enospc = () =>
		Object.assign(new Error("ENOSPC: no space left on device, write"), {
			code: "ENOSPC",
			errno: -28,
			syscall: "write",
		});
	const writeSync = fs.writeSync;
	vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
		if (refuse(fd, data, rest[0], rest[1])) throw enospc();
		return Reflect.apply(writeSync, fs, [fd, data, ...rest]) as number;
	}) as typeof fs.writeSync);
	if (typeof fs.writevSync === "function") {
		const writevSync = fs.writevSync;
		vi.spyOn(fs, "writevSync").mockImplementation(((fd: number, buffers: unknown, ...rest: unknown[]) => {
			if (refuse(fd, buffers, undefined, undefined)) throw enospc();
			return Reflect.apply(writevSync, fs, [fd, buffers, ...rest]) as number;
		}) as typeof fs.writevSync);
	}
	return { requested: () => requested };
}

describe("a resume and a running session work when the older-entry store cannot be used", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A host whose TMPDIR is read-only (a locked-down container) must still resume its sessions.
	it.skipIf(RUNS_AS_ROOT)(
		"resumes a compacted session with every entry as the file holds it when os.tmpdir() is read-only",
		async () => {
			using dir = TempDir.createSync("@omp-cold-unusable-");
			using tmp = TempDir.createSync("@omp-cold-unusable-tmp-");
			const file = await writeSession(dir.path(), compactedSession());
			fs.chmodSync(tmp.path(), 0o500);
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
			try {
				const manager = await open(file);
				expect(readEntries(manager)).toEqual(await entriesInFile(file));
				expect(manager.buildSessionContext().messages.map(message => message.role)).toEqual([
					"compactionSummary",
					"user",
					"assistant",
				]);
				await manager.close();
			} finally {
				fs.chmodSync(tmp.path(), 0o700);
			}
		},
	);

	// A TMPDIR that names a missing path no one can create (a stale or mistyped setting).
	it("resumes a compacted session with every entry as the file holds it when os.tmpdir() cannot be created", async () => {
		using dir = TempDir.createSync("@omp-cold-unusable-");
		const file = await writeSession(dir.path(), compactedSession());
		vi.spyOn(os, "tmpdir").mockReturnValue(uncreatableDir(dir.path()));

		const manager = await open(file);
		expect(readEntries(manager)).toEqual(await entriesInFile(file));
		expect(manager.buildSessionContext().messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);
		await manager.close();
	});

	// The agent rebuilds its context after every compaction; a throw there stops the session.
	it("builds a running session's context after a compaction when the store cannot be created", async () => {
		using dir = TempDir.createSync("@omp-cold-unusable-");
		// Nothing large on disk: the resume itself needs nothing kept apart.
		const file = await writeSession(dir.path(), [
			{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user("hi") },
		]);
		vi.spyOn(os, "tmpdir").mockReturnValue(uncreatableDir(dir.path()));
		const manager = await open(file);

		const a1 = manager.appendMessage(assistant(`a1 ${BODY}`));
		const u2 = manager.appendMessage(user(`u2 ${BODY}`));
		manager.appendCompaction(`summary ${BODY}`, undefined, u2, 1000);
		manager.appendMessage(assistant(`a2 ${BODY}`));

		const context = manager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
		const older = manager.getEntry(a1);
		expect(older?.type === "message" ? older.message : undefined).toEqual(assistant(`a1 ${BODY}`));
		await manager.close();
	});

	it.skipIf(!HAS_PROC_FD)(
		"resumes with every entry read back while every store write fails, asking for at most a few times the transcript's bytes",
		async () => {
			using dir = TempDir.createSync("@omp-cold-unusable-");
			using tmp = TempDir.createSync("@omp-cold-unusable-tmp-");
			const file = await writeSession(dir.path(), longCompactedSession(600));
			const transcriptBytes = fs.statSync(file).size;
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
			const disk = failWritesUnder(tmp.path());

			const manager = await open(file);
			// Retrying the same records on every new one makes a full disk cost the square of the transcript.
			const requestedByResume = disk.requested();
			expect(requestedByResume).toBeLessThanOrEqual(4 * transcriptBytes);
			// The bodies read back while the disk is still full.
			expect(readEntries(manager)).toEqual(await entriesInFile(file));
			await manager.close();
		},
	);
});
