import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { postOpenAIStream } from "@oh-my-pi/pi-ai/utils/openai-http";
import { resetRequestCompressionForTesting } from "@oh-my-pi/pi-ai/utils/request-compression";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";
import { mockFetch } from "./helpers/fetch-mock";

/**
 * OpenAI refuses content it flags for cybersecurity risk with the code `cyber_policy`. Each copy sent
 * again adds a refusal to the organization's record, so no transport path may send it a second time,
 * whatever status or wording the refusal arrives with. Synthetic error bodies only.
 */
const SENTENCE = "This content was flagged for possible cybersecurity risk.";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	resetRequestCompressionForTesting();
	vi.restoreAllMocks();
});

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Review this change", timestamp: Date.now() }],
};

const COMPLETED_SSE = `${[
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

/** Codex fetch answering the first `/responses` call with `first()` and any later call with a completed stream. */
function codexFetch(first: () => Response): { requests: () => number; fetch: FetchImpl } {
	let requests = 0;
	const fetch = (async (input: string | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.endsWith("/responses")) return new Response("not found", { status: 404 });
		requests++;
		return requests === 1
			? first()
			: new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as FetchImpl;
	return { requests: () => requests, fetch };
}

describe("a cyber_policy refusal on the OpenAI transports", () => {
	const model = createCodexModel("gpt-6-sol", { preferWebsockets: false });

	it("sends a Codex JSON 400 refusal once, and its code reaches the message", async () => {
		const { requests, fetch } = codexFetch(
			() =>
				new Response(JSON.stringify({ error: { code: "cyber_policy", message: "Request rejected." } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: codexToken("acct-cyber-400"),
			fetch,
		}).result();

		expect(requests()).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("cyber_policy");
	});

	it("sends a refusal a gateway relays as a 5xx to Codex once", async () => {
		const { requests, fetch } = codexFetch(
			() =>
				new Response(JSON.stringify({ error: { code: "cyber_policy", message: SENTENCE } }), {
					status: 500,
					headers: { "content-type": "application/json", "retry-after-ms": "1" },
				}),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: codexToken("acct-cyber-500"),
			fetch,
		}).result();

		expect(requests()).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("does not replay a Codex refusal event whose wording reads as transient", async () => {
		const event = {
			type: "error",
			code: "cyber_policy",
			message: `${SENTENCE} The service is temporarily refusing it.`,
		};
		const { requests, fetch } = codexFetch(
			() =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: codexToken("acct-cyber-event"),
			fetch,
		}).result();

		expect(requests()).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("still replays a transient Codex server event, as before", async () => {
		const event = { type: "error", code: "server_error", message: "The server is temporarily unavailable." };
		const { requests, fetch } = codexFetch(
			() =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: codexToken("acct-server-event"),
			fetch,
		}).result();

		expect(requests()).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it.each([
		["a refusal relayed as a 5xx", { error: { code: "cyber_policy", message: SENTENCE } }, 1],
		["an ordinary 5xx", { error: { type: "server_error", message: "upstream unavailable" } }, 3],
	])("the OpenAI wire sends %s %i time(s)", async (_label, body, expected) => {
		let attempts = 0;
		const fetch = mockFetch(() => {
			attempts++;
			return new Response(JSON.stringify(body), {
				status: 500,
				headers: { "content-type": "application/json", "retry-after-ms": "1" },
			});
		});

		const error = await postOpenAIStream({
			url: "https://gateway.local/v1/responses",
			headers: {},
			body: {},
			signal: new AbortController().signal,
			fetch,
			maxAttempts: 3,
		}).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(attempts).toBe(expected);
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
	});

	it("keeps a refusal's code in the message when the provider text omits it", async () => {
		const result = await AIError.finalize(
			new AIError.ProviderHttpError("Request rejected.", 400, { code: "cyber_policy" }),
			{
				api: "azure-openai-responses",
				provider: "azure",
			},
		);

		expect(result.message).toContain("cyber_policy");
		expect(AIError.is(result.id, AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.is(result.id, AIError.Flag.AccountPolicy)).toBe(false);
	});
});
