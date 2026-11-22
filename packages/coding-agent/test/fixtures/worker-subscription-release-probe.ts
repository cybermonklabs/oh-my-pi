/**
 * Subscribes a listener through `trackWorkerSubscription` (`set`) or `PeerCleanups` (`peer-cleanups`),
 * unsubscribes it, collects from fresh event-loop turns, and prints whether the listener was collected.
 * With `held`, the probe keeps the listener itself: the control, which must not be collected.
 *
 * Run it in a process of its own with `BUN_JSC_useConcurrentJIT=0`: in a process that has warmed the
 * subscription code, an optimizing-JIT plan on a background thread can keep the listener reachable.
 */
import { PeerCleanups, trackWorkerSubscription } from "../../src/thread/services/support";

const [route, reference] = process.argv.slice(2);
if ((route !== "set" && route !== "peer-cleanups") || (reference !== "dropped" && reference !== "held")) {
	throw new Error("usage: worker-subscription-release-probe <set|peer-cleanups> <dropped|held>");
}

let held: object | undefined;

/** A listener-holding `off` that is only reachable through the returned WeakRef and `track`'s result. */
function subscribe(track: (off: () => void) => () => void): { unsubscribe: () => void; listener: WeakRef<object> } {
	const listener = { onEvent: () => {} };
	if (reference === "held") held = listener;
	const calls: unknown[] = [];
	const unsubscribe = track(() => calls.push(listener));
	return { unsubscribe, listener: new WeakRef(listener) };
}

async function collect(): Promise<void> {
	for (let pass = 0; pass < 3; pass++) {
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		Bun.gc(true);
	}
}

let tracked: { unsubscribe: () => void; listener: WeakRef<object> };
let aliveWhileSubscribed: boolean;
let remaining: number | undefined;
let runs = 0;
if (route === "set") {
	const subscriptions = new Set<() => void>();
	tracked = subscribe(off => trackWorkerSubscription(subscriptions, off));
	await collect();
	aliveWhileSubscribed = tracked.listener.deref() !== undefined;
	tracked.unsubscribe();
	remaining = subscriptions.size;
} else {
	const cleanups = new PeerCleanups("test");
	tracked = subscribe(off =>
		cleanups.track("w1", () => {
			runs++;
			off();
		}),
	);
	await collect();
	aliveWhileSubscribed = tracked.listener.deref() !== undefined;
	tracked.unsubscribe();
	tracked.unsubscribe();
	cleanups.release("w1");
}
await collect();

process.stdout.write(
	JSON.stringify({
		aliveWhileSubscribed,
		remaining,
		runs,
		collected: tracked.listener.deref() === undefined,
		held: held !== undefined,
	}),
);
