/**
 * Older bodies stay out of memory and the store holding them is released: a
 * move of the leaf, an idle check, the patch records a pass appends, a closed
 * manager, a leaf that moves back and forth, a session with no compaction, and
 * a full rewrite each keep what a session holds, on disk and in memory,
 * bounded by what it needs.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** A value whose JSON text is longer than this is a body. */
const LARGE_JSON_BYTES = 4096;
const HAS_PROC_FD = fs.existsSync("/proc/self/fd");
/** Patch records are appended by `SessionManager.patchEntries`, which a build without the patch-record change lacks. */
const HAS_PATCH_ENTRIES = "patchEntries" in SessionManager.prototype;
type PatchingSessionManager = SessionManager & { patchEntries(patches: object[]): Promise<void> };

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
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
}

function message(id: string, parentId: string | null, body: object): object {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message: body };
}

function compaction(id: string, parentId: string, firstKeptEntryId: string): object {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: TIMESTAMP,
		summary: `${id} ${BODY}`,
		firstKeptEntryId,
		tokensBefore: 1000,
		details: { notes: [`${id} ${BODY}`] },
	};
}

function header(dir: string): SessionHeader {
	return { type: "session", version: CURRENT_SESSION_VERSION, id: path.basename(dir), timestamp: TIMESTAMP, cwd: dir };
}

/** Write `lines` (entries, or JSON text) after a header; the session id is the directory's name. */
async function writeSession(dir: string, lines: Array<object | string>, name = "session.jsonl"): Promise<string> {
	const file = path.join(dir, name);
	const text = [header(dir), ...lines].map(line => (typeof line === "string" ? line : JSON.stringify(line)));
	await Bun.write(file, text.map(line => `${line}\n`).join(""));
	return file;
}

function open(file: string, sessionDir?: string): Promise<SessionManager> {
	return SessionManager.open(file, sessionDir, new FileSessionStorage(), { suppressBreadcrumb: true });
}

/**
 * `u1 a1` before any compaction, then four turns each closed by a compaction
 * that keeps that turn on (`c2` keeps `u2` … `c5` keeps `u5`, the cut), then
 * `u6 a6`, the leaf.
 */
function compactedFourTimes(): object[] {
	const entries: object[] = [message("u1", null, user(`u1 ${BODY}`)), message("a1", "u1", assistant(`a1 ${BODY}`))];
	let parentId = "a1";
	for (let turn = 2; turn <= 5; turn++) {
		entries.push(
			message(`u${turn}`, parentId, user(`u${turn} ${BODY}`)),
			message(`a${turn}`, `u${turn}`, assistant(`a${turn} ${BODY}`)),
			compaction(`c${turn}`, `a${turn}`, `u${turn}`),
		);
		parentId = `c${turn}`;
	}
	entries.push(message("u6", parentId, user(`u6 ${BODY}`)), message("a6", "u6", assistant(`a6 ${BODY}`)));
	return entries;
}

/** `u1 a1 u2`, `c1` keeping `u2` on, `a2 u3`, `c2` keeping `u3` on, `a3`: the cut is `u3`. */
function compactedTwice(): object[] {
	return [
		message("u1", null, user(`u1 ${BODY}`)),
		message("a1", "u1", assistant(`a1 ${BODY}`)),
		message("u2", "a1", user(`u2 ${BODY}`)),
		compaction("c1", "u2", "u2"),
		message("a2", "c1", assistant(`a2 ${BODY}`)),
		message("u3", "a2", user(`u3 ${BODY}`)),
		compaction("c2", "u3", "u3"),
		message("a3", "c2", assistant(`a3 ${BODY}`)),
	];
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
	label: string;
	ref: WeakRef<object>;
}

/** Weak references to every body of `entries`, read through the accessors. */
function refsToBodies(entries: readonly SessionEntry[]): BodyRef[] {
	const refs: BodyRef[] = [];
	for (const entry of entries) {
		for (const [label, holder, field] of bodyFields(entry)) {
			refs.push({ label, ref: new WeakRef(Reflect.get(holder, field) as object) });
		}
	}
	return refs;
}

