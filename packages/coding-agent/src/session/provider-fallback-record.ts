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
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "./session-manager";

/**
 * Custom session entry holding `{ version: 1, fallbacks: ProviderFallback[] }`: the fallbacks the session's provider
 * state keeps (an endpoint rejected part of a request with a 400, so the provider leaves it out of that model's
 * requests there), written each time they change. The newest record on any branch is the session's: a process that
 * reads the session's entries in whole puts those fallbacks back before it sends anything.
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
	/** The model a recorded Responses fallback names: its provider state starts from the model's compat. */
	findModel(provider: string, modelId: string): Model<Api> | undefined;
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
 * provider state keeps (a branch into a new file) write a new record.
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
		const held = providerFallbacks(this.#host.providerSessionState);
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
			fallbacks = data.fallbacks.filter(isProviderFallback);
		}
		const read = { sessionId, loadRevision, bodyRevision, fallbacks, key: fallbacksKey(fallbacks) };
		this.#newest = read;
		return read;
	}

	/** Makes the provider state keep `fallbacks` and no other. */
	#restore(fallbacks: readonly ProviderFallback[]): void {
		const state = this.#host.providerSessionState;
		clearProviderFallbacks(state);
		for (const fallback of fallbacks) {
			switch (fallback.api) {
				case "anthropic-messages":
					restoreAnthropicFallback(state, fallback);
					break;
				case "openai-completions":
					restoreOpenAICompletionsStrictToolsFallback(state, fallback);
					break;
				case "openai-responses": {
					const model = this.#host.findModel(fallback.provider, fallback.modelId);
					// Without the model its state cannot start right; its next rejection turns the fallback on again.
					if (!model) break;
					restoreOpenAIResponsesStrictToolsFallback(state, model as Model<"openai-responses">, fallback);
					break;
				}
			}
		}
	}
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
