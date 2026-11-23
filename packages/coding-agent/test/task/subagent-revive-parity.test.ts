/**
 * A parked subagent revived warm, and then cold from the same stored session, is built with the same
 * session options, apart from the accepted differences listed below. Each route spawns a
 * real subagent on a scripted model, parks it, revives it warm, drops the warm reviver as a subagent
 * worker's exit does, and revives it cold through the persisted reviver factory; each option of the
 * spawn input inventory then has its own case, so a failure names the option.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { isIrcEnabled } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { buildWorkPoolOutputSchema } from "@oh-my-pi/pi-coding-agent/task/workpool-yield";
import { isRecord } from "@oh-my-pi/pi-utils";
import { localSession } from "../helpers/local-session";
import {
	CONTEXT_TEXT,
	fixtureAgent,
	LOOKUP_TOOL,
	type LiveParent,
	openReviveEnv,
	PREWALK_MODEL,
	type ParityRun,
	type RecordedRequest,
	type ReviveEnv,
	type RevivedSubagent,
	SPAWN_MODEL,
	SPAWN_TASK,
	type SpawnedSubagent,
	sessionInitRecords,
	spawnerOptions,
} from "./revive-harness";

const CHANGED_CONTEXT_TEXT = "Context fixture, changed while parked: report each row in two lines.";
/** An agent defined under the root's explicit extension root (`<root>/agents/*.md`) on the vibe-worker route. */
const EXPLICIT_ROOT_AGENT = "explicit-root-agent";
const VERDICT_SCHEMA = {
	type: "object",
	properties: { verdict: { type: "string" } },
	required: ["verdict"],
};

/**
 * The accepted differences between a warm and a cold revive: the only options in which the two may differ.
 * Only the first is an option of a revive's build that differs on these routes; the others name state the builds
 * do not compare, or values that differ only where live state changed since the spawn, which no route here changes.
 */
const ACCEPTED_DIFFERENCES = [
	"1. The dispatch guard (assertDispatchModel), which holds a per-call worker to its grants and an offline subagent to the active parent provider: the warm revive keeps the spawn's; the cold revive builds one against the grants and the provider as they are at the revive.",
	"2. Settings that the subagent wrote to its overlay during its run: the warm revive keeps them; the cold revive restores the overlay the spawn wrote.",
	"3. A family cache candidate that the parent stashed at spawn and that no request promoted yet (pendingCacheCandidate): the warm revive holds it in memory; the cold revive does not have it.",
	"4. On a later build, the IRC roster: the warm revive can keep the roster that the live prompt showed; the cold revive collects it again.",
	"5. A live input of a parent that is not live, and a discovery list whose contents changed on disk since the spawn and the root has not moved (difference 7).",
	"6. A custom tool that the cold revive cannot build again: both revives keep it in the tool list; on the cold revive a call to it answers that it is unavailable.",
	"8. The extension roots on a route whose spawner passes none (a vibe worker): the warm revive passes none; the cold revive passes the live parent's (the root's where the parent is not live) with an empty explicit list, so its task tool offers no agent of an explicit root.",
] as const;

/** Whether this run printed {@link ACCEPTED_DIFFERENCES}: the first comparison of the differing options prints them. */
let acceptedDifferencesPrinted = false;

/**
 * How one option of the two revives' builds is compared: `data`, plain data with every live object and
 * function replaced by an identity tag (same object or not); `flag`, a flag the session reads as false
 * when absent; `model`, the model by its exact identity; `prewalk`, the prewalk target by its exact
 * identity and its thinking level; `settings`, the overlay's own layers when the build was made and the
 * parent settings by identity; `session`, the reopened session by its file; `ref`, the claimed registry
 * ref by its id; `tools`, tools by name, label, description, parameters and load mode; `roots`, a provider
 * function by what it returns; `prompt`, the system prompt builder by its output on one default prompt
 * right after the revive; `accepted`, an accepted difference, named and not compared.
 */
type Compare =
	| "data"
	| "flag"
	| "model"
	| "prewalk"
	| "settings"
	| "session"
	| "ref"
	| "tools"
	| "roots"
	| "prompt"
	| "accepted";

/**
 * Every option of a subagent build, grouped by its class in the spawn input inventory. The type check fails
 * when `createAgentSession` gains an option this table does not class.
 */
