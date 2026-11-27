/**
 * Worker-side proxies of the main-owned agent singletons, installed with
 * `installGlobal` at worker boot (see `./agents`).
 *
 * The APIs are synchronous wherever the main classes are, so those calls are
 * `callSync` round trips; async APIs use `call`, and results nobody reads
 * (`setActivity`, `recordReply`, `forgetAgent`, `adopt`) are ordered
 * notifications. Change listeners share one main-side forwarding
 * subscription per proxy, which is dropped once the last local listener
 * unsubscribes; events arrive asynchronously after the main-side change.
 *
 * A subagent this thread parks keeps its revive state here, in this thread's
 * one revive table, keyed by agent id: main's adoption of it names its entry
 * as plain data, and main revives it and drops the entry through two
 * module-level functions (see `RemoteAgentLifecycle.adopt`).
 */
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentAwaitsApi } from "../../registry/agent-awaits";
import {
	type AdoptedReviver,
	type AdoptOptions,
	type AgentLifecycleApi,
	type AgentLifecycleDisposeOptions,
	type AgentReleaseOptions,
	type AgentReviveState,
	type ColdReviveOptions,
	type LiveAgentTarget,
	type PersistedSubagentReviverFactory,
	runReviver,
	WarmReviveInputsMissingError,
} from "../../registry/agent-lifecycle";
import type {
	AgentHistorySummary,
	AgentRef,
	AgentRefExpectation,
	AgentRegistryApi,
	AgentStatus,
	RegisterInput,
	RegistryEvent,
	RegistryListener,
} from "../../registry/agent-registry";
import type { IrcBusApi, IrcWaitFilter } from "../../irc/bus";
import type { AgentSessionHandle } from "../../session/agent-session-handle";
import type { RemoteObject } from "../rpc";
import type { AgentLifecycleProtocol, AgentRegistryProtocol, IrcBusProtocol, UnansweredSend } from "./agents-protocol";

/** Local listeners fed by one lazily opened remote subscription. */
class ForwardedListeners<A extends unknown[]> {
	readonly #listeners = new Set<(...args: A) => void>();
	readonly #open: (forward: (...args: A) => void) => () => void;
	readonly #label: string;
	#close: (() => void) | undefined;

	constructor(label: string, open: (forward: (...args: A) => void) => () => void) {
		this.#label = label;
		this.#open = open;
	}

	add(listener: (...args: A) => void): () => void {
		this.#listeners.add(listener);
		this.#close ??= this.#open((...args) => this.#emit(args));
		return () => {
			if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
			const close = this.#close;
			this.#close = undefined;
			close?.();
		};
	}

	#emit(args: A): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(...args);
			} catch (error) {
				logger.debug("Forwarded listener threw", { source: this.#label, error: String(error) });
			}
		}
	}
}

/** Worker proxy of main's agent awaits table. */
export class RemoteAgentAwaits implements AgentAwaitsApi {
	readonly #remote: RemoteObject<AgentRegistryProtocol>;
	readonly #listeners: ForwardedListeners<[]>;

	constructor(remote: RemoteObject<AgentRegistryProtocol>) {
		this.#remote = remote;
		this.#listeners = new ForwardedListeners("agent-awaits", forward => remote.callSync("awaitsSubscribe", forward));
	}

	hold(waiter: string, awaited: readonly string[], options: { interruptible: boolean }): () => void {
		return this.#remote.callSync("awaitsHold", waiter, awaited, options);
	}

	blocksOn(agent: string, target: string, sentAt: number): boolean {
		return this.#remote.callSync("awaitsBlocksOn", agent, target, sentAt);
	}

	onChange(listener: () => void): () => void {
		return this.#listeners.add(listener);
	}
}

/** Worker proxy of main's {@link AgentRegistryApi}. */
export class RemoteAgentRegistry implements AgentRegistryApi {
	readonly awaits: AgentAwaitsApi;
	readonly #remote: RemoteObject<AgentRegistryProtocol>;
	readonly #listeners: ForwardedListeners<[RegistryEvent]>;

	constructor(remote: RemoteObject<AgentRegistryProtocol>) {
		this.#remote = remote;
		this.awaits = new RemoteAgentAwaits(remote);
		this.#listeners = new ForwardedListeners("agent-registry", forward => remote.callSync("subscribe", forward));
	}

