/**
 * Warm revive of a kept-alive subagent: the revive inputs its transcript records, the settings writes and
 * credentials its runs made, what the parked subagent keeps in memory, and the revive that rebuilds its session
 * from them.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { validateAgentAccountPools } from "../config/account-pools";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { OverlayLayers, Settings } from "../config/settings";
import { initializeExtensions } from "../modes/runtime-init";
import { WarmReviveInputsMissingError } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionResult, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { ArtifactManagerApi } from "../session/artifacts";
import { installRetryFallbackRole, type RetryFallbackRole } from "../session/retry-fallback-chains";
import type { SessionEntry } from "../session/session-entries";
import { extractSessionInit, hasConversationalHistory, SessionManager } from "../session/session-manager";
import type { SessionStorage } from "../session/session-storage";
import type { EventBus } from "../utils/event-bus";
import {
	attachIrcWakeTurnMonitor,
	followMCPTools,
	type IrcWakeTurnMonitorOptions,
	type MCPToolFollower,
	replayRevivedAgentStart,
	subagentRetryFallbackRole,
} from "./executor";
import { cfgTaskAgentAccountPools } from "./settings";
import { startupModelFallbacks } from "./subagent-run-state";
import {
	buildSubagentSessionOptions,
	dropIrcRendersOnDispose,
	explicitSubagentToolNames,
	type IrcPeerRosterData,
	ircRosterBlockKey,
	ircRosterRecordOf,
	recordedIrcRosterBlocks,
	refreshSubagentIrcRoot,
	type SubagentPromptInputs,
	type SubagentSessionSpec,
	withoutUndefinedFields,
} from "./subagent-session-options";
import {
	kRootCompactionThresholds,
	layerWrites,
	splitCredentialWrites,
	type SubagentChainSettings,
	type SubagentCredentialWrites,
	type SubagentSettingsInputs,
	type SubagentSettingsWrites,
	subagentSettingsFromInputs,
	withCredentialWrites,
	withLayerWrites,
} from "./subagent-settings";
import type { AgentDefinition } from "./types";

/**
 * The roster the parked session's prompt showed, read back from its transcript: the
 * `IRC_ROSTER_ENTRY` (subagent-session-options.ts) of a block of the base its latest
 * `session_init` holds, the base its last model call was built from (before any
 * `before_agent_start` rewrite, which the revived turn runs again). `undefined` when the
 * transcript records none, as one written before rosters were recorded: the revive then renders
 * the live registry's roster.
 */
function revivalIrcRoster(entries: readonly SessionEntry[]): IrcPeerRosterData | undefined {
	const base = extractSessionInit(entries)?.systemPrompt;
	if (!base) return undefined;
	const held = new Set(base.map(ircRosterBlockKey));
	for (let index = entries.length - 1; index >= 0; index--) {
		const record = ircRosterRecordOf(entries[index]);
		if (record && held.has(record.block)) return record.roster;
	}
	return undefined;
}

/**
 * The settings a warm revive of `inputs` runs on: the overlay rebuilt over the live parent from the
 * spawn's inputs, with the spawn's retry fallback role and the runs' `writes`; root compaction
 * thresholds come from the live parent too. `baseline` is the overlay's layers before the writes,
 * which the revived session's own writes are taken against.
 */
function reviveSubagentSettings(
	parentSettings: Settings,
	inputs: SubagentReviveInputs,
	writes: SubagentSettingsWrites | undefined,
): { settings: Settings; baseline: OverlayLayers } {
	const rebuilt = subagentSettingsFromInputs(parentSettings, inputs.settingsInputs);
	if (inputs.retryFallback) {
		installRetryFallbackRole(rebuilt, subagentRetryFallbackRole(inputs.spec.prompt.id), inputs.retryFallback);
	}
	const baseline = rebuilt.overlayLayers();
	if (!writes) return { settings: rebuilt, baseline };
	const settings: SubagentChainSettings = parentSettings.restoreOverlay({
		global: withLayerWrites(baseline.global, writes.global),
		overrides: withLayerWrites(baseline.overrides, writes.overrides),
		derived: baseline.derived,
	});
	settings[kRootCompactionThresholds] = rebuilt[kRootCompactionThresholds];
	return { settings, baseline };
}

/**
 * Custom transcript entry holding the plain inputs a kept-alive subagent's session was built from,
 * written each time that session is disposed, so a warm revive reads them from the transcript it
 * reopens rather than from a copy kept in memory. Custom entries never enter the model's context.
 */
const SUBAGENT_REVIVE_ENTRY = "subagent-revive-state";

type SubagentSpecOptions = SubagentSessionSpec["options"];

