import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AdvisorOutputQuarantinedError, AdvisorRuntime } from "@oh-my-pi/pi-coding-agent/advisor/runtime";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { COLLECT_DEADLINE_MS, collected } from "./helpers/gc";

/** Bound on one idle drain, session transition, or fixture release on this small session file. */
const SETTLE_TIMEOUT_MS = 5_000;
/**
 * Bound on `AgentSession.dispose()`, whose own drains stop after 5 s (post-prompt tasks), 3 s (auto-learn
 * capture), 3 s (owned tabs, computer sessions and MCP, in parallel) and 5 s (the run settling).
 */
const DISPOSE_TIMEOUT_MS = 20_000;
/** A test's releases run one after another: the session's dispose and at most four more, each within its bound. */
const RELEASE_ALL_TIMEOUT_MS = DISPOSE_TIMEOUT_MS + 4 * SETTLE_TIMEOUT_MS;
/** Setup opens the auth store and, when a step fails, releases what it acquired; teardown releases everything. */
const HOOK_TIMEOUT_MS = SETTLE_TIMEOUT_MS + RELEASE_ALL_TIMEOUT_MS + 5_000;

/**
 * File storage that counts the bytes the session layer hands it — whole-body
 * publishes plus appended lines — and can fail one append, the way a full or
 * read-only disk refuses a write.
 */
class InstrumentedFileSessionStorage extends FileSessionStorage {
	bytesWritten = 0;
	/** The next appended line containing this text throws instead of landing. */
	failNextAppendContaining: string | undefined;

	override writeTextSync(filePath: string, content: string, options?: SessionStorageWriteOptions): void {
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		super.writeTextSync(filePath, content, options);
	}