const OPTION_COMPARES = {
	// Stored: the stored session's cwd, where its tools run, on every build.
	cwd: "data",
	// Stored for the spawn and a warm revive; held to the live process at a cold revive (accepted difference 7,
	// where live state changed since the spawn: no route here changes it).
	additionalDirectories: "data",
	credentialSourceSessionId: "data",
	// Stored in the spawn spec.
	model: "model",
	thinkingLevel: "data",
	thinkingLevelCeiling: "data",
	cacheWarming: "data",
	toolNames: "data",
	outputSchema: "data",
	outputSchemaMode: "data",
	restrictToolNames: "flag",
	requireYieldTool: "flag",
	noContextFiles: "flag",
	prewalk: "prewalk",
	spawns: "data",
	taskDepth: "data",
	parentTaskPrefix: "data",
	parentAgentId: "data",
	agentId: "data",
	agentDisplayName: "data",
	agentName: "data",
	enableLsp: "data",
	enableIrc: "data",
	skipPythonPreflight: "flag",
	enableMCP: "data",
	mountedToolNames: "data",
	// Replaced at a revive by the stored model.
	modelPattern: "data",
	modelPatternParentFallback: "data",
	modelPatternFallbackRole: "data",
	modelPatternDefaultFallbackChain: "data",
	// Derived from the stored per-call flag, and from offline mode.
	disableModelFallback: "flag",
	disableServerSideFallback: "flag",
	// Set at a cold revive only, to the cwd of the session its live inputs come from (the live parent, else the root)
	// where it is not the stored session's cwd, so a mask entry is only added: on no route here do the two differ.
	secretsProjectDirs: "data",
	// Set by no subagent build, so the SDK default holds on every path.
	additionalExtensionPaths: "data",
	advertiseHeadlessAsk: "data",
	agentDir: "data",
	agentRegistry: "data",
	allowRestrictedCustomTools: "data",
	allowSessionModelFallback: "data",
	appendSystemPrompt: "data",
	autoApprove: "data",
	autoTitle: "data",
	bindProcessState: "data",
	customSystemPrompt: "data",
	deadline: "data",
	deferRetryFallbackValidation: "data",
	deferHintCompression: "data",
	deferUsageReserveConfirmation: "data",
	deferredExtensionPaths: "data",
	deferredPrewalk: "data",
	eventBus: "data",
	extensions: "data",
	topLevelExtensions: "data",
	disableExtensionDiscovery: "data",
	interactivePrompts: "data",
	jobCaptionWriter: "data",
	jobWidgetAuthor: "data",
	lspReadOnly: "data",
	modelRole: "data",
	onPrewalkWarning: "data",
	openAIServiceTier: "data",
	planYolo: "data",
	preloadedExtensions: "data",
	providerPromptCacheKey: "data",
	providerPromptCacheKeySource: "data",
	providerSessionId: "data",
	rebindModelAfterDiscovery: "data",
	scopedModels: "data",
	scopedModelsFromSettings: "data",
	settingsApproval: "data",
	settingsManager: "data",
	slashCommands: "data",
	suppressAutoPrewalk: "data",
	systemPromptTemplate: "data",
	tanFork: "data",
	taskPromptCacheKey: "data",
	titleSystemPrompt: "data",
	tuiTranscript: "data",
	// Constants of every spawn.
	excludeAgentsMd: "flag",
	hasUI: "flag",
	// Live inputs of the process: the spawner's at the spawn and a warm revive, the live parent's at a cold revive.
	costGate: "data",
	authStorage: "data",
	modelRegistry: "data",
	getApiKey: "data",
	oauthAccountPools: "data",
	inheritedSessionAgents: "data",
	assertDispatchModel: "accepted",
	contextFiles: "data",
	skills: "data",
	promptTemplates: "data",
	workspaceTree: "data",
	rules: "data",
	extensionRoots: "roots",
	preloadedExtensionPaths: "data",
	preloadedPreparedExtensions: "data",
	preloadedCustomToolPaths: "data",
	subagentEventBus: "data",
	parentHindsightSessionState: "data",
	parentMnemopiSessionState: "data",
	asyncJobManager: "data",
	mcpManager: "data",
	localProtocolOptions: "data",
	telemetry: "data",
	mcpTools: "tools",
	mcpToolScope: "data",
	sessionManager: "session",
	expectedAgentRef: "ref",
	// Stored descriptors, built over the live parent's eval kernel.
	customTools: "tools",
	// Stored layers over the live parent settings.
	settings: "settings",
	// Stored prompt inputs, the held base prompt and the live default blocks.
	systemPrompt: "prompt",
	// Passed by the spawn's first build only.
	resolveServiceTierByFamily: "data",
	onFirstChatDispatch: "data",
	awaitingAssignment: "flag",
} satisfies Record<keyof CreateAgentSessionOptions, Compare>;

