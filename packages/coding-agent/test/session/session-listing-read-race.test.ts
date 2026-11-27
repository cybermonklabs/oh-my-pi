import { expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage, SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const DIR = path.resolve("/sessions/listing");
const FILE = path.join(DIR, "race.jsonl");
const GAP = `${JSON.stringify({ type: "custom", data: "x".repeat(40 * 1024) })}\n`;

const header = (id: string) => `${JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00.000Z" })}\n`;
const prompt = (content: string) => `${JSON.stringify({ type: "message", message: { role: "user", content } })}\n`;
const reply = `${JSON.stringify({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "reply" }], stopReason: "stop" },
})}\n`;

it("rereads the stat and both windows when a listing scan reports a replacement", async () => {
	const storage = new MemorySessionStorage();
	storage.writeTextSync(FILE, header("original") + prompt("old prompt") + GAP);
	const replacement = header("replacement") + GAP + prompt("new prompt") + reply;
	const readSlices = spyOn(storage, "readTextSlices");
	spyOn(storage, "scanLines").mockImplementationOnce(async file => {
		storage.writeTextSync(file, replacement);
		throw new SessionReadConflictError(file);
	});

	const listing = await listSessions(DIR, storage);
	expect(listing).toHaveLength(1);
	expect(listing[0]).toMatchObject({
		id: "replacement",
		firstMessage: "new prompt",
		assistantTurns: 1,
		status: "complete",
		size: Buffer.byteLength(replacement),
		modified: storage.statSync(FILE).mtime,
	});
	expect(readSlices).toHaveBeenCalledTimes(2);
	// The replacement result is cached under the replacement stat.
	expect(await listSessions(DIR, storage)).toEqual(listing);
	expect(readSlices).toHaveBeenCalledTimes(2);
});

it.each([
	{ line: prompt("recovered prompt"), firstMessage: "recovered prompt", assistantTurns: 0, found: "prompt" },
	{ line: reply, firstMessage: "(no messages)", assistantTurns: 1, found: "assistant turn" },
])("keeps the $found recovered before an ordinary scan error", async ({ line, firstMessage, assistantTurns }) => {
	const storage = new MemorySessionStorage();
	storage.writeTextSync(FILE, header("session") + GAP + line + GAP);
	const scan = spyOn(storage, "scanLines").mockImplementationOnce(async (_file, visit) => {
		expect(visit(line.trimEnd())).toBe(false);
		throw Object.assign(new Error("Read failed"), { code: "EIO" });
	});

	const listing = await listSessions(DIR, storage);
	expect(scan).toHaveBeenCalledTimes(1);
	expect(listing).toHaveLength(1);
	expect(listing[0]).toMatchObject({ firstMessage, assistantTurns });
});
