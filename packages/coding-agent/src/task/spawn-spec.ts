/**
 * The spawn spec: a plain-data record of the inputs a subagent session was built from, stored in
 * its `session_init` (`spawnSpec`) so that a revive in another process can build the same session.
 *
 * {@link SPAWN_INPUT_CLASSES} classes every input of a subagent build; {@link spawnSpecFromSpawn}
 * records the stored ones at spawn, and {@link readSpawnSpec} reads them back part by part.
 *
 * Its value imports are leaf packages only, so the executor, the eval tools and the thread
 * services can import it without changing the order their module graph evaluates in.
 */
import type { Effort, JsonValue } from "@oh-my-pi/pi-ai";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel, parseEffort } from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { EvalToolDescriptor } from "../eval/types";
import type { CreateAgentSessionOptions } from "../sdk";
import type { PersistedSessionInit } from "../session/session-manager";
import type {
	IrcWakeTurnMonitorOptions,
	RootCompactionThresholds,
	SubagentLiveInputs,
	SubagentPromptInputs,
	SubagentSettingsSnapshot,
	WarmReviveCache,
	WarmReviveCapture,
} from "./executor";
import type { AgentDefinition } from "./types";

/** Version of the stored spec; a record whose `v` differs reads as having none. */
export const SPAWN_SPEC_VERSION = 1;

/** A JSON object, as a transcript line stores it. */
export type JsonRecord = { readonly [key: string]: JsonValue };

/** The spawn's agent definition without its `systemPrompt`, which the spec stores once, as `prompt.agentSystemPrompt`. */
export interface SpawnSpecAgent extends Omit<AgentDefinition, "systemPrompt" | "output"> {
	output?: JsonValue;
}

