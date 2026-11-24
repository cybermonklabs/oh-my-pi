/**
 * The realm-wide record of which evaluated run the executing code belongs to, so that code of an abandoned run
 * is refused by every runtime of the realm. A run is abandoned when its runtime is disposed before its code
 * settled (a browser run discards its runtime when it times out or is cancelled with code still running): such
 * code cannot be stopped in-process and may resume while another run owns the realm.
 */
import { AsyncLocalStorage } from "node:async_hooks";
// Subpath imports only, as in runtime.ts: the computer worker's readiness graph must not load pi_natives.
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";

/** What the realm knows about the run whose code is executing. */
export interface RealmRun {
	/** Set when the run was abandoned before its code settled, with the reason it was given up. */
	abandoned?: { reason: unknown };
}

/**
 * The run whose code is executing, whichever runtime of this realm started it (`JsRuntime` enters it for each
 * run). Each runtime's own AsyncLocalStorage sees only its own runs, and code of an abandoned run can reach
 * another runtime's globals.
 */
export const REALM_RUN = new AsyncLocalStorage<RealmRun>();

/**
 * The error code of an abandoned run gets from runtime capabilities. Made at each refusal, so its stack names
 * the code that called, and marked as expected cleanup: nothing awaits that code any more, and its rejection
 * must not end the process.
 */
export function abandonedRunError(reason: unknown): Error {
	const error = new Error(
		"This run was abandoned (timed out, cancelled or disposed); its code can no longer use the JS runtime",
		{ cause: reason },
	);
	error.name = "AbortError";
	return postmortem.markExpectedCleanupError(error);
}

/**
 * Throws when the calling code belongs to an abandoned run. Every runtime capability (hooks, helpers, module
 * resolution) and every browser run facade calls it, so such code cannot act inside the run that owns the realm
 * now. (The stdio routing drops such a run's writes instead of throwing.)
 */
export function throwIfRunAbandoned(): void {
	const abandoned = REALM_RUN.getStore()?.abandoned;
	if (abandoned) throw abandonedRunError(abandoned.reason);
}
