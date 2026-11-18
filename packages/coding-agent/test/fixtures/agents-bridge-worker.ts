/**
 * Subagent worker entry for the agents-bridge tests: the real link wiring of
 * `subagent-worker-entry` with only the identity and agents services, plus a
 * probe service that hands the test functions driving real `AgentSession`s
 * homed on this worker.
 */
import { MessagePort, parentPort } from "node:worker_threads";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { QueuedMessageTarget } from "../../src/session/agent-session-types";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import { PeerAgentSession } from "../../src/thread/peer-agent-session";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";

/** What a worker-side peer handle reports about a session homed elsewhere. */
export interface PeerReport {
	isPeer: boolean;
	key: string;
	isStreaming: boolean;
	messageCount: number;
	sessionFile: string | undefined;
	canonical: boolean;
	casBySession: boolean;
}

/** Operations the test drives on the worker. */
export interface AgentsProbe {
	threadId(): Promise<string>;
	/** Build a real session (mock model) and register it as `id` in the (remote) registry. */
	open(id: string, options: { sessionFile?: string; gated?: boolean }): Promise<string>;
	/** Run a prompt on the local session to completion. */
	prompt(id: string, text: string): Promise<void>;
	/** Let gated model calls answer. */
	openGate(): Promise<void>;
	/** Rewrite the second message's text through `replaceMessages`, keeping the first and last objects (as pruning does). */
	rewriteInterior(id: string, text: string): Promise<void>;
	/** Custom message types of the local session's transcript. */
	localCustomTypes(id: string): Promise<string[]>;
	/** Keep the current ref object for `id`. */
	grab(id: string): Promise<number>;
	/** CAS `setStatus` with the grabbed ref, then with a fresh one. */
	cas(id: string, status: "idle" | "running"): Promise<{ grabbed: boolean; fresh: boolean; canonical: boolean }>;
	/** Read a session homed elsewhere through its peer handle. */
	peer(id: string): Promise<PeerReport>;
	/** Subscribe to events and run state of the session of `id` through its peer handle. */
	peerSubscribe(id: string): Promise<void>;
	/** Prompt the session of `id` through its peer handle (main routes it to the home thread). */
	peerPrompt(id: string, text: string): Promise<{ accepted: boolean }>;
	/** Event types and run states the peer subscriptions received. */
	peerSeen(): Promise<{ events: string[]; runStates: string[] }>;
	/** Adopt `id` into the main lifecycle with a reviver that builds a fresh session here. */
	adopt(id: string): Promise<void>;
	/** Whether the local session of `key` was disposed. */
	disposed(key: string): Promise<boolean>;
	/** Whether the worker's lifecycle proxy manages the worker's registry proxy. */
	manages(): Promise<boolean>;
	/** Once the local session of `id` settled: its message count and the texts on its steering queue. */
	settled(id: string): Promise<{ messageCount: number; steering: string[] }>;
	/**
	 * Through the peer handle of `id` (homed elsewhere): queue `text` twice as next-run
	 * steers named `kept` and `taken back`, then take back `taken back` by name, twice.
	 * Reports what `onPromptQueued` delivered here for the first and both take-backs.
	 */
	peerQueueAndTakeBackNextRunSteer(
		id: string,
		text: string,
	): Promise<{ reported: unknown; removed: boolean; removedAgain: boolean }>;
	/** Names of the steers queued by {@link peerQueueAndTakeBackNextRunSteer} that a run took, in order. */
	peerTaken(): Promise<string[]>;
	/** Once the local session of `id` settled: the texts of the user messages in its transcript. */
	userTexts(id: string): Promise<string[]>;
	/**
	 * Mark the run of `id` ended in the registry, as its executor does when the
	 * run's drive ends, the moment the local session emits the steer `text`.
	 */
	endRunWhenSteerTaken(id: string, text: string): Promise<void>;
	/**
	 * The moment a steer queued on the local session of `id` returns, run the
	 * session on `text` to its end, before the steer's answer leaves this worker.
	 */
	promptWhenSteerQueued(id: string, text: string): Promise<void>;
	/**
	 * Hold the next model call of the local session of `id` before it starts, with
	 * the steers its run took already in its context, until {@link releaseModelCall}
	 * or the run's abort.
	 */
	holdNextModelCall(id: string): Promise<void>;
	/** Resolves once {@link holdNextModelCall} holds a model call. */
	modelCallHeld(): Promise<void>;
	/** Let the model call {@link holdNextModelCall} holds start. */
	releaseModelCall(): Promise<void>;
	/** Note the take-backs by name the local session of `id` receives from now on (see {@link takeBackReceived}). */
	watchTakeBacks(id: string): Promise<void>;
	/** Resolves once the session {@link watchTakeBacks} watches received a take-back by name. */
	takeBackReceived(): Promise<void>;
	/** Dispose the local session of `id`. */
	disposeLocal(id: string): Promise<void>;
}

