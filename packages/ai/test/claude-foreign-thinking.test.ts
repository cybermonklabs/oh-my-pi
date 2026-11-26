import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
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
import {
	AssignModelResponseSchema,
	GetChatMessageRequestSchema,
	GetUserJwtResponseSchema,
	ModelAssignmentSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

/**
 * Claude's input classifier (`reasoning_extraction`) refuses a request whose
 * earlier assistant turns carry another model's reasoning as plain prose. A
 * session that moved from Claude to another model and back sent that model's
 * thinking demoted to text and was refused; the same request with only that
 * thinking removed was served. A Claude target therefore gets no other model's
 * thinking, signed or not, other Claude models included. The other model's
 * answers and tool calls stay, and Claude's own thinking replays as it did
 * before.
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

function otherTarget<T extends Api>(api: T, provider: string, id: string, compat?: ModelSpec<T>["compat"]): Model<T> {
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
		...(compat && { compat }),
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
	data?: string;
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
		// but a signature from one route does not verify on the other. The
		// thinking went out as text (to the direct route, and to a gateway set not
		// to replay unsigned thinking) or, at a gateway's default compat, as an
		// unsigned block that a host in front of Anthropic rejects.
		const direct = anthropicTarget({ id: "claude-opus-5-5" });
		const gateway = anthropicTarget({
			provider: "model-gateway",
			id: "claude-opus-5-5",
			baseUrl: "https://gateway.example.com",
			compat: { replayUnsignedThinking: false },
		});
		const gatewayAtDefaultCompat = anthropicTarget({
			provider: "model-gateway",
			id: "claude-opus-5-5",
			baseUrl: "https://gateway.example.com",
		});
		expect(gatewayAtDefaultCompat.compat.replayUnsignedThinking).toBe(true);
		for (const [from, target] of [
			[direct, gateway],
			[direct, gatewayAtDefaultCompat],
			[gateway, direct],
		]) {
			const source: Source = { api: "anthropic-messages", provider: from.provider, model: from.id };
			const wire = anthropicWire(foreignHistory(source, "sig_other_route"), target);
			expect(wire.json).not.toContain(REASONING);
			expect(wire.json).not.toContain("sig_other_route");
			expect(wire.assistant.filter(block => block.type === "thinking")).toEqual([]);
			expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
			expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
		}
	});

	it("drops another provider's redacted thinking that a custom host would replay", () => {
		// At its default compat a custom host replays unsigned and redacted
		// thinking natively, so the rules for its own signatures keep this block.
		const kimi: Source = { api: "anthropic-messages", provider: "kimi-code", model: "k3" };
		const target = anthropicTarget({
			provider: "custom-anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://llm.example.com/anthropic",
		});
		const messages: Message[] = [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: REASONING, thinkingSignature: "kimi-issued-signature" },
					{ type: "redactedThinking", data: "kimi-redacted-blob" },
					{ type: "text", text: ANSWER },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } },
				],
				kimi,
			),
			toolResult("call_1"),
			user("Continue."),
		];

		const wire = anthropicWire(messages, target);
		expect(wire.json).not.toContain("kimi-redacted-blob");
		expect(wire.json).not.toContain(REASONING);
		expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
		expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
	});

	it("drops another model's thinking from another wire of the same provider", () => {
		// One provider id can serve Gemini on chat completions and Claude on
		// Anthropic Messages. A host set not to replay unsigned thinking would get
		// that thinking demoted to text, which no later step removes.
		const target = anthropicTarget({
			provider: "model-gateway",
			id: "claude-opus-5-5",
			baseUrl: "https://gateway.example.com",
			compat: { replayUnsignedThinking: false },
		});
		const gemini: Source = { ...GEMINI_COMPLETIONS, provider: "model-gateway" };
		const wire = anthropicWire(foreignHistory(gemini), target);

		expect(wire.json).not.toContain(REASONING);
		expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
		expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
	});
});

describe("another Claude model's signed thinking on the same provider", () => {
	it("drops it, with its redacted and unsigned blocks, on a custom host", () => {
		const target = anthropicTarget({
			provider: "custom-anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://llm.example.com/anthropic",
		});
		const other: Source = { api: "anthropic-messages", provider: "custom-anthropic", model: "claude-opus-4-8" };
		const history: Message[] = [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: "Signed plan.", thinkingSignature: "sig_signed" },
					{ type: "redactedThinking", data: "redacted-on-this-host" },
					{ type: "thinking", thinking: REASONING },
					{ type: "text", text: ANSWER },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } },
				],
				other,
			),
			toolResult("call_1"),
			user("Continue."),
		];
		const latest = history;
		const earlier = [...history, assistant([{ type: "text", text: "Done." }], other, "stop"), user("Next.")];

		for (const messages of [latest, earlier]) {
			const wire = anthropicWire(messages, target);
			expect(wire.json).not.toContain("Signed plan.");
			expect(wire.json).not.toContain("sig_signed");
			expect(wire.json).not.toContain("redacted-on-this-host");
			expect(wire.json).not.toContain(REASONING);
			expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
			expect(wire.assistant).toContainEqual(expect.objectContaining({ type: "tool_use", id: "call_1" }));
		}
	});

	it("drops it on first-party Anthropic", () => {
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
		expect(wire.json).not.toContain("Signed plan.");
		expect(wire.json).not.toContain("sig_complete");
		expect(wire.json).not.toContain(REASONING);
		expect(wire.assistant).toContainEqual({ type: "text", text: ANSWER });
	});

	it("sends a mid-tool-loop switch from another Claude model as it sends a Gemini loop", () => {
		const target = anthropicTarget({ id: "claude-opus-4-8" });
		const sonnet: Source = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-6" };
		const loop = (source: Source, signature: string): Message[] => [
			user("Fix the parser."),
			assistant(
				[
					{ type: "thinking", thinking: REASONING, thinkingSignature: signature },
					{ type: "toolCall", id: "toolu_loop", name: "read", arguments: { path: "config.ts" } },
				],
				source,
			),
			toolResult("toolu_loop"),
		];

		const fromSonnet = anthropicWire(loop(sonnet, "sig_sonnet"), target);
		const fromGemini = anthropicWire(loop(GEMINI_COMPLETIONS, "reasoning_content"), target);
		expect(fromSonnet.json).not.toContain(REASONING);
		expect(fromSonnet.json).not.toContain("sig_sonnet");
		expect(fromSonnet.assistant.map(block => block.type)).toEqual(["tool_use"]);
		expect(fromSonnet.user.map(block => block.type)).toContain("tool_result");
		expect(fromSonnet.json).toBe(fromGemini.json);
	});
});

/**
 * Captures the Cascade request omp's Devin provider sends, without a model
 * call. A router's AssignModel call is answered with `routedTo`.
 */
async function devinRequest(model: Model<"devin-agent">, messages: Message[], routedTo = "claude-sonnet-4-5") {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	const assignment = create(AssignModelResponseSchema, {
		assignment: create(ModelAssignmentSchema, { assignmentJwt: "assign-jwt", modelUid: routedTo }),
	});
	let requestPayload: Uint8Array | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		if (String(input).includes("AssignModel")) return new Response(toBinary(AssignModelResponseSchema, assignment));
		requestPayload = new Uint8Array(init?.body as ArrayBuffer);
		return new Response(new Uint8Array());
	}) as typeof fetch;
	await streamDevin(model, { messages }, { apiKey: "token", fetch: fetchImpl }).result();
	if (!requestPayload) throw new Error("Devin chat request was not captured");
	const view = new DataView(requestPayload.buffer, requestPayload.byteOffset, requestPayload.byteLength);
	// Connect envelope: flag byte (bit 0 = gzip), u32 length, message.
	const body = requestPayload.subarray(5, 5 + view.getUint32(1, false));
	return fromBinary(GetChatMessageRequestSchema, (requestPayload[0] & 1) !== 0 ? gunzipSync(body) : body);
}

