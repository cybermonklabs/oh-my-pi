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

describe("handleRpcSteerSubagent with two steers of the same text", () => {
	const subagentId = "Worker";
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mock: MockModel;
	let session: AgentSession;
	let eventBus: EventBus;
	let roster: RpcSubagentRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-rpc-steer-same-text-");
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
			// A run takes one queued steer at each step boundary, as AgentSession does by default.
			steeringMode: "one-at-a-time",
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});

		// The subagent is idle between two turns of its run (waiting for its own
		// jobs), and this session's roster lists it running.
		const sessionFile = path.join(tempDir.path(), `${subagentId}.jsonl`);
		eventBus = new EventBus();
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

	/** Resolves once the subagent's steering queue holds `count` messages. */
	function untilSteeringQueued(count: number): Promise<void> {
		const queued = Promise.withResolvers<void>();
		const check = () => {
			if (session.agent.peekSteeringQueue().length < count) return;
			unsubscribe();
			queued.resolve();
		};
		const unsubscribe = session.agent.onQueueChange(check);
		check();
		return queued.promise;
	}

	test("a second steer the run never took answers an error, is taken back, and reaches no later run", async () => {
		// Regression: a host that sends the same steer_subagent text twice within one
		// millisecond gets success for the second although the subagent never saw it,
		// and that message then turns up in a later, unrelated run of the subagent.
		const text = "Also check the README.";
		// The run ends right after it takes the first steer (a terminal yield's
		// turn-stop or a budget stop ends it the same way), before its next step
		// boundary could take the second.
		let taken = 0;
		session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			if (messageText(event.message) !== text) return;
			taken++;
			if (taken === 1) void session.abort();
		});

		// Both frames are handled within one clock millisecond.
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const first = handleRpcSteerSubagent(roster, subagentId, text);
		const second = handleRpcSteerSubagent(roster, subagentId, text);
		await untilSteeringQueued(2);
		now.mockRestore();

		// The executor's next prompt starts the run that takes the first steer.
		await session.prompt("Submit your result.");
		await session.waitForIdle();
		// The run's drive is over: it takes no further turn.
		expect(AgentRegistry.global().markRunEnded(subagentId, session)).toBe(true);
		const [firstAnswer, secondAnswer] = await Promise.all([first, second]);

		expect(taken).toBe(1);
		expect(firstAnswer).toBeUndefined();
		// The second message never reached the run: no success for it.
		expect(secondAnswer).toEqual(expect.any(String));
		// Taken back off the queue.
		expect(session.getQueuedMessages().steering).not.toContain(text);

		// A later run of the same subagent does not carry it.
		const callsBefore = mock.calls.length;
		await session.prompt("Next assignment.");
		await session.waitForIdle();
		const laterRequests = mock.calls.slice(callsBefore).map(call => call.context.messages.map(messageText));
		expect(laterRequests.length).toBeGreaterThan(0);
		for (const request of laterRequests) {
			// The first steer stays in the history; the second never joins it.
			expect(request.filter(message => message === text)).toHaveLength(1);
			expect(request.slice(request.indexOf("Next assignment."))).not.toContain(text);
		}
	});
});
