/**
 * What a resumed session keeps in memory. The model context starts at the
 * latest compaction's cut, so after a resume the large values (bodies) held in
 * memory are those of the entries from the cut on and those of the kinds that
 * features read from older entries; every older body is read back on access and
 * released once its reader drops it. Every accessor still returns every entry,
 * exactly as a manager holding every entry does.
 *
 * Only APIs that sessions have had all along are used here, so a build that
 * holds every body fails the release checks instead of skipping them.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { selectRpcEntries } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-compat";
import {
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

/** SQL session storage, which only some builds carry. */
interface SqlStorageModule {
	SqlSessionStorage: { create(options: { client: SQL }): Promise<SessionStorage> };
}
// Imported only where the module exists: a static import would fail to load
// this file in a build without SQL storage, whose cases skip instead.
const SQL_STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/sql-session-storage.ts");
const sqlStorageModule: SqlStorageModule | undefined = fs.existsSync(SQL_STORAGE_MODULE)
	? await import(SQL_STORAGE_MODULE)
	: undefined;

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** A value whose JSON text is longer than this is a body. */
const LARGE_JSON_BYTES = 4096;

/**
 * Kinds an entry before the cut keeps whole: extension and feature state and
 * the selections a resume restores. The newest `session_init` and the newest
 * `todo` result on the current path are kept too.
 */
const KINDS_KEPT_WHOLE: Record<string, true> = {
	custom: true,
	model_change: true,
	thinking_level_change: true,
	service_tier_change: true,
	mode_change: true,
	ttsr_injection: true,
	label: true,
	credential_pin: true,
	reset_boundary: true,
	model_usage: true,
	title_change: true,
};

function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

function usage() {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(label: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text: text(label) }], timestamp: 1 };
}

function assistantMessage(label: string, todoCallId?: string) {
	return {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text: text(label) },
			...(todoCallId
				? [{ type: "toolCall" as const, id: todoCallId, name: "todo", arguments: { op: "replace" } }]
				: []),
		],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(),
		stopReason: todoCallId ? ("toolUse" as const) : ("stop" as const),
		timestamp: 2,
	};
}

function paths(label: string): string[] {
	return Array.from({ length: 200 }, (_, index) => `src/${label}/module-${index}.ts`);
}

/**
 * Three compactions on the current path (`c1` keeps from `u2`, `c2` from `u4`,
 * `c3` from `u7`, the cut) and a second branch from `c2` (`b1` to `s1`), left
 * for `bs`, a branch summary on the current path. Before the cut lie bodies of
 * every kind: messages, a custom message, compactions, the branch summary, two
 * `session_init` entries (`s0` on the path, `s1` on the other branch), three
 * `todo` results (`t1` and `t3` on the path, `tb` on the other branch), and
 * entries of the kinds kept whole (`x1`, `md`, and small `m1`, `k1`, `l1`, `st`).
 */
function sessionEntries(): object[] {
	const entries: object[] = [];
	const add = (type: string, id: string, parentId: string | null, fields: object) => {
		entries.push({ type, id, parentId, timestamp: TIMESTAMP, ...fields });
	};
	const user = (id: string, parentId: string) => add("message", id, parentId, { message: userMessage(id) });
	const assistant = (id: string, parentId: string, todoCallId?: string) =>
		add("message", id, parentId, { message: assistantMessage(id, todoCallId) });
	const todoResult = (id: string, parentId: string, toolCallId: string) =>
		add("message", id, parentId, {
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content: [{ type: "text", text: text(id) }],
				details: {
					op: "replace",
					phases: [{ name: id, tasks: paths(id).map(content => ({ content, status: "pending" })) }],
				},
				isError: false,
				timestamp: 3,
			},
		});
	const compaction = (id: string, parentId: string, firstKeptEntryId: string) =>
		add("compaction", id, parentId, {
			summary: text(id),
			firstKeptEntryId,
			tokensBefore: 1000,
			details: { readFiles: paths(id), modifiedFiles: [] },
		});
	const sessionInit = (id: string, parentId: string | null) =>
		add("session_init", id, parentId, { systemPrompt: [text(id)], task: `task of ${id}`, tools: ["read", "todo"] });

	sessionInit("s0", null);
	user("u1", "s0");
	add("model_change", "m1", "u1", { model: "anthropic/claude-sonnet-4-5" });
	assistant("a1", "m1", "call_t1");
	todoResult("t1", "a1", "call_t1");
	add("custom", "x1", "t1", { customType: "test-ledger", data: { notes: paths("x1") } });
	user("u2", "x1");
	assistant("a2", "u2");
	compaction("c1", "a2", "u2");
	add("thinking_level_change", "k1", "c1", { thinkingLevel: "high" });
	user("u3", "k1");
	assistant("a3", "u3", "call_t3");
	todoResult("t3", "a3", "call_t3");
	add("mode_change", "md", "t3", { mode: "plan", data: { planFile: "plan.md", notes: paths("md") } });
	add("custom_message", "cm", "md", {
		customType: "test-note",
		content: [{ type: "text", text: text("cm") }],
		display: true,
	});
	user("u4", "cm");
	assistant("a4", "u4");
	compaction("c2", "a4", "u4");
	user("u5", "c2");
	assistant("a5", "u5");
	user("b1", "c2");
	assistant("b2", "b1", "call_tb");
	todoResult("tb", "b2", "call_tb");
	sessionInit("s1", "tb");
	add("branch_summary", "bs", "a5", { fromId: "s1", summary: text("bs"), details: { readFiles: paths("bs") } });
	add("label", "l1", "bs", { targetId: "u5", label: "checkpoint" });
	add("service_tier_change", "st", "l1", { serviceTier: null });
	user("u6", "st");
	assistant("a6", "u6");
	user("u7", "a6");
	assistant("a7", "u7");
	compaction("c3", "a7", "u7");
	user("u8", "c3");
	assistant("a8", "u8");
	return entries;
}

