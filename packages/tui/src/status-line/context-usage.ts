import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool as AiTool, Model } from "@oh-my-pi/pi-ai";
import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { stripSchemaDescriptions, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

interface ContextSkill {
	readonly name: string;
	readonly description?: string;
	readonly hide?: boolean;
}

type ContextTool = Pick<AiTool, "name" | "description" | "parameters" | "examples">;

/** Savings computed by the host's inline-image planner, not by the renderer. */
export interface ContextSavingsEstimate {
	visionCapable: boolean;
	systemPrompt?: {
		applied: boolean;
		reason?: "empty" | "margin" | "budget";
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
		scope: "agents-md" | "all";
	};
	toolResults?: {
		total: number;
		swapped: number;
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
	};
	savedTokens: number;
}

/** Real sessions satisfy this view without wrapping or copying their state. */
export interface ContextUsageSession extends NonMessageTokenSource {
	readonly model: Model | undefined;
	readonly agent: {
		readonly tokenizer: Tokenizer;
		readonly state?: { readonly tools?: readonly ContextTool[] };
	};
	readonly messages?: AgentMessage[];
	getContextBreakdown?():
		| {
				messagesTokens: number;
				skillsTokens: number;
				systemToolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
				usedTokens: number;
		  }
		| undefined;
}

export interface ContextUsageOptions {
	compaction: CompactionSettings;
	sourceRevision?: number;
	skillful?: boolean;
	snapcompact?: ContextSavingsEstimate;
}

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Where auto-compaction fires, in tokens; undefined when compaction is off. */
	thresholdTokens?: number;
	/** Estimated snapcompact wire savings; set when requested and a snapcompact.* setting is enabled. */
	snapcompact?: ContextSavingsEstimate;
}

/** Percent positions (0–100 of the context window) for the auto-compaction boundaries. */
export interface CompactionBoundaries {
	/** Where auto-compaction fires. */
	thresholdPercent: number;
	/**
	 * Where the background speculative summarizer starts (threshold − lead), or
	 * `null` when no speculation will run (async compaction disabled, or the
	 * first available method is local — snapcompact/shake — and thus instant).
	 */
	speculationPercent: number | null;
}

/**
 * Boundary positions for the status line's annotated context gauge. `null`
 * when compaction is disabled/off or the window is unknown — the gauge then
 * renders without markers. The host supplies a lead only when its configured
 * method and async policy allow speculative compaction.
 */
export function computeCompactionBoundaries(
	compactionSettings: CompactionSettings,
	contextWindow: number,
	speculationLeadTokens?: number,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	if (!compactionSettings.enabled || compactionSettings.strategy === "off") return null;
	const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
	if (!(thresholdTokens > 0) || thresholdTokens > contextWindow) return null;
	return {
		thresholdPercent: (thresholdTokens / contextWindow) * 100,
		speculationPercent:
			speculationLeadTokens === undefined
				? null
				: (Math.max(0, thresholdTokens - speculationLeadTokens) / contextWindow) * 100,
	};
}

/** An agent's tool roster and the tool definitions its next request declares (`Agent`). */
export interface ToolDeclarationSource {
	readonly state?: {
		readonly tools?: readonly ContextTool[];
	};
	/**
	 * Whether requests to `model` ship description-stripped tool specs because
	 * the catalog rides in the system prompt (`Agent.prunesToolDescriptions`).
	 */
	prunesToolDescriptions?(model: Model | undefined): boolean;
	/**
	 * The tools the next request to `model` declares (`Agent.declaredTools`): the
	 * roster (the `state.tools` array itself when the request declares nothing
	 * else) and, on a provider that keeps its tool declaration across a
	 * conversation, each tool taken off the roster that the request still
	 * declares, as it was last sent.
	 */
	declaredTools?(model: Model | undefined): readonly ContextTool[];
}

