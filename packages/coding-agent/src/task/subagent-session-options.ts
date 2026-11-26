/**
 * What a subagent session is built from and the one code that builds it ({@link buildSubagentSession}), for the
 * spawn's first build and for a warm or cold revive: the live inputs of the process, the model the build starts on,
 * the session options and system prompt the spawn spec (`./spawn-spec`) and those inputs give, and the IRC peer roster
 * the prompt renders, with the transcript records of that roster a warm revive renders again.
 */
import type { AgentIdentity, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import {
	assertModelSupportsEffortCeiling,
	type ConfiguredThinkingLevel,
	type TaskEffort,
} from "@oh-my-pi/pi-tui/thinking";
import { DEFAULT_PEER_ROSTER_LIMIT, LIST_STATUS_ORDER } from "@oh-my-pi/pi-tui/tools/irc";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { type OAuthAccountPools, validateAgentAccountPools } from "../config/account-pools";
import type { ModelRegistry } from "../config/model-registry";
import type { OverlayLayers, Settings } from "../config/settings";
import type { ExtensionPathEntry, PreparedExtension } from "../extensibility/extensions/types";
import type { MCPToolScope } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster, isCurrentSessionRosterRef } from "../registry/persisted-agents";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { isLocalAgentSession } from "../session/agent-session-handle";
import type { ArtifactManagerApi } from "../session/artifacts";
import type { AuthStorage } from "../session/auth-storage";
import { cfgWorkspaceAdditionalDirectories } from "../session/context-settings";
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { SessionStorage } from "../session/session-storage";
import type { EventBus } from "../utils/event-bus";
import {
	attachIrcWakeTurnMonitor,
	followMCPTools,
	type IrcWakeTurnMonitorOptions,
	type MCPToolFollower,
	replayRevivedAgentStart,
	type SubagentRunOptions,
} from "./executor";
import { assertPerCallModelApproved, type PerCallModelGrants } from "./model-approval";
import type { PreparedSeanceSession } from "./seance";
import { seanceIsolationOptions } from "./seance-policy";
import { cfgTaskAgentAccountPools, cfgTaskMaxEffort } from "./settings";
import type { SubagentSpawnSpec } from "./spawn-spec";
import { type SubagentReviveInputs, trackWarmReviveCache, type WarmReviveCache } from "./subagent-revive";
import { startupModelFallbacks } from "./subagent-run-state";
import {
	restoreSubagentSettings,
	storedSpawnSettings,
	type SubagentSettingsWrites,
	withLayerWrites,
} from "./subagent-settings";
import type { WorkPoolYieldItem } from "./workpool-yield";

export interface IrcPeerRosterRow {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	activity?: string;
}

export interface IrcPeerRosterData {
	/** Live (running+idle) peer rows, bounded at DEFAULT_PEER_ROSTER_LIMIT. */
	peers: IrcPeerRosterRow[];
	/** Current-root parked refs, counted but never named. */
	parkedCount: number;
	/** Live rows dropped by the bound; the prompt reports them truthfully. */
	omittedCount: number;
}

