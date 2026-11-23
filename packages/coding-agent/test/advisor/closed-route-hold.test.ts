// An advisor on a route a cyber-policy refusal closed holds its batch until the closure ends. When a
// person's prompt ends it while the runtime is still awaiting its route check, the resume finds nothing
// held yet: the runtime must read the route again once the hold is set, or the batch stays held for good.
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../../src/advisor/runtime";

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

describe("advisor held for a closed route", () => {
	it("sends the batch when the closure ends during the route check", async () => {
		const prompts: string[] = [];
		const agent: AdvisorAgent = {
			prompt: async (input: string) => {
				prompts.push(input);
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		let closed = true;
		let checks = 0;
		const ref: { runtime?: AdvisorRuntime } = {};
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => [userMessage("turn one body", 1)],
			ensureOpenRoute: async () => {
				checks++;
				if (checks > 1) return !closed;
				// A person's prompt ends the closure while this check is awaited: the resume runs now,
				// before the runtime has set its hold.
				closed = false;
				ref.runtime?.resumeAfterClosedRoute();
				return false;
			},
			isRouteClosed: () => closed,
		};
		const runtime = new AdvisorRuntime(agent, host);
		ref.runtime = runtime;

		// Catch-up resolves once the batch is sent, or at once when the runtime holds it (waiters released).
		runtime.onTurnEnd();
		await runtime.waitForCatchup(5_000, 1);

		expect(prompts).toHaveLength(1);
	});

	it("holds the batch while the route stays closed, as intended", async () => {
		const prompts: string[] = [];
		const agent: AdvisorAgent = {
			prompt: async (input: string) => {
				prompts.push(input);
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => [userMessage("turn one body", 1)],
			ensureOpenRoute: async () => false,
			isRouteClosed: () => true,
		};
		const runtime = new AdvisorRuntime(agent, host);

		runtime.onTurnEnd();
		await runtime.waitForCatchup(5_000, 1);

		expect(prompts).toHaveLength(0);
	});
});
