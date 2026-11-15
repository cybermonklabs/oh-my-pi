/**
 * A full rewrite that meets entries another writer appended to the session
 * file (one without the ownership lease: an older omp, an external tool) reads
 * the file back, keeps those entries and republishes. The read-back streams
 * the stored transcript (windows of at most 1 MiB on the synchronous path), so
 * these sessions span several windows, with a multibyte character across the
 * first window's edge, and must adopt exactly the entries a parse of the whole
 * file finds.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The most a synchronous read-back reads at once. */
const WINDOW_BYTES = 1024 * 1024;
/** Four UTF-8 bytes, so a window edge can fall inside it. */
const WIDE_CHARACTER = "😀";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** File storage that also reads byte ranges synchronously, recording each range it decoded. */
class RangeReadingStorage extends FileSessionStorage {
	readonly ranges: Array<{ bytes: number; text: string }> = [];

	readTextRangeSync(filePath: string, start: number, end: number): string {
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(Math.max(0, end - start));
			const read = fs.readSync(fd, buffer, 0, buffer.length, start);
			const text = buffer.toString("utf8", 0, read);
			this.ranges.push({ bytes: read, text });
			return text;
		} finally {
			fs.closeSync(fd);
		}
	}
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

/**
 * A titled session of four user turns of about 1.2 MB each, the first padded
 * so that the first read window ends inside a {@link WIDE_CHARACTER}.
 */
async function transcriptAcrossWindows(dir: string): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const slot = serializeTitleSlot({ title: "Long session", source: "user", updatedAt: TIMESTAMP });
	const header = `${JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	})}\n`;
	const run = WIDE_CHARACTER.repeat(300_000);
	const turnLine = (id: string, parentId: string | null, content: string) =>
		`${JSON.stringify({ type: "message", id, parentId, timestamp: TIMESTAMP, message: userTurn(content) })}\n`;
	// Bytes before the first turn's run of wide characters, without padding.
	const marked = turnLine("t0", null, "<run>");
	const runStart = Buffer.byteLength(slot + header + marked.slice(0, marked.indexOf("<run>")));
	const pad = "a".repeat((((WINDOW_BYTES - runStart - 2) % 4) + 4) % 4);
	const lines = [slot, header, turnLine("t0", null, pad + run)];
	for (let turn = 1; turn < 4; turn++) lines.push(turnLine(`t${turn}`, `t${turn - 1}`, `turn ${turn} ${run}`));
	await Bun.write(file, lines.join(""));
	return file;
}

function open(file: string, storage: FileSessionStorage): Promise<SessionManager> {
	return SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
}

describe("conflict recovery of a session file another writer appended to", () => {
	it.each([
		{
			path: "an atomic rewrite, reading the stored chunk stream",
			storage: () => new FileSessionStorage(),
			tornTail: false,
		},
		{
			path: "a synchronous rewrite, reading windows of the file",
			storage: () => new FileSessionStorage(),
			tornTail: true,
		},
		{
			path: "a synchronous rewrite, reading windows through readTextRangeSync",
			storage: () => new RangeReadingStorage(),
			tornTail: true,
		},
	])("adopts exactly the entries a whole parse of the file finds, after $path", async ({ storage, tornTail }) => {
		using dir = TempDir.createSync("@omp-conflict-recovery-");
		const file = await transcriptAcrossWindows(dir.path());
		// A torn line makes the next append replace the whole file synchronously.
		if (tornTail) fs.appendFileSync(file, '{"type":"message"\n');
		const ourStorage = storage();
		const ours = await open(file, ourStorage);
		const ourBranch = ours.getBranch().map(entry => entry.id);
		const ourIds = new Set(ours.getEntries().map(entry => entry.id));

		const theirs = await open(file, new FileSessionStorage());
		theirs.appendMessage(userTurn(`their turn ${WIDE_CHARACTER.repeat(1000)}`));
		theirs.appendMessage(userTurn("their second turn"));
		await theirs.close();
		const expected = (parseSessionContent(await Bun.file(file).text()).entries.slice(1) as SessionEntry[]).filter(
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

		const reopened = await open(file, new FileSessionStorage());
		expect(reopened.getEntries().filter(entry => expected.some(found => found.id === entry.id))).toHaveLength(
			expected.length,
		);
		await reopened.close();
		if (ourStorage instanceof RangeReadingStorage) {
			expect(ourStorage.ranges.length).toBeGreaterThan(1);
			expect(ourStorage.ranges.every(range => range.bytes <= WINDOW_BYTES)).toBe(true);
			// The first window ended inside a wide character, which the next window read whole.
			expect(ourStorage.ranges[0]!.text.endsWith("\uFFFD")).toBe(true);
		}
	});
});
