import { describe, expect, test } from "bun:test";
import { cloneJsonTree, structuredCloneDeep } from "@oh-my-pi/pi-utils";

/** Levels past what a recursive copy reaches (about 12,000 for arrays); a transcript line holds millions. */
const DEEP_LEVELS = 50_000;

describe("cloneJsonTree", () => {
	// A tool returns any JSON, and a session entry copies what it returned (an entry patch, a session copy).
	test("copies a tree nested 50,000 levels, and the copy shares no container with the source", () => {
		const bottom = { leaf: "bottom" };
		let source: unknown = bottom;
		for (let level = 0; level < DEEP_LEVELS; level++) source = level % 2 === 0 ? [source] : { next: source };

		const copy = cloneJsonTree(source);
		bottom.leaf = "changed";

		let node = copy;
		let levels = 0;
		for (;;) {
			if (Array.isArray(node)) node = node[0];
			else if (typeof node === "object" && node !== null && "next" in node) node = node.next;
			else break;
			levels++;
		}
		expect(levels).toBe(DEEP_LEVELS);
		expect(node).toEqual({ leaf: "bottom" });
	});

	test("keeps an array's holes, an own `__proto__` key and the key order of each object", () => {
		const record: Record<string, unknown> = JSON.parse('{"b":1,"__proto__":{"x":1},"a":[1,null,3]}');
		const holes: unknown[] = [1];
		holes[2] = 3;
		const copy = cloneJsonTree({ record, holes });

		expect(Object.keys(copy.record)).toEqual(["b", "__proto__", "a"]);
		expect(Object.getPrototypeOf(copy.record)).toBe(Object.prototype);
		expect(Object.hasOwn(copy.record, "__proto__")).toBe(true);
		expect(1 in copy.holes).toBe(false);
		expect(copy.holes).toHaveLength(3);
	});

	// The copy keeps its own stack, so a cycle must end it as the end of the call stack ended the recursion.
	test("throws a TypeError for a cycle instead of copying until memory runs out", () => {
		const bottom: Record<string, unknown> = { leaf: "bottom" };
		let chain: Record<string, unknown> = bottom;
		for (let level = 0; level < 2_000; level++) chain = { next: chain };
		bottom.loop = chain;
		expect(() => cloneJsonTree(chain)).toThrow(TypeError);
	});
});

describe("structuredCloneDeep", () => {
	// A tool's details are any value it returned: a shallow one must come back as `structuredClone` copies it,
	// not as the `{}` and the string a JSON copy turns a Map and a Date into.
	test("keeps a Map, a Date and a Uint8Array in a shallow value, in a copy independent of the source", () => {
		const source = {
			details: { files: new Map([["a.ts", 12]]), at: new Date(1_000), bytes: new Uint8Array([1, 2]) },
		};

		const copy = structuredCloneDeep(source);
		source.details.files.set("a.ts", 0);
		source.details.at.setTime(0);
		source.details.bytes[0] = 9;

		expect(copy.details.files).toBeInstanceOf(Map);
		expect([...copy.details.files]).toEqual([["a.ts", 12]]);
		expect(copy.details.at).toBeInstanceOf(Date);
		expect(copy.details.at.getTime()).toBe(1_000);
		expect(copy.details.bytes).toBeInstanceOf(Uint8Array);
		expect([...copy.details.bytes]).toEqual([1, 2]);
	});

	// A value `structuredClone` copies is copied by it: a cycle, where a JSON copy throws, stays a cycle.
	test("keeps a cycle in a shallow value", () => {
		const source: Record<string, unknown> = { name: "root" };
		source.self = source;

		const copy = structuredCloneDeep(source);

		expect(copy).not.toBe(source);
		expect(copy.self).toBe(copy);
	});

	// A tool call's arguments are any JSON; `structuredClone` runs out of stack near 40,000 levels.
	test("copies a chain nested 50,000 levels, and the copy shares no container with the source", () => {
		const bottom = { leaf: "bottom" };
		let source: Record<string, unknown> = bottom;
		for (let level = 0; level < DEEP_LEVELS; level++) source = { next: source };

		const copy = structuredCloneDeep(source);
		bottom.leaf = "changed";

		let node: unknown = copy;
		let levels = 0;
		while (typeof node === "object" && node !== null && "next" in node) {
			node = node.next;
			levels++;
		}
		expect(levels).toBe(DEEP_LEVELS);
		expect(node).toEqual({ leaf: "bottom" });
	});
});
