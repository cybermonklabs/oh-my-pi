/**
 * Shared steps of the subagent revive tests. A test spawns a real subagent through `runSubprocess` on a
 * scripted model, parks it, revives it warm through the lifecycle, drops the warm reviver as a subagent
 * worker's exit does, and revives the same stored session cold through the persisted reviver factory.
 * A call-through spy records every `createAgentSession` options object, and the scripted model records
 * every request as a provider receives it.
 */
import { expect, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TSchema,
} from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { type OverlayLayers, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EvalKernelNotRunningError } from "@oh-my-pi/pi-coding-agent/eval/executor-base";
import * as jsContextManager from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { JsToolRequest } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import type { EvalToolDescriptor, EvalToolInvokeResult } from "@oh-my-pi/pi-coding-agent/eval/types";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { sessionLocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-coding-agent/irc/irc-types";
import { MCPManager, type MCPToolScope } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { AgentLifecycleManager, type AgentReviver } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as settingsStreamModule from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import {
	type ExecutorOptions,
	type IrcWakeTurnMonitorOptions,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ContextFileEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { MCPToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/mcp";
import * as toolsModule from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { buildWorkspaceTree, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { __resetDirsFromEnvForTests, isRecord, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MOCK_API_SOURCE = "test/subagent-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** The model every subagent of these tests starts on. */
export const SPAWN_MODEL = "mock/mock-model";
/** The target a prewalk-armed spawn would hand off to at its first edit. */
export const PREWALK_MODEL = "mock/mock-prewalk";
/** Body of the IRC message that wakes a revived subagent. */
export const WAKE_BODY = "Main asks for one status line.";
/** The one default prompt block a system prompt builder is applied to when two revives' builders are compared. */
export const PROMPT_PROBE = "Default prompt block of the comparison.";
/** Text of the fixture context file, which the spawn's default prompt renders. */
export const CONTEXT_TEXT = "Context fixture: report each row in one line.";
/** The task a spawn is given. */
export const SPAWN_TASK = "Check the fixture rows.";
/** The one kernel-defined custom tool of the eval spawns. */
export const LOOKUP_TOOL: EvalToolDescriptor = {
	name: "lookup_rows",
	description: "Looks up fixture rows by key.",
	parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
	language: "js",
};

/** Settings of the root session in every test, before a test's own. */
const BASE_SETTINGS: Readonly<Record<string, unknown>> = {
	// No TTL timer: the tests park through the same path the timer takes.
	"task.agentIdleTtlMs": 0,
	"async.enabled": false,
	"compaction.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	// Eval-defined tools are off by default; the tests spawn subagents that carry them.
	"eval.tools.enabled": true,
	modelRoles: { default: SPAWN_MODEL },
};

/** The agent definition of a fixture subagent, with `extra` over it. */
export function fixtureAgent(extra: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "task",
		description: "Fixture task agent",
		systemPrompt: "You check fixture rows and report what you found.",
		source: "bundled",
		thinkingLevel: Effort.Low,
		...extra,
	};
}

/** One model request, as the provider received it. */
export interface RecordedRequest {
	/** `provider/id` of the model the request went to. */
	model: string;
	/** System prompt blocks, as sent. */
	system: string[];
	/** Name, description and parameters of every tool, as JSON bytes. */
	tools: string;
	toolNames: string[];
	messages: Message[];
	/** Thinking effort the request asked for; absent when it asked for none. */
	reasoning?: Effort;
}

/** One `createAgentSession` call. */
export interface RecordedBuild {
	options: CreateAgentSessionOptions;
	/** The settings overlay's own layers when the call was made; the session may write to it later. */
	settingsLayers: OverlayLayers | undefined;
}

/** What the scripted model answers. */
export interface ScriptedTurns {
	/** Arguments of the `yield` call that ends a spawn's first run. */
	yieldArguments: Record<string, unknown>;
	/** Tool call a woken subagent makes before it answers; absent: it answers at once. */
	wakeToolCall?: { name: string; arguments: Record<string, unknown> };
}

/** Lists that discovery finds, written to the fixture workspace and handed to every spawn. */
export interface DiscoveryFixtures {
	contextFiles: ContextFileEntry[];
	skills: Skill[];
	rules: Rule[];
	promptTemplates: PromptTemplate[];
	workspaceTree: WorkspaceTree;
}

/** A parent session that is live while its subagent revives. */
export interface LiveParent {
	/** The parent as a spawner reads it, and as the cold revive of a later change reads its live inputs. */
	readonly toolSession: ToolSession;
	/** The root session the cold reviver factory is built over. */
	readonly session: AgentSession;
	/** The prepared extensions both of them hold: one array, which a test fills as the parent's scan does. */
	readonly preparedExtensions?: PreparedExtension[];
}

/** What a parent's process allows its subagents; each is on where absent. */
export type LivePolicy = Partial<Pick<ToolSession, "enableLsp" | "enableIrc" | "enableMCP">>;

export interface SpawnedSubagent {
	readonly id: string;
	readonly sessionFile: string;
	/** The last request of the spawn's run, the last before its park. */
	readonly lastRequest: RecordedRequest;
}

export interface RevivedSubagent {
	readonly session: AgentSession;
	readonly build: RecordedBuild;
	/** The system prompt builder applied to {@link PROMPT_PROBE} right after the revive, before any model call. */
	readonly prompt: unknown;
	/** The options of the wake-turn monitor the revive attached; undefined when it attached none on this thread. */
	readonly wake: IrcWakeTurnMonitorOptions | undefined;
}

/** An IRC send to a parked subagent and the first request of the turn it woke. */
export interface IrcSendResult {
	readonly receipt: IrcDeliveryReceipt;
	readonly request?: RecordedRequest;
	readonly session?: AgentSession;
}

/** One subagent spawned, parked, revived warm, parked again, and revived cold from the same stored session. */
export interface ParityRun {
	readonly spawned: SpawnedSubagent;
	readonly warm: RevivedSubagent;
	readonly cold: RevivedSubagent;
	/** First request of the wake turn after the warm revive. */
	readonly warmRequest: RecordedRequest;
	/** Last request of the wake turn after the warm revive, the last before the second park. */
	readonly warmLastRequest: RecordedRequest;
	/** First request of the wake turn after the cold revive. */
	readonly coldRequest: RecordedRequest;
}

function recordRequest(model: string, context: Context, reasoning: Effort | undefined): RecordedRequest {
	const tools = context.tools ?? [];
	const wire = tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: toolWireSchema(tool),
	}));
	return {
		model,
		system: [...(context.systemPrompt ?? [])],
		tools: JSON.stringify(wire),
		toolNames: tools.map(tool => tool.name),
		messages: [...context.messages],
		reasoning,
	};
}

/** Efforts of the scripted models that take a thinking level. */
const THINKING_LADDER = { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] } as const;

