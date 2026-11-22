/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`. A killed (`aborted`) agent is revived the same way: its
 * transcript is still on disk, so ensureLive reopens it as a fresh `parked`
 * generation and cold-revives it.
 *
 * Park/dispose is gated against concurrent ensureLive/peer sends:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
 *
 * Every adoption, park, and revival is bound to the exact {@link AgentRef} it
 * started from, so stale async work (a late finalizer, a cancelled initializer,
 * a superseded revive) can never clobber a newer same-id ref.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, postmortem, untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import type { AgentSessionDisposeOptions, OwnedJobsEnd } from "../session/agent-session-types";
import { isSameJournalFile, sessionJournalLiveness } from "../session/session-storage";
import { trackLateCleanup } from "../utils/late-cleanup";
import {
	type AgentRef,
	agentHasAncestor,
	type AgentRefExpectation,
	AgentRegistry,
	type AgentRegistryApi,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";
import { getAgentTombstonePath } from "./agent-tombstone";
import { type LiveJournalHolder, liveJournalRefusal, suppressedTranscriptNote } from "./persisted-agents";

/** Recreates a parked agent's live session from its sessionFile. */
export type AgentReviver = (expected: AgentRef) => Promise<AgentSessionHandle>;

/** Where a request to reach an agent by name landed. */
export interface LiveAgentTarget {
	/** The live session the name reached. */
	session: AgentSessionHandle;
	/**
	 * The id that session is registered under. Not always the name asked for:
	 * the transcript a pane is running is that pane's own session, so peers
	 * that know it by its file name reach it under the id it runs as.
	 */
	agentId: string;
	/** Whether getting there rebuilt a parked transcript into a new session. */
	revived: boolean;
}

/**
 * A reviver kept as plain data: `reviver` called with the agent's own `state`. An adoption holds it
 * for as long as its agent stays parked, so `reviver` MUST be a module-level function shared by every
 * agent it revives, never a closure (a closure keeps the scope of the run that built it), and
 * `state` holds only what the live process does not already keep for the agent elsewhere: references
 * to objects the process holds, with the agent's own inputs read back from its transcript.
 */
export interface AgentReviveState<S = unknown> {
	// Method syntax: an `AgentReviveState<Inputs>` stands where an `AgentReviveState<unknown>` is expected.
	reviver(expected: AgentRef, state: S): Promise<AgentSessionHandle>;
	readonly state: S;
}

/** What an adoption revives its agent with: a closure, or plain data ({@link AgentReviveState}). */
export type AdoptedReviver = AgentReviver | AgentReviveState;

/** Runs `revive` for the parked ref `expected`. */
export function runReviver(revive: AdoptedReviver, expected: AgentRef): Promise<AgentSessionHandle> {
	return typeof revive === "function" ? revive(expected) : revive.reviver(expected, revive.state);
}

/**
 * Thrown by a warm reviver when its agent's transcript holds none of the inputs it revives from
 * (a transcript written before they were recorded there, or a park whose write failed). The lifecycle
 * then drops that reviver and revives the agent cold from its persisted session contract, as it does
 * an agent restored from disk.
 */
export class WarmReviveInputsMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WarmReviveInputsMissingError";
	}
}

const AGENT_RELEASE_GRACE_MS = 5000;

async function persistAgentTombstone(sessionFile: string): Promise<void> {
	const tombstone = getAgentTombstonePath(sessionFile);
	try {
		// The sidecar is a local file in every storage mode. Under `session.storage:
		// sql` the transcript is a row, so the directory beside it may not exist yet.
		await fs.mkdir(path.dirname(tombstone), { recursive: true });
		await fs.writeFile(tombstone, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** Drop the kill marker of a reopened agent so later persisted scans list it as parked, not killed. */
async function removeAgentTombstone(id: string, sessionFile: string): Promise<void> {
	try {
		await fs.rm(getAgentTombstonePath(sessionFile), { force: true });
	} catch (error) {
		logger.warn("AgentLifecycleManager: failed to remove kill tombstone of reopened agent", {
			id,
			error: String(error),
		});
	}
}

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

/**
 * A reviver scoped to one {@link AgentLifecycleApi.ensureLive} call, for a host that
 * cannot install one process-global {@link PersistedSubagentReviverFactory} (ACP).
 */
export interface ColdReviveOptions {
	reviverFactory: PersistedSubagentReviverFactory;
	/** TTL of the cold-revived adoption; defaults to 0 (immediately re-parkable). */
	idleTtlMs?: number;
}

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/**
	 * Recreates a live AgentSession from the ref's sessionFile after parking. Kept for as long as the
	 * agent stays adopted: an adopter of many agents passes the plain-data form.
	 */
	revive?: AdoptedReviver;
	/** Releases resources that must survive parking but end with the agent lifecycle. */
	onRelease?: () => Promise<void>;
	/**
	 * Called once when this adoption stops holding `revive` — released, replaced by
	 * a re-adopt, removed from the registry, or its reviver forgotten — so whoever
	 * tracks the reviver can let go of it.
	 */
	onReviverDropped?: () => void;
}