type OptionName = keyof typeof OPTION_COMPARES;

const OPTION_NAMES = Object.keys(OPTION_COMPARES) as OptionName[];
const POLICY_OPTIONS = [
	"cwd",
	"additionalDirectories",
	"credentialSourceSessionId",
	"noContextFiles",
	"enableLsp",
	"cacheWarming",
	"enableIrc",
	"enableMCP",
	"skipPythonPreflight",
	"spawns",
	"taskDepth",
] as const;
const IDENTITY_OPTIONS = ["agentId", "agentName", "agentDisplayName", "parentAgentId", "parentTaskPrefix"] as const;
const TOOL_OPTIONS = [
	"toolNames",
	"restrictToolNames",
	"requireYieldTool",
	"outputSchemaMode",
	"outputSchema",
] as const;
const STORED_OPTION_GROUPS = [
	["policy", POLICY_OPTIONS],
	["identity", IDENTITY_OPTIONS],
	["tools", TOOL_OPTIONS],
] as const;
const DISCOVERY_OPTIONS = ["contextFiles", "skills", "rules", "promptTemplates", "workspaceTree"] as const;

type Tags = Map<object, string>;

function tag(value: object, tags: Tags): string {
	let name = tags.get(value);
	if (!name) {
		name = `live object ${tags.size + 1}`;
		tags.set(value, name);
	}
	return name;
}