/** A scripted model's options; see {@link ReviveEnv.addModel}. */
export interface ScriptedModelOptions {
	/** Defaults to `mock`. */
	provider?: string;
	/** The model takes a thinking level from {@link THINKING_LADDER}. */
	thinking?: boolean;
}

function scriptedResponse(turns: ScriptedTurns, context: Context): MockResponse {
	if (context.messages.at(-1)?.role === "toolResult") return { content: ["done"] };
	// A spawn's first request has no answer before it; it ends the run with its result.
	if (!context.messages.some(message => message.role === "assistant")) {
		return { content: [{ type: "toolCall", name: "yield", arguments: turns.yieldArguments }] };
	}
	const call = turns.wakeToolCall;
	return call ? { content: [{ type: "toolCall", name: call.name, arguments: call.arguments }] } : { content: ["ack"] };
}

/** Text of the user and developer messages of a request: what the model reads besides the tool traffic. */
export function userTexts(request: RecordedRequest): string[] {
	return request.messages.flatMap(message => {
		if (message.role !== "user" && message.role !== "developer") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
	});
}

/** The text of the runtime limit's log line. */
export const LIMIT_WARNING = "Subagent runtime limit exceeded; aborting";
/** A held turn's wait for its end: past every limit the revive tests set, short of their timeouts. */
export const HELD_TURN_BOUND_MS = 12_000;
/** The answer of a model that holds a request until the turn is aborted. */
export const HELD: MockResponse = { delayMs: 120_000, content: ["late"] };

/** One lifecycle frame of a subagent, with the time it was seen. */
export interface LifecycleFrame {
	id: string;
	status: string;
	agentSource: unknown;
	description: unknown;
	parentToolCallId: unknown;
	index: unknown;
	at: number;
}

/** Every lifecycle frame `bus` carries from now on, in order. */
export function recordFrames(bus: EventBus): LifecycleFrame[] {
	const frames: LifecycleFrame[] = [];
	bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (!isRecord(payload)) return;
		frames.push({
			id: String(payload.id),
			status: String(payload.status),
			agentSource: payload.agentSource,
			description: payload.description,
			parentToolCallId: payload.parentToolCallId,
			index: payload.index,
			at: Date.now(),
		});
	});
	return frames;
}

/** A turn whose model may hold its answer: its `started` frame, and its end where one came within the bound. */
export interface HeldTurn {
	started: LifecycleFrame;
	ended: LifecycleFrame | undefined;
	/** From the `started` frame to the end; undefined when the turn had not ended within the bound. */
	elapsedMs: number | undefined;
}

/**
 * Waits for the next turn of `id` (of any subagent where `id` is undefined) after `frames[from]` to start, then up
 * to the bound for it to end. The limit under test is a real timer of the subagent's own run (on another thread
 * for a worker-homed subagent), so the wait polls the frames on the platform clock rather than a fake one.
 */
export async function heldTurn(frames: LifecycleFrame[], id: string | undefined, from: number): Promise<HeldTurn> {
	const startDeadline = Date.now() + HELD_TURN_BOUND_MS;
	for (;;) {
		const after = frames.slice(from).filter(frame => id === undefined || frame.id === id);
		const started = after.find(frame => frame.status === "started");
		if (started) {
			const ended = after.find(frame => frame.status !== "started" && frame.at >= started.at);
			if (ended) return { started, ended, elapsedMs: ended.at - started.at };
			if (Date.now() - started.at > HELD_TURN_BOUND_MS) return { started, ended: undefined, elapsedMs: undefined };
		} else if (Date.now() > startDeadline) {
			throw new Error(`No turn of ${id ?? "any subagent"} started`);
		}
		await Bun.sleep(20);
	}
}

