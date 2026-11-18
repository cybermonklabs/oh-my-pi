import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** A card with input and output prices and no cache prices, as a models.yml entry that names only those two. */
const NO_CACHE_PRICES = { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 };

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

describe("a superseded read on a model without cache prices", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	/**
	 * The text of the old read's result after the post-turn maintenance of a 1M-window session under
	 * `providers.cacheRetention: retention`, whose replies grow 100,000 tokens a request (two requests from the
	 * threshold) and whose last reply just wrote a live cache entry.
	 */
	async function oldReadAfterMaintenance(retention: "short" | "long"): Promise<string> {
		const model = createMockModel({ cost: NO_CACHE_PRICES, contextWindow: 1_000_000 });
		const sessionManager = SessionManager.inMemory();
		const endedAt = Date.now();
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
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": false,
				"compaction.supersedeReads": true,
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

	it("is pruned under one-hour caching as under five-minute caching: no cache price makes its rewrite dearer", async () => {
		// Five-minute writes: `w` is the card's cacheWrite, 0, so the rewrite costs nothing and the prune runs.
		expect(await oldReadAfterMaintenance("short")).toBe(SUPERSEDED_NOTICE);
		// One-hour writes: the rule's docs admit "a model with no cache prices" too.
		expect(await oldReadAfterMaintenance("long")).toBe(SUPERSEDED_NOTICE);
	});
});
