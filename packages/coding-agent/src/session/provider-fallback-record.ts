import type { Api, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { restoreAnthropicFallback } from "@oh-my-pi/pi-ai/providers/anthropic";
import { restoreOpenAICompletionsStrictToolsFallback } from "@oh-my-pi/pi-ai/providers/openai-completions-state";
import { restoreOpenAIResponsesStrictToolsFallback } from "@oh-my-pi/pi-ai/providers/openai-responses-state";
import {
	clearProviderFallbacks,
	isProviderFallback,
	type ProviderFallback,
	providerFallbacks,
} from "@oh-my-pi/pi-ai/providers/provider-fallbacks";
import { wireModel } from "@oh-my-pi/pi-ai/providers/wire-model";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { SessionManager } from "./session-manager";

/**
 * Custom session entry holding `{ version: 1, fallbacks: ProviderFallback[] }`: the fallbacks the session's provider
 * state keeps (an endpoint rejected part of a request with a 400, so the provider leaves it out of that model's
 * requests there), written each time they change, but a `cache_control` fallback ({@link outlivesProviderState}). The
 * newest record on any branch is the session's: a process that reads the session's entries in whole puts those
 * fallbacks back before it sends anything.
 */
const PROVIDER_FALLBACKS_ENTRY_TYPE = "provider-fallbacks";

/** What a {@link ProviderFallbackRecord} reads and writes. */
export interface ProviderFallbackRecordHost {
	sessionManager: Pick<
		SessionManager,
		"getEntries" | "getSessionId" | "appendCustomEntry" | "loadRevision" | "bodyRevision"
	>;
	/** The session's provider state, which the providers' requests keep their fallbacks in. */
	providerSessionState: Map<string, ProviderSessionState>;
	/** Where the model a recorded Responses fallback names is found: its provider state starts from the model's compat. */
	modelRegistry: Pick<ModelRegistry, "find" | "getProviderModels">;
}

/** The newest record of one read of the session's entries, kept current by the record's own writes. */
interface NewestRecord {
	sessionId: string;
	loadRevision: number;
	bodyRevision: number;
	fallbacks: ProviderFallback[];
	/** {@link fallbacksKey} of `fallbacks`. */
	key: string;
}

/**
 * Keeps the session's provider state and its newest {@link PROVIDER_FALLBACKS_ENTRY_TYPE} record holding the same
 * fallbacks. A read of the session's entries in whole (a resume, a `/resume` switch or reload, `omp --fork`, a
 * restored state), or provider state dropped with the session it held ({@link forget}), puts the newest record's
 * fallbacks in the provider state in place of what it kept, so the first request leaves out what the endpoint
 * rejected, as the last request of the session did; a provider state change since (a fallback turned on, a model
 * switch or `/fresh` that closed the state keeping one) and a copy of the session that lacks a record of what the
 * provider state keeps (a branch into a new file) write a new record. A `cache_control` fallback is the exception: it
 * stays with the provider state that learned it, through such a read too, and no record holds it
 * ({@link outlivesProviderState}).
 */
export class ProviderFallbackRecord {
	readonly #host: ProviderFallbackRecordHost;
	/** {@link SessionManager.loadRevision} of the read whose newest record the provider state took in. */
	#takenRevision: number | undefined;
	#newest: NewestRecord | undefined;

	constructor(host: ProviderFallbackRecordHost) {
		this.#host = host;
	}

	/**
	 * Takes the newest record into the provider state when it has not taken in the current read of the session's
	 * entries, then records the provider state's fallbacks where they differ from the newest record. Another session
	 * at the same read (a copy, `/new`) keeps what the provider state holds.
	 */
	sync(): void {
		const newest = this.#newestRecord();
		if (this.#takenRevision !== newest.loadRevision) this.#restore(newest.fallbacks);
		this.#takenRevision = newest.loadRevision;
		const held = providerFallbacks(this.#host.providerSessionState).filter(outlivesProviderState);
		const key = fallbacksKey(held);
		if (key === newest.key) return;
		this.#host.sessionManager.appendCustomEntry(PROVIDER_FALLBACKS_ENTRY_TYPE, { version: 1, fallbacks: held });
		newest.fallbacks = held;
		newest.key = key;
	}

	/** The provider state was closed with the session it held: the next {@link sync} takes the newest record in. */
	forget(): void {
		this.#takenRevision = undefined;
	}

	/** The newest record on any branch of the session's entries, read again for another session id or read. */
	#newestRecord(): NewestRecord {
		const sessionManager = this.#host.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const loadRevision = sessionManager.loadRevision;
		const bodyRevision = sessionManager.bodyRevision;
		const cached = this.#newest;
		if (
			cached?.sessionId === sessionId &&
			cached.loadRevision === loadRevision &&
			cached.bodyRevision === bodyRevision
		) {
			return cached;
		}
		let fallbacks: ProviderFallback[] = [];
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PROVIDER_FALLBACKS_ENTRY_TYPE) continue;
			const data = entry.data;
			if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.fallbacks)) continue;
			fallbacks = data.fallbacks.filter(isProviderFallback).filter(outlivesProviderState);
		}
		const read = { sessionId, loadRevision, bodyRevision, fallbacks, key: fallbacksKey(fallbacks) };
		this.#newest = read;
		return read;
	}

	/**
	 * Makes the provider state keep `fallbacks` and no other, but the `cache_control` fallbacks it learned itself, which
	 * no record holds ({@link outlivesProviderState}).
	 */
	#restore(fallbacks: readonly ProviderFallback[]): void {
		const state = this.#host.providerSessionState;
		const learned = providerFallbacks(state).filter(fallback => !outlivesProviderState(fallback));
		clearProviderFallbacks(state);
		for (const fallback of [...fallbacks, ...learned]) {
			switch (fallback.api) {
				case "anthropic-messages":
					restoreAnthropicFallback(state, fallback);
					break;
				case "openai-completions":
					restoreOpenAICompletionsStrictToolsFallback(state, fallback);
					break;
				case "openai-responses": {
					const model = this.#requestModel(fallback.provider, fallback.modelId);
					// Without the model its state cannot start right; its next rejection turns the fallback on again.
					if (!model) break;
					restoreOpenAIResponsesStrictToolsFallback(state, model as Model<"openai-responses">, fallback);
					break;
				}
			}
		}
	}

	/**
	 * The model requests went out as under `provider` and `modelId`, the scope a Responses fallback names: the
	 * registry's model of that id, else the one a wrapper transport sends a model of the provider as ({@link wireModel}:
	 * GitLab Duo's requests name the upstream id, which no catalog row of the provider carries).
	 */
	#requestModel(provider: string, modelId: string): Model<Api> | undefined {
		const registry = this.#host.modelRegistry;
		const found = registry.find(provider, modelId);
		if (found) return found;
		for (const model of registry.getProviderModels(provider)) {
			const wire = wireModel(model);
			if (wire.id === modelId) return wire;
		}
		return undefined;
	}
}

