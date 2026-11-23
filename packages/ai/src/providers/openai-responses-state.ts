import { $flag } from "@oh-my-pi/pi-utils";
import type { Model, ProviderSessionState } from "../types";
import { releaseOpenAIEffortControlSession } from "./openai-configuration-update";
import {
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackState,
} from "./openai-reasoning-fallback";
import type {
	OpenAIResponsesChainState,
	OpenAIResponsesOptions,
	OpenAIResponsesProviderSessionState,
} from "./openai-responses";
import {
	clearOpenAIStrictToolsState,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	normalizeOpenAIPromptCacheKey,
	type OpenAIStrictToolsScope,
} from "./openai-shared";

/** Prefix shared by Responses request state and credential-reset hooks. */
export const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
/**
 * Whether the next request for `model` replays native Responses history items
 * (encrypted reasoning, item ids), matching request construction. A session
 * is cold, rebuilding turns from message content, from the first request on a
 * connection-bound host (`compat.connectionBoundNativeHistory`, GitHub Copilot)
 * and after `close()` on any host, until a response succeeds. Without session
 * state every request replays. Transport selection does not change this rule.
 */
export function openAIResponsesReplaysNativeHistory(
	model: Pick<Model, "api" | "provider" | "compat"> | null | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): boolean {
	if (!providerSessionState || (model?.api !== "openai-responses" && model?.api !== "openrouter")) return true;
	const state = providerSessionState.get(`${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`) as
		| OpenAIResponsesProviderSessionState
		| undefined;
	if (state) return state.nativeHistoryReplayWarmed;
	const compat = model.compat;
	return !(compat && "connectionBoundNativeHistory" in compat && compat.connectionBoundNativeHistory);
}

function createOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
): OpenAIResponsesProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAIResponsesProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		nativeHistoryReplayWarmed: !model.compat.connectionBoundNativeHistory,
		closeCount: 0,
		chains: new Map(),
		effortControls: new Map(),
		releaseSession: sessionId => {
			const normalizedSessionId = normalizeOpenAIPromptCacheKey(sessionId);
			if (!normalizedSessionId) return;
			for (const [key, chain] of state.chains) {
				if (chain.sessionId === normalizedSessionId) state.chains.delete(key);
			}
			releaseOpenAIEffortControlSession(state.effortControls, normalizedSessionId);
			state.transports?.releaseSession(normalizedSessionId);
		},
		close: () => {
			state.nativeHistoryReplayWarmed = false;
			state.closeCount++;
			state.chains.clear();
			state.effortControls.clear();
			state.transports?.close();
			state.transports = undefined;
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

/** Return or initialize the Responses state for `model`'s provider in a session's provider state. */
export function getOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAIResponsesProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`;
	const existing = providerSessionState.get(key) as OpenAIResponsesProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAIResponsesProviderSessionState(model);
	providerSessionState.set(key, created);
	return created;
}

/**
 * Puts back the strict-tools fallback an earlier process of the session kept for `scope` (see
 * `@oh-my-pi/pi-ai/providers/provider-fallbacks`): requests for `model`'s provider send no tool as strict for that
 * scope, as the requests after the endpoint rejected strict tools did.
 */
export function restoreOpenAIResponsesStrictToolsFallback(
	providerSessionState: Map<string, ProviderSessionState>,
	model: Model<"openai-responses">,
	scope: OpenAIStrictToolsScope,
): void {
	disableStrictToolsForScope(getOpenAIResponsesProviderSessionState(model, providerSessionState), scope);
}

/** Host per-provider storage defaults; see {@link configureProviderStoreResponses}. */
let configuredProviderStoreResponses: Readonly<Record<string, boolean>> = {};

/**
 * Set the process-wide storage default per provider id, used when a request
 * leaves `storeResponses` unset. Hosts call this from their settings so every
 * request follows the setting, including direct `streamSimple`/`completeSimple`
 * side calls that do not pass per-request options. `PI_MUSE_STORE_RESPONSES`
 * still overrides it.
 */
export function configureProviderStoreResponses(byProvider: Readonly<Record<string, boolean>> | undefined): void {
	configuredProviderStoreResponses = byProvider ?? {};
}

/**
 * Whether this request stores its result server-side. Only hosts whose rule
 * sets `store-responses` (they finish runs after a client disconnect, so a
 * dropped stream can be resumed) are eligible, and storage is opt-in:
 * `options.storeResponses`, then `PI_MUSE_STORE_RESPONSES`, then the host
 * default ({@link configureProviderStoreResponses}), else off. Privacy: stored
 * runs retain prompts and outputs on the provider. Off also disables resume and
 * the `previous_response_id` chaining that needs storage.
 */
export function storesResponsesServerSide(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
): boolean {
	if (model.compat.storeResponses !== true) return false;
	return (
		options?.storeResponses ??
		$flag("PI_MUSE_STORE_RESPONSES", configuredProviderStoreResponses[model.provider] ?? false)
	);
}

/** Forget server-side append baselines while preserving the chain's failure history. */
export function resetOpenAIResponsesChainState(state: OpenAIResponsesChainState): void {
	state.canAppend = false;
	state.lastParams = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
	state.lastPromptCacheBreakpointPolicy = undefined;
}

/**
 * Drop the account-bound half of every retained `openai-responses` record in
 * `states`: the stateful `previous_response_id` chain baselines.
 *
 * Chaining stores the turn server-side under the account that created it, so a
 * baseline minted by one credential is dead weight the moment the session is
 * switched to a sibling account — the next delta request answers
 * `Previous response not found` and burns a turn re-learning that. Everything
 * else this record holds describes the *deployment*, not the account
 * (strict-tools demotion, reasoning-effort fallback, native-history-replay
 * warmup, the chaining circuit breaker), and is deliberately preserved:
 * re-learning an endpoint's limits on every credential switch is the cost this
 * state exists to avoid.
 */
export function resetOpenAIResponsesAccountScopedState(states: Map<string, ProviderSessionState>): void {
	for (const [key, value] of states) {
		if (!key.startsWith(OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX)) continue;
		const state = value as OpenAIResponsesProviderSessionState;
		for (const chain of state.chains.values()) {
			resetOpenAIResponsesChainState(chain);
			// The stale-failure counter tallies the previous account's 404s; a
			// fresh account must not inherit a tripped circuit breaker.
			chain.staleFailures = 0;
		}
	}
}
