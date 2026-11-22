import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * The model a configured name sends to, as pi-ai's model-call guards read it (`guardedRequestUrl`).
 *
 * `<provider>/<id>` is that provider's model, so `openai/text-embedding-3-small` is OpenAI's. A name with
 * no provider is the configured endpoint's own model, which the catalog cannot place: its family is
 * unknown, and a hold that covers unknown families (coding-agent's `cyber_policy` hold) covers it. The
 * model only answers the guards; the request still names the configured string.
 */
export function configuredModel(name: string, baseUrl: string): Model<Api> {
	const slash = name.indexOf("/");
	const provider = slash > 0 ? name.slice(0, slash) : "mnemopi";
	const id = slash > 0 ? name.slice(slash + 1) : name;
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	});
}
