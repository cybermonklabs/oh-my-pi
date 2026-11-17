/**
 * What one cold entry keeps in memory. A cold message keeps as data only the
 * small values of the fields that readers walking the whole branch read on
 * every turn; its other fields (request controls, timings, tool details,
 * content) are read back from the store on access. A tool start marker before
 * the cut and every user's edit of the to-do list but the newest snapshot on
 * the path, wherever it lies, keep only their tree fields, `customType` and a
 * small `runtime`; the newest snapshot stays whole.
 * Every read still returns what the transcript holds, as a manager holding
 * every entry returns it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { selectRpcEntries } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-compat";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { CURRENT_SESSION_VERSION, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The message fields a cold message keeps as data while small: what the readers of every turn read. */
const READ_EVERY_TURN = [
	"role",
	"stopReason",
	"timestamp",
	"toolCallId",
	"toolName",
	"isError",
	"provider",
	"model",
	"api",
	"usage",
	"responseId",
	"customType",
	"display",
	"attribution",
	"errorMessage",
	"prunedAt",
	"useless",
];

/** The fields of a cold to-do edit or tool start marker that stay data, for one written without a `runtime`. */
const MARKER_FIELDS_IN_MEMORY = ["type", "id", "parentId", "timestamp", "customType"];

function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

function phases(label: string) {
	return [
		{
			name: `Phase ${label}`,
			tasks: Array.from({ length: 40 }, (_, index) => ({
				content: `${label} task ${index}: move module ${index} under src/tree`,
				status: index < 10 ? "completed" : "pending",
			})),
		},
	];
}

/** An assistant message with the fields a recent Anthropic reply records, each of them small but `content`. */
function assistantMessage(label: string, toolCall?: { id: string; name: string; arguments: object }) {
	return {
		role: "assistant",
		content: [{ type: "text", text: text(label) }, ...(toolCall ? [{ type: "toolCall", ...toolCall }] : [])],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 4,
			output: 182,
			cacheRead: 16780,
			cacheWrite: 24030,
			totalTokens: 40996,
			cost: { input: 0.00002, output: 0.00455, cacheRead: 0.00839, cacheWrite: 0.15019, total: 0.16315 },
		},
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: 2,
		requestControls: {
			messageIndex: 8,
			tools: { declared: ["read", "bash", "todo"], deferred: [], active: ["read", "bash", "todo"] },
			effort: { topLevel: "high", tail: "high" },
		},
		responseId: `msg_01${label}Fixture`,
		duration: 4163.076492,
		ttft: 2100.812789,
		completedAt: 1767225604163,
		contextSnapshot: { promptTokens: 40814, nonMessageTokens: 32441, toolSchemaTokens: 9132, compactionEpoch: 0 },
	};
}

/**
 * Three compactions: `c1` keeps from `u2`, `c2` from `u4`, `c3` from `u6` (the
 * cut). Before the cut lie an assistant turn `a1` that calls `read`, its
 * tool start marker `x1` and its result `r1` with small details, and two
 * to-do edits, `e1` and `e2`. From the cut on lie two more, `e3` and `e4`,
 * the newest snapshot on the path.
 */
