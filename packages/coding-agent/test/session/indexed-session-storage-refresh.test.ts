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
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { parseTitleSlotFromContent, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import { collectGarbage, HeapGraph, takeV8HeapSnapshot } from "../helpers/heap-snapshot";

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
	async readFull(path: string): Promise<SessionStorageFullRead | null> {
		const file = this.files.get(path);
		return file ? { text: file.content, title: undefined } : null;
	}
	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string, undefined]> {
		const content = Buffer.from(this.files.get(path)?.content ?? "");
		return [
			content.subarray(0, prefixBytes).toString(),
			content.subarray(Math.max(0, content.length - suffixBytes)).toString(),
			undefined,
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
 * How long a look at the heap waits for an object that a write replaced to go: JSC can keep such an object past a
 * few full collections, while an object the storage still holds stays for the whole wait.
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

/** A string no other in the process carries: every title a case makes carries its own. */
function titleMarker(): string {
	return `title-marker-${crypto.randomUUID()}`;
}

/**
 * The strings carrying `marker` that a plain object only a table holds keeps, after full collections, each as the
 * retainer path from that object: `(Object a table holds).title: <the title>`. A Map keeps its values in a table
 * the heap snapshot records no edge out of, so the entry the storage's index keeps for a path (`#index` → its table
 * → the entry) is such an object, as is the value of any other Map or Set; an object the test or a pending call
 * holds has a retainer the snapshot shows. Looked at until none is left or {@link SETTLE_MS} passed.
 */
async function titlesInTableEntries(marker: string): Promise<string[]> {
	for (const deadline = Date.now() + SETTLE_MS; ;) {
		await collectGarbage();
		const graph = new HeapGraph(takeV8HeapSnapshot());
		const holders = graph.retainers(new Set(graph.stringNodes(text => text.includes(marker))));
		const objects = new Set<number>();
		for (const retainers of holders.values()) {
			for (const { from } of retainers)
				if (graph.type(from) === "object" && graph.name(from) === "Object") objects.add(from);
		}
		const heldObjects = graph.retainers(objects);
		const found: string[] = [];
		for (const [title, retainers] of holders) {
			for (const { from, name } of retainers) {
				if (objects.has(from) && !heldObjects.has(from))
					found.push(`(Object a table holds).${name}: ${graph.name(title)}`);
			}
		}
		if (found.length === 0 || Date.now() >= deadline) return found.sort();
		// A real wait: what lets JSC drop a replaced object is later turns of the event loop, which no fake clock gives.
		await Bun.sleep(100);
	}
}

async function chunkText(storage: SqlSessionStorage, target: string, fromByte: number): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of storage.readChunks(target, fromByte)) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
}

