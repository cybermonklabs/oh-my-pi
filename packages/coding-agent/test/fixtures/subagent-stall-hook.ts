// Evaluated before the real entry. Stalls this worker's thread on request, as a
// worker busy in a synchronous native call is when it dies: a number posted on
// the channel (executor-routing.test.ts posts it) makes the worker post
// "stalled" back, then block that many milliseconds in `Bun.sleepSync`, which a
// terminate does not interrupt, so the thread stops, and the OS closes its
// descriptors, only after the sleep.
const channel = new BroadcastChannel("omp-test-subagent-stall");
channel.addEventListener("message", event => {
	const { data } = event as MessageEvent<unknown>;
	if (typeof data !== "number") return;
	channel.postMessage("stalled");
	Bun.sleepSync(data);
});
