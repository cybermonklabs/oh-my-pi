import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantRetryRecovery, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/**
 * File storage that counts the bytes the session layer hands it, and how many
 * of its writes published the whole file.
 */
class InstrumentedFileSessionStorage extends FileSessionStorage {
	bytesWritten = 0;
	fullWrites = 0;

	override writeTextSync(filePath: string, content: string, options?: SessionStorageWriteOptions): void {
		this.fullWrites++;
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		super.writeTextSync(filePath, content, options);
	}

	override writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.fullWrites++;
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		return super.writeTextAtomic(filePath, content, options);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		const count = (line: string): void => {
			this.bytesWritten += Buffer.byteLength(line, "utf8");
		};
		return {
			append: line => {
				count(line);
				return writer.append(line);
			},
			appendSync: line => {
				count(line);
				if (!writer.appendSync) throw new Error("file writer lost appendSync");
				writer.appendSync(line);
			},
			flush: () => writer.flush(),
			flushSync: () => writer.flushSync?.(),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}

	/** Start counting a new write window. */
	resetCounts(): void {
		this.bytesWritten = 0;
		this.fullWrites = 0;
	}
}

const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";
/** Several MiB of history: a whole-file rewrite would write at least this much. */
const LONG_HISTORY = Array.from({ length: 6 }, (_, turn) => `history line ${turn}\n`.repeat(30_000));
const SHORT_HISTORY = ["history line\n"];

function usageWith(input: number): Usage {
	return {
		input,
		output: 8,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 8,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: usageWith(16),
		timestamp: Date.now(),
		...overrides,
	};
}

function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

function messageOf(manager: SessionManager, id: string): AgentMessage {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message") throw new Error(`Expected message entry ${id}`);
	return entry.message;
}

/** The retry markers in `messages`, keyed by the message they mark. */
function retryMarks(
	messages: readonly AgentMessage[],
): Array<{ timestamp: number; retryRecovery: AssistantRetryRecovery }> {
	return messages.flatMap(message =>
		message.role === "assistant" && message.retryRecovery
			? [{ timestamp: message.timestamp, retryRecovery: message.retryRecovery }]
			: [],
	);
}

/** The display metadata of the latest compaction, as an entry or as its summary message carries it. */
function compactionStamp(source: { entries?: readonly SessionEntry[]; messages?: readonly AgentMessage[] }): {
	warning: string | undefined;
	tokensAfter: number | undefined;
} {
	if (source.entries) {
		const entry = source.entries.findLast(candidate => candidate.type === "compaction");
		if (entry?.type !== "compaction") throw new Error("Expected a compaction entry");
		return { warning: entry.warning, tokensAfter: entry.tokensAfter };
	}
	const summary = source.messages?.findLast(message => message.role === "compactionSummary");
	if (summary?.role !== "compactionSummary") throw new Error("Expected a compaction summary message");
	return { warning: summary.warning, tokensAfter: summary.tokensAfter };
}

interface WholeFileReads<T> {
	resume: T;
	fork: T;
	readOnly: T;
	htmlExport: T;
}

