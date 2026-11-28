import { stringifyDeepJson } from "./json";
import { ContainerPath, isStackOverflow, type NestedWalk, runNested } from "./nested-walk";
import { isJsonRecord } from "./type-guards";

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

/**
 * A copy of `value`: an array or an object whose prototype is
 * `Object.prototype` as {@link structuredCloneDeep} copies it, so a `Map` or
 * `Date` inside stays one; any other object, or one that `structuredClone`
 * cannot copy (it holds a function or a symbol), as `JSON.parse` reads the
 * JSON {@link stringifyDeepJson} writes of it, which leaves that member out.
 * Both copy a value of any depth `JSON.parse` reads.
 */
export function structuredCloneJSON<T>(value: T): T {
	// primitives|null|undefined, copy
	if (!value || typeof value !== "object") {
		return value;
	}

	// deep clone
	if (isPlainObject(value)) {
		try {
			return structuredCloneDeep(value);
		} catch {
			// A function or symbol inside, which the JSON copy leaves out.
		}
	}
	return JSON.parse(stringifyDeepJson(value) as string) as T;
}

/**
 * Deep-copies a JSON-shaped tree (arrays and plain or null-prototype objects)
 * so later mutation of the source can never reach the copy. Strings and other
 * primitives are immutable and shared, so the cost is O(containers) instead of
 * `structuredClone`'s O(bytes) — the difference matters for hot paths that
 * re-copy large string payloads (e.g. streamed tool-call arguments) per delta.
 *
 * Copies own enumerable string keys only. Any other object (class instance,
 * Date, Map, inherited-prototype object) is copied with {@link structuredCloneJSON}.
 * The copy keeps its own stack ({@link runNested}), so it copies a tree of any
 * depth `JSON.parse` reads (a session entry read from a transcript line, say),
 * where a recursive copy stops near 22,500 levels; a cycle, which JSON data
 * never holds, throws the `TypeError` `JSON.stringify` throws.
 */
export function cloneJsonTree<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	return runNested(cloneJsonNode(value, new ContainerPath())) as T;
}

/**
 * `structuredClone(value)`, also for a value nested deeper than its recursion
 * allows: Bun's `structuredClone` throws `Maximum call stack size exceeded`
 * near 40,000 levels, and sooner on a deep call stack or a worker thread.
 * Every value `structuredClone` copies is copied by it. On that stack overflow
 * ({@link isStackOverflow}) the value is copied again by
 * {@link structuredCloneIteratively}, which keeps less: it walks the value's
 * arrays and plain objects on a stack of its own, so an array or plain object
 * met twice is copied once and a cycle through them stays a cycle, and it
 * copies each other object (a `Map`, `Set`, `Date`, class instance, typed
 * array) with a `structuredClone` call of its own, so that object keeps its
 * type but not what it shares with the rest of the value or with another such
 * object (a buffer two typed arrays view, a plain object both inside a `Map`
 * and beside it, a cycle through a `Map`), and a value nested past
 * `structuredClone`'s reach inside one still throws. A function or symbol
 * throws its `DataCloneError`, and the getters ahead of the overflow run twice
 * on that path. Any other error is its own, a `RangeError` a getter throws
 * included. Only data parsed from JSON nests that deep (a tool call's
 * arguments, a session entry read from a transcript line), and such data holds
 * only arrays, plain objects and primitives. That failed attempt costs tens of
 * milliseconds, and a shallow value pays no depth check.
 */
export function structuredCloneDeep<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch (error) {
		if (!isStackOverflow(error)) throw error;
		return structuredCloneIteratively(value) as T;
	}
}

/** An array or plain object {@link structuredCloneIteratively} is filling: its source, its copy, and the source's keys from `index` on still to read. */
interface CloneFrame {
	readonly source: object;
	readonly copy: object;
	readonly keys: string[];
	index: number;
}

/**
 * `structuredClone(value)` without recursion. It copies each array, and each
 * object whose prototype is `Object.prototype` or `null`, itself, as
 * `structuredClone` copies them: an array keeps its length, its holes and its
 * other own enumerable keys, an object becomes a plain object with its own
 * enumerable string keys, and the value is read in `structuredClone`'s order,
 * each key's value whole before the next key, each once (a getter's included)
 * and a key a getter deleted before it is left out. Any other value is copied
 * by a `structuredClone` call of its own, so a `Map`, `Set`, `Date`, `RegExp`,
 * typed array or `ArrayBuffer` keeps its type, a class instance becomes a
 * plain object, and a function or symbol throws its `DataCloneError`. An
 * object met twice is copied once, so what the arrays and plain objects share
 * stays shared and a cycle through them stays a cycle. Each of those
 * `structuredClone` calls copies apart from the rest: an object both inside
 * one and elsewhere (a buffer two typed arrays view, say) is copied once for
 * each, and a value nested past its reach inside one still overflows.
 */
function structuredCloneIteratively(root: unknown): unknown {
	const copies = new Map<object, unknown>();
	const stack: CloneFrame[] = [];
	// An array or plain object is copied empty here and filled by the loop below, before the key after it is read.
	const copyOf = (value: unknown): unknown => {
		if (typeof value !== "object" || value === null) {
			return typeof value === "function" || typeof value === "symbol" ? structuredClone(value) : value;
		}
		if (copies.has(value)) return copies.get(value);
		let copy: unknown;
		if (Array.isArray(value)) {
			// The copy starts at the source's length, so a hole the source leaves stays a hole.
			const array: unknown[] = [];
			array.length = value.length;
			stack.push({ source: value, copy: array, keys: Object.keys(value), index: 0 });
			copy = array;
		} else if (isJsonRecord(value)) {
			const record: Record<string, unknown> = {};
			stack.push({ source: value, copy: record, keys: Object.keys(value), index: 0 });
			copy = record;
		} else {
			copy = structuredClone(value);
		}
		copies.set(value, copy);
		return copy;
	};
	const copy = copyOf(root);
	while (stack.length > 0) {
		const frame = stack[stack.length - 1]!;
		if (frame.index === frame.keys.length) {
			stack.pop();
			continue;
		}
		const key = frame.keys[frame.index++]!;
		if (!Object.hasOwn(frame.source, key)) continue;
		const item = copyOf(Reflect.get(frame.source, key));
		// Assigning `__proto__` would swap the copy's prototype instead of creating the own key.
		if (key === "__proto__") {
			Object.defineProperty(frame.copy, key, { value: item, enumerable: true, writable: true, configurable: true });
		} else {
			Reflect.set(frame.copy, key, item);
		}
	}
	return copy;
}

/** {@link cloneJsonTree} of `value`, an object `path` is inside of; each child object is a nested step. */
function* cloneJsonNode(value: object, path: ContainerPath): NestedWalk {
	if (Array.isArray(value)) {
		path.enter(value);
		const out: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			// A hole stays a hole, as `Array.prototype.map` leaves it.
			if (!(index in value)) {
				out.length = index + 1;
				continue;
			}
			const item: unknown = value[index];
			out.push(item !== null && typeof item === "object" ? yield cloneJsonNode(item, path) : item);
		}
		path.leave(value);
		return out;
	}
	if (!isJsonRecord(value)) return structuredCloneJSON(value);
	path.enter(value);
	const out: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const item = value[key];
		const child = item !== null && typeof item === "object" ? yield cloneJsonNode(item, path) : item;
		// Assigning `__proto__` would swap the copy's prototype instead of
		// creating the own data property JSON.parse produces.
		if (key === "__proto__") {
			Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true });
		} else {
			out[key] = child;
		}
	}
	path.leave(value);
	return out;
}
