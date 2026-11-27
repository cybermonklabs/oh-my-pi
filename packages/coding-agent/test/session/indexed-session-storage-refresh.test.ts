/**
 * `IndexedSessionStorage.refresh` brings a long-running process's index up to
 * date with sessions other processes wrote to the shared backend, without
 * losing a write of its own the backend read could not yet describe.
 */
import { describe, expect, test } from "bun:test";
import { SESSION_TITLE_SLOT_BYTES } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { parseTitleSlotFromContent, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import { collectGarbage, countHeapObjectsWithProperty, takeV8HeapSnapshot } from "../helpers/heap-snapshot";

/** A shared backend whose index read can be held open, as a slow database query would be. */
class SharedBackend implements SessionStorageBackend {
	readonly files = new Map<string, { content: string; mtimeMs: number }>();
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

async function storageOn(backend: SharedBackend): Promise<IndexedSessionStorage> {
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	return storage;
}

const SESSION_DIR = "/s/project";
/** The time the headers of the sessions below carry. */
const HEADER_TIME = "2026-11-01T00:00:00.000Z";
/** The time of the title updates the cases below make: later than the headers'. */
const RENAMED_TIME = "2026-11-02T00:00:00.000Z";
/**
 * How long a count of heap objects waits for a reference to an entry that a write replaced to go: JSC can keep such an
 * object past a few full collections, while an entry the index still holds stays counted for the whole wait.
 */
const SETTLE_MS = 5_000;

async function withSqlStorage(run: (storage: SqlSessionStorage) => Promise<void>): Promise<void> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	try {
		await run(storage);
	} finally {
		await storage.drain().catch(() => undefined);
		await client.end();
	}
}

/** A session's text: its title slot, made with the title and time its header carries, its header and two messages. */
function sessionBody(id: string, title: string): string {
	const slot = serializeTitleSlot({ title, source: "auto", updatedAt: HEADER_TIME });
	const header = { type: "session", version: 3, id, timestamp: HEADER_TIME, cwd: "/project" };
	return `${slot}${[header, messageLine(id, 0), messageLine(id, 1)].map(line => JSON.stringify(line)).join("\n")}\n`;
}

function messageLine(id: string, turn: number): object {
	return {
		type: "message",
		id: `${id}-${turn}`,
		parentId: null,
		timestamp: HEADER_TIME,
		message: { role: "user", content: `turn ${turn} of ${id}`, timestamp: 0 },
	};
}

/** A title update to `title` by the user, at {@link RENAMED_TIME}. */
function rename(title: string) {
	return { title, source: "user" as const, updatedAt: RENAMED_TIME };
}

/** `text` as every reader gives it once `title` is its session's title: the title slot at its head is the update's. */
function renamedText(text: string, title: string): string {
	return `${serializeTitleSlot(rename(title))}${text.slice(SESSION_TITLE_SLOT_BYTES)}`;
}

/** The title the title slot at the head of `text` carries. */
function titleOf(text: string): string | undefined {
	return parseTitleSlotFromContent(text)?.title;
}

/** How many objects of the heap hold a `titleUpdatedAt`, after full collections. */
async function titleHolderCount(): Promise<number> {
	await collectGarbage();
	return countHeapObjectsWithProperty(takeV8HeapSnapshot(), "titleUpdatedAt");
}

/** The count a case starts from: what other code holds, once it stops falling. */
async function titleHoldersAtStart(): Promise<number> {
	let held = await titleHolderCount();
	for (const deadline = Date.now() + SETTLE_MS; Date.now() < deadline;) {
		const next = await titleHolderCount();
		if (next === held) break;
		held = next;
	}
	return held;
}

/** The objects holding a `titleUpdatedAt` beyond `baseline`, once at most `atMost` are left or {@link SETTLE_MS} passed. */
async function settledTitleHolders(baseline: number, atMost: number): Promise<number> {
	for (const deadline = Date.now() + SETTLE_MS; ;) {
		const held = (await titleHolderCount()) - baseline;
		if (held <= atMost || Date.now() >= deadline) return held;
		await Bun.sleep(100);
	}
}

async function chunkText(storage: SqlSessionStorage, target: string, fromByte: number): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of storage.readChunks(target, fromByte)) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
}

/**
 * What each reader of `storage` answers for `target`: the size and time of `statSync`, whether the path exists and is
 * listed, and the title through `readText`, `readTextSlices`, `readTextFrom` and the chunked read, with whether each
 * window of text those give is the same bytes `readText` gives.
 */
