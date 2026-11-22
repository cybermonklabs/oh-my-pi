/**
 * The session manager expects a file-store session's size in stored bytes, as the stream path counts them, even where
 * the text decodes to something longer: an invalid UTF-8 byte decodes to U+FFFD (3 bytes for 1), and so does a
 * character cut off at the file's end. The text path (below 8 MiB) and the manager's recovery from a write conflict
 * took the size from the decoded text, so such a session met a size conflict at its first whole rewrite (cut off: at
 * its first append), and after three tries moved to a second file under a new id. The loaded size is checked too:
 * the conflict recovery alone would keep the session one session after a needless conflict.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const ID = "0199c0de-0000-7000-8000-0000000000a1";
const utf8 = (text: string) => Buffer.from(text, "utf8");
const header = `${JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-11-21T00:00:00.000Z", cwd: "/w" })}\n`;
/** A user message line whose text is `before`, then `raw` bytes as they are, then `after`. */
const userLine = (id: string, parentId: string | null, before: string, raw: number[] = [], after = "") =>
	Buffer.concat([
		utf8(
			`{"type":"message","id":"${id}","parentId":${JSON.stringify(parentId)},"timestamp":"2026-11-21T00:00:01.000Z","message":{"role":"user","content":"${before}`,
		),
		Buffer.from(raw),
		utf8(`${after}","timestamp":1}}\n`),
	]);

function userTurn(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** `bytes` written as a session file, loaded with its stored size, and opened through the file store. */
async function open(dir: TempDir, bytes: Buffer): Promise<{ file: string; manager: SessionManager }> {
	const file = path.join(dir.path(), "s.jsonl");
	fs.writeFileSync(file, bytes);
	expect((await loadSessionFile(file, new FileSessionStorage())).sourceSize).toBe(bytes.length);
	const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), { suppressBreadcrumb: true });
	return { file, manager };
}

/** The session is still one session: the manager kept its file and id, and the listing names only it. */
async function expectOneSession(dir: TempDir, file: string, manager: SessionManager): Promise<void> {
	expect([manager.getSessionFile(), manager.getSessionId()]).toEqual([file, ID]);
	const listed = (await listSessions(dir.path(), new FileSessionStorage())).map(info => [info.path, info.id]);
	expect(listed).toEqual([[file, ID]]);
}

describe("a file-store session whose bytes are not all valid UTF-8 stays one session", () => {
	it("through an append and a whole rewrite, with an invalid byte in a message", async () => {
		using dir = TempDir.createSync("@omp-stored-size-");
		const { file, manager } = await open(dir, Buffer.concat([utf8(header), userLine("m1", null, "a", [0xff], "b")]));
		try {
			manager.appendMessage(userTurn("a second turn"));
			manager.appendMessage(createAssistantMessage("a reply"));
			await manager.flush();
			await manager.rewriteEntries();
			await manager.flush();
			await expectOneSession(dir, file, manager);
		} finally {
			await manager.close();
		}
	});

	it("through an append, with a character cut off at the end of the file", async () => {
		using dir = TempDir.createSync("@omp-stored-size-");
		// The last line stops after the first byte of a two-byte character (é is C3 A9), with no newline.
		const cut = userLine("m2", "m1", "caf", [0xc3]).subarray(0, -utf8(`","timestamp":1}}\n`).length);
		const { file, manager } = await open(dir, Buffer.concat([utf8(header), userLine("m1", null, "a turn"), cut]));
		try {
			manager.appendMessage(userTurn("a second turn"));
			manager.appendMessage(createAssistantMessage("a reply"));
			await manager.flush();
			await expectOneSession(dir, file, manager);
		} finally {
			await manager.close();
		}
	});

	it("through a whole rewrite after another writer appended a line with an invalid byte", async () => {
		using dir = TempDir.createSync("@omp-stored-size-");
		const { file, manager } = await open(dir, Buffer.concat([utf8(header), userLine("m1", null, "a turn")]));
		try {
			fs.appendFileSync(file, userLine("f1", "m1", "x", [0xff], "y"));
			await manager.rewriteEntries();
			await manager.flush();
			await expectOneSession(dir, file, manager);
			expect(manager.getEntries().map(entry => entry.id)).toContain("f1");
		} finally {
			await manager.close();
		}
	});
});
