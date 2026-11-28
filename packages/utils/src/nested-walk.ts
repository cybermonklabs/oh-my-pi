/**
 * A walk written as recursion that runs on an explicit stack. Each step of the
 * walk is a generator: where a recursive walk calls itself on a child, the step
 * yields the child's step, and {@link runNested} runs it and resumes the step
 * with its result. The call stack then stays one step deep however deep the
 * value is: a value parsed from JSON (a session entry read from a transcript
 * line, say) nests as deep as `JSON.parse` reads (400,000 levels), about ten
 * times what a recursive walk's stack allows, and less on a worker thread.
 */

/** One step of a walk: it yields each nested step it needs and receives that step's result back. */
export type NestedWalk<T = unknown> = Generator<NestedWalk, T, unknown>;

/**
 * Run `root` to its result, each step it yields (and each those yield) on an
 * explicit stack, in the order recursion would run them. A step that throws
 * throws into the step that yielded it, as a call would.
 */
export function runNested<T>(root: NestedWalk<T>): T {
	const stack: NestedWalk[] = [root];
	let input: unknown;
	let failure: { readonly error: unknown } | undefined;
	for (;;) {
		const step = stack[stack.length - 1]!;
		let next: IteratorResult<NestedWalk, unknown>;
		try {
			next = failure === undefined ? step.next(input) : step.throw(failure.error);
		} catch (error) {
			stack.pop();
			if (stack.length === 0) throw error;
			failure = { error };
			continue;
		}
		failure = undefined;
		if (next.done) {
			stack.pop();
			if (stack.length === 0) return next.value as T;
			input = next.value;
		} else {
			stack.push(next.value);
			input = undefined;
		}
	}
}

/**
 * Levels a walk goes down before {@link ContainerPath} tracks the containers
 * it is inside: deeper than an entry a session writes holds, so a common
 * walk pays nothing, and shallow enough that a cycle is caught after a few
 * hundred kilobytes of steps.
 */
const CYCLE_CHECK_DEPTH = 1_000;

/**
 * The containers (objects and arrays) a walk on an explicit stack is inside.
 * A container met again inside itself is a cycle, which recursion walked
 * until its stack ran out and which JSON cannot write: {@link enter} throws
 * for it, as `JSON.stringify` does, where the walk would go on until memory
 * ran out. A cycle has no end, so it passes {@link CYCLE_CHECK_DEPTH}, and
 * the containers are tracked only past it.
 */
export class ContainerPath {
	#depth = 0;
	#open: Set<object> | undefined;