/**
 * Read every body of `entries` once more, in order, dropping each: whatever a
 * reader keeps of the last few reads for the next one is replaced.
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
 * for a clock. The engine scans the stack conservatively, so one collection can
 * still find a stale pointer; a body something still holds survives every round.
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

function entriesById(manager: SessionManager, ids: readonly string[]): SessionEntry[] {
	return ids.map(id => {
		const found = manager.getEntry(id);
		if (!found) throw new Error(`missing entry ${id}`);
		return found;
	});
}

/** Descriptors of this process open on a file under `dir`. */
function descriptorsUnder(dir: string): string[] {
	const found: string[] = [];
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		try {
			const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
			if (target.startsWith(`${dir}${path.sep}`)) found.push(target);
		} catch {
			// Closed between the listing and the read.
		}
	}
	return found;
}

function isUnder(fd: number, dir: string): boolean {
	try {
		return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}${path.sep}`);
	} catch {
		return false;
	}
}

function requestedBytes(data: unknown, offset: unknown, length: unknown): number {
	if (typeof data === "string") return Buffer.byteLength(data);
	if (Array.isArray(data))
		return data.reduce((sum: number, item) => sum + requestedBytes(item, undefined, undefined), 0);
	if (ArrayBuffer.isView(data)) {
		if (typeof length === "number") return length;
		return data.byteLength - (typeof offset === "number" ? offset : 0);
	}
	return 0;
}

/** Count the bytes written to files under `dir`; every write goes through. */
function countWritesUnder(dir: string): { written: () => number } {
	let written = 0;
	const writeSync = fs.writeSync;
	vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
		if (isUnder(fd, dir)) written += requestedBytes(data, rest[0], rest[1]);
		return Reflect.apply(writeSync, fs, [fd, data, ...rest]) as number;
	}) as typeof fs.writeSync);
	if (typeof fs.writevSync === "function") {
		const writevSync = fs.writevSync;
		vi.spyOn(fs, "writevSync").mockImplementation(((fd: number, buffers: unknown, ...rest: unknown[]) => {
			if (isUnder(fd, dir)) written += requestedBytes(buffers, undefined, undefined);
			return Reflect.apply(writevSync, fs, [fd, buffers, ...rest]) as number;
		}) as typeof fs.writevSync);
	}
	return { written: () => written };
}

/** Run `run` with the agent directory (and so the blob store) in a scratch directory. */
async function withScratchAgentDir(run: () => Promise<void>): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = TempDir.createSync("@omp-cold-lifetime-agent-");
	setAgentDir(agentDir.path());
	try {
		await run();
	} finally {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		agentDir.removeSync();
	}
}

describe("older bodies stay out of memory and the store is released", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	// /tree to the first turns of a long session must not bring the whole history back into memory.
	it("keeps the bodies before the cut that leave the path cold after a move to an entry before the first compaction", async () => {
		using dir = TempDir.createSync("@omp-cold-lifetime-");
		const manager = await open(await writeSession(dir.path(), compactedFourTimes()));
		cleanups.push(() => manager.close());

		manager.branch("a1");
		const roles = manager.buildSessionContext().messages.map(found => found.role);
		expect(roles).toEqual(["user", "assistant"]);

		const offPath = entriesById(manager, ["u2", "a2", "c2", "u3", "a3", "c3", "u4", "a4", "c4"]);
		const refs = refsToBodies(offPath);
		expect(refs.length).toBe(offPath.length);
		expect(readBodiesAgain(manager.getEntries())).toBeGreaterThan(0);
		await collectGarbage(() => alive(refs).length === 0);
		expect(alive(refs)).toEqual([]);
	});

	// The TUI's retry hint and the thread publisher read this on every idle state; it must cost no older body.
	it("answers the retry-hint check of an idle resumed session without reading an older body", async () => {
		using root = TempDir.createSync("@omp-cold-lifetime-");
		const cwd = path.join(root.path(), "project");
		const sessionDir = path.join(root.path(), "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		const lines: object[] = [];
		let parentId: string | null = null;
		const turns = 40;
		for (let index = 0; index < turns; index++) {
			lines.push(message(`a${index}`, parentId, assistant(`a${index} ${BODY}`)));
			parentId = `a${index}`;
		}
		lines.push(message("keep", parentId, user(`keep ${BODY}`)), compaction("c1", "keep", "keep"));
		// The previous process stopped before the model answered this prompt.
		lines.push(message("pending", "c1", user("a prompt the model has not answered yet")));
		const id = crypto.randomUUID();
		const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		await Bun.write(file, [{ ...header(cwd), id }, ...lines].map(line => `${JSON.stringify(line)}\n`).join(""));
		const manager = await open(file, sessionDir);
		cleanups.push(() => manager.close());

		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({ responses: [] });
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});
		cleanups.push(() => session.dispose());

		const before = manager.coldStoreStats().materializations;
		expect(session.hasAbortedToolCallTail).toBe(false);
		expect(session.hasAbortedToolCallTail).toBe(false);
		expect(manager.coldStoreStats().materializations).toBe(before);
	});

	// Each elide pass appends a patch record; a resume must not hold every patched body again in those records.
	it.skipIf(!HAS_PATCH_ENTRIES)(
		"keeps no patched body in memory through the patch records an elide pass appended before the cut",
		async () => {
			await withScratchAgentDir(async () => {
				using dir = TempDir.createSync("@omp-cold-lifetime-");
				const file = await writeSession(dir.path(), [message("u0", null, user("start"))]);
				const writer = (await open(file)) as PatchingSessionManager;
				const patched = new Map<string, Array<TextContent | ImageContent>>();
				const rest = "r".repeat(16_000);
				for (let index = 0; index < 12; index++) {
					const id = writer.appendMessage(assistant(`a${index} ${rest} ${rest}`));
					const content: TextContent[] = [{ type: "text", text: `a${index} [elided] ${rest}` }];
					await writer.patchEntries([{ entryId: id, message: { content, elidedOutputTokens: 5 } }]);
					patched.set(id, content);
				}
				for (let index = 0; index < 4; index++) {
					const image: ImageContent = {
						type: "image",
						data: Buffer.alloc(6000, index + 1).toString("base64"),
						mimeType: "image/png",
					};
					const id = writer.appendMessage({
						role: "toolResult",
						toolCallId: `call-${index}`,
						toolName: "read",
						content: [{ type: "text", text: `t${index} ${rest}` }, image],
						isError: false,
						timestamp: 3,
					});
					// What elide keeps of a tool result: the placeholder and every non-text block.
					const content = [{ type: "text" as const, text: `[elided t${index}]` }, { ...image }];
					await writer.patchEntries([{ entryId: id, message: { content, prunedAt: 4 } }]);
					patched.set(id, content);
				}
				const keep = writer.appendMessage(user(`keep ${BODY}`));
				writer.appendCompaction(`summary ${BODY}`, undefined, keep, 1000);
				writer.appendMessage(assistant(`after ${BODY}`));
				await writer.flush();
				await writer.close();

				// Closed here, before the scratch agent directory (and its blob store) goes away.
				const manager = await open(file);
				try {
					for (const [id, content] of patched) {
						const target = manager.getEntry(id);
						expect(
							target?.type === "message" ? JSON.parse(JSON.stringify(target.message)).content : undefined,
						).toEqual(content);
					}
					const entries = manager.getEntries();
					const cut = entries.findIndex(found => found.id === keep);
					const refs = refsToBodies(entries.slice(0, cut));
					expect(refs.length).toBeGreaterThanOrEqual(2 * patched.size);
					expect(readBodiesAgain(entries)).toBeGreaterThan(0);
					await collectGarbage(() => alive(refs).length === 0);
					expect(alive(refs)).toEqual([]);
				} finally {
					await manager.close();
				}
			});
		},
	);

	// A host that opens and closes many sessions (a subagent pool) must not run out of descriptors or disk.
	it.skipIf(!HAS_PROC_FD)(
		"releases the descriptors it holds under os.tmpdir() when the manager is closed",
		async () => {
			using dir = TempDir.createSync("@omp-cold-lifetime-");
			using tmp = TempDir.createSync("@omp-cold-lifetime-tmp-");
			const file = await writeSession(dir.path(), compactedTwice());
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());

			const manager = await open(file);
			const older = manager.getEntry("a1");
			expect(older?.type === "message" ? older.message : undefined).toEqual(assistant(`a1 ${BODY}`));
			await manager.close();
			expect(descriptorsUnder(tmp.path())).toEqual([]);
		},
	);

	// Switching back and forth in /tree must not grow the disk a session uses with every switch.
	it("keeps the store bounded while the leaf moves back and forth across the cut", async () => {
		using dir = TempDir.createSync("@omp-cold-lifetime-");
		const manager = await open(await writeSession(dir.path(), compactedTwice()));
		cleanups.push(() => manager.close());
		const roundTrip = () => {
			manager.branch("a1");
			manager.buildSessionContext();
			manager.branch("a3");
			manager.buildSessionContext();
		};

		roundTrip();
		const afterOne = manager.coldStoreStats().storeBytes;
		for (let round = 1; round < 50; round++) roundTrip();
		expect(manager.coldStoreStats().storeBytes).toBeLessThanOrEqual(2 * afterOne);
	});

	// A session that never compacted has nothing before a cut; its resume needs no store.
	it.skipIf(!HAS_PROC_FD)(
		"writes nothing under os.tmpdir() when it resumes a session with no compaction",
		async () => {
			using dir = TempDir.createSync("@omp-cold-lifetime-");
			using tmp = TempDir.createSync("@omp-cold-lifetime-tmp-");
			const lines: object[] = [];
			let parentId: string | null = null;
			const turns = 400;
			for (let index = 0; index < turns; index++) {
				lines.push(message(`a${index}`, parentId, assistant(`a${index} ${BODY}${BODY}`)));
				parentId = `a${index}`;
			}
			const file = await writeSession(dir.path(), lines);
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
			const disk = countWritesUnder(tmp.path());

			const manager = await open(file);
			cleanups.push(() => manager.close());
			expect(manager.getEntries()).toHaveLength(turns);
			expect(disk.written()).toBe(0);
		},
	);

	// A field the file holds must come back from a full rewrite, whatever its name.
	it("keeps a field named __proto__ of an entry and of its message before the cut through a full rewrite", async () => {
		using dir = TempDir.createSync("@omp-cold-lifetime-");
		const odd = `{"type":"message","id":"o1","parentId":"u1","timestamp":"${TIMESTAMP}","__proto__":{"marker":"entry"},"message":{"role":"user","content":"o1 ${BODY}","__proto__":{"marker":"message"},"timestamp":1}}`;
		const file = await writeSession(dir.path(), [
			message("u1", null, user(`u1 ${BODY}`)),
			odd,
			message("u2", "o1", user(`u2 ${BODY}`)),
			compaction("c1", "u2", "u2"),
			message("a2", "c1", assistant(`a2 ${BODY}`)),
		]);
		const manager = await open(file);
		await manager.rewriteEntries();
		await manager.close();

		const line = (await Bun.file(file).text()).split("\n").find(text => text.includes('"id":"o1"'));
		if (!line) throw new Error("o1 is missing from the rewritten file");
		const written = JSON.parse(line) as Record<string, unknown>;
		expect(Object.getOwnPropertyDescriptor(written, "__proto__")?.value).toEqual({ marker: "entry" });
		const writtenMessage = written.message as Record<string, unknown>;
		expect(Object.getOwnPropertyDescriptor(writtenMessage, "__proto__")?.value).toEqual({ marker: "message" });
	});
});