/** The held turn ended at its limit: an `aborted` frame `minMs` to 10 s after it started. */
export function expectEndedAtLimit(turn: HeldTurn, minMs: number): void {
	expect(turn.ended?.status).toBe("aborted");
	expect(turn.elapsedMs).toBeGreaterThanOrEqual(minMs);
	expect(turn.elapsedMs).toBeLessThanOrEqual(10_000);
}

/** omp's log holds the runtime limit's line for `id` with `maxRuntimeMs`. */
export function limitLogged(warn: Mock<typeof logger.warn>, id: string, maxRuntimeMs: number): boolean {
	return warn.mock.calls.some(
		([message, fields]) => message === LIMIT_WARNING && fields?.id === id && fields.maxRuntimeMs === maxRuntimeMs,
	);
}

/** Holds every request of a wake turn: one whose conversation carries the IRC message that woke it. */
export function holdWake(request: RecordedRequest): MockResponse | undefined {
	return userTexts(request).some(text => text.includes(WAKE_BODY)) ? HELD : undefined;
}

/** The last result of a tool in a session's conversation. */
export interface ToolResultText {
	text: string;
	isError: boolean;
}

/** The last result of `toolName` in `session`'s conversation. */
export function lastToolResult(session: AgentSession, toolName: string): ToolResultText | undefined {
	const result = session.agent.state.messages.findLast(
		message => message.role === "toolResult" && message.toolName === toolName,
	);
	if (result?.role !== "toolResult") return undefined;
	const text = result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
	return { text, isError: result.isError };
}

/** The `session_init` records of a transcript, as its lines hold them. */
export async function sessionInitRecords(sessionFile: string): Promise<Array<Record<string, unknown>>> {
	const records: unknown[] = Bun.JSONL.parse(await Bun.file(sessionFile).text());
	return records.filter(isRecord).filter(record => record.type === "session_init");
}

/**
 * Rewrites each record of `sessionFile` that `edit` changes in place (it returns whether it did), as a writer of the
 * session store does; a blank line is kept as it is. Returns the number of records rewritten.
 */
export async function editSessionRecords(
	sessionFile: string,
	edit: (record: Record<string, unknown>) => boolean,
): Promise<number> {
	let changed = 0;
	const lines = (await Bun.file(sessionFile).text()).split("\n").map(line => {
		if (line.trim() === "") return line;
		const record: unknown = JSON.parse(line);
		if (!isRecord(record) || !edit(record)) return line;
		changed++;
		return JSON.stringify(record);
	});
	await Bun.write(sessionFile, lines.join("\n"));
	return changed;
}

/**
 * Rewrites the spawn spec of each `session_init` of a parked subagent's `sessionFile` through `edit`, which changes
 * it in place ({@link editSessionRecords}). Returns the number of records rewritten.
 */
export function editStoredSpawnSpecs(
	sessionFile: string,
	edit: (spec: Record<string, unknown>) => void,
): Promise<number> {
	return editSessionRecords(sessionFile, record => {
		if (record.type !== "session_init" || !isRecord(record.spawnSpec)) return false;
		edit(record.spawnSpec);
		return true;
	});
}

/** A process MCP manager with no servers, whose tool set a test changes as a server's `tools/list` change would. */
export class FixtureMcpManager extends MCPManager {
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	readonly #listeners = new Set<() => void>();

	override getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		return [...super.getTools(scope), ...this.#tools];
	}

	override addToolsChangedListener(listener: () => void): () => void {
		const unsubscribe = super.addToolsChangedListener(listener);
		this.#listeners.add(listener);
		return () => {
			unsubscribe();
			this.#listeners.delete(listener);
		};
	}

	/** Replace the fixture tools by MCP tools of these names and tell every subscribed session. */
	setFixtureTools(names: string[]): void {
		this.#tools = names.map(name => fixtureMcpTool(name));
		for (const listener of this.#listeners) listener();
	}
}

function fixtureMcpTool(name: string): CustomTool<TSchema, MCPToolDetails> {
	return {
		name: `mcp__fixture__${name}`,
		label: name,
		description: `Fixture MCP tool ${name}.`,
		parameters: { type: "object", properties: {} },
		mcpServerName: "fixture",
		mcpToolName: name,
		async execute() {
			const details = { serverName: "fixture", mcpToolName: name };
			return { content: [{ type: "text", text: `${name} ok` }], details };
		},
	};
}

/** What a kernel answers a tool query with: a call's result, or the descriptors a `describe` found. */
type KernelReply = EvalToolInvokeResult | { ok: true; tools: EvalToolDescriptor[]; missing: string[] };

/**
 * The eval kernels of the live parents of a test: which tools each defines, and the calls they answered.
 * It answers the kernel queries `task/eval-tools.ts` makes (`invokeJsTool`) for each parent tool session a
 * test registers; a session it does not know has no kernel running, as with no kernel at all.
 */
export class FixtureKernels {
	readonly #tools = new Map<ToolSession, EvalToolDescriptor[]>();
	readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

