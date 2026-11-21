/**
 * Where no private store can be made under `os.tmpdir()`, or a write to the
 * store's file fails later, the bodies of the entries before the cut are kept
 * compressed in memory, in blocks of whole records: the entries go cold as with
 * a file store, read back unchanged, and the session holds at most a quarter of
 * their size (plus the record cache and the records not yet gathered into a
 * block). No other directory is used.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const HAS_PROC_FD = fs.existsSync("/proc/self/fd");
/** Words of a body: varied enough that a block of them does not shrink to nothing, as session text does not. */
const WORDS = ["read", "the", "file", "then", "edit", "line", "test", "passes", "error", "fixed", "build", "again"];

/** A body of about `bytes` bytes of text that compresses as prose does. */
function body(label: string, bytes: number): string {
	const parts = [label];
	let size = label.length;
	for (let index = 0; size < bytes; index++) {
		const word = `${WORDS[(index * 7 + label.length) % WORDS.length]}${index % 97}`;
		parts.push(word);
		size += word.length + 1;
	}
	return parts.join(" ");
}

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

/** `count` replies of `bytes` each before a compaction that keeps only `keep` on; `beforeCut` names them. */
function compactedSession(count: number, bytes: number): { entries: object[]; beforeCut: string[] } {
	const entries: object[] = [];
	const beforeCut: string[] = [];
	let parentId: string | null = null;
	for (let index = 0; index < count; index++) {
		const id = `a${index}`;
		entries.push({ type: "message", id, parentId, timestamp: TIMESTAMP, message: assistant(body(id, bytes)) });
		beforeCut.push(id);
		parentId = id;
	}
	entries.push(
		{ type: "message", id: "keep", parentId, timestamp: TIMESTAMP, message: user(body("keep", 1024)) },
		{
			type: "compaction",
			id: "c1",
			parentId: "keep",
			timestamp: TIMESTAMP,
			summary: body("c1", 1024),
			firstKeptEntryId: "keep",
			tokensBefore: 1000,
		},
	);
	return { entries, beforeCut };
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

function open(file: string): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true });
}

/** The entries of `file` as its lines hold them, the header left out. */
async function entriesInFile(file: string): Promise<unknown[]> {
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.length > 0);
	return lines.map(line => JSON.parse(line) as SessionEntry | SessionHeader).filter(entry => entry.type !== "session");
}

/** A temporary directory path under a regular file: no store can be made under it. */
function unusableTmp(dir: string): string {
	const blocker = path.join(dir, "not-a-directory");
	fs.writeFileSync(blocker, "");
	return path.join(blocker, "tmp");
}

/** The entries of `ids` that `manager` holds whole in memory. */
function heldWhole(manager: SessionManager, ids: readonly string[]): string[] {
	return ids.filter(id => {
		const entry = manager.getEntry(id);
		return !entry || !isColdEntry(entry);
	});
}

