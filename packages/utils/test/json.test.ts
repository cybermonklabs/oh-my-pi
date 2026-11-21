import { describe, expect, it } from "bun:test";
import {
	stableStringifyJson,
	stringifyDeepJson,
	stringifyJson,
	stringifyJsonIteratively,
} from "@oh-my-pi/pi-utils/json";

describe("stableStringifyJson", () => {
	it("canonicalizes nested object key order while preserving array order", () => {
		const left = { settings: { beta: 2, alpha: { z: true, a: false } }, args: ["--b", "--a"] };
		const right = { args: ["--b", "--a"], settings: { alpha: { a: false, z: true }, beta: 2 } };

		expect(stableStringifyJson(left)).toBe(stableStringifyJson(right));
		expect(stableStringifyJson({ args: ["--a", "--b"] })).not.toBe(stableStringifyJson({ args: ["--b", "--a"] }));
	});

	it("preserves __proto__ as an ordinary own JSON key", () => {
		const value: unknown = JSON.parse('{"__proto__":{"x":1}}');

		expect(stableStringifyJson(value)).toBe('{"__proto__":{"x":1}}');
		expect(stableStringifyJson(value)).not.toBe(stableStringifyJson({}));
	});

	it("rejects a top-level value JSON cannot serialize", () => {
		expect(() => stableStringifyJson(undefined)).toThrow("Value is not JSON-serializable");
	});
});

describe("stringifyJson", () => {
	it("serializes bigint values as decimal strings", () => {
		expect(stringifyJson({ n: 10n })).toBe('{"n":"10"}');
	});

	it("serializes bigints produced by toJSON", () => {
		expect(stringifyJson({ o: { toJSON: () => 5n } })).toBe('{"o":"5"}');
	});

	it("coerces bigints that follow a stateful serializer", () => {
		let calls = 0;
		const value = { a: { toJSON: () => ++calls }, b: 1n };
		expect(stringifyJson(value)).toBe('{"a":2,"b":"1"}');
	});

	it("still throws TypeError for non-serializable values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => stringifyJson(circular)).toThrow(TypeError);
	});

	it("rethrows non-TypeError serializer failures without retrying", () => {
		let calls = 0;
		const failing = {
			toJSON: () => {
				calls++;
				throw new RangeError("boom");
			},
		};
		expect(() => stringifyJson({ x: failing })).toThrow(RangeError);
		expect(calls).toBe(1);
	});
});

/** What `fn` throws, so two writers' errors compare by kind and message. */
function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? [error.constructor.name, error.message] : error;
	}
	return "nothing thrown";
}

/**
 * A value `levels` containers deep whose levels take turns among the shapes
 * `JSON.stringify` treats apart: values it leaves out of an object and writes
 * `null` in an array, `toJSON(key)` returning a container or `undefined`, a
 * hole, boxed primitives and a `Date`, integer-like keys it writes first, a
 * getter, symbol and inherited keys it skips, and strings it escapes.
 */
function deepValue(levels: number): unknown {
	let value: unknown = 'leaf \u2028 "quoted" \\ \ud800';
	for (let level = 0; level < levels; level++) {
		const child = value;
		switch ((level * 7 + 3) % 8) {
			case 0:
				value = {
					[`k${level}`]: child,
					u: undefined,
					f: () => level,
					s: Symbol("s"),
					n: level / 3,
					t: `tab\t${level}`,
				};
				break;
			case 1:
				value = [child, undefined, () => level, Symbol("s"), Number.NaN, -0, Number.POSITIVE_INFINITY];
				break;
			case 2:
				value = { toJSON: (key: string) => ({ key, inner: child }) };
				break;
			case 3: {
				const sparse: unknown[] = [];
				sparse[1] = child;
				value = sparse;
				break;
			}
			case 4:
				value = {
					"2": child,
					b: new Number(level),
					a: new String("x"),
					d: new Date(level),
					"1": new Boolean(true),
				};
				break;
			case 5:
				value = {
					get g() {
						return child;
					},
					[Symbol("hidden")]: level,
				};
				break;
			case 6:
				value = { omitted: { toJSON: () => undefined }, kept: child, list: [{ toJSON: () => undefined }] };
				break;
			default:
				value = Object.assign(Object.create({ inherited: level }), { own: child, [String(level)]: null });
		}
	}
	return value;
}

/** A generated value and the text `JSON.stringify` gives for it. */
interface Stringified {
	readonly value: unknown;
	readonly text: string;
}

/**
 * {@link deepValue} at the most levels, doubling from 4,000, that
 * `JSON.stringify` still writes here, with its text: at least half the depth
 * at which it runs out of stack. Bun's `JSON.stringify` takes seconds near
 * that depth (its time grows with the square of the depth), so the text of
 * the last success is kept rather than written again.
 */
