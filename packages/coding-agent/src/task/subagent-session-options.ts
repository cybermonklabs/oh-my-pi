/**
 * What a subagent session is built from: its spawn-time inputs and the session options the live run and the warm
 * revive (`./subagent-revive`) both build it with, including the IRC peer roster its prompt renders and the
 * transcript records of that roster.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { assertModelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import { DEFAULT_PEER_ROSTER_LIMIT, LIST_STATUS_ORDER } from "@oh-my-pi/pi-tui/tools/irc";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster, isCurrentSessionRosterRef } from "../registry/persisted-agents";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { isLocalAgentSession } from "../session/agent-session-handle";
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { SessionStorage } from "../session/session-storage";
import type { MCPToolFollower } from "./executor";
import { assertPerCallModelApproved, type PerCallModelGrants } from "./model-approval";
import type { PreparedSeanceSession } from "./seance";
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

/** Inputs of a subagent's rendered system prompt, fixed at spawn. */
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
	/**
	 * Root resolved by the latest roster ensure; peer rows render scoped to it, so a session switch hides stale parked
	 * trees. Resolved again before each session build and dropped at dispose.
	 */
	ircRootSessionFile?: string;
	/**
	 * What the live session's prompt renders recorded: made by the first render (by a warm revive, before it builds
	 * the session), dropped at dispose.
	 */
	ircRenders?: IrcRenderLog;
	/**
	 * Set only while a warm revive builds the session: the roster read back by `revivalIrcRoster`
	 * (subagent-revive.ts).
	 */
	revivalIrcRoster?: IrcPeerRosterData;
}

/** Rosters a live subagent session's prompt rendered; a parked subagent keeps none. */
interface IrcRenderLog {
	/** Peer roster each prompt block the live session rendered shows, keyed by that block. */
	readonly renders: Map<string, IrcPeerRosterData>;
	/**
	 * {@link ircRosterBlockKey} of every block the transcript holds an {@link IRC_ROSTER_ENTRY} for; absent when the
	 * transcript records none ({@link SubagentSessionSpec.revivable}).
	 */
	readonly recorded?: Set<string>;
}

/**
 * Custom transcript entry recording the peer roster a subagent's prompt block shows, so a warm
 * revive renders that block again from the transcript rather than from a copy kept in memory.
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
 * The spawn-time inputs of a subagent session. The live run and the lifecycle reviver both build
 * their `createAgentSession` (sdk.ts) options from it, so a parked subagent keeps this data (its
 * plain parts in its transcript, see `SUBAGENT_REVIVE_ENTRY` in subagent-revive.ts) rather than the
 * spawning run's options, monitor, abort signals, progress sinks or settings.
 */
export interface SubagentSessionSpec {
	options: Omit<
		CreateAgentSessionOptions,
		| "settings"
		| "sessionManager"
		| "expectedAgentRef"
		| "systemPrompt"
		| "resolveServiceTierByFamily"
		| "onFirstChatDispatch"
		| "assertDispatchModel"
	>;
	preparedSession?: Pick<PreparedSeanceSession, "promptSuffix">;
	prompt: SubagentPromptInputs;
	/** A per-call worker's grants; every session built from the spec holds each request to them. */
	perCall?: { readonly grants: PerCallModelGrants; readonly modelRegistry: ModelRegistry };
	/**
	 * Whether a warm revive can read the session's transcript back: the subagent is kept alive and has a session
	 * file. Only then does the transcript record the rosters its prompt renders ({@link IRC_ROSTER_ENTRY}) and its
	 * revive inputs (`SUBAGENT_REVIVE_ENTRY` in subagent-revive.ts).
	 */
	revivable: boolean;
}

/** Launch-only session inputs: a revived session restores these from its transcript or goes without. */
interface SubagentLaunchInputs {
	workPoolYieldItems: readonly WorkPoolYieldItem[];
	resolveServiceTierByFamily?: CreateAgentSessionOptions["resolveServiceTierByFamily"];
	onFirstChatDispatch?: () => void;
}

