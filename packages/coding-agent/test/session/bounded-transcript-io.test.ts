/**
 * No read or write of a running session builds its whole transcript as one
 * value. Each case drives one whole read or full write a running session
 * reaches, on a transcript of at least 64 MiB, while a storage that records
 * the longest string or buffer handed to or returned by it, and spies on
 * `JSON.parse` and `Bun.JSONL.parseChunk` that record the longest text parsed,
 * watch; none may exceed 16 MiB. Full writes that remain name why in their case.
 *
 * SQL storage cases run where `IndexedSessionStorage` reads in chunks; without
 * that capability its reads are whole by design, and the cases skip.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveResumableSession, resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorage,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";

/** A value longer than this means a transcript was read, written or parsed whole. */
const WHOLE_VALUE_LIMIT = 16 * 1024 * 1024;
const TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Each case writes and reads tens of MiB: well past the default per-test limit on a busy machine. */
const CASE_TIMEOUT_MS = 120_000;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const FILLER = "the session keeps working through the module tree ".repeat(640);
const FENCE = `\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(200)}\`\`\``;
/** The custom entry type of an appended patch record, where the build has them. */
const ENTRY_PATCH_TYPE = "entry_patch";
const hasEntryPatchRecords = fs.existsSync(path.join(import.meta.dir, "../../src/session/entry-patches.ts"));
const indexedStorageReadsChunks = typeof (IndexedSessionStorage.prototype as SessionStorage).readChunks === "function";
const POSTGRES_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;

/** The longest value each watched entry point handled. */
class ValueWatch {
	readonly #longest = new Map<string, number>();