function deepestStringified(): Stringified {
	let deepest: Stringified | undefined;
	for (let levels = 4_000; ; levels *= 2) {
		const value = deepValue(levels);
		try {
			deepest = { value, text: JSON.stringify(value) };
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			if (!deepest) throw new Error(`JSON.stringify ran out of stack at ${levels} levels`);
			return deepest;
		}
	}
}

// The RPC encoder writes a frame through `stringifyDeepJson`; a byte that differs from
// `JSON.stringify`'s is a frame the client parses to a different value than the host sent.
describe("stringifyJsonIteratively", () => {
	it("writes JSON.stringify's bytes for each kind of value", () => {
		const shared = { x: 1 };
		const callable = Object.assign(() => 1, { toJSON: () => "callable" });
		const hole: unknown[] = [0];
		hole[2] = 2;
		const cases: Record<string, unknown> = {
			string: 'a "quoted" \\ \n \u2028 \ud800 string',
			number: 1.5e300,
			negativeZero: -0,
			notFinite: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
			booleans: [true, false],
			null: null,
			undefined,
			function: () => 1,
			symbol: Symbol("s"),
			boxed: [new Number(3), new String("s"), new Boolean(false)],
			boxedRoot: new String("root"),
			empty: { object: {}, array: [] },
			keyOrder: { b: 1, 2: 2, a: 3, 1: 4 },
			escapedKeys: { 'a"b': 1, "\n": 2, "\u2028": 3 },
			protoKey: JSON.parse('{"__proto__":{"x":1}}'),
			omittedInObject: { u: undefined, f: () => 1, s: Symbol("s"), kept: 1 },
			nullInArray: [undefined, () => 1, Symbol("s"), 1],
			hole,
			toJSONKey: { a: { toJSON: (key: string) => `key ${key}` }, list: [{ toJSON: (key: string) => key }] },
			toJSONContainer: { a: { toJSON: () => ({ nested: [1, { toJSON: () => 2 }] }) } },
			toJSONUndefined: { gone: { toJSON: () => undefined }, list: [{ toJSON: () => undefined }] },
			toJSONRoot: { toJSON: (key: string) => ({ root: key }) },
			callableToJSON: { callable },
			date: new Date(0),
			symbolKey: { [Symbol("x")]: 1, a: 2 },
			hidden: Object.defineProperty({ shown: 1 }, "hidden", { value: 2, enumerable: false }),
			getter: {
				get computed() {
					return [1, 2];
				},
			},
			inherited: Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
			collections: [new Map([[1, 2]]), new Set([1])],
			typedArray: new Uint8Array([1, 2]),
			buffer: Buffer.from("ab"),
			sharedNotCycle: { a: shared, b: [shared, shared] },
		};
		for (const [name, value] of Object.entries(cases)) {
			expect([name, stringifyJsonIteratively(value)]).toEqual([name, JSON.stringify(value)]);
		}
	});

	it("throws JSON.stringify's errors for a cycle, a bigint and a throwing toJSON", () => {
		const list: unknown[] = [];
		const cycle = { a: list };
		list.push(cycle);
		const failing = {
			x: {
				toJSON: () => {
					throw new RangeError("boom");
				},
			},
		};
		for (const value of [cycle, { n: 1n }, [Object(1n)], failing]) {
			expect(thrown(() => stringifyJsonIteratively(value))).toEqual(thrown(() => JSON.stringify(value)));
		}
	});

	it("writes JSON.stringify's bytes for a generated value at least half as deep as its depth limit", () => {
		const { value, text } = deepestStringified();
		expect(stringifyJsonIteratively(value) === text).toBe(true);
	}, 120_000);
});

// RPC `get_tree` of a session longer than about 10,000 entries nests each one under its parent,
// past where `JSON.stringify` runs out of stack; without the fallback the command fails.
describe("stringifyDeepJson", () => {
	it("writes a 100,000-deep chain that JSON.stringify cannot", () => {
		let chain: unknown = { id: "leaf", children: [] };
		let expected = '{"id":"leaf","children":[]}';
		for (let index = 0; index < 100_000; index++) {
			chain = { id: `n${index}`, children: [chain] };
			expected = `{"id":"n${index}","children":[${expected}]}`;
		}
		expect(() => JSON.stringify(chain)).toThrow(RangeError);
		expect(stringifyDeepJson(chain) === expected).toBe(true);
	}, 60_000);

	it("throws TypeError for a cycle below the depth JSON.stringify reaches", () => {
		const bottom: Record<string, unknown> = { id: "bottom" };
		let chain: Record<string, unknown> = bottom;
		for (let index = 0; index < 100_000; index++) chain = { child: chain };
		bottom.loop = chain;
		expect(thrown(() => stringifyDeepJson(chain))).toEqual([
			"TypeError",
			"JSON.stringify cannot serialize cyclic structures.",
		]);
	}, 60_000);
});
