import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** claude-opus-5-5's card per million tokens; with one-hour writes `w` = $8 and `r` = $0.20. */
const OPUS_COST = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const HOUR_MS = 60 * 60_000;

const OLD_RESULT = "old file contents\n".repeat(100);
const NEW_RESULT = "new file contents\n".repeat(100);

/** A reply whose request sent `prompt` tokens, read from the cache. */
function reply(
	model: Model,
	content: AssistantMessage["content"],
	prompt: number,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 100,
			cacheRead: prompt,
			cacheWrite: 0,
			totalTokens: prompt + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function readResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Ends a turn with `final`, which runs the session's post-turn maintenance. */
async function endTurn(session: AgentSession, final: AssistantMessage): Promise<void> {
	session.agent.emitExternalEvent({ type: "message_end", message: final });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
	await session.waitForIdle();
}

describe("automatic cuts under the cut rule", () => {
	const sessions: AgentSession[] = [];
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const cleanup of cleanups.splice(0)) await cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * A 1M-window session whose last turn superseded a read of `src/foo.ts`, the replies growing 100,000
	 * tokens a request, its final reply sent at `endedAt` and, with `warmedAt`, a warm refresh that hit
	 * the cache after it. Its post-turn maintenance has run.
	 */
	async function supersededReadSession(endedAt: number, warmedAt?: number): Promise<AgentSession> {
		const model = createMockModel({ cost: OPUS_COST, contextWindow: 1_000_000 });
		const sessionManager = SessionManager.inMemory();
		const start = endedAt - 500;
		sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: start });
		const readCall = (id: string) => [
			{ type: "toolCall" as const, id, name: "read", arguments: { path: "src/foo.ts" } },
		];
		sessionManager.appendMessage(reply(model, readCall("read-old"), 400_000, start + 100));
		sessionManager.appendMessage(readResult("read-old", OLD_RESULT, start + 150));
		sessionManager.appendMessage(reply(model, readCall("read-new"), 500_000, start + 200));
		sessionManager.appendMessage(readResult("read-new", NEW_RESULT, start + 250));
		const final = reply(model, [{ type: "text", text: "Done." }], 600_000, endedAt);
		sessionManager.appendMessage(final);
		if (warmedAt !== undefined) {
			sessionManager.appendModelUsage(
				{
					purpose: "cache-warm",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: final.usage,
					stopReason: "stop",
					cacheRefresh: { sentAt: warmedAt, hit: true },
				},
				{ sessionId: sessionManager.getSessionId(), parentId: sessionManager.getLeafId() },
			);
		}
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": false,
				"compaction.supersedeReads": true,
				"providers.cacheRetention": "long",
			}),
			// The session reads the cache entry its replies left under the model that wrote them.
			modelRegistry: { getApiKey: async () => "test-key", find: () => model } as never,
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();
		return session;
	}

	function oldReadText(session: AgentSession): string {
		const message = session.agent.state.messages.find(
			(candidate): candidate is ToolResultMessage =>
				candidate.role === "toolResult" && candidate.toolCallId === "read-old",
		);
		const text = message?.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected the old read result's text");
		return text.text;
	}

	it("holds a superseded read whose saved reads do not pay for its rewrite until the cache entry lapses", async () => {
		// Pruning ~440 tokens rewrites the ~500 after them; the context reaches the 850,000-token
		// threshold again within two requests, so the saved reads come to far less than the write.
		const warm = await supersededReadSession(Date.now());
		expect(oldReadText(warm)).toBe(OLD_RESULT);

		// Two hours after the last request its one-hour entry is gone: the rewrite costs nothing more.
		const lapsed = await supersededReadSession(Date.now() - 2 * HOUR_MS);
		expect(oldReadText(lapsed)).toBe(SUPERSEDED_NOTICE);
	});

	it("keeps holding the read after a warm refresh that hit, although the last reply is past its lifetime", async () => {
		// The refresh a minute ago renewed the one-hour entry the two-hour-old reply left.
		const refreshed = await supersededReadSession(Date.now() - 2 * HOUR_MS, Date.now() - 60_000);
		expect(oldReadText(refreshed)).toBe(OLD_RESULT);
	});

	/**
	 * Threshold compactions a 100,000-token session started when its final reply's request sent `prompt` tokens. Its
	 * replies came from `models.replies` and it runs on `models.session`; both are a mock model unless given.
	 */
	async function thresholdCompactionStarts(
		prompt: number,
		settings: Record<string, unknown>,
		models?: { replies: Model; session: Model },
	): Promise<string[]> {
		const tempDir = TempDir.createSync("@pi-context-cut-rule-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		cleanups.push(async () => {
			authStorage.close();
			await tempDir.remove();
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		// No model to summarize with: an admitted compaction starts, then ends skipped.
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		const mock = createMockModel({ cost: OPUS_COST, contextWindow: 100_000 });
		const { replies: model, session: sessionModel } = models ?? { replies: mock, session: mock };
		// The session reads the cache entry its replies left under the model that wrote them.
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const now = Date.now();
		sessionManager.appendMessage({ role: "user", content: "first question", timestamp: now - 600 });
		sessionManager.appendMessage(reply(model, [{ type: "text", text: "first answer" }], 10_000, now - 500));
		sessionManager.appendMessage({ role: "user", content: "second question", timestamp: now - 400 });
		sessionManager.appendMessage(reply(model, [{ type: "text", text: "second answer" }], 50_000, now - 300));
		sessionManager.appendMessage({ role: "user", content: "third question", timestamp: now - 200 });
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: sessionModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["soft"],
				// The pass runs in the turn's maintenance, not deferred to a background summary.
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
				"providers.cacheRetention": "long",
				...settings,
			}),
			modelRegistry,
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const starts: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts.push(event.reason);
		});
		await endTurn(session, reply(model, [{ type: "text", text: "third answer" }], prompt, now));
		return starts;
	}

	it("compacts at the default threshold, which is the window less its reserve, and holds the cut below it", async () => {
		// The window less its 16,384-token reserve leaves 83,616 tokens. A compaction writes its
		// summary (up to 16,384 tokens) again, and the context reaches the threshold again within a
		// request or two, so it would never pay for that write: only the full window forces it.
		expect(await thresholdCompactionStarts(90_000, {})).toEqual(["threshold"]);
		expect(await thresholdCompactionStarts(70_000, { "compaction.thresholdTokens": 60_000 })).toEqual([]);
	});

	it("compacts below the window once the model changed after the last reply, as after a lapsed entry", async () => {
		// Claude models that bind thinking to the prompt prefix, on Opus 5.5's card and a 100,000-token window.
		const claude: Omit<ModelSpec<"anthropic-messages">, "id" | "name"> = {
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: OPUS_COST,
			contextWindow: 100_000,
			maxTokens: 64_000,
		};
		const opus = buildModel({ ...claude, id: "claude-opus-5-5", name: "Claude Opus 5.5" });
		const sonnet = buildModel({ ...claude, id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" });
		const settings = { "compaction.thresholdTokens": 60_000 };
		// Sonnet wrote the live one-hour entry and the next request reads it: the compaction waits.
		expect(await thresholdCompactionStarts(70_000, settings, { replies: sonnet, session: sonnet })).toEqual([]);
		// Opus wrote it, and the next request goes to Sonnet, which cannot read it: nothing is cached to lose.
		expect(await thresholdCompactionStarts(70_000, settings, { replies: opus, session: sonnet })).toEqual([
			"threshold",
		]);
	});
});
