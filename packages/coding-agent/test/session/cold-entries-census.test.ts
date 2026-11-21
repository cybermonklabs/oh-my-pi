/**
 * Census of the records that hold a copy of another entry's body: a
 * `session_exit` record (the arguments of the tool calls pending at an exit),
 * the revisions of the context notebook, the to-do HUD choices (the list's
 * JSON text), the mode changes a goal records every turn (the goal's
 * objective) and the stale snapcompact compaction a frame rescue replaces
 * (its archive text). Each one no context build reads goes to the cold store,
 * before the cut and from the cut on, so no record kept whole holds a copy of
 * a cold body; the ones a build or a resume reads stay whole.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

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

/** `entries` chained in order, each the child of the one before. */
function chain(entries: Array<Record<string, unknown> & { id: string }>): object[] {
	return entries.map((entry, index) => ({
		...entry,
		parentId: index === 0 ? null : entries[index - 1]!.id,
		timestamp: TIMESTAMP,
	}));
}

function custom(id: string, customType: string, data: object) {
	return { type: "custom", id, customType, data };
}

function notes(id: string) {
	return custom(id, "experimental_context_notes", { version: 1, text: `${id} ${BODY}` });
}

function hudChoice(id: string) {
	return custom(id, "todo_hud_state", { sourceEntryId: "a0", fingerprint: `${id} ${BODY}`, visibility: "dismissed" });
}

function sessionExit(id: string) {
	return custom(id, "session_exit", {
		reason: "SIGTERM",
		kind: "signal",
		recordedAt: TIMESTAMP,
		pendingToolCalls: [{ id: `call-${id}`, name: "write", args: { content: `${id} ${BODY}` } }],
	});
}

function goalSnapshot(id: string) {
	return { type: "mode_change", id, mode: "goal", data: { goal: { objective: `${id} ${BODY}`, status: "active" } } };
}

function snapcompact(id: string, extra: object) {
	return {
		type: "compaction",
		id,
		summary: `${id} summary`,
		firstKeptEntryId: "keep",
		tokensBefore: 1000,
		method: "snapcompact",
		...extra,
	};
}

/**
 * Before the cut at `keep`: the start, older notes `n1` and the newest `n2`, a
 * HUD choice, an exit record and a goal snapshot. From the cut on: the stale
 * snapcompact compaction `stale` and its rescue `rescue` (same kept entry and
 * size), two goal snapshots and the newest HUD choice, a reply and an exit.
 */
function censusSession(): object[] {
	return chain([
		{ type: "message", id: "u0", message: { role: "user", content: `u0 ${BODY}`, timestamp: 1 } },
		{ type: "message", id: "a0", message: assistant(`a0 ${BODY}`) },
		notes("n1"),
		hudChoice("h1"),
		sessionExit("s1"),
		goalSnapshot("m1"),
		notes("n2"),
		{ type: "message", id: "keep", message: { role: "user", content: `keep ${BODY}`, timestamp: 1 } },
		snapcompact("stale", { preserveData: { snapcompact: { text: `archive ${BODY}`, frames: [] } } }),
		snapcompact("rescue", {}),
		goalSnapshot("m3"),
		hudChoice("h2"),
		goalSnapshot("m4"),
		{ type: "message", id: "a1", message: assistant(`a1 ${BODY}`) },
		sessionExit("s2"),
	]);
}

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

function open(file: string): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true });
}

/** The ids of `manager`'s entries, split by whether they are cold. */
function census(manager: SessionManager): { cold: string[]; whole: string[] } {
	const entries = manager.getEntries();
	return {
		cold: entries.filter(entry => isColdEntry(entry)).map(entry => entry.id),
		whole: entries.filter(entry => !isColdEntry(entry)).map(entry => entry.id),
	};
}

describe("records that copy another entry's body", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	// A long /goal session (a snapshot per turn), a notebook saved many times or many HUD toggles
	// would otherwise keep every copy whole for the rest of the session, while the bodies they copy
	// are out of memory.
	it("sends every copy no build reads to the store, live and after a resume, and builds from the ones it reads", async () => {
		using dir = TempDir.createSync("@omp-cold-census-");
		const file = await writeSession(dir.path(), censusSession());
		const expected = {
			cold: ["u0", "a0", "n1", "h1", "s1", "m1", "stale", "m3", "s2"],
			whole: ["n2", "keep", "rescue", "h2", "m4", "a1"],
		};

		const resumed = await open(file);
		cleanups.push(() => resumed.close());
		expect(census(resumed)).toEqual(expected);
		const readsBefore = resumed.coldStoreStats().materializations;
		const context = resumed.buildSessionContext();
		// Built from the newest notebook revision and the newest goal snapshot, reading no cold record.
		expect(context.mode).toBe("goal");
		expect(JSON.stringify(context.modeData)).toContain("m4 ");
		expect(JSON.stringify(context.messages)).toContain("n2 ");
		expect(resumed.coldStoreStats().materializations).toBe(readsBefore);
		expect(census(resumed)).toEqual(expected);

		// Live: a new goal snapshot and HUD choice supersede the newest, which go to the store at the next cut.
		resumed.appendModeChange("goal", { goal: { objective: `m5 ${BODY}`, status: "active" } });
		resumed.appendCustomEntry("todo_hud_state", {
			sourceEntryId: "a0",
			fingerprint: `h3 ${BODY}`,
			visibility: "revealed",
		});
		resumed.recoolEntries();
		const live = census(resumed);
		expect(live.cold).toEqual(expect.arrayContaining(["m4", "h2"]));
		expect(resumed.buildSessionContext().modeData).toMatchObject({ goal: { status: "active" } });
		expect(JSON.stringify(resumed.buildSessionContext().modeData)).toContain("m5 ");
	});
});