export function collectIrcPeerRoster(
	registry: AgentRegistryApi,
	selfId: string,
	rootSessionFile?: string,
): IrcPeerRosterData {
	// Running before idle, then newest activity
	// first — so the cap keeps the newest relevant siblings, not an
	// insertion-order prefix.
	const live = registry
		.listVisibleTo(selfId)
		.sort(
			(a, b) =>
				(LIST_STATUS_ORDER[a.status] ?? 9) - (LIST_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
		);
	const limit = DEFAULT_PEER_ROSTER_LIMIT;
	const omittedCount = Math.max(0, live.length - limit);
	const peers = (omittedCount > 0 ? live.slice(0, limit) : live).map(peer => ({
		id: peer.id,
		displayName: peer.displayName,
		kind: peer.kind,
		status: peer.status,
		activity: peer.activity,
	}));
	let parkedCount = 0;
	for (const ref of registry.list()) {
		if (
			ref.id !== selfId &&
			ref.kind !== "advisor" &&
			ref.status === "parked" &&
			isCurrentSessionRosterRef(ref, rootSessionFile)
		) {
			parkedCount++;
		}
	}
	return { peers, parkedCount, omittedCount };
}

/**
 * The subagent's own attached session. Its prompt builders run on its home
 * thread, so an attached session is the local {@link AgentSession}.
 */
function ownAttachedSession(id: string): AgentSession | undefined {
	const session = AgentRegistry.global().get(id)?.session;
	return session && isLocalAgentSession(session) ? session : undefined;
}

/** Inputs of a subagent's rendered system prompt: its spawn spec's, plus the roster state of the live session. */
export interface SubagentPromptInputs {
	id: string;
	model?: string;
	agentSystemPrompt: string;
	context: string;
	planReference: string;
	planReferencePath: string;
	worktree: string;
	/** Whether the session has a `yield` tool; selects the Completion protocol. */
	structured: boolean;
	outputSchema: unknown;
	outputSchemaOverridesAgent: boolean;
	ircEnabled: boolean;
	/** Root resolved by the latest roster ensure; peer rows render scoped to it, so a session switch hides stale parked trees. */
	ircRoot: { sessionFile?: string };
	/**
	 * Peer roster each prompt block the live session rendered shows, keyed by that block. Made by each build: a warm
	 * revive's starts from the rosters its transcript records for the blocks of the base it holds
	 * ({@link IRC_ROSTER_ENTRY}), so a parked subagent keeps none.
	 */
	ircRenders: Map<string, IrcPeerRosterData>;
	/**
	 * {@link ircRosterBlockKey} of every block the transcript holds an {@link IRC_ROSTER_ENTRY} for; absent where no
	 * warm revive can read the transcript back (a one-shot run, a seance consult, a cold revive), whose transcript
	 * records no roster.
	 */
	ircRecorded?: Set<string>;
}

/**
 * Custom transcript entry recording the peer roster a subagent's prompt block shows, so the builds of a warm
 * revive render that block again from the transcript rather than from a copy kept in memory while parked.
 * Custom entries never enter the model's context.
 */
const IRC_ROSTER_ENTRY = "subagent-irc-roster";

/** Data of an {@link IRC_ROSTER_ENTRY}. */
interface IrcRosterRecord {
	/** {@link ircRosterBlockKey} of the rendered prompt block. */
	block: string;
	roster: IrcPeerRosterData;
}

function isIrcRosterRecord(data: unknown): data is IrcRosterRecord {
	if (!isRecord(data) || typeof data.block !== "string" || !isRecord(data.roster)) return false;
	const { peers, parkedCount, omittedCount } = data.roster;
	return (
		Array.isArray(peers) &&
		peers.every(isRecord) &&
		typeof parkedCount === "number" &&
		typeof omittedCount === "number"
	);
}

/** The roster record `entry` holds, when it is a well-formed {@link IRC_ROSTER_ENTRY}. */
export function ircRosterRecordOf(entry: SessionEntry): IrcRosterRecord | undefined {
	return entry.type === "custom" && entry.customType === IRC_ROSTER_ENTRY && isIrcRosterRecord(entry.data)
		? entry.data
		: undefined;
}

/** Key an {@link IRC_ROSTER_ENTRY} names its block by: the transcript keeps the block itself in `session_init`. */
export function ircRosterBlockKey(block: string): string {
	return Bun.hash(block).toString(36);
}

/**
 * The peer roster of each block of `base` (the held base prompt a revive replays) that `entries` hold an
 * {@link IRC_ROSTER_ENTRY} for, the newest record of a block winning, and the keys of every block they record. A
 * transcript written before rosters were recorded holds none: a build after the revived session's first model call then
 * renders the live registry's roster.
 */
function recordedIrcRosters(
	entries: readonly SessionEntry[],
	base: readonly string[],
): { renders: Map<string, IrcPeerRosterData>; recorded: Set<string> } {
	const keys = new Map(base.map(block => [ircRosterBlockKey(block), block]));
	const renders = new Map<string, IrcPeerRosterData>();
	const recorded = new Set<string>();
	for (const entry of entries) {
		const record = ircRosterRecordOf(entry);
		if (!record) continue;
		recorded.add(record.block);
		const block = keys.get(record.block);
		if (block !== undefined) renders.set(block, record.roster);
	}
	return { renders, recorded };
}

/** What a subagent's process allows it, whatever its spawn spec stores; each is allowed where absent. */
export interface SubagentLivePolicy {
	enableLsp?: boolean;
	enableIrc?: boolean;
	enableMCP?: boolean;
}

/** Session options a subagent build takes from the live process: class `L` of the spawn input inventory. */
type SubagentLiveOptionKeys =
	| "costGate"
	| "cyberPolicyClosure"
	| "getApiKey"
	| "oauthAccountPools"
	| "inheritedSessionAgents"
	| "assertDispatchModel"
	| "contextFiles"
	| "skills"
	| "promptTemplates"
	| "workspaceTree"
	| "rules"
	| "extensionRoots"
	| "preloadedExtensionPaths"
	| "preloadedPreparedExtensions"
	| "preloadedCustomToolPaths"
	| "subagentEventBus"
	| "parentHindsightSessionState"
	| "parentMnemopiSessionState"
	| "asyncJobManager"
	| "mcpManager"
	| "localProtocolOptions"
	| "telemetry"
	| "customTools"
	| "secretsProjectDirs";

/**
 * The live inputs of a subagent build: the spawner's objects at the spawn and at a warm revive, the
 * live parent session's at a cold revive. A build never reads one of them from a transcript.
 */
export interface SubagentLiveInputs extends Pick<CreateAgentSessionOptions, SubagentLiveOptionKeys> {
	/** The parent's extension entries, each with its scope (the session option also takes bare paths). */
	preloadedExtensionPaths?: ExtensionPathEntry[];
	/** The parent's prepared extensions, each with its scope (the session option also takes them without one). */
	preloadedPreparedExtensions?: readonly PreparedExtension[];
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	/** Settings a revive restores the subagent's overlay over, and whose live values a build reads. */
	settingsParent: Settings;
	/** Bus a revived session's wake-turn monitor reports its lifecycle frames on. */
	eventBus: EventBus | undefined;
	/** The parent session's cwd, whose secrets mask the `<id>.md` and `<id>.json` a revived wake turn rewrites. */
	storeMaskCwd: string;
	/** Artifact manager the subagent's session manager adopts. */
	parentArtifactManager: ArtifactManagerApi | undefined;
	/** What the process allows: a stored LSP, IRC or MCP value never turns on what it has off. */
	policy: SubagentLivePolicy;
	/**
	 * A seance consult: its builds take the seance isolation options. A consult revived from its transcript
	 * has no prompt suffix; its builds replay the held prompt.
	 */
	seance?: Partial<Pick<PreparedSeanceSession, "promptSuffix">>;
}

/** Model options a subagent build passes. */
type SubagentModelOptionKeys =
	| "model"
	| "thinkingLevel"
	| "modelPattern"
	| "modelPatternAuthFallback"
	| "modelPatternFallbackRole"
	| "modelPatternDefaultFallbackChain"
	| "modelPatternChainFallback";

/** An explicit model: the spawn's resolved one, or the one a revive holds or resolves. */
export interface ExplicitBuildModel {
	kind: "model";
	model: Model | undefined;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/** The patterns of a spawn that left the model to the session's own resolution: the spawn's first build only. */
export interface DeferredBuildModel extends Pick<
	CreateAgentSessionOptions,
	"modelPattern" | "modelPatternAuthFallback" | "modelPatternFallbackRole" | "modelPatternDefaultFallbackChain"
> {
	kind: "deferred";
}

/**
 * What a cold revive passes where its record's spawn spec gives no model (a record an older omp wrote, a
 * seance consult): its patterns.
 */
export interface LegacyBuildModel extends Pick<CreateAgentSessionOptions, "modelPattern" | "modelPatternAuthFallback"> {
	kind: "legacy";
}

/** The model a subagent build starts on. */
export type SubagentBuildModel = ExplicitBuildModel | DeferredBuildModel | LegacyBuildModel;

/** The spawn's own inputs and steps around its first build; a revive has none of them. */
export interface SubagentLaunchInputs {
	/** The spawn's overlay; a deferred model resolution installs its retry-fallback role into it. */
	settings: Settings;
	workPoolYieldItems: readonly WorkPoolYieldItem[];
	resolveServiceTierByFamily?: CreateAgentSessionOptions["resolveServiceTierByFamily"];
	onFirstChatDispatch?: () => void;
	/** The spawn's effort hint where it starts on no model: session creation maps it onto the model it settles on. */
	taskEffort: TaskEffort | undefined;
	/** The spawning session's view of the MCP manager, which the subagent's own view starts from. */
	mcpToolScope: MCPToolScope | undefined;
	/** The cache a warm revive of this subagent will hold; undefined where none can (a one-shot run, a seance consult). */
	cache: WarmReviveCache | undefined;
	/** Waits for one step of the build, rejecting as soon as the launch is aborted. */
	settle<T>(step: Promise<T>): Promise<T>;
	/** Takes a session creation the launch stopped waiting for, so the session it yields is disposed. */
	abandon(creation: Promise<CreateAgentSessionResult>): void;
	/** The launch's own steps once the session exists, before the shared steps after its creation. */
	created(session: AgentSession): void;
	/** The launch's own steps after the todo strip, before the extensions start. */
	beforeExtensions(session: AgentSession): Promise<void>;
	/** Takes an extension send the launch waits for before its first prompt. */
	trackExtensionSend(send: Promise<unknown>): void;
	/** The launch's own step once startup discovery ran, inside the extensions' startup hold. */
	afterStartupDiscovery(session: AgentSession): void;
}

/** Inputs of {@link buildSubagentSession}. */
export interface SubagentBuildInput {
	spec: SubagentSpawnSpec;
	live: SubagentLiveInputs;
	sessionManager: SessionManager;
	/** The store the subagent's transcripts live in, whose persisted roster its prompt's peer rows scope to. */
	storage: SessionStorage | undefined;
	model: SubagentBuildModel;
	/** The model `spec.prewalk.target` names; without it the build arms no prewalk. */
	prewalkTarget?: Model;
	launch?: SubagentLaunchInputs;
	revive?: SubagentReviveInputs;
}

/** A revive's held base prompt: every build returns it until the revived session's first model call. */
interface HeldBasePrompt {
	blocks: string[] | undefined;
}

/** Session options of a subagent build before the session's own: its settings, manager, prompt and launch hooks. */
type SubagentBaseOptions = Omit<
	CreateAgentSessionOptions,
	| "settings"
	| "sessionManager"
	| "expectedAgentRef"
	| "systemPrompt"
	| "resolveServiceTierByFamily"
	| "onFirstChatDispatch"
>;

/**
 * Builds a subagent session from its spawn spec, the live inputs of the process and its session manager:
 * the only code that builds one. The spawn's first build adds its launch inputs and steps; a warm revive
 * passes the spec it read back from the reopened session_init, with its cache; a cold revive passes the spec
 * of the latest session_init. After `createAgentSession` it runs each step a build takes before the session's
 * first turn: the MCP follower bind, the registry status, the tracker of a session a warm revive follows, the
 * todo strip, a revive's held work-pool items, the extension start, and at a revive the `before_agent_start`
 * replay and the wake-turn monitor.
 */
export async function buildSubagentSession(input: SubagentBuildInput): Promise<AgentSession> {
	const { spec, live, sessionManager, launch, revive } = input;
	const id = spec.prompt.id;
	const cache = launch?.cache ?? revive?.cache;
	const settle = <T>(step: Promise<T>): Promise<T> => (launch ? launch.settle(step) : step);
	if (live.parentArtifactManager) sessionManager.adoptArtifactManager(live.parentArtifactManager);
	const held: HeldBasePrompt = { blocks: revive?.heldInit?.systemPrompt };
	let settings: Settings;
	let inputs: SubagentPromptInputs;
	let mcpFollower: MCPToolFollower | undefined;
	let creation: Promise<CreateAgentSessionResult> | undefined;
	let session: AgentSession;
	try {
		settings =
			launch?.settings ??
			restoreSubagentSettings(live.settingsParent, {
				layers: revivedLayers(spec.settings.layers, revive?.cache?.settingsWrites),
				rootThresholds: spec.settings.rootThresholds,
			});
		// A revive of a record that holds a spawn spec (the warm revive too) writes its file header's workspace roots
		// once, before the build, as the roots the build uses: the policy's (at a cold revive, the live parent's, or the
		// root's where the parent is not live) and the live settings'. A spec whose policy part is missing or malformed
		// brings no policy roots, so only the live setting's roots are written. The SDK's merge then changes nothing, so
		// a warm revive rewrites the file for its roots only where these changed, and a root the run took from a live
		// settings edit stays while the setting holds it. A root only the reopened header holds, which a writer of the
		// session store can edit, is not kept. A record with no spec keeps its header's roots, as before spawn specs.
		if (revive && !revive.legacy?.keepHeaderRoots) {
			await sessionManager.setAdditionalDirectories([
				...(spec.policy.additionalDirectories ?? []),
				...cfgWorkspaceAdditionalDirectories.get(settings),
			]);
		}
		// Only a session a warm revive can follow records the rosters its prompt renders; a warm revive starts from
		// those its transcript records for the base it replays.
		const rosters =
			cache && spec.prompt.ircEnabled
				? recordedIrcRosters(sessionManager.getEntries(), revive?.cache ? (held.blocks ?? []) : [])
				: undefined;
		// The base a warm revive replays shows the peer roster of the park, which the transcript records beside it.
		// One that records none of them (a transcript written before rosters were recorded) would replay a roster no
		// record vouches for and no rebuild could catch up: the build renders the live registry's roster instead.
		if (revive?.cache && spec.prompt.ircEnabled && rosters?.renders.size === 0) held.blocks = undefined;
		inputs = {
			...spec.prompt,
			outputSchema: spec.prompt.outputSchema,
			ircRoot: {},
			ircRenders: rosters?.renders ?? new Map(),
			ircRecorded: rosters?.recorded,
		};
		await refreshSubagentIrcRoot(inputs, sessionManager, input.storage);
		const options = subagentBaseOptions(input);
		const customTools = options.customTools ?? [];
		// Subscribe before the builder mints proxies so a manager change during session startup is replayed
		// on bind instead of lost. A revived session reopens its own view, keeping the tools its earlier
		// requests rendered. The explicitly supplied tools win over same-named MCP proxies on every rebind.
		mcpFollower = options.mcpManager
			? followMCPTools(
					options.mcpManager,
					{ scope: sessionManager.getSessionId(), seed: launch?.mcpToolScope },
					new Set(customTools.map(tool => tool.name)),
				)
			: undefined;
		// MCP proxies are minted per build, not stored: a subagent revived after `/mcp reload` must see the
		// manager's current tools.
		const mcpTools = mcpFollower?.proxyTools() ?? [];
		creation = createAgentSession({
			...options,
			mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
			mcpToolScope: mcpFollower?.scope,
			customTools: customTools.length > 0 ? customTools : undefined,
			settings,
			sessionManager,
			expectedAgentRef: revive?.expectedAgentRef ?? null,
			resolveServiceTierByFamily: launch?.resolveServiceTierByFamily,
			onFirstChatDispatch: launch?.onFirstChatDispatch,
			taskEffort: launch?.taskEffort,
			// A launch prompts its assignment only after setup; a revive's turns are its IRC wakes.
			awaitingAssignment: launch !== undefined,
			systemPrompt: subagentSystemPrompt(inputs, sessionManager, held, launch?.workPoolYieldItems, live.seance),
		});
		let startupModelFallback: CreateAgentSessionResult["startupModelFallback"];
		({ session, startupModelFallback } = await settle(creation));
		// A revive starts on the model its session started on, as an explicit model, so session creation reports
		// no startup fallback for it: the one the spawn stored is recorded again for the revived session, and its
		// runs report that model as the fallback, with the same reason, whenever it serves.
		const startupFallback = startupModelFallback ?? (revive ? spec.startupFallback : undefined);
		if (startupFallback) startupModelFallbacks.set(session, startupFallback);
	} catch (error) {
		mcpFollower?.dispose();
		if (creation) launch?.abandon(creation);
		// A revive's reopened manager is this build's alone, whatever step failed. Once built, the session
		// claimed this journal as its writer: leaving it claimed would divert the next revive of this
		// transcript to a sibling file instead of rebuilding it in place.
		if (revive) await sessionManager.close();
		throw error;
	}
	mcpFollower?.bind(session);
	launch?.created(session);
	// Run-state notifications precede deferrable wire-level `agent_end`, so an adopted
	// keep-alive lifecycle cannot get stuck during prompt unwind.
	AgentRegistry.global().syncSessionStatus(id, session);
	if (cache) {
		// The layers the spawn spec stores, which the runs' writes are taken against: the spawn's as it stores
		// them now, a revive's as it read them back.
		trackWarmReviveCache(session, cache, launch ? storedSpawnSettings(settings) : spec.settings, live.modelRegistry);
	}
	if (held.blocks && !revive?.legacy?.replayPrompt) releaseHeldPromptAtFirstCall(session, held);
	// Todos are parent-owned bookkeeping and stripped from subagents, except under prewalk, whose plan
	// nudge and todo gate require the subagent to commit its own todo list before the hand-off. Strip
	// before extensions start: every build enables the session's default tools again.
	const keepTodo = spec.tools.keepTodo;
	const withoutParentOwnedTools = (toolNames: string[]): string[] =>
		keepTodo ? toolNames : toolNames.filter(name => name !== "todo");
	const legacyTools = revive?.legacy?.tools;
	if (legacyTools) {
		// An older record's tool list is its contract: `createAgentSession` can re-add extension or custom
		// tools its run did not carry. Names the session does not have are ignored.
		const toolNames = spec.tools.toolNames ?? [];
		await session.setActiveToolsByName(
			legacyTools.keepDevices ? [...toolNames, ...session.getMountedXdevToolNames()] : toolNames,
		);
	} else {
		const enabledToolNames = session.getEnabledToolNames();
		const subagentToolNames = withoutParentOwnedTools(enabledToolNames);
		if (subagentToolNames.length !== enabledToolNames.length) {
			await settle(session.setActiveToolsByName(subagentToolNames));
		}
	}
	if (launch) {
		await launch.beforeExtensions(session);
	} else if (revive?.heldInit?.workPoolYieldItems) {
		// The yield tool's schema carries the held batch's items; the replayed prefix must match it.
		await session.setWorkPoolYieldItems(revive.heldInit.workPoolYieldItems);
	}
	// Without the extension wiring the runner stays pre-init, so a `tool_call` handler touching a runtime
	// action trips the fail-closed gate and blocks every tool, `yield` included (issue #8824).
	await settle(
		initializeExtensions(session, {
			reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
			reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			trackExtensionSend: launch ? send => launch.trackExtensionSend(send) : undefined,
			filterActiveTools: withoutParentOwnedTools,
			afterStartupDiscovery: launch ? started => launch.afterStartupDiscovery(started) : undefined,
			agentActionsScope: revive?.agentActionsScope,
		}),
	);
	if (revive) {
		await replayRevivedAgentStart(session);
		attachIrcWakeTurnMonitor(session, revivedWakeOptions(spec, live, sessionManager));
	}
	return session;
}

/**
 * The overlay layers a revive restores: those the spawn spec stores, with the runs' writes a warm revive's cache holds
 * on top (class `S+P` of the spawn input inventory).
 */
function revivedLayers(layers: OverlayLayers, writes: SubagentSettingsWrites | undefined): OverlayLayers {
	if (!writes) return layers;
	return {
		global: withLayerWrites(layers.global, writes.global),
		overrides: withLayerWrites(layers.overrides, writes.overrides),
		derived: layers.derived,
	};
}

/** `stored`, unless the live process turns the capability off. */
function narrowedToLive(stored: boolean | undefined, allowed: boolean | undefined): boolean | undefined {
	return allowed === false ? false : stored;
}

/** The spawn's effort ceiling, lowered to the live `task.maxEffort` when that is lower. */
export function liveEffortCeiling(ceiling: Effort | undefined, settings: Settings): Effort | undefined {
	if (ceiling === undefined) return undefined;
	const maxEffort = cfgTaskMaxEffort.get(settings);
	return THINKING_EFFORTS.indexOf(maxEffort) < THINKING_EFFORTS.indexOf(ceiling) ? maxEffort : ceiling;
}

/**
 * A subagent's telemetry, derived from its parent's: the child loop's spans nest under the parent's
 * active span (OTEL context propagation links them), carry the subagent's own identity, and use the
 * subagent's own session id as `gen_ai.conversation.id` (the parent's is cleared).
 */
export function subagentTelemetryConfig(
	parent: AgentTelemetryConfig | undefined,
	agent: AgentIdentity,
): AgentTelemetryConfig | undefined {
	return parent ? { ...parent, agent, conversationId: undefined } : undefined;
}

/** Executor options a spawner reads from the spawning session's tool session: the live inputs of a subagent build. */
export type SubagentSpawnerLiveInputs = Pick<
	SubagentRunOptions,
	| "costGate"
	| "cyberPolicyClosure"
	| "getApiKey"
	| "authStorage"
	| "modelRegistry"
	| "settings"
	| "asyncJobManager"
	| "inheritedSessionAgents"
	| "mcpManager"
	| "contextFiles"
	| "noContextFiles"
	| "skills"
	| "workspaceTree"
	| "promptTemplates"
	| "rules"
	| "extensionRoots"
	| "preloadedExtensionPaths"
	| "preloadedPreparedExtensions"
	| "preloadedCustomToolPaths"
	| "localProtocolOptions"
	| "parentArtifactManager"
	| "parentHindsightSessionState"
	| "parentMnemopiSessionState"
	| "parentTelemetry"
>;

/** Live inputs of a subagent build that a spawner's inputs give as they are; see {@link spawnerLiveInputs}. */
type SpawnerLiveInputKeys =
	| "costGate"
	| "cyberPolicyClosure"
	| "getApiKey"
	| "inheritedSessionAgents"
	| "contextFiles"
	| "skills"
	| "promptTemplates"
	| "workspaceTree"
	| "rules"
	| "extensionRoots"
	| "preloadedExtensionPaths"
	| "preloadedPreparedExtensions"
	| "preloadedCustomToolPaths"
	| "parentHindsightSessionState"
	| "parentMnemopiSessionState"
	| "asyncJobManager"
	| "localProtocolOptions"
	| "telemetry";

/**
 * The live inputs of a subagent build that `inputs`, a spawner's, give as they are, with the subagent's
 * telemetry derived from the spawner's: what a spawn passes from its options, and what a cold revive takes
 * from the live parent's tool session. Each caller adds its own fallbacks and the inputs only it has.
 */
export function spawnerLiveInputs(
	inputs: SubagentSpawnerLiveInputs,
	agent: AgentIdentity,
): Pick<SubagentLiveInputs, SpawnerLiveInputKeys> {
	return {
		costGate: inputs.costGate,
		cyberPolicyClosure: inputs.cyberPolicyClosure,
		getApiKey: inputs.getApiKey,
		inheritedSessionAgents: inputs.inheritedSessionAgents,
		contextFiles: inputs.contextFiles,
		skills: inputs.skills,
		promptTemplates: inputs.promptTemplates,
		workspaceTree: inputs.workspaceTree,
		rules: inputs.rules,
		extensionRoots: inputs.extensionRoots,
		preloadedExtensionPaths: inputs.preloadedExtensionPaths,
		preloadedPreparedExtensions: inputs.preloadedPreparedExtensions,
		preloadedCustomToolPaths: inputs.preloadedCustomToolPaths,
		parentHindsightSessionState: inputs.parentHindsightSessionState,
		parentMnemopiSessionState: inputs.parentMnemopiSessionState,
		asyncJobManager: inputs.asyncJobManager,
		localProtocolOptions: inputs.localProtocolOptions,
		telemetry: subagentTelemetryConfig(inputs.parentTelemetry, agent),
	};
}

/** The live exact-name `task.agentAccountPools` entry of `agentName`: owner policy, never a spawn-time copy. */
export function liveAgentAccountPools(
	settings: Settings,
	agentName: string | undefined,
): OAuthAccountPools | undefined {
	const agentAccountPools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(settings));
	return agentName !== undefined && Object.hasOwn(agentAccountPools, agentName)
		? agentAccountPools[agentName]
		: undefined;
}

/**
 * Holds each model a per-call worker dispatches to `approve`, then to the effort ceiling: a model that cannot
 * run at or below it is refused. `ceiling` is read at each call, so a ceiling over a live setting is taken as
 * that setting is then.
 */
export function perCallModelAssertion(
	approve: (model: Model) => void,
	ceiling: () => Effort | undefined,
): (model: Model) => void {
	return model => {
		approve(model);
		const effort = ceiling();
		if (effort) assertModelSupportsEffortCeiling(model, effort);
	};
}

/**
 * Holds every request of a per-call worker to an approved model that can run at or below the spawn's
 * effort ceiling. Each build makes its own; a parked subagent keeps only the grants (`WarmReviveState`).
 */
export function perCallDispatchAssertion(
	grants: PerCallModelGrants,
	modelRegistry: ModelRegistry,
	ceiling: Effort | undefined,
): (model: Model) => void {
	return perCallModelAssertion(
		model => assertPerCallModelApproved(model, grants, modelRegistry),
		() => ceiling,
	);
}

function subagentModelOptions(
	model: SubagentBuildModel,
	spec: SubagentSpawnSpec,
): Pick<CreateAgentSessionOptions, SubagentModelOptionKeys> {
	switch (model.kind) {
		case "model":
			return { model: model.model, thinkingLevel: model.thinkingLevel };
		case "deferred":
			return {
				model: undefined,
				modelPattern: model.modelPattern,
				modelPatternAuthFallback: model.modelPatternAuthFallback,
				modelPatternFallbackRole: model.modelPatternFallbackRole,
				modelPatternDefaultFallbackChain: model.modelPatternDefaultFallbackChain,
				modelPatternChainFallback: true,
				thinkingLevel: spec.thinkingLevel ?? undefined,
			};
		case "legacy":
			return {
				model: undefined,
				modelPattern: model.modelPattern,
				modelPatternAuthFallback: model.modelPatternAuthFallback,
				thinkingLevel: undefined,
			};
	}
}

/** A subagent build's session options from its spawn spec and live inputs, before the session's own. */
function subagentBaseOptions(input: SubagentBuildInput): SubagentBaseOptions {
	const { spec, live, revive } = input;
	const { policy, identity, tools } = spec;
	// A restricted contract keeps MCP, extension paths and custom-tool paths off, and at a revive LSP too;
	// the SDK turns IRC off for it. A stored LSP, IRC or MCP value never turns on what the live process has off.
	const restricted = tools.restrictToolNames === true;
	const enableMCP = restricted ? false : narrowedToLive(policy.enableMCP, live.policy.enableMCP);
	return {
		cwd: policy.cwd,
		// Set by a cold revive only: the cwd of the session its live inputs came from, where it is not the stored one.
		secretsProjectDirs: live.secretsProjectDirs,
		costGate: live.costGate,
		cyberPolicyClosure: live.cyberPolicyClosure,
		additionalDirectories: policy.additionalDirectories,
		authStorage: live.authStorage,
		modelRegistry: live.modelRegistry,
		getApiKey: live.getApiKey,
		credentialSourceSessionId: policy.credentialSourceSessionId,
		oauthAccountPools: revive
			? liveAgentAccountPools(live.settingsParent, identity.agentName)
			: live.oauthAccountPools,
		inheritedSessionAgents: live.inheritedSessionAgents,
		...subagentModelOptions(input.model, spec),
		...(spec.perCallModel
			? {
					// Every request stays on an approved model that can run at or below the spawn's effort ceiling.
					assertDispatchModel: live.assertDispatchModel,
					disableModelFallback: true,
					disableServerSideFallback: true,
				}
			: {}),
		// A named model held to its own list: no configured chain, promotion target or server-side chain.
		...(spec.exclusiveRetryFallbackRole !== undefined
			? { exclusiveRetryFallbackRole: spec.exclusiveRetryFallbackRole, disableServerSideFallback: true }
			: {}),
		thinkingLevelCeiling: liveEffortCeiling(spec.thinkingLevelCeiling, live.settingsParent),
		cacheWarming: policy.cacheWarming,
		toolNames: tools.toolNames,
		// The tool names a revive replays include the devices the spawn mounted; keep them mounted.
		mountedToolNames: revive?.legacy?.tools
			? revive.legacy.tools.mountedToolNames
			: revive
				? tools.mountedToolNames
				: undefined,
		outputSchema: tools.outputSchema,
		outputSchemaMode: tools.outputSchemaMode,
		restrictToolNames: tools.restrictToolNames,
		requireYieldTool: tools.requireYieldTool,
		contextFiles: live.contextFiles,
		noContextFiles: policy.noContextFiles,
		// Subagents never receive AGENTS.md, including from additional workspace roots they rediscover.
		excludeAgentsMd: true,
		skills: live.skills,
		mergeDiscoveredSkillPaths: policy.mergeDiscoveredSkillPaths,
		promptTemplates: live.promptTemplates,
		workspaceTree: live.workspaceTree,
		rules: live.rules,
		extensionRoots: live.extensionRoots,
		preloadedExtensionPaths: restricted ? [] : live.preloadedExtensionPaths,
		preloadedPreparedExtensions: live.preloadedPreparedExtensions,
		preloadedCustomToolPaths: restricted ? [] : live.preloadedCustomToolPaths,
		hasUI: false,
		prewalk:
			spec.prewalk && input.prewalkTarget
				? { target: input.prewalkTarget, thinkingLevel: spec.prewalk.thinkingLevel }
				: undefined,
		spawns: policy.spawns,
		taskDepth: policy.taskDepth,
		// The whole spawn tree shares the root session's observability bus, so nested
		// lifecycle/progress/event frames reach its surfaces without leaking into another
		// root session's traffic.
		subagentEventBus: live.subagentEventBus,
		parentHindsightSessionState: live.parentHindsightSessionState,
		parentMnemopiSessionState: live.parentMnemopiSessionState,
		parentTaskPrefix: identity.parentTaskPrefix,
		asyncJobManager: live.asyncJobManager,
		parentAgentId: identity.parentAgentId,
		agentId: identity.agentId,
		agentDisplayName: identity.agentDisplayName,
		agentName: identity.agentName,
		enableLsp: restricted && revive ? false : narrowedToLive(policy.enableLsp, live.policy.enableLsp),
		enableIrc: narrowedToLive(policy.enableIrc, live.policy.enableIrc),
		skipPythonPreflight: policy.skipPythonPreflight,
		enableMCP,
		// The manager also feeds the MCP proxy tools of an older record's revive, which keeps MCP itself off.
		mcpManager: restricted || live.policy.enableMCP === false ? undefined : live.mcpManager,
		customTools: live.customTools,
		localProtocolOptions: live.localProtocolOptions,
		telemetry: live.telemetry,
		// Seance isolation overrides every inherited field above in one place.
		...(live.seance ? seanceIsolationOptions(policy.cwd ?? input.sessionManager.getCwd()) : {}),
	};
}

/** The system prompt builder of a subagent build; module-level, so it holds nothing but its inputs. */
function subagentSystemPrompt(
	inputs: SubagentPromptInputs,
	sessionManager: SessionManager,
	held: HeldBasePrompt,
	launchWorkPoolYieldItems: readonly WorkPoolYieldItem[] | undefined,
	seance: SubagentLiveInputs["seance"],
): (defaultPrompt: string[]) => string[] {
	return defaultPrompt => {
		// Until its first model call a revived session sends what the parked session's last call sent:
		// signed thinking is bound to the system prompt, and a changed prefix writes the prompt cache again.
		if (held.blocks) return [...held.blocks];
		// A rebuild that leaves the rest of the prompt unchanged keeps the roster the prompt it replaces
		// showed: peer rows carry each peer's live activity, so a re-collected roster changed the prompt's
		// bytes on every such rebuild and the provider wrote the whole conversation to its prompt cache
		// again. A rebuild whose default blocks changed loses the cached prefix anyway, so it catches the
		// roster up.
		const ircRoster = inputs.ircEnabled
			? (heldIrcRoster(inputs, defaultPrompt) ??
				collectIrcPeerRoster(AgentRegistry.global(), inputs.id, inputs.ircRoot.sessionFile))
			: undefined;
		const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
			agent: inputs.agentSystemPrompt,
			context: inputs.context,
			planReference: inputs.planReference,
			planReferencePath: inputs.planReferencePath,
			worktree: inputs.worktree,
			structured: inputs.structured,
			outputSchema: inputs.outputSchema,
			outputSchemaOverridesAgent: inputs.outputSchemaOverridesAgent,
			// Read the live item set through the registry instead of capturing the session, which
			// would pin its whole graph past park.
			workPoolYieldItems: ownAttachedSession(inputs.id)?.getWorkPoolYieldItems?.() ?? launchWorkPoolYieldItems ?? [],
			ircPeers: ircRoster?.peers ?? [],
			ircParkedCount: ircRoster?.parkedCount ?? 0,
			ircOmittedCount: ircRoster?.omittedCount ?? 0,
			ircSelfId: inputs.ircEnabled ? inputs.id : "",
		});
		if (ircRoster) recordIrcRender(inputs, sessionManager, subagentPrompt, ircRoster);
		// Per-spawn text (context, worktree, IRC roster) goes after the trailing
		// `<project-context>` block so spawns of the same agent share the static
		// prompt prefix as a cache hit.
		const seancePrompt = seance?.promptSuffix?.(inputs.model);
		return [...defaultPrompt, subagentPrompt, ...(seancePrompt ? [seancePrompt] : [])];
	};
}