/** The prewalk hand-off the spawn armed. */
export interface SpawnSpecPrewalk {
	/** Identity (`formatModelStringWithRouting`) of the target model. */
	target: string;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** The subagent settings overlay the spawn wrote. */
export interface SpawnSpecSettings {
	/** The overlay's own writes (`Settings.overlayLayers()`), among them the `subagent:<id>` retry-fallback role. */
	layers: { global: JsonRecord; overrides: JsonRecord; derived: boolean };
	/** Root compaction thresholds the spawn chain pins; absent when it pins none. */
	rootThresholds?: RootCompactionThresholds;
}

/** Tool options the spec stores as the spawn passed them. */
type StoredToolOptionKeys = "toolNames" | "restrictToolNames" | "requireYieldTool" | "outputSchemaMode";

/** The tools the spawn asked for. */
export interface SpawnSpecTools extends Pick<CreateAgentSessionOptions, StoredToolOptionKeys> {
	/** Tool commands the session mounted as bash commands at spawn. */
	mountedToolNames: string[];
	/** Todos are parent-owned and stripped from a subagent, except under prewalk. */
	keepTodo: boolean;
	outputSchema?: JsonValue;
	/** Descriptor of each eval-defined custom tool, from which a revive builds the tool again. */
	customTools: EvalToolDescriptor[];
}

/** Policy values the spawn passed to the session; an absent value is one the spawn left to the SDK default. */
export type SpawnSpecPolicy = Pick<
	CreateAgentSessionOptions,
	| "cwd"
	| "additionalDirectories"
	| "credentialSourceSessionId"
	| "noContextFiles"
	| "enableLsp"
	| "cacheWarming"
	| "enableIrc"
	| "enableMCP"
	| "skipPythonPreflight"
	| "spawns"
	| "taskDepth"
>;

/** The identity the spawn gave the session. */
export type SpawnSpecIdentity = Pick<
	CreateAgentSessionOptions,
	"agentId" | "agentName" | "agentDisplayName" | "parentAgentId" | "parentTaskPrefix"
>;

/** Prompt inputs that only the live process holds; the spec does not store them. */
type ProcessLocalPromptKeys = "ircRoot" | "ircRenders";

/** The inputs of the subagent's own prompt block. */
export interface SpawnSpecPrompt extends Omit<SubagentPromptInputs, ProcessLocalPromptKeys | "outputSchema"> {
	outputSchema?: JsonValue;
}

/** Wake-turn monitor options the spec stores as the spawn passed them. */
type StoredWakeKeys =
	| "index"
	| "description"
	| "modelOverride"
	| "modelRole"
	| "parentToolCallId"
	| "maxRuntimeMs"
	| "completionProbe"
	| "softRequestBudget"
	| "softRequestBudgetNotice"
	| "outputSchemaMode"
	| "outputSchemaSource"
	| "artifactsDir";

/** The plain inputs of the wake-turn monitor. */
export interface SpawnSpecWake extends Pick<IrcWakeTurnMonitorOptions, StoredWakeKeys> {
	agent: SpawnSpecAgent;
	outputSchema?: JsonValue;
}

/**
 * Live inputs a spawner passes or leaves unset (a vibe worker, for one, passes no extension roots). The spec
 * names those the spawn passed, never their values, so a cold revive passes the same ones from the live parent.
 */
export const SPAWN_LIVE_INPUT_NAMES = [
	"costGate",
	"getApiKey",
	"inheritedSessionAgents",
	"contextFiles",
	"skills",
	"promptTemplates",
	"workspaceTree",
	"rules",
	"extensionRoots",
	"preloadedExtensionPaths",
	"preloadedPreparedExtensions",
	"preloadedCustomToolPaths",
	"subagentEventBus",
	"parentHindsightSessionState",
	"parentMnemopiSessionState",
	"asyncJobManager",
	"mcpManager",
	"localProtocolOptions",
	"telemetry",
	"eventBus",
	"parentArtifactManager",
] as const satisfies readonly (keyof SubagentLiveInputs)[];

/** One of {@link SPAWN_LIVE_INPUT_NAMES}. */
export type SpawnLiveInputName = (typeof SPAWN_LIVE_INPUT_NAMES)[number];

/**
 * Everything a subagent spawn decided that a revive needs to build the same session, as JSON values
 * only (no function, `Map` or class instance), so a JSON round trip gives the same value.
 */
export interface SubagentSpawnSpec {
	v: typeof SPAWN_SPEC_VERSION;
	/** Identity (`formatModelStringWithRouting`) of the model the session started on; null when it started on none. */
	model: string | null;
	/** Configured thinking level the spawn passed; null where it passed none. */
	thinkingLevel: ConfiguredThinkingLevel | null;
	/** The spawn's effort ceiling; absent when it set none. */
	thinkingLevelCeiling?: Effort;
	/** The model came from a per-call `model`. */
	perCallModel: boolean;
	/** Absent when the spawn armed no prewalk. */
	prewalk?: SpawnSpecPrewalk;
	settings: SpawnSpecSettings;
	tools: SpawnSpecTools;
	policy: SpawnSpecPolicy;
	identity: SpawnSpecIdentity;
	prompt: SpawnSpecPrompt;
	wake: SpawnSpecWake;
	/** The live inputs the spawn passed; absent, a revive passes every live input it has. */
	liveInputs?: SpawnLiveInputName[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Inventory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How one input of a subagent build reaches a revive:
 * - `S`: stored in the spawn spec.
 * - `R`: replaced at a revive by a stored field (the `modelPattern*` options by `model`).
 * - `D`: derived at a revive from stored fields by the spawn's own formula.
 * - `L`: a live input of the process: the spawner's objects at the spawn and a warm revive, the live
 *   parent session's at a cold revive.
 * - `C`: a constant of every spawn; it also applies to a record with no spawn spec.
 * - `P`: process-local state that only a warm revive holds.
 * - `N`: set by no subagent build, so the SDK default holds on every path.
 * - `S+L`: stored descriptors rebuilt over a live input (custom tools over the parent's eval kernel).
 * - `S over L`: stored layers applied over a live base (the overlay over the parent `Settings`).
 * - `S+held+L`: built from the stored prompt inputs, the transcript's held base prompt and the live
 *   default blocks (`systemPrompt`).
 * - `S+P`: stored at spawn, plus the writes of the run that only a warm revive holds.
 * - `launch`: passed by the spawn's first build only; absent (or false) at a revive.
 * - `nested`: a member whose own type's map classes its members.
 */
export type InputClass =
	| "S"
	| "R"
	| "D"
	| "L"
	| "C"
	| "P"
	| "N"
	| "S+L"
	| "S over L"
	| "S+held+L"
	| "S+P"
	| "launch"
	| "nested";

/** Classes of one type's members; `bun run check` fails while a member has none. */
type InputClasses<T> = Readonly<Record<keyof T, InputClass>>;

const createAgentSessionOptionClasses: InputClasses<CreateAgentSessionOptions> = {
	cwd: "S",
	additionalDirectories: "S",
	agentDir: "N",
	spawns: "S",
	inheritedSessionAgents: "L",
	authStorage: "L",
	modelRegistry: "L",
	getApiKey: "L",
	credentialSourceSessionId: "S",
	oauthAccountPools: "L",
	model: "S",
	modelRole: "N",
	rebindModelAfterDiscovery: "N",
	deferRetryFallbackValidation: "N",
	modelPattern: "R",
	modelPatternParentFallback: "R",
	modelPatternFallbackRole: "R",
	modelPatternDefaultFallbackChain: "R",
	// The dispatch guard: the offline provider check and the per-call approval. The spawn's at a warm
	// revive; one over the live provider and grants at a cold revive.
	assertDispatchModel: "L",
	// From `perCallModel`.
	disableModelFallback: "D",
	// From `perCallModel`, or offline mode.
	disableServerSideFallback: "D",
	thinkingLevel: "S",
	thinkingLevelCeiling: "S",
	openAIServiceTier: "N",
	cacheWarming: "S",
	resolveServiceTierByFamily: "launch",
	scopedModels: "N",
	prewalk: "S",
	deferredPrewalk: "N",
	onPrewalkWarning: "N",
	suppressAutoPrewalk: "N",
	awaitingAssignment: "launch",
	planYolo: "N",
	systemPrompt: "S+held+L",
	systemPromptTemplate: "N",
	customSystemPrompt: "N",
	appendSystemPrompt: "N",
	titleSystemPrompt: "N",
	providerSessionId: "N",
	providerPromptCacheKey: "N",
	taskPromptCacheKey: "N",
	providerPromptCacheKeySource: "N",
	deadline: "N",
	costGate: "L",
	// Descriptors stored (`ExecutorOptions.customToolDescriptors` carries them into a worker); built over the parent's kernel.
	customTools: "S+L",
	extensions: "N",
	topLevelExtensions: "N",
	additionalExtensionPaths: "N",
	disableExtensionDiscovery: "N",
	extensionRoots: "L",
	preloadedExtensions: "N",
	deferredExtensionPaths: "N",
	preloadedExtensionPaths: "L",
	preloadedPreparedExtensions: "L",
	preloadedCustomToolPaths: "L",
	eventBus: "N",
	subagentEventBus: "L",
	skills: "L",
	rules: "L",
	contextFiles: "L",
	noContextFiles: "S",
	excludeAgentsMd: "C",
	workspaceTree: "L",
	promptTemplates: "L",
	slashCommands: "N",
	enableMCP: "S",
	mcpManager: "L",
	mcpTools: "L",
	mcpToolScope: "L",
	enableLsp: "S",
	lspReadOnly: "N",
	enableIrc: "S",
	skipPythonPreflight: "S",
	toolNames: "S",
	mountedToolNames: "S",
	restrictToolNames: "S",
	allowRestrictedCustomTools: "N",
	outputSchema: "S",
	outputSchemaMode: "S",
	requireYieldTool: "S",
	bindProcessState: "N",
	taskDepth: "S",
	parentHindsightSessionState: "L",
	parentMnemopiSessionState: "L",
	agentId: "S",
	agentDisplayName: "S",
	agentName: "S",
	agentRegistry: "N",
	expectedAgentRef: "L",
	parentTaskPrefix: "S",
	asyncJobManager: "L",
	jobWidgetAuthor: "N",
	jobCaptionWriter: "N",
	parentAgentId: "S",
	sessionManager: "L",
	localProtocolOptions: "L",
	settings: "S over L",
	settingsManager: "N",
	hasUI: "C",
	allowSessionModelFallback: "N",
	interactivePrompts: "N",
	advertiseHeadlessAsk: "N",
	settingsApproval: "N",
	tuiTranscript: "N",
	autoTitle: "N",
	deferHintCompression: "N",
	deferUsageReserveConfirmation: "N",
	telemetry: "L",
	onFirstChatDispatch: "launch",
	autoApprove: "N",
};

const subagentPromptInputClasses: InputClasses<SubagentPromptInputs> = {
	id: "S",
	model: "S",
	agentSystemPrompt: "S",
	context: "S",
	planReference: "S",
	planReferencePath: "S",
	worktree: "S",
	structured: "S",
	outputSchema: "S",
	outputSchemaOverridesAgent: "S",
	ircEnabled: "S",
	// Resolved again at each build (`refreshSubagentIrcRoot`).
	ircRoot: "D",
	ircRenders: "P",
};

const warmReviveCaptureClasses: InputClasses<WarmReviveCapture> = {
	sessionFile: "L",
	// The spawn spec itself, the same object the spawn wrote to session_init.
	spec: "S",
	live: "L",
	cache: "nested",
};

const warmReviveCacheClasses: InputClasses<WarmReviveCache> = {
	// The models the spec's identities name, which a warm revive holds rather than resolves.
	model: "S",
	prewalkTarget: "S",
	settings: "S+P",
	pendingCacheCandidate: "P",
	ircRenders: "P",
};

const ircWakeTurnMonitorOptionClasses: InputClasses<IrcWakeTurnMonitorOptions> = {
	// Stored once, as `identity.agentId`.
	id: "S",
	index: "S",
	agent: "S",
	description: "S",
	modelOverride: "S",
	modelRole: "S",
	eventBus: "L",
	subagentEventBus: "L",
	parentToolCallId: "S",
	sessionFile: "L",
	maxRuntimeMs: "S",
	completionProbe: "S",
	softRequestBudget: "S",
	softRequestBudgetNotice: "S",
	outputSchema: "S",
	outputSchemaMode: "S",
	outputSchemaSource: "S",
	artifactsDir: "S",
};

/** Every input of a subagent build, by the type that carries it, with its {@link InputClass}. */
export const SPAWN_INPUT_CLASSES = {
	createAgentSessionOptions: createAgentSessionOptionClasses,
	subagentPromptInputs: subagentPromptInputClasses,
	warmReviveCapture: warmReviveCaptureClasses,
	warmReviveCache: warmReviveCacheClasses,
	ircWakeTurnMonitorOptions: ircWakeTurnMonitorOptionClasses,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Writing
// ═══════════════════════════════════════════════════════════════════════════

/** Session options {@link spawnSpecFromSpawn} reads. */
type SpawnSpecOptionKeys =
	| keyof SpawnSpecPolicy
	| keyof SpawnSpecIdentity
	| StoredToolOptionKeys
	| "thinkingLevel"
	| "thinkingLevelCeiling"
	| "outputSchema";

/**
 * What the spawn decided, for {@link spawnSpecFromSpawn}. The spec it writes takes `model`, `settings` and
 * `mountedToolNames` as they are once `createAgentSession` returned.
 */
export interface SpawnSpecInputs {
	/** The session options the spawn built. */
	options: Pick<CreateAgentSessionOptions, SpawnSpecOptionKeys>;
	prompt: Omit<SubagentPromptInputs, ProcessLocalPromptKeys>;
	wake: IrcWakeTurnMonitorOptions;
	/** Identity (`formatModelStringWithRouting`) of the model the session started on; null when none. */
	model: string | null;
	/** The prewalk hand-off the spawn armed, its target as an identity. */
	prewalk: SpawnSpecPrewalk | undefined;
	perCallModel: boolean;
	keepTodo: boolean;
	/** The overlay's own writes and root thresholds, as the warm capture takes them. */
	settings: SubagentSettingsSnapshot;
	mountedToolNames: string[];
	customTools: EvalToolDescriptor[];
	liveInputs: SpawnLiveInputName[];
}

/** The descriptor each eval-defined custom tool was built from, on the thread that built it. */
const evalToolDescriptors = new WeakMap<object, EvalToolDescriptor>();

/** Records that `tool` was built from `descriptor`, for {@link evalToolDescriptor}. */
export function recordEvalToolDescriptor(tool: object, descriptor: EvalToolDescriptor): void {
	evalToolDescriptors.set(tool, descriptor);
}

/**
 * The eval descriptor `tool` was built from (`createEvalCustomTools`), or undefined for any other
 * tool, and for a tool built on another thread: a tool that crossed into a worker is a new view.
 */
export function evalToolDescriptor(tool: object): EvalToolDescriptor | undefined {
	return evalToolDescriptors.get(tool);
}

/** `value` without its undefined members, which a transcript line does not hold. */
function definedMembers<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T;
}

/** `value` as a transcript line gives it back; undefined where JSON holds no value for it. */
export function jsonValue(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value);
	return text === undefined ? undefined : JSON.parse(text);
}

function jsonRecord(value: Readonly<Record<string, unknown>>): JsonRecord {
	return JSON.parse(JSON.stringify(value));
}

/** A subagent overlay's own writes (`Settings.overlayLayers()`) and the root thresholds its chain pins, as the spec stores them. */
export function spawnSpecSettings(snapshot: SubagentSettingsSnapshot): SpawnSpecSettings {
	const { layers, rootThresholds } = snapshot;
	return definedMembers({
		layers: { global: jsonRecord(layers.global), overrides: jsonRecord(layers.overrides), derived: layers.derived },
		rootThresholds: rootThresholds ? definedMembers({ ...rootThresholds }) : undefined,
	});
}

/** The spawn spec of a subagent the spawn has just built, from the values the spawn holds. */
export function spawnSpecFromSpawn(spawn: SpawnSpecInputs): SubagentSpawnSpec {
	const { options, prompt, wake, prewalk } = spawn;
	const { systemPrompt: _storedAsPrompt, output, ...agent } = wake.agent;
	// The tools, the prompt and the wake each store an output schema; an object they share is converted once.
	const outputSchema = jsonValue(options.outputSchema);
	const spec: SubagentSpawnSpec = {
		v: SPAWN_SPEC_VERSION,
		model: spawn.model,
		thinkingLevel: options.thinkingLevel ?? null,
		thinkingLevelCeiling: options.thinkingLevelCeiling,
		perCallModel: spawn.perCallModel,
		prewalk: prewalk ? definedMembers({ ...prewalk }) : undefined,
		settings: spawnSpecSettings(spawn.settings),
		tools: definedMembers({
			toolNames: options.toolNames,
			mountedToolNames: spawn.mountedToolNames,
			restrictToolNames: options.restrictToolNames,
			requireYieldTool: options.requireYieldTool,
			keepTodo: spawn.keepTodo,
			outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			customTools: spawn.customTools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: jsonRecord(tool.parameters),
				language: tool.language,
			})),
		}),
		policy: definedMembers({
			cwd: options.cwd,
			additionalDirectories: options.additionalDirectories,
			credentialSourceSessionId: options.credentialSourceSessionId,
			noContextFiles: options.noContextFiles,
			enableLsp: options.enableLsp,
			cacheWarming: options.cacheWarming,
			enableIrc: options.enableIrc,
			enableMCP: options.enableMCP,
			skipPythonPreflight: options.skipPythonPreflight,
			spawns: options.spawns,
			taskDepth: options.taskDepth,
		}),
		identity: definedMembers({
			agentId: options.agentId,
			agentName: options.agentName,
			agentDisplayName: options.agentDisplayName,
			parentAgentId: options.parentAgentId,
			parentTaskPrefix: options.parentTaskPrefix,
		}),
		prompt: definedMembers({
			id: prompt.id,
			model: prompt.model,
			agentSystemPrompt: prompt.agentSystemPrompt,
			context: prompt.context,
			planReference: prompt.planReference,
			planReferencePath: prompt.planReferencePath,
			worktree: prompt.worktree,
			structured: prompt.structured,
			outputSchema: prompt.outputSchema === options.outputSchema ? outputSchema : jsonValue(prompt.outputSchema),
			outputSchemaOverridesAgent: prompt.outputSchemaOverridesAgent,
			ircEnabled: prompt.ircEnabled,
		}),
		wake: definedMembers({
			index: wake.index,
			agent: definedMembers({ ...agent, output: jsonValue(output) }),
			description: wake.description,
			modelOverride: wake.modelOverride,
			modelRole: wake.modelRole,
			parentToolCallId: wake.parentToolCallId,
			maxRuntimeMs: wake.maxRuntimeMs,
			completionProbe: wake.completionProbe,
			softRequestBudget: wake.softRequestBudget,
			softRequestBudgetNotice: wake.softRequestBudgetNotice,
			outputSchema: wake.outputSchema === options.outputSchema ? outputSchema : jsonValue(wake.outputSchema),
			outputSchemaMode: wake.outputSchemaMode,
			outputSchemaSource: wake.outputSchemaSource,
			artifactsDir: wake.artifactsDir,
		}),
		liveInputs: [...spawn.liveInputs],
	};
	return definedMembers(spec);
}

