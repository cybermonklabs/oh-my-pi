/**
 * Warm revive of a kept-alive subagent: what a parked subagent keeps in memory for it ({@link WarmReviveState}, plain
 * data a module-level reviver takes), and the revive itself, which reads the spawn spec back from the `session_init`
 * of the transcript it reopens and rebuilds the session through `buildSubagentSession` (subagent-session-options.ts).
 * Also what a warm and a cold revive share: their inputs to that build, the reopen of a parked transcript and the
 * models a revive resolves.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import {
	disabledProviderIds,
	enabledProviderModels,
	modelNotFoundMessage,
	resolveSpawnModelIdentity,
} from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { InitializeExtensionsOptions } from "../modes/runtime-init";
import { WarmReviveInputsMissingError } from "../registry/agent-lifecycle";
import type { AgentRef } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import {
	formatRetryFallbackBaseSelector,
	parseRetryFallbackChainEntry,
	type RetryFallbackSelector,
} from "../session/retry-fallback-chains";
import { maskStoredData } from "../session/session-entry-mask";
import {
	extractSessionInit,
	hasConversationalHistory,
	type PersistedSessionInit,
	SessionManager,
} from "../session/session-manager";
import type { SessionStorage } from "../session/session-storage";
import type { PerCallModelGrants } from "./model-approval";
import { type SpawnSpecSettings, spawnSpecSettings, type SubagentSpawnSpec } from "./spawn-spec";
import {
	buildSubagentSession,
	type ExplicitBuildModel,
	perCallDispatchAssertion,
	type SubagentBuildInput,
	type SubagentLiveInputs,
} from "./subagent-session-options";
import { captureSubagentSettings, layerWrites, type SubagentSettingsWrites } from "./subagent-settings";

/** A revive's own inputs. */
export interface SubagentReviveInputs {
	/** The reopened transcript's latest session_init; null where it holds none. */
	heldInit: PersistedSessionInit | null;
	expectedAgentRef: AgentRef;
	/** A warm revive's cache. */
	cache?: WarmReviveCache;
	/** The parts a record with no spawn spec builds as the cold revive before spawn specs did. */
	legacy?: SubagentLegacyRevive;
	/** The reviver factory and idle TTL the revived session's own extension `agents` actions cold-revive through. */
	agentActionsScope?: InitializeExtensionsOptions["agentActionsScope"];
}

/** How a cold revive of a record an older omp wrote builds the parts its record cannot state as a spawn spec. */
export interface SubagentLegacyRevive {
	/**
	 * The record's tool contract: the session mounts `mountedToolNames` (undefined where the record names none),
	 * and once it exists its active tools are clamped to the spec's tool names, with the devices it mounted
	 * where `keepDevices`.
	 */
	tools?: { mountedToolNames: string[] | undefined; keepDevices: boolean };
	/** Every build returns the held base prompt, the builds after the revived session's first model call too. */
	replayPrompt?: boolean;
	/** The record holds no spawn spec: the session keeps the workspace roots its file's header holds. */
	keepHeaderRoots?: boolean;
}

/**
 * What a warm revive holds besides the spawn spec its transcript stores: process-local state of the live session,
 * plain data only. Each field is set when the live session is disposed (class `P` and the run part of `S+P` of the
 * spawn input inventory).
 */
export interface WarmReviveCache {
	/**
	 * The model the session started on, which a warm revive starts on as it is; undefined where it started on
	 * none, and where the model registry holds an equal one when the session is disposed: a revive then takes the
	 * registry's under the spec's `model` identity. A catalog rebuild after the park replaces the registry's objects
	 * with equal copies, so a cache that kept the registry's object would then keep one nothing else holds alive.
	 */
	model: Model | undefined;
	/** The prewalk target the spawn armed, kept as {@link model} is, under the spec's `prewalk.target`. */
	prewalkTarget: Model | undefined;
	/**
	 * The runs' writes to the overlay beyond the layers the spawn spec stores, a credential setting's value among
	 * them (the spec leaves those out); undefined while the runs wrote none.
	 */
	settingsWrites: SubagentSettingsWrites | undefined;
	/**
	 * Pending, never-promoted family candidate. The stash lives only on the live manager, so park
	 * re-reads it (when the header still carries no task key) and the revive restores it onto the
	 * fresh manager the reviver opens from disk.
	 */
	pendingCacheCandidate: string | undefined;
}

/**
 * What a parked kept-alive subagent keeps in memory for its warm revive, revived by the module-level
 * {@link reviveWarmSubagent}: references to objects the live process holds (its live inputs, the store its
 * transcript lives in), its {@link WarmReviveCache} and the digest of the spawn spec its transcript stores. It keeps
 * no copy of the spec, no function, no `Map` and no session file: the revive reads the spec back from the latest
 * `session_init` of the file its registry record names, which the lifecycle hands it.
 */
