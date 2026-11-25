import { ContainerPath, type NestedWalk, runNested } from "./nested-walk";

export { once, untilAborted } from "./abortable";
export * from "./async";
export * from "./binary";
export * from "./bytes";
export * from "./color";
export * from "./dirs";
export * from "./env";
export * from "./event-loop-slice";
export * from "./executable";
export * from "./fetch-retry";
export * from "./file-lock";
export * from "./format";
export * from "./frontmatter";
export * from "./fs-error";
export * from "./incoming-json";
export * from "./json";
export * from "./json-parse";
export * as logger from "./logger";
export * from "./loop-phase";
export * from "./math-delimiters";
export * from "./materialize-string";
export * from "./mermaid-ascii";
export * from "./mime";
export * from "./nested-walk";
export * from "./path";
export * from "./path-tree";
export * from "./peek-file";
export * from "./pid";
export * as postmortem from "./postmortem";
export * from "./process-name";
export * as procmgr from "./procmgr";
export * as prompt from "./prompt";
export * as ptree from "./ptree";
export { AbortError, ChildProcess, Exception, NonZeroExitError } from "./ptree";
export * from "./runtime-install";
export * from "./sanitize-text";
export * from "./slugify";
export * from "./snowflake";
export * from "./sqlite";
export * from "./stderr-guard";
export * from "./stream";
export * from "./tab-spacing";
export * from "./temp";
export * from "./tls-fetch";
export * from "./type-guards";
export * from "./version";
export * from "./which";
export * from "./yaml-config";

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

export function structuredCloneJSON<T>(value: T): T {
	// primitives|null|undefined, copy
	if (!value || typeof value !== "object") {
		return value;
	}

	// deep clone
	if (isPlainObject(value)) {
		try {
			return structuredClone(value);
		} catch {
			// might still fail due to nested structures
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
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

function isJsonRecord(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
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
