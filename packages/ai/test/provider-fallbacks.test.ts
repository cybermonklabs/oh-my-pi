import { describe, expect, it } from "bun:test";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { resolveAnthropicBaseUrl } from "@oh-my-pi/pi-ai/providers/anthropic-http-options";
import { anthropicProviderSessionStateKey } from "@oh-my-pi/pi-ai/providers/anthropic-state";
import { strictToolsFallbackHolds } from "@oh-my-pi/pi-ai/providers/provider-fallbacks";
import { snowflakeTransport } from "@oh-my-pi/pi-ai/registry/snowflake";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

/**
 * The agent's declared-tools fingerprint counts the strict-tools fallback the provider keeps after an endpoint
 * rejected strict tools. A Snowflake catalog row carries a placeholder origin; its transport swaps in the account URL
 * before the provider keys its state on the endpoint, so a lookup by the row's own URL never finds the fallback and the
 * fingerprint names strict tools the requests no longer send.
 */
describe("strictToolsFallbackHolds on Anthropic's messages API", () => {
	const model = getBundledModel("snowflake", "claude-opus-4-6") as Model<"anthropic-messages"> | undefined;
	if (!model) throw new Error("expected the bundled Snowflake claude-opus-4-6");

	/** A session's provider state with the strict-tools fallback the provider keeps for `modelId` at `sent`'s endpoint. */
	function stateAfterFallback(sent: Model<"anthropic-messages">, modelId: string): Map<string, ProviderSessionState> {
		const baseUrl = resolveAnthropicBaseUrl(sent);
		if (!baseUrl) throw new Error("expected the endpoint the request went to");
		return new Map([[anthropicProviderSessionStateKey(baseUrl, modelId), { strictToolsDisabled: true, close() {} }]]);
	}

	const prepared = snowflakeTransport.prepareRequest?.(model, {
		apiKey: JSON.stringify({ token: "pat", enterpriseUrl: "myorg-myaccount" }),
	});
	const sent = prepared?.model as Model<"anthropic-messages"> | undefined;
	if (!sent) throw new Error("expected the transport to prepare the request");

	it("finds the fallback kept for the endpoint the transport swapped in", () => {
		// Precondition: the request went to another endpoint than the catalog row names.
		expect(sent.baseUrl).not.toBe(model.baseUrl);

		expect(strictToolsFallbackHolds(stateAfterFallback(sent, model.id), model)).toBe(true);
	});

	it("does not take another model's fallback for this one", () => {
		expect(strictToolsFallbackHolds(stateAfterFallback(sent, "claude-haiku-4-5"), model)).toBe(false);
	});
});
