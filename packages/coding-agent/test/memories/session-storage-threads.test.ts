/**
 * Memory startup collects the other sessions in the current session's
 * directory and later feeds each one's transcript (its "rollout") to stage 1.
 * Under `session.storage: sql` those transcripts are rows, not files: listing
 * the directory, reading each header, and reading the rollout's head and tail
 * must go through the current session's storage, or memories see no past
 * session.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildStage1RolloutItems, collectThreads } from "@oh-my-pi/pi-coding-agent/memories";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { parseJsonlLenient, TempDir } from "@oh-my-pi/pi-utils";

const previous = defaultSessionStorage();
const clients: SQL[] = [];

afterEach(async () => {
	setDefaultSessionStorage(previous);
	for (const client of clients.splice(0)) await client.end();
});

const backends: Array<[string, () => Promise<SessionStorage>]> = [
	["file", async () => new FileSessionStorage()],
	[
		"sql",
		async () => {
			const client = new SQL("sqlite::memory:");
			clients.push(client);
			return SqlSessionStorage.create({ client });
		},
	],
];

function sessionIn(sessionDir: string, storage: SessionStorage): AgentSession {
	return { sessionManager: { getSessionDir: () => sessionDir, getStorage: () => storage } } as unknown as AgentSession;
}

/** The whole-transcript read + stringify + head/tail truncation stage 1 must reproduce. */
function referenceItems(raw: string, tokenLimit: number): string {
	const messages: unknown[] = [];
	for (const row of parseJsonlLenient<Record<string, unknown>>(raw)) {
		if (!row || typeof row !== "object" || row.type !== "message") continue;
		const message = row.message as { role?: string; toolName?: string; content?: unknown } | undefined;
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
			messages.push(message);
			continue;
		}
		if (role !== "toolResult" || !["bash", "eval", "read", "grep"].includes(message.toolName ?? "")) continue;
		const content = Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [];
		const text = content.map(item => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
		if (text.length > 0 && text.length <= 32_000) messages.push(message);
	}
	const text = JSON.stringify(messages);
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-(maxChars - head))}`;
}

function messageLine(index: number, body: string): string {
	const role = index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult";
	const message =
		role === "toolResult"
			? { role, toolName: "bash", content: [{ type: "text", text: body }] }
			: { role, content: [{ type: "text", text: body }] };
	return JSON.stringify({ type: "message", id: `m${index}`, message });
}

/** Sessions in a map, read only whole as Redis and SDK backends read them (no `readChunks`), counting the reads. */
class WholeReadBackend implements SessionStorageBackend {
	readonly sessions = new Map<string, string>();
	fullReads = 0;

	init(): Promise<void> {
		return Promise.resolve();
	}
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([]);
	}
	readFull(path: string): Promise<string | null> {
		this.fullReads++;
		return Promise.resolve(this.sessions.get(path) ?? null);
	}
	readSlices(): Promise<[string, string]> {
		return Promise.reject(new Error("stage 1 reads no slices"));
	}
	writeFull(path: string, content: string): Promise<void> {
		this.sessions.set(path, content);
		return Promise.resolve();
	}
	append(path: string, line: string): Promise<void> {
		this.sessions.set(path, (this.sessions.get(path) ?? "") + line);
		return Promise.resolve();
	}
	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}
	truncate(path: string): Promise<void> {
		this.sessions.set(path, "");
		return Promise.resolve();
	}
	remove(paths: string[]): Promise<void> {
		for (const path of paths) this.sessions.delete(path);
		return Promise.resolve();
	}
	move(): Promise<void> {
		return Promise.reject(new Error("stage 1 moves nothing"));
	}
}

describe("memories over the session storage", () => {
	it.each(backends)("collects the sibling sessions the %s storage holds", async (_name, open) => {
		using tmp = TempDir.createSync("@omp-memories-storage-");
		const storage = await open();
		// The process default stays file storage: memories read the session's.
		setDefaultSessionStorage(new FileSessionStorage());
		const sessionDir = tmp.join("sessions", "project");
		await storage.writeText(
			path.join(sessionDir, "a.jsonl"),
			'{"type":"session","id":"thread-a","cwd":"/work/a"}\n{"type":"message","id":"m1"}\n',
		);
		// Past the 64 KiB head window: the header comes from the head slice.
		const filler = `${JSON.stringify({ type: "message", id: "big", note: "é".repeat(40_000) })}\n`.repeat(3);
		await storage.writeText(
			path.join(sessionDir, "b.jsonl"),
			`{"type":"session","id":"thread-b","cwd":"/work/b"}\n${filler}`,
		);
		await storage.writeText(path.join(sessionDir, "current.jsonl"), '{"type":"session","id":"current"}\n');

		const threads = await collectThreads(sessionIn(sessionDir, storage), "current");

		expect(
			threads.map(thread => [thread.id, thread.cwd, thread.rolloutPath]).sort((x, y) => x[0].localeCompare(y[0])),
		).toEqual([
			["thread-a", "/work/a", path.join(sessionDir, "a.jsonl")],
			["thread-b", "/work/b", path.join(sessionDir, "b.jsonl")],
		]);
	});

	it.each(backends)("builds stage-1 input from a rollout the %s storage holds", async (_name, open) => {
		using tmp = TempDir.createSync("@omp-memories-storage-");
		const storage = await open();
		setDefaultSessionStorage(new FileSessionStorage());
		const lines = ['{"type":"session","id":"s"}', "not json"];
		let size = 0;
		// Over two 1 MiB windows, with multibyte text and one record wider than a window.
		for (let i = 0; size < 2_500_000; i++) {
			const line = messageLine(i, `${i}:${"é".repeat((i * 9973) % 20_000)}🚀`);
			lines.push(line);
			size += line.length + 1;
		}
		lines.splice(lines.length - 3, 0, messageLine(3, "y".repeat(1_200_000)));
		const raw = `${lines.join("\n")}\n`;
		const rollout = tmp.join("sessions", "project", "rollout.jsonl");
		await storage.writeText(rollout, raw);

		for (const limit of [1, 4000, 100_000, 10_000_000]) {
			expect(await buildStage1RolloutItems(rollout, limit, storage)).toBe(referenceItems(raw, limit));
		}
	});

	it("reads a rollout whole once, not once per window, from an indexed backend without chunked reads", async () => {
		const backend = new WholeReadBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const lines = ['{"type":"session","id":"s"}'];
		let size = 0;
		// Several 1 MiB windows from either end.
		for (let i = 0; size < 5_000_000; i++) {
			const line = messageLine(i, `${i}:${"é".repeat(20_000)}`);
			lines.push(line);
			size += line.length + 1;
		}
		const raw = `${lines.join("\n")}\n`;
		const rollout = "/sessions/project/rollout.jsonl";
		await storage.writeText(rollout, raw);

		for (const limit of [100_000, 10_000_000]) {
			backend.fullReads = 0;
			expect(await buildStage1RolloutItems(rollout, limit, storage)).toBe(referenceItems(raw, limit));
			expect({ limit, fullReads: backend.fullReads }).toEqual({ limit, fullReads: 1 });
		}
	});
});
