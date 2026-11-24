/**
 * Once the cut rule refused an automatic snapcompact archive, the session keeps the refusal as a record after the
 * reply the pass was weighed on, and later maintenance points on any branch that carries that reply weigh the same
 * figures before they start another pass. A copy of the branch into a new file goes on with the same history, so the
 * refusal goes with it (`SessionMaintenance.followBranchCopy`). These cases move the branch onto that reply with
 * `/tree` (the record is then on another branch), copy it, restart omp on the copy, and count the archives the
 * resumed process's first maintenance point renders: once for a `/btw` answer promoted into a new file, once for
 * `/fork` at that reply.
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

describe("an automatic snapcompact pass the cut rule refused, across a copy of the branch /tree moved onto its reply", () => {
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

	/**
	 * Refuses a pass in a session whose final reply sent the whole context, moves the branch onto that reply with
	 * `/tree`, copies the branch with `copy`, and restarts omp on the copy. Returns the archives rendered before and
	 * after the restart's first maintenance point, and the auto-compactions it started.
	 */
	async function refuseCopyRestart(
		copy: (session: AgentSession, replyId: string) => Promise<void>,
	): Promise<{ rendersBefore: number; rendersAfter: number; starts: string[] }> {
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		const model: Model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		using tempDir = TempDir.createSync("@pi-btw-copy-refusal-");
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
				const message = reply(model, i, 0, i < turns - 1 ? now - (turns - i) * 1000 + 100 : now);
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
			for (const message of messages) sessionManager.appendMessage(message);
			const render = vi.spyOn(snapcompact, "compact");

			const session = open(sessionManager);
			await endTurn(session, final);
			const rendersBefore = render.mock.calls.length;
			const replyEntry = sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!replyEntry) throw new Error("Expected the reply the pass was weighed on");
			// `/tree` onto that reply: the branch carries it, and the refusal's record sits after it, on another branch.
			await session.navigateTree(replyEntry.id);
			await copy(session, replyEntry.id);
			const copyFile = sessionManager.getSessionFile();
			if (!copyFile) throw new Error("Expected the copy's session file");
			await sessionManager.flush();
			await close(session);

			const resumed = open(await SessionManager.open(copyFile));
			const starts: string[] = [];
			resumed.subscribe(event => {
				if (event.type === "auto_compaction_start") starts.push(event.action);
			});
			const last = resumed.agent.state.messages.findLast(message => message.role === "assistant");
			if (!last) throw new Error("Expected a reply in the copy's context");
			await endTurn(resumed, last);
			return { rendersBefore, rendersAfter: render.mock.calls.length, starts };
		} finally {
			for (const session of sessions.splice(0)) await session.dispose();
		}
	}

	it("renders no archive at the first maintenance point of a process that resumes a promoted /btw answer", async () => {
		const result = await refuseCopyRestart(async session => {
			const answer: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "It failed because the build cache was stale." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
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
			};
			const leafId = session.sessionManager.getLeafId();
			if (!leafId) throw new Error("Expected a leaf");
			const promoted = await session.branchFromBtw(
				"why did the build fail?",
				answer,
				leafId,
				session.sessionManager.getSessionId(),
			);
			expect(promoted.cancelled).toBe(false);
		});
		// Precondition: the first process rendered one archive and the rule refused it.
		expect(result.rendersBefore).toBe(1);
		expect({ starts: result.starts, renders: result.rendersAfter }).toEqual({ starts: [], renders: 1 });
	}, 60_000);

	it("renders no archive at the first maintenance point of a process that resumes /fork at the reply", async () => {
		const result = await refuseCopyRestart(async (session, replyId) => {
			expect(await session.fork(replyId)).toBe(true);
		});
		expect(result.rendersBefore).toBe(1);
		expect({ starts: result.starts, renders: result.rendersAfter }).toEqual({ starts: [], renders: 1 });
	}, 60_000);
});
