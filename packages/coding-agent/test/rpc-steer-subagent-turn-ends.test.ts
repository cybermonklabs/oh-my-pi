/**
 * `steer_subagent` to a subagent homed on the main thread whose turn ends while
 * its own session prepares the message: the session, not the handler, decides
 * whether the message goes into a running turn or waits for the next run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

describe("steer_subagent to a main-thread subagent whose turn ends while its session prepares the message", () => {
	const subagentId = "Worker";
	const steerText = "Also check the README.";
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mock: MockModel;
	let session: AgentSession;
	let roster: RpcSubagentRegistry;
	/** Settled when the subagent's first model call starts; the call answers once `firstTurnGate` opens. */
	let firstCallStarted: PromiseWithResolvers<void>;
	let firstTurnGate: PromiseWithResolvers<void>;
	/** Settled when the subagent's first turn has ended. */
	let firstTurnEnded: PromiseWithResolvers<void>;
	/** Model calls made by the end of the first turn. */
	let callsByFirstTurnEnd = 0;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-rpc-steer-turn-ends-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		firstCallStarted = Promise.withResolvers<void>();
		firstTurnGate = Promise.withResolvers<void>();
		firstTurnEnded = Promise.withResolvers<void>();
		mock = createMockModel({
			responses: [
				async () => {
					firstCallStarted.resolve();
					await firstTurnGate.promise;
					return { content: ["Working."] };
				},
			],
			handler: { content: ["Done."] },
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }, assistantMessage()],
			},
			streamFn: mock.stream,
		});
		// A slash command the host sends runs in the subagent's prompt() before the
		// message is queued; this one lets the running turn end while it runs.
		const readme: LoadedCustomCommand = {
			path: "readme.ts",
			resolvedPath: path.join(tempDir.path(), "readme.ts"),
			source: "user",
			command: {
				name: "readme",
				description: "Ask for the README check",
				execute: async () => {
					firstTurnGate.resolve();
					await firstTurnEnded.promise;
					callsByFirstTurnEnd = mock.calls.length;
					return steerText;
				},
			},
		};
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			customCommands: [readme],
		});
		// This session's roster lists the subagent running, and its ref reads running.
		const sessionFile = path.join(tempDir.path(), `${subagentId}.jsonl`);
		const eventBus = new EventBus();
		roster = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: subagentId,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		AgentRegistry.global().register({
			id: subagentId,
			displayName: subagentId,
			kind: "sub",
			session,
			sessionFile,
			status: "running",
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		roster.dispose();
		await session.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	test("holds the message for the run's next prompt, which takes it, instead of starting a turn of its own", async () => {
		// If this regresses, a host that steers a subagent mid-turn sees the subagent
		// answer the message in a turn of its own when that turn ends while the
		// message is being prepared, and the run's next prompt (the executor's yield
		// reminder) fails with AgentBusyError, so the subagent stops without doing
		// what was asked.
		const firstTurn = session.prompt("Do the task.").finally(() => firstTurnEnded.resolve());
		await firstCallStarted.promise;
		expect(session.isStreaming).toBe(true);

		const answer = handleRpcSteerSubagent(roster, subagentId, "/readme");
		const queued = Promise.withResolvers<void>();
		const check = () => {
			if (session.agent.peekSteeringQueue().length > 0) queued.resolve();
		};
		const unsubscribe = session.agent.onQueueChange(check);
		check();
		await Promise.race([queued.promise, answer]);
		unsubscribe();
		await firstTurn;

		// The message waits on the queue: no turn ran for it.
		expect(session.getQueuedMessages().steering).toEqual([steerText]);
		expect(session.isStreaming).toBe(false);
		expect(mock.calls).toHaveLength(callsByFirstTurnEnd);

		// The executor's next prompt runs and takes the message into its first model call.
		const nextPrompt = await session.prompt("Submit your result.").then(
			() => "accepted",
			(error: unknown) => String(error),
		);
		expect(nextPrompt).toBe("accepted");
		await session.waitForIdle();
		expect(await answer).toBeUndefined();
		const request = mock.calls[callsByFirstTurnEnd]?.context.messages.map(messageText) ?? [];
		expect(request.filter(text => text === steerText)).toHaveLength(1);
		expect(request).toContain("Submit your result.");
		expect(session.agent.peekSteeringQueue()).toEqual([]);
	});
});
