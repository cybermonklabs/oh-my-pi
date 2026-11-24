/**
 * The cut rule's "waits" for a model-summary compaction and a refused snapcompact pass are kept in the session as
 * records written after the newest message of the branch they were answered on. `/fork` at that message copies the
 * branch up to it into a new file, which reads the same cache entry, so the wait and the refusal must go on in the
 * copy (`SessionMaintenance.followBranchCopy`). These cases make the copy in a process that resumed the session and
 * forked before its first maintenance point: the wait and the refusal are then only in the file it read, not yet
 * taken in. A third process resumes the copy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createInMemoryAuthStorage, sessionContextTokens } from "./helpers/agent-session-setup";
import { continuesCachedPrompt, gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured thresholds, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold of the first process sits this far below the transcript's context: the rule waits. */
const THRESHOLD_MARGIN = 2_000;
/** The threshold of the process on the copy sits this far above it: the band where only the wait keeps a summary off. */
const BAND_MARGIN = 4_000;

describe("a wait and a refusal across /fork at the newest message, made by a process that resumed the session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts no background summary in a process that resumes the copy while the wait holds", async () => {
		using tempDir = TempDir.createSync("@pi-resumed-fork-wait-");
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
		try {
			const { session: sizing } = await createAgentSession({
				...options,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings: processSettings(CONTEXT_WINDOW / 2),
			});
			const contextTokens = sessionContextTokens(sizing, messages);
			await sizing.dispose();

			// The first process: its prompt's reply writes the whole context to a one-hour entry, and the rule waits on
			// the compaction after it. It exits.
			const live = recordGateway(contextTokens);
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			for (const message of messages) sessionManager.appendMessage(message);
			const { session } = await createAgentSession({
				...options,
				sessionManager,
				settings: processSettings(contextTokens - THRESHOLD_MARGIN),
			});
			try {
				await live.send(session, "first prompt");
				await sessionManager.flush();
			} finally {
				await session.dispose();
				live.restore();
			}
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected the session file");
			const lastBefore = live.requests.findLast(request => request.kind === "main");
			if (!lastBefore) throw new Error("Expected a main request of the first process");
			// Precondition: the rule waited after the reply.
			expect(live.timeline.slice(live.timeline.indexOf("main request"))).toContain(SUMMARY_COMPACTION_WAITS);

			// A second process resumes the session and, before it sends anything, forks it at the newest reply.
			const forking = recordGateway(contextTokens);
			const forkingManager = await SessionManager.open(file);
			const { session: resumed } = await createAgentSession({
				...options,
				sessionManager: forkingManager,
				settings: processSettings(contextTokens + BAND_MARGIN),
			});
			let copyFile: string | undefined;
			try {
				const branch = forkingManager.getBranch();
				const replyIndex = branch.findLastIndex(entry => entry.type === "message");
				const reply = branch[replyIndex];
				if (!reply) throw new Error("Expected the newest reply");
				// Precondition: the file the second process read records the wait after that reply, the newest message.
				expect(
					branch
						.slice(replyIndex + 1)
						.some(entry => entry.type === "custom" && entry.customType === "compaction-wait"),
				).toBe(true);
				expect(await resumed.fork(reply.id)).toBe(true);
				copyFile = forkingManager.getSessionFile();
				await forkingManager.flush();
			} finally {
				await resumed.dispose();
				forking.restore();
			}
			if (!copyFile) throw new Error("Expected the copy's session file");
			// Precondition: the second process sent nothing.
			expect(forking.requests).toHaveLength(0);

			// omp restarts on the copy a moment later, with a threshold above the context.
			const copy = recordGateway(contextTokens);
			const { session: restarted } = await createAgentSession({
				...options,
				sessionManager: await SessionManager.open(copyFile),
				settings: processSettings(contextTokens + BAND_MARGIN),
			});
			try {
				await copy.send(restarted, "resumed prompt");
				const main = copy.requests.find(request => request.kind === "main");
				if (!main) throw new Error("Expected the copy's main request");
				// The copy's request reads the entry the rule waited on, and it requests no summary for a cut that cannot
				// run.
				expect({
					continues: continuesCachedPrompt(lastBefore.body, main.body),
					summaries: copy.timeline.filter(entry => entry === "summary request").length,
				}).toEqual({ continues: true, summaries: 0 });
			} finally {
				await restarted.dispose();
				copy.restore();
			}
		} finally {
			authStorage.close();
		}
	}, 180_000);

	describe("snapcompact", () => {
		const THRESHOLD_TOKENS = 90_000;
		const GROWTH = 20_000;
		const SIZED_REPLIES = 3;
		const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		let authStorage: AuthStorage;
		let modelRegistry: ModelRegistry;

		beforeAll(async () => {
			authStorage = await AuthStorage.create(":memory:");
			authStorage.keys.setRuntime("anthropic", "test-key");
			modelRegistry = new ModelRegistry(authStorage);
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
			using tempDir = TempDir.createSync("@pi-resumed-fork-refusal-");
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

				// The first process: the pass renders, the cut rule refuses it, and the process exits.
				const first = open(sessionManager);
				await endTurn(first, final);
				await sessionManager.flush();
				await close(first);
				const file = sessionManager.getSessionFile();
				if (!file) throw new Error("Expected the session file");
				// Precondition: one archive rendered and nothing committed.
				expect({
					renders: render.mock.calls.length,
					compacted: sessionManager.getBranch().some(entry => entry.type === "compaction"),
				}).toEqual({ renders: 1, compacted: false });

				// A second process resumes the session and forks it at the newest reply before any maintenance point.
				const forkingManager = await SessionManager.open(file);
				const forking = open(forkingManager);
				const branch = forkingManager.getBranch();
				const replyIndex = branch.findLastIndex(entry => entry.type === "message");
				const newest = branch[replyIndex];
				if (!newest) throw new Error("Expected the newest reply");
				// Precondition: the file it read records the refusal after that reply, the newest message.
				expect(
					branch
						.slice(replyIndex + 1)
						.some(entry => entry.type === "custom" && entry.customType === "snapcompact-refusal"),
				).toBe(true);
				expect(await forking.fork(newest.id)).toBe(true);
				const copyFile = forkingManager.getSessionFile();
				if (!copyFile) throw new Error("Expected the copy's session file");
				await forkingManager.flush();
				await close(forking);

				// omp restarts on the copy: the same history, the same live entry, the same archive waiting on the same
				// figures, so it starts and renders nothing.
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
				}).toEqual({ starts: [], renders: 1, compacted: false });
			} finally {
				for (const session of sessions.splice(0)) await session.dispose();
			}
		}, 60_000);
	});
});
