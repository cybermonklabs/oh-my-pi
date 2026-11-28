import { describe, expect, test } from "bun:test";
import { cloneJsonTree, isStackOverflow, structuredCloneDeep, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { DEEP_LEVELS, nestedChain, nestingOf } from "../../ai/test/helpers/deep-nesting";

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

	// `structuredClone` throws for a function, where a JSON copy leaves it out without a word.
	test("throws DataCloneError for a function in a shallow value", () => {
		let error: unknown;
		try {
			structuredCloneDeep({ run: () => 1 });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("DataCloneError");
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
		const source = nestedChain(bottom);

		const copy = structuredCloneDeep(source);
		bottom.leaf = "changed";

		expect(nestingOf(copy)).toEqual({ levels: DEEP_LEVELS, bottom: { leaf: "bottom" } });
	});

	// Past `structuredClone`'s stack the whole value is copied again: a Map in a tool result's details beside one
	// deep tool call must come back a Map, not the `{}` a JSON copy makes of it.
	test("keeps each value structuredClone keeps beside a branch nested 50,000 levels", () => {
		const shared = { name: "shared" };
		const deep = nestedChain();
		const source = {
			deep,
			map: new Map([["x", 1]]),
			set: new Set(["y"]),
			date: new Date(1_000),
			regexp: /a+/gi,
			bytes: new Uint8Array([1, 2]),
			buffer: new Uint8Array([3, 4]).buffer,
			first: shared,
			second: shared,
		};
		expect(() => structuredClone(source)).toThrow(RangeError);

		const copy = structuredCloneDeep(source);

		expect(copy.map).toBeInstanceOf(Map);
		expect([...copy.map]).toEqual([["x", 1]]);
		expect(copy.set).toBeInstanceOf(Set);
		expect([...copy.set]).toEqual(["y"]);
		expect(copy.date).toBeInstanceOf(Date);
		expect(copy.date.getTime()).toBe(1_000);
		expect(copy.regexp).toBeInstanceOf(RegExp);
		expect(copy.regexp.source).toBe("a+");
		expect(copy.regexp.flags).toBe("gi");
		expect(copy.bytes).toBeInstanceOf(Uint8Array);
		expect([...copy.bytes]).toEqual([1, 2]);
		expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(copy.buffer)]).toEqual([3, 4]);
		expect(copy.first).toBe(copy.second);
		expect(copy.first).not.toBe(shared);
		expect(copy.first).toEqual(shared);
	});

	// `structuredClone` keeps a cycle and throws for a function; the copy past its stack must do the same, not throw
	// a TypeError for the cycle and hand the function back.
	test("keeps a cycle and throws DataCloneError for a function beside a branch nested 50,000 levels", () => {
		const deep = nestedChain();
		const cyclic: Record<string, unknown> = { deep };
		cyclic.self = cyclic;

		const copy = structuredCloneDeep(cyclic);

		expect(copy).not.toBe(cyclic);
		expect(copy.self).toBe(copy);
		let error: unknown;
		try {
			structuredCloneDeep({ deep, run: () => 1 });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("DataCloneError");
	});

	// Only the engine's stack overflow is copied again: a RangeError a getter throws is the copy's error, as
	// `structuredClone` throws it, and the getter does not run a second time.
	test("throws the RangeError a getter throws without reading the getter again", () => {
		let reads = 0;
		const source = {
			get value() {
				reads++;
				if (reads === 1) throw new RangeError("first read");
				return 7;
			},
		};

		expect(() => structuredCloneDeep(source)).toThrow("first read");
		expect(reads).toBe(1);
	});

	// Past `structuredClone`'s stack the value is read again in the order `structuredClone` reads it, each container
	// whole before the key after it: a getter that changes a value read before it must leave the copy as the shallow
	// copy leaves it, not reach a container the copy has not filled yet.
	test("reads a value beside a branch nested 50,000 levels in the order structuredClone reads it", () => {
		const copiedBranch = (withDeep: boolean): unknown => {
			const deep = nestedChain();
			const branch = { value: "before" };
			const source = {
				...(withDeep ? { deep } : {}),
				branch,
				get later() {
					branch.value = "after";
					return 1;
				},
			};
			return structuredCloneDeep(source).branch.value;
		};

		expect(copiedBranch(false)).toBe("before");
		expect(copiedBranch(true)).toBe("before");
	});
});

describe("isStackOverflow", () => {
	// A copy or a writer falls back on the engine's stack overflow only; a RangeError the value's own code throws (a
	// getter, a `toJSON`) must surface as it is, where a fallback would run that code again.
	test("answers true for the engine's stack overflow and false for a RangeError code threw", () => {
		const deep = nestedChain();
		const overflows: unknown[] = [];
		for (const recurse of [() => structuredClone(deep), () => JSON.stringify(deep)]) {
			try {
				recurse();
			} catch (caught) {
				overflows.push(caught);
			}
		}

		expect(overflows).toHaveLength(2);
		expect(overflows.map(error => isStackOverflow(error))).toEqual([true, true]);
		expect(isStackOverflow(new RangeError("first read"))).toBe(false);
		expect(isStackOverflow(new Error("Maximum call stack size exceeded."))).toBe(false);
	});
});

describe("structuredCloneJSON", () => {
	// A tool call's arguments are copied before a repair writes to them: arguments nested past `structuredClone`'s
	// stack must still be copied as it copies them, a Map beside them included, not fail the call.
	test("copies a value nested 50,000 levels as structuredClone does, keeping a Map beside it", () => {
		const deep = nestedChain();

		const copy = structuredCloneJSON({ deep, map: new Map([["x", 1]]) });

		expect({ deep: nestingOf(copy.deep), map: copy.map }).toEqual({
			deep: { levels: DEEP_LEVELS, bottom: { leaf: "bottom" } },
			map: new Map([["x", 1]]),
		});
		expect(copy.map).toBeInstanceOf(Map);
	});

	// An in-process caller's arguments can hold a function, which `structuredClone` refuses: the copy leaves it out,
	// as the JSON copy always has, also when the arguments nest past `JSON.stringify`'s stack.
	test("copies a value nested 50,000 levels that holds a function, leaving the function out as the JSON copy does", () => {
		const deep = nestedChain();

		const copy = structuredCloneJSON({ deep, run: () => 1 });

		expect({ deep: nestingOf(copy.deep), keys: Object.keys(copy) }).toEqual({
			deep: { levels: DEEP_LEVELS, bottom: { leaf: "bottom" } },
			keys: ["deep"],
		});
	}, 30_000);
});
