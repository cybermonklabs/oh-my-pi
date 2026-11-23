import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { wireModel } from "@oh-my-pi/pi-ai/providers/wire-model";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { anthropicChunks, type CapturedRequest, captureFetch, completionsChunks } from "./helpers/factory-droid";

/**
 * The prompt cache's decisions (the strict flags a request sends, its tool choice) read the model `wireModel` gives
 * for the model a request goes out as. Synthetic sends a request to its Anthropic-compatible endpoint or to its
 * OpenAI-compatible one by the API format the request selects; a `wireModel` that named the other endpoint's model
 * would have those decisions read another API than the request's.
 */
describe("wireModel on a Synthetic model", () => {
	const model = getBundledModel("synthetic", "hf:moonshotai/Kimi-K3");

	it.each([
		{ format: "anthropic", api: "anthropic-messages" },
		{ format: "openai", api: "openai-completions" },
	] as const)("is the $format endpoint's model when the request selects that format", async ({ format, api }) => {
		const captured: CapturedRequest[] = [];
		const fetch = captureFetch(
			captured,
			format === "anthropic" ? anthropicChunks("ok") : completionsChunks("ok", model.id),
		);
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "not-a-secret", syntheticApiFormat: format, fetch },
		).result();
		const wire = wireModel(model, { syntheticApiFormat: format });

		expect({ api: wire.api, sentToWireHost: captured[0]?.url.startsWith(wire.baseUrl) }).toEqual({
			api,
			sentToWireHost: true,
		});
	});
});