/**
 * Whether the session records `fallback` for a later provider state to take back: every fallback but a `cache_control`
 * one (no breakpoint, or breakpoints without `ttl` and `scope`), which lasts as long as the provider state that learned
 * it, as it did before the session recorded fallbacks. Kept, one such 400 would hold every later process of the
 * session to five-minute breakpoints (or none) for good, a cache write of the whole prompt after each pause of five
 * minutes, while the 400 that set it may not describe the endpoint: the provider cannot tell a refused option from a
 * refused breakpoint, and the endpoint may take `ttl` again. Dropped, it costs a later provider state the 400 once
 * more (twice for an endpoint that takes no breakpoint), and the first request that sends `ttl` again reads none of
 * the five-minute entries and writes the prompt at the one-hour price.
 */
function outlivesProviderState(fallback: ProviderFallback): boolean {
	return (
		fallback.api !== "anthropic-messages" ||
		(fallback.off !== "cache-control" && fallback.off !== "cache-control-options")
	);
}

/** A key equal for two lists of the same fallbacks in any order. */
function fallbacksKey(fallbacks: readonly ProviderFallback[]): string {
	return fallbacks
		.map(fallback =>
			JSON.stringify([
				fallback.api,
				fallback.api === "anthropic-messages" ? "" : fallback.provider,
				fallback.baseUrl,
				fallback.modelId,
				fallback.off,
				fallback.off === "thinking-blocks" ? [...fallback.blocks].sort() : [],
			]),
		)
		.sort()
		.join("\n");
}
