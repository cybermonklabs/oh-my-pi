import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { InternalUrlRouter } from "../../src/internal-urls";
import { IrcBus } from "../../src/irc/bus";
import { handleRpcSteerSubagent } from "../../src/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "../../src/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { deobfuscateAssistantContent } from "../../src/secrets/message-transform";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import type { AgentSessionDisposeOptions } from "../../src/session/agent-session-types";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { sessionMessagePersistenceKey } from "../../src/session/turn-persistence";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { runEach } from "../helpers/cleanup";

/** The timeout of each case's teardown: far past what its cleanups take. */
const TEARDOWN_TIMEOUT_MS = 30_000;

/** What each case acquired, released newest first by `afterEach`, each on its own. */
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(
	() =>
		runEach([
			...cleanups.splice(0).reverse(),
			() => AgentLifecycleManager.resetGlobalForTests(),
			() => AgentRegistry.resetGlobalForTests(),
			() => IrcBus.resetGlobalForTests(),
		]),
	TEARDOWN_TIMEOUT_MS,
);

/** A bridge worker, terminated by the case's cleanups; its 20 s start cap is below each worker case's 60 s timeout. */
async function startWorker(): Promise<{ worker: SubagentWorker; probe: AgentsProbe }> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 20_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return { worker, probe: await probe.promise };
}

/**
 * Poll a condition fed by another thread (mirror patches, worker-side state).
 * There is no in-process clock to fake across a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function liveRef(id: string): AgentRef {
	const ref = AgentRegistry.global().get(id);
	if (!ref) throw new Error(`no ref ${id}`);
	return ref;
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker session mirror");
	return session;
}

/**
 * Watch `remote` as a focused view does, until the returned stop or the case's end: the stop is registered with the
 * case's cleanups as the watch starts. Stopping twice stops once.
 */
function watch(remote: RemoteAgentSession): () => void {
	let unsubscribe: (() => void) | undefined = remote.subscribe(() => {});
	const stop = (): void => {
		const current = unsubscribe;
		unsubscribe = undefined;
		current?.();
	};
	cleanups.push(stop);
	return stop;
}

async function mainSession(id: string): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	// Cleanups run newest first: the session is disposed, then its auth store is closed, each on its own.
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** This session's `get_subagents` roster, listing `id` running with its transcript at `sessionFile`. */
function rosterListing(id: string, sessionFile: string): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const roster = new RpcSubagentRegistry(eventBus, () => {});
	cleanups.push(() => roster.dispose());
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile,
	} satisfies SubagentLifecyclePayload);
	return roster;
}

/** Subscriptions to `roster`, to the agent registry and to `shutdown` made from now on and not ended yet. */
function liveSubscriptions(roster: RpcSubagentRegistry, shutdown: AbortSignal) {
	// The lifecycle manager subscribes to the registry for good when first built; build it first.
	AgentLifecycleManager.global();
	cleanups.push(() => vi.restoreAllMocks());
	const live = { roster: 0, registry: 0, shutdown: 0 };
	const track = (target: { onChange(listener: () => void): () => void }, key: "roster" | "registry") => {
		const onChange = target.onChange.bind(target);
		vi.spyOn(target, "onChange").mockImplementation(listener => {
			live[key]++;
			const unsubscribe = onChange(listener);
			return () => {
				live[key]--;
				unsubscribe();
			};
		});
	};
	track(roster, "roster");
	track(AgentRegistry.global(), "registry");
	const addEventListener = shutdown.addEventListener.bind(shutdown);
	const removeEventListener = shutdown.removeEventListener.bind(shutdown);
	vi.spyOn(shutdown, "addEventListener").mockImplementation((type, listener, options) => {
		if (type === "abort" && listener) live.shutdown++;
		addEventListener(type, listener, options);
	});
	vi.spyOn(shutdown, "removeEventListener").mockImplementation((type, listener, options) => {
		if (type === "abort" && listener) live.shutdown--;
		removeEventListener(type, listener, options);
	});
	return live;
}

/** What main receives of `value` in one note: every note is its own structured clone. */
function note<T>(value: T): T {
	return structuredClone(value);
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: { exitCode: 0 },
		isError: false,
		timestamp,
	};
}

