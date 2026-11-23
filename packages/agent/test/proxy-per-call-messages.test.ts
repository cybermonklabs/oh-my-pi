/**
 * The loop takes a main request's per-call record in the `beforeDispatch` it hands the stream function, which a
 * transport calls as it sends. `streamProxy` is the Agent's proxy stream function, so it must call it too: one that
 * never did left the record empty, and a per-call message the next request repeated at the same position stayed
 * per-call (a rolling cache breakpoint lost), while a refusal raised there never kept a request from the proxy.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ProxyAssistantMessageEvent, streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { isPerCallContextMessage, markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";

const PROXY_URL = "http://127.0.0.1:0";

/** A proxy server stand-in that answers every request with one text reply; `requests` counts what reached it. */
function proxyServer(): { fetch: FetchImpl; requests: number } {
	const server = {
		requests: 0,
		fetch: (async () => {
			server.requests++;
			const usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const events: ProxyAssistantMessageEvent[] = [
				{ type: "start" },
				{ type: "done", reason: "stop", usage, content: [{ type: "text", text: "ok" }] },
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
		}) as FetchImpl,
	};
	return server;
}

describe("streamProxy as an Agent's stream function", () => {
	it("sends a per-call message the previous request sent at the same position as history", async () => {
		const server = proxyServer();
		const sent: Context[] = [];
		const agent = new Agent({
			initialState: { model: createMockModel().model },
			streamFn: (model, context, options) => {
				sent.push(context);
				return streamProxy(model, context, {
					...options,
					authToken: "not-a-secret",
					proxyUrl: PROXY_URL,
					fetch: server.fetch,
				});
			},
			// A context hook's note ahead of the history, rebuilt for every request.
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: "status: idle", timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(server.requests).toBe(2);
		const [first, second] = sent;
		expect(isPerCallContextMessage(first?.messages[0])).toBe(true);
		// The proxy sent the same note at this position last time: the cache holds it as history.
		expect(second?.messages[0]?.content).toBe("status: idle");
		expect(isPerCallContextMessage(second?.messages[0])).toBe(false);
	});

	it("sends nothing to the proxy when the dispatch hook refuses the request", async () => {
		const server = proxyServer();
		const message = await streamProxy(
			createMockModel().model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				authToken: "not-a-secret",
				proxyUrl: PROXY_URL,
				fetch: server.fetch,
				beforeDispatch: () => {
					throw new Error("Session cost cap reached");
				},
			},
		).result();

		expect(server.requests).toBe(0);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Session cost cap reached");
	});
});
