/**
 * A classifier refusal's same-model retries count right when the close of an earlier retry is slow: the close
 * writes the retry's outcome (an `entry_patch` that sets `retryRecovery` on the refused attempt's entry), and the
 * test holds that write open while the run goes on. The reply after the tool is refused again, so a second retry
 * saga starts while the first one's close still waits on its write.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const REFUSAL: MockResponse = {
	content: [],
	stopReason: "error",
	stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined the request." },
	errorMessage: "Refusal (cyber): Classifier declined.",
};

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

describe("a classifier refusal's same-model retries while an earlier retry's close writes its outcome", () => {
	const primary = bundled("anthropic", "claude-sonnet-4-5");
	const fallback = bundled("openai", "gpt-4o-mini");
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	it("gives the second saga's refused model its own two retries, then walks the chain", async () => {
		const requested: string[] = [];
		// Saga 1: the first request is refused and its retry is served with a tool call; the close of saga 1 then
		// writes its outcome, held open. Saga 2: every later request to the primary is refused; the fallback answers.
		const respond = (model: Model): MockResponse => {
			const key = selector(model);
			const prior = requested.filter(entry => entry === key).length;
			requested.push(key);
			if (key === selector(fallback)) return { content: ["fallback answered"] };
			if (prior === 1) return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
			return REFUSAL;
		};
		const mock = createMockModel();
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Reads a file",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "notes" }], details: {} }),
		};
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const manager = SessionManager.inMemory();

		// Hold the first write of a retry's outcome until the second saga has announced its first retry.
		let outcomeWrites = 0;
		const outcomeHeld = Promise.withResolvers<void>();
		const releaseOutcome = Promise.withResolvers<void>();
		const patchEntries = manager.patchEntries.bind(manager);
		manager.patchEntries = (async (patches: Parameters<SessionManager["patchEntries"]>[0]) => {
			const outcome = patches.some(patch => patch.message?.retryRecovery !== undefined);
			if (outcome && outcomeWrites++ === 0) {
				outcomeHeld.resolve();
				await releaseOutcome.promise;
			}
			await patchEntries(patches);
		}) as SessionManager["patchEntries"];

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: [selector(fallback)] },
			"features.unexpectedStopDetection": "none",
			"todo.enabled": false,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent: new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: primary, systemPrompt: ["Test"], tools: [readTool], messages: [] },
				streamFn: (model, context, options) => {
					mock.push(respond(model));
					return mock.stream(model, context, options);
				},
				convertToLlm,
			}),
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const starts: number[] = [];
		const ends: Array<{ success: boolean; attempt: number }> = [];
		let heldWhenSecondSagaStarted = false;
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_retry_start") {
				starts.push(event.attempt);
				// The second saga's first retry: let the first saga's close finish now.
				if (starts.length === 2) {
					heldWhenSecondSagaStarted = outcomeWrites === 1;
					releaseOutcome.resolve();
				}
			}
			if (event.type === "auto_retry_end") ends.push({ success: event.success, attempt: event.attempt });
		});

		await session.prompt("Read notes.txt, then answer.");
		await session.waitForIdle();
		releaseOutcome.resolve();

		const p = selector(primary);
		expect({ heldWhenSecondSagaStarted, requested }).toEqual({
			heldWhenSecondSagaStarted: true,
			// Saga 1: refused, served (the tool call). Saga 2: refused, two same-model retries refused, then the walk.
			requested: [p, p, p, p, p, selector(fallback)],
		});
		expect(ends.map(end => end.success)).toEqual([true, true]);
	});
});
