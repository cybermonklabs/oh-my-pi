/**
 * A full rewrite that meets entries another writer appended to the session
 * file (one without the ownership lease: an older omp, an external tool) reads
 * the file back, keeps those entries and republishes. The read-back streams
 * the stored transcript (windows of at most 1 MiB on the synchronous path), so
 * these sessions span several windows, with a multibyte character across the
 * first window's edge, and must adopt exactly the entries a parse of the whole
 * file finds. A read-back that another writer's full write cut off mid-read
 * (`SessionReadConflictError`, which SQL storage's chunked read raises) reads
 * the file again instead of taking it for another session's.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	SessionReadConflictError,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The most a synchronous read-back reads at once. */
const WINDOW_BYTES = 1024 * 1024;
/** Four UTF-8 bytes, so a window edge can fall inside it. */
const WIDE_CHARACTER = "😀";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** A line cut off mid-record: the next append replaces the whole file synchronously. */
const TORN_LINE = '{"type":"message"\n';

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

/**
 * A titled session of four user turns of about 1.2 MB each, the first padded
 * so that the first read window ends inside a {@link WIDE_CHARACTER}.
 */
function transcriptAcrossWindows(id: string, cwd: string): string {
	const slot = serializeTitleSlot({ title: "Long session", source: "user", updatedAt: TIMESTAMP });
	const header = `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd })}\n`;
	const run = WIDE_CHARACTER.repeat(300_000);
	const turnLine = (entryId: string, parentId: string | null, content: string) =>
		`${JSON.stringify({ type: "message", id: entryId, parentId, timestamp: TIMESTAMP, message: userTurn(content) })}\n`;
	// Bytes before the first turn's run of wide characters, without padding.
	const marked = turnLine("t0", null, "<run>");
	const runStart = Buffer.byteLength(slot + header + marked.slice(0, marked.indexOf("<run>")));
	const pad = "a".repeat((((WINDOW_BYTES - runStart - 2) % 4) + 4) % 4);
	const lines = [slot, header, turnLine("t0", null, pad + run)];
	for (let turn = 1; turn < 4; turn++) lines.push(turnLine(`t${turn}`, `t${turn - 1}`, `turn ${turn} ${run}`));
	return lines.join("");
}

interface Storages {
	/** The storage the session under test writes through. */
	ours: SessionStorage;
	/** The storage the other writer, and the later reader, use. */
	other: SessionStorage;
	/** Each byte range `ours` decoded through `readTextRangeSync`. */
	ranges: Array<{ bytes: number; text: string }>;
}

/** File storage whose range reader fails: file storage reads the file's windows itself. */
async function fileStorages(file: string, content: string): Promise<Storages> {
	await Bun.write(file, content);
	const ours: SessionStorage = new FileSessionStorage();
	ours.readTextRangeSync = () => {
		throw new Error("File storage reads the file's windows itself, not through its range reader");
	};
	return { ours, other: new FileSessionStorage(), ranges: [] };
}

/** An in-memory store that reads byte ranges synchronously, recording each range it decoded. */
async function rangeReadingMemoryStorages(file: string, content: string): Promise<Storages> {
	const memory = new MemorySessionStorage();
	memory.writeTextSync(file, content);
	const ranges: Storages["ranges"] = [];
	const ours: SessionStorage = memory;
	ours.readTextRangeSync = (filePath, start, end) => {
		const bytes = Buffer.from(memory.readTextSync(filePath), "utf8");
		const stop = Math.min(end, bytes.length);
		const text = bytes.toString("utf8", Math.min(start, stop), stop);
		ranges.push({ bytes: Math.max(0, stop - start), text });
		return text;
	};
	return { ours, other: memory, ranges };
}

function open(file: string, storage: SessionStorage): Promise<SessionManager> {
	return SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
}

