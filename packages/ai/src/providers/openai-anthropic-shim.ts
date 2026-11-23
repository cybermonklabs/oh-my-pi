/**
 * Shared implementation for providers that expose BOTH an OpenAI-compatible
 * and an Anthropic-compatible API surface against the same model catalog
 * (currently Kimi Code and Synthetic).
 *
 * Each call site supplies the provider-specific bits (base URLs, default
 * format, optional extra headers); the streaming/forwarding plumbing lives
 * here once.
 */

import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ANTHROPIC_THINKING, mapAnthropicToolChoice } from "../stream";
import type { Context, Model, ModelSpec, SimpleStreamOptions, ThinkingControlMode } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";

export type OpenAIAnthropicApiFormat = "openai" | "anthropic";

export interface OpenAIAnthropicShimOptions extends SimpleStreamOptions {
	/** API format: "openai" or "anthropic". */
	format?: OpenAIAnthropicApiFormat;
}

export interface OpenAIAnthropicShimConfig {
	/** Base URL for the Anthropic-compatible endpoint (without trailing /v1/messages). */
	anthropicBaseUrl: string;
	/** Optional override for the OpenAI-compatible base URL. If omitted, `model.baseUrl` is used as-is. */
	openaiBaseUrl?: string;
	/** Default API format when caller does not specify one. */
	defaultFormat: OpenAIAnthropicApiFormat;
	/** Thinking transport used when this provider's Anthropic endpoint differs from generic budget semantics. */
	anthropicThinkingMode?: ThinkingControlMode;
	/** Forward cache-retention and request-metadata options to the selected transport. Default: false. */
	forwardCacheOptions?: boolean;
	/** Provider-specific headers (e.g. auth/session) merged ahead of user-supplied headers. */
	extraHeaders?: () => Record<string, string>;
}

/**
 * The model a request on `model` goes out as in `format` (`config.defaultFormat` when undefined): on the
 * Anthropic-compatible endpoint, a messages model of the same id and limits, under `config.anthropicThinkingMode`
 * when the config names one; on the OpenAI-compatible endpoint, `model` rebuilt for `config.openaiBaseUrl`, or `model`
 * itself without one. `headers` ride the model a stream sends.
 */
export function openAIAnthropicShimModel(
	model: Model<"openai-completions">,
	format: OpenAIAnthropicApiFormat | undefined,
	config: OpenAIAnthropicShimConfig,
	headers?: Record<string, string>,
): Model<"anthropic-messages"> | Model<"openai-completions"> {
	if ((format ?? config.defaultFormat) === "anthropic") {
		return buildModel({
			id: model.id,
			name: model.name,
			api: "anthropic-messages",
			provider: model.provider,
			baseUrl: config.anthropicBaseUrl,
			headers,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			...(config.anthropicThinkingMode && model.thinking
				? { thinking: { ...model.thinking, mode: config.anthropicThinkingMode } }
				: {}),
			input: model.input,
			cost: model.cost,
		} as ModelSpec<"anthropic-messages">);
	}
	return config.openaiBaseUrl
		? buildModel({
				...model,
				baseUrl: config.openaiBaseUrl,
				headers,
				compat: model.compatConfig,
			} as ModelSpec<"openai-completions">)
		: model;
}

/**
 * Stream from an OpenAI-or-Anthropic compatible provider. Returns synchronously;
 * async header fetching and stream piping happen internally.
 */
export function streamOpenAIAnthropicShim(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAIAnthropicShimOptions | undefined,
	config: OpenAIAnthropicShimConfig,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	// The resolver form of `apiKey` is resolved upstream in `streamSimple`;
	// this shim only ever receives a static bearer string.
	const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;

	(async () => {
		try {
			const mergedHeaders = {
				...config.extraHeaders?.(),
				...options?.headers,
			};

			const requestModel = openAIAnthropicShimModel(model, options?.format, config, mergedHeaders);
			if (requestModel.api === "anthropic-messages") {
				const reasoningEffort = options?.reasoning;
				const thinkingEnabled = !!reasoningEffort && model.reasoning && !options?.disableReasoning;
				const thinkingBudget = reasoningEffort
					? (options?.thinkingBudgets?.[reasoningEffort] ?? ANTHROPIC_THINKING[reasoningEffort])
					: undefined;

				const innerStream = streamAnthropic(requestModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					cacheRetention: config.forwardCacheOptions ? options?.cacheRetention : undefined,
					metadata: config.forwardCacheOptions ? options?.metadata : undefined,
					sessionId: options?.sessionId,
					parentSessionId: options?.parentSessionId,
					promptCacheKey: options?.promptCacheKey,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					thinkingEnabled,
					thinkingBudgetTokens: thinkingBudget,
					reasoning: config.anthropicThinkingMode ? reasoningEffort : undefined,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
					waitForTerminalDrain: options?.waitForTerminalDrain,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			} else {
				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(requestModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					maxHttpAttempts: options?.maxHttpAttempts,
					signal: options?.signal,
					headers: mergedHeaders,
					cacheRetention: config.forwardCacheOptions ? options?.cacheRetention : undefined,
					metadata: config.forwardCacheOptions ? options?.metadata : undefined,
					sessionId: options?.sessionId,
					parentSessionId: options?.parentSessionId,
					promptCacheKey: options?.promptCacheKey,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					reasoning: reasoningEffort,
					toolChoice: options?.toolChoice,
					serviceTier: options?.serviceTier,
					disableReasoning: options?.disableReasoning,
					waitForTerminalDrain: options?.waitForTerminalDrain,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
