import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { addModelCallGuard } from "@oh-my-pi/pi-ai/model-call-guard";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import type { Api, AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * A transport that sends again after a wait (a 5xx backoff, another endpoint) reads the model-call guards
 * right before each send. A hold that begins after the first attempt (here, as its 503 comes back) holds
 * the next one: one request, and the call ends on the held error. Each control runs the same call with no
 * hold and sends twice. Synthetic responses only.
 */
const HOLD = "held: cyber_policy";
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** A 503 the transports retry at once (`retry-after-ms: 1`). */
function unavailable(): Response {
	return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
		status: 503,
		headers: { "content-type": "application/json", "retry-after-ms": "1" },
	});
}

/** Runs `call` with a guard that holds `model` once `hold()` was called. */
async function withHold(
	model: Model<Api>,
	call: (hold: () => void) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
	let held = false;
	const removeGuard = addModelCallGuard({
		refuse: candidate => (held && candidate.id === model.id ? HOLD : undefined),
	});
	try {
		return await call(() => {
			held = true;
		});
	} finally {
		removeGuard();
	}
}

const CASES = [
	["holds the next attempt when a model-call hold begins after the first", true, 1],
	["sends the next attempt when no hold begins (control)", false, 2],
] as const;

describe("Bedrock: each fetchWithRetry attempt reads the model-call guards", () => {
	const model: Model<"bedrock-converse-stream"> = buildModel({
		id: "openai.gpt-oss-120b-1:0",
		name: "gpt-oss-120b",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	});

	it.each(CASES)("%s", async (_label, holdAfterFirst, expectedRequests) => {
		let requests = 0;
		const result = await withHold(model, hold => {
			const fetch = (async () => {
				requests++;
				if (requests === 1) {
					if (holdAfterFirst) hold();
					return unavailable();
				}
				return new Response(new Uint8Array(), {
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				});
			}) as unknown as FetchImpl;
			return streamBedrock(model, context, { bearerToken: "test-token", fetch, maxTokens: 16 }).result();
		});

		expect(requests).toBe(expectedRequests);
		if (holdAfterFirst) expect(result.errorMessage).toContain(HOLD);
	});
});

describe("Ollama: each fetchWithRetry attempt reads the model-call guards", () => {
	const model: Model<"ollama-chat"> = buildModel({
		id: "gpt-oss:120b",
		name: "gpt-oss 120b",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	});

	it.each(CASES)("%s", async (_label, holdAfterFirst, expectedRequests) => {
		let requests = 0;
		const result = await withHold(model, hold => {
			const fetch = (async () => {
				requests++;
				if (requests === 1) {
					if (holdAfterFirst) hold();
					return unavailable();
				}
				return new Response(
					'{"message":{"content":"ok"},"done":true,"done_reason":"stop","prompt_eval_count":1,"eval_count":1}\n',
					{ status: 200 },
				);
			}) as unknown as FetchImpl;
			return streamOllama(model, context, {
				apiKey: "not-a-secret",
				fetch,
				providerRetryWait: async () => {},
			}).result();
		});

		expect(requests).toBe(expectedRequests);
		if (holdAfterFirst) expect(result.errorMessage).toContain(HOLD);
		else expect(result.stopReason).toBe("stop");
	});
});