	register(input: RegisterInput): AgentRef {
		return this.#remote.callSync("register", input);
	}

	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		return this.#remote.callSync("registerIfAvailable", input, expected);
	}

	reopen(id: string, expected: AgentRef): AgentRef | undefined {
		return this.#remote.callSync("reopen", id, expected);
	}

	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		return this.#remote.callSync("setHistory", id, history, expectedSessionFile);
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("setStatus", id, status, expected);
	}

	markResultAccepted(id: string, expected?: AgentRefExpectation, responseAt?: number): boolean {
		return this.#remote.callSync("markResultAccepted", id, expected, responseAt);
	}

	markRunEnded(id: string, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("markRunEnded", id, expected);
	}

	startRun(id: string, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("startRun", id, expected);
	}

	staleAcceptedRuns(): AgentRef[] {
		return this.#remote.callSync("staleAcceptedRuns");
	}

	setActivity(id: string, activity: string): void {
		this.#remote.notify("setActivity", id, activity);
	}

	attachSession(
		id: string,
		session: AgentSessionHandle,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		return this.#remote.callSync("attachSession", id, session, sessionFile, expected);
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("detachSession", id, expected);
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("unregister", id, expected);
	}

	bindLiveName(name: string, targetId: string, sessionFile: string): boolean {
		return this.#remote.callSync("bindLiveName", name, targetId, sessionFile);
	}

	get(id: string): AgentRef | undefined {
		return this.#remote.callSync("get", id);
	}

	list(): AgentRef[] {
		return this.#remote.callSync("list");
	}

	listVisibleTo(id: string): AgentRef[] {
		return this.#remote.callSync("listVisibleTo", id);
	}

	isRunning(ref: AgentRef): boolean {
		return this.#remote.callSync("isRunning", ref);
	}

	/** Subscribes on the session's own thread view and reports each transition to main in order. */
	syncSessionStatus(id: string, session: AgentSessionHandle): () => void {
		return session.subscribeRunState(status => {
			this.#remote.notify("setStatus", id, status, session);
		});
	}

	onChange(listener: RegistryListener): () => void {
		return this.#listeners.add(listener);
	}
}

/** Plain data naming one entry of this thread's revive table: the parked agent, and which adoption of it. */
export interface ParkedReviveEntry {
	readonly agentId: string;
	/** Tells this adoption's entry from a later re-adopt's, which replaced it under the same agent id. */
	readonly token: number;
}

/** A table entry: the revive state an adopt handed this thread. */
interface ParkedRevive {
	readonly token: number;
	readonly revive: AdoptedReviver;
}

/** This thread's revive table, by agent id: one entry while main's adoption of the agent holds it. */
const parkedRevives = new Map<string, ParkedRevive>();
let nextParkedToken = 0;

/** How many entries this thread's revive table holds for `id` (0 or 1); test seam. */
export function reviveTableEntriesForTests(id: string): number {
	return parkedRevives.has(id) ? 1 : 0;
}

/**
 * Revive `expected` from the table entry `entry` names. Main calls it for every adoption of this thread's agents.
 * An entry that is gone (or another adoption's) leaves nothing to revive warm: main's lifecycle then revives cold.
 */
async function reviveParked(expected: AgentRef, entry: ParkedReviveEntry): Promise<AgentSessionHandle> {
	const parked = parkedRevives.get(entry.agentId);
	if (parked?.token !== entry.token) {
		throw new WarmReviveInputsMissingError(`This worker keeps no revive state of ${entry.agentId}'s adoption`);
	}
	return runReviver(parked.revive, expected);
}

/** Drop the table entry `entry` names, once main's adoption let go of it; a later adopt's entry stays. */
function dropParked(entry: ParkedReviveEntry): void {
	if (parkedRevives.get(entry.agentId)?.token === entry.token) parkedRevives.delete(entry.agentId);
}

/** Worker proxy of main's {@link AgentLifecycleApi}; the reviver factory and the process exit's teardown are main-only. */
export class RemoteAgentLifecycle implements AgentLifecycleApi {
	readonly #remote: RemoteObject<AgentLifecycleProtocol>;

