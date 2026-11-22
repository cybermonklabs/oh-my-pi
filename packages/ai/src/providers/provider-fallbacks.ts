/**
 * The fallbacks the providers keep in a session's provider state: an endpoint rejected part of a request with a 400,
 * so the provider retried without it and leaves it out of every later request for that endpoint and model until its
 * state for them is closed. Anthropic keeps them on its state for an endpoint and model (strict tools, unsigned
 * thinking replayed as thinking, replayed thinking at all, `cache_control` breakpoints or their `ttl`/`scope`, and
 * the thinking blocks it strips after a prefix-binding or modified-thinking 400); chat completions and Responses keep
 * the strict-tools fallback as a scope of their {@link OpenAIStrictToolsState}. This module reads those states without
 * loading the providers, and tells a session's owner each time a provider turns one on, so the owner can keep them
 * with the session and put them back in a later process, whose requests then leave out what the endpoint rejected.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Api, Model, ProviderSessionState } from "../types";
import { ANTHROPIC_PROVIDER_SESSION_STATE_KEY, parseAnthropicProviderSessionStateKey } from "./anthropic-state";
import { OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX } from "./openai-completions-state";
import { OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX } from "./openai-responses-state";
import type { OpenAIStrictToolsState } from "./openai-shared";
import { isOpenAIToolsModel, openAIToolsApi } from "./openai-tool-strict";
import { isAnthropicMessagesModel } from "./transform-messages";

/**
 * Each fallback Anthropic's state keeps as a flag, with the flag: tools sent without `strict`; unsigned thinking
 * replayed as text; no replayed thinking; no `cache_control` breakpoint; breakpoints without `ttl` and `scope`.
 */
export const ANTHROPIC_FALLBACK_FLAGS = {
	"strict-tools": "strictToolsDisabled",
	"unsigned-thinking-replay": "replayUnsignedThinkingDisabled",
	"thinking-replay": "thinkingReplayDisabled",
	"cache-control": "cacheControlUnsupported",
	"cache-control-options": "cacheControlOptionsUnsupported",
} as const;

/** A fallback Anthropic's state keeps as a flag ({@link ANTHROPIC_FALLBACK_FLAGS}). */
export type AnthropicFallbackFlag = keyof typeof ANTHROPIC_FALLBACK_FLAGS;

/**
 * A fallback Anthropic's state keeps for an endpoint and a model: what its requests there leave out (`off`), and for
 * `thinking-blocks` the replay keys of the thinking blocks it strips (`thinking:<signature>`, `redacted:<data>`).
 */
export type AnthropicFallback =
	| { api: "anthropic-messages"; baseUrl: string; modelId: string; off: AnthropicFallbackFlag }
	| { api: "anthropic-messages"; baseUrl: string; modelId: string; off: "thinking-blocks"; blocks: string[] };

/** The strict-tools fallback chat completions or Responses keeps for a provider, an endpoint and a model. */
export interface OpenAIStrictToolsFallback {
	api: "openai-completions" | "openai-responses";
	provider: string;
	baseUrl: string;
	modelId: string;
	off: "strict-tools";
}

/** A fallback a provider state keeps. It names no credential. */
export type ProviderFallback = AnthropicFallback | OpenAIStrictToolsFallback;

/** Whether `value` is a {@link ProviderFallback}, as a session record holds it. */
export function isProviderFallback(value: unknown): value is ProviderFallback {
	if (!isRecord(value) || typeof value.baseUrl !== "string" || typeof value.modelId !== "string") return false;
	if (value.api === "anthropic-messages") {
		if (value.off === "thinking-blocks") {
			return Array.isArray(value.blocks) && value.blocks.every(block => typeof block === "string");
		}
		return typeof value.off === "string" && Object.hasOwn(ANTHROPIC_FALLBACK_FLAGS, value.off);
	}
	return (
		(value.api === "openai-completions" || value.api === "openai-responses") &&
		typeof value.provider === "string" &&
		value.off === "strict-tools"
	);
}

/**
 * The fallbacks the provider states in `providerSessionState` keep, in the map's order. A state an injected Anthropic
 * client without a base URL keeps outside the map is not among them.
 */
export function providerFallbacks(providerSessionState: ReadonlyMap<string, ProviderSessionState>): ProviderFallback[] {
	const fallbacks: ProviderFallback[] = [];
	for (const [key, state] of providerSessionState) {
		const anthropicScope = parseAnthropicProviderSessionStateKey(key);
		if (anthropicScope) {
			const { baseUrl, modelId } = anthropicScope;
			for (const [off, flag] of Object.entries(ANTHROPIC_FALLBACK_FLAGS) as [AnthropicFallbackFlag, string][]) {
				if (flag in state && (state as unknown as Record<string, unknown>)[flag] === true) {
					fallbacks.push({ api: "anthropic-messages", baseUrl, modelId, off });
				}
			}
			const blocks = anthropicDroppedThinkingBlocks(state);
			if (blocks && blocks.size > 0) {
				fallbacks.push({
					api: "anthropic-messages",
					baseUrl,
					modelId,
					off: "thinking-blocks",
					blocks: [...blocks],
				});
			}
			continue;
		}
		const api = openAIStrictToolsApi(key);
		if (!api || !hasOpenAIStrictToolsState(state)) continue;
		for (const scope of state.strictTools.disabledModelScopes.values()) {
			fallbacks.push({
				api,
				provider: scope.provider,
				baseUrl: scope.baseUrl ?? "",
				modelId: scope.modelId,
				off: "strict-tools",
			});
		}
	}
	return fallbacks;
}