function isPlainData(value: object): boolean {
	if (Array.isArray(value)) return true;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** `value` with every live object and function replaced by an identity tag that both revives share. */
function normalized(value: unknown, tags: Tags, seen = new Set<object>()): unknown {
	if (typeof value === "function") return tag(value, tags);
	if (typeof value !== "object" || value === null) return value;
	if (!isPlainData(value) || seen.has(value)) return tag(value, tags);
	seen.add(value);
	if (Array.isArray(value)) return value.map(item => normalized(item, tags, seen));
	const members = Object.entries(value).filter(([, member]) => member !== undefined);
	return Object.fromEntries(members.map(([key, member]) => [key, normalized(member, tags, seen)]));
}

function toolShapes(tools: unknown, tags: Tags): unknown {
	if (!Array.isArray(tools)) return normalized(tools, tags);
	const shapes = tools.map(tool => {
		if (!isRecord(tool)) return tool;
		const { name, label, description, parameters, loadMode } = tool;
		return { name, label, description, parameters, loadMode };
	});
	return normalized(shapes, tags);
}

function optionValue(revived: RevivedSubagent, option: OptionName, compare: Compare, tags: Tags): unknown {
	const options = revived.build.options;
	switch (compare) {
		case "data":
			return normalized(options[option], tags);
		case "flag":
			return options[option] ?? false;
		case "model":
			return options.model ? formatModelStringWithRouting(options.model) : undefined;
		case "prewalk": {
			const prewalk = options.prewalk;
			if (!prewalk) return undefined;
			return { target: formatModelStringWithRouting(prewalk.target), thinkingLevel: prewalk.thinkingLevel };
		}
		case "settings":
			return {
				layers: normalized(revived.build.settingsLayers, tags),
				parent: normalized(options.settings?.overlayParent(), tags),
			};
		case "session":
			return options.sessionManager?.getSessionFile();
		case "ref":
			return options.expectedAgentRef === null ? null : options.expectedAgentRef?.id;
		case "tools":
			return toolShapes(options[option], tags);
		case "roots":
			return normalized(options.extensionRoots?.(), tags);
		case "prompt":
			return normalized(revived.prompt, tags);
		case "accepted":
			return undefined;
	}
}

/** One option of the warm and the cold revive's builds, each normalized with the same identity tags. */
function compareOption(run: ParityRun, option: OptionName): { warm: unknown; cold: unknown } {
	const tags: Tags = new Map();
	const compare: Compare = OPTION_COMPARES[option];
	const warm = optionValue(run.warm, option, compare, tags);
	const cold = optionValue(run.cold, option, compare, tags);
	return { warm, cold };
}

function json(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function part(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

interface ParityRoute {
	readonly title: string;
	readonly settings?: Readonly<Record<string, unknown>>;
	readonly yieldArguments?: Record<string, unknown>;
	options(env: ReviveEnv, root: LiveParent): Promise<ExecutorOptions> | ExecutorOptions;
	/** The root's extension roots, where the route needs other than the default (none explicit, merge). */
	readonly roots?: (env: ReviveEnv) => Promise<EffectiveExtensionRoots>;
	/** Runs on the spawned subagent before its first park; returns it with the last request it sent by then. */
	readonly beforePark?: (env: ReviveEnv, spawned: SpawnedSubagent) => Promise<SpawnedSubagent>;
	/**
	 * An accepted difference this route's revives show: its options are not compared, and `check` asserts what each
	 * revive passes there.
	 */
	readonly accepted?: {
		readonly title: string;
		readonly options: readonly OptionName[];
		check(run: ParityRun, root: LiveParent): Promise<void>;
	};
}

const ROUTES: ParityRoute[] = [
	{
		title: "a task subagent with an effort hint, a runtime limit, a spawn allowlist and IRC off",
		settings: { "task.maxRuntimeMs": 120_000 },
		options: (env, root) => ({
			...spawnerOptions(root.toolSession),
			...env.subagentInputs("EffortHint", fixtureAgent({ spawns: ["explore"] })),
			effort: "lo",
			maxRuntimeMs: 120_000,
			enableIrc: false,
			parentToolCallId: "call-effort-hint",
			context: "Shared background of the batch.",
		}),
	},
	{
		title: "a task subagent with an output schema",
		yieldArguments: { type: "result", data: { verdict: "done" } },
		options: (env, root) => ({
			...spawnerOptions(root.toolSession),
			...env.subagentInputs("OutputSchema"),
			outputSchema: VERDICT_SCHEMA,
			outputSchemaMode: "strict",
			outputSchemaSource: "caller",
			outputSchemaOverridesAgent: true,
			parentToolCallId: "call-output-schema",
		}),
	},
	{
		title: "a plan-mode subagent with a restricted contract",
		options: (env, root) => ({
			...spawnerOptions(root.toolSession, true),
			...env.subagentInputs("PlanMode", fixtureAgent({ tools: ["read", "grep", "yield"] })),
			parentToolCallId: "call-plan-mode",
		}),
	},
	{
		title: "a task subagent with prewalk armed and not yet spent",
		options: (env, root) => ({
			...spawnerOptions(root.toolSession),
			...env.subagentInputs("PrewalkArmed", fixtureAgent({ prewalk: PREWALK_MODEL })),
			parentToolCallId: "call-prewalk",
		}),
	},
	{
		title: "a per-call worker",
		options: (env, root) => ({
			...spawnerOptions(root.toolSession),
			...env.subagentInputs("PerCall"),
			parentActiveModelPattern: SPAWN_MODEL,
			perCallModelGrants: {
				settings: root.toolSession.settings,
				agentName: "task",
				agentSource: "bundled",
				parentModelPattern: SPAWN_MODEL,
			},
			parentToolCallId: "call-per-call",
		}),
	},
	{
		title: "an eval agent() call with one custom tool, revived while its parent and kernel are live",
		options: (env, root) => {
			env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
			return {
				...spawnerOptions(root.toolSession),
				...env.subagentInputs("EvalAgent"),
				description: "lookup rows",
				customTools: createEvalCustomTools(root.toolSession, [LOOKUP_TOOL]),
			};
		},
	},
	{
		title: "an eval work-pool agent with yield items",
		yieldArguments: { key: 1, data: "row-a checked" },
		options: (env, root) => {
			const items = [{ id: "row-a", index: 1 }];
			return {
				...spawnerOptions(root.toolSession),
				...env.subagentInputs("WorkPool"),
				context: "Rows of this batch: row-a.",
				outputSchema: buildWorkPoolOutputSchema(items),
				outputSchemaMode: "strict",
				outputSchemaSource: "caller",
				workPoolYieldItems: items,
				enableIrc: isIrcEnabled(root.toolSession.settings, 0),
			};
		},
		// The pool clears a finished batch's items (task/workpool.ts) and its worker makes a call before it parks.
		beforePark: async (env, spawned) => {
			const session = localSession(AgentRegistry.global().get(spawned.id)?.session);
			await session.setWorkPoolYieldItems([]);
			await env.wake(session, spawned.id);
			const lastRequest = env.requests.at(-1);
			if (!lastRequest) throw new Error(`${spawned.id} sent no request after its batch`);
			return { ...spawned, lastRequest };
		},
	},
	{
		title: "a vibe worker",
		// The root's explicit extension root holds an agent (`<root>/agents/*.md`) its own spawns can name.
		roots: async env => {
			const explicitRoot = path.join(env.root, "explicit-root");
			await Bun.write(
				path.join(explicitRoot, "agents", `${EXPLICIT_ROOT_AGENT}.md`),
				`---\nname: ${EXPLICIT_ROOT_AGENT}\ndescription: Agent of the root's explicit extension root.\n---\n\nCheck the rows.\n`,
			);
			return { explicit: [explicitRoot], mode: "merge", configured: [], configuredLevel: "user" };
		},
		options: (env, root) => {
			const sonic = getBundledAgent("sonic");
			if (!sonic) throw new Error("Expected the bundled sonic agent");
			// A worker that may spawn, so its task tool lists the agents its extension roots discover.
			const agent = { ...sonic, spawns: "*" as const };
			// `vibe/runtime.ts` passes no extension roots, directories, credential source or MCP flag.
			return {
				...spawnerOptions(root.toolSession),
				...env.subagentInputs("VibeWorker", agent),
				additionalDirectories: undefined,
				credentialSourceSessionId: undefined,
				extensionRoots: undefined,
				enableMCP: undefined,
				restrictToolNames: undefined,
				assignment: SPAWN_TASK,
				description: "vibe fast session",
				detached: true,
				parentActiveModelPattern: SPAWN_MODEL,
				keepAlive: true,
			};
		},
		accepted: {
			title: "accepted difference 8: the warm revive passes no extension roots, and the cold revive the live parent's without their explicit list, so its task tool does not offer the explicit root's agent",
			options: ["extensionRoots"],
			check: async (run, root) => {
				const cwd = run.cold.build.options.cwd;
				if (cwd === undefined) throw new Error("The cold revive passed no cwd");
				const underRootRoots = await discoverAgents(cwd, undefined, root.toolSession.effectiveExtensionRoots?.());
				const coldTask = run.cold.session.getToolByName("task")?.description;
				expect({
					warm: run.warm.build.options.extensionRoots?.(),
					cold: run.cold.build.options.extensionRoots?.(),
					rootRootsOffer: underRootRoots.agents.some(agent => agent.name === EXPLICIT_ROOT_AGENT),
					coldHasTask: coldTask !== undefined,
					coldOffers: coldTask?.includes(EXPLICIT_ROOT_AGENT),
				}).toEqual({
					warm: undefined,
					// The root's roots (merge, no configured list) without the explicit root.
					cold: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
					rootRootsOffer: true,
					coldHasTask: true,
					coldOffers: false,
				});
			},
		},
	},
	{
		title: "a nested subagent whose parent is live",
		options: async (env, root) => {
			await env.spawn({ ...spawnerOptions(root.toolSession), ...env.subagentInputs("NestParent") });
			// The parent stays live. Its own tool session, captured through a call-through spy on `createTools`
			// (the base exposes no accessor for it), is what spawns it makes read.
			const parent = env.toolSessionOf("NestParent");
			return { ...spawnerOptions(parent), ...env.subagentInputs("NestChild") };
		},
	},
];

function defineRouteCases(result: () => ParityRun, accepted: readonly OptionName[] = []): void {
	const compared = (option: OptionName): boolean =>
		OPTION_COMPARES[option] !== "accepted" && !accepted.includes(option);
	for (const option of OPTION_NAMES) {
		if (!compared(option)) continue;
		it(`the cold revive is built with the warm revive's ${option}`, () => {
			const { warm, cold } = compareOption(result(), option);
			expect(cold).toEqual(warm);
		}, 30_000);
	}

	// The spec the warm revive holds is not readable through any seam the base has, so the spec read back
	// from the file is compared with what the warm revive builds from: its `createAgentSession` options.
	it("the spawn's session_init holds the spec, and the spec read back from the file equals the warm revive's", async () => {
		const { spawned, warm } = result();
		const [record] = await sessionInitRecords(spawned.sessionFile);
		const spec = part(record?.spawnSpec);
		expect(spec.v).toBe(1);
		const options = warm.build.options;
		expect(spec.model).toBe(options.model ? formatModelStringWithRouting(options.model) : null);
		expect(spec.thinkingLevel).toBe(options.thinkingLevel ?? null);
		expect(spec.thinkingLevelCeiling).toBe(options.thinkingLevelCeiling);
		const prewalk = options.prewalk;
		if (prewalk) {
			const target = formatModelStringWithRouting(prewalk.target);
			expect(spec.prewalk).toEqual(json({ target, thinkingLevel: prewalk.thinkingLevel }));
		} else {
			expect(spec.prewalk).toBeUndefined();
		}
		for (const [group, keys] of STORED_OPTION_GROUPS) {
			const stored = part(spec[group]);
			for (const key of keys) expect([group, key, stored[key]]).toEqual([group, key, json(options[key])]);
		}
		const storedTools = part(spec.tools).customTools;
		const storedShapes = (Array.isArray(storedTools) ? storedTools : []).map(tool => {
			const { name, description, parameters } = part(tool);
			return { name, description, parameters };
		});
		const warmShapes = (options.customTools ?? []).map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: json(tool.parameters),
		}));
		expect(storedShapes).toEqual(warmShapes);
		expect(part(spec.settings).layers).toEqual(json(warm.build.settingsLayers));
	}, 30_000);

	it("the first request after the warm revive carries the held base prompt and the last tool list before the park", () => {
		const { spawned, warmRequest } = result();
		expect(warmRequest.system).toEqual(spawned.lastRequest.system);
		expect(warmRequest.tools).toBe(spawned.lastRequest.tools);
	}, 30_000);

	it("the first request after the cold revive carries the held base prompt and the last tool list before the park", () => {
		const { warmLastRequest, coldRequest } = result();
		expect(coldRequest.system).toEqual(warmLastRequest.system);
		expect(coldRequest.tools).toBe(warmLastRequest.tools);
	}, 30_000);

	it("with the parent live, both revives receive equal context files, skills, rules, prompt templates and workspace tree", () => {
		const run = result();
		for (const option of DISCOVERY_OPTIONS) {
			const { warm, cold } = compareOption(run, option);
			const empty = warm === undefined || (Array.isArray(warm) && warm.length === 0);
			expect([option, empty]).toEqual([option, false]);
			expect([option, cold]).toEqual([option, warm]);
		}
	}, 30_000);

	it("the options that differ are exactly the accepted differences", () => {
		if (!acceptedDifferencesPrinted) {
			acceptedDifferencesPrinted = true;
			console.log(["Accepted differences between a warm and a cold revive:", ...ACCEPTED_DIFFERENCES].join("\n"));
		}
		const run = result();
		const differing = OPTION_NAMES.filter(option => {
			if (!compared(option)) return false;
			const { warm, cold } = compareOption(run, option);
			return !Bun.deepEquals(cold, warm);
		});
		expect(differing).toEqual([]);
	}, 30_000);

	it("on a route that changes no live state, maxRuntimeMs and softRequestBudget are equal on both revives", () => {
		// The wake-turn monitor's limits, which no build option carries: the cold revive holds them to the live
		// settings (accepted difference 7), which no route here changes since the spawn.
		const { warm, cold } = result();
		const wakeLimits = (revived: RevivedSubagent) => {
			if (!revived.wake) throw new Error("The revive attached no wake-turn monitor");
			return { maxRuntimeMs: revived.wake.maxRuntimeMs, softRequestBudget: revived.wake.softRequestBudget };
		};
		expect(wakeLimits(cold)).toEqual(wakeLimits(warm));
	}, 30_000);
}

