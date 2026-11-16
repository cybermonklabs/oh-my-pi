/**
 * The matcher of a session-store mask: finds every held value in a text and replaces what it finds
 * with markers.
 *
 * One pass over a text:
 * 1. finds the exact markers of this matcher that the text already holds;
 * 2. finds every occurrence of every held literal in the whole text, overlapping occurrences too.
 *    An occurrence that lies wholly inside one of those markers is marker text and is left out; one
 *    that overlaps a marker otherwise takes the whole marker, so a marker is never cut;
 * 3. finds every non-empty match of every held regex in the text between those markers;
 * 4. replaces each maximal run of ranges that overlap or touch with one marker: that of the match
 *    that starts first, of the longer one when two start together, of a literal rather than a
 *    regex when both match the same text, and of the regex held first when two regexes do.
 *
 * `mask` repeats the pass until the text no longer changes, so its result is a fixed point and
 * masking is idempotent. One changing pass is enough unless a regex depends on what surrounds its
 * match (an anchor, a lookaround) or a held literal holds marker text.
 *
 * No pattern grows with the size of a held value. A literal is found with `indexOf`; the only
 * patterns are alternations of keys, a key being a literal's first {@link KEY_CHARS} characters,
 * which say in one scan each which literals a text can hold at all.
 */

/** The start of every marker. */
export const MARKER_PREFIX = "[REDACTED:";

/** A marker: the prefix, a label that holds no bracket, and the closing bracket. */
const MARKER_SHAPE = /^\[REDACTED:[^[\]]*\]$/;

/** The characters of a literal's start that its key holds. */
const KEY_CHARS = 32;

/**
 * The pattern characters one alternation of keys may hold: a quarter of the 1,048,576 past which
 * JavaScriptCore refuses a pattern. An escaped key takes at most 6 × {@link KEY_CHARS} characters,
 * so every key fits, and a set of keys past this size is split over more alternations.
 */
const CHUNK_PATTERN_CHARS = 256 * 1024;

/** A held regex, compiled with the global flag, and the marker its matches become. */
export interface MarkedRegex {
	readonly regex: RegExp;
	readonly marker: string;
}

/** Replaces held values in a text with their markers. */
export interface SessionStoreMatcher {
	/** `text` with every held value replaced by a marker. Throws rather than return text that may hold one. */
	mask(text: string): string;
}

interface Span {
	readonly start: number;
	readonly end: number;
}

/** What a match takes of a text; for a literal, a run of its occurrences that overlap or touch. */
interface MatchRange {
	/** Where the match, the first of a run, starts, and how long it is: these rank the ranges. */
	readonly at: number;
	readonly length: number;
	/** What is replaced: the match or the run, with every exact marker it overlaps taken whole. */
	readonly start: number;
	end: number;
	readonly marker: string;
}

/** Where a key occurs in a text: the indexes of its first and of its last occurrence. */
interface Reach {
	first: number;
	last: number;
}

interface ScanRegex extends MarkedRegex {
	/** Whether an empty match is stepped over by a code point rather than a code unit. */
	readonly unicode: boolean;
}

const NO_SPANS: readonly Span[] = [];

/** For each prefix of `literal`, the length of its longest proper prefix that is also its suffix. */
function borderLengths(literal: string): Int32Array {
	const borders = new Int32Array(literal.length);
	let matched = 0;
	for (let index = 1; index < literal.length; index++) {
		const code = literal.charCodeAt(index);
		while (matched > 0 && literal.charCodeAt(matched) !== code) matched = borders[matched - 1];
		if (literal.charCodeAt(matched) === code) matched++;
		borders[index] = matched;
	}
	return borders;
}

/** The one of `markers`, which are in text order and apart, that holds the character at `index`. */
function markerAt(markers: readonly Span[], index: number): Span | undefined {
	let low = 0;
	let high = markers.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (markers[middle].end <= index) low = middle + 1;
		else high = middle;
	}
	const marker = markers[low];
	return marker !== undefined && marker.start <= index ? marker : undefined;
}

