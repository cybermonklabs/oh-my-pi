/**
 * `IndexedSessionStorage.refresh` brings a long-running process's index up to
 * date with sessions other processes wrote to the shared backend, without
 * losing a write of its own the backend read could not yet describe. A
 * backend that cannot read a byte range is read whole once per line scan, and
 * a scan in read windows visits each line as the whole read holds it.
 */
import { describe, expect, test } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import * as sessionStorageModule from "@oh-my-pi/pi-coding-agent/session/session-storage";

/** A shared backend whose index read can be held open, as a slow database query would be. */
class SharedBackend implements SessionStorageBackend {
	readonly files = new Map<string, { content: string; mtimeMs: number }>();
	/** Whole-session reads; this backend has no `readFrom`, so every read is one. */
	readFullCalls = 0;
	#heldIndex: { snapshot: SessionStorageIndexEntry[]; release: PromiseWithResolvers<void> } | undefined;

	/** The next index read snapshots now and returns only once released. */
	holdNextIndexRead(): () => void {
		const release = Promise.withResolvers<void>();
		this.#heldIndex = { snapshot: [], release };
		return () => release.resolve();
	}

	#snapshot(): SessionStorageIndexEntry[] {
		return [...this.files].map(([path, file]) => ({
			path,
			size: Buffer.byteLength(file.content),
			mtimeMs: file.mtimeMs,
		}));
	}

	async init(): Promise<void> {}
	async loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		const held = this.#heldIndex;
		if (!held) return this.#snapshot();
		this.#heldIndex = undefined;
		const snapshot = this.#snapshot();
		await held.release.promise;
		return snapshot;
	}
	async readFull(path: string): Promise<string | null> {
		this.readFullCalls++;
		return this.files.get(path)?.content ?? null;
	}
	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const content = Buffer.from(this.files.get(path)?.content ?? "");
		return [
			content.subarray(0, prefixBytes).toString(),
			content.subarray(Math.max(0, content.length - suffixBytes)).toString(),
		];
	}
	async writeFull(path: string, content: string, mtimeMs: number): Promise<void> {
		this.files.set(path, { content, mtimeMs });
	}
	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		this.files.set(path, { content: (this.files.get(path)?.content ?? "") + line, mtimeMs });
	}
	async updateSessionTitle(): Promise<void> {}
	async truncate(path: string, mtimeMs: number): Promise<void> {
		this.files.set(path, { content: "", mtimeMs });
	}
	async remove(paths: string[]): Promise<void> {
		for (const path of paths) this.files.delete(path);
	}
	async move(src: string, dst: string): Promise<void> {
		const file = this.files.get(src);
		if (!file) return;
		this.files.delete(src);
		this.files.set(dst, file);
	}
}

/** The same backend with a range read, which keeps every byte of the range as a file read would. */
class RangedBackend extends SharedBackend {
	async readFrom(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null> {
		const content = this.files.get(path)?.content;
		if (content === undefined) return null;
		const bytes = Buffer.from(content, "utf-8");
		const end = maxBytes === undefined ? undefined : offset + maxBytes;
		return { text: bytes.subarray(offset, end).toString("utf-8"), size: bytes.length };
	}
}

async function storageOn(backend: SharedBackend): Promise<IndexedSessionStorage> {
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	return storage;
}

describe("IndexedSessionStorage.refresh", () => {
	test("shows sessions another process created and drops ones it removed", async () => {
		const backend = new SharedBackend();
		backend.files.set("/s/gone.jsonl", { content: "{}\n", mtimeMs: 1 });
		const storage = await storageOn(backend);
		backend.files.set("/s/new.jsonl", { content: "{}\n", mtimeMs: 2 });
		backend.files.delete("/s/gone.jsonl");

		expect(storage.listFilesSync("/s", "*.jsonl")).toEqual(["/s/gone.jsonl"]);
		await storage.refresh();

		expect(storage.listFilesSync("/s", "*.jsonl")).toEqual(["/s/new.jsonl"]);
		expect(storage.statSync("/s/new.jsonl").size).toBe(3);
	});

	test("keeps a local write made while the backend read was in flight", async () => {
		const backend = new SharedBackend();
		const storage = await storageOn(backend);
		const release = backend.holdNextIndexRead();
		const refreshing = storage.refresh();
		// Written after the held read took its snapshot, and published before it returns.
		await storage.writeText("/s/mine.jsonl", "local session\n");
		release();
		await refreshing;

		expect(storage.existsSync("/s/mine.jsonl")).toBe(true);
		expect(await storage.readText("/s/mine.jsonl")).toBe("local session\n");
	});

	test("keeps a local removal made while the backend read was in flight", async () => {
		const backend = new SharedBackend();
		backend.files.set("/s/old.jsonl", { content: "{}\n", mtimeMs: 1 });
		const storage = await storageOn(backend);
		const release = backend.holdNextIndexRead();
		const refreshing = storage.refresh();
		await storage.unlink("/s/old.jsonl");
		release();
		await refreshing;

		expect(storage.existsSync("/s/old.jsonl")).toBe(false);
	});
});

describe("IndexedSessionStorage.scanLines on a backend that cannot read a range", () => {
	test("reads a transcript several read windows long whole, once, and visits every line", async () => {
		const backend = new SharedBackend();
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${"é".repeat(60_000)}`);
		backend.files.set("/s/long.jsonl", { content: `${lines.join("\n")}\n`, mtimeMs: 1 });
		const storage = await storageOn(backend);
		backend.readFullCalls = 0;
		const seen: string[] = [];

		await storage.scanLines("/s/long.jsonl", line => {
			if (line) seen.push(line.slice(0, line.indexOf(" ", 5)));
			return false;
		});

		expect(seen).toEqual(lines.map(line => line.slice(0, line.indexOf(" ", 5))));
		expect(backend.readFullCalls).toBe(1);
	});
});

describe("IndexedSessionStorage.scanLines in read windows", () => {
	test("keeps a byte order mark that opens a line at the start of a read window, as the whole read does", async () => {
		// Through the module, so the file still loads at a tree that does not export the window size.
		const windowBytes = sessionStorageModule.SESSION_READ_WINDOW_BYTES ?? 1024 * 1024;
		const backend = new RangedBackend();
		// The first line and its newline fill the first window exactly, so the marked line starts the second.
		const first = "x".repeat(windowBytes - 1);
		const content = `${first}\n\uFEFFmarked\nafter\n`;
		backend.files.set("/s/marked.jsonl", { content, mtimeMs: 1 });
		const storage = await storageOn(backend);
		const seen: string[] = [];

		await storage.scanLines("/s/marked.jsonl", line => {
			// Each window ends at a newline, so each gives an empty last line.
			if (line) seen.push(line.length > 32 ? `${line.slice(0, 8)}…(${line.length})` : line);
			return false;
		});

		expect(seen).toEqual([`xxxxxxxx…(${windowBytes - 1})`, "\uFEFFmarked", "after"]);
		expect((await storage.readText("/s/marked.jsonl")).split("\n")[1]).toBe("\uFEFFmarked");
	});
});