/**
 * Ends a revived session's hold on its base prompt once its first model call is under way; every build
 * after it renders from the spawn's prompt inputs, under the session's own prompt-binding guard.
 */
function releaseHeldPromptAtFirstCall(session: AgentSession, held: HeldBasePrompt): void {
	const unsubscribe = session.subscribe(event => {
		if (event.type !== "message_start" || event.message.role !== "assistant") return;
		held.blocks = undefined;
		unsubscribe();
	});
}

/** A revived session's wake-turn monitor: the spawn's stored wake inputs, reporting on the live event buses. */
function revivedWakeOptions(
	spec: SubagentSpawnSpec,
	live: SubagentLiveInputs,
	sessionManager: SessionManager,
): IrcWakeTurnMonitorOptions {
	const { agent, ...wake } = spec.wake;
	return {
		...wake,
		id: spec.prompt.id,
		agent: { ...agent, systemPrompt: spec.prompt.agentSystemPrompt },
		eventBus: live.eventBus,
		subagentEventBus: live.subagentEventBus,
		storeMaskCwd: live.storeMaskCwd,
		sessionFile: sessionManager.getSessionFile(),
	};
}

/**
 * The roster the live session's base prompt shows, when that prompt starts with `defaultPrompt`:
 * reusing it then keeps the whole prompt byte-identical. `undefined` before the first render or
 * when the default blocks changed.
 */