	/** Make `session`'s kernel define `tools`. */
	define(session: ToolSession, tools: EvalToolDescriptor[]): void {
		this.#tools.set(session, tools);
	}

	/** Answers an `invokeJsTool` query as the kernel of the queried session would. */
	readonly answer = async (request: JsToolRequest, options: { session: ToolSession }): Promise<KernelReply> => {
		const tools = this.#tools.get(options.session);
		if (!tools) throw new EvalKernelNotRunningError("JavaScript");
		if (request.op === "describe") {
			const defined = new Set(tools.map(tool => tool.name));
			const found = request.names.length === 0 ? tools : tools.filter(tool => request.names.includes(tool.name));
			return { ok: true, tools: found, missing: request.names.filter(name => !defined.has(name)) };
		}
		this.calls.push({ tool: request.name, args: request.args });
		return { ok: true, value: `${request.name} answered ${JSON.stringify(request.args)}` };
	};
}

async function writeDiscoveryFixtures(cwd: string): Promise<DiscoveryFixtures> {
	const contextPath = path.join(cwd, "CONTEXT.md");
	const skillDir = path.join(cwd, ".omp", "skills", "fixture-skill");
	const skillPath = path.join(skillDir, "SKILL.md");
	const ruleDir = path.join(cwd, ".omp", "rules");
	const rulePath = path.join(ruleDir, "fixture-rule.md");
	const templateDir = path.join(cwd, ".omp", "prompts");
	await fs.mkdir(skillDir, { recursive: true });
	await fs.mkdir(ruleDir, { recursive: true });
	await fs.mkdir(templateDir, { recursive: true });
	await Bun.write(contextPath, `${CONTEXT_TEXT}\n`);
	await Bun.write(skillPath, "---\nname: fixture-skill\ndescription: Checks fixture rows.\n---\nCheck each row.\n");
	await Bun.write(rulePath, "Name the row you checked.\n");
	await Bun.write(path.join(templateDir, "fixture-template.md"), "Summarize the fixture rows.\n");
	const ruleSource = { provider: "native", providerName: "native", path: rulePath, level: "project" as const };
	const skill: Skill = {
		name: "fixture-skill",
		description: "Checks fixture rows.",
		filePath: skillPath,
		baseDir: skillDir,
		source: "project",
	};
	const rule: Rule = {
		name: "fixture-rule",
		path: rulePath,
		content: "Name the row you checked.",
		alwaysApply: true,
		_source: ruleSource,
	};
	return {
		contextFiles: [{ path: contextPath, content: CONTEXT_TEXT }],
		skills: [skill],
		rules: [rule],
		promptTemplates: [
			{
				name: "fixture-template",
				description: "Summarize the fixture rows.",
				content: "Summarize the fixture rows.",
				source: "(project)",
			},
		],
		workspaceTree: await buildWorkspaceTree(cwd),
	};
}

/** The `runSubprocess` options a spawner takes from the spawning session; a route adds the rest. */
export type SpawnerOptions = Omit<ExecutorOptions, "agent" | "task" | "index" | "id">;
/** The `runSubprocess` options every spawn of these tests shares. */
export type SpawnInputs = Pick<
	ExecutorOptions,
	"id" | "agent" | "task" | "index" | "artifactsDir" | "modelOverride" | "thinkingLevel"
>;

/**
 * The `runSubprocess` options a spawner takes from the spawning session, as `buildExecutorOptions`
 * (`task/structured-subagent.ts`) takes them; a route adds the agent, the task and its own inputs.
 */
export function spawnerOptions(session: ToolSession, restrictToolNames = false): SpawnerOptions {
	const enableMCP = !restrictToolNames && (session.enableMCP ?? true);
	return {
		cwd: session.cwd,
		costGate: session.costGate,
		additionalDirectories: session.additionalDirectories,
		getApiKey: session.getApiKey,
		credentialSourceSessionId: session.getCredentialSourceSessionId?.(),
		taskDepth: session.taskDepth ?? 0,
		restrictToolNames,
		// A spawner passes its session's LSP policy, off for a plan-mode spawn (the restricted contract here);
		// `task.enableLsp`, off by default, keeps LSP checks off the subagent's writes through its settings overlay.
		enableLsp: !restrictToolNames && (session.enableLsp ?? true),
		eventBus: session.eventBus,
		subagentEventBus: session.subagentEventBus,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		asyncJobManager: session.asyncJobManager,
		inheritedSessionAgents: session.getSessionAgents?.(),
		parentActiveProvider: session.getActiveModel?.()?.provider,
		mcpManager: enableMCP ? (session.mcpManager ?? MCPManager.instance()) : undefined,
		mcpToolScope: session.mcpToolScope,
		enableMCP,
		contextFiles: session.contextFiles,
		noContextFiles: session.noContextFiles,
		skills: [...(session.skills ?? [])],
		workspaceTree: session.workspaceTree,
		promptTemplates: session.promptTemplates,
		rules: session.rules,
		extensionRoots: session.effectiveExtensionRoots,
		preloadedExtensionPaths: restrictToolNames ? [] : session.extensionPaths,
		preloadedPreparedExtensions: session.preparedExtensions,
		preloadedCustomToolPaths: restrictToolNames ? [] : session.customToolPaths,
		localProtocolOptions: sessionLocalProtocolOptions(session),
		parentArtifactManager: session.getArtifactManager?.() ?? undefined,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentTelemetry: session.getTelemetry?.(),
		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		parentPromptCacheKey: session.getPromptCacheKey?.(),
		parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
	};
}

/**
 * A task spawn of `id` by `parent` in `env`, with `extra` over the shared spawn inputs. `extra.agent` is the spawned
 * agent and `extra.restrictToolNames` makes the spawner's own options restricted, as a restricted spawn takes them.
 */
export function taskSpawn(
	env: ReviveEnv,
	parent: ToolSession,
	id: string,
	extra: Partial<ExecutorOptions> = {},
): ExecutorOptions {
	return { ...spawnerOptions(parent, extra.restrictToolNames), ...env.subagentInputs(id, extra.agent), ...extra };
}

interface ReviveEnvParts {
	root: string;
	cwd: string;
	extraDir: string;
	artifactsDir: string;
	savedEnv: Record<string, string | undefined>;
	authStorage: AuthStorage;
	settingsOverrides: Readonly<Record<string, unknown>>;
	fixtures: DiscoveryFixtures;
}

/** The process a test runs in: its workspace, models, root settings, lifecycle and recorders. */
export class ReviveEnv {
	readonly root: string;
	readonly cwd: string;
	readonly artifactsDir: string;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settings: Settings;
	readonly eventBus = new EventBus();
	readonly subagentEventBus = new EventBus();
	readonly mcp: FixtureMcpManager;
	readonly kernels = new FixtureKernels();
	readonly fixtures: DiscoveryFixtures;
	readonly spawnModel: MockModel;
	readonly requests: RecordedRequest[] = [];
	readonly builds: RecordedBuild[] = [];
	/** Every wake-turn monitor's options, in the order the monitors were attached on this thread. */
	readonly wakes: IrcWakeTurnMonitorOptions[] = [];
	turns: ScriptedTurns = { yieldArguments: { type: "result", data: "done" } };
	/** A test's own answer to a request, asked before {@link turns}; undefined leaves the request to them. */
	respond: ((request: RecordedRequest) => MockResponse | undefined) | undefined;
	readonly #extraDir: string;
	readonly #savedEnv: Record<string, string | undefined>;
	readonly #settingsOverrides: Readonly<Record<string, unknown>>;
	readonly #waiters: Array<(request: RecordedRequest) => void> = [];
	readonly #createTools: Mock<typeof toolsModule.createTools>;
	/** Models the registry lists besides its catalog. */
	readonly #models: Model<Api>[] = [];
	/** Models the registry lists only once its runtime discovery ran. */
	readonly #discovered: Model<Api>[] = [];
	#discoveryScripted = false;
	#discoveryRan = false;
	/** Providers whose requests the scripted model answers, whatever the model's API. */
	readonly #servedProviders = new Set<string>();
	#lifecycle: AgentLifecycleManager;
	#adopt: Mock<AgentLifecycleManager["adopt"]>;

