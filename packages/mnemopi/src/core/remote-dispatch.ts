import type { Api, DispatchHold, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { assertModelCallAllowed } from "@oh-my-pi/pi-ai/model-call-guard";
import { dispatchWhenOpen } from "@oh-my-pi/pi-ai/utils/dispatch-hold";

/**
 * `fetchImpl` behind an instance's dispatch hold: every attempt waits on it,
 * including each one a retry loop makes, and that attempt's own signal ends
 * the wait. The fetch call is the send itself, so it runs in the same step as
 * the hold's last check. Without a hold, `fetchImpl` is returned unchanged.
 *
 * `model` is the model the request calls. A POST reads its model-call guards
 * in that same step, after the hold: the caller's read before the attempt
 * (`guardedRequestUrl`) comes before the wait, and a refusal recorded during
 * it (an OpenAI `cyber_policy` refusal another call met) must hold the send.
 * A held send is not made and rejects with `ModelCallRefusedError`.
 */
export function fetchBehindHold(fetchImpl: FetchImpl, hold: DispatchHold | undefined, model: Model<Api>): FetchImpl {
	if (!hold) return fetchImpl;
	return (input, init) => {
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		return dispatchWhenOpen(hold, init?.signal, () => {
			if (method === "POST") assertModelCallAllowed(model);
			return fetchImpl(input, init);
		});
	};
}