/**
 * Where a warm revive takes one of a kept-alive subagent's spawn inputs from. Every spec option, prompt input and
 * wake-turn input has one ({@link SPEC_OPTION_SOURCES}, {@link PROMPT_INPUT_SOURCES}, {@link WAKE_INPUT_SOURCES}), so
 * an input added to their types without one fails to compile.
 * - `recorded`: the transcript's {@link SUBAGENT_REVIVE_ENTRY}, which holds plain data of the spawn's own (strings,
 *   numbers, booleans, and lists and records of them).
 * - `shared`: the {@link WarmReviveState}, which references it, when the spawn set it: an object the live process
 *   holds and shares (registries, managers, buses, the parent's tools, context and extensions) or one JSON cannot
 *   hold.
 * - `either`: the entry when JSON keeps it whole, else the state. The model goes to the entry only when it also can
 *   carry no secret ({@link modelMayCarrySecret}), and also when JSON only leaves out its `undefined` fields (the
 *   entry lists them) if the model registry holds a model equal to it in every field (the usual case). A revive takes
 *   the registry's object while the registry holds an equal one.
 * - `live`: neither; each revive or session build takes it from the live process or makes it again.
 */
type ReviveInputSource = "recorded" | "shared" | "either" | "live";

/** The keys of `R` whose {@link ReviveInputSource} is `S`. */
type KeysWithSource<R, S extends ReviveInputSource> = { [K in keyof R]: R[K] extends S ? K : never }[keyof R];

/** The keys of `sources` whose source is `source`, in their order. */
function keysWithSource<R extends Readonly<Record<string, ReviveInputSource>>, S extends ReviveInputSource>(
	sources: R,
	source: S,
): readonly KeysWithSource<R, S>[] {
	return Object.keys(sources).filter(key => sources[key] === source) as KeysWithSource<R, S>[];
}

/** Where a warm revive takes each spec option from. */
const SPEC_OPTION_SOURCES = {
	cwd: "recorded",
	additionalDirectories: "recorded",
	credentialSourceSessionId: "recorded",
	modelPattern: "recorded",
	modelPatternAuthFallback: "recorded",
	modelPatternFallbackRole: "recorded",
	modelPatternDefaultFallbackChain: "recorded",
	modelPatternChainFallback: "recorded",
	thinkingLevel: "recorded",
	disableModelFallback: "recorded",
	disableServerSideFallback: "recorded",
	thinkingLevelCeiling: "recorded",
	taskEffort: "recorded",
	cacheWarming: "recorded",
	toolNames: "recorded",
	outputSchemaMode: "recorded",
	restrictToolNames: "recorded",
	requireYieldTool: "recorded",
	noContextFiles: "recorded",
	excludeAgentsMd: "recorded",
	mergeDiscoveredSkillPaths: "recorded",
	disableExtensionDiscovery: "recorded",
	preloadedExtensionPaths: "recorded",
	hasUI: "recorded",
	spawns: "recorded",
	taskDepth: "recorded",
	parentTaskPrefix: "recorded",
	parentAgentId: "recorded",
	agentId: "recorded",
	agentDisplayName: "recorded",
	agentName: "recorded",
	enableLsp: "recorded",
	enableIrc: "recorded",
	skipPythonPreflight: "recorded",
	enableMCP: "recorded",
	model: "either",
	outputSchema: "either",
	// Each revive takes the live `task.agentAccountPools` entry; each build sets the rest.
	oauthAccountPools: "live",
	awaitingAssignment: "live",
	mcpTools: "live",
	mcpToolScope: "live",
	agentDir: "shared",
	inheritedSessionAgents: "shared",
	authStorage: "shared",
	modelRegistry: "shared",
	getApiKey: "shared",
	modelRole: "shared",
	rebindModelAfterDiscovery: "shared",
	deferRetryFallbackValidation: "shared",
	openAIServiceTier: "shared",
	scopedModels: "shared",
	prewalk: "shared",
	deferredPrewalk: "shared",
	onPrewalkWarning: "shared",
	suppressAutoPrewalk: "shared",
	planYolo: "shared",
	systemPromptTemplate: "shared",
	customSystemPrompt: "shared",
	appendSystemPrompt: "shared",
	titleSystemPrompt: "shared",
	providerSessionId: "shared",
	providerPromptCacheKey: "shared",
	taskPromptCacheKey: "shared",
	providerPromptCacheKeySource: "shared",
	deadline: "shared",
	costGate: "shared",
	customTools: "shared",
	extensions: "shared",
	additionalExtensionPaths: "shared",
	extensionRoots: "shared",
	preloadedExtensions: "shared",
	deferredExtensionPaths: "shared",
	preloadedPreparedExtensions: "shared",
	preloadedCustomToolPaths: "shared",
	eventBus: "shared",
	subagentEventBus: "shared",
	skills: "shared",
	rules: "shared",
	contextFiles: "shared",
	workspaceTree: "shared",
	promptTemplates: "shared",
	slashCommands: "shared",
	mcpManager: "shared",
	lspReadOnly: "shared",
	mountedToolNames: "shared",
	allowRestrictedCustomTools: "shared",
	bindProcessState: "shared",
	parentHindsightSessionState: "shared",
	parentMnemopiSessionState: "shared",
	agentRegistry: "shared",
	asyncJobManager: "shared",
	jobWidgetAuthor: "shared",
	jobCaptionWriter: "shared",
	localProtocolOptions: "shared",
	settingsManager: "shared",
	allowSessionModelFallback: "shared",
	interactivePrompts: "shared",
	advertiseHeadlessAsk: "shared",
	settingsApproval: "shared",
	tuiTranscript: "shared",
	autoTitle: "shared",
	deferSkillDescriptionCompression: "shared",
	deferUsageReserveConfirmation: "shared",
	telemetry: "shared",
	autoApprove: "shared",
} as const satisfies Record<keyof SubagentSpecOptions, ReviveInputSource>;

