import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Agent } from "../src/agent";
import { normalizeTools } from "../src/agent-loop";
import { toolSpecsFingerprint } from "../src/append-only-context";
import type { AgentTool } from "../src/types";
import { withNativeDialectEnv } from "./helpers";

function agentTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ arg: type("string") }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function reply(requestControls?: AssistantMessage["requestControls"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...(requestControls && { requestControls }),
	};
}

describe("Agent — inactive tool definitions", () => {
	it("re-supplies a withdrawn tool the latest request declared, as the main loop last sent it", async () => {
		const previousDialect = Bun.env.PI_DIALECT;
		delete Bun.env.PI_DIALECT;
		try {
			const contexts: Context[] = [];
			// What the provider transform (where the request-size clamp runs) sees.
			const transformed: Context[] = [];
			const responses = [
				reply({
					messageIndex: 1,
					tools: { declared: ["read", "grep"], deferred: [], active: ["read", "grep"] },
				}),
				reply({ messageIndex: 3, tools: { declared: ["read", "grep"], deferred: [], active: ["read"] } }),
			];
			const agent = new Agent({
				initialState: {
					model: createMockModel({ responses: [] }),
					systemPrompt: ["system"],
					tools: [agentTool("read"), agentTool("grep")],
				},
				transformProviderContext: context => {
					transformed.push(context);
					return context;
				},
				streamFn: (_model, context) => {
					contexts.push(context);
					const message = responses[contexts.length - 1] ?? reply();
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
					return stream;
				},
			});

			await agent.prompt("first");
			agent.setTools([agentTool("read")]);
			await agent.prompt("second");

			const sentGrep = contexts[0]?.tools?.find(tool => tool.name === "grep");
			if (!sentGrep) throw new Error("expected grep in the first request");
			expect(contexts[0]?.inactiveTools).toBeUndefined();
			expect(contexts[1]?.tools?.map(tool => tool.name)).toEqual(["read"]);
			expect(contexts[1]?.inactiveTools).toEqual([sentGrep]);
			expect(transformed[1]?.inactiveTools).toEqual([sentGrep]);

			const messages = agent.state.messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			);
			const side = await agent.buildSideRequestContext(messages);
			expect(side.inactiveTools).toEqual([sentGrep]);
			expect(transformed[2]?.inactiveTools).toEqual([sentGrep]);
		} finally {
			if (previousDialect === undefined) delete Bun.env.PI_DIALECT;
			else Bun.env.PI_DIALECT = previousDialect;
		}
	});
});

describe("Agent — a refused request's tool declaration", () => {
	it("is not read: the declared tools follow the request before it, as the replay sends no refusal", async () => {
		await withNativeDialectEnv(async () => {
			// A model whose requests keep their tool declaration across the conversation.
			const model = getBundledModel("anthropic", "claude-opus-5-5");
			if (!model) throw new Error("expected the bundled claude-opus-5-5");
			const contexts: Context[] = [];
			const refusal: AssistantMessage = {
				...reply({
					messageIndex: 3,
					tools: { declared: ["read", "grep"], deferred: ["grep"], active: ["read", "grep"] },
				}),
				stopReason: "error",
				stopDetails: { type: "refusal" },
			};
			const responses = [
				reply({ messageIndex: 1, tools: { declared: ["read"], deferred: [], active: ["read"] } }),
				refusal,
			];
			const read = agentTool("read");
			const agent = new Agent({
				initialState: { model, systemPrompt: ["system"], tools: [read] },
				streamFn: (_model, context) => {
					contexts.push(context);
					const message = responses[contexts.length - 1] ?? reply();
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() =>
						stream.push(
							message.stopReason === "error"
								? { type: "error", reason: "error", error: message }
								: { type: "done", reason: "stop", message },
						),
					);
					return stream;
				},
			});

			await agent.prompt("first");
			// The refused request adds grep; grep is withdrawn before the next request.
			agent.setTools([read, agentTool("grep")]);
			await agent.prompt("second");
			agent.setTools([read]);
			// Precondition: the transcript keeps the refusal, with the declaration its request recorded.
			expect(agent.state.messages.at(-1)).toMatchObject({ stopDetails: { type: "refusal" } });

			expect(agent.declaredTools(model).map(tool => tool.name)).toEqual(["read"]);
			expect(agent.declaredToolsFingerprint(model)).toBe(
				toolSpecsFingerprint(normalizeTools([read], { injectIntent: false }) ?? []),
			);
		});
	});
});
