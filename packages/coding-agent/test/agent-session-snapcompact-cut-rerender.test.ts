import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import * as snapcompact from "@oh-my-pi/snapcompact";

/** A 400,000-token window: its prompt budget is 340,000 tokens, far above the configured threshold. */
const CONTEXT_WINDOW = 400_000;
const THRESHOLD_TOKENS = 90_000;
/** Each of the last main requests' prompts grew this much over the one before it. */
const GROWTH = 20_000;
/** How many replies before the final one say what their request sent. */
const SIZED_REPLIES = 3;

describe("an automatic snapcompact compaction whose rendered archive the cut rule refuses", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
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
	async function endTurn(session: AgentSession, final: AssistantMessage): Promise<void> {
		session.agent.emitExternalEvent({ type: "message_end", message: final });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();
	}

	it("does not start a pass and render its archive again at the next maintenance point while the same cut waits", async () => {
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		const model: Model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		const sessionManager = SessionManager.inMemory();
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		const turns = 64;
		const now = Date.now();
		const earlier: AssistantMessage[] = [];
		for (let i = 0; i < turns; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: now - (turns - i) * 1000,
			});
			if (i < turns - 1) {
				const message = reply(model, i, 0, now - (turns - i) * 1000 + 100);
				earlier.push(message);
				sessionManager.appendMessage(message);
			}
		}
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

		// The final reply's request sent the whole context, read from a live one-hour entry; the last few requests
		// before it grew GROWTH tokens each.
		const final = reply(model, turns - 1, 0, now);
		session.agent.appendMessage(final);
		const before =
			computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision) +
			session.agent.tokenizer.countMessages(session.messages as AgentMessage[], { excludeEncryptedReasoning: true });
		final.usage.cacheRead = before;
		final.usage.output = 100;
		final.usage.totalTokens = before + 100;
		for (let offset = 1; offset <= SIZED_REPLIES; offset++) {
			const sized = earlier[earlier.length - offset];
			sized.usage.cacheRead = before - offset * GROWTH;
			sized.usage.output = 100;
			sized.usage.totalTokens = sized.usage.cacheRead + 100;
		}
		sessionManager.appendMessage(final);

		const starts: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts.push(event.action);
		});
		const render = vi.spyOn(snapcompact, "compact");
		const compacted = () => sessionManager.getBranch().some(branchEntry => branchEntry.type === "compaction");

		// First maintenance point: the context (~93,000 tokens) is past the 90,000-token threshold and far below the
		// prompt budget, so the cut is not forced. An archive at no tokens would pay, so the pass starts and renders;
		// the archive it rendered does not pay for rewriting itself and the kept turns, so nothing is committed.
		await endTurn(session, final);
		const first = { starts: [...starts], renders: render.mock.calls.length, compacted: compacted() };
		expect(first.compacted).toBe(false);

		// Second maintenance point a moment later, nothing changed: the entry is as live and the history the same, so
		// the same archive waits on the same figures. Rendering it again and announcing another compaction to the
		// user only to skip it again is work the session already did.
		await endTurn(session, final);
		expect({ starts, renders: render.mock.calls.length, compacted: compacted() }).toEqual(first);
	}, 60_000);
});