interface AdoptedAgent {
	ref: AgentRef;
	idleTtlMs: number;
	revive?: AdoptedReviver;
	onRelease?: () => Promise<void>;
	onReviverDropped?: () => void;
	timer?: NodeJS.Timeout;
}

/** Fire (at most once) the adoption's reviver-dropped hook. */
function dropReviver(adopted: AdoptedAgent | undefined): void {
	const hook = adopted?.onReviverDropped;
	if (!adopted || !hook) return;
	adopted.onReviverDropped = undefined;
	try {
		hook();
	} catch (error) {
		logger.warn("AgentLifecycleManager: onReviverDropped hook failed", { error: String(error) });
	}
}

interface ParkInFlight {
	/** The exact ref this park was started for. */
	ref: AgentRef;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
}

interface RevivingAgent {
	ref: AgentRef;
	promise: Promise<AgentSessionHandle>;
}

interface ReopeningAgent {
	/** The killed ref being reopened. */
	ref: AgentRef;
	/** Resolves to the fresh `parked` generation. */
	promise: Promise<AgentRef>;
}

/** How {@link AgentLifecycleApi.release} ends an agent. */
export interface AgentReleaseOptions {
	/**
	 * Explicit kill: keep a terminal `aborted` row and persist the kill marker. The kill stops
	 * the agent's own jobs, so their subagents end with it and `omp --restore` leaves them.
	 */
	tombstone?: boolean;
	/**
	 * Forwarded to the live session's dispose: the reason its `session_exit` record carries, and
	 * how its own jobs end. A kill (`tombstone`) stops them unless this names another end; any
	 * other release that names none cuts them off.
	 */
	dispose?: AgentSessionDisposeOptions;
}

/** How {@link AgentLifecycleApi.dispose} and {@link AgentLifecycleApi.releaseUnder} release the agents they end. */
export interface AgentLifecycleDisposeOptions {
	/** When the teardown stops waiting for a release; later ones go on as late cleanup. */
	deadlineAt?: number;
	/**
	 * How each agent's turn and own jobs end: cut off by default (the process exit), stopped
	 * when the process goes on ({@link AgentSessionDisposeOptions.ownedJobsEnd}).
	 */
	ownedJobsEnd?: OwnedJobsEnd;
}

/** Public surface of the process-global agent lifecycle, implemented locally on main and by a proxy in workers. */
export interface AgentLifecycleApi {
	/** Install the factory used to cold-revive `parked` refs restored from disk. */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: () => number): void;
	/** Take ownership of a finished subagent and arm its idle TTL. */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void;
	/** True if the id is adopted (and still bound to `expected` when given). */
	has(id: string, expected?: AgentRefExpectation): boolean;
	/** Reclaim a provably-dead parked corpse so a fresh spawn can reuse its id. */
	reclaimDeadCorpse(id: string, expected: AgentRef): Promise<boolean>;
	/** True when this lifecycle owns `registry` (identity comparison). */
	manages(registry: AgentRegistryApi): boolean;
	/** True while a park is disposing this agent's session. */
	isParking(id: string, expected?: AgentRefExpectation): boolean;
	/** True while a {@link release} of the agent is in flight. */
	isReleasing(id: string): boolean;
	/** Settles once no {@link release} of the agent is in flight; at once when none is. */
	whenReleased(id: string): Promise<void>;
	/** Dispose the live session of an adopted agent and mark it `parked`. */
	park(id: string): Promise<void>;
	/** Return the live session, reviving it if parked or killed (with `coldRevive` over the global factory when given). */
	ensureLive(id: string, coldRevive?: ColdReviveOptions): Promise<AgentSessionHandle>;
	/** {@link ensureLive}, with the id the request reached and whether a transcript was rebuilt. */
	ensureLiveTarget(id: string, coldRevive?: ColdReviveOptions): Promise<LiveAgentTarget>;
	/** Dispose if live and drop timers; `tombstone` keeps a terminal `aborted` row. */
	release(id: string, expected?: AgentRefExpectation, options?: AgentReleaseOptions): Promise<boolean>;
	/** Tear down every adopted agent at the process exit, as `options` says. */
	dispose(options?: AgentLifecycleDisposeOptions): Promise<void>;
	/**
	 * Release, as {@link dispose} releases each, every registered agent whose ancestry
	 * ({@link agentHasAncestor}) reaches `ancestorId`, also past a parent unregistered since, whatever
	 * its status: running, idle, parked, killed, or being revived or reopened. The lifecycle and every
	 * other agent go on.
	 */
	releaseUnder(ancestorId: string, options?: AgentLifecycleDisposeOptions): Promise<void>;
}

