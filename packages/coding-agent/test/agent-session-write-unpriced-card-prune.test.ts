import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * gpt-5.1's card per million tokens: a cached read at a tenth of the input rate and no cache-write price. OpenAI bills
 * no cache write for it at either retention ("No additional cache-write charge", `in_memory` or `24h`): a token the
 * request writes again costs the input rate, whatever the retention asked.
 */
const READ_ONLY_CACHE_PRICES = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
const THRESHOLD_TOKENS = 850_000;

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

describe("a superseded read on a model whose card prices cache reads and no cache write", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	/**
	 * The text of the old read's result after the post-turn maintenance of a 1M-window session under
	 * `providers.cacheRetention: retention`, whose replies grow 20,000 tokens a request (a dozen requests from the
	 * 850,000-token threshold) and whose last reply just touched a live cache entry. The read sits at the tail: the
	 * prune rewrites only the new read and the replies after it, about as many tokens as it removes, and the reads it
	 * saves over the dozen requests cost more than writing those tokens again at the input rate.
	 */
	async function oldReadAfterMaintenance(retention: "short" | "long"): Promise<string> {
		const model = createMockModel({ cost: READ_ONLY_CACHE_PRICES, contextWindow: 1_000_000 });
		const sessionManager = SessionManager.inMemory();
		const endedAt = Date.now();
		const start = endedAt - 500;
		sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: start });
		const readCall = (id: string) => [
			{ type: "toolCall" as const, id, name: "read", arguments: { path: "src/foo.ts" } },
		];
		sessionManager.appendMessage(reply(model, readCall("read-old"), 560_000, start + 100));
		sessionManager.appendMessage(readResult("read-old", OLD_RESULT, start + 150));
		sessionManager.appendMessage(reply(model, readCall("read-new"), 580_000, start + 200));
		sessionManager.appendMessage(readResult("read-new", NEW_RESULT, start + 250));
		const final = reply(model, [{ type: "text", text: "Done." }], 600_000, endedAt);
		sessionManager.appendMessage(final);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": false,
				"compaction.supersedeReads": true,
				"compaction.thresholdTokens": THRESHOLD_TOKENS,
				"providers.cacheRetention": retention,
			}),
			modelRegistry: { getApiKey: async () => "test-key", find: () => model } as never,
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();
		const message = session.agent.state.messages.find(
			(candidate): candidate is ToolResultMessage =>
				candidate.role === "toolResult" && candidate.toolCallId === "read-old",
		);
		const text = message?.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected the old read result's text");
		return text.text;
	}

	it("is pruned under long retention as under short retention: the card prices no write that the retention makes dearer", async () => {
		expect(await oldReadAfterMaintenance("short")).toBe(SUPERSEDED_NOTICE);
		// Long retention asks the provider for its extended entry, which this card bills as the short one: the
		// rewrite costs the same, so the cut rule must decide the same.
		expect(await oldReadAfterMaintenance("long")).toBe(SUPERSEDED_NOTICE);
	});
});
