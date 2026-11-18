import { heapStats } from "bun:jsc";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { armPreResponseTimeout, preResponseGuard } from "@oh-my-pi/pi-ai/utils/idle-iterator";

/**
 * Regression for the issue #2422 follow-up: the streaming providers (Codex SSE,
 * Bedrock, Gemini CLI, Ollama) used to hand `AbortSignal.timeout(firstEventMs)`
 * to `fetch` as a "pre-response" guard. That signal is an *absolute* wall-clock
 * deadline and stays bound to the request after headers arrive, so it aborted an
 * actively-streaming body (e.g. a large `write` tool call) with
 * `TimeoutError: The operation timed out.` even while deltas were flowing — a
 * `fetch` signal governs the whole request lifecycle, including the body stream.
 *
 * `armPreResponseTimeout` arms a *clearable* timer that callers disarm the
 * instant `fetchWithRetry` resolves (headers in), leaving the body to the
 * iterator-level idle watchdog. The deadline is a plain `setTimeout`, so these
 * tests drive it with fake timers — the contract is "signal aborts at the
 * deadline unless cleared", which needs no real time or network.
 */
describe("armPreResponseTimeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("passes the caller signal through unchanged when no positive timeout is configured", () => {
		const caller = new AbortController().signal;
		expect(armPreResponseTimeout(caller, undefined).signal).toBe(caller);
		expect(armPreResponseTimeout(caller, 0).signal).toBe(caller);
		expect(armPreResponseTimeout(caller, -5).signal).toBe(caller);
		expect(armPreResponseTimeout(undefined, undefined).signal).toBeUndefined();
	});

	it("aborts at the deadline with a TimeoutError when never cleared", () => {
		vi.useFakeTimers();
		const { signal } = armPreResponseTimeout(undefined, 50);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(49);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		const reason = signal?.reason as DOMException;
		expect(reason.name).toBe("TimeoutError");
		expect(reason.message).toBe("The operation timed out.");
	});

	it("never aborts once cleared, even long past the deadline", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 50);
		clear(); // headers arrived — disarm before the body streams
		vi.advanceTimersByTime(10_000);
		expect(signal?.aborted).toBe(false);
	});

	it("combines the caller signal so a caller abort still cancels after clearing", () => {
		const caller = new AbortController();
		const { signal, clear } = armPreResponseTimeout(caller.signal, 60_000);
		clear();
		expect(signal).toBeDefined();
		expect(signal!.aborted).toBe(false);
		caller.abort(new Error("caller cancelled"));
		expect(signal!.aborted).toBe(true);
		expect((signal!.reason as Error).message).toBe("caller cancelled");
	});
});

/**
 * The budget is a stopwatch the transport stops while it prepares a request and
 * while it is parked on a caller's dispatch hold (`/pause`), and starts again at
 * the wire with what is left. Two properties follow, and both are load-bearing:
 * a hold a human releases must not consume the provider's first-byte budget,
 * and a caller that reuses one guard across its own retries (Gemini CLI hands
 * `watchdog.signal` to `fetchWithRetry`) must not get a fresh budget per
 * attempt — that is how a 90 ms first-event budget became 194 ms of waiting.
 */
describe("pre-response budget", () => {
	afterEach(() => {
		vi.useRealTimers();
		// The Date.now spy below would otherwise outlive this file and freeze the
		// clock (and `setSystemTime`) for every test file run after it.
		vi.restoreAllMocks();
	});

	it("does not spend the budget while the transport is suspended", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 60);
		const budget = preResponseGuard(signal);
		expect(budget).toBeDefined();
		budget?.suspend();
		vi.advanceTimersByTime(10_000);
		expect(signal?.aborted).toBe(false);
		budget?.resume();
		vi.advanceTimersByTime(59);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		clear();
	});

	it("spends one budget across every attempt the guard covers", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 120);
		const budget = preResponseGuard(signal);
		// Attempt one: 80 ms of wire time, then a retry backoff off the clock.
		budget?.suspend();
		budget?.resume();
		vi.advanceTimersByTime(80);
		budget?.suspend();
		vi.advanceTimersByTime(5_000);
		expect(signal?.aborted).toBe(false);
		// Attempt two gets the 40 ms that are left, not another 120 ms.
		budget?.resume();
		vi.advanceTimersByTime(39);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		clear();
	});

	it("expires at the wire when the budget is already spent", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 20);
		const budget = preResponseGuard(signal);
		// Wall time the armed timer did not get to observe (a blocked loop, a
		// suspended machine): the stopwatch still charges it to the budget.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 50);
		budget?.suspend();
		budget?.resume();
		expect(signal?.aborted).toBe(true);
		expect((signal?.reason as DOMException | undefined)?.name).toBe("TimeoutError");
		clear();
	});

	it("stays disarmed after clear, whatever the transport does next", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 30);
		const budget = preResponseGuard(signal);
		clear();
		budget?.suspend();
		budget?.resume();
		vi.advanceTimersByTime(10_000);
		expect(signal?.aborted).toBe(false);
	});
});

