/**
 * A session storage that bounds its queued transcript appends
 * (`SessionStorage.waitForAppendAdmission`) holds an agent turn before each
 * model request and before the loop appends each tool result, and an abort
 * ends that wait at once. A storage under its threshold, or one that never
 * makes turns wait, hands the turn nothing to await.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { MemoryBackend } from "../helpers/memory-session-backend";

const CALL_ID = "toolu_append_admission";
const TOOL_OUTPUT = [{ type: "text" as const, text: "fixture contents" }];

/** One admission wait the storage has not granted yet. */
interface PendingAdmission {
	admit(): void;
}

/**
 * In-memory storage whose append admission stays closed until the test admits
 * each wait. A fired signal ends a wait, as the method's contract requires.
 */
class GatedAdmissionStorage extends MemorySessionStorage {
	readonly #pending: PendingAdmission[] = [];
	#arrival: PromiseWithResolvers<void> | undefined;

	waitForAppendAdmission(signal?: AbortSignal): Promise<void> {
		const admitted = Promise.withResolvers<void>();
		if (signal?.aborted) admitted.resolve();
		else signal?.addEventListener("abort", () => admitted.resolve(), { once: true });
		this.#pending.push({ admit: () => admitted.resolve() });
		this.#arrival?.resolve();
		return admitted.promise;
	}

	/** The next wait the session starts, once it has started it. */
	async nextWait(): Promise<PendingAdmission> {
		while (true) {
			const next = this.#pending.shift();
			if (next) return next;
			this.#arrival = Promise.withResolvers<void>();
			await this.#arrival.promise;
		}
	}
}

/**
 * In-memory storage whose append admission throws before it returns a promise
 * at its second wait, the one before the loop appends the tool result, as an
 * SDK storage's method can; every other wait admits at once.
 */
class ThrowingAdmissionStorage extends MemorySessionStorage {
	readonly failure = new Error("admission check failed");
	#waits = 0;

	waitForAppendAdmission(): Promise<void> {
		this.#waits++;
		if (this.#waits === 2) throw this.failure;
		return Promise.resolve();
	}
}

/**
 * Hold admission closed for a while before the test looks at the turn. Real time on purpose: what must not
 * happen (a request or append that skipped the wait) has no event to await, and the agent loop reaches its
 * next request through a timer turn of its own, so only letting real time pass would show it.
 */
function holdClosed(): Promise<void> {
	return Bun.sleep(30);
}

/** The tool results the session saved for the test's tool call. */
function savedToolResults(sessionManager: SessionManager): { content: unknown; isError: boolean }[] {
	return sessionManager
		.getEntries()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === CALL_ID
				? [{ content: entry.message.content, isError: entry.message.isError }]
				: [],
		);
}