/** Spec options a {@link SUBAGENT_REVIVE_ENTRY} holds. */
const RECORDED_SPEC_OPTION_KEYS = keysWithSource(SPEC_OPTION_SOURCES, "recorded");

/** Where a warm revive takes each prompt input from. */
const PROMPT_INPUT_SOURCES = {
	id: "recorded",
	model: "recorded",
	agentSystemPrompt: "recorded",
	context: "recorded",
	planReference: "recorded",
	planReferencePath: "recorded",
	worktree: "recorded",
	structured: "recorded",
	outputSchema: "either",
	outputSchemaOverridesAgent: "recorded",
	ircEnabled: "recorded",
	ircRootSessionFile: "live",
	ircRenders: "live",
	revivalIrcRoster: "live",
} as const satisfies Record<keyof SubagentPromptInputs, ReviveInputSource>;

/** Prompt inputs a {@link SUBAGENT_REVIVE_ENTRY} holds: those fixed at spawn but the output schema. */
const RECORDED_PROMPT_KEYS = keysWithSource(PROMPT_INPUT_SOURCES, "recorded");

/** Where a warm revive takes each wake-turn monitor input from; its observability bus and schema are the spec options'. */
const WAKE_INPUT_SOURCES = {
	id: "recorded",
	index: "recorded",
	agent: "either",
	description: "recorded",
	modelOverride: "recorded",
	modelRole: "recorded",
	eventBus: "shared",
	subagentEventBus: "shared",
	parentToolCallId: "recorded",
	// Each attach passes its own.
	sessionFile: "live",
	maxRuntimeMs: "recorded",
	completionProbe: "recorded",
	softRequestBudget: "recorded",
	softRequestBudgetNotice: "recorded",
	structured: "recorded",
	outputSchema: "either",
	outputSchemaMode: "recorded",
	outputSchemaSource: "recorded",
	artifactsDir: "recorded",
	storeMaskCwd: "recorded",
} as const satisfies Record<keyof IrcWakeTurnMonitorOptions, ReviveInputSource>;

/** Wake-turn monitor inputs a {@link SUBAGENT_REVIVE_ENTRY} holds: all but the buses, agent definition and output schema. */
const RECORDED_WAKE_KEYS = keysWithSource(WAKE_INPUT_SOURCES, "recorded");

/**
 * What a kept-alive subagent's session is built from besides the live parent's settings and artifact
 * manager: the live run's, and each warm revive's, rebuilt from the {@link SUBAGENT_REVIVE_ENTRY} and
 * {@link WarmReviveState}. The session's disposers hold it, never the lifecycle.
 */
export interface SubagentReviveInputs {
	readonly spec: SubagentSessionSpec;
	readonly settingsInputs: SubagentSettingsInputs;
	/** The `subagent:<id>` retry fallback role the spawn installed; each revive installs it again. */
	readonly retryFallback: RetryFallbackRole | undefined;
	/** Todos are parent-owned and stripped from subagents, except under prewalk (its todo gate needs them). */
	readonly keepTodo: boolean;
	/**
	 * Inputs of the session's wake-turn monitor, without the session file each attach passes it. Its
	 * observability bus and output schema are the spec options'.
	 */
	readonly wake: IrcWakeTurnMonitorOptions;
}

/**
 * Data of a {@link SUBAGENT_REVIVE_ENTRY}: the plain parts of a subagent's
 * {@link SubagentReviveInputs}, and what its live session held when it was disposed.
 */
