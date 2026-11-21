/**
 * A resumed session keeps the bodies of the entries before the latest
 * compaction's cut out of memory also when the usual place for them under
 * `os.tmpdir()` cannot be used: a read-only temporary directory, or a
 * temporary directory set to a path under a regular file. The accessors still
 * return every entry exactly as a resume with a usable temporary directory
 * returns it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A heavy body: far larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(64 * 1024);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Turns (a user message and a reply each) before the compaction's cut. */
const TURNS_BEFORE_CUT = 6;
/** Root ignores directory permissions, so a read-only directory cannot be made for it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

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

/**
 * Heavy turns `u0`..`a5` before the cut of `c1`, which keeps `keep` on, and a
 * reply after the compaction; `beforeCut` names the entries before the cut.
 */
function compactedSession(): { entries: object[]; beforeCut: string[] } {
	const entries: object[] = [];
	const beforeCut: string[] = [];
	let parentId: string | null = null;
	for (let turn = 0; turn < TURNS_BEFORE_CUT; turn++) {
		for (const [id, message] of [
			[`u${turn}`, user(`u${turn} ${BODY}`)],
			[`a${turn}`, assistant(`a${turn} ${BODY}`)],
		] as const) {
			entries.push({ type: "message", id, parentId, timestamp: TIMESTAMP, message });
			beforeCut.push(id);
			parentId = id;
		}
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
		{ type: "message", id: "after", parentId: "c1", timestamp: TIMESTAMP, message: assistant(`after ${BODY}`) },
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

/** Resume `file` from file storage while `os.tmpdir()` answers `tmp`. */
function resumeWithTmpdir(file: string, tmp: string): Promise<SessionManager> {
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true });
}

/** Each entry the accessors return, as its id and the hash of its JSON text. */
function entryHashes(manager: SessionManager): string[] {
	return manager
		.getEntries()
		.map(entry => `${entry.id}:${crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`);
}

/** The entries of `ids` that `manager` holds whole in memory. */
function heldWhole(manager: SessionManager, ids: readonly string[]): string[] {
	return ids.filter(id => {
		const entry = manager.getEntry(id);
		return !entry || !isColdEntry(entry);
	});
}

/** What a resume with a usable temporary directory keeps whole and returns. */
async function usableResume(file: string, beforeCut: readonly string[]): Promise<string[]> {
	using usableTmp = TempDir.createSync("@omp-cold-unopenable-usable-");
	const manager = await resumeWithTmpdir(file, usableTmp.path());
	try {
		expect(heldWhole(manager, beforeCut)).toEqual([]);
		return entryHashes(manager);
	} finally {
		await manager.close();
		vi.restoreAllMocks();
	}
}

describe("a resume whose temporary directory cannot hold older entry bodies", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A host whose TMPDIR is read-only (a locked-down container) would otherwise hold every older
	// body of a long resumed session in memory, so the process grows with the transcript.
	it.skipIf(RUNS_AS_ROOT)(
		"keeps the bodies before the cut out of memory and returns every entry unchanged when os.tmpdir() is read-only",
		async () => {
			using dir = TempDir.createSync("@omp-cold-unopenable-");
			using readOnlyTmp = TempDir.createSync("@omp-cold-unopenable-tmp-");
			const { entries, beforeCut } = compactedSession();
			const file = await writeSession(dir.path(), entries);
			const expected = await usableResume(file, beforeCut);

			fs.chmodSync(readOnlyTmp.path(), 0o500);
			try {
				const manager = await resumeWithTmpdir(file, readOnlyTmp.path());
				try {
					expect(heldWhole(manager, beforeCut)).toEqual([]);
					expect(manager.coldStoreStats().coldEntries).toBe(beforeCut.length);
					expect(entryHashes(manager)).toEqual(expected);
				} finally {
					await manager.close();
				}
			} finally {
				fs.chmodSync(readOnlyTmp.path(), 0o700);
			}
		},
	);

	// A TMPDIR that names a path under a regular file (a stale or mistyped setting) would otherwise
	// hold every older body of a long resumed session in memory, so the process grows with the transcript.
	it("keeps the bodies before the cut out of memory and returns every entry unchanged when os.tmpdir() lies under a regular file", async () => {
		using dir = TempDir.createSync("@omp-cold-unopenable-");
		const { entries, beforeCut } = compactedSession();
		const file = await writeSession(dir.path(), entries);
		const expected = await usableResume(file, beforeCut);

		const blocker = path.join(dir.path(), "not-a-directory");
		fs.writeFileSync(blocker, "");
		const manager = await resumeWithTmpdir(file, path.join(blocker, "tmp"));
		try {
			expect(heldWhole(manager, beforeCut)).toEqual([]);
			expect(manager.coldStoreStats().coldEntries).toBe(beforeCut.length);
			expect(entryHashes(manager)).toEqual(expected);
		} finally {
			await manager.close();
		}
	});
});
