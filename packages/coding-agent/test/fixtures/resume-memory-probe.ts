/**
 * Child process for test/session/resume-memory-transcript-length.test.ts.
 *
 * `write <storage> <root> <turns>` stores a session under `<root>`: `<turns>` tool turns, each with a
 * {@link RESULT_BYTES}-byte tool result, then one compaction that keeps only the last of them, then
 * {@link TURNS_AFTER_CUT} more turns. Its live context is the same size whatever `<turns>` is. It prints
 * `{ "bytes": <transcript length> }`.
 *
 * `resume <storage> <root>` opens that session in this fresh process as a resume does, builds its model
 * context, and prints `{ "retained": <bytes>, "entries": <count> }`: the JS heap after full collections
 * with the opened manager still reachable, less the heap before the open.
 *
 * `<storage>` is `file` (file session storage) or `sqlite` (SQL session storage on a SQLite database).
 * Only APIs that sessions have had all along are used, so the probe runs on a build that holds every
 * entry too.
 */
import { heapStats } from "bun:jsc";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

/** Size of each tool result's text: large enough that the bodies, not the entries' small fields, dominate. */
const RESULT_BYTES = 256 * 1024;
/** Turns after the compaction: the live context, the same for every session the probe writes. */
const TURNS_AFTER_CUT = 3;
const TIMESTAMP = "2026-11-01T00:00:00.000Z";

const [mode, kind, root, turnsArg] = process.argv.slice(2);
if ((mode !== "write" && mode !== "resume") || (kind !== "file" && kind !== "sqlite") || !root) {
	throw new Error("usage: resume-memory-probe.ts write|resume file|sqlite <root> [turns]");
}

const sessionFile = path.join(root, "sessions", "session.jsonl");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

interface OpenedStorage {
	storage: SessionStorage;
	close(): Promise<void>;
}

async function openStorage(): Promise<OpenedStorage> {
	if (kind === "file") return { storage: new FileSessionStorage(), close: async () => {} };
	const client = new SQL(`sqlite://${path.join(root!, "sessions.db")}`);
	const storage = await SqlSessionStorage.create({ client });
	return {
		storage,
		close: async () => {
			await storage.drain();
			await client.close();
		},
	};
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The transcript's lines: header, `turns` turns, the compaction keeping only the last, and the turns after it. */
function transcriptLines(turns: number): string[] {
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "resume-memory",
			timestamp: TIMESTAMP,
			cwd: root,
		}),
	];
	let parentId: string | null = null;
	const add = (type: string, id: string, fields: object) => {
		lines.push(JSON.stringify({ type, id, parentId, timestamp: TIMESTAMP, ...fields }));
		parentId = id;
	};
	const turn = (label: string) => {
		add("message", `u${label}`, {
			message: { role: "user", content: [{ type: "text", text: `read file ${label}` }], timestamp: 1 },
		});
		add("message", `a${label}`, {
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call_${label}`, name: "read", arguments: { path: `src/${label}.ts` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
		});
		add("message", `r${label}`, {
			message: {
				role: "toolResult",
				toolCallId: `call_${label}`,
				toolName: "read",
				content: [{ type: "text", text: `${label} `.padEnd(RESULT_BYTES, "x") }],
				isError: false,
				timestamp: 3,
			},
		});
	};
	for (let index = 0; index < turns; index++) turn(`${index}`);
	add("compaction", "cut", {
		summary: "Read every file before this point.",
		firstKeptEntryId: `u${turns - 1}`,
		tokensBefore: 1000,
	});
	for (let index = 0; index < TURNS_AFTER_CUT; index++) turn(`after${index}`);
	return lines;
}

function collect(): number {
	Bun.gc(true);
	Bun.gc(true);
	return heapStats().heapSize;
}

const opened = await openStorage();
if (mode === "write") {
	const text = `${transcriptLines(Number(turnsArg)).join("\n")}\n`;
	await opened.storage.writeText(sessionFile, text);
	await opened.close();
	console.log(JSON.stringify({ bytes: Buffer.byteLength(text) }));
} else {
	const before = collect();
	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), opened.storage, {
		suppressBreadcrumb: true,
	});
	manager.buildSessionContext();
	const retained = collect() - before;
	console.log(JSON.stringify({ retained, entries: manager.getEntries().length }));
	await manager.close();
	await opened.close();
}
