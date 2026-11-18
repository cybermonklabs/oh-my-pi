import { vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./fetch-mock";

/** An Anthropic gateway reached on a `.local` host, configured as a deployment's `models.yml` declares it. */
export const GATEWAY = "http://gateway.test.local:4000";

/** The gateway's `models.yml`: claude-opus-5-5 on its card, with a `contextWindow`-token window. */
export function gatewayModelsYml(contextWindow = 1_000_000): string {
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
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: ${contextWindow}, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;
}

export interface WireMessage {
	role: string;
	content: unknown;
}

export interface WireTool {
	name: string;
}

/** A `/v1/messages` request body, as far as the tests read it. */
export interface MessagesRequest {
	system?: unknown;
	tools?: WireTool[];
	messages: WireMessage[];
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

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
export function withoutCacheControl(value: unknown): string {
	return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
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
 * extension discovery, prompt templates, slash commands, MCP, LSP or Python preflight.
 */
export function gatewaySessionOptions(tempDir: TempDir): CreateAgentSessionOptions {
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
