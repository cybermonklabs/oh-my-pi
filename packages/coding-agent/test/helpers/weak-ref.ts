/**
 * A deadline for {@link collected} that outlasts transient retention. After earlier files warm the
 * session code, JSC's optimizing-JIT worklist can keep an object referenced by an in-flight compile
 * reachable for a few seconds (observed ~4 s locally, >8 s on loaded CI runners); collection is
 * polled past that window. A healthy release returns on the first poll that sees it collected, so
 * the deadline only bounds how long a real leak takes to fail.
 */
export const COLLECT_DEADLINE_MS = 15_000;

/** Whether `ref`'s target is collected within `deadlineMs`, polling with full collections. */
export async function collected(ref: WeakRef<object>, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		// A WeakRef target stays alive until the current task ends; yield a task before each collection.
		const nextTask = Promise.withResolvers<void>();
		setImmediate(nextTask.resolve);
		await nextTask.promise;
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(100);
	}
}
