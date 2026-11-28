import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { PrefixToolCallCache } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AdvisorOutputQuarantinedError, AdvisorRuntime } from "@oh-my-pi/pi-coding-agent/advisor/runtime";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/** Bound on one idle drain, journal rewrite, session transition, or fixture release on this small session file. */
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
	let authStorage: AuthStorage;

	const BIG_CALL_ID = "call-big-useless";
	const ADVISOR_REPLY = "ADVISOR_REPLY_SENTINEL";
	let advisorRequests: Context[];

	/** Each acquired resource's release, recorded as it is acquired; {@link releaseAll} runs them newest first. */
	const releases: Array<() => Promise<unknown>> = [];

	/** Records `release` for teardown, bounded so a release that hangs still lets the others run. */
	function releaseOnTeardown(label: string, release: () => unknown, timeoutMs = SETTLE_TIMEOUT_MS): void {
		// Async, so a release that throws synchronously rejects like one that fails later.
		releases.push(async () => {
			await withTimeout(Promise.resolve(release()), timeoutMs, `Timed out releasing ${label}`);
		});
	}

	/**
	 * Runs every recorded release, newest first, each even when an earlier one failed; then throws
	 * `failures` and theirs together.
	 */
	async function releaseAll(failures: unknown[] = []): Promise<void> {
		for (const release of releases.splice(0).reverse()) {
			try {
				await release();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "The prune persistence fixture failed");
	}

	beforeEach(async () => {
		try {
			await createFixture();
		} catch (error) {
			// Bun may skip `afterEach` for a failed `beforeEach`: release what was acquired here.
			await releaseAll([error]);
		}
	}, HOOK_TIMEOUT_MS);

	afterEach(() => releaseAll(), HOOK_TIMEOUT_MS);

	async function createFixture(): Promise<void> {
		const dir = TempDir.createSync("@pi-prune-persistence-");
		tempDir = dir;
		releaseOnTeardown("the temp directory", () => dir.remove());
		const auth = await AuthStorage.create(path.join(dir.path(), "testauth.db"));
		authStorage = auth;
		releaseOnTeardown("the auth storage", () => auth.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(dir.path(), dir.path());
		sessionManager = manager;
		// Recorded before the session exists, so a session constructor that throws still closes the manager.
		releaseOnTeardown("the session manager", () => manager.close());

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
		releaseOnTeardown("the session", () => created.dispose(), DISPOSE_TIMEOUT_MS);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	function liveResultText(): string {
		const message = session.agent.state.messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === BIG_CALL_ID,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error("Expected the seeded tool result in live agent state");
		}
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected text content on the seeded tool result");
		return text.text;
	}

	it("persists the pruned rewrite so a from-disk rebuild matches the live context", async () => {
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

		// The per-turn pass rewrote the live context…
		expect(liveResultText()).toBe(USELESS_NOTICE);

		// …and the persisted file must rebuild to the SAME content (fork/resume
		// read this file; a divergent prefix cold-misses the provider cache).
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		const rebuilt = reloaded
			.buildSessionContext()
			.messages.find(candidate => candidate.role === "toolResult" && candidate.toolCallId === BIG_CALL_ID);
		if (rebuilt?.role !== "toolResult" || !Array.isArray(rebuilt.content)) {
			throw new Error("Expected the seeded tool result in the from-disk rebuild");
		}
		const rebuiltText = rebuilt.content.find(block => block.type === "text");
		expect(rebuiltText?.type === "text" ? rebuiltText.text : undefined).toBe(USELESS_NOTICE);
	});

	it("settles the run and restores the result when persisting the prune fails", async () => {
		const rewriteEntries = vi
			.spyOn(sessionManager, "rewriteEntries")
			.mockRejectedValueOnce(new Error("injected rewrite failure"));
		const runStates: string[] = [];
		const unsubscribeRunState = session.subscribeRunState(state => runStates.push(state));
		const settles: string[] = [];
		const notices: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end" || event.type === "agent_pause") settles.push(event.type);
			if (event.type === "notice") notices.push(event.message);
		});
		try {
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

			// The loop end opens the run it ends: the run reports idle and publishes one
			// agent_end, so the UI stops its working indicator instead of spinning forever.
			expect(rewriteEntries).toHaveBeenCalledTimes(1);
			expect(runStates).toEqual(["running", "idle"]);
			expect(settles).toEqual(["agent_end"]);
			expect(notices.some(message => message.includes("injected rewrite failure"))).toBe(true);
			// The blanked result was restored: live context matches durable history.
			expect(liveResultText()).toBe("match line\n".repeat(20000));
			const entry = sessionManager
				.getBranch()
				.find(candidate => candidate.type === "message" && candidate.message.role === "toolResult");
			expect(entry?.type === "message" ? entry.message : undefined).toMatchObject({
				content: [{ type: "text", text: "match line\n".repeat(20000) }],
				prunedAt: undefined,
			});
		} finally {
			unsubscribe();
			unsubscribeRunState();
			rewriteEntries.mockRestore();
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
	 * The stale pass keeps the calls the latest compaction summarized away
	 * across turns. Once the session rewrites one of them in place, the next
	 * pass must pair the kept result with the call as rewritten: a stale call
	 * keys the result by the file it no longer shows, and a newer read of that
	 * file blanks it. Once the conversation ends, the session must keep none of
	 * those calls.
	 */
	describe("across a compaction boundary", () => {
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
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

		function readCall(toolCallId: string, path: string): AssistantMessage {
			return assistant([{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }]);
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

		// Two turns and a journal rewrite, each bounded by SETTLE_TIMEOUT_MS (5 s): 20 s covers them.
		it("pairs a kept read with its summarized-away call as the session rewrote it", async () => {
			const { callEntryId, keptId } = compactAwayReadCall();
			// Nothing reads src/a.ts again yet: the stale pass pairs the kept result with that call and keeps it.
			await commitTurn([assistant([{ type: "text", text: "Read it." }])]);

			// The session rewrites that call in place to read src/b.ts; then src/a.ts is read again.
			const callEntry = sessionManager.getEntry(callEntryId);
			if (callEntry?.type !== "message") throw new Error("Expected the kept read's call entry");
			callEntry.message = readCall("call-kept", "src/b.ts");
			await withTimeout(sessionManager.rewriteEntries(), SETTLE_TIMEOUT_MS, "Timed out rewriting the journal");
			await commitTurn([
				readCall("call-newer", "src/a.ts"),
				readResult("call-newer"),
				assistant([{ type: "text", text: "Read it again." }]),
			]);

			// The kept result shows src/b.ts, so the newer read of src/a.ts leaves it in context.
			const kept = sessionManager.getEntry(keptId);
			const keptMsg = kept?.type === "message" ? kept.message : undefined;
			expect(keptMsg).toMatchObject({ content: [{ type: "text", text: fileBody }] });
			expect(keptMsg && "prunedAt" in keptMsg ? keptMsg.prunedAt : undefined).toBeUndefined();
		}, 20_000);

		describe("when the conversation ends", () => {
			/**
			 * Compacts away a kept read's call and commits a turn, whose stale pass looks that call up
			 * before the boundary; returns the session's prefix cache, which then holds the calls there.
			 */
			async function indexSummarizedAwayCall(): Promise<PrefixToolCallCache> {
				const caches = new Set<PrefixToolCallCache>();
				const get = PrefixToolCallCache.prototype.get;
				const spy = vi.spyOn(PrefixToolCallCache.prototype, "get").mockImplementation(function (
					this: PrefixToolCallCache,
					...args
				) {
					caches.add(this);
					return get.apply(this, args);
				});
				try {
					compactAwayReadCall();
					await commitTurn([assistant([{ type: "text", text: "Read it." }])]);
				} finally {
					spy.mockRestore();
				}
				// Every pass of a session looks its prefix calls up in that session's one cache.
				const [cache, ...others] = caches;
				if (!cache || others.length > 0) throw new Error(`Expected one prefix cache, saw ${caches.size}`);
				// The summarized-away prefix holds the seeded grep call and the kept read's call.
				expect(cache.size).toBe(2);
				return cache;
			}

			/** A saved session in the same directory, for this one to resume in its place. */
			async function savedOtherSession(): Promise<string> {
				const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other-sessions"));
				releaseOnTeardown("the other session's manager", () => manager.close());
				manager.appendMessage({ role: "user", content: "Another conversation.", timestamp: Date.now() });
				await withTimeout(manager.ensureOnDisk(), SETTLE_TIMEOUT_MS, "Timed out saving the other session");
				const file = manager.getSessionFile();
				if (!file) throw new Error("Expected the other session's file");
				await withTimeout(manager.close(), SETTLE_TIMEOUT_MS, "Timed out closing the other session");
				return file;
			}

			/** Each way a conversation ends, resolving whether it went through. */
			const endings: Array<[name: string, end: () => Promise<boolean>]> = [
				["/new", () => session.newSession()],
				["/clear", async () => (await session.resetSessionContext()) !== undefined],
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
					"a /btw branch",
					async () => {
						const leafId = sessionManager.getLeafId();
						if (!leafId) throw new Error("Expected a leaf to branch /btw from");
						const answer = assistant([{ type: "text", text: "Because." }]);
						const sessionId = sessionManager.getSessionId();
						return !(await session.branchFromBtw("Why?", answer, leafId, sessionId)).cancelled;
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
				// A turn (SETTLE_TIMEOUT_MS, 5 s), then the ending (DISPOSE_TIMEOUT_MS, 20 s): 30 s covers them.
				it(`drops the summarized-away calls the session cached on ${name}`, async () => {
					const cache = await indexSummarizedAwayCall();

					const ended = await withTimeout(end(), DISPOSE_TIMEOUT_MS, `Timed out ending the conversation: ${name}`);
					expect(ended).toBe(true);

					// Read right after the ending, before any later pass could replace the cached prefix.
					expect(cache.size).toBe(0);
				}, 30_000);
			}
		});
	});
});
