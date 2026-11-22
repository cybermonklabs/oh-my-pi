import { describe, expect, test } from "bun:test";
import {
	buildCompactionV2Request,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { addModelCallGuard, ModelCallRefusedError } from "@oh-my-pi/pi-ai/model-call-guard";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-attestation";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Remote compaction sends the session's history to the model's provider (OpenAI's `/responses/compact`, V2
 * streaming compaction, a configured remote endpoint). Each request passes pi-ai's model-call checkpoint: a
 * held model sends nothing, each attempt reads the guards right before it goes out, and a `cyber_policy`
 * refusal reaches the guards and is not retried. Synthetic responses only.
 */
const HOLD = "held: cyber_policy";
const REFUSAL = {
	error: {
		message: "This content was flagged for possible cybersecurity risk.",
		type: "invalid_request_error",
		code: "cyber_policy",
	},
};
const USER_ITEM = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };
const COMPACTION_ITEM = { type: "compaction", encrypted_content: "enc_123" };
/** A ChatGPT-OAuth-shaped access token: its account id claim makes V1 wait for a Codex attestation. */
const CODEX_ACCOUNT_TOKEN = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
).toString("base64url")}.signature`;

function makeOpenAiModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

const V2_MODEL = makeOpenAiModel({
	remoteCompaction: { enabled: true, v2StreamingEnabled: true, v2Endpoint: "https://compact.example/v1/responses" },
});

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function v2Completed(): Response {
	return sseResponse([
		{ type: "response.output_item.done", output_index: 0, item: COMPACTION_ITEM },
		{ type: "response.completed" },
	]);
}

/** Registers a guard that holds `model` while `isHeld()` is true and records what the guards are told. */
function guardFor(model: Model, isHeld: () => boolean): { outcomes: unknown[]; remove: () => void } {
	const outcomes: unknown[] = [];
	const remove = addModelCallGuard({
		refuse: candidate => (isHeld() && candidate.id === model.id ? HOLD : undefined),
		settled: (_model, outcome) => outcomes.push(outcome),
	});
	return { outcomes, remove };
}

describe("remote compaction passes the model-call checkpoint", () => {
	test.each([
		["V1 /responses/compact sends nothing while a hold stands", true, 0],
		["V1 /responses/compact is sent with no hold (control)", false, 1],
	])("%s", async (_label, held, expectedRequests) => {
		const model = makeOpenAiModel();
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return Response.json({ output: [COMPACTION_ITEM] });
		};
		const guard = guardFor(model, () => held);
		try {
			const outcome = await requestOpenAiRemoteCompaction(
				model,
				"test-key",
				[USER_ITEM],
				"instructions",
				undefined,
				{
					fetch: fetchMock,
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(requests).toBe(expectedRequests);
			if (held) expect(outcome).toBeInstanceOf(ModelCallRefusedError);
			else expect(outcome).toBe("sent");
		} finally {
			guard.remove();
		}
	});

	// The guards are read again right before the POST, after the waits that precede it.
	test("V1 reads the guards again right before the POST", async () => {
		const model = makeOpenAiModel();
		let reads = 0;
		let requests = 0;
		const remove = addModelCallGuard({
			refuse: candidate => (candidate.id === model.id && ++reads >= 2 ? HOLD : undefined),
		});
		try {
			const outcome = await requestOpenAiRemoteCompaction(
				model,
				"test-key",
				[USER_ITEM],
				"instructions",
				undefined,
				{
					fetch: (async () => {
						requests++;
						return Response.json({ output: [COMPACTION_ITEM] });
					}) as FetchImpl,
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(reads).toBe(2);
			expect(requests).toBe(0);
			expect(outcome).toBeInstanceOf(ModelCallRefusedError);
		} finally {
			remove();
		}
	});

	// The second read sits after V1's waits. A Codex model waits for its attestation before the POST: a hold
	// that begins during that wait holds the POST. The control is the same call with no hold.
	test.each([
		["V1 holds a POST whose hold begins during the Codex attestation wait", true, 0],
		["V1 sends after the Codex attestation wait when no hold begins (control)", false, 1],
	])("%s", async (_label, holdInAttestation, expectedRequests) => {
		const model = makeOpenAiModel({ provider: "openai-codex" });
		let held = false;
		let attestations = 0;
		let requests = 0;
		const guard = guardFor(model, () => held);
		setCodexAttestationProvider(async () => {
			attestations++;
			held = holdInAttestation;
			return "attestation";
		});
		try {
			const outcome = await requestOpenAiRemoteCompaction(
				model,
				CODEX_ACCOUNT_TOKEN,
				[USER_ITEM],
				"instructions",
				undefined,
				{
					fetch: (async () => {
						requests++;
						return Response.json({ output: [COMPACTION_ITEM] });
					}) as FetchImpl,
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(attestations).toBe(1);
			expect(requests).toBe(expectedRequests);
			if (holdInAttestation) expect(outcome).toBeInstanceOf(ModelCallRefusedError);
			else expect(outcome).toBe("sent");
		} finally {
			setCodexAttestationProvider(undefined);
			guard.remove();
		}
	});

	test("V1 reports a cyber_policy refusal to the guards", async () => {
		const model = makeOpenAiModel();
		let requests = 0;
		const guard = guardFor(model, () => false);
		try {
			const error = await requestOpenAiRemoteCompaction(model, "test-key", [USER_ITEM], "instructions", undefined, {
				fetch: (async () => {
					requests++;
					return Response.json(REFUSAL, { status: 400 });
				}) as FetchImpl,
			}).catch((cause: unknown) => cause);

			expect(requests).toBe(1);
			expect(AIError.isCyberPolicyRefusal(error)).toBe(true);
			expect(guard.outcomes).toEqual([error]);
		} finally {
			guard.remove();
		}
	});

	test.each([
		["V2 streaming compaction sends nothing while a hold stands", true, 0],
		["V2 streaming compaction is sent with no hold (control)", false, 1],
	])("%s", async (_label, held, expectedRequests) => {
		let requests = 0;
		const guard = guardFor(V2_MODEL, () => held);
		try {
			const outcome = await requestCompactionV2Streaming(
				V2_MODEL,
				"test-key",
				buildCompactionV2Request(V2_MODEL, [USER_ITEM], "instructions"),
				undefined,
				{
					fetch: (async () => {
						requests++;
						return v2Completed();
					}) as FetchImpl,
					retryWait: async () => {},
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(requests).toBe(expectedRequests);
			if (held) expect(outcome).toBeInstanceOf(ModelCallRefusedError);
			else expect(outcome).toBe("sent");
		} finally {
			guard.remove();
		}
	});

	// V2 retries a transient failure after a backoff: the retry reads the guards right before it goes out.
	test.each([
		["V2 holds its retry when a hold begins during the backoff", true, 1],
		["V2 retries after the backoff when no hold begins (control)", false, 2],
	])("%s", async (_label, holdDuringWait, expectedRequests) => {
		let held = false;
		let requests = 0;
		const guard = guardFor(V2_MODEL, () => held);
		try {
			const outcome = await requestCompactionV2Streaming(
				V2_MODEL,
				"test-key",
				buildCompactionV2Request(V2_MODEL, [USER_ITEM], "instructions"),
				undefined,
				{
					fetch: (async () => {
						requests++;
						if (requests === 1)
							return new Response("try again", { status: 500, statusText: "Internal Server Error" });
						return v2Completed();
					}) as FetchImpl,
					retryWait: async () => {
						held = holdDuringWait;
					},
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(requests).toBe(expectedRequests);
			if (holdDuringWait) expect(outcome).toBeInstanceOf(ModelCallRefusedError);
			else expect(outcome).toBe("sent");
		} finally {
			guard.remove();
		}
	});

	// A gateway can relay OpenAI's refusal as a 5xx; V2 retries 5xx, never a refusal.
	test("V2 sends a cyber_policy refusal relayed as a 503 once and reports it", async () => {
		let requests = 0;
		const guard = guardFor(V2_MODEL, () => false);
		try {
			const error = await requestCompactionV2Streaming(
				V2_MODEL,
				"test-key",
				buildCompactionV2Request(V2_MODEL, [USER_ITEM], "instructions"),
				undefined,
				{
					fetch: (async () => {
						requests++;
						return Response.json(REFUSAL, { status: 503, statusText: "Service Unavailable" });
					}) as FetchImpl,
					retryWait: async () => {},
				},
			).catch((cause: unknown) => cause);

			expect(requests).toBe(1);
			expect(AIError.isCyberPolicyRefusal(error)).toBe(true);
			expect(guard.outcomes).toEqual([error]);
		} finally {
			guard.remove();
		}
	});

	test.each([
		["a configured remote endpoint sends nothing while a hold stands", true, 0],
		["a configured remote endpoint is sent with no hold (control)", false, 1],
	])("%s", async (_label, held, expectedRequests) => {
		const model = makeOpenAiModel();
		let requests = 0;
		const guard = guardFor(model, () => held);
		try {
			const outcome = await requestRemoteCompaction(
				"https://summarizer.example/compact",
				{ systemPrompt: "system", prompt: "history", maxTokens: 64 },
				undefined,
				{
					fetch: (async () => {
						requests++;
						return Response.json({ summary: "summary" });
					}) as FetchImpl,
					model,
					apiKey: "not-a-secret",
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(requests).toBe(expectedRequests);
			if (held) expect(outcome).toBeInstanceOf(ModelCallRefusedError);
			else expect(outcome).toBe("sent");
		} finally {
			guard.remove();
		}
	});

	test("a configured remote endpoint reports a cyber_policy refusal to the guards", async () => {
		const model = makeOpenAiModel();
		let requests = 0;
		const guard = guardFor(model, () => false);
		try {
			const error = await requestRemoteCompaction(
				"https://gateway.example/v1/chat/completions",
				{ systemPrompt: "system", prompt: "history", maxTokens: 64 },
				undefined,
				{
					fetch: (async () => {
						requests++;
						return Response.json(REFUSAL, { status: 400 });
					}) as FetchImpl,
					model,
					apiKey: "not-a-secret",
				},
			).catch((cause: unknown) => cause);

			expect(requests).toBe(1);
			expect(AIError.isCyberPolicyRefusal(error)).toBe(true);
			expect(guard.outcomes).toEqual([error]);
		} finally {
			guard.remove();
		}
	});

	// The request reads the guards again right before it goes out, after the header and `onPayload` waits.
	test.each([
		["a configured remote endpoint holds a request whose hold begins during its onPayload hook", true, 0],
		["a configured remote endpoint sends after its onPayload hook with no hold (control)", false, 1],
	])("%s", async (_label, holdInHook, expectedRequests) => {
		const model = makeOpenAiModel();
		let held = false;
		let requests = 0;
		const guard = guardFor(model, () => held);
		try {
			const outcome = await requestRemoteCompaction(
				"https://summarizer.example/compact",
				{ systemPrompt: "system", prompt: "history", maxTokens: 64 },
				undefined,
				{
					fetch: (async () => {
						requests++;
						return Response.json({ summary: "summary" });
					}) as FetchImpl,
					model,
					apiKey: "not-a-secret",
					onPayload: async () => {
						held = holdInHook;
						return undefined;
					},
				},
			).then(
				() => "sent",
				(error: unknown) => error,
			);

			expect(requests).toBe(expectedRequests);
			if (holdInHook) expect(outcome).toBeInstanceOf(ModelCallRefusedError);
			else expect(outcome).toBe("sent");
		} finally {
			guard.remove();
		}
	});
});
