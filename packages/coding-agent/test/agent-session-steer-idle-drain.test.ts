import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: a steer can land on an idle session — the submit path checks
 * `isStreaming` before `#queueSteer`'s (potentially slow) image normalization,
 * so the turn may end in between. Unlike `#queueFollowUp`, `#queueSteer` had no
 * idle drain: the message stranded in the queue (visible chip, never delivered)
 * until the next manual prompt.
 *
 * Contract: steering an idle session schedules an immediate `agent.continue()`,
 * so a queued steer is delivered without waiting for the next manual prompt. A
 * queued steer resumes from any tail (continue() injects it before the next
 * provider call), so there is no "non-resumable steer" case. While a turn is
 * still streaming the drain stands down and the steer simply stays queued.
 */

function createAssistantMessage(): AssistantMessage {
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

function createToolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "Interrupted" }],
		isError: true,
		timestamp: Date.now(),
	};
}

describe("AgentSession steer idle drain", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-steer-idle-drain-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	async function createSession(
		messages: Parameters<typeof Agent.prototype.appendMessage>[0][],
		streamFn?: MockModel["stream"],
	): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("delivers a steer queued on an idle resumable session via continue()", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("steer me please");

		// Drained without waiting for the next manual prompt.
		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("delivers successive idle steers after each successful drain", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("first steer");
		vi.advanceTimersByTime(200);
		await session.waitForIdle();

		await session.steer("second steer");
		vi.advanceTimersByTime(200);
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(2);
	});

	it("delivers a steer queued after an interrupted tool result", async () => {
		await createSession([
			{ role: "user", content: "hello", timestamp: Date.now() },
			createAssistantMessage(),
			createToolResultMessage(),
		]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("deliver after interrupt");

		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("round-trips queued images through clearQueue for editor restoration", async () => {
		// A steer queued mid-stream stays in the queue (the idle drain stands down while
		// streaming), so clearQueue round-trips session.steer's normalized image payload
		// for editor restoration. A parked model turn gives a deterministic streaming
		// state. Real timers here: the prompt/stream path awaits real timers that the
		// suite's fake clock would gate (it hangs otherwise), and the parked turn is
		// cancelled by abort via the AbortSignal — never waited on — so there is no 60s wait.
		vi.useRealTimers();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const running = session.prompt("do the thing");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		await session.steer("with image", [image]);

		const { steering } = session.clearQueue();
		expect(steering).toEqual([{ text: "with image", images: [image] }]);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});
	});

	it("keeps a next-run steer for the next prompt's request instead of starting a turn, and emits it when that run takes it", async () => {
		const mock = createMockModel({ handler: { content: ["Done."] } });
		await createSession(
			[{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()],
			mock.stream,
		);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});
		const emitted: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "message_end") emitted.push(event.message);
		});
		let queued: readonly unknown[] = [];

		await session.steer("Also check the README.", undefined, {
			holdUntilNextRun: true,
			onPromptQueued: messages => {
				queued = messages;
			},
		});
		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(0);
		expect(queued).toHaveLength(1);
		expect(emitted.includes(queued[0])).toBe(false);

		// Real timers: the prompt path awaits timers the fake clock would gate.
		vi.useRealTimers();
		await session.prompt("Submit your result.");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		const request = mock.calls[0]!.context.messages.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "")).join(""),
		);
		expect(request.some(text => text.includes("Submit your result."))).toBe(true);
		expect(request.some(text => text.includes("Also check the README."))).toBe(true);
		// The run reports the queued message object itself as it takes it.
		expect(emitted.includes(queued[0])).toBe(true);
	});

	it("starts no turn for a next-run steer when the session aborts", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("Also check the README.", undefined, { holdUntilNextRun: true });
		await session.abort();
		vi.advanceTimersByTime(200);
		await session.waitForIdle();

		expect(continueSpy).not.toHaveBeenCalled();
		// Still waiting for the next run, and its sender can take it back.
		expect(session.removeQueuedMessage("Also check the README.", "steering")).toBe(true);
	});
});