function sessionLines(cwd: string): Array<Record<string, unknown>> {
	const lines: Array<Record<string, unknown>> = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: path.basename(cwd), timestamp: TIMESTAMP, cwd },
	];
	const add = (type: string, id: string, parentId: string | null, fields: object) =>
		lines.push({ type, id, parentId, timestamp: TIMESTAMP, ...fields });
	const user = (id: string, parentId: string) =>
		add("message", id, parentId, {
			message: { role: "user", content: [{ type: "text", text: text(id) }], attribution: "user", timestamp: 1 },
		});
	const assistant = (id: string, parentId: string, toolCall?: { id: string; name: string; arguments: object }) =>
		add("message", id, parentId, { message: assistantMessage(id, toolCall) });
	const compaction = (id: string, parentId: string, firstKeptEntryId: string) =>
		add("compaction", id, parentId, { summary: text(id), firstKeptEntryId, tokensBefore: 1000 });
	const todoEdit = (id: string, parentId: string) =>
		add("custom", id, parentId, { customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: phases(id) } });

	add("session_init", "s0", null, {
		systemPrompt: [text("system prompt")],
		task: "Refactor the module tree",
		tools: ["read", "todo"],
	});
	user("u1", "s0");
	assistant("a1", "u1", { id: "call_r1", name: "read", arguments: { path: "src/tree.ts" } });
	add("custom", "x1", "a1", {
		customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
		data: {
			toolCallId: "call_r1",
			toolName: "read",
			startedAt: TIMESTAMP,
			args: { path: "src/tree.ts" },
			intent: "Reading the module tree",
		},
	});
	add("message", "r1", "x1", {
		message: {
			role: "toolResult",
			toolCallId: "call_r1",
			toolName: "read",
			content: [{ type: "text", text: text("r1") }],
			details: { path: "src/tree.ts", lines: 120, truncated: false },
			isError: false,
			timestamp: 3,
		},
	});
	add("custom", "e1", "r1", {
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		data: { phases: [{ name: "First plan", tasks: [{ content: "Read the tree", status: "completed" }] }] },
	});
	user("u2", "e1");
	assistant("a2", "u2");
	compaction("c1", "a2", "u2");
	user("u3", "c1");
	assistant("a3", "u3");
	todoEdit("e2", "a3");
	user("u4", "e2");
	assistant("a4", "u4");
	compaction("c2", "a4", "u4");
	user("u5", "c2");
	assistant("a5", "u5");
	user("u6", "a5");
	todoEdit("e3", "u6");
	assistant("a6", "e3");
	compaction("c3", "a6", "u6");
	user("u7", "c3");
	todoEdit("e4", "u7");
	assistant("a7", "e4");
	return lines;
}

/** What a client receives. */
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** Own fields of `holder` that are data properties, in key order. */
function dataFields(holder: object): string[] {
	return Object.keys(holder).filter(key => "value" in (Object.getOwnPropertyDescriptor(holder, key) ?? {}));
}

/** Fields of cold entries that their records hold, by entry id, read back on access. */
const READ_BACK: Record<string, readonly string[]> = {
	a1: ["requestControls", "duration", "ttft", "completedAt", "contextSnapshot"],
	r1: ["details"],
};

/** The {@link READ_BACK} fields of each entry's message, through `entryOf`. */
function readBack(entryOf: (id: string) => unknown): unknown {
	const values: Record<string, Record<string, unknown>> = {};
	for (const [id, fields] of Object.entries(READ_BACK)) {
		const entry = entryOf(id);
		const message = typeof entry === "object" && entry !== null ? Reflect.get(entry, "message") : undefined;
		values[id] = Object.fromEntries(fields.map(field => [field, Reflect.get(message as object, field)]));
	}
	return wire(values);
}

/** {@link readBack} over each way a caller reads entries: by id, the entry list, the branch and an RPC answer. */
function readBackEveryWay(manager: SessionManager): unknown[] {
	const byId = (entries: readonly unknown[]) => (id: string) =>
		entries.find(entry => typeof entry === "object" && entry !== null && Reflect.get(entry, "id") === id);
	const rpc = wire(selectRpcEntries(manager.getEntries(), manager.getLeafId())) as { entries: unknown[] };
	return [
		readBack(id => manager.getEntry(id)),
		readBack(byId(manager.getEntries())),
		readBack(byId(manager.getBranch())),
		readBack(byId([...manager.getBranchView()])),
		readBack(byId(structuredClone(manager.getEntries()))),
		readBack(byId(rpc.entries)),
	];
}

