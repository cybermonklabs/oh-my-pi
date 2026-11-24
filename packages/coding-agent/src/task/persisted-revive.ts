import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentIdentity } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { type ConfiguredThinkingLevel, modelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveAgentAdvisorRolePattern,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { KeptOverlayLayers, Settings } from "../config/settings";
import type { EvalToolDescriptor } from "../eval/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { extensionPathKey, importExtensionModule } from "../extensibility/extensions/loader";
import type { ExtensionPathEntry, ExtensionScope } from "../extensibility/extensions/types";
import { MCPManager, type MCPManagerApi } from "../mcp/manager";
import unavailableCustomToolsPrompt from "../prompts/system/unavailable-custom-tools.md" with { type: "text" };
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, agentAncestors, bareAgentId, MAIN_AGENT_ID } from "../registry/agent-registry";
import { discoverSessionExtensionPaths } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { type AgentSessionHandle, isLocalAgentSession } from "../session/agent-session-handle";
import type { AuthStorage } from "../session/auth-storage";
import {
	formatRetryFallbackBaseSelector,
	getRetryFallbackRole,
	installRetryFallbackRole,
	retryFallbackThinkingLevel,
} from "../session/retry-fallback-chains";
import { extractSessionInit, type PersistedSessionInit, SessionManager } from "../session/session-manager";
import { defaultSessionStorage, type SessionStorage } from "../session/session-storage";
import { revivePersistedPlaced } from "../thread/executor-routing";
import { RemoteAgentSession } from "../thread/remote-agent-session";
import { isRpcProxy } from "../thread/rpc";
import { type SessionSettingsSource, sessionSettingsSource, settingsFromSource } from "../thread/session-mirror";
import { toWorkerCustomTool } from "../thread/services/integrations";
import { subagentWorkerPool } from "../thread/subagent-worker";
import type { ToolSession } from "../tools";
import type { EventBus } from "../utils/event-bus";
import { isCompletionProbeEnabled } from "./completion-probe";
import { discoverAgents, getAgent } from "./discovery";
import { definedEvalCustomTools, unavailableEvalCustomTool } from "./eval-tools";
import {
	buildSubagentSession,
	captureSubagentSettings,
	compactionThresholdSettings,
	createSubagentSettings,
	type ExplicitBuildModel,
	type LegacyBuildModel,
	liveEffortCeiling,
	perCallModelAssertion,
	RevivedModels,
	reopenParkedSubagent,
	restoreSubagentSettings,
	SUBAGENT_OVERLAY_SETTINGS,
	type SubagentBuildInput,
	type SubagentLegacyRevive,
	type SubagentLiveInputs,
	type SubagentLivePolicy,
	type SubagentOverlayOverrides,
	type SubagentSpawnerLiveInputs,
	softRequestBudgetFor,
	spawnerLiveInputs,
	subagentRetryFallbackRole,
	switchedOrHeldModel,
} from "./executor";
import {
	assertPerCallModelApproved,
	PerCallModelError,
	type PerCallModelGrants,
	PerCallModelUnavailableError,
	parentModelGrantPattern,
} from "./model-approval";
import { type RestoredSeanceSession, restoreSeanceSession } from "./seance";
import { cfgTaskAgentIdleTtlMs, cfgTaskMaxEffort, cfgTaskMaxRuntimeMs } from "./settings";
import {
	jsonValue,
	readSpawnSpec,
	SPAWN_LIVE_INPUT_NAMES,
	SPAWN_SPEC_VERSION,
	type SpawnLiveInputName,
	type SpawnSpecParts,
	type SpawnSpecPolicy,
	type SpawnSpecSettings,
	type SubagentSpawnSpec,
	spawnSpecSettings,
} from "./spawn-spec";
import { subagentLiveInputs, subagentSpawnerPolicy } from "./structured-subagent";
import type { AgentDefinition } from "./types";

/** Custom type of the message that names a revived subagent's unavailable custom tools to its model. */
const UNAVAILABLE_CUSTOM_TOOLS_NOTICE = "unavailable-custom-tools";

/**
 * Ambient context the reviver needs at revive time. The top-level session is kept LIVE and read at each
 * revive rather than snapshotted, so a later `/new` or cwd move is followed. A revived subagent builds in the
 * cwd its record's header holds, as the reopened session manager reads it, where its tools run; a seance
 * consult builds in the cwd its record holds. A revive takes the artifact manager of its live parent
 * session (the root's where the parent is not live) where its spawn passed one (a spec names the live inputs
 * its spawn passed; a record with no spawn spec always takes it) and where that manager can reach the main
 * thread; a seance consult takes none. Auth/models/settings are process-stable and captured by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
	/**
	 * Shared event bus feeding RPC/collab subagent subscriptions. Passed through
	 * to the wake-turn monitor so an IRC send to a cold-revived subagent emits
	 * the same lifecycle/progress frames a live run does.
	 */
	eventBus?: EventBus;
	/** Root-scoped observability bus the revived run's frames also publish to. */
	subagentEventBus?: EventBus;
	/**
	 * MCP manager owned by the top-level session, for a host that keeps MCP per
	 * session instead of in the process-global {@link MCPManager.instance} (ACP:
	 * servers come from the client, never from workspace `.mcp.json`). Read on
	 * every revive because the host connects its servers after this factory is
	 * built. When supplied, revived agents use exactly this manager and never
	 * discover MCP config themselves, even when it returns `undefined`.
	 */
	mcpManager?: () => MCPManager | undefined;
	/** Storage holding the top-level session's subagent transcripts; defaults to the configured session storage. */
	storage?: SessionStorage;
}

/** The live inputs a cold revive takes from the live parent session; the reviving thread adds its own. */
export type ColdReviveLiveInputs = Omit<
	SubagentLiveInputs,
	"assertDispatchModel" | "customTools" | "oauthAccountPools" | "seance" | "storeMaskCwd"
>;

/**
 * A live parent session's inputs for a child's build, as a spawn of it reads them from its tool session
 * ({@link subagentLiveInputs}), with the event buses that tool session carries.
 */