interface SubagentReviveRecord {
	/**
	 * The options {@link RECORDED_SPEC_OPTION_KEYS} names; the output schema, unless the
	 * {@link WarmReviveState} references it; the model, when it can carry no secret ({@link modelMayCarrySecret})
	 * and the entry gives it back equal in every field ({@link modelUndefinedFields}): one the model registry holds an
	 * equal one of, or a copy of the subagent's own that JSON keeps whole.
	 */
	readonly options: Partial<SubagentSpecOptions>;
	/** The fields of the options' model whose value is `undefined`, which its JSON leaves out; absent when none. */
	readonly modelUndefinedFields?: readonly (readonly string[])[];
	/** The prompt inputs {@link RECORDED_PROMPT_KEYS} names, and the output schema as the options hold it. */
	readonly prompt: Pick<SubagentPromptInputs, (typeof RECORDED_PROMPT_KEYS)[number]> & {
		readonly outputSchema?: unknown;
	};
	readonly settingsInputs: SubagentSettingsInputs;
	readonly retryFallback?: RetryFallbackRole;
	/** Settings writes of the subagent's runs; absent when none. */
	readonly settingsWrites?: SubagentSettingsWrites;
	readonly keepTodo: boolean;
	/** The wake inputs {@link RECORDED_WAKE_KEYS} names, and the agent definition unless the state references it. */
	readonly wake: Pick<IrcWakeTurnMonitorOptions, (typeof RECORDED_WAKE_KEYS)[number]> & {
		readonly agent?: AgentDefinition;
	};
	/**
	 * Pending, never-promoted family candidate. The stash lives only on the live manager, so its
	 * disposal reads it (when the header still carries no task key) and the revive restores it onto
	 * the fresh manager it opens from disk.
	 */
	readonly pendingCacheCandidate?: string;
	/**
	 * The {@link WarmReviveState.generation} of the park that wrote it. A revive pairs the state only with the entry
	 * of the same generation, so with an entry another state wrote, which a fork copies with the rest of its
	 * transcript, only by chance, at odds of about 2^-52 a park.
	 */
	readonly generation: number;
}

/** Whether `value` is a list of field paths (keys from the outermost in), as a revive record's model has. */
function isFieldPaths(value: unknown): value is string[][] {
	return (
		Array.isArray(value) &&
		value.every(
			(fieldPath: unknown) =>
				Array.isArray(fieldPath) &&
				fieldPath.length > 0 &&
				fieldPath.every((key: unknown) => typeof key === "string"),
		)
	);
}

function isSubagentReviveRecord(data: unknown): data is SubagentReviveRecord {
	return (
		isRecord(data) &&
		isRecord(data.options) &&
		isRecord(data.prompt) &&
		typeof data.prompt.id === "string" &&
		isRecord(data.settingsInputs) &&
		isRecord(data.wake) &&
		typeof data.keepTodo === "boolean" &&
		typeof data.generation === "number" &&
		(data.modelUndefinedFields === undefined || isFieldPaths(data.modelUndefinedFields))
	);
}

/**
 * The newest {@link SUBAGENT_REVIVE_ENTRY} of `entries`, which the last disposal of the subagent's
 * session wrote; `undefined` when there is none, as in a transcript written before revive inputs
 * were recorded, or when it is malformed.
 */
function latestSubagentReviveRecord(entries: readonly SessionEntry[]): SubagentReviveRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === SUBAGENT_REVIVE_ENTRY) {
			return isSubagentReviveRecord(entry.data) ? entry.data : undefined;
		}
	}
	return undefined;
}

/** Spec options a {@link WarmReviveState} references, the shared ones and those JSON may not keep whole. */
type SharedSpecOptions = Pick<SubagentSpecOptions, KeysWithSource<typeof SPEC_OPTION_SOURCES, "shared" | "either">>;

/**
 * What a parked kept-alive subagent keeps in memory for its warm revive, revived by the module-level
 * {@link reviveWarmSubagent}, in this one object: references to objects the live process holds (the
 * session storage its transcript lives in, the parent's settings and artifact manager, and the spec
 * options that name registries, managers, buses or the parent's tools, context and extensions), and
 * the few inputs its transcript does not hold: functions, a prewalk target's model, telemetry hooks,
 * a model, output schema or agent definition JSON would not keep whole, a model that may carry a
 * secret, and the credential settings its runs wrote. The model is set when the live session is
 * disposed, and only when the entry cannot give it back equal: one that may carry a secret, or one
 * JSON would not keep whole that the model registry holds no equal one of. A model equal to the
 * registry's goes to the entry: a catalog rebuild after the park replaces the registry's objects
 * with equal copies, so a state that kept the registry's object would then keep alive one nothing
 * else holds. The credential settings are set at disposal too. Its plain inputs are in its
 * transcript's newest {@link SUBAGENT_REVIVE_ENTRY} and the peer roster its prompt showed in an
 * `IRC_ROSTER_ENTRY` (subagent-session-options.ts); its session file is the one its registry
 * record names, which the lifecycle hands each revive.
 */
