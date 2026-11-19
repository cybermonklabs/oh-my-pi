/**
 * Product identity: the catalog's class, family and revision, refined by the
 * product words of the id a provider serves, so one model keeps one key across
 * providers while different products of one revision keep their own.
 */
import { collapseVocabulary, discoveryVocabulary } from "../compat/taxonomy";
import type { Model } from "../types";

/** A route word, and the classes where the same word names a product of its own. */
export interface ModelRouteWord {
	word: string;
	exceptClasses: readonly string[];
}

/**
 * Words that name a route of one model, not another product: a provider sells
 * the same model in a batch, flex or priority tier, at a discount, on a fast
 * lane, or under a `latest` alias, and adds the word to the model's id. An
 * entry's `exceptClasses` are the classes where its word names a model of its
 * own: xAI's Grok 4 Fast is not Grok 4 on a fast lane.
 */
export const MODEL_ROUTE_WORDS: readonly ModelRouteWord[] = [
	{ word: "batch", exceptClasses: [] },
	{ word: "flex", exceptClasses: [] },
	{ word: "priority", exceptClasses: [] },
	{ word: "discounted", exceptClasses: [] },
	{ word: "cheaper", exceptClasses: [] },
	{ word: "latest", exceptClasses: [] },
	{ word: "fast", exceptClasses: ["xai"] },
];

const WORD_PATTERN = /[a-z0-9]+/g;
const NUMBER_WORD_PATTERN = /^v?[0-9]+$/;

interface ProductKeyVocabulary {
	/** Variant words the catalog strips from any provider's ids. */
	variantWords: Set<string>;
	/** Lane and routing-variant words, by the provider that declares them. */
	providerWords: Map<string, Set<string>>;
	/** Route words, each with the classes it does not apply to. */
	routeWords: Map<string, readonly string[]>;
}

let productKeyVocabulary: ProductKeyVocabulary | undefined;

/** The lowercase words of `text`: it splits at every character that is not an ASCII letter or digit. */
function wordsOf(text: string): readonly string[] {
	return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

function addWords(target: Set<string>, text: string): void {
	for (const word of wordsOf(text)) target.add(word);
}

function addProviderWords(
	target: Map<string, Set<string>>,
	rules: readonly { suffix: string; providers: readonly string[] }[],
): void {
	for (const rule of rules) {
		for (const provider of rule.providers) {
			let words = target.get(provider);
			if (words === undefined) {
				words = new Set();
				target.set(provider, words);
			}
			addWords(words, rule.suffix);
		}
	}
}

function getProductKeyVocabulary(): ProductKeyVocabulary {
	if (productKeyVocabulary !== undefined) return productKeyVocabulary;
	const discovery = discoveryVocabulary();
	const collapse = collapseVocabulary();
	const variantWords = new Set<string>();
	for (const marker of discovery.trailingMarkers) addWords(variantWords, marker);
	for (const suffix of discovery.billingVariantSuffixes) addWords(variantWords, suffix);
	for (const rule of collapse.suffixes) addWords(variantWords, rule.suffix);
	for (const token of collapse.pairTokens) addWords(variantWords, token);
	const providerWords = new Map<string, Set<string>>();
	addProviderWords(providerWords, collapse.lanes);
	addProviderWords(providerWords, collapse.routingVariants);
	const routeWords = new Map<string, readonly string[]>();
	for (const entry of MODEL_ROUTE_WORDS) routeWords.set(entry.word, entry.exceptClasses);
	productKeyVocabulary = { variantWords, providerWords, routeWords };
	return productKeyVocabulary;
}

// Cache keyed by class and family id (a bounded set from the catalog's rules), so no eviction is needed.
const nameWordsCache = new Map<string, readonly string[]>();
function nameWords(name: string): readonly string[] {
	let words = nameWordsCache.get(name);
	if (words === undefined) {
		words = wordsOf(name);
		nameWordsCache.set(name, words);
	}
	return words;
}

/**
 * The key of one model product. One model keeps one key across the providers
 * that serve it, the spellings they give its id and the routes they sell it on
 * (`anthropic/claude-opus-4-8`, `amazon-bedrock/us.anthropic.claude-opus-4-8`,
 * `openrouter/anthropic/claude-opus-4.8:batch`). Different products that share
 * the catalog's class, family and revision get separate keys (`openai/gpt-5.6`
 * and `openai/gpt-5.6-sol`).
 *
 * The key is `class/family/revision/` followed by the product words of the
 * served id (`requestModelId`, else the identity's logical id, else `id`): its
 * words after the family's last word, without numbers, class and family words,
 * the catalog's variant words, the provider's lane and routing-variant words,
 * and {@link MODEL_ROUTE_WORDS}. A word on no list counts as a product word:
 * keeping a word that only names a route costs one more refused request, but
 * dropping a word that names another product would pass over that product and
 * can end a turn early.
 *
 * Undefined when the identity names no one model: class `unknown`, or no
 * family, or no revision.
 */
export function productIdentityKey(
	model: Pick<Model, "provider" | "id" | "identity" | "requestModelId">,
): string | undefined {
	const { identity } = model;
	if (!identity || identity.class === "unknown" || identity.family === undefined || identity.revision === undefined) {
		return undefined;
	}
	const served = model.requestModelId ?? identity.logicalId ?? model.id;
	const start = served.lastIndexOf("/") + 1;
	const at = served.indexOf("@", start);
	const bare = at === -1 ? served.slice(start) : served.slice(start, at);
	const { variantWords, providerWords, routeWords } = getProductKeyVocabulary();
	const laneWords = providerWords.get(model.provider.toLowerCase());
	const classWords = nameWords(identity.class);
	const familyWords = nameWords(identity.family);
	const anchor = familyWords.at(-1);
	const kept: string[] = [];
	let anchored = false;
	for (const word of wordsOf(bare)) {
		// The words up to the family's last word are a vendor, region or class prefix (`us-gov.anthropic.claude-opus`).
		if (!anchored && word === anchor) {
			anchored = true;
			kept.length = 0;
			continue;
		}
		if (
			NUMBER_WORD_PATTERN.test(word) ||
			classWords.includes(word) ||
			familyWords.includes(word) ||
			variantWords.has(word) ||
			laneWords?.has(word)
		) {
			continue;
		}
		const exceptClasses = routeWords.get(word);
		if (exceptClasses !== undefined && !exceptClasses.includes(identity.class)) continue;
		kept.push(word);
	}
	return `${identity.class}/${identity.family}/${identity.revision}/${kept.join("-")}`;
}
