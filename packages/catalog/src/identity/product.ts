/**
 * Product identity: the catalog's class, family and revision, refined by the
 * product words of the id a provider serves, so one model keeps one key across
 * providers while different products of one revision keep their own.
 */
import { once } from "@oh-my-pi/pi-utils";
import { collapseVocabulary, discoveryVocabulary } from "../compat/taxonomy";
import type { Model } from "../types";
import { bareModelId } from "./id";

/** A route word, and the classes where it names a route. */
export interface ModelRouteWord {
	/** The route word; one made of several id words (`non-reasoning`) matches them in that order. */
	word: string;
	/** The only classes where the word names a route; absent for every class. */
	classes?: readonly string[];
	/** The classes where the word names a product of its own instead of a route. */
	exceptClasses?: readonly string[];
}

/**
 * Words that name a route of one model, not another product: a provider sells
 * the same model in a batch, flex or priority tier, at a discount, on a fast,
 * high-speed or turbo serving, with its thinking off (`nothinking`,
 * `non-reasoning`), or under a `latest` alias, and adds the word to the model's
 * id. A word names a route in every class unless its entry limits it: xAI's
 * Grok 4 Fast is a model of its own, and `turbo` names a route only for Qwen,
 * while OpenAI's `gpt-4-turbo` is a product.
 */
export const MODEL_ROUTE_WORDS: readonly ModelRouteWord[] = [
	{ word: "batch" },
	{ word: "flex" },
	{ word: "priority" },
	{ word: "discounted" },
	{ word: "cheaper" },
	{ word: "latest" },
	{ word: "highspeed" },
	{ word: "nothinking" },
	{ word: "non-reasoning" },
	{ word: "fast", exceptClasses: ["xai"] },
	{ word: "turbo", classes: ["qwen"] },
];

const WORD_PATTERN = /[a-z0-9]+/g;
const NUMBER_WORD_PATTERN = /^v?[0-9]+$/;

/** A route word split into id words, with its entry. */
interface RouteWordRule {
	words: readonly string[];
	entry: ModelRouteWord;
}

interface ProductKeyVocabulary {
	/** Variant words the catalog strips from any provider's ids. */
	variantWords: Set<string>;
	/** Lane and routing-variant words, by the provider that declares them. */
	providerWords: Map<string, Set<string>>;
	/** Route words by their first id word, the longest first. */
	routeWords: Map<string, RouteWordRule[]>;
}

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

const getProductKeyVocabulary = once((): ProductKeyVocabulary => {
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
	const routeWords = new Map<string, RouteWordRule[]>();
	for (const entry of MODEL_ROUTE_WORDS) {
		const words = wordsOf(entry.word);
		if (words.length === 0) continue;
		const rules = routeWords.get(words[0]);
		if (rules === undefined) routeWords.set(words[0], [{ words, entry }]);
		else rules.push({ words, entry });
	}
	for (const rules of routeWords.values()) rules.sort((left, right) => right.words.length - left.words.length);
	return { variantWords, providerWords, routeWords };
});

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

/** How many of `words` from `start` on make a route word for class `cls`, the longest first; 0 when none does. */
function routeWordLength(
	routeWords: ReadonlyMap<string, readonly RouteWordRule[]>,
	words: readonly string[],
	start: number,
	cls: string,
): number {
	const rules = routeWords.get(words[start]);
	if (rules === undefined) return 0;
	for (const rule of rules) {
		if (rule.entry.classes?.includes(cls) === false || rule.entry.exceptClasses?.includes(cls)) continue;
		let length = 0;
		while (length < rule.words.length && words[start + length] === rule.words[length]) length++;
		if (length === rule.words.length) return length;
	}
	return 0;
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
	const served = bareModelId(model.requestModelId ?? identity.logicalId ?? model.id);
	const at = served.indexOf("@");
	const bare = at === -1 ? served : served.slice(0, at);
	const { variantWords, providerWords, routeWords } = getProductKeyVocabulary();
	const laneWords = providerWords.get(model.provider.toLowerCase());
	const classWords = nameWords(identity.class);
	const familyWords = nameWords(identity.family);
	const words = wordsOf(bare);
	const anchor = familyWords.at(-1);
	const kept: string[] = [];
	// The words up to the family's last word are a vendor, region or class prefix (`us-gov.anthropic.claude-opus`).
	let index = anchor === undefined ? 0 : words.indexOf(anchor) + 1;
	while (index < words.length) {
		const routeLength = routeWordLength(routeWords, words, index, identity.class);
		if (routeLength > 0) {
			index += routeLength;
			continue;
		}
		const word = words[index];
		index++;
		if (
			NUMBER_WORD_PATTERN.test(word) ||
			classWords.includes(word) ||
			familyWords.includes(word) ||
			variantWords.has(word) ||
			laneWords?.has(word)
		) {
			continue;
		}
		kept.push(word);
	}
	return `${identity.class}/${identity.family}/${identity.revision}/${kept.join("-")}`;
}
