import { vi } from "bun:test";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./fetch-mock";

/** An Anthropic gateway reached on a `.local` host, configured as a deployment's `models.yml` declares it. */
export const GATEWAY = "http://gateway.test.local:4000";

/**
 * The gateway's `models.yml`: claude-opus-5-5 on its card, with a `contextWindow`-token window, and a host that takes
 * `imageCountBudget` images per request where one is given.
 */
export function gatewayModelsYml(contextWindow = 1_000_000, imageCountBudget?: number): string {
	const imageBudget = imageCountBudget === undefined ? "" : ` imageCountBudget: ${imageCountBudget},`;
	return `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image],${imageBudget} contextWindow: ${contextWindow}, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;
}

export interface WireMessage {
	role: string;
	content: unknown;
}

/** A tool definition as a `/v1/messages` request declares it. */
export interface WireTool {
	name: string;
	description?: string;
	input_schema?: unknown;
}

/** Tokens of `tool`'s definition as the wire carries it: its name, its description and its input schema. */
export function wireToolTokens(tokenizer: Tokenizer, tool: WireTool): number {
	return tokenizer.countTokens([tool.name, tool.description ?? "", JSON.stringify(tool.input_schema)]);
}

/** A `/v1/messages` request body, as far as the tests read it. */
export interface MessagesRequest {
	system?: unknown;
	tools?: WireTool[];
	messages: WireMessage[];
}

/** How many image blocks each of `request`'s messages sends. */
export function imagesPerMessage(request: MessagesRequest): number[] {
	return request.messages.map(message =>
		Array.isArray(message.content)
			? message.content.filter(block => typeof block === "object" && block !== null && block.type === "image").length
			: 0,
	);
}

/** Usage of the request a reply answers. */
export interface ReplyUsage {
	/** Tokens it sent uncached; 10 unless given. */
	inputTokens?: number;
	/** Tokens it wrote to the prompt cache; 0 unless given. */
	cacheWriteTokens?: number;
}

/** A streamed reply of one content block, the gateway's `turn`th. */
export function streamedAnswer(
	turn: number,
	block: Record<string, unknown>,
	deltas: unknown[],
	stopReason: string,
	{ inputTokens = 10, cacheWriteTokens = 0 }: ReplyUsage = {},
): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: inputTokens,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: cacheWriteTokens,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: block },
		...deltas.map(delta => ({ type: "content_block_delta", index: 0, delta })),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A streamed text reply, `seen <turn>`. */
export function answer(turn: number, usage?: ReplyUsage): Response {
	return streamedAnswer(
		turn,
		{ type: "text", text: "" },
		[{ type: "text_delta", text: `seen ${turn}` }],
		"end_turn",
		usage,
	);
}

/** A streamed reply calling `name` with `input`, the gateway's `turn`th. */
export function toolCallAnswer(
	turn: number,
	name: string,
	input: Record<string, unknown>,
	usage?: ReplyUsage,
): Response {
	return streamedAnswer(
		turn,
		{ type: "tool_use", id: `toolu_${turn}`, name, input: {} },
		[{ type: "input_json_delta", partial_json: JSON.stringify(input) }],
		"tool_use",
		usage,
	);
}

/** `reply`, whose stream sends nothing until `released` settles: the request stays in flight until then. */
export function heldOpen(reply: Response, released: Promise<void>): Response {
	const body = reply.arrayBuffer();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			await released;
			controller.enqueue(new Uint8Array(await body));
			controller.close();
		},
	});
	return new Response(stream, { status: reply.status, headers: reply.headers });
}

/** Every text a wire value carries: text blocks, string contents and nested tool results. */
export function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.content].map(textOf).join("\n");
}

/** The tool result a request carries for the call `toolUseId`. */
export function toolResultOf(
	request: MessagesRequest | undefined,
	toolUseId: string,
): Record<string, unknown> | undefined {
	return request?.messages
		.flatMap(message => (Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []))
		.find(block => block.type === "tool_result" && block.tool_use_id === toolUseId);
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
export function withoutCacheControl(value: unknown): string {
	return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
}

/** How many times `value`, without its cache breakpoints, carries `text`. */
export function copiesIn(value: unknown, text: string): number {
	return withoutCacheControl(value).split(text).length - 1;
}

/**
 * Whether `later` sends `earlier`'s prompt in cache order, tools, then system, then every message, with the same
 * bytes, so its cache lookup reads all of `earlier`'s prompt.
 */
export function continuesCachedPrompt(earlier: MessagesRequest, later: MessagesRequest): boolean {
	return (
		withoutCacheControl(later.tools) === withoutCacheControl(earlier.tools) &&
		withoutCacheControl(later.system) === withoutCacheControl(earlier.system) &&
		withoutCacheControl(later.messages.slice(0, earlier.messages.length)) === withoutCacheControl(earlier.messages)
	);
}

/** The requests a {@link mockGatewayFetch} gateway received. */
export interface GatewayFetch {
	/** Each request body, oldest first. */
	requests: MessagesRequest[];
	/** Puts the real `fetch` back. */
	restore(): void;
}

/**
 * Spies on `fetch` as the gateway: each `/v1/messages` request is recorded and answered with `reply` of its 1-based
 * number; a request to any other URL throws.
 */
export function mockGatewayFetch(reply: (turn: number) => Response): GatewayFetch {
	const requests: MessagesRequest[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (input, init) => {
			if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
			requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
			return reply(requests.length);
		}),
	);
	return { requests, restore: () => spy.mockRestore() };
}

/**
 * The `createAgentSession` options every gateway test passes: `tempDir` as its working and agent directory, and no
 * extension discovery, prompt templates, slash commands, MCP, LSP or Python preflight. A process the test spawns passes
 * the test's directory as `{ path }`.
 */
export function gatewaySessionOptions(tempDir: Pick<TempDir, "path">): CreateAgentSessionOptions {
	return {
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		disableExtensionDiscovery: true,
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	};
}