	constructor(parts: ReviveEnvParts) {
		this.root = parts.root;
		this.cwd = parts.cwd;
		this.artifactsDir = parts.artifactsDir;
		this.authStorage = parts.authStorage;
		this.fixtures = parts.fixtures;
		this.#extraDir = parts.extraDir;
		this.#savedEnv = parts.savedEnv;
		this.#settingsOverrides = parts.settingsOverrides;
		this.settings = this.createSettings();
		this.modelRegistry = new ModelRegistry(this.authStorage);
		this.spawnModel = this.#scriptedModel("mock-model");
		this.#models.push(this.spawnModel, this.#scriptedModel("mock-prewalk"));
		const available = this.modelRegistry.getAvailable.bind(this.modelRegistry);
		const all = this.modelRegistry.getAll.bind(this.modelRegistry);
		vi.spyOn(this.modelRegistry, "getAvailable").mockImplementation(kind => [...this.#listed(), ...available(kind)]);
		vi.spyOn(this.modelRegistry, "getAll").mockImplementation(() => [...this.#listed(), ...all()]);
		this.mcp = new FixtureMcpManager(this.cwd);
		MCPManager.setInstance(this.mcp);
		const create = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const build = { options: options ?? {}, settingsLayers: options?.settings?.overlayLayers() };
			this.builds.push(build);
			return create(options);
		});
		this.#createTools = vi.spyOn(toolsModule, "createTools");
		const attach = executorModule.attachIrcWakeTurnMonitor;
		vi.spyOn(executorModule, "attachIrcWakeTurnMonitor").mockImplementation((session, options) => {
			this.wakes.push(options);
			attach(session, options);
		});
		vi.spyOn(jsContextManager, "invokeJsTool").mockImplementation(this.kernels.answer);
		this.#lifecycle = localLifecycle();
		this.#adopt = vi.spyOn(this.#lifecycle, "adopt");
	}

	/** Root settings of this process, with `extra` over them (a resumed parent's, for example). */
	createSettings(extra: Readonly<Record<string, unknown>> = {}): Settings {
		return Settings.isolated({ ...BASE_SETTINGS, ...this.#settingsOverrides, ...extra });
	}

	/** The lifecycle manager of this process, a new one after {@link restart}. */
	get lifecycle(): AgentLifecycleManager {
		return this.#lifecycle;
	}

	#listed(): Model<Api>[] {
		return this.#discoveryRan ? [...this.#models, ...this.#discovered] : [...this.#models];
	}

	#scriptedModel(id: string, options: ScriptedModelOptions = {}): MockModel {
		const provider = options.provider ?? "mock";
		const model = createMockModel({
			id,
			provider,
			reasoning: options.thinking,
			handler: (context, streamOptions) => this.#answer(`${provider}/${id}`, context, streamOptions),
		});
		return options.thinking ? Object.assign(model, { thinking: THINKING_LADDER }) : model;
	}

	#answer(model: string, context: Context, streamOptions: SimpleStreamOptions | undefined): MockResponse {
		const request = recordRequest(model, context, streamOptions?.reasoning);
		this.requests.push(request);
		for (const resolve of this.#waiters.splice(0)) resolve(request);
		return this.respond?.(request) ?? scriptedResponse(this.turns, context);
	}

	/** A scripted model the registry lists from now on, its requests recorded as `<provider>/<id>`; its provider gets a runtime key. */
	addModel(id: string, options: ScriptedModelOptions = {}): MockModel {
		const model = this.#scriptedModel(id, options);
		this.authStorage.keys.setRuntime(model.provider, "test-key");
		this.#models.push(model);
		return model;
	}

	/**
	 * A catalog model of any provider and API that the registry lists from now on; the scripted model
	 * answers every request to its provider, which gets a runtime key.
	 */
	addProviderModel(model: Model<Api>): void {
		if (this.#servedProviders.size === 0) {
			const create = settingsStreamModule.createSettingsAwareStreamFn;
			vi.spyOn(settingsStreamModule, "createSettingsAwareStreamFn").mockImplementation(
				(settings, base: StreamFn = streamSimple, slowMode) =>
					create(settings, this.#serveProviders(base), slowMode),
			);
		}
		this.#servedProviders.add(model.provider);
		this.authStorage.keys.setRuntime(model.provider, "test-key");
		this.#models.push(model);
	}

	#serveProviders(base: StreamFn): StreamFn {
		return (model, context, streamOptions) => {
			if (!this.#servedProviders.has(model.provider)) return base(model, context, streamOptions);
			const identity = `${model.provider}/${model.id}`;
			const scripted = createMockModel({
				id: model.id,
				provider: model.provider,
				handler: (request, options) => this.#answer(identity, request, options),
			});
			return scripted.stream(model, context, streamOptions);
		};
	}

	/** Take `identity` (`<provider>/<id>`) out of the registry, as a model a provider withdrew. */
	removeModel(identity: string): void {
		for (const list of [this.#models, this.#discovered]) {
			const index = list.findIndex(model => `${model.provider}/${model.id}` === identity);
			if (index >= 0) list.splice(index, 1);
		}
	}

	/**
	 * Make the registry's discovery scripted: a refresh, background or runtime, completes at once and
	 * lists the models of {@link addDiscoveredModel}; nothing reaches the network.
	 */
	scriptDiscovery(): void {
		if (this.#discoveryScripted) return;
		this.#discoveryScripted = true;
		const ran = (): void => {
			this.#discoveryRan = true;
		};
		vi.spyOn(this.modelRegistry, "refreshRuntimeProviders").mockImplementation(async () => ran());
		vi.spyOn(this.modelRegistry, "refresh").mockImplementation(async () => ran());
		vi.spyOn(this.modelRegistry, "refreshInBackground").mockImplementation(() => ran());
		vi.spyOn(this.modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {});
	}

	/** A scripted model the registry lists only after its discovery ran (see {@link forgetDiscovery}). */
	addDiscoveredModel(id: string, options: ScriptedModelOptions = {}): MockModel {
		this.scriptDiscovery();
		const model = this.#scriptedModel(id, options);
		this.#discovered.push(model);
		return model;
	}

	/** The registry of a new process: discovered models are unlisted until discovery runs again. */
	forgetDiscovery(): void {
		this.#discoveryRan = false;
	}

	/** Resolves with the next request any subagent sends. */
	nextRequest(): Promise<RecordedRequest> {
		const { promise, resolve } = Promise.withResolvers<RecordedRequest>();
		this.#waiters.push(resolve);
		return promise;
	}

	/**
	 * A live root session holding the discovery fixtures: its tool session is what a spawner reads,
	 * and `evalToolSession` exposes that same tool session on the root, where a cold revive reads
	 * the live parent's inputs. `policy` is what the parent's process allows (each on by default).
	 * Its session manager holds its working directory and workspace roots, which its tool session
	 * reads, as a session's does; `moveTo` and `addWorkspaceDirectory` change them as `/move` (or
	 * `/wt`) and `/add-dir` do. `roots` is the owner's extension-root policy.
	 */
	createLiveParent(
		settings: Settings = this.settings,
		policy: LivePolicy = {},
		roots: EffectiveExtensionRoots = { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
	): LiveParent {
		const preparedExtensions: PreparedExtension[] = [];
		const sessionAgents: AgentDefinition[] = [];
		let cwd = this.cwd;
		let workspaceRoots = [this.#extraDir];
		const sessionId = "root-session";
		const toolSession: ToolSession = {
			get cwd() {
				return cwd;
			},
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			taskDepth: 0,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			eventBus: this.eventBus,
			subagentEventBus: this.subagentEventBus,
			mcpManager: this.mcp,
			enableMCP: policy.enableMCP ?? true,
			enableLsp: policy.enableLsp ?? true,
			...(policy.enableIrc === undefined ? {} : { enableIrc: policy.enableIrc }),
			get additionalDirectories() {
				return [...workspaceRoots];
			},
			// A root session's tool session gives its own session id as a spawn's credential source.
			getCredentialSourceSessionId: () => sessionId,
			contextFiles: this.fixtures.contextFiles,
			skills: this.fixtures.skills,
			rules: this.fixtures.rules,
			promptTemplates: this.fixtures.promptTemplates,
			workspaceTree: this.fixtures.workspaceTree,
			getSessionAgents: () => sessionAgents,
			effectiveExtensionRoots: () => roots,
			extensionPaths: [],
			customToolPaths: [],
			preparedExtensions,
			localProtocolOptions: { getArtifactsDir: () => null, getSessionId: () => null },
		};
		const session = {
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => cwd,
				getAdditionalDirectories: () => [...workspaceRoots],
				moveTo: async (next: string) => {
					cwd = path.resolve(next);
				},
				addWorkspaceDirectory: async (directory: string) => {
					const resolved = path.resolve(cwd, directory);
					if (workspaceRoots.includes(resolved)) return null;
					workspaceRoots = [...workspaceRoots, resolved];
					return resolved;
				},
				getArtifactManager: () => undefined,
			},
			get effectiveExtensionRoots() {
				return roots;
			},
			preparedExtensions,
			model: this.spawnModel,
			skills: this.fixtures.skills,
			promptTemplates: this.fixtures.promptTemplates,
			getSessionAgents: () => sessionAgents,
			getAgentId: () => MAIN_AGENT_ID,
			evalToolSession: toolSession,
		} as unknown as AgentSession;
		return { toolSession, session, preparedExtensions };
	}

	/** `parent`'s root session as a host's root that holds no tool session, with the same live state. */
	hostRoot(parent: LiveParent): LiveParent {
		const session: AgentSession = Object.create(parent.session, { evalToolSession: { value: undefined } });
		return { toolSession: parent.toolSession, session, preparedExtensions: parent.preparedExtensions };
	}

	/**
	 * Install the persisted reviver factory over `parent`, as the root session of an interactive run does;
	 * `enableLsp` is the root's LSP policy.
	 */
	installColdReviver(parent: LiveParent, enableLsp = true): void {
		const factory = createPersistedSubagentReviverFactory({
			session: parent.session,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			settings: parent.toolSession.settings,
			enableLsp,
			eventBus: this.eventBus,
			subagentEventBus: this.subagentEventBus,
		});
		this.#lifecycle.setPersistedSubagentReviverFactory(factory, () => 0);
	}

	/** A new lifecycle manager on the same registry and files, with the cold reviver over `parent`. */
	restart(parent: LiveParent, enableLsp = true): void {
		AgentLifecycleManager.resetGlobalForTests();
		this.#lifecycle = localLifecycle();
		this.#adopt = vi.spyOn(this.#lifecycle, "adopt");
		this.installColdReviver(parent, enableLsp);
	}

	/** What every spawn of these tests shares: its id, agent, task, artifacts and model. */
	subagentInputs(id: string, agent: AgentDefinition = fixtureAgent()): SpawnInputs {
		return {
			id,
			agent,
			task: SPAWN_TASK,
			index: 0,
			artifactsDir: this.artifactsDir,
			modelOverride: SPAWN_MODEL,
			// A spawner passes the agent definition's thinking level (`buildExecutorOptions`, `vibe/runtime.ts`).
			thinkingLevel: agent.thinkingLevel,
		};
	}

	/** Run a kept-alive subagent to its result; its session stays live and adopted. */
	async spawn(options: ExecutorOptions): Promise<SpawnedSubagent> {
		const result = await runSubprocess(options);
		if (result.exitCode !== 0) throw new Error(`Spawn of ${options.id} failed: ${result.error ?? result.stderr}`);
		const lastRequest = this.requests.at(-1);
		if (!lastRequest) throw new Error(`Spawn of ${options.id} sent no request`);
		return { id: options.id, sessionFile: path.join(this.artifactsDir, `${options.id}.jsonl`), lastRequest };
	}

	park(id: string): Promise<void> {
		return this.#lifecycle.park(id);
	}

	/** Kill a subagent as the Agent Hub does: a terminal `aborted` row that a later message reopens. */
	async kill(id: string): Promise<void> {
		if (!(await this.#lifecycle.release(id, undefined, { tombstone: true }))) throw new Error(`${id} was not killed`);
	}

	/** Drop the warm reviver of `id`, as `MainSessionBridge.exit` does when the subagent's worker exits. */
	dropWarmReviver(id: string): void {
		const opts = this.#adopt.mock.calls.findLast(([adopted]) => adopted === id)?.[1];
		const revive: AgentReviver | undefined = opts?.revive;
		if (!revive || !this.#lifecycle.forgetReviver(id, revive)) throw new Error(`${id} has no warm reviver to drop`);
	}

	/** Revive a parked subagent through the lifecycle: warm while its reviver is adopted, cold after it is dropped. */
	async revive(id: string): Promise<RevivedSubagent> {
		const first = this.builds.length;
		const firstWake = this.wakes.length;
		const session = localSession(await this.#lifecycle.ensureLive(id));
		const build = this.builds.slice(first).findLast(candidate => candidate.options.agentId === id);
		if (!build) throw new Error(`The revive of ${id} built no session`);
		const systemPrompt = build.options.systemPrompt;
		const prompt = typeof systemPrompt === "function" ? systemPrompt([PROMPT_PROBE]) : systemPrompt;
		const wake = this.wakes.slice(firstWake).findLast(options => options.id === id);
		return { session, build, prompt, wake };
	}

	/** Wake a live subagent with an IRC message, as a peer does, and return the first request of that turn. */
	async wake(session: AgentSession, id: string): Promise<RecordedRequest> {
		const next = this.nextRequest();
		await session.deliverIrcMessage({
			id: `wake-${this.requests.length}`,
			from: MAIN_AGENT_ID,
			to: id,
			body: WAKE_BODY,
			ts: Date.now(),
		});
		const request = await next;
		await session.agent.waitForIdle();
		return request;
	}

	/** Send `id` an IRC message, which revives it when it is parked or killed, and wait for the turn it wakes. */
	async ircSend(id: string): Promise<IrcSendResult> {
		const next = this.nextRequest();
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		if (receipt.outcome === "failed") return { receipt };
		const request = await next;
		const session = localSession(AgentRegistry.global().get(id)?.session);
		await session.agent.waitForIdle();
		return { receipt, request, session };
	}

	/** Change the fixture MCP tools and wait until `session` has rebuilt its tools from them. */
	async setMcpTools(session: AgentSession, names: string[]): Promise<void> {
		const refreshed = Promise.withResolvers<void>();
		const refresh = session.refreshMCPTools.bind(session);
		const spy = vi.spyOn(session, "refreshMCPTools").mockImplementation(async tools => {
			await refresh(tools);
			refreshed.resolve();
		});
		this.mcp.setFixtureTools(names);
		await refreshed.promise;
		spy.mockRestore();
	}

	/** The tool session `createAgentSession` built for `agentId`, which that session's own spawns read. */
	toolSessionOf(agentId: string): ToolSession {
		const call = this.#createTools.mock.calls.findLast(([session]) => session.getAgentId?.() === agentId);
		if (!call) throw new Error(`No tool session was built for ${agentId}`);
		return call[0];
	}

	/**
	 * Spawn, park, revive warm and wake, park, drop the warm reviver, revive cold and wake. `beforePark` runs on
	 * the spawned subagent before its first park and returns it with the last request it sent by then.
	 */
	async runParity(
		root: LiveParent,
		options: ExecutorOptions,
		beforePark?: (spawned: SpawnedSubagent) => Promise<SpawnedSubagent>,
	): Promise<ParityRun> {
		this.installColdReviver(root);
		const first = await this.spawn(options);
		const spawned = beforePark ? await beforePark(first) : first;
		await this.park(spawned.id);
		const warm = await this.revive(spawned.id);
		const warmRequest = await this.wake(warm.session, spawned.id);
		const warmLastRequest = this.requests.at(-1) ?? warmRequest;
		await this.park(spawned.id);
		this.dropWarmReviver(spawned.id);
		const cold = await this.revive(spawned.id);
		const coldRequest = await this.wake(cold.session, spawned.id);
		return { spawned, warm, cold, warmRequest, warmLastRequest, coldRequest };
	}

	async close(): Promise<void> {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		MCPManager.resetForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, this.#savedEnv[key]);
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		this.authStorage.close();
		await removeWithRetries(this.root);
	}
}

function localLifecycle(): AgentLifecycleManager {
	const lifecycle = AgentLifecycleManager.global();
	if (!(lifecycle instanceof AgentLifecycleManager)) throw new Error("Expected the main-thread lifecycle manager");
	return lifecycle;
}

/** A fresh process for one test: temporary home and workspace, the discovery fixtures, and every recorder. */
export async function openReviveEnv(settingsOverrides: Readonly<Record<string, unknown>> = {}): Promise<ReviveEnv> {
	const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-revive-"));
	const home = path.join(root, "home");
	const cwd = path.join(home, "work");
	const extraDir = path.join(home, "extra");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(extraDir, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const fixtures = await writeDiscoveryFixtures(cwd);
	return new ReviveEnv({ root, cwd, extraDir, artifactsDir, savedEnv, authStorage, settingsOverrides, fixtures });
}
