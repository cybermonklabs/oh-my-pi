import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as coldEntries from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { sanitizeRehydratedOpenAIResponsesAssistantMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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
		...overrides,
	};
}

/** A GitHub Copilot Responses turn carrying the native replay payload a resume strips. */
function copilotTurn(text: string): AssistantMessage {
	return assistant(text, {
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: `item-${text.slice(0, 8)}` }] },
	});
}

/**
 * `u1` and `a1` lie before the cut of `c1`, which keeps `u2` on; `a2` follows
 * the compaction. The session id is the directory's name.
 */
async function writeSession(dir: string, first: AssistantMessage, second: AssistantMessage): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	const entries = [
		header,
		{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user(`u1 ${BODY}`) },
		{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: first },
		{ type: "message", id: "u2", parentId: "a1", timestamp: TIMESTAMP, message: user(`u2 ${BODY}`) },
		{
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp: TIMESTAMP,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "u2",
			tokensBefore: 1000,
		},
		{ type: "message", id: "a2", parentId: "c1", timestamp: TIMESTAMP, message: second },
	];
	await Bun.write(file, entries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

/**
 * Open `file` with the store on while `pass` writes the loaded entries the way a
 * load-time record pass does: after the stream, through the entries' own
 * fields.
 */
async function openWithPass(file: string, pass: (byId: Map<string, SessionEntry>) => void): Promise<SessionManager> {
	const coldBoundary = coldEntries.coldBoundary;
	let passed = false;
	vi.spyOn(coldEntries, "coldBoundary").mockImplementation((entries, branch, model) => {
		const boundary = coldBoundary(entries, branch, model);
		if (!passed) {
			passed = true;
			pass(new Map(entries.map(entry => [entry.id, entry])));
		}
		return boundary;
	});
	try {
		return await SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true });
	} finally {
		vi.restoreAllMocks();
	}
}

function assistantOf(manager: SessionManager, id: string): AssistantMessage {
	const found = manager.getEntry(id);
	if (found?.type !== "message" || found.message.role !== "assistant")
		throw new Error(`${id} is not an assistant turn`);
	return found.message;
}

function textOf(manager: SessionManager, id: string): string {
	const found = manager.getEntry(id);
	if (found?.type !== "message") throw new Error(`${id} is not a message`);
	const { message } = found;
	if (message.role !== "user" && message.role !== "assistant") throw new Error(`${id} has no text`);
	const { content } = message;
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" ? block.text : "")).join("");
}

describe("cold entries after load-time passes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("puts entries before the cut that a pass wrote back in the store, holding the written values", async () => {
		using dir = TempDir.createSync("@omp-cold-load-");
		const file = await writeSession(dir.path(), assistant(`a1 ${BODY}`), assistant(`a2 ${BODY}`));
		const manager = await openWithPass(file, byId => {
			const u1 = byId.get("u1");
			const a1 = byId.get("a1");
			if (u1?.type !== "message" || u1.message.role !== "user") throw new Error("u1 missing");
			if (a1?.type !== "message" || a1.message.role !== "assistant") throw new Error("a1 missing");
			// A pass on a cold target writes through the accessor, which makes the entry whole.
			u1.message.content = `patched u1 ${BODY}`;
			a1.message.content = [{ type: "text", text: `patched a1 ${BODY}` }];
		});

		const stats = manager.coldStoreStats();
		expect(stats.coldEntries).toBe(2);
		expect(stats.materializations).toBe(0);
		expect(textOf(manager, "u1")).toBe(`patched u1 ${BODY}`);
		expect(textOf(manager, "a1")).toBe(`patched a1 ${BODY}`);
		expect(manager.coldStoreStats().materializations).toBe(2);
	});

	it("strips replay metadata from what the passes left, as sanitizing the whole loaded transcript does", async () => {
		using dir = TempDir.createSync("@omp-cold-load-");
		const signed = (id: string): AssistantMessage["content"] => [
			{ type: "thinking", thinking: `${id} ${BODY}`, thinkingSignature: `${id}-signature` },
			{ type: "text", text: `${id} text` },
		];
		const file = await writeSession(
			dir.path(),
			{ ...copilotTurn(`a1 ${BODY}`), content: signed("a1") },
			copilotTurn(`a2 ${BODY}`),
		);
		// The pass gives the hot a2 signed content; the cold a1 keeps the metadata it was stored with.
		const pass = (byId: Map<string, SessionEntry>) => {
			const found = byId.get("a2");
			if (found?.type !== "message" || found.message.role !== "assistant") throw new Error("a2 missing");
			found.message.content = signed("a2");
		};
		const manager = await openWithPass(file, pass);

		// The release's order: parse every entry, run the passes, then sanitize.
		const parsed = new Map<string, SessionEntry>();
		for (const line of (await Bun.file(file).text()).split("\n")) {
			if (!line) continue;
			const value = JSON.parse(line) as SessionEntry | SessionHeader;
			if (value.type !== "session") parsed.set(value.id, value);
		}
		pass(parsed);
		for (const id of ["a1", "a2"]) {
			const found = parsed.get(id);
			if (found?.type !== "message" || found.message.role !== "assistant") throw new Error(`${id} missing`);
			const expected = sanitizeRehydratedOpenAIResponsesAssistantMessage(found.message);
			expect(expected.providerPayload).toBeUndefined();
			expect(JSON.parse(JSON.stringify(assistantOf(manager, id)))).toEqual(JSON.parse(JSON.stringify(expected)));
		}
		// The stripped metadata marks the transcript for a rewrite; a1 is back in the store.
		expect(manager.bodyRevision).toBe(1);
		expect(manager.coldStoreStats().coldEntries).toBe(2);
	});
});
