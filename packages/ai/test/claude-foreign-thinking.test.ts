import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Claude's input classifier (`reasoning_extraction`) refuses a request whose
 * earlier assistant turns carry another model's reasoning as plain prose. A
 * session that moved from Claude to another model and back sent that model's
 * thinking demoted to text and was refused; the same request with only that
 * thinking removed was served. A Claude target therefore gets none of another
 * model's thinking. The other model's answers and tool calls stay, and
 * Claude's own thinking replays as it did before.
 */

const REASONING = "Plan: read config.ts first, then patch the parser and rerun the suite.";
const ANSWER = "Reading the config first.";
const OWN_REASONING = "The parser fix is in; the suite is next.";

type Source = Pick<AssistantMessage, "api" | "provider" | "model">;
type ChatReply = { content?: unknown; tool_calls?: Array<{ function: { name: string } }> };

/** Gemini through an OpenAI-compatible endpoint, as a fallback chain reaches it. */
const GEMINI_COMPLETIONS: Source = {
	api: "openai-completions",
	provider: "vertex",
	model: "google/gemini-3.1-pro-preview",
};
/** Gemini through Google's own API. */
const GEMINI_GOOGLE: Source = { api: "google-generative-ai", provider: "google", model: "gemini-3-pro-preview" };

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(
	content: AssistantMessage["content"],
	source: Source,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		...source,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "export const config = {};" }],
		isError: false,
		timestamp: 0,
	};
}

/** A turn of another model: its thinking, its answer and a tool call, then the tool's result. */
function foreignHistory(source: Source, signature = "reasoning_content"): Message[] {
	return [
		user("Fix the parser."),
		assistant(
			[
				{ type: "thinking", thinking: REASONING, thinkingSignature: signature },
				{ type: "text", text: ANSWER },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } },
			],
			source,
		),
		toolResult("call_1"),
		user("Continue."),
	];
}

function anthropicTarget(spec: Partial<ModelSpec<"anthropic-messages">>): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-opus-4-8",
		name: "Claude",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...spec,
	} as ModelSpec<"anthropic-messages">);
}