	/** Go down into `container`; throws when the walk is already inside it. */
	enter(container: object): void {
		if (++this.#depth <= CYCLE_CHECK_DEPTH) return;
		this.#open ??= new Set();
		if (this.#open.has(container)) throw new TypeError("JSON.stringify cannot serialize cyclic structures.");
		this.#open.add(container);
	}

	/** Come back up out of `container`, the one the latest {@link enter} not yet left went into. */
	leave(container: object): void {
		if (this.#depth-- > CYCLE_CHECK_DEPTH) this.#open?.delete(container);
	}
}

/**
 * Pairs a comparison holds on its path before {@link ContainerPairPath} looks
 * them up in maps: a common value nests a few levels, where scanning the path
 * costs less than hashing each pair into a map and out again.
 */
const PAIR_SCAN_LENGTH = 64;

/**
 * The pairs of containers a comparison on an explicit stack is inside. A pair
 * met again inside itself is a cycle, which the comparison would walk until
 * memory ran out; {@link enter} answers it as `Bun.deepEquals` does instead:
 * the pair is equal when its left container is already on the path with its
 * right one, and unequal when either container is there with another, so two
 * cycles of different shapes differ. A container is on the path at most once,
 * so a pair is found by its containers: by a scan while the path holds at
 * most {@link PAIR_SCAN_LENGTH} pairs, and in maps once it held more.
 */
export class ContainerPairPath {
	readonly #lefts: object[] = [];
	readonly #rights: object[] = [];
	/** Once the path held more than {@link PAIR_SCAN_LENGTH} pairs: each pair's right container by its left one. */
	#rightOf: Map<object, object> | undefined;
	/** With {@link #rightOf}: the right containers on the path. */
	#openRights: Set<object> | undefined;

	/**
	 * Go down into the pair `left`, `right`: `undefined` when neither container
	 * is on the path (the walk compares the pair, then calls {@link leave}),
	 * else whether the pair met again is equal, which the walk answers without
	 * going down.
	 */
	enter(left: object, right: object): boolean | undefined {
		const rightOf = this.#rightOf;
		if (rightOf !== undefined) {
			const paired = rightOf.get(left);
			if (paired !== undefined) return paired === right;
			if (this.#openRights!.has(right)) return false;
			rightOf.set(left, right);
			this.#openRights!.add(right);
			return undefined;
		}
		const lefts = this.#lefts;
		const rights = this.#rights;
		for (let index = 0; index < lefts.length; index++) {
			if (lefts[index] === left) return rights[index] === right;
			if (rights[index] === right) return false;
		}
		lefts.push(left);
		rights.push(right);
		if (lefts.length > PAIR_SCAN_LENGTH) {
			this.#rightOf = new Map(lefts.map((open, index) => [open, rights[index]!]));
			this.#openRights = new Set(rights);
			lefts.length = 0;
			rights.length = 0;
		}
		return undefined;
	}

	/** Come back up out of the pair `left`, `right`, the one the latest {@link enter} that went down went into. */
	leave(left: object, right: object): void {
		if (this.#rightOf !== undefined) {
			this.#rightOf.delete(left);
			this.#openRights!.delete(right);
			return;
		}
		this.#lefts.pop();
		this.#rights.pop();
	}
}

/**
 * Node's and Bun's `util.types.isProxy`, read through `process.getBuiltinModule`
 * rather than imported, so this module still imports nothing; a browser has
 * neither, and nothing there tells a proxy from its target.
 */
const isProxy: ((value: object) => boolean) | undefined =
	globalThis.process?.getBuiltinModule?.("node:util")?.types.isProxy;

/**
 * Whether `value` nests objects or arrays past `levels` levels, read by a walk
 * that keeps its own stack and stops at the first node past them, so a cycle
 * answers true. It calls no getter or `toJSON` of the value, so the writer
 * that walks the value next calls each once, as `JSON.stringify` alone would:
 * it reads an object's own enumerable data properties and an array by index,
 * not through its iterator, takes an accessor as holding nothing, and does not
 * go into an object whose `toJSON` is a function (`JSON.stringify` writes what
 * that returns instead) or an accessor. A `toJSON` field that holds data, as
 * `JSON.parse` makes of one, is a key like any other. Nor does it go into a
 * proxy, whose traps are the value's own code too: finding a `toJSON` asks a
 * proxy for its prototype, and a trap that throws would stop the check before
 * the writer runs, where `JSON.stringify` calls none but `get`, `ownKeys` and
 * `getOwnPropertyDescriptor`; a browser cannot tell a proxy from its target,
 * so there it is walked. A value nested past `levels` only below a getter, a
 * `toJSON` or a proxy answers false; a writer that relies on the answer still
 * falls back on the engine's stack overflow ({@link isStackOverflow}) for it.
 * It imports nothing, so a browser bundle can use it too.
 */
export function nestsDeeperThan(value: unknown, levels: number): boolean {
	const nodes: unknown[] = [value];
	const depths: number[] = [0];
	while (nodes.length > 0) {
		const node = nodes.pop();
		const depth = depths.pop()!;
		if (typeof node !== "object" || node === null || isProxy?.(node) || writesThroughToJSON(node)) continue;
		if (depth >= levels) return true;
		if (Array.isArray(node)) {
			const length = node.length;
			for (let index = 0; index < length; index++) {
				nodes.push(ownDataValue(node, index));
				depths.push(depth + 1);
			}
			continue;
		}
		for (const key of Object.keys(node)) {
			nodes.push(ownDataValue(node, key));
			depths.push(depth + 1);
		}
	}
	return false;
}

/** The value of `holder`'s own data property `key`, or `undefined` for an accessor (not called) or a missing key. */
function ownDataValue(holder: object, key: string | number): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(holder, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Whether `JSON.stringify` may write what `node`'s `toJSON` returns in its
 * place: the first `toJSON` on `node` or its prototypes, as `JSON.stringify`
 * finds it, is a function, or an accessor whose getter is not called to find
 * out. A `toJSON` that holds other data is not called, so `node` is written
 * by its keys.
 */
function writesThroughToJSON(node: object): boolean {
	for (let holder: object | null = node; holder !== null; holder = Object.getPrototypeOf(holder)) {
		const descriptor = Object.getOwnPropertyDescriptor(holder, "toJSON");
		if (descriptor !== undefined) return !("value" in descriptor) || typeof descriptor.value === "function";
	}
	return false;
}

/**
 * Whether `error` is the `RangeError` the engine throws when a recursion
 * (`JSON.stringify`'s, `structuredClone`'s) runs out of stack: its message is
 * `Maximum call stack size exceeded` (JavaScriptCore ends it with a period).
 * A `RangeError` that the value's own code throws (a `toJSON`, a getter) is
 * not one, so a walk that falls back on this error does not run that code
 * again. Code of the value's own that runs out of stack itself (a getter that
 * recurses without end) throws the same error and cannot be told from it: a
 * walk that falls back runs that code again.
 */
export function isStackOverflow(error: unknown): error is RangeError {
	return error instanceof RangeError && error.message.startsWith("Maximum call stack size exceeded");
}