for (const route of ROUTES) {
	describe(`warm and cold revives of ${route.title}`, () => {
		let env: ReviveEnv | undefined;
		let root: LiveParent | undefined;
		let run: ParityRun | undefined;
		const ran = (): ParityRun => {
			if (!run) throw new Error(`The route "${route.title}" did not run`);
			return run;
		};

		beforeAll(async () => {
			const opened = await openReviveEnv(route.settings);
			env = opened;
			if (route.yieldArguments) opened.turns = { yieldArguments: route.yieldArguments };
			root = opened.createLiveParent(undefined, undefined, await route.roots?.(opened));
			const options = await route.options(opened, root);
			const { beforePark } = route;
			run = await opened.runParity(root, options, beforePark && (spawned => beforePark(opened, spawned)));
		}, 60_000);

		afterAll(async () => {
			await env?.close();
		}, 30_000);

		defineRouteCases(ran, route.accepted?.options);

		const { accepted } = route;
		if (accepted) {
			it(
				accepted.title,
				async () => {
					if (!root) throw new Error(`The route "${route.title}" did not run`);
					await accepted.check(ran(), root);
				},
				30_000,
			);
		}
	});
}

describe("a default prompt block changed while the subagent was parked", () => {
	const id = "PromptChanged";
	let env: ReviveEnv | undefined;
	let spawned: SpawnedSubagent | undefined;
	let warmRequest: RecordedRequest | undefined;
	let warmLastRequest: RecordedRequest | undefined;
	let coldRequest: RecordedRequest | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.installColdReviver(root);
		spawned = await env.spawn({
			...spawnerOptions(root.toolSession),
			...env.subagentInputs(id),
			enableIrc: false,
		});
		await env.park(id);
		// The test seam: the context file the default prompt renders changes in the live parent's list.
		const [contextFile] = env.fixtures.contextFiles;
		if (contextFile) contextFile.content = CHANGED_CONTEXT_TEXT;
		const warm = await env.revive(id);
		warmRequest = await env.wake(warm.session, id);
		warmLastRequest = env.requests.at(-1);
		await env.park(id);
		env.dropWarmReviver(id);
		const cold = await env.revive(id);
		coldRequest = await env.wake(cold.session, id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the first request after the warm revive still carries the held base prompt", () => {
		expect(spawned?.lastRequest.system.join("\n")).toContain(CONTEXT_TEXT);
		expect(warmRequest?.system).toEqual(spawned?.lastRequest.system);
	}, 30_000);

	it("the first request after the cold revive still carries the held base prompt", () => {
		expect(coldRequest?.system).toEqual(warmLastRequest?.system);
	}, 30_000);
});