export interface WarmReviveState {
	/** Store the transcript lives in; the revive reopens it there. */
	readonly storage: SessionStorage;
	/** The spawner's live inputs, without a per-call worker's approval, which each revive builds from {@link perCallGrants}. */
	readonly live: Omit<SubagentLiveInputs, "assertDispatchModel" | "seance">;
	/** A per-call worker's grants. */
	readonly perCallGrants?: PerCallModelGrants;
	readonly cache: WarmReviveCache;
	/**
	 * {@link spawnSpecDigest} of the spawn spec as the transcript stores it. A transcript whose latest spec has
	 * another digest holds another spec: none (a transcript an older build wrote), an edited one, or another
	 * subagent's (a seance consult's or a fork's transcript copies its source's), and the revive goes cold.
	 */
	readonly specDigest: number;
}

/** Seed of {@link spawnSpecDigest}, drawn once per thread: a spec edited to match a digest would need it. */
const SPEC_DIGEST_SEED = crypto.getRandomValues(new BigUint64Array(1))[0];

/** A 52-bit digest of `spec` as JSON writes it, a number the state holds inline. */
function spawnSpecDigest(spec: unknown): number {
	return Number(BigInt.asUintN(52, Bun.hash.wyhash(JSON.stringify(spec) ?? "", SPEC_DIGEST_SEED)));
}

/**
 * The {@link WarmReviveState} of a kept-alive subagent whose spawn has just written `spec` to the transcript
 * `sessionManager` holds: its digest is taken of the spec as the store holds it, which masks it as other free
 * content when `secrets.maskSessionStore` is on. Its live inputs keep no `undefined` field.
 */
export function warmReviveState(
	spec: SubagentSpawnSpec,
	sessionManager: SessionManager,
	storage: SessionStorage,
	live: SubagentLiveInputs,
	perCallGrants: PerCallModelGrants | undefined,
	cache: WarmReviveCache,
): WarmReviveState {
	const { assertDispatchModel: _perBuild, seance: _notWarm, ...shared } = live;
	const kept: Partial<WarmReviveState["live"]> = {};
	for (const key of Object.keys(shared) as (keyof typeof shared)[]) {
		const value = shared[key];
		if (value === undefined) continue;
		Object.assign(kept, { [key]: value });
	}
	return {
		storage,
		live: kept as WarmReviveState["live"],
		...(perCallGrants ? { perCallGrants } : {}),
		cache,
		specDigest: spawnSpecDigest(maskStoredData(spec, sessionManager.storeMask())),
	};
}

/** The model `registry` holds under `model`'s provider and id, when it equals `model` in every field. */
function equalRegistryModel(registry: ModelRegistry, model: Model | undefined): Model | undefined {
	const registered = model && registry.find(model.provider, model.id);
	return registered && (registered === model || Bun.deepEquals(registered, model, true)) ? registered : undefined;
}

/**
 * When `session` is disposed, sets `cache` to what the live session holds then: the runs' writes to its overlay
 * beyond `stored`, the layers its spawn spec stores; its manager's pending cache candidate; and no model or prewalk
 * target `registry` holds an equal one of. Every value is final once disposal begins.
 */
export function trackWarmReviveCache(
	session: AgentSession,
	cache: WarmReviveCache,
	stored: SpawnSpecSettings,
	registry: ModelRegistry,
): void {
	session.addDisposer(() => {
		// As JSON gives the layers back, as the spec stores them.
		const { layers } = spawnSpecSettings(captureSubagentSettings(session.settings));
		const global = layerWrites(stored.layers.global, layers.global);
		const overrides = layerWrites(stored.layers.overrides, layers.overrides);
		cache.settingsWrites =
			global || overrides ? { ...(global ? { global } : {}), ...(overrides ? { overrides } : {}) } : undefined;
		const manager = session.sessionManager;
		// An already-persisted header is the carrier a revive reconstitutes from —
		// only an unpromoted stash must be carried, so a header stripped on disk
		// (a deliberate drop of persisted affinity) cannot resurrect it.
		cache.pendingCacheCandidate =
			manager.getHeader()?.taskPromptCacheKey === undefined ? manager.getTaskSiblingCandidate() : undefined;
		if (equalRegistryModel(registry, cache.model)) cache.model = undefined;
		if (equalRegistryModel(registry, cache.prewalkTarget)) cache.prewalkTarget = undefined;
	});
}

/**
 * Reopens a parked subagent's transcript for a revive, in `storage`, where the tree's transcripts live (the
 * configured store when undefined). Park closed the JSONL writer, so this takes the single-writer lock
 * cleanly and restores the full message history (createAgentSession → agent.replaceMessages); a transcript
 * truncated to its header and session_init is refused.
 */