// ═══════════════════════════════════════════════════════════════════════════
// Reading
// ═══════════════════════════════════════════════════════════════════════════

/** {@link SpawnSpecWake} with the agent's `systemPrompt` taken back from `prompt.agentSystemPrompt`. */
export interface SpawnSpecWakeOptions extends Omit<SpawnSpecWake, "agent"> {
	agent: SpawnSpecAgent & Pick<AgentDefinition, "systemPrompt">;
}

/**
 * A record's spawn spec, part by part. Each part is undefined where the record holds no spec, or
 * where the spec lacks the part or holds it in the wrong shape; a caller then takes that part's
 * fallback for a record an older omp wrote.
 */
export interface SpawnSpecParts {
	/** The record holds a spec of {@link SPAWN_SPEC_VERSION}; a spec of another version reads as none. */
	stored: boolean;
	model?: { model: string | null; perCallModel: boolean };
	thinking?: { thinkingLevel: ConfiguredThinkingLevel | null; thinkingLevelCeiling?: Effort };
	/** Absent where the spawn armed no prewalk, as where the part is malformed. */
	prewalk?: SpawnSpecPrewalk;
	settings?: SpawnSpecSettings;
	tools?: SpawnSpecTools;
	policy?: SpawnSpecPolicy;
	identity?: SpawnSpecIdentity;
	prompt?: SpawnSpecPrompt;
	wake?: SpawnSpecWakeOptions;
	liveInputs?: SpawnLiveInputName[];
}