describe("Gemini CLI: each endpoint attempt reads the model-call guards", () => {
	const DAILY = "https://daily-cloudcode-pa.googleapis.com";
	const model: Model<"google-gemini-cli"> = buildModel({
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B (Antigravity)",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: DAILY,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	});
	// Endpoint failover only: the pinned client version keeps the manifest lookup off the injected fetch.
	const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
	beforeEach(() => {
		process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
	});
	afterEach(() => {
		if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
	});

	it.each(CASES)("%s", async (_label, holdAfterFirst, expectedRequests) => {
		const endpoints: string[] = [];
		const result = await withHold(model, hold => {
			const fetch: FetchImpl = async input => {
				const url = input instanceof Request ? input.url : input.toString();
				endpoints.push(new URL(url).origin);
				if (endpoints.length === 1) {
					if (holdAfterFirst) hold();
					return unavailable();
				}
				const body = `data: ${JSON.stringify({
					response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
				})}\n\n`;
				return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			return streamGoogleGeminiCli(model, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				antigravityEndpointMode: "auto",
				fetch,
			}).result();
		});

		expect(endpoints).toHaveLength(expectedRequests);
		if (holdAfterFirst) expect(result.errorMessage).toContain(HOLD);
		else expect(result.stopReason).toBe("stop");
	});

	// An endpoint that answers 200 with an empty stop is asked again, after a backoff, with the same body. That
	// resend reads the guards right before it goes out: a hold that begins after the empty answer holds it, and the
	// held call keeps the first answer (its usage), since the output is reset only after the read.
	it.each(CASES)("empty-response resend: %s", async (_label, holdAfterFirst, expectedRequests) => {
		const urls: string[] = [];
		const result = await withHold(model, hold => {
			const fetch: FetchImpl = async input => {
				const url = input instanceof Request ? input.url : input.toString();
				urls.push(url);
				const parts = urls.length === 1 ? [] : [{ text: "ok" }];
				if (urls.length === 1 && holdAfterFirst) hold();
				const body = `data: ${JSON.stringify({
					response: {
						candidates: [{ content: { parts }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
					},
				})}\n\n`;
				const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
				// The resend goes to the URL the first response came from.
				Object.defineProperty(response, "url", { value: url });
				return response;
			};
			return streamGoogleGeminiCli(model, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				antigravityEndpointMode: "production",
				fetch,
			}).result();
		});

		expect(urls).toHaveLength(expectedRequests);
		if (holdAfterFirst) {
			expect(result.errorMessage).toContain(HOLD);
			expect(result.usage.input).toBe(10);
		} else {
			expect(result.stopReason).toBe("stop");
			// The control's resend went to the same endpoint as the first request.
			expect(urls[1]).toBe(urls[0]);
		}
	});
});

describe("Google (public API and Vertex): each send reads the model-call guards", () => {
	const model: Model<"google-generative-ai"> = buildModel({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});

	// A STOP with no content is asked again after a backoff: that resend reads the guards right before it goes
	// out, so a hold that begins after the empty answer holds it. A first answer of thinking only counts as empty;
	// the held call keeps it (its thinking and usage), since the output is reset only after the read.
	it.each(CASES)("empty-response resend: %s", async (_label, holdAfterFirst, expectedRequests) => {
		let requests = 0;
		const result = await withHold(model, hold => {
			const fetch: FetchImpl = async () => {
				requests++;
				if (requests === 1 && holdAfterFirst) hold();
				const parts = requests === 1 ? [{ text: "pondering", thought: true }] : [{ text: "Hello!" }];
				const body = `data: ${JSON.stringify({
					candidates: [{ content: { parts }, finishReason: "STOP" }],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: requests === 1 ? 2 : 5,
						totalTokenCount: 15,
					},
				})}\n\n`;
				return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			return streamGoogle(model, context, { apiKey: "k", fetch }).result();
		});

		expect(requests).toBe(expectedRequests);
		if (holdAfterFirst) {
			expect(result.errorMessage).toContain(HOLD);
			expect(result.content).toEqual([expect.objectContaining({ type: "thinking", thinking: "pondering" })]);
			expect(result.usage.input).toBe(10);
		} else expect(result.stopReason).toBe("stop");
	});

	// Vertex with an ambient region (no explicit `location`) retries the global endpoint once after a regional 404.
	// That retry reads the guards right before it goes out: a hold that begins on the 404 holds it.
	describe("Vertex regional-404 retry", () => {
		const vertexModel: Model<"google-vertex"> = buildModel({
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro Preview",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		});
		const LOCATION_KEYS = ["GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION", "VERTEX_LOCATION"] as const;
		const saved = new Map<string, string | undefined>();
		beforeEach(() => {
			for (const key of LOCATION_KEYS) saved.set(key, Bun.env[key]);
			for (const key of LOCATION_KEYS) delete Bun.env[key];
			Bun.env.GOOGLE_VERTEX_LOCATION = "us-central1";
		});
		afterEach(() => {
			for (const key of LOCATION_KEYS) {
				const value = saved.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		});

		it.each(CASES)("%s", async (_label, holdAfterFirst, expectedRequests) => {
			const hosts: string[] = [];
			const result = await withHold(vertexModel, hold => {
				const fetch: FetchImpl = async input => {
					const url = input instanceof Request ? input.url : input.toString();
					hosts.push(new URL(url).host);
					if (hosts.length === 1) {
						if (holdAfterFirst) hold();
						return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
					}
					const body = `data: ${JSON.stringify({
						candidates: [{ content: { parts: [{ text: "Hello!" }] }, finishReason: "STOP" }],
					})}\n\n`;
					return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
				};
				return streamGoogleVertex(vertexModel, context, { apiKey: "not-a-secret", fetch }).result();
			});

			expect(hosts).toHaveLength(expectedRequests);
			expect(hosts[0]).toBe("us-central1-aiplatform.googleapis.com");
			if (holdAfterFirst) expect(result.errorMessage).toContain(HOLD);
			else {
				expect(result.stopReason).toBe("stop");
				expect(hosts[1]).toBe("aiplatform.googleapis.com");
			}
		});
	});
});