describe("a Claude model behind Devin", () => {
	// Devin writes the transform's demoted text into the turn's prompt, and its
	// thinking field into the turn's thinking.
	const claude = otherTarget("devin-agent", "devin", "claude-opus-5");

	it("gets none of another model's thinking in the prompt, and keeps the answer and tool call", async () => {
		const request = await devinRequest(claude, foreignHistory(GEMINI_GOOGLE));

		expect(request.chatMessagePrompts[1]).toMatchObject({ prompt: ANSWER, thinking: "" });
		expect(request.chatMessagePrompts[1]?.toolCalls.map(call => call.name)).toEqual(["read"]);
		for (const prompt of request.chatMessagePrompts) {
			expect(prompt.prompt).not.toContain(REASONING);
			expect(prompt.thinking).not.toContain(REASONING);
		}
	});

	it("keeps its own thinking in the thinking field", async () => {
		const own: Source = { api: "devin-agent", provider: "devin", model: claude.id };
		const request = await devinRequest(claude, foreignHistory(own));

		expect(request.chatMessagePrompts[1]).toMatchObject({ prompt: ANSWER, thinking: REASONING });
	});

	it("still sends another model's thinking as text to a model that is not Claude", async () => {
		const request = await devinRequest(otherTarget("devin-agent", "devin", "gpt-5"), foreignHistory(GEMINI_GOOGLE));

		expect(request.chatMessagePrompts[1]?.prompt).toContain(REASONING);
	});
});

describe("a model Devin's router picks", () => {
	// `adaptive` names no model; the router picks one per request, and the
	// model it picks may be Claude.
	const router = otherTarget("devin-agent", "devin", "adaptive", { modelRouter: true });

	it("gets none of another model's thinking in the prompt, and keeps the answer and tool call", async () => {
		const request = await devinRequest(router, foreignHistory(GEMINI_GOOGLE));

		expect(request.chatModelUid).toBe("claude-sonnet-4-5");
		expect(request.chatMessagePrompts[1]).toMatchObject({ prompt: ANSWER, thinking: "" });
		expect(request.chatMessagePrompts[1]?.toolCalls.map(call => call.name)).toEqual(["read"]);
		for (const prompt of request.chatMessagePrompts) expect(prompt.prompt).not.toContain(REASONING);
	});

	it("keeps the router's own thinking in the thinking field", async () => {
		const own: Source = { api: "devin-agent", provider: "devin", model: router.id };
		const request = await devinRequest(router, foreignHistory(own));

		expect(request.chatMessagePrompts[1]).toMatchObject({ prompt: ANSWER, thinking: REASONING });
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
