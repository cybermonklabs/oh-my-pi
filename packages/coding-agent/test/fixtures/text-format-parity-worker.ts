import "../../src/thread/subagent-worker-entry";
import { parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import { textFormatParsing } from "../../src/thread/text-format-forwarding";

// Parses every document through the forwarders, then (once a dated TOML
// document made this thread parse locally) through the originals, compares the
// two inside the worker, and reports one row per document.

const YAML_DOCUMENT = `cycle: &node
  name: node
  self: *node
  peers: [*node]
negativeZero: -0.0
notANumber: .nan
negativeInfinity: -.inf
big: 123456789012345678901234567890
timestamp: 2001-12-14t21:59:43.10-05:00
__proto__:
  polluted: true
nested:
  - [1, [2, [3]]]
  - { list: [a, b] }
`;

const TOML_DOCUMENT = `title = "parity"
negative_zero = -0.0
not_a_number = nan
negative_infinity = -inf

[owner]
name = "omp"
tags = ["a", "b"]

[[items]]
id = 1

[[items]]
id = 2
`;

const XML_DOCUMENT = '<root id="1" kind="demo"><item>1</item><item>2</item><leaf name="x"/></root>';

/** Name and parse call of each document a forwarder must answer from main. */
const FORWARDED: ReadonlyArray<readonly [name: string, parse: () => unknown]> = [
	["YAML", () => Bun.YAML.parse(YAML_DOCUMENT)],
	["YAML malformed", () => Bun.YAML.parse("a: [1, 2\nb: }\n")],
	["TOML from bytes", () => Bun.TOML.parse(new TextEncoder().encode(TOML_DOCUMENT))],
	["TOML integer past 2^53", () => Bun.TOML.parse("n = 9007199254740993\n")],
	["JSONC", () => Bun.JSONC.parse('{\n  // line\n  "a": [1, 2,], /* block */\n  "b": { "c": true, },\n}')],
	["JSONC malformed", () => Bun.JSONC.parse('{"a": }')],
	["JSON5", () => Bun.JSON5.parse("{ inf: Infinity, nan: NaN, hex: 0xFF, negativeZero: -0, }")],
	["JSON5 malformed", () => Bun.JSON5.parse("{a: }")],
	["XML", () => Bun.XML.parse(XML_DOCUMENT)],
	["XML compact: false", () => Bun.XML.parse(XML_DOCUMENT, { compact: false })],
	["XML malformed", () => Bun.XML.parse("<root><a></root>")],
];

/** Main cannot send `Temporal` values back, so this one falls back to a local parse. */
const parseDated = (): unknown => Bun.TOML.parse("released = 1979-05-27T07:32:00-08:00\nday = 1979-05-27\n");

type Outcome = { readonly value: unknown } | { readonly error: unknown };

function attempt(parse: () => unknown): Outcome {
	try {
		return { value: parse() };
	} catch (error) {
		return { error };
	}
}

function describeOutcome(outcome: Outcome): string {
	if ("value" in outcome) return "value";
	return outcome.error instanceof Error ? outcome.error.name : `non-Error ${String(outcome.error)}`;
}

/**
 * First difference between `a` and `b`: `Object.is` on leaves, the same
 * prototypes and own keys in the same order, and every object reached again
 * (a cycle or a shared reference) reached again at the same place.
 */
function valueDifference(
	a: unknown,
	b: unknown,
	path: string,
	firstSeenA: Map<object, string>,
	firstSeenB: Map<object, string>,
): string | undefined {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return Object.is(a, b) ? undefined : `${path}: ${Bun.inspect(a)} vs ${Bun.inspect(b)}`;
	}
	const seenA = firstSeenA.get(a);
	const seenB = firstSeenB.get(b);
	if (seenA !== undefined || seenB !== undefined) {
		return seenA === seenB ? undefined : `${path}: reaches ${seenA ?? "a new object"} vs ${seenB ?? "a new object"}`;
	}
	firstSeenA.set(a, path);
	firstSeenB.set(b, path);
	const proto = Object.getPrototypeOf(a);
	if (proto !== Object.getPrototypeOf(b)) return `${path}: different prototypes`;
	if (a instanceof Date && b instanceof Date) {
		if (!Object.is(a.getTime(), b.getTime())) return `${path}: ${a.getTime()} vs ${b.getTime()}`;
	} else if (proto !== Object.prototype && proto !== Array.prototype && proto !== null && String(a) !== String(b)) {
		// `Temporal` values carry their state in internal slots, not own keys.
		return `${path}: ${String(a)} vs ${String(b)}`;
	}
	const keysA = Reflect.ownKeys(a);
	const keysB = Reflect.ownKeys(b);
	if (keysA.length !== keysB.length || keysA.some((key, i) => key !== keysB[i])) {
		return `${path}: keys ${keysA.map(String).join(",")} vs ${keysB.map(String).join(",")}`;
	}
	for (const key of keysA) {
		const difference = valueDifference(
			Object.getOwnPropertyDescriptor(a, key)?.value,
			Object.getOwnPropertyDescriptor(b, key)?.value,
			`${path}.${String(key)}`,
			firstSeenA,
			firstSeenB,
		);
		if (difference) return difference;
	}
	return undefined;
}

function errorDifference(a: unknown, b: unknown): string | undefined {
	if (!(a instanceof Error) || !(b instanceof Error)) return "not both Errors";
	if (a.constructor !== b.constructor) return `constructor ${a.constructor.name} vs ${b.constructor.name}`;
	if (a.name !== b.name) return `name ${a.name} vs ${b.name}`;
	if (a.message !== b.message) return `message ${a.message} vs ${b.message}`;
	return undefined;
}

function outcomeDifference(forwarded: Outcome, local: Outcome): string {
	let difference: string | undefined;
	if ("value" in forwarded && "value" in local) {
		difference = valueDifference(forwarded.value, local.value, "$", new Map(), new Map());
	} else if ("error" in forwarded && "error" in local) {
		difference = errorDifference(forwarded.error, local.error);
	} else {
		difference = `${describeOutcome(forwarded)} vs ${describeOutcome(local)}`;
	}
	return difference ?? "same";
}

function run(): void {
	const forwarded = FORWARDED.map(([, parse]) => attempt(parse));
	const afterForwarding = textFormatParsing();
	const datedFallback = attempt(parseDated);
	const afterFallback = textFormatParsing();
	const rows = FORWARDED.map(([name, parse], i) => {
		const outcome = forwarded[i];
		return [name, describeOutcome(outcome), outcomeDifference(outcome, attempt(parse))];
	});
	rows.push([
		"TOML with dates",
		describeOutcome(datedFallback),
		outcomeDifference(datedFallback, attempt(parseDated)),
	]);
	logger.debug("text-format-parity: done", { states: [afterForwarding, afterFallback], rows });
}

// Runs after the entry's own listener handled the init message, so the link is attached.
parentPort?.once("message", () => run());
