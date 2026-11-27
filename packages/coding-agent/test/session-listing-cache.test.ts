import { describe, expect, it, spyOn } from "bun:test";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage, SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/project";

function writeSession(storage: MemorySessionStorage, file: string, firstPrompt: string): void {
	storage.writeTextSync(
		file,
		[
			JSON.stringify({
				type: "session",
				id: "cache-id",
				cwd: "/repo",
				title: "Cached Title",
				timestamp: "2026-06-27T00:00:00.000Z",
			}),
			JSON.stringify({ type: "message", message: { role: "user", content: firstPrompt } }),
			"",
		].join("\n"),
	);
}

describe("session listing scan cache", () => {
	it("serves an unchanged file from cache without re-reading it", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/cached.jsonl`;
		writeSession(storage, file, "first prompt");
		const readSpy = spyOn(storage, "readTextSlices");

		const first = await listSessions(SESSION_DIR, storage);
		expect(first.map(s => s.id)).toEqual(["cache-id"]);
		expect(readSpy).toHaveBeenCalledTimes(1);

		const second = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("invalidates when the file's size changes", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/grows.jsonl`;
		writeSession(storage, file, "short");
		const readSpy = spyOn(storage, "readTextSlices");

		await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// Simulate the active session growing during streaming.
		writeSession(storage, file, "a much longer replacement prompt");
		const after = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(after[0]?.firstMessage).toBe("a much longer replacement prompt");
	});

	it("invalidates when mtime changes even at identical size", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/retitle.jsonl`;
		writeSession(storage, file, "same-length");
		const readSpy = spyOn(storage, "readTextSlices");

		await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// Simulate updateSessionTitle's in-place slot rewrite: same byte length,
		// newer mtime (MemorySessionStorage stamps Date.now on write). Advance
		// the clock deterministically instead of sleeping.
		const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 10);
		try {
			writeSession(storage, file, "SAME-LENGTH");
		} finally {
			nowSpy.mockRestore();
		}
		const after = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(after[0]?.firstMessage).toBe("SAME-LENGTH");
	});

	it("caches negative results for unparseable files", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/garbage.jsonl`;
		storage.writeTextSync(file, "not json at all\n");
		const readSpy = spyOn(storage, "readTextSlices");

		expect(await listSessions(SESSION_DIR, storage)).toEqual([]);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(await listSessions(SESSION_DIR, storage)).toEqual([]);
		expect(readSpy).toHaveBeenCalledTimes(1);
	});
});

/**
 * A session `id` whose first prompt sits past the 4 KiB head window, behind a
 * leading entry of 8 KiB, and that has no reply: only the line scan finds the
 * prompt, and it reads to the end looking for a reply.
 */
function longPromptSession(id: string, prompt: string): string {
	return [
		JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: "2026-06-27T00:00:00.000Z" }),
		JSON.stringify({ type: "custom", customType: "pad", data: "p".repeat(8 * 1024) }),
		JSON.stringify({ type: "message", message: { role: "user", content: prompt } }),
		JSON.stringify({ type: "custom", customType: "note", data: "after the prompt" }),
		"",
	].join("\n");
}

/** Memory storage whose first line scan of a file ends as `scan` says, given the file and the scan's visitor. */
class ScanFailingStorage extends MemorySessionStorage {
	#failed = false;

	constructor(readonly scan: (file: string, visit: (line: string) => boolean) => Promise<void>) {
		super();
	}

	override scanLines(filePath: string, visit: (line: string) => boolean): Promise<void> {
		if (this.#failed) return super.scanLines(filePath, visit);
		this.#failed = true;
		return this.scan(filePath, visit);
	}
}

describe("session listing line scan", () => {
	it("lists one body's header and prompt when a full rewrite races the scan", async () => {
		// If this regresses, the session picker lists a session another process rewrote with the old
		// body's id and the new body's first prompt, and keeps that pairing under the old stat.
		const file = `${SESSION_DIR}/raced.jsonl`;
		const storage = new ScanFailingStorage(async path => {
			storage.writeTextSync(path, longPromptSession("rewritten-id", "rewritten prompt"));
			throw new SessionReadConflictError(path);
		});
		storage.writeTextSync(file, longPromptSession("original-id", "original prompt"));

		const [listed] = await listSessions(SESSION_DIR, storage);
		const reads = spyOn(storage, "readTextSlices");
		const [again] = await listSessions(SESSION_DIR, storage);

		expect({
			listed: { id: listed?.id, firstMessage: listed?.firstMessage, size: listed?.size },
			again: { id: again?.id, firstMessage: again?.firstMessage },
			readsAgain: reads.mock.calls.length,
		}).toEqual({
			listed: { id: "rewritten-id", firstMessage: "rewritten prompt", size: storage.statSync(file).size },
			again: { id: "rewritten-id", firstMessage: "rewritten prompt" },
			readsAgain: 0,
		});
	});

	it("keeps the prompt the scan found before a read error", async () => {
		// If this regresses, a session whose storage fails partway through the scan, after the scan found
		// its first prompt, is listed as "(no messages)".
		const file = `${SESSION_DIR}/unreadable.jsonl`;
		const storage = new ScanFailingStorage(async (path, visit) => {
			const lines = (await storage.readText(path)).split("\n");
			for (const line of lines) {
				if (line.includes("after the prompt")) throw Object.assign(new Error("read failed"), { code: "EIO" });
				if (visit(line)) return;
			}
		});
		storage.writeTextSync(file, longPromptSession("unreadable-id", "found prompt"));

		const [listed] = await listSessions(SESSION_DIR, storage);

		expect({ id: listed?.id, firstMessage: listed?.firstMessage }).toEqual({
			id: "unreadable-id",
			firstMessage: "found prompt",
		});
	});
});