function textOf(message: AgentMessage | null | undefined): string {
	if (!message || !("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/**
 * For each message of the mirror's list, in order: whether an entry holds an equal message (same
 * persistence key, deep-equal; each entry taken once, in entry order) and, if so, whether the two
 * are one object.
 */
function sharing(remote: RemoteAgentSession): Array<"shared" | "copy" | "no equal entry"> {
	const held = remote.sessionManager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
	let from = 0;
	return remote.messages.map(message => {
		const key = sessionMessagePersistenceKey(message);
		const at = held.findIndex(
			(candidate, index) =>
				index >= from &&
				key !== undefined &&
				sessionMessagePersistenceKey(candidate) === key &&
				Bun.deepEquals(candidate, message, true),
		);
		if (at < 0) return "no equal entry";
		from = at + 1;
		return held[at] === message ? "shared" : "copy";
	});
}

function messageEntryCount(remote: RemoteAgentSession): number {
	return remote.sessionManager.getEntries().filter(entry => entry.type === "message").length;
}

/** The text the `agent://` and `history://` readers serve for `id`, as a tool reads them. */
async function readerTexts(id: string): Promise<{ agent: string; history: string }> {
	const router = InternalUrlRouter.instance();
	return {
		agent: (await router.resolve(`agent://${id}`)).content,
		history: (await router.resolve(`history://${id}`)).content,
	};
}

describe("agent bridging across subagent workers", () => {
	it("mirrors a real worker-homed AgentSession on main: streaming, run state, events, messages", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { gated: true });
		const ref = liveRef("W1");
		const remote = mirrorOf(ref.session);
		expect(remote.instanceKey).toBe(key);
		expect(remote.home).toBe(worker.threadId);
		expect(key.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(worker.load).toBe(1);

		const runStates: string[] = [];
		cleanups.push(remote.subscribeRunState(state => runStates.push(state)));
		const events: string[] = [];
		cleanups.push(remote.subscribe(event => events.push(event.type)));

		const prompting = remote.prompt("hello from main");
		await waitFor(() => remote.isStreaming && ref.status === "running");
		expect(remote.runStartedAt).toBeNumber();

		await probe.openGate();
		expect(await prompting).toBe(true);
		await waitFor(() => !remote.isStreaming && ref.status === "idle");
		const roles = remote.messages.map(message => message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(remote.agent.state.messages).toBe(remote.messages);
		expect(remote.getSessionStats().assistantMessages).toBeGreaterThan(0);
		expect(runStates).toEqual(["running", "idle"]);
		expect(events).toContain("agent_end");
	}, 60_000);

	it("republishes the message mirror after a history rewrite that keeps both endpoints", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		// Watched, so the entries reach main too.
		watch(remote);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await waitFor(() => remote.messages.length >= 4);

		// Pruning rebuilds the runtime history with new interior content but the same first/last objects.
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");

		await waitFor(() => remote.messages.length >= 6);
		const interior = remote.messages[1];
		expect(interior?.role === "assistant" ? interior.content : undefined).toEqual([{ type: "text", text: "pruned" }]);
		// The replace builds the sharing again: a message equal to its entry is that entry's object. The pruned
		// one, which its entry no longer equals, has none.
		await waitFor(() => messageEntryCount(remote) >= 6);
		const shared = sharing(remote);
		expect({
			first: shared[0],
			pruned: shared[1],
			second: shared[2],
			third: shared[4],
			copies: shared.filter(state => state === "copy").length,
		}).toEqual({ first: "shared", pruned: "no equal entry", second: "shared", third: "shared", copies: 0 });
	}, 60_000);

	it("shares one object between a mirrored toolResult entry's message and the mirror's message, and keeps a restored-secret message separate", async () => {
		// If this regresses, main holds each message of a watched worker subagent twice, once in its message list
		// and once in its entry list, though the two are equal; or it shows the restored secret in the message list.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		// Idle and unwatched: nothing but the notes below reaches the mirror.
		await probe.settled("W1");
		expect(remote.messages).toEqual([]);
		const base = Date.now();

		// The `messages` note first, then the `entries` note, as one publisher flush sends them.
		const first = toolResult("call-1", "first output", base);
		remote.applyMessages({ kind: "append", messages: [note(first)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e1", null, note(first))] });
		// The `entries` note first: the entry was recorded before its message reached the published list.
		const second = toolResult("call-2", "second output", base + 1);
		remote.applyEntries({ kind: "append", entries: [messageEntry("e2", "e1", note(second))] });
		remote.applyMessages({ kind: "append", messages: [note(second)] });
		// The entry of an assistant message shows its secret restored for display; the message keeps the placeholder.
		const secret = "sk-agents-bridge-secret-0042";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const masked: AssistantMessage = {
			...createAssistantMessage(`the key is ${obfuscator.obfuscate(secret)}`),
			timestamp: base + 2,
		};
		const shown: AssistantMessage = { ...masked, content: deobfuscateAssistantContent(obfuscator, masked.content) };
		remote.applyMessages({ kind: "append", messages: [note(masked)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e3", "e2", note(shown))] });

		const branch = remote.sessionManager
			.getBranch("e3")
			.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
		const [firstMessage, secondMessage, maskedMessage] = remote.messages;
		expect({
			messagesNoteFirst: branch[0] === firstMessage,
			entriesNoteFirst: branch[1] === secondMessage,
			restoredSecretShared: branch[2] === maskedMessage,
			entryShowsSecret: textOf(branch[2]).includes(secret),
			messageShowsSecret: textOf(maskedMessage).includes(secret),
		}).toEqual({
			messagesNoteFirst: true,
			entriesNoteFirst: true,
			restoredSecretShared: false,
			entryShowsSecret: true,
			messageShowsSecret: false,
		});
		expect(remote.messages.map(textOf)).toEqual(["first output", "second output", textOf(masked)]);
	}, 60_000);

	it("gives the same agent:// and history:// text for a worker subagent's messages before and after its mirror shares entry and message objects", async () => {
		// If this regresses, a watched worker subagent's mirror serves agent:// and history:// a message list its
		// sharing changed, as an entry's text in place of the unequal message a pruned turn left.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");
		await waitFor(() => remote.messages.length >= 6);

		// Unwatched: main has no entries, so nothing can be shared yet.
		expect(messageEntryCount(remote)).toBe(0);
		const unshared = await readerTexts("W1");
		expect(unshared.history).toContain("pruned");
		expect(unshared.agent).toContain("Done");

		// A watch brings the entries, which the mirror may share with the equal messages it holds.
		const unwatch = watch(remote);
		await waitFor(() => messageEntryCount(remote) >= 6);
		expect(await readerTexts("W1")).toEqual(unshared);

		// A history replace while watched: the mirror builds its list again against the entries.
		unwatch();
		const before = remote.messages[1];
		await probe.rewriteInterior("W1", "pruned");
		watch(remote);
		await waitFor(() => remote.messages[1] !== before);
		expect(await readerTexts("W1")).toEqual(unshared);
	}, 60_000);

	it("shares a streamed message's object only once its final message arrives", async () => {
		// If this regresses, a watched worker subagent's finished reply stays in main twice (its entry and its
		// message), or its entry keeps the half-streamed text.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.settled("W1");
		const final: AssistantMessage = {
			...createAssistantMessage("Hello"),
			responseId: "resp-1",
			timestamp: Date.now(),
		};
		const partial: AssistantMessage = { ...final, content: [{ type: "text", text: "Hel" }] };

		// While it streams, the reply is only the mirror's stream message (the forwarded events).
		remote.applyEvent({ type: "message_start", message: note(partial) });
		remote.applyEvent({
			type: "message_update",
			message: note(partial),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: note(partial) },
		});
		const streamed = remote.agent.state.streamMessage;
		expect(textOf(streamed)).toBe("Hel");
		// Then its final message, as the publisher sends it: the `messages` note and the `entries` note, ahead of
		// the forwarded `message_end`.
		remote.applyMessages({ kind: "append", messages: [note(final)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e1", null, note(final))] });
		const [entry] = remote.sessionManager.getBranch("e1");
		const entryMessage = entry?.type === "message" ? entry.message : undefined;
		const message = remote.messages.at(-1);
		expect({
			streamedInEntries: entryMessage === streamed,
			streamedInMessages: message === streamed,
			entryText: textOf(entryMessage),
			messageText: textOf(message),
			finalShared: entryMessage === message,
		}).toEqual({
			streamedInEntries: false,
			streamedInMessages: false,
			entryText: "Hello",
			messageText: "Hello",
			finalShared: true,
		});
		remote.applyEvent({ type: "message_end", message: note(final) });
		expect(remote.agent.state.streamMessage).toBeNull();
	}, 60_000);

	it("fails a worker's registry CAS against a stale main ref generation", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const before = await probe.grab("W1");
		const registry = AgentRegistry.global();
		const replaced = registry.register({
			id: "W1",
			displayName: "W1",
			kind: "sub",
			session: liveRef("W1").session,
			status: "idle",
		});
		expect(replaced.generation).not.toBe(before);

		expect(await probe.cas("W1", "running")).toEqual({ grabbed: false, fresh: true, canonical: true });
		expect(registry.get("W1")?.status).toBe("running");
		expect(await probe.manages()).toBe(true);
	}, 60_000);

	it("lets a worker read a main-homed session through one canonical peer handle", async () => {
		const { probe } = await startWorker();
		const main = await mainSession("Main");
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: main,
			status: "running",
		});

		const report = await probe.peer("Main");
		expect(report).toEqual({
			isPeer: true,
			key: main.instanceKey,
			isStreaming: false,
			messageCount: 0,
			sessionFile: undefined,
			canonical: true,
			casBySession: true,
		});
		expect(liveRef("Main").status).toBe("idle");

		await probe.peerSubscribe("Main");
		expect(await probe.peerPrompt("Main", "hello from a worker")).toEqual({ accepted: true });
		expect(main.messages.map(message => message.role)).toContain("assistant");
		await waitFor(async () => {
			const seen = await probe.peerSeen();
			return seen.events.includes("agent_end") && seen.runStates.includes("idle");
		});
		expect((await probe.peerSeen()).runStates).toEqual(["running", "idle"]);
	}, 60_000);

	it("delivers an IRC message from main into a worker-homed session", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);

		const receipt = await IrcBus.global().send({ from: "Main", to: "W1", body: "ping from main" });
		expect(["injected", "woken"]).toContain(receipt.outcome);
		await waitFor(async () => (await probe.localCustomTypes("W1")).includes("irc:incoming"));
		await waitFor(() =>
			remote.messages.some(message => message.role === "custom" && message.customType === "irc:incoming"),
		);
	}, 60_000);

	it("tells IRC delivered on a worker a message from a descendant past an ended parent", async () => {
		// If this regresses, a worker reads refs without their recorded ancestry: a keep-alive subagent under a
		// subagent that has ended (unregistered) reaches its worker-homed ancestor as a peer, its question waiting
		// for a turn of its own while the ancestor's run waits on it.
		const { probe } = await startWorker();
		const registry = AgentRegistry.global();
		registry.register({ id: "Child", displayName: "task", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Child.Kid", displayName: "task", kind: "sub", parentId: "Child", session: null });
		registry.register({
			id: "Child.Kid.Grand",
			displayName: "task",
			kind: "sub",
			parentId: "Child.Kid",
			session: null,
		});
		registry.unregister("Child.Kid");

		expect(await probe.inRunFrom("Child", "Child.Kid.Grand")).toBe(true);
	}, 60_000);

	it("lends a worker-homed agent its nearest main-thread ancestor's extensions past an ended parent", async () => {
		// If this regresses, a worker-homed subagent under a subagent that has ended (unregistered) takes the `Main`
		// session's extension runner, for a helper session's subagent the host's, instead of its nearest main-thread
		// ancestor's.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		const helperRunner = {} as ExtensionRunner;
		const registry = AgentRegistry.global();
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: { extensionRunner: {} } as unknown as AgentSession,
			status: "idle",
		});
		registry.register({
			id: "Helper",
			displayName: "helper",
			kind: "main",
			session: { extensionRunner: helperRunner } as unknown as AgentSession,
			status: "idle",
		});
		registry.register({ id: "Helper-Child", displayName: "task", kind: "sub", parentId: "Helper", session: null });
		registry.register({ id: "W1", displayName: "W1", kind: "sub", parentId: "Helper-Child", session: remote });
		registry.unregister("Helper-Child");

		expect(remote.extensionRunner).toBe(helperRunner);
	}, 60_000);

	it("releases on main the agents under a helper session that ends on a worker", async () => {
		// If this regresses, a worker's lifecycle proxy refuses the release that a helper session hosted there (a
		// `/security` scan a worker-homed subagent started) asks for at its end: the helper's subagents stay live on
		// main after it ended.
		const { probe } = await startWorker();
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const disposals: Array<AgentSessionDisposeOptions | undefined> = [];
		let hostSubDisposals = 0;
		const helperSub = {
			dispose: async (options?: AgentSessionDisposeOptions) => {
				disposals.push(options);
			},
		} as unknown as AgentSession;
		const hostSub = {
			dispose: async () => {
				hostSubDisposals++;
			},
		} as unknown as AgentSession;
		registry.register({ id: "Helper", displayName: "helper", kind: "main", session: null, status: "running" });
		const helperRef = registry.register({
			id: "Helper-Sub",
			displayName: "task",
			kind: "sub",
			parentId: "Helper",
			session: helperSub,
			status: "idle",
		});
		lifecycle.adopt("Helper-Sub", { idleTtlMs: 0 }, helperRef);
		const hostRef = registry.register({
			id: "Host-Sub",
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: hostSub,
			status: "idle",
		});
		lifecycle.adopt("Host-Sub", { idleTtlMs: 0 }, hostRef);

		await probe.releaseUnder("Helper");

		expect(disposals).toEqual([{ ownedJobsEnd: "stop" }]);
		expect(registry.get("Helper-Sub")).toBeUndefined();
		expect(lifecycle.has("Helper-Sub")).toBe(false);
		expect(registry.get("Host-Sub")).toBe(hostRef);
		expect(hostSubDisposals).toBe(0);
		expect(lifecycle.has("Host-Sub", hostRef)).toBe(true);
	}, 60_000);

	it("tells a worker that a release on main is in flight, and settles its wait only once that release is over", async () => {
		// If this regresses, an isolated run that ends on a worker (an isolated task of a worker-homed subagent) reads
		// no release in flight, or reads one as over before it is: its end removes the worktree that the release's hook
		// still has to capture, and the agent's changes are lost.
		const { probe } = await startWorker();
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const disposing = Promise.withResolvers<void>();
		const session = { dispose: () => disposing.promise } as unknown as AgentSession;
		registry.register({
			id: "Releasing",
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session,
			status: "idle",
		});
		expect(await probe.isReleasing("Releasing")).toBe(false);

		const release = lifecycle.release("Releasing");
		expect(await probe.isReleasing("Releasing")).toBe(true);
		let over = false;
		const waited = probe.whenReleased("Releasing").then(() => {
			over = true;
		});
		// Each round trip below reaches main after the wait's own call and its answer would, so a wait that settles
		// at once (on the worker or on main) has settled by the last of them.
		for (let i = 0; i < 3; i++) expect(await probe.isReleasing("Releasing")).toBe(true);
		expect(over).toBe(false);

		disposing.resolve();
		expect(await release).toBe(true);
		await waited;
		expect(await probe.isReleasing("Releasing")).toBe(false);
	}, 60_000);

	it("detaches refs and rejects in-flight commands when the worker dies", async () => {
		const { worker, probe } = await startWorker();
		await probe.open("Parked", { sessionFile: "/tmp/agents-bridge-parked.jsonl", gated: true });
		await probe.open("Lost", {});
		await probe.adopt("Parked");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("Parked"));
		const parked = liveRef("Parked");
		const lost = liveRef("Lost");
		const remote = mirrorOf(parked.session);

		const pending = remote.prompt("never answered");
		await waitFor(() => remote.isStreaming);
		worker.terminate("killed by test");

		await expect(pending).rejects.toThrow(worker.threadId);
		expect(remote.closed).toBe(true);
		expect(parked.session).toBeNull();
		expect(parked.status).toBe("parked");
		expect(lost.session).toBeNull();
		expect(lost.status).toBe("aborted");
		// The adoption (and its release hook) survives; only the dead worker's warm reviver is gone.
		expect(lifecycle.has("Parked")).toBe(true);
		await expect(lifecycle.ensureLive("Parked")).rejects.toThrow("no reviver registered");
		await expect(remote.prompt("again")).rejects.toThrow(worker.threadId);
		await remote.dispose();
	}, 60_000);

	it("parks a worker-homed session and warm-revives it through the worker's reviver", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { sessionFile: "/tmp/agents-bridge-revive.jsonl" });
		await probe.adopt("W1");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("W1"));
		const ref = liveRef("W1");
		const first = mirrorOf(ref.session);

		await lifecycle.park("W1");
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(first.closed).toBe(true);
		expect(await probe.disposed(key)).toBe(true);

		const revived = mirrorOf(await lifecycle.ensureLive("W1"));
		expect(revived).not.toBe(first);
		expect(revived.instanceKey.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(liveRef("W1").session).toBe(revived);
		expect(liveRef("W1").status).toBe("idle");
		expect(worker.load).toBe(1);
	}, 60_000);

	it("queues a next-run steer on a worker-homed session, reports it on main, and takes it back", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		const reported: UserMessage[] = [];
		const taken: string[] = [];
		const queueNextRunSteer = (text: string, queueId: string) =>
			remote.steer(text, undefined, {
				holdUntilNextRun: true,
				queueId,
				onTaken: () => taken.push(queueId),
				onPromptQueued: messages => {
					const message = messages.at(-1);
					if (message?.role === "user") reported.push(message);
				},
			});

		await queueNextRunSteer("Take this back.", "only");
		await waitFor(() => reported.length === 1);
		expect(reported[0]).toMatchObject({
			role: "user",
			steering: true,
			content: [{ type: "text", text: "Take this back." }],
		});
		// The steer waits on the queue: no turn ran for it.
		expect(await probe.settled("W1")).toEqual({ messageCount: 0, steering: ["Take this back."] });
		expect(await remote.removeQueuedMessage({ queueId: "only" }, "steering")).toBe(true);
		expect(await probe.settled("W1")).toEqual({ messageCount: 0, steering: [] });
		expect(await remote.removeQueuedMessage({ queueId: "only" }, "steering")).toBe(false);

		// Two steers of the same text are two messages on the home worker: the
		// take-back by name removes the second, and the run takes the first.
		await queueNextRunSteer("Also check the README.", "first");
		await queueNextRunSteer("Also check the README.", "second");
		expect(await remote.removeQueuedMessage({ queueId: "second" }, "steering")).toBe(true);
		expect(await probe.settled("W1")).toEqual({ messageCount: 0, steering: ["Also check the README."] });
		expect(await remote.prompt("Submit your result.")).toBe(true);
		await waitFor(() => taken.length === 1);
		expect(taken).toEqual(["first"]);
		expect(await probe.settled("W1")).toMatchObject({ steering: [] });
	}, 60_000);

	it("queues and takes back a next-run steer on a main-homed session through a worker's peer handle", async () => {
		const { probe } = await startWorker();
		const main = await mainSession("Main");
		AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: main, status: "idle" });

		const result = await probe.peerQueueAndTakeBackNextRunSteer("Main", "Take this back.");

		expect(result).toEqual({
			reported: expect.objectContaining({
				role: "user",
				steering: true,
				content: [{ type: "text", text: "Take this back." }],
			}),
			removed: true,
			removedAgain: false,
		});
		// Of the two steers of that text, the one the take-back named is gone and the other waits.
		expect(main.agent.peekSteeringQueue()).toHaveLength(1);
		expect(await main.prompt("Submit your result.")).toBe(true);
		await main.waitForIdle();
		await waitFor(async () => (await probe.peerTaken()).length === 1);
		expect(await probe.peerTaken()).toEqual(["kept"]);
		expect(main.agent.peekSteeringQueue()).toEqual([]);
	}, 60_000);
});