export async function reopenParkedSubagent(
	id: string,
	sessionFile: string,
	storage: SessionStorage | undefined,
): Promise<SessionManager> {
	const reopened = await SessionManager.open(sessionFile, undefined, storage, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	if (!hasConversationalHistory(reopened.getEntries())) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${id}": session file "${sessionFile}" has no message history ` +
				`(truncated to header/session_init). The agent was not revived.`,
		);
	}
	return reopened;
}

/**
 * The models one revive's stored identities (`formatModelStringWithRouting`) name, among every model the
 * registry holds whose provider the live settings leave enabled: the one place a revive holds a model to
 * `disabledProviders`. At the revive's first identity the registry does not hold, the registry's discovery
 * runs and the identity is resolved again; a later miss of the same revive waits on that discovery rather
 * than starting another. An identity the registry holds under a disabled provider resolves to nothing at
 * once: no discovery can make it resolve.
 */
export class RevivedModels {
	readonly #modelRegistry: ModelRegistry;
	readonly #settings: Settings;
	#discovery: Promise<void> | undefined;

	/**
	 * `settings`: the live settings, whose `disabledProviders` a model must not belong to. `discoveryRan`: an
	 * earlier step of the same revive, on another thread, already ran the discovery.
	 */
	constructor(modelRegistry: ModelRegistry, settings: Settings, discoveryRan = false) {
		this.#modelRegistry = modelRegistry;
		this.#settings = settings;
		if (discoveryRan) this.#discovery = Promise.resolve();
	}

	/** Whether this revive ran the registry's discovery. */
	get discoveryRan(): boolean {
		return this.#discovery !== undefined;
	}

	/**
	 * The model `identity` names among the models the registry holds now, without its discovery; undefined where
	 * it holds none, or where the model belongs to a disabled provider.
	 */
	lookup(identity: string): Model | undefined {
		return this.#enabled(resolveSpawnModelIdentity(identity, this.#modelRegistry));
	}