/** Stable inputs used to cache non-message token estimates. */
export interface NonMessageTokenSource {
	readonly model?: Model;
	readonly systemPrompt?: readonly string[];
	readonly agent?: ToolDeclarationSource;
	readonly skills?: readonly ContextSkill[];
	/** Provider-facing, session-frozen descriptions when available. */
	readonly renderedSkills?: readonly ContextSkill[];
}

/** Shared empty system-prompt part list, avoiding an allocation per render. */
export const EMPTY_STRING_PARTS: string[] = [];
const EMPTY_TOOLS: readonly ContextTool[] = [];
const EMPTY_SKILLS: readonly ContextSkill[] = [];

/**
 * Skills actually rendered into the system prompt, mirroring the filter in
 * `buildSystemPrompt` (`system-prompt.ts`): the `read` tool must be present so
 * the model can fetch skill content, and skills with frontmatter `hide: true`
 * (or `disable-model-invocation`, normalized onto `hide`) are excluded.
 * Accounting must count only these so the Skills category and the System-prompt
 * subtraction stay aligned with the provider-facing prompt.
 */
function renderedSkills(skills: readonly ContextSkill[], tools: readonly ContextTool[]): readonly ContextSkill[] {
	if (!tools.some(tool => tool.name === "read")) return EMPTY_SKILLS;
	return skills.filter(skill => skill.hide !== true);
}

export function estimateSkillsTokens(skills: readonly ContextSkill[], tokenizer: Tokenizer): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description ?? "");
	}
	return tokenizer.countTokens(fragments);
}

type ToolSchemaSource = readonly ContextTool[];

interface ToolSchemaTokenCache {
	revision: number;
	byTokenizer: WeakMap<
		Tokenizer,
		{ revision: number; sourceRevision: number; pruneDescriptions: boolean; tokens: number }
	>;
}

/**
 * Per-roster metadata revisions and token estimates. Tool arrays are
 * caller-owned and may be frozen, so a WeakMap is the only safe place to keep
 * cache state without changing their observable shape.
 */
const TOOL_SCHEMA_TOKEN_CACHE = new WeakMap<ToolSchemaSource, ToolSchemaTokenCache>();

function toolSchemaTokenCache(tools: ToolSchemaSource): ToolSchemaTokenCache {
	let cache = TOOL_SCHEMA_TOKEN_CACHE.get(tools);
	if (!cache) {
		cache = { revision: 0, byTokenizer: new WeakMap() };
		TOOL_SCHEMA_TOKEN_CACHE.set(tools, cache);
	}
	return cache;
}

/**
 * Current dynamic metadata revision for one tool roster.
 *
 * Consumers caching a larger context breakdown must key on both the tools
 * array identity and this revision. Array replacement covers roster changes;
 * {@link invalidateToolSchemaMetadata} covers live description/schema changes
 * while the roster object remains stable.
 */
export function getToolSchemaMetadataRevision(tools: ToolSchemaSource): number {
	return TOOL_SCHEMA_TOKEN_CACHE.get(tools)?.revision ?? 0;
}

/**
 * Invalidate token estimates after a live tool description or parameter schema
 * can change without replacing the tools array (settings, model, policy, or
 * discovered-agent metadata changes).
 */
export function invalidateToolSchemaMetadata(tools: ToolSchemaSource): void {
	toolSchemaTokenCache(tools).revision++;
}

/** Provider-visible text of one tool definition, in wire order. */
export interface ToolSchemaFragments {
	/** Name, description, wire schema JSON, then rendered examples; fields that cannot be serialized are omitted. */
	readonly fragments: string[];
	/** `fragments` with the schema JSON indented for reading; present only when a display indent was requested. */
	readonly display?: string[];
	/** Why serialization stopped; the schema or examples after that point are missing from `fragments`. */
	readonly schemaError?: string;
}

/** How {@link toolSchemaFragments} renders one tool definition. */
export interface ToolSchemaFragmentOptions {
	/** Also return `display`: the same fragments with the schema JSON indented by this many spaces. */
	displayIndent?: number;
	/**
	 * Mirror `normalizeTools({ pruneDescriptions: true })`: the wire spec is the
	 * name plus the description-stripped schema, with no description or examples.
	 */
	pruneDescriptions?: boolean;
}

