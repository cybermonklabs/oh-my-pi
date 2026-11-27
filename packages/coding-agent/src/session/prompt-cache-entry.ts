/**
 * Whether the prompt cache entry the next request would read has lapsed. A hold on a settings change, and a
 * restored transcript prompt, both end at a lapse: the request after it writes the whole prompt again anyway.
 */
import type { CacheLifetime } from "@oh-my-pi/pi-catalog/models";
import type { ObservedPromptCacheEntry } from "./prompt-cache-status";

/** Cache lifetime of each tier, for an entry whose model declares none. */
const LIFETIME_MS: Record<CacheLifetime, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

/**
 * Whether `cacheEntry` has lapsed at `now`: the newest real or warm request touched it longer ago than it lives
 * (the model's declared lifetime for its tier, else five minutes, or one hour for a `long` entry). No entry counts
 * as lapsed.
 */
export function promptCacheEntryLapsed(
	cacheEntry: Pick<ObservedPromptCacheEntry, "tier" | "touchedAt" | "ttlMs"> | undefined,
	now: number,
): boolean {
	if (!cacheEntry) return true;
	return now - cacheEntry.touchedAt >= (cacheEntry.ttlMs ?? LIFETIME_MS[cacheEntry.tier === "long" ? "1h" : "5m"]);
}
