import type { Model } from "@oh-my-pi/pi-ai";
import { resolveSessionModelSelector } from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import {
	findRetryFallbackCandidates,
	isRetryFallbackModelKey,
	isRetryFallbackWildcardKey,
	parseRetryFallbackSelector,
	resolveRetryFallbackChainKey,
} from "./retry-fallback-chains";
import { cfgRetryFallbackChains } from "./settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export type RetiredSessionModelResolution =
	| { kind: "present" }
	| { kind: "migrated"; model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined }
	| { kind: "refused" };

/**
 * Resolves a persisted selector whose provider has been removed through that
 * selector's own model-key fallback chain. Roles and the default chain are not
 * migrations: they would substitute an unrelated saved model.
 */
export function resolveRetiredSessionModel(
	modelRegistry: ModelRegistry,
	settings: Settings,
	selector: string,
): RetiredSessionModelResolution {
	const saved = parseRetryFallbackSelector(selector, modelRegistry);
	if (!saved || modelRegistry.hasProvider(saved.provider)) return { kind: "present" };

	const context = {
		chains: cfgRetryFallbackChains.get(settings),
		getModelRole: (role: string) => settings.getModelRole(role),
		modelLookup: modelRegistry,
	};
	const chainKey = resolveRetryFallbackChainKey(context, selector);
	if (!chainKey || !isRetryFallbackModelKey(chainKey) || isRetryFallbackWildcardKey(chainKey)) {
		return { kind: "refused" };
	}
	const savedBareId = saved.id.includes("/") ? saved.id.slice(saved.id.lastIndexOf("/") + 1) : saved.id;

	for (const candidate of findRetryFallbackCandidates(context, chainKey, selector, undefined, {
		allowMissingPrimary: true,
	})) {
		const restored = resolveSessionModelSelector(modelRegistry, candidate.raw);
		if (!restored) continue;
		const candidateBareId = restored.model.id.includes("/")
			? restored.model.id.slice(restored.model.id.lastIndexOf("/") + 1)
			: restored.model.id;
		if (candidateBareId !== savedBareId) continue;
		return {
			kind: "migrated",
			model: restored.model,
			thinkingLevel: restored.thinkingLevel ?? saved.thinkingLevel,
		};
	}
	return { kind: "refused" };
}

/** Discovery providers that can materialize this retired selector's migration targets. */
export function retiredSessionModelMigrationProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	selector: string,
): Set<string> {
	const saved = parseRetryFallbackSelector(selector, modelRegistry);
	if (!saved || modelRegistry.hasProvider(saved.provider)) return new Set();

	const context = {
		chains: cfgRetryFallbackChains.get(settings),
		getModelRole: (role: string) => settings.getModelRole(role),
		modelLookup: modelRegistry,
	};
	const chainKey = resolveRetryFallbackChainKey(context, selector);
	if (!chainKey || !isRetryFallbackModelKey(chainKey) || isRetryFallbackWildcardKey(chainKey)) return new Set();

	const providers = new Set<string>();
	for (const candidate of findRetryFallbackCandidates(context, chainKey, selector, undefined, {
		allowMissingPrimary: true,
	})) {
		const provider = modelRegistry.getDiscoveryProviderId(candidate.provider);
		if (provider) providers.add(provider);
	}
	return providers;
}
