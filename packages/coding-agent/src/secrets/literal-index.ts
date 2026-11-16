/**
 * The literal index: says in one scan each which of a set of literals a text can hold at all, and
 * where, with no pattern that grows with a literal. The only patterns are alternations of keys, a
 * key being a literal's first {@link KEY_CHARS} characters; a literal is then confirmed, or found,
 * with a plain comparison. The session-store matcher and the provider obfuscator's literal detectors
 * both search with it.
 */

/** The characters of a literal's start that its key holds. */
const KEY_CHARS = 32;

/**
 * The pattern characters one alternation of keys may hold: a quarter of the 1,048,576 past which
 * JavaScriptCore refuses a pattern. An escaped key takes at most 6 × {@link KEY_CHARS} characters,
 * so every key fits, and a set of keys past this size is split over more alternations.
 */
const CHUNK_PATTERN_CHARS = 256 * 1024;

const NON_ASCII_RE = /[^\x00-\x7F]/;

/** Where a key occurs in a text: the literals that start with it, and the indexes of its first and of its last occurrence. */
export interface KeyReach {
	readonly literals: readonly string[];
	first: number;
	last: number;
}

/**
 * Regex source matching any of `literals`, deduplicated and longest first (ties
 * in code-unit order), so a literal that contains another wins.
 */
function literalAlternationSource(literals: Iterable<string>): string {
	return Array.from(new Set(literals))
		.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
		.map(literal => RegExp.escape(literal))
		.join("|");
}

/**
 * The alternation of `keys` with `flags`, matched once: JavaScriptCore compiles a pattern at its
 * first match, so a pattern it refuses fails here, where the index is built, and not in a search.
 */
function compiledAlternation(keys: readonly string[], flags: string): RegExp {
	const alternation = new RegExp(literalAlternationSource(keys), flags);
	alternation.test("");
	alternation.lastIndex = 0;
	return alternation;
}

/**
 * Whether `literal`, which is in lower case, starts at `at` in `text` up to ASCII case: an ASCII
 * capital of the text compares as its small letter, every other character as it is.
 */
function startsAtIgnoringAsciiCase(text: string, literal: string, at: number): boolean {
	if (at + literal.length > text.length) return false;
	for (let offset = 0; offset < literal.length; offset++) {
		const code = text.charCodeAt(at + offset);
		if ((code >= 0x41 && code <= 0x5a ? code + 0x20 : code) !== literal.charCodeAt(offset)) return false;
	}
	return true;
}

/**
 * Finds held literals in a text: each literal by its key, and alternations of the keys within
 * {@link CHUNK_PATTERN_CHARS} each. An empty literal is left out.
 *
 * Under `ignoreCase` it finds each literal up to ASCII case: the literals and keys are held in lower
 * case and the alternations carry the `i` flag, without `u`, which for an ASCII key finds the key up
 * to ASCII case and no other. Every literal must then be ASCII: for another, the alternations, the
 * lower-case fold and the ASCII comparison disagree, and what the index finds would depend on the
 * literal's length.
 */
export class LiteralIndex {
	readonly #ignoreCase: boolean;
	/** The literals of each key. */
	readonly #byKey = new Map<string, string[]>();
	/** The keys that occur only where a literal does: a key that is a literal, or that starts with a shorter key. */
	readonly #wholeKeys = new Set<string>();
	/** The lengths of the keys shorter than {@link KEY_CHARS}, ascending: each such key is a whole literal. */
	readonly #shortKeyLengths: number[];
	readonly #keyChunks: RegExp[] = [];