	/**
	 * The model `identity` names; undefined when the registry holds none after its discovery ran, or when the
	 * model it holds belongs to a disabled provider.
	 */
	async resolve(identity: string): Promise<Model | undefined> {
		let held = resolveSpawnModelIdentity(identity, this.#modelRegistry);
		if (!held) {
			await this.#discover();
			held = resolveSpawnModelIdentity(identity, this.#modelRegistry);
		}
		return this.#enabled(held);
	}

	/**
	 * Each model a retry-fallback `chain` names when the stored model `identity` is gone or refused, in the
	 * chain's order, every entry read as the live retry walk reads it (a provider wildcard keeps the failing
	 * model's id under another provider, without an aggregator's vendor prefix the target provider does not
	 * use): the entry's selector, and the model {@link lookup} gives for it, if any. `held`: the model the caller
	 * resolved `identity` to. Where it is none, the registry's discovery runs first, so the walk sees what it
	 * adds, also where the model is held under a disabled provider.
	 */
	async *chainModels(
		chain: readonly string[],
		identity: string,
		held: Model | undefined,
	): AsyncGenerator<{ candidate: RetryFallbackSelector; model: Model | undefined }> {
		if (!held) await this.#discover();
		// A stored identity is exact: no part of its id is read as a thinking level.
		const slash = identity.indexOf("/");
		const current: RetryFallbackSelector = {
			raw: identity,
			provider: identity.slice(0, slash),
			id: identity.slice(slash + 1),
			thinkingLevel: undefined,
		};
		for (const entry of chain) {
			const candidate = parseRetryFallbackChainEntry({ modelLookup: this.#modelRegistry }, entry, current);
			if (!candidate) continue;
			yield { candidate, model: this.lookup(formatRetryFallbackBaseSelector(candidate)) };
		}
	}

	/**
	 * The spawn's own message for a model the registry does not know, its hint drawn, as the spawn draws it,
	 * from the models of the providers the live settings leave enabled.
	 */
	notFoundMessage(identity: string): string {
		return modelNotFoundMessage(
			[identity],
			enabledProviderModels(this.#modelRegistry.getAll(), disabledProviderIds(this.#settings)),
		);
	}

	/** The registry's discovery, once per revive: started where this revive started none, else the one it started. */
	#discover(): Promise<void> {
		if (!this.#discovery) {
			this.#modelRegistry.refreshInBackground("online-if-uncached");
			this.#discovery = this.#modelRegistry.awaitBackgroundRefresh();
		}
		return this.#discovery;
	}

	/** `model`, where the live settings leave its provider enabled. */
	#enabled(model: Model | undefined): Model | undefined {
		return model && !disabledProviderIds(this.#settings).has(model.provider) ? model : undefined;
	}
}

/**
 * The model a revive whose build holds a model starts on: `held`, the one its session started on (a warm
 * revive) or the one a cold revive prepared from the spawn spec. A session-local switch since the spawn (a
 * prewalk handoff) owns the model and effort: the revive starts on the switched model where the registry
 * knows it, else on the held one, and the transcript restores the effort. The spawn's prewalk stays
 * configured; the coordinator sees it was spent. A per-call worker never switches models, and a seance
 * fork's selections belong to its source run, never to the consult. `discoveryRan`: an earlier step of the
 * same revive already ran the registry's discovery.
 */
export async function switchedOrHeldModel(
	build: Pick<SubagentBuildInput, "spec" | "live" | "sessionManager">,
	held: ExplicitBuildModel,
	discoveryRan = false,
): Promise<ExplicitBuildModel> {
	const { spec, live, sessionManager } = build;
	const switched = spec.perCallModel || live.seance ? undefined : sessionManager.getSessionLocalModelChange()?.model;
	if (switched === undefined) return held;
	const model = await new RevivedModels(live.modelRegistry, live.settingsParent, discoveryRan).resolve(switched);
	return { kind: "model", model: model ?? held.model, thinkingLevel: undefined };
}

/**
 * The model `identity` names, as a warm revive takes it: `kept`, the object its cache kept, else the one the model
 * registry holds under it. Undefined where the identity is null, and where the registry no longer holds it.
 */
function warmModel(
	kept: Model | undefined,
	identity: string | null | undefined,
	registry: ModelRegistry,
): Model | undefined {
	return kept ?? (identity ? resolveSpawnModelIdentity(identity, registry) : undefined);
}

/**
 * Warm reviver of every parked kept-alive subagent, called by the lifecycle with that subagent's own
 * {@link WarmReviveState}: it reopens the transcript its registry record names, reads the spawn spec back from the
 * latest `session_init`, and builds the session through `buildSubagentSession` with the live inputs and the cache
 * the state holds. Isolated runs keep their worktree for the same lifecycle, so they use this path too.
 *
 * A transcript whose latest spec is not the one the state's digest names, or which holds no spec, fails with
 * {@link WarmReviveInputsMissingError}, which the lifecycle answers with a cold revive (`persisted-revive.ts`). So
 * does a parked subagent whose model the registry no longer holds. A transcript a build wrote before spawn specs
 * existed, among them one that kept its revive inputs in a `subagent-revive-state` custom entry, is no state's: such a
 * subagent was parked by another process, so it revives cold, and the cold revive's path for a record with no spawn
 * spec ({@link SubagentLegacyRevive}) rebuilds it from the record's `session_init` as before spawn specs, which
 * revives every record an older omp wrote (test/task/subagent-revive-older-record.test.ts). No reader of the older
 * entry is kept.
 */
export async function reviveWarmSubagent(expectedAgentRef: AgentRef, state: WarmReviveState): Promise<AgentSession> {
	const { id, sessionFile } = expectedAgentRef;
	if (sessionFile === null) {
		throw new Error(`Cannot revive subagent "${id}": its registry record names no session file.`);
	}
	const { storage, live, perCallGrants, cache } = state;
	const reopened = await reopenParkedSubagent(id, sessionFile, storage);
	const heldInit = extractSessionInit(reopened.getEntries());
	const spec = heldInit?.spawnSpec;
	const model = spec ? warmModel(cache.model, spec.model, live.modelRegistry) : undefined;
	const prewalkTarget = spec?.prewalk
		? warmModel(cache.prewalkTarget, spec.prewalk.target, live.modelRegistry)
		: undefined;
	if (!spec || spawnSpecDigest(spec) !== state.specDigest || (spec.model !== null && !model)) {
		await reopened.close();
		throw new WarmReviveInputsMissingError(
			`Cannot warm-revive subagent "${id}": session file "${sessionFile}" holds no spawn spec its park wrote.`,
		);
	}
	// The stash died with the parked manager: hand the pending, never-promoted
	// family candidate to the fresh one so the first eligible request after
	// revival still finds and persists it.
	if (cache.pendingCacheCandidate !== undefined) {
		reopened.setTaskSiblingCandidate(cache.pendingCacheCandidate);
	}
	const buildLive: SubagentLiveInputs = perCallGrants
		? {
				...live,
				assertDispatchModel: perCallDispatchAssertion(perCallGrants, live.modelRegistry, spec.thinkingLevelCeiling),
			}
		: live;
	const held: ExplicitBuildModel = { kind: "model", model, thinkingLevel: spec.thinkingLevel ?? undefined };
	let buildModel: ExplicitBuildModel;
	try {
		buildModel = await switchedOrHeldModel({ spec, live: buildLive, sessionManager: reopened }, held);
	} catch (error) {
		await reopened.close();
		throw error;
	}
	return buildSubagentSession({
		spec,
		live: buildLive,
		sessionManager: reopened,
		storage,
		model: buildModel,
		prewalkTarget,
		revive: { heldInit, expectedAgentRef, cache },
	});
}
