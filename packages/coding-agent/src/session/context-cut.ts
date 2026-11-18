/**
 * The live session's inputs to the cut rule ({@link decideContextCut}). Every automatic cut of a
 * session's context (a prune, a shake, a compaction, an image clamp) asks
 * {@link decideSessionContextCut} before it changes the context; a cut that is not admitted does
 * not run now and is proposed again at a later point.
 */
import {
	type CompactionSettings,
	type ContextCutDecision,
	decideContextCut,
	GROWTH_WINDOW_REQUESTS,
	meanPromptGrowth,
	promptBudgetTokens,
	resolveThresholdTokens,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { type CacheLifetime, getCacheTokenPrices } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { promptTokensOf } from "./cache-warmer";
import type { ObservedPromptCacheEntry } from "./prompt-cache-status";
import type { SessionEntry } from "./session-entries";

/** The growth mean covers the steps between the main requests of its window, so it reads one prompt size more. */
const GROWTH_SAMPLE_REPLIES = GROWTH_WINDOW_REQUESTS + 1;

/** Cache lifetime of each tier, for an entry whose model declares none. */
const LIFETIME_MS: Record<CacheLifetime, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

/** A cut a call site proposes, in the rule's letters. */
export interface ContextCut {
	/** Names the call site in the decision's debug log. */
	site: string;
	/** `p`: tokens before the cut's first changed position, which stay cached. */
	prefixTokens: number;
	/** `s`: tokens the cut removes. */
	removedTokens: number;
	/**
	 * The site's own evidence that the request cannot be served without the cut: a provider
	 * overflow or size refusal, a request-body timeout, the dead-end rescue, an image budget the
	 * request exceeds. A prompt over the window less the reserve counts as forced without it.
	 */
	forced: boolean;
	/** `P`, where the site measured the request the cut changes; the session's figure otherwise. */
	promptTokens?: number;
	/**
	 * Made by a provider-context transform (an image clamp, {@link providerContextCut}) in a request whose prompt is
	 * already taken, so it never runs a held settings rebuild.
	 */
	providerContext?: boolean;
}

/** What the session holds that the rule reads. */
export interface ContextCutSession {
	model: Model;
	/**
	 * The prompt cache entry the next request would read (the session's prompt cache status entry):
	 * touched by the newest real or warm request that hit it. `undefined` when there is none, no reply
	 * used the cache, the next request cannot read it (the entry's `change`) or asks for no caching,
	 * so every cut counts as lapsed.
	 */
	cacheEntry: Pick<ObservedPromptCacheEntry, "tier" | "touchedAt" | "ttlMs"> | undefined;
	/** The compaction policy in force for `model` (its threshold and reserve). */
	compactionSettings: CompactionSettings;
	/** The current branch, oldest entry first. */
	branch: readonly SessionEntry[];
	/** `P`: the cut's own figure where it has one, else the context tokens the compaction threshold check uses. */
	promptTokens: number;
	/** Unix milliseconds. */
	now: number;
}

/**
 * The prompt sizes of the newest main-loop replies of `branch`, oldest first: each one's tokens read
 * from the cache, written to it, and sent uncached. A failed or aborted turn carries no prompt the
 * cache saw.
 */
function recentMainPrompts(branch: readonly SessionEntry[]): number[] {
	const sizes: number[] = [];
	for (let index = branch.length - 1; index >= 0 && sizes.length < GROWTH_SAMPLE_REPLIES; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { stopReason, usage } = entry.message;
		const size = promptTokensOf(usage);
		if (stopReason === "error" || stopReason === "aborted" || size <= 0) continue;
		sizes.push(size);
	}
	return sizes.reverse();
}

/** The lifetime `cacheEntry`'s tier caches for: one hour for `long`, else five minutes. */
function cacheLifetimeOf(cacheEntry: ContextCutSession["cacheEntry"]): CacheLifetime {
	return cacheEntry?.tier === "long" ? "1h" : "5m";
}

/**
 * Milliseconds since the newest real or warm request touched `cacheEntry`, and its lifetime: the model's declared one
 * for the entry's tier, else five minutes or one hour. Without an entry the idle time is endless and the lifetime 0.
 */
function promptCacheEntryAge(
	cacheEntry: ContextCutSession["cacheEntry"],
	now: number,
): { idleMs: number; lifeMs: number } {
	if (!cacheEntry) return { idleMs: Number.POSITIVE_INFINITY, lifeMs: 0 };
	return {
		idleMs: now - cacheEntry.touchedAt,
		lifeMs: cacheEntry.ttlMs ?? LIFETIME_MS[cacheLifetimeOf(cacheEntry)],
	};
}

/** Whether `cacheEntry` has lapsed at `now`, as the cut rule's lapse condition reads it; no entry counts as lapsed. */
export function promptCacheEntryLapsed(cacheEntry: ContextCutSession["cacheEntry"], now: number): boolean {
	const { idleMs, lifeMs } = promptCacheEntryAge(cacheEntry, now);
	return idleMs >= lifeMs;
}

/**
 * Decide whether `cut` runs now, from the live session's figures, and log the decision.
 *
 * The cache entry the next request would read sets the idle time (since the newest real or warm
 * request touched it, so a warm refresh keeps the cache live), its lifetime (the model's declared one
 * for the entry's tier, else five minutes or one hour), and the lifetime `r` and `w` are priced at
 * ({@link getCacheTokenPrices}). Without an entry every cut counts as lapsed. `T` is the compaction
 * threshold and `g` the mean growth of the recent main requests' prompts. A prompt over the window
 * less the reserve forces the cut whatever the site says: with default settings that is the threshold.
 */
export function decideSessionContextCut(session: ContextCutSession, cut: ContextCut): ContextCutDecision {
	const { model, compactionSettings, cacheEntry, promptTokens } = session;
	const contextWindow = model.contextWindow ?? 0;
	const prices = getCacheTokenPrices(model.cost, cacheLifetimeOf(cacheEntry), promptTokens, session.now);
	const overBudget = contextWindow > 0 && promptTokens > promptBudgetTokens(contextWindow, compactionSettings);
	const { idleMs, lifeMs } = promptCacheEntryAge(cacheEntry, session.now);
	const decision = decideContextCut({
		promptTokens,
		prefixTokens: cut.prefixTokens,
		removedTokens: cut.removedTokens,
		readPrice: prices.read,
		writePrice: prices.write,
		thresholdTokens: contextWindow > 0 ? resolveThresholdTokens(contextWindow, compactionSettings) : 0,
		growthPerRequest: meanPromptGrowth(recentMainPrompts(session.branch)),
		idleMs,
		lifeMs,
		forced: cut.forced || overBudget,
	});
	logger.debug("Context cut decision", {
		site: cut.site,
		reason: decision.reason,
		requestsToThreshold: decision.requestsToThreshold,
		saving: decision.saving,
		writeCost: decision.writeCost,
		promptTokens,
		prefixTokens: cut.prefixTokens,
		removedTokens: cut.removedTokens,
	});
	return decision;
}

/**
 * The forced cut a provider-context transform (an image clamp) made at `site`. Forced, it is admitted whatever its
 * figures, so it counts none: `P`, `p` and `s` are 0 and the rule's log names its site.
 */
export function providerContextCut(site: string): ContextCut {
	return { site, prefixTokens: 0, removedTokens: 0, forced: true, promptTokens: 0, providerContext: true };
}
