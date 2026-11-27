/**
 * Memory startup collects the other sessions in the current session's
 * directory and later feeds each one's transcript (its "rollout") to stage 1.
 * Under `session.storage: sql` those transcripts are rows, not files: listing
 * the directory, reading each header, and reading the rollout's head and tail
 * must go through the current session's storage, or memories see no past
 * session.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildStage1RolloutItems, collectThreads } from "@oh-my-pi/pi-coding-agent/memories";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	defaultSessionStorage,
	FileSessionStorage,
	SessionReadConflictError,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { parseJsonlLenient, TempDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { MemoryBackend } from "../helpers/memory-session-backend";
import { raceAfterFirstChunk } from "../session/chunked-read-race";
import { LEASE_BACKENDS, openLeaseDb, STILL } from "../session/sql-session-lease-fixture";

const previous = defaultSessionStorage();
const clients: SQL[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
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

/** Sessions in a map, read only whole as an SDK backend without `readChunks` reads them. */
class WholeReadBackend extends MemoryBackend {
	override readSlices(): Promise<[string, string]> {
		return Promise.reject(new Error("stage 1 reads no slices"));
	}
	override move(): Promise<void> {
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
			backend.readFullPaths.length = 0;
			expect(await buildStage1RolloutItems(rollout, limit, storage)).toBe(referenceItems(raw, limit));
			expect({ limit, fullReads: backend.readFullPaths.length }).toEqual({ limit, fullReads: 1 });
		}
	});

	it("builds one body's stage-1 input when a full write replaces a chunked rollout between its two reads", async () => {
		// If this regresses, a memory extracted from a session another process rewrote between the
		// read of its records and the read of its messages applies the old transcript's records to the
		// new transcript's messages: the extraction model gets the output the new transcript's record elided.
		const client = new SQL("sqlite::memory:");
		clients.push(client);
		const storage = await SqlSessionStorage.create({ client });
		setDefaultSessionStorage(new FileSessionStorage());
		const rollout = "/sessions/project/rollout.jsonl";
		const result = (text: string) =>
			JSON.stringify({
				type: "message",
				id: "t1",
				message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
			});
		const elided = JSON.stringify({
			type: "custom",
			customType: "entry_patch",
			id: "p1",
			data: { patches: [{ entryId: "t1", message: { content: [{ type: "text", text: "elided" }] } }] },
		});
		const body = (...lines: string[]) =>
			`${['{"type":"session","id":"s"}', messageLine(0, "go"), ...lines].join("\n")}\n`;
		await storage.writeText(rollout, body(result("first output")));
		const readChunks = storage.readChunks.bind(storage);
		let reads = 0;
		spyOn(storage, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
			(async function* () {
				// The full write lands after the first read of the rollout ends, before the second starts.
				if (chunkPath === rollout && ++reads === 2) await storage.writeText(rollout, body(result("HEAVY"), elided));
				yield* readChunks(chunkPath, fromByte);
			})(),
		);

		const built = await buildStage1RolloutItems(rollout, 10_000_000, storage);

		expect({ raced: reads > 1, built }).toEqual({
			raced: true,
			built: referenceItems(body(result("elided")), 10_000_000),
		});
	});

	it("builds one file's stage-1 input when another file is renamed over the rollout between its record scan and its message reads", async () => {
		// If this regresses, a memory extracted from a session file another process replaced meanwhile
		// applies the old file's records to the new file's messages, and the extraction model gets the
		// output the new file's record elided.
		using tmp = TempDir.createSync("@omp-memories-storage-");
		setDefaultSessionStorage(new FileSessionStorage());
		const rollout = tmp.join("sessions", "project", "rollout.jsonl");
		const result = (id: string, text: string) =>
			JSON.stringify({
				type: "message",
				id,
				message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
			});
		const elide = (recordId: string, entryId: string) =>
			JSON.stringify({
				type: "custom",
				customType: "entry_patch",
				id: recordId,
				data: { patches: [{ entryId, message: { content: [{ type: "text", text: "elided" }] } }] },
			});
		const body = (...lines: string[]) =>
			`${['{"type":"session","id":"s"}', messageLine(0, "go"), ...lines].join("\n")}\n`;
		// The old file is the longer one, so a read sized by it takes all of the new one.
		const oldFile = body(result("t1", "o".repeat(4096)), elide("p1", "t1"));
		const newFile = body(result("t1", "fresh output"), result("t2", "HEAVY"), elide("p2", "t2"));
		const parse = utils.tryParseJson;
		let replaced = false;
		// The record scan parses the old file's record, then the new file is renamed over the rollout,
		// synchronously, before the scan goes on and before any message is read.
		spyOn(utils, "tryParseJson").mockImplementation((text: string) => {
			if (!replaced) {
				replaced = true;
				fs.writeFileSync(`${rollout}.new`, newFile);
				fs.renameSync(`${rollout}.new`, rollout);
			}
			return parse(text);
		});

		// The whole input from the front, and a budget whose tail is read from the back.
		for (const limit of [10_000_000, 20]) {
			await Bun.write(rollout, oldFile);
			replaced = false;

			const built = await buildStage1RolloutItems(rollout, limit, new FileSessionStorage());

			expect({ limit, replaced }).toEqual({ limit, replaced: true });
			expect([
				referenceItems(body(result("t1", "elided")), limit),
				referenceItems(body(result("t1", "fresh output"), result("t2", "elided")), limit),
			]).toContain(built);
		}
	});
});

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`memories over a SQL rollout another store rewrites (${adapter})`, () => {
		it("builds one body's stage-1 input, or fails as a read conflict, when the rollout is rewritten after its head was read", async () => {
			// If this regresses, a memory extracted from a SQL session another process rewrote meanwhile is
			// built from the first turns of the old transcript and the last turns of the new one.
			await using db = await openLeaseDb(adapter, url ?? "");
			const rollout = path.join(db.dir.path(), "sessions", "project", "rollout.jsonl");
			// About 4 MB of turns of 20,000 characters: the head and the tail budget each fit in one 1 MiB window.
			const body = (tag: string) =>
				`${['{"type":"session","id":"s"}', ...Array.from({ length: 100 }, (_, i) => messageLine(i, `${tag}${i}:${"é".repeat(20_000)}`))].join("\n")}\n`;
			const limit = 100_000;
			const holder = await db.open({ lease: STILL });
			await holder.writeText(rollout, body("a"));
			const reader = await db.open({ lease: STILL });
			const race = raceAfterFirstChunk(
				reader,
				rollout,
				() => holder.writeText(rollout, body("b")),
				// Past the head: the turns the input starts with are read by then.
				1024 * 1024,
			);

			let outcome: string;
			try {
				const built = await buildStage1RolloutItems(rollout, limit, reader);
				outcome =
					built === referenceItems(body("a"), limit)
						? "old body"
						: built === referenceItems(body("b"), limit)
							? "new body"
							: "a mix";
			} catch (err) {
				if (!(err instanceof SessionReadConflictError)) throw err;
				outcome = "read conflict";
			}

			expect(race.ran).toBe(true);
			expect(["old body", "new body", "read conflict"]).toContain(outcome);
		}, 120_000);
	});
}
