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

const HOUR_MS = 60 * 60_000;
/** A 400,000-token window: its prompt budget is 340,000 tokens, far above the configured threshold. */
const CONTEXT_WINDOW = 400_000;
const THRESHOLD_TOKENS = 90_000;
/** The prompt of the reply before the final one; the final reply's prompt is the whole ~93,000-token context. */
const PREVIOUS_PROMPT_TOKENS = 1_000;

describe("an automatic snapcompact compaction the cut rule holds", () => {
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

	it("starts no pass and renders no archive while even its smallest cut waits, and runs once the entry lapses", async () => {
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		const model: Model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		const sessionManager = SessionManager.inMemory();
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		const turns = 64;
		const now = Date.now();
		for (let i = 0; i < turns; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: now - (turns - i) * 1000,
			});
			// Only the reply before the final one says what its request sent.
			const prompt = i === turns - 2 ? PREVIOUS_PROMPT_TOKENS : 0;
			if (i < turns - 1) sessionManager.appendMessage(reply(model, i, prompt, now - (turns - i) * 1000 + 100));
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

		// The final reply's request sent the whole context, read from a live one-hour entry.
		const final = reply(model, turns - 1, 0, now);
		session.agent.appendMessage(final);
		const before =
			computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision) +
			session.agent.tokenizer.countMessages(session.messages as AgentMessage[], { excludeEncryptedReasoning: true });
		final.usage.cacheRead = before;
		final.usage.output = 100;
		final.usage.totalTokens = before + 100;
		sessionManager.appendMessage(final);
		const entry = session.observedPromptCacheEntry();
		if (!entry || entry.change !== undefined) throw new Error("Expected the final reply's live cache entry");

		const starts: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts.push(event.action);
		});
		const render = vi.spyOn(snapcompact, "compact");
		const compacted = () => sessionManager.getBranch().some(branchEntry => branchEntry.type === "compaction");

		// The turn's maintenance: the context (~93,000 tokens) is past the configured 90,000-token threshold and far
		// below the prompt budget, so the compaction is not forced. The prompt grew ~92,000 tokens over the previous
		// request, so the context is back at the threshold one request after any cut: even a cut whose archive cost
		// nothing saves no reads to pay for writing the kept turns again, and every cut waits for the entry to lapse.
		await endTurn(session, final);
		expect({ starts, renders: render.mock.calls.length, compacted: compacted() }).toEqual({
			starts: [],
			renders: 0,
			compacted: false,
		});

		// Two hours on, the one-hour entry has lapsed: the same maintenance point renders the archive and compacts.
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * HOUR_MS);
		await endTurn(session, final);
		expect({ starts, rendered: render.mock.calls.length > 0, compacted: compacted() }).toEqual({
			starts: ["snapcompact"],
			rendered: true,
			compacted: true,
		});
	}, 60_000);
});
