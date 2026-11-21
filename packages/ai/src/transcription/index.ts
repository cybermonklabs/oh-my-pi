import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { transcribeOpenAI, type TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

export * from "./openai-transcriptions";
export * from "./types";

/**
 * Dispatch an audio transcription through the transport selected by the catalog model. It passes no
 * model-call guard: its input is recorded audio, in coding-agent only a person's own dictated speech, so a
 * hold does not keep a person from dictating.
 */
export function transcribeAudio(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	if (model.api === "openai-transcriptions") return transcribeOpenAI(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported transcription API: ${model.api}`);
}
