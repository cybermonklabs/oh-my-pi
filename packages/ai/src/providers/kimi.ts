/**
 * Kimi Code provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Kimi offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.kimi.com/coding/v1/chat/completions
 * - Anthropic: https://api.kimi.com/coding/v1/messages
 *
 * Each discovered model selects its server-declared protocol; legacy models
 * without protocol metadata retain the Anthropic-compatible default.
 */

import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimConfig,
	type OpenAIAnthropicShimOptions,
	openAIAnthropicShimModel,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	/** Explicit API format override. Defaults to the model's resolved protocol policy. */
	format?: KimiApiFormat;
}

/** The shim config of a Kimi Code model, whose default API format is its resolved one, else `format`. */
function kimiShimConfig(
	model: Model<"openai-completions">,
	format: KimiApiFormat | undefined,
): OpenAIAnthropicShimConfig {
	const defaultFormat = model.compat.kimiApiFormat ?? format;
	if (defaultFormat === undefined) {
		throw new Error(`Kimi Code model ${model.id} has no resolved API format`);
	}
	return {
		anthropicBaseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
		defaultFormat,
		anthropicThinkingMode: model.compat.thinkingFormat === "kimi" ? "anthropic-adaptive" : undefined,
		forwardCacheOptions: true,
		extraHeaders: getKimiCommonHeaders,
	};
}

/**
 * Stream from Kimi Code, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async header fetching happens internally.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, kimiShimConfig(model, options?.format));
}

/**
 * The model a Kimi Code request on `model` goes out as: in the API format `format` names (an explicit override), else
 * in the model's resolved one ({@link openAIAnthropicShimModel}); `model` itself when neither names one.
 */
export function kimiRequestModel(model: Model<"openai-completions">, format?: KimiApiFormat): Model<Api> {
	if (format === undefined && model.compat.kimiApiFormat === undefined) return model;
	return openAIAnthropicShimModel(model, format, kimiShimConfig(model, format));
}