/** Whether descriptor `fd` of this process is open on a file under `dir`. */
function isUnder(fd: number, dir: string): boolean {
	try {
		return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}${path.sep}`);
	} catch {
		return false;
	}
}

/** Let the first `allowed` writes to files under `dir` through, then fail each with ENOSPC, as a disk filling up does. */
function diskFillsUnder(dir: string, allowed: number): void {
	let writes = 0;
	const writeSync = fs.writeSync;
	vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
		if (isUnder(fd, dir) && ++writes > allowed) {
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28 });
		}
		return Reflect.apply(writeSync, fs, [fd, data, ...rest]) as number;
	}) as typeof fs.writeSync);
}

/** Bytes the engine holds: the heap and the buffers outside it, after a full collection. */
function heldBytes(): number {
	Bun.gc(true);
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external;
}

describe("older bodies kept compressed in memory when no store file can be used", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// First in the file: the warning is once per process. An operator whose TMPDIR is broken must learn
	// why the session holds its older bodies in memory, without one warning per session.
	it("warns once, naming why the store could not be made, however many sessions resume", async () => {
		using dir = TempDir.createSync("@omp-cold-memory-");
		const { entries } = compactedSession(4, 4096);
		const file = await writeSession(dir.path(), entries);
		vi.spyOn(os, "tmpdir").mockReturnValue(unusableTmp(dir.path()));
		const warn = vi.spyOn(logger, "warn");

		for (let resume = 0; resume < 2; resume++) {
			const manager = await open(file);
			expect(manager.coldStoreStats().storeInMemory).toBe(true);
			await manager.close();
		}

		const warnings = warn.mock.calls.filter(([message]) => String(message).includes("compressed in memory"));
		expect(warnings).toHaveLength(1);
		expect(JSON.stringify(warnings[0]?.[1])).toContain("ENOTDIR");
	});

	// A host whose TMPDIR is unusable would otherwise hold every older body of a long session whole,
	// so the process grows with the transcript; and a compaction later in the session must cool too.
	it("holds at most a quarter of the older bodies' size after a resume, a read of every entry and the tree, and a compaction", async () => {
		using dir = TempDir.createSync("@omp-cold-memory-");
		const { entries, beforeCut } = compactedSession(96, 64 * 1024);
		const file = await writeSession(dir.path(), entries);
		vi.spyOn(os, "tmpdir").mockReturnValue(unusableTmp(dir.path()));
		const manager = await open(file);
		try {
			const quarterOfBodies = () => {
				const stats = manager.coldStoreStats();
				expect(stats.storeInMemory).toBe(true);
				expect(stats.compressedBytes).toBeGreaterThan(0);
				expect(stats.compressedBytes).toBeLessThanOrEqual(stats.storeBytes / 4);
			};
			expect(heldWhole(manager, beforeCut)).toEqual([]);
			expect(manager.coldStoreStats().coldEntries).toBe(beforeCut.length);
			quarterOfBodies();

			expect(JSON.parse(JSON.stringify(manager.getEntries()))).toEqual(await entriesInFile(file));
			expect(JSON.stringify(manager.getTree()).length).toBeGreaterThan(beforeCut.length * 64 * 1024);
			expect(heldWhole(manager, beforeCut)).toEqual([]);
			quarterOfBodies();

			const later: string[] = [];
			for (let index = 0; index < 32; index++)
				later.push(manager.appendMessage(assistant(body(`b${index}`, 64 * 1024))));
			const keep = manager.appendMessage(user(body("keep2", 1024)));
			manager.appendCompaction(body("c2", 1024), undefined, keep, 2000);
			manager.buildSessionContext();
			expect(heldWhole(manager, [...beforeCut, ...later])).toEqual([]);
			quarterOfBodies();
			// No other directory took the bodies: the session's own holds only its file.
			expect(fs.readdirSync(dir.path()).sort()).toEqual(["not-a-directory", "session.jsonl"]);
		} finally {
			await manager.close();
		}
	});

	// Reading an older entry must not bring its body, or the block around it, back into memory for good.
	it("keeps no decompressed body after the reads that needed it, the entries staying cold", async () => {
		using dir = TempDir.createSync("@omp-cold-memory-");
		const { entries, beforeCut } = compactedSession(512, 64 * 1024);
		const file = await writeSession(dir.path(), entries);
		vi.spyOn(os, "tmpdir").mockReturnValue(unusableTmp(dir.path()));
		const manager = await open(file);
		try {
			const bodiesBytes = manager.coldStoreStats().storeBytes;
			const before = heldBytes();
			let read = 0;
			for (const id of beforeCut) {
				const entry = manager.getEntry(id);
				read += JSON.stringify(entry).length;
			}
			expect(read).toBeGreaterThan(bodiesBytes / 2);
			expect(heldWhole(manager, beforeCut)).toEqual([]);
			// The store keeps at most the one block a synchronous pass is reading: a read keeps no
			// decompressed block once the task yields.
			await Bun.sleep(0);
			// The record cache keeps at most 8 records; a kept block or body would hold the bodies' size.
			expect(heldBytes() - before).toBeLessThan(bodiesBytes / 4);
		} finally {
			await manager.close();
		}
	});

	// A full rewrite, or any walk over every older entry, would otherwise decompress a whole block for
	// each record it reads: about 2 ms a record, minutes for the 84,773 records of a long session.
	it("decompresses a block once for a synchronous walk over its records, and again once the task yields", async () => {
		using dir = TempDir.createSync("@omp-cold-memory-");
		// About sixteen records a block: the first six share the first block.
		const { entries, beforeCut } = compactedSession(48, 64 * 1024);
		const file = await writeSession(dir.path(), entries);
		vi.spyOn(os, "tmpdir").mockReturnValue(unusableTmp(dir.path()));
		const manager = await open(file);
		try {
			expect(manager.coldStoreStats().storeInMemory).toBe(true);
			const decompress = vi.spyOn(Bun, "zstdDecompressSync");
			for (const id of beforeCut.slice(0, 5)) JSON.stringify(manager.getEntry(id));
			expect(decompress).toHaveBeenCalledTimes(1);

			await Bun.sleep(0);
			// Not one of the records read above, which the record cache keeps parsed.
			JSON.stringify(manager.getEntry(beforeCut[5]!));
			expect(decompress).toHaveBeenCalledTimes(2);
		} finally {
			await manager.close();
		}
	});

	// Entries on both sides of a block's end must read back as the file holds them, in any order.
	it("reads back every entry across block boundaries, newest first and oldest first", async () => {
		using dir = TempDir.createSync("@omp-cold-memory-");
		// About four records a block.
		const { entries, beforeCut } = compactedSession(40, 300 * 1024);
		const file = await writeSession(dir.path(), entries);
		vi.spyOn(os, "tmpdir").mockReturnValue(unusableTmp(dir.path()));
		const manager = await open(file);
		try {
			const expected = new Map<string, string>();
			for (const entry of await entriesInFile(file)) {
				if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string") {
					expected.set(entry.id, JSON.stringify(entry));
				}
			}
			for (const id of [...beforeCut].reverse()) {
				expect(JSON.stringify(manager.getEntry(id))).toBe(expected.get(id) ?? `missing ${id}`);
			}
			for (const id of beforeCut)
				expect(JSON.stringify(manager.getEntry(id))).toBe(expected.get(id) ?? `missing ${id}`);
			expect(manager.coldStoreStats().compressedBytes).toBeGreaterThan(0);
		} finally {
			await manager.close();
		}
	});

	// A disk that fills up during a long resume must not leave the rest of the older bodies whole in memory.
	it.skipIf(!HAS_PROC_FD)(
		"moves the records a failed write left, and later ones, into compressed blocks while the file keeps the ones it holds",
		async () => {
			using dir = TempDir.createSync("@omp-cold-memory-");
			using tmp = TempDir.createSync("@omp-cold-memory-tmp-");
			const { entries, beforeCut } = compactedSession(96, 64 * 1024);
			const file = await writeSession(dir.path(), entries);
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
			diskFillsUnder(tmp.path(), 1);

			const manager = await open(file);
			try {
				const stats = manager.coldStoreStats();
				expect(stats.storeInMemory).toBe(true);
				expect(stats.coldEntries).toBe(beforeCut.length);
				expect(stats.compressedBytes).toBeGreaterThan(0);
				expect(stats.compressedBytes).toBeLessThanOrEqual(stats.storeBytes / 4);
				expect(JSON.parse(JSON.stringify(manager.getEntries()))).toEqual(await entriesInFile(file));
				expect(heldWhole(manager, beforeCut)).toEqual([]);
			} finally {
				await manager.close();
			}
		},
	);
});