export interface WarmReviveState extends SharedSpecOptions {
	/** Storage the parked session's file lives in; the revive reopens it there. */
	readonly storage: SessionStorage;
	/** Settings the subagent's overlay reads through to; each revive rebuilds the overlay over them. */
	readonly parentSettings: Settings;
	readonly parentArtifactManager?: ArtifactManagerApi;
	/** A seance consult's prompt suffix, a function of the consulted session. */
	readonly preparedSession?: SubagentSessionSpec["preparedSession"];
	/** A per-call worker's grants, which hold the parent's settings. */
	readonly perCall?: SubagentSessionSpec["perCall"];
	/** The wake-turn monitor's event bus. */
	readonly wakeEventBus?: EventBus;
	/** The wake-turn monitor's agent definition, when JSON would not keep it whole. */
	readonly wakeAgent?: AgentDefinition;
	/** Credential settings the subagent's runs wrote, which its {@link SUBAGENT_REVIVE_ENTRY} leaves out. */
	credentialWrites?: SubagentCredentialWrites;
	/**
	 * Generation of the newest {@link SUBAGENT_REVIVE_ENTRY} its parks wrote or tried to write: it starts at a random
	 * integer below 2^52, which another state's start equals with odds of about 2^-52, a park that writes one raises it
	 * by one first, and the entry carries it. The model and credential settings here are the last park's, so a
	 * transcript whose newest entry carries another generation holds other inputs: an earlier park's (a write that
	 * never reached the file) or another subagent's (a seance consult's transcript is a copy of its source's, which can
	 * be another subagent's), and the revive goes cold rather than pair the two.
	 */
	generation: number;
}

/** `value` as JSON gives it back, a new value; `undefined` when JSON takes none of it. */
function jsonCopy(value: unknown): unknown {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		// A cycle or a BigInt.
		return undefined;
	}
	return json === undefined ? undefined : JSON.parse(json);
}

/** Whether `value` parsed back from its JSON is strictly equal to it: JSON loses none of its fields. */
function jsonKeepsWhole(value: unknown): boolean {
	const copy = jsonCopy(value);
	try {
		return copy !== undefined && Bun.deepEquals(copy, value, true);
	} catch {
		// A field that throws when read again after JSON read it.
		return false;
	}
}

/** The paths (keys from the outermost in) of the fields in `value` whose value is `undefined`. */
function undefinedFieldPaths(value: object, at: readonly string[] = [], within = new Set<object>()): string[][] {
	// A value JSON took whole has no cycle among its fields; this only guards a field JSON reads through `toJSON`.
	if (within.has(value)) return [];
	within.add(value);
	const paths: string[][] = [];
	for (const [key, field] of Object.entries(value)) {
		if (field === undefined) {
			paths.push([...at, key]);
		} else if (typeof field === "object" && field !== null) {
			paths.push(...undefinedFieldPaths(field, [...at, key], within));
		}
	}
	within.delete(value);
	return paths;
}

/**
 * Sets each field `paths` names in `value` (as JSON gave it back, so a new object) to `undefined` again, as an own
 * field. A path descends through own fields only, so none (one through `__proto__`, say) reaches a prototype.
 */
