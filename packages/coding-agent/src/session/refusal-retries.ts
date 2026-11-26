/**
 * How many times a classifier refusal is sent again, unchanged, to the model that refused it
 * before recovery moves on: the primary's walk of `retry.fallbackChains`
 * (`session/turn-recovery.ts`), and an advisor's strip of the primary's reasoning and model
 * fallback (`advisor/runtime.ts`). Every refusal category and shape takes the same count.
 *
 * The retries carry out a rule: a classifier refusal is retried on its model before recovery moves
 * on, as any other refusal is. The evidence for them is mixed. A refused request replayed exactly
 * on its one model was refused in one of five sends; a request that carried another model's
 * thinking as text was refused in five of five. Anthropic's documentation says that a refused
 * request sent again to the same model usually earns another refusal, that a `reasoning_extraction`
 * refusal calls for a changed prompt rather than a retry, and that a refusal before any output is
 * billed in some categories. So the retries stop at two for each model: the model is asked three
 * times in all, and where a request is refused one time in five, three refusals running come
 * about one time in 125.
 */
export const CLASSIFIER_REFUSAL_SAME_MODEL_RETRIES = 2;
