import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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

/** The text the request `context` sends for the result of tool call `toolCallId`. */
function sentResultText(context: Context, toolCallId: string): string {
	const message = context.messages.find(
		(candidate): candidate is ToolResultMessage =>
			candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
	);
	if (!message) throw new Error(`Expected the request to carry the result of ${toolCallId}`);
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

describe("a prune the cut rule withholds", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	it("runs at the first request after the cache entry lapsed, which rewrites the whole prompt anyway", async () => {
		const model = createMockModel({
			cost: OPUS_COST,
			contextWindow: 1_000_000,
			handler: { content: ["second answer"], usage: { input: 10, cacheWrite: 600_000 } },
		});
		const sessionManager = SessionManager.inMemory();
		const endedAt = Date.now();
		const start = endedAt - 500;
		sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: start });
		const readCall = (id: string) => [
			{ type: "toolCall" as const, id, name: "read", arguments: { path: "src/foo.ts" } },
		];
		// The replies grow 100,000 tokens a request: within a request or two of the 850,000-token threshold.
		sessionManager.appendMessage(reply(model, readCall("read-old"), 400_000, start + 100));
		sessionManager.appendMessage(readResult("read-old", OLD_RESULT, start + 150));
		sessionManager.appendMessage(reply(model, readCall("read-new"), 500_000, start + 200));
		sessionManager.appendMessage(readResult("read-new", NEW_RESULT, start + 250));
		const final = reply(model, [{ type: "text", text: "Done." }], 600_000, endedAt);
		sessionManager.appendMessage(final);

		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: model.stream,
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": false,
				"compaction.supersedeReads": true,
				"providers.cacheRetention": "long",
			}),
			modelRegistry: { getApiKey: async () => "test-key", find: () => model } as never,
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		// The turn's maintenance runs while its one-hour entry is live: the prune does not pay and waits.
		session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
		await session.waitForIdle();
		const held = session.agent.state.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-old",
		);
		expect(held?.content).toEqual([{ type: "text", text: OLD_RESULT }]);

		// Two hours later the entry is gone, and the next request writes the whole prompt again: the held
		// prune now adds no write ("lapsed"), so the request should no longer carry the superseded read.
		vi.spyOn(Date, "now").mockReturnValue(endedAt + 2 * HOUR_MS);
		await session.prompt("Next question.");

		const request = model.calls[0]?.context;
		if (!request) throw new Error("Expected the request after the lapse");
		expect(sentResultText(request, "read-old")).toBe(SUPERSEDED_NOTICE);
	});
});