/** Test-only boot globals of the probe service. */
export interface AgentsProbeGlobals {
	ready(probe: AgentsProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const sessions = new Map<string, AgentSession>();
const byKey = new Map<string, AgentSession>();
const grabbed = new Map<string, AgentRef>();
const peerSeen: { events: string[]; runStates: string[] } = { events: [], runStates: [] };
/** Names of the peer steers a run took (see `peerQueueAndTakeBackNextRunSteer`). */
const peerTaken: string[] = [];
let threadName = "";
let gate = Promise.withResolvers<void>();
let gateOpen = false;
/** The model call {@link AgentsProbe.holdNextModelCall} holds: reached, and let go. */
let modelCallHold = { held: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
/** Settled by the first take-back by name after {@link AgentsProbe.watchTakeBacks}. */
const takeBack = Promise.withResolvers<void>();

async function makeSession(id: string, gated: boolean): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({
		handler: async () => {
			if (gated && !gateOpen) await gate.promise;
			return { content: ["Done"] };
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
	});
	sessions.set(id, session);
	byKey.set(session.instanceKey, session);
	return session;
}

function local(id: string): AgentSession {
	const session = sessions.get(id);
	if (!session) throw new Error(`no local session ${id}`);
	return session;
}

/** The text of a user message, or undefined for any other message. */
function userText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

const probe: AgentsProbe = {
	threadId: async () => threadName,
	open: async (id, options) => {
		const session = await makeSession(id, options.gated === true);
		const registry = AgentRegistry.global();
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: options.sessionFile ?? null,
			status: "idle",
		});
		registry.syncSessionStatus(id, session);
		return session.instanceKey;
	},
	prompt: async (id, text) => {
		await local(id).prompt(text);
	},
	rewriteInterior: async (id, text) => {
		const session = local(id);
		const messages = [...session.messages];
		const interior = messages[1];
		if (messages.length < 3 || interior?.role !== "assistant") throw new Error("need [user, assistant, …] history");
		messages[1] = { ...interior, content: [{ type: "text", text }] };
		session.agent.replaceMessages(messages);
	},
	openGate: async () => {
		gateOpen = true;
		gate.resolve();
		gate = Promise.withResolvers<void>();
	},
	localCustomTypes: async id =>
		local(id).messages.flatMap(message => (message.role === "custom" ? [message.customType] : [])),
	grab: async id => {
		const ref = AgentRegistry.global().get(id);
		if (!ref) throw new Error(`no ref ${id}`);
		grabbed.set(id, ref);
		return ref.generation;
	},
	cas: async (id, status) => {
		const registry = AgentRegistry.global();
		const old = grabbed.get(id);
		if (!old) throw new Error(`nothing grabbed for ${id}`);
		const grabbedOk = registry.setStatus(id, status, old);
		const fresh = registry.get(id);
		const freshOk = fresh ? registry.setStatus(id, status, fresh) : false;
		return { grabbed: grabbedOk, fresh: freshOk, canonical: fresh === registry.get(id) };
	},
	peer: async id => {
		const registry = AgentRegistry.global();
		const session = registry.get(id)?.session;
		if (!session) throw new Error(`no session for ${id}`);
		return {
			isPeer: session instanceof PeerAgentSession,
			key: session.instanceKey,
			isStreaming: session.isStreaming,
			messageCount: session.messages.length,
			sessionFile: session.sessionFile,
			canonical: session === registry.get(id)?.session,
			casBySession: registry.setStatus(id, "idle", session),
		};
	},
	peerSubscribe: async id => {
		const session = AgentRegistry.global().get(id)?.session;
		if (!session) throw new Error(`no session for ${id}`);
		session.subscribe(event => peerSeen.events.push(event.type));
		session.subscribeRunState(state => peerSeen.runStates.push(state));
	},
	peerPrompt: async (id, text) => {
		const session = AgentRegistry.global().get(id)?.session;
		if (!session) throw new Error(`no session for ${id}`);
		return { accepted: await session.prompt(text) };
	},
	peerSeen: async () => ({ events: [...peerSeen.events], runStates: [...peerSeen.runStates] }),
	adopt: async id => {
		const registry = AgentRegistry.global();
		const ref = registry.get(id);
		if (!ref) throw new Error(`no ref ${id}`);
		AgentLifecycleManager.global().adopt(
			id,
			{
				idleTtlMs: 0,
				revive: async () => makeSession(id, false),
			},
			ref,
		);
	},
	disposed: async key => {
		const session = byKey.get(key);
		if (!session) throw new Error(`no session ${key}`);
		return session.isDisposed;
	},
	manages: async () => AgentLifecycleManager.global().manages(AgentRegistry.global()),
	settled: async id => {
		const session = local(id);
		await session.waitForIdle();
		return {
			messageCount: session.messages.length,
			steering: session.agent
				.peekSteeringQueue()
				.flatMap(message =>
					message.role === "user" && Array.isArray(message.content)
						? message.content.flatMap(part => (part.type === "text" ? [part.text] : []))
						: [],
				),
		};
	},
	peerQueueAndTakeBackNextRunSteer: async (id, text) => {
		const session = AgentRegistry.global().get(id)?.session;
		if (!session) throw new Error(`no session for ${id}`);
		const reported = Promise.withResolvers<unknown>();
		for (const queueId of ["kept", "taken back"]) {
			await session.steer(text, undefined, {
				holdUntilNextRun: true,
				queueId,
				onTaken: () => peerTaken.push(queueId),
				onPromptQueued: messages => reported.resolve(messages.at(-1)),
			});
		}
		return {
			reported: await reported.promise,
			removed: await session.removeQueuedMessage({ queueId: "taken back" }, "steering"),
			removedAgain: await session.removeQueuedMessage({ queueId: "taken back" }, "steering"),
		};
	},
	peerTaken: async () => [...peerTaken],
	userTexts: async id => {
		const session = local(id);
		await session.waitForIdle();
		return session.messages.flatMap(message => {
			const text = userText(message);
			return text === undefined ? [] : [text];
		});
	},
	endRunWhenSteerTaken: async (id, text) => {
		const session = local(id);
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "message_end" || userText(event.message) !== text) return;
			unsubscribe();
			AgentRegistry.global().markRunEnded(id, session);
		});
	},
	promptWhenSteerQueued: async (id, text) => {
		const session = local(id);
		const steer = session.steer.bind(session);
		session.steer = async (...args) => {
			await steer(...args);
			await session.prompt(text);
		};
	},
	holdNextModelCall: async id => {
		const hold = { held: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		modelCallHold = hold;
		const remove = local(id).agent.addBeforeModelCallHook(async signal => {
			remove();
			hold.held.resolve();
			const aborted = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await Promise.race([hold.release.promise, aborted.promise]);
		});
	},
	modelCallHeld: () => modelCallHold.held.promise,
	releaseModelCall: async () => modelCallHold.release.resolve(),
	watchTakeBacks: async id => {
		const session = local(id);
		const removeQueuedMessage = session.removeQueuedMessage.bind(session);
		session.removeQueuedMessage = ((target: QueuedMessageTarget, queue: "steering" | "followUp") => {
			if (typeof target !== "string") takeBack.resolve();
			return removeQueuedMessage(target, queue);
		}) as AgentSession["removeQueuedMessage"];
	},
	takeBackReceived: () => takeBack.promise,
	disposeLocal: async id => {
		await local(id).dispose();
	},
};

function isProbeGlobals(value: unknown): value is AgentsProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "agents-probe",
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("probe globals missing");
		globals.ready(probe);
	},
};

const services: readonly ThreadService[] = [identityThreadService, agentsThreadService, probeService];

function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

let frameHandler: ((frame: RpcFrame) => void) | undefined;

port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		threadName = message.threadId;
		setCurrentThreadId(message.threadId);
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{
				name: `${message.threadId}↔main`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = { type: "subagent-worker-ready" };
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
