import { describe, expect, it } from "bun:test";
import { extractRetryHint } from "@oh-my-pi/pi-utils/fetch-retry";

// Turn recovery reads a provider's stated wait from the error text through
// `extractProviderRetryHint`, which hands the text to `extractRetryHint` with no
// response headers: the calls below are the reads a session makes.
describe("extractRetryHint: waits stated in seconds", () => {
	// Regression: an Azure OpenAI deployment says "Try again in 90 seconds." and
	// the session, blind to it, retries after its own short backoff, re-hits the
	// limit and spends the user's attempts on requests the provider already said
	// it would refuse.
	it("reads 'Try again in 90 seconds.' as 90 s", () => {
		const body = `429 ${JSON.stringify({ error: { code: "429", message: "Rate limit is exceeded. Try again in 90 seconds." } })}`;
		expect(extractRetryHint(undefined, body)).toBe(90_000);
	});

	// Regression: an Azure OpenAI deployment says "Please retry after 20 seconds."
	// and the session retries before the window clears, re-hits the limit and
	// spends the user's attempts on requests the provider already said it would
	// refuse.
	it("reads 'Please retry after 20 seconds.' as 20 s", () => {
		const body = `429 ${JSON.stringify({
			error: {
				code: "429",
				message:
					"Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-06-01 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 20 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.",
			},
		})}`;
		expect(extractRetryHint(undefined, body)).toBe(20_000);
	});

	// Regression: a provider says "try again in 45 secs" and the session retries
	// after its own short backoff, re-hits the limit and spends the user's attempts
	// on requests the provider already said it would refuse.
	it("reads 'try again in 45 secs' as 45 s", () => {
		expect(extractRetryHint(undefined, "429 Too many requests, try again in 45 secs")).toBe(45_000);
	});
});