/**
 * Adds every occurrence of `literal` in `text` to `ranges`, each run of occurrences that overlap or
 * touch as one range. An occurrence that lies wholly inside one of `markers` is marker text, not a
 * value, and is left out; one that overlaps a marker otherwise takes the whole marker, so a marker
 * is never cut. The literal's key occurs in the text within `reach`, so the literal starts nowhere
 * else.
 *
 * `indexOf` finds each occurrence. Where the literal overlaps itself (a value that repeats a short
 * unit), a search that resumed one character after each start would compare the whole literal at
 * every character, so those occurrences are walked with the literal's border table instead, which
 * reads each character of the text once.
 */
function addOccurrences(
	text: string,
	literal: string,
	reach: Reach,
	marker: string,
	markers: readonly Span[],
	ranges: MatchRange[],
): void {
	const length = literal.length;
	let run: MatchRange | undefined;
	const add = (at: number): void => {
		let start = at;
		let end = at + length;
		if (markers.length > 0) {
			const first = markerAt(markers, start);
			if (first !== undefined) {
				if (end <= first.end) return;
				start = first.start;
			}
			end = markerAt(markers, end - 1)?.end ?? end;
		}
		if (run !== undefined && start <= run.end) {
			run.end = Math.max(run.end, end);
		} else {
			run = { at, length, start, end, marker };
			ranges.push(run);
		}
	};
	let borders: Int32Array | undefined;
	let at = text.indexOf(literal, reach.first);
	while (at !== -1) {
		add(at);
		if (at >= reach.last) break;
		let next = text.indexOf(literal, at + 1);
		if (next !== -1 && next < at + length) {
			borders ??= borderLengths(literal);
			// `matched` characters of the literal end at `index`, so no occurrence that is not yet
			// added starts before `index - matched`; the walk ends once that is past the last one.
			let matched = borders[length - 1];
			let index = at + length;
			let end = index;
			while (index < text.length && index - matched < end) {
				const code = text.charCodeAt(index);
				while (matched > 0 && literal.charCodeAt(matched) !== code) matched = borders[matched - 1];
				if (literal.charCodeAt(matched) === code) matched++;
				index++;
				if (matched === length) {
					add(index - length);
					end = index;
					matched = borders[length - 1];
				}
			}
			next = text.indexOf(literal, index - matched);
		}
		at = next;
	}
}

class UnionMatcher implements SessionStoreMatcher {
	readonly #markers = new Set<string>();
	readonly #longestMarker: number;
	/** Each held literal's marker. */
	readonly #literals: ReadonlyMap<string, string>;
	/** The held literals that start with each key. */
	readonly #byKey = new Map<string, string[]>();
	/** The lengths of the keys shorter than {@link KEY_CHARS}, ascending. */
	readonly #shortKeyLengths: number[];
	/** Alternations of the keys, longest first, each within {@link CHUNK_PATTERN_CHARS}. */
	readonly #keyChunks: RegExp[] = [];
	readonly #regexes: readonly ScanRegex[];

