/**
 * A tool-roster or `xd://` mount change on a prompt that keeps its bytes reaches the model as a hidden notice after a
 * request's newest content. These cases check that a request whose context no longer carries that notice (a `/tree`
 * move to a branch without it, a compaction between tool calls that summarized it) sends it again once, that the
 * request after it adds no second copy, and that consecutive requests keep their cache-order prefix.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** An MCP tool that connects mid-session; the session mounts it as an `xd://` device. */
const LOOKUP: CustomTool = {
	name: "mcp__docs_lookup",
	label: "docs/lookup",
	description: "Look up a page of the project docs",
	parameters: type({ q: "string" }),
	mcpServerName: "docs",
	mcpToolName: "lookup",
	async execute() {
		return { content: [{ type: "text", text: "page" }] };
	},
};

/** A change the bound prompt keeps out of its bytes, and the line of the notice that tells the model of it. */
interface NoticeCase {
	label: string;
	change: (session: AgentSession) => Promise<void>;
	marker: string;
}

const CASES: NoticeCase[] = [
	{
		label: "tool-roster",
		change: session => session.setActiveToolsByName(["read"]),
		marker: "No longer available: bash",
	},
	{
		label: "xd:// mount",
		change: session => session.refreshMCPTools([LOOKUP]),
		marker: "- xd://mcp__docs_lookup —",
	},
];

/** How many times `request`'s messages carry `text`. */
function copies(request: MessagesRequest, text: string): number {
	return withoutCacheControl(request.messages).split(text).length - 1;
}

/**
 * Opens a session on the gateway's claude-opus-5-5 with `read` and `bash`, whose prompt binds once it answered,
 * answering each request with `reply` of its number. MCP discovery applies its tool set (none here) before the first
 * prompt, as in a session with MCP servers configured, so the first reply binds a prompt the session committed.
 */
async function openSession(
	tempDir: TempDir,
	settings: Settings,
	contextWindow: number,
	reply: (turn: number) => Response,
): Promise<{ session: AgentSession; requests: MessagesRequest[]; close: () => Promise<void> }> {
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(contextWindow));
	const gateway = mockGatewayFetch(reply);
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const { session } = await createAgentSession({
		...gatewaySessionOptions(tempDir),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
		authStorage,
		modelRegistry,
		settings,
		model,
		toolNames: ["read", "bash"],
		contextFiles: [],
		skills: [],
	});
	await session.refreshMCPTools([]);
	return {
		session,
		requests: gateway.requests,
		close: async () => {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		},
	};
}

describe("tool-roster and xd:// mount notices a request's context lacks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(CASES)(
		"sends the $label notice again after /tree to a branch without it",
		async ({ change, marker }) => {
			using tempDir = TempDir.createSync("@pi-tool-notices-tree-");
			const { session, requests, close } = await openSession(
				tempDir,
				Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
				1_000_000,
				turn => answer(turn, { cacheWriteTokens: 100 }),
			);
			try {
				await session.prompt("First.");
				const firstReply = session.sessionManager
					.getBranch()
					.find(entry => entry.type === "message" && entry.message.role === "assistant");
				if (!firstReply) throw new Error("Expected the first prompt's reply");
				await change(session);
				await session.prompt("Second.");
				await session.prompt("Third.");
				// Back to the first reply: the branch is from before the request that told the model of the change.
				await session.navigateTree(firstReply.id);
				await session.prompt("Fourth.");
				await session.prompt("Fifth.");

				const [first, second, third, fourth, fifth] = requests;
				if (!first || !second || !third || !fourth || !fifth) throw new Error("Expected five requests");
				expect(copies(second, marker)).toBe(1);
				expect(copies(third, marker)).toBe(1);
				expect(continuesCachedPrompt(second, third)).toBe(true);
				expect(copies(fourth, marker)).toBe(1);
				// The bound prompt keeps its bytes, and the branch's history goes out as the first request sent it.
				expect(withoutCacheControl(fourth.system)).toBe(withoutCacheControl(first.system));
				expect(withoutCacheControl(fourth.tools)).toBe(withoutCacheControl(third.tools));
				expect(withoutCacheControl(fourth.messages.slice(0, first.messages.length))).toBe(
					withoutCacheControl(first.messages),
				);
				expect(copies(fifth, marker)).toBe(1);
				expect(continuesCachedPrompt(fourth, fifth)).toBe(true);
			} finally {
				await close();
			}
		},
		30_000,
	);

	it.each(CASES)(
		"sends the $label notice again in the rest of a run a compaction between tool calls summarized it in",
		async ({ change, marker }) => {
			using tempDir = TempDir.createSync("@pi-tool-notices-mid-run-");
			await Bun.write(tempDir.join("queue.txt"), "drained\n");
			// A 100,000-token window: the tool call's 90,000-token context leaves less than the window's reserve, so
			// the compaction at the tool boundary cannot wait.
			const { session, requests, close } = await openSession(
				tempDir,
				Settings.isolated({
					"providers.cacheRetention": "long",
					"compaction.methodOrder": ["soft"],
					"compaction.keepRecentTokens": 1,
					"compaction.midTurnEnabled": true,
					// A blocking compaction: no background speculation takes the tool boundary's pass over.
					"compaction.asyncEnabled": false,
				}),
				100_000,
				turn =>
					turn === 3
						? toolCallAnswer(turn, "read", { path: "queue.txt" }, { inputTokens: 90_000 })
						: answer(turn, { cacheWriteTokens: 100 }),
			);
			try {
				// A long first turn, so the compaction has history to summarize.
				const log = Array.from({ length: 6_000 }, (_, line) => `worker ${line}: drained the queue\n`).join("");
				await session.prompt(`Here is the deploy log:\n${log}`);
				await change(session);
				await session.prompt("Check the log again.");
				await session.prompt("Read queue.txt.");
				const compacted = session.sessionManager.getBranch().some(entry => entry.type === "compaction");
				if (!compacted) throw new Error("Expected the tool boundary to compact the history");
				const afterTool = requests.at(-1);
				if (!afterTool || !withoutCacheControl(afterTool.messages).includes('"type":"tool_result"')) {
					throw new Error("Expected the run's last request to answer the tool call");
				}
				if (withoutCacheControl(afterTool.messages).includes("Check the log again.")) {
					throw new Error("Expected the compaction to summarize the first two turns before the request");
				}
				await session.prompt("Thanks.");
				const next = requests.at(-1);
				if (!next || next === afterTool) throw new Error("Expected the fourth prompt's request");

				const [, second, third] = requests;
				if (!second || !third) throw new Error("Expected the second and third prompts' requests");
				expect(copies(second, marker)).toBe(1);
				expect(continuesCachedPrompt(second, third)).toBe(true);
				expect(copies(afterTool, marker)).toBe(1);
				// The request after carries the notice it was sent once, after the content it follows.
				expect(copies(next, marker)).toBe(1);
				expect(continuesCachedPrompt(afterTool, next)).toBe(true);
			} finally {
				await close();
			}
		},
		30_000,
	);
});
