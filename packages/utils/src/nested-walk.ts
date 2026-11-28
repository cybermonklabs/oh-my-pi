/**
 * A walk written as recursion that runs on an explicit stack. Each step of the
 * walk is a generator: where a recursive walk calls itself on a child, the step
 * yields the child's step, and {@link runNested} runs it and resumes the step
 * with its result. The call stack then stays one step deep however deep the
 * value is: a value parsed from JSON (a session entry read from a transcript
 * line, say) nests as deep as `JSON.parse` reads (it does not recurse: millions
 * of levels), over a hundred times what a recursive walk's stack allows, and
 * less on a worker thread.
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
 * Whether `value` nests objects or arrays past `levels` levels, read by a walk
 * that keeps its own stack and stops at the first node past them, so a cycle
 * answers true. It calls no getter or `toJSON` of the value, so the writer
 * that walks the value next calls each once, as `JSON.stringify` alone would:
 * it reads no accessor property, does not go into an object whose `toJSON`
 * (its own or inherited) is a function (`JSON.stringify` writes what that
 * returns instead), and reads an array by index, not through its iterator. A
 * `toJSON` key that holds anything else, which JSON can carry (`"toJSON":
 * null`), is a key like the rest, as `JSON.stringify` writes it, and a
 * `toJSON` getter is not called: its object is walked. A value nested past
 * `levels` only below a `toJSON` function or a getter answers false; a writer
 * that relies on the answer still falls back on the engine's stack overflow
 * ({@link isStackOverflow}) for it. It imports nothing, so a browser bundle
 * can use it too.
 */
export function nestsDeeperThan(value: unknown, levels: number): boolean {
	const nodes: unknown[] = [value];
	const depths: number[] = [0];
	while (nodes.length > 0) {
		const node = nodes.pop();
		const depth = depths.pop()!;
		if (typeof node !== "object" || node === null || ("toJSON" in node && hasToJSONFunction(node))) continue;
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
 * Whether `node`'s `toJSON`, its own or the nearest inherited one, is a function, which `JSON.stringify` calls.
 * It reads the property's descriptor, so a `toJSON` getter is not called (and answers false).
 */
function hasToJSONFunction(node: object): boolean {
	for (let holder: object | null = node; holder !== null; holder = Object.getPrototypeOf(holder)) {
		const descriptor = Object.getOwnPropertyDescriptor(holder, "toJSON");
		if (descriptor !== undefined) return typeof descriptor.value === "function";
	}
	return false;
}

/**
 * Whether `error` is the `RangeError` the engine throws when a recursion
 * (`JSON.stringify`'s, `structuredClone`'s) runs out of stack: its message is
 * `Maximum call stack size exceeded` (JavaScriptCore ends it with a period).
 * A `RangeError` that the value's own code threw (a `toJSON`, a getter) is not
 * one, so a walk that falls back on this error does not run that code again.
 */
export function isStackOverflow(error: unknown): error is RangeError {
	return error instanceof RangeError && error.message.startsWith("Maximum call stack size exceeded");
}