/**
 * Provider-visible text of one tool definition. `displayIndent` additionally
 * returns `display`, the same fragments with the schema JSON indented, from
 * the same schema conversion.
 */
export function toolSchemaFragments(tool: ContextTool, options: ToolSchemaFragmentOptions = {}): ToolSchemaFragments {
	const { displayIndent, pruneDescriptions = false } = options;
	// Extension-supplied tools may carry a non-string name/description or a
	// parameters value whose wire schema stringifies to `undefined` (e.g. a
	// callable schema that escaped normalization). A non-string fragment is
	// fatal inside the native tokenizer, so only real strings are kept.
	const { name, description, parameters } = tool;
	const fragments: string[] = [];
	const display: string[] | undefined = displayIndent === undefined ? undefined : [];
	const push = (wire: string, shown: string = wire): void => {
		fragments.push(wire);
		display?.push(shown);
	};
	if (typeof name === "string") push(name);
	if (!pruneDescriptions && typeof description === "string") push(description);
	try {
		const wireTool: AiTool = {
			name,
			description,
			parameters: parameters as AiTool["parameters"],
			examples: tool.examples,
		};
		const fullSchema = toolWireSchema(wireTool) ?? {};
		const wireSchema = pruneDescriptions ? stripSchemaDescriptions(fullSchema) : fullSchema;
		const wireJson = JSON.stringify(wireSchema);
		if (typeof wireJson === "string")
			push(wireJson, display ? JSON.stringify(wireSchema, null, displayIndent) : wireJson);
		// The agent loop appends rendered examples to the wire description,
		// which pruning empties.
		const examplesBlock = pruneDescriptions ? undefined : renderToolExamples(wireTool);
		if (examplesBlock) push(examplesBlock);
	} catch (error) {
		// Schema may contain functions or cycles.
		return { fragments, display, schemaError: error instanceof Error ? error.message : String(error) };
	}
	return { fragments, display };
}

/** Inputs that select which tool-schema estimate applies, beyond the roster and tokenizer. */
export interface ToolSchemaEstimateOptions {
	/** Caller settings/source revision; a change invalidates the cached estimate. */
	sourceRevision?: number;
	/** Count the description-stripped specs sent when the catalog rides in the system prompt. */
	pruneDescriptions?: boolean;
}

/**
 * Estimate provider-visible tool-schema tokens.
 *
 * Results are cached by roster-array identity, tokenizer identity, the
 * caller-supplied settings/source revision, the prune mode, and the roster's
 * explicit dynamic metadata revision. Callers whose descriptions or schemas are
 * live getters must either advance `sourceRevision` or call
 * {@link invalidateToolSchemaMetadata} when those inputs change.
 */
export function estimateToolSchemaTokens(
	tools: ToolSchemaSource,
	tokenizer: Tokenizer,
	options: ToolSchemaEstimateOptions = {},
): number {
	const { sourceRevision = 0, pruneDescriptions = false } = options;
	const cache = toolSchemaTokenCache(tools);
	const cached = cache.byTokenizer.get(tokenizer);
	if (
		cached?.revision === cache.revision &&
		cached.sourceRevision === sourceRevision &&
		cached.pruneDescriptions === pruneDescriptions
	)
		return cached.tokens;

	const fragments = tools.flatMap(tool => toolSchemaFragments(tool, { pruneDescriptions }).fragments);
	const tokens = tokenizer.countTokens(fragments);
	cache.byTokenizer.set(tokenizer, { revision: cache.revision, sourceRevision, pruneDescriptions, tokens });
	return tokens;
}

/** What {@link withdrawnToolDefinitions} took from one declared list: the roster it filtered by and the result. */
interface WithdrawnToolDefinitions {
	tools: ToolSchemaSource;
	withdrawn: readonly ContextTool[];
}