async function observe(storage: SqlSessionStorage, target: string) {
	const text = await storage.readText(target);
	const bytes = Buffer.from(text, "utf-8");
	const [prefix, suffix] = await storage.readTextSlices(target, SESSION_TITLE_SLOT_BYTES, 40);
	const head = await storage.readTextFrom(target, 0, SESSION_TITLE_SLOT_BYTES);
	const middle = await storage.readTextFrom(target, 10, 50);
	const whole = await storage.readTextFrom(target, 0);
	const chunksFromStart = await chunkText(storage, target, 0);
	const chunksFromBody = await chunkText(storage, target, SESSION_TITLE_SLOT_BYTES + 5);
	const { size, mtimeMs } = storage.statSync(target);
	return {
		exists: storage.existsSync(target),
		listed: storage.listFilesSync(SESSION_DIR, "*.jsonl").includes(target),
		size,
		mtimeMs,
		text,
		titles: {
			readText: titleOf(text),
			readTextSlices: titleOf(prefix),
			readTextFrom: titleOf(head.text),
			readChunks: titleOf(chunksFromStart),
		},
		windowsAgree: {
			suffix: suffix === bytes.subarray(bytes.byteLength - 40).toString("utf-8"),
			middle: middle.text === bytes.subarray(10, 60).toString("utf-8"),
			whole: whole.text === text,
			wholeSize: whole.size === bytes.byteLength && head.size === bytes.byteLength,
			chunksFromStart: chunksFromStart === text,
			chunksFromBody: chunksFromBody === bytes.subarray(SESSION_TITLE_SLOT_BYTES + 5).toString("utf-8"),
		},
	};
}

/** The answers of {@link observe}, less the time, for a session whose text reads as `text` and whose title as `title`. */
function answersFor(text: string, title: string) {
	return {
		exists: true,
		listed: true,
		size: Buffer.byteLength(text),
		text,
		titles: { readText: title, readTextSlices: title, readTextFrom: title, readChunks: title },
		windowsAgree: {
			suffix: true,
			middle: true,
			whole: true,
			wholeSize: true,
			chunksFromStart: true,
			chunksFromBody: true,
		},
	};
}

/** `observed` without its time, which a case compares by itself. */
function withoutTime<T extends { mtimeMs: number }>(observed: T): Omit<T, "mtimeMs"> {
	const { mtimeMs: _time, ...rest } = observed;
	return rest;
}

