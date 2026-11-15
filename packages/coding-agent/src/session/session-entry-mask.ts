/**
 * Copy-on-write masking of a session entry or header before it reaches the
 * session store (`secrets.maskSessionStore`). Rules go by field name, `type`
 * string and the place of a field in the session format only. An entry with
 * nothing to mask comes back as the same object; a masked one shares every
 * untouched subtree with the live entry.
 */
import { countNewlines, isRecord } from "@oh-my-pi/pi-utils";
import type { SessionStoreMask } from "../secrets/session-store-mask";
import { isBlobRef, isImageDataUrl } from "./blob-store";
import { isImageDataPayload } from "./session-persistence";
import type { SessionTitleUpdate } from "./session-title-slot";

/** A child the parent copy leaves out: an object key omitted, an array item removed. */
const DROP: unique symbol = Symbol("drop");

/**
 * Where an object sits in the session format: an entry or the header, an entry's
 * `message`, a `content` array of either, an item of that array, or anywhere else.
 */
type Position = "entry" | "message" | "content" | "block" | "free";

/**
 * Per position, the keys whose string values link or classify records, kept as written
 * there only. Under any other field (tool call arguments, tool result details, custom
 * data) these names are data a model, a tool or an extension wrote, and are masked.
 */
const STRUCTURAL_KEYS: Readonly<Record<Position, ReadonlySet<string>>> = {
	entry: new Set(["type", "id", "parentId", "timestamp"]),
	message: new Set(["role", "timestamp", "toolCallId"]),
	content: new Set(),
	block: new Set(["type", "id"]),
	free: new Set(),
};
/** Header (`type: "session"`) fields kept as written. */
const HEADER_KEYS = new Set(["cwd", "parentSession", "version"]);
/** Keys holding provider ciphertext, never scanned. */
const CIPHERTEXT_KEYS = new Set(["encrypted_content", "encryptedContent"]);
/** Keys holding provider replay state, dropped whole when masking changes any string inside. */
const CARRIER_KEYS = new Set(["providerPayload", "anthropicCompaction"]);
/** `type`s of provider replay state, dropped whole when masking changes any string inside. */
const CARRIER_TYPES = new Set(["anthropicCompaction", "cursorHistory", "geminiNativeContent"]);
/** Per block `type`, the field holding a payload kept whole and unscanned. */
const OPAQUE_KEY_BY_TYPE = new Map([
	["image_generation_call", "result"],
	["redactedThinking", "data"],
]);
/** Per block `type`, the signature binding the block to its exact bytes. */
const SIGNATURE_KEY_BY_TYPE = new Map([
	["thinking", "thinkingSignature"],
	["text", "textSignature"],
	["toolCall", "thoughtSignature"],
]);
/** Anthropic replays a server-tool use and its result as a pair, so a changed one takes its siblings along. */
const SERVER_TOOL_TYPE = "anthropicServerTool";

/**
 * `entry` with every held secret replaced by its marker, for the stored copy
 * only: the live entry is never mutated. Returns `entry` itself when nothing
 * changes or `mask` is `null`. Signed blocks that change lose their signature;
 * provider replay state that changes is dropped whole.
 */
export function maskSessionEntry<T>(entry: T, mask: SessionStoreMask | null): T {
	if (mask === null || mask.empty) return entry;
	if (!isRecord(entry)) return maskValue(entry, mask, "free") as T;
	return maskObject(entry, mask, "entry") as T;
}

/**
 * `value` with every held secret replaced by its marker, for a stored copy of free data, such as a
 * subagent's yield data: no field in it is structural. The value itself is masked, never dropped.
 */
export function maskStoredData<T>(value: T, mask: SessionStoreMask | null): T {
	return mask === null || mask.empty ? value : (maskValue(value, mask, "free") as T);
}

/** `update` with its title masked, so the store's title field holds what the title slot holds. */
export function maskTitleUpdate(update: SessionTitleUpdate, mask: SessionStoreMask | null): SessionTitleUpdate {
	if (mask === null || update.title === undefined) return update;
	const title = mask.maskText(update.title);
	return title === update.title ? update : { ...update, title };
}