function setUndefinedFields<T>(value: T, paths: readonly (readonly string[])[]): T {
	for (const fieldPath of paths) {
		let parent: unknown = value;
		for (const key of fieldPath.slice(0, -1)) {
			parent =
				typeof parent === "object" && parent !== null && Object.hasOwn(parent, key)
					? Reflect.get(parent, key)
					: undefined;
		}
		if (typeof parent === "object" && parent !== null) {
			Object.defineProperty(parent, fieldPath[fieldPath.length - 1], {
				value: undefined,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
	}
	return value;
}

/**
 * The fields of `model` whose value is `undefined`, which its JSON leaves out, when its JSON with those set again gives
 * back a model strictly equal to it: one that holds no function, cycle or other value JSON changes (a models.yml model
 * holds `undefined` fields). `undefined` when it does not.
 */
function modelUndefinedFields(model: Model<Api>): string[][] | undefined {
	const copy = jsonCopy(model);
	if (copy === undefined) return undefined;
	const undefinedFields = undefinedFieldPaths(model);
	return Bun.deepEquals(setUndefinedFields(copy, undefinedFields), model, true) ? undefinedFields : undefined;
}

/** The model `registry` holds under `model`'s provider and id, when it equals `model` in every field. */
function equalRegistryModel(
	registry: ModelRegistry | undefined,
	model: Model<Api> | undefined,
): Model<Api> | undefined {
	const registered = model && registry?.find(model.provider, model.id);
	return registered && (registered === model || Bun.deepEquals(registered, model, true)) ? registered : undefined;
}

/** Whether `url` may hold a key: userinfo or a query string, or a text that is no absolute URL. */
function urlMayCarrySecret(url: string): boolean {
	const parsed = URL.parse(url);
	return parsed === null || parsed.username !== "" || parsed.password !== "" || parsed.search !== "";
}

/**
 * Whether `model` may carry a secret a provider is called with: request headers, static or resolved
 * (an `Authorization` or `x-api-key` a models.yml provider sets), extra request body fields, or an
 * endpoint URL with userinfo or a query string (a key a provider takes in the URL). Its other fields
 * name, route, price and describe the model.
 */
function modelMayCarrySecret(model: Model<Api>): boolean {
	if (model.headers !== undefined || model.resolveHeaders !== undefined) return true;
	for (const compat of [model.compat, model.compatConfig] as unknown[]) {
		if (isRecord(compat) && compat.extraBody !== undefined) return true;
	}
	const { remoteCompaction } = model;
	return [
		model.baseUrl,
		remoteCompaction?.endpoint,
		remoteCompaction?.v2Endpoint,
		remoteCompaction?.streamingEndpoint,
	].some(url => url !== undefined && urlMayCarrySecret(url));
}

/** The fields of `fields` that `omit` does not name. */
function omitFields<T extends object>(fields: T, omit: (key: keyof T) => boolean): Partial<T> {
	const kept: Partial<T> = {};
	for (const key of Object.keys(fields) as (keyof T)[]) {
		if (!omit(key)) kept[key] = fields[key];
	}
	return kept;
}

/**
 * The {@link WarmReviveState} of a kept-alive subagent spawned from `inputs`, built at spawn. The
 * model is left to its session's disposal, which settles whose object it is.
 */
export function createWarmReviveState(
	inputs: SubagentReviveInputs,
	storage: SessionStorage,
	parentSettings: Settings,
	parentArtifactManager: ArtifactManagerApi | undefined,
): WarmReviveState {
	const { spec, wake } = inputs;
	const recordsSchema = jsonKeepsWhole(spec.options.outputSchema);
	const shared = omitFields(spec.options, key => {
		const source = SPEC_OPTION_SOURCES[key];
		// The model is left to the disposal; a schema JSON keeps whole goes to the entry.
		return source === "recorded" || source === "live" || key === "model" || (key === "outputSchema" && recordsSchema);
	});
	return withoutUndefinedFields({
		...shared,
		storage,
		parentSettings,
		parentArtifactManager,
		preparedSession: spec.preparedSession,
		perCall: spec.perCall,
		wakeEventBus: wake.eventBus,
		wakeAgent: jsonKeepsWhole(wake.agent) ? undefined : wake.agent,
		// A random start: an entry another state wrote carries this state's generation only with odds of about 2^-52.
		generation: Math.floor(Math.random() * 2 ** 52),
	});
}

/**
 * When `session` is disposed, writes its {@link SUBAGENT_REVIVE_ENTRY}: the plain parts of `inputs`,
 * the writes its settings overlay holds beyond `baseline` but the credential settings' values, which
 * `state` keeps, and its manager's pending cache candidate, all final once disposal begins, while
 * the transcript's writer is still open. A disposal that would write what the transcript's newest
 * {@link SUBAGENT_REVIVE_ENTRY} already holds writes nothing: the spawn's inputs are fixed, and the settings writes and
 * pending candidate rarely change, so each park would otherwise add another copy of the prompt
 * inputs. The model goes to the entry when it can carry no secret ({@link modelMayCarrySecret}) and
 * the entry gives it back equal in every field ({@link modelUndefinedFields}), when the model registry
 * holds an equal one or JSON keeps it whole; otherwise `state` references it, as the registry's object
 * when the two agree in every field. A catalog rebuild replaces the registry's model objects with
 * equal copies, before the park (so the spawn's copy is the one nothing else holds) or after it (so
 * the park's is). A parked subagent whose model went to the entry keeps neither; one whose model
 * `state` references keeps that object through a later rebuild: the registry's as of the park, or
 * its own.
 */
export function trackSubagentReviveRecord(
	session: AgentSession,
	inputs: SubagentReviveInputs,
	state: WarmReviveState,
	baseline: OverlayLayers,
): void {
	session.addDisposer(() => {
		const { options, prompt } = inputs.spec;
		const model = options.model;
		const registryModel = equalRegistryModel(options.modelRegistry, model);
		const undefinedFields = model && !modelMayCarrySecret(model) ? modelUndefinedFields(model) : undefined;
		// A model the registry holds no equal of goes to the entry only when JSON keeps it whole.
		const recordedModel = undefinedFields && (registryModel || undefinedFields.length === 0) ? model : undefined;
		const keptModel = recordedModel ? undefined : (registryModel ?? model);
		if (state.model !== keptModel) state.model = keptModel;
		const layers = session.settings.overlayLayers();
		const global = splitCredentialWrites(layerWrites(baseline.global, layers.global));
		const overrides = splitCredentialWrites(layerWrites(baseline.overrides, layers.overrides));
		const credentialWrites =
			global.credentials || overrides.credentials
				? withoutUndefinedFields({ global: global.credentials, overrides: overrides.credentials })
				: undefined;
		if (state.credentialWrites !== credentialWrites) state.credentialWrites = credentialWrites;
		const manager = session.sessionManager;
		// An output schema JSON would not keep whole stays referenced in `state`; the prompt's is then the same object.
		const recordsSchema = state.outputSchema === undefined;
		const record: SubagentReviveRecord = {
			options: {
				...withoutUndefinedFields(options, RECORDED_SPEC_OPTION_KEYS),
				outputSchema: recordsSchema ? options.outputSchema : undefined,
				model: recordedModel,
			},
			modelUndefinedFields: recordedModel && undefinedFields?.length ? undefinedFields : undefined,
			prompt: {
				...withoutUndefinedFields(prompt, RECORDED_PROMPT_KEYS),
				outputSchema: recordsSchema ? prompt.outputSchema : undefined,
			},
			settingsInputs: inputs.settingsInputs,
			retryFallback: inputs.retryFallback,
			settingsWrites:
				global.writes || overrides.writes ? { global: global.writes, overrides: overrides.writes } : undefined,
			keepTodo: inputs.keepTodo,
			wake: {
				...withoutUndefinedFields(inputs.wake, RECORDED_WAKE_KEYS),
				agent: state.wakeAgent === undefined ? inputs.wake.agent : undefined,
			},
			// An already-persisted header is the carrier a revive reconstitutes from — only an unpromoted
			// stash must be carried, so a header stripped on disk (a deliberate drop of persisted
			// affinity) cannot resurrect it.
			pendingCacheCandidate:
				manager.getHeader()?.taskPromptCacheKey === undefined ? manager.getTaskSiblingCandidate() : undefined,
			generation: state.generation,
		};
		// Compared as JSON reads it back: a field this record leaves `undefined` is one the entry lacks.
		if (Bun.deepEquals(latestSubagentReviveRecord(manager.getEntries()), record)) return;
		// The entry carries the state's next generation: should it never reach the file (a disk failure the manager
		// only notes), the next revive finds an older entry's generation, or another state's, and revives cold.
		state.generation += 1;
		try {
			manager.appendCustomEntry(SUBAGENT_REVIVE_ENTRY, { ...record, generation: state.generation });
		} catch (error) {
			logger.warn("Subagent revive inputs were not recorded", { id: prompt.id, error: String(error) });
		}
	});
}

/**
 * Warm reviver of every parked kept-alive subagent, called by the lifecycle with that subagent's
 * own {@link WarmReviveState}. Park closed the JSONL writer, so reopening takes the single-writer
 * lock cleanly and restores the full message history (createAgentSession → agent.replaceMessages),
 * and the transcript's newest {@link SUBAGENT_REVIVE_ENTRY} holds the session's plain inputs. A
 * transcript without one, or whose newest is not the last park's ({@link WarmReviveState.generation}), fails with
 * {@link WarmReviveInputsMissingError}, which the lifecycle answers with a cold revive. Isolated runs keep their
 * worktree for the same lifecycle, so they use this path too.
 */
export async function reviveWarmSubagent(expectedAgentRef: AgentRef, state: WarmReviveState): Promise<AgentSession> {
	const { id } = expectedAgentRef;
	// The file the parked session wrote: its registry record takes the path the spawn's session manager opened.
	const sessionFile = expectedAgentRef.sessionFile;
	if (sessionFile === null) {
		throw new Error(`Cannot revive subagent "${id}": its registry record names no session file.`);
	}
	const reopened = await SessionManager.open(sessionFile, undefined, state.storage, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	const entries = reopened.getEntries();
	if (!hasConversationalHistory(entries)) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${id}": session file "${sessionFile}" has no message history ` +
				`(truncated to header/session_init). The agent was not revived.`,
		);
	}
	const record = latestSubagentReviveRecord(entries);
	const {
		storage,
		parentSettings,
		parentArtifactManager,
		preparedSession,
		perCall,
		wakeEventBus,
		wakeAgent,
		credentialWrites,
		generation,
		...shared
	} = state;
	const agent = wakeAgent ?? record?.wake.agent;
	if (!record || !agent || record.generation !== generation) {
		await reopened.close();
		throw new WarmReviveInputsMissingError(
			`Cannot warm-revive subagent "${id}": session file "${sessionFile}" records no revive inputs of its last park.`,
		);
	}
	// The model the subagent parked with, as the entry gives it back, is the model registry's object when the registry
	// still holds an equal one.
	const recordedModel =
		record.options.model && record.modelUndefinedFields
			? setUndefinedFields(structuredClone(record.options.model), record.modelUndefinedFields)
			: record.options.model;
	const registryModel = equalRegistryModel(shared.modelRegistry, recordedModel);
	// The inputs the parked session was built from: the plain ones its transcript holds, and the live objects.
	const options: SubagentSpecOptions = withoutUndefinedFields({
		...record.options,
		...shared,
		model: shared.model ?? registryModel ?? recordedModel,
	});
	const inputs: SubagentReviveInputs = {
		spec: {
			options,
			preparedSession,
			prompt: { ...record.prompt, outputSchema: shared.outputSchema ?? record.prompt.outputSchema },
			perCall,
			revivable: true,
		},
		settingsInputs: record.settingsInputs,
		retryFallback: record.retryFallback,
		keepTodo: record.keepTodo,
		wake: withoutUndefinedFields({
			...record.wake,
			agent,
			eventBus: wakeEventBus,
			subagentEventBus: options.subagentEventBus,
			outputSchema: options.outputSchema,
		}),
	};
	if (parentArtifactManager) {
		reopened.adoptArtifactManager(parentArtifactManager);
	}
	// The stash died with the parked manager: hand the pending, never-promoted
	// family candidate to the fresh one so the first eligible request after
	// revival still finds and persists it.
	if (record.pendingCacheCandidate !== undefined) {
		reopened.setTaskSiblingCandidate(record.pendingCacheCandidate);
	}
	const { spec } = inputs;
	const mcpManager = spec.options.mcpManager;
	let mcpFollower: MCPToolFollower | undefined;
	let revived: AgentSession;
	let startupModelFallback: CreateAgentSessionResult["startupModelFallback"];
	let settingsBaseline: OverlayLayers;
	try {
		try {
			await refreshSubagentIrcRoot(spec.prompt, reopened, sessionFile, storage);
			// The revived session reopens its own view, keeping the tools its earlier requests rendered.
			mcpFollower = mcpManager
				? followMCPTools(mcpManager, { scope: reopened.getSessionId() }, explicitSubagentToolNames(spec))
				: undefined;
			// Account pools are owner policy: take the live exact-name entry, as
			// dispatch and persisted revival do, never the spawn-time copy.
			const agentAccountPools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(parentSettings));
			// A session-local switch since spawn (a prewalk handoff) owns the model and effort: the
			// transcript restores the effort, and the spawn selection only backs the model up when it is
			// unavailable. The spawn's prewalk stays configured; the coordinator sees it was spent. A seance
			// fork's selections belong to its source run, never to the consult.
			// A per-call worker never switches models, so its warm revive never prepends a session-local switch.
			const sessionLocalModel =
				spec.preparedSession || spec.perCall ? undefined : reopened.getSessionLocalModelChange()?.model;
			if (spec.prompt.ircEnabled) {
				// The prompt the parked session sent shows this roster; rendering it again keeps the cached prefix.
				spec.prompt.revivalIrcRoster = revivalIrcRoster(entries);
				// The blocks the transcript already records, read from the entries in hand rather than again.
				spec.prompt.ircRenders = { renders: new Map(), recorded: recordedIrcRosterBlocks(entries) };
			}
			const revivedSettings = reviveSubagentSettings(
				parentSettings,
				inputs,
				withCredentialWrites(record.settingsWrites, credentialWrites),
			);
			settingsBaseline = revivedSettings.baseline;
			const sessionOptions = buildSubagentSessionOptions(
				spec,
				revivedSettings.settings,
				reopened,
				expectedAgentRef,
				mcpFollower,
			);
			({ session: revived, startupModelFallback } = await createAgentSession({
				...sessionOptions,
				...(sessionLocalModel
					? {
							model: undefined,
							modelPattern: [
								sessionLocalModel,
								...(sessionOptions.model
									? [formatModelStringWithRouting(sessionOptions.model)]
									: sessionOptions.modelPattern === undefined
										? []
										: [sessionOptions.modelPattern].flat()),
							],
							modelPatternFallbackRole: undefined,
							modelPatternDefaultFallbackChain: undefined,
							thinkingLevel: undefined,
						}
					: undefined),
				oauthAccountPools: Object.hasOwn(agentAccountPools, inputs.wake.agent.name)
					? agentAccountPools[inputs.wake.agent.name]
					: undefined,
			}));
		} catch (error) {
			mcpFollower?.dispose();
			// The reopened manager is this revive's alone, whatever step failed. Once built, the session claimed
			// this journal as its writer: leaving it claimed would divert the next revive of this transcript to a
			// sibling file instead of rebuilding it in place.
			await reopened.close();
			throw error;
		}
		mcpFollower?.bind(revived);
		if (startupModelFallback) startupModelFallbacks.set(revived, startupModelFallback);
		trackSubagentReviveRecord(revived, inputs, state, settingsBaseline);
		dropIrcRendersOnDispose(revived, spec.prompt);
		const withoutParentOwnedTools = (toolNames: string[]): string[] =>
			inputs.keepTodo ? toolNames : toolNames.filter(name => name !== "todo");
		// Strip what the spawn stripped, before extensions start: the rebuilt session enables its defaults again.
		const revivedToolNames = revived.getEnabledToolNames();
		const subagentToolNames = withoutParentOwnedTools(revivedToolNames);
		if (subagentToolNames.length !== revivedToolNames.length) {
			await revived.setActiveToolsByName(subagentToolNames);
		}
		// Re-run the executor's extension wiring on the rebuilt session. Skipping it leaves the
		// runner pre-init, so a `tool_call` handler touching a runtime action trips the
		// fail-closed gate and blocks every tool (including `yield`) in the revived agent (issue #8824).
		await initializeExtensions(revived, {
			reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
			reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			filterActiveTools: withoutParentOwnedTools,
		});
		await replayRevivedAgentStart(revived);
	} finally {
		spec.prompt.revivalIrcRoster = undefined;
	}
	AgentRegistry.global().syncSessionStatus(id, revived);
	attachIrcWakeTurnMonitor(revived, { ...inputs.wake, sessionFile });
	return revived;
}