describe("steer_subagent to a worker-homed subagent idle between turns", () => {
	const id = "W1";
	const text = "Also check the README.";
	const notDelivered = `The message was not delivered to subagent: ${id}`;

	/** A worker homing subagent `W1` idle between two turns of its run, which this session's roster lists running. */
	async function startSubagent() {
		const { worker, probe } = await startWorker();
		const sessionFile = `/tmp/agents-bridge-steer-${id}.jsonl`;
		await probe.open(id, { sessionFile });
		return { worker, probe, roster: rosterListing(id, sessionFile), remote: mirrorOf(liveRef(id).session) };
	}

	/** Wait until the steer is on the subagent's steering queue on its worker. */
	async function steerQueued(probe: AgentsProbe): Promise<void> {
		await waitFor(async () => (await probe.settled(id)).steering.length === 1);
	}

	/** How many times the subagent's transcript holds the steer. */
	async function timesDelivered(probe: AgentsProbe): Promise<number> {
		return (await probe.userTexts(id)).filter(message => message === text).length;
	}

	it("answers success when the run takes the steer and its executor marks the run ended at once", async () => {
		// Race: the subagent's next run takes the steer and its drive ends on the
		// worker right then, so the parent's take-back and the report that the
		// run took the message cross the bridge together. A steer that read the
		// take-back first would tell the host the message was lost although the
		// subagent acted on it.
		const { probe, roster, remote } = await startSubagent();
		await probe.endRunWhenSteerTaken(id, text);
		const answer = handleRpcSteerSubagent(roster, id, text);
		await steerQueued(probe);

		expect(await remote.prompt("Submit your result.")).toBe(true);

		expect(await answer).toBeUndefined();
		expect(liveRef(id).lifecycle?.endedAt).toBeNumber();
		expect(await timesDelivered(probe)).toBe(1);
		expect((await probe.settled(id)).steering).toEqual([]);
		// A later run carries it no more.
		expect(await remote.prompt("Anything else?")).toBe(true);
		expect(await timesDelivered(probe)).toBe(1);
	}, 60_000);

	it("answers success when the take-back reaches the worker while the run holds the steer before its model call", async () => {
		// Regression: the RPC shutdown takes the steer back just after the
		// subagent's run took it off the queue on its worker; the take-back finds
		// nothing to remove, the steer tells the host the message was not
		// delivered, and the subagent then acts on it anyway.
		const { probe, roster, remote } = await startSubagent();
		await probe.holdNextModelCall(id);
		await probe.watchTakeBacks(id);
		const shutdown = new AbortController();
		const answer = handleRpcSteerSubagent(roster, id, text, shutdown.signal);
		await steerQueued(probe);
		const prompting = remote.prompt("Submit your result.");
		await probe.modelCallHeld();

		// The race: the take-back crosses the bridge while the run holds the steer.
		shutdown.abort();
		await probe.takeBackReceived();
		await probe.releaseModelCall();

		expect(await prompting).toBe(true);
		expect(await answer).toBeUndefined();
		expect(await timesDelivered(probe)).toBe(1);
		expect((await probe.settled(id)).steering).toEqual([]);
	}, 60_000);

	it("answers success when the run starts on the worker the moment the steer is queued", async () => {
		// Race: the subagent's next run starts and takes the steer before the
		// parent hears back that the steer was queued. A steer that followed its
		// message only from then on would miss the run taking it, and wait until
		// the subagent stops or tell the host the message was lost.
		const { probe, roster } = await startSubagent();
		await probe.promptWhenSteerQueued(id, "Submit your result.");

		expect(await handleRpcSteerSubagent(roster, id, text)).toBeUndefined();

		expect(await timesDelivered(probe)).toBe(1);
		expect((await probe.settled(id)).steering).toEqual([]);
	}, 60_000);

	it("answers an error at once, leaving no subscription, when the worker dies while the take-back waits on it", async () => {
		// Regression: the subagent's worker dies while the steer's take-back waits
		// there; a steer that waited on the lost reply would hold the host's
		// command, and the RPC shutdown that drains it, for good.
		const { worker, probe, roster, remote } = await startSubagent();
		await probe.holdNextModelCall(id);
		await probe.watchTakeBacks(id);
		const shutdown = new AbortController();
		const live = liveSubscriptions(roster, shutdown.signal);
		const answer = handleRpcSteerSubagent(roster, id, text, shutdown.signal);
		await steerQueued(probe);
		const prompting = remote.prompt("Submit your result.");
		await probe.modelCallHeld();
		shutdown.abort();
		await probe.takeBackReceived();

		worker.terminate("killed by test");

		await expect(prompting).rejects.toThrow(worker.threadId);
		expect(await answer).toBe(notDelivered);
		expect(live).toEqual({ roster: 0, registry: 0, shutdown: 0 });
	}, 60_000);

	it("answers an error at once, leaving no subscription, when the session is disposed while the take-back waits on it", async () => {
		// Regression: the subagent's session is disposed on its worker while the
		// steer's take-back waits there for the run that holds the steer; the
		// disposal ends that run before its model call, and a take-back that
		// waited only for the run to take the steer would never answer, holding
		// the host's command and the RPC shutdown that drains it.
		const { probe, roster, remote } = await startSubagent();
		await probe.holdNextModelCall(id);
		await probe.watchTakeBacks(id);
		const shutdown = new AbortController();
		const live = liveSubscriptions(roster, shutdown.signal);
		const answer = handleRpcSteerSubagent(roster, id, text, shutdown.signal);
		await steerQueued(probe);
		const prompting = remote.prompt("Submit your result.");
		await probe.modelCallHeld();
		shutdown.abort();
		await probe.takeBackReceived();

		await probe.disposeLocal(id);
		await Promise.allSettled([prompting]);

		const answered = (await answer) ?? "success";
		expect([`Subagent's run ended before the message reached it: ${id}`, notDelivered]).toContain(answered);
		expect(live).toEqual({ roster: 0, registry: 0, shutdown: 0 });
	}, 60_000);
});
