/**
 * When an automatic context cut is worth its prompt-cache write.
 *
 * A cut (a prune, a shake, a compaction, an image clamp) changes the prompt
 * from its first changed position on. The next request still reads the tokens
 * before that position from the cache, but writes every token after it again.
 * The cut pays back through the tokens it removes: each later request reads
 * that many fewer, until the context grows back to the compaction threshold.
 * {@link decideContextCut} weighs the two in the model's own cache prices.
 */

/** Prompt growth is averaged over this many most recent main requests. */
const GROWTH_WINDOW_REQUESTS = 20;

/** Which condition decided a cut: one of the three admits, or `waits`. */
export type ContextCutReason = "forced" | "lapsed" | "pays" | "waits";

/** What {@link decideContextCut} weighs; the letters are the rule's. */
export interface ContextCutInputs {
	/** `P`: prompt tokens of the request the cut changes. */
	promptTokens: number;
	/** `p`: tokens before the cut's first changed position, which stay cached. */
	prefixTokens: number;
	/** `s`: tokens the cut removes. */
	removedTokens: number;
	/** `r`: price of one cached token read, at the cache lifetime the next request asks. */
	readPrice: number;
	/** `w`: price of one token written to the cache, at the cache lifetime the next request asks. */
	writePrice: number;
	/** `T`: the compaction threshold `shouldCompact` uses (`resolveThresholdTokens`). */
	thresholdTokens: number;
	/** `g`: mean prompt growth per main request, from {@link meanPromptGrowth}; at least 1. */
	growthPerRequest: number;
	/** Milliseconds since the last request. */
	idleMs: number;
	/** Cache lifetime of the last request, in milliseconds. */
	lifeMs: number;
	/**
	 * The request cannot be served without the cut: its prompt is over the
	 * window less the reserve, or the provider refused it for its size.
	 */
	forced: boolean;
}

/** The outcome of {@link decideContextCut}, with the figures it compared. */
export interface ContextCutDecision {
	/** Whether the cut runs now; `false` means it waits. */
	admitted: boolean;
	reason: ContextCutReason;
	/** `N`: requests until the context after the cut reaches the threshold again. */
	requestsToThreshold: number;
	/** `N * s * r`: the cache reads the cut saves over those requests. */
	saving: number;
	/** `(P - p - s) * (w - r)`: the extra cost of writing the tokens after the cut again. */
	writeCost: number;
}

/** Degenerate caller figures (negative, NaN) count as 0. */
function nonNegative(value: number): number {
	return value > 0 ? value : 0;
}

/**
 * Decide whether an automatic context cut runs now or waits.
 *
 * With `N = max(0, floor((T - (P - s)) / g))`, the requests until the context
 * after the cut reaches the threshold again, the cut is admitted when any of
 * these holds:
 *
 * 1. `forced`: the request cannot be served without it.
 * 2. `idleMs >= lifeMs`: the last request's cache entry has lapsed, so the
 *    prefix is already gone and the cut adds no write.
 * 3. `N * s * r > (P - p - s) * (w - r)`: the reads the cut saves before the
 *    threshold is reached again cost more than writing the `P - p - s` tokens
 *    after it again.
 *
 * Otherwise it waits, and runs at the first later point where it is admitted:
 * a lapse, the threshold, or a forced cut.
 *
 * The inputs are the request the cut changes (`P`, `p`, `s`), the model's
 * per-token cache read and write prices at the lifetime the next request asks
 * (`r`, `w`, from the catalog's `getCacheTokenPrices`), the threshold `T`, the
 * growth `g` ({@link meanPromptGrowth}), the idle time and cache lifetime, and
 * whether the cut is forced. Negative or NaN figures count as 0, `g` as at
 * least 1, and a cut position past the end of the prompt as nothing to write.
 *
 * The rule governs automatic cuts only. Manual `/shake` and `/compact`, and a
 * compaction an RPC client requests, are a person's or an operator's choice and
 * are not governed by it.
 */
export function decideContextCut(inputs: ContextCutInputs): ContextCutDecision {
	const promptTokens = nonNegative(inputs.promptTokens);
	const removedTokens = nonNegative(inputs.removedTokens);
	const readPrice = nonNegative(inputs.readPrice);
	const growth = Math.max(1, nonNegative(inputs.growthPerRequest));
	const tokensAfterCut = nonNegative(promptTokens - removedTokens);
	const requestsToThreshold = Math.max(0, Math.floor((nonNegative(inputs.thresholdTokens) - tokensAfterCut) / growth));
	const saving = requestsToThreshold * removedTokens * readPrice;
	const rewrittenTokens = nonNegative(promptTokens - nonNegative(inputs.prefixTokens) - removedTokens);
	const writeCost = rewrittenTokens * (nonNegative(inputs.writePrice) - readPrice);

	let reason: ContextCutReason;
	if (inputs.forced) reason = "forced";
	else if (nonNegative(inputs.idleMs) >= nonNegative(inputs.lifeMs)) reason = "lapsed";
	else if (saving > writeCost) reason = "pays";
	else reason = "waits";
	return { admitted: reason !== "waits", reason, requestsToThreshold, saving, writeCost };
}

/**
 * Mean prompt growth per main request, the `g` of {@link decideContextCut}:
 * the growth of each of the last 20 main requests over the request before it,
 * averaged, and at least 1 token.
 *
 * `promptTokens` lists the main requests' prompt sizes, oldest first. A request
 * whose prompt shrank came after a cut; that step is not growth and is left out
 * of the mean. With no growth step to average the result is 1.
 */
export function meanPromptGrowth(promptTokens: readonly number[]): number {
	let total = 0;
	let steps = 0;
	for (let i = Math.max(1, promptTokens.length - GROWTH_WINDOW_REQUESTS); i < promptTokens.length; i++) {
		const step = promptTokens[i] - promptTokens[i - 1];
		if (!(step >= 0)) continue;
		total += step;
		steps++;
	}
	return steps === 0 ? 1 : Math.max(1, total / steps);
}