/** Names of the child's explicitly supplied tools; they win over same-named MCP proxies on every rebind. */
export function explicitSubagentToolNames(spec: SubagentSessionSpec): ReadonlySet<string> {
	return new Set((spec.options.customTools ?? []).map(tool => tool.name));
}

export function buildSubagentSessionOptions(
	spec: SubagentSessionSpec,
	settings: Settings,
	sessionManager: SessionManager,
	expectedAgentRef: CreateAgentSessionOptions["expectedAgentRef"],
	mcpFollower: MCPToolFollower | undefined,
	launch?: SubagentLaunchInputs,
): CreateAgentSessionOptions {
	const inputs = spec.prompt;
	const perCall = spec.perCall;
	const effortCeiling = spec.options.thinkingLevelCeiling;
	// MCP proxies are minted per build, not captured in the spec: a kept-alive
	// subagent revived after `/mcp reload` must see the manager's current tools.
	const mcpTools = mcpFollower?.proxyTools() ?? [];
	const customTools = spec.options.customTools ?? [];
	return {
		...spec.options,
		// Built per session, never kept in the spec, so a parked subagent holds no function of its run.
		assertDispatchModel: perCall
			? (dispatchModel: Model) => {
					// Every request stays on an approved model that can run at or below the spawn's effort ceiling.
					assertPerCallModelApproved(dispatchModel, perCall.grants, perCall.modelRegistry);
					if (effortCeiling) assertModelSupportsEffortCeiling(dispatchModel, effortCeiling);
				}
			: undefined,
		mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
		mcpToolScope: mcpFollower?.scope,
		customTools: customTools.length > 0 ? customTools : undefined,
		settings,
		sessionManager,
		expectedAgentRef,
		resolveServiceTierByFamily: launch?.resolveServiceTierByFamily,
		onFirstChatDispatch: launch?.onFirstChatDispatch,
		// A launch prompts its assignment only after setup; a revive's turns are its IRC wakes.
		awaitingAssignment: launch !== undefined,
		systemPrompt: defaultPrompt => {
			// A revive shows the roster `revivalIrcRoster` (subagent-revive.ts) returned, and a rebuild
			// that leaves the rest of the prompt unchanged keeps the roster the prompt it replaces showed:
			// peer rows carry each peer's live activity, so a re-collected roster changed the prompt's
			// bytes on every such rebuild and the provider wrote the whole conversation to its prompt
			// cache again. A rebuild whose default blocks changed loses the cached prefix anyway, so it
			// catches the roster up.
			const ircRoster = !inputs.ircEnabled
				? undefined
				: (inputs.revivalIrcRoster ??
					heldIrcRoster(inputs, defaultPrompt) ??
					collectIrcPeerRoster(AgentRegistry.global(), inputs.id, inputs.ircRootSessionFile));
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
				// would pin its whole graph past park. A revive builds while the registry session is
				// null, so it renders the cleared set rather than the launch-time pooled instructions.
				workPoolYieldItems:
					ownAttachedSession(inputs.id)?.getWorkPoolYieldItems?.() ?? launch?.workPoolYieldItems ?? [],
				ircPeers: ircRoster?.peers ?? [],
				ircParkedCount: ircRoster?.parkedCount ?? 0,
				ircOmittedCount: ircRoster?.omittedCount ?? 0,
				ircSelfId: inputs.ircEnabled ? inputs.id : "",
			});
			if (ircRoster) recordIrcRender(inputs, sessionManager, subagentPrompt, ircRoster, spec.revivable);
			// Per-spawn text (context, worktree, IRC roster) goes after the trailing
			// `<project-context>` block so spawns of the same agent share the static
			// prompt prefix as a cache hit.
			const seancePrompt = spec.preparedSession?.promptSuffix(inputs.model);
			return [...defaultPrompt, subagentPrompt, ...(seancePrompt ? [seancePrompt] : [])];
		},
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
	const renders = inputs.ircRenders?.renders;
	return renders && held.map(block => renders.get(block)).find(roster => roster !== undefined);
}

