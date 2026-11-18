import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { decideContextCut, meanPromptGrowth } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel, getCacheTokenPrices } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";

const HOUR_MS = 60 * 60_000;
/** A 400,000-token window: its prompt budget is 340,000 tokens, far above the configured threshold. */
const CONTEXT_WINDOW = 400_000;
const THRESHOLD_TOKENS = 90_000;
/** Each main request's prompt grew this much over the one before it. */
const GROWTH = 1_500;

describe("an automatic snapcompact compaction the cut rule admits", () => {
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
				output: 100,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens + 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		};
	}

	function storedContextTokens(session: AgentSession): number {
		return (
			computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision) +
			session.agent.tokenizer.countMessages(session.messages as AgentMessage[], { excludeEncryptedReasoning: true })
		);
	}

	it("pays for its cache write by what the compaction really removes and rewrites", async () => {
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
			if (i < turns - 1) sessionManager.appendMessage(reply(model, i, 1_000, now - (turns - i) * 1000 + 100));
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

		const final = reply(model, turns - 1, 0, now);
		session.agent.appendMessage(final);
		const before = storedContextTokens(session);
		final.usage.cacheRead = before;
		final.usage.totalTokens = before + 100;
		// The recent replies grew GROWTH tokens a request up to this one, all read from a live one-hour entry.
		const branchReplies = sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		for (const [offset, earlier] of branchReplies.reverse().entries()) {
			const prompt = Math.max(1_000, before - (offset + 1) * GROWTH);
			earlier.usage.cacheRead = prompt;
			earlier.usage.totalTokens = prompt + 100;
		}
		sessionManager.appendMessage(final);

		// The turn's maintenance: the context (~93,000 tokens) is past the configured 90,000-token threshold and far
		// below the 340,000-token prompt budget, so the compaction is not forced and the cut rule weighs it.
		session.agent.emitExternalEvent({ type: "message_end", message: final });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();

		// What the compaction really did: the next request reads the cache only through the system prompt and writes
		// the archive and the kept turns again; it removed the difference.
		const after = storedContextTokens(session);
		const prefix = computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision);
		const prompts = [...branchReplies.reverse().map(message => message.usage.cacheRead), before];
		const prices = getCacheTokenPrices(model.cost, "1h", before, now);
		const real = decideContextCut({
			promptTokens: before,
			prefixTokens: prefix,
			removedTokens: before - after,
			readPrice: prices.read,
			writePrice: prices.write,
			thresholdTokens: THRESHOLD_TOKENS,
			growthPerRequest: meanPromptGrowth(prompts),
			idleMs: 0,
			lifeMs: HOUR_MS,
			forced: false,
		});
		const committed = sessionManager.getBranch().some(entry => entry.type === "compaction");
		// The rule admits the cut exactly when it pays on the figures of the cut it makes.
		expect({ compactionCommitted: committed, realFigures: real }).toEqual({
			compactionCommitted: real.admitted,
			realFigures: real,
		});
	}, 60_000);
});
