/**
 * Subagent worker threads parse YAML, TOML, JSONC, JSON5 and XML on the main
 * thread while they live.
 *
 * Bun 1.4.4 and 1.4.5 keep one private mimalloc heap per thread (up to 2 MiB
 * between calls) for `Bun.YAML.parse`, `Bun.TOML.parse`, `Bun.JSONC.parse`,
 * `Bun.JSON5.parse` and `Bun.XML.parse`, and never free it when the thread
 * ends. Every subagent worker parses frontmatter, settings and config, and the
 * pool stops idle workers and starts new ones, so a long session leaked one
 * heap per worker it ever started; the main thread's heap lives as long as the
 * process. Bun fixed this in https://github.com/oven-sh/bun/pull/49007: remove
 * this module once the release build's Bun carries that fix, i.e. from the
 * first Bun release after `bun-v1.4.5`.
 *
 * Worker side: evaluated on a worker thread, this module replaces each
 * `Bun.<format>.parse` of the realm with a forwarder (the subagent worker
 * entry imports it before the rest of its graph). Once
 * {@link attachTextFormatLink} gave it the link, a forwarder sends a string,
 * `ArrayBuffer` or `ArrayBufferView` input (and, for XML, options that are a
 * plain record of primitives) to the main thread with a synchronous call and
 * returns main's value or throws main's error, rebuilt. Every other case, and
 * every forward main cannot answer in time or at all, runs the original
 * `parse`; the first such local parse creates this thread's heap, so from
 * then on the thread parses locally ({@link textFormatParsing}).
 *
 * Main side: {@link parseTextFormatForWorker} serves those calls. The main
 * thread never waits on a worker, so the forward cannot deadlock; a busy main
 * thread costs a worker {@link TEXT_FORMAT_FORWARD_TIMEOUT_MS} once.
 */
import { isMainThread } from "node:worker_threads";
import { deserialize, serialize } from "bun:jsc";
import type { WorkerThreadLink } from "./protocol";

/** Formats whose `Bun.<format>.parse` keeps a heap per thread on Bun 1.4.4 and 1.4.5. */
export const TEXT_FORMATS = ["YAML", "TOML", "JSONC", "JSON5", "XML"] as const;

/** One of {@link TEXT_FORMATS}. */
export type TextFormat = (typeof TEXT_FORMATS)[number];

/** Input a forwarder sends to main; any other input (a `Blob`, a `SharedArrayBuffer`) parses locally. */
export type TextFormatInput = string | ArrayBuffer | ArrayBufferView;

/**
 * Main's answer to one forwarded parse: `value`, the result serialized with
 * `bun:jsc`'s structured clone; `error`, the `Error` the parser threw; or
 * `local`, when the result cannot be serialized (TOML dates are `Temporal`
 * objects) or the parser threw something else, so the worker parses locally.
 */
export type TextFormatParseReply =
	| { readonly value: SharedArrayBuffer }
	| { readonly error: { readonly name: string; readonly message: string } }
	| { readonly local: true };

/**
 * Deadline of one forwarded parse. It is longer than any normal turn of the
 * main event loop; a main thread blocked for longer costs this worker one
 * timeout and then a local parse (the leak this module avoids, once: the
 * thread parses locally from then on).
 */
export const TEXT_FORMAT_FORWARD_TIMEOUT_MS = 1000;

/** One format's `Bun` namespace; method syntax lets each format's own `parse` signature stand in. */
interface TextFormatNamespace {
	parse(input: unknown, options?: unknown): unknown;
}

/** Built-in error constructors a forwarded parse error is rebuilt with, by `name`. */
const ERROR_CLASSES: Record<string, ErrorConstructor> = {
	SyntaxError,
	TypeError,
	RangeError,
	ReferenceError,
	EvalError,
	URIError,
	Error,
};

let link: WorkerThreadLink | undefined;
/** Set by this thread's first local parse; the main thread always parses locally. */
let local = isMainThread;

/** Main thread: parse `input` for a worker on main's heap (`options` only for XML). */
export function parseTextFormatForWorker(
	format: TextFormat,
	input: TextFormatInput,
	options: unknown,
): TextFormatParseReply {
	const namespace: TextFormatNamespace = Bun[format];
	let value: unknown;
	try {
		value = format === "XML" ? namespace.parse(input, options) : namespace.parse(input);
	} catch (error) {
		return error instanceof Error ? { error: { name: error.name, message: error.message } } : { local: true };
	}
	try {
		return { value: serialize(value) };
	} catch {
		// `DataCloneError`, e.g. a TOML date (`Temporal`).
		return { local: true };
	}
}

/** Worker thread: forward this thread's parses over `workerLink` from now on (until one parses locally). */
export function attachTextFormatLink(workerLink: WorkerThreadLink): void {
	link = workerLink;
}

/** Whether this thread's parses still go to main, or run locally for good. */
export function textFormatParsing(): "forwarding" | "local" {
	return local ? "local" : "forwarding";
}

function isForwardableInput(input: unknown): input is TextFormatInput {
	return typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input);
}

/** `undefined`, `null`, or a plain record of enumerable data fields holding primitives: XML options main sees unchanged. */
function isForwardableXmlOptions(options: unknown): boolean {
	if (options === undefined || options === null) return true;
	if (typeof options !== "object") return false;
	const proto = Object.getPrototypeOf(options);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const key of Reflect.ownKeys(options)) {
		const field = Object.getOwnPropertyDescriptor(options, key);
		if (typeof key !== "string" || !field?.enumerable || !("value" in field)) return false;
		const value: unknown = field.value;
		if ((typeof value === "object" && value !== null) || typeof value === "function") return false;
	}
	return true;
}

/** This realm's error for one main reported: the built-in class of that name, else an `Error` carrying the name. */
function rebuildError(reported: { readonly name: string; readonly message: string }): Error {
	// Own keys only: a reported name like `constructor` must not reach `Object.prototype`.
	if (Object.hasOwn(ERROR_CLASSES, reported.name)) return new ERROR_CLASSES[reported.name](reported.message);
	const error = new Error(reported.message);
	error.name = reported.name;
	return error;
}

function installForwarder(format: TextFormat): void {
	const namespace: TextFormatNamespace = Bun[format];
	const original = namespace.parse;
	const parseLocally = (input: unknown, options: unknown): unknown => {
		local = true;
		return original.call(namespace, input, options);
	};
	namespace.parse = (input: unknown, options?: unknown): unknown => {
		const target = link;
		if (local || !target || !isForwardableInput(input) || (format === "XML" && !isForwardableXmlOptions(options))) {
			return parseLocally(input, options);
		}
		let reply: TextFormatParseReply;
		try {
			reply = target.callSyncWithin(
				TEXT_FORMAT_FORWARD_TIMEOUT_MS,
				"parseTextFormat",
				format,
				input,
				format === "XML" ? options : undefined,
			);
		} catch {
			// `RpcTimeoutError` (main busy), `RpcClosedError`, `RpcEncodeError`, `DataCloneError`.
			return parseLocally(input, options);
		}
		if ("value" in reply) return deserialize(reply.value);
		if ("error" in reply) throw rebuildError(reply.error);
		return parseLocally(input, options);
	};
}

if (!isMainThread) {
	for (const format of TEXT_FORMATS) installForwarder(format);
}