describe("builds after the first model call of a revive", () => {
	const id = "PromptRebuild";
	let env: ReviveEnv | undefined;
	let warmFirst: RecordedRequest | undefined;
	let warmRebuilt: RecordedRequest | undefined;
	let coldRebuilt: RecordedRequest | undefined;
	let records: Array<Record<string, unknown>> = [];

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.installColdReviver(root);
		const spawned = await env.spawn({
			...spawnerOptions(root.toolSession),
			...env.subagentInputs(id),
			enableIrc: false,
		});
		await env.park(id);
		const warm = await env.revive(id);
		warmFirst = await env.wake(warm.session, id);
		await env.setMcpTools(warm.session, ["first"]);
		warmRebuilt = await env.wake(warm.session, id);
		// A second build before the park: the base the parked session last sent then differs from the one the
		// comparison renders, so a cold revive that only replays the newest stored base cannot pass.
		await env.setMcpTools(warm.session, ["first", "second"]);
		await env.wake(warm.session, id);
		await env.park(id);
		env.mcp.setFixtureTools([]);
		env.dropWarmReviver(id);
		const cold = await env.revive(id);
		await env.wake(cold.session, id);
		await env.setMcpTools(cold.session, ["first"]);
		coldRebuilt = await env.wake(cold.session, id);
		records = await sessionInitRecords(spawned.sessionFile);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("after a later build (an MCP tool added), both revives send equal prompts rendered from the spawn's prompt inputs", () => {
		expect(warmRebuilt?.system).not.toEqual(warmFirst?.system);
		expect(coldRebuilt?.system).toEqual(warmRebuilt?.system);
	}, 30_000);

	it("after a model call that changes the base prompt, the newest session_init holds the same spec", () => {
		const [first] = records;
		const newest = records.at(-1);
		expect(newest?.systemPrompt).not.toEqual(first?.systemPrompt);
		expect(part(first?.spawnSpec).v).toBe(1);
		expect(newest?.spawnSpec).toEqual(first?.spawnSpec);
	}, 30_000);
});
