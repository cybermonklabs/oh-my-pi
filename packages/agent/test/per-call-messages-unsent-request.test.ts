/**
 * A per-call message rebuilt equal to the one the previous request sent at the same position goes out as history.
 * "Previous" must mean a request that reached the provider. The loop once recorded a request's per-call messages as it
 * called the stream function, before the stream function's own work: an abort that lands there (the transport's
 * dispatch hold throws on the aborted signal) or a refusal there (a spend cap checked again as the request goes out)
 * keeps the request from going out, yet its per-call messages became the record, so the next request sent the new note
 * as history although no request ever carried it. The record is now taken as the provider reports its response.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { isPerCallContextMessage, markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";

type Unsent = "abort" | "refuse";

/** Three prompts; the second request is kept from going out by `unsent`. Returns the contexts the provider received. */
async function runWithUnsentSecondRequest(unsent: Unsent): Promise<Context[]> {
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
	let keepFromGoingOut = false;
	const agent: Agent = new Agent({
		initialState: { model: mock.model },
		streamFn: async (model, context, options) => {
			if (keepFromGoingOut) {
				// A spend cap checked again as the request goes out refuses it: nothing is sent.
				if (unsent === "refuse") throw new Error("Session cost cap reached");
				// The user stops the run while the transport prepares the request.
				agent.abort();
			}
			// As a transport does: the dispatch hold runs before anything is sent and throws on an aborted signal.
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
	keepFromGoingOut = true;
	await agent.prompt("second");
	keepFromGoingOut = false;
	await agent.prompt("third");
	return sent;
}

describe("a per-call message of a request kept from going out inside the stream function", () => {
	for (const unsent of ["abort", "refuse"] as const) {
		it(`stays per-call in the next request sent (${unsent})`, async () => {
			const sent = await runWithUnsentSecondRequest(unsent);
			// Precondition: the second request never reached the provider.
			expect(sent).toHaveLength(2);
			const [first, third] = sent;
			expect(first?.messages[0]?.content).toBe("status: idle");
			expect(third?.messages[0]?.content).toBe("status: busy");
			// The note changed since the last request sent: no request carried it, so it stays per-call.
			expect(isPerCallContextMessage(third?.messages[0])).toBe(true);
		});
	}
});
