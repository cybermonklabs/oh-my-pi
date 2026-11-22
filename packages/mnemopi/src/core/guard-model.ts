import type { Api, Model } from "@oh-my-pi/pi-ai";
import { isCyberPolicyRefusal, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { captureOpenAIHttpError } from "@oh-my-pi/pi-ai/utils/openai-http";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * The model a configured name sends to, as pi-ai's model-call guards read it (`guardModelRequest`,
 * `guardedRequestUrl`).
 *
 * `<provider>/<id>` splits into the model's provider and id; a name with no provider gets the provider
 * `mnemopi`. The family a guard judges comes from the id: the catalog places it by the id, so
 * `openai/text-embedding-3-small` is OpenAI's and an id it cannot place (`house-summarizer`) is of an
 * unknown family, which coding-agent's `cyber_policy` hold also covers. The provider only names the
 * route, as in that hold's message (`…no request goes to openai/gpt-4o-mini…`). The model only answers
 * the guards; the request still names the configured string.
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

/**
 * `fetchWithRetry`'s `shouldRetryResponse` for a configured endpoint: a `cyber_policy` refusal is never sent
 * again, even when a gateway relays it as a 5xx. Every copy sent again adds a refusal to the organization's
 * record.
 */
export function retryUnlessCyberPolicy(_response: Response, bodyText: string): boolean {
	return !isCyberPolicyRefusal(bodyText);
}

/**
 * A configured endpoint's response that is not ok, as the error its request throws inside
 * `guardModelRequest`: the decoded body is the cause and its text the message, so a guard sees a
 * `cyber_policy` refusal the endpoint relays (with its code) before the caller turns it into no result.
 */
export async function configuredRequestError(label: string, response: Response): Promise<ProviderHttpError> {
	const cause = await captureOpenAIHttpError(response);
	const detail = (cause.captured.bodyText ?? "").trim();
	return new ProviderHttpError(detail || `${label} (${response.status} ${response.statusText})`, response.status, {
		headers: response.headers,
		cause,
	});
}