/**
 * What each reader of `storage` answers for `target`: the size and time of `statSync`, whether the path exists, is
 * confirmed and is listed, and the title through `readText`, `readTextSlices`, `readTextFrom` and the chunked read,
 * with whether each window of text those give is the same bytes `readText` gives.
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
		confirmed: storage.existsConfirmedSync(target),
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
		confirmed: true,
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
	// If this regresses, every session a process wrote, renamed, or found in a refresh keeps a copy of its title,
	// the title's source and its time in the index for as long as the process lives (104 bytes a parked subagent),
	// or a reader answers a size, a time, a confirmation or a title other than the session's own.
	test("keeps no title in the index through queued, awaited and atomic full writes, a title update and a refresh, while existsSync, existsConfirmedSync, statSync, listFilesSync and the title through readText, readTextSlices, readTextFrom and the chunked read answer as before", async () => {
		await withSqlStorage(async storage => {
			const marker = titleMarker();
			const ids = Array.from({ length: 9 }, (_, index) => `session-${index}`);
			const targets = ids.map(id => `${SESSION_DIR}/${id}.jsonl`);
			const own = (id: string): string => `Own title of ${id} ${marker}`;
			const bodies = ids.map(id => sessionBody(id, own(id)));
			const startedAt = Date.now();
			// Each way the storage takes a full write: queued, awaited, and atomic.
			for (const [index, target] of targets.entries()) {
				if (index < 3) storage.writeTextSync(target, bodies[index]);
				else if (index < 6) await storage.writeText(target, bodies[index]);
				else await storage.writeTextAtomic(target, bodies[index]);
			}
			await storage.drain();
			// What the index holds of the titles after each step, checked together at the end so each step shows.
			const held: Record<string, string[]> = { afterFullWrites: await titlesInTableEntries(marker) };
			const written = await Promise.all(targets.map(target => observe(storage, target)));
			expect({
				answers: written.map(withoutTime),
				timesAreTheWrites: written.map(({ mtimeMs }) => mtimeMs >= startedAt),
			}).toEqual({
				answers: ids.map((id, index) => answersFor(bodies[index], own(id))),
				timesAreTheWrites: ids.map(() => true),
			});

			// A title update: the backend's metadata, read with the bytes; the index takes only its time.
			const renamedFirst = `Renamed first ${marker}`;
			await storage.updateSessionTitle(targets[0], rename(renamedFirst));
			held.afterTitleUpdate = await titlesInTableEntries(marker);
			const renamed = await observe(storage, targets[0]);
			const afterRename = ids.map((id, index) =>
				index === 0
					? answersFor(renamedText(bodies[0], renamedFirst), renamedFirst)
					: answersFor(bodies[index], own(id)),
			);
			expect({
				renamed: withoutTime(renamed),
				timeMoved: renamed.mtimeMs > written[0].mtimeMs,
			}).toEqual({ renamed: afterRename[0], timeMoved: true });

			// A refresh takes each row's size and time, and every answer, the time included, stays as the rows give it.
			await storage.refresh();
			held.afterRefresh = await titlesInTableEntries(marker);
			const refreshed = await Promise.all(targets.map(target => observe(storage, target)));
			expect({
				answers: refreshed.map(withoutTime),
				times: refreshed.map(({ mtimeMs }) => mtimeMs),
			}).toEqual({
				answers: afterRename,
				times: [renamed.mtimeMs, ...written.slice(1).map(({ mtimeMs }) => mtimeMs)],
			});

			// A title changed after the refresh reads through every reader.
			const renamedLater = `Renamed after the refresh ${marker}`;
			await storage.updateSessionTitle(targets[1], rename(renamedLater));
			held.afterTitleUpdateAfterRefresh = await titlesInTableEntries(marker);
			const later = await Promise.all(targets.slice(0, 3).map(target => observe(storage, target)));
			expect({
				answers: later.map(withoutTime),
				timeMoved: later[1].mtimeMs > refreshed[1].mtimeMs,
			}).toEqual({
				answers: [afterRename[0], answersFor(renamedText(bodies[1], renamedLater), renamedLater), afterRename[2]],
				timeMoved: true,
			});

			expect(held).toEqual({
				afterFullWrites: [],
				afterTitleUpdate: [],
				afterRefresh: [],
				afterTitleUpdateAfterRefresh: [],
			});
		});
	}, 120_000);

	// If this regresses, an append to a session another title update renamed brings the title into the index, or
	// drops it from every read.
	test("keeps no title in the index through an append after a full write and after a title update, and every reader gives the session's title", async () => {
		await withSqlStorage(async storage => {
			const marker = titleMarker();
			const target = `${SESSION_DIR}/appended.jsonl`;
			const ownTitle = `Own title ${marker}`;
			const body = sessionBody("appended", ownTitle);
			await storage.writeText(target, body);
			const written = storage.statSync(target);

			const first = `${JSON.stringify(messageLine("appended", 2))}\n`;
			const writer = storage.openWriter(target);
			await writer.append(first);
			await writer.close();
			await storage.drain();
			const heldAfterAppend = await titlesInTableEntries(marker);
			const appended = await observe(storage, target);
			expect({
				held: heldAfterAppend,
				answers: withoutTime(appended),
				timeMoved: appended.mtimeMs > written.mtimeMs,
			}).toEqual({ held: [], answers: answersFor(body + first, ownTitle), timeMoved: true });

			// After a title update, an append keeps the title the backend holds, and every read gives it.
			const renamedTitle = `Renamed ${marker}`;
			await storage.updateSessionTitle(target, rename(renamedTitle));
			const second = `${JSON.stringify(messageLine("appended", 3))}\n`;
			const again = storage.openWriter(target);
			await again.append(second);
			await again.close();
			await storage.drain();
			const heldAfterRenamedAppend = await titlesInTableEntries(marker);
			expect({
				held: heldAfterRenamedAppend,
				answers: withoutTime(await observe(storage, target)),
			}).toEqual({
				held: [],
				answers: answersFor(renamedText(body + first + second, renamedTitle), renamedTitle),
			});
		});
	}, 120_000);

	// If this regresses, a session emptied by its writer (a rewrite from scratch) reads as the title slot of its old
	// title, or what is written next reads under the old title or the title of an earlier update.
	test("a truncation clears the session's title, and every reader gives the title of what is written next", async () => {
		await withSqlStorage(async storage => {
			const marker = titleMarker();
			const target = `${SESSION_DIR}/truncated.jsonl`;
			await storage.writeText(target, sessionBody("truncated", `First title ${marker}`));
			const renamedTitle = `Renamed ${marker}`;
			await storage.updateSessionTitle(target, rename(renamedTitle));
			expect(titleOf(await storage.readText(target))).toBe(renamedTitle);

			const writer = storage.openWriter(target, { flags: "w" });
			await writer.close();
			await storage.drain();
			// Emptied, it reads as nothing: the old title is not laid over a body that holds no slot.
			expect({
				held: await titlesInTableEntries(marker),
				size: storage.statSync(target).size,
				text: await storage.readText(target),
				chunks: await chunkText(storage, target, 0),
			}).toEqual({ held: [], size: 0, text: "", chunks: "" });

			// What is written next: first appended by the writer, then rewritten in full.
			const secondTitle = `Second title ${marker}`;
			const next = sessionBody("truncated", secondTitle);
			const again = storage.openWriter(target, { flags: "w" });
			await again.append(next);
			await again.close();
			await storage.drain();
			const heldAfterAppend = await titlesInTableEntries(marker);
			expect({ held: heldAfterAppend, answers: withoutTime(await observe(storage, target)) }).toEqual({
				held: [],
				answers: answersFor(next, secondTitle),
			});

			const thirdTitle = `Third title ${marker}`;
			const rewritten = sessionBody("truncated", thirdTitle);
			await storage.writeText(target, rewritten);
			await storage.drain();
			const heldAfterRewrite = await titlesInTableEntries(marker);
			expect({ held: heldAfterRewrite, answers: withoutTime(await observe(storage, target)) }).toEqual({
				held: [],
				answers: answersFor(rewritten, thirdTitle),
			});
		});
	}, 120_000);
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
