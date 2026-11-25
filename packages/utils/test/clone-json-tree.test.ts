import { describe, expect, test } from "bun:test";
import { cloneJsonTree } from "@oh-my-pi/pi-utils";

/** Levels past what a recursive copy reaches (about 12,000 for arrays); a transcript line holds 400,000. */
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