function maskValue(value: unknown, mask: SessionStoreMask, position: Position): unknown {
	if (typeof value === "string") return isBlobRef(value) || isImageDataUrl(value) ? value : mask.maskText(value);
	if (Array.isArray(value)) return maskArray(value, mask, position === "content" ? "block" : "free");
	if (!isRecord(value)) return value;
	return maskObject(value, mask, position);
}

/** `value` masked, or {@link DROP} when it is provider replay state that masking changed. */
function maskChild(value: unknown, mask: SessionStoreMask, position: Position, key?: string): unknown {
	const next = maskValue(value, mask, position);
	if (next === value) return value;
	if (key !== undefined && CARRIER_KEYS.has(key)) return DROP;
	if (isRecord(value) && typeof value.type === "string" && CARRIER_TYPES.has(value.type)) return DROP;
	return next;
}

/** `items` masked, each at `itemPosition`. */
function maskArray(items: unknown[], mask: SessionStoreMask, itemPosition: Position): unknown[] {
	let copy: unknown[] | undefined;
	let serverToolChanged = false;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const next = maskChild(item, mask, itemPosition);
		if (copy === undefined) {
			if (next === item) continue;
			copy = items.slice(0, i);
		}
		if (next === DROP) continue;
		if (next !== item && isRecord(item) && item.type === SERVER_TOOL_TYPE) serverToolChanged = true;
		copy.push(next);
	}
	if (copy === undefined) return items;
	return serverToolChanged ? copy.filter(item => !isRecord(item) || item.type !== SERVER_TOOL_TYPE) : copy;
}

function maskObject(obj: Record<string, unknown>, mask: SessionStoreMask, position: Position): Record<string, unknown> {
	// Image and binary payloads are kept whole: masking base64 would corrupt it.
	if (isImageDataPayload(obj)) return obj;
	const type = typeof obj.type === "string" ? obj.type : undefined;
	const opaqueKey = type === undefined ? undefined : OPAQUE_KEY_BY_TYPE.get(type);
	const signatureKey = signatureKeyOf(obj, type);
	const header = position === "entry" && type === "session";
	let copy: Record<string, unknown> | undefined;
	let maskedContent: string | undefined;
	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const value = obj[key];
		const next = keptAsWritten(key, value, opaqueKey, position, header)
			? value
			: maskChild(value, mask, childPosition(position, key), key);
		if (copy === undefined) {
			if (next === value) continue;
			copy = copyBefore(obj, key, signatureKey);
		}
		// A signed block that changed no longer matches its signature: store it unsigned.
		if (next === DROP || key === signatureKey) continue;
		setOwn(copy, key, next);
		if (key === "content" && typeof next === "string" && next !== value) maskedContent = next;
	}
	if (copy === undefined) return obj;
	if (maskedContent !== undefined && typeof copy.lineCount === "number") {
		copy.lineCount = countNewlines(maskedContent) + 1;
	}
	return copy;
}

function keptAsWritten(
	key: string,
	value: unknown,
	opaqueKey: string | undefined,
	position: Position,
	header: boolean,
): boolean {
	if (key === opaqueKey || (header && HEADER_KEYS.has(key))) return true;
	return typeof value === "string" && (STRUCTURAL_KEYS[position].has(key) || CIPHERTEXT_KEYS.has(key));
}

/** The position of the value under `key` of an object at `position`. */
function childPosition(position: Position, key: string): Position {
	if (position === "entry" && key === "message") return "message";
	if ((position === "entry" || position === "message") && key === "content") return "content";
	return "free";
}

/** The signature key of a signed `thinking`/`text`/`toolCall` block, or `undefined` when it is unsigned. */
function signatureKeyOf(obj: Record<string, unknown>, type: string | undefined): string | undefined {
	const key = type === undefined ? undefined : SIGNATURE_KEY_BY_TYPE.get(type);
	if (key === undefined) return undefined;
	const signature = obj[key];
	return typeof signature === "string" && signature.length > 0 ? key : undefined;
}

/** A copy of `obj`'s own keys that come before `stop`, leaving out `skip`. */
function copyBefore(obj: Record<string, unknown>, stop: string, skip: string | undefined): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const key in obj) {
		if (key === stop) break;
		if (Object.hasOwn(obj, key) && key !== skip) setOwn(copy, key, obj[key]);
	}
	return copy;
}

/** Assign an own data property, so a parsed `__proto__` key stays a field rather than a prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		target[key] = value;
	}
}
