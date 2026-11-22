/**
 * Once the cut rule refused an automatic snapcompact archive, later maintenance points weigh what that archive would
 * leave before they start another pass, and the session keeps the refusal as a record after the reply the pass was
 * weighed on. `/fork` at that reply copies the branch up to it into a new file: this case forks a session right after a
 * refusal, restarts omp on the copy, and counts the archives the resumed process's first maintenance point renders.
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
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { sessionContextTokens } from "./helpers/agent-session-setup";

/** A 400,000-token window: its prompt budget is 340,000 tokens, far above the configured threshold. */
const CONTEXT_WINDOW = 400_000;
const THRESHOLD_TOKENS = 90_000;
/** Each of the last main requests' prompts grew this much over the one before it. */
const GROWTH = 20_000;
/** How many replies before the final one say what their request sent. */
const SIZED_REPLIES = 3;
const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(64);

describe("an automatic snapcompact pass the cut rule refused, across /fork at the newest message and a restart", () => {
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
		};
	}

	/** Ends a turn with `final`, which runs the session's post-turn maintenance. */
	async function endTurn(session: AgentSession, final: AgentMessage): Promise<void> {
		session.agent.emitExternalEvent({ type: "message_end", message: final });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();
	}

	it("renders no archive at the first maintenance point of a process that resumes the copy", async () => {
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		const model: Model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		using tempDir = TempDir.createSync("@pi-snapcompact-refusal-fork-restart-");
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
			const turns = 64;
			const now = Date.now();
			const transcript: (UserMessage | AssistantMessage)[] = [];
			const earlier: AssistantMessage[] = [];
			for (let i = 0; i < turns; i++) {
				transcript.push({
					role: "user",
					content: [{ type: "text", text: `turn ${i}: ${FILLER}` }],
					timestamp: now - (turns - i) * 1000,
				});
				const message = reply(model, i, 0, i < turns - 1 ? now - (turns - i) * 1000 + 100 : now);
				earlier.push(message);
				transcript.push(message);
			}
			const final = earlier.pop();
			if (!final) throw new Error("Expected the final reply");

			// The final reply's request sent the whole context, read from a live one-hour entry; the last few requests
			// before it grew GROWTH tokens each.
			const sizing = open(SessionManager.inMemory());
			sizing.agent.replaceMessages(transcript);
			const before = sessionContextTokens(sizing, transcript);
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
			const session = open(sessionManager);

			const render = vi.spyOn(snapcompact, "compact");

			// Precondition: the context (~93,000 tokens) is past the 90,000-token threshold and far below the prompt
			// budget, so the cut is not forced: the pass starts and renders, and the archive it rendered does not pay for
			// rewriting itself and the kept turns, so the cut rule refuses it and nothing is committed.
			await endTurn(session, final);
			expect({
				renders: render.mock.calls.length,
				compacted: sessionManager.getBranch().some(entry => entry.type === "compaction"),
			}).toEqual({
				renders: 1,
				compacted: false,
			});

			// The process forks the session at the reply the pass was weighed on, its newest message, and exits.
			const refusedLeaf = sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!refusedLeaf) throw new Error("Expected the reply the pass was weighed on");
			expect(await session.fork(refusedLeaf.id)).toBe(true);
			const copyFile = sessionManager.getSessionFile();
			if (!copyFile) throw new Error("Expected the copy's session file");
			await sessionManager.flush();
			await session.dispose();
			sessions.splice(sessions.indexOf(session), 1);

			// omp restarts on the copy a moment later. The copy holds the same history and the entry is as live: the
			// same archive waits on the same figures, so the resumed process weighs them before it starts, and announces
			// and renders nothing.
			const resumed = open(await SessionManager.open(copyFile));
			const starts: string[] = [];
			resumed.subscribe(event => {
				if (event.type === "auto_compaction_start") starts.push(event.action);
			});
			const last = resumed.agent.state.messages.findLast(message => message.role === "assistant");
			if (!last) throw new Error("Expected a reply in the copy's context");
			await endTurn(resumed, last);
			expect({
				starts,
				renders: render.mock.calls.length,
				compacted: resumed.sessionManager.getBranch().some(entry => entry.type === "compaction"),
			}).toEqual({
				starts: [],
				renders: 1,
				compacted: false,
			});
		} finally {
			for (const session of sessions.splice(0)) await session.dispose();
		}
	}, 60_000);
});