describe("AgentSession entry patch persistence", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	function model() {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		// Pinned so catalog regeneration cannot move the compaction threshold.
		return { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	}

	/** A persisted session whose file already holds `history` (one user turn each), counting bytes from here on. */
	async function persistedManager(history: readonly string[]): Promise<{
		dir: string;
		storage: InstrumentedFileSessionStorage;
		manager: SessionManager;
	}> {
		const tempDir = TempDir.createSync("@pi-entry-patch-");
		tempDirs.push(tempDir);
		const storage = new InstrumentedFileSessionStorage();
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		for (const text of history) {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() - 1_000 });
			manager.appendMessage(assistant([{ type: "text", text: "Noted." }], { timestamp: Date.now() - 999 }));
		}
		await manager.flush();
		storage.resetCounts();
		return { dir: tempDir.path(), storage, manager };
	}

	function sessionFileOf(manager: SessionManager): string {
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return sessionFile;
	}

	/**
	 * What each reader that loads the whole session file rebuilds: resume,
	 * `/fork`, `history://` for a parked agent, and the HTML export of the same
	 * file as a subagent transcript.
	 */
	async function readWholeFile<T>(
		manager: SessionManager,
		dir: string,
		fromEntries: (entries: readonly SessionEntry[]) => T,
		fromMessages: (messages: readonly AgentMessage[]) => T,
	): Promise<WholeFileReads<T>> {
		const sessionFile = sessionFileOf(manager);
		const resumed = await SessionManager.open(sessionFile, dir);
		const forked = await SessionManager.forkFrom(sessionFile, dir, path.join(dir, "fork"), undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const parentFile = path.join(dir, "export", "parent.jsonl");
		fs.mkdirSync(path.join(dir, "export", "parent"), { recursive: true });
		fs.copyFileSync(sessionFile, path.join(dir, "export", "parent", "Helper.jsonl"));
		const exported = (await collectSubSessions(parentFile)).Helper;
		if (!exported) throw new Error("Expected the copied session as an exported subagent transcript");
		try {
			return {
				resume: fromEntries(resumed.getEntries()),
				fork: fromEntries(forked.getEntries()),
				readOnly: fromMessages(await loadSessionMessagesReadOnly(sessionFile)),
				htmlExport: fromEntries(exported.entries),
			};
		} finally {
			await resumed.close();
			await forked.close();
		}
	}

	describe("a recovered retry", () => {
		async function recoverRetry(history: readonly string[]) {
			const { dir, storage, manager } = await persistedManager(history);
			const mock = createMockModel({
				responses: [{ throw: RETRIABLE_SERVER_ERROR }, { content: ["Recovered after retry."], stopReason: "stop" }],
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": true,
					"retry.baseDelayMs": 5,
					"retry.maxDelayMs": 100,
					"retry.maxRetries": 1,
					"retry.modelFallback": false,
					"features.unexpectedStopDetection": "none",
				}),
				modelRegistry,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			const transcriptBytes = fs.statSync(sessionFileOf(manager)).size;
			storage.resetCounts();

			await session.prompt("Recover from the transient failure.");
			await session.waitForIdle();
			await manager.flush();
			return { dir, manager, transcriptBytes, bytesWritten: storage.bytesWritten, fullWrites: storage.fullWrites };
		}

		it("marks the same entries for every whole-file reader in bytes that do not grow with the transcript", async () => {
			mockSchedulerWaitWithClock();
			const short = await recoverRetry(SHORT_HISTORY);
			const long = await recoverRetry(LONG_HISTORY);
			expect(long.transcriptBytes - short.transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

			// Marking the recovered attempt never rewrites the whole session file:
			// the turn writes its own entries and one small record, so a recovered
			// retry on a long session does not write the transcript again.
			expect([short.fullWrites, long.fullWrites]).toEqual([0, 0]);
			expect(Math.abs(long.bytesWritten - short.bytesWritten)).toBeLessThan(1024);

			const live = retryMarks(messagesOf(long.manager.getEntries()));
			expect(live.map(mark => mark.retryRecovery.status)).toEqual(["recovered"]);
			// A reader that loses the marker shows the superseded error as a live failure.
			expect(
				await readWholeFile(long.manager, long.dir, entries => retryMarks(messagesOf(entries)), retryMarks),
			).toEqual({
				resume: live,
				fork: live,
				readOnly: live,
				htmlExport: live,
			});
		});
	});

	describe("a compaction dead-end stamp", () => {
		async function stampDeadEnd(history: readonly string[]) {
			const { dir, storage, manager } = await persistedManager(history);
			// The hook supplies the summary, so the pass needs no model; the guard
			// then finds no headroom and stamps the dead-end on the entry.
			const extensionRunner = {
				initialize: () => {},
				onError: () => {},
				hasHandlers: (type: string) => type === "session_before_compact",
				emit: async (event: { type: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
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
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.autoContinue": true }),
				modelRegistry,
				extensionRunner: extensionRunner as never,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
			// The oversized tail holds nothing a rescue can elide.
			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 0,
				blocksDropped: 0,
				tokensFreed: 0,
			});
			const compactionDone = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") compactionDone.resolve();
			});
			const transcriptBytes = fs.statSync(sessionFileOf(manager)).size;
			storage.resetCounts();

			const turn = assistant([{ type: "text", text: "Done." }], { usage: usageWith(190_000) });
			session.agent.emitExternalEvent({ type: "message_end", message: turn });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [turn] });
			await compactionDone.promise;
			await session.waitForIdle();
			await manager.flush();
			return { dir, manager, transcriptBytes, bytesWritten: storage.bytesWritten, fullWrites: storage.fullWrites };
		}

		it("lands the warning on every whole-file reader in bytes that do not grow with the transcript", async () => {
			const short = await stampDeadEnd(SHORT_HISTORY);
			const long = await stampDeadEnd(LONG_HISTORY);
			expect(long.transcriptBytes - short.transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

			// The stamp never rewrites the whole session file, so a compaction that
			// dead-ends does not write the transcript again.
			expect([short.fullWrites, long.fullWrites]).toEqual([0, 0]);
			expect(Math.abs(long.bytesWritten - short.bytesWritten)).toBeLessThan(1024);

			const live = compactionStamp({ entries: long.manager.getEntries() });
			expect(live.warning).toContain("Compaction freed too little context");
			// The divider badges the pause from this stamp; a reader without it
			// shows the paused session as healthy.
			expect(
				await readWholeFile(
					long.manager,
					long.dir,
					entries => compactionStamp({ entries }),
					messages => compactionStamp({ messages }),
				),
			).toEqual({ resume: live, fork: live, readOnly: live, htmlExport: live });
		});
	});

	describe("an elide pass", () => {
		const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" };

		/** A session with a heavy tool result, a fenced block in a reply, and a usage anchor after both. */
		async function elidableSession(history: readonly string[]) {
			const persisted = await persistedManager(history);
			const { manager } = persisted;
			const callId = "call_heavy";
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "do it" }], timestamp: Date.now() });
			manager.appendMessage(
				assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }], {
					stopReason: "toolUse",
				}),
			);
			const toolResultId = manager.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: "X".repeat(20_000) }, IMAGE],
				isError: false,
				timestamp: Date.now(),
			});
			const fence = `\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(200)}\`\`\``;
			const fencedReplyId = manager.appendMessage(
				assistant([{ type: "text", text: `Here it is:\n${fence}\nDone.` }]),
			);
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `newer context\n${"tail ".repeat(4_000)}` }],
				timestamp: Date.now(),
			});
			const anchorId = manager.appendMessage(
				assistant([{ type: "text", text: "Latest reply." }], { usage: usageWith(20_000) }),
			);
			const session = new AgentSession({
				agent: new Agent({ initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
				modelRegistry,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await manager.flush();
			return { ...persisted, session, elidedIds: [toolResultId, fencedReplyId, anchorId] };
		}

		async function resumedMessages(manager: SessionManager, dir: string, ids: readonly string[]) {
			const resumed = await SessionManager.open(sessionFileOf(manager), dir);
			try {
				return ids.map(id => structuredClone(messageOf(resumed, id)));
			} finally {
				await resumed.close();
			}
		}

		it("resumes each elided entry as the live session holds it, in bytes that do not grow with the transcript", async () => {
			const runs = [];
			for (const history of [SHORT_HISTORY, LONG_HISTORY]) {
				const run = await elidableSession(history);
				const transcriptBytes = fs.statSync(sessionFileOf(run.manager)).size;
				run.storage.resetCounts();
				const result = await run.session.shake("elide");
				await run.manager.flush();
				expect(result.toolResultsDropped + result.blocksDropped).toBe(2);
				runs.push({
					...run,
					transcriptBytes,
					bytesWritten: run.storage.bytesWritten,
					fullWrites: run.storage.fullWrites,
				});
			}
			const [short, long] = runs;
			expect(long.transcriptBytes - short.transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

			// An elide pass, which runs on its own after compactions, never rewrites
			// the whole session file.
			expect([short.fullWrites, long.fullWrites]).toEqual([0, 0]);
			expect(Math.abs(long.bytesWritten - short.bytesWritten)).toBeLessThan(1024);

			const [toolResult, fencedReply, anchor] = long.elidedIds.map(id => messageOf(long.manager, id));
			// The pass shortened the result and the reply, and credited the removed
			// tokens to the usage anchor; a resume that drops any of it re-sends the
			// elided text or misreports the context meter.
			expect(toolResult.role === "toolResult" ? toolResult.prunedAt : undefined).toBeGreaterThan(0);
			expect(fencedReply.role === "assistant" ? fencedReply.elidedOutputTokens : undefined).toBeGreaterThan(0);
			expect(
				anchor.role === "assistant" ? anchor.contextSnapshot?.historyRewriteTokensRemoved : undefined,
			).toBeGreaterThan(0);
			expect(await resumedMessages(long.manager, long.dir, long.elidedIds)).toEqual(
				[toolResult, fencedReply, anchor].map(message => structuredClone(message)),
			);
		});

		it("keeps images a later image drop removed from an elided result out of the resumed session", async () => {
			const { dir, manager, session, elidedIds } = await elidableSession(SHORT_HISTORY);
			const [toolResultId] = elidedIds;
			await session.shake("elide");
			// Elision keeps the image; the image drop then rewrites the whole file.
			expect(messageOf(manager, toolResultId)).toMatchObject({ content: [{ type: "text" }, IMAGE] });
			expect((await session.shake("images")).imagesDropped).toBe(1);
			await manager.flush();

			const live = structuredClone(messageOf(manager, toolResultId));
			expect(live).toMatchObject({ content: [{ type: "text" }] });
			// Replaying the elide record's older content would put the dropped image
			// back into every resumed request.
			expect(await resumedMessages(manager, dir, [toolResultId])).toEqual([live]);
		});
	});

	it("loads a session past a malformed entry patch record and still applies the valid ones", async () => {
		const { dir, manager } = await persistedManager(SHORT_HISTORY);
		const errorId = manager.appendMessage(
			assistant([{ type: "text", text: "partial" }], {
				stopReason: "error",
				errorMessage: RETRIABLE_SERVER_ERROR,
				usage: usageWith(0),
			}),
		);
		manager.appendCustomEntry("entry_patch", { patches: "not a list" });
		const retryRecovery: AssistantRetryRecovery = {
			kind: "auto-retry",
			status: "superseded",
			attempt: 1,
			recovery: "plain",
			note: "error; retried",
		};
		await manager.patchEntries([{ entryId: errorId, message: { retryRecovery } }]);
		await manager.flush();
		const warn = vi.spyOn(logger, "warn");

		const resumed = await SessionManager.open(sessionFileOf(manager), dir);
		try {
			expect(warn).toHaveBeenCalledWith("Skipping malformed entry patch record", expect.anything());
			expect(retryMarks(messagesOf(resumed.getEntries()))).toEqual([
				{ timestamp: messageOf(resumed, errorId).timestamp, retryRecovery },
			]);
		} finally {
			await resumed.close();
		}
		expect(retryMarks(await loadSessionMessagesReadOnly(sessionFileOf(manager)))).toHaveLength(1);
	});
});
