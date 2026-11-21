import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { addModelCallGuard, type JudgmentRequest, ModelCallRefusedError, NativeJudge } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
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
/** The model a transport request is for: `postOpenAIStream` reads the model-call guards before each resend. */
const MODEL = createMockModel({ id: "gpt-5.5", handler: { content: [] } });

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
			model: MODEL,
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

	// The model-call guards are read again before each transport resend: a hold that began while the first
	// attempt was out (here, during its 503) holds the resend, and its error leaves unretried and unwrapped.
	it.each([
		["holds the resend of an ordinary 503 when a hold begins meanwhile", true, 1],
		["resends an ordinary 503 when no hold begins (control)", false, 3],
	])("%s", async (_label, holdDuringAttempt, expected) => {
		let attempts = 0;
		let held = false;
		const removeGuard = addModelCallGuard({ refuse: () => (held ? "held: cyber_policy" : undefined) });
		const fetch = mockFetch(() => {
			attempts++;
			held = holdDuringAttempt;
			return new Response(JSON.stringify({ error: { type: "server_error", message: "upstream unavailable" } }), {
				status: 503,
				headers: { "content-type": "application/json", "retry-after-ms": "1" },
			});
		});
		try {
			const error = await postOpenAIStream({
				url: "https://gateway.local/v1/responses",
				model: MODEL,
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
			if (holdDuringAttempt) expect(error).toBeInstanceOf(ModelCallRefusedError);
			else expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		} finally {
			removeGuard();
		}
	});

	// A native judgment retries 408, 429 and 5xx inside one guarded call; a refusal a gateway relays as a 503
	// ends it at once, so the guard around `judge` records it after one request.
	it.each([
		["a refusal relayed as a 503", { error: { code: "cyber_policy", message: SENTENCE } }, 1],
		["an ordinary 503", { error: { type: "server_error", message: "upstream unavailable" } }, 3],
	])("a native judgment sends %s %i time(s)", async (_label, body, expected) => {
		let attempts = 0;
		const judge = new NativeJudge({
			api: "typesafe",
			provider: "typesafe",
			model: "typesafe/jev-latest",
			baseUrl: "https://gateway.local",
			apiKey: "test",
			fetch: async () => {
				attempts++;
				return new Response(JSON.stringify(body), {
					status: 503,
					headers: { "content-type": "application/json", "retry-after-ms": "1" },
				});
			},
		});
		const request = { state: "s", questions: { q: { type: "noul", instructions: "Question?" } } };

		const error = await judge.judge(request as unknown as JudgmentRequest).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(attempts).toBe(expected);
		expect(error).toBeInstanceOf(Error);
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