/**
 * The guard hands the transport an `AbortSignal.any` composite over the
 * caller's signal, and a composite with an abort listener is kept alive by its
 * sources for as long as they can still abort it. A caller signal that lives
 * for a whole session therefore accumulates one guard signal per model call —
 * and behind its listeners' closures that call's request body, response queue
 * and stream — unless the listeners come off. Measured on omp at a 382 KiB
 * prompt, that was 8.5 `AbortSignal`s and 447 KiB of live heap retained per
 * model call, 500 calls into a session (INFRA-1876).
 *
 * The contract is a count, not a call: after N cleared guards the number of
 * signals still live does not grow with N. A test that asserted `clear()`
 * called `removeEventListener` would pass against a fix that removed the wrong
 * listener; this one cannot.
 */
describe("guard retention on a session-lifetime caller signal", () => {
	const ARMS = 400;
	const heldWork = () => ({ trackLocalWork: <T>(work: Promise<T>): Promise<T> => work });

	/** Live `AbortSignal`s after a forced full collection. */
	const liveSignals = (): number => {
		Bun.gc(true);
		return heapStats().objectTypeCounts.AbortSignal ?? 0;
	};

	/** Signals retained per armed guard, over `ARMS` guards on one caller signal. */
	const retainedPerArm = (arm: (caller: AbortSignal) => void): number => {
		const session = new AbortController();
		const before = liveSignals();
		for (let i = 0; i < ARMS; i++) arm(session.signal);
		const after = liveSignals();
		// Keep the caller signal alive to the end: that is the whole mechanism.
		expect(session.signal.aborted).toBe(false);
		return (after - before) / ARMS;
	};

	it("retains one signal per guard while the guard is never cleared", () => {
		// The control. Without it, a fix that made the instrument blind would
		// pass every assertion below.
		const perArm = retainedPerArm(caller => {
			const guard = armPreResponseTimeout(caller, 60_000, heldWork());
			guard.onAbort(() => {});
		});
		expect(perArm).toBeGreaterThan(0.9);
	});

	it("retains nothing once each guard is cleared", () => {
		const perArm = retainedPerArm(caller => {
			const guard = armPreResponseTimeout(caller, 60_000, heldWork());
			guard.onAbort(() => {});
			guard.clear();
		});
		expect(perArm).toBeLessThan(0.05);
	});

	it("retains nothing when a cleared guard encloses another", () => {
		// The Anthropic shape: the provider arms one guard over the request
		// signal and the SDK transport arms a second over the first's signal.
		const perArm = retainedPerArm(caller => {
			const outer = armPreResponseTimeout(caller, 60_000, heldWork());
			const inner = armPreResponseTimeout(outer.signal, 30_000);
			inner.clear();
			outer.clear();
		});
		expect(perArm).toBeLessThan(0.05);
	});
});

/**
 * `onAbort` exists so a provider never leaves a listener of its own on the
 * composite. It must behave exactly like the `{ once: true }` listener each
 * provider used to register, and stop existing at `clear()`.
 */
describe("pre-response guard onAbort", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs once when the budget expires before the guard is cleared", () => {
		vi.useFakeTimers();
		const { onAbort } = armPreResponseTimeout(new AbortController().signal, 50);
		let fired = 0;
		onAbort(() => fired++);
		vi.advanceTimersByTime(50);
		expect(fired).toBe(1);
	});

	it("does not run for a caller abort after the guard is cleared", () => {
		const caller = new AbortController();
		const { signal, clear, onAbort } = armPreResponseTimeout(caller.signal, 60_000);
		let fired = 0;
		onAbort(() => fired++);
		clear();
		caller.abort(new Error("caller cancelled"));
		// The request itself is still cancelled — only the guard's bookkeeping is gone.
		expect(signal?.aborted).toBe(true);
		expect(fired).toBe(0);
	});

	it("does not run after clear when no budget is armed and the signal is the caller's own", () => {
		const caller = new AbortController();
		const { signal, clear, onAbort } = armPreResponseTimeout(caller.signal, undefined);
		expect(signal).toBe(caller.signal);
		let fired = 0;
		onAbort(() => fired++);
		clear();
		caller.abort();
		expect(fired).toBe(0);
	});
});