describe("AgentSession waits for its storage's append admission", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-append-admission-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/** A session over `storage` whose scripted model calls one tool, then answers. */
	function startSession(storage: SessionStorage): {
		session: AgentSession;
		sessionManager: SessionManager;
		mock: MockModel;
		toolRuns: () => number;
	} {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		let toolRuns = 0;
		const tool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Reads the fixture",
			parameters: type({}),
			execute: async () => {
				toolRuns++;
				return { content: TOOL_OUTPUT };
			},
		};
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: CALL_ID, name: "read", arguments: {} }] }],
			handler: { content: ["done"] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"), storage);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
		sessions.push(session);
		return { session, sessionManager, mock, toolRuns: () => toolRuns };
	}

	it("hands a tool result back with nothing to await on storage that never waits, and on indexed storage under its threshold", async () => {
		// If this regresses, every model request and tool result of a session on file storage, or on indexed
		// storage with nothing queued, goes through an admission promise and an extra await hop.
		const indexed = new IndexedSessionStorage(new MemoryBackend());
		await indexed.initialize();
		const observed: Record<string, { admission: Promise<void> | undefined; afterToolCall: string[] }> = {};
		for (const [name, storage] of [
			["file", new FileSessionStorage()],
			["indexed", indexed],
		] as const) {
			const { session, sessionManager } = startSession(storage);
			const afterToolCall = session.agent.afterToolCall;
			if (!afterToolCall) throw new Error("Expected the session's afterToolCall hook");
			const returned: string[] = [];
			session.agent.afterToolCall = (ctx, signal) => {
				const result = afterToolCall(ctx, signal);
				returned.push(result instanceof Promise ? "promise" : "value");
				return result;
			};
			await session.prompt("read the fixture");
			await session.waitForIdle();
			expect(savedToolResults(sessionManager)).toEqual([{ content: TOOL_OUTPUT, isError: false }]);
			observed[name] = { admission: sessionManager.waitForAppendAdmission(), afterToolCall: returned };
		}
		expect(observed).toEqual({
			file: { admission: undefined, afterToolCall: ["value"] },
			indexed: { admission: undefined, afterToolCall: ["value"] },
		});
	});

	it("waits for the storage's append admission before each model request and before it appends each tool result", async () => {
		// If this regresses, a process whose SQL store falls behind keeps sending model requests and
		// queuing tool results, and the transcript lines it has queued grow its memory without bound.
		const storage = new GatedAdmissionStorage();
		const gated = startSession(storage);
		const prompt = gated.session.prompt("read the fixture");

		const beforeFirstRequest = await storage.nextWait();
		await holdClosed();
		expect(gated.mock.calls).toHaveLength(0);
		beforeFirstRequest.admit();

		const beforeToolResult = await storage.nextWait();
		await holdClosed();
		expect(gated.toolRuns()).toBe(1);
		expect(savedToolResults(gated.sessionManager)).toEqual([]);
		beforeToolResult.admit();

		const beforeSecondRequest = await storage.nextWait();
		await holdClosed();
		expect(savedToolResults(gated.sessionManager)).toEqual([{ content: TOOL_OUTPUT, isError: false }]);
		expect(gated.mock.calls).toHaveLength(1);
		beforeSecondRequest.admit();

		await prompt;
		await gated.session.waitForIdle();
		expect(gated.mock.calls).toHaveLength(2);

		const plain = startSession(new MemorySessionStorage());
		await plain.session.prompt("read the fixture");
		await plain.session.waitForIdle();
		// What a resume reads back: each saved message's role and content.
		const [gatedMessages, plainMessages] = [gated, plain].map(({ sessionManager }) =>
			sessionManager.getEntries().flatMap(entry =>
				entry.type === "message"
					? [
							{
								role: entry.message.role,
								content: "content" in entry.message ? entry.message.content : undefined,
							},
						]
					: [],
			),
		);
		expect(gatedMessages).toEqual(plainMessages);
	});

	it("ends the admission wait when the turn is aborted", async () => {
		// If this regresses, pressing Esc while the SQL store is behind leaves the turn stuck until the
		// database catches up (here `abort()` never settles and the test times out), or the tool that
		// already ran loses its result to an error in the transcript.
		const storage = new GatedAdmissionStorage();
		const gated = startSession(storage);
		const prompt = gated.session.prompt("read the fixture");
		(await storage.nextWait()).admit();
		await storage.nextWait();
		expect(gated.toolRuns()).toBe(1);

		await gated.session.abort();
		await prompt;

		expect(gated.mock.calls).toHaveLength(1);
		expect(savedToolResults(gated.sessionManager)).toEqual([{ content: TOOL_OUTPUT, isError: false }]);
		const lastAssistant = gated.session.agent.state.messages.findLast(message => message.role === "assistant");
		expect(lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined).toBe("aborted");
	});

	it("ends the admission wait before a model request when the turn is aborted", async () => {
		// If this regresses, pressing Esc while the SQL store is behind leaves a turn that has not yet
		// asked the model anything stuck until the database catches up (here `abort()` never settles
		// and the test times out).
		const storage = new GatedAdmissionStorage();
		const gated = startSession(storage);
		const prompt = gated.session.prompt("read the fixture");
		await storage.nextWait();

		await gated.session.abort();
		await prompt;

		expect(gated.mock.calls).toHaveLength(0);
		const lastAssistant = gated.session.agent.state.messages.findLast(message => message.role === "assistant");
		expect(lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined).toBe("aborted");
	});

	it("keeps a completed tool's result when the storage's admission wait throws before it returns a promise", async () => {
		// If this regresses, an SDK storage whose admission check throws at once makes the agent loop
		// save an error in place of the result of a tool that already ran, and the model is told the
		// tool failed.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const storage = new ThrowingAdmissionStorage();
			const throwing = startSession(storage);
			await throwing.session.prompt("read the fixture");
			await throwing.session.waitForIdle();

			expect({
				toolRuns: throwing.toolRuns(),
				saved: savedToolResults(throwing.sessionManager),
				requests: throwing.mock.calls.length,
				warned: warn.mock.calls.filter(([message]) => message === "Append admission wait failed"),
			}).toEqual({
				toolRuns: 1,
				saved: [{ content: TOOL_OUTPUT, isError: false }],
				requests: 2,
				warned: [["Append admission wait failed", { error: String(storage.failure) }]],
			});
		} finally {
			warn.mockRestore();
		}
	});
});