	override writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.bytesWritten += Buffer.byteLength(content, "utf8");
		return super.writeTextAtomic(filePath, content, options);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		const admit = (line: string): void => {
			const marker = this.failNextAppendContaining;
			if (marker !== undefined && line.includes(marker)) {
				this.failNextAppendContaining = undefined;
				throw new Error("injected append failure");
			}
			this.bytesWritten += Buffer.byteLength(line, "utf8");
		};
		return {
			append: line => {
				admit(line);
				return writer.append(line);
			},
			appendSync: line => {
				admit(line);
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
}

/**
 * Regression: the per-turn supersede/useless prune pass rewrote the LIVE agent
 * context but never persisted the rewrite, so the session file kept the
 * original (un-pruned) history. Anything that rebuilds from the file — `/tan`
 * and `/fork` clones, session resume — then produced a divergent, larger
 * prefix and cold-missed the provider prompt cache the parent had populated.
 *
 * Contract: after the prune fires, rebuilding the session from disk yields the
 * same message content as the live agent state.
 */
describe("AgentSession per-turn prune persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let storage: InstrumentedFileSessionStorage;
	let authStorage: AuthStorage;

	const BIG_CALL_ID = "call-big-useless";
	const ADVISOR_REPLY = "ADVISOR_REPLY_SENTINEL";
	let advisorRequests: Context[];

	/**
	 * What the running test acquired. Disposing it releases each resource newest first, every one even
	 * after an earlier release failed; each release is bounded, so one that hangs still lets the others run.
	 */
	let resources: AsyncDisposableStack;

	beforeEach(async () => {
		// A failed setup releases what it acquired here: Bun may skip `afterEach` for a failed `beforeEach`.
		await using acquired = new AsyncDisposableStack();
		resources = acquired;
		await createFixture();
		resources = acquired.move();
	}, HOOK_TIMEOUT_MS);

	afterEach(() => resources.disposeAsync(), HOOK_TIMEOUT_MS);

	async function createFixture(): Promise<void> {
		const dir = TempDir.createSync("@pi-prune-persistence-");
		tempDir = dir;
		resources.defer(() => withTimeout(dir.remove(), SETTLE_TIMEOUT_MS, "Timed out removing the temp directory"));
		const auth = await AuthStorage.create(path.join(dir.path(), "testauth.db"));
		authStorage = auth;
		resources.defer(() => auth.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		storage = new InstrumentedFileSessionStorage();
		const manager = SessionManager.create(dir.path(), dir.path(), storage);
		sessionManager = manager;
		// Recorded before the session exists, so a session constructor that throws still closes the manager.
		resources.defer(() => withTimeout(manager.close(), SETTLE_TIMEOUT_MS, "Timed out closing the session manager"));

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const now = Date.now();
		const usageZero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: BIG_CALL_ID, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp: now - 180,
		});
		// The only prune candidate: a big result flagged useless whose suffix
		// stays inside the cache-warm window, so the pass rewrites it.
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: BIG_CALL_ID,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }],
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Nothing relevant found; moving on." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usageZero,
			timestamp: now - 160,
		});

		const primary = createMockModel({ provider: "anthropic", handler: { content: ["Primary step done."] } });
		const advisorModel = createMockModel({ provider: "anthropic", handler: { content: [ADVISOR_REPLY] } });
		advisorRequests = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: primary.stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
			}),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (streamModel, context, options) => {
				advisorRequests.push({
					systemPrompt: context.systemPrompt?.slice(),
					messages: structuredClone(context.messages),
				});
				return advisorModel.stream(streamModel, context, options);
			},
			// Enough for `#withEvalStateContext` to append its synthetic message
			// once the history holds an `eval` call.
			evalToolSession: {
				cwd: dir.path(),
				getEvalSessionId: () => "prune-persistence-eval",
			} as unknown as ToolSession,
		});
		session = created;
		resources.defer(() => withTimeout(created.dispose(), DISPOSE_TIMEOUT_MS, "Timed out disposing the session"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	function liveResultText(toolCallId = BIG_CALL_ID): string {
		const message = session.agent.state.messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error("Expected the seeded tool result in live agent state");
		}
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected text content on the seeded tool result");
		return text.text;
	}

	/** Text content of the tool result answering `toolCallId` among `messages`. */
	function resultTextIn(messages: readonly AgentMessage[], toolCallId: string): string | undefined {
		const result = messages.find(candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId);
		if (result?.role !== "toolResult" || !Array.isArray(result.content)) {
			throw new Error(`Expected tool result ${toolCallId} in the rebuilt messages`);
		}
		const text = result.content.find(block => block.type === "text");
		return text?.type === "text" ? text.text : undefined;
	}

	function persistedSessionFile(): string {
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return sessionFile;
	}

	/** Text of a tool result in a fresh session rebuilt from the file, as resume sees it. */
	async function rebuiltResultText(toolCallId = BIG_CALL_ID): Promise<string | undefined> {
		const reloaded = await SessionManager.open(persistedSessionFile(), tempDir.path());
		return resultTextIn(reloaded.buildSessionContext().messages, toolCallId);
	}

	/**
	 * Text of a tool result as each reader that loads the whole session file
	 * sees it: resume, `/fork`/`/tan`, `history://` for a parked agent, and the
	 * HTML export of the same file as a subagent transcript.
	 */
	async function wholeFileReaderTexts(toolCallId = BIG_CALL_ID): Promise<Record<string, string | undefined>> {
		const sessionFile = persistedSessionFile();
		const forked = await SessionManager.forkFrom(
			sessionFile,
			tempDir.path(),
			path.join(tempDir.path(), "fork"),
			undefined,
			{ copyArtifacts: false, suppressBreadcrumb: true },
		);
		const parentFile = path.join(tempDir.path(), "export", "parent.jsonl");
		fs.mkdirSync(path.join(tempDir.path(), "export", "parent"), { recursive: true });
		fs.copyFileSync(sessionFile, path.join(tempDir.path(), "export", "parent", "Helper.jsonl"));
		const subSession = (await collectSubSessions(parentFile)).Helper;
		if (!subSession) throw new Error("Expected the copied session as an exported subagent transcript");
		const exported = subSession.entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
		return {
			resume: await rebuiltResultText(toolCallId),
			fork: resultTextIn(forked.buildSessionContext().messages, toolCallId),
			readOnly: resultTextIn(await loadSessionMessagesReadOnly(sessionFile), toolCallId),
			htmlSubSession: resultTextIn(exported, toolCallId),
		};
	}

	/** Ends a turn outside the agent loop; its agent end runs the per-turn prune pass. */
	async function endTurn(): Promise<void> {
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	it("persists the prune so every whole-file reader rebuilds the live context", async () => {
		await endTurn();

		// The per-turn pass rewrote the live context…
		expect(liveResultText()).toBe(USELESS_NOTICE);

		// …and every reader of the persisted file must rebuild the SAME content:
		// a divergent fork/resume prefix cold-misses the provider cache, and a
		// parked agent's `history://` or its exported transcript would show the
		// stale output.
		await sessionManager.flush();
		expect(await wholeFileReaderTexts()).toEqual({
			resume: USELESS_NOTICE,
			fork: USELESS_NOTICE,
			readOnly: USELESS_NOTICE,
			htmlSubSession: USELESS_NOTICE,
		});
	});

	it("persists a prune in bytes that do not grow with the transcript", async () => {
		// Regression: the pass republished the whole session file for every
		// prune, so a small tool call on a long session wrote the entire
		// transcript again (tens of MiB per turn on real sessions).
		const lateCallId = "call-late-useless";
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: `history line ${i}\n`.repeat(50_000),
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `Noted part ${i}.` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
		// The turn's only prune candidate sits in the cache-warm tail.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: lateCallId, name: "grep", arguments: { pattern: "FIXME" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: lateCallId,
			toolName: "grep",
			content: [{ type: "text", text: "late match\n".repeat(20000) }],
			isError: false,
			useless: true,
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.flush();
		const sessionFile = persistedSessionFile();
		const transcriptBytes = fs.statSync(sessionFile).size;
		expect(transcriptBytes).toBeGreaterThan(2 * 1024 * 1024);

		storage.bytesWritten = 0;
		await endTurn();
		await sessionManager.flush();

		expect(liveResultText(lateCallId)).toBe(USELESS_NOTICE);
		// The turn wrote its own entries and the prune record. A whole-file
		// publish writes at least the file it publishes (the pre-turn transcript
		// is no bound: that publish drops the pruned body).
		expect(storage.bytesWritten).toBeLessThan(fs.statSync(sessionFile).size);
		expect(await rebuiltResultText(lateCallId)).toBe(USELESS_NOTICE);
	});

	it("settles the run and lands the prune durably after its write fails", async () => {
		storage.failNextAppendContaining = "tool_result_prune";
		const persistenceErrors: string[] = [];
		const unsubscribePersistence = sessionManager.onPersistenceError(error => persistenceErrors.push(error.message));
		const runStates: string[] = [];
		const unsubscribeRunState = session.subscribeRunState(state => runStates.push(state));
		const settles: boolean[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") settles.push(event.isTerminal !== false);
		});
		try {
			await endTurn();

			// The run reports idle and publishes one terminal settle, so the UI
			// stops its working indicator instead of spinning forever, and the
			// failed write reaches the persistence-error surface.
			expect(runStates).toEqual(["idle"]);
			expect(settles).toEqual([true]);
			expect(persistenceErrors).toEqual(["injected append failure"]);
			expect(liveResultText()).toBe(USELESS_NOTICE);

			// The next entry recovers the store, and the file then rebuilds to
			// the live (pruned) context.
			sessionManager.appendCustomEntry("prune-persistence-probe");
			await sessionManager.flush();
			expect(await rebuiltResultText()).toBe(USELESS_NOTICE);
		} finally {
			unsubscribe();
			unsubscribeRunState();
			unsubscribePersistence();
		}
	});

	describe("advisor across the per-turn prune", () => {
		const usage = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		function assistant(content: Array<Record<string, unknown>>): AgentMessage {
			return {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
				usage,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		function toolResult(toolCallId: string, toolName: string, text: string, useless = false): AgentMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				useless,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		/** Commits a turn outside the agent loop (no advisor review); its agent end runs the prune pass. */
		async function commitUnreviewedTurn(messages: AgentMessage[]): Promise<void> {
			for (const message of messages) session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages });
			await session.waitForIdle();
		}

		/** A real primary turn: its turn end renders the next advisor delta, its agent end runs the prune pass. */
		async function reviewedTurn(text: string): Promise<void> {
			await session.agent.prompt(text);
			await session.waitForIdle();
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		}

		function enableAdvisor(): void {
			session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
			expect(session.setAdvisorEnabled(true)).toBe(true);
		}

		async function withPrefixResetCount(run: () => Promise<void>): Promise<number> {
			const debug = vi.spyOn(logger, "debug");
			try {
				await run();
				return debug.mock.calls.filter(
					([message, details]) =>
						message === "advisor context reset" &&
						(details as { reason?: string } | undefined)?.reason === "delivered-prefix-changed",
				).length;
			} finally {
				debug.mockRestore();
			}
		}

		/** The advisor kept its own history and was not re-sent the transcript it never needed. */
		function expectLastReviewIncremental(): void {
			const request = JSON.stringify(advisorRequests.at(-1)?.messages);
			expect(request).toContain(ADVISOR_REPLY);
			expect(request).not.toContain("Investigate every module of the project.");
		}

		it("reviews the step after a prune without re-priming or replaying the transcript", async () => {
			enableAdvisor();
			await reviewedTurn("turn one");
			// The prune elided a result the advisor was seeded past.
			expect(liveResultText()).toBe(USELESS_NOTICE);

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("treats a later equal clone of a pruned result as unchanged", async () => {
			enableAdvisor();
			await reviewedTurn("turn one");
			expect(liveResultText()).toBe(USELESS_NOTICE);
			// Context rebuilds (secret deobfuscation, display-context rebuilds) hand
			// the advisor equal clones instead of the objects it last saw, so the
			// comparison falls through to the fingerprint of the pruned content.
			session.agent.replaceMessages(structuredClone(session.agent.state.messages));

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("keeps the advisor's context across two prunes while the eval state message keeps its slot", async () => {
			enableAdvisor();
			// An `eval` call in history makes the next display-context rebuild append
			// an `eval-state-context` snapshot at the tail and persist it there.
			await commitUnreviewedTurn([
				assistant([{ type: "toolCall", id: "call-eval", name: "eval", arguments: { code: "1 + 1" } }]),
				toolResult("call-eval", "eval", "2"),
				assistant([{ type: "text", text: "Evaluated." }]),
			]);
			const tail = session.agent.state.messages.at(-1);
			expect(tail?.role === "custom" ? tail.customType : undefined).toBe("eval-state-context");
			const slot = session.agent.state.messages.length - 1;
			// Delivers the eval-state message at its current slot.
			await reviewedTurn("turn one");

			// Second prune: the persisted snapshot stays where it was sent; no copy moves to the tail.
			await commitUnreviewedTurn([
				assistant([{ type: "toolCall", id: "call-big-2", name: "grep", arguments: { pattern: "FIXME" } }]),
				toolResult("call-big-2", "grep", "other line\n".repeat(20000), true),
				assistant([{ type: "text", text: "Nothing there either." }]),
			]);
			const snapshots = session.agent.state.messages.flatMap((message, index) =>
				message.role === "custom" && message.customType === "eval-state-context" ? [index] : [],
			);
			expect(snapshots).toEqual([slot]);

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("still resets when a delivered message the prune did not elide was replaced", async () => {
			const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });
			const messages: AgentMessage[] = [
				user("delivered one"),
				toolResult("call-a", "read", "file body"),
				user("delivered two"),
			];
			const runtime = new AdvisorRuntime(
				{ prompt: async () => {}, abort: () => {}, reset: () => {}, state: { messages: [] } },
				{ snapshotMessages: () => messages },
			);
			runtime.onTurnEnd(messages);
			await runtime.waitForCatchup(1_000, 1);
			// The prune elides the result (a fresh object after the rebuild) while
			// an unrelated rewrite replaced another delivered message.
			messages[1] = {
				...messages[1],
				content: [{ type: "text", text: USELESS_NOTICE }],
				prunedAt: Date.now(),
			} as AgentMessage;
			messages[2] = user("delivered two, edited");
			runtime.rebaseDeliveredPrefix("prune-tool-outputs");
			messages.push(user("next step"));

			const resets = await withPrefixResetCount(async () => {
				runtime.onTurnEnd(messages);
				await runtime.waitForCatchup(1_000, 1);
			});

			expect(resets).toBe(1);
			runtime.dispose();
		});

		it("re-primes a quarantined review from the pruned transcript, not the pre-prune snapshot", async () => {
			const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });
			const firstPrompt = Promise.withResolvers<void>();
			const firstPromptStarted = Promise.withResolvers<void>();
			const replay = Promise.withResolvers<string>();
			let promptCalls = 0;
			let current: AgentMessage[] = [
				user("delivered one"),
				assistant([{ type: "toolCall", id: "call-big", name: "grep", arguments: { pattern: "TODO" } }]),
				toolResult("call-big", "grep", "match line\n".repeat(30).trimEnd()),
			];
			const runtime = new AdvisorRuntime(
				{
					prompt: input => {
						promptCalls++;
						if (promptCalls === 1) {
							firstPromptStarted.resolve();
							return firstPrompt.promise;
						}
						replay.resolve(JSON.stringify(input));
						return Promise.resolve();
					},
					abort: () => {},
					reset: () => {},
					state: { messages: [] },
				},
				// The live session swaps in a new array on every rebuild; mirror that.
				{ snapshotMessages: () => current },
				0,
			);
			runtime.onTurnEnd(current);
			await firstPromptStarted.promise;
			// Queued while the first review is still running, so the quarantine re-primes.
			current = [...current, user("delivered two")];
			runtime.onTurnEnd(current);
			// The prune rebuilds the transcript into a fresh array with the result elided.
			current = current.map(message =>
				message.role === "toolResult"
					? ({
							...message,
							content: [{ type: "text", text: USELESS_NOTICE }],
							prunedAt: Date.now(),
						} as AgentMessage)
					: message,
			);
			runtime.rebaseDeliveredPrefix("prune-tool-outputs");

			firstPrompt.reject(new AdvisorOutputQuarantinedError("quarantined"));
			const replayed = await replay.promise;

			expect(replayed).toContain("⇒ ok · 1 line");
			expect(replayed).not.toContain("30 lines");
			runtime.dispose();
		});
	});

	/**
	 * The session keeps the tool calls before the compaction boundary, which
	 * the stale pass looks up for the results the compaction kept, in one cache
	 * across turns. Once the conversation ends, the session must let go of
	 * the entries it looked those calls up in.
	 */
	describe("across a compaction boundary", () => {
		const usage = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const fileBody = "export const value = 1;\n".repeat(200);

		function assistant(content: AssistantMessage["content"]): AssistantMessage {
			return {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
				usage,
				timestamp: Date.now(),
			};
		}

		function readCall(id: string, filePath: string): AssistantMessage {
			return assistant([{ type: "toolCall", id, name: "read", arguments: { path: filePath } }]);
		}

		function readResult(toolCallId: string): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: fileBody }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		/** Appends a compaction that keeps a read's result and summarizes away its call, and adopts the new context. */
		function compactAwayReadCall(): { callEntryId: string; keptId: string } {
			const callEntryId = sessionManager.appendMessage(readCall("call-kept", "src/a.ts"));
			const keptId = sessionManager.appendMessage(readResult("call-kept"));
			sessionManager.appendCompaction("Read src/a.ts.", undefined, keptId, 10_000);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			return { callEntryId, keptId };
		}

		/** Commits a turn outside the agent loop; its agent end runs the stale pass. */
		async function commitTurn(messages: AgentMessage[]): Promise<void> {
			for (const message of messages) session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages });
			await withTimeout(session.waitForIdle(), SETTLE_TIMEOUT_MS, "Timed out waiting for the stale pass to settle");
		}

		describe("when the conversation ends", () => {
			/** Kept out of the test body so no strong local binding outlives the capture. */
			function weakRefToEntry(id: string): WeakRef<object> {
				const entry = sessionManager.getEntry(id);
				if (!entry) throw new Error(`Expected entry ${id} on the branch`);
				return new WeakRef(entry);
			}

			/**
			 * Compacts away a kept read's call and commits a turn, whose stale pass looks that call up
			 * before the boundary; returns the call's entry, observed weakly.
			 */
			async function lookUpSummarizedAwayCall(): Promise<WeakRef<object>> {
				const { callEntryId } = compactAwayReadCall();
				await commitTurn([assistant([{ type: "text", text: "Read it." }])]);
				return weakRefToEntry(callEntryId);
			}

			/** A saved session in the same directory, for this one to resume in its place. */
			async function savedOtherSession(): Promise<string> {
				const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other-sessions"));
				resources.defer(() =>
					withTimeout(manager.close(), SETTLE_TIMEOUT_MS, "Timed out closing the other session's manager"),
				);
				manager.appendMessage({ role: "user", content: "Another conversation.", timestamp: Date.now() });
				await withTimeout(manager.ensureOnDisk(), SETTLE_TIMEOUT_MS, "Timed out saving the other session");
				const file = manager.getSessionFile();
				if (!file) throw new Error("Expected the other session's file");
				await withTimeout(manager.close(), SETTLE_TIMEOUT_MS, "Timed out closing the other session");
				return file;
			}

			/**
			 * Each way a conversation ends whose session lets go of the summarized-away entries, resolving
			 * whether it went through. `/clear` and a `/btw` branch keep those entries on the session's tree.
			 */
			const endings: Array<[name: string, end: () => Promise<boolean>]> = [
				["/new", () => session.newSession()],
				["a resume of another session", async () => session.switchSession(await savedOtherSession())],
				[
					"a branch from the first prompt",
					async () => {
						const branch = sessionManager.getBranch();
						const prompt = branch.find(entry => entry.type === "message" && entry.message.role === "user");
						if (!prompt) throw new Error("Expected the seeded prompt");
						return !(await session.branch(prompt.id)).cancelled;
					},
				],
				[
					"dispose",
					async () => {
						await session.dispose();
						return true;
					},
				],
			];

			for (const [name, end] of endings) {
				// A turn (SETTLE_TIMEOUT_MS, 5 s), the ending (DISPOSE_TIMEOUT_MS, 20 s), then collection
				// (COLLECT_DEADLINE_MS, 15 s): 45 s covers them.
				it(`releases the summarized-away call the stale pass looked up on ${name}`, async () => {
					const call = await lookUpSummarizedAwayCall();

					const ended = await withTimeout(end(), DISPOSE_TIMEOUT_MS, `Timed out ending the conversation: ${name}`);
					expect(ended).toBe(true);

					// Checked right after the ending, before a later pass could replace what the session cached.
					expect(await collected(call, COLLECT_DEADLINE_MS)).toBe(true);
				}, 45_000);
			}

			// A turn (SETTLE_TIMEOUT_MS, 5 s), the failed `/new` (DISPOSE_TIMEOUT_MS, 20 s), then collection
			// (COLLECT_DEADLINE_MS, 15 s): 45 s covers them.
			it("releases the summarized-away call the stale pass looked up when /new fails to save its new journal", async () => {
				const call = await lookUpSummarizedAwayCall();
				const failure = new Error("injected journal write failure");
				const ensureOnDisk = vi.spyOn(sessionManager, "ensureOnDisk").mockRejectedValue(failure);
				let outcome: unknown;
				try {
					outcome = await withTimeout(
						session.newSession().then(
							() => "started",
							(error: unknown) => error,
						),
						DISPOSE_TIMEOUT_MS,
						"Timed out on /new",
					);
				} finally {
					ensureOnDisk.mockRestore();
				}

				// The manager dropped the old conversation, then failed to write the new journal.
				expect(outcome).toBe(failure);
				expect(sessionManager.getBranch()).toEqual([]);
				expect(await collected(call, COLLECT_DEADLINE_MS)).toBe(true);
			}, 45_000);

			// Two turns and `/clear` between them, each within SETTLE_TIMEOUT_MS (5 s): 20 s covers them.
			it("leaves the history before /clear out of the passes after it", async () => {
				const { keptId } = compactAwayReadCall();
				await commitTurn([assistant([{ type: "text", text: "Read it." }])]);
				const reset = await withTimeout(session.resetSessionContext(), SETTLE_TIMEOUT_MS, "Timed out on /clear");
				expect(reset).toBeDefined();

				// src/a.ts is read again after `/clear`. The kept read before it no longer reaches the prompt, and
				// the compaction before `/clear` bounds nothing after it, so the newer read leaves the kept one alone.
				await commitTurn([
					readCall("call-newer", "src/a.ts"),
					readResult("call-newer"),
					assistant([{ type: "text", text: "Read it again." }]),
				]);

				const kept = sessionManager.getEntry(keptId);
				const keptMsg = kept?.type === "message" ? kept.message : undefined;
				expect(keptMsg).toMatchObject({ content: [{ type: "text", text: fileBody }] });
				expect(keptMsg && "prunedAt" in keptMsg ? keptMsg.prunedAt : undefined).toBeUndefined();
			}, 20_000);
		});
	});
});
