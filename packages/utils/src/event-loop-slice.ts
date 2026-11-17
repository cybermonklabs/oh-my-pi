/**
 * Cooperative time slicing for CPU-bound work that runs on the main thread in
 * the background, such as model discovery. One long synchronous run holds the
 * event loop: timers, socket reads and writes, and TUI frames all wait for it,
 * and a chain of `await`s whose promises are already settled is still one run.
 *
 * A sliced pass checks {@link sliceExpired} immediately before each unit of
 * work and, while it is true, awaits {@link nextSlice}. The units of one slice
 * then hold the loop for at most {@link EVENT_LOOP_SLICE_MS} plus one unit.
 * The check and its unit must run in the same synchronous step: every waiter
 * of a slice resumes in the same macrotask, and each one must see the budget
 * the waiters before it used, or each takes a full budget of its own.
 * {@link mapInSlices} and {@link runInSlices} keep that rule for their callers.
 *
 * Under fake timers `performance.now()` stands still, so a slice never expires
 * and a sliced pass runs to completion in one step, as an unsliced one did.
 */

/** Wall-clock budget of one slice: well inside a 16 ms frame, and far inside any network handshake. */
export const EVENT_LOOP_SLICE_MS = 10;

let sliceStart = 0;
/** True from a slice's first check until the event loop next runs a macrotask. */
let sliceOpen = false;
let pendingSlice: Promise<void> | undefined;

function closeSlice(): void {
	sliceOpen = false;
}

/**
 * Whether the current slice has used its budget, so the caller must await
 * {@link nextSlice} before its next unit. The first check after the event loop
 * ran a macrotask opens a new slice that counts from that check, so a pass
 * always runs at least one unit per turn, however long other work in that turn
 * took. Work in the same turn before the first check, such as parsing a
 * fetched payload, is the caller's to end with {@link nextSlice}.
 */
export function sliceExpired(): boolean {
	const now = performance.now();
	if (!sliceOpen) {
		sliceOpen = true;
		sliceStart = now;
		// setImmediate, not setTimeout: fake timers replace setTimeout, and a
		// pass that waited on it would hang until a test advanced the clock.
		setImmediate(closeSlice);
	} else if (now < sliceStart) {
		// A clock behind the slice's start is a mocked clock put back: start over.
		sliceStart = now;
	}
	return now - sliceStart >= EVENT_LOOP_SLICE_MS;
}

/**
 * Resolves in a later macrotask, after the timers and socket events that are
 * due by then. Every waiter shares the one macrotask, and the first check
 * after it opens the next slice.
 */
export function nextSlice(): Promise<void> {
	if (!pendingSlice) {
		const { promise, resolve } = Promise.withResolvers<void>();
		pendingSlice = promise;
		setImmediate(() => {
			pendingSlice = undefined;
			resolve();
		});
	}
	return pendingSlice;
}

/** `items.map(fn)` that returns to the event loop between items once a slice has used its budget. */
export async function mapInSlices<T, U>(items: readonly T[], fn: (item: T, index: number) => U): Promise<U[]> {
	const out = new Array<U>(items.length);
	for (let index = 0; index < items.length; index++) {
		while (sliceExpired()) await nextSlice();
		out[index] = fn(items[index], index);
	}
	return out;
}

/**
 * Runs `steps` to its return value. Each `yield` in it ends one unit: there
 * the pass returns to the event loop when the slice has used its budget.
 */
export async function runInSlices<T>(steps: Iterator<unknown, T, undefined>): Promise<T> {
	for (;;) {
		while (sliceExpired()) await nextSlice();
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/** Runs `steps` to its return value in one synchronous step, for callers that cannot await. */
export function runToCompletion<T>(steps: Iterator<unknown, T, undefined>): T {
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}
