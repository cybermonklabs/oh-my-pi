/**
 * An automatic snapcompact pass the cut rule refused is weighed again by its figures on every branch that carries the
 * leaf it was weighed on. The record of the refusal sits after that leaf on the branch current then, so a branch
 * continued from the leaf itself (`/tree` to it) carries the leaf but not the record: a process that resumes the
 * session on that branch must still weigh the refusal, as the process that refused does, instead of rendering the
 * archive again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

/** A 400,000-token window: its prompt budget is 340,000 tokens, far above the configured threshold. */
const CONTEXT_WINDOW = 400_000;
const THRESHOLD_TOKENS = 90_000;
/** Each of the last main requests' prompts grew this much over the one before it. */
const GROWTH = 20_000;
/** How many replies before the final one say what their request sent. */
const SIZED_REPLIES = 3;

describe("a snapcompact refusal on a branch continued from the leaf it was weighed on, after a restart", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	/** A reply whose request sent `promptTokens`, read from the cache; 0 for a reply that carries no prompt size. */
	function reply(model: Model, index: number, promptTokens: number, timestamp: number): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "text", text: `reply ${index}: ${"the quick brown fox jumps over the lazy dog. ".repeat(64)}` },
			],
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
		};
	}

	/** Ends a turn with `final`, which runs the session's post-turn maintenance. */
	async function endTurn(session: AgentSession, final: AgentMessage): Promise<void> {
		session.agent.emitExternalEvent({ type: "message_end", message: final });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();
	}

	/** The newest reply of the agent's context. */
	function lastReply(session: AgentSession): AgentMessage {
		const last = session.agent.state.messages.findLast(message => message.role === "assistant");
		if (!last) throw new Error("Expected a reply in the context");
		return last;
	}

	it("weighs the refusal and renders no archive at the resumed session's first maintenance point", async () => {
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		const model: Model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		const tempDir = TempDir.createSync("@pi-snapcompact-refusal-branch-resume-");
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
		try {
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"), undefined, {
				suppressBreadcrumb: true,
			});
			const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
			const turns = 64;
			const now = Date.now();
			const transcript: (UserMessage | AssistantMessage)[] = [];
			const earlier: AssistantMessage[] = [];
			for (let i = 0; i < turns; i++) {
				transcript.push({
					role: "user",
					content: [{ type: "text", text: `turn ${i}: ${filler}` }],
					timestamp: now - (turns - i) * 1000,
				});
				const message = reply(model, i, 0, i < turns - 1 ? now - (turns - i) * 1000 + 100 : now);
				earlier.push(message);
				transcript.push(message);
			}
			const final = earlier.pop();
			if (!final) throw new Error("Expected the final reply");

			// The final reply's request sent the whole context, read from a live one-hour entry; the last few
			// requests before it grew GROWTH tokens each.
			const sizing = open(SessionManager.inMemory());
			sizing.agent.replaceMessages(transcript);
			const before =
				computeNonMessageTokens(sizing, sizing.agent.tokenizer, sizing.settings.revision) +
				sizing.agent.tokenizer.countMessages(transcript, { excludeEncryptedReasoning: true });
			await sizing.dispose();
			sessions.splice(sessions.indexOf(sizing), 1);
			final.usage.cacheRead = before;
			final.usage.output = 100;
			final.usage.totalTokens = before + 100;
			for (let offset = 1; offset <= SIZED_REPLIES; offset++) {
				const sized = earlier[earlier.length - offset];
				sized.usage.cacheRead = before - offset * GROWTH;
				sized.usage.output = 100;
				sized.usage.totalTokens = sized.usage.cacheRead + 100;
			}
			for (const message of transcript) sessionManager.appendMessage(message);
			const first = open(sessionManager);

			const render = vi.spyOn(snapcompact, "compact");
			const compacted = (manager: SessionManager) =>
				manager.getBranch().some(branchEntry => branchEntry.type === "compaction");

			// The pass starts and renders, and the archive it rendered does not pay for rewriting itself and the kept
			// turns: the cut rule refuses it, and the refusal is recorded after the final reply.
			await endTurn(first, final);
			expect({ renders: render.mock.calls.length, compacted: compacted(sessionManager) }).toEqual({
				renders: 1,
				compacted: false,
			});
			const refusal = sessionManager
				.getBranch()
				.find(entry => entry.type === "custom" && entry.customType === "snapcompact-refusal");
			const refusedLeaf = sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!refusal || !refusedLeaf) throw new Error("Expected the refusal and the reply it was weighed on");

			// `/tree` to the final reply itself: the branch carries the leaf the refusal was weighed on, not its
			// record. The process that refused weighs its figures there and renders nothing.
			await first.navigateTree(refusedLeaf.id);
			await endTurn(first, lastReply(first));
			expect(render.mock.calls.length).toBe(1);
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected the session's file");
			await sessionManager.flush();
			// The exit record continues the branch from the final reply.
			await first.dispose();
			sessions.splice(sessions.indexOf(first), 1);

			// omp restarts a moment later and resumes the session on that branch: the entry is as live and the
			// history the same, so the resumed process weighs the same figures and announces and renders nothing.
			const resumedManager = await SessionManager.open(sessionFile, tempDir.join("sessions"), undefined, {
				suppressBreadcrumb: true,
			});
			const resumedBranch = resumedManager.getBranch();
			expect({
				carriesLeaf: resumedBranch.some(entry => entry.id === refusedLeaf.id),
				carriesRecord: resumedBranch.some(entry => entry.id === refusal.id),
			}).toEqual({ carriesLeaf: true, carriesRecord: false });
			const resumed = open(resumedManager);
			const starts: string[] = [];
			resumed.subscribe(event => {
				if (event.type === "auto_compaction_start") starts.push(event.action);
			});
			await endTurn(resumed, lastReply(resumed));
			expect({ starts, renders: render.mock.calls.length, compacted: compacted(resumedManager) }).toEqual({
				starts: [],
				renders: 1,
				compacted: false,
			});
		} finally {
			for (const session of sessions.splice(0)) await session.dispose();
			await tempDir.remove();
		}
	}, 60_000);
});
