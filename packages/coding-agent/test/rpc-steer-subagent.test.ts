import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import {
	type AgentSession,
	type AgentSessionEvent,
	PromptDroppedError,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { QueuedMessageTarget, SteerOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

interface SentMessage {
	id: string;
	text: unknown;
	streamingBehavior: unknown;
}

/**
 * How the fake session answers `prompt`. `dropped` mirrors AgentSession: a
 * prompt dropped before dispatch (abort, disposal, usage preflight denial)
 * resolves `true` unless `throwOnDrop` asks for a {@link PromptDroppedError}.
 */
type Delivery = "queued" | "turn-started" | "dropped";

describe("handleRpcSteerSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let sent: SentMessage[];
	let sessionDir: string;
	let ownSessionFile: string;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		sent = [];
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-steer-"));
		ownSessionFile = path.join(sessionDir, "SubagentA.jsonl");
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(sessionDir);
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"]): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile: ownSessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	/**
	 * Register a live subagent whose session records `prompt` calls.
	 * `queued` resolves as a mid-turn steer does; `turn-started` emits
	 * `agent_start` and never settles, like a whole new turn. `isStreaming`
	 * says whether the session is in a turn, which a steer goes into.
	 */
	function registerLiveAgent(
		id: string,
		sessionFile = ownSessionFile,
		delivery: Delivery = "queued",
		isStreaming = true,
	): void {
		const listeners: Array<(event: { type: string }) => void> = [];
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				isStreaming,
				subscribe: (listener: (event: { type: string }) => void) => {
					listeners.push(listener);
					return () => listeners.splice(listeners.indexOf(listener), 1);
				},
				prompt: async (text: unknown, options: { streamingBehavior?: unknown; throwOnDrop?: boolean }) => {
					sent.push({ id, text, streamingBehavior: options.streamingBehavior });
					if (delivery === "turn-started") {
						for (const listener of listeners) listener({ type: "agent_start" });
						await Promise.withResolvers<void>().promise;
					}
					if (delivery === "dropped" && options.throwOnDrop) throw new PromptDroppedError();
					return true;
				},
			} as never,
			sessionFile,
			status: "running",
		});
	}

	test("steers the subagent's own session with the message untrimmed", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		const message = "  fn main() {\n      todo!()\n  }\n";

		await expect(handleRpcSteerSubagent(registry, "SubagentA", message)).resolves.toBeUndefined();

		expect(sent).toEqual([{ id: "SubagentA", text: message, streamingBehavior: "steer" }]);
	});

	test("accepts once a new turn starts, without waiting for the turn", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", ownSessionFile, "turn-started");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "go")).resolves.toBeUndefined();
	});

	test("reports a prompt the subagent dropped before dispatch as refused", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", ownSessionFile, "dropped");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "go")).resolves.toBe(
			`Subagent refused the message: ${new PromptDroppedError().message}`,
		);
	});

	test("does not deliver when the id changes owner while the subagent is brought live", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		const original = AgentRegistry.global().get("SubagentA")?.session;
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async () => {
			// Another session's same-name agent replaces the ref during the await.
			registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));
			return original as never;
		});

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hi")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("does not reach another session's same-name subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hi")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("does not reach a live agent this session never reported", async () => {
		registerLiveAgent("Stranger");

		await expect(handleRpcSteerSubagent(registry, "Stranger", "hi")).resolves.toBe("Subagent not running: Stranger");
		expect(sent).toEqual([]);
	});

	test("does not reach a subagent that already finished", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("does not start a turn on a subagent whose result was accepted before its terminal frame", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", ownSessionFile, "queued", false);
		// Yield acceptance flips the ref to idle while the roster still lists it.
		AgentRegistry.global().markResultAccepted("SubagentA");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("queues the message for the first turn of a subagent listed running before that turn starts", async () => {
		// Regression: a host steers a subagent that `get_subagents` lists running
		// while its executor still sets it up. The ref reads running but no turn
		// streams, so the steer starts a turn of its own, and the executor's
		// assignment prompt then meets AgentBusyError: the run fails without
		// doing its task.
		const id = "Worker";
		const message = "Also check the README.";
		const setupReached = Promise.withResolvers<void>();
		const setupDone = Promise.withResolvers<void>();
		const steerQueued = Promise.withResolvers<void>();
		/** A turn the host's message starts runs until the case ends it, as a model answer takes time. */
		const hostTurnDone = Promise.withResolvers<void>();
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const emit = (event: unknown) => {
			for (const listener of listeners) listener(event as AgentSessionEvent);
		};
		/** The texts of the steers each turn took before its first model call. */
		const turns: string[][] = [];
		const queuedSteers: Array<{ text: string; message: UserMessage; queueId?: string; onTaken?: () => void }> = [];
		let streaming = false;
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			get isStreaming() {
				return streaming;
			},
			sessionManager: { appendSessionInit: () => {} },
			// `todo` belongs to the parent: the executor drops it between listing
			// the run and sending its first prompt, and this stub holds it there.
			getActiveToolNames: () => ["read", "todo", "yield"],
			getEnabledToolNames: () => ["read", "todo", "yield"],
			getMountedXdevToolNames: () => [],
			getToolByName: () => undefined,
			setActiveToolsByName: async () => {
				setupReached.resolve();
				await setupDone.promise;
			},
			setWorkPoolYieldItems: () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async (text: string) => {
				if (streaming) throw new AgentBusyError();
				streaming = true;
				emit({ type: "agent_start" });
				const steers = queuedSteers.splice(0);
				for (const steer of steers) {
					emit({ type: "message_start", message: steer.message });
					emit({ type: "message_end", message: steer.message });
					steer.onTaken?.();
				}
				turns.push(steers.map(steer => steer.text));
				if (text === message) {
					await hostTurnDone.promise;
				} else {
					emit({
						type: "tool_execution_end",
						toolCallId: "yield-1",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { done: true } },
						},
					});
				}
				streaming = false;
				return true;
			},
			steer: async (text: string, _images?: unknown, options?: SteerOptions) => {
				const steerMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text }],
					steering: true,
					attribution: "user",
					timestamp: Date.now(),
				};
				queuedSteers.push({ text, message: steerMessage, queueId: options?.queueId, onTaken: options?.onTaken });
				options?.onPromptQueued?.([steerMessage]);
				steerQueued.resolve();
			},
			removeQueuedMessage: (target: QueuedMessageTarget) => {
				const index = queuedSteers.findIndex(steer =>
					typeof target === "string" ? steer.text === target : steer.queueId === target.queueId,
				);
				if (index >= 0) queuedSteers.splice(index, 1);
				return index >= 0;
			},
			waitForIdle: async () => {},
			isAdvisorActive: () => false,
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			hasPendingAsyncWork: () => false,
			getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
			settleAsyncWork: async () => {},
			abort: async () => {},
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
			holdIrcWakes: () => () => {},
			trackIrcReply: () => {},
			subscribeRunState: () => () => {},
			addDisposer: () => {},
		} as unknown as AgentSession;
		// A new session's ref reads running from its registration, before its first turn.
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: path.join(sessionDir, `${id}.jsonl`),
			status: "running",
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const teardown = new AbortController();
		const run = runSubprocess({
			cwd: sessionDir,
			agent,
			task: "work",
			index: 0,
			id,
			eventBus,
			artifactsDir: sessionDir,
			signal: teardown.signal,
		});
		try {
			await setupReached.promise;
			expect(registry.getSubagents().map(({ id, status }) => ({ id, status }))).toEqual([{ id, status: "running" }]);
			expect(AgentRegistry.global().get(id)?.status).toBe("running");
			expect(session.isStreaming).toBe(false);

			const answer = handleRpcSteerSubagent(registry, id, message);
			// A steer into a running turn answers once the turn starts; one between turns waits on the queue.
			await Promise.race([answer, steerQueued.promise]);
			setupDone.resolve();

			const result = await run;
			expect(result).toMatchObject({ exitCode: 0, aborted: false });
			await expect(answer).resolves.toBeUndefined();
			expect(turns).toEqual([[message]]);
		} finally {
			// End the run the case may leave unsettled.
			teardown.abort();
			setupDone.resolve();
			hostTurnDone.resolve();
			await Promise.allSettled([run]);
		}
	}, 30_000);
});