function heldIrcRoster(inputs: SubagentPromptInputs, defaultPrompt: readonly string[]): IrcPeerRosterData | undefined {
	const held = ownAttachedSession(inputs.id)?.baseSystemPrompt;
	if (!held || held.length <= defaultPrompt.length) return undefined;
	if (defaultPrompt.some((block, index) => held[index] !== block)) return undefined;
	return held.map(block => inputs.ircRenders.get(block)).find(roster => roster !== undefined);
}

/**
 * Remembers the roster `block` shows, dropping blocks the live session's base prompt no longer holds, and, where a
 * warm revive can read the transcript back ({@link SubagentPromptInputs.ircRecorded}), records it there unless the
 * transcript already holds that block's roster.
 */
function recordIrcRender(
	inputs: SubagentPromptInputs,
	sessionManager: SessionManager,
	block: string,
	roster: IrcPeerRosterData,
): void {
	const held = ownAttachedSession(inputs.id)?.baseSystemPrompt;
	if (held) pruneIrcRenders(inputs.ircRenders, held);
	inputs.ircRenders.set(block, roster);
	const recorded = inputs.ircRecorded;
	if (!recorded) return;
	const key = ircRosterBlockKey(block);
	if (recorded.has(key)) return;
	recorded.add(key);
	const record: IrcRosterRecord = { block: key, roster };
	sessionManager.appendCustomEntry(IRC_ROSTER_ENTRY, record);
}

/** Drops from `ircRenders` the roster of every block that `held`, a base prompt, does not hold. */
function pruneIrcRenders(ircRenders: Map<string, IrcPeerRosterData>, held: readonly string[]): void {
	const kept = new Set(held);
	for (const block of ircRenders.keys()) {
		if (!kept.has(block)) ircRenders.delete(block);
	}
}

/**
 * Re-resolves the IRC roster root a subagent's prompt scopes its peer rows to,
 * scanning the persisted roster in `storage`, where the tree's transcripts live.
 */
async function refreshSubagentIrcRoot(
	inputs: SubagentPromptInputs,
	sessionManager: SessionManager,
	storage: SessionStorage | undefined,
): Promise<void> {
	if (!inputs.ircEnabled) return;
	const registry = AgentRegistry.global();
	inputs.ircRoot.sessionFile = await ensurePersistedRoster(
		registry,
		sessionManager.getSessionFile() ??
			registry.get(inputs.id)?.sessionFile ??
			registry.get(MAIN_AGENT_ID)?.sessionFile,
		storage,
	);
}