/**
 * Remembers the roster `block` shows, dropping blocks the live session's base prompt no longer holds, and, when a
 * warm revive can read the transcript back (`revivable`), records it there unless the transcript already holds that
 * block's roster.
 */
function recordIrcRender(
	inputs: SubagentPromptInputs,
	sessionManager: SessionManager,
	block: string,
	roster: IrcPeerRosterData,
	revivable: boolean,
): void {
	const log = (inputs.ircRenders ??= {
		renders: new Map(),
		recorded: revivable ? recordedIrcRosterBlocks(sessionManager.getEntries()) : undefined,
	});
	const held = ownAttachedSession(inputs.id)?.baseSystemPrompt;
	if (held) {
		for (const rendered of log.renders.keys()) {
			if (!held.includes(rendered)) log.renders.delete(rendered);
		}
	}
	log.renders.set(block, roster);
	if (!log.recorded) return;
	const key = ircRosterBlockKey(block);
	if (log.recorded.has(key)) return;
	log.recorded.add(key);
	const record: IrcRosterRecord = { block: key, roster };
	sessionManager.appendCustomEntry(IRC_ROSTER_ENTRY, record);
}

/** Keys of the blocks `entries` hold an {@link IRC_ROSTER_ENTRY} for. */
export function recordedIrcRosterBlocks(entries: readonly SessionEntry[]): Set<string> {
	const recorded = new Set<string>();
	for (const entry of entries) {
		const record = ircRosterRecordOf(entry);
		if (record) recorded.add(record.block);
	}
	return recorded;
}

/**
 * `fields` without its keys whose value is `undefined`; with `keys`, only the fields they name. A parked subagent
 * keeps its spawn's session options and wake-turn inputs for as long as it can be revived, and their readers take a
 * missing key as `undefined`.
 */
export function withoutUndefinedFields<T extends object>(fields: T): T;
export function withoutUndefinedFields<T extends object, K extends keyof T>(fields: T, keys: readonly K[]): Pick<T, K>;
export function withoutUndefinedFields<T extends object>(
	fields: T,
	keys: readonly (keyof T)[] = Object.keys(fields) as (keyof T)[],
): Partial<T> {
	// Own fields only: a key list naming `__proto__` would read the prototype of fields without that key. Object.fromEntries
	// defines each key as an own field, as JSON.parse does, where assigning `__proto__` would swap the copy's prototype.
	const defined: [keyof T, unknown][] = [];
	for (const key of keys) {
		const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
		if (value !== undefined) defined.push([key, value]);
	}
	return Object.fromEntries(defined) as Partial<T>;
}

/**
 * Drops `session`'s rendered rosters and roster root when it is disposed: the transcript keeps what a revive needs,
 * and the revive resolves the root again.
 */
export function dropIrcRendersOnDispose(session: AgentSession, inputs: SubagentPromptInputs): void {
	session.addDisposer(() => {
		inputs.ircRenders = undefined;
		inputs.ircRootSessionFile = undefined;
	});
}

/**
 * Re-resolves the IRC roster root a subagent's prompt scopes its peer rows to,
 * scanning the persisted roster in `storage`, where the tree's transcripts live.
 */
export async function refreshSubagentIrcRoot(
	inputs: SubagentPromptInputs,
	sessionManager: SessionManager,
	sessionFile: string | null,
	storage: SessionStorage,
): Promise<void> {
	if (!inputs.ircEnabled) return;
	const registry = AgentRegistry.global();
	inputs.ircRootSessionFile = await ensurePersistedRoster(
		registry,
		sessionManager.getSessionFile() ??
			sessionFile ??
			registry.get(inputs.id)?.sessionFile ??
			registry.get(MAIN_AGENT_ID)?.sessionFile,
		storage,
	);
}
