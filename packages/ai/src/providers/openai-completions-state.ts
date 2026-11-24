import type { Model, ProviderSessionState } from "../types";
import {
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackState,
	type OpenAIReasoningEffortFallbackState,
} from "./openai-reasoning-fallback";
import {
	clearOpenAIStrictToolsState,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
} from "./openai-shared";

/** Prefix of a chat completions provider state key: `openai-completions:<provider>:<baseUrl>:<modelId>`. */
export const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

/** What chat completions keeps for a provider, an endpoint and a model across a session's requests. */
export type OpenAICompletionsProviderSessionState = ProviderSessionState &
	OpenAIStrictToolsState &
	OpenAIReasoningEffortFallbackState;

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAICompletionsProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		close: () => {
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

/** Return or initialize the chat completions state for `model` at `baseUrl` in a session's provider state. */
export function getOpenAICompletionsProviderSessionState(
	model: Pick<Model<"openai-completions">, "provider" | "id">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

/**
 * Puts back the strict-tools fallback an earlier process of the session kept for `scope` (see
 * `@oh-my-pi/pi-ai/providers/provider-fallbacks`): its requests send no tool as strict, as the requests after the
 * endpoint rejected strict tools did.
 */
export function restoreOpenAICompletionsStrictToolsFallback(
	providerSessionState: Map<string, ProviderSessionState>,
	scope: OpenAIStrictToolsScope,
): void {
	const state = getOpenAICompletionsProviderSessionState(
		{ provider: scope.provider, id: scope.modelId },
		scope.baseUrl,
		providerSessionState,
	);
	disableStrictToolsForScope(state, scope);
}
