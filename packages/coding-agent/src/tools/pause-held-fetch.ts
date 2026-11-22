import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { assertModelCallAllowed } from "@oh-my-pi/pi-ai/model-call-guard";
import { dispatchWhenOpen } from "@oh-my-pi/pi-ai/utils/dispatch-hold";

/**
 * The fetch for a provider request whose client takes a `fetch` but no
 * `beforeDispatch` — speech synthesis and image generation. Each call waits
 * out `/pause` before it reaches `fetchImpl`, so a tool that was already
 * running when the gate closed sends nothing more until the resume. The call's
 * own signal ends that wait and fails the call with the signal's reason.
 *
 * The wait goes through {@link dispatchWhenOpen}, which reads the gate's probe
 * in the same synchronous step that calls `fetchImpl`. Awaiting the gate's
 * hold and calling `fetchImpl` once it settles is not enough: a resume answers
 * the hold, and a pause that returns in the microtasks before the call would
 * go unseen, putting the request on the wire while the gate is engaged.
 *
 * `model` is the model the request calls. For a POST, the request to the
 * model, its model-call guards are read in that same step: the caller read
 * them when the call started, and a refusal recorded while the request was
 * parked (an OpenAI `cyber_policy` refusal met by another call of the session
 * tree) must hold it. A held request is not sent, and the call rejects with
 * the hold's error (`ModelCallRefusedError`). Any other method (the image
 * tool's GET of an image the generation already made) is no model call and
 * is not held, as `transportFetch` reads only a POST.
 */
export function pauseHeldFetch(fetchImpl: FetchImpl, model: Model<Api>): FetchImpl {
	return (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		return dispatchWhenOpen(agentPauseGate.dispatchHold(signal ?? undefined), signal, () => {
			if (method === "POST") assertModelCallAllowed(model);
			return fetchImpl(input, init);
		});
	};
}
