/**
 * A walk written as recursion that runs on an explicit stack. Each step of the
 * walk is a generator: where a recursive walk calls itself on a child, the step
 * yields the child's step, and {@link runNested} runs it and resumes the step
 * with its result. The call stack then stays one step deep however deep the
 * value is: a session entry parsed from a transcript line nests as deep as
 * `JSON.parse` reads (400,000 levels), about ten times what a recursive walk's
 * stack allows, and less on a worker thread.
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