	constructor(remote: RemoteObject<AgentLifecycleProtocol>) {
		this.#remote = remote;
	}

	setPersistedSubagentReviverFactory(_factory: PersistedSubagentReviverFactory, _idleTtlMs: () => number): void {
		throw new Error("The persisted subagent reviver factory is owned by the main thread");
	}

	/**
	 * A reviver stays on this thread with the session it rebuilds, in the revive table; main's adoption names its
	 * entry, as plain data revived by {@link reviveParked} and dropped by {@link dropParked}.
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (!opts.revive) {
			this.#remote.notify("adopt", id, opts, expected);
			return;
		}
		const token = nextParkedToken++;
		parkedRevives.set(id, { token, revive: opts.revive });
		const revive: AgentReviveState<ParkedReviveEntry> = {
			reviver: reviveParked,
			dropped: dropParked,
			state: { agentId: id, token },
		};
		this.#remote.notify("adopt", id, { ...opts, revive }, expected);
	}

	has(id: string, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("has", id, expected);
	}

	reclaimDeadCorpse(id: string, expected: AgentRef): Promise<boolean> {
		return this.#remote.call("reclaimDeadCorpse", id, expected);
	}

	/** Identity across the link: only main's registry (this worker's proxy of it) is managed. */
	manages(registry: AgentRegistryApi): boolean {
		return registry instanceof RemoteAgentRegistry && this.#remote.callSync("manages", registry);
	}

	isParking(id: string, expected?: AgentRefExpectation): boolean {
		return this.#remote.callSync("isParking", id, expected);
	}

	isReleasing(id: string): boolean {
		return this.#remote.callSync("isReleasing", id);
	}

	whenReleased(id: string): Promise<void> {
		return this.#remote.call("whenReleased", id);
	}

	park(id: string): Promise<void> {
		return this.#remote.call("park", id);
	}

	ensureLive(id: string, coldRevive?: ColdReviveOptions): Promise<AgentSessionHandle> {
		return this.#remote.call("ensureLive", id, coldRevive);
	}

	ensureLiveTarget(id: string, coldRevive?: ColdReviveOptions): Promise<LiveAgentTarget> {
		return this.#remote.call("ensureLiveTarget", id, coldRevive);
	}

	release(id: string, expected?: AgentRefExpectation, options?: AgentReleaseOptions): Promise<boolean> {
		return this.#remote.call("release", id, expected, options);
	}

	dispose(_options?: AgentLifecycleDisposeOptions): Promise<void> {
		return Promise.reject(new Error("The agent lifecycle is torn down by the main thread"));
	}

	/** Main's lifecycle releases the agents under `ancestorId` (a helper session hosted here that ends). */
	releaseUnder(ancestorId: string, options?: AgentLifecycleDisposeOptions): Promise<void> {
		return this.#remote.call("releaseUnder", ancestorId, options);
	}
}

/** Worker proxy of main's {@link IrcBusApi}. */
export class RemoteIrcBus implements IrcBusApi {
	readonly #remote: RemoteObject<IrcBusProtocol>;

	constructor(remote: RemoteObject<IrcBusProtocol>) {
		this.#remote = remote;
	}

	send(msg: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt> {
		return this.#remote.call("send", msg);
	}

	sentSince(from: string, to: string, sinceTs: number): boolean {
		return this.#remote.callSync("sentSince", from, to, sinceTs);
	}

	unansweredSends(from: string, sinceTs: number): UnansweredSend[] {
		return this.#remote.callSync("unansweredSends", from, sinceTs);
	}

	wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		return this.#remote.call("wait", agentId, filter, timeoutMs, signal, options);
	}

	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#remote.callSync("take", agentId, from);
	}

	unreadCount(agentId: string): number {
		return this.#remote.callSync("unreadCount", agentId);
	}

	recordReply(from: string, to: string): void {
		this.#remote.notify("recordReply", from, to);
	}

	forgetAgent(agentId: string): void {
		this.#remote.notify("forgetAgent", agentId);
	}

	holdSentMarks(agentId: string): () => void {
		return this.#remote.callSync("holdSentMarks", agentId);
	}
}