type Check = (value: unknown) => boolean;

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isThinkingLevel = (value: unknown): value is ConfiguredThinkingLevel =>
	typeof value === "string" && parseConfiguredThinkingLevel(value) === value;
const isEffort = (value: unknown): value is Effort => typeof value === "string" && parseEffort(value) === value;
const isSchemaMode: Check = value => value === "permissive" || value === "strict";
const isCacheWarmingMode: Check = value => value === "off" || value === "streaming" || value === "idle";
const isSchemaSource: Check = value =>
	value === "caller" || value === "agent" || value === "session" || value === "none";
const isAgentSource: Check = value => value === "bundled" || value === "user" || value === "project";
const isEvalLanguage: Check = value => value === "python" || value === "js";
const isBooleanOrString: Check = value => typeof value === "boolean" || typeof value === "string";

/** Whether every listed member of `record` is present and passes its check (`optional` ones may be absent). */
function hasShape(
	record: Readonly<Record<string, unknown>>,
	required: Readonly<Record<string, Check>>,
	optional: Readonly<Record<string, Check>> = {},
): boolean {
	for (const key in required) {
		if (!required[key](record[key])) return false;
	}
	for (const key in optional) {
		const value = record[key];
		if (value !== undefined && !optional[key](value)) return false;
	}
	return true;
}

