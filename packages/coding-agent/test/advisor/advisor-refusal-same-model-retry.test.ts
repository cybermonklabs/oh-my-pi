import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AdvisorAgent, AdvisorRuntime } from "../../src/advisor";

/** Poll until the drain loop reaches the asserted state (a failing advisor releases its waiters at once). */
async function settleUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Advisor did not settle within ${timeoutMs}ms`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

function promptText(input: string | AgentMessage[]): string {
	if (typeof input === "string") return input;
	return input
		.map(message => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map(block =>
					block && typeof block === "object" && "text" in block && typeof block.text === "string"
						? block.text
						: "",
				)
				.join("\n");
		})
		.join("\n");
}

const REASONING = "private reasoning";
const CYBER_POLICY_ERROR = "cyber_policy: This content was flagged for possible cybersecurity risk.";

type Reply = "answer" | "refuse" | "cyber";

/**
 * An advisor agent whose reply to each prompt `decide` picks from the prompt's text. A refusal is an
 * Anthropic classifier stop; `cyber` is OpenAI's `cyber_policy` denial.
 */
function scriptedAgent(decide: (text: string) => Reply): { agent: AdvisorAgent; inputs: string[] } {
	const inputs: string[] = [];
	const state: { messages: AgentMessage[]; error?: string } = { messages: [] };
	const agent: AdvisorAgent = {
		prompt: async input => {
			const text = promptText(input);
			inputs.push(text);
			const reply = decide(text);
			if (reply === "answer") {
				state.error = undefined;
				state.messages.push({
					role: "assistant",
					content: [],
					stopReason: "stop",
					timestamp: inputs.length + 1,
				} as unknown as AgentMessage);
				return;
			}
			state.error =
				reply === "cyber" ? CYBER_POLICY_ERROR : "Refusal (reasoning_extraction): reasoning may not be echoed";
			state.messages.push({
				role: "assistant",
				content: [],
				stopReason: "error",
				stopDetails: reply === "cyber" ? undefined : { type: "refusal", category: "reasoning_extraction" },
				errorMessage: state.error,
				timestamp: inputs.length + 1,
			} as unknown as AgentMessage);
		},
		abort: () => {},
		reset: () => {},
		rollbackTo: count => {
			state.messages.length = count;
			state.error = undefined;
		},
		state,
	};
	return { agent, inputs };
}

function primaryTurn(withReasoning: boolean): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: withReasoning
				? [
						{ type: "thinking", thinking: REASONING },
						{ type: "text", text: "answer" },
					]
				: [{ type: "text", text: "answer" }],
			timestamp: 1,
		} as AgentMessage,
	];
}

describe("an advisor resends a refused batch to the same model before its refusal cascade", () => {
	it("is answered by the same model on an unchanged resend", async () => {
		let sends = 0;
		const { agent, inputs } = scriptedAgent(() => (++sends === 1 ? "refuse" : "answer"));
		const failures: unknown[] = [];
		let fallbackCalls = 0;
		const messages = primaryTurn(true);
		const runtime = new AdvisorRuntime(
			agent,
			{
				snapshotMessages: () => messages,
				notifyFailure: error => failures.push(error),
				onTurnError: async () => {
					fallbackCalls++;
					return false;
				},
			},
			0,
		);

		runtime.onTurnEnd(messages);
		await settleUntil(() => runtime.backlog === 0);

		expect(inputs).toHaveLength(2);
		// Unchanged: the resend still carries the primary's reasoning, and no model switch was asked for.
		expect(inputs[1]).toBe(inputs[0]);
		expect(inputs[1]).toContain(REASONING);
		expect(fallbackCalls).toBe(0);
		expect(failures).toEqual([]);
	});

	it("strips the primary's reasoning only after two unchanged resends are refused", async () => {
		// The model refuses any batch that carries the reasoning, so only the strip recovers.
		const { agent, inputs } = scriptedAgent(text => (text.includes(REASONING) ? "refuse" : "answer"));
		const failures: unknown[] = [];
		let fallbackCalls = 0;
		const messages = primaryTurn(true);
		const runtime = new AdvisorRuntime(
			agent,
			{
				snapshotMessages: () => messages,
				notifyFailure: error => failures.push(error),
				onTurnError: async () => {
					fallbackCalls++;
					return false;
				},
			},
			0,
		);

		runtime.onTurnEnd(messages);
		await settleUntil(() => runtime.backlog === 0);

		expect(inputs).toHaveLength(4);
		expect(inputs.slice(0, 3).every(text => text === inputs[0] && text.includes(REASONING))).toBe(true);
		expect(inputs[3]).not.toContain(REASONING);
		expect(inputs[3]).toContain("answer");
		expect(fallbackCalls).toBe(0);
		expect(failures).toEqual([]);
	});

	it("gives a model the host switched to its own two resends", async () => {
		let identity = "model/a";
		const { agent, inputs } = scriptedAgent(() => "refuse");
		const failures: unknown[] = [];
		const switched: string[] = [];
		const sentTo: string[] = [];
		const messages = primaryTurn(false);
		const runtime = new AdvisorRuntime(
			{
				...agent,
				prompt: async input => {
					sentTo.push(identity);
					await agent.prompt(input);
				},
			},
			{
				snapshotMessages: () => messages,
				notifyFailure: error => failures.push(error),
				getModelIdentity: () => identity,
				onTurnError: async () => {
					if (switched.length > 0) return false;
					switched.push("model/b");
					identity = "model/b";
					return true;
				},
			},
			0,
		);

		runtime.onTurnEnd(messages);
		await settleUntil(() => failures.length === 1 && runtime.backlog === 0);

		// No reasoning to strip: three sends to each model, one switch between them.
		expect(sentTo).toEqual(["model/a", "model/a", "model/a", "model/b", "model/b", "model/b"]);
		expect(inputs).toHaveLength(6);
		expect(switched).toEqual(["model/b"]);
	});

	// Control: OpenAI's `cyber_policy` denial is never resent to the model that refused it.
	it("sends a cyber_policy denial once and resends nothing", async () => {
		const { agent, inputs } = scriptedAgent(() => "cyber");
		const failures: unknown[] = [];
		const messages = primaryTurn(false);
		const runtime = new AdvisorRuntime(
			agent,
			{
				snapshotMessages: () => messages,
				notifyFailure: error => failures.push(error),
				onTurnError: async () => false,
			},
			0,
		);

		runtime.onTurnEnd(messages);
		await settleUntil(() => failures.length === 1 && runtime.backlog === 0);

		expect(inputs).toHaveLength(1);
		expect(failures).toHaveLength(1);
	});
});