function transcript(cwd: string): string {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(cwd),
		timestamp: TIMESTAMP,
		cwd,
	};
	return [header, ...sessionEntries()].map(entry => `${JSON.stringify(entry)}\n`).join("");
}

interface StoredSession {
	file: string;
	storage: SessionStorage;
	close(): Promise<void>;
}

/** Where a test writes the transcript: file storage, and SQLite SQL storage where the build has it. */
const storages: Array<{ name: string; available: boolean; store(dir: string): Promise<StoredSession> }> = [
	{
		name: "file storage",
		available: true,
		async store(dir) {
			const file = path.join(dir, "sessions", "session.jsonl");
			await Bun.write(file, transcript(dir));
			return { file, storage: new FileSessionStorage(), close: async () => {} };
		},
	},
	{
		name: "SQLite SQL storage",
		available: sqlStorageModule !== undefined,
		async store(dir) {
			if (!sqlStorageModule) throw new Error("SQL session storage is not in this build");
			const client = new SQL(`sqlite://${path.join(dir, "sessions.db")}`);
			const storage = await sqlStorageModule.SqlSessionStorage.create({ client });
			const file = path.join(dir, "sessions", "session.jsonl");
			await storage.writeText(file, transcript(dir));
			await storage.drain();
			return { file, storage, close: () => client.close() };
		},
	},
];

function resume(session: StoredSession): Promise<SessionManager> {
	return SessionManager.open(session.file, path.dirname(session.file), session.storage, {
		suppressBreadcrumb: true,
	});
}

/** The same transcript in a manager that holds every entry: one in memory, given the loaded entries. */
async function holdingEveryEntry(session: StoredSession): Promise<SessionManager> {
	const [header, ...entries] = await loadEntriesFromFile(session.file, session.storage);
	const manager = SessionManager.inMemory(path.dirname(session.file));
	manager.restoreState({
		...manager.captureState(),
		header: header as SessionHeader,
		entries: entries as SessionEntry[],
	});
	return manager;
}

/** Whether `entry` records the to-do list: a `todo` result with phases. */
function isTodoListResult(entry: SessionEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
	const message = entry.message;
	if (message.toolName !== "todo" || message.isError) return false;
	const details: unknown = message.details;
	return typeof details === "object" && details !== null && "phases" in details;
}

/** Ids of the entries whose bodies must stay in memory: from the cut on, and those kept whole. */
function residentIds(manager: SessionManager): Set<string> {
	const entries = manager.getEntries();
	const branch = manager.getBranch();
	const compaction = branch.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
	const cut = compaction ? entries.findIndex(entry => entry.id === compaction.firstKeptEntryId) : 0;
	const resident = new Set<string>();
	for (const id of [
		branch.findLast(entry => entry.type === "session_init")?.id,
		branch.findLast(isTodoListResult)?.id,
	]) {
		if (id) resident.add(id);
	}
	entries.forEach((entry, index) => {
		if (index >= cut || KINDS_KEPT_WHOLE[entry.type]) resident.add(entry.id);
	});
	return resident;
}

