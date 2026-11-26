/**
 * A per-call message rebuilt equal to the one the previous request sent at the same position goes out as history, and
 * "previous" must mean a request that reached the provider. The loop takes that record in the dispatch hook it gives
 * the stream function, but the provider dispatch layer calls that hook first, before the provider builds and hands off
 * its request: the provider still awaits its payload hook (an extension's `before_provider_request`), image
 * preparation and its SDK, and only then does the transport call the hook again and send. A stop that lands in those
 * awaits (the user aborts while a payload hook runs) keeps the request from going out, yet its per-call messages are
 * already the record, so the next request sends the changed note as history although no request carried it.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Context, type FetchImpl, streamSimple } from "@oh-my-pi/pi-ai";
import { isPerCallContextMessage, markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://gateway.local",
	reasoning: false,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** A gateway stand-in: each request gets a one-text reply; `bodies` holds every request that reached it. */
function gateway(): { fetch: FetchImpl; bodies: string[] } {
	const bodies: string[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		bodies.push(typeof init?.body === "string" ? init.body : "");
		const events = [
			{ type: "message_start", message: { id: `msg_${bodies.length}`, model: model.id, usage } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
			{ type: "message_stop" },
		];
		const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req" } });
	};
	return { fetch, bodies };
}

describe("a per-call message of a request stopped while the provider prepares it", () => {
	it("stays per-call in the next request sent", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		let note = "status: idle";
		let stopInPayloadHook = false;
		const agent: Agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, {
					...options,
					fetch: server.fetch,
					// An extension's payload hook that awaits; the user stops the run while it runs.
					onPayload: async () => {
						if (!stopInPayloadHook) return undefined;
						await Promise.resolve();
						agent.abort();
						return undefined;
					},
				});
			},
			// A context hook's note ahead of the history, rebuilt for every request.
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: note, timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		note = "status: busy";
		stopInPayloadHook = true;
		await agent.prompt("second");
		stopInPayloadHook = false;
		await agent.prompt("third");

		// Preconditions: three requests were prepared, and the second never reached the gateway.
		expect(contexts).toHaveLength(3);
		expect(server.bodies).toHaveLength(2);
		expect(server.bodies[1]).toContain("status: busy");
		expect(contexts[2]?.messages[0]?.content).toBe("status: busy");
		// The note changed since the last request that went out: no request carried it, so it stays per-call.
		expect(isPerCallContextMessage(contexts[2]?.messages[0])).toBe(true);
	});

	it("goes out as history in the next request once the gateway answered the request that carried it", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		const agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, { ...options, fetch: server.fetch });
			},
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: "status: idle", timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(server.bodies).toHaveLength(2);
		expect(isPerCallContextMessage(contexts[0]?.messages[0])).toBe(true);
		// The provider reported its answer to the first request, which carried the note at this position.
		expect(contexts[1]?.messages[0]?.content).toBe("status: idle");
		expect(isPerCallContextMessage(contexts[1]?.messages[0])).toBe(false);
	});
});