export class AgentLifecycleManager implements AgentLifecycleApi {
	static #global: AgentLifecycleManager | undefined;
	/** Lifecycle installed by a worker bootstrap; takes precedence over the local manager. */
	static #installed: AgentLifecycleApi | undefined;

	/** The installed lifecycle; lazily a local manager bound to {@link AgentRegistry.global}. */
	static global(): AgentLifecycleApi {
		if (AgentLifecycleManager.#installed) return AgentLifecycleManager.#installed;
		const current = AgentLifecycleManager.#global;
		if (current) {
			// The manager captures its registry at construction and subscribes to
			// it for the manager's lifetime. A test that swaps the global registry
			// (`AgentRegistry.resetGlobalForTests`) without also resetting this
			// manager would strand it on the dead instance: terminal transitions
			// (`release`) would mutate the old registry while consumers subscribe
			// to the new one, so `status_changed` never reaches them (issue #11432).
			// Rebind by retiring the stale manager and reconstructing against the
			// current global registry. In production the registry is never reset, so
			// this always short-circuits and the singleton is stable.
			if (current.#registry === AgentRegistry.global()) return current;
			current.#retire();
		}
		AgentLifecycleManager.#global = new AgentLifecycleManager();
		return AgentLifecycleManager.#global;
	}

	/** Install the process-global lifecycle. Worker bootstrap only. */
	static installGlobal(api: AgentLifecycleApi): void {
		AgentLifecycleManager.#installed = api;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) current.#retire();
		AgentLifecycleManager.#global = undefined;
		AgentLifecycleManager.#installed = undefined;
	}

	/** Detach from the registry and cancel every pending timer/park/revival. */
	#retire(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const adopted of this.#adopted.values()) {
			clearTimeout(adopted.timer);
		}
		this.#adopted.clear();
		this.#revivals.clear();
		this.#reopens.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
	}

	readonly #registry: AgentRegistryApi;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	/** In-flight reopens of killed refs, bound to the killed ref, so concurrent {@link ensureLive} calls coalesce. */
	readonly #reopens = new Map<string, ReopeningAgent>();
	/**
	 * Refs a {@link release} is ending, with how many releases of each are in flight: until they end, no
	 * revive may adopt one or attach a session to it. Keyed by ref, so a newer same-id generation stays revivable.
	 */
	readonly #releasing = new Map<AgentRef, number>();
	/** Waiters of {@link whenReleased}, per agent id, settled once no release of that id is left in flight. */
	readonly #releaseWaiters = new Map<string, PromiseWithResolvers<void>>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** Resolves the TTL applied when a cold-revived ref is adopted on demand (read per revive). */
	#persistedReviveTtlMs: () => number = () => 0;
	/** Set once {@link dispose} runs; blocks late revivals from adopting into a torn-down manager. */
	#disposed = false;