/** Each body of `entry` and of its message: `[label, holder, field]`. */
function bodyFields(entry: SessionEntry): Array<[string, object, string]> {
	const holders: Array<[string, object]> = [[entry.id, entry]];
	if (entry.type === "message") holders.push([`${entry.id}.message`, entry.message]);
	const fields: Array<[string, object, string]> = [];
	for (const [label, holder] of holders) {
		for (const field of Object.keys(holder)) {
			if (holder === entry && field === "message") continue;
			const value: unknown = Reflect.get(holder, field);
			if (typeof value !== "object" || value === null) continue;
			if ((JSON.stringify(value)?.length ?? 0) > LARGE_JSON_BYTES) fields.push([`${label}.${field}`, holder, field]);
		}
	}
	return fields;
}

interface BodyRef {
	entryId: string;
	label: string;
	ref: WeakRef<object>;
}

interface BodyRefs {
	resident: BodyRef[];
	released: BodyRef[];
	/** Resident bodies a second read returned as another object. */
	notStable: string[];
}

/** Weak references to every body of `entries`, read through the accessors, split by `resident`. */
function refsToBodies(entries: readonly SessionEntry[], resident: ReadonlySet<string>): BodyRefs {
	const refs: BodyRefs = { resident: [], released: [], notStable: [] };
	for (const entry of entries) {
		for (const [label, holder, field] of bodyFields(entry)) {
			const value = Reflect.get(holder, field) as object;
			const bodyRef = { entryId: entry.id, label, ref: new WeakRef(value) };
			if (!resident.has(entry.id)) {
				refs.released.push(bodyRef);
				continue;
			}
			if (Reflect.get(holder, field) !== value) refs.notStable.push(label);
			refs.resident.push(bodyRef);
		}
	}
	return refs;
}

/**
 * Read every body of `entries` once more, in the same order, dropping each. A
 * store keeps the few records it read last for the next field read; reading
 * more entries than it keeps, in order, replaces every one of them.
 */
function readBodiesAgain(entries: readonly SessionEntry[]): number {
	let read = 0;
	for (const entry of entries) {
		for (const [, holder, field] of bodyFields(entry)) {
			if (Reflect.get(holder, field)) read++;
		}
	}
	return read;
}

/**
 * Full collections, each in a later task than the last read, until `done`
 * holds or `rounds` pass: a `WeakRef` keeps its target alive until the task
 * that made or read it ends, and `Bun.sleep(0)` ends the task without waiting
 * for a clock. The engine scans the stack conservatively, so a collection can
 * still find a stale copy of a pointer that the reads left there and keep a
 * released body; four rounds with no check between them failed under load. A
 * body something still holds survives every round.
 */
