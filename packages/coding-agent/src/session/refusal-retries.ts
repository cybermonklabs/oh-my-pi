/**
 * How many times a classifier refusal is sent again, unchanged, to the model that refused it
 * before recovery moves on: the primary's walk of `retry.fallbackChains`
 * (`session/turn-recovery.ts`), and an advisor's strip of the primary's reasoning and model
 * fallback (`advisor/runtime.ts`). Every refusal category and shape takes the same count.
 *
 * A classifier refusal judges the reply the model sampled, not the request: a refused request sent
 * again to the same model is usually answered. A refused request replayed exactly on its one model
 * was refused in one of five sends, at the end of a long reply. Two retries ask the model three
 * times in all, so a request refused one time in five is refused three times running about one time
 * in 125.
 */
export const CLASSIFIER_REFUSAL_SAME_MODEL_RETRIES = 2;
