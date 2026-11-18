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
 * A slice lasts until the event loop next runs its timers, so one pass through
 * the loop holds at most one slice. Other work in the same pass, such as socket
 * callbacks or unsliced code, cannot be followed by a second slice before the
 * timers that fell due run.
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
/** The real clock when the slice opened: `performance.now()` can be mocked, `process.hrtime` is not. */
let sliceOpenedAt = 0n;
const SLICE_NS = BigInt(EVENT_LOOP_SLICE_MS * 1_000_000);
let sliceOpen = false;
/** The number of the slice open now, or of the last one; each close names the slice it ends. */
let openSlice = 0;
/** Resolvers of the passes waiting for the next turn, in the order they asked. */
let waiters: Array<() => void> = [];
/** The batch of waiters a scheduled release is for; 0 once released. */
let pendingBatch = 0;
let lastBatch = 0;
/** Whether the waiting batch's check-phase leg scheduled a close of its own yet. */
let closeRearmed = false;

function closeSlice(slice: number): void {
	// A close can run after a release opened the next slice in the same timers phase: it ends only its own.
	if (slice === openSlice) sliceOpen = false;
}

/**
 * Whether the current slice has used its budget, so the caller must await
 * {@link nextSlice} before its next unit. The first check after the event loop
 * ran its timers opens a new slice that counts from that check, so the first
 * pass to check in a turn runs at least one unit, however long other work in
 * that turn took.
 */
export function sliceExpired(): boolean {
	const now = performance.now();
	if (!sliceOpen) {
		sliceOpen = true;
		openSlice++;
		sliceStart = now;
		sliceOpenedAt = process.hrtime.bigint();
		// Closed by a timer, so work later in this pass through the event loop
		// finds the slice still open. Fake timers replace setTimeout, so the close
		// may never run: a release (below) opens the next turn anyway.
		setTimeout(closeSlice, 0, openSlice);
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
 * timers replace it; `setImmediate` still runs under fake timers. While a slice
 * that held the loop for its budget is still open, the `setImmediate` leg waits
 * for the timers to close it, however many passes through the check phase that
 * takes: in a gVisor pod, check phases ran several times before the timers did,
 * and a leg that gave up waiting opened a second slice in one pass through the
 * event loop. A slice that a mocked clock ended before the real one moved its
 * budget releases at once, without the clamp; so does any slice under fake
 * timers, which stop every clock and never run the close.
 */
export function nextSlice(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (waiters.length === 0) {
		const batch = ++lastBatch;
		pendingBatch = batch;
		closeRearmed = false;
		setImmediate(releaseWaiters, batch, true);
		setTimeout(releaseWaiters, 0, batch);
	}
	waiters.push(resolve);
	return promise;
}

function releaseWaiters(batch: number, inCheckPhase = false): void {
	// The other leg of a released batch, or of one a later batch replaced.
	if (batch !== pendingBatch) return;
	if (inCheckPhase && sliceOpen && process.hrtime.bigint() - sliceOpenedAt >= SLICE_NS) {
		// The close this slice scheduled can be gone: fake timers drop the timers set under them
		// when they are removed. Another close, at the next timers phase, ends the wait either way.
		if (!closeRearmed) {
			closeRearmed = true;
			setTimeout(closeSlice, 0, openSlice);
		}
		setImmediate(releaseWaiters, batch, true);
		return;
	}
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
	const out: U[] = [];
	for (let index = 0; index < items.length; index++) {
		while (sliceExpired()) await nextSlice();
		out.push(fn(items[index], index));
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

/**
 * Decodes and parses a JSON payload's bytes as two units, each after a slice
 * check. A fetched catalog's decode and parse then take a slice of their own,
 * instead of running unchecked in the socket callback that delivered them, back
 * to back with another response's.
 */
export async function parseJsonBytesInSlices(bytes: ArrayBuffer | Uint8Array): Promise<unknown> {
	while (sliceExpired()) await nextSlice();
	const text = new TextDecoder().decode(bytes);
	while (sliceExpired()) await nextSlice();
	return JSON.parse(text);
}

/** `response.json()` for sliced work: the body's bytes, then {@link parseJsonBytesInSlices}. */
export async function readJsonInSlices(response: Response): Promise<unknown> {
	return parseJsonBytesInSlices(await response.arrayBuffer());
}
