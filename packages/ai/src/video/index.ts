import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { guardModelRequest } from "../model-call-guard";
import {
	downloadOpenRouterVideo,
	pollOpenRouterVideo,
	submitOpenRouterVideo,
	type VideoOptions,
} from "./openrouter-video";
import type { VideoContent, VideoGenerationRequest, VideoJob } from "./types";

export * from "./openrouter-video";
export * from "./types";

/**
 * Submit an asynchronous video generation job through the model's transport. The prompt can be model-written,
 * so the request passes the process's model-call guard. {@link pollVideo} and {@link downloadVideo} send only
 * the job id and pass no guard: a job submitted before a hold can finish.
 */
export function submitVideo(
	model: Model<Api>,
	request: VideoGenerationRequest,
	options: VideoOptions,
): Promise<VideoJob> {
	return guardModelRequest(model, () => {
		if (model.api === "openrouter-video") return submitOpenRouterVideo(model, request, options);
		throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
	});
}

/** Poll an asynchronous video generation job through the model's transport. */
export function pollVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoJob> {
	if (model.api === "openrouter-video") return pollOpenRouterVideo(model, jobId, options);
	throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
}

/** Stream generated video content through the model's transport. */
export function downloadVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoContent> {
	if (model.api === "openrouter-video") return downloadOpenRouterVideo(model, jobId, options);
	throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
}