	constructor(literals: ReadonlyMap<string, string>, regexes: readonly MarkedRegex[]) {
		this.#literals = literals;
		for (const marker of literals.values()) this.#markers.add(marker);
		for (const { marker } of regexes) this.#markers.add(marker);
		let longestMarker = 0;
		for (const marker of this.#markers) {
			// The scan for exact markers relies on this shape: no marker overlaps another.
			if (!MARKER_SHAPE.test(marker)) throw new Error("A session store marker has an unexpected shape");
			longestMarker = Math.max(longestMarker, marker.length);
		}
		this.#longestMarker = longestMarker;

		for (const literal of literals.keys()) {
			if (literal === "") continue;
			const key = literal.slice(0, KEY_CHARS);
			const sharing = this.#byKey.get(key);
			if (sharing === undefined) this.#byKey.set(key, [literal]);
			else sharing.push(literal);
		}
		// Longest first, so the key an alternation matches at a position is the longest that starts there.
		const keys = [...this.#byKey.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
		const shortKeyLengths = new Set<number>();
		let sources: string[] = [];
		let chars = 0;
		for (const key of keys) {
			if (key.length < KEY_CHARS) shortKeyLengths.add(key.length);
			const source = RegExp.escape(key);
			if (sources.length > 0 && chars + source.length + 1 > CHUNK_PATTERN_CHARS) {
				this.#keyChunks.push(compiledAlternation(sources));
				sources = [];
				chars = 0;
			}
			sources.push(source);
			chars += source.length + 1;
		}
		if (sources.length > 0) this.#keyChunks.push(compiledAlternation(sources));
		this.#shortKeyLengths = [...shortKeyLengths].sort((a, b) => a - b);

		this.#regexes = regexes.map(({ regex, marker }) => {
			// Without the global flag, `exec` would give the first match again and again.
			if (!regex.global) throw new Error("A held session store regex is not global");
			return { regex, marker, unicode: regex.unicode || regex.unicodeSets };
		});
	}

	mask(text: string): string {
		// A range is whole exact markers and characters outside them, and one marker replaces it. So a
		// pass that changes the text leaves fewer characters outside the exact markers, or as many and
		// fewer markers: the text settles within `text.length` changing passes. Should it not, the
		// throw fails the write.
		let current = text;
		for (let pass = 0; pass <= text.length; pass++) {
			const next = this.#pass(current);
			if (next === current) return current;
			current = next;
		}
		throw new Error("Session store masking did not settle");
	}

	#pass(text: string): string {
		const keys = this.#keysIn(text);
		// The common case: no key of a held literal occurs, and there is no regex to run.
		if (keys === undefined && this.#regexes.length === 0) return text;
		const markers = this.#markersIn(text);
		const ranges: MatchRange[] = [];
		if (keys !== undefined) this.#addLiteralRanges(text, keys, markers, ranges);
		this.#addRegexRanges(text, markers, ranges);
		if (ranges.length === 0) return text;
		// The match that starts first names a merged range, the longer one when two start together.
		// The sort is stable: matches of one start and one length keep the order they were found in,
		// a literal's before a regex's. In this order the ranges start in text order too.
		ranges.sort((a, b) => a.at - b.at || b.length - a.length);
		const parts: string[] = [];
		let from = 0;
		for (let index = 0; index < ranges.length;) {
			const { start, marker } = ranges[index];
			let end = ranges[index].end;
			for (index++; index < ranges.length && ranges[index].start <= end; index++) {
				end = Math.max(end, ranges[index].end);
			}
			parts.push(text.slice(from, start), marker);
			from = end;
		}
		parts.push(text.slice(from));
		return parts.join("");
	}

	/** The exact markers of this matcher in `text`, in order. A marker holds no bracket inside, so no two overlap. */
	#markersIn(text: string): readonly Span[] {
		let at = text.indexOf(MARKER_PREFIX);
		if (at === -1) return NO_SPANS;
		const spans: Span[] = [];
		let close = -1;
		while (at !== -1) {
			// The first closing bracket after the prefix; the last one found still is while it lies ahead.
			if (close < at + MARKER_PREFIX.length) {
				close = text.indexOf("]", at + MARKER_PREFIX.length);
				if (close === -1) break;
			}
			const end = close + 1;
			if (end - at <= this.#longestMarker && this.#markers.has(text.slice(at, end))) {
				spans.push({ start: at, end });
				at = text.indexOf(MARKER_PREFIX, end);
			} else {
				at = text.indexOf(MARKER_PREFIX, at + 1);
			}
		}
		return spans;
	}

	#addLiteralRanges(
		text: string,
		keys: ReadonlyMap<string, Reach>,
		markers: readonly Span[],
		ranges: MatchRange[],
	): void {
		for (const [key, reach] of keys) {
			for (const literal of this.#byKey.get(key) ?? []) {
				const marker = this.#literals.get(literal);
				if (marker !== undefined) addOccurrences(text, literal, reach, marker, markers, ranges);
			}
		}
	}

	/**
	 * Each key that occurs in `text` with where it does, or `undefined` when none does: only a
	 * literal of such a key can occur in the text, and only within that reach.
	 */
	#keysIn(text: string): Map<string, Reach> | undefined {
		let keys: Map<string, Reach> | undefined;
		for (const chunk of this.#keyChunks) {
			chunk.lastIndex = 0;
			for (let match = chunk.exec(text); match !== null; match = chunk.exec(text)) {
				const { index } = match;
				// Resume one character on, so a key that starts inside this one is found too.
				chunk.lastIndex = index + 1;
				keys ??= new Map();
				const reach = keys.get(match[0]);
				if (reach === undefined) keys.set(match[0], { first: index, last: index });
				else reach.last = index;
			}
		}
		if (keys === undefined || this.#shortKeyLengths.length === 0) return keys;
		// An alternation names the longest key that starts at a character. A shorter key that starts
		// there is a prefix of it, so it occurs wherever the longer one does. A key added here is
		// visited in turn; its prefixes are prefixes of the longer key too, so the result is the same.
		for (const [key, reach] of keys) {
			for (const length of this.#shortKeyLengths) {
				if (length >= key.length) break;
				const shorter = key.slice(0, length);
				if (!this.#byKey.has(shorter)) continue;
				const known = keys.get(shorter);
				if (known === undefined) {
					keys.set(shorter, { first: reach.first, last: reach.last });
				} else {
					known.first = Math.min(known.first, reach.first);
					known.last = Math.max(known.last, reach.last);
				}
			}
		}
		return keys;
	}

	#addRegexRanges(text: string, markers: readonly Span[], ranges: MatchRange[]): void {
		if (this.#regexes.length === 0) return;
		if (markers.length === 0) {
			this.#addRegexMatches(text, 0, ranges);
			return;
		}
		let from = 0;
		for (const marker of markers) {
			if (marker.start > from) this.#addRegexMatches(text.slice(from, marker.start), from, ranges);
			from = marker.end;
		}
		if (from < text.length) this.#addRegexMatches(text.slice(from), from, ranges);
	}

	/** Adds each non-empty regex match in `segment`, the text that starts at `offset` between two markers. */
	#addRegexMatches(segment: string, offset: number, ranges: MatchRange[]): void {
		for (const { regex, marker, unicode } of this.#regexes) {
			regex.lastIndex = 0;
			for (let match = regex.exec(segment); match !== null; match = regex.exec(segment)) {
				const start = match.index;
				const length = match[0].length;
				if (length > 0) {
					const at = offset + start;
					ranges.push({ at, length, start: at, end: at + length, marker });
					continue;
				}
				// An empty match masks nothing; step over one character, as `String.prototype.replace` does.
				const pair = unicode && (segment.codePointAt(start) ?? 0) > 0xffff;
				regex.lastIndex = start + (pair ? 2 : 1);
			}
		}
	}
}

/**
 * The alternation of `sources`, matched once: JavaScriptCore compiles a pattern at its first match,
 * so a pattern it refuses fails here, where the matcher is built, and not in a write.
 */
function compiledAlternation(sources: readonly string[]): RegExp {
	const alternation = new RegExp(sources.join("|"), "g");
	alternation.test("");
	alternation.lastIndex = 0;
	return alternation;
}

/**
 * Builds the matcher for `literals` (each held value and its marker) and `regexes`. Throws when it
 * cannot build one; nothing of a matcher that failed to build is kept.
 */
export function buildSessionStoreMatcher(
	literals: ReadonlyMap<string, string>,
	regexes: readonly MarkedRegex[],
): SessionStoreMatcher {
	return new UnionMatcher(literals, regexes);
}
