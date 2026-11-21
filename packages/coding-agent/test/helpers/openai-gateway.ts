import { vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { GATEWAY, type WireMessage } from "./anthropic-gateway";
import { asGlobalFetch } from "./fetch-mock";

/** The OpenAI APIs the gateway serves claude-opus-5-5 on, each under a provider of its own. */
export type OpenAIGatewayApi = "openai-responses" | "openai-completions";

/** The provider {@link openAIGatewayModelsYml} declares each API's claude-opus-5-5 under. */
const OPENAI_GATEWAY_PROVIDERS: Record<OpenAIGatewayApi, string> = {
	"openai-responses": "gateway-responses",
	"openai-completions": "gateway-completions",
};

const PATHS: Record<OpenAIGatewayApi, string> = {
	"openai-responses": "/v1/responses",
	"openai-completions": "/v1/chat/completions",
};

/**
 * The gateway's `models.yml` for its OpenAI APIs: claude-opus-5-5, whose thinking binds the conversation's prefix on
 * every host, on each, behind a host whose compat sends strict tools, with five-minute and one-hour cache lifetimes.
 */
export function openAIGatewayModelsYml(): string {
	const providers = Object.entries(OPENAI_GATEWAY_PROVIDERS).map(
		([api, provider]) => `  ${provider}:
    baseUrl: ${GATEWAY}/v1
    api: ${api}
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      supportsStrictMode: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}, promptCache: {short: 300, long: 3600}}
`,
	);
	return `providers:\n${providers.join("")}`;
}

/** The gateway's claude-opus-5-5 in `modelRegistry`, on `api`, or on Anthropic's messages API without one. */
export function gatewayModel(modelRegistry: ModelRegistry, api?: OpenAIGatewayApi): Model<Api> {
	const provider = api ? OPENAI_GATEWAY_PROVIDERS[api] : "anthropic";
	const model = modelRegistry.find(provider, "claude-opus-5-5");
	if (!model) throw new Error(`Expected the gateway's ${provider} claude-opus-5-5`);
	return model;
}

/** A request body as far as the tests read it, on the gateway's Anthropic or OpenAI APIs. */
export interface GatewayRequest {
	/** The system prompt of a `/v1/messages` request. */
	system?: unknown;
	/** The system prompt a Responses request sends as its instructions. */
	instructions?: unknown;
	tools?: unknown[];
	/** The messages of a `/v1/messages` or chat completions request. */
	messages?: WireMessage[];
	/** The input items of a Responses request. */
	input?: WireMessage[];
}

/** A streamed text reply, `seen <turn>`, that read 100 of its request's 110 prompt tokens from the cache. */
function answer(api: OpenAIGatewayApi, turn: number): Response {
	const text = `seen ${turn}`;
	const events =
		api === "openai-responses"
			? [
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: `msg_${turn}`, role: "assistant", status: "in_progress", content: [] },
					},
					{
						type: "response.output_text.delta",
						item_id: `msg_${turn}`,
						output_index: 0,
						content_index: 0,
						delta: text,
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: `msg_${turn}`,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: `resp_${turn}`,
							status: "completed",
							usage: {
								input_tokens: 110,
								output_tokens: 3,
								total_tokens: 113,
								input_tokens_details: { cached_tokens: 100 },
							},
						},
					},
				]
			: [
					{ id: `chatcmpl-${turn}`, choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
					{ id: `chatcmpl-${turn}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{
						id: `chatcmpl-${turn}`,
						choices: [],
						usage: {
							prompt_tokens: 110,
							completion_tokens: 3,
							total_tokens: 113,
							prompt_tokens_details: { cached_tokens: 100 },
						},
					},
					"[DONE]",
				];
	const body = events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Spies on `fetch` as the gateway's `api`: each request to its path is recorded and answered with what `refuse` gives
 * for it, else a text reply that read the cache; a request to any other URL throws.
 */
export function mockOpenAIGatewayFetch(
	api: OpenAIGatewayApi,
	refuse?: (request: GatewayRequest) => Response | undefined,
): { requests: GatewayRequest[]; restore(): void } {
	const requests: GatewayRequest[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (input, init) => {
			if (String(input) !== `${GATEWAY}${PATHS[api]}`) throw new Error(`Unexpected request to ${String(input)}`);
			const request: GatewayRequest = JSON.parse(requestBodyText(init) ?? "{}");
			requests.push(request);
			return refuse?.(request) ?? answer(api, requests.length);
		}),
	);
	return { requests, restore: () => spy.mockRestore() };
}