	/** Throws when it cannot build the index, and under `ignoreCase` for a literal that is not ASCII. */
	constructor(literals: Iterable<string>, options: { readonly ignoreCase?: boolean } = {}) {
		const ignoreCase = options.ignoreCase ?? false;
		this.#ignoreCase = ignoreCase;
		const held = new Set<string>();
		for (const literal of literals) {
			if (literal === "") continue;
			// The error names the rule, never the literal, which may be a secret.
			if (ignoreCase && NON_ASCII_RE.test(literal)) {
				throw new Error("A case-insensitive literal index holds only ASCII literals");
			}
			held.add(ignoreCase ? literal.toLowerCase() : literal);
		}
		for (const literal of held) {
			const key = literal.slice(0, KEY_CHARS);
			const sharing = this.#byKey.get(key);
			if (sharing === undefined) this.#byKey.set(key, [literal]);
			else sharing.push(literal);
		}
		const flags = ignoreCase ? "gi" : "g";
		const shortKeyLengths = new Set<number>();
		let chunk: string[] = [];
		let chars = 0;
		for (const key of this.#byKey.keys()) {
			if (key.length < KEY_CHARS) shortKeyLengths.add(key.length);
			const size = RegExp.escape(key).length + 1;
			if (chunk.length > 0 && chars + size > CHUNK_PATTERN_CHARS) {
				this.#keyChunks.push(compiledAlternation(chunk, flags));
				chunk = [];
				chars = 0;
			}
			chunk.push(key);
			chars += size;
		}
		if (chunk.length > 0) this.#keyChunks.push(compiledAlternation(chunk, flags));
		this.#shortKeyLengths = [...shortKeyLengths].sort((a, b) => a - b);
		for (const [key, sharing] of this.#byKey) {
			if (
				sharing.includes(key) ||
				this.#shortKeyLengths.some(length => length < key.length && this.#byKey.has(key.slice(0, length)))
			) {
				this.#wholeKeys.add(key);
			}
		}
	}

	/** Whether some literal occurs in `text`. */
	test(text: string): boolean {
		for (const chunk of this.#keyChunks) {
			chunk.lastIndex = 0;
			for (let match = chunk.exec(text); match !== null; match = chunk.exec(text)) {
				const at = match.index;
				// Resume one character on, so a key that starts inside this one is found too.
				chunk.lastIndex = at + 1;
				const key = this.#ignoreCase ? match[0].toLowerCase() : match[0];
				if (this.#wholeKeys.has(key)) return true;
				// Every key found is one of `#byKey`'s: the alternations hold no other.
				for (const literal of this.#byKey.get(key)!) {
					if (this.#ignoreCase ? startsAtIgnoringAsciiCase(text, literal, at) : text.startsWith(literal, at)) {
						return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * The reach of each key that occurs in `text`, or `undefined` when none does: only a literal of
	 * such a key can occur in the text, and only starting within that reach. The same scan as
	 * {@link test}, kept apart: a shared visitor would cost a closure per call, at every text the
	 * matcher passes, most of which hold no key.
	 */
	reachesIn(text: string): Iterable<KeyReach> | undefined {
		let reaches: Map<string, KeyReach> | undefined;
		for (const chunk of this.#keyChunks) {
			chunk.lastIndex = 0;
			for (let match = chunk.exec(text); match !== null; match = chunk.exec(text)) {
				const { index } = match;
				// Resume one character on, so a key that starts inside this one is found too.
				chunk.lastIndex = index + 1;
				const key = this.#ignoreCase ? match[0].toLowerCase() : match[0];
				reaches ??= new Map();
				const reach = reaches.get(key);
				if (reach === undefined) reaches.set(key, { literals: this.#byKey.get(key)!, first: index, last: index });
				else reach.last = index;
			}
		}
		if (reaches === undefined || this.#shortKeyLengths.length === 0) return reaches?.values();
		// An alternation names the longest key that starts at a character. A shorter key that starts
		// there is a prefix of it, so it occurs wherever the longer one does. A key added here is
		// visited in turn; its prefixes are prefixes of the longer key too, so the result is the same.
		for (const [key, reach] of reaches) {
			for (const length of this.#shortKeyLengths) {
				if (length >= key.length) break;
				const shorter = key.slice(0, length);
				const literals = this.#byKey.get(shorter);
				if (literals === undefined) continue;
				const known = reaches.get(shorter);
				if (known === undefined) {
					reaches.set(shorter, { literals, first: reach.first, last: reach.last });
				} else {
					known.first = Math.min(known.first, reach.first);
					known.last = Math.max(known.last, reach.last);
				}
			}
		}
		return reaches.values();
	}
}