/**
 * Per declared list ({@link ToolDeclarationSource.declaredTools}), the withdrawn
 * definitions last taken from it. An agent gives the same list until its
 * tools, its declaration or its sent definitions change, so a repeated call
 * compares references only. Lists are caller-owned, so a WeakMap keeps the
 * state off them.
 */
const WITHDRAWN_TOOL_DEFINITIONS = new WeakMap<readonly ContextTool[], WithdrawnToolDefinitions>();

/**
 * The definitions the next request to `model` declares for tools not on
 * `tools`, `agent`'s roster: on a provider that keeps its tool declaration
 * across a conversation, a tool taken off the roster goes out with every
 * request, as it was last sent. Converts no schema, so a cyclic one cannot throw here.
 */
function withdrawnToolDefinitions(
	agent: ToolDeclarationSource | undefined,
	tools: ToolSchemaSource,
	model: Model | undefined,
): readonly ContextTool[] {
	const declared = agent?.declaredTools?.(model);
	if (!declared || declared === tools) return EMPTY_TOOLS;
	const cached = WITHDRAWN_TOOL_DEFINITIONS.get(declared);
	if (cached?.tools === tools) return cached.withdrawn;
	const active = new Set(tools.map(tool => tool.name));
	const filtered = declared.filter(tool => !active.has(tool.name));
	const withdrawn = filtered.length > 0 ? filtered : EMPTY_TOOLS;
	WITHDRAWN_TOOL_DEFINITIONS.set(declared, { tools, withdrawn });
	return withdrawn;
}

/**
 * Whether two lists of definitions carry the same names, descriptions and
 * schemas in the same order. A declared list is built again each time the
 * agent's tools, its declaration or its sent definitions change (a deferred
 * tool as a copy), so lists of two builds compare by field, not by object.
 */
function sameToolDefinitions(left: readonly ContextTool[], right: readonly ContextTool[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const a = left[index];
		const b = right[index];
		if (a?.name !== b?.name || a?.description !== b?.description || a?.parameters !== b?.parameters) return false;
	}
	return true;
}

/** What {@link withdrawnToolTokens} counted for one agent: the withdrawn definitions and the tokenizer. */
interface WithdrawnToolTokens {
	definitions: readonly ContextTool[];
	tokenizer: Tokenizer;
	tokens: number;
}

/**
 * Per agent, the last count of the withdrawn tools its declaration still sends.
 * Agents are caller-owned, so a WeakMap keeps the state off them.
 */
const WITHDRAWN_TOOL_TOKENS = new WeakMap<ToolDeclarationSource, WithdrawnToolTokens>();

/**
 * Tokens of `definitions`, the withdrawn tools `agent`'s next request still
 * declares ({@link withdrawnToolDefinitions}), each as it was sent. Counted
 * again only when those definitions or the tokenizer change.
 */
function withdrawnToolTokens(
	agent: ToolDeclarationSource,
	definitions: readonly ContextTool[],
	tokenizer: Tokenizer,
): number {
	if (definitions.length === 0) return 0;
	const cached = WITHDRAWN_TOOL_TOKENS.get(agent);
	if (cached?.tokenizer === tokenizer && sameToolDefinitions(cached.definitions, definitions)) return cached.tokens;
	// A sent description already carries the rendered examples, so they are not rendered again.
	const fragments = definitions.flatMap(
		({ name, description, parameters }) => toolSchemaFragments({ name, description, parameters }).fragments,
	);
	const tokens = tokenizer.countTokens(fragments);
	WITHDRAWN_TOOL_TOKENS.set(agent, { definitions, tokenizer, tokens });
	return tokens;
}

/**
 * Count the tool definitions the next request to `model` carries in context:
 * `agent`'s roster, as {@link estimateToolSchemaTokens} counts and caches it,
 * description-stripped where `agent` prunes the descriptions it sends
 * ({@link ToolDeclarationSource.prunesToolDescriptions}), and each withdrawn
 * tool a kept declaration still sends ({@link ToolDeclarationSource.declaredTools}),
 * counted from its sent definition, again only when those definitions change.
 * A server-side deferred catalog counts nothing.
 */