describe("what a cold entry keeps in memory", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function written(): Promise<{ file: string; lines: Map<string, Record<string, unknown>> }> {
		const dir = TempDir.createSync("@omp-cold-allowlist-");
		cleanups.push(() => dir.removeSync());
		const lines = sessionLines(dir.path());
		const file = path.join(dir.path(), "sessions", "session.jsonl");
		await Bun.write(file, lines.map(line => `${JSON.stringify(line)}\n`).join(""));
		return { file, lines: new Map(lines.map(line => [String(line.id), line])) };
	}

	async function open(file: string, coldStore: boolean): Promise<SessionManager> {
		const manager = await SessionManager.open(file, path.dirname(file), new FileSessionStorage(), {
			suppressBreadcrumb: true,
			coldStore,
		});
		cleanups.push(() => manager.close());
		return manager;
	}

	it("keeps as data only the small fields every turn reads of a cold message, and of a tool start marker and every to-do edit but the newest snapshot only their tree fields, keeping the newest snapshot whole", async () => {
		// A cold message that kept every small value held ~71 properties and a dozen objects per reply,
		// and every to-do edit its whole list, so a long session's heap grew with its age.
		const { file, lines } = await written();
		const cold = await open(file, true);
		for (const id of ["u1", "a1", "r1"]) {
			const entry = cold.getEntry(id);
			if (entry?.type !== "message") throw new Error(`${id} is not a message`);
			const line = lines.get(id)?.message as Record<string, unknown>;
			expect(isColdEntry(entry)).toBe(true);
			expect(Object.keys(entry.message)).toEqual(Object.keys(line));
			expect(dataFields(entry.message)).toEqual(Object.keys(line).filter(field => READ_EVERY_TURN.includes(field)));
		}
		// `e3` lies from the cut on, where every other entry stays whole.
		for (const id of ["x1", "e1", "e2", "e3"]) {
			const entry = cold.getEntry(id);
			if (!entry) throw new Error(`${id} was not loaded`);
			expect(isColdEntry(entry)).toBe(true);
			expect(dataFields(entry)).toEqual(MARKER_FIELDS_IN_MEMORY);
			expect(wire(entry)).toEqual(lines.get(id));
		}
		const newest = cold.getEntry("e4");
		if (!newest) throw new Error("e4 was not loaded");
		expect(isColdEntry(newest)).toBe(false);
		expect(dataFields(newest)).toEqual([...MARKER_FIELDS_IN_MEMORY, "data"]);
	});

	it("keeps whole a to-do edit appended after a resume, sends the one before it to the store at the next recool and when a compaction moves the cut, and restores the list from the new one", async () => {
		// A recool that kept the previous snapshot whole would let a long session's edits pile up in memory;
		// one that sent the new snapshot to the store would read it back on every to-do restore.
		async function resumedWithNewEdit() {
			const { file } = await written();
			const cold = await open(file, true);
			const appended = cold.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phases("e5") });
			const coldness = () => ({
				previous: isColdEntry(cold.getEntry("e4") ?? {}),
				appended: isColdEntry(cold.getEntry(appended) ?? {}),
			});
			expect(coldness()).toEqual({ previous: false, appended: false });
			return { cold, coldness };
		}
		function expectListFromAppended(cold: SessionManager): void {
			const before = cold.coldStoreStats().materializations;
			expect(wire(getLatestTodoPhasesFromEntries(cold.getBranch()))).toEqual(wire(phases("e5")));
			expect(cold.coldStoreStats().materializations).toBe(before);
		}

		const recooled = await resumedWithNewEdit();
		recooled.cold.recoolEntries();
		expect(recooled.coldness()).toEqual({ previous: true, appended: false });
		expectListFromAppended(recooled.cold);

		// A fresh copy, never recooled: `c4` moves the cut from `u6` to `u7`, so `e4` still lies from the cut
		// on and only the context build after the compaction sends it to the store.
		const compacted = await resumedWithNewEdit();
		compacted.cold.appendCompaction(text("c4"), undefined, "u7", 2000);
		compacted.cold.buildSessionContext();
		expect(compacted.coldness()).toEqual({ previous: true, appended: false });
		expectListFromAppended(compacted.cold);
	});

	it("reads a cold message's other fields back from the store, through every accessor and RPC answer, as the transcript holds them and a manager holding every entry gives them", async () => {
		const { file, lines } = await written();
		const cold = await open(file, true);
		const whole = await open(file, false);
		const transcript = readBack(id => lines.get(id));

		const before = cold.coldStoreStats().materializations;
		const byId = readBack(id => cold.getEntry(id));
		// Each of the two entries' records is read back from the store once, then served from its cache.
		expect(cold.coldStoreStats().materializations).toBe(before + 2);
		expect(byId).toEqual(transcript);
		const fromCold = readBackEveryWay(cold);
		expect(whole.coldStoreStats().coldEntries).toBe(0);
		for (const values of fromCold) expect(values).toEqual(transcript);
		expect(fromCold).toEqual(readBackEveryWay(whole));
	});
});
