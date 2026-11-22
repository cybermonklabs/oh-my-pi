/**
 * A label the user puts on an entry from `/tree` is the branch's leaf until the next entry. A copy of the branch into a
 * new file (`/fork <entry>`, `/branch`, a promoted `/btw` answer) leaves the label entries out and re-creates the labels
 * of the entries it keeps under new ids. The copy must still hold the conversation through an entry written after a
 * label, and every record and event that names where the branch stands must name an entry the copy holds: the cut
 * rule's wait on a model-summary compaction, its refusal of a snapcompact archive, and `session_before_branch`'s
 * `entryId`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createInMemoryAuthStorage, sessionContextTokens } from "./helpers/agent-session-setup";
import { gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured thresholds, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(64);

function usage(tokens: Pick<Usage, "cacheRead" | "cacheWrite">): Usage {
	return {
		input: 1,
		output: 1,
		...tokens,
		totalTokens: 2 + tokens.cacheRead + tokens.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The role and text of each message a context holds. */
function transcriptOf(messages: readonly { role: string; content?: unknown }[]): string[] {
	return messages.map(message => {
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("")
					: "";
		return `${message.role}: ${text}`;
	});
}

describe("a copy of a branch whose leaf was a label", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts no background summary in a process that resumes a /fork copy of a wait answered at a label", async () => {
		/** The threshold of the first two processes sits this far above the transcript's context. */
		const LABELLED_MARGIN = 20_000;
		/** The threshold of the process on the copy sits this far above its context: only a wait keeps a summary off. */
		const BAND_MARGIN = 4_000;
		using tempDir = TempDir.createSync("@pi-labelled-leaf-wait-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(CONTEXT_WINDOW));
		const messages = transcript();
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const options = {
			...gatewaySessionOptions(tempDir),
			authStorage,
			modelRegistry,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		};
		const longPrompt = `second prompt ${FILLER.repeat(30)}`;
		try {
			const { session: sizing } = await createAgentSession({
				...options,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings: processSettings(CONTEXT_WINDOW / 2),
			});
			const contextTokens = sessionContextTokens(sizing, messages);
			const longPromptTokens = sizing.agent.tokenizer.countTokens([longPrompt]);
			await sizing.dispose();
			// Precondition: the long prompt carries the context past the first threshold.
			expect(longPromptTokens).toBeGreaterThan(LABELLED_MARGIN);

			// The first process: its reply writes the whole context to a one-hour entry, below the threshold. It exits.
			const live = recordGateway(contextTokens);
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			for (const message of messages) sessionManager.appendMessage(message);
			const { session: first } = await createAgentSession({
				...options,
				sessionManager,
				settings: processSettings(contextTokens + LABELLED_MARGIN),
			});
			try {
				await live.send(first, "first prompt");
				await sessionManager.flush();
			} finally {
				await first.dispose();
				live.restore();
			}
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected the session file");

			// A second process resumes it; the user labels the newest reply in /tree and sends a long prompt. The rule
			// answers "waits" before the prompt goes out, the label being the branch's leaf. It exits.
			const second = recordGateway(contextTokens);
			const secondManager = await SessionManager.open(file);
			const { session: resumed } = await createAgentSession({
				...options,
				sessionManager: secondManager,
				settings: processSettings(contextTokens + LABELLED_MARGIN),
			});
			try {
				const reply = secondManager.getBranch().findLast(entry => entry.type === "message");
				if (!reply) throw new Error("Expected the newest reply");
				const labelId = secondManager.appendLabelChange(reply.id, "ready");
				await second.send(resumed, longPrompt);
				await secondManager.flush();
				// Preconditions: the rule waited before the main request, and its record follows the label.
				expect(second.timeline.slice(0, second.timeline.indexOf("main request"))).toContain(
					SUMMARY_COMPACTION_WAITS,
				);
				const waits = secondManager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "compaction-wait");
				expect(waits.map(entry => entry.parentId)).toEqual([labelId]);
			} finally {
				await resumed.dispose();
				second.restore();
			}

			// A third process resumes it and, before it sends anything, forks it at the newest reply.
			const forking = recordGateway(contextTokens);
			const forkingManager = await SessionManager.open(file);
			const { session: forkingSession } = await createAgentSession({
				...options,
				sessionManager: forkingManager,
				settings: processSettings(contextTokens + longPromptTokens + BAND_MARGIN),
			});
			let copyFile: string | undefined;
			try {
				const reply = forkingManager.getBranch().findLast(entry => entry.type === "message");
				if (!reply) throw new Error("Expected the newest reply");
				expect(await forkingSession.fork(reply.id)).toBe(true);
				copyFile = forkingManager.getSessionFile();
				await forkingManager.flush();
			} finally {
				await forkingSession.dispose();
				forking.restore();
			}
			if (!copyFile) throw new Error("Expected the copy's session file");
			// Precondition: the third process sent nothing.
			expect(forking.requests).toHaveLength(0);

			// omp restarts on the copy a moment later, the context in the band below the threshold where only the wait
			// keeps a background summary from being requested.
			const copy = recordGateway(contextTokens);
			const { session: restarted } = await createAgentSession({
				...options,
				sessionManager: await SessionManager.open(copyFile),
				settings: processSettings(contextTokens + longPromptTokens + BAND_MARGIN),
			});
			try {
				await copy.send(restarted, "resumed prompt");
				expect({
					main: copy.timeline.filter(entry => entry === "main request").length,
					summaries: copy.timeline.filter(entry => entry === "summary request").length,
				}).toEqual({ main: 1, summaries: 0 });
			} finally {
				await restarted.dispose();
				copy.restore();
			}
		} finally {
			authStorage.close();
		}
	}, 180_000);

	it("renders no archive in a process that resumes a /fork copy of a refusal weighed at a label", async () => {
		const THRESHOLD_TOKENS = 90_000;
		const GROWTH = 20_000;
		const SIZED_REPLIES = 3;
		// Every request throws: nothing here may reach a provider.
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				throw new Error(`Unexpected request to ${String(input)}`);
			}),
		);
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		const model: Model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		using tempDir = TempDir.createSync("@pi-labelled-leaf-refusal-");
		const sessions: AgentSession[] = [];
		const open = (sessionManager: SessionManager) => {
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager,
				settings: Settings.isolated({
					"compaction.methodOrder": ["snapcompact"],
					"compaction.autoContinue": false,
					"compaction.asyncEnabled": false,
					"compaction.keepRecentTokens": 4000,
					"compaction.thresholdTokens": THRESHOLD_TOKENS,
					"providers.cacheRetention": "long",
				}),
				modelRegistry,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			return session;
		};
		const close = async (session: AgentSession) => {
			sessions.splice(sessions.indexOf(session), 1);
			await session.dispose();
		};
		/** A reply whose request sent `promptTokens`, read from the cache; 0 for a reply that carries no prompt size. */
		const reply = (index: number, promptTokens: number, timestamp: number): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: `reply ${index}: ${FILLER}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 0,
				output: promptTokens > 0 ? 100 : 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens > 0 ? promptTokens + 100 : 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		});
		/** Settles the turn `final` ended, which runs the session's post-turn maintenance. */
		const endTurn = async (session: AgentSession, final: AgentMessage) => {
			session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
			await session.waitForIdle();
		};
		try {
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"), undefined, {
				suppressBreadcrumb: true,
			});
			const turns = 64;
			const now = Date.now();
			const messages: (UserMessage | AssistantMessage)[] = [];
			const earlier: AssistantMessage[] = [];
			for (let i = 0; i < turns; i++) {
				messages.push({
					role: "user",
					content: [{ type: "text", text: `turn ${i}: ${FILLER}` }],
					timestamp: now - (turns - i) * 1000,
				});
				const message = reply(i, 0, i < turns - 1 ? now - (turns - i) * 1000 + 100 : now);
				earlier.push(message);
				messages.push(message);
			}
			const final = earlier.pop();
			if (!final) throw new Error("Expected the final reply");
			const sizing = open(SessionManager.inMemory());
			sizing.agent.replaceMessages(messages);
			const before = sessionContextTokens(sizing, messages);
			await close(sizing);
			final.usage.cacheRead = before;
			final.usage.output = 100;
			final.usage.totalTokens = before + 100;
			for (let offset = 1; offset <= SIZED_REPLIES; offset++) {
				const sized = earlier[earlier.length - offset];
				sized.usage.cacheRead = before - offset * GROWTH;
				sized.usage.output = 100;
				sized.usage.totalTokens = sized.usage.cacheRead + 100;
			}
			for (const message of messages.slice(0, -1)) sessionManager.appendMessage(message);
			const render = vi.spyOn(snapcompact, "compact");

			// The first process: the final reply lands, the user labels it before the turn settles, and the turn's pass
			// renders an archive the cut rule refuses. It exits.
			const first = open(sessionManager);
			first.agent.emitExternalEvent({ type: "message_end", message: final });
			await first.waitForIdle();
			const finalId = sessionManager.getLeafId();
			if (!finalId) throw new Error("Expected the final reply's entry");
			const labelId = sessionManager.appendLabelChange(finalId, "ready");
			await endTurn(first, final);
			await sessionManager.flush();
			// Preconditions: one archive rendered, nothing committed, and the refusal's record follows the label.
			expect({
				renders: render.mock.calls.length,
				compacted: sessionManager.getBranch().some(entry => entry.type === "compaction"),
				refusals: sessionManager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "snapcompact-refusal")
					.map(entry => entry.parentId),
			}).toEqual({ renders: 1, compacted: false, refusals: [labelId] });
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected the session file");
			await close(first);

			// A second process resumes the session and forks it at the final reply before any maintenance point.
			const forkingManager = await SessionManager.open(file);
			const forking = open(forkingManager);
			expect(await forking.fork(finalId)).toBe(true);
			const copyFile = forkingManager.getSessionFile();
			if (!copyFile) throw new Error("Expected the copy's session file");
			await forkingManager.flush();
			await close(forking);

			// omp restarts on the copy: the same history and live entry, the same archive waiting on the same figures.
			const resumed = open(await SessionManager.open(copyFile));
			const starts: string[] = [];
			resumed.subscribe(event => {
				if (event.type === "auto_compaction_start") starts.push(event.action);
			});
			const last = resumed.agent.state.messages.findLast(message => message.role === "assistant");
			if (!last) throw new Error("Expected a reply in the copy's context");
			await endTurn(resumed, last);
			expect({ starts, renders: render.mock.calls.length }).toEqual({ starts: [], renders: 1 });
		} finally {
			for (const session of sessions.splice(0)) await session.dispose();
			authStorage.close();
		}
	}, 60_000);

	describe("the conversation and session_before_branch's entryId", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const sessions: AgentSession[] = [];
		const authStorages: AuthStorage[] = [];

		afterEach(async () => {
			for (const session of sessions.splice(0)) await session.dispose();
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		});

		/** A process on `sessionManager` whose `session_before_branch` hook records each event's `entryId`. */
		function open(sessionManager: SessionManager): { session: AgentSession; entryIds: string[] } {
			const entryIds: string[] = [];
			const extensionRunner = {
				hasHandlers: (eventType: string) => eventType === "session_before_branch",
				emit: async (event: { type: string; entryId?: string }) => {
					if (event.type === "session_before_branch" && event.entryId) entryIds.push(event.entryId);
					return undefined;
				},
			} as unknown as ExtensionRunner;
			const authStorage = createInMemoryAuthStorage();
			authStorages.push(authStorage);
			authStorage.keys.setRuntime("anthropic", "test-key");
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
				extensionRunner,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			return { session, entryIds };
		}

		/** A reply on the session's model. */
		function assistant(text: string): AssistantMessage {
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
				usage: usage({ cacheRead: 0, cacheWrite: 5_000 }),
			};
		}

		/** A warm refresh's usage, recorded under the branch's leaf as the session records it. */
		function appendWarmRefresh(sessionManager: SessionManager): void {
			sessionManager.appendModelUsage(
				{
					purpose: "cache-warm",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: usage({ cacheRead: 5_000, cacheWrite: 0 }),
					stopReason: "stop",
				},
				{ sessionId: sessionManager.getSessionId(), parentId: sessionManager.getLeafId() },
			);
		}

		it.each([
			{ leaf: "a warm refresh's usage after the label", after: appendWarmRefresh },
			{ leaf: "the label", after: () => {} },
		])("a promoted /btw answer from $leaf keeps the conversation", async ({ after }) => {
			using tempDir = TempDir.createSync("@pi-labelled-leaf-btw-");
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
			const replyId = sessionManager.appendMessage(assistant("the release is ready"));
			sessionManager.appendLabelChange(replyId, "ready");
			after(sessionManager);
			const { session, entryIds } = open(sessionManager);
			const leafId = sessionManager.getLeafId();
			if (!leafId) throw new Error("Expected a leaf");

			const promoted = await session.branchFromBtw(
				"why is it ready?",
				assistant("every check passed"),
				leafId,
				sessionManager.getSessionId(),
			);
			expect(promoted.cancelled).toBe(false);
			const [entryId] = entryIds;
			expect({
				copy: transcriptOf(session.buildDisplaySessionContext().messages),
				sent: transcriptOf(session.agent.state.messages),
				hookEntryHeld: entryId !== undefined && sessionManager.getEntry(entryId) !== undefined,
				label: sessionManager.getLabel(replyId),
			}).toEqual({
				copy: [
					"user: check the release",
					"assistant: the release is ready",
					"user: why is it ready?",
					"assistant: every check passed",
				],
				sent: [
					"user: check the release",
					"assistant: the release is ready",
					"user: why is it ready?",
					"assistant: every check passed",
				],
				hookEntryHeld: true,
				label: "ready",
			});
		});

		it("/branch at a prompt sent after a label and a warm refresh keeps the conversation before it", async () => {
			using tempDir = TempDir.createSync("@pi-labelled-leaf-branch-");
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 2_000 });
			const replyId = sessionManager.appendMessage(assistant("the release is ready"));
			sessionManager.appendLabelChange(replyId, "ready");
			appendWarmRefresh(sessionManager);
			const promptId = sessionManager.appendMessage({
				role: "user",
				content: "ship it",
				timestamp: Date.now() - 1_000,
			});
			sessionManager.appendMessage(assistant("shipped"));
			const { session } = open(sessionManager);

			const result = await session.branch(promptId);
			expect(result.cancelled).toBe(false);
			const copyFile = sessionManager.getSessionFile();
			if (!copyFile) throw new Error("Expected the copy's session file");
			await sessionManager.flush();
			const resumed = open(await SessionManager.open(copyFile)).session;
			expect({
				copy: transcriptOf(session.buildDisplaySessionContext().messages),
				resumed: transcriptOf(resumed.buildDisplaySessionContext().messages),
			}).toEqual({
				copy: ["user: check the release", "assistant: the release is ready"],
				resumed: ["user: check the release", "assistant: the release is ready"],
			});
		});

		it("/fork at a labelled newest reply names that reply as the last entry kept", async () => {
			using tempDir = TempDir.createSync("@pi-labelled-leaf-fork-");
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
			const replyId = sessionManager.appendMessage(assistant("the release is ready"));
			sessionManager.appendLabelChange(replyId, "ready");
			const { session, entryIds } = open(sessionManager);

			expect(await session.fork(replyId)).toBe(true);
			expect({ entryIds, held: sessionManager.getEntry(replyId)?.type }).toEqual({
				entryIds: [replyId],
				held: "message",
			});
		});
	});
});