export function estimateContextToolSchemaTokens(
	agent: ToolDeclarationSource | undefined,
	tokenizer: Tokenizer,
	model: Model | undefined,
	options: Pick<ToolSchemaEstimateOptions, "sourceRevision"> = {},
): number {
	if (model?.toolSchemasInContext === false) return 0;
	const tools = agent?.state?.tools ?? EMPTY_TOOLS;
	return declaredToolSchemaTokens(agent, tools, withdrawnToolDefinitions(agent, tools, model), tokenizer, model, {
		sourceRevision: options.sourceRevision,
		pruneDescriptions: agent?.prunesToolDescriptions?.(model) === true,
	});
}

/**
 * {@link estimateContextToolSchemaTokens} from what its caller computed
 * already: `tools`, `agent`'s roster, `withdrawn`, the definitions
 * {@link withdrawnToolDefinitions} gives, and the prune mode in `options`.
 */
function declaredToolSchemaTokens(
	agent: ToolDeclarationSource | undefined,
	tools: ToolSchemaSource,
	withdrawn: readonly ContextTool[],
	tokenizer: Tokenizer,
	model: Model | undefined,
	options: ToolSchemaEstimateOptions,
): number {
	if (model?.toolSchemasInContext === false) return 0;
	const tokens = estimateToolSchemaTokens(tools, tokenizer, options);
	return agent ? tokens + withdrawnToolTokens(agent, withdrawn, tokenizer) : tokens;
}

/**
 * Compute just the NON-MESSAGE token total: system prompt (with its skills
 * section subtracted, since skills are tokenized separately) + system context
 * (the rest of the system-prompt array) + tools + skills. The tools are those
 * the next request declares ({@link estimateContextToolSchemaTokens}), a
 * withdrawn tool a kept declaration still sends included.
 *
 * Exposed so callers like `StatusLineComponent` can cache the non-message
 * total separately from the growing message total. A model switch can change
 * which tool schemas occupy context without changing the roster; a prune-mode
 * change (`Agent.prunesToolDescriptions`) changes how much of each spec ships.
 */
// The per-turn threshold and compaction paths call these helpers repeatedly.
// Cache by prompt, roster, the withdrawn definitions the next request still
// declares, skills, tokenizer, revision, model schema policy, and prune mode;
// setSystemPrompt/setTools replace their arrays rather than mutating them.
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	toolsRef: ToolSchemaSource;
	/** {@link withdrawnToolDefinitions}: they change with a new declaration as well as with the roster. */
	withdrawnTools: readonly ContextTool[];
	toolSchemasInContext: boolean;
	pruneToolDescriptions: boolean;
	toolsRevision: number;
	sourceRevision: number;
	skillful: boolean;
	skillsRef: readonly ContextSkill[];
	// The Agent swaps its Tokenizer instance when the model's encoding changes,
	// so instance identity doubles as the encoding key.
	tokenizerRef: Tokenizer;
	tokens: number | undefined;
	breakdown:
		| {
				skillsTokens: number;
				toolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
		  }
		| undefined;
}

const NON_MESSAGE_TOKEN_CACHE = Symbol("non-message-token-cache");

interface CachedNonMessageTokenSource extends NonMessageTokenSource {
	[NON_MESSAGE_TOKEN_CACHE]?: NonMessageTokenCache;
}