	constructor(registry: AgentRegistryApi = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time. `idleTtlMs`
	 * is resolved per revive so a live `task.agentIdleTtlMs` change applies.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: () => number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session). A ref a {@link release} is
	 * ending (its run finalized while the release disposed its session) is not
	 * adopted: its release hook is called now, as late cleanup, without waiting
	 * for the release's dispose of its session. A hook whose run is still ending
	 * waits for that end before it releases what the end still uses.
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (id === MAIN_AGENT_ID) {
			opts.onReviverDropped?.();
			return;
		}
		const ref = this.#registry.get(id);
		if (!ref || (expected !== undefined && ref !== expected && ref.session !== expected)) {
			logger.warn("AgentLifecycleManager.adopt: unknown or replaced agent id", { id });
			opts.onReviverDropped?.();
			return;
		}
		if (this.#releasing.has(ref)) {
			opts.onReviverDropped?.();
			if (opts.onRelease) trackLateCleanup(opts.onRelease(), { id, resource: "adopted-agent" });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = {
			ref,
			idleTtlMs: opts.idleTtlMs,
			revive: opts.revive,
			onRelease: opts.onRelease,
			onReviverDropped: opts.onReviverDropped,
		};
		dropReviver(existing);
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/**
	 * Drop `revive` from the adoption of `id` — a warm reviver whose host thread
	 * died with the agent's session. The adoption itself stays, so its
	 * `onRelease` (e.g. a retained isolation workspace) still runs at final
	 * release, and the next {@link ensureLive} cold-revives through the persisted
	 * reviver factory. Main-thread bridging only. Returns true when dropped.
	 */
	forgetReviver(id: string, revive: AdoptedReviver): boolean {
		const adopted = this.#adopted.get(id);
		if (adopted?.revive !== revive) return false;
		clearTimeout(adopted.timer);
		adopted.timer = undefined;
		adopted.revive = undefined;
		dropReviver(adopted);
		return true;
	}

	/** True if the id is adopted (parked or live) — and, when `expected` is given, still bound to that ref. */
	has(id: string, expected?: AgentRefExpectation): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected),
		);
	}

	/**
	 * Reclaim a provably-dead parked corpse so a fresh spawn can reuse its id.
	 * Refuses live, adopted, in-flight, or cold-revivable refs. For a parked ref
	 * restored from disk, the persisted factory is consulted before removal
	 * because cold revivers are created lazily by {@link ensureLive}.
	 *
	 * Only refs in the registry this manager owns are touched; the transcript
	 * stays readable at `history://<id>`. Returns true when the corpse was
	 * unregistered.
	 */
	async reclaimDeadCorpse(id: string, expected: AgentRef): Promise<boolean> {
		const ref = this.#registry.get(id);
		if (ref !== expected || ref.status !== "parked" || ref.session) return false;
		if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;

		const persistedFactory = ref.sessionFile ? this.#persistedReviverFactory : undefined;
		if (persistedFactory) {
			try {
				if (await persistedFactory(ref)) return false;
			} catch (error) {
				logger.warn("AgentLifecycleManager.reclaimDeadCorpse: persisted reviver probe failed", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			// The factory awaited I/O; another lifecycle operation may now own or
			// have replaced this ref. Revalidate every reclaim invariant.
			if (this.#registry.get(id) !== ref || ref.status !== "parked" || ref.session) return false;
			if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;
		}
		return this.#registry.unregister(id, ref);
	}

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistryApi): boolean {
		return this.#registry === registry;
	}

	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes. When `expected` is
	 * given, only a park bound to that ref (or its session) counts.
	 */
	isParking(id: string, expected?: AgentRefExpectation): boolean {
		const park = this.#parks.get(id);
		return Boolean(
			park && !park.cancelled && (expected === undefined || park.ref === expected || park.ref.session === expected),
		);
	}

	/**
	 * True while a {@link release} of the agent `id` is in flight: from the moment it marks the ref as releasing, before
	 * it drops the agent's adoption if there is one, until it has ended. A release that took an adoption calls that
	 * adoption's release hook before it ends; one that took none calls no hook. Matched by id, not by the registered
	 * ref, which the released session's dispose may unregister while the release goes on; a release of an earlier ref
	 * of that id counts too.
	 */
	isReleasing(id: string): boolean {
		for (const ref of this.#releasing.keys()) {
			if (ref.id === id) return true;
		}
		return false;
	}

	/** Settles once no release of the agent `id` is left in flight ({@link isReleasing}); at once when none is. */
	whenReleased(id: string): Promise<void> {
		if (!this.isReleasing(id)) return Promise.resolve();
		let waiting = this.#releaseWaiters.get(id);
		if (!waiting) {
			waiting = Promise.withResolvers<void>();
			this.#releaseWaiters.set(id, waiting);
		}
		return waiting.promise;
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/peer sends never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref || adopted.ref !== ref) return;
		const session = ref.session;
		if (!session) return;

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister/replace may have raced us.
				const live = this.#registry.get(id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;

				// Preserve cost before detaching the only live source. The session usage
				// index includes off-transcript model calls; remove completed task-result
				// billing so child rows remain the sole owners of nested spend.
				try {
					const usage = session.sessionManager.getUsageStatistics();
					const directCost = usage.cost - usage.subagentCost;
					if (Number.isFinite(directCost) && directCost >= 0) {
						this.#registry.setHistory(id, { directCost }, ref.sessionFile ?? undefined);
					}
				} catch (error) {
					logger.debug("AgentLifecycleManager.park: cost snapshot failed", { id, error: String(error) });
				}

				// Commit: detach + parked *before* dispose so callers never see a
				// dying session via ref.session / idle status.
				park.detached = true;
				this.#registry.detachSession(id, ref);
				this.#registry.setStatus(id, "parked", ref);

				try {
					// A park happens while the process runs: it stops the agent's own jobs, so
					// their subagents end stopped and stay revivable, and `omp --restore` leaves
					// them. Only the process teardown cuts them off.
					await session.dispose({ ownedJobsEnd: "stop" });
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked or
	 * killed. Throws a plain Error if the id is unknown, or its transcript
	 * cannot be revived (no reviver, no session contract, workspace gone, or a
	 * live session holds its journal). Concurrent calls share one in-flight
	 * revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 *
	 * `coldRevive` lets a caller that cannot install one process-global
	 * {@link PersistedSubagentReviverFactory} (ACP hosts several concurrent
	 * top-level sessions, each with its own ambient auth/model/settings) supply
	 * a reviver scoped to this single call instead. It takes precedence over
	 * the global factory, for reopening a killed ref as well as for the cold
	 * revive, and is never persisted onto the manager.
	 */
	async ensureLive(id: string, coldRevive?: ColdReviveOptions): Promise<AgentSessionHandle> {
		return (await this.ensureLiveTarget(id, coldRevive)).session;
	}

	/**
	 * {@link ensureLive}, with where the request landed: a name can resolve to
	 * an agent registered under another id (the transcript a pane is running
	 * is that pane's session, not a peer of it), and a caller that reports
	 * delivery needs the id that actually received it and whether a transcript
	 * was rebuilt to get there.
	 */
	async ensureLiveTarget(id: string, coldRevive?: ColdReviveOptions): Promise<LiveAgentTarget> {
		const park = this.#parks.get(id);
		if (park) {
			const parked = this.#registry.get(id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = this.#registry.get(id);
				if (kept?.session && !this.#releasing.has(parked)) {
					// Park cleared the idle timer; re-arm so TTL park still works.
					const adopted = this.#adopted.get(id);
					if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return { session: kept.session, agentId: kept.id, revived: false };
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then fall through to the revive path.
				await park.promise;
			}
		}

		let ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				suppressedTranscriptNote(id) ??
					`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		// A release is disposing the agent's session: hand out nothing meanwhile. A kill keeps its row,
		// `aborted`, and the agent can be reopened once the kill ends; any other release unregisters it.
		if (this.#releasing.has(ref)) {
			throw new Error(
				ref.status === "aborted"
					? `Agent "${id}" is still shutting down after its kill; retry once it has stopped.`
					: `Agent "${id}" is being released and cannot be revived.`,
			);
		}
		if (ref.status === "aborted") ref = await this.#reopen(id, ref, coldRevive?.reviverFactory);
		// A revive attaches its session before it finishes initializing it: join the revive rather
		// than hand out a session whose extensions have not re-registered their tools yet. This
		// comes before the liveness probe below: a revive in flight has already claimed the
		// journal, so probing first would read this process's own revive as a live session
		// holding the transcript and refuse to join it.
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return { session: await inflight.promise, agentId: ref.id, revived: true };
		if (ref.session) return { session: ref.session, agentId: ref.id, revived: false };
		// A ref whose journal a live agent loop writes is not revivable, however
		// it got here (a scan that ran before the session went live, a kill and
		// re-registration, a collab mirror): rebuilding it would run a second
		// agent loop on a running session.
		if (ref.sessionFile) {
			const holder = sessionJournalLiveness(ref.sessionFile);
			if (holder !== "free") return this.#liveJournalTarget(ref.id, ref.sessionFile, holder);
		}
		const revival = this.#resolveAndRevive(id, ref, coldRevive);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return { session: await revival, agentId: ref.id, revived: true };
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/**
	 * Where a request for a ref whose journal a live session holds goes. When
	 * that session runs here, the name means it: hand the request to it, and
	 * repair the registry — drop the dead ref, bind the name to the live agent
	 * — so every later lookup agrees without re-deriving this. A journal held
	 * in another process, or a copy of a live journal (same session id,
	 * different file), has no local session to hand back; say what holds it
	 * instead of forking the agent.
	 */
	#liveJournalTarget(id: string, sessionFile: string, holder: LiveJournalHolder): LiveAgentTarget {
		if (holder === "here") {
			for (const live of this.#registry.list()) {
				if (live.id === id || !live.session || !live.sessionFile) continue;
				if (!isSameJournalFile(live.sessionFile, sessionFile)) continue;
				const stale = this.#registry.get(id);
				if (stale && !stale.session && stale.sessionFile === sessionFile) this.#registry.unregister(id, stale);
				this.#registry.bindLiveName(id, live.id, live.sessionFile);
				logger.debug("Resolved a live session's transcript to the agent running it", { id, agentId: live.id });
				return { session: live.session, agentId: live.id, revived: false };
			}
		}
		throw new Error(liveJournalRefusal(id, sessionFile, holder));
	}

	/**
	 * Turn a killed ref into a fresh `parked` generation on the same transcript
	 * and drop its kill marker, so the cold-revive path can rebuild it. Probes the
	 * call-scoped reviver, else the persisted factory, first: a transcript nothing
	 * can revive stays killed. Concurrent calls for the same killed ref share one
	 * reopen.
	 */
	async #reopen(id: string, killed: AgentRef, reviverFactory?: PersistedSubagentReviverFactory): Promise<AgentRef> {
		const inflight = this.#reopens.get(id);
		if (inflight?.ref === killed) return inflight.promise;
		const pending: ReopeningAgent = { ref: killed, promise: this.#reopenKilled(id, killed, reviverFactory) };
		this.#reopens.set(id, pending);
		try {
			return await pending.promise;
		} finally {
			if (this.#reopens.get(id) === pending) this.#reopens.delete(id);
		}
	}

	async #reopenKilled(
		id: string,
		killed: AgentRef,
		reviverFactory?: PersistedSubagentReviverFactory,
	): Promise<AgentRef> {
		const sessionFile = killed.sessionFile;
		if (!sessionFile) throw new Error(`Agent "${id}" was killed and has no transcript to resume from.`);
		const factory = reviverFactory ?? this.#persistedReviverFactory;
		if (!factory) {
			throw new Error(
				`Agent "${id}" was killed and cannot be revived (no reviver registered). Read history://${id} for what it did.`,
			);
		}
		if (killed.session) {
			throw new Error(`Agent "${id}" is still shutting down after its kill; retry once it has stopped.`);
		}
		// Only decides whether the kill can be undone; the cold-revive path builds
		// its own reviver for the fresh generation.
		const reviver = await factory(killed);
		if (this.#disposed) {
			throw new Error(
				`Agent "${id}" revival aborted: its lifecycle was disposed while its transcript was being checked.`,
			);
		}
		if (!reviver) {
			throw new Error(
				`Agent "${id}" was killed and its transcript cannot be resumed (no session contract, isolated run, or its workspace is gone). Read history://${id} for what it did.`,
			);
		}
		// A release of the killed ref began while its transcript was checked: it stays ended.
		if (this.#releasing.has(killed))
			throw new Error(`Agent "${id}" was released while its transcript was being checked.`);
		const reopened = this.#registry.reopen(id, killed);
		if (!reopened) throw new Error(`Agent "${id}" changed while its transcript was being checked.`);
		await removeAgentTombstone(id, sessionFile);
		return reopened;
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef, coldRevive?: ColdReviveOptions): Promise<AgentSessionHandle> {
		let adoption = this.#adopted.get(id);
		// A reviver-less adoption of this ref (its warm reviver's thread died) keeps
		// its release hook through cold revival and restores it if that fails.
		const prior = adoption?.ref === ref ? adoption : undefined;
		let revive = prior?.revive;
		const persistedFactory = coldRevive?.reviverFactory ?? this.#persistedReviverFactory;
		let coldReviver: AgentReviver | undefined;
		if (!revive && ref.status === "parked" && ref.sessionFile && persistedFactory) {
			coldReviver = await persistedFactory(ref);
			// Teardown can complete during the factory await. A late cold revive must
			// not cold-adopt (and later attach a live session + TTL) into a disposed
			// manager — reject deterministically before creating any session.
			if (this.#disposed) {
				throw new Error(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was being prepared.`,
				);
			}
		}
		// Checked before a cold adoption: a release while the factory awaited (the end of the helper
		// session that spawned the agent) removed the ref or still waits on its session or release hook,
		// and an adoption for it would bring the agent back with nothing left to release it.
		if (this.#registry.get(id) !== ref) {
			throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		}
		if (this.#releasing.has(ref)) {
			throw new Error(`Agent "${id}" was released while its persisted session was being prepared.`);
		}
		if (coldReviver) {
			revive = coldReviver;
			adoption = {
				ref,
				idleTtlMs: coldRevive ? (coldRevive.idleTtlMs ?? 0) : (prior?.idleTtlMs ?? this.#persistedReviveTtlMs()),
				revive,
				onRelease: prior?.onRelease,
			};
		}
		// Also checked before a cold adoption: a kill that completed while the factory awaited left the ref
		// `aborted` with its release hook run, and an adoption would keep that hook for a later release to run again.
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		if (coldReviver) this.#adopted.set(id, adoption);
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldReviver && this.#adopted.get(id) === adoption) {
				if (prior) this.#adopted.set(id, prior);
				else this.#adopted.delete(id);
			}
			// A warm reviver whose transcript records no inputs revives nothing: drop it, as a dead
			// worker's is ({@link forgetReviver}), and revive cold from the transcript.
			if (
				error instanceof WarmReviveInputsMissingError &&
				prior &&
				prior.revive === revive &&
				this.#adopted.get(id) === prior
			) {
				prior.revive = undefined;
				dropReviver(prior);
				return this.#resolveAndRevive(id, ref);
			}
			throw error;
		}
	}

	/**
	 * Dispose if live and drop timers. When `expected` is given, only a ref
	 * matching it is released; a stale release can never take down a newer
	 * same-id ref. Returns true when a matching ref was released.
	 *
	 * By default the ref is unregistered (teardown / one-shot removal). Pass
	 * `tombstone: true` for an explicit kill: the ref is kept registered as a
	 * terminal `aborted` row (session detached) instead of being removed, so a
	 * later persisted-subagent scan (e.g. Agent Hub reopen) skips it via its
	 * `if (!registry.get(id))` guard rather than re-adopting the surviving
	 * on-disk transcript as a fresh `parked` row. Mirrors
	 * `finalizeSubagentLifecycle`'s explicit-kill path. The kill stops the agent
	 * and its own jobs, it does not destroy it: {@link ensureLive} (a message, Hub
	 * revive/focus) reopens the transcript.
	 */
	async release(id: string, expected?: AgentRefExpectation, options?: AgentReleaseOptions): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = this.#registry.get(id);
		const currentMatches =
			current && (expected === undefined || current === expected || current.session === expected);
		const adoptedMatches =
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		const onRelease = adopted && adopted.ref === ref ? adopted.onRelease : undefined;
		if (!ref) return false;
		this.#releasing.set(ref, (this.#releasing.get(ref) ?? 0) + 1);
		try {
			if (adopted?.ref === ref) {
				clearTimeout(adopted.timer);
				this.#adopted.delete(id);
				dropReviver(adopted);
			}

			const park = this.#parks.get(id);
			if (park && park.ref === ref) {
				// Prefer cancel when the session is still live so release owns dispose.
				if (!park.detached) park.cancel();
				await park.promise;
			}

			const live = this.#registry.get(id) === ref ? ref.session : null;
			if (options?.tombstone) {
				// Apply the terminal transition synchronously, before any await. The
				// dying session's own dispose path calls unregisterUnlessParked
				// (sdk.ts), which spares a ref only when it is already `aborted` AND
				// already detached; awaiting persistAgentTombstone before this
				// transition left a window in which that unregister deleted the ref
				// (issue #10531). Persisting the sidecar afterward is safe: within the
				// process the still-registered `aborted` row already blocks re-adoption
				// via the `if (!registry.get(id))` discovery guard, and the sidecar
				// only needs to exist before a later cross-restart discovery pass —
				// release awaits the write below before returning.
				// Detach before publishing `aborted`: setStatus emits synchronously, so
				// every subscriber must observe a terminal ref with session === null.
				if (!this.#registry.detachSession(id, ref) || !this.#registry.setStatus(id, "aborted", ref)) {
					logger.warn("AgentLifecycleManager.release: terminal transition rejected", { id });
				}
			}
			try {
				if (options?.tombstone && ref.sessionFile) await persistAgentTombstone(ref.sessionFile);
			} finally {
				// Detaching removes the registry's only route to the live session. Always
				// dispose the captured session, even when tombstone persistence fails.
				if (live) {
					try {
						await live.dispose(
							options?.tombstone ? { ownedJobsEnd: "stop", ...options.dispose } : options?.dispose,
						);
					} catch (error) {
						logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
					}
				}
				try {
					await onRelease?.();
				} catch (error) {
					logger.warn("AgentLifecycleManager.release: owned resource cleanup failed", {
						id,
						error: String(error),
					});
				}
			}
			if (!options?.tombstone) this.#registry.unregister(id, ref);
			return true;
		} finally {
			// A revive may start again once no release of this ref is left.
			const releases = (this.#releasing.get(ref) ?? 1) - 1;
			if (releases > 0) this.#releasing.set(ref, releases);
			else this.#releasing.delete(ref);
			// Waiters for the agent settle once no release of its id is left.
			if (!this.isReleasing(id)) {
				this.#releaseWaiters.get(id)?.resolve();
				this.#releaseWaiters.delete(id);
			}
		}
	}

	/**
	 * Tear everything down at the process exit; disposing the global manager makes its next owner a
	 * fresh instance. `ownedJobsEnd` says how each agent's turn and own jobs end, cut off by default as
	 * the process exit ends them. A session that ends while the process goes on releases only the
	 * agents under it ({@link releaseUnder}).
	 */
	async dispose(options: AgentLifecycleDisposeOptions = {}): Promise<void> {
		this.#unsubscribe?.();
		this.#disposed = true;
		this.#unsubscribe = undefined;
		await this.#releaseAll([...new Set([...this.#adopted.keys(), ...this.#parks.keys()])], options);
		this.#revivals.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
		if (AgentLifecycleManager.#global === this) AgentLifecycleManager.#global = undefined;
	}

	/**
	 * Release every registered agent whose ancestry ({@link agentHasAncestor}) reaches `ancestorId`,
	 * whatever its status, each as {@link dispose} releases it. A session that ends while the process
	 * goes on (a `/security` scan, an ACP session's close) ends the agents under it this way once its own
	 * turn and jobs have stopped. A subagent still running is released too: its session is disposed and
	 * its ref unregistered, and its run's finalize adopts nothing (an adoption while the release runs is
	 * refused and runs the release hook; after it, the ref is gone). A killed agent's `aborted` row is
	 * unregistered, so no message reopens it under the ended session; its tombstone on disk makes a later
	 * scan of that session's root register its transcript as `aborted`, not `parked`. An agent a revive or
	 * a reopen is bringing back is released through its registered ref, so the revive finds it gone and
	 * fails. Every other agent, this manager and its revivers go on.
	 */
	async releaseUnder(ancestorId: string, options: AgentLifecycleDisposeOptions = {}): Promise<void> {
		const under = this.#registry.list().filter(ref => agentHasAncestor(this.#registry, ref, ancestorId));
		await this.#releaseAll(
			under.map(ref => ref.id),
			options,
		);
	}

	/**
	 * Release each of `ids`, distinct, as `options` says, waiting for each until the deadline; a release
	 * past it goes on as late cleanup.
	 */
	async #releaseAll(ids: readonly string[], options: AgentLifecycleDisposeOptions): Promise<void> {
		const deadlineAt = options.deadlineAt ?? Date.now() + AGENT_RELEASE_GRACE_MS;
		const ownedJobsEnd = options.ownedJobsEnd ?? "shutdown";
		// At the process exit, the subagents of an agent's own jobs are parked, not stopped, so
		// `omp --restore` goes on with them. A turn still running (a revived or woken agent) is
		// cut off too: its session records a process exit, so `omp --restore` goes on with it. An
		// idle agent's `session_exit` record stays a plain dispose. A stop ends a running agent as
		// it ends an idle one: its turn and its own jobs stop, and no process exit is recorded.
		const idle: AgentReleaseOptions = { dispose: { ownedJobsEnd } };
		const running: AgentReleaseOptions =
			ownedJobsEnd === "stop" ? idle : { dispose: { reason: postmortem.Reason.EXIT, ownedJobsEnd } };
		await Promise.all(
			ids.map(async id => {
				const releaseOptions = this.#registry.get(id)?.status === "running" ? running : idle;
				const release = this.release(id, undefined, releaseOptions).then(() => {});
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => release);
				} catch (error) {
					if (Date.now() >= deadlineAt) {
						trackLateCleanup(release, { id, resource: "adopted-agent" });
					}
					logger.warn("Agent cleanup exceeded its deadline", {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}

	async #revive(
		id: string,
		revive: AdoptedReviver,
		ref: AgentRef,
		adopted: AdoptedAgent,
	): Promise<AgentSessionHandle> {
		const session = await runReviver(revive, ref);
		if (this.#disposed || this.#releasing.has(ref)) {
			// The owning lifecycle tore down, or a release of this agent began, while the reviver was
			// in flight; dispose the freshly built session instead of attaching it, and fail the waiter.
			await session.dispose();
			throw new Error(
				this.#disposed
					? `Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was reviving.`
					: `Agent "${id}" revival aborted: it was released while its persisted session was reviving.`,
			);
		}
		let liveRef = this.#registry.get(id);
		if (liveRef === ref && ref.status === "parked" && !ref.session) {
			// A simple reviver returned a session without claiming the parked ref;
			// attach it here while the exact ref is still revivable.
			if (!this.#registry.attachSession(id, session, ref.sessionFile, ref)) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			// createAgentSession may have already claimed this exact parked ref and
			// attached the returned session. Any other state — especially an
			// `aborted` tombstone set while revive() was in flight — is stale.
			await session.dispose();
			throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
		}
		adopted.ref = liveRef;
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		if (!this.#registry.setStatus(id, "idle", liveRef)) {
			await session.dispose();
			throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
		}
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			// A session still owing turns to IRC messages (held by a run publishing
			// its result, or queued) would drop them when parked. Try again once the
			// TTL passes anew.
			if (adopted.ref.session?.ircWakesPending) {
				this.#armTimer(id, adopted);
				return;
			}
			void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.ref !== event.ref) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			dropReviver(adopted);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