async function collectGarbage(done: () => boolean, rounds = 20): Promise<void> {
	for (let round = 0; round < rounds && !done(); round++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
	await Bun.sleep(0);
}

function alive(refs: readonly BodyRef[]): string[] {
	return refs.filter(({ ref }) => ref.deref() !== undefined).map(({ label }) => label);
}

/**
 * Check every body of `manager` once the test dropped what it read: released
 * bodies are collected, resident ones are the same object on two reads and
 * stay. Returns the entries whose bodies were released, in file order.
 */
async function expectOnlyResidentBodiesSurvive(manager: SessionManager): Promise<string[]> {
	const entries = manager.getEntries();
	const refs = refsToBodies(entries, residentIds(manager));
	expect(readBodiesAgain(entries)).toBeGreaterThan(0);
	await collectGarbage(() => alive(refs.released).length === 0);
	expect(refs.notStable).toEqual([]);
	expect({
		releasedAlive: alive(refs.released),
		residentGone: refs.resident.filter(({ ref }) => ref.deref() === undefined).map(({ label }) => label),
	}).toEqual({ releasedAlive: [], residentGone: [] });
	return [...new Set(refs.released.map(({ entryId }) => entryId))];
}

/** Entries before the cut `u7` that are not kept whole: every one holds a body. */
const RELEASED_AFTER_RESUME = [
	"u1",
	"a1",
	"t1",
	"u2",
	"a2",
	"c1",
	"u3",
	"a3",
	"cm",
	"u4",
	"a4",
	"c2",
	"u5",
	"a5",
	"b1",
	"b2",
	"tb",
	"s1",
	"bs",
	"u6",
	"a6",
];

/** The plain data an in-process caller reads. */
function plain<T>(value: T): T {
	return structuredClone(value);
}

/** What an RPC client receives. */
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function expectSameAnswers(manager: SessionManager, reference: SessionManager): void {
	const ids = reference.getEntries().map(entry => entry.id);
	expect(manager.getEntries().map(entry => entry.id)).toEqual(ids);
	expect(plain(manager.getEntries())).toEqual(plain(reference.getEntries()));
	expect(plain(manager.getBranch())).toEqual(plain(reference.getBranch()));
	expect(plain(manager.getBranch("s1"))).toEqual(plain(reference.getBranch("s1")));
	expect(plain([...manager.getBranchView()])).toEqual(plain([...reference.getBranchView()]));
	for (const id of ids) expect(plain(manager.getEntry(id))).toEqual(plain(reference.getEntry(id)));
	expect(plain(manager.getTree())).toEqual(plain(reference.getTree()));
	expect(manager.getLeafId()).toBe(reference.getLeafId());
	expect(wire(selectRpcEntries(manager.getEntries(), manager.getLeafId()))).toEqual(
		wire(selectRpcEntries(reference.getEntries(), reference.getLeafId())),
	);
	expect(wire({ tree: manager.getTree(), leafId: manager.getLeafId() })).toEqual(
		wire({ tree: reference.getTree(), leafId: reference.getLeafId() }),
	);
}

/**
 * Two more turns (`u9` to `a10`) and a compaction that keeps from `u10`, whose
 * context the session then rebuilds, as after any compaction.
 */
function compactAfterTwoTurns(manager: SessionManager): Map<string, string> {
	const ids = new Map<string, string>();
	ids.set(manager.appendMessage(userMessage("u9")), "u9");
	ids.set(manager.appendMessage(assistantMessage("a9")), "a9");
	const keptFrom = manager.appendMessage(userMessage("u10"));
	ids.set(keptFrom, "u10");
	ids.set(manager.appendMessage(assistantMessage("a10")), "a10");
	ids.set(
		manager.appendCompaction(text("c4"), undefined, keptFrom, 2000, { details: { readFiles: paths("c4") } }),
		"c4",
	);
	manager.buildSessionContext();
	return ids;
}

describe.each(storages)("a resumed session on $name", ({ available, store }) => {
	it.skipIf(!available)(
		"keeps in memory only the bodies from the cut on and of the kinds kept whole, reading older ones on access",
		async () => {
			using dir = TempDir.createSync("@omp-cold-resident-");
			const session = await store(dir.path());
			const manager = await resume(session);
			try {
				expect(await expectOnlyResidentBodiesSurvive(manager)).toEqual(RELEASED_AFTER_RESUME);
			} finally {
				await manager.close();
				await session.close();
			}
		},
	);

	it.skipIf(!available)(
		"releases the bodies between the old cut and the new one once a compaction moves the cut",
		async () => {
			using dir = TempDir.createSync("@omp-cold-resident-");
			const session = await store(dir.path());
			const manager = await resume(session);
			try {
				const entries = manager.getEntries();
				// What the entries from the old cut on held while the context kept them.
				const whole = refsToBodies(entries, new Set(entries.map(entry => entry.id))).resident.filter(
					({ entryId }) => ["u7", "a7", "c3", "u8", "a8"].includes(entryId),
				);
				expect(new Set(whole.map(({ entryId }) => entryId)).size).toBe(5);
				const appended = compactAfterTwoTurns(manager);

				const released = await expectOnlyResidentBodiesSurvive(manager);
				expect(released.map(id => appended.get(id) ?? id)).toEqual([
					...RELEASED_AFTER_RESUME,
					"u7",
					"a7",
					"c3",
					"u8",
					"a8",
					"u9",
					"a9",
				]);
				await collectGarbage(() => alive(whole).length === 0);
				expect(alive(whole)).toEqual([]);
			} finally {
				await manager.close();
				await session.close();
			}
		},
	);

	it.skipIf(!available)(
		"returns the same entries through every accessor and RPC answer as a manager holding every entry",
		async () => {
			using dir = TempDir.createSync("@omp-cold-resident-");
			const session = await store(dir.path());
			const manager = await resume(session);
			try {
				expectSameAnswers(manager, await holdingEveryEntry(session));

				compactAfterTwoTurns(manager);
				await manager.flush();
				expectSameAnswers(manager, await holdingEveryEntry(session));
			} finally {
				await manager.close();
				await session.close();
			}
		},
	);
});
