import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { handleRpcCancelSubagent, handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SteerOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("handleRpcCancelSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let frames: RpcSubagentFrame[];
	let calls: string[];
	/** Real directory: releasing a tombstone persists `<sessionFile>.tombstone`. */
	let sessionDir: string;
	let ownSessionFile: string;

	beforeEach(() => {
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-cancel-"));
		ownSessionFile = path.join(sessionDir, "SubagentA.jsonl");
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		calls = [];
		frames = [];
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
	});

	afterEach(() => {
		registry.dispose();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(sessionDir);
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"], sessionFile = ownSessionFile): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	/** Register a live subagent whose session records abort/dispose calls. */
	function registerLiveAgent(id: string, sessionFile = ownSessionFile): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				abort: async () => {
					calls.push(`abort:${id}`);
				},
				dispose: async () => {
					calls.push(`dispose:${id}`);
				},
			} as never,
			sessionFile,
			status: "running",
		});
	}

	/**
	 * Run a synchronous subagent through the real executor. Its first turn starts
	 * an eval `agent()` job, registered as `runEvalAgent` registers it (owned by
	 * the subagent), and ends, so the executor waits for that job while the
	 * run-state mirror holds the subagent's ref `idle`. Once the job completes,
	 * its delivered result wakes the subagent, whose next turn yields; a job
	 * that ends without a result leaves the executor to send its yield reminder.
	 *
	 * The session mirrors AgentSession's steering queue: a steer queues a
	 * steering user message (reported through `onPromptQueued`); each turn takes
	 * the queued steers before its first model call and emits each as
	 * `message_start`/`message_end`; a steer queued without `holdUntilNextRun`
	 * on the idle session is drained into a turn of its own; and a prompt while
	 * a turn streams meets `AgentBusyError`.
	 */
	function startSubagentAwaitingEvalJob() {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = "Worker";
		const childId = "Worker.Child";
		const childResult = Promise.withResolvers<string>();
		const awaitingJob = Promise.withResolvers<void>();
		const steerQueued = Promise.withResolvers<void>();
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const runStateListeners = new Set<(state: "running" | "idle") => void>();
		const setRunState = (state: "running" | "idle") => {
			for (const listener of runStateListeners) listener(state);
		};
		/** Each turn the subagent ran: what started it, and the texts of the steers it took before its first model call. */
		const turns: Array<{ source: "prompt" | "drain" | "job result"; steers: string[] }> = [];
		/** Queued steers: the text each was sent with and the user message the queue holds for it. */
		const queuedSteers: Array<{ text: string; message: UserMessage }> = [];
		const busyPrompts: string[] = [];
		let streaming = false;
		const runTurn = (source: (typeof turns)[number]["source"], during?: () => void) => {
			streaming = true;
			setRunState("running");
			for (const listener of listeners) listener({ type: "agent_start" } as AgentSessionEvent);
			const steers = queuedSteers.splice(0);
			for (const { message } of steers) {
				for (const listener of listeners) {
					listener({ type: "message_start", message } as AgentSessionEvent);
					listener({ type: "message_end", message } as AgentSessionEvent);
				}
			}
			turns.push({ source, steers: steers.map(steer => steer.text) });
			during?.();
			setRunState("idle");
			streaming = false;
		};
		const startEvalJob = () => {
			manager.register(
				"task",
				childId,
				async ({ signal, markRunning }) => {
					markRunning();
					const cancelled = Promise.withResolvers<never>();
					signal.addEventListener("abort", () => cancelled.reject(new Error("cancelled")), { once: true });
					return await Promise.race([childResult.promise, cancelled.promise]);
				},
				{ id: childId, agentId: childId, ownerId: id },
			);
		};
		const emitYield = () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { child: childId } },
					},
				} as AgentSessionEvent);
			}
		};
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["eval", "yield"],
			getEnabledToolNames: () => ["eval", "yield"],
			getMountedXdevToolNames: () => [],
			getToolByName: () => undefined,
			setActiveToolsByName: async () => {},
			setWorkPoolYieldItems: () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
			prompt: async (text: string) => {
				if (streaming) {
					busyPrompts.push(text);
					throw new AgentBusyError();
				}
				// The first prompt is the assignment, whose eval cell starts the job.
				runTurn("prompt", turns.length === 0 ? startEvalJob : undefined);
				return true;
			},
			steer: async (text: string, _images?: unknown, options?: SteerOptions) => {
				const message: UserMessage = {
					role: "user",
					content: [{ type: "text", text }],
					steering: true,
					attribution: "user",
					timestamp: Date.now(),
				};
				queuedSteers.push({ text, message });
				options?.onPromptQueued?.([message]);
				steerQueued.resolve();
				if (!options?.holdUntilNextRun && !streaming) runTurn("drain");
			},
			removeQueuedMessage: (text: string) => {
				const index = queuedSteers.findIndex(steer => steer.text === text);
				if (index >= 0) queuedSteers.splice(index, 1);
				return index >= 0;
			},
			waitForIdle: async () => {},
			isAdvisorActive: () => false,
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			hasPendingAsyncWork: () => manager.getRunningJobs({ ownerId: id }).length > 0,
			getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
			settleAsyncWork: async () => {
				awaitingJob.resolve();
				await manager.waitForOwnerJobs(id, { excludeSuppressed: true });
				// The job's delivered result wakes the subagent; that turn yields.
				if (manager.getJob(childId)?.status === "completed") runTurn("job result", emitYield);
			},
			abort: async () => {},
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
			holdIrcWakes: () => () => {},
			trackIrcReply: () => {},
			subscribeRunState: (listener: (state: "running" | "idle") => void) => {
				runStateListeners.add(listener);
				return () => runStateListeners.delete(listener);
			},
			addDisposer: () => {},
		} as unknown as AgentSession;
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
		// Synchronous: the parent awaits the run directly.
		const run = runSubprocess({
			cwd: sessionDir,
			agent,
			task: "work",
			index: 0,
			id,
			eventBus,
			artifactsDir: sessionDir,
			asyncJobManager: manager,
			signal: teardown.signal,
		});
		return {
			id,
			run,
			turns,
			/** Steers still waiting on the session's queue. */
			queuedSteers,
			busyPrompts,
			/** The eval `agent()` job on the parent's job manager. */
			evalJob: () => manager.getJob(childId),
			/** Resolves once the executor waits for the job with the subagent between turns. */
			awaitingJob: awaitingJob.promise,
			/** Resolves once a steer reached the subagent's session. */
			steerQueued: steerQueued.promise,
			finishChild: childResult.resolve,
			/** End the job without a result to deliver (cancelled). */
			endJobWithoutResult: () => manager.cancel(childId),
			/** Someone other than the steer's sender takes its message off the queue. */
			takeBackElsewhere: (text: string) => session.removeQueuedMessage(text, "steering"),
			/** Test teardown: end a run the case left unsettled, and its job. */
			async stop(): Promise<void> {
				teardown.abort();
				manager.cancelAll();
				await Promise.allSettled([run]);
				await manager.dispose({ timeoutMs: 1000 });
			},
		};
	}

	test("aborts a running subagent and leaves an aborted tombstone", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(true);

		expect(calls).toEqual(["abort:SubagentA", "dispose:SubagentA"]);
		const ref = AgentRegistry.global().get("SubagentA");
		expect(ref?.status).toBe("aborted");
		expect(ref?.session).toBeNull();
	});

	test("does not touch another session's same-name subagent", async () => {
		// This session's roster lists SubagentA, but the process-global registry
		// now holds a different session's agent under the same id.
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("running");
	});

	test("does not let the run's result be accepted while the abort settles", async () => {
		emitLifecycle("SubagentA", "started");
		let acceptedDuringAbort: boolean | undefined;
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: {
				// The executor may accept a yield that lands while the abort is in flight.
				abort: async () => {
					acceptedDuringAbort = AgentRegistry.global().markResultAccepted("SubagentA");
				},
				dispose: async () => {},
			} as never,
			sessionFile: ownSessionFile,
			status: "running",
		});

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(true);

		expect(acceptedDuringAbort).toBe(false);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("aborted");
	});

	test("reports a failed tombstone write as an error while the abort is still settling", async () => {
		// The tombstone sidecar lands next to the transcript; a missing directory
		// makes the write fail with ENOENT. release() disposes the session after
		// that failure and then rejects, so the abort stays pending until dispose
		// ran plus one macrotask hop: the release rejection lands mid-abort.
		const missingDirSessionFile = path.join(sessionDir, "missing", "SubagentA.jsonl");
		emitLifecycle("SubagentA", "started", missingDirSessionFile);
		const disposed = Promise.withResolvers<void>();
		const nextMacrotask = () => new Promise<void>(resolve => setImmediate(resolve));
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: {
				abort: async () => {
					await disposed.promise;
					await nextMacrotask();
					calls.push("abort:SubagentA");
				},
				dispose: async () => {
					calls.push("dispose:SubagentA");
					disposed.resolve();
				},
			} as never,
			sessionFile: missingDirSessionFile,
			status: "running",
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(handleRpcCancelSubagent(registry, "SubagentA")).rejects.toMatchObject({ code: "ENOENT" });
			await nextMacrotask();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
		expect(calls).toEqual(["dispose:SubagentA", "abort:SubagentA"]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("aborted");
	});

	test("is a no-op for a second cancel of the same subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		await handleRpcCancelSubagent(registry, "SubagentA");
		calls = [];

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);
		expect(calls).toEqual([]);
	});

	test("does not tombstone a subagent whose result was accepted before its terminal frame", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		// Yield acceptance flips the ref to idle while the roster still lists it.
		AgentRegistry.global().markResultAccepted("SubagentA");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("idle");
	});

	test("does not touch a live agent this session never reported", async () => {
		registerLiveAgent("Stranger");

		await expect(handleRpcCancelSubagent(registry, "Stranger")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("Stranger")?.status).toBe("running");
	});

	test("does not touch a subagent that already finished", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);
		expect(calls).toEqual([]);
	});

	test("settles a foreground nested task run as aborted and emits the aborted lifecycle frame", async () => {
		const id = "Worker.Child";
		const artifactsDir = sessionDir;
		const promptEntered = Promise.withResolvers<void>();
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		// Minimal session whose turn never finishes on its own: only a cancel can end the run.
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			getMountedXdevToolNames: () => [],
			getToolByName: () => undefined,
			setActiveToolsByName: async () => {},
			setWorkPoolYieldItems: () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
			prompt: async () => {
				promptEntered.resolve();
				await Promise.withResolvers<never>().promise;
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
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: path.join(artifactsDir, `${id}.jsonl`),
			status: "running",
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		registry.setSubscriptionLevel("progress");
		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

		// Foreground: awaited directly, with no async job behind it.
		const run = runSubprocess({ cwd: artifactsDir, agent, task: "work", index: 0, id, eventBus, artifactsDir });
		await promptEntered.promise;

		await expect(handleRpcCancelSubagent(registry, id)).resolves.toBe(true);

		const result = await run;
		expect(result.aborted).toBe(true);
		expect(frames.filter(frame => frame.type === "subagent_lifecycle").map(frame => frame.payload.status)).toEqual([
			"started",
			"aborted",
		]);
		expect(registry.getSubagents()).toEqual([]);
	});

	test("cancels a subagent idle between turns while its eval agent() job runs, and ends the job", async () => {
		const subagent = startSubagentAwaitingEvalJob();
		try {
			await subagent.awaitingJob;
			expect(registry.getSubagents().map(({ id, status }) => ({ id, status }))).toEqual([
				{ id: subagent.id, status: "running" },
			]);
			expect(AgentRegistry.global().get(subagent.id)?.status).toBe("idle");
			const job = subagent.evalJob();
			expect(job?.status).toBe("running");

			await expect(handleRpcCancelSubagent(registry, subagent.id)).resolves.toBe(true);

			await job?.promise;
			expect(job?.status).toBe("cancelled");
			expect((await subagent.run).aborted).toBe(true);
			expect(registry.getSubagents()).toEqual([]);
			expect(AgentRegistry.global().get(subagent.id)?.status).toBe("aborted");
		} finally {
			await subagent.stop();
		}
	}, 15_000);

	test("refuses a subagent idle between turns once the parent accepted its result", async () => {
		const subagent = startSubagentAwaitingEvalJob();
		let atAcceptance:
			| { listed: string | undefined; refStatus: string; holdsSession: boolean; cancelled: Promise<boolean> }
			| undefined;
		// The host's cancel lands once the result is accepted, before the terminal
		// lifecycle frame prunes the roster.
		const unsubscribe = AgentRegistry.global().onChange(event => {
			if (atAcceptance || event.ref.id !== subagent.id || event.ref.lifecycle?.acceptedAt === undefined) return;
			atAcceptance = {
				listed: registry.getSubagents().find(snapshot => snapshot.id === subagent.id)?.status,
				refStatus: event.ref.status,
				holdsSession: event.ref.session !== null,
				cancelled: handleRpcCancelSubagent(registry, subagent.id),
			};
		});
		try {
			await subagent.awaitingJob;
			subagent.finishChild("child done");
			const result = await subagent.run;

			expect(result.aborted).toBe(false);
			expect(atAcceptance).toMatchObject({ listed: "running", refStatus: "idle", holdsSession: true });
			await expect(atAcceptance?.cancelled).resolves.toBe(false);
			expect(AgentRegistry.global().get(subagent.id)?.status).toBe("idle");
		} finally {
			unsubscribe();
			await subagent.stop();
		}
	}, 15_000);

	test("steer_subagent queues its message for the executor's next prompt to a subagent idle between turns", async () => {
		const subagent = startSubagentAwaitingEvalJob();
		const message = "Also check the README.";
		try {
			await subagent.awaitingJob;
			expect(AgentRegistry.global().get(subagent.id)?.status).toBe("idle");
			const answer = handleRpcSteerSubagent(registry, subagent.id, message);
			// A refusal answers at once; an accepted steer waits on the queue.
			await Promise.race([answer, subagent.steerQueued]);
			expect(subagent.turns).toEqual([{ source: "prompt", steers: [] }]);

			// The job ends with nothing to deliver, so the executor sends its yield reminder next.
			subagent.endJobWithoutResult();

			await expect(answer).resolves.toBeUndefined();
			expect(subagent.turns[1]).toEqual({ source: "prompt", steers: [message] });
			expect(subagent.busyPrompts).toEqual([]);
		} finally {
			await subagent.stop();
		}
	}, 15_000);

	test("steer_subagent takes its message back and answers an error when the subagent stops before its next turn", async () => {
		const subagent = startSubagentAwaitingEvalJob();
		try {
			await subagent.awaitingJob;
			const answer = handleRpcSteerSubagent(registry, subagent.id, "Also check the README.");
			await Promise.race([answer, subagent.steerQueued]);

			await expect(handleRpcCancelSubagent(registry, subagent.id)).resolves.toBe(true);

			await expect(answer).resolves.toBe(`Subagent's run ended before the message reached it: ${subagent.id}`);
			expect(subagent.queuedSteers).toEqual([]);
			expect(subagent.turns).toHaveLength(1);
		} finally {
			await subagent.stop();
		}
	}, 15_000);

	test("steer_subagent answers an error when someone else takes its message back and the run then ends", async () => {
		const subagent = startSubagentAwaitingEvalJob();
		const message = "Also check the README.";
		try {
			await subagent.awaitingJob;
			const answer = handleRpcSteerSubagent(registry, subagent.id, message);
			await Promise.race([answer, subagent.steerQueued]);
			expect(subagent.takeBackElsewhere(message)).toBe(true);

			// The job's result wakes the subagent; that turn yields and the parent accepts it.
			subagent.finishChild("child done");
			expect((await subagent.run).aborted).toBe(false);

			await expect(answer).resolves.toBe(`The message was not delivered to subagent: ${subagent.id}`);
			expect(subagent.turns.map(turn => turn.steers)).toEqual([[], []]);
		} finally {
			await subagent.stop();
		}
	}, 15_000);
});