	note(label: string, size: number): void {
		if (size > (this.#longest.get(label) ?? 0)) this.#longest.set(label, size);
	}

	noteValue(label: string, value: unknown): void {
		if (typeof value === "string") this.note(label, value.length);
		else if (value instanceof Uint8Array) this.note(label, value.byteLength);
	}

	/** The entry points that handled a value over {@link WHOLE_VALUE_LIMIT}, with their longest. */
	oversized(): Record<string, number> {
		return Object.fromEntries([...this.#longest].filter(([, size]) => size > WHOLE_VALUE_LIMIT));
	}

	get watched(): number {
		return this.#longest.size;
	}
}

/**
 * File storage recording what it hands out and takes in. It does not override
 * `writeTextSync` or `writeTextAtomic`: the base class joins the lines of a
 * full write and routes them through an override of those.
 */
class RecordingFileStorage extends FileSessionStorage {
	watch: ValueWatch | undefined;
	fullWrites = 0;
	/** Park the next atomic full write until {@link releaseAtomic}, then let it land anyway. */
	parkNextAtomic = false;
	readonly atomicParked = Promise.withResolvers<void>();
	readonly releaseAtomic = Promise.withResolvers<void>();

	#lines(label: string, lines: readonly string[]): void {
		this.fullWrites++;
		for (const line of lines) this.watch?.noteValue(label, line);
	}

	override async readText(filePath: string): Promise<string> {
		const text = await super.readText(filePath);
		this.watch?.noteValue("storage.readText", text);
		return text;
	}

	override readTextSync(filePath: string): string {
		const text = super.readTextSync(filePath);
		this.watch?.noteValue("storage.readTextSync", text);
		return text;
	}

	override async readTextSlices(
		filePath: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[string, string]> {
		const slices = await super.readTextSlices(filePath, prefixBytes, suffixBytes);
		for (const slice of slices) this.watch?.noteValue("storage.readTextSlices", slice);
		return slices;
	}

	override scanLines(filePath: string, visit: (line: string) => boolean): Promise<void> {
		return super.scanLines(filePath, line => {
			this.watch?.noteValue("storage.scanLines", line);
			return visit(line);
		});
	}

	override writeText(filePath: string, content: string): Promise<void> {
		this.watch?.noteValue("storage.writeText", content);
		return super.writeText(filePath, content);
	}

	override writeLinesSync(fpath: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.#lines("storage.writeLinesSync", lines);
		super.writeLinesSync(fpath, lines, options);
	}

	override async writeLinesAtomic(
		fpath: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.#lines("storage.writeLinesAtomic", lines);
		if (!this.parkNextAtomic) return super.writeLinesAtomic(fpath, lines, options);
		this.parkNextAtomic = false;
		this.atomicParked.resolve();
		await this.releaseAtomic.promise;
		// A store that committed before it noticed it was superseded.
		super.writeLinesSync(fpath, lines);
	}
}

/** A SQL client recording every value bound to or returned by a statement. */
class RecordingSqlClient implements SqlSessionStorageClient {
	watch: ValueWatch | undefined;
	readonly options: SqlSessionStorageClient["options"];
	readonly #client: SQL;

	constructor(client: SQL) {
		this.#client = client;
		this.options = client.options;
	}

	async #recorded(
		executor: SqlSessionStorageTransaction,
		query: string,
		values: unknown[] | undefined,
	): Promise<SqlSessionStorageResult> {
		for (const value of values ?? []) this.watch?.noteValue("sql.bound", value);
		const rows = await executor.unsafe(query, values);
		for (const row of rows) {
			if (typeof row !== "object" || row === null) continue;
			for (const value of Object.values(row)) this.watch?.noteValue("sql.returned", value);
		}
		return rows;
	}

	unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult> {
		return this.#recorded(this.#client, query, values);
	}

	transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> {
		return this.#client.transaction(transaction =>
			callback({ unsafe: (query, values) => this.#recorded(transaction, query, values) }),
		);
	}

	end(): Promise<void> {
		return this.#client.close();
	}
}

/**
 * Run `action` while `watch` records the storage's values and the spies the
 * longest text `JSON.parse` and `Bun.JSONL.parseChunk` are given, and the
 * whole texts handed to the base class's own full writes. Restores the spies.
 */
async function watched<T>(
	targets: { watch: ValueWatch | undefined }[],
	action: () => Promise<T>,
): Promise<{ result: T; oversized: Record<string, number>; watched: number }> {
	const watch = new ValueWatch();
	for (const target of targets) target.watch = watch;
	const parse = JSON.parse;
	const parseChunk = Bun.JSONL.parseChunk;
	const writeTextSync = FileSessionStorage.prototype.writeTextSync;
	const writeTextAtomic = FileSessionStorage.prototype.writeTextAtomic;
	const spies = [
		vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
			watch.noteValue("JSON.parse", text);
			return parse(text, reviver);
		}),
		vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation((input, start, end) => {
			watch.noteValue("Bun.JSONL.parseChunk", input);
			return parseChunk(input, start, end);
		}),
		vi
			.spyOn(FileSessionStorage.prototype, "writeTextSync")
			.mockImplementation(function (this: FileSessionStorage, fpath, content, options) {
				watch.noteValue("storage.writeTextSync", content);
				writeTextSync.call(this, fpath, content, options);
			}),
		vi
			.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
			.mockImplementation(function (this: FileSessionStorage, fpath, content, options) {
				watch.noteValue("storage.writeTextAtomic", content);
				return writeTextAtomic.call(this, fpath, content, options);
			}),
	];
	try {
		const result = await action();
		return { result, oversized: watch.oversized(), watched: watch.watched };
	} finally {
		for (const spy of spies) spy.mockRestore();
		for (const target of targets) target.watch = undefined;
	}
}

function usage() {
	return {
		input: 100,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 200,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

interface LongTranscript {
	file: string;
	sessionId: string;
	cwd: string;
	sessionDir: string;
}

/**
 * Write a transcript of at least {@link TRANSCRIPT_BYTES} to `sessionDir`,
 * line by line: turns of a user message (an image now and then, unless
 * `images` is false), an assistant message with thinking, a fenced code block
 * and a `read` call, and its result; three compactions on the current path,
 * the last keeping only the final turns; and a second branch off the middle
 * compaction.
 */
async function writeLongTranscript(
	cwd: string,
	sessionDir: string,
	options: { images?: boolean } = {},
): Promise<LongTranscript> {
	const images = options.images !== false;
	const sessionId = crypto.randomUUID();
	const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	fs.mkdirSync(sessionDir, { recursive: true });
	const writer = Bun.file(file).writer();
	let bytes = 0;
	const write = (entry: object): void => {
		const line = `${JSON.stringify(entry)}\n`;
		bytes += Buffer.byteLength(line);
		writer.write(line);
	};
	write({ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: TIMESTAMP, cwd });
	let parentId: string | null = null;
	const add = (type: string, id: string, fields: object, parent = parentId): string => {
		write({ type, id, parentId: parent, timestamp: TIMESTAMP, ...fields });
		parentId = id;
		return id;
	};
	const turn = (index: number, withImage: boolean): string => {
		const userId = add("message", `u${index}`, {
			message: {
				role: "user",
				content: [
					{ type: "text", text: `turn ${index} ${FILLER}` },
					...(withImage ? [{ type: "image", data: PNG_PIXEL, mimeType: "image/png" }] : []),
				],
				timestamp: index,
			},
		});
		add("message", `a${index}`, {
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `reasoning about turn ${index} `.repeat(100) },
					{ type: "text", text: `Here is turn ${index}:\n${FENCE}\nDone.` },
					{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { path: `src/m${index}.ts` } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: usage(),
				stopReason: "toolUse",
				timestamp: index,
			},
		});
		add("message", `r${index}`, {
			message: {
				role: "toolResult",
				toolCallId: `call_${index}`,
				toolName: "read",
				content: [{ type: "text", text: `result ${index} ${FILLER}` }],
				isError: false,
				timestamp: index,
			},
		});
		return userId;
	};
	const compaction = (id: string, firstKeptEntryId: string) =>
		add("compaction", id, { summary: `summary ${id} ${FILLER}`, firstKeptEntryId, tokensBefore: 150_000 });

	let index = 0;
	const turnBytes = (() => {
		const before = bytes;
		turn(index++, images);
		return bytes - before;
	})();
	const turns = Math.ceil(TRANSCRIPT_BYTES / turnBytes) + 8;
	const userIds = ["u0"];
	for (; index < turns; index++) {
		userIds.push(turn(index, images && (index % 100 === 0 || index === turns - 1)));
		if (index === Math.floor(turns / 4)) compaction("c1", userIds[index - 2]!);
		if (index === Math.floor(turns / 2)) {
			const mainParent = compaction("c2", userIds[index - 2]!);
			// A second branch, left for the current one.
			add(
				"message",
				"side-user",
				{ message: { role: "user", content: `side ${FILLER}`, timestamp: 0 } },
				mainParent,
			);
			parentId = mainParent;
		}
		if (index === turns - 3) compaction("c3", userIds[turns - 5]!);
	}
	await writer.end();
	expect(bytes).toBeGreaterThanOrEqual(TRANSCRIPT_BYTES);
	return { file, sessionId, cwd, sessionDir };
}

describe("a running session's reads and writes of a 64 MiB transcript on file storage", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function setUp(
		options: { images?: boolean } = {},
	): Promise<{ transcript: LongTranscript; storage: RecordingFileStorage }> {
		const dir = TempDir.createSync("@omp-bounded-io-");
		cleanups.push(() => dir.removeSync());
		const cwd = dir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const transcript = await writeLongTranscript(cwd, dir.join("sessions"), options);
		return { transcript, storage: new RecordingFileStorage() };
	}

	async function open(
		file: string,
		storage: SessionStorage,
		options: { throwIfMissing?: boolean } = {},
	): Promise<SessionManager> {
		const manager = await SessionManager.open(file, path.dirname(file), storage, {
			suppressBreadcrumb: true,
			...options,
		});
		cleanups.push(() => manager.close());
		return manager;
	}

	async function startSession(
		manager: SessionManager,
		options: {
			settings?: Record<string, unknown>;
			streamFn?: StreamFn;
			extensionRunner?: unknown;
		} = {},
	): Promise<AgentSession> {
		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const agent: Agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: {
				model: { ...bundled, contextWindow: 200_000, maxTokens: 64_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: options.streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
			modelRegistry,
			extensionRunner: options.extensionRunner as never,
		});
		cleanups.push(() => session.dispose());
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		return session;
	}

	it(
		"resumes it by path",
		async () => {
			const { transcript, storage } = await setUp();
			const { result: manager, oversized } = await watched([storage], () => open(transcript.file, storage));
			expect(oversized).toEqual({});
			expect(manager.getEntries().length).toBeGreaterThan(2000);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"resumes it by id",
		async () => {
			const { transcript, storage } = await setUp();
			const { result: manager, oversized } = await watched([storage], async () => {
				const target = await resolveResumeTarget(
					transcript.sessionId.slice(0, 8),
					transcript.cwd,
					transcript.sessionDir,
				);
				if (!target) throw new Error("The session was not found by its id");
				return open(target.session.path, storage);
			});
			expect(oversized).toEqual({});
			expect(manager.getSessionFile()).toBe(transcript.file);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"reads it again when a revival opens it, failing closed on a missing file",
		async () => {
			const { transcript, storage } = await setUp();
			const { result: manager, oversized } = await watched([storage], () =>
				open(transcript.file, storage, { throwIfMissing: true }),
			);
			expect(oversized).toEqual({});
			expect(manager.getSessionId()).toBe(transcript.sessionId);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"switches to it and reloads it (setSessionFile)",
		async () => {
			const { transcript, storage } = await setUp();
			const manager = SessionManager.create(transcript.cwd, transcript.sessionDir, storage);
			cleanups.push(() => manager.close());
			const { oversized } = await watched([storage], async () => {
				await manager.setSessionFile(transcript.file);
				await manager.setSessionFile(transcript.file);
			});
			expect(oversized).toEqual({});
			expect(manager.getSessionId()).toBe(transcript.sessionId);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"continues it as the most recent session (continueRecent)",
		async () => {
			const { transcript, storage } = await setUp();
			const { result: manager, oversized } = await watched([storage], () =>
				SessionManager.continueRecent(transcript.cwd, transcript.sessionDir, storage),
			);
			cleanups.push(() => manager.close());
			expect(oversized).toEqual({});
			expect(manager.getSessionFile()).toBe(transcript.file);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"forks it into a new file (forkFrom), and copies it (fork, createBranchedSession)",
		async () => {
			const { transcript, storage } = await setUp();
			const { result: forked, oversized } = await watched([storage], () =>
				SessionManager.forkFrom(transcript.file, transcript.cwd, transcript.sessionDir, storage),
			);
			cleanups.push(() => forked.close());
			expect(oversized).toEqual({});
			expect(forked.getHeader()?.parentSession).toBe(transcript.sessionId);

			const manager = await open(transcript.file, storage);
			const copies = await watched([storage], async () => {
				const fork = await manager.fork();
				const branched = manager.createBranchedSession(manager.getEntries().find(entry => entry.id === "u3")!.id);
				return { fork, branched };
			});
			expect(copies.oversized).toEqual({});
			expect(copies.result.fork?.newSessionFile).toBeDefined();
			expect(copies.result.branched).toBeDefined();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"rewrites it whole, streamed line by line (rewriteEntries, flushSync)",
		async () => {
			const { transcript, storage } = await setUp();
			const manager = await open(transcript.file, storage);
			const { oversized } = await watched([storage], async () => {
				await manager.rewriteEntries();
				manager.flushSync();
			});
			expect(oversized).toEqual({});
			expect(storage.fullWrites).toBeGreaterThan(0);
		},
		CASE_TIMEOUT_MS,
	);

	it.each([
		{ path: "an atomic rewrite (#recoverFromWriteConflict)", tornTail: false },
		{ path: "a synchronous rewrite (#recoverFromWriteConflictSync)", tornTail: true },
	])(
		"keeps another writer's entries after $path, reading the file back in a stream",
		async ({ tornTail }) => {
			const { transcript, storage } = await setUp();
			// A torn line makes the next append replace the whole file synchronously.
			if (tornTail) fs.appendFileSync(transcript.file, '{"type":"message"\n');
			const ours = await open(transcript.file, storage);
			const theirs = await open(transcript.file, new FileSessionStorage());
			theirs.appendMessage({ role: "user", content: "their turn", timestamp: 1 });
			await theirs.close();

			const { oversized } = await watched([storage], async () => {
				if (tornTail) ours.appendMessage({ role: "user", content: "our turn", timestamp: 2 });
				else await ours.rewriteEntries();
				await ours.flush();
			});
			expect(oversized).toEqual({});
			expect(ours.getSessionFile()).toBe(transcript.file);
			expect(
				ours
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === "their turn",
					),
			).toBe(true);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"reads back an atomic publish that landed after a synchronous rewrite superseded it",
		async () => {
			const { transcript, storage } = await setUp();
			const manager = await open(transcript.file, storage);
			const { oversized } = await watched([storage], async () => {
				storage.parkNextAtomic = true;
				const rewrite = manager.rewriteEntries();
				await storage.atomicParked.promise;
				manager.appendCustomEntry("during_rewrite", { data: "x" });
				manager.flushSync();
				storage.releaseAtomic.resolve();
				await rewrite;
			});
			expect(oversized).toEqual({});
			// The read-back recorded the size that landed, so the next publish succeeds.
			await manager.rewriteEntries();
			await manager.flush();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"reads it as a gzip-compressed subagent transcript (collectSubSessions)",
		async () => {
			const { transcript } = await setUp();
			const parent = path.join(transcript.sessionDir, "parent.jsonl");
			await Bun.write(parent, "");
			await Bun.write(
				path.join(transcript.sessionDir, "parent", "Worker.jsonl.gz"),
				Bun.gzipSync(await Bun.file(transcript.file).bytes()),
			);
			const { result, oversized } = await watched([], () => collectSubSessions(parent, { includeCompressed: true }));
			expect(oversized).toEqual({});
			expect(result.Worker?.entries.length).toBeGreaterThan(2000);
		},
		CASE_TIMEOUT_MS,
	);

	// Each of the next three changes entries before the cut or the header, so a streamed full write remains.

	it(
		"drops every image with a streamed full write: it changes entries before the cut (dropImages)",
		async () => {
			const { transcript, storage } = await setUp();
			const session = await startSession(await open(transcript.file, storage));
			const { result, oversized } = await watched([storage], () => session.dropImages());
			expect(oversized).toEqual({});
			expect(result.removed).toBeGreaterThan(1);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		'drops every thinking block with a streamed full write: it changes entries before the cut (shake("thinking"))',
		async () => {
			const { transcript, storage } = await setUp();
			const session = await startSession(await open(transcript.file, storage));
			const { result, oversized } = await watched([storage], () => session.shake("thinking"));
			expect(oversized).toEqual({});
			expect(result.thinkingBlocksDropped).toBeGreaterThan(1);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"persists a header change with a streamed full write: the listing reads the header from the first 4 KiB",
		async () => {
			const { transcript, storage } = await setUp();
			const manager = await open(transcript.file, storage);
			const added = path.join(transcript.cwd, "..", "second-root");
			fs.mkdirSync(added, { recursive: true });
			const { oversized } = await watched([storage], () => manager.addWorkspaceDirectory(added));
			expect(oversized).toEqual({});
			expect(manager.getHeader()?.additionalDirectories).toEqual([path.resolve(added)]);
		},
		CASE_TIMEOUT_MS,
	);

	/** A session whose next model call fails with a retriable error and then succeeds. */
	async function recoveringSession(transcript: LongTranscript, storage: RecordingFileStorage): Promise<AgentSession> {
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error" },
				{ content: ["Recovered after retry."], stopReason: "stop" },
			],
		});
		const session = await startSession(await open(transcript.file, storage), {
			streamFn: mock.stream,
			settings: {
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
				"features.unexpectedStopDetection": "none",
			},
		});
		mockSchedulerWaitWithClock();
		return session;
	}

	/**
	 * A session whose next turn trips threshold compaction, whose summary comes
	 * from a hook, and whose context stays too large afterwards: the commit
	 * stamps a dead-end warning on the compaction.
	 */
	async function deadEndCompactionSession(
		transcript: LongTranscript,
		storage: RecordingFileStorage,
	): Promise<AgentSession> {
		const extensionRunner = {
			initialize: () => {},
			onError: () => {},
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				return {
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};
		const session = await startSession(await open(transcript.file, storage), {
			extensionRunner,
			settings: { "compaction.enabled": true, "compaction.autoContinue": true },
		});
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
		return session;
	}

	async function runDeadEndCompaction(session: AgentSession): Promise<void> {
		const compacted = Promise.withResolvers<void>();
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_compaction_end") compacted.resolve();
		});
		const turn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: { ...usage(), input: 190_000, totalTokens: 190_100 },
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: turn });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [turn] });
		await compacted.promise;
		await session.waitForIdle();
	}

	function latestCompaction(manager: SessionManager): CompactionEntry | undefined {
		return manager.getBranch().findLast((entry): entry is CompactionEntry => entry.type === "compaction");
	}

	it(
		"marks the errors of a recovered retry (#markPendingRetryErrors)",
		async () => {
			const { transcript, storage } = await setUp();
			const session = await recoveringSession(transcript, storage);
			const { oversized } = await watched([storage], async () => {
				await session.prompt("Trigger a retriable failure");
				await session.waitForIdle();
				await session.sessionManager.flush();
			});
			expect(oversized).toEqual({});
			const recovered = session.sessionManager
				.getBranch()
				.some(
					(entry: SessionEntry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.retryRecovery?.status === "recovered",
				);
			expect(recovered).toBe(true);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"stamps a compaction after its commit (the post-compaction dead-end warning)",
		async () => {
			const { transcript, storage } = await setUp();
			const session = await deadEndCompactionSession(transcript, storage);
			const before = latestCompaction(session.sessionManager)?.id;
			const { oversized } = await watched([storage], async () => {
				await runDeadEndCompaction(session);
				await session.sessionManager.flush();
			});
			expect(oversized).toEqual({});
			const stamped = latestCompaction(session.sessionManager);
			expect(stamped?.id).not.toBe(before);
			expect(stamped?.warning).toBeString();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		'elides fenced code blocks (shake("elide"))',
		async () => {
			const { transcript, storage } = await setUp();
			const session = await startSession(await open(transcript.file, storage), {
				settings: { "compaction.enabled": true },
			});
			const { result, oversized } = await watched([storage], async () => {
				const shaken = await session.shake("elide");
				await session.sessionManager.flush();
				return shaken;
			});
			expect(oversized).toEqual({});
			expect(result.blocksDropped).toBeGreaterThan(0);
		},
		CASE_TIMEOUT_MS,
	);

	it.skipIf(!hasEntryPatchRecords)(
		'appends entry_patch records instead of rewriting for a recovered retry, a compaction stamp and shake("elide")',
		async () => {
			const patchRecords = (manager: SessionManager) =>
				manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === ENTRY_PATCH_TYPE)
					.length;
			// Without images, a dead-end rescue has none to drop: `dropImages`, a full write by design, keeps its own case.
			const { transcript, storage } = await setUp({ images: false });

			const retrying = await recoveringSession(transcript, storage);
			storage.fullWrites = 0;
			await retrying.prompt("Trigger a retriable failure");
			await retrying.waitForIdle();
			expect([storage.fullWrites, patchRecords(retrying.sessionManager)]).toEqual([0, 1]);

			const compacting = await deadEndCompactionSession(
				await writeLongTranscript(transcript.cwd, transcript.sessionDir, { images: false }),
				storage,
			);
			storage.fullWrites = 0;
			await runDeadEndCompaction(compacting);
			expect(storage.fullWrites).toBe(0);
			expect(patchRecords(compacting.sessionManager)).toBeGreaterThanOrEqual(1);

			const shaking = await startSession(
				await open(
					(await writeLongTranscript(transcript.cwd, transcript.sessionDir, { images: false })).file,
					storage,
				),
				{
					settings: { "compaction.enabled": true },
				},
			);
			storage.fullWrites = 0;
			await shaking.shake("elide");
			expect([storage.fullWrites, patchRecords(shaking.sessionManager)]).toEqual([0, 1]);
		},
		CASE_TIMEOUT_MS,
	);
});

/** SQL storages a case can run on: SQLite always, PostgreSQL when a scratch database is named. */
const sqlTargets = [
	{ name: "SQLite", url: (dir: string) => `sqlite://${path.join(dir, "sessions.db")}` },
	...(POSTGRES_URL ? [{ name: "PostgreSQL", url: () => POSTGRES_URL }] : []),
];

describe.each(sqlTargets)("a 64 MiB transcript on $name SQL storage", ({ url }) => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function stored(): Promise<{
		transcript: LongTranscript;
		storage: SessionStorage;
		client: RecordingSqlClient;
	}> {
		const dir = TempDir.createSync("@omp-bounded-io-sql-");
		cleanups.push(() => dir.removeSync());
		const cwd = dir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const transcript = await writeLongTranscript(cwd, dir.join("sessions"));
		const client = new RecordingSqlClient(new SQL(url(dir.path())));
		const table = `omp_bounded_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const storage = await SqlSessionStorage.create({ client, table });
		cleanups.push(async () => {
			await client.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
			await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
			await client.end();
		});
		await storage.writeText(transcript.file, await Bun.file(transcript.file).text());
		await storage.drain();
		return { transcript, storage, client };
	}

	async function open(file: string, storage: SessionStorage): Promise<SessionManager> {
		const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
		cleanups.push(() => manager.close());
		return manager;
	}

	it.skipIf(!indexedStorageReadsChunks)(
		"resumes it by path",
		async () => {
			const { transcript, storage, client } = await stored();
			const { oversized, watched: points } = await watched([client], () => open(transcript.file, storage));
			expect(oversized).toEqual({});
			expect(points).toBeGreaterThan(0);
		},
		CASE_TIMEOUT_MS,
	);

	it.skipIf(!indexedStorageReadsChunks)(
		"resumes it by id",
		async () => {
			const { transcript, storage, client } = await stored();
			const { oversized } = await watched([client], async () => {
				const match = await resolveResumableSession(
					transcript.sessionId.slice(0, 8),
					transcript.cwd,
					transcript.sessionDir,
					storage,
				);
				if (!match) throw new Error("The session was not found by its id");
				return open(match.session.path, storage);
			});
			expect(oversized).toEqual({});
		},
		CASE_TIMEOUT_MS,
	);

	it.skipIf(!indexedStorageReadsChunks)(
		"rewrites it whole, streamed (rewriteEntries)",
		async () => {
			const { transcript, storage, client } = await stored();
			const manager = await open(transcript.file, storage);
			const { oversized } = await watched([client], async () => {
				await manager.rewriteEntries();
				await manager.flush();
				await storage.drain();
			});
			expect(oversized).toEqual({});
		},
		CASE_TIMEOUT_MS,
	);
});
