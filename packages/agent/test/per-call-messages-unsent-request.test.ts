/**
 * A per-call message rebuilt equal to the one the previous request sent at the same position goes out as history.
 * "Previous" must mean a request that reached the provider. The loop once recorded a request's per-call messages as it
 * called the stream function, before the stream function's own work: a refusal there (a spend cap checked again as the
 * request goes out) keeps the request from going out, yet its per-call messages became the record, so the next request
 * sent the new note as history although no request ever carried it. The record is now taken as the provider reports
 * its response. An abort before the request reaches the provider is covered by
 * per-call-messages-abort-before-wire.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { isPerCallContextMessage, markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";

describe("a per-call message of a request a refusal inside the stream function kept from going out", () => {
	it("stays per-call in the next request sent", async () => {
		const sent: Context[] = [];
		// As a provider does, each reply reports its response (`onResponse`), which takes the per-call record.
		const mock = createMockModel({
			responses: [
				context => {
					sent.push(context);
					return { content: ["first"], responseHeaders: {} };
				},
				context => {
					sent.push(context);
					return { content: ["third"], responseHeaders: {} };
				},
			],
		});
		// A context hook's note ahead of the history, rebuilt for every request.
		let note = "status: idle";
		let refuse = false;
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: async (model, context, options) => {
				// A spend cap checked again as the request goes out refuses it: nothing is sent.
				if (refuse) throw new Error("Session cost cap reached");
				// As a transport does: the dispatch hook runs before anything is sent.
				await options?.beforeDispatch?.();
				return mock.stream(model, context, options);
			},
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: note, timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		note = "status: busy";
		refuse = true;
		await agent.prompt("second");
		refuse = false;
		await agent.prompt("third");

		// Precondition: the second request never reached the provider.
		expect(sent).toHaveLength(2);
		const [first, third] = sent;
		expect(first?.messages[0]?.content).toBe("status: idle");
		expect(third?.messages[0]?.content).toBe("status: busy");
		// The note changed since the last request sent: no request carried it, so it stays per-call.
		expect(isPerCallContextMessage(third?.messages[0])).toBe(true);
	});
});