describe("conflict recovery of a session file another writer appended to", () => {
	it.each([
		{ path: "an atomic rewrite, reading the stored chunk stream", storages: fileStorages, tornTail: false },
		{ path: "a synchronous rewrite, reading windows of the file itself", storages: fileStorages, tornTail: true },
		{
			path: "a synchronous rewrite on a store that reads windows through readTextRangeSync",
			storages: rangeReadingMemoryStorages,
			tornTail: true,
		},
	])("adopts exactly the entries a whole parse of the file finds, after $path", async ({ storages, tornTail }) => {
		using dir = TempDir.createSync("@omp-conflict-recovery-");
		const file = path.join(dir.path(), "session.jsonl");
		const content = transcriptAcrossWindows(path.basename(dir.path()), dir.path());
		const { ours: ourStorage, other, ranges } = await storages(file, tornTail ? content + TORN_LINE : content);
		const ours = await open(file, ourStorage);
		const ourBranch = ours.getBranch().map(entry => entry.id);
		const ourIds = new Set(ours.getEntries().map(entry => entry.id));

		const theirs = await open(file, other);
		theirs.appendMessage(userTurn(`their turn ${WIDE_CHARACTER.repeat(1000)}`));
		theirs.appendMessage(userTurn("their second turn"));
		await theirs.close();
		const expected = (parseSessionContent(await other.readText(file)).entries.slice(1) as SessionEntry[]).filter(
			entry => !ourIds.has(entry.id),
		);
		expect(expected.length).toBeGreaterThanOrEqual(2);

		const notices: SessionPersistenceNotice[] = [];
		const errors: Error[] = [];
		ours.onPersistenceNotice(notice => notices.push(notice));
		ours.onPersistenceError(error => errors.push(error));
		if (tornTail) ours.appendMessage(userTurn("our turn after the conflict"));
		else await ours.rewriteEntries();
		await ours.flush();

		const adopted = ours.getEntries().filter(entry => expected.some(found => found.id === entry.id));
		expect(JSON.parse(JSON.stringify(adopted))).toEqual(JSON.parse(JSON.stringify(expected)));
		expect(
			ours
				.getBranch()
				.map(entry => entry.id)
				.slice(0, ourBranch.length),
		).toEqual(ourBranch);
		expect(ours.getSessionFile()).toBe(file);
		expect(notices).toEqual([]);
		expect(errors).toEqual([]);
		await ours.close();

		const reopened = await open(file, other);
		expect(reopened.getEntries().filter(entry => expected.some(found => found.id === entry.id))).toHaveLength(
			expected.length,
		);
		await reopened.close();
		if (ourStorage instanceof MemorySessionStorage) {
			expect(ranges.length).toBeGreaterThan(1);
			expect(ranges.every(range => range.bytes <= WINDOW_BYTES)).toBe(true);
			// The first window ended inside a wide character, which the next window read whole.
			expect(ranges[0]!.text.endsWith("\uFFFD")).toBe(true);
		}
	});
});

/**
 * `storage` with its chunked reads counted, the next `conflicts` of them each
 * failing after their first chunk as a read does on SQL storage when another
 * writer's full write replaced the file mid-read.
 */
function cutOffReads(storage: FileSessionStorage, conflicts: number): { reads: () => number } {
	const readChunks = storage.readChunks.bind(storage);
	let reads = 0;
	let left = conflicts;
	storage.readChunks = async function* (filePath: string, fromByte?: number) {
		reads++;
		for await (const chunk of readChunks(filePath, fromByte)) {
			yield chunk;
			if (left > 0) {
				left--;
				throw new SessionReadConflictError(filePath);
			}
		}
	};
	return { reads: () => reads };
}

describe("conflict recovery whose read-back another writer's full write cut off", () => {
	/** A session another writer appended a turn to, opened before it did; and that writer's file. */
	async function contestedSession(
		dir: TempDir,
	): Promise<{ file: string; ours: SessionManager; storage: FileSessionStorage; written: string }> {
		const file = path.join(dir.path(), "session.jsonl");
		await Bun.write(file, transcriptAcrossWindows(path.basename(dir.path()), dir.path()));
		const storage = new FileSessionStorage();
		const ours = await open(file, storage);
		const theirs = await open(file, new FileSessionStorage());
		theirs.appendMessage(userTurn("their turn"));
		await theirs.close();
		return { file, ours, storage, written: await new FileSessionStorage().readText(file) };
	}

	it("reads the file again and keeps the session's id and file, taking in the other writer's turn", async () => {
		using dir = TempDir.createSync("@omp-conflict-reread-");
		const { file, ours, storage } = await contestedSession(dir);
		const id = ours.getSessionId();
		const notices: SessionPersistenceNotice[] = [];
		const errors: Error[] = [];
		ours.onPersistenceNotice(notice => notices.push(notice));
		ours.onPersistenceError(error => errors.push(error));
		const { reads } = cutOffReads(storage, 1);

		await ours.rewriteEntries();
		await ours.flush();

		expect({
			sessionId: ours.getSessionId(),
			sessionFile: ours.getSessionFile(),
			notices,
			errors,
			reads: reads(),
			theirTurn: ours
				.getEntries()
				.some(
					entry =>
						entry.type === "message" && entry.message.role === "user" && entry.message.content === "their turn",
				),
		}).toEqual({ sessionId: id, sessionFile: file, notices: [], errors: [], reads: 2, theirTurn: true });
		await ours.close();
	});

	it("moves to a sibling as contested after three cut-off reads, leaving the file as the other writer wrote it", async () => {
		using dir = TempDir.createSync("@omp-conflict-reread-");
		const { file, ours, storage, written } = await contestedSession(dir);
		const notices: SessionPersistenceNotice[] = [];
		ours.onPersistenceNotice(notice => notices.push(notice));
		const { reads } = cutOffReads(storage, Number.POSITIVE_INFINITY);

		await ours.rewriteEntries();
		await ours.flush();

		expect({
			reasons: notices.map(notice => notice.reason),
			reads: reads(),
			unchanged: (await new FileSessionStorage().readText(file)) === written,
		}).toEqual({ reasons: ["contested"], reads: 3, unchanged: true });
		await ours.close();
	});
});