function isRootThresholds(value: unknown): value is RootCompactionThresholds {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{ thresholdPercent: isNumber, thresholdTokens: isNumber, modelThresholdsEnabled: isBoolean },
			{ fixed: fixed => fixed === true },
		)
	);
}

function isSettings(value: unknown): value is SpawnSpecSettings {
	if (!isRecord(value)) return false;
	const layers = value.layers;
	return (
		isRecord(layers) &&
		isRecord(layers.global) &&
		isRecord(layers.overrides) &&
		isBoolean(layers.derived) &&
		(value.rootThresholds === undefined || isRootThresholds(value.rootThresholds))
	);
}

function isEvalToolDescriptor(value: unknown): value is EvalToolDescriptor {
	return (
		isRecord(value) &&
		hasShape(value, { name: isString, description: isString, parameters: isRecord, language: isEvalLanguage })
	);
}

function isTools(value: unknown): value is SpawnSpecTools {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{
				mountedToolNames: isStringArray,
				keepTodo: isBoolean,
				customTools: tools => Array.isArray(tools) && tools.every(isEvalToolDescriptor),
			},
			{
				toolNames: isStringArray,
				restrictToolNames: isBoolean,
				requireYieldTool: isBoolean,
				outputSchemaMode: isSchemaMode,
			},
		)
	);
}