/**
 * Whether a provider state in `providerSessionState` keeps the strict-tools fallback for `model`'s next request, so
 * that request sends no tool as strict where the fallback applies: on Anthropic's messages API, a state for the model's
 * id, whichever endpoint it names (a transport may swap in the endpoint the provider keys its state on, as Snowflake's
 * and Cloudflare's do for their placeholder URLs, and GitHub Copilot's token decides its own); on chat completions or
 * Responses (an `openrouter` model's as it routes), a scope of the model's provider and id, whichever endpoint it
 * names. Codex keeps no fallback.
 */
export function strictToolsFallbackHolds(
	providerSessionState: ReadonlyMap<string, ProviderSessionState> | undefined,
	model: Model<Api>,
): boolean {
	if (!providerSessionState || providerSessionState.size === 0) return false;
	if (isAnthropicMessagesModel(model)) {
		for (const [key, state] of providerSessionState) {
			if (
				"strictToolsDisabled" in state &&
				state.strictToolsDisabled === true &&
				parseAnthropicProviderSessionStateKey(key)?.modelId === model.id
			) {
				return true;
			}
		}
		return false;
	}
	if (!isOpenAIToolsModel(model)) return false;
	switch (openAIToolsApi(model)) {
		case "openai-codex-responses":
			return false;
		case "openai-responses": {
			const state = providerSessionState.get(`${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`);
			return state !== undefined && keepsStrictToolsFallback(state, model);
		}
		case "openai-completions": {
			const prefix = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:`;
			for (const [key, state] of providerSessionState) {
				if (key.startsWith(prefix) && keepsStrictToolsFallback(state, model)) return true;
			}
			return false;
		}
	}
}

/** Turns off every fallback the provider states in `providerSessionState` keep. */
export function clearProviderFallbacks(providerSessionState: ReadonlyMap<string, ProviderSessionState>): void {
	const anthropicPrefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, state] of providerSessionState) {
		if (key.startsWith(anthropicPrefix)) {
			for (const flag of Object.values(ANTHROPIC_FALLBACK_FLAGS)) {
				if (flag in state) Object.assign(state, { [flag]: false });
			}
			anthropicDroppedThinkingBlocks(state)?.clear();
		} else if (openAIStrictToolsApi(key) && hasOpenAIStrictToolsState(state)) {
			state.strictTools.disabledModelScopes.clear();
		}
	}
}

const providerFallbackListeners = new WeakMap<ReadonlyMap<string, ProviderSessionState>, () => void>();

/**
 * Has `listener` called each time a provider turns a fallback on for a request that keeps its state in
 * `providerSessionState`, once the state keeps it; `undefined` stops the calls. A map has one listener.
 */
export function onProviderFallback(
	providerSessionState: ReadonlyMap<string, ProviderSessionState>,
	listener: (() => void) | undefined,
): void {
	if (listener) providerFallbackListeners.set(providerSessionState, listener);
	else providerFallbackListeners.delete(providerSessionState);
}

/** Called by a provider once it turned a fallback on in `providerSessionState`. */
export function reportProviderFallback(
	providerSessionState: ReadonlyMap<string, ProviderSessionState> | undefined,
): void {
	const listener = providerSessionState && providerFallbackListeners.get(providerSessionState);
	if (!listener) return;
	try {
		listener();
	} catch (error) {
		logger.warn("provider fallback listener failed", { error: String(error) });
	}
}

/** The thinking blocks an Anthropic state strips, by replay key. */
function anthropicDroppedThinkingBlocks(state: ProviderSessionState): Set<string> | undefined {
	return "prefixDroppedThinkingBlocks" in state && state.prefixDroppedThinkingBlocks instanceof Set
		? (state.prefixDroppedThinkingBlocks as Set<string>)
		: undefined;
}

/** The API whose provider keeps its state under `key`, among those that keep strict-tools scopes. */
function openAIStrictToolsApi(key: string): "openai-completions" | "openai-responses" | undefined {
	if (key.startsWith(OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX)) return "openai-completions";
	if (key.startsWith(OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX)) return "openai-responses";
	return undefined;
}

/** Whether `state` keeps the strict-tools fallback for `model`'s provider and id, whichever endpoint it names. */
function keepsStrictToolsFallback(state: ProviderSessionState, model: Model<Api>): boolean {
	if (!hasOpenAIStrictToolsState(state)) return false;
	for (const scope of state.strictTools.disabledModelScopes.values()) {
		if (scope.provider === model.provider && scope.modelId === model.id) return true;
	}
	return false;
}

function hasOpenAIStrictToolsState(
	state: ProviderSessionState,
): state is ProviderSessionState & OpenAIStrictToolsState {
	return (
		"strictTools" in state &&
		typeof state.strictTools === "object" &&
		state.strictTools !== null &&
		"disabledModelScopes" in state.strictTools &&
		state.strictTools.disabledModelScopes instanceof Map
	);
}
