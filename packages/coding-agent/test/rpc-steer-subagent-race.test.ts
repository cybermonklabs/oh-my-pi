/**
 * Race tests of the `steer_subagent` take-back on a real AgentSession idle
 * between turns: another sender's message of the same text sits on the same
 * steering queue when the subagent's run ends without taking the steer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

describe("handleRpcSteerSubagent take-back beside another sender's message of the same text", () => {
	const subagentId = "Worker";
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mock: MockModel;
	let session: AgentSession;
	let roster: RpcSubagentRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-rpc-steer-race-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		mock = createMockModel({ handler: { content: ["Done."] } });
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		// The subagent is idle between two turns of its run, and this session's roster lists it running.
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
			status: "idle",
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

	test("takes back its own message and leaves another sender's message of the same text for the next run", async () => {
		// Regression: a host steers a subagent that another sender (Agent Hub chat, a
		// second host) already gave the same words; the subagent's run ends before
		// taking the steer, and the take-back removes the other sender's message,
		// so the subagent never sees it, while the host's own message is delivered
		// to a later, unrelated run.
		const text = "Also check the README.";
		const theirs: AgentMessage[] = [];
		await session.steer(text, undefined, {
			holdUntilNextRun: true,
			onPromptQueued: queued => theirs.push(...queued),
		});
		expect(theirs).toHaveLength(1);
		const ours = handleRpcSteerSubagent(roster, subagentId, text);
		// The race: the run ends (its drive over) while both messages are queued.
		const queued = Promise.withResolvers<void>();
		const check = () => {
			if (session.agent.peekSteeringQueue().length >= 2) queued.resolve();
		};
		const unsubscribe = session.agent.onQueueChange(check);
		check();
		await queued.promise;
		unsubscribe();
		expect(AgentRegistry.global().markRunEnded(subagentId, session)).toBe(true);

		expect(await ours).toBe(`Subagent's run ended before the message reached it: ${subagentId}`);
		// Exactly the other sender's message waits, by identity.
		expect(session.agent.peekSteeringQueue()).toEqual(theirs);
		expect(session.agent.peekSteeringQueue()[0]).toBe(theirs[0]);

		// The next run carries the other sender's message once, and nothing of ours.
		const callsBefore = mock.calls.length;
		await session.prompt("Next assignment.");
		await session.waitForIdle();
		const requests = mock.calls.slice(callsBefore).map(call => call.context.messages.map(messageText));
		expect(requests.length).toBeGreaterThan(0);
		expect(requests[0]!.filter(message => message === text)).toHaveLength(1);
		expect(session.agent.peekSteeringQueue()).toEqual([]);
	});
});