function otherTarget<T extends Api>(api: T, provider: string, id: string): Model<T> {
	return buildModel({
		api,
		provider,
		id,
		name: id,
		baseUrl: "https://llm.example.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<T>);
}

/** Claude on Anthropic Messages hosts: first party, a gateway that signs nothing, Vertex, Cloudflare. */
const ANTHROPIC_MESSAGES_CLAUDE = [
	anthropicTarget({}),
	anthropicTarget({
		provider: "model-gateway",
		id: "claude-opus-5-5",
		baseUrl: "https://gateway.example.com",
		compat: { replayUnsignedThinking: false },
	}),
	anthropicTarget({
		provider: "google-vertex",
		id: "claude-opus-4-8@20260215",
		baseUrl:
			"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-opus-4-8@20260215:streamRawPredict",
	}),
	anthropicTarget({
		provider: "cloudflare-ai-gateway",
		id: "cf-anthropic/claude-opus-4-8",
		baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gate/anthropic",
	}),
];

interface WireBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
}

function anthropicWire(messages: Message[], target: Model<"anthropic-messages">) {
	const params = convertAnthropicMessages(messages, target, false);
	const wire = {
		json: JSON.stringify(params),
		assistant: [] as WireBlock[],
		user: [] as WireBlock[],
		system: [] as WireBlock[],
	};
	for (const param of params) {
		if (typeof param.content !== "string") wire[param.role].push(...(param.content as WireBlock[]));
	}
	return wire;
}

describe("a Claude target gets none of another model's thinking", () => {
	for (const target of ANTHROPIC_MESSAGES_CLAUDE) {
		for (const source of [GEMINI_COMPLETIONS, GEMINI_GOOGLE]) {
			it(`${target.provider} after ${source.provider}: keeps the answer and tool call`, () => {
				const wire = anthropicWire(foreignHistory(source), target);

				expect(wire.json).not.toContain(REASONING);
				expect(wire.assistant.filter(block => block.type === "thinking")).toEqual([]);
				expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
				expect(wire.assistant).toContainEqual(
					expect.objectContaining({ type: "tool_use", id: "call_1", name: "read", input: { path: "config.ts" } }),
				);
				expect(wire.user).toContainEqual(expect.objectContaining({ type: "tool_result", tool_use_id: "call_1" }));
			});
		}
	}

	it("Claude on Bedrock and on an OpenAI-compatible API: keeps the answer and tool call", () => {
		const bedrock = otherTarget("bedrock-converse-stream", "amazon-bedrock", "global.anthropic.claude-opus-4-8");
		const replayed = transformMessages(foreignHistory(GEMINI_COMPLETIONS), bedrock);
		const turn = replayed.find((message): message is AssistantMessage => message.role === "assistant");
		expect(JSON.stringify(replayed)).not.toContain(REASONING);
		expect(turn?.content.map(block => block.type)).toEqual(["text", "toolCall"]);
		expect(turn?.content[0]).toEqual({ type: "text", text: ANSWER });

		const openRouter = otherTarget("openai-completions", "openrouter", "anthropic/claude-opus-4.5");
		const params = convertMessages(openRouter, { messages: foreignHistory(GEMINI_GOOGLE) }, openRouter.compat);
		const reply = params.find(param => param.role === "assistant") as ChatReply | undefined;
		expect(JSON.stringify(params)).not.toContain(REASONING);
		expect(reply?.content).toBe(ANSWER);
		expect(reply?.tool_calls?.map(call => call.function.name)).toEqual(["read"]);
	});

	it("drops thinking another Anthropic Messages model signed, on its latest turn and on an earlier one", () => {
		const kimi: Source = { api: "anthropic-messages", provider: "kimi-code", model: "k3" };
		const target = anthropicTarget({ id: "claude-fable-5" });
		const history = foreignHistory(kimi, "kimi-issued-signature");
		const latest = history.slice(0, 3);
		const earlier = [...history, assistant([{ type: "text", text: "Done." }], kimi, "stop")];

		for (const messages of [latest, earlier]) {
			const wire = anthropicWire(messages, target);
			expect(wire.json).not.toContain(REASONING);
			expect(wire.json).not.toContain("kimi-issued-signature");
			expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
			expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
		}
	});

	it("drops the same Claude model's thinking from another route, in both directions", () => {
		// A gateway in front of Anthropic and the direct route serve one model,
		// but a signature from one route does not verify on the other, so that
		// thinking would arrive as bare prose too.
		const direct = anthropicTarget({ id: "claude-opus-5-5" });
		const gateway = anthropicTarget({
			provider: "model-gateway",
			id: "claude-opus-5-5",
			baseUrl: "https://gateway.example.com",
			compat: { replayUnsignedThinking: false },
		});
		for (const [from, target] of [
			[direct, gateway],
			[gateway, direct],
		]) {
			const source: Source = { api: "anthropic-messages", provider: from.provider, model: from.id };
			const wire = anthropicWire(foreignHistory(source, "sig_other_route"), target);
			expect(wire.json).not.toContain(REASONING);
			expect(wire.json).not.toContain("sig_other_route");
			expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
			expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
		}
	});

	it("drops another model's thinking on a host that signs nothing, signed or not", () => {
		// Such a host keeps another model's signature as an opaque hint (#2265),
		// and a turn that keeps one signed block has its unsigned blocks written
		// as text.
		const target = anthropicTarget({
			provider: "custom-anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://llm.example.com/anthropic",
		});
		const other: Source = { api: "anthropic-messages", provider: "custom-anthropic", model: "claude-opus-4-8" };
		const messages: Message[] = [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: "Signed plan.", thinkingSignature: "sig_signed" },
					{ type: "thinking", thinking: REASONING },
					{ type: "text", text: ANSWER },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } },
				],
				other,
			),
			toolResult("call_1"),
			user("Continue."),
		];

		const wire = anthropicWire(messages, target);
		expect(wire.json).not.toContain(REASONING);
		expect(wire.json).not.toContain("Signed plan.");
		expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
		expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
	});

	it("keeps another Claude model's signed block on the same deployment, and drops the one it stops trusting", () => {
		// First-party Anthropic verifies another model's signature from its own
		// deployment, so that block replays natively. An errored turn's final
		// block holds a partial signature, which is stripped; unsigned, it would
		// be written as text.
		const target = anthropicTarget({ id: "claude-opus-4-8" });
		const sonnet: Source = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-6" };
		const messages: Message[] = [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: "Signed plan.", thinkingSignature: "sig_complete" },
					{ type: "text", text: ANSWER },
					{ type: "thinking", thinking: REASONING, thinkingSignature: "sig_partial" },
				],
				sonnet,
				"error",
			),
			user("Continue."),
		];

		const wire = anthropicWire(messages, target);
		expect(wire.assistant).toContainEqual({ type: "thinking", thinking: "Signed plan.", signature: "sig_complete" });
		expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
		expect(wire.json).not.toContain(REASONING);
	});
});

describe("a Claude target's own thinking is unchanged", () => {
	it("replays its own signed thinking natively", () => {
		const target = anthropicTarget({});
		const own: Source = { api: "anthropic-messages", provider: "anthropic", model: target.id };
		const messages: Message[] = [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: OWN_REASONING, thinkingSignature: "sig_own" },
					{ type: "toolCall", id: "toolu_own", name: "read", arguments: { path: "config.ts" } },
				],
				own,
			),
			toolResult("toolu_own"),
		];

		const wire = anthropicWire(messages, target);
		expect(wire.assistant[0]).toEqual({ type: "thinking", thinking: OWN_REASONING, signature: "sig_own" });
	});

	it("still writes its own unsigned thinking as text where the host cannot replay it", () => {
		const target = anthropicTarget({
			provider: "model-gateway",
			id: "claude-opus-5-5",
			baseUrl: "https://gateway.example.com",
			compat: { replayUnsignedThinking: false },
		});
		const own: Source = { api: "anthropic-messages", provider: "model-gateway", model: target.id };
		const messages: Message[] = [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: OWN_REASONING },
					{ type: "toolCall", id: "toolu_own", name: "read", arguments: { path: "config.ts" } },
				],
				own,
			),
			toolResult("toolu_own"),
		];

		const wire = anthropicWire(messages, target);
		expect(wire.assistant[0]).toEqual({ type: "text", text: OWN_REASONING });
	});
});
