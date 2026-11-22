import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentIdentity } from "@oh-my-pi/pi-agent-core";
import type { JsonValue, Model } from "@oh-my-pi/pi-ai";
import { type ConfiguredThinkingLevel, modelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import type { ModelRegistry } from "../config/model-registry";
import {
	disabledProviderIds,
	enabledProviderModels,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	modelNotFoundMessage,
	resolveAgentAdvisorRolePattern,
	resolveSpawnModelIdentity,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import type { EvalToolDescriptor } from "../eval/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { MCPManager } from "../mcp/manager";
import unavailableCustomToolsPrompt from "../prompts/system/unavailable-custom-tools.md" with { type: "text" };
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { type AgentSessionHandle, isLocalAgentSession } from "../session/agent-session-handle";
import type { AuthStorage } from "../session/auth-storage";
import {
	formatRetryFallbackBaseSelector,
	getRetryFallbackRole,
	installRetryFallbackRole,
	parseRetryFallbackChainEntry,
	type RetryFallbackSelector,
	retryFallbackThinkingLevel,
} from "../session/retry-fallback-chains";
import { extractSessionInit, type PersistedSessionInit, SessionManager } from "../session/session-manager";
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
import { cfgTaskMaxEffort, cfgTaskMaxRuntimeMs } from "./settings";
import {
	type JsonRecord,
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
import { subagentLiveInputs } from "./structured-subagent";
import type { AgentDefinition } from "./types";

/** Custom type of the message that names a revived subagent's unavailable custom tools to its model. */
const UNAVAILABLE_CUSTOM_TOOLS_NOTICE = "unavailable-custom-tools";

/**
 * Ambient context the reviver needs at revive time. The top-level session is kept LIVE and read at each
 * revive rather than snapshotted: a revived subagent discovers its context in the root's current cwd, so a
 * later `/new` or cwd move is followed, and its tools run in the cwd its record's header holds; a seance
 * consult does both in the cwd its record holds. A revive takes the artifact manager of its live parent
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
}

/** The live inputs a cold revive takes from the live parent session; the reviving thread adds its own. */
export type ColdReviveLiveInputs = Omit<
	SubagentLiveInputs,
	"assertDispatchModel" | "customTools" | "oauthAccountPools" | "seance"
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
}

/**
 * The policy fields a spawn takes from its spawner's tool session (`buildExecutorOptions`); a cold revive takes
 * them from the live parent, never from the record.
 */
type ParentPolicy = Pick<SpawnSpecPolicy, "credentialSourceSessionId" | "additionalDirectories">;

/**
 * A live parent's inputs for a child's build, its policy fields, and the tools of the child's descriptors its
 * kernels define now.
 */
interface LiveParent {
	readonly inputs: ParentLiveInputs;
	readonly policy: ParentPolicy;
	readonly customTools: readonly CustomTool[];
}

/** The model a cold revive builds on: never the patterns of a spawn's deferred model resolution. */
type ColdReviveBuildModel = ExplicitBuildModel | LegacyBuildModel;

/** A per-call worker's grants besides the live settings and the live parent's model, which each request reads. */
export type PerCallGrantInputs = Omit<PerCallModelGrants, "settings" | "parentModelPattern">;

/** What the main thread prepares for one cold revive before anything is reopened ({@link prepareColdRevive}). */
export interface PreparedColdRevive {
	/** The live parent session's inputs: the parent ref's while it holds a session, else the root's. */
	readonly live: ColdReviveLiveInputs;
	/** The model a spawn spec's model or a per-call worker starts on; absent, the record's patterns decide. */
	readonly model: ExplicitBuildModel | undefined;
	/**
	 * The model the spec's prewalk target names, where the registry knows it and its provider has a credential;
	 * else the prewalk is not armed.
	 */
	readonly prewalkTarget: Model | undefined;
	/** The registry's discovery ran while this step resolved a model; the build does not run it again. */
	readonly discoveryRan: boolean;
	/** A per-call worker's grants, which each of its requests is held to. */
	readonly grants: PerCallGrantInputs | undefined;
	/** Each custom tool the spec names, built over the live parent's kernel or kept as unavailable. */
	readonly customTools: readonly CustomTool[];
	/** Names of the custom tools no live kernel serves. */
	readonly unavailableTools: readonly string[];
	/** The root session's cwd, where a revived subagent discovers its context (its tools run in its header's). */
	readonly rootCwd: string;
	/** The live parent's policy fields a spawn takes from its spawner; undefined where no parent is live. */
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
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
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
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		return async expectedRef => {
			// Live state is read per revive, so a later `/new`, cwd move or registry change is followed.
			const target: ColdReviveTarget = {
				id: ref.id,
				displayName: ref.displayName,
				parentId: ref.parentId,
				sessionFile,
				taskDepth,
				restoredSeance,
				root: ctx.session,
				rootAgentId: ctx.session.getAgentId?.() ?? MAIN_AGENT_ID,
				settings: ctx.settings,
			};
			const spec: PersistedReviveSpec = { ...target, prepared: await prepareColdRevive(ctx, target, init) };
			// Worker mode: a revival is placed like a fresh spawn (main thread or a worker).
			const pool = subagentWorkerPool(ctx.settings);
			return pool
				? revivePersistedPlaced(pool, spec, expectedRef, revivePersistedSubagent)
				: revivePersistedSubagent(spec, expectedRef);
		};
	};
}

/**
 * The main thread's part of one cold revive, at the start of each reviver call and before anything is
 * reopened: the live parent session's inputs (from its home where it is homed in a worker), the model the
 * record's spawn spec starts on as the registry holds it now (a per-call worker: its saved model, held to
 * the grants as they are now), and the spec's custom tools over the live parent's eval kernels. `init` is
 * the `session_init` the factory read.
 */
export async function prepareColdRevive(
	ctx: PersistedSubagentReviveContext,
	target: ColdReviveTarget,
	init: PersistedSessionInit,
): Promise<PreparedColdRevive> {
	const root = ctx.session;
	const { parts, rejected, unwritten } = coldReviveSpecParts(target, init);
	if (rejected !== undefined) {
		logger.warn("Revived subagent's stored settings do not restore; it takes the settings of an older record", {
			subagent: target.id,
			error: rejected,
		});
	}
	if (unwritten) {
		logger.warn("Revived subagent's stored settings hold values no spawn writes; they read through to the parent", {
			subagent: target.id,
		});
	}
	const parentSession = liveParentSession(target);
	const descriptors = parts.tools?.customTools ?? [];
	const parent = await liveParent(target.id, parentSession, descriptors);
	const agentName = persistedAgentName(target.displayName, init);
	const live = coldReviveLiveInputs(
		ctx,
		parent?.inputs,
		{
			id: target.id,
			name: parts.wake?.agent.name ?? agentName,
			description: parts.wake?.agent.description ?? "",
		},
		parts.liveInputs,
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
			settings: settingsParent,
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
			settings: settingsParent,
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
	return {
		live,
		model,
		prewalkTarget,
		discoveryRan: models.discoveryRan,
		grants,
		customTools: tools.customTools,
		unavailableTools: tools.unavailable,
		rootCwd: root.sessionManager.getCwd(),
		parentPolicy: parent?.policy,
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
		try {
			served = await session.subagentParentInputs(id, descriptors);
		} catch (error) {
			logger.warn("Revived subagent could not read its live parent's inputs; it takes the root's", {
				subagent: id,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (!served) return undefined;
		// Owner policy, read from the parent's mirror while it lives; held weakly, as a spawn holds the provider.
		const parent = new WeakRef(session);
		const roots = session.effectiveExtensionRoots;
		return {
			inputs: {
				...served.live,
				settings: settingsFromSource(served.settings),
				extensionRoots: () => parent.deref()?.effectiveExtensionRoots ?? roots,
			},
			policy: served.policy,
			customTools: served.customTools,
		};
	}
	const tools = session && isLocalAgentSession(session) ? session.evalToolSession : undefined;
	if (!tools) return undefined;
	return {
		inputs: parentLiveInputs(tools),
		policy: parentPolicy(tools),
		customTools: await parentEvalCustomTools(id, tools, descriptors),
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

/** The policy fields `tools`, a live parent's tool session, gives a spawn of it. */
function parentPolicy(tools: ToolSession): ParentPolicy {
	const directories = tools.additionalDirectories;
	return {
		credentialSourceSessionId: tools.getCredentialSourceSessionId?.(),
		additionalDirectories: directories ? [...directories] : undefined,
	};
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

/**
 * The spawn spec of a cold revive's record, part by part; a seance consult's record holds none. The stored
 * settings overlay must restore as `overlay()` checks overrides (each setting known, each value one its
 * definition accepts); an overlay that does not is a malformed part, which takes its legacy variant, and
 * `rejected` holds the check's error. Of an overlay that restores, only the settings a spawn writes
 * ({@link SUBAGENT_OVERLAY_SETTINGS}) are kept, so a stored value never widens what the live parent allows;
 * `unwritten` says whether it held any other.
 */
function coldReviveSpecParts(
	target: ColdReviveTarget,
	init: PersistedSessionInit,
): { parts: SpawnSpecParts; rejected?: string; unwritten?: boolean } {
	if (target.restoredSeance) return { parts: { stored: false } };
	const parts = readSpawnSpec(init);
	if (!parts.settings) return { parts };
	try {
		target.settings.assertOverlayLayers(parts.settings.layers);
	} catch (error) {
		return {
			parts: { ...parts, settings: undefined },
			rejected: error instanceof Error ? error.message : String(error),
		};
	}
	const { global, overrides, derived } = parts.settings.layers;
	const written = { global: spawnWrittenLayer(global), overrides: spawnWrittenLayer(overrides), derived };
	return {
		parts: { ...parts, settings: { ...parts.settings, layers: written } },
		unwritten: !Bun.deepEquals(written, parts.settings.layers),
	};
}

/** Setting paths as a tree of their segments; `true` marks a whole setting. */
interface SettingPathTree {
	[segment: string]: SettingPathTree | true;
}

/** `layer` (one layer of a stored overlay) holding only the settings of {@link SUBAGENT_OVERLAY_SETTINGS}. */
function spawnWrittenLayer(layer: JsonRecord): JsonRecord {
	const tree: SettingPathTree = {};
	for (const id of SUBAGENT_OVERLAY_SETTINGS) {
		const segments = id.split(".");
		let node = tree;
		for (const [index, segment] of segments.entries()) {
			if (index === segments.length - 1) {
				node[segment] = true;
				break;
			}
			let next = node[segment];
			if (next === true) break;
			if (!next) {
				next = {};
				node[segment] = next;
			}
			node = next;
		}
	}
	return pickSettings(layer, tree);
}

/** The values of `layer` at the paths `tree` names. */
function pickSettings(layer: JsonRecord, tree: SettingPathTree): JsonRecord {
	const picked: { [key: string]: JsonValue } = {};
	for (const key in tree) {
		if (!Object.hasOwn(layer, key)) continue;
		const value = layer[key];
		const branch = tree[key];
		if (branch === true) {
			picked[key] = value;
		} else if (isJsonRecord(value)) {
			const inner = pickSettings(value, branch);
			if (Object.keys(inner).length > 0) picked[key] = inner;
		}
	}
	return picked;
}

/** Whether `value` is a JSON object, as a stored overlay layer's settings groups are. */
function isJsonRecord(value: JsonValue): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * The live inputs of a subagent build: the live parent's (`parent`), else the root tool session's, as a spawn
 * of either reads them, limited to those the spawn passed where its spec names them. A root built without a
 * tool session (a host's root) gives its own objects, as cold revives took them before spawn specs.
 */
function coldReviveLiveInputs(
	ctx: PersistedSubagentReviveContext,
	parent: ParentLiveInputs | undefined,
	agent: AgentIdentity,
	names: readonly SpawnLiveInputName[] | undefined,
): ColdReviveLiveInputs {
	const root = ctx.session;
	// What the process allows: the root's policy, whichever session the other inputs come from.
	const rootTools = root.evalToolSession;
	const policy: SubagentLivePolicy = {
		enableLsp: ctx.enableLsp,
		enableIrc: rootTools?.enableIrc,
		enableMCP: rootTools?.enableMCP,
	};
	const inputs = parent ?? (rootTools ? parentLiveInputs(rootTools) : undefined);
	let live: ColdReviveLiveInputs;
	if (inputs) {
		live = {
			...spawnerLiveInputs(inputs, agent),
			authStorage: inputs.authStorage ?? ctx.authStorage,
			modelRegistry: inputs.modelRegistry ?? ctx.modelRegistry,
			subagentEventBus: inputs.subagentEventBus ?? ctx.subagentEventBus,
			mcpManager: inputs.mcpManager ?? MCPManager.instance(),
			settingsParent: inputs.settings ?? ctx.settings,
			eventBus: inputs.eventBus ?? ctx.eventBus,
			parentArtifactManager: inputs.parentArtifactManager,
			policy,
		};
	} else {
		live = {
			costGate: root.costGate,
			authStorage: ctx.authStorage,
			modelRegistry: ctx.modelRegistry,
			asyncJobManager: root.asyncJobManager,
			// Owner policy, read when the session asks, never extension authority from a transcript.
			extensionRoots: () => root.effectiveExtensionRoots,
			preloadedPreparedExtensions: root.preparedExtensions,
			mcpManager: MCPManager.instance(),
			subagentEventBus: ctx.subagentEventBus,
			settingsParent: ctx.settings,
			eventBus: ctx.eventBus,
			parentArtifactManager: root.sessionManager.getArtifactManager() ?? undefined,
			policy,
		};
	}
	if (names) {
		const passed = new Set<string>(names);
		for (const name of SPAWN_LIVE_INPUT_NAMES) {
			if (!passed.has(name)) live[name] = undefined;
		}
	}
	return live;
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
 * Each model a retry-fallback `chain` names when the stored model `identity` failed, in the chain's order,
 * every entry read as the live retry walk reads it (a provider wildcard keeps the failing model's id under
 * another provider, without an aggregator's vendor prefix the target provider does not use): the entry's
 * selector, and the model the registry holds for it, if any, among the providers `settings` leave enabled.
 */
function* chainModels(
	chain: readonly string[],
	identity: string,
	modelRegistry: ModelRegistry,
	settings: Settings,
): Generator<{ candidate: RetryFallbackSelector; model: Model | undefined }> {
	// A stored identity is exact: no part of its id is read as a thinking level.
	const slash = identity.indexOf("/");
	const current: RetryFallbackSelector = {
		raw: identity,
		provider: identity.slice(0, slash),
		id: identity.slice(slash + 1),
		thinkingLevel: undefined,
	};
	for (const entry of chain) {
		const candidate = parseRetryFallbackChainEntry({ modelLookup: modelRegistry }, entry, current);
		if (!candidate) continue;
		const model = resolveSpawnModelIdentity(formatRetryFallbackBaseSelector(candidate), modelRegistry, settings);
		yield { candidate, model };
	}
}

/**
 * The spawn's own message for a model the registry does not know, its hint drawn, as the spawn draws it,
 * from the models of the providers `settings` leave enabled.
 */
function notFoundMessage(identity: string, modelRegistry: ModelRegistry, settings: Settings): string {
	return modelNotFoundMessage(
		[identity],
		enabledProviderModels(modelRegistry.getAll(), disabledProviderIds(settings)),
	);
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
	/** The live settings, whose disabled providers have no models. */
	settings: Settings;
	ceiling: Effort | undefined;
	fallback: Model | undefined;
}): Promise<ExplicitBuildModel> {
	const { id, identity, level, modelRegistry, ceiling } = args;
	// A spawn that started on no model left it to the session, as the warm revive does.
	if (identity === null) return { kind: "model", model: undefined, thinkingLevel: level };
	const known = await args.models.resolve(identity);
	if (known) return { kind: "model", model: known, thinkingLevel: level };
	// The chain walk sees what the discovery adds, also where the stored model is held under a disabled provider.
	await args.models.discover();
	const moved = (model: Model | undefined): void => {
		logger.warn(notFoundMessage(identity, modelRegistry, args.settings), {
			subagent: id,
			model: model ? formatModelStringWithRouting(model) : undefined,
		});
	};
	for (const { candidate, model } of chainModels(args.chain(), identity, modelRegistry, args.settings)) {
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
	/** The live settings, whose disabled providers have no models. */
	settings: Settings;
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
	} else {
		// The chain walk sees what the discovery adds, also where the saved model is held under a disabled provider.
		await args.models.discover();
	}
	for (const { candidate, model } of chainModels(args.chain(), identity, modelRegistry, args.settings)) {
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
			: notFoundMessage(identity, modelRegistry, args.settings);
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
	const reopened = await reopenParkedSubagent(spec.id, spec.sessionFile);
	const init = extractSessionInit(reopened.getEntries());
	if (!init) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${spec.id}": session file "${spec.sessionFile}" has no persisted session contract. The agent was not revived.`,
		);
	}
	const { parts } = coldReviveSpecParts(spec, init);
	const settingsParent = coldReviveSettingsParent(spec, parts, prepared.live);
	const { spawnSpec, legacy } = coldReviveSpawnSpec(spec, parts, init, settingsParent);
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
		seance: restoredSeance ? {} : undefined,
	};
	const model = await coldReviveModel(spec, init, { spec: spawnSpec, live, sessionManager: reopened });
	const session = await buildSubagentSession({
		spec: spawnSpec,
		live,
		sessionManager: reopened,
		model,
		prewalkTarget: prepared.prewalkTarget,
		revive: { heldInit: init, expectedAgentRef: expectedRef, legacy },
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
 * part of a record an older omp wrote, or of a seance consult) what the cold revive built before spawn
 * specs, with the values every spawn gives (`cacheWarming: false`) applied to a record with no spec. A stored
 * value never widens what the live process allows: the fields of a stored part that select a place, an
 * authority or a limit take the live value, or the narrower of the stored and the live one.
 */
function coldReviveSpawnSpec(
	spec: PersistedReviveSpec,
	parts: SpawnSpecParts,
	init: PersistedSessionInit,
	settingsParent: Settings,
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
		settings: parts.settings ?? legacySubagentSettings(id, init, settingsParent),
		tools,
		policy: parts.policy
			? {
					...parts.policy,
					// Discovery runs in the root's cwd, as for a record with no spec; the tools run in the cwd of
					// the record's header.
					cwd: spec.prepared.rootCwd,
					// Never shallower than the live parent chain, so `task.maxRecursionDepth` holds.
					taskDepth: Math.max(parts.policy.taskDepth ?? spec.taskDepth, spec.taskDepth),
					// Where the spawn passed them, the spawner's as the live parent holds them now, never the record's;
					// none where the parent is not live, or where the spawn passed none (a vibe worker's spawner).
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
					cwd: restoredSeance?.cwd ?? spec.prepared.rootCwd,
					enableLsp: spec.prepared.live.policy.enableLsp,
					// A constant of every spawn, applied to a record with no spec: a spec whose policy part is missing or
					// malformed takes the legacy policy alone.
					...(parts.stored ? {} : { cacheWarming: false }),
					...(restricted ? { enableIrc: false, enableMCP: false } : { enableMCP: !spec.prepared.live.mcpManager }),
					// Old files predate persisted spawns: deny re-spawning rather than let
					// createAgentSession default to wildcard ("*").
					spawns: init.spawns ?? "",
					taskDepth: spec.taskDepth,
				},
		identity: {
			// The names the record stores (`agents` rule scoping keys on the durable definition name, see
			// `persistedAgentName`); the ids are the live registry ref's, never the record's.
			agentName: parts.identity ? parts.identity.agentName : agentName,
			agentDisplayName: parts.identity ? parts.identity.agentDisplayName : displayName,
			agentId: id,
			parentAgentId: spec.parentId,
			parentTaskPrefix: id,
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
	return { spawnSpec, legacy: legacy.tools || legacy.replayPrompt ? legacy : undefined };
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
	// `"on"` = advisor-role model, anything else = the pattern stamped onto this session's
	// `modelRoles.advisor`, which spawn persists already expanded against the spawning owner's roles;
	// expanding again is a no-op for those and only resolves aliases in files written before that.
	const settings = createSubagentSettings(parent, {
		...(init.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
		...(init.advisor
			? {
					"advisor.enabled": true,
					...(init.advisor !== "on"
						? {
								modelRoles: {
									...parent.getModelRoles(),
									advisor: resolveAgentAdvisorRolePattern(init.advisor, parent),
								},
							}
						: undefined),
				}
			: undefined),
		...compactionThresholdSettings(init.compactionThreshold),
	});
	if (init.retryFallback) installRetryFallbackRole(settings, subagentRetryFallbackRole(id), init.retryFallback);
	return spawnSpecSettings(captureSubagentSettings(settings));
}
