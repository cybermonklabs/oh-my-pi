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
 * Concurrent passes share one budget per turn and take it in turn: the waiter
 * that used up the last slice resumes after the others in the next turn.
 *
 * Under fake timers `performance.now()` stands still, so a slice never expires
 * and a sliced pass runs to completion in one step, as an unsliced one did.
 */

/** Wall-clock budget of one slice: well inside a 16 ms frame, and far inside any network handshake. */
export const EVENT_LOOP_SLICE_MS = 10;

let sliceStart = 0;
/** True from a slice's first check until the event loop next runs a macrotask. */
let sliceOpen = false;
/** Resolvers of the passes waiting for the next turn, in the order they asked. */
let waiters: Array<() => void> = [];
/** The batch of waiters a scheduled release is for; 0 once released. */
let pendingBatch = 0;
let lastBatch = 0;

function closeSlice(): void {
	sliceOpen = false;
}

/**
 * Whether the current slice has used its budget, so the caller must await
 * {@link nextSlice} before its next unit. The first check after the event loop
 * ran a macrotask opens a new slice that counts from that check, so the first
 * pass to check in a turn runs at least one unit, however long other work in
 * that turn took.
 */
export function sliceExpired(): boolean {
	const now = performance.now();
	if (!sliceOpen) {
		sliceOpen = true;
		sliceStart = now;
		// setImmediate, not setTimeout: fake timers replace setTimeout, and a
		// slice that never closed would stay expired after they are removed.
		// A late close only costs the next check one extra turn.
		setImmediate(closeSlice);
	} else if (now < sliceStart) {
		// A clock behind the slice's start is a mocked clock put back: start over.
		sliceStart = now;
	}
	return now - sliceStart >= EVENT_LOOP_SLICE_MS;
}

/**
 * Resolves in a later macrotask, after the timers and socket events that are
 * due by then. All waiters resume in that one macrotask, and the first check
 * after it opens the next slice.
 *
 * The release is raced on `setImmediate` and `setTimeout(0)`; the first to run
 * releases the batch. `setImmediate` alone stalled in Bun 1.4: during
 * `createAgentSession`, a promise resolved from its callback did not resume
 * until a timer next woke the event loop, so each turn cost up to a timer
 * period. `setTimeout` alone costs its 1 ms clamp on every turn, and fake
 * timers replace it; `setImmediate` still runs under fake timers.
 */
export function nextSlice(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (waiters.length === 0) {
		const batch = ++lastBatch;
		pendingBatch = batch;
		setImmediate(releaseWaiters, batch);
		setTimeout(releaseWaiters, 0, batch);
	}
	waiters.push(resolve);
	return promise;
}

function releaseWaiters(batch: number): void {
	// The other leg of a released batch, or of one a later batch replaced.
	if (batch !== pendingBatch) return;
	pendingBatch = 0;
	// This macrotask is a new turn, whether or not the last slice's close ran yet.
	sliceOpen = false;
	const turn = waiters;
	waiters = [];
	// The first to ask is the pass that used up the last slice: a pass that
	// resumes into a spent slice asks only after it, and a pass that finished
	// inside the slice does not ask. Resuming it last gives the others the
	// next slice, so concurrent passes take the budget in turn.
	const spent = turn.shift();
	if (spent) turn.push(spent);
	for (const resolve of turn) resolve();
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
