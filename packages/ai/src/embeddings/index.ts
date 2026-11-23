import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { guardModelRequest } from "../model-call-guard";
import { embedOpenAI, type EmbeddingOptions } from "./openai-embeddings";
import type { EmbeddingRequest, EmbeddingResult } from "./types";

export * from "./openai-embeddings";
export * from "./types";

/**
 * Dispatch an embedding request through the transport selected by the catalog model. The input can be drawn
 * from a conversation, so the request passes the process's model-call guard.
 */
export function embed(
	model: Model<Api>,
	request: EmbeddingRequest,
	options: EmbeddingOptions,
): Promise<EmbeddingResult> {
	return guardModelRequest(model, () => {
		if (model.api === "openai-embeddings") return embedOpenAI(model, request, options);
		throw new AIError.ConfigurationError(`Unsupported embeddings API: ${model.api}`);
	});
}
