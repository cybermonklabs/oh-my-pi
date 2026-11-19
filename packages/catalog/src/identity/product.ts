/**
 * Product identity: the catalog's class, family and revision, refined by the
 * product words of the id a provider is sent, so one model keeps one key across
 * providers while different products of one revision keep their own.
 */
import { once } from "@oh-my-pi/pi-utils";
import { collapseVocabulary, discoveryVocabulary } from "../compat/taxonomy";
import type { Model } from "../types";
import { bareModelId } from "./id";

/**
 * A route word, and the classes where it names a route. {@link MODEL_PRODUCT_VARIANT_WORDS} uses the same shape
 * for the classes where a variant word names a product.
 */
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

/**
 * Variant words of the catalog that name a product of their own in some classes: a word on this list is a product
 * word in the classes its entry names and a variant word elsewhere. Each is one id word. The catalog strips `max`
 * as an effort or mode word, as in Cursor's `claude-opus-4-8-max` (Claude Opus 4.8 in Max mode), but GPT-5.1 Codex
 * Max is another model than GPT-5.1 Codex: providers send it upstream as `gpt-5.1-codex-max`, and NanoGPT charges
 * 2.5/20 for it per million input/output tokens against 1.25/10.
 */
export const MODEL_PRODUCT_VARIANT_WORDS: readonly ModelRouteWord[] = [{ word: "max", classes: ["openai"] }];

const WORD_PATTERN = /[a-z0-9]+/g;
const NUMBER_WORD_PATTERN = /^v?[0-9]+$/;
const TRAILING_DIGITS_PATTERN = /[0-9]+$/;

/** A route word split into id words, with its entry. */
interface RouteWordRule {
	words: readonly string[];
	entry: ModelRouteWord;
}

interface ProductKeyVocabulary {
	/** Variant words the catalog strips from any provider's ids. */
	variantWords: Set<string>;
	/** {@link MODEL_PRODUCT_VARIANT_WORDS} by word. */
	productVariantWords: Map<string, ModelRouteWord>;
	/** Vendor-lineage words: the catalog's canonical family tokens (`claude`, `qwen`). */
	lineageWords: Set<string>;
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
	const productVariantWords = new Map<string, ModelRouteWord>();
	for (const entry of MODEL_PRODUCT_VARIANT_WORDS) productVariantWords.set(entry.word, entry);
	const lineageWords = new Set<string>();
	for (const token of discovery.canonicalFamilyTokens) addWords(lineageWords, token);
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
	return { variantWords, productVariantWords, lineageWords, providerWords, routeWords };
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
 * Whether `word` names the model, not a product of it: a word of its class or family, or a vendor-lineage word.
 * A vendor-lineage word is one of `lineageWords`, or such a word or a class word followed by digits (`qwen3`).
 */
function isNameWord(
	word: string,
	classWords: readonly string[],
	familyWords: readonly string[],
	lineageWords: ReadonlySet<string>,
): boolean {
	if (classWords.includes(word) || familyWords.includes(word) || lineageWords.has(word)) return true;
	const stem = word.replace(TRAILING_DIGITS_PATTERN, "");
	return stem !== word && (lineageWords.has(stem) || classWords.includes(stem));
}

/** Whether `word` is on {@link MODEL_PRODUCT_VARIANT_WORDS} for class `cls`. */
function isProductVariantWord(
	productVariantWords: ReadonlyMap<string, ModelRouteWord>,
	word: string,
	cls: string,
): boolean {
	const entry = productVariantWords.get(word);
	return entry !== undefined && entry.classes?.includes(cls) !== false && !entry.exceptClasses?.includes(cls);
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
 * served id, the id the provider is sent (`requestModelId`, else `id`). The
 * catalog's logical id is not read: it drops variant words such as `max`,
 * which name a product in some classes. The product words start at the first
 * class, family or vendor-lineage word of the served id (`claude`, or `qwen3`
 * in `qwen.qwen3-coder`), so a vendor or region prefix (`us-gov.anthropic.`) is
 * left out; when no word qualifies, they start at the first word. They are the
 * words from there on without numbers, class, family and lineage words, the
 * catalog's variant words (except {@link MODEL_PRODUCT_VARIANT_WORDS} in their
 * classes), the provider's lane and routing-variant words, and
 * {@link MODEL_ROUTE_WORDS}. A product word that comes before the family's last
 * word counts too (`live` in `gemini-live-2.5-flash`). A word on no list counts
 * as a product word: keeping a word that only names a route costs one more
 * refused request, but dropping a word that names another product would pass
 * over that product and can end a turn early.
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
	const served = bareModelId(model.requestModelId ?? model.id);
	const at = served.indexOf("@");
	const bare = at === -1 ? served : served.slice(0, at);
	const { variantWords, productVariantWords, lineageWords, providerWords, routeWords } = getProductKeyVocabulary();
	const laneWords = providerWords.get(model.provider.toLowerCase());
	const classWords = nameWords(identity.class);
	const familyWords = nameWords(identity.family);
	const words = wordsOf(bare);
	const kept: string[] = [];
	// The words before the first class, family or lineage word are a vendor or region prefix (`us-gov.anthropic.`).
	let index = 0;
	while (index < words.length && !isNameWord(words[index], classWords, familyWords, lineageWords)) index++;
	if (index === words.length) index = 0;
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
			isNameWord(word, classWords, familyWords, lineageWords) ||
			(variantWords.has(word) && !isProductVariantWord(productVariantWords, word, identity.class)) ||
			laneWords?.has(word)
		) {
			continue;
		}
		kept.push(word);
	}
	return `${identity.class}/${identity.family}/${identity.revision}/${kept.join("-")}`;
}