describe("IndexedSessionStorage index entries", () => {
	// If this regresses, every session a process wrote keeps a copy of its title, the title's source and the time of
	// its header in the index for as long as the process lives (about 300 bytes a session, a parked subagent among
	// them), or a reader answers a size, a time or a title other than the session's own: a title changed after a
	// refresh reads as the header's old one, or the stored head's title hides the change.
	test("keeps only size, time and an overlaid title update in a session's index entry, and still answers existsSync, statSync and listFilesSync and the title through readText, readTextSlices, readTextFrom and the chunked read, a title changed by updateSessionTitle after a refresh included", async () => {
		await withSqlStorage(async storage => {
			const baseline = await titleHoldersAtStart();
			const ids = Array.from({ length: 9 }, (_, index) => `session-${index}`);
			const targets = ids.map(id => `${SESSION_DIR}/${id}.jsonl`);
			const bodies = ids.map(id => sessionBody(id, `Own title of ${id}`));
			const startedAt = Date.now();
			// Each way the storage takes a full write: queued, awaited, and atomic.
			for (const [index, target] of targets.entries()) {
				if (index < 3) storage.writeTextSync(target, bodies[index]);
				else if (index < 6) await storage.writeText(target, bodies[index]);
				else await storage.writeTextAtomic(target, bodies[index]);
			}
			await storage.drain();
			const held = await settledTitleHolders(baseline, 0);

			const written = await Promise.all(targets.map(target => observe(storage, target)));
			expect({
				held,
				answers: written.map(withoutTime),
				timesAreTheWrites: written.map(({ mtimeMs }) => mtimeMs >= startedAt),
			}).toEqual({
				held: 0,
				answers: ids.map((id, index) => answersFor(bodies[index], `Own title of ${id}`)),
				timesAreTheWrites: ids.map(() => true),
			});

			// A title update before any refresh: only the session it renames holds one.
			await storage.updateSessionTitle(targets[0], rename("Renamed first"));
			const renamed = await observe(storage, targets[0]);
			const afterRename = ids.map((id, index) =>
				index === 0
					? answersFor(renamedText(bodies[0], "Renamed first"), "Renamed first")
					: answersFor(bodies[index], `Own title of ${id}`),
			);
			expect({
				held: await settledTitleHolders(baseline, 1),
				renamed: withoutTime(renamed),
				timeMoved: renamed.mtimeMs > written[0].mtimeMs,
			}).toEqual({ held: 1, renamed: afterRename[0], timeMoved: true });

			// A refresh keeps every answer, the time included, as the rows give them.
			await storage.refresh();
			const refreshed = await Promise.all(targets.map(target => observe(storage, target)));
			expect({
				answers: refreshed.map(withoutTime),
				times: refreshed.map(({ mtimeMs }) => mtimeMs),
			}).toEqual({
				answers: afterRename,
				times: [renamed.mtimeMs, ...written.slice(1).map(({ mtimeMs }) => mtimeMs)],
			});

			// A title changed after the refresh reads through every reader, over the title the refresh kept.
			await storage.updateSessionTitle(targets[1], rename("Renamed after the refresh"));
			const later = await Promise.all(targets.slice(0, 3).map(target => observe(storage, target)));
			expect({
				answers: later.map(withoutTime),
				timeMoved: later[1].mtimeMs > refreshed[1].mtimeMs,
			}).toEqual({
				answers: [
					afterRename[0],
					answersFor(renamedText(bodies[1], "Renamed after the refresh"), "Renamed after the refresh"),
					afterRename[2],
				],
				timeMoved: true,
			});
		});
	}, 60_000);

	// If this regresses, an append to a session whose index entry holds a title (a title update kept it) drops the
	// title from every read, or an append to a session that kept none brings one back into the index.
	test("an append after a full write keeps the entry trimmed and the title read through readText", async () => {
		await withSqlStorage(async storage => {
			const baseline = await titleHoldersAtStart();
			const target = `${SESSION_DIR}/appended.jsonl`;
			const body = sessionBody("appended", "Own title");
			await storage.writeText(target, body);
			const written = storage.statSync(target);

			const first = `${JSON.stringify(messageLine("appended", 2))}\n`;
			const writer = storage.openWriter(target);
			await writer.append(first);
			await writer.close();
			await storage.drain();
			const appended = await observe(storage, target);
			expect({
				held: await settledTitleHolders(baseline, 0),
				answers: withoutTime(appended),
				timeMoved: appended.mtimeMs > written.mtimeMs,
			}).toEqual({ held: 0, answers: answersFor(body + first, "Own title"), timeMoved: true });

			// A title update keeps its entry through an append, and every read still gives it.
			await storage.updateSessionTitle(target, rename("Renamed"));
			const second = `${JSON.stringify(messageLine("appended", 3))}\n`;
			const again = storage.openWriter(target);
			await again.append(second);
			await again.close();
			await storage.drain();
			expect({
				held: await settledTitleHolders(baseline, 1),
				answers: withoutTime(await observe(storage, target)),
			}).toEqual({
				held: 1,
				answers: answersFor(renamedText(body + first + second, "Renamed"), "Renamed"),
			});
		});
	}, 60_000);

	// If this regresses, a session emptied by its writer (a rewrite from scratch) reads as the title slot of its old
	// title, or what is written next reads under the old title or the title of an earlier update.
	test("a truncation clears the entry's title, and readText gives the title of what is written next", async () => {
		await withSqlStorage(async storage => {
			const baseline = await titleHoldersAtStart();
			const target = `${SESSION_DIR}/truncated.jsonl`;
			await storage.writeText(target, sessionBody("truncated", "First title"));
			await storage.updateSessionTitle(target, rename("Renamed"));
			expect({
				held: await settledTitleHolders(baseline, 1),
				title: titleOf(await storage.readText(target)),
			}).toEqual({
				held: 1,
				title: "Renamed",
			});

			const writer = storage.openWriter(target, { flags: "w" });
			await writer.close();
			await storage.drain();
			// Emptied, it reads as nothing: the old title is not laid over a body that holds no slot.
			expect({
				held: await settledTitleHolders(baseline, 0),
				size: storage.statSync(target).size,
				text: await storage.readText(target),
				chunks: await chunkText(storage, target, 0),
			}).toEqual({ held: 0, size: 0, text: "", chunks: "" });

			// What is written next: first appended by the writer, then rewritten in full.
			const next = sessionBody("truncated", "Second title");
			const again = storage.openWriter(target, { flags: "w" });
			await again.append(next);
			await again.close();
			await storage.drain();
			expect({
				held: await settledTitleHolders(baseline, 0),
				answers: withoutTime(await observe(storage, target)),
			}).toEqual({ held: 0, answers: answersFor(next, "Second title") });

			const rewritten = sessionBody("truncated", "Third title");
			await storage.writeText(target, rewritten);
			await storage.drain();
			expect({
				held: await settledTitleHolders(baseline, 0),
				answers: withoutTime(await observe(storage, target)),
			}).toEqual({ held: 0, answers: answersFor(rewritten, "Third title") });
		});
	}, 60_000);
});

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
