/**
 * Try to parse JSON, returning null on failure.
 */
export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Index just past the JSON object or array that opens at `text[start]`, or -1
 * when it does not close within `text`. String literals are skipped, honoring
 * escapes, so brackets inside values do not count. Malformed input yields some
 * end that a parser then rejects.
 */
export function jsonContainerEnd(text: string, start: number): number {
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x22) {
			for (index++; index < text.length; index++) {
				const inner = text.charCodeAt(index);
				if (inner === 0x5c) index++;
				else if (inner === 0x22) break;
			}
		} else if (code === 0x7b || code === 0x5b) {
			depth++;
		} else if ((code === 0x7d || code === 0x5d) && --depth === 0) {
			return index + 1;
		}
	}
	return -1;
}

/**
 * Serialize JSON while preserving bigint precision as decimal strings.
 *
 * Tool arguments normally arrive from JSON providers, but extension hooks and
 * host integrations can supply JavaScript bigint values. Native
 * `JSON.stringify` throws for those values, which makes otherwise valid agent
 * history impossible to persist, replay, or compact. A decimal string is the
 * only lossless JSON representation.
 */
export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	// Fast path: a replacer forces the slow stringify on every call, but
	// bigint payloads are vanishingly rare. Try plain stringify first and
	// retry with the coercing replacer only on TypeError (the only error a
	// bigint raises). A TypeError from elsewhere (circular value, throwing
	// toJSON) recurs on the retry and surfaces from that second walk, so
	// stateful serializers ahead of a bigint run twice on that path.
	try {
		return JSON.stringify(value, undefined, space);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
	}
}

/**
 * `JSON.stringify(value)`, also for a value nested deeper than the engine's
 * recursion allows (Bun's throws a `RangeError` between 10,000 and 40,000
 * levels, while its `JSON.parse` reads 400,000): on that `RangeError` the
 * value is written again by {@link stringifyJsonIteratively}, which gives the
 * same bytes. Any value `JSON.stringify` writes gets its result, and any other
 * error is its own. A `RangeError` from elsewhere (a `toJSON` that throws one)
 * recurs in the second walk and surfaces from it, so the `toJSON` methods
 * ahead of it run twice on that path.
 */
export function stringifyDeepJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		return stringifyJsonIteratively(value);
	}
}

/** An object or array {@link stringifyJsonIteratively} is writing. */
interface JsonContainerFrame {
	readonly container: object;
	/** The object's keys, in the order `JSON.stringify` writes them; undefined for an array. */
	readonly keys: string[] | undefined;
	/** How many keys or elements it has. */
	readonly length: number;
	/** The next key or element to write. */
	index: number;
	/** Whether a member was written, so the next one follows a comma. */
	written: boolean;
}

/** Pieces {@link stringifyJsonIteratively} joins into one chunk of its text. */
const JSON_PIECES_PER_CHUNK = 1024;

/**
 * `JSON.stringify(value)` with no replacer and no indent, written with an
 * explicit stack instead of recursion, so a value of any depth serializes.
 * It walks objects and arrays as `JSON.stringify` does: each value's
 * `toJSON(key)` first, an object's keys in `Object.keys` order, `undefined`,
 * a function and a symbol left out of an object and written `null` in an
 * array, and a cycle a `TypeError`. Every other value (a string, number,
 * boolean, `null`, bigint or boxed primitive) is written by `JSON.stringify`
 * itself, so its bytes and errors are that function's. It takes several
 * times as long as `JSON.stringify` on a shallow value, but Bun's slows with
 * depth: {@link stringifyDeepJson} runs this writer where `JSON.stringify`
 * runs out of stack, and a caller that knows a value is deep can call it
 * directly.
 */
export function stringifyJsonIteratively(value: unknown): string | undefined {
	const root = jsonValueOf(value, "");
	if (!isJsonContainer(root)) return JSON.stringify(root);
	// The text so far: chunks of joined pieces, and the pieces since, so the engine holds a few
	// long strings instead of one short string per value (millions for a long session's tree).
	const chunks: string[] = [];
	let parts: string[] = [];
	const write = (piece: string): void => {
		parts.push(piece);
		if (parts.length < JSON_PIECES_PER_CHUNK) return;
		chunks.push(parts.join(""));
		parts = [];
	};
	const stack: JsonContainerFrame[] = [];
	const open = new Set<object>();
	// Keys repeat across the objects of one value (every entry of a tree has the same ones).
	const quotedKeys = new Map<string, string>();
	const prefix = (frame: JsonContainerFrame, key: string): string => {
		const comma = frame.written ? "," : "";
		if (!frame.keys) return comma;
		let quoted = quotedKeys.get(key);
		if (quoted === undefined) {
			quoted = JSON.stringify(key);
			quotedKeys.set(key, quoted);
		}
		return `${comma}${quoted}:`;
	};
	const enter = (container: object): void => {
		if (open.has(container)) throw new TypeError("JSON.stringify cannot serialize cyclic structures.");
		open.add(container);
		if (Array.isArray(container)) {
			stack.push({ container, keys: undefined, length: container.length, index: 0, written: false });
			write("[");
		} else {
			const keys = Object.keys(container);
			stack.push({ container, keys, length: keys.length, index: 0, written: false });
			write("{");
		}
	};
	enter(root);
	while (stack.length > 0) {
		const frame = stack[stack.length - 1]!;
		if (frame.index === frame.length) {
			write(frame.keys ? "}" : "]");
			open.delete(frame.container);
			stack.pop();
			continue;
		}
		const key = frame.keys ? frame.keys[frame.index]! : String(frame.index);
		frame.index++;
		const member = jsonValueOf(Reflect.get(frame.container, key), key);
		if (isJsonContainer(member)) {
			write(prefix(frame, key));
			frame.written = true;
			enter(member);
			continue;
		}
		const text: string | undefined = JSON.stringify(member);
		if (text === undefined && frame.keys) continue;
		write(prefix(frame, key) + (text ?? "null"));
		frame.written = true;
	}
	chunks.push(parts.join(""));
	return chunks.join("");
}

/** `value` after its `toJSON(key)`, as `JSON.stringify` serializes it under `key`. */
function jsonValueOf(value: unknown, key: string): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "bigint")) {
		return value;
	}
	// Read as `JSON.stringify` reads it: a bigint's on its prototype, with the bigint as the receiver.
	const toJSON: unknown =
		typeof value === "bigint" ? Reflect.get(Object(value), "toJSON", value) : Reflect.get(value, "toJSON");
	return typeof toJSON === "function" ? Reflect.apply(toJSON, value, [key]) : value;
}

/** Whether `JSON.stringify` writes `value` as an object or an array: an object that is neither callable nor a boxed primitive. */
function isJsonContainer(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt)
	);
}

function stableJsonClone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableJsonClone);
	if (value !== null && typeof value === "object") {
		const sorted = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableJsonClone(Reflect.get(value, key));
		}
		return sorted;
	}
	return value;
}

/**
 * Deterministically serialize JSON-shaped data by sorting object keys at every
 * depth while preserving array order. Throws for values JSON cannot represent
 * as a top-level value instead of returning an easy-to-misuse undefined.
 */
export function stableStringifyJson(value: unknown): string {
	const serialized = JSON.stringify(stableJsonClone(value));
	if (serialized === undefined) throw new TypeError("Value is not JSON-serializable");
	return serialized;
}