interface ParentLiveInputs extends SubagentSpawnerLiveInputs {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/**
 * What a live parent homed on another thread sends for a cold revive of its child
 * (`SessionHostProtocol.subagentParentInputs`, answered by {@link serveSubagentParentInputs}).
 */
export interface SubagentParentInputs {
	/**
	 * Its live inputs in the forms that reach the main thread: plain data, codec values, functions, and the
	 * main-thread objects its home imported, which arrive as themselves. An object local to its home is left
	 * out, and so is the extension-roots provider, which a build calls synchronously: main reads the parent's
	 * mirrored roots instead.
	 */
	readonly live: Omit<ParentLiveInputs, "settings" | "extensionRoots">;
	/** Its settings, as the recipe main rebuilds them from. */
	readonly settings: SessionSettingsSource;
	/** Its values of the policy fields a spawn takes from its spawner. */
	readonly policy: ParentPolicy;
	/** The tools of the requested descriptors its kernels define now, as cross-thread views. */
	readonly customTools: CustomTool[];
	/** Its cwd: the directory its custom-tool paths, MCP manager and project extensions serve. */
	readonly cwd: string;
}

/**
 * The policy fields a spawn takes from its spawner's tool session (`buildExecutorOptions`); a cold revive takes
 * them from the live parent, never from the record.
 */
type ParentPolicy = Pick<SpawnSpecPolicy, "credentialSourceSessionId" | "additionalDirectories">;

/**
 * A live parent's inputs for a child's build, its policy fields, the tools of the child's descriptors its
 * kernels define now, and its cwd.
 */
interface LiveParent {
	readonly inputs: ParentLiveInputs;
	readonly policy: ParentPolicy;
	readonly customTools: readonly CustomTool[];
	readonly cwd: string;
}

/** The model a cold revive builds on: never the patterns of a spawn's deferred model resolution. */
type ColdReviveBuildModel = ExplicitBuildModel | LegacyBuildModel;

/** A per-call worker's grants besides the live settings and the live parent's model, which each request reads. */
export type PerCallGrantInputs = Omit<PerCallModelGrants, "settings" | "parentModelPattern">;

/** What the main thread prepares for one cold revive before anything is reopened ({@link prepareColdRevive}). */
export interface PreparedColdRevive {
	/**
	 * The live parent session's inputs: the parent ref's while it holds a session, else the root's. Where that
	 * session's cwd is not the stored session's, its tool sources are narrowed to the stored session's directory
	 * ({@link coldReviveLiveInputs}).
	 */
	readonly live: ColdReviveLiveInputs;
	/**
	 * The session {@link live} came from works in another directory than the stored session's: the revive builds on
	 * the main thread, since in a worker a session given no MCP manager takes the process's shared one, while on main
	 * it discovers the stored directory's MCP servers.
	 */
	readonly buildsOnMain: boolean;
	/** The model a spawn spec's model or a per-call worker starts on; absent, the record's patterns decide. */
	readonly model: ExplicitBuildModel | undefined;
	/**
	 * The model the spec's prewalk target names, where the registry knows it and its provider has a credential;
	 * else the prewalk is not armed.
	 */
	readonly prewalkTarget: Model | undefined;
	/** The registry's discovery ran while this step resolved a model; the build does not run it again. */
	readonly discoveryRan: boolean;
	/**
	 * The spec's settings overlay as it restores, checked once per revive here: only the settings a spawn writes
	 * ({@link SUBAGENT_OVERLAY_SETTINGS}). Undefined where the record holds none, or where it does not restore (the
	 * build then takes the settings of an older record).
	 */
	readonly settings: SpawnSpecSettings | undefined;
	/** A per-call worker's grants, which each of its requests is held to. */
	readonly grants: PerCallGrantInputs | undefined;
	/** Each custom tool the spec names, built over the live parent's kernel or kept as unavailable. */
	readonly customTools: readonly CustomTool[];
	/** Names of the custom tools no live kernel serves. */
	readonly unavailableTools: readonly string[];
	/**
	 * The policy fields a spawn takes from its spawner: the live parent's, else the root tool session's (the parent
	 * is not live, or its home cannot answer); undefined where neither holds a tool session (a host's root).
	 */
	readonly parentPolicy: ParentPolicy | undefined;
}

/**
 * Everything one cold revive of a persisted subagent needs, built on main per revive and
 * cloneable (live objects cross as their bridged proxies), so the session can be created
 * on main or inside a pooled worker alike.
 */
export interface PersistedReviveSpec {
	readonly id: string;
	readonly displayName: string;
	readonly parentId: string | undefined;
	readonly sessionFile: string;
	readonly storage?: SessionStorage;
	/** The cwd its file's header holds, as the factory read it: where its tools run. */
	readonly storedCwd: string;
	/** Depth derived from the persisted parent chain (drives capability gating). */
	readonly taskDepth: number;
	/** The consulted source of a persisted seance session. */
	readonly restoredSeance: RestoredSeanceSession | undefined;
	/** The live top-level session revived agents join (parent grants of its direct children). */
	readonly root: AgentSessionHandle;
	/** Registry id of {@link root}. */
	readonly rootAgentId: string;
	/** The root session's settings, which the subagent settings of a record with no spawn spec build on. */
	readonly settings: Settings;
	readonly prepared: PreparedColdRevive;
	/**
	 * Set when the host keeps MCP per top-level session
	 * ({@link PersistedSubagentReviveContext.mcpManager}): the revived agent uses exactly
	 * `manager`, read on main at revive time, and never discovers MCP config itself, even
	 * when `manager` is `undefined`.
	 */
	readonly hostMcp: { readonly manager: MCPManagerApi | undefined } | undefined;
	/**
	 * The factory that built this revive, handed to the revived agent's own extension
	 * `agents` actions so its persisted children stay cold-revivable without a
	 * process-global factory (ACP). Crosses to a worker as a callback into main.
	 */
	readonly reviverFactory: PersistedSubagentReviverFactory;
	/** Idle TTL for agents {@link reviverFactory} cold-revives through those actions. */
	readonly agentIdleTtlMs: number;
}

/** A cold revive before the main thread prepared it. */
type ColdReviveTarget = Omit<PersistedReviveSpec, "prepared">;

/**
 * Durable agent definition name (`scout`, `reviewer`, …) of a persisted subagent.
 * Cold-revived refs register with `displayName: id` (`registry/persisted-agents.ts`),
 * so a generated task id would silently drop agent-scoped rules and budgets.
 * `init.agent` carries the real name; only files predating that field fall back to
 * `displayName`. A parked transcript may also predate the `main`/`sub` definition-name
 * reservation (`discovery/helpers.ts`): a persisted `init.agent` of either sentinel
 * value from such a legacy custom agent must not masquerade as that sentinel, so it
 * falls back to `displayName` too, keeping it scoped as an ordinary subagent under its
 * generated id instead of `main` or the shared `sub` bucket.
 */
export function persistedAgentName(displayName: string, init: PersistedSessionInit): string {
	const normalized = init.agent?.trim().toLowerCase();
	return init.agent && normalized !== MAIN_AGENT_RULE_NAME && normalized !== SUB_AGENT_RULE_NAME
		? init.agent
		: displayName;
}

/**
 * The agent definition a cold-revived subagent's monitored turns report (IRC wakes,
 * `omp --restore`) when its record holds no spawn spec: such files predate an agent-source
 * field, so frames carry the runtime-neutral `user` source; the name is the registry ref's.
 */
export function persistedAgentDefinition(displayName: string, init: PersistedSessionInit): AgentDefinition {
	return {
		name: displayName,
		description: "",
		systemPrompt: init.systemPrompt.join("\n\n"),
		source: "user",
	};
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (Agent Hub scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * Each revive builds the subagent through {@link buildSubagentSession} from the spawn spec
 * of the transcript's latest `session_init` and the live inputs of its live parent session;
 * a record an older omp wrote takes, part by part, what the cold revive built before spawn
 * specs existed.
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	// ACP hosts several concurrent top-level sessions in one process, so it
	// never installs one process-global `PersistedSubagentReviverFactory`
	// (see main.ts's non-ACP bootstrap comment) — a cold-revived subagent's
	// own `api.agents` actions would otherwise have no reviver for ITS OWN
	// persisted children. Reuse this exact factory (anchored to the same
	// ambient top-level `ctx` for every generation) so the whole persisted
	// subtree stays cold-revivable, however deep.
	const idleTtlMs = Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(ctx.settings)) || 0);
	const factory: PersistedSubagentReviverFactory = async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const storage = ctx.storage ?? defaultSessionStorage();
		const peek = await SessionManager.peekSessionInit(sessionFile, storage);
		// No persisted contract (pre-session_init file) or the recorded workspace
		// is gone (isolated/merged worktree, moved dir): leave it transcript-only
		// (history://) rather than resurrect a wrong or broken session.
		if (!peek?.init) return undefined;
		const init = peek.init;
		let restoredSeance: RestoredSeanceSession | undefined;
		if (peek.seanceSource !== undefined) {
			try {
				restoredSeance = await restoreSeanceSession({
					init,
					cwd: peek.cwd,
					modelRegistry: ctx.modelRegistry,
				});
			} catch (error) {
				logger.warn("Unable to restore persisted seance session", {
					sessionFile,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
			if (!restoredSeance) return undefined;
		}
		// Isolated runs are never resumable: their worktree is merged + cleaned,
		// and the parent was told messaging is impossible. A retained workspace
		// (capture/persist failure) still exists on disk and would pass the cwd
		// probe below, so gate on the stamped contract instead — otherwise a
		// restart + peer message revives the agent outside isolation, in the
		// parent cwd, contradicting the delivery notice.
		if (init.isolated) return undefined;
		try {
			await fs.stat(restoredSeance?.cwd ?? peek.cwd);
		} catch {
			return undefined;
		}
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the recorded parent chain, which keeps a
		// parent that ended since, rather than assuming a fixed level. The chain's
		// root is either the literal MAIN_AGENT_ID or (ACP) an unregistered
		// top-level session id such as `acp:<session-id>` — ACP hosts several
		// concurrent top-level sessions, none of which is ever itself an AgentRef
		// (only subagents/advisors are registered) — so neither root is itself a
		// subagent generation. Stop at the owning session's own root (MAIN_AGENT_ID
		// or this ctx's own agent id) rather than only the literal "Main" id, or an
		// ACP-rooted direct child is counted at depth 2 instead of 1 and every
		// subsequent child spawn is rejected by the default `task.maxRecursionDepth`.
		// A non-root ancestor with no registered ref is a real generation: one that
		// ended, or one the persisted scan chose not to register (an incomplete
		// mid-spawn stub it recursed past without adding — see
		// registerPersistedSubagentsFromDir's `metadata.incomplete` branch).
		// agentAncestors lists it, so it counts, or a descendant beneath that gap
		// undercounts its true depth and can out-spawn `task.maxRecursionDepth`.
		const rootAgentId = ctx.session.getAgentId?.() ?? MAIN_AGENT_ID;
		let taskDepth = 1;
		for (const ancestorId of agentAncestors(registry, ref)) {
			if (ancestorId === MAIN_AGENT_ID || ancestorId === rootAgentId) break;
			taskDepth++;
		}
		return async expectedRef => {
			// Live state is read per revive, so a later `/new`, cwd move or registry change is followed.
			const target: ColdReviveTarget = {
				id: ref.id,
				displayName: ref.displayName,
				parentId: ref.parentId,
				sessionFile,
				storage,
				storedCwd: peek.cwd,
				taskDepth,
				restoredSeance,
				root: ctx.session,
				rootAgentId: ctx.session.getAgentId?.() ?? MAIN_AGENT_ID,
				settings: ctx.settings,
				hostMcp: ctx.mcpManager ? { manager: ctx.mcpManager() } : undefined,
				reviverFactory: factory,
				agentIdleTtlMs: idleTtlMs,
			};
			const spec: PersistedReviveSpec = { ...target, prepared: await prepareColdRevive(ctx, target, init) };
			// Worker mode: a revival is placed like a fresh spawn (main thread or a worker), except one that builds on
			// main ({@link PreparedColdRevive.buildsOnMain}).
			const pool = spec.prepared.buildsOnMain ? undefined : subagentWorkerPool(ctx.settings, storage);
			return pool
				? revivePersistedPlaced(pool, spec, expectedRef, revivePersistedSubagent)
				: revivePersistedSubagent(spec, expectedRef);
		};
	};
	return factory;
}

/**
 * The main thread's part of one cold revive, at the start of each reviver call and before anything is
 * reopened: the spec's settings overlay as it restores (checked here, once per revive), the live parent
 * session's inputs (from its home where it is homed in a worker), the model the record's spawn spec starts on
 * as the registry holds it now (a per-call worker: its saved model, held to the grants as they are now), and
 * the spec's custom tools over the live parent's eval kernels. `init` is the `session_init` the factory read.
 */
export async function prepareColdRevive(
	ctx: PersistedSubagentReviveContext,
	target: ColdReviveTarget,
	init: PersistedSessionInit,
): Promise<PreparedColdRevive> {
	const root = ctx.session;
	const stored = coldReviveSpecParts(target, init);
	const settings = stored.settings && coldReviveSettings(target, stored.settings);
	const parts: SpawnSpecParts = { ...stored, settings };
	const parentSession = liveParentSession(target);
	const descriptors = parts.tools?.customTools ?? [];
	const parent = await liveParent(target.id, parentSession, descriptors);
	const agentName = persistedAgentName(target.displayName, init);
	const { live, buildsOnMain } = await coldReviveLiveInputs(
		ctx,
		parent,
		{
			id: target.id,
			name: parts.wake?.agent.name ?? agentName,
			description: parts.wake?.agent.description ?? "",
		},
		parts.liveInputs,
		target.hostMcp,
		// A seance consult takes the seance isolation, whatever directory its source ran in.
		target.restoredSeance ? undefined : target.storedCwd,
	);
	const settingsParent = coldReviveSettingsParent(target, parts, live);
	const modelRegistry = live.modelRegistry;
	const models = new RevivedModels(modelRegistry, settingsParent);
	// The overlay the chain is read from is restored only where the revive walks the chain.
	const chain = (): string[] => retryFallbackChain(target.id, parts.settings, init, settingsParent);
	let model: ExplicitBuildModel | undefined;
	let grants: PerCallGrantInputs | undefined;
	if (isPerCallRecord(parts, init) && !target.restoredSeance) {
		const identity = parts.model ? parts.model.model : init.perCallModelIdentity;
		const level = parts.thinking ? parts.thinking.thinkingLevel : init.perCallThinkingLevel;
		if (!identity || level === undefined) {
			throw new PerCallModelError(
				`Cannot revive subagent "${target.id}": its per-call model identity and thinking level were not recorded separately, so they cannot be restored exactly. The agent was not revived.`,
			);
		}
		grants = await perCallGrantInputs(target, init, parentSession, settingsParent);
		const approve = perCallApproval(target, grants, settingsParent, modelRegistry);
		const ceiling = liveEffortCeiling(
			parts.thinking ? parts.thinking.thinkingLevelCeiling : cfgTaskMaxEffort.get(settingsParent),
			settingsParent,
		);
		model = await choosePerCallModel({
			id: target.id,
			identity,
			level: level ?? undefined,
			chain,
			models,
			modelRegistry,
			ceiling,
			approve: perCallModelAssertion(approve, () => ceiling),
		});
	} else if (parts.model) {
		model = await chooseColdReviveModel({
			id: target.id,
			identity: parts.model.model,
			level: parts.thinking?.thinkingLevel ?? undefined,
			chain,
			models,
			modelRegistry,
			ceiling: liveEffortCeiling(parts.thinking?.thinkingLevelCeiling, settingsParent),
			// The model of the parent's live session; the root's where the parent ref holds no session.
			fallback: parentSession?.model ?? root.model,
		});
	}
	let prewalkTarget: Model | undefined;
	if (parts.prewalk) {
		// Held to the spawn's own check: a target whose provider has no credential is not armed.
		const resolved = await models.resolve(parts.prewalk.target);
		prewalkTarget = resolved && modelRegistry.hasConfiguredAuth(resolved) ? resolved : undefined;
		if (!prewalkTarget) {
			logger.warn("Revived subagent prewalk target unavailable; skipping prewalk", {
				subagent: target.id,
				target: parts.prewalk.target,
			});
		}
	}
	const tools = coldReviveCustomTools(target.id, descriptors, parent?.customTools ?? []);
	// The policy alone falls back to the root's, as the live inputs do: the custom tools of a parent that is not
	// live are asked of no kernel, the root's included.
	const rootTools = root.evalToolSession;
	return {
		live,
		buildsOnMain,
		model,
		prewalkTarget,
		discoveryRan: models.discoveryRan,
		settings: parts.settings,
		grants,
		customTools: tools.customTools,
		unavailableTools: tools.unavailable,
		parentPolicy: parent ? parent.policy : rootTools && parentPolicy(rootTools),
	};
}

/**
 * The parent's live session: the root session for its direct children, else the parent ref's session while
 * that ref holds one; undefined when the parent ref is parked, killed or gone.
 */
function liveParentSession(target: ColdReviveTarget): AgentSessionHandle | undefined {
	if (target.parentId === target.rootAgentId) return target.root;
	return AgentRegistry.global().get(target.parentId ?? "")?.session ?? undefined;
}

/**
 * What `session`, the live parent of subagent `id`, gives its cold revive: read from its tool session where it
 * is homed on this thread, and from its home where it is the mirror of a worker-homed session. Undefined where
 * it holds no tool session or its home cannot answer; the revive then takes the root's inputs.
 */
async function liveParent(
	id: string,
	session: AgentSessionHandle | undefined,
	descriptors: readonly EvalToolDescriptor[],
): Promise<LiveParent | undefined> {
	if (session instanceof RemoteAgentSession) {
		let served: SubagentParentInputs | null;
		let settings: Settings;
		try {
			served = await session.subagentParentInputs(id, descriptors);
			if (!served) return undefined;
			// Served layers that fail the check, as stored ones are checked, are an answer the revive cannot take.
			settings = settingsFromSource(served.settings);
		} catch (error) {
			logger.warn("Revived subagent could not read its live parent's inputs; it takes the root's", {
				subagent: id,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		// Owner policy, read from the parent's mirror while it lives; held weakly, as a spawn holds the provider.
		const parent = new WeakRef(session);
		const roots = session.effectiveExtensionRoots;
		return {
			inputs: {
				...served.live,
				settings,
				extensionRoots: () => parent.deref()?.effectiveExtensionRoots ?? roots,
			},
			policy: served.policy,
			customTools: served.customTools,
			cwd: served.cwd,
		};
	}
	const tools = session && isLocalAgentSession(session) ? session.evalToolSession : undefined;
	if (!tools) return undefined;
	return {
		inputs: parentLiveInputs(tools),
		policy: parentPolicy(tools),
		customTools: await parentEvalCustomTools(id, tools, descriptors),
		cwd: tools.cwd,
	};
}

/**
 * The home thread's answer to `SessionHostProtocol.subagentParentInputs`: what a cold revive of subagent `id`
 * takes from `session`, its live parent homed on this thread; null where the session holds no tool session.
 */
export async function serveSubagentParentInputs(
	session: AgentSession,
	id: string,
	descriptors: readonly EvalToolDescriptor[],
): Promise<SubagentParentInputs | null> {
	const tools = session.evalToolSession;
	if (!tools) return null;
	const { settings: _settings, extensionRoots: _extensionRoots, ...inputs } = parentLiveInputs(tools);
	const customTools = await parentEvalCustomTools(id, tools, descriptors);
	return {
		live: {
			...inputs,
			costGate: mainObject(inputs.costGate),
			cyberPolicyClosure: mainObject(inputs.cyberPolicyClosure),
			authStorage: mainObject(inputs.authStorage),
			modelRegistry: mainObject(inputs.modelRegistry),
			asyncJobManager: mainObject(inputs.asyncJobManager),
			mcpManager: mainObject(inputs.mcpManager),
			parentArtifactManager: mainObject(inputs.parentArtifactManager),
			parentHindsightSessionState: mainObject(inputs.parentHindsightSessionState),
			parentMnemopiSessionState: mainObject(inputs.parentMnemopiSessionState),
			eventBus: mainObject(inputs.eventBus),
			subagentEventBus: mainObject(inputs.subagentEventBus),
		},
		settings: sessionSettingsSource(tools.settings),
		policy: parentPolicy(tools),
		customTools: customTools.map(tool => toWorkerCustomTool(tool)),
		cwd: tools.cwd,
	};
}

/** `value` where it is a main-thread object this thread imported, which reaches main as itself; else undefined. */
function mainObject<T>(value: T | undefined): T | undefined {
	return isRpcProxy(value) ? value : undefined;
}

/** The live inputs `tools`, a live parent's tool session, holds for a child's build. */
function parentLiveInputs(tools: ToolSession): ParentLiveInputs {
	return { ...subagentLiveInputs(tools), eventBus: tools.eventBus, subagentEventBus: tools.subagentEventBus };
}

/** The policy fields `tools`, a live parent's tool session, gives a spawn of it, its roots copied. */
function parentPolicy(tools: ToolSession): ParentPolicy {
	const { credentialSourceSessionId, additionalDirectories } = subagentSpawnerPolicy(tools);
	return { credentialSourceSessionId, additionalDirectories: additionalDirectories && [...additionalDirectories] };
}

/**
 * The tools of `descriptors` the kernels of `tools`, a live parent's tool session, define now; none, with a
 * warning, where they cannot be read.
 */
async function parentEvalCustomTools(
	id: string,
	tools: ToolSession,
	descriptors: readonly EvalToolDescriptor[],
): Promise<CustomTool[]> {
	try {
		return await definedEvalCustomTools(tools, descriptors);
	} catch (error) {
		logger.warn("Revived subagent could not read its parent's eval tools", {
			subagent: id,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/** The spawn spec of a cold revive's record, part by part, as stored; a seance consult's record holds none. */
function coldReviveSpecParts(target: ColdReviveTarget, init: PersistedSessionInit): SpawnSpecParts {
	return target.restoredSeance ? { stored: false } : readSpawnSpec(init);
}

/**
 * `stored`, a spec's settings overlay, as a cold revive restores it. It must restore as `overlay()` checks
 * overrides (each setting known, each value one its definition accepts); an overlay that does not is a malformed
 * part, which takes its legacy variant (undefined), with a warning. Of an overlay that restores, only the settings
 * a spawn writes ({@link SUBAGENT_OVERLAY_SETTINGS}) are kept, so a stored value never widens what the live parent
 * allows, with a warning where it held any other.
 */
function coldReviveSettings(target: ColdReviveTarget, stored: SpawnSpecSettings): SpawnSpecSettings | undefined {
	let kept: KeptOverlayLayers;
	try {
		kept = target.settings.keptOverlayLayers(stored.layers, SUBAGENT_OVERLAY_SETTINGS);
	} catch (error) {
		logger.warn("Revived subagent's stored settings do not restore; it takes the settings of an older record", {
			subagent: target.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (kept.dropped) {
		logger.warn("Revived subagent's stored settings hold values no spawn writes; they read through to the parent", {
			subagent: target.id,
		});
	}
	return spawnSpecSettings({ layers: kept.layers, rootThresholds: stored.rootThresholds });
}

/** What a cold revive restores the subagent's overlay over: the live parent's settings for a spec's, else the root's. */
function coldReviveSettingsParent(
	target: ColdReviveTarget,
	parts: SpawnSpecParts,
	live: ColdReviveLiveInputs,
): Settings {
	return parts.settings ? live.settingsParent : target.settings;
}

/** Whether the subagent's model came from a per-call `model`: the spec's flag, else the record's. */
function isPerCallRecord(parts: SpawnSpecParts, init: PersistedSessionInit): boolean {
	return parts.model ? parts.model.perCallModel : init.perCallModel === true;
}

/**
 * Live inputs a cold revive passes whatever its record's list names, since leaving one out lets the subagent do
 * more than the live process allows. Without the tree's cost gate it starts its own, which `session.maxCost` does
 * not reach; without the tree's cyber-policy closure it starts its own, so it ignores a hold a refusal elsewhere in
 * the tree put on OpenAI's routes (a record written before the closure existed does not name it, and the cold revive
 * passed it before spawn specs); without the prepared extensions it loses a host's inline policy hooks and, as a
 * restricted child, the hooks it inherits. Every spawner passes all three. The extension roots follow their own rule
 * ({@link coldReviveLiveInputs}).
 */
const KEPT_LIVE_INPUTS: Partial<Record<SpawnLiveInputName, true>> = {
	costGate: true,
	cyberPolicyClosure: true,
	preloadedPreparedExtensions: true,
};

/**
 * The live inputs of a subagent build: the live parent's (`parent`), else the root tool session's, as a spawn
 * of either reads them, limited to those the spawn passed where its spec names them, except the inputs of
 * {@link KEPT_LIVE_INPUTS}, which pass whatever the list names. Extension roots the list leaves out pass as that
 * session's without their explicit list, so what the subagent and its own subagents discover still holds to the
 * owner's mode and configured list. A root built without a tool session (a host's root) gives its own objects, as
 * cold revives took them before spawn specs. Where the cwd of the session they come from is not `storedCwd`, the
 * stored session's (undefined for a seance consult), that session's own tool sources serve another directory: its
 * custom-tool paths and its MCP manager do not pass, so the SDK discovers the custom tools and the project's MCP
 * servers in the stored directory; of its extensions only the explicit (configured included) and inline ones stay,
 * beside those discovery finds in the stored directory under the root session's extension policy
 * ({@link moveExtensionsToStoredDirectory}); the secret mask loads that session's project secrets beside the stored
 * directory's; and the revive builds on the main thread. A host's own MCP manager (`hostMcp`) passes in every case:
 * discovery cannot rebuild it.
 */
async function coldReviveLiveInputs(
	ctx: PersistedSubagentReviveContext,
	parent: LiveParent | undefined,
	agent: AgentIdentity,
	names: readonly SpawnLiveInputName[] | undefined,
	hostMcp: PersistedReviveSpec["hostMcp"],
	storedCwd: string | undefined,
): Promise<{ live: ColdReviveLiveInputs; buildsOnMain: boolean }> {
	const root = ctx.session;
	// What the process allows: the root's policy, whichever session the other inputs come from. A host that
	// keeps MCP per top-level session runs its root with MCP off and allows its own manager.
	const rootTools = root.evalToolSession;
	const policy: SubagentLivePolicy = {
		enableLsp: ctx.enableLsp,
		enableIrc: rootTools?.enableIrc,
		enableMCP: hostMcp ? undefined : rootTools?.enableMCP,
	};
	// The session the inputs come from: the live parent, else the root.
	const sourceCwd = parent ? parent.cwd : root.sessionManager.getCwd();
	const elsewhere = storedCwd !== undefined && path.resolve(sourceCwd) !== path.resolve(storedCwd);
	const inputs = parent?.inputs ?? (rootTools ? parentLiveInputs(rootTools) : undefined);
	let live: ColdReviveLiveInputs;
	if (inputs) {
		live = {
			...spawnerLiveInputs(inputs, agent),
			// The source session's own custom-tool paths and MCP manager serve its directory only.
			preloadedCustomToolPaths: elsewhere ? undefined : inputs.preloadedCustomToolPaths,
			authStorage: inputs.authStorage ?? ctx.authStorage,
			modelRegistry: inputs.modelRegistry ?? ctx.modelRegistry,
			subagentEventBus: inputs.subagentEventBus ?? ctx.subagentEventBus,
			mcpManager: elsewhere ? undefined : (inputs.mcpManager ?? MCPManager.instance()),
			settingsParent: inputs.settings ?? ctx.settings,
			eventBus: inputs.eventBus ?? ctx.eventBus,
			parentArtifactManager: inputs.parentArtifactManager,
			policy,
		};
	} else {
		live = {
			costGate: root.costGate,
			cyberPolicyClosure: root.cyberPolicyClosure,
			authStorage: ctx.authStorage,
			modelRegistry: ctx.modelRegistry,
			asyncJobManager: root.asyncJobManager,
			// Owner policy, read when the session asks, never extension authority from a transcript.
			extensionRoots: () => root.effectiveExtensionRoots,
			preloadedPreparedExtensions: root.preparedExtensions,
			mcpManager: elsewhere ? undefined : MCPManager.instance(),
			subagentEventBus: ctx.subagentEventBus,
			settingsParent: ctx.settings,
			eventBus: ctx.eventBus,
			parentArtifactManager: root.sessionManager.getArtifactManager() ?? undefined,
			policy,
		};
	}
	const sourceRoots = live.extensionRoots;
	if (names) {
		const passed = new Set<string>(names);
		for (const name of SPAWN_LIVE_INPUT_NAMES) {
			if (!passed.has(name) && KEPT_LIVE_INPUTS[name] !== true) live[name] = undefined;
		}
		// The explicit list (`--extension`, `additionalExtensionPaths`) holds in both modes, and the agents and
		// commands of its packages would give the subagent spawn targets its spawn did not have.
		if (sourceRoots && !passed.has("extensionRoots")) {
			live.extensionRoots = () => ({ ...sourceRoots(), explicit: [] });
		}
	}
	// Such a host gives the revived agent exactly its manager, read on main at revive time. Its servers come from the
	// host, not from a directory, so it passes where the session the inputs come from works elsewhere too.
	if (hostMcp) live.mcpManager = hostMcp.manager;
	if (!elsewhere) return { live, buildsOnMain: false };
	live.secretsProjectDirs = [sourceCwd];
	await moveExtensionsToStoredDirectory(live, root.effectiveExtensionRoots, ctx.settings, storedCwd);
	return { live, buildsOnMain: true };
}

/**
 * Moves `live`'s extensions to `storedCwd`, the stored session's cwd. Of the prepared extensions (else the extension
 * paths) of the session they came from, only the explicit entries (configured ones included) and the inline ones
 * stay. Every project and user entry, plugins included, comes from one discovery in `storedCwd` under `rootRoots`,
 * the root session's extension roots (their explicit-only mode, with `settings`' disabled list), whatever the
 * record's list names and whatever that session's own roots are. Of that discovery only the project and user entries
 * are added: explicit and configured sources come only from the kept entries (a relative package root re-resolved
 * in `storedCwd` is another copy of one they hold). Each added entry is prepared there and placed first, in
 * discovery's order; a file the kept entries hold is not added again, so it is bound once, at the scope the session
 * it came from gave it. Where prepared extensions pass, the session reads no extension paths, so none pass.
 */
async function moveExtensionsToStoredDirectory(
	live: ColdReviveLiveInputs,
	rootRoots: EffectiveExtensionRoots,
	settings: Settings,
	storedCwd: string,
): Promise<void> {
	const { preloadedPreparedExtensions: preparedExtensions, preloadedExtensionPaths: extensionPaths } = live;
	if (!preparedExtensions && !extensionPaths) return;
	const ambientOnly = (): EffectiveExtensionRoots => ({ ...rootRoots, explicit: [], configured: [] });
	const found = await discoverSessionExtensionPaths({ extensionRoots: ambientOnly }, storedCwd, settings);
	const discovered = found.filter(entry => entry.scope !== "explicit");
	const discoveredKeys = await Promise.all(discovered.map(entry => extensionPathKey(entry.path)));
	const notHeldBy = async (keptFiles: readonly string[]): Promise<ExtensionPathEntry[]> => {
		const held = new Set(await Promise.all(keptFiles.map(extensionPathKey)));
		return discovered.filter((_, index) => !held.has(discoveredKeys[index]));
	};
	const stays = (scope: ExtensionScope): boolean => scope === "explicit" || scope === "inline";
	if (preparedExtensions) {
		const kept = preparedExtensions.filter(entry => stays(entry.scope));
		const added = await notHeldBy(kept.map(entry => entry.resolvedPath));
		const imported = await Promise.all(added.map(entry => importExtensionModule(entry, storedCwd)));
		live.preloadedPreparedExtensions = [...imported, ...kept];
		live.preloadedExtensionPaths = undefined;
	} else if (extensionPaths) {
		const kept = extensionPaths.filter(entry => stays(entry.scope));
		live.preloadedExtensionPaths = [...(await notHeldBy(kept.map(entry => entry.path))), ...kept];
	}
}

/**
 * The custom tools `descriptors` name: each the tool the live parent's kernel serves (one of `served`) where a
 * kernel defines it, else built from its stored descriptor as an unavailable tool, which is named in a
 * warning. No tool is dropped.
 */
function coldReviveCustomTools(
	id: string,
	descriptors: readonly EvalToolDescriptor[],
	served: readonly CustomTool[],
): { customTools: CustomTool[]; unavailable: string[] } {
	const byName = new Map(served.map(tool => [tool.name, tool]));
	const customTools: CustomTool[] = [];
	const unavailable: string[] = [];
	for (const descriptor of descriptors) {
		const tool = byName.get(descriptor.name);
		if (tool) {
			customTools.push(tool);
			continue;
		}
		customTools.push(unavailableEvalCustomTool(descriptor));
		unavailable.push(descriptor.name);
		logger.warn("Revived subagent keeps a custom tool no live kernel defines; a call to it answers unavailable", {
			subagent: id,
			tool: descriptor.name,
		});
	}
	return { customTools, unavailable };
}

/** The `subagent:<id>` retry-fallback chain the spawn installed: in the spec's settings, else the record's. */
function retryFallbackChain(
	id: string,
	settings: SpawnSpecSettings | undefined,
	init: PersistedSessionInit,
	settingsParent: Settings,
): string[] {
	if (!settings) return init.retryFallback?.chain ?? [];
	const role = getRetryFallbackRole(restoreSubagentSettings(settingsParent, settings), subagentRetryFallbackRole(id));
	return role?.chain ?? [];
}

/**
 * The model a cold revive of a record with a spawn spec starts on: the spec's model as the registry holds
 * it, after its discovery ran; else the first model of the subagent's retry-fallback chain that the live
 * retry walk would switch to (its provider enabled and credentialed, within the effort ceiling); else
 * `fallback`, the live parent's (or the root's) model. Each move is logged with the spawn's own message for
 * a model the registry does not know.
 */
async function chooseColdReviveModel(args: {
	id: string;
	identity: string | null;
	level: ConfiguredThinkingLevel | undefined;
	/** The subagent's retry-fallback chain, read only where the spec's model is gone. */
	chain: () => readonly string[];
	models: RevivedModels;
	modelRegistry: ModelRegistry;
	ceiling: Effort | undefined;
	fallback: Model | undefined;
}): Promise<ExplicitBuildModel> {
	const { id, identity, level, modelRegistry, ceiling } = args;
	// A spawn that started on no model left it to the session, as the warm revive does.
	if (identity === null) return { kind: "model", model: undefined, thinkingLevel: level };
	const known = await args.models.resolve(identity);
	if (known) return { kind: "model", model: known, thinkingLevel: level };
	const moved = (model: Model | undefined): void => {
		logger.warn(args.models.notFoundMessage(identity), {
			subagent: id,
			model: model ? formatModelStringWithRouting(model) : undefined,
		});
	};
	for await (const { candidate, model } of args.models.chainModels(args.chain(), identity, known)) {
		if (!model || !modelRegistry.hasConfiguredAuth(model)) continue;
		if (ceiling && !modelSupportsEffortCeiling(model, ceiling)) continue;
		moved(model);
		const thinkingLevel = retryFallbackThinkingLevel(model, candidate.thinkingLevel ?? level, ceiling);
		return { kind: "model", model, thinkingLevel };
	}
	moved(args.fallback);
	return { kind: "model", model: args.fallback, thinkingLevel: level };
}

/**
 * The model a per-call worker resumes on: its saved model where the registry knows it and `approve` (the
 * grants as they are now, and the effort ceiling) passes it; else the first model of its retry-fallback chain
 * that the registry knows and `approve` passes, logged. It is refused where none is: with the grant's error
 * where the registry knows a model of the chain, and an error naming each model where it knows none.
 */
async function choosePerCallModel(args: {
	id: string;
	identity: string;
	level: ConfiguredThinkingLevel | undefined;
	/** The worker's retry-fallback chain, read only where its saved model is gone or refused. */
	chain: () => readonly string[];
	models: RevivedModels;
	modelRegistry: ModelRegistry;
	ceiling: Effort | undefined;
	approve: (model: Model) => void;
}): Promise<ExplicitBuildModel> {
	const { id, identity, level, modelRegistry, approve } = args;
	// Discovery a spawn started may still add the saved model.
	await modelRegistry.awaitBackgroundRefresh();
	const saved = await args.models.resolve(identity);
	const unknown: string[] = [];
	let refusal: unknown;
	if (saved) {
		try {
			approve(saved);
			return { kind: "model", model: saved, thinkingLevel: level };
		} catch (error) {
			refusal = error;
		}
	}
	for await (const { candidate, model } of args.models.chainModels(args.chain(), identity, saved)) {
		if (!model) {
			unknown.push(formatRetryFallbackBaseSelector(candidate));
			continue;
		}
		try {
			approve(model);
		} catch (error) {
			refusal ??= error;
			continue;
		}
		const reason = saved
			? refusal instanceof Error
				? refusal.message
				: String(refusal)
			: args.models.notFoundMessage(identity);
		logger.warn(reason, { subagent: id, model: formatModelStringWithRouting(model) });
		const thinkingLevel = retryFallbackThinkingLevel(model, candidate.thinkingLevel ?? level, args.ceiling);
		return { kind: "model", model, thinkingLevel };
	}
	if (refusal !== undefined) throw refusal;
	const chain = unknown.length > 0 ? `, nor is any model of its retry-fallback chain (${unknown.join(", ")})` : "";
	throw new PerCallModelError(
		`Cannot revive subagent "${id}": its per-call model ${identity} is no longer available${chain}. The agent was not revived.`,
	);
}

/** The agent the spawn selected, as the live discovery scope finds it now: what its grants rest on. */
async function perCallGrantInputs(
	target: ColdReviveTarget,
	init: PersistedSessionInit,
	parentSession: AgentSessionHandle | undefined,
	settings: Settings,
): Promise<PerCallGrantInputs> {
	// File definitions follow the live parent's discovery scope; a missing parent
	// can use current root file discovery, never unrelated root-local pseudonyms.
	const discoverySession = parentSession ?? target.root;
	const configuredAgent = init.agent
		? getAgent(
				[
					...(
						await discoverAgents(
							discoverySession.sessionManager.getCwd(),
							undefined,
							discoverySession.effectiveExtensionRoots,
						)
					).agents,
					...(parentSession?.getSessionAgents() ?? []),
				],
				init.agent,
			)
		: undefined;
	return {
		agentName: init.agent ?? target.displayName,
		agentModel: configuredAgent?.model,
		agentSource: configuredAgent?.source,
		agentRemoved: configuredAgent === undefined,
		matchPreferences: structuredClone(getModelMatchPreferences(settings.grantAuthority())),
	};
}

/**
 * Holds a revived per-call worker's models to the operator's grants as they are at each call: the agent
 * the spawn selected, and the model of its real parent while that parent is live.
 */
function perCallApproval(
	target: ColdReviveTarget,
	grants: PerCallGrantInputs,
	settings: Settings,
	modelRegistry: ModelRegistry,
): (model: Model) => void {
	// One grants object per live parent model keeps approval decisions cached across requests.
	const grantsByParentModel = new Map<string | undefined, PerCallModelGrants>();
	return model => {
		// Parent models grant only while the real parent is live, including
		// after this revival; transcript metadata never substitutes for it.
		const parentSession = liveParentSession(target);
		const parentModel = parentSession?.model;
		const parentModelPattern = parentModel ? parentModelGrantPattern(parentModel) : undefined;
		let modelGrants = grantsByParentModel.get(parentModelPattern);
		if (!modelGrants) {
			modelGrants = { ...grants, settings, parentModelPattern };
			grantsByParentModel.set(parentModelPattern, modelGrants);
		}
		try {
			assertPerCallModelApproved(model, modelGrants, modelRegistry);
		} catch (error) {
			// Only an approval denial depends on the parent; an unavailable model is refused either way.
			if (parentSession || !(error instanceof PerCallModelError) || error instanceof PerCallModelUnavailableError) {
				throw error;
			}
			throw new PerCallModelError(
				`${error.message} Parent agent "${target.parentId ?? "unknown"}" of revived subagent "${target.id}" is not live; its model grants nothing and its parent-local agent grants are unavailable until the parent is revived.`,
			);
		}
	};
}

/**
 * Rebuild the persisted subagent of `spec` on the calling thread (main, or the pooled
 * worker that will home it) and claim `expectedRef` for it.
 */
export async function revivePersistedSubagent(spec: PersistedReviveSpec, expectedRef: AgentRef): Promise<AgentSession> {
	const { prepared, restoredSeance } = spec;
	const reopened = await reopenParkedSubagent(spec.id, spec.sessionFile, spec.storage);
	const init = extractSessionInit(reopened.getEntries());
	if (!init) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${spec.id}": session file "${spec.sessionFile}" has no persisted session contract. The agent was not revived.`,
		);
	}
	// Where the subagent's tools run, as the reopened manager reads it: the build and the tools share one directory.
	const cwd = reopened.getCwd();
	// The settings overlay as the main thread checked it, once per revive; the other parts as the record holds them.
	const parts: SpawnSpecParts = { ...coldReviveSpecParts(spec, init), settings: prepared.settings };
	const settingsParent = coldReviveSettingsParent(spec, parts, prepared.live);
	const { spawnSpec, legacy } = coldReviveSpawnSpec(spec, parts, init, settingsParent, cwd);
	const approve = prepared.grants
		? perCallApproval(spec, prepared.grants, settingsParent, prepared.live.modelRegistry)
		: undefined;
	const live: SubagentLiveInputs = {
		...prepared.live,
		settingsParent,
		customTools: [...prepared.customTools],
		// A per-call model is held to the operator's grants as they are now, and to the effort ceiling.
		assertDispatchModel: approve
			? perCallModelAssertion(approve, () => liveEffortCeiling(spawnSpec.thinkingLevelCeiling, settingsParent))
			: undefined,
		// A seance consult keeps its own artifacts and its isolation.
		parentArtifactManager: restoredSeance ? undefined : prepared.live.parentArtifactManager,
		// The output files go to the parent's artifacts directory, so the root session's secrets mask them.
		storeMaskCwd: spec.settings.getCwd(),
		seance: restoredSeance ? {} : undefined,
	};
	const model = await coldReviveModel(spec, init, { spec: spawnSpec, live, sessionManager: reopened });
	const session = await buildSubagentSession({
		spec: spawnSpec,
		live,
		sessionManager: reopened,
		storage: spec.storage,
		model,
		prewalkTarget: prepared.prewalkTarget,
		revive: {
			heldInit: init,
			expectedAgentRef: expectedRef,
			legacy,
			agentActionsScope: { reviverFactory: spec.reviverFactory, idleTtlMs: spec.agentIdleTtlMs },
		},
	});
	if (spawnSpec.perCallModel) {
		// A per-call worker runs only on the model it was approved on, never a similarly named survivor.
		const expected = model.kind === "model" && model.model ? formatModelStringWithRouting(model.model) : undefined;
		const identity = session.model ? formatModelStringWithRouting(session.model) : undefined;
		if (identity !== expected) {
			await session.dispose();
			throw new PerCallModelError(
				`Cannot revive subagent "${spec.id}": its per-call model ${expected} is no longer available${identity ? ` (resolution found ${identity})` : ""}.`,
			);
		}
		// An explicit unset selector must not inherit a new default while reviving.
		if (!parts.thinking && init.perCallThinkingLevel === null) session.setThinkingLevel(undefined);
	}
	if (prepared.unavailableTools.length > 0) {
		// After the transcript, so the held prompt, the tool list and the conversation keep their bytes.
		await session.sendCustomMessage(
			{
				customType: UNAVAILABLE_CUSTOM_TOOLS_NOTICE,
				content: prompt.render(unavailableCustomToolsPrompt, { tools: prepared.unavailableTools }),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
	}
	return session;
}

/**
 * The model of the build. A seance consult starts on its source run's patterns, never on a switched model.
 * A prepared model (a spec's, a per-call worker's) holds unless a session-local switch since the spawn takes
 * its place, as {@link switchedOrHeldModel} decides for both revives. A record whose spec gives no model
 * starts on the record's patterns, the switched model first.
 */
async function coldReviveModel(
	spec: PersistedReviveSpec,
	init: PersistedSessionInit,
	build: Pick<SubagentBuildInput, "spec" | "live" | "sessionManager">,
): Promise<ColdReviveBuildModel> {
	const { prepared, restoredSeance } = spec;
	// A seance fork's selections belong to its source run, never to the consult.
	if (restoredSeance) return { kind: "legacy", modelPattern: restoredSeance.modelPattern };
	if (prepared.model) return switchedOrHeldModel(build, prepared.model, prepared.discoveryRan);
	const switched = build.sessionManager.getSessionLocalModelChange()?.model;
	const spawnModelPattern =
		init.modelRole && init.modelRole !== "default"
			? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
			: init.resolvedModel;
	return {
		kind: "legacy",
		modelPattern:
			switched === undefined
				? spawnModelPattern
				: [switched, ...(spawnModelPattern === undefined ? [] : [spawnModelPattern].flat())],
		modelPatternAuthFallback: init.resolvedModel,
	};
}

/**
 * The spawn spec the build starts from: each part of the record's spec, and for each part it lacks (every
 * part of a record an older omp wrote, or of a seance consult) or holds in a shape no spawn writes what the
 * cold revive built before spawn specs, with the values every spawn gives (`cacheWarming: false`). The build runs
 * in `cwd`, the stored session's cwd. A stored value never widens what the live process allows, except the values
 * that the cold revive also took from the stored session before spawn specs existed, which the `spawnSpec`
 * paragraph of `docs/session.md` lists with what the stored cwd chooses. The other fields of a stored part that
 * select a place, an authority or a limit take the live value, or the narrower of the stored and the live one.
 */
function coldReviveSpawnSpec(
	spec: PersistedReviveSpec,
	parts: SpawnSpecParts,
	init: PersistedSessionInit,
	settingsParent: Settings,
	cwd: string,
): { spawnSpec: SubagentSpawnSpec; legacy: SubagentLegacyRevive | undefined } {
	const { id, displayName, restoredSeance } = spec;
	const agentName = persistedAgentName(displayName, init);
	const legacyAgent = persistedAgentDefinition(displayName, init);
	// Older session files persisted the synthetic xd:// write transport in the
	// enabled set. A read-only agent definition could never grant full write,
	// so remove that transport name before replaying tools as explicit grants.
	const legacyToolNames = restoredSeance
		? restoredSeance.toolNames
		: init.readOnly === true && init.tools.includes("write")
			? init.tools.filter(name => name !== "write")
			: init.tools;
	// A restricted persisted contract must not consult process-global MCP
	// state: same-name MCP tools are untrusted capability sources.
	const restricted = restoredSeance !== undefined || init.restrictToolNames === true;
	const tools = parts.tools ?? {
		toolNames: legacyToolNames,
		mountedToolNames: init.mountedTools ?? [],
		restrictToolNames: restricted || undefined,
		// The spawn's result contract: a session persisted without `yield` returned its final message.
		requireYieldTool: legacyToolNames.includes("yield"),
		// The record's tool list already leaves out what its spawn stripped.
		keepTodo: true,
		outputSchema: jsonValue(init.outputSchema),
		outputSchemaMode: init.outputSchemaMode,
		customTools: [],
	};
	const structured = (tools.toolNames ?? []).includes("yield");
	const perCall = isPerCallRecord(parts, init);
	const legacy: SubagentLegacyRevive = {};
	if (!parts.tools) {
		legacy.tools = { mountedToolNames: restoredSeance ? undefined : init.mountedTools, keepDevices: !restoredSeance };
	}
	if (!parts.prompt) legacy.replayPrompt = true;
	// Only a record with no spec keeps the workspace roots its header holds; a malformed policy part does not.
	if (!parts.stored) legacy.keepHeaderRoots = true;
	const policy: SpawnSpecPolicy = parts.policy
		? {
				...parts.policy,
				// The constant every spawn writes.
				cacheWarming: false,
				// The stored session's cwd, where its tools run, never the stored policy's.
				cwd,
				// Never shallower than the live parent chain, so `task.maxRecursionDepth` holds.
				taskDepth: Math.max(parts.policy.taskDepth ?? spec.taskDepth, spec.taskDepth),
				// Where the spawn passed them, the spawner's as the live parent holds them now (the root's where the
				// parent is not live), never the record's; none where the spawn passed none (a vibe worker's spawner).
				credentialSourceSessionId:
					parts.policy.credentialSourceSessionId === undefined
						? undefined
						: spec.prepared.parentPolicy?.credentialSourceSessionId,
				additionalDirectories:
					parts.policy.additionalDirectories === undefined
						? undefined
						: spec.prepared.parentPolicy?.additionalDirectories,
			}
		: {
				cwd: restoredSeance?.cwd ?? cwd,
				enableLsp: spec.prepared.live.policy.enableLsp,
				// The constant every spawn writes, for a record with no spec and for a spec whose policy part is
				// missing or malformed alike.
				cacheWarming: false,
				...(restricted ? { enableIrc: false, enableMCP: false } : { enableMCP: !spec.prepared.live.mcpManager }),
				// Mirrors the task executor's own internal-spawner opt-in: `initializeExtensions`
				// re-runs `discoverStartupSkillPaths()` once session_start fires, and without
				// this the merge is a no-op, silently dropping any resources_discover
				// contribution the revived subagent's own extensions make.
				mergeDiscoveredSkillPaths: true,
				// Old files predate persisted spawns: deny re-spawning rather than let
				// createAgentSession default to wildcard ("*").
				spawns: init.spawns ?? "",
				taskDepth: spec.taskDepth,
			};
	const spawnSpec: SubagentSpawnSpec = {
		v: SPAWN_SPEC_VERSION,
		model: parts.model?.model ?? null,
		thinkingLevel: parts.thinking?.thinkingLevel ?? null,
		// A per-call model keeps the live task.maxEffort ceiling the spawn ran under.
		thinkingLevelCeiling: parts.thinking
			? parts.thinking.thinkingLevelCeiling
			: perCall
				? cfgTaskMaxEffort.get(settingsParent)
				: undefined,
		perCallModel: perCall,
		prewalk: parts.prewalk,
		// The constructor records it for the revived session; a record with no spec holds none.
		startupFallback: parts.startupFallback,
		settings: parts.settings ?? legacySubagentSettings(id, init, settingsParent),
		tools,
		// A host that keeps MCP per top-level session gives the revived agent its own manager
		// (`coldReviveLiveInputs`), and the agent never discovers MCP config itself.
		policy: spec.hostMcp ? { ...policy, enableMCP: false } : policy,
		identity: {
			// The names the record stores (`agents` rule scoping keys on the durable definition name, see
			// `persistedAgentName`); the ids are the live registry ref's, never the record's.
			agentName: parts.identity ? parts.identity.agentName : agentName,
			agentDisplayName: parts.identity ? parts.identity.agentDisplayName : displayName,
			// `id` is the AgentRegistry key, which may be a `qualifyPersistedAgentId`-disambiguated
			// `owner/bareId` string when this id collided with an unrelated session's identically-named
			// agent: the build claims and reports under that key. Descendant naming never takes the
			// qualifier: `AgentOutputManager` nests child ids under `parentTaskPrefix` and `runSubprocess`
			// writes them to `path.join(artifactsDir, \`${id}.jsonl\`)`, so a slash there would write
			// descendants below an unexpected intermediate directory that the persisted-agent scan never
			// looks inside.
			agentId: id,
			parentAgentId: spec.parentId,
			parentTaskPrefix: bareAgentId(id, spec.parentId),
		},
		// The session drives the registry status and the wake frames of this id: the ref's, never the record's.
		prompt: parts.prompt
			? { ...parts.prompt, id }
			: {
					id,
					agentSystemPrompt: legacyAgent.systemPrompt,
					context: "",
					planReference: "",
					planReferencePath: "",
					worktree: "",
					structured,
					outputSchemaOverridesAgent: false,
					ircEnabled: false,
				},
		wake: parts.wake
			? {
					...parts.wake,
					// The run's artifacts go to the revived ref's own dir, and its limits are never looser than the
					// live settings'.
					artifactsDir: path.dirname(spec.sessionFile),
					maxRuntimeMs: tighterLimit(parts.wake.maxRuntimeMs, cfgTaskMaxRuntimeMs.get(settingsParent)),
					softRequestBudget: tighterLimit(
						parts.wake.softRequestBudget,
						softRequestBudgetFor(parts.wake.agent.name, settingsParent).softRequestBudget,
					),
				}
			: {
					agent: { name: legacyAgent.name, description: legacyAgent.description, source: legacyAgent.source },
					completionProbe: isCompletionProbeEnabled(spec.settings, spec.taskDepth - 1),
					...softRequestBudgetFor(agentName, spec.settings),
					structured,
					outputSchema: jsonValue(init.outputSchema),
					outputSchemaMode: init.outputSchemaMode,
					// Anchor artifacts to the revived ref's own dir (its parent's children
					// dir), not the live root session's, matching the spawn callers (#11563).
					artifactsDir: path.dirname(spec.sessionFile),
				},
	};
	return { spawnSpec, legacy: legacy.tools || legacy.replayPrompt || legacy.keepHeaderRoots ? legacy : undefined };
}

/**
 * The tighter of a stored limit and the live one, where 0 (or no stored value) sets none: a stored limit never
 * loosens what the live settings allow.
 */
export function tighterLimit(stored: number | undefined, live: number): number {
	const limits = [stored ?? 0, live].filter(limit => limit > 0);
	return limits.length > 0 ? Math.min(...limits) : 0;
}

/**
 * The subagent settings of a record with no spawn spec, over `parent`: the same advisor opt-in, summarize
 * switch and compaction threshold the spawn resolved, and the `subagent:<id>` fallback chain it installed,
 * which the transcript alone cannot rebuild (multi-model agent patterns and inherited role chains are
 * resolved only at spawn).
 */
function legacySubagentSettings(id: string, init: PersistedSessionInit, parent: Settings): SpawnSpecSettings {
	const overrides: SubagentOverlayOverrides = {};
	if (init.readSummarize === false) overrides["read.summarize.enabled"] = false;
	if (init.advisor) {
		overrides["advisor.enabled"] = true;
		// `"on"` = advisor-role model, anything else = the pattern stamped onto this session's
		// `modelRoles.advisor`, which spawn persists already expanded against the spawning owner's roles;
		// expanding again is a no-op for those and only resolves aliases in files written before that.
		if (init.advisor !== "on") {
			overrides.modelRoles = {
				...parent.getModelRoles(),
				advisor: resolveAgentAdvisorRolePattern(init.advisor, parent),
			};
		}
	}
	const settings = createSubagentSettings(parent, {
		...overrides,
		...compactionThresholdSettings(init.compactionThreshold),
	});
	if (init.retryFallback) installRetryFallbackRole(settings, subagentRetryFallbackRole(id), init.retryFallback);
	return spawnSpecSettings(captureSubagentSettings(settings));
}