function isPolicy(value: unknown): value is SpawnSpecPolicy {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{},
			{
				cwd: isString,
				additionalDirectories: isStringArray,
				credentialSourceSessionId: isString,
				noContextFiles: isBoolean,
				enableLsp: isBoolean,
				cacheWarming: isCacheWarmingMode,
				enableIrc: isBoolean,
				enableMCP: isBoolean,
				skipPythonPreflight: isBoolean,
				spawns: isString,
				taskDepth: isNumber,
			},
		)
	);
}

function isIdentity(value: unknown): value is SpawnSpecIdentity {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{},
			{
				agentId: isString,
				agentName: isString,
				agentDisplayName: isString,
				parentAgentId: isString,
				parentTaskPrefix: isString,
			},
		)
	);
}

function isPrompt(value: unknown): value is SpawnSpecPrompt {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{
				id: isString,
				agentSystemPrompt: isString,
				context: isString,
				planReference: isString,
				planReferencePath: isString,
				worktree: isString,
				structured: isBoolean,
				outputSchemaOverridesAgent: isBoolean,
				ircEnabled: isBoolean,
			},
			{ model: isString },
		)
	);
}

function isAgent(value: unknown): value is SpawnSpecAgent {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{ name: isString, description: isString, source: isAgentSource },
			{
				tools: isStringArray,
				spawns: spawns => spawns === "*" || isStringArray(spawns),
				model: isStringArray,
				thinkingLevel: isThinkingLevel,
				blocking: isBoolean,
				structured: isBoolean,
				autoloadSkills: isStringArray,
				readSummarize: isBoolean,
				prewalk: isBooleanOrString,
				advisor: isBooleanOrString,
				filePath: isString,
			},
		)
	);
}

