import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { guardModelRequest } from "../model-call-guard";
import { rerankOpenRouter, type RerankOptions } from "./openrouter-rerank";
import type { RerankRequest, RerankResult } from "./types";

export * from "./openrouter-rerank";
export * from "./types";

/**
 * Dispatch reranking through the transport selected by the catalog model. The query and documents can be
 * drawn from a conversation, so the request passes the process's model-call guard.
 */
export function rerank(model: Model<Api>, request: RerankRequest, options: RerankOptions): Promise<RerankResult> {
	return guardModelRequest(model, () => {
		if (model.api === "openrouter-rerank") return rerankOpenRouter(model, request, options);
		throw new AIError.ConfigurationError(`Unsupported rerank API: ${model.api}`);
	});
}
