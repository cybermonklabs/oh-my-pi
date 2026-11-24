/**
 * Synthetic provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Synthetic offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.synthetic.new/openai/v1/chat/completions
 * - Anthropic: https://api.synthetic.new/anthropic/v1/messages
 *
 * @see https://dev.synthetic.new/docs/api/overview
 */

import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimConfig,
	type OpenAIAnthropicShimOptions,
	openAIAnthropicShimModel,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type SyntheticApiFormat = OpenAIAnthropicApiFormat;

const SYNTHETIC_SHIM_CONFIG: OpenAIAnthropicShimConfig = {
	anthropicBaseUrl: "https://api.synthetic.new/anthropic",
	openaiBaseUrl: "https://api.synthetic.new/openai/v1",
	defaultFormat: "openai",
};

export interface SyntheticOptions extends OpenAIAnthropicShimOptions {
	/** API format: "openai" or "anthropic". Default: "openai" */
	format?: SyntheticApiFormat;
}

/**
 * Stream from Synthetic, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async processing happens internally.
 */
export function streamSynthetic(
	model: Model<"openai-completions">,
	context: Context,
	options?: SyntheticOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, SYNTHETIC_SHIM_CONFIG);
}

/** The model a Synthetic request on `model` goes out as in the API format `format` names, OpenAI's by default. */
export function syntheticRequestModel(model: Model<"openai-completions">, format?: SyntheticApiFormat): Model<Api> {
	return openAIAnthropicShimModel(model, format, SYNTHETIC_SHIM_CONFIG);
}