function isWake(value: unknown): value is SpawnSpecWake {
	return (
		isRecord(value) &&
		hasShape(
			value,
			{ agent: isAgent },
			{
				index: isNumber,
				description: isString,
				modelOverride: override => isString(override) || isStringArray(override),
				modelRole: isString,
				parentToolCallId: isString,
				maxRuntimeMs: isNumber,
				completionProbe: isBoolean,
				softRequestBudget: isNumber,
				softRequestBudgetNotice: isBoolean,
				outputSchemaMode: isSchemaMode,
				outputSchemaSource: isSchemaSource,
				artifactsDir: isString,
			},
		)
	);
}

function isPrewalk(value: unknown): value is SpawnSpecPrewalk {
	return isRecord(value) && hasShape(value, { target: isString }, { thinkingLevel: isThinkingLevel });
}

const liveInputNames: ReadonlySet<string> = new Set(SPAWN_LIVE_INPUT_NAMES);

function isLiveInputName(name: string): name is SpawnLiveInputName {
	return liveInputNames.has(name);
}

/** The spawn spec `init` holds, each part checked by shape; see {@link SpawnSpecParts}. */
export function readSpawnSpec(init: PersistedSessionInit): SpawnSpecParts {
	const spec: unknown = init.spawnSpec;
	if (!isRecord(spec) || spec.v !== SPAWN_SPEC_VERSION) return { stored: false };
	const { model, perCallModel, thinkingLevel, thinkingLevelCeiling, prewalk, prompt, wake, liveInputs } = spec;
	const agentSystemPrompt = isRecord(prompt) ? prompt.agentSystemPrompt : undefined;
	return {
		stored: true,
		model: (model === null || isString(model)) && isBoolean(perCallModel) ? { model, perCallModel } : undefined,
		thinking:
			(thinkingLevel === null || isThinkingLevel(thinkingLevel)) &&
			(thinkingLevelCeiling === undefined || isEffort(thinkingLevelCeiling))
				? definedMembers({ thinkingLevel, thinkingLevelCeiling })
				: undefined,
		prewalk: isPrewalk(prewalk) ? prewalk : undefined,
		settings: isSettings(spec.settings) ? spec.settings : undefined,
		tools: isTools(spec.tools) ? spec.tools : undefined,
		policy: isPolicy(spec.policy) ? spec.policy : undefined,
		identity: isIdentity(spec.identity) ? spec.identity : undefined,
		prompt: isPrompt(prompt) ? prompt : undefined,
		wake:
			isWake(wake) && typeof agentSystemPrompt === "string"
				? { ...wake, agent: { ...wake.agent, systemPrompt: agentSystemPrompt } }
				: undefined,
		// A name this omp does not know is an input it does not have.
		liveInputs: isStringArray(liveInputs) ? liveInputs.filter(isLiveInputName) : undefined,
	};
}
