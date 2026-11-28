import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantRetryRecovery } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const SERVER_ERROR = "503 service unavailable: overloaded_error";
/** What an elide pass leaves in place of a heavy tool result. */
const PLACEHOLDER = "[elided: see artifact://1]";
/** One line, so a failure prints a short diff. */
const HEAVY_RESULT = "heavy tool output ".repeat(16);

/** How a retry saga marks the attempt its retry recovered. */
const RECOVERED: AssistantRetryRecovery = {
	kind: "auto-retry",
	status: "recovered",
	attempt: 1,
	recoveredAt: TIMESTAMP,
	recovery: "plain",
	note: "error; retried",
	supersededBy: { timestamp: 3, provider: "anthropic", model: "claude-sonnet-4-5" },
};

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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

/** An attempt that failed with partial output, which a retry then recovered. */
function failedAttempt(): AssistantMessage {
	return assistant("partial answer", { stopReason: "error", errorMessage: SERVER_ERROR });
}

function toolCall(id: string, command: string): AssistantMessage {
	return assistant("", {
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		stopReason: "toolUse",
	});
}

function toolResult(toolCallId: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 3,
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return file;
}

function messagesOf(manager: SessionManager): AgentMessage[] {
	return manager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

/** The marker on the failed attempt and the content of the tool result among `messages`. */
function patchedFields(messages: readonly AgentMessage[]): { retryRecovery: unknown; result: unknown } {
	const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
	const result = messages.find(message => message.role === "toolResult");
	return {
		retryRecovery: failed?.role === "assistant" ? failed.retryRecovery : undefined,
		result: result?.role === "toolResult" ? result.content : undefined,
	};
}

/** Write `entries` under a session header as `dir`/session.jsonl. The session id is the directory's name. */
async function writeSession(dir: string, entries: readonly object[]): Promise<string> {
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

const OLD_TURNS = 50;

/**
 * A resumed long session: OLD_TURNS tool-call turns before the cut of `c1`,
 * then a kept tail with a heavy tool result and a reply with a large fenced
 * block, both of which an elide pass shortens, and a usage anchor after them.
 */
async function resumeLongSession(dir: string) {
	const entries: object[] = [];
	let parent: string | null = null;
	const push = (id: string, message: object) => {
		entries.push({ type: "message", id, parentId: parent, timestamp: TIMESTAMP, message });
		parent = id;
	};
	for (let turn = 0; turn < OLD_TURNS; turn++) {
		push(`a${turn}`, toolCall(`old_${turn}`, `echo ${BODY}`));
		push(`t${turn}`, toolResult(`old_${turn}`, `old result ${turn} ${BODY}`));
	}
	push("keep", { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 4 });
	entries.push({
		type: "compaction",
		id: "c1",
		parentId: "keep",
		timestamp: TIMESTAMP,
		summary: `c1 ${BODY}`,
		firstKeptEntryId: "keep",
		tokensBefore: 1000,
	});
	parent = "c1";
	push("call", toolCall("call_heavy", "ls"));
	push("heavy", toolResult("call_heavy", "X".repeat(20_000)));
	const fence = `\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(200)}\`\`\``;
	push("fenced", assistant(`Here it is:\n${fence}\nDone.`));
	push("tail", { role: "user", content: [{ type: "text", text: `newer\n${"tail ".repeat(4_000)}` }], timestamp: 6 });
	const anchorUsage = { ...assistant("").usage, input: 20_000, totalTokens: 20_008 };
	push("anchor", assistant("Latest reply.", { usage: anchorUsage }));
	const file = await writeSession(dir, entries);

	const manager = await SessionManager.open(file, dir, new FileSessionStorage(), { suppressBreadcrumb: true });
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic model to exist");
	// Pinned so catalog regeneration cannot move what an elide pass protects.
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
		convertToLlm,
		streamFn: createMockModel({ responses: [] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { session, manager, authStorage };
}

describe("entry patch records and the readers of a session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A session's previous process, or any other writer of the journal, can append
	// a record after this manager loaded the file; the manager keeps such entries.
	// Without the patch the live session shows the recovered attempt as a failure,
	// and its next full write erases the marker for every later resume.
	it("applies a patch record another writer appended, and keeps the patched field through a full rewrite", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const manager = SessionManager.create(dir.path(), dir.path(), new FileSessionStorage());
		try {
			manager.appendMessage(user("go"));
			const failedId = manager.appendMessage(failedAttempt());
			const leafId = manager.appendMessage(assistant("Recovered after retry."));
			await manager.flush();
			const file = sessionFileOf(manager);

			const record = {
				type: "custom",
				customType: "entry_patch",
				id: "otherwriter",
				parentId: leafId,
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: failedId, message: { retryRecovery: RECOVERED } }] },
			};
			await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`);
			// This manager's next append finds the record past what it wrote.
			manager.appendMessage(user("next"));
			await manager.flush();
			const live = patchedFields(messagesOf(manager)).retryRecovery;

			await manager.rewriteEntries();
			await manager.flush();
			const resumed = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			try {
				expect({ live, resumedAfterRewrite: patchedFields(messagesOf(resumed)).retryRecovery }).toEqual({
					live: RECOVERED,
					resumedAfterRewrite: RECOVERED,
				});
			} finally {
				await resumed.close();
			}
		} finally {
			await manager.close();
		}
	});

	// A client that reads a subagent's transcript must see what the subagent's
	// session holds: otherwise a recovered attempt reads as a failed run and an
	// elided result comes back in full.
	it("shows a recovered attempt and an elided result to the RPC subagent transcript and the agent hub transcript", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const manager = SessionManager.create(dir.path(), dir.path(), new FileSessionStorage());
		try {
			manager.appendMessage(user("do the task"));
			const failedId = manager.appendMessage(failedAttempt());
			manager.appendMessage(toolCall("call_1", "ls -R"));
			const resultId = manager.appendMessage(toolResult("call_1", HEAVY_RESULT));
			manager.appendMessage(assistant("Recovered after retry."));
			await manager.flush();
			// What the end of a retry saga and an elide pass record.
			await manager.patchEntries([{ entryId: failedId, message: { retryRecovery: RECOVERED } }]);
			await manager.patchEntries([
				{ entryId: resultId, message: { content: [{ type: "text", text: PLACEHOLDER }], prunedAt: 5 } },
			]);
			await manager.flush();
			const file = sessionFileOf(manager);

			const rpc = await readRpcSubagentTranscript(file, 0);
			const hub = agentTranscriptSource.parseEntries(await agentTranscriptSource.readFrom(file, 0));
			const held = { retryRecovery: RECOVERED, result: [{ type: "text", text: PLACEHOLDER }] };
			expect({
				session: patchedFields(messagesOf(manager)),
				rpcTranscript: patchedFields(rpc.messages),
				agentHubTranscript: patchedFields(hub.flatMap(entry => (entry.type === "message" ? [entry.message] : []))),
			}).toEqual({ session: held, rpcTranscript: held, agentHubTranscript: held });
		} finally {
			await manager.close();
		}
	});

	// A running session must not read the bodies of entries before the cut back
	// from the store: the pass runs on its own after compactions, and on a long
	// session each read of the whole history blocks the session.
	it('reads no body of an entry before the cut in a shake("elide") pass that has nothing left to shorten', async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const { session, manager, authStorage } = await resumeLongSession(dir.path());
		try {
			expect(manager.coldStoreStats().coldEntries).toBeGreaterThan(0);
			const first = await session.shake("elide");
			expect(first.toolResultsDropped + first.blocksDropped).toBe(2);

			const before = manager.coldStoreStats().materializations;
			const second = await session.shake("elide");
			expect({
				shortened: second.toolResultsDropped + second.blocksDropped,
				olderBodiesRead: manager.coldStoreStats().materializations - before,
			}).toEqual({ shortened: 0, olderBodiesRead: 0 });
		} finally {
			await session.dispose();
			authStorage.close();
			await manager.close();
		}
	});

	// A tool result's content is a list of blocks. A record that sets a string
	// there is malformed: applied, it makes every later request of the session
	// throw while the session still appears to load.
	it("skips a patch record whose content has the wrong shape for its target's role", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const resultText = "files listed here";
		const file = await writeSession(dir.path(), [
			{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user("list the files") },
			{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: toolCall("call_1", "ls") },
			{ type: "message", id: "t1", parentId: "a1", timestamp: TIMESTAMP, message: toolResult("call_1", resultText) },
			{
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "t1",
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: "t1", message: { content: "a string" } }] },
			},
			{ type: "message", id: "u2", parentId: "p1", timestamp: TIMESTAMP, message: user("next") },
		]);
		const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			let modelContext: string;
			try {
				const request = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
				modelContext = request.includes(resultText) ? "holds the result" : "lacks the result";
			} catch (error) {
				modelContext = `threw: ${error instanceof Error ? error.message : String(error)}`;
			}
			expect({
				result: patchedFields(messagesOf(manager)).result,
				modelContext,
			}).toEqual({
				result: [{ type: "text", text: resultText }],
				modelContext: "holds the result",
			});
		} finally {
			await manager.close();
		}
	});

	// A continuation marks the failed turn it continued from (`continued`) with a
	// patch record. If the record loses the marker, a resumed session rebuilds
	// its model context without that turn, and the continuation follows nothing.
	it("keeps the continued marker a patch record sets on a failed turn through a resume and a full rewrite", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const file = await writeSession(dir.path(), [
			{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user("go") },
			{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: failedAttempt() },
			{ type: "message", id: "a2", parentId: "a1", timestamp: TIMESTAMP, message: assistant(" and the rest.") },
			{
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "a2",
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: "a1", message: { continued: true } }] },
			},
		]);
		const continuedOf = (manager: SessionManager) =>
			messagesOf(manager).map(message => (message.role === "assistant" ? message.continued : undefined));
		const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		let resumed: (true | undefined)[];
		try {
			resumed = continuedOf(manager);
			await manager.rewriteEntries();
			await manager.flush();
		} finally {
			await manager.close();
		}
		const rewritten = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect({ resumed, afterRewrite: continuedOf(rewritten) }).toEqual({
				resumed: [undefined, true, undefined],
				afterRewrite: [undefined, true, undefined],
			});
		} finally {
			await rewritten.close();
		}
	});

	// The marker belongs to an assistant turn; a record that sets it on another
	// role is malformed, as one that sets an assistant field there is.
	it("skips a patch record that sets the continued marker on a user message, with a warning", async () => {
		using dir = TempDir.createSync("@omp-entry-patch-");
		const file = await writeSession(dir.path(), [
			{ type: "message", id: "u1", parentId: null, timestamp: TIMESTAMP, message: user("go") },
			{ type: "message", id: "a1", parentId: "u1", timestamp: TIMESTAMP, message: assistant("done") },
			{
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "a1",
				timestamp: TIMESTAMP,
				data: { patches: [{ entryId: "u1", message: { continued: true } }] },
			},
		]);
		const warn = vi.spyOn(logger, "warn");
		const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			const first = messagesOf(manager)[0];
			expect({
				warned: warn.mock.calls.some(call => /entry patch/i.test(String(call[0]))),
				userHasMarker: first !== undefined && "continued" in first,
			}).toEqual({ warned: true, userHasMarker: false });
		} finally {
			await manager.close();
		}
	});
});