function nonMessageTokenCacheEntry(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision: number,
): NonMessageTokenCache {
	const cachedSession: CachedNonMessageTokenSource = session;
	const systemPromptRef = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const toolsRef = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const withdrawnTools = withdrawnToolDefinitions(session.agent, toolsRef, session.model);
	const toolSchemasInContext = session.model?.toolSchemasInContext !== false;
	const pruneToolDescriptions = session.agent?.prunesToolDescriptions?.(session.model) === true;
	const toolsRevision = getToolSchemaMetadataRevision(toolsRef);
	const skillsRef = session.renderedSkills ?? session.skills ?? EMPTY_SKILLS;
	let entry = cachedSession[NON_MESSAGE_TOKEN_CACHE];
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		sameToolDefinitions(entry.withdrawnTools, withdrawnTools) &&
		entry.toolSchemasInContext === toolSchemasInContext &&
		entry.pruneToolDescriptions === pruneToolDescriptions &&
		entry.toolsRevision === toolsRevision &&
		entry.sourceRevision === sourceRevision &&
		entry.skillsRef === skillsRef &&
		entry.tokenizerRef === tokenizer
	) {
		return entry;
	}
	entry = {
		systemPromptRef,
		toolsRef,
		withdrawnTools,
		toolSchemasInContext,
		pruneToolDescriptions,
		toolsRevision,
		sourceRevision,
		skillful: true,
		skillsRef,
		tokenizerRef: tokenizer,
		tokens: undefined,
		breakdown: undefined,
	};
	cachedSession[NON_MESSAGE_TOKEN_CACHE] = entry;
	return entry;
}

export function computeNonMessageTokens(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
): number {
	const entry = nonMessageTokenCacheEntry(session, tokenizer, sourceRevision);
	if (entry.tokens !== undefined) return entry.tokens;
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tokens =
		tokenizer.countTokens(Array.from(systemPromptParts, part => part ?? "")) +
		declaredToolSchemaTokens(session.agent, entry.toolsRef, entry.withdrawnTools, tokenizer, session.model, {
			sourceRevision,
			pruneDescriptions: entry.pruneToolDescriptions,
		});
	entry.tokens = tokens;
	return tokens;
}

/**
 * Shared helper for the four non-message token totals used by
 * `computeContextBreakdown` (/context panel). Keep this category split stable:
 * the status-line fast path intentionally uses the equivalent collapsed total
 * in `computeNonMessageTokens`.
 */
export function computeNonMessageBreakdown(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
	skillful = true,
): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session, tokenizer, sourceRevision);
	if (entry.breakdown && entry.skillful === skillful) return entry.breakdown;
	const tools = entry.toolsRef;
	const skillsTokens =
		skillful === false
			? 0
			: estimateSkillsTokens(
					renderedSkills(session.renderedSkills ?? session.skills ?? EMPTY_SKILLS, tools),
					tokenizer,
				);
	const toolsTokens = declaredToolSchemaTokens(session.agent, tools, entry.withdrawnTools, tokenizer, session.model, {
		sourceRevision,
		pruneDescriptions: entry.pruneToolDescriptions,
	});
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = tokenizer.countTokens(Array.from(systemPromptParts.slice(1), part => part ?? ""));
	const systemPromptTokens = Math.max(0, tokenizer.countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.skillful = skillful;
	entry.breakdown = breakdown;
	return breakdown;
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(session: ContextUsageSession, options: ContextUsageOptions): ContextBreakdown {
	const model = session.model;
	const tokenizer = session.agent.tokenizer;
	const contextWindow = model?.contextWindow ?? 0;

	const breakdown = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;

	let messagesTokens = 0;
	let skillsTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		// Category split needs a messages-only number, so this walk stays local:
		// an anchored total folds the system prompt and tool schemas into it.
		messagesTokens = tokenizer.countMessages(session.messages ?? []);
		const nonMessage = computeNonMessageBreakdown(session, tokenizer, options.sourceRevision, options.skillful);
		skillsTokens = nonMessage.skillsTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens + messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens },
		{ id: "systemContext", label: "System context", tokens: systemContextTokens },
		{ id: "skills", label: "Skills", tokens: skillsTokens },
		{ id: "messages", label: "Messages", tokens: messagesTokens },
	];

	let autoCompactBufferTokens = 0;
	let thresholdTokens: number | undefined;
	if (contextWindow > 0) {
		const compactionSettings = options.compaction;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			if (threshold > 0 && threshold <= contextWindow) thresholdTokens = threshold;
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		thresholdTokens,
		snapcompact: options.snapcompact,
	};
}
