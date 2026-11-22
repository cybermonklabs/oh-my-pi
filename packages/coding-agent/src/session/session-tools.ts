import { AsyncLocalStorage } from "node:async_hooks";
import {
	type Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	latestToolDeclaration,
} from "@oh-my-pi/pi-agent-core";
import type { Model, Tool } from "@oh-my-pi/pi-ai";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import {
	isRecord,
	isStringList,
	logger,
	prompt,
	stringProperty,
	structuredCloneJSON,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { shouldInlineToolDescriptors } from "../config/inline-tool-descriptors-mode";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import {
	type AnySetting,
	lookup as lookupSetting,
	type SettingChange,
	settingValuesEqual,
	trackSettingsReads,
} from "../config/registry";
import type { Settings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { clearPluginRootsAndCaches } from "../discovery/helpers";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type { ExtensionRunner, SourceInfo, ToolInfo } from "../extensibility/extensions";
import { type EvalPreludeDefinition, evalPreludeSummary } from "../eval/preludes";
import { isEvalBridgeToolCallable } from "../eval/tool-bridge-policy";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import {
	getActiveSkills,
	type LoadSkillsResult,
	loadSkills,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "../extensibility/skills";
import { type LocalProtocolOptions } from "../internal-urls";
import { stripXdUrlPrefix, XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";
import { sameItems } from "@oh-my-pi/pi-tui/native/memo";
import { deduplicateMCPToolsByName, resolveMCPToolAlias } from "../mcp/tool-bridge";
import {
	appendRecallBlock,
	type ConversationRecall,
	findDeliveredRecall,
	findDeliveredRecallChanges,
	isRecordedRecall,
	type RecallChangesReport,
} from "../memory-backend/recall-entry";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import { MEMORY_BACKEND_TOOL_NAMES } from "../memory-backend/tool-names";
import { invalidateToolSchemaMetadata } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { MemoryBackendStartOptions, MemoryPromptPreparation } from "../memory-backend/types";
import { publishedAgentDiscovery } from "../task/discovery-snapshots";
import { getPerCallModelAdvertisement, type PerCallModelAdvertisement } from "../task/model-approval";
import { cfgTaskDisabledAgents, perCallModelEnabled } from "../task/settings";
import { resolveSpawnPolicy, spawnableAgents } from "../task/spawn-policy";
import type { AgentDefinition } from "../task/types";
import evalPreludeNoticePrompt from "../prompts/system/eval-prelude-notice.md" with { type: "text" };
import perCallModelNoticePrompt from "../prompts/system/per-call-model-notice.md" with { type: "text" };
import sessionAgentNoticePrompt from "../prompts/system/session-agent-notice.md" with { type: "text" };
import heldToolRefusalPrompt from "../prompts/system/settings-held-tool-refusal.md" with { type: "text" };
import settingsNoticePrompt from "../prompts/system/settings-notice.md" with { type: "text" };
import skillNoticePrompt from "../prompts/system/skill-notice.md" with { type: "text" };
import taskAgentNoticePrompt from "../prompts/system/task-agent-notice.md" with { type: "text" };
import toolRosterNoticePrompt from "../prompts/system/tool-roster-notice.md" with { type: "text" };
import xdevMountNoticePrompt from "../prompts/system/xdev-mount-notice.md" with { type: "text" };
import { isMCPToolName, normalizeToolNames } from "../tools/builtin-names";
import {
	approvalRestrictions,
	denyError,
	resolveApproval,
	resolveApprovalFromContext,
	restrictedFolderReason,
} from "../tools/approval";
import { getApprovalGrants } from "../tools/approval-cache";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { isFilesystemSourcePath } from "../tools/path-utils";
import { supportsExternalThinking } from "../tools/think";
import { ToolAbortError } from "../tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	isMountableUnderXdev,
	listXdevTools,
	planXdevPromptDocs,
	type XdevState,
	xdevDocsFor,
	xdevEntries,
} from "../tools/xdev";
import type { EditModeSetting } from "../edit/settings";
import { resolveEditMode } from "../utils/edit-mode";
import { TOOL_DECLARATION_KEYS } from "../utils/tool-declarations";
import {
	extractPermissionLocations,
	getPermissionIntent,
	PERMISSION_OPTIONS,
	PERMISSION_OPTIONS_BY_ID,
	PERMISSION_REQUIRED_TOOLS,
} from "./acp-permission-gate";
import type { ClientBridge, ClientBridgePermissionOutcome } from "./client-bridge";
import { toolReadsSkillUris } from "../system-prompt";

import type { CustomMessage } from "./messages";
import { SESSION_AGENT_NOTICE_TYPE } from "./queued-messages";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

import { cfgDisabledExtensions, cfgSkills, type SkillsSettings } from "../extensibility/settings";
import { cfgExternalThinking, cfgIncludeModelInPrompt, cfgInlineToolDescriptors, cfgSkillful } from "./settings";
import { cfgStartupQuiet } from "../modes/settings";
import {
	cfgToolsApproval,
	cfgToolsApprovalMode,
	cfgToolsXdevDocs,
	cfgToolsXdevInlineDevices,
	cfgToolsXdevNotices,
} from "../tools/settings";

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionToolsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Session-local extension roots (explicit + mode + configured) for post-startup reloads. */
	effectiveExtensionRoots(): EffectiveExtensionRoots;
	modelRegistry: ModelRegistry;
	extensionRunner(): ExtensionRunner | undefined;
	clientBridge(): ClientBridge | undefined;
	agentKind(): "main" | "sub";
	isDisposed(): boolean;
	isStreaming(): boolean;
	/**
	 * Aborts once per user steering-message arrival; the ACP permission gate
	 * races it against its elicit so a steer supersedes an open dialog.
	 */
	steeringArrivalSignal(): AbortSignal;
	/**
	 * Monotonic count of steering arrivals fired so far. The permission gate
	 * snapshots it when it parks, so its read of
	 * {@link steeringArrivalAdmitted} covers exactly the arrivals inside its
	 * own wait window — never a group that fired before the dialog opened.
	 */
	steeringArrivalSeq(): number;
	/**
	 * The user-message groups admitted by the steering arrivals after `since`
	 * (a snapshot from {@link steeringArrivalSeq}), flattened in admission
	 * order — first post-park arrival first — or `undefined` when none. The
	 * permission gate promotes exactly these messages: an agent-authored
	 * steer enqueued in the same window never fired the signal and must not
	 * ride the promotion ahead of the user's superseding message, and an
	 * earlier pre-dialog steer must not be re-promoted by a later dialog.
	 */
	steeringArrivalAdmitted(since?: number): readonly AgentMessage[] | undefined;
	/**
	 * Release a park snapshot taken by {@link steeringArrivalSeq} once its
	 * dialog ends without superseding (the read in
	 * {@link steeringArrivalAdmitted} releases it on the supersede path).
	 * Without this, sessions that steer often but rarely supersede a dialog
	 * would pin every arrival group since that stale snapshot forever.
	 */
	steeringArrivalRelease(seq: number): void;
	queuedMessageCount(): number;
	planModeEnabled(): boolean;
	/** The session's spawn policy (`spawns`): which agents it may spawn. */
	sessionSpawns(): string;
	model(): Model | undefined;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	clearInheritedProviderPromptCacheKey(): void;
	/**
	 * Whether the next request, sent with the base prompt `promptDigest` names, reads the prompt cache entry the
	 * branch's newest cached reply left: the entry has not lapsed, and the request asks for it on the same model and
	 * retention with no compaction since. The tool definitions are not compared: tools that register late may not be
	 * in yet, and the first request compares them (the entry it reads counts as lapsed when they differ).
	 */
	transcriptPromptCacheLive(promptDigest: string): boolean;
	/**
	 * Digest of the tool definitions the next primary request declares, as the wire carries them, comparable with the
	 * {@link TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE} records on the branch; with `tools`, what it would declare with them
	 * in place of the active tools.
	 */
	toolDefinitionsDigest(tools?: AgentTool[]): string;
	clearMemoryPromotionSnapshot(): void;
	captureMemoryPromotionSnapshot(prompt: string[]): void;
	/**
	 * Records what the recall the memory backend adopted leaves the conversation carrying: `recall`, as a hidden
	 * `memory-recall` message or as the system prompt's own last block (undefined when the backend adopted none), and
	 * `changes`, the reports of what changed in a reused recall's memories it carries as hidden `memory-recall-changes`
	 * messages, oldest first (none for a fresh recall). Each request sends a hidden one again where its context lacks
	 * it, and each prompt build appends the block.
	 */
	adoptMemoryRecall(recall: ConversationRecall | undefined, changes: readonly RecallChangesReport[]): void;
	/** The recall the conversation carries ({@link adoptMemoryRecall}): the one it adopted from the transcript at start. */
	memoryRecall(): ConversationRecall | undefined;
	/**
	 * The scope the live memory backend's first-turn recall reads, as its records name it: a recall the branch records,
	 * or delivers hidden, under another scope is not the conversation's.
	 */
	memoryRecallScope(): string | undefined;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	notifyCommandMetadataChanged(): void;
	localProtocolOptions(): LocalProtocolOptions;
	/** Live enabled eval preludes; candidates for the next base rebuild's advertised snapshot. */
	evalPreludes(): readonly EvalPreludeDefinition[];
	/** Live user-tagged model agents; candidates for the next base rebuild's advertised snapshot. */
	sessionAgents(): readonly AgentDefinition[];
	/** Runs a wait for the user's answer, such as an ACP client's permission request. */
	waitForUser<T>(dialog: () => Promise<T>): Promise<T>;
}

/** Registry delta applied by the SDK's settings-gated tool reconcile. */
export interface SettingsGatedToolDelta {
	/** Newly registered names: `builtIn` marks built-in factory provenance, `activate` joins the enabled set. */
	readonly added: readonly { readonly name: string; readonly builtIn: boolean; readonly activate: boolean }[];
	/** Names whose registry entries were removed. */
	readonly removed: readonly string[];
	/** `xd://` state after following `tools.xdev`; undefined while mounting is off. */
	readonly xdev: XdevState | undefined;
}

/** Options of a rebuild a settings change may start. */
export interface SettingsChangeOptions {
	/** The changed settings that started the rebuild, which holds it on a bound prompt. */
	settingsChange?: readonly SettingChange[];
}

/** Options of a base prompt rebuild ({@link SessionTools.refreshBaseSystemPrompt}). */
export interface BasePromptRebuildOptions extends SettingsChangeOptions {
	/**
	 * The rebuild finishes work a settings change, or this process's startup, started in the background (the
	 * mental-model load of a memory backend state the change or the startup installed): while a settings rebuild is
	 * held, or the restored transcript prompt is kept in place of this process's own build, it joins that change and
	 * goes out with it.
	 */
	joinsHeldChange?: boolean;
}

/**
 * Renders the base prompt for an active tool set. `xdev` is the `xd://` state
 * to render: the live state, or a frozen prefix's committed roster when a
 * rebuild re-renders it. Supplied by `sdk.ts`; called on every prompt rebuild.
 * `settingsRead` holds each setting the render read, with the value it read
 * (`trackSettingsReads`): a bound prompt holds a change of any of them.
 */
export type SystemPromptRebuilder = (
	toolNames: string[],
	tools: Map<string, AgentTool>,
	xdev: XdevState | undefined,
) => Promise<{
	systemPrompt: string[];
	xdevCatalogNames?: readonly string[];
	settingsRead?: ReadonlyMap<AnySetting, unknown>;
}>;

interface SessionToolsOptions {
	autoApprove?: boolean;
	toolRegistry?: Map<string, AgentTool>;
	createVibeTools?: () => AgentTool[];
	/** Creates the private `think` scratchpad tool for runtime setting changes. */
	createThinkTool?: () => Promise<AgentTool | null>;
	builtInToolNames?: Iterable<string>;
	presentationPinnedToolNames?: ReadonlySet<string>;
	/** MCP tool names whose current registry entries came from the manager snapshot. */
	mcpManagerToolNames?: Iterable<string>;
	ensureWriteRegistered?: () => Promise<boolean>;
	isDeviceOnlyWrite?: () => boolean;
	setDeviceOnlyWrite?: (enabled: boolean) => void;
	setPendingFullWriteDescription?: (enabled: boolean) => void;
	/** Registers the hidden `goal` tool when goal mode is enabled at runtime. */
	ensureGoalRegistered?: () => Promise<boolean>;
	/**
	 * Re-resolves settings-gated tools against live settings, mutating the shared
	 * registry; `isBuiltIn` reports this session's built-in provenance.
	 */
	reconcileSettingsGatedTools?: (isBuiltIn: (name: string) => boolean) => Promise<SettingsGatedToolDelta>;
	rebuildSystemPrompt?: SystemPromptRebuilder;
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	xdev?: XdevState;
	setActiveToolNames?: (names: Iterable<string>) => void;
	baseSystemPrompt: string[];
	/** Each setting the build of {@link baseSystemPrompt} read, with the value it read ({@link SystemPromptRebuilder}). */
	baseSettingsRead?: ReadonlyMap<AnySetting, unknown>;
	/**
	 * Digest of the prompt inputs the operator gives explicitly (custom prompt, template, appended text), or
	 * undefined when they cannot be compared. A resumed transcript's stored prompt is sent again only under the
	 * digest it was stored with (see `SessionTools.#restoreTranscriptPrompt`).
	 */
	operatorPromptDigest?: string;
	skills?: Skill[];
	skillWarnings?: SkillWarning[];
	skillsSettings?: SkillsSettings;
	skillsReloadable?: boolean;
}

interface SystemPromptPreparation {
	systemPrompt: string[];
	/** Each setting the render read, with the value it read; undefined for a preparation that keeps the base. */
	settingsRead?: ReadonlyMap<AnySetting, unknown>;
	/** Memory backend note to deliver with the turn ({@link MemoryPromptPreparation.notice}). */
	memoryNotice?: MemoryPromptPreparation["notice"];
	/** Publish staged state at validated delivery; false declines the prepared turn without mutation. */
	commit?(): boolean;
}

/**
 * No settings: {@link SessionTools.#promptSettingsRead} of a prompt whose build reported none, and
 * {@link SessionTools.#promptUnreadChanges} while no setting that build did not read has changed.
 */
const NO_SETTINGS: ReadonlyMap<AnySetting, unknown> = new Map();

export interface MountedMCPToolRouteSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

export interface MountedMCPToolRoute {
	readonly mcpServerName: string;
	readonly mcpToolName: string;
	readonly name: string;
}

export interface MCPXdevGuidanceMapping extends MountedMCPToolRoute {
	readonly label: string;
	readonly path: string;
}

export interface MCPXdevGuidanceProjection {
	readonly mappings: readonly MCPXdevGuidanceMapping[];
	readonly hasOmittedMappings: boolean;
}

const MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH = 4000;
const MAX_MCP_XDEV_GUIDANCE_MAPPINGS = 64;

/** Yield exact mounted MCP ownership and route metadata. */
export function* collectMountedMCPToolRoutes(
	tools: Iterable<MountedMCPToolRouteSource>,
): Generator<MountedMCPToolRoute> {
	for (const tool of tools) {
		if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") continue;
		yield {
			mcpServerName: tool.mcpServerName,
			mcpToolName: tool.mcpToolName,
			name: tool.name,
		};
	}
}

function formatMCPXdevGuidanceLabel(label: string): string {
	return (JSON.stringify(label) ?? '""')
		.replaceAll("`", "\\u0060")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/**
 * Project exact live MCP routes into the bounded, Markdown-safe mapping data
 * rendered by the static MCP guidance prompt.
 */
export function projectMountedMCPXdevGuidance(routes: Iterable<MountedMCPToolRoute>): MCPXdevGuidanceProjection {
	const mappings: MCPXdevGuidanceMapping[] = [];
	let remainingMappingDataLength = MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH;
	let hasOmittedMappings = false;
	for (const route of routes) {
		const rawMappingDataLength = route.mcpToolName.length + XD_URL_PREFIX.length + route.name.length;
		if (mappings.length >= MAX_MCP_XDEV_GUIDANCE_MAPPINGS || rawMappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		const label = formatMCPXdevGuidanceLabel(route.mcpToolName);
		const path = `${XD_URL_PREFIX}${route.name}`;
		const mappingDataLength = label.length + path.length;
		if (mappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		mappings.push({ ...route, label, path });
		remainingMappingDataLength -= mappingDataLength;
	}
	return { mappings, hasOmittedMappings };
}

const TOOL_ROSTER_NOTICE_MESSAGE_TYPE = "tool-roster-notice";
const XDEV_MOUNT_NOTICE_MESSAGE_TYPE = "xdev-mount-notice";
const EVAL_PRELUDE_NOTICE_MESSAGE_TYPE = "eval-prelude-notice";
const SKILL_NOTICE_MESSAGE_TYPE = "skill-notice";
const TASK_AGENT_NOTICE_MESSAGE_TYPE = "task-agent-notice";
const PER_CALL_MODEL_NOTICE_MESSAGE_TYPE = "per-call-model-notice";
const SETTINGS_NOTICE_MESSAGE_TYPE = "settings-notice";

/** Custom entry holding the digest of the base prompt the branch's primary model calls are built from. */
const SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE = "system-prompt-digest";

/**
 * Custom entry holding the digest of the tool definitions the branch's primary model calls declare, as the wire
 * carries them: the part of the cached prefix that comes before the system prompt.
 */
const TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE = "tool-definitions-digest";

/** What a primary model call was sent with, as the branch records it before the call's reply. */
interface ModelCallDigests {
	/** Digest of its base prompt ({@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE}). */
	readonly prompt: string;
	/** Digest of its tool definitions ({@link TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE}). */
	readonly tools: string;
}

/** Custom entry holding the base prompt blocks a {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} record names. */
const SYSTEM_PROMPT_CUSTOM_TYPE = "system-prompt";

/** Data of a {@link SYSTEM_PROMPT_CUSTOM_TYPE} entry: a prompt a resumed process may send again. */
interface StoredSystemPrompt {
	/** Digest of {@link blocks}, as {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} records it. */
	digest: string;
	/** Base prompt blocks, before a per-turn hook override. */
	blocks: string[];
	/** The top-level tools the blocks list ({@link PromptListing.toolNames}). */
	toolNames: string[];
	/** The `xd://` devices the blocks list ({@link PromptListing.xdevNames}). */
	xdevNames: string[];
	/** The skills the blocks list, each with the description they give ({@link PromptListing.skills}). */
	skills: Array<{ name: string; description: string }>;
	/** {@link SessionToolsOptions.operatorPromptDigest} of the process that stored them. */
	operatorDigest: string;
	/**
	 * Each setting the build of the blocks read, with the value it read ({@link heldSettingRecord}: a credential by id
	 * only, an unset setting without a value): the values a resumed process that sends the blocks again names as the
	 * ones they were built with. Absent from records written before it was added.
	 */
	settingsRead?: HeldSettingRecord[];
}

/**
 * Custom entry recording that the base prompt a {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} record names withholds a
 * change from the model, and since when: a settings rebuild held on it, or a resumed process's own build it was
 * restored in place of. A resumed process that restores that prompt keeps the change waiting no longer than the
 * process that recorded it would have ({@link WITHHELD_CHANGE_MAX_AGE_MS}), whichever branch of the session holds
 * the record, until a {@link SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE} record ends it.
 */
const SYSTEM_PROMPT_HOLD_CUSTOM_TYPE = "system-prompt-hold";

/** Data of a {@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE} entry. */
interface SystemPromptHold {
	/** Digest of the base prompt that withholds the change, as {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} records it. */
	digest: string;
	/** When the change was made (Unix milliseconds), by the clock of the process that recorded it. */
	since: number;
}

/**
 * Custom entry recording that the base prompt a {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} record names withholds
 * nothing any longer although it keeps its bytes: the change each {@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE} record before
 * it names went out in the tool definitions alone, or nothing of it was left to withhold. A resumed process that
 * restores that prompt dates what it withholds from a later hold record, or from the restore.
 */
const SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE = "system-prompt-hold-end";

/** Data of a {@link SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE} entry. */
interface SystemPromptHoldEnd {
	/** Digest of the base prompt whose holds end, as {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} records it. */
	digest: string;
}

/**
 * Custom entry naming the settings a change the base prompt a {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} record names
 * withholds holds ({@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE}), each with the value that prompt was built with, and the
 * change ({@link SettingsNoticeDetails.hold}): what a resumed process that restores that prompt tells the model of
 * where the settings notices in its context did not ({@link SessionTools.takeSettingsNotice}). Each names the
 * settings no such record of the same change names since the branch last recorded another prompt or ended a hold on
 * this one.
 */
const SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE = "system-prompt-held-settings";

/**
 * A setting a {@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE} entry names, or a settings notice gives
 * ({@link SettingsNoticeDetails.values}), with its value.
 */
interface HeldSettingRecord {
	/** The setting's id. */
	id: string;
	/** The value; absent when the setting is unset, and for a credential, whose value is never recorded. */
	value?: unknown;
}

/** Data of a {@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE} entry. */
interface SystemPromptHeldSettings {
	/** Digest of the base prompt that withholds the change, as {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} records it. */
	digest: string;
	/** The {@link HeldSettings.id} of the change. */
	hold: string;
	/** Each setting the change holds, with the value the prompt was built with. */
	settings: HeldSettingRecord[];
}

/** What the session records of a change the base prompt a digest names withholds, on any branch. */
interface RecordedHold {
	/** When the change was made: the earliest {@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE} record's time. */
	since: number;
	/** Each setting a {@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE} record names, by id: the earliest record of it. */
	settings: ReadonlyMap<string, HeldSettingRecord>;
}

/**
 * Longest a change the system prompt withholds to keep the cached prefix waits: the first request made this long after
 * the change carries it, however warm the cache stays, unless a lapse or a cut that rewrites every message sent it
 * earlier ({@link withheldChangeDue}).
 */
const WITHHELD_CHANGE_MAX_AGE_MS = 5 * 60_000;

/**
 * A change the base prompt withholds from the model to keep the cached prefix: a settings rebuild held on a bound
 * prompt, or this process's own build behind a restored transcript prompt.
 */
interface WithheldChange {
	/** Digest of the base prompt that withholds the change, as {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} records it. */
	readonly digest: string;
	/**
	 * When the change was made (Unix milliseconds), never later than the clock: {@link withheldChangeDue} moves a
	 * time the clock has not reached (a clock set back since, a record a clock running fast wrote) to the clock's.
	 */
	since: number;
	/** A cut that rewrites every message, or a move to another transcript, ended the reason to withhold it. */
	due: boolean;
	/**
	 * The branch view last found to record the change at {@link since} ({@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE}) and
	 * each setting it holds ({@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE}) with no record of another prompt and no
	 * end of a hold on this one after those records, or given such records; a reply under the change on another view
	 * records it there ({@link SessionTools.recordReplyPrompt}). Undefined before then, once the change ended, once
	 * its time moved to the clock's, and once it holds a setting more.
	 */
	recordedOn: readonly SessionEntry[] | undefined;
	/**
	 * The session holds a {@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE} record of the change that no
	 * {@link SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE} record ended, so ending the change ends the record too.
	 */
	recorded: boolean;
	/**
	 * The session whose transcript the prompt withholds the change from: its records are written to that session's
	 * file alone, never to one the session switched to since; a copy of the transcript the conversation goes on in
	 * takes its place ({@link SessionTools.followTranscriptCopy}).
	 */
	sessionId: string;
}

/**
 * Whether `change` goes out at the next request: the prompt cache entry it keeps has `lapsed` (or the next request
 * cannot read it), the reason to withhold it ended ({@link WithheldChange.due}), or it is
 * {@link WITHHELD_CHANGE_MAX_AGE_MS} old, whatever requests kept the entry warm meanwhile. A change dated after the
 * clock is dated at the clock first, so it waits at most that long by this clock.
 */
function withheldChangeDue(change: WithheldChange, lapsed: boolean): boolean {
	const now = Date.now();
	if (change.since > now) {
		change.since = now;
		// A record of the later time does not record this one.
		change.recordedOn = undefined;
	}
	return lapsed || change.due || now - change.since >= WITHHELD_CHANGE_MAX_AGE_MS;
}

/** When `change` goes out at the latest, as the settings notice and the held-tool refusal give it (ISO 8601). */
function withheldChangeDeadline(change: WithheldChange): string {
	return new Date(change.since + WITHHELD_CHANGE_MAX_AGE_MS).toISOString();
}

/**
 * Least time between two rediscoveries started by `skill://` names no loaded skill owns, so a typo
 * read in a loop (a shell resolving one URL per spawned command) costs one pass per interval
 * rather than one per read, while a skill installed after a miss is found once it has passed.
 */
const UNKNOWN_SKILL_REDISCOVERY_INTERVAL_MS = 2_000;

/** Equal digests mean equal prompt blocks. */
function systemPromptDigest(blocks: readonly string[]): string {
	let hash = BigInt(blocks.length);
	for (const block of blocks) hash = Bun.hash.wyhash(block, hash);
	return hash.toString(16);
}

/** The members of a tool that shape what a request declares for it besides its name; getters may render them. */
type ToolDeclarationFields = Pick<AgentTool, Exclude<keyof Tool, "name"> | "intent">;

/** The keys of {@link ToolDeclarationFields}: every {@link Tool} field but its name, and the tool's `intent`. */
const TOOL_DECLARATION_FIELD_KEYS: readonly (keyof ToolDeclarationFields)[] = [
	...TOOL_DECLARATION_KEYS.filter((key): key is Exclude<keyof Tool, "name"> => key !== "name"),
	"intent",
];

/** What a request declares for `tool`: its names and each of its {@link ToolDeclarationFields}. */
function toolDeclaration(tool: Pick<AgentTool, "name" | "label"> & ToolDeclarationFields): string {
	return JSON.stringify([tool.name, tool.label, ...TOOL_DECLARATION_FIELD_KEYS.map(key => tool[key])]);
}

/** Each kept declaration's {@link keptDeclaration} string, with the names it was rendered under. */
const keptDeclarations = new WeakMap<
	ToolDeclarationFields,
	Pick<AgentTool, "name" | "label"> & { declaration: string }
>();

/**
 * What a request declares for `own` under the kept declaration `fields`: `own`'s names with `fields`. Kept fields are
 * a snapshot that never changes, so the string is rendered once for them and the names they go with.
 */
function keptDeclaration(own: Pick<AgentTool, "name" | "label">, fields: ToolDeclarationFields): string {
	const { name, label } = own;
	const kept = keptDeclarations.get(fields);
	if (kept?.name === name && kept.label === label) return kept.declaration;
	const declaration = toolDeclaration({ ...fields, name, label });
	keptDeclarations.set(fields, { name, label, declaration });
	return declaration;
}

/** `tool`'s {@link ToolDeclarationFields} as they read now. */
function toolDeclarationFields(tool: AgentTool): ToolDeclarationFields {
	const fields: Partial<Record<keyof ToolDeclarationFields, unknown>> = {};
	for (const key of TOOL_DECLARATION_FIELD_KEYS) fields[key] = tool[key];
	return fields as ToolDeclarationFields;
}

/**
 * `target` with each own member of `overrides` read in its place (a getter of `overrides` runs on each read). Every
 * other member is the target's own, read through `run` when given; a method runs on the target itself, through
 * `run` when given, so a target that keeps private state still works. Each method is wrapped once.
 */
function forwardingProxy<T extends object>(target: T, overrides: object, run?: <R>(use: () => R) => R): T {
	const methods = new Map<PropertyKey, unknown>();
	return new Proxy(target, {
		get(object, property) {
			if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
			const value: unknown = run
				? run(() => Reflect.get(object, property, object))
				: Reflect.get(object, property, object);
			if (typeof value !== "function") return value;
			let method = methods.get(property);
			if (method === undefined) {
				method = run ? (...args: unknown[]) => run(() => value.apply(object, args)) : value.bind(object);
				methods.set(property, method);
			}
			return method;
		},
	});
}

/** The digest a branch entry records, `undefined` for a malformed record, or `null` when it is not a record. */
export function promptDigestOfEntry(entry: SessionEntry): string | undefined | null {
	if (entry.type !== "custom" || entry.customType !== SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE) return null;
	return typeof entry.data === "string" ? entry.data : undefined;
}

/** The tools digest a branch entry records, `undefined` for a malformed record, or `null` when it is not a record. */
export function toolsDigestOfEntry(entry: SessionEntry): string | undefined | null {
	if (entry.type !== "custom" || entry.customType !== TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE) return null;
	return typeof entry.data === "string" ? entry.data : undefined;
}

/** The newest record of one kind a branch view holds, and how much of the view was scanned for it. */
interface NewestRecordScan {
	branch: readonly SessionEntry[];
	scanned: number;
	value: string | undefined;
}

/**
 * Folds `branch` into `scan` for the newest value `read` finds (`null`: the entry is no such record). The session
 * manager's memoized view only grows in place, so a later read of the same array scans just the appended entries;
 * another array is scanned back from its end. Returns the scan to keep.
 */
function scanNewestRecord(
	scan: NewestRecordScan | undefined,
	branch: readonly SessionEntry[],
	read: (entry: SessionEntry) => string | undefined | null,
): NewestRecordScan {
	if (scan?.branch === branch) {
		for (let index = scan.scanned; index < branch.length; index++) {
			const value = read(branch[index]);
			if (value !== null) scan.value = value;
		}
		scan.scanned = branch.length;
		return scan;
	}
	for (let index = branch.length - 1; index >= 0; index--) {
		const value = read(branch[index]);
		if (value !== null) return { branch, scanned: branch.length, value };
	}
	return { branch, scanned: branch.length, value: undefined };
}

/**
 * Applies a roster or `xd://` mount notice's `details` to the names the model was told of: adds each name they list
 * as `added`, then drops each they list as `removed`. False, leaving `known` as it is, when they carry no such lists.
 */
function applyNameNotice(known: Set<string>, details: unknown): boolean {
	if (!isRecord(details) || !isStringList(details.added) || !isStringList(details.removed)) return false;
	for (const name of details.added) known.add(name);
	for (const name of details.removed) known.delete(name);
	return true;
}

/**
 * Applies the tool lists of a settings notice's `details` ({@link SettingsNoticeDetails}) to what the notices before it
 * told, `disabled` (calls refused) and `enabled` (available after the rebuild), so the newest notice that names a tool
 * decides its state: a tool it gives as disabled leaves `enabled`, one it gives as enabled leaves `disabled`, one that
 * runs again leaves `disabled`, and one no longer enabled leaves `enabled`. A list that is not one of names changes
 * nothing.
 */
function applyNoticeToolLists(disabled: Set<string>, enabled: Set<string>, details: Record<string, unknown>): void {
	if (isStringList(details.disabledTools)) {
		for (const name of details.disabledTools) {
			disabled.add(name);
			enabled.delete(name);
		}
	}
	if (isStringList(details.reenabledTools)) for (const name of details.reenabledTools) disabled.delete(name);
	if (isStringList(details.enabledTools)) {
		for (const name of details.enabledTools) {
			enabled.add(name);
			disabled.delete(name);
		}
	}
	if (isStringList(details.noLongerEnabledTools)) {
		for (const name of details.noLongerEnabledTools) enabled.delete(name);
	}
}

/** A context's custom messages by `customType`, each list in context order ({@link customMessagesByType}). */
export type CustomMessagesByType = ReadonlyMap<string, readonly CustomMessage[]>;

const NO_CUSTOM_MESSAGES: readonly CustomMessage[] = [];

/** Reads `messages` once into its custom messages by `customType`, each list in the order `messages` holds them. */
export function customMessagesByType(messages: readonly AgentMessage[]): CustomMessagesByType {
	const byType = new Map<string, CustomMessage[]>();
	for (const message of messages) {
		if (message.role !== "custom") continue;
		const list = byType.get(message.customType);
		if (list) list.push(message);
		else byType.set(message.customType, [message]);
	}
	return byType;
}

/** The custom messages of `customType` in `byType`, in context order. */
export function customMessagesOf(byType: CustomMessagesByType, customType: string): readonly CustomMessage[] {
	return byType.get(customType) ?? NO_CUSTOM_MESSAGES;
}

/** Whether `value` is a skill listed by name with its description, as a {@link StoredSystemPrompt} stores each. */
function isListedSkill(value: unknown): value is StoredSystemPrompt["skills"][number] {
	return isRecord(value) && typeof value.name === "string" && typeof value.description === "string";
}

/** Whether `value` lists skills by name, each with a description, as a {@link StoredSystemPrompt} stores them. */
function isListedSkills(value: unknown): value is StoredSystemPrompt["skills"] {
	return Array.isArray(value) && value.every(isListedSkill);
}

/**
 * The prompt a branch entry stores, or `undefined` when it is no such record or a malformed one: one without the
 * devices and skills it lists cannot tell the `xd://` and skill notices what the model holds. A record whose
 * {@link StoredSystemPrompt.settingsRead} is missing or malformed is read without it.
 */
function storedPromptOfEntry(entry: SessionEntry): StoredSystemPrompt | undefined {
	if (entry.type !== "custom" || entry.customType !== SYSTEM_PROMPT_CUSTOM_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	const { digest, blocks, toolNames, xdevNames, skills, operatorDigest, settingsRead } = entry.data;
	if (typeof digest !== "string" || typeof operatorDigest !== "string" || !isListedSkills(skills)) return undefined;
	if (!isStringList(blocks) || !isStringList(toolNames) || !isStringList(xdevNames)) return undefined;
	const stored: StoredSystemPrompt = { digest, blocks, toolNames, xdevNames, skills, operatorDigest };
	if (isHeldSettingRecords(settingsRead)) stored.settingsRead = settingsRead;
	return stored;
}

/** The change a branch entry records as withheld, or `undefined` when it is no such record or a malformed one. */
function promptHoldOfEntry(entry: SessionEntry): SystemPromptHold | undefined {
	if (entry.type !== "custom" || entry.customType !== SYSTEM_PROMPT_HOLD_CUSTOM_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	const { digest, since } = entry.data;
	return typeof digest === "string" && typeof since === "number" ? { digest, since } : undefined;
}

/** The digest of the prompt whose holds a branch entry ends, or `undefined` when it is no such record. */
function promptHoldEndOfEntry(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	const { digest } = entry.data;
	return typeof digest === "string" ? digest : undefined;
}

/** Whether `value` names a setting with its value, as a {@link HeldSettingRecord} does. */
function isHeldSettingRecord(value: unknown): value is HeldSettingRecord {
	return isRecord(value) && typeof value.id === "string";
}

/** Whether `value` lists settings with their values, as {@link HeldSettingRecord}s. */
function isHeldSettingRecords(value: unknown): value is HeldSettingRecord[] {
	return Array.isArray(value) && value.every(isHeldSettingRecord);
}

/** The held settings a branch entry names, or `undefined` when it is no such record or a malformed one. */
function heldSettingsOfEntry(entry: SessionEntry): SystemPromptHeldSettings | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE ||
		!isRecord(entry.data)
	) {
		return undefined;
	}
	const { digest, hold, settings } = entry.data;
	if (typeof digest !== "string" || typeof hold !== "string" || !isHeldSettingRecords(settings)) return undefined;
	return { digest, hold, settings };
}

/** `setting` with `value`, as a {@link HeldSettingRecord} gives it. */
function heldSettingRecord(setting: AnySetting, value: unknown): HeldSettingRecord {
	return setting.isCredential || value === undefined ? { id: setting.id } : { id: setting.id, value };
}

/** Index of the newest entry of `branch` that records a prompt other than `digest`; -1 when none does. */
function otherPromptRecordIndex(branch: readonly SessionEntry[], digest: string): number {
	return branch.findLastIndex(entry => {
		const recorded = promptDigestOfEntry(entry);
		return recorded !== null && recorded !== digest;
	});
}

/** Tools one hidden {@link TOOL_ROSTER_NOTICE_MESSAGE_TYPE} message announced or withdrew. */
interface ToolRosterNoticeDetails {
	added: string[];
	removed: string[];
}

/**
 * Structured payload persisted on each {@link XDEV_MOUNT_NOTICE_MESSAGE_TYPE}
 * custom message: the devices it announced and withdrew. Lets a request's
 * context tell which dynamic devices the model has already been told about, so
 * a reconnecting host does not re-announce (and splice a redundant developer
 * message).
 */
interface XdevMountNoticeDetails {
	added: string[];
	removed: string[];
}

/** A device a legacy mount notice's text lists as mounted (`added`) or no longer mounted (`removed`). */
type LegacyMountNoticeLine = readonly ["added" | "removed", string];

/** Each legacy mount notice's {@link legacyMountNoticeLines}, parsed once: a saved message is never edited. */
const legacyMountNoticeParses = new WeakMap<CustomMessage, readonly LegacyMountNoticeLine[]>();

/**
 * The devices a mount notice saved without structured details lists in the two stable inventory sections of its
 * rendered text, in order. Releases before structured notice details persisted only the rendered prompt; replaying
 * these keeps the first resume after upgrading from announcing every dynamic device once.
 */
function legacyMountNoticeLines(message: CustomMessage): readonly LegacyMountNoticeLine[] {
	const { content } = message;
	if (typeof content !== "string") return [];
	const parsed = legacyMountNoticeParses.get(message);
	if (parsed) return parsed;
	const lines: LegacyMountNoticeLine[] = [];
	let section: "added" | "removed" | undefined;
	for (const line of content.split("\n")) {
		if (line === "These tools became available:") {
			section = "added";
			continue;
		}
		if (line.startsWith("No longer mounted")) {
			section = "removed";
			continue;
		}
		if (line === "Configured inline device docs:" || line === "</system-notice>") break;
		if (line.startsWith("Read `xd://<tool>`")) {
			section = undefined;
			continue;
		}
		if (!section) continue;
		const match = /^- xd:\/\/(\S+?)(?:\s+—|$)/.exec(line);
		const name = match?.[1];
		if (name) lines.push([section, name]);
	}
	legacyMountNoticeParses.set(message, lines);
	return lines;
}

/** Prelude names added/removed by one hidden {@link EVAL_PRELUDE_NOTICE_MESSAGE_TYPE} message. */
interface EvalPreludeNoticeDetails {
	added: string[];
	removed: string[];
}

/** Skills one hidden {@link SKILL_NOTICE_MESSAGE_TYPE} message announced or withdrew. */
interface SkillNoticeDetails {
	announced: Array<{ name: string; description: string }>;
	removed: string[];
}

/**
 * Agents one hidden {@link SESSION_AGENT_NOTICE_TYPE} or {@link TASK_AGENT_NOTICE_MESSAGE_TYPE} message listed as
 * available, new or with an edited description, and the ones it withdrew.
 */
interface AgentNoticeDetails {
	added: string[];
	removed: string[];
	/** The description the notice gave each `added` agent; notices written before edits were announced lack it. */
	descriptions: Record<string, string>;
}

/**
 * What `live` changes in a list the model knows, `known`: each name it was given with the description it read,
 * undefined when that is not known. Returns the entries new to it, the ones whose description changed, and the
 * names `live` no longer has.
 */
function listingDelta<T extends { name: string; description: string }>(
	known: ReadonlyMap<string, string | undefined>,
	live: readonly T[],
): { added: T[]; updated: T[]; removed: string[] } {
	const liveNames = new Set(live.map(entry => entry.name));
	const added = live.filter(entry => !known.has(entry.name));
	const updated = live.filter(entry => {
		const description = known.get(entry.name);
		return description !== undefined && description !== entry.description;
	});
	const removed = [...known.keys()].filter(name => !liveNames.has(name));
	return { added, updated, removed };
}

/** Whether `value` is the approvals a {@link PER_CALL_MODEL_NOTICE_MESSAGE_TYPE} message restated. */
function isPerCallModelAdvertisement(value: unknown): value is PerCallModelAdvertisement {
	return (
		isRecord(value) &&
		Array.isArray(value.roles) &&
		value.roles.every(entry => isRecord(entry) && typeof entry.role === "string" && isStringList(entry.patterns)) &&
		isStringList(value.allowlist) &&
		typeof value.parentModelWithheld === "boolean"
	);
}

/**
 * The settings a change the base prompt withholds holds, as its settings notices tell the model of them
 * ({@link SessionTools.takeSettingsNotice}): a held settings rebuild's, or a restored transcript prompt's, which the
 * session's records name ({@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE}).
 */
interface HeldSettings {
	/** Identifies the change's settings notices on any branch ({@link SettingsNoticeDetails.hold}). */
	readonly id: string;
	/** Each changed setting's value the withholding prompt was built with. */
	readonly before: Map<AnySetting, unknown>;
	/** What the change's settings notices told the model, each with the ones before it on its branch, by number. */
	readonly notices: SettingsNoticeState[];
}

/**
 * A rebuild that a settings change started while the prompt was bound, held until it is due
 * ({@link withheldChangeDue}: five minutes after the change at the latest; see
 * {@link SessionTools.absorbHeldSettingsRebuild}). Its {@link HeldSettings.before} holds each changed setting's value
 * when the hold began, and a restored transcript prompt's settings when it began on one.
 */
interface HeldSettingsRebuild extends WithheldChange, HeldSettings {
	/** Enabled tools a held reconcile unregistered, with the settings whose change did it; calls are refused. */
	readonly disabledTools: Map<string, readonly AnySetting[]>;
	/** Tools a held reconcile registered for the enabled set; the rebuild activates them. */
	readonly enabledTools: Set<string>;
	/** A tool reconcile is held: the rebuild reapplies the enabled set. */
	reconcile: boolean;
	/** A skill rediscovery is held: the rebuild lists the registry's skills in the prompt. */
	skills: boolean;
	/**
	 * What the last request before the hold declared for each tool, by name, with the digests it was sent with: the
	 * tools keep declaring it until the rebuild, as the prompt keeps its bytes. Undefined when that request did not
	 * carry the held prompt, or when neither this process's requests nor the branch's record shows what it declared (a
	 * resumed or switched-in transcript whose tools render otherwise under the earlier settings): the tools then
	 * declare what they render. A later change that shows it fills it in ({@link SessionTools.#keptDeclarations}), and
	 * a move to a branch whose newest request declared other tool definitions takes that branch's own
	 * ({@link SessionTools.followBranchDeclarations}).
	 */
	declarations: SentDeclarations | undefined;
	/** Each tool the hold declares with {@link declarations}, wrapped once for each it keeps ({@link forwardingProxy}). */
	declared: WeakMap<AgentTool, AgentTool>;
	/**
	 * The settings a tool the hold keeps declared as sent was declared under: each changed setting reads its value
	 * from before the change while the hold lasts ({@link SessionTools.toolCallSettings}).
	 */
	readonly toolSettings: Settings;
}

/** What a settings notice and the notices before it on its branch told the model under one change. */
interface SettingsNoticeState {
	/** The value given for each setting. */
	readonly values: ReadonlyMap<AnySetting, unknown>;
	/** The tools given as disabled, their calls refused. */
	readonly disabledTools: readonly string[];
	/** The tools given as enabled, available after the rebuild. */
	readonly enabledTools: readonly string[];
}

/**
 * What the settings notices in a context told the model of every change but the one the base withholds, if any: an
 * earlier process's change of a restored prompt, and a change whose hold ended (released, or spent across a restart),
 * whether or not a notice of its last state went out. As {@link SettingsNoticeState}, with each setting by id.
 */
interface EarlierNoticesTold {
	/** The value the newest of them gave each setting it names, by id. */
	readonly values: ReadonlyMap<string, unknown>;
	/** The tools given as disabled, their calls refused. */
	readonly disabledTools: readonly string[];
	/** The tools given as enabled, available after the rebuild. */
	readonly enabledTools: readonly string[];
	/** The change the newest of them describes, and how many of them describe it; undefined without them. */
	readonly newest: { readonly hold: string; readonly notices: number } | undefined;
}

/**
 * Where each setting a settings notice may name starts, as the model was told of it before the notices of the change
 * the base withholds, if any, which holds each setting of `before` with the value the withholding prompt was built
 * with: each setting it holds at the value the newest notice of another change in the context gave it (`earlier`),
 * else at the value the prompt was built with; then each other setting those notices gave a value, at that value, but
 * a credential, whose value no notice records, and a setting this process does not know. The settings notice and the
 * held-tool refusal name each change from here, so both give a setting the same value before the change.
 */
function noticedSettingStarts(
	before: ReadonlyMap<AnySetting, unknown>,
	earlier: EarlierNoticesTold,
): Map<AnySetting, unknown> {
	const starts = new Map<AnySetting, unknown>();
	for (const [setting, value] of before) {
		starts.set(setting, earlier.values.has(setting.id) ? earlier.values.get(setting.id) : value);
	}
	for (const [id, value] of earlier.values) {
		const setting = lookupSetting(id);
		if (setting && !setting.isCredential && !starts.has(setting)) starts.set(setting, value);
	}
	return starts;
}

/**
 * A resumed transcript's stored prompt, restored in place of this process's own build, which it withholds from the
 * model ({@link SessionTools.replaceRestoredPromptIfDue}), with the settings the session's records name as held from
 * it ({@link SessionTools.#restoreTranscriptPrompt}).
 */
interface RestoredPrompt extends WithheldChange, HeldSettings {
	/** The stored blocks, restored as the base; {@link WithheldChange.digest} is theirs. */
	readonly base: readonly string[];
}

/**
 * Data of a {@link SETTINGS_NOTICE_MESSAGE_TYPE} message: setting ids, tool names and its change, never a credential's
 * value.
 */
interface SettingsNoticeDetails {
	settings: string[];
	/** Each setting it names but a credential, with the value it gives now: what a resumed process counts as told. */
	values: HeldSettingRecord[];
	/** Tools it gives as disabled that no notice before it on its branch did. */
	disabledTools: string[];
	/** Tools a notice before it on its branch gave as disabled that run again. */
	reenabledTools: string[];
	/** Tools it gives as enabled after the rebuild that no notice before it on its branch did. */
	enabledTools: string[];
	/** Tools a notice before it on its branch gave as enabled after the rebuild that no longer are. */
	noLongerEnabledTools: string[];
	/** The {@link HeldSettings.id} of the change the notice describes. */
	hold: string;
	/** The notice's index in that change's {@link HeldSettings.notices}. */
	notice: number;
}

/** A changed setting as the settings notice and the held-tool refusal print it; a credential's values are withheld. */
interface SettingChangeView {
	id: string;
	secret: boolean;
	previous?: string;
	next?: string;
}

function settingChangeView(setting: AnySetting, previous: unknown, next: unknown): SettingChangeView {
	if (setting.isCredential) return { id: setting.id, secret: true };
	return {
		id: setting.id,
		secret: false,
		previous: previous === undefined ? "unset" : JSON.stringify(previous),
		next: next === undefined ? "unset" : JSON.stringify(next),
	};
}

/** The tool lists of a settings notice ({@link SettingsNoticeDetails}). */
type SettingsNoticeTools = Pick<
	SettingsNoticeDetails,
	"disabledTools" | "reenabledTools" | "enabledTools" | "noLongerEnabledTools"
>;

/**
 * What the notice of a held change gives beside the changes it holds: when the rebuild comes at the latest, each setting
 * it puts right that a change which ended left as it is now, which the request's prompt and tools follow already
 * (`releasedChanges`), and each tool it disables that the request lists nowhere (`unlistedTools`).
 */
interface HeldNoticeParts {
	rebuildBy: string;
	releasedChanges: SettingChangeView[];
	unlistedTools: readonly string[];
}

/**
 * The hidden settings notice giving `changes` and `tools`, recording `given` as the values it gives, as notice
 * `notice` of the change `hold`: a held change's, with its other `parts`, or without them the notice that the change
 * it puts right was released.
 */
function settingsNoticeMessage(
	changes: SettingChangeView[],
	given: HeldSettingRecord[],
	tools: SettingsNoticeTools,
	hold: string,
	notice: number,
	parts: HeldNoticeParts | undefined,
): CustomMessage<SettingsNoticeDetails> {
	const releasedChanges = parts?.releasedChanges ?? [];
	const unlisted = parts?.unlistedTools ?? [];
	return {
		role: "custom",
		customType: SETTINGS_NOTICE_MESSAGE_TYPE,
		content: prompt.render(settingsNoticePrompt, {
			changes,
			releasedChanges,
			...tools,
			disabledTools: tools.disabledTools.filter(name => !unlisted.includes(name)),
			unlistedDisabledTools: tools.disabledTools.filter(name => unlisted.includes(name)),
			rebuildBy: parts?.rebuildBy,
			released: parts === undefined,
		}),
		details: {
			settings: [...changes, ...releasedChanges].map(change => change.id),
			values: given,
			...tools,
			hold,
			notice,
		},
		attribution: "agent",
		display: false,
		timestamp: Date.now(),
	};
}

/**
 * Prompt-affecting state frozen at each base rebuild. Tools render their
 * provider-visible text from this snapshot instead of live settings, so
 * mid-session toggles leave the cached prefix byte-stable and ride hidden
 * notices until the next rebuild absorbs them.
 */
interface PromptSurface {
	/** Skill-URI hints in `bash`/`read` (mid-session `/skillful` toggles). */
	skillHintVisible: boolean;
	/** Eval preludes in the system prompt and eval description. */
	evalPreludes: readonly EvalPreludeDefinition[];
	/** User-tagged model agents listed in the task description. */
	sessionAgents: readonly AgentDefinition[];
	/** Tool names the eval description lists as callable from cells. */
	evalToolNames: readonly string[];
	/**
	 * Discovered agents listed in the task description: the latest discovery scan for the
	 * session's cwd and extension roots; undefined when no task tool scanned them.
	 */
	discoveredAgents: readonly AgentDefinition[] | undefined;
	/** Per-call models the task and eval descriptions approve; undefined while per-call models are off. */
	perCallModels: PerCallModelAdvertisement | undefined;
}

/**
 * Tool roster a committed base prompt rendered, captured for prefix-bound
 * models. While a roster change is held out of that prompt, a forced rebuild
 * re-renders this roster first (see `SessionTools.#prepareHeldRosterPrompt`).
 */
interface PromptRoster {
	/** Active tool names the render listed. */
	readonly toolNames: string[];
	/** Registry entries the render could read. */
	readonly tools: Map<string, AgentTool>;
	/** `xd://` state over {@link tools} with the mounts the render listed. */
	readonly xdev: XdevState | undefined;
}

/** A mount notice previewed for pre-prompt context maintenance ({@link SessionTools.peekXdevMountNotice}). */
interface XdevMountNoticePreview {
	notice: CustomMessage<XdevMountNoticeDetails> | undefined;
	/**
	 * Exact rendered content included in the context estimate. Re-projecting and
	 * comparing this key after maintenance catches every semantically relevant
	 * change — mount membership, base-catalog suppression, summaries, and schemas
	 * — without false-invalidating a byte-identical notice after a hidden rebuild.
	 */
	contentKey: string;
	/** The history the notice was derived from; maintenance that replaces it (a compaction) re-derives it. */
	history: readonly AgentMessage[];
}

/**
 * The top-level tools, `xd://` devices and skills a system prompt tells the model of
 * ({@link SessionTools.#promptListing}).
 */
interface PromptListing {
	readonly toolNames: readonly string[];
	readonly xdevNames: ReadonlySet<string>;
	/**
	 * The skills a restored transcript prompt lists, each with the description it gives. Undefined for a prompt this
	 * process built, which lists {@link SessionTools.promptSkills}.
	 */
	readonly skills?: ReadonlyMap<string, string>;
}

/** The skills of `skills` a system prompt lists: the ones not hidden. */
function listedSkills(skills: readonly Skill[]): Skill[] {
	return skills.filter(skill => skill.hide !== true);
}

/** A withheld change with the members a move to another transcript or a rebuild changes in place. */
interface WithheldChangeState<T extends WithheldChange> {
	readonly change: T;
	readonly due: boolean;
	readonly recorded: boolean;
	readonly recordedOn: readonly SessionEntry[] | undefined;
}

/** `change`, if any, with the members {@link WithheldChangeState} keeps as they are now. */
function withheldChangeState<T extends WithheldChange>(change: T | undefined): WithheldChangeState<T> | undefined {
	return change && { change, due: change.due, recorded: change.recorded, recordedOn: change.recordedOn };
}

/** The change `state` names with the members it kept put back; undefined without one. */
function restoreWithheldChange<T extends WithheldChange>(state: WithheldChangeState<T> | undefined): T | undefined {
	if (!state) return undefined;
	const { change } = state;
	change.due = state.due;
	change.recorded = state.recorded;
	change.recordedOn = state.recordedOn;
	return change;
}

/** A base prompt kept in place of a build of this process's ({@link SessionTools.#baseStandIn}). */
interface BaseStandIn {
	readonly base: readonly string[];
	readonly build: readonly string[];
	/** Each setting the build read, with the value it read. */
	readonly settingsRead: ReadonlyMap<AnySetting, unknown>;
}

/**
 * What a request declared for each tool, by name, with the digest of the base prompt it was sent with and the digest
 * of its tool definitions as the wire carried them ({@link TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE}).
 */
interface SentDeclarations {
	readonly promptDigest: string;
	readonly toolsDigest: string;
	readonly tools: ReadonlyMap<string, ToolDeclarationFields>;
}

/**
 * The newest assistant reply restored with a transcript, and the recorded digest of the prompt that transcript was
 * sent with (undefined when it records none).
 */
interface RestoredTranscript {
	readonly reply: AgentMessage;
	readonly promptDigest: string | undefined;
}

/**
 * The committed base prompt with what a commit records beside it ({@link SessionTools.basePromptState}): what it
 * lists, the roster it rendered and whether a roster change is held out of it, the surface the tool definitions render
 * from, the tool signature it was applied for, the model key and inline-descriptor decision it was rendered with, the
 * settings its build read, and the ones it did not read that changed since; what the base keeps in place of a
 * rebuild: the restored transcript's stored prompt with the build it stands in for (a move to another transcript ends
 * it), the held settings rebuild and the skill list the prompt renders (a rebuild that renders the live state ends the
 * hold and takes the registry's skills), and a spent hold not yet ended; and what the transcript's last request
 * declared for each tool, which a move to another transcript leaves behind.
 */
export interface SessionToolsSnapshot {
	readonly systemPrompt: string[];
	readonly listing: PromptListing;
	readonly roster: PromptRoster | undefined;
	readonly rosterHeld: boolean;
	readonly surface: PromptSurface;
	readonly appliedToolSignature: string | undefined;
	readonly modelKey: string | undefined;
	readonly inlineDescriptors: boolean | undefined;
	readonly settingsRead: ReadonlyMap<AnySetting, unknown>;
	readonly unreadChanges: ReadonlyMap<AnySetting, unknown>;
	readonly restoredTranscript: RestoredTranscript | undefined;
	readonly basePromptRestored: boolean;
	readonly restoredPrompt: WithheldChangeState<RestoredPrompt> | undefined;
	readonly standIn: BaseStandIn | undefined;
	readonly heldSettingsRebuild: WithheldChangeState<HeldSettingsRebuild> | undefined;
	readonly promptSkills: Skill[];
	readonly spentHold: WithheldChangeState<WithheldChange> | undefined;
	readonly sentDeclarations: SentDeclarations | undefined;
	/**
	 * The tool set the prompt goes with: the enabled names, the `xd://` mounts, the registry and the built-in names
	 * (a rebuild that ends a held reconcile applies the reconciled set).
	 */
	readonly toolSet: {
		readonly enabled: ReadonlySet<string>;
		readonly mounted: readonly string[] | undefined;
		readonly registry: ReadonlyMap<string, AgentTool>;
		readonly builtIn: ReadonlySet<string>;
	};
}

/** Owns tool registration, presentation, prompt rebuilding, skills, and permissions. */
export class SessionTools {
	readonly #host: SessionToolsHost;
	#autoApprove: boolean;
	#toolRegistry: Map<string, AgentTool>;
	#createVibeTools: (() => AgentTool[]) | undefined;
	#createThinkTool: SessionToolsOptions["createThinkTool"];
	#installedVibeToolNames = new Set<string>();
	/** An MCP refresh landed while vibe narrowed the active set; vibe exit activates its manager tools. */
	#vibeDeferredMcpRefresh = false;
	#builtInToolNames: Set<string>;
	#rpcHostToolNames = new Set<string>();
	#mcpManagerToolNames = new Set<string>();
	#extensionMcpTools = new Map<string, AgentTool>();
	#xdev: XdevState | undefined;
	/**
	 * Newest assistant reply restored with the transcript this session was created with, and the recorded digest of
	 * the prompt that transcript was sent with (undefined when it records none), until this session's first primary
	 * model call; see {@link #implicitRebuildBinding}.
	 */
	#restoredTranscript: RestoredTranscript | undefined;
	/** The last primary model call, until its reply ends: its digests, and the active tools when it captured them. */
	#capturedCall: { digests: ModelCallDigests; activeTools: AgentTool[] } | undefined;
	/** Digests of the call each primary reply with provider output was produced by. */
	readonly #replyCalls = new WeakMap<AgentMessage, ModelCallDigests>();
	/** Newest {@link SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE} record of a branch view ({@link scanNewestRecord}). */
	#recordedDigestScan: NewestRecordScan | undefined;
	/** Newest {@link TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE} record of a branch view ({@link scanNewestRecord}). */
	#recordedToolsDigestScan: NewestRecordScan | undefined;
	/** {@link currentPromptDigest} for the base prompt array it hashed. */
	#currentPromptDigest: { base: readonly string[]; digest: string } | undefined;
	/** {@link SessionToolsOptions.operatorPromptDigest}. */
	readonly #operatorPromptDigest: string | undefined;
	/**
	 * The session started from the restored transcript's stored prompt ({@link #restoreTranscriptPrompt}), which
	 * counts as committed; false again once the session moves to another transcript ({@link leaveRestoredTranscript}).
	 */
	#basePromptRestored = false;
	/**
	 * The restored transcript's stored prompt while it is kept in place of this process's own build; kept only while
	 * its `base` is the base. See {@link replaceRestoredPromptIfDue}.
	 */
	#restoredPrompt: RestoredPrompt | undefined;
	/**
	 * A change the session records a hold on ({@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE}) whose prompt withholds nothing
	 * here although this process sends its bytes: the resumed transcript's prompt, which this process's own build
	 * reproduced at startup or later ({@link #settleRestoredPrompt}). Ended at the first reply under that prompt, or
	 * before a new hold on it is recorded; dropped at a reply under another prompt, which records that prompt.
	 */
	#spentHold: WithheldChange | undefined;
	/**
	 * A base prompt that keeps its bytes in place of a prompt this process built for itself: a restored
	 * transcript's stored prompt in place of this process's own startup build ({@link #restoreTranscriptPrompt}),
	 * or a bound prompt in place of the build a held settings rebuild would commit
	 * ({@link #recordHeldSettingsBuild}). `build` follows the newest such build, with the settings it read. While
	 * `base` is the base, a rebuild that renders `build` again changes nothing of its own and keeps `base`
	 * ({@link #prepareBaseSystemPrompt}).
	 */
	#baseStandIn: BaseStandIn | undefined;
	/** Newest prompt a branch view stores for each digest, and how much of it was scanned (as {@link #recordedDigestScan}). */
	#storedPromptScan:
		| { branch: readonly SessionEntry[]; scanned: number; prompts: Map<string, StoredSystemPrompt> }
		| undefined;
	/**
	 * What the session's startup prompt listed: the top-level tools and `xd://` devices it was constructed with. A
	 * per-turn `before_agent_start` override stands in for that prompt ({@link #promptListing}).
	 */
	readonly #startupListing: PromptListing;
	/**
	 * The mount notice a prompt's pre-prompt maintenance budgeted changed before the request (a mount or a
	 * same-named tool's new docs): no request adds one until the next prompt budgets it ({@link takeXdevMountNotice}).
	 */
	#xdevMountNoticeDeferred = false;
	#presentationPinnedToolNames: ReadonlySet<string> | undefined;
	#runtimeSelectedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];
	/**
	 * Each setting the build of {@link #baseSystemPrompt} read, with the value it read: the startup build's for the
	 * prompt the session was created with or restored, then each committed rebuild's. A bound prompt holds a change of
	 * any of them ({@link #promptMovers}).
	 */
	#promptSettingsRead: ReadonlyMap<AnySetting, unknown>;
	/**
	 * Each setting the build of {@link #baseSystemPrompt} did not read that changed since, with its value before the
	 * first such change: the value that build was rendered under ({@link holdToolDeclarationChange} records them). A
	 * held rebuild whose build reads one at another value sends its change too ({@link #holdEarlierChanges}).
	 */
	#promptUnreadChanges = NO_SETTINGS;
	/**
	 * Per-turn system prompt returned by a `before_agent_start` extension hook
	 * ("replace the system prompt for this turn"). While set, base-prompt
	 * rebuilds keep this override on the agent instead of the rebuilt base, so a
	 * rebuild landing in the prompt window (compaction/promotion, memory
	 * promotion, MCP/RPC tool refresh, hindsight MM-TTL refresh) cannot silently
	 * drop it before the request. Cleared when the turn ends.
	 */
	#turnSystemPromptOverride: string[] | undefined;
	/** The latest per-turn override and the base its hook was given; kept after the turn ends. */
	#lastTurnSystemPromptOverride: { prompt: string[]; base: string[] } | undefined;
	#lastAppliedToolSignature: string | undefined;
	/** Roster {@link #baseSystemPrompt} rendered; captured only for prefix-bound models. */
	#basePromptRoster: PromptRoster | undefined;
	/** A frozen roster change is held out of {@link #baseSystemPrompt}, riding notices instead. */
	#promptRosterHeld = false;
	/** The rebuild a settings change started on a bound prompt, held; see {@link #holdSettingsRebuild}. */
	#heldSettingsRebuild: HeldSettingsRebuild | undefined;
	/**
	 * What the last primary request on a prefix-bound model declared for each tool, by name, a tool taken off the
	 * roster that the request still declared included, with the digests of the base prompt and the tool definitions
	 * it was sent with ({@link recordPrimaryModelCall}). In a transcript this process has sent nothing on (resumed,
	 * or switched to), or on a branch whose newest request declared other definitions (`/tree`), the active tools'
	 * declarations once a settings change shows they are what the branch records its last request declared
	 * ({@link #transcriptDeclarations}). A hold that begins on that prompt and branch keeps the declarations
	 * ({@link HeldSettingsRebuild.declarations}); one on a prompt rebuilt since has none to keep.
	 */
	#sentDeclarations: SentDeclarations | undefined;
	/** Each tool a hold declares as sent ({@link #declaredAs}), to the tool it wraps. */
	readonly #declaredOwners = new WeakMap<AgentTool, AgentTool>();
	/** Frame of a call to a tool whose held declaration the change altered: its {@link HeldSettingsRebuild.toolSettings}. */
	readonly #toolCallSettingsScope = new AsyncLocalStorage<Settings>();
	/** Full enabled set, including tools demoted from the model-visible surface. */
	#enabledToolNames = new Set<string>();
	/**
	 * What the current base system prompt lists ({@link #promptListing}): the
	 * top-level tools it rendered, and the `xd://` devices its catalog renders (the
	 * last rebuild's {@link BuildSystemPromptResult.xdevCatalogNames}; none when the
	 * prompt carries no catalog, such as a custom prompt that omits the section)
	 * with the mounted MCP devices whose route line, with its catalog summary, it
	 * renders. The startup prompt's ({@link #startupListing}) until a rebuild
	 * commits; a restored transcript prompt lists the tools it was stored with. A
	 * request carrying the base needs no notice for any of them; a device mounted
	 * since needs one even when the live route projection lists it: a frozen prompt
	 * never shipped it.
	 */
	#basePromptListing: PromptListing;
	#toolRegistryMutationScope = new AsyncLocalStorage<boolean>();
	/**
	 * Render-scoped candidate prompt surface. Rebuild frames run inside
	 * `.run(candidate, …)` so tool getters read the candidate during render and
	 * signature computation; everything outside the frame reads the committed
	 * {@link #promptSurface}. Abandoned frames simply exit their scope — no
	 * rollback write that could clobber a newer commit.
	 */
	#promptSurfaceScope = new AsyncLocalStorage<PromptSurface>();
	#toolRegistryMutationTail: Promise<void> = Promise.resolve();
	#promptModelKey: string | undefined;
	/** The model switch in progress, settled; see {@link settleModelSwitch}. */
	#modelSwitch: Promise<void> | undefined;
	/** Inline-descriptor decision of the model the base prompt was rendered for. */
	#promptInlineDescriptors: boolean | undefined;
	#rebuildSystemPrompt: SessionToolsOptions["rebuildSystemPrompt"];
	#getMcpServerInstructions: SessionToolsOptions["getMcpServerInstructions"];
	/**
	 * Session-lifetime factory shared by every custom-tool wrapper. Defining it
	 * outside the refresh frame prevents wrappers from retaining rollback maps
	 * from earlier MCP generations through a shared lexical environment.
	 */
	readonly #getCustomToolContext = (): CustomToolContext => ({
		sessionManager: this.#host.sessionManager,
		modelRegistry: this.#host.modelRegistry,
		model: this.#host.model(),
		isIdle: () => !this.#host.isStreaming(),
		hasQueuedMessages: () => this.#host.queuedMessageCount() > 0,
		abort: () => {
			this.#host.agent.abort();
		},
		settings: this.#host.settings,
		localProtocolOptions: this.#host.localProtocolOptions(),
	});
	#setActiveToolNames: SessionToolsOptions["setActiveToolNames"];
	#ensureWriteRegistered: SessionToolsOptions["ensureWriteRegistered"];
	#isDeviceOnlyWrite: SessionToolsOptions["isDeviceOnlyWrite"];
	#setDeviceOnlyWrite: SessionToolsOptions["setDeviceOnlyWrite"];
	#setPendingFullWriteDescription: SessionToolsOptions["setPendingFullWriteDescription"];
	/**
	 * The session originated with an xd:// transport grant. Unlike the live
	 * device-only flag, this survives temporary full-write upgrades.
	 */
	readonly #deviceOnlyWriteTransportAvailable: boolean;
	#ensureGoalRegistered: SessionToolsOptions["ensureGoalRegistered"];
	#reconcileSettingsGatedTools: SessionToolsOptions["reconcileSettingsGatedTools"];
	#skills: Skill[];
	#promptSkills: Skill[];
	#skillWarnings: SkillWarning[];
	#skillsSettings: SkillsSettings | undefined;
	#skillsReloadable: boolean;
	/** The skill rediscovery in flight, shared by concurrent misses (see {@link shareSkillRediscovery}). */
	#skillsRediscovery: Promise<readonly Skill[]> | undefined;
	/** Earliest time (ms since epoch) a name no loaded skill owns may start another rediscovery. */
	#nextUnknownSkillRediscovery = 0;
	/**
	 * Prompt surface committed by the last system-prompt rebuild. The
	 * provider-visible system prompt is deliberately byte-stable across
	 * mid-session `/skillful` and eval-prelude toggles (a notice rides the next
	 * turn instead), so the provider-side text in `BashTool.description`,
	 * `ReadTool.parameters`, and `EvalTool.description` must freeze to the same
	 * state — reading live settings per request would mutate the provider tool
	 * prefix without the intended prompt refresh. The refresh lifecycle updates it.
	 */
	#promptSurface: PromptSurface;
	#acpPermissionDecisions = new Map<string, "allow_always" | "reject_always">();

	constructor(host: SessionToolsHost, options: SessionToolsOptions) {
		this.#host = host;
		this.#autoApprove = options.autoApprove === true;
		this.#toolRegistry = options.toolRegistry ?? new Map();
		this.#createVibeTools = options.createVibeTools;
		this.#createThinkTool = options.createThinkTool;
		this.#builtInToolNames = new Set(options.builtInToolNames ?? []);
		this.#mcpManagerToolNames = new Set(options.mcpManagerToolNames ?? []);
		if (options.mcpManagerToolNames === undefined) {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#mcpManagerToolNames.add(name);
			}
		}
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name) && !this.#mcpManagerToolNames.has(name)) {
				this.#extensionMcpTools.set(name, tool);
			}
		}
		this.#presentationPinnedToolNames = options.presentationPinnedToolNames;
		this.#ensureWriteRegistered = options.ensureWriteRegistered;
		this.#isDeviceOnlyWrite = options.isDeviceOnlyWrite;
		this.#deviceOnlyWriteTransportAvailable = this.#isDeviceOnlyWrite?.() === true;
		this.#setDeviceOnlyWrite = options.setDeviceOnlyWrite;
		this.#setPendingFullWriteDescription = options.setPendingFullWriteDescription;
		this.#ensureGoalRegistered = options.ensureGoalRegistered;
		this.#reconcileSettingsGatedTools = options.reconcileSettingsGatedTools;
		this.#rebuildSystemPrompt = options.rebuildSystemPrompt;
		this.#getMcpServerInstructions = options.getMcpServerInstructions;
		this.#xdev = options.xdev;
		if (this.#xdev && this.#xdev.tools !== this.#toolRegistry) {
			throw new Error("xd:// state must reference the canonical session tool map");
		}
		if (this.#xdev) this.#xdev.decorateExecution = tool => this.#callableAsDeclared(tool);
		this.#setActiveToolNames = options.setActiveToolNames;
		this.#baseSystemPrompt = options.baseSystemPrompt;
		this.#promptSettingsRead = options.baseSettingsRead ?? NO_SETTINGS;
		this.#operatorPromptDigest = options.operatorPromptDigest;
		// The startup prompt was built from the construction slate, so it lists these tools and devices.
		this.#startupListing = {
			toolNames: host.agent.state.tools.map(tool => tool.name),
			xdevNames: new Set(this.#xdev?.mountedNames),
		};
		this.#basePromptListing = this.#startupListing;
		// A reply binds the startup prompt as it binds a rebuilt one ({@link #implicitRebuildBinding}): a roster change
		// held out of it re-renders against the roster it was built from.
		this.#recordPromptRoster(this.#startupListing.toolNames);
		const restoredReply = this.#latestReply();
		this.#restoredTranscript = restoredReply && { reply: restoredReply, promptDigest: this.recordedPromptDigest() };
		this.#restoreTranscriptPrompt();
		this.#skills = options.skills ?? [];
		this.#promptSkills = this.#skills;
		this.#skillWarnings = options.skillWarnings ?? [];
		this.#skillsSettings = options.skillsSettings;
		this.#skillsReloadable = options.skillsReloadable ?? true;
		// Seed from the construction slate (top-level tools plus xd:// mounts).
		// Left empty, getEnabledToolNames() falls back to live agent.state.tools,
		// so an early reconcile (think after the startup model resolution)
		// landing while the live set is transiently narrow
		// commits that narrow set as the sticky slate — the session keeps almost
		// no tools and the prompt rebuild without `read` empties the skill list.
		for (const tool of host.agent.state.tools) this.#enabledToolNames.add(tool.name);
		for (const name of this.#xdev?.mountedNames ?? []) this.#enabledToolNames.add(name);
		this.#promptSurface = this.#derivePromptSurface();
		this.#promptModelKey = this.#currentPromptModelKey();
		this.#promptInlineDescriptors = this.#currentInlineDescriptors();
	}

	/** Mutable registry shared with controller hosts that inspect available tools. */
	get registry(): Map<string, AgentTool> {
		return this.#toolRegistry;
	}

	/** Current stable base system prompt. */
	get baseSystemPrompt(): string[] {
		return this.#baseSystemPrompt;
	}

	/** Replaces the controller-owned base prompt without applying it to the agent. */
	setBaseSystemPrompt(prompt: string[]): void {
		this.#baseSystemPrompt = prompt;
	}

	/** The committed base prompt and what a commit records beside it, for a caller that may have to put them back. */
	get basePromptState(): SessionToolsSnapshot {
		return {
			systemPrompt: this.#baseSystemPrompt,
			listing: this.#basePromptListing,
			roster: this.#basePromptRoster,
			rosterHeld: this.#promptRosterHeld,
			surface: this.#promptSurface,
			appliedToolSignature: this.#lastAppliedToolSignature,
			modelKey: this.#promptModelKey,
			inlineDescriptors: this.#promptInlineDescriptors,
			settingsRead: this.#promptSettingsRead,
			unreadChanges: this.#promptUnreadChanges,
			restoredTranscript: this.#restoredTranscript,
			basePromptRestored: this.#basePromptRestored,
			restoredPrompt: withheldChangeState(this.#restoredPrompt),
			standIn: this.#baseStandIn,
			heldSettingsRebuild: withheldChangeState(this.#heldSettingsRebuild),
			promptSkills: this.#promptSkills,
			spentHold: withheldChangeState(this.#spentHold),
			sentDeclarations: this.#sentDeclarations,
			toolSet: {
				enabled: new Set(this.#enabledToolNames),
				mounted: this.#xdev ? [...this.#xdev.mountedNames] : undefined,
				registry: new Map(this.#toolRegistry),
				builtIn: new Set(this.#builtInToolNames),
			},
		};
	}

	/**
	 * Puts back a base prompt with what its commit recorded ({@link basePromptState}), without applying it to the
	 * agent: a rolled-back session switch restores the prompt a rebuild replaced, and the roster and mount notices then
	 * compare against what that prompt lists, not the rebuild's. A restored transcript prompt the switch left comes
	 * back as the base it was, still kept for the transcript's cache entry, and a held settings change a rebuild sent
	 * is held again, with what the transcript's last request declared, so the next request continues the prompt and
	 * the tool definitions the transcript's last one sent.
	 */
	restoreBasePromptState(state: SessionToolsSnapshot): void {
		this.#baseSystemPrompt = state.systemPrompt;
		this.#basePromptListing = state.listing;
		this.#basePromptRoster = state.roster;
		this.#promptRosterHeld = state.rosterHeld;
		this.#promptSurface = state.surface;
		this.#lastAppliedToolSignature = state.appliedToolSignature;
		this.#promptModelKey = state.modelKey;
		this.#promptInlineDescriptors = state.inlineDescriptors;
		this.#promptSettingsRead = state.settingsRead;
		this.#promptUnreadChanges = state.unreadChanges;
		this.#restoredTranscript = state.restoredTranscript;
		this.#basePromptRestored = state.basePromptRestored;
		this.#restoredPrompt = restoreWithheldChange(state.restoredPrompt);
		this.#baseStandIn = state.standIn;
		this.#heldSettingsRebuild = restoreWithheldChange(state.heldSettingsRebuild);
		this.#promptSkills = state.promptSkills;
		this.#spentHold = restoreWithheldChange(state.spentHold);
		this.#sentDeclarations = state.sentDeclarations;
		const { toolSet } = state;
		this.#enabledToolNames = new Set(toolSet.enabled);
		if (toolSet.mounted) this.#setMountedNames(toolSet.mounted);
		// The registry is shared with the `xd://` state: refilled in place.
		this.#toolRegistry.clear();
		for (const [name, tool] of toolSet.registry) this.#toolRegistry.set(name, tool);
		this.#builtInToolNames = new Set(toolSet.builtIn);
		// The caller gave the agent its previous tools back.
		this.#setActiveToolNames?.(this.getActiveToolNames());
	}

	/**
	 * Pushes `base` to the agent as the effective system prompt, unless an active
	 * per-turn {@link #turnSystemPromptOverride} takes precedence. Every base
	 * rebuild applies its result through here so a mid-turn rebuild preserves the
	 * override.
	 */
	#applyAgentSystemPrompt(base: string[]): void {
		this.#host.agent.setSystemPrompt(this.#turnSystemPromptOverride ?? base);
	}

	/**
	 * Registers the per-turn `before_agent_start` system-prompt override and
	 * applies it to the agent. Base rebuilds during the turn preserve it until
	 * {@link clearTurnSystemPromptOverride}.
	 */
	setTurnSystemPromptOverride(prompt: string[], base: string[]): void {
		this.#turnSystemPromptOverride = prompt;
		this.#lastTurnSystemPromptOverride = { prompt, base };
		this.#host.agent.setSystemPrompt(prompt);
	}

	/**
	 * The base prompt a system prompt the agent sent was built from: the hook's input when it is a
	 * per-turn override, else the prompt itself, since every other prompt applied to the agent is a base.
	 */
	baseOfSystemPrompt(prompt: string[]): string[] {
		return prompt === this.#lastTurnSystemPromptOverride?.prompt ? this.#lastTurnSystemPromptOverride.base : prompt;
	}

	/** Drops the active per-turn override; later rebuilds fall back to the base prompt. */
	clearTurnSystemPromptOverride(): void {
		this.#turnSystemPromptOverride = undefined;
	}

	/** The live skill registry: what `skill://` and `/skill:` resolve. */
	get skills(): Skill[] {
		return this.#skills;
	}

	/** Skills the system prompt renders; behind {@link skills} after {@link reloadSkills}. */
	get promptSkills(): Skill[] {
		return this.#promptSkills;
	}

	/** Whether {@link refreshSkills} rediscovers the list; false when it was fixed at creation (a subagent's). */
	get skillsReloadable(): boolean {
		return this.#skillsReloadable;
	}

	/** Stores a re-pointed fixed skill list (see `rediscoverSkills`) and refreshes prompt metadata. */
	async replaceSkills(skills: readonly Skill[]): Promise<void> {
		this.#skills = [...skills];
		this.#promptSkills = this.#skills;
		if (this.#host.agentKind() === "main") {
			setActiveSkills(this.#skills);
		}
		await this.refreshBaseSystemPrompt();
		this.#host.notifyCommandMetadataChanged();
	}

	/** Runs `rediscover`, or joins the rediscovery already in flight, so concurrent misses share one pass. */
	shareSkillRediscovery(rediscover: () => Promise<readonly Skill[]>): Promise<readonly Skill[]> {
		this.#skillsRediscovery ??= rediscover().finally(() => {
			this.#skillsRediscovery = undefined;
		});
		return this.#skillsRediscovery;
	}

	/**
	 * Skills rediscovered for a `skill://` name the list lacks (one created or installed since the
	 * list was taken, or a typo): joins a pass in flight, else starts one unless another such miss
	 * started one within {@link UNKNOWN_SKILL_REDISCOVERY_INTERVAL_MS}. Undefined when skipped.
	 */
	rediscoverSkillsForUnknownName(): Promise<readonly Skill[]> | undefined {
		if (!this.#skillsRediscovery) {
			const now = Date.now();
			if (now < this.#nextUnknownSkillRediscovery) return undefined;
			this.#nextUnknownSkillRediscovery = now + UNKNOWN_SKILL_REDISCOVERY_INTERVAL_MS;
		}
		return this.shareSkillRediscovery(() => this.#adoptNewSkills());
	}

	/**
	 * Discovers this session's skills again and adopts them when they differ from the list (a skill
	 * added, or one removed, which a stale-skill miss joining this pass must see gone); otherwise the
	 * list, the prompt and the process snapshot stay as they were. The process snapshot follows only
	 * while it is this session's list, so another session's stays published.
	 */
	#adoptNewSkills(): Promise<readonly Skill[]> {
		return this.runToolRegistryMutation(async () => {
			clearPluginRootsAndCaches();
			resetCapabilities();
			const { discovered, skillsSettings } = await this.#discoverSkills();
			const held = new Set(this.#skills.map(skill => `${skill.name}\0${skill.filePath}`));
			if (
				discovered.skills.length === this.#skills.length &&
				discovered.skills.every(skill => held.has(`${skill.name}\0${skill.filePath}`))
			) {
				return this.#skills;
			}
			const published = getActiveSkills() === this.#skills;
			this.#skills = discovered.skills;
			this.#skillWarnings = discovered.warnings;
			this.#skillsSettings = skillsSettings;
			if (published) setActiveSkills(this.#skills);
			await this.refreshBaseSystemPrompt();
			this.#host.notifyCommandMetadataChanged();
			return this.#skills;
		});
	}

	/** A fresh discovery of this session's skills, with the skills settings it ran under. */
	async #discoverSkills(): Promise<{ discovered: LoadSkillsResult; skillsSettings: SkillsSettings }> {
		const skillsSettings = cfgSkills.get(this.#host.settings);
		const discovered = await loadSkills({
			...skillsSettings,
			cwd: this.#host.sessionManager.getCwd(),
			disabledExtensions: cfgDisabledExtensions.get(this.#host.settings),
			extensionRoots: this.#host.effectiveExtensionRoots(),
		});
		return { discovered, skillsSettings };
	}

	/** Diagnostics produced while loading the current skills. */
	get skillWarnings(): SkillWarning[] {
		return this.#skillWarnings;
	}

	/** Settings snapshot used for the current skill discovery. */
	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/**
	 * Skill-URI hint visibility (see {@link #promptSurface}). Tools read this
	 * instead of the live `skillful` setting so the provider tool prefix stays
	 * byte-stable between system-prompt rebuilds.
	 *
	 * Inside a rebuild frame ({@link #promptSurfaceScope}) this returns the
	 * candidate so the rendered prompt and computed signature see the new
	 * state; outside, the committed snapshot.
	 */
	get skillHintVisible(): boolean {
		return (this.#promptSurfaceScope.getStore() ?? this.#promptSurface).skillHintVisible;
	}

	/**
	 * Eval preludes the system prompt and eval description advertise (see
	 * {@link #promptSurface}); the candidate inside a rebuild frame.
	 */
	get advertisedEvalPreludes(): readonly EvalPreludeDefinition[] {
		return (this.#promptSurfaceScope.getStore() ?? this.#promptSurface).evalPreludes;
	}

	/**
	 * User-tagged model agents the task description advertises (see
	 * {@link #promptSurface}); the candidate inside a rebuild frame.
	 */
	get advertisedSessionAgents(): readonly AgentDefinition[] {
		return (this.#promptSurfaceScope.getStore() ?? this.#promptSurface).sessionAgents;
	}

	/**
	 * Tool names the eval description advertises (see {@link #promptSurface});
	 * the candidate inside a rebuild frame. Tools enabled since the last rebuild
	 * stay callable from cells and ride the mount notice until a rebuild absorbs them.
	 */
	get advertisedEvalToolNames(): readonly string[] {
		return (this.#promptSurfaceScope.getStore() ?? this.#promptSurface).evalToolNames;
	}

	/**
	 * Discovered agents the task description advertises (see {@link #promptSurface});
	 * the candidate inside a rebuild frame. A rescan since rides {@link takeTaskAgentNotice}.
	 */
	get advertisedDiscoveredAgents(): readonly AgentDefinition[] | undefined {
		return (this.#promptSurfaceScope.getStore() ?? this.#promptSurface).discoveredAgents;
	}

	/**
	 * Per-call models the task and eval descriptions approve (see {@link #promptSurface});
	 * the candidate inside a rebuild frame. A change since rides {@link takePerCallModelNotice}.
	 */
	get advertisedPerCallModels(): PerCallModelAdvertisement | undefined {
		return (this.#promptSurfaceScope.getStore() ?? this.#promptSurface).perCallModels;
	}

	/** Derives the candidate surface from live state without publishing it. */
	#derivePromptSurface(): PromptSurface {
		return {
			skillHintVisible: cfgSkillful.get(this.#host.settings) === true && this.#promptSkills.length > 0,
			evalPreludes: this.#host.evalPreludes(),
			sessionAgents: this.#host.sessionAgents(),
			evalToolNames: this.getEvalBridgeToolNames(),
			discoveredAgents: publishedAgentDiscovery(
				this.#host.sessionManager.getCwd(),
				this.#host.effectiveExtensionRoots(),
			),
			perCallModels: this.#perCallModelsAdvertised()
				? getPerCallModelAdvertisement(this.#host.settings, this.#host.model(), this.#host.modelRegistry)
				: undefined,
		};
	}

	/**
	 * Whether the task or eval description lists the per-call models it approves. Given the session's enabled
	 * `tools`, only the description of a tool among them counts. Each tool's settings are `settingsOf` it: the
	 * session's own unless given.
	 */
	#perCallModelsAdvertised(
		tools?: readonly string[],
		settingsOf: (tool: string) => Settings = () => this.#host.settings,
	): boolean {
		return (["task", "eval"] as const).some(
			tool => (!tools || tools.includes(tool)) && perCallModelEnabled(settingsOf(tool), tool),
		);
	}

	/** Drops cached per-session ACP `allow_always`/`reject_always` decisions. */
	clearAcpPermissionDecisions(): void {
		this.#acpPermissionDecisions.clear();
	}

	/** Drops cached ACP decisions and re-wraps active tools after the client changes. */
	refreshAcpPermissionGates(): void {
		this.#acpPermissionDecisions.clear();
		const activeTools = this.getActiveToolNames()
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.#setAgentTools(activeTools);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getEnabledToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/** Names of tools currently exposed at the top level. */
	getActiveToolNames(): string[] {
		return this.#host.agent.state.tools.map(t => t.name);
	}
	/** Enabled top-level and `xd://` tool names. */
	getEnabledToolNames(): string[] {
		// Union live xd:// mounts so devices mounted out-of-band (plugins writing
		// to xdev state directly) survive the next apply.
		const mountedNames = this.#xdev?.mountedNames;
		const base = this.#enabledToolNames.size > 0 ? [...this.#enabledToolNames] : this.getActiveToolNames();
		if (!mountedNames || mountedNames.size === 0) return base;
		return [...new Set([...base, ...mountedNames])];
	}

	/** Names currently presented as `xd://` devices. */
	getMountedXdevToolNames(): string[] {
		return [...(this.#xdev?.mountedNames ?? [])];
	}

	/** Whether the edit tool is registered. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Looks up a registered tool by its canonical name or `xd://` alias.
	 *
	 * An unmatched `mcp__` name is retried under its canonical registry keys: the
	 * identity prompt primes the Claude Code spelling `mcp__<server>__<tool>`
	 * while `createMCPToolName` mints a single separator, so the doubled form is
	 * a dead end for a tool the session does expose. That retry goes through the
	 * shared {@link resolveMCPToolAlias}, so an alias two registered tools both
	 * answer resolves to nothing here exactly as it does at dispatch — this
	 * method is public and also picks transcript renderers, so a first-match
	 * shortcut could render or return the wrong tool. While a held settings
	 * rebuild keeps the tool declared as sent, it is the tool as declared
	 * ({@link #declaredAs}), whose members run as that declaration says.
	 */
	getToolByName(name: string): AgentTool | undefined {
		const bareName = stripXdUrlPrefix(name);
		const tool =
			this.#toolRegistry.get(name) ??
			this.#toolRegistry.get(bareName) ??
			resolveMCPToolAlias(bareName, candidate => this.#toolRegistry.get(candidate));
		return tool && this.#declaredAs(tool);
	}

	/**
	 * Looks up an enabled tool through the same ACP permission gate as direct calls, declared as the agent holds
	 * it ({@link #callableAsDeclared}).
	 *
	 * Accepts the spellings direct dispatch accepts: an `xd://` prefix and the
	 * Claude Code `mcp__<server>__<tool>` alias. The alias resolves in one
	 * {@link resolveMCPToolAlias} pass over every enabled tool (top-level plus
	 * mounted devices), so an alias two enabled tools answer resolves to nothing.
	 */
	getToolForEvalBridge(name: string): AgentTool | undefined {
		const bareName = stripXdUrlPrefix(name);
		const enabled = new Set(this.getEnabledToolNames());
		const named = this.#resolveToolWireName(bareName);
		// A registered name never falls through to an alias guess, even when disabled.
		if (named) return enabled.has(named.name) ? this.#callableAsDeclared(named) : undefined;
		const alias = resolveMCPToolAlias(bareName, candidate =>
			enabled.has(candidate) ? this.#toolRegistry.get(candidate) : undefined,
		);
		return alias && this.#callableAsDeclared(alias);
	}

	/**
	 * `tool` as a caller outside the agent loop runs it (an eval cell, an `xd://` device write): behind the ACP
	 * permission gate, and while a held settings rebuild keeps it declared as sent, declared so
	 * ({@link #declaredAs}), so a call shaped by that declaration is checked and runs as it says.
	 */
	#callableAsDeclared(tool: AgentTool): AgentTool {
		return this.#declaredAs(this.#wrapToolForAcpPermission(tool));
	}

	/** Canonical and unambiguous wire names accepted by the eval bridge. */
	getEvalBridgeToolNames(): string[] {
		const names = new Set<string>();
		for (const name of this.getEnabledToolNames()) {
			const tool = this.#toolRegistry.get(name);
			if (!tool || !isEvalBridgeToolCallable(tool)) continue;
			names.add(name);
			if (tool.customWireName && this.#resolveToolWireName(tool.customWireName) === tool) {
				names.add(tool.customWireName);
			}
		}
		return [...names];
	}

	/** Exact registry names shadow wire aliases, including when the exact tool is disabled. */
	#resolveToolWireName(name: string): AgentTool | undefined {
		const exact = this.#toolRegistry.get(name);
		if (exact) return exact;
		let resolved: AgentTool | undefined;
		for (const tool of this.#toolRegistry.values()) {
			if (tool.customWireName !== name) continue;
			if (resolved) return undefined;
			resolved = tool;
		}
		return resolved;
	}

	/**
	 * Whether a registry entry came from a built-in factory.
	 *
	 * Resolves `customWireName` aliases too: a built-in tool may present on the
	 * wire under a different name (e.g. `edit` exposes itself as `apply_patch` in
	 * apply_patch mode), and tool cards render the call under that wire name. An
	 * extension registering the literal alias name shadows it — the agent loop
	 * routes exact-name matches ahead of wire aliases — so a registered non-built-in
	 * tool with that name wins and the alias no longer counts as built-in.
	 */
	hasBuiltInTool(name: string): boolean {
		const tool = this.#resolveToolWireName(name);
		return tool !== undefined && this.#builtInToolNames.has(tool.name);
	}

	/** Updates source provenance when a live registry entry is replaced or restored. */
	setToolBuiltIn(name: string, builtIn: boolean): void {
		if (builtIn) {
			this.#builtInToolNames.add(name);
		} else {
			this.#builtInToolNames.delete(name);
		}
	}

	/** Whether the live registry entry is owned by the RPC host. */
	hasRpcHostTool(name: string): boolean {
		return this.#rpcHostToolNames.has(name);
	}

	/** Whether the current MCP entry came from the manager snapshot. */
	hasMCPManagerTool(name: string): boolean {
		return this.#mcpManagerToolNames.has(name);
	}

	/** Restores manager ownership after a lifecycle registration rollback. */
	setMCPManagerTool(name: string, managerOwned: boolean): void {
		if (managerOwned) {
			this.#mcpManagerToolNames.add(name);
		} else {
			this.#mcpManagerToolNames.delete(name);
		}
	}

	/** Current extension-owned MCP entry retained across manager refreshes. */
	getExtensionMCPTool(name: string): AgentTool | undefined {
		return this.#extensionMcpTools.get(name);
	}

	/** Updates extension ownership when a lifecycle registration commits or rolls back. */
	setExtensionMCPTool(name: string, tool: AgentTool | undefined): void {
		if (!isMCPToolName(name)) return;
		if (tool) {
			this.#extensionMcpTools.set(name, tool);
			this.#mcpManagerToolNames.delete(name);
		} else {
			this.#extensionMcpTools.delete(name);
		}
	}

	/** Serializes every registry and presentation mutation for this session. */
	runToolRegistryMutation<T>(mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#toolRegistryMutationScope.getStore()) return untilAborted(signal, mutation);
		const serialized = this.#toolRegistryMutationTail.then(() => {
			signal?.throwIfAborted();
			return this.#toolRegistryMutationScope.run(true, mutation);
		});
		const operation = untilAborted(signal, serialized);
		this.#toolRegistryMutationTail = serialized.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Names of every registered tool. */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	/**
	 * Full metadata for every registered tool, including source provenance.
	 *
	 * Backs the `getAllTools()` ExtensionAPI method. Returns {@link ToolInfo}
	 * objects (not bare names) so extensions authored against upstream
	 * `@earendil-works/pi-coding-agent` — which promises `ToolInfo[]` — can read
	 * `sourceInfo.source` unchanged.
	 */
	getAllToolInfos(): ToolInfo[] {
		return Array.from(this.#toolRegistry, ([name, tool]) => {
			const source = this.#builtInToolNames.has(name)
				? "builtin"
				: isMCPToolName(name)
					? "mcp"
					: this.#rpcHostToolNames.has(name)
						? "sdk"
						: "extension";
			const sourceInfo: SourceInfo = {
				path: registeredFilesystemSourcePath(this.#host.extensionRunner(), name) ?? `<${source}:${name}>`,
				source,
				scope: "temporary",
				origin: "top-level",
			};
			const info: ToolInfo = { name, description: tool.description, parameters: tool.parameters, sourceInfo };
			// MCP-backed tools (MCPTool, DeferredMCPTool and their adapters) carry the
			// server, original name and read-only annotation; expose them so
			// extensions can act on the hint the runtime already keeps.
			const mcp = tool as { mcpServerName?: unknown; mcpToolName?: unknown; mcpReadOnlyHint?: unknown };
			if (typeof mcp.mcpServerName === "string") info.mcpServerName = mcp.mcpServerName;
			if (typeof mcp.mcpToolName === "string") info.mcpToolName = mcp.mcpToolName;
			if (typeof mcp.mcpReadOnlyHint === "boolean") info.mcpReadOnlyHint = mcp.mcpReadOnlyHint;
			return info;
		});
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		const extensionRunner = this.#host.extensionRunner();
		return extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped;
	}

	/** Installs and activates the ephemeral vibe tool set. */
	activateVibeTools(baseToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const createVibeTools = this.#createVibeTools;
			if (!createVibeTools) {
				throw new Error("Vibe tools are unavailable in this session.");
			}

			const tools = createVibeTools();
			const vibeToolNames = tools.map(tool => tool.name);
			if (new Set(vibeToolNames).size !== vibeToolNames.length) {
				throw new Error("Vibe tool names must be unique.");
			}

			for (const tool of tools) {
				if (this.#toolRegistry.has(tool.name)) continue;
				this.#toolRegistry.set(tool.name, this.#wrapRuntimeTool(tool));
				this.#builtInToolNames.add(tool.name);
				this.#installedVibeToolNames.add(tool.name);
			}

			await this.#applyActiveToolsByName([...new Set([...baseToolNames, ...vibeToolNames])]);
		});
	}

	/** Uninstalls vibe tools and activates the replacement set. */
	deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			this.#uninstallVibeTools();
			await this.#applyActiveToolsByName([
				...nextToolNames,
				...(this.#vibeDeferredMcpRefresh ? this.#mcpManagerToolNames : []),
			]);
			this.#vibeDeferredMcpRefresh = false;
		});
	}

	/** Removes vibe tools without restoring a source-session snapshot. */
	removeVibeToolsPreservingActive(): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const removed = new Set(this.#installedVibeToolNames);
			this.#uninstallVibeTools();
			const nextEnabled = this.getEnabledToolNames().filter(name => !removed.has(name));
			await this.#applyActiveToolsByName([
				...nextEnabled,
				...(this.#vibeDeferredMcpRefresh ? this.#mcpManagerToolNames : []),
			]);
			this.#vibeDeferredMcpRefresh = false;
		});
	}

	#uninstallVibeTools(): void {
		for (const name of this.#installedVibeToolNames) {
			this.#toolRegistry.delete(name);
			this.#builtInToolNames.delete(name);
		}
		this.#installedVibeToolNames.clear();
	}

	#getEditModeSession() {
		return {
			settings: this.#host.settings,
			getActiveModelString: () => {
				const model = this.#host.model();
				return model ? formatModelString(model) : undefined;
			},
		} as const;
	}

	/** Resolves the edit mode for the active model and settings; `"none"` when the edit tool is disabled. */
	resolveActiveEditMode(): EditModeSetting {
		return resolveEditMode(this.#getEditModeSession());
	}

	/** Whether the active model inlines tool descriptors into the prompt and prunes them from the provider schemas. */
	#currentInlineDescriptors(): boolean | undefined {
		const activeModel = this.#host.model();
		if (!activeModel) return undefined;
		return shouldInlineToolDescriptors(cfgInlineToolDescriptors.get(this.#host.settings), activeModel.id);
	}

	#currentPromptModelKey(): string | undefined {
		const activeModel = this.#host.model();
		if (!activeModel) return undefined;
		if (cfgIncludeModelInPrompt.get(this.#host.settings)) return formatModelString(activeModel);
		// The inline-descriptor decision is per model and selects both the prompt's
		// tool catalog and provider-side description pruning (see `sdk.ts`).
		return `delegation-bias:${resolveDelegationBias(activeModel)}|inline-descriptors:${this.#currentInlineDescriptors()}`;
	}

	/**
	 * Rebuilds model-dependent tool prompts after a model change.
	 *
	 * `retryFallback` marks a hop down the retry fallback chain. It keeps the Model line and the
	 * Delegation wording the prompt was rendered with: re-rendering them changed the prompt's bytes,
	 * and the provider then wrote the whole cached conversation again on every hop. It still rebuilds
	 * when the hop changes what the request must carry for the new model: the edit-mode policy
	 * (#11983), or the inline-descriptor decision, which also turns provider-side description pruning
	 * on or off (#14200). The kept key makes a later switch back to the rendered model a no-op, and a
	 * deliberate switch (`/model`, `setModel`) compares against the model the prompt describes.
	 */
	async syncAfterModelChange(previousEditMode: EditModeSetting, options?: { retryFallback?: boolean }): Promise<void> {
		const currentEditMode = this.resolveActiveEditMode();
		if (options?.retryFallback) {
			const inlineDescriptorsChanged = this.#currentInlineDescriptors() !== this.#promptInlineDescriptors;
			if (previousEditMode !== currentEditMode || inlineDescriptorsChanged) await this.refreshBaseSystemPrompt();
			return;
		}
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit");
		// The system prompt selects model-specific policy even when it does not display the model id.
		const modelChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (editModeChanged || modelChanged) {
			await this.refreshBaseSystemPrompt();
		}
	}

	/**
	 * Runs `modelSwitch`, a model selection from the agent's switch to the new model through its
	 * {@link syncAfterModelChange}, as one step that main requests wait for ({@link settleModelSwitch}).
	 */
	async trackModelSwitch<T>(modelSwitch: () => Promise<T>): Promise<T> {
		const switching = modelSwitch();
		const settled = switching.then(
			() => undefined,
			() => undefined,
		);
		this.#modelSwitch = settled;
		try {
			return await switching;
		} finally {
			if (this.#modelSwitch === settled) this.#modelSwitch = undefined;
		}
	}

	/**
	 * Resolves once the model switch in progress ({@link trackModelSwitch}) has ended, at once when none runs. The agent
	 * takes the new model before its prompt is rebuilt, so a request sent between the two goes out on the new model with
	 * the old prompt, and the rebuilt one then rewrites the whole cached conversation a second time at the next request.
	 * Awaited before each main request; a request made inside a registry mutation does not wait, since the switch's
	 * rebuild runs after that mutation.
	 */
	settleModelSwitch(): Promise<void> {
		const modelSwitch = this.#modelSwitch;
		if (!modelSwitch || this.#toolRegistryMutationScope.getStore()) return Promise.resolve();
		return modelSwitch;
	}

	/** Enabled MCP tools in their current presentation partition. */
	getSelectedMCPToolNames(): string[] {
		// Every connected MCP tool is enabled; presentation (top-level vs xd://) is
		// decided by loadMode. Return the enabled MCP tools in the current set.
		return this.getEnabledToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an ACP client is connected.
	 * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
	 * the bridge exposes `requestPermission`. No-ops for all other cases.
	 *
	 * Bash follows its own approval resolution, including pattern allows, denials,
	 * and critical overrides. The schema's implicit yolo default retains ACP's
	 * client permission gate for unmatched bash commands; explicitly selecting
	 * yolo opts out. Other tools keep their existing ACP gate behavior.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#host.clientBridge();
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (PERMISSION_REQUIRED_TOOLS[tool.name] !== true) return tool;
		// Default-config ACP sessions still ask for executable calls even though
		// the schema defaults to yolo; explicit yolo is an intentional opt-in.
		if (tool.name !== "bash" && this.#isExplicitAutoApproveMode()) {
			const userPolicies: Record<string, unknown> = cfgToolsApproval.get(this.#host.settings);
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: AgentToolContext | undefined,
				) => {
					const restrictions = approvalRestrictions(this.#host.settings, this.#host.sessionManager.getCwd());
					// A restricted call is approved per call: a remembered ACP answer never covers it.
					let cacheable = restrictedFolderReason(target, args, restrictions) === undefined;
					if (target.name === "bash") {
						const explicitAutoApprove = this.#isExplicitAutoApproveMode();
						const { approvalMode, userPolicies } = resolveApprovalFromContext({
							autoApprove: this.#autoApprove,
							settings: this.#host.settings,
						});
						const mode = approvalMode === "yolo" && !explicitAutoApprove ? "always-ask" : approvalMode;
						const resolved = resolveApproval(
							target,
							args,
							mode,
							userPolicies,
							getApprovalGrants(this.#host.settings.getAgentDir(), this.#host.sessionManager.getSessionId()),
							restrictions,
							ctx,
						);
						if (resolved.policy === "deny") throw denyError(resolved, target.name);
						if (resolved.policy === "allow") {
							return await target.execute(toolCallId, args as never, signal, onUpdate, ctx as never);
						}
						// A prompt forced by a critical command or an explicit pattern
						// remains per-call, even after the client selects Always allow.
						cacheable = !resolved.override;
					}
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx as never);
					}
					// Preserve the exact arguments authorized by a selected or
					// persisted ACP grant; inner handlers may mutate `args` in place.
					const approvedCtx = (ctx ? { ...ctx, acpApprovedArgs: structuredCloneJSON(args) } : ctx) as never;
					const command =
						target.name === "bash" && args && typeof args === "object" && !Array.isArray(args)
							? stringProperty(args, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;
					// Short-circuit on persisted decisions.
					const persisted = cacheable ? this.#acpPermissionDecisions.get(permissionIntent.cacheKey) : undefined;
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, approvedCtx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" }
						| { kind: "steered" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					// The tool call's loop-owned steer signal: aborted when a
					// queued steer is detected while this batch runs, gated on
					// `interruptMode` ("wait" spares side-effecting work — the
					// dialog then simply waits, and the message injects at the
					// next boundary). Racing it instead of a session-level third
					// signal keeps the gate on the loop's own policy. Direct
					// executors without a loop context (e.g. the Cursor bridge)
					// fall back to the session's steering-arrival signal.
					const steeringSignal = ctx?.toolCall?.steeringSignal ?? this.#host.steeringArrivalSignal();
					// Park marker: only arrivals fired after this snapshot
					// belong to this dialog's supersede window — a steer
					// that fired before the dialog opened must keep its
					// natural queue position, not ride this promotion.
					const arrivalParkSeq = this.#host.steeringArrivalSeq();
					// The message that supersedes this dialog delivers at the
					// next batch boundary ahead of older queued steers, so the
					// agent reads the question that stopped the call first —
					// the same "denying steer first" semantics as the TUI
					// approval dialog (agent.prioritizeSteering, #15642).
					// Promote exactly the group whose admission fired the
					// session arrival signal — never whatever else appeared on
					// the queue in the same window: an agent-authored steer
					// enqueued after the dialog opened does not fire it, and
					// promoting it along would deliver it first under the
					// one-at-a-time boundary, making the user's superseding
					// message wait another boundary. Identity-based promotion:
					// text matching could hit an older equal-looking steer.
					const { promise: steerPromise, resolve: resolveSteer } = Promise.withResolvers<PermissionRaceResult>();
					// Only user steering may supersede the dialog. The
					// loop-owned signal aborts — once per run — for ANY queued
					// steering source (agent-authored asides, IRC interrupts
					// included), none of which the user asked to preempt
					// their own dialog, so re-check the arrival channel at
					// the loop abort and only then classify the dialog as
					// superseded. The loop's own interruptMode policy is
					// untouched: a queued non-user steer still injects at
					// the next batch boundary once the call this dialog
					// guards finishes normally.
					const userSteering = new AbortController();
					let superseded = false;
					const finishSteer = (arrived: readonly AgentMessage[]): void => {
						const queued = new Set(this.#host.agent.peekSteeringQueue());
						const promotable = arrived.filter(message => queued.has(message));
						if (promotable.length > 0) {
							this.#host.agent.prioritizeSteering(promotable);
						}
						userSteering.abort();
						resolveSteer({ kind: "steered" });
						superseded = true;
					};
					const onLoopSteer = () => {
						if (superseded) return;
						const arrived = this.#host.steeringArrivalAdmitted(arrivalParkSeq) ?? [];
						// Empty window: agent-authored or IRC steering. Keep
						// waiting — the arrival listener below still catches a
						// user steer admitted later.
						if (arrived.length === 0) {
							return;
						}
						finishSteer(arrived);
					};
					// The arrival channel re-arms on every user-steering
					// admission, so it also covers the case where an
					// agent-authored steer already spent the loop's single
					// soft abort: the loop signal being aborted is the proof
					// the interruptMode policy allowed an interrupt this
					// batch, so a user steer admitted afterwards still
					// supersedes. In "wait" mode the loop signal never
					// aborts and this listener stays inert, preserving the
					// policy.
					const arrivalSignal = this.#host.steeringArrivalSignal();
					const onArrival = () => {
						if (superseded) return;
						if (!steeringSignal.aborted) return;
						const arrived = this.#host.steeringArrivalAdmitted(arrivalParkSeq) ?? [];
						if (arrived.length === 0) return;
						finishSteer(arrived);
					};
					if (steeringSignal.aborted) {
						onLoopSteer();
					} else {
						steeringSignal.addEventListener("abort", onLoopSteer);
					}
					if (arrivalSignal.aborted) {
						onArrival();
					} else {
						arrivalSignal.addEventListener("abort", onArrival);
					}
					let raced: PermissionRaceResult;
					try {
						raced = await this.#host.waitForUser(() => {
							const permissionPromise = bridge.requestPermission!(
								{
									toolCallId,
									toolName: target.name,
									title: permissionIntent.title,
									...(target.name === "bash" ? { kind: "execute" } : {}),
									status: "pending",
									rawInput: args,
									...(commandContent ? { content: commandContent } : {}),
									locations: extractPermissionLocations(
										args,
										this.#host.sessionManager.getCwd(),
										permissionIntent.paths,
									),
								},
								PERMISSION_OPTIONS,
								signal,
								// The bridge cancels its pending wire dialog when the
								// steer wins; the gate's own race above classifies the
								// outcome either way. The derived signal keeps the wire
								// cancel on user steering only — an agent-authored or
								// IRC steer that aborted the loop signal leaves the
								// client's dialog open.
								userSteering.signal,
							).then(outcome => ({ kind: "permission" as const, outcome }));
							return Promise.race([permissionPromise, abortPromise, steerPromise]);
						});
					} finally {
						signal?.removeEventListener("abort", onAbort);
						steeringSignal.removeEventListener("abort", onLoopSteer);
						arrivalSignal.removeEventListener("abort", onArrival);
						// The dialog is over; its park window can no longer
						// read. Idempotent when a supersede's drain already
						// released it.
						this.#host.steeringArrivalRelease(arrivalParkSeq);
					}
					if (raced.kind === "steered") {
						throw new ToolAbortError("Permission request superseded by user steering");
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (cacheable && selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (cacheable && selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, approvedCtx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			(cfgToolsApprovalMode.isConfigured(this.#host.settings) &&
				cfgToolsApprovalMode.get(this.#host.settings) === "yolo")
		);
	}

	/** Applies an enabled tool set and reconciles its `xd://` partition. */
	applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		return this.runToolRegistryMutation(
			() => this.#applyActiveToolsByName(toolNames, forcePromptRefresh, signal),
			signal,
		);
	}

	/**
	 * A forced rebuild commits the live state, so it ends a held settings rebuild ({@link #applyHeldToolSet}) or a kept
	 * restored transcript prompt, unless it changes nothing of its own ({@link #takeUnchangedHeldToolSet}).
	 */
	async #applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		const held = forcePromptRefresh ? this.#heldSettingsRebuild : undefined;
		if (forcePromptRefresh && this.withholdsPromptChange && (await this.#takeUnchangedHeldToolSet(toolNames))) return;
		if (!held) return this.#applyToolSet(toolNames, forcePromptRefresh, signal);
		await this.#applyHeldToolSet(held, toolNames, signal);
	}

	/**
	 * Applies `toolNames` with a forced rebuild that ends `held`: the tools that rebuild enables join `toolNames` and
	 * the prompt lists the registry's skills when it held a rediscovery.
	 */
	#applyHeldToolSet(held: HeldSettingsRebuild, toolNames: string[], signal?: AbortSignal): Promise<void> {
		return this.#runReleasingHold(held, () => this.#applyToolSet([...toolNames, ...held.enabledTools], true, signal));
	}

	/**
	 * Runs `rebuild` with `held` ended: the hold is cleared, the prompt lists the registry's skills when it held a
	 * rediscovery, and the tools declare what they render now. A `rebuild` that throws restores the skills, and the
	 * hold unless another one began meanwhile. A rebuild that leaves the base with the held prompt's bytes sends
	 * the change in the tool definitions alone, so the held prompt withholds nothing any more
	 * ({@link #endWithheldChange}).
	 */
	async #runReleasingHold(held: HeldSettingsRebuild, rebuild: () => Promise<void>): Promise<void> {
		this.#heldSettingsRebuild = undefined;
		const promptSkills = this.#promptSkills;
		if (held.skills) this.#promptSkills = this.#skills;
		try {
			await rebuild();
		} catch (error) {
			this.#promptSkills = promptSkills;
			this.#heldSettingsRebuild ??= held;
			throw error;
		} finally {
			this.#setAgentTools(this.#host.agent.state.tools);
		}
		this.#endWithheldChangeIfBaseKept(held);
	}

	/**
	 * `tool` as the agent holds it: under a held settings rebuild, declared as the last request before the hold
	 * declared it ({@link HeldSettingsRebuild.declarations}), whatever its members render now; otherwise itself.
	 * While the change alters what the tool would declare, its other members (a call, its approval, its parser) run
	 * under the settings it was declared under ({@link HeldSettingsRebuild.toolSettings}), so a call the model shapes
	 * by the kept declaration runs as that declaration says until the rebuild.
	 */
	#declaredAs(tool: AgentTool): AgentTool {
		const own = this.#declaredOwners.get(tool) ?? tool;
		const held = this.#heldSettingsRebuild;
		const fields = held?.declarations?.tools.get(own.name);
		if (!held || !fields) return own;
		let declared = held.declared.get(own);
		if (!declared) {
			let checkedRevision: number | undefined;
			let altered = false;
			// Requests, argument checks and token counts read `fields`; every other member is the tool's own, read and
			// called through the scope below, and its methods run on the tool itself, so a tool that keeps private state
			// still runs.
			declared = forwardingProxy(own, fields, use => {
				if (this.#heldSettingsRebuild !== held) return use();
				const revision = this.#host.settings.revision;
				if (revision !== checkedRevision) {
					checkedRevision = revision;
					altered = this.#declaresOtherwise(own, fields);
				}
				return altered ? this.#toolCallSettingsScope.run(held.toolSettings, use) : use();
			});
			held.declared.set(own, declared);
			this.#declaredOwners.set(declared, own);
		}
		return declared;
	}

	/**
	 * The settings a tool reads now: inside a call to a tool whose held declaration the change altered, the ones it
	 * was declared under ({@link #declaredAs}); otherwise undefined, for the session's own.
	 */
	get toolCallSettings(): Settings | undefined {
		return this.#toolCallSettingsScope.getStore();
	}

	/**
	 * The settings a call to the tool `name` runs under, for work done on the call outside the tool, such as the
	 * transform of its arguments: while a held settings change keeps the tool declared as sent and alters what it
	 * would declare, the ones it was declared under ({@link #declaredAs}); otherwise undefined, for the session's own.
	 */
	toolCallSettingsFor(name: string): Settings | undefined {
		const held = this.#heldSettingsRebuild;
		const fields = held?.declarations?.tools.get(name);
		const tool = fields && this.#host.agent.state.tools.find(candidate => candidate.name === name);
		if (!held || !fields || !tool) return undefined;
		return this.#declaresOtherwise(this.#declaredOwners.get(tool) ?? tool, fields) ? held.toolSettings : undefined;
	}

	/** Whether `own` declares otherwise under the session's settings than its kept declaration `fields`. */
	#declaresOtherwise(own: AgentTool, fields: ToolDeclarationFields): boolean {
		return this.#toolCallSettingsScope.exit(() => toolDeclaration(own)) !== keptDeclaration(own, fields);
	}

	/**
	 * The settings a request reads where it is shaped beside the system prompt and the tool declarations (the intent
	 * field the agent loop injects, description pruning, the tool-call dialect): under a held settings rebuild, each
	 * setting the change moved reads the value the bound prompt and the kept declarations were sent with
	 * ({@link HeldSettingsRebuild.toolSettings}) until the rebuild; otherwise the session's own.
	 */
	get requestSettings(): Settings {
		return this.#heldSettingsRebuild?.toolSettings ?? this.#host.settings;
	}

	/**
	 * The session's settings with each setting of `values` reading its value there while `applies()`, and the live
	 * one otherwise: a hold's {@link HeldSettingsRebuild.toolSettings} reads each setting the held change moved from
	 * before the change while that hold lasts, and the live one once it ends (a job a call started outlives it).
	 * Writes, listeners, overlays and every other member are the session settings' own.
	 */
	#settingsWith(values: ReadonlyMap<AnySetting, unknown>, applies: () => boolean): Settings {
		const settings = this.#host.settings;
		return forwardingProxy(settings, {
			rawValue: (setting: AnySetting): unknown =>
				applies() && values.has(setting) ? values.get(setting) : settings.rawValue(setting),
			// Values derived from these never reach the session settings' memo.
			get valueCache() {
				return [];
			},
		});
	}

	/** Gives the agent `tools`, each {@link #declaredAs} the agent holds it; nothing when that changes nothing. */
	#setAgentTools(tools: readonly AgentTool[]): void {
		const declared = tools.map(tool => this.#declaredAs(tool));
		if (sameItems(this.#host.agent.state.tools, declared)) return;
		this.#host.agent.setTools(declared);
	}

	/**
	 * Under a held settings rebuild or a kept restored transcript prompt, takes a forced tool-set apply that changes
	 * nothing of its own, such as an extension registering a tool again with the same definition: the same tools in
	 * the same places, each declared as now, and a system prompt that renders the build the base stands in for again.
	 * Only the tools' current implementations are taken; the prompt, the declarations and the withheld change stay.
	 * False when the apply changes something, or when this cannot tell (a tool that could move under or out of
	 * `xd://`).
	 */
	async #takeUnchangedHeldToolSet(toolNames: string[]): Promise<boolean> {
		const names = normalizeToolNames(toolNames);
		const enabled = normalizeToolNames(this.getEnabledToolNames());
		if (names.length !== enabled.length || names.some((name, index) => name !== enabled[index])) return false;
		const declared = this.#host.agent.state.tools.map(tool => this.#declaredOwners.get(tool) ?? tool);
		const pinned = (name: string): boolean =>
			this.#presentationPinnedToolNames?.has(name) === true || this.#runtimeSelectedToolNames?.has(name) === true;
		const mayMove = (tool: AgentTool): boolean => !pinned(tool.name) && isMountableUnderXdev(tool);
		if (this.#xdev && ([...this.#xdev.mountedNames].some(pinned) || declared.some(mayMove))) return false;
		const current = declared.map(tool => this.#toolRegistry.get(tool.name) ?? tool);
		if (current.some((tool, index) => toolDeclaration(tool) !== toolDeclaration(declared[index]))) return false;
		const base = this.#baseSystemPrompt;
		const prepared = await this.#prepareBaseSystemPrompt();
		if (prepared?.systemPrompt !== base || this.#baseSystemPrompt !== base) return false;
		this.#setAgentTools(this.#withCurrentImplementations(declared, current));
		return true;
	}

	/**
	 * `declared`, the agent's tools by their declared owners, each replaced by the registry's entry for it where that
	 * is another tool (`current`, index-aligned, looked up now unless given), wrapped for ACP permission.
	 */
	#withCurrentImplementations(
		declared: readonly AgentTool[],
		current: readonly AgentTool[] = declared.map(tool => this.#toolRegistry.get(tool.name) ?? tool),
	): AgentTool[] {
		return declared.map((tool, index) =>
			current[index] === tool ? tool : this.#wrapToolForAcpPermission(current[index]),
		);
	}

	async #applyToolSet(toolNames: string[], forcePromptRefresh: boolean, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		toolNames = normalizeToolNames(toolNames);
		let builtInWriteAvailable = this.#builtInToolNames.has("write");
		const fullWriteSelected =
			toolNames.includes("write") &&
			(this.#presentationPinnedToolNames?.has("write") === true ||
				this.#runtimeSelectedToolNames?.has("write") === true);
		if (fullWriteSelected) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			if (writeRegistration) {
				builtInWriteAvailable = (await untilAborted(signal, writeRegistration)) === true;
				if (builtInWriteAvailable) this.#builtInToolNames.add("write");
			}
		}
		const upgradeDeviceOnlyWrite =
			fullWriteSelected &&
			builtInWriteAvailable &&
			this.#isDeviceOnlyWrite?.() === true &&
			this.#setDeviceOnlyWrite !== undefined &&
			this.#setPendingFullWriteDescription !== undefined;
		// Goal mode may have been enabled after session creation, leaving the
		// registry without `goal`. Register it before resolving the selection so
		// `#enterGoalMode`'s `[...tools, "goal"]` request is honored instead of
		// silently dropped (issue #9444).
		if (toolNames.includes("goal") && !this.#toolRegistry.has("goal")) {
			const goalRegistration = this.#ensureGoalRegistered?.();
			if (goalRegistration) await untilAborted(signal, goalRegistration);
		}
		const selectedTools = toolNames.flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [{ name, tool }] : [];
		});
		const xdevReadAvailable = this.#builtInToolNames.has("read") && selectedTools.some(({ name }) => name === "read");
		const xdevWriteAvailable =
			builtInWriteAvailable &&
			(selectedTools.some(({ name }) => name === "write") || this.#deviceOnlyWriteTransportAvailable);
		const isPresentationPinned = (name: string): boolean =>
			this.#presentationPinnedToolNames?.has(name) === true || this.#runtimeSelectedToolNames?.has(name) === true;
		const mountCandidates = selectedTools.filter(
			({ name, tool }) =>
				this.#xdev !== undefined &&
				xdevReadAvailable &&
				xdevWriteAvailable &&
				!isPresentationPinned(name) &&
				isMountableUnderXdev(tool),
		);
		const mountNames = new Set(mountCandidates.map(({ name }) => name));
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const { name, tool } of selectedTools) {
			if (mountNames.has(name)) continue;
			tools.push(this.#wrapToolForAcpPermission(tool));
			validToolNames.push(name);
		}

		const pinnedWrite = isPresentationPinned("write");
		const activeDeferrableTool = tools.some(tool => tool.deferrable === true);
		const transportNeeded = mountNames.size > 0 || activeDeferrableTool || this.#host.planModeEnabled();
		if (transportNeeded && !builtInWriteAvailable) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			builtInWriteAvailable = writeRegistration ? (await untilAborted(signal, writeRegistration)) === true : false;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		if (transportNeeded && builtInWriteAvailable) {
			const write = this.#toolRegistry.get("write");
			if (write && !validToolNames.includes("write")) {
				tools.push(this.#wrapToolForAcpPermission(write));
				validToolNames.push("write");
			}
		} else if (
			!pinnedWrite &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined)
		) {
			const writeNameIndex = validToolNames.indexOf("write");
			if (writeNameIndex >= 0 && this.#builtInToolNames.has("write")) validToolNames.splice(writeNameIndex, 1);
			const writeToolIndex = tools.findIndex(tool => tool.name === "write" && this.#builtInToolNames.has("write"));
			if (writeToolIndex >= 0) tools.splice(writeToolIndex, 1);
		}

		const restrictDeviceOnlyWrite =
			validToolNames.includes("write") &&
			!fullWriteSelected &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined) &&
			builtInWriteAvailable &&
			this.#isDeviceOnlyWrite?.() !== true &&
			this.#setDeviceOnlyWrite !== undefined;
		const restoreDormantDeviceOnlyWrite =
			!validToolNames.includes("write") &&
			this.#deviceOnlyWriteTransportAvailable &&
			this.#isDeviceOnlyWrite?.() !== true &&
			this.#setDeviceOnlyWrite !== undefined;
		const deactivateDeviceOnlyWrite =
			!validToolNames.includes("write") &&
			!this.#deviceOnlyWriteTransportAvailable &&
			this.#isDeviceOnlyWrite?.() === true &&
			this.#setDeviceOnlyWrite !== undefined;
		const previousMounted = new Set(this.#xdev?.mountedNames ?? []);
		const previousActiveToolNames = this.getActiveToolNames();
		const previousEnabledToolNames = this.#enabledToolNames;
		this.#enabledToolNames = new Set([...validToolNames, ...mountNames]);
		this.#setMountedNames(mountNames);
		this.#setActiveToolNames?.(validToolNames);

		let rebuiltSystemPrompt: string[] | undefined;
		let rebuiltSignature: string | undefined;
		let frozenSignature: string | undefined;
		// Trigger of an implicit (non-forced) rebuild, rechecked at commit.
		let implicitRebuildSignature: string | undefined;
		let rebuiltXdevCatalogNames: readonly string[] | undefined;
		let rebuiltSettingsRead: ReadonlyMap<AnySetting, unknown> | undefined;
		let candidateSurface: PromptSurface | undefined;
		try {
			if (restrictDeviceOnlyWrite) this.#setDeviceOnlyWrite?.(true);
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(true);
			if (this.#rebuildSystemPrompt) {
				// Local alias: closures below cannot observe the field narrowing.
				const rebuildSystemPrompt = this.#rebuildSystemPrompt;
				const mountedSignatureTools = [...mountNames].flatMap(name => {
					const tool = this.#toolRegistry.get(name);
					return tool ? [tool] : [];
				});
				// Derive the candidate surface and run both the signature
				// computation and the awaited render inside its scope: the tool
				// getters read the candidate, so prompt, signature and provider
				// schemas describe the same state. Nothing publishes outside this
				// frame until the commit below.
				const candidate = this.#derivePromptSurface();
				const computeSignature = (surface: PromptSurface): string =>
					this.#promptSurfaceScope.run(surface, () =>
						this.#computeAppliedToolSignature(validToolNames, tools, mountedSignatureTools),
					);
				// Eval-prelude, eval tool-name, model-mention, discovered-agent and
				// per-call model changes alone never trigger a rebuild: they ride
				// their hidden notices. The trigger keeps the committed sets; a
				// rebuild caused by anything else absorbs the live ones.
				const triggerSignature = computeSignature({
					...candidate,
					evalPreludes: this.#promptSurface.evalPreludes,
					sessionAgents: this.#promptSurface.sessionAgents,
					evalToolNames: this.#promptSurface.evalToolNames,
					discoveredAgents: this.#promptSurface.discoveredAgents,
					perCallModels: this.#promptSurface.perCallModels,
				});
				// A base that stands in for a build of this process's (a held settings rebuild, a kept restored
				// transcript prompt) renders the frozen change too: that build takes it in, so a later rebuild that
				// renders it again changes nothing of its own.
				const freezeImplicitPromptRefresh =
					!forcePromptRefresh &&
					triggerSignature !== this.#lastAppliedToolSignature &&
					this.#implicitRebuildBinding() === "frozen" &&
					this.#baseStandIn?.base !== this.#baseSystemPrompt;
				if (freezeImplicitPromptRefresh) {
					frozenSignature = triggerSignature;
				} else if (forcePromptRefresh || triggerSignature !== this.#lastAppliedToolSignature) {
					const signature = computeSignature(candidate);
					const built = await untilAborted(
						signal,
						this.#promptSurfaceScope.run(candidate, () =>
							rebuildSystemPrompt(validToolNames, this.#toolRegistry, this.#xdev),
						),
					);
					rebuiltSystemPrompt = built.systemPrompt;
					if (!forcePromptRefresh) implicitRebuildSignature = triggerSignature;
					rebuiltSignature = signature;
					rebuiltXdevCatalogNames = built.xdevCatalogNames;
					rebuiltSettingsRead = built.settingsRead;
					candidateSurface = candidate;
				}
			}
			signal?.throwIfAborted();
		} catch (error) {
			if (restrictDeviceOnlyWrite) this.#setDeviceOnlyWrite?.(false);
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(false);
			this.#setMountedNames(previousMounted);
			this.#setActiveToolNames?.(previousActiveToolNames);
			this.#enabledToolNames = previousEnabledToolNames;
			throw error;
		}

		if (this.#host.isDisposed()) {
			if (restrictDeviceOnlyWrite) this.#setDeviceOnlyWrite?.(false);
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(false);
			this.#setMountedNames(previousMounted);
			this.#setActiveToolNames?.(previousActiveToolNames);
			this.#enabledToolNames = previousEnabledToolNames;
			return;
		}

		try {
			this.#emitXdevMountChange(previousMounted);
			this.#setAgentTools(tools);
			// The first primary model call can capture the prompt while the rebuild
			// awaits; that prompt is bound from then on, so an implicit rebuild ends
			// exactly as if it had frozen up front. Before that call, a resumed
			// transcript binds the prompt it was sent with: only a rebuild that
			// reproduces it commits.
			let restoresTranscriptPrompt = false;
			if (rebuiltSystemPrompt && implicitRebuildSignature !== undefined) {
				const binding = this.#implicitRebuildBinding();
				restoresTranscriptPrompt =
					typeof binding === "object" && systemPromptDigest(rebuiltSystemPrompt) === binding.promptDigest;
				if (binding !== "free" && !restoresTranscriptPrompt) {
					// This process's newest own build, for a base that stands in for one.
					const standIn = this.#baseStandIn;
					if (standIn?.base === this.#baseSystemPrompt) {
						this.#baseStandIn = {
							base: standIn.base,
							build: rebuiltSystemPrompt,
							settingsRead: rebuiltSettingsRead ?? NO_SETTINGS,
						};
					}
					rebuiltSystemPrompt = undefined;
					frozenSignature = implicitRebuildSignature;
				}
			}
			if (rebuiltSystemPrompt && rebuiltSignature) {
				// The restored transcript was sent with this prompt under the inherited cache key. A prompt
				// restored from the branch was too, so replacing it with another drops the key.
				const committed = this.#lastAppliedToolSignature !== undefined || this.#basePromptRestored;
				if (committed && !restoresTranscriptPrompt) {
					this.#host.clearInheritedProviderPromptCacheKey();
				}
				this.#baseSystemPrompt = this.#committedBase(rebuiltSystemPrompt);
				this.#promptSettingsRead = rebuiltSettingsRead ?? NO_SETTINGS;
				this.#promptUnreadChanges = NO_SETTINGS;
				this.#host.clearMemoryPromotionSnapshot();
				this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
				invalidateToolSchemaMetadata(this.#host.agent.state.tools);
				this.#lastAppliedToolSignature = rebuiltSignature;
				this.#recordBasePromptListing(validToolNames, rebuiltXdevCatalogNames);
				this.#promptModelKey = this.#currentPromptModelKey();
				this.#promptInlineDescriptors = this.#currentInlineDescriptors();
				// Publish the exact surface the prompt rendered with — never
				// re-derive from live settings, which could diverge mid-flight.
				this.#promptSurface = candidateSurface ?? this.#promptSurface;
			} else if (frozenSignature) {
				this.#lastAppliedToolSignature = frozenSignature;
				this.#promptRosterHeld = true;
			}
			if (restoreDormantDeviceOnlyWrite) {
				this.#setDeviceOnlyWrite?.(true);
			} else if (upgradeDeviceOnlyWrite || deactivateDeviceOnlyWrite) {
				this.#setDeviceOnlyWrite?.(false);
			}
		} finally {
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(false);
		}
	}

	#setMountedNames(names: Iterable<string>): void {
		const mountedNames = this.#xdev?.mountedNames;
		if (!mountedNames) return;
		mountedNames.clear();
		for (const name of names) mountedNames.add(name);
	}

	/**
	 * Records what a just-committed base prompt lists ({@link #basePromptListing}): `toolNames`, the roster it
	 * rendered, and the devices its catalog renders (`xdevCatalogNames`) with the routed MCP devices. A base whose
	 * bytes the branch stores ({@link #storedPrompt}: one this session's transcript, or the transcript it was copied
	 * from, recorded when a request carried them) lists what that record names, its skills included, whichever build
	 * reproduced them (a `/tan` clone's copy of its parent's prompt, a revived task's stored one, whose first block no
	 * longer matches a fresh render). Ends any roster hold ({@link #recordPromptRoster}).
	 */
	#recordBasePromptListing(toolNames: readonly string[], xdevCatalogNames: readonly string[] | undefined): void {
		const stored = this.#storedPrompt(systemPromptDigest(this.#baseSystemPrompt));
		this.#basePromptListing = stored
			? {
					toolNames: stored.toolNames,
					xdevNames: new Set(stored.xdevNames),
					skills: new Map(stored.skills.map(({ name, description }) => [name, description])),
				}
			: {
					toolNames: [...toolNames],
					xdevNames: new Set([...(xdevCatalogNames ?? []), ...this.#routedSummaryXdevNames()]),
				};
		this.#recordPromptRoster(this.#basePromptListing.toolNames);
	}

	/** Mounted MCP devices the live route projection lists with their catalog summary. */
	#routedSummaryXdevNames(): ReadonlySet<string> {
		if (!this.#xdev) return new Set();
		const docsPlan = planXdevPromptDocs(
			this.#xdev,
			cfgToolsXdevDocs.get(this.#host.settings),
			cfgToolsXdevInlineDevices.get(this.#host.settings),
		);
		return new Set(
			projectMountedMCPXdevGuidance(collectMountedMCPToolRoutes(listXdevTools(this.#xdev)))
				.mappings.filter(mapping => docsPlan.catalog.has(mapping.name))
				.map(mapping => mapping.name),
		);
	}

	#latestReply(): AgentMessage | undefined {
		return this.#host.agent.state.messages.findLast(message => message.role === "assistant");
	}

	/**
	 * Whether the prompt is bound: a prefix-bound model has answered under it, or a primary call in flight on one was
	 * sent with it, whose reply binds it ({@link #holdSettingsRebuild}).
	 */
	get #promptBound(): boolean {
		return this.#host.model()?.thinking?.prefixBinding === true && !this.#promptUnanswered;
	}

	/**
	 * Whether nothing binds the prompt yet, on any model: the transcript holds no reply, and no primary model call has
	 * captured the prompt ({@link #rebuildUnboundPrompt}).
	 */
	get #promptUnanswered(): boolean {
		return this.#latestReply() === undefined && this.#capturedCall === undefined;
	}

	/** Digest of the base prompt the current branch's newest reply with provider output was produced under. */
	recordedPromptDigest(): string | undefined {
		const branch = this.#host.sessionManager.getBranchView();
		this.#recordedDigestScan = scanNewestRecord(this.#recordedDigestScan, branch, promptDigestOfEntry);
		return this.#recordedDigestScan.value;
	}

	/** Digest of the tool definitions the current branch's newest reply with provider output was produced under. */
	recordedToolsDigest(): string | undefined {
		const branch = this.#host.sessionManager.getBranchView();
		this.#recordedToolsDigestScan = scanNewestRecord(this.#recordedToolsDigestScan, branch, toolsDigestOfEntry);
		return this.#recordedToolsDigestScan.value;
	}

	/** Digest of the agent's current base prompt, comparable with the digests recorded on the branch. */
	currentPromptDigest(): string {
		const base = this.baseOfSystemPrompt(this.#host.agent.state.systemPrompt);
		const memo = this.#currentPromptDigest;
		if (memo?.base === base) return memo.digest;
		const digest = systemPromptDigest(base);
		this.#currentPromptDigest = { base, digest };
		return digest;
	}

	/**
	 * Called with the prompt a primary model call captures, before the request is
	 * sent. From then on the transcript's signed thinking may be bound to that
	 * prompt, whatever later history edits (`/tree`, fork, recovery) leave as the
	 * newest reply, so the restored transcript is dropped for good. The capture,
	 * with the digest of the tool definitions the call declares, is not recorded
	 * yet: the call may still stop before it is sent; see
	 * {@link bindReplyToCapturedPrompt}. Side requests (`runEphemeralTurn`) do
	 * not count. On a prefix-bound model, what the call declares for each tool
	 * is kept too, for a settings change held on that prompt
	 * ({@link HeldSettingsRebuild.declarations}), a tool taken off the roster
	 * that the request still declares included; a held call declares what the
	 * hold keeps.
	 */
	recordPrimaryModelCall(prompt: string[]): void {
		this.#restoredTranscript = undefined;
		// What the previous request declared, while the conversation continues from it.
		const previous = this.#sentDeclarations;
		const continued = previous?.toolsDigest === this.#boundToolsDigest() ? previous : undefined;
		const promptDigest = systemPromptDigest(this.baseOfSystemPrompt(prompt));
		const toolsDigest = this.#host.toolDefinitionsDigest();
		this.#capturedCall = {
			digests: { prompt: promptDigest, tools: toolsDigest },
			activeTools: this.#host.agent.state.tools,
		};
		if (this.#heldSettingsRebuild) return;
		if (this.#host.model()?.thinking?.prefixBinding !== true) {
			this.#sentDeclarations = undefined;
			return;
		}
		// A provider that keeps a withdrawn tool declared (Anthropic) declares it as it was last sent.
		const stillDeclared = new Set(latestToolDeclaration(this.#host.agent.state.messages)?.declared);
		const tools = new Map([...(continued?.tools ?? [])].filter(([name]) => stillDeclared.has(name)));
		for (const tool of this.#host.agent.state.tools) tools.set(tool.name, toolDeclarationFields(tool));
		this.#sentDeclarations = { promptDigest, toolsDigest, tools };
	}

	/**
	 * Digest of the tool definitions the conversation's newest request declared, which the next request declares to
	 * read the cache entry it left: the call in flight's, else that of the call the newest reply was produced by, as
	 * this process captured it or the current branch records it.
	 */
	#boundToolsDigest(): string | undefined {
		if (this.#capturedCall) return this.#capturedCall.digests.tools;
		const reply = this.#latestReply();
		return (reply && this.#replyCalls.get(reply)?.tools) ?? this.recordedToolsDigest();
	}

	/**
	 * Called each time a provider turns a fallback on in the session's provider state. Only the strict-tools fallback
	 * changes the digest: the endpoint rejected strict tools, so the call in flight retries sending its tools without
	 * `strict`. The digest of its tool definitions is taken again for the tools it captured, now that the fallback
	 * counts in it, and so are the declarations kept with that digest (what the call declares, what a held rebuild
	 * keeps declaring), so its reply records the definitions the retry sent. A call the fallback does not reach, and
	 * any other fallback, keeps its digest. Gives whether a call in flight now counts other tool definitions.
	 */
	recountCapturedCallTools(): boolean {
		const call = this.#capturedCall;
		if (!call) return false;
		const { digests } = call;
		const recounted = this.#host.toolDefinitionsDigest(call.activeTools);
		if (recounted === digests.tools) return false;
		this.#capturedCall = { digests: { prompt: digests.prompt, tools: recounted }, activeTools: call.activeTools };
		const sent = this.#sentDeclarations;
		if (sent?.toolsDigest === digests.tools) this.#sentDeclarations = { ...sent, toolsDigest: recounted };
		const held = this.#heldSettingsRebuild;
		const kept = held?.declarations;
		if (held && kept?.toolsDigest === digests.tools) held.declarations = { ...kept, toolsDigest: recounted };
		return true;
	}

	/**
	 * Called synchronously when a primary reply ends. A reply carrying provider
	 * output was produced by the last captured call; one without (a call
	 * stopped before it was sent, an abort before the first event) binds nothing,
	 * so the replies before it keep their prompt and tools.
	 */
	bindReplyToCapturedPrompt(reply: AgentMessage): void {
		const call = this.#capturedCall;
		this.#capturedCall = undefined;
		if (call === undefined || reply.role !== "assistant") return;
		if (reply.content.some(block => block.type !== "text" || block.text.length > 0)) {
			this.#replyCalls.set(reply, call.digests);
		}
	}

	/**
	 * Called just before a primary reply is appended to the branch: records the
	 * digests of the prompt and the tool definitions it was produced under where
	 * they differ from the branch's, ahead of the reply so every path to the
	 * reply carries them. A reply under a prompt that withholds a change (a kept
	 * restored transcript prompt, a held settings rebuild) also records when the
	 * change was made, unless the branch records it already: a branch `/tree`
	 * moved to, or one copied into another session file, then carries it as the
	 * branch the change began on does. A reply under the prompt of a spent hold
	 * ({@link #spentHold}) ends the session's record of it.
	 */
	recordReplyPrompt(reply: AgentMessage): void {
		const call = this.#replyCalls.get(reply);
		if (call === undefined) return;
		this.recordPromptDigest(call.prompt);
		this.recordToolsDigest(call.tools);
		this.#settleRestoredPrompt();
		this.#endSpentHold(call.prompt);
		// A reply under another prompt records it, which ends the spent hold's record on this branch.
		this.#spentHold = undefined;
		const restored = this.#restoredPrompt;
		if (restored?.digest === call.prompt) this.#recordWithheldChange(restored);
		const held = this.#heldSettingsRebuild;
		if (held?.digest === call.prompt) this.#recordWithheldChange(held);
	}

	/**
	 * Drops the restored transcript prompt once the base replaced it with the same bytes (this process's own build
	 * reproduced it; one that holds settings keeps its base instead, {@link #committedBase}): it withholds nothing any
	 * more, so a hold the session records on it is spent ({@link #spentHold}).
	 */
	#settleRestoredPrompt(): void {
		const restored = this.#restoredPrompt;
		if (!restored || restored.base === this.#baseSystemPrompt || !sameItems(restored.base, this.#baseSystemPrompt)) {
			return;
		}
		this.#restoredPrompt = undefined;
		if (this.#baseStandIn?.base === restored.base) this.#baseStandIn = undefined;
		if (restored.recorded) this.#spentHold = restored;
	}

	/** Ends the session's record of the spent hold ({@link #spentHold}) when it is on the prompt `digest` names. */
	#endSpentHold(digest: string): void {
		const spent = this.#spentHold;
		if (spent?.digest !== digest) return;
		this.#spentHold = undefined;
		this.#endWithheldChange(spent);
	}

	/**
	 * Records `digest` on the current branch unless it is already the branch's
	 * newest record, and stores the blocks it names (see {@link #storePromptBlocks}).
	 */
	recordPromptDigest(digest: string | undefined): void {
		if (digest === undefined) return;
		if (digest !== this.recordedPromptDigest()) {
			this.#host.sessionManager.appendCustomEntry(SYSTEM_PROMPT_DIGEST_CUSTOM_TYPE, digest);
		}
		this.#storePromptBlocks(digest);
	}

	/** Records `digest` on the current branch unless it is already the branch's newest tool-definitions record. */
	recordToolsDigest(digest: string | undefined): void {
		if (digest === undefined || digest === this.recordedToolsDigest()) return;
		this.#host.sessionManager.appendCustomEntry(TOOL_DEFINITIONS_DIGEST_CUSTOM_TYPE, digest);
	}

	/**
	 * The skills the base prompt lists, by name, with the description it gives each, in the order it lists them: a
	 * restored transcript prompt's ({@link PromptListing.skills}), else the ones this process's prompt renders.
	 */
	#basePromptSkills(): ReadonlyMap<string, string> {
		return (
			this.#basePromptListing.skills ??
			new Map<string, string>(listedSkills(this.#promptSkills).map(skill => [skill.name, skill.description]))
		);
	}

	/**
	 * Stores the base prompt blocks `digest` names on the current branch, once
	 * per digest, for a resumed process to send again (see
	 * {@link #restoreTranscriptPrompt}), with the settings their build read
	 * ({@link #promptSettingsRead}; a credential by id only). Only the current
	 * base is at hand: a reply produced under an older one (a forced rebuild
	 * committed while it streamed) leaves its digest without blocks. Nothing
	 * reads them for a model that does not bind its prefix, or when the operator
	 * inputs cannot be compared, so nothing is stored then.
	 */
	#storePromptBlocks(digest: string): void {
		const operatorDigest = this.#operatorPromptDigest;
		if (operatorDigest === undefined || this.#host.model()?.thinking?.prefixBinding !== true) return;
		if (this.#storedPrompt(digest) !== undefined || digest !== this.currentPromptDigest()) return;
		const stored: StoredSystemPrompt = {
			digest,
			blocks: [...this.baseOfSystemPrompt(this.#host.agent.state.systemPrompt)],
			toolNames: [...this.#basePromptListing.toolNames],
			xdevNames: [...this.#basePromptListing.xdevNames],
			skills: [...this.#basePromptSkills()].map(([name, description]) => ({ name, description })),
			operatorDigest,
			settingsRead: [...this.#promptSettingsRead].map(([setting, value]) => heldSettingRecord(setting, value)),
		};
		this.#host.sessionManager.appendCustomEntry(SYSTEM_PROMPT_CUSTOM_TYPE, stored);
	}

	/** The newest prompt the current branch stores for `digest`. */
	#storedPrompt(digest: string): StoredSystemPrompt | undefined {
		const branch = this.#host.sessionManager.getBranchView();
		let scan = this.#storedPromptScan;
		if (scan?.branch !== branch) {
			scan = { branch, scanned: 0, prompts: new Map() };
			this.#storedPromptScan = scan;
		}
		for (; scan.scanned < branch.length; scan.scanned++) {
			const stored = storedPromptOfEntry(branch[scan.scanned]);
			if (stored) scan.prompts.set(stored.digest, stored);
		}
		return scan.prompts.get(digest);
	}

	/**
	 * Records on the current branch that the base prompt `change` names withholds
	 * a change made at its `since`, for a resumed process that restores that
	 * prompt ({@link #recordedHold}), unless the branch records that time
	 * since it last recorded another prompt or ended a hold on this one, and the
	 * settings it holds with the values that prompt was built with
	 * ({@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE}), each the branch does not
	 * name since then. A spent hold on the same prompt ({@link #spentHold}) is
	 * ended first, so the records follow the end. Nothing reads them when the
	 * operator inputs cannot be compared, so nothing is recorded then.
	 */
	#recordWithheldChange(change: WithheldChange & HeldSettings): void {
		if (!this.#writesHoldRecords(change)) return;
		this.#settleRestoredPrompt();
		this.#endSpentHold(change.digest);
		const branch = this.#host.sessionManager.getBranchView();
		if (change.recordedOn === branch) return;
		// The view grows in place with the record and the entries after it.
		change.recordedOn = branch;
		change.recorded = true;
		let dated = false;
		const unnamed = new Map(change.before);
		const other = otherPromptRecordIndex(branch, change.digest);
		for (let index = branch.length - 1; index > other; index--) {
			const entry = branch[index];
			if (promptHoldEndOfEntry(entry) === change.digest) break;
			const withheld = promptHoldOfEntry(entry);
			if (withheld?.digest === change.digest && withheld.since === change.since) dated = true;
			const named = heldSettingsOfEntry(entry);
			if (named?.digest === change.digest && named.hold === change.id) {
				for (const setting of unnamed.keys()) {
					if (named.settings.some(record => record.id === setting.id)) unnamed.delete(setting);
				}
			}
			// The branch records both already.
			if (dated && unnamed.size === 0) return;
		}
		if (!dated) {
			const record: SystemPromptHold = { digest: change.digest, since: change.since };
			this.#host.sessionManager.appendCustomEntry(SYSTEM_PROMPT_HOLD_CUSTOM_TYPE, record);
		}
		if (unnamed.size === 0) return;
		const record: SystemPromptHeldSettings = {
			digest: change.digest,
			hold: change.id,
			settings: [...unnamed].map(([setting, value]) => heldSettingRecord(setting, value)),
		};
		this.#host.sessionManager.appendCustomEntry(SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE, record);
	}

	/**
	 * Records that the base prompt `change` names withholds nothing any more while it keeps its bytes
	 * ({@link SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE}): a resumed process that restores that prompt then dates what it
	 * withholds from a later hold record, or from the restore. Only a change the session records is ended.
	 */
	#endWithheldChange(change: WithheldChange): void {
		if (!change.recorded || !this.#writesHoldRecords(change)) return;
		change.recorded = false;
		change.recordedOn = undefined;
		const record: SystemPromptHoldEnd = { digest: change.digest };
		this.#host.sessionManager.appendCustomEntry(SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE, record);
	}

	/**
	 * Ends `change` ({@link #endWithheldChange}) when a rebuild left the base prompt with the bytes that withhold it:
	 * the change went out in the tool definitions alone, or nothing of it was left to withhold.
	 */
	#endWithheldChangeIfBaseKept(change: WithheldChange): void {
		if (!this.#host.isDisposed() && systemPromptDigest(this.#baseSystemPrompt) === change.digest) {
			this.#endWithheldChange(change);
		}
	}

	/**
	 * Whether hold records of `change` are written: a resumed process can compare the operator inputs, so it reads
	 * them, and the session is the one whose transcript the prompt withholds the change from.
	 */
	#writesHoldRecords(change: WithheldChange): boolean {
		return this.#operatorPromptDigest !== undefined && change.sessionId === this.#host.sessionManager.getSessionId();
	}

	/**
	 * A change the base prompt `digest` names has withheld from this session's transcript since `since`: not due, on
	 * no branch view yet, and `recorded` when the session holds a hold record of it that no end record ended.
	 */
	#withheldChange(digest: string, since: number, recorded: boolean): WithheldChange {
		return {
			digest,
			since,
			due: false,
			recordedOn: undefined,
			recorded,
			sessionId: this.#host.sessionManager.getSessionId(),
		};
	}

	/**
	 * What the session records of a change the base prompt `digest` names
	 * withholds: when it began, the earliest {@link SYSTEM_PROMPT_HOLD_CUSTOM_TYPE}
	 * record naming it written after the current branch last recorded another
	 * prompt, on any branch, and after the last
	 * {@link SYSTEM_PROMPT_HOLD_END_CUSTOM_TYPE} record naming it, on any branch;
	 * and the settings each {@link SYSTEM_PROMPT_HELD_SETTINGS_CUSTOM_TYPE} record
	 * naming it in that span names. Undefined when no hold record is there.
	 * The change was made to the process, not to a branch: `/tree` onto a branch
	 * that holds no record of it, before a restart, leaves it no less old, and a
	 * change that went out on another branch went out of the process.
	 */
	#recordedHold(digest: string): RecordedHold | undefined {
		const branch = this.#host.sessionManager.getBranchView();
		const other = otherPromptRecordIndex(branch, digest);
		const entries = this.#host.sessionManager.getEntries();
		let since: number | undefined;
		let settings = new Map<string, HeldSettingRecord>();
		for (let index = other < 0 ? 0 : entries.indexOf(branch[other]) + 1; index < entries.length; index++) {
			const entry = entries[index];
			if (promptHoldEndOfEntry(entry) === digest) {
				since = undefined;
				settings = new Map();
				continue;
			}
			const withheld = promptHoldOfEntry(entry);
			if (withheld?.digest === digest) since = Math.min(withheld.since, since ?? withheld.since);
			const named = heldSettingsOfEntry(entry);
			if (named?.digest !== digest) continue;
			for (const record of named.settings) if (!settings.has(record.id)) settings.set(record.id, record);
		}
		return since === undefined ? undefined : { since, settings };
	}

	/**
	 * Each setting `records` name, with the value the prompt they name was built with; undefined when one cannot be
	 * told to the model: a credential, whose value is never recorded, or a setting this process does not know.
	 */
	#heldSettingValues(records: ReadonlyMap<string, HeldSettingRecord>): Map<AnySetting, unknown> | undefined {
		const values = new Map<AnySetting, unknown>();
		for (const [id, record] of records) {
			const setting = lookupSetting(id);
			if (!setting || setting.isCredential) return undefined;
			values.set(setting, record.value);
		}
		return values;
	}

	/**
	 * Starts a resumed transcript from the prompt its newest reply was sent
	 * with, when the branch stores it, this process built another one from
	 * the same operator inputs, and the next request reads the transcript's
	 * live cache entry. The rest of a startup build is raced against
	 * deadlines or read from caches another process filled (skill descriptions,
	 * context files, the workspace tree, tools that register late), and a changed
	 * prompt makes a prefix-bound model write the whole cached conversation
	 * again and drop its replayed thinking. What this build would change then
	 * waits, as it does mid-session, on the frozen prompt's notices or a rebuild
	 * that changes the prompt anyway; a rebuild that only renders this process's
	 * own build again (a startup step such as extension skill discovery or a
	 * memory backend refreshing the prompt) keeps the stored one. The stored
	 * prompt keeps nothing but that entry's prefix: with the entry lapsed,
	 * written for another model or retention, or followed by a compaction, the
	 * request writes the whole prompt anyway, so this process's own build goes
	 * out. So it does when the first request declares other tool definitions
	 * than the transcript's last one (they come first in cache order): tools
	 * may still register here, so that request finds the entry unreadable and
	 * releases the stored prompt first ({@link replaceRestoredPromptIfDue}). It
	 * goes out too once the change the stored prompt withholds is
	 * {@link WITHHELD_CHANGE_MAX_AGE_MS} old by the session's record, on
	 * whichever branch ({@link #recordedHold}), a record dated after the
	 * clock counting from now; a restored prompt is released as soon as that or
	 * any other reason to keep it ends ({@link replaceRestoredPromptIfDue}).
	 * The settings a held change the session records holds go into the
	 * settings notice ({@link takeSettingsNotice}), each with the value the
	 * stored prompt was built with, so the model learns of a change held
	 * after the transcript's last request too; one it cannot be told of (a
	 * credential, a setting this process does not know) sends this process's
	 * own build instead. When this process's own build is the transcript's
	 * prompt, a hold the session records on it withholds nothing from the
	 * prompt, but the notices of one that holds settings may tell the model
	 * what is no longer so (a setting set back before the restart, a tool
	 * they called refused that runs again): the stored prompt is restored all
	 * the same, so the settings notice puts them right; a hold that holds no
	 * setting, or one on a prompt that is not restored, is spent
	 * ({@link #spentHold}). Models that do not bind their prefix keep the
	 * fresh build: they rebuild freely mid-session as well.
	 */
	#restoreTranscriptPrompt(): void {
		const promptDigest = this.#restoredTranscript?.promptDigest;
		const operatorDigest = this.#operatorPromptDigest;
		if (!promptDigest || operatorDigest === undefined || this.#host.model()?.thinking?.prefixBinding !== true) return;
		if (systemPromptDigest(this.#baseSystemPrompt) !== promptDigest) {
			this.#restoreStoredPrompt(promptDigest, operatorDigest);
			return;
		}
		const recorded = this.#recordedHold(promptDigest);
		if (!recorded) return;
		if (recorded.settings.size > 0 && this.#restoreStoredPrompt(promptDigest, operatorDigest, recorded)) return;
		this.#spentHold = this.#withheldChange(promptDigest, recorded.since, true);
	}

	/**
	 * Restores the prompt the branch stores for `promptDigest` as the base, in place of this process's own build, when
	 * {@link #restoreTranscriptPrompt} keeps it, and returns whether it did. `recorded` is the session's record of the
	 * change it withholds ({@link #recordedHold}), read here when not given.
	 */
	#restoreStoredPrompt(promptDigest: string, operatorDigest: string, recorded?: RecordedHold): boolean {
		const stored = this.#storedPrompt(promptDigest);
		if (stored?.operatorDigest !== operatorDigest || systemPromptDigest(stored.blocks) !== stored.digest) {
			return false;
		}
		if (!this.#host.transcriptPromptCacheLive(promptDigest)) return false;
		// The stored prompt ends with a recall the conversation does not carry as its block (another backend's, bank's
		// or server's, which the operator digest does not cover): that recall never goes out again, and this process's
		// own build does.
		const lastBlock = stored.blocks.at(-1);
		const recall = this.#host.memoryRecall();
		if (
			lastBlock !== undefined &&
			(recall?.hidden !== false || recall.text !== lastBlock) &&
			isRecordedRecall(this.#host.sessionManager.getBranchView(), lastBlock)
		) {
			return false;
		}
		recorded ??= this.#recordedHold(promptDigest);
		const before = recorded ? this.#heldSettingValues(recorded.settings) : new Map<AnySetting, unknown>();
		// The session records a held change of a setting the model cannot be told of: this process's own build goes out.
		if (!before) return false;
		const restoredPrompt: RestoredPrompt = {
			base: stored.blocks,
			// The earliest the session records, else the restore.
			...this.#withheldChange(promptDigest, recorded?.since ?? Date.now(), recorded !== undefined),
			id: crypto.randomUUID(),
			before,
			notices: [],
		};
		// The change the stored prompt would withhold is due already: this process's own build goes out.
		if (withheldChangeDue(restoredPrompt, false)) return false;
		this.#baseStandIn = {
			base: stored.blocks,
			build: this.#baseSystemPrompt,
			settingsRead: this.#promptSettingsRead,
		};
		this.#baseSystemPrompt = stored.blocks;
		// The values a change's notice and records name as the ones the prompt was built with are the stored build's.
		if (stored.settingsRead) this.#promptSettingsRead = this.#storedSettingsRead(stored.settingsRead);
		this.#basePromptRestored = true;
		this.#restoredPrompt = restoredPrompt;
		this.#applyAgentSystemPrompt(stored.blocks);
		// The transcript's requests carried the stored roster, devices and skills: a request's roster, mount and skill
		// notices tell what differs now.
		this.#basePromptListing = {
			toolNames: stored.toolNames,
			xdevNames: new Set(stored.xdevNames),
			skills: new Map(stored.skills.map(({ name, description }) => [name, description])),
		};
		return true;
	}

	/**
	 * The settings a stored prompt's build read, `records`, each with the value it read: a credential, whose value is
	 * never stored, with the value this process's own build read, if it read it; a setting this process does not
	 * know is left out.
	 */
	#storedSettingsRead(records: readonly HeldSettingRecord[]): Map<AnySetting, unknown> {
		const own = this.#promptSettingsRead;
		const read = new Map<AnySetting, unknown>();
		for (const record of records) {
			const setting = lookupSetting(record.id);
			if (!setting) continue;
			if (!setting.isCredential) read.set(setting, record.value);
			else if (own.has(setting)) read.set(setting, own.get(setting));
		}
		return read;
	}

	/** {@link #restoredPrompt} while it is the base. */
	#keptRestoredPrompt(): RestoredPrompt | undefined {
		const restored = this.#restoredPrompt;
		return restored?.base === this.#baseSystemPrompt ? restored : undefined;
	}

	/**
	 * The base a rebuild that rendered `built` commits: `built`, or the kept restored transcript prompt when `built`
	 * has its bytes while it holds settings. This process's own build then reproduces the transcript's prompt, which
	 * withholds nothing from it any more, but the restored prompt stays kept until it is released, so the settings
	 * notice still puts right what the notices of the change it holds told ({@link #restoreTranscriptPrompt}).
	 */
	#committedBase(built: string[]): string[] {
		const restored = this.#keptRestoredPrompt();
		return restored && restored.before.size > 0 && sameItems(built, restored.base) ? this.#baseSystemPrompt : built;
	}

	/**
	 * Whether the base prompt withholds a change from the model to keep the cached prefix: a settings rebuild is
	 * held ({@link #holdSettingsRebuild}), or the restored transcript prompt is kept ({@link #restoreTranscriptPrompt}).
	 */
	get withholdsPromptChange(): boolean {
		return this.#heldSettingsRebuild !== undefined || this.#keptRestoredPrompt() !== undefined;
	}

	/** Whether the kept restored transcript prompt is due for release ({@link replaceRestoredPromptIfDue}). */
	#restoredPromptDue(lapsed: boolean): boolean {
		const restored = this.#keptRestoredPrompt();
		return restored !== undefined && withheldChangeDue(restored, lapsed);
	}

	/**
	 * Replaces the kept restored transcript prompt with this process's own build once keeping it buys nothing or the
	 * change it withholds has waited long enough: `lapsed` (the prompt cache entry the cut rule reads has lapsed or
	 * cannot be read, so no cached prefix is left to keep), a cut the cut rule admitted that rewrites every message
	 * ({@link noteRewritingCutAdmitted}), a move to another transcript ({@link leaveRestoredTranscript}), or
	 * {@link WITHHELD_CHANGE_MAX_AGE_MS} after the change. The rebuild renders the live settings, so a held settings
	 * rebuild runs with it.
	 */
	replaceRestoredPromptIfDue(lapsed: boolean): Promise<void> {
		// Nothing runs: no wait behind the registry mutations in flight.
		if (!this.#restoredPromptDue(lapsed)) return Promise.resolve();
		return this.runToolRegistryMutation(async () => {
			const restored = this.#restoredPrompt;
			if (!restored || this.#host.isDisposed() || !this.#restoredPromptDue(lapsed)) return;
			this.#restoredPrompt = undefined;
			if (this.#baseStandIn?.base === restored.base) this.#baseStandIn = undefined;
			try {
				if (this.#heldSettingsRebuild) {
					await this.#absorbHeldSettingsRebuild();
				} else {
					const prepared = await this.#prepareBaseSystemPrompt();
					prepared?.commit?.();
				}
			} catch (error) {
				// Still due: the next request tries again.
				this.#restoredPrompt ??= { ...restored, due: true };
				throw error;
			}
			// This process's own build came out with the stored bytes: they withhold nothing any more.
			this.#endWithheldChangeIfBaseKept(restored);
		});
	}

	/**
	 * The session moved to another transcript (`/new`, `/clear`, a switch to another session). A restored transcript
	 * prompt was kept for the restored transcript's cache entry, which the next request does not read: it stops
	 * standing in for this process's own build, so the rebuild that follows the move commits that build, and is due
	 * at the next request should that rebuild fail. What the left transcript's last request declared stays with it:
	 * the new transcript's record says what its own last request declared ({@link #transcriptDeclarations}).
	 */
	leaveRestoredTranscript(): void {
		this.#restoredTranscript = undefined;
		this.#basePromptRestored = false;
		// The left transcript's hold records stay as they are in its session file.
		this.#spentHold = undefined;
		this.#sentDeclarations = undefined;
		const restored = this.#restoredPrompt;
		if (!restored) return;
		restored.due = true;
		restored.recorded = false;
		if (this.#baseStandIn?.base === restored.base) this.#baseStandIn = undefined;
	}

	/**
	 * The session's transcript was copied into another session file under a new id, and the conversation goes on in
	 * the copy: a whole-session fork, a fork or branch at an entry, a `/btw` branch, a move off a file another process
	 * writes. A withheld change of the session `fromSessionId` names (a held settings rebuild, the restored transcript
	 * prompt, a spent hold) records itself in the copy from now on, and a recorded one records itself there at once,
	 * since a copy cut at an earlier entry lacks the records written after it. So does the end of one: a copy that
	 * records a hold on the base prompt, which a bound process holds no change for, lacks the end record written after
	 * the copy point, so the hold ends there too ({@link #endWithheldChange}); without it, a process that resumes the
	 * copy dates the change from that hold and sends its own build once it is due. A switch to another session, or
	 * `/new`, copies nothing: the change keeps the session it began in.
	 */
	followTranscriptCopy(fromSessionId: string): void {
		const sessionId = this.#host.sessionManager.getSessionId();
		if (sessionId === fromSessionId) return;
		const changes = [this.#heldSettingsRebuild, this.#restoredPrompt, this.#spentHold];
		for (const change of changes) {
			if (change?.sessionId !== fromSessionId) continue;
			change.sessionId = sessionId;
			change.recordedOn = undefined;
		}
		const held = this.#heldSettingsRebuild;
		if (held?.sessionId === sessionId) this.#recordWithheldChange(held);
		const restored = this.#keptRestoredPrompt();
		if (restored?.recorded && restored.sessionId === sessionId) this.#recordWithheldChange(restored);
		// A bound process takes in every hold on its base prompt when it restores the transcript, and holds each one it
		// begins until it ends: one it holds nothing for withholds nothing from the base any more.
		if (this.#host.model()?.thinking?.prefixBinding !== true) return;
		const digest = systemPromptDigest(this.#baseSystemPrompt);
		if (changes.some(change => change?.digest === digest)) return;
		const recorded = this.#recordedHold(digest);
		if (recorded) this.#endWithheldChange(this.#withheldChange(digest, recorded.since, true));
	}

	/** Drops retained transcript references when the session is disposed. */
	releaseRestoredTranscript(): void {
		this.#restoredTranscript = undefined;
		this.#recordedDigestScan = undefined;
		this.#recordedToolsDigestScan = undefined;
		this.#storedPromptScan = undefined;
	}

	/**
	 * What an implicit prompt rebuild must keep when the model binds signed
	 * thinking to its prompt prefix. `"free"`: the model does not bind, the
	 * transcript holds no reply and no primary model call is in flight, or its
	 * newest reply is one this session was created with whose prompt the
	 * transcript does not record, while no prompt is committed yet: that reply was
	 * not produced under the startup prompt, so the startup build may still take
	 * its place. `"frozen"`: the transcript may be bound to the current prompt, the
	 * one the session was created with included: as for a held settings rebuild
	 * ({@link #promptBound}), a reply produced under it, or a call in flight that
	 * was sent with it (the session's first included), binds it whether or not a
	 * rebuild ever committed one. Otherwise the newest reply is the restored one
	 * and no primary model call has run: a resumed process builds its base prompt
	 * before tools that register late (extension tools, MCP servers), so a rebuild
	 * may commit only when it reproduces the prompt the transcript was sent with.
	 * A transcript restored without a recorded digest, once a prompt is committed,
	 * or switched in later, stays frozen.
	 */
	#implicitRebuildBinding(): "free" | "frozen" | { promptDigest: string } {
		if (this.#host.model()?.thinking?.prefixBinding !== true || this.#promptUnanswered) return "free";
		const latest = this.#latestReply();
		const restored = this.#restoredTranscript;
		// No reply yet: the call in flight binds the prompt it was sent with.
		if (latest === undefined || latest !== restored?.reply) return "frozen";
		if (restored.promptDigest) return { promptDigest: restored.promptDigest };
		return this.#lastAppliedToolSignature !== undefined || this.#basePromptRestored ? "frozen" : "free";
	}

	/**
	 * Records the roster a just-committed base prompt rendered and ends any hold.
	 * Only prefix-bound models hold roster changes, so others skip the copy.
	 */
	#recordPromptRoster(toolNames: readonly string[]): void {
		this.#promptRosterHeld = false;
		if (this.#host.model()?.thinking?.prefixBinding !== true) {
			this.#basePromptRoster = undefined;
			return;
		}
		const tools = new Map(this.#toolRegistry);
		const xdev = this.#xdev;
		this.#basePromptRoster = {
			toolNames: [...toolNames],
			tools,
			xdev: xdev && {
				tools,
				mountedNames: new Set(xdev.mountedNames),
				builtInNames: xdev.builtInNames,
				isActive: xdev.isActive,
			},
		};
	}

	/**
	 * Shows the user a mid-session `xd://` mount change. Non-MCP mount churn
	 * leaves the system prompt and provider cache prefix byte-stable; mounted MCP
	 * route changes additionally rebuild the global route guidance through the
	 * applied-tool signature. The model learns of the change from the mount notice
	 * of the next request whose context does not tell it ({@link #xdevMountNotice}),
	 * never from a steered message: one landing at a run's stop boundary (or while
	 * the session is idle) would force an unsolicited extra assistant turn. Docs +
	 * schema stay one `read xd://<tool>` away; full docs join the system prompt
	 * opportunistically on a rebuild.
	 */
	#emitXdevMountChange(previousMounted: ReadonlySet<string>): void {
		const current = this.#xdev?.mountedNames;
		if (!current || cfgStartupQuiet.get(this.#host.settings) || !cfgToolsXdevNotices.get(this.#host.settings)) {
			return;
		}
		const addedNames = [...current].filter(name => !previousMounted.has(name));
		const removedNames = [...previousMounted].filter(name => !current.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return;
		const parts: string[] = [];
		if (addedNames.length > 0) parts.push(`mounted ${addedNames.join(", ")}`);
		if (removedNames.length > 0) parts.push(`unmounted ${removedNames.join(", ")}`);
		this.#host.emitNotice("info", `xd://: ${parts.join("; ")}`, "xdev");
	}

	/**
	 * What `systemPrompt`, a request's, tells the model of: the roster and `xd://` devices the base prompt lists
	 * ({@link #basePromptListing}). A per-turn `before_agent_start` override replaces the base with the extension's
	 * own text, so it is not credited with what a rebuilt base lists: it stands in for the session's startup prompt
	 * ({@link #startupListing}), and each change since reaches the model as a notice (issue #7139).
	 */
	#promptListing(systemPrompt: readonly string[]): PromptListing {
		if (systemPrompt !== this.#baseSystemPrompt && systemPrompt === this.#lastTurnSystemPromptOverride?.prompt) {
			return this.#startupListing;
		}
		return this.#basePromptListing;
	}

	/**
	 * Builds the hidden notice reconciling the top-level tools the model was told of with the live ones: the roster
	 * the request's system prompt lists ({@link #promptListing}), then every roster notice still in `messages`
	 * (the agent's own unless given), applied in order. A roster change a bound prompt keeps out of its bytes, or one
	 * since the stored prompt a resumed process restored, leaves the prompt listing an older roster, and this notice
	 * tells the model the difference; a rebuild that absorbs the change leaves nothing to tell, so a request never
	 * carries both a rebuilt roster and a contradicting notice. Derived from the context, it reaches every request
	 * that lacks it: `/tree` to a branch without the notice and a compaction that summarized it each get it again,
	 * once. It is a short tool-name list, so it is never budgeted or deferred: it ships with the tool list it
	 * describes. A session that does not build its prompt (no `rebuildSystemPrompt`) has no roster it lists, and
	 * the model knows the tools from their definitions alone, so it gets none.
	 */
	takeToolRosterNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
		systemPrompt: readonly string[] = this.#host.agent.state.systemPrompt,
	): CustomMessage<ToolRosterNoticeDetails> | undefined {
		if (!this.#rebuildSystemPrompt) return undefined;
		const known = new Set(this.#promptListing(systemPrompt).toolNames);
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== TOOL_ROSTER_NOTICE_MESSAGE_TYPE) continue;
			applyNameNotice(known, message.details);
		}
		const live = this.getActiveToolNames();
		const liveNames = new Set(live);
		const added = live.filter(name => !known.has(name));
		const removed = [...known].filter(name => !liveNames.has(name));
		if (added.length === 0 && removed.length === 0) return undefined;
		return {
			role: "custom",
			customType: TOOL_ROSTER_NOTICE_MESSAGE_TYPE,
			content: prompt.render(toolRosterNoticePrompt, {
				added: added.length > 0 ? added.join(", ") : undefined,
				removed: removed.length > 0 ? removed.join(", ") : undefined,
			}),
			details: { added, removed },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * The notices derived from the context that a request lacks, given its custom messages `byType`, its
	 * `systemPrompt` and the enabled tool names: {@link #xdevMountNotice} (unless a prompt deferred it, see
	 * {@link takeXdevMountNotice}), {@link takeToolRosterNotice} and the {@link historyNotices}, each built from the
	 * messages of its own kind. The prompt carries them before its message; a request whose context lost one since (a
	 * compaction between tool calls) or that a change since leaves untold gets it here.
	 */
	missingContextNotices(
		byType: CustomMessagesByType,
		systemPrompt: readonly string[],
		enabledToolNames: readonly string[],
	): AgentMessage[] {
		return [
			this.#xdevMountNoticeDeferred
				? undefined
				: this.#xdevMountNotice(customMessagesOf(byType, XDEV_MOUNT_NOTICE_MESSAGE_TYPE), systemPrompt),
			this.takeToolRosterNotice(customMessagesOf(byType, TOOL_ROSTER_NOTICE_MESSAGE_TYPE), systemPrompt),
			...this.historyNotices(byType, enabledToolNames, systemPrompt),
		].filter(notice => notice !== undefined);
	}

	/**
	 * The notices of what changed since the prompt the model holds in the eval preludes
	 * ({@link takeEvalPreludeNotice}), the session's and the discovered agents ({@link takeSessionAgentNotice},
	 * {@link takeTaskAgentNotice}), the per-call models ({@link takePerCallModelNotice}), the skills
	 * ({@link takeSkillNotice}) and a held settings change ({@link takeSettingsNotice}), each built from the messages
	 * of its own kind in `byType` (the agent's context unless given), the enabled tool names, and the request's
	 * `systemPrompt`.
	 */
	historyNotices(
		byType: CustomMessagesByType = customMessagesByType(this.#host.agent.state.messages),
		enabledToolNames: readonly string[] = this.getEnabledToolNames(),
		systemPrompt: readonly string[] = this.#host.agent.state.systemPrompt,
	): AgentMessage[] {
		return [
			this.takeEvalPreludeNotice(customMessagesOf(byType, EVAL_PRELUDE_NOTICE_MESSAGE_TYPE)),
			this.takeSessionAgentNotice(customMessagesOf(byType, SESSION_AGENT_NOTICE_TYPE)),
			this.takeTaskAgentNotice(customMessagesOf(byType, TASK_AGENT_NOTICE_MESSAGE_TYPE), enabledToolNames),
			this.takePerCallModelNotice(customMessagesOf(byType, PER_CALL_MODEL_NOTICE_MESSAGE_TYPE), enabledToolNames),
			this.takeSkillNotice(customMessagesOf(byType, SKILL_NOTICE_MESSAGE_TYPE), enabledToolNames),
			this.takeSettingsNotice(
				customMessagesOf(byType, SETTINGS_NOTICE_MESSAGE_TYPE),
				customMessagesOf(byType, XDEV_MOUNT_NOTICE_MESSAGE_TYPE),
				systemPrompt,
			),
		].filter(notice => notice !== undefined);
	}

	/**
	 * Builds the hidden notice reconciling the eval preludes the model knows with
	 * the live set. Delivered with the next user prompt instead of rebuilding the
	 * system prompt, so a mid-session toggle (`/computer on`) keeps the provider
	 * cache prefix intact.
	 *
	 * Known preludes are the committed base snapshot, then every prelude notice
	 * still in context (`messages`, the agent's own unless given), applied in order.
	 * Deriving this from the transcript rather than tracked state stays truthful
	 * across base rebuilds (which absorb the live set), compaction (which drops old
	 * notices), and resume.
	 */
	takeEvalPreludeNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
	): CustomMessage<EvalPreludeNoticeDetails> | undefined {
		const known = new Set(this.#promptSurface.evalPreludes.map(definition => definition.name));
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== EVAL_PRELUDE_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (!isRecord(details) || !Array.isArray(details.added) || !Array.isArray(details.removed)) continue;
			for (const name of details.added) if (typeof name === "string") known.add(name);
			for (const name of details.removed) if (typeof name === "string") known.delete(name);
		}
		const live = this.#host.evalPreludes();
		const liveNames = new Set(live.map(definition => definition.name));
		const added = live.filter(definition => !known.has(definition.name));
		const removed = [...known].filter(name => !liveNames.has(name));
		if (added.length === 0 && removed.length === 0) return undefined;
		// Topic docs are served through `read`; sessions without it get them inline,
		// matching the eval description's `inlineTopics` fallback.
		const canRead = this.getActiveToolNames().includes("read");
		return {
			role: "custom",
			customType: EVAL_PRELUDE_NOTICE_MESSAGE_TYPE,
			content: prompt.render(evalPreludeNoticePrompt, {
				added: added.map(definition => ({ name: definition.name, summary: evalPreludeSummary(definition) })),
				removed,
				canRead,
				sections: added.flatMap(definition => [
					...(canRead ? [] : [definition.documentation.trim()]),
					...(definition.guidance ? [definition.guidance.trim()] : []),
				]),
			}),
			details: { added: added.map(definition => definition.name), removed },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Builds the hidden notice reconciling the user-tagged model agents the task
	 * description advertises with the live set. Delivered with the next user
	 * prompt instead of rewriting the task description, so tagging a model
	 * mid-session keeps the provider cache prefix intact.
	 *
	 * Known agents are the committed base snapshot, then every agent notice still
	 * in context, applied in order ({@link #agentRosterNotice}) — mirroring {@link takeEvalPreludeNotice}.
	 */
	takeSessionAgentNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
	): CustomMessage<AgentNoticeDetails> | undefined {
		return this.#agentRosterNotice(
			SESSION_AGENT_NOTICE_TYPE,
			sessionAgentNoticePrompt,
			this.#promptSurface.sessionAgents,
			this.#host.sessionAgents(),
			messages,
		);
	}

	/**
	 * Builds the hidden notice reconciling the discovered agents the task
	 * description advertises with the latest discovery scan. Delivered with the
	 * next user prompt instead of rewriting the task description, so a rescan
	 * mid-session (an agent file added through the agents hub, a plugin reload)
	 * keeps the provider cache prefix intact. Spawning reads its own fresh scan,
	 * so a new agent works before and after the notice. Only the task
	 * description lists them, so a session without the task tool gets none.
	 *
	 * Known agents are the committed base snapshot, then every such notice still
	 * in context, applied in order ({@link #agentRosterNotice}).
	 */
	takeTaskAgentNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
		enabledToolNames: readonly string[] = this.getEnabledToolNames(),
	): CustomMessage<AgentNoticeDetails> | undefined {
		if (!enabledToolNames.includes("task")) return undefined;
		const committed = this.#promptSurface.discoveredAgents;
		const live = publishedAgentDiscovery(this.#host.sessionManager.getCwd(), this.#host.effectiveExtensionRoots());
		// Without a committed scan the description lists the latest one itself.
		if (!committed || !live) return undefined;
		return this.#agentRosterNotice(TASK_AGENT_NOTICE_MESSAGE_TYPE, taskAgentNoticePrompt, committed, live, messages);
	}

	/**
	 * The hidden `customType` notice of what `live` changes in the agents the model knows: `committed`, then what
	 * every `customType` notice in `messages` listed and withdrew, in order. Both sides keep only the agents the
	 * session may spawn now ({@link spawnableAgents}), as the task description lists them and as a call of the `task`
	 * tool reads its settings (a held change that alters the description keeps the earlier ones,
	 * {@link toolCallSettingsFor}), so an agent the settings disable is never announced. An agent whose description
	 * changed is listed again with the new one, since the model picks agents by it. `template` renders the notice.
	 */
	#agentRosterNotice(
		customType: string,
		template: string,
		committed: readonly AgentDefinition[],
		live: readonly AgentDefinition[],
		messages: readonly AgentMessage[],
	): CustomMessage<AgentNoticeDetails> | undefined {
		const disabledAgents = cfgTaskDisabledAgents.get(this.toolCallSettingsFor("task") ?? this.#host.settings);
		const policy = resolveSpawnPolicy(this.#host.sessionSpawns());
		// Each agent the model knows, with the description it was given: undefined when an older notice listed it.
		const known = new Map<string, string | undefined>(
			spawnableAgents(committed, disabledAgents, policy).map(agent => [agent.name, agent.description]),
		);
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== customType) continue;
			const details = message.details;
			if (!isRecord(details) || !Array.isArray(details.added) || !Array.isArray(details.removed)) continue;
			const descriptions: Record<string, unknown> = isRecord(details.descriptions) ? details.descriptions : {};
			for (const name of details.added) {
				if (typeof name !== "string") continue;
				const description = descriptions[name];
				known.set(name, typeof description === "string" ? description : known.get(name));
			}
			for (const name of details.removed) if (typeof name === "string") known.delete(name);
		}
		const { added, updated, removed } = listingDelta(known, spawnableAgents(live, disabledAgents, policy));
		if (added.length === 0 && updated.length === 0 && removed.length === 0) return undefined;
		const entry = (agent: AgentDefinition) => ({ name: agent.name, description: agent.description });
		const announced = [...added, ...updated];
		return {
			role: "custom",
			customType,
			content: prompt.render(template, { added: added.map(entry), updated: updated.map(entry), removed }),
			details: {
				added: announced.map(agent => agent.name),
				removed,
				descriptions: Object.fromEntries(announced.map(agent => [agent.name, agent.description])),
			},
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Builds the hidden notice restating the per-call models the task and eval
	 * descriptions approve, when the live approvals differ from the ones the
	 * model last read: the committed base snapshot, or the newest such notice
	 * still in context. Delivered with the next user prompt instead of rewriting
	 * the descriptions, so an operator's role or allowlist edit mid-session keeps
	 * the provider cache prefix intact. The list is restated whole because roles,
	 * allowlist and the own-model clause change together; a notice that a later
	 * rebuild outdated costs at most one restatement of what the descriptions list.
	 * A session with no task or eval tool that lists them gets none. The approvals
	 * are read as a call of the tool reads them: under the settings its
	 * description was written for while a held change alters it
	 * ({@link toolCallSettingsFor}).
	 */
	takePerCallModelNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
		enabledToolNames: readonly string[] = this.getEnabledToolNames(),
	): CustomMessage<PerCallModelAdvertisement> | undefined {
		const settingsOf = (tool: string): Settings => this.toolCallSettingsFor(tool) ?? this.#host.settings;
		let known = this.#promptSurface.perCallModels;
		// Without a committed snapshot the descriptions list the live approvals themselves.
		if (!known || !this.#perCallModelsAdvertised(enabledToolNames, settingsOf)) return undefined;
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== PER_CALL_MODEL_NOTICE_MESSAGE_TYPE) continue;
			if (isPerCallModelAdvertisement(message.details)) known = message.details;
		}
		const settings = this.toolCallSettingsFor("task") ?? settingsOf("eval");
		const live = getPerCallModelAdvertisement(settings, this.#host.model(), this.#host.modelRegistry);
		if (Bun.deepEquals(live, known)) return undefined;
		return {
			role: "custom",
			customType: PER_CALL_MODEL_NOTICE_MESSAGE_TYPE,
			content: prompt.render(perCallModelNoticePrompt, { ...live }),
			details: live,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Builds the hidden notice of skills the live registry has gained, changed or lost since the system
	 * prompt and the notices still in context listed them: the skills a restored transcript prompt lists
	 * ({@link PromptListing.skills}), else the ones this process's prompt renders. A changed description is
	 * announced again because the model routes on it. Gated like the prompt's skill list: `skillful` on and an
	 * enabled tool, top-level or `xd://`-mounted, that reads `skill://`.
	 */
	takeSkillNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
		enabledToolNames: readonly string[] = this.getEnabledToolNames(),
	): CustomMessage<SkillNoticeDetails> | undefined {
		if (cfgSkillful.get(this.#host.settings) !== true) return undefined;
		if (!enabledToolNames.some(name => toolReadsSkillUris(this.getToolByName(name)))) return undefined;
		const known = new Map(this.#basePromptSkills());
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== SKILL_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (!isRecord(details) || !Array.isArray(details.announced) || !Array.isArray(details.removed)) continue;
			for (const entry of details.announced) {
				if (isListedSkill(entry)) known.set(entry.name, entry.description);
			}
			for (const name of details.removed) if (typeof name === "string") known.delete(name);
		}
		const { added, updated, removed } = listingDelta(known, listedSkills(this.#skills));
		if (added.length === 0 && updated.length === 0 && removed.length === 0) return undefined;
		return {
			role: "custom",
			customType: SKILL_NOTICE_MESSAGE_TYPE,
			content: prompt.render(skillNoticePrompt, { added, updated, removed }),
			details: {
				announced: [...added, ...updated].map(({ name, description }) => ({ name, description })),
				removed,
			},
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Previews, for a prompt's pre-prompt context maintenance, the hidden `xd://` mount notice its request needs: the
	 * only hidden notice that can carry substantial inline docs (up to XDEV_DOCS_TOTAL_BUDGET). Ends a deferral an
	 * earlier prompt made ({@link takeXdevMountNotice}).
	 */
	peekXdevMountNotice(): XdevMountNoticePreview {
		this.#xdevMountNoticeDeferred = false;
		const history = this.#host.agent.state.messages;
		const notice = this.#xdevMountNotice(history, this.#host.agent.state.systemPrompt);
		return { notice, contentKey: this.#xdevNoticeContentKey(notice), history };
	}

	/**
	 * The mount notice a prompt's request carries once its pre-prompt maintenance ran with `preview` in its estimate.
	 * A hidden base rebuild can leave it byte-identical: the exact content was budgeted, so it goes out. Maintenance
	 * that replaced the history (a compaction) made room for what the context it left lacks, so the notice is derived
	 * from that context. Any other change to its rendered content was not estimated: a mount or unmount during the
	 * await, a same-named MCP tool reconnecting with other docs (mount membership and the applied-tool signature stay
	 * the same), or a rebuilt base catalog. Then no request carries a mount notice until the next prompt budgets it.
	 */
	takeXdevMountNotice(preview: XdevMountNoticePreview): CustomMessage<XdevMountNoticeDetails> | undefined {
		const history = this.#host.agent.state.messages;
		const notice = this.#xdevMountNotice(history, this.#host.agent.state.systemPrompt);
		if (history !== preview.history || this.#xdevNoticeContentKey(notice) === preview.contentKey) return notice;
		this.#xdevMountNoticeDeferred = true;
		return undefined;
	}

	/** Stable fingerprint of a mount notice's rendered text, ignoring its timestamp. */
	#xdevNoticeContentKey(notice: CustomMessage<XdevMountNoticeDetails> | undefined): string {
		if (!notice) return "";
		const { content } = notice;
		if (typeof content === "string") return content;
		return content.map(part => (part.type === "text" ? part.text : "")).join("\u0000");
	}

	/**
	 * The `xd://` devices the model was told of in a request: the devices its `systemPrompt` lists
	 * ({@link #promptListing}), then every mount notice in its `messages`, applied in order.
	 */
	#toldXdevNames(messages: readonly AgentMessage[], systemPrompt: readonly string[]): Set<string> {
		const known = new Set(this.#promptListing(systemPrompt).xdevNames);
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== XDEV_MOUNT_NOTICE_MESSAGE_TYPE) continue;
			if (applyNameNotice(known, message.details)) continue;
			// A notice an older release saved without structured details: replay what its text lists.
			for (const [section, name] of legacyMountNoticeLines(message)) {
				if (section === "added") known.add(name);
				else known.delete(name);
			}
		}
		return known;
	}

	/**
	 * The `xd://` devices a request about to go out lists, given the mount notices in its context and its
	 * `systemPrompt`: the mounted devices, which its mount notice reconciles the model's list with, or while a prompt
	 * put that notice off ({@link takeXdevMountNotice}), the ones the prompt and those notices told
	 * ({@link #toldXdevNames}).
	 */
	#nextRequestXdevNames(xdevNotices: readonly AgentMessage[], systemPrompt: readonly string[]): ReadonlySet<string> {
		const xdev = this.#xdev;
		if (!xdev) return new Set();
		return this.#xdevMountNoticeDeferred ? this.#toldXdevNames(xdevNotices, systemPrompt) : xdev.mountedNames;
	}

	/**
	 * Where a request lists `name` for the model to call: `"tools"` when its tool list declares it, `"devices"` when its
	 * `xd://` listing, `xdevNames`, names it; undefined when neither does.
	 */
	#requestListing(name: string, xdevNames: ReadonlySet<string>): "tools" | "devices" | undefined {
		if (this.#host.agent.state.tools.some(tool => tool.name === name)) return "tools";
		return xdevNames.has(name) ? "devices" : undefined;
	}

	/**
	 * Builds the hidden notice reconciling the `xd://` devices the model was told of with the mounted ones: the
	 * devices the request's system prompt lists ({@link #promptListing}), then every mount notice still in `messages`,
	 * applied in order ({@link #toldXdevNames}). A device the base prompt lists in its catalog, or in a route line with
	 * its catalog summary (deferred MCP discovery mounts devices whose routes a rebuild renders), needs no notice line;
	 * one the bounded route projection omits, one whose docs the prompt inlines (its route line has no summary; the
	 * notice delivers them) and one mounted after a bound base was committed each get one. Only a net change is
	 * announced: a device a resume or host reconnect mounts again that the context already announced, and an unmount
	 * of a device the model was never told of, add nothing, keeping the provider prompt cache prefix byte-stable across
	 * resumes. Derived from the context, it reaches every request that lacks it: `/tree` to a branch without the
	 * notice, a replaced transcript (`/new`) and a compaction that summarized it each get it again.
	 */
	#xdevMountNotice(
		messages: readonly AgentMessage[],
		systemPrompt: readonly string[],
	): CustomMessage<XdevMountNoticeDetails> | undefined {
		const xdev = this.#xdev;
		if (!xdev) return undefined;
		const known = this.#toldXdevNames(messages, systemPrompt);
		const mounted = xdev.mountedNames;
		const addedNames = [...mounted].filter(name => !known.has(name));
		const removedNames = [...known].filter(name => !mounted.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return undefined;
		const summaries = new Map(xdevEntries(xdev).map(entry => [entry.name, entry.summary]));
		const added = addedNames.map(name => ({ name, summary: summaries.get(name) ?? "" }));
		const removed = removedNames.map(name => ({ name }));
		const docs = xdevDocsFor(
			xdev,
			new Set(addedNames),
			cfgToolsXdevDocs.get(this.#host.settings),
			cfgToolsXdevInlineDevices.get(this.#host.settings),
		);
		return {
			role: "custom",
			customType: XDEV_MOUNT_NOTICE_MESSAGE_TYPE,
			content: prompt.render(xdevMountNoticePrompt, { added, removed, docs }),
			details: { added: addedNames, removed: removedNames },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Rediscovers reloadable skills and rebuilds the system prompt's skill list. With `settingsChange` on a bound
	 * prompt only the registry follows now ({@link reloadSkills}); the prompt's list waits for the held rebuild
	 * ({@link #holdSettingsRebuild}) and {@link takeSkillNotice} tells the model.
	 */
	refreshSkills(options?: SettingsChangeOptions): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			await this.#rediscoverSkills();
			const held = this.#holdSettingsRebuild(options?.settingsChange);
			if (held) {
				held.skills = true;
				await this.#recordHeldSettingsBuild();
			} else {
				this.#promptSkills = this.#skills;
				await this.refreshBaseSystemPrompt();
			}
			this.#host.notifyCommandMetadataChanged();
		});
	}

	/**
	 * Rediscovers skills for the registry only, after a tool wrote or deleted one. The system prompt keeps
	 * its list so the provider cache prefix survives; {@link takeSkillNotice} tells the model instead.
	 */
	reloadSkills(): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			await this.#rediscoverSkills();
			this.#host.notifyCommandMetadataChanged();
		});
	}

	async #rediscoverSkills(): Promise<void> {
		resetCapabilities();
		if (!this.#skillsReloadable) return;
		const { discovered, skillsSettings } = await this.#discoverSkills();
		this.#skills = discovered.skills;
		this.#skillWarnings = discovered.warnings;
		this.#skillsSettings = skillsSettings;
		if (this.#host.agentKind() === "main") {
			setActiveSkills(this.#skills);
		}
	}

	/** Selects enabled tools, ignoring names absent from the registry. */
	setActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);
			// Transport-write eligibility keys off the *current* active set: an ordinary
			// selection change should not demote `write` unless it is already active.
			await this.#applyToolPresentation(
				normalized,
				this.#xdev?.mountedNames ?? new Set(),
				this.getActiveToolNames().includes("write"),
			);
		});
	}

	/**
	 * Restore an enabled tool set with its exact top-level versus `xd://` partition.
	 *
	 * Both inputs are required because {@link setActiveToolsByName} only receives the
	 * enabled name list and classifies mounts from the current presentation set.
	 * Rollback/restore callers must pass the snapshotted mounted subset so names that
	 * were top-level stay pinned (`#runtimeSelectedToolNames`) and names that were under
	 * `xd://` remain mount-eligible, even when the live mount set has drifted.
	 *
	 * Names outside `mountedToolNames` are pinned top-level for this application;
	 * names in the mounted subset remain eligible for xdev mounting. Set
	 * `forcePromptRefresh` when an enabled tool's schema or prompt-visible metadata
	 * changed without changing its name or presentation.
	 *
	 * With `settingsChange` on a bound prompt (an extension-sources edit suspended an extension, taking its tool off
	 * the registry or bringing back the built-in it replaced) the selection follows, but the reapply is held
	 * ({@link #holdToolSetChange}).
	 *
	 * Delegates the actual apply through {@link applyActiveToolsByName} and restores
	 * the prior runtime selection if that apply throws.
	 */
	setActiveToolPresentation(
		toolNames: string[],
		mountedToolNames: string[],
		forcePromptRefresh = false,
		signal?: AbortSignal,
		{ settingsChange }: SettingsChangeOptions = {},
	): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);
			// Restoration targets a snapshot, so write eligibility comes from the
			// *target* set rather than whatever happens to be active mid-rollback.
			await this.#applyToolPresentation(
				normalized,
				new Set(normalizeToolNames(mountedToolNames)),
				normalized.includes("write"),
				{ forcePromptRefresh, signal, settingsChange },
			);
		}, signal);
	}

	/** Restores a non-MCP presentation snapshot plus the MCP selection and non-built-in tools registered after it. */
	restoreNonMCPToolPresentation(
		nonMCPToolNames: string[],
		nonMCPMountedToolNames: string[],
		registeredToolNames: readonly string[],
	): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const registered = new Set(registeredToolNames);
			const isLateNonBuiltIn = (name: string) =>
				!isMCPToolName(name) && !this.hasBuiltInTool(name) && !registered.has(name);
			const currentMCPToolNames = this.getSelectedMCPToolNames();
			const currentMountedMCPToolNames = this.getMountedXdevToolNames().filter(isMCPToolName);
			await this.setActiveToolPresentation(
				[...nonMCPToolNames, ...currentMCPToolNames, ...this.getEnabledToolNames().filter(isLateNonBuiltIn)],
				[
					...nonMCPMountedToolNames,
					...currentMountedMCPToolNames,
					...this.getMountedXdevToolNames().filter(isLateNonBuiltIn),
				],
			);
		});
	}

	/**
	 * Shared body for {@link setActiveToolsByName} and {@link setActiveToolPresentation}:
	 * pins non-mounted names as the runtime selection (holding `write` back when it is
	 * transport-only) and applies the set, or holds its reapply when `settingsChange` started
	 * it on a bound prompt ({@link #holdToolSetChange}), rolling the selection back if apply throws.
	 */
	async #applyToolPresentation(
		normalized: string[],
		mounted: ReadonlySet<string>,
		writeSelected: boolean,
		{
			forcePromptRefresh = false,
			signal,
			settingsChange,
		}: { forcePromptRefresh?: boolean; signal?: AbortSignal } & SettingsChangeOptions = {},
	): Promise<void> {
		const retainedMountedDevice = [...mounted].some(name => normalized.includes(name));
		const retainedDeferrableTool = normalized.some(name => this.#toolRegistry.get(name)?.deferrable === true);
		const deviceOnlyWriteActive = this.#isDeviceOnlyWrite?.() === true;
		const transportWriteActive =
			normalized.includes("write") &&
			this.#builtInToolNames.has("write") &&
			this.#presentationPinnedToolNames?.has("write") !== true &&
			this.#runtimeSelectedToolNames?.has("write") !== true &&
			((this.#host.planModeEnabled() && (!writeSelected || deviceOnlyWriteActive)) ||
				(writeSelected && deviceOnlyWriteActive && (retainedMountedDevice || retainedDeferrableTool)));
		const previousRuntimeSelectedToolNames = this.#runtimeSelectedToolNames;
		this.#runtimeSelectedToolNames = new Set(
			normalized.filter(name => !mounted.has(name) && !(name === "write" && transportWriteActive)),
		);
		try {
			// A held reapply runs with the held rebuild, under the selection pinned here.
			if (settingsChange && (await this.#holdToolSetChange(normalized, settingsChange))) return;
			await this.#applyActiveToolsByName(normalized, forcePromptRefresh, signal);
		} catch (error) {
			this.#runtimeSelectedToolNames = previousRuntimeSelectedToolNames;
			throw error;
		}
	}

	/**
	 * Holds a tool-set apply that `settingsChange` started on a bound prompt, as {@link #holdRosterChange} holds a
	 * reconcile's: an extension-sources edit that suspends an extension, which takes its tools off the registry or
	 * brings back the built-in one it replaced, or resumes one. Each caller builds `toolNames` from the enabled set,
	 * which a hold leaves as it is, so the tools it moves against that set are the step's own: each tool `toolNames`
	 * leaves stays declared and its calls are refused, each it adds waits for the rebuild, and each that stays runs the
	 * registry's current entry (the built-in brought back) under the declaration the hold keeps for it
	 * ({@link #declaredAs}). A tool an earlier step moved stays moved unless the registry moved it back: one the hold
	 * disables that is registered again (its extension resumed) runs again, and one it brings with the rebuild that left
	 * the registry (its extension suspended again) no longer comes. False when nothing is held and the caller applies
	 * the set now.
	 */
	async #holdToolSetChange(toolNames: readonly string[], settingsChange: readonly SettingChange[]): Promise<boolean> {
		const held = this.#heldSettingsRebuild;
		const enabled = new Set(this.getEnabledToolNames());
		const names = new Set(toolNames);
		const removed = [...enabled].filter(name => !names.has(name) && !held?.disabledTools.has(name));
		for (const name of held?.enabledTools ?? []) {
			if (!names.has(name) && !this.#toolRegistry.has(name)) removed.push(name);
		}
		const added = toolNames
			.filter(name => !enabled.has(name) || (held?.disabledTools.has(name) && this.#toolRegistry.has(name)))
			.map(name => ({ name, activate: true }));
		if (!(await this.#holdRosterChange(settingsChange, enabled, removed, added))) return false;
		this.#setAgentTools(
			this.#withCurrentImplementations(
				this.#host.agent.state.tools.map(tool => this.#declaredOwners.get(tool) ?? tool),
			),
		);
		return true;
	}

	/**
	 * The tools enabled once `held` rebuilds: the enabled tools but the ones it disables, then the ones it enables; the
	 * enabled tools without a hold.
	 */
	#enabledAfterHold(held: HeldSettingsRebuild | undefined): Set<string> {
		const enabled = new Set(this.getEnabledToolNames().filter(name => !held?.disabledTools.has(name)));
		for (const name of held?.enabledTools ?? []) enabled.add(name);
		return enabled;
	}

	/**
	 * Replaces memory-backend tools while preserving unrelated selections. With `settingsChange` on a bound prompt (a
	 * memory setting switched or reconfigured the backend) the registry follows the backend, but the reapply is held
	 * as {@link reconcileBuiltinTools} holds one ({@link #holdSettingsRebuild}): a memory tool the backend no longer
	 * offers stays declared and its calls are refused, a new one waits for the rebuild.
	 */
	replaceMemoryTools(tools: AgentTool[], options?: SettingsChangeOptions): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const wasEnabled = new Set(this.getEnabledToolNames());
			const removed = new Set<string>(MEMORY_BACKEND_TOOL_NAMES.filter(name => this.#builtInToolNames.has(name)));
			const nextActive = [...wasEnabled].filter(name => !removed.has(name));
			for (const name of removed) {
				this.#toolRegistry.delete(name);
				this.#builtInToolNames.delete(name);
			}

			const added: string[] = [];
			for (const tool of tools) {
				if (!MEMORY_BACKEND_TOOL_NAMES.some(name => name === tool.name) || this.#toolRegistry.has(tool.name)) {
					continue;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
				added.push(wrapped.name);
			}
			const held =
				(removed.size > 0 || added.length > 0) &&
				(await this.#holdRosterChange(
					options?.settingsChange,
					wasEnabled,
					removed,
					added.map(name => ({ name, activate: true })),
				));
			if (held) return;
			await this.#applyActiveToolsByName([...new Set([...nextActive, ...added])]);
		});
	}

	/**
	 * Holds the reapply of a tool reconcile that `settingsChange` started when the prompt is bound
	 * ({@link #holdSettingsRebuild}): each of the `removed` tools that was enabled (in `wasEnabled`) stays declared and
	 * its calls are refused, each of the `added` ones that `activate` waits for the rebuild. Returns false when nothing
	 * is held and the caller reapplies the enabled set now.
	 */
	async #holdRosterChange(
		settingsChange: readonly SettingChange[] | undefined,
		wasEnabled: ReadonlySet<string>,
		removed: Iterable<string>,
		added: Iterable<{ readonly name: string; readonly activate: boolean }>,
	): Promise<boolean> {
		if (!settingsChange) return false;
		const held = this.#holdSettingsRebuild(settingsChange);
		if (!held) return false;
		held.reconcile = true;
		const gates = settingsChange.map(change => change.setting);
		for (const name of removed) {
			// A tool registered under this hold was never active: it just leaves the pending list.
			if (!held.enabledTools.delete(name) && wasEnabled.has(name)) held.disabledTools.set(name, gates);
		}
		for (const { name, activate } of added) {
			// A tool disabled under this hold is still declared: registered again, its calls run again.
			if (!held.disabledTools.delete(name) && activate) held.enabledTools.add(name);
		}
		await this.#recordHeldSettingsBuild();
		return true;
	}

	/**
	 * Reconciles the private `think` scratchpad with the `externalThinking`
	 * setting and the active model. Enabling constructs the tool once;
	 * disabling removes it from the active set but keeps its registry entry.
	 *
	 * @returns false when enabling was requested but this session cannot build the tool.
	 */
	reconcileThinkTool(): Promise<boolean> {
		return this.#setThinkToolActive(
			cfgExternalThinking.get(this.#host.settings) && supportsExternalThinking(this.#host.model()),
		);
	}

	#setThinkToolActive(enabled: boolean): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const active = this.getEnabledToolNames();
			if (!enabled) {
				if (active.includes("think")) {
					await this.#applyActiveToolsByName(active.filter(name => name !== "think"));
				}
				return true;
			}
			if (!this.#toolRegistry.has("think")) {
				const tool = await this.#createThinkTool?.();
				if (tool?.name !== "think") return false;
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			if (!active.includes("think")) {
				await this.#applyActiveToolsByName([...active, "think"]);
			}
			return true;
		});
	}

	/**
	 * Re-resolves settings-gated tools (built-in factories, image/speech generation,
	 * `xd://` mounting) against live settings: registers newly allowed tools,
	 * unregisters disallowed ones, and reapplies the enabled set with one forced
	 * prompt rebuild — unconditionally unless `refreshPrompt` is false, then only
	 * when the tool set changed. Unrelated selections and MCP/extension tools are
	 * preserved. With `settingsChange` on a bound prompt the registry still follows
	 * the settings, but the reapply is held ({@link #holdSettingsRebuild}): an
	 * unregistered tool stays declared and its calls are refused, a registered one
	 * waits for the rebuild. A change of the `xd://` state is never held.
	 */
	reconcileBuiltinTools({
		refreshPrompt = true,
		settingsChange,
	}: { refreshPrompt?: boolean } & SettingsChangeOptions = {}): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const reconcile = this.#reconcileSettingsGatedTools;
			if (!reconcile || this.#host.isDisposed()) return;
			// Sampled before the delta: it still carries names mounted under the
			// `xd://` state the reconcile may release.
			const wasEnabled = new Set(this.getEnabledToolNames());
			const enabled = new Set(wasEnabled);
			const delta = await reconcile(name => this.#builtInToolNames.has(name));
			for (const name of delta.removed) {
				enabled.delete(name);
				this.#builtInToolNames.delete(name);
			}
			for (const { name, builtIn, activate } of delta.added) {
				this.setToolBuiltIn(name, builtIn);
				if (activate) enabled.add(name);
			}
			const xdevChanged = delta.xdev !== this.#xdev;
			if (xdevChanged) {
				this.#xdev = delta.xdev;
				if (delta.xdev) delta.xdev.decorateExecution = tool => this.#callableAsDeclared(tool);
			}
			if (!refreshPrompt && !xdevChanged && delta.added.length === 0 && delta.removed.length === 0) return;
			if (!xdevChanged && (await this.#holdRosterChange(settingsChange, wasEnabled, delta.removed, delta.added))) {
				return;
			}
			await this.#applyActiveToolsByName([...enabled], true);
		});
	}

	/**
	 * Rebuilds the stable base prompt for the current tools and model.
	 * `commitIf` lets asynchronous producers discard a stale rebuild atomically
	 * after its inputs have been superseded. With `settingsChange` on a bound
	 * prompt the rebuild is held ({@link #holdSettingsRebuild}), unless it
	 * renders the kept restored transcript prompt's bytes: that prompt then
	 * withholds nothing and settles ({@link #settleKeptRestoredPrompt}). With
	 * `joinsHeldChange` while the base withholds a change (a settings rebuild
	 * is held, or the restored transcript prompt is kept in place of this
	 * process's own build), the rebuild is part of that change: its render
	 * becomes the build the base stands in for ({@link #recordHeldSettingsBuild})
	 * and goes out with the change, at the held rebuild or when the restored
	 * prompt is released, or settles a kept restored prompt it reproduces. Any
	 * other rebuild renders the live settings anyway, so one that changes the
	 * prompt runs a held one with it; one that changes nothing of its own (it
	 * renders the build the base stands in for again, {@link #baseStandIn})
	 * keeps the base and the hold.
	 */
	refreshBaseSystemPrompt(commitIf?: () => boolean, options?: BasePromptRebuildOptions): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const settingsChange = options?.settingsChange;
			if (settingsChange && this.#promptBound && !this.#heldSettingsRebuild && this.#keptRestoredPrompt()) {
				if (this.#settleKeptRestoredPrompt(await this.#prepareBaseSystemPrompt(commitIf))) return;
			}
			if (this.#holdSettingsRebuild(settingsChange)) {
				await this.#recordHeldSettingsBuild();
				return;
			}
			if (options?.joinsHeldChange && this.withholdsPromptChange) {
				const render = await this.#prepareBaseSystemPrompt(commitIf);
				if (!render || commitIf?.() === false || this.#settleKeptRestoredPrompt(render)) return;
				await this.#recordHeldSettingsBuild(render);
				return;
			}
			const base = this.#baseSystemPrompt;
			let prepared = await this.#prepareBaseSystemPrompt();
			if (this.#heldSettingsRebuild && prepared && !sameItems(prepared.systemPrompt, base)) {
				await this.#absorbHeldSettingsRebuild();
				prepared = await this.#prepareBaseSystemPrompt();
			}
			if (commitIf && !commitIf()) return;
			prepared?.commit?.();
		});
	}

	/**
	 * Holds the rebuild that `settingsChange` started when the prompt is bound (a prefix-bound model has answered
	 * under it, or a call in flight was sent with it): the system prompt keeps its bytes and each tool keeps the
	 * declaration the last request before the change sent ({@link #declaredAs}), {@link takeSettingsNotice} tells the
	 * model what changed and when it goes out, and {@link absorbHeldSettingsRebuild} runs the rebuild once it is due:
	 * at a cut the cut rule admits, once the prompt cache entry lapses, or five minutes after the change, whichever
	 * comes first. A new hold is recorded on the branch with its start, as on each branch a reply under it goes to
	 * ({@link recordReplyPrompt}), and so is each setting it holds, so a resumed process that restores the bound
	 * prompt keeps the change waiting no longer and tells the model of it ({@link #restoreTranscriptPrompt}). A hold
	 * on a restored transcript prompt holds the settings the session records as held from it too, with the values that
	 * prompt was built with, and goes on from the notices that told the model of them; it goes out when that prompt
	 * does ({@link replaceRestoredPromptIfDue}), so it is dated from the change that prompt withholds, and its notice
	 * and its refusals give that time. Returns the hold to extend, or undefined when the rebuild runs now: no settings
	 * change started it, or nothing is bound. Unlike {@link #implicitRebuildBinding}, the prompt the session was
	 * created with binds as soon as a reply was produced under it or a call sent with it, before any rebuild committed.
	 */
	#holdSettingsRebuild(settingsChange: readonly SettingChange[] | undefined): HeldSettingsRebuild | undefined {
		if (!settingsChange || !this.#promptBound) return undefined;
		let held = this.#heldSettingsRebuild;
		if (!held) {
			const restored = this.#keptRestoredPrompt();
			const before = new Map(restored?.before);
			held = {
				id: restored?.id ?? crypto.randomUUID(),
				// A kept restored prompt goes out with the change: it is as old as the change that prompt withholds.
				...this.#withheldChange(this.currentPromptDigest(), restored?.since ?? Date.now(), false),
				before,
				notices: restored?.notices ?? [],
				disabledTools: new Map(),
				enabledTools: new Set(),
				reconcile: false,
				skills: false,
				declarations: undefined,
				declared: new WeakMap(),
				toolSettings: this.#settingsWith(before, () => this.#heldSettingsRebuild?.before === before),
			};
			// Not the session's hold yet, so nothing is recorded; the declarations it keeps read every setting it holds.
			this.#holdMoreSettings(held, settingsChange);
			held.declarations = this.#keptDeclarations(before);
			this.#heldSettingsRebuild = held;
			this.#recordWithheldChange(held);
			this.#setAgentTools(this.#host.agent.state.tools);
			return held;
		}
		this.#holdMoreSettings(held, settingsChange);
		return held;
	}

	/**
	 * Adds to `held` each setting of `changes` it does not hold yet, with the value the prompt was built with
	 * ({@link #builtValue}), and when one was added and `held` is the session's hold, records the settings it holds
	 * that its records on the current branch do not name yet.
	 */
	#holdMoreSettings(held: HeldSettingsRebuild, changes: readonly SettingChange[]): void {
		let grown = false;
		for (const { setting, previous } of changes) {
			if (held.before.has(setting)) continue;
			held.before.set(setting, this.#builtValue(setting, previous));
			grown = true;
		}
		if (!grown || this.#heldSettingsRebuild !== held) return;
		// The branch's records may name fewer settings than the hold holds now.
		held.recordedOn = undefined;
		this.#recordWithheldChange(held);
	}

	/**
	 * The value `setting` had when the base prompt was built: the one its build read ({@link #promptSettingsRead}; a
	 * restored transcript prompt's, as its stored record gives it), else `previous`, its value before the change.
	 */
	#builtValue(setting: AnySetting, previous: unknown): unknown {
		const read = this.#promptSettingsRead;
		return read.has(setting) ? read.get(setting) : previous;
	}

	/**
	 * Holds a settings change on a bound prompt that alters what an active tool declares or what the system prompt
	 * renders, whatever setting it is, as {@link #holdSettingsRebuild} holds the rebuilds the settings the system
	 * prompt and the tool gates render start: the prompt and the declarations stay as sent, the settings notice names
	 * the change, it goes out within five minutes, and calls run as declared. A setting a tool definition renders
	 * (`tools.maxTimeout` in the `bash` and `eval` descriptions, `task.enableEffort` in the `task` schema), or one
	 * only the prompt renders (`task.maxConcurrency`), starts no rebuild of its own, so without this the next request
	 * would send the new definition, or the next rebuild that changes nothing else would send the new prompt. The
	 * changes held are those the declarations move with ({@link #declarationMovers}) and those the prompt moves with
	 * ({@link #promptMovers}); with none, nothing is held, and a render of the change that reproduces the kept
	 * restored transcript prompt settles it ({@link #settleKeptRestoredPrompt}). A change of a setting the base's build
	 * did not read is recorded first, for a later hold whose build renders it ({@link #recordUnreadChanges}). Before
	 * anything binds the prompt, a change of a setting its build read rebuilds it at once instead
	 * ({@link #rebuildUnboundPrompt}).
	 */
	holdToolDeclarationChange(settingsChange: readonly SettingChange[]): Promise<void> {
		this.#recordUnreadChanges(settingsChange);
		if (this.#promptUnanswered) return this.#rebuildUnboundPrompt(settingsChange);
		// Nothing to hold: no wait behind the registry mutations in flight.
		if (!this.#promptBound) return Promise.resolve();
		// A change a call made reaches here in that call's settings frame; the declarations are the session's own.
		return this.#toolCallSettingsScope.exit(() =>
			this.runToolRegistryMutation(async () => {
				if (this.#host.isDisposed()) return;
				const declarations = this.#declarationMovers(settingsChange);
				// A hold that had no declarations to keep takes the ones the change shows, and its tools declare them
				// from then on.
				const held = this.#heldSettingsRebuild;
				if (held && !held.declarations && declarations.kept) this.#keepDeclarations(held, declarations.kept);
				const prompt = await this.#promptMovers(
					settingsChange.filter(change => !declarations.movers.includes(change)),
				);
				const movers = [...declarations.movers, ...prompt.movers];
				if (movers.length === 0) {
					this.#settleKeptRestoredPrompt(prompt.render);
					return;
				}
				if (!this.#holdSettingsRebuild(movers)) return;
				await this.#recordHeldSettingsBuild(prompt.render, prompt.surfaceRead);
			}),
		);
	}

	/**
	 * Records each change of `settingsChange` to a setting the base prompt's build did not read, unless one is recorded
	 * already, with its value before the change: the value the build was rendered under ({@link #promptUnreadChanges}).
	 * A setting the build read keeps that value in {@link #promptSettingsRead}.
	 */
	#recordUnreadChanges(settingsChange: readonly SettingChange[]): void {
		let recorded: Map<AnySetting, unknown> | undefined;
		for (const { setting, previous } of settingsChange) {
			if (this.#promptSettingsRead.has(setting) || this.#promptUnreadChanges.has(setting)) continue;
			recorded ??= new Map(this.#promptUnreadChanges);
			recorded.set(setting, previous);
		}
		if (recorded) this.#promptUnreadChanges = recorded;
	}

	/**
	 * Rebuilds the base prompt for a change of a setting its build read at another value, while no reply and no call
	 * has bound the prompt: nothing is cached yet, so the change goes in now, and no rebuild after the prompt binds
	 * sends it in place of a held change.
	 */
	#rebuildUnboundPrompt(settingsChange: readonly SettingChange[]): Promise<void> {
		const stale = (): boolean => {
			const read = this.#promptSettingsRead;
			return settingsChange.some(({ setting }) => this.#readAtOtherValue(read, setting));
		};
		// Nothing to rebuild: no wait behind the registry mutations in flight.
		if (!stale()) return Promise.resolve();
		return this.#toolCallSettingsScope.exit(() =>
			this.runToolRegistryMutation(async () => {
				// A rebuild queued before this one (a prompt input's) may have taken the change in already.
				if (!this.#host.isDisposed() && this.#promptUnanswered && stale()) await this.refreshBaseSystemPrompt();
			}),
		);
	}

	/** Whether `read`, a build's settings reads, holds `setting` at another value than the session's settings now. */
	#readAtOtherValue(read: ReadonlyMap<AnySetting, unknown>, setting: AnySetting): boolean {
		return read.has(setting) && !settingValuesEqual(read.get(setting), setting.get(this.#host.settings));
	}

	/**
	 * What a hold keeps the bound prompt's tools declaring on the current branch: what the last request declared
	 * ({@link #sentDeclarations}) when the conversation continues from it (the current prompt, and the tool
	 * definitions the branch's newest request declared: {@link #boundToolsDigest}), else what the branch records its
	 * last request declared, when the active tools declare that under `before` (each held or changed setting at its
	 * earlier value; {@link #transcriptDeclarations}): a resumed or switched-in transcript, or a `/tree` move to a
	 * reply whose request declared other definitions. Undefined when nothing shows them.
	 */
	#keptDeclarations(before: ReadonlyMap<AnySetting, unknown>): SentDeclarations | undefined {
		const sent = this.#sentDeclarations;
		return sent?.promptDigest === this.currentPromptDigest() && sent.toolsDigest === this.#boundToolsDigest()
			? sent
			: this.#transcriptDeclarations(before);
	}

	/** Gives `held` the declarations its tools keep from now on, or none, and the agent its tools declared so. */
	#keepDeclarations(held: HeldSettingsRebuild, declarations: SentDeclarations | undefined): void {
		held.declarations = declarations;
		held.declared = new WeakMap();
		this.#setAgentTools(this.#host.agent.state.tools);
	}

	/**
	 * Follows a move to another branch (`/tree`, a rewind, a branch or fork into a new session file, a session
	 * switch): a held settings rebuild whose tools keep what a request declared with other tool definitions than the
	 * ones the branch's newest request declared ({@link #boundToolsDigest}) keeps what that request declared instead
	 * ({@link #keptDeclarations}), or nothing when nothing shows it, and its tools then declare what they render. The
	 * next request declares what the request it continues from declared, so it reads the cache entry that request's
	 * reply left.
	 */
	followBranchDeclarations(): void {
		const held = this.#heldSettingsRebuild;
		if (!held || held.declarations?.toolsDigest === this.#boundToolsDigest()) return;
		this.#keepDeclarations(held, this.#keptDeclarations(held.before));
	}

	/**
	 * What the current branch's last request declared for each tool, where this process's last request does not show
	 * it (a resumed or switched-in transcript, a branch `/tree` moved to whose newest request declared other
	 * definitions): the active tools' declarations under `before`, when the branch records that its newest reply was
	 * produced under the current prompt with tool definitions of their digest. They are then the declarations sent
	 * ({@link #sentDeclarations}). Undefined when the branch records neither, or the tools declare otherwise (a tool
	 * registered since, a withdrawn one only an earlier process could declare).
	 */
	#transcriptDeclarations(before: ReadonlyMap<AnySetting, unknown>): SentDeclarations | undefined {
		const promptDigest = this.currentPromptDigest();
		const toolsDigest = this.recordedToolsDigest();
		if (toolsDigest === undefined || this.recordedPromptDigest() !== promptDigest) return undefined;
		const tools = this.#host.agent.state.tools.map(tool => this.#declaredOwners.get(tool) ?? tool);
		const fields = this.#toolCallSettingsScope.run(
			this.#settingsWith(before, () => true),
			() => tools.map(tool => toolDeclarationFields(tool)),
		);
		const declared = tools.map((tool, index) => forwardingProxy(tool, fields[index]));
		if (this.#host.toolDefinitionsDigest(declared) !== toolsDigest) return undefined;
		const declarations: SentDeclarations = {
			promptDigest,
			toolsDigest,
			tools: new Map(tools.map((tool, index) => [tool.name, fields[index]] as const)),
		};
		this.#sentDeclarations = declarations;
		return declarations;
	}

	/**
	 * The changes of `settingsChange` an active tool's declaration moves with, among the tools that now declare
	 * otherwise than the bound prompt's kept declarations (the hold's, else {@link #keptDeclarations}): each change
	 * that gives one of those tools another declaration when set back to its earlier value alone, or when it alone
	 * keeps its new value while every held or changed setting is set back. The second catches a setting a declaration
	 * renders only beside another changed one (`tools.maxTimeout`, which `bash` states only while `async.enabled` is
	 * on), so a kept declaration runs under every setting it was rendered under. Empty when nothing shows what the
	 * bound prompt's request declared, no tool declares otherwise, or the hold keeps each changed setting. Gives the
	 * kept declarations too, which a hold that had none takes ({@link holdToolDeclarationChange}); undefined when the
	 * hold keeps each changed setting or nothing shows them.
	 */
	#declarationMovers(settingsChange: readonly SettingChange[]): {
		movers: SettingChange[];
		kept: SentDeclarations | undefined;
	} {
		const held = this.#heldSettingsRebuild;
		const changes = settingsChange.filter(({ setting }) => !held?.before.has(setting));
		if (changes.length === 0) return { movers: [], kept: undefined };
		// The settings the kept declarations were rendered under: each changed one at the value the prompt was built
		// with ({@link #builtValue}).
		const before = new Map(held?.before);
		for (const { setting, previous } of changes) before.set(setting, this.#builtValue(setting, previous));
		const kept = held?.declarations ?? this.#keptDeclarations(before);
		if (!kept) return { movers: [], kept };
		// Each tool that declares otherwise now, with what it declares under the session's settings.
		const altered = this.#host.agent.state.tools.flatMap(tool => {
			const own = this.#declaredOwners.get(tool) ?? tool;
			const fields = kept.tools.get(own.name);
			if (!fields) return [];
			const declaration = this.#toolCallSettingsScope.exit(() => toolDeclaration(own));
			return declaration === keptDeclaration(own, fields) ? [] : [{ own, declaration }];
		});
		if (altered.length === 0) return { movers: [], kept };
		const declarationsUnder = (values: ReadonlyMap<AnySetting, unknown>): string[] =>
			this.#toolCallSettingsScope.run(
				this.#settingsWith(values, () => true),
				() => altered.map(({ own }) => toolDeclaration(own)),
			);
		const live = altered.map(({ declaration }) => declaration);
		let declared: string[] | undefined;
		const movers = changes.filter(({ setting }) => {
			if (!sameItems(declarationsUnder(new Map([[setting, before.get(setting)]])), live)) return true;
			const others = new Map(before);
			others.delete(setting);
			declared ??= declarationsUnder(before);
			return !sameItems(declarationsUnder(others), declared);
		});
		return { movers, kept };
	}

	/**
	 * The changes of `settingsChange` the bound system prompt moves with, whatever setting it is: each setting the
	 * base prompt's build read ({@link #promptSettingsRead}) at another value than it holds now, or that the build
	 * the base stands in for read ({@link #baseStandIn}), when the prompt the settings give now renders otherwise
	 * than what the base stands for; and each change that prompt's build reads where the base's did not (a setting
	 * the prompt renders only beside another changed one). A setting the prompt surface reads (the eval preludes'
	 * gates, the per-call models, `skillful`) is left out: its change rides the surface's own notices and goes into
	 * the prompt with the next rebuild ({@link #promptSurface}). A setting the base's build read comes with the value
	 * it read: the value the bound prompt was built with; one it did not read comes with the value it had when that
	 * build was made ({@link #promptUnreadChanges}), though an earlier reload changed it too. Gives the render too, for
	 * the hold to record ({@link #recordHeldSettingsBuild}), undefined when nothing was rendered, and the settings the
	 * prompt surface reads, undefined when they were not derived.
	 */
	async #promptMovers(settingsChange: readonly SettingChange[]): Promise<{
		movers: SettingChange[];
		render: SystemPromptPreparation | undefined;
		surfaceRead: ReadonlyMap<AnySetting, unknown> | undefined;
	}> {
		const held = this.#heldSettingsRebuild;
		const read = this.#promptSettingsRead;
		const standIn = this.#baseStandIn?.base === this.#baseSystemPrompt ? this.#baseStandIn.settingsRead : undefined;
		const changes = settingsChange.filter(({ setting }) => !held?.before.has(setting));
		const candidates = changes.flatMap((change): SettingChange[] => {
			const { setting } = change;
			if (!read.has(setting)) return standIn?.has(setting) ? [change] : [];
			return this.#readAtOtherValue(read, setting) ? [{ setting, previous: read.get(setting) }] : [];
		});
		if (candidates.length === 0) return { movers: [], render: undefined, surfaceRead: undefined };
		const surfaceRead = await this.#promptSurfaceReads();
		const moved = candidates.filter(({ setting }) => !surfaceRead.has(setting));
		if (moved.length === 0) return { movers: [], render: undefined, surfaceRead };
		const base = this.#baseSystemPrompt;
		const render = await this.#prepareBaseSystemPrompt();
		// The prompt the settings give now renders what the base stands for: nothing of it moved.
		if (!render || sameItems(render.systemPrompt, base)) return { movers: [], render, surfaceRead };
		const unread = this.#promptUnreadChanges;
		const masked = changes.flatMap(({ setting, previous }): SettingChange[] =>
			!read.has(setting) &&
			!standIn?.has(setting) &&
			!surfaceRead.has(setting) &&
			render.settingsRead?.has(setting) === true
				? [{ setting, previous: unread.has(setting) ? unread.get(setting) : previous }]
				: [],
		);
		return { movers: [...moved, ...masked], render, surfaceRead };
	}

	/** The settings {@link #derivePromptSurface} reads: their changes ride the surface's own notices. */
	async #promptSurfaceReads(): Promise<ReadonlyMap<AnySetting, unknown>> {
		const { read } = await trackSettingsReads(this.#host.settings, async () => this.#derivePromptSurface());
		return read;
	}

	/**
	 * Renders the base prompt a rebuild would give now under a held settings rebuild (the live settings, with the
	 * tool set and skill list the prompt keeps), or takes `render`, one made for the change just now or one that joins
	 * the change the base withholds ({@link refreshBaseSystemPrompt}), and records it as the build the bound base, or
	 * the kept restored transcript prompt, stands in for ({@link #baseStandIn}). A later rebuild that only renders it
	 * again, such as a skill rediscovery that leaves the prompt's list as it is, then leaves the base and the hold in
	 * place. A build that changes the prompt holds the earlier changes it renders too ({@link #holdEarlierChanges}),
	 * told the prompt surface's reads by `surfaceRead` where the change just now derived them.
	 */
	async #recordHeldSettingsBuild(
		render?: SystemPromptPreparation,
		surfaceRead?: ReadonlyMap<AnySetting, unknown>,
	): Promise<void> {
		const base = this.#baseSystemPrompt;
		const prepared = render ?? (await this.#prepareBaseSystemPrompt());
		if (!prepared || prepared.systemPrompt === base || this.#baseSystemPrompt !== base) return;
		const settingsRead = prepared.settingsRead ?? NO_SETTINGS;
		this.#baseStandIn = { base, build: prepared.systemPrompt, settingsRead };
		if (!sameItems(prepared.systemPrompt, base)) await this.#holdEarlierChanges(settingsRead, surfaceRead);
	}

	/**
	 * Commits `render`, a build of this process's, when it has the bytes of the kept restored transcript prompt while
	 * no settings rebuild is held, and returns whether it did. This process's own build then reproduces that prompt,
	 * which withholds nothing from it, so the change that rendered it holds nothing and no notice names a value the
	 * prompt was not written under: the commit settles the restored prompt, or keeps it while it holds settings the
	 * settings notice still puts right ({@link #committedBase}, {@link #settleRestoredPrompt}). A render that keeps the
	 * base ({@link #keptBasePreparation}) renders the build the base stands in for again, so it reproduces nothing.
	 */
	#settleKeptRestoredPrompt(render: SystemPromptPreparation | undefined): boolean {
		const restored = this.#keptRestoredPrompt();
		if (!render || !restored || this.#heldSettingsRebuild || render.systemPrompt === restored.base) return false;
		return sameItems(render.systemPrompt, restored.base) && render.commit?.() === true;
	}

	/**
	 * Adds to the held settings rebuild each earlier change that its build, which read `read`, renders and the hold
	 * does not hold yet: a setting the base's build read at another value than it has now ({@link #promptSettingsRead}),
	 * or one that build did not read that changed since ({@link #promptUnreadChanges}), each with the value the base
	 * was built under. Such a change moved nothing alone (a setting the prompt renders only beside another one, changed
	 * in a later reload), and the rebuild sends it with the held change, so the settings notice names it as well
	 * ({@link takeSettingsNotice}), and so do the session's records of the hold ({@link #recordWithheldChange}). A
	 * setting the prompt surface reads (`surfaceRead`, derived here when not given) is left out, as
	 * {@link #promptMovers} leaves it.
	 */
	async #holdEarlierChanges(
		read: ReadonlyMap<AnySetting, unknown>,
		surfaceRead?: ReadonlyMap<AnySetting, unknown>,
	): Promise<void> {
		const held = this.#heldSettingsRebuild;
		if (!held) return;
		const builtWith = this.#promptSettingsRead;
		const unread = this.#promptUnreadChanges;
		const earlier: SettingChange[] = [];
		for (const setting of read.keys()) {
			if (held.before.has(setting)) continue;
			const builtUnder = builtWith.has(setting) ? builtWith : unread;
			if (this.#readAtOtherValue(builtUnder, setting)) earlier.push({ setting, previous: builtUnder.get(setting) });
		}
		if (earlier.length === 0) return;
		const surface = surfaceRead ?? (await this.#promptSurfaceReads());
		this.#holdMoreSettings(
			held,
			earlier.filter(({ setting }) => !surface.has(setting)),
		);
	}

	/**
	 * Records that the cut rule admitted a cut that rewrites every message after the system prompt and tools anyway:
	 * the held settings rebuild and the kept restored transcript prompt, if any, are due, and stay due if a failed
	 * rebuild restores them.
	 */
	noteRewritingCutAdmitted(): void {
		if (this.#heldSettingsRebuild) this.#heldSettingsRebuild.due = true;
		const restored = this.#keptRestoredPrompt();
		if (restored) restored.due = true;
	}

	/** Whether the held settings rebuild runs now ({@link absorbHeldSettingsRebuild}). */
	#heldSettingsRebuildDue(lapsed: boolean): boolean {
		const held = this.#heldSettingsRebuild;
		return held !== undefined && (withheldChangeDue(held, lapsed) || !this.#promptBound);
	}

	/**
	 * Runs the held settings rebuild once it is due ({@link withheldChangeDue}): the prompt cache entry the cut rule
	 * reads has `lapsed` or the next request cannot read it, the cut rule admitted a cut under the hold that rewrites
	 * every message, or the change is five minutes old, however warm the entry stayed. Runs it too when the prompt
	 * is no longer bound ({@link #holdSettingsRebuild}).
	 */
	absorbHeldSettingsRebuild(lapsed: boolean): Promise<void> {
		// Nothing runs: no wait behind the registry mutations in flight.
		if (!this.#heldSettingsRebuildDue(lapsed)) return Promise.resolve();
		return this.runToolRegistryMutation(async () => {
			if (this.#host.isDisposed() || !this.#heldSettingsRebuildDue(lapsed)) return;
			await this.#absorbHeldSettingsRebuild();
		});
	}

	/** Runs a held settings rebuild: the live settings, tool set and skills go into the prompt. */
	async #absorbHeldSettingsRebuild(): Promise<void> {
		const held = this.#heldSettingsRebuild;
		if (!held) return;
		// The rebuild commits the live state, whatever the base stood in for.
		this.#baseStandIn = undefined;
		if (held.reconcile) {
			// The forced apply ends the hold and activates the tools it enables.
			const toolNames = [...this.#enabledAfterHold(held)];
			await this.#runReleasingHold(held, () => this.#applyToolSet(toolNames, true));
			return;
		}
		await this.#runReleasingHold(held, async () => {
			const prepared = await this.#prepareBaseSystemPrompt();
			prepared?.commit?.();
		});
	}

	/**
	 * Builds the hidden notice of a held settings change: each changed setting with the value the model was told of
	 * it and the value now set (a credential's values withheld), the tools the change disabled, whose calls are
	 * refused, with whether the request still lists them, the tools it enables at the rebuild, and when the rebuild
	 * comes at the latest. Gives only what changed since the change's last notice on the current branch, both ways: a
	 * tool that notice gave as disabled that runs again, and one it gave as enabled that the rebuild no longer brings;
	 * a branch the change's notices are not on (`/tree` to an earlier reply, a switch to another session) gets the
	 * whole change. The change is a held settings rebuild's, else the settings a kept restored transcript prompt
	 * withholds ({@link #restoreTranscriptPrompt}). What the notices of every other change in `messages` gave counts as
	 * told ({@link noticedSettingStarts}): a setting at the value the newest of them gave it, and the tools they gave
	 * as disabled or as available after the rebuild. So the change's first notice also puts right what they told that
	 * is no longer so, as {@link #releasedSettingsNotice} does while no change is withheld: a setting whose value
	 * differs now (one set back before a restart, or after a hold that ended before a notice of its last state went
	 * out), a tool they gave as disabled that runs here, and one they gave as available after the rebuild that is not
	 * here. Such a setting is named apart from the held ones, as in effect, unless the base prompt was built with
	 * another value of it: the request's prompt and tools follow it already. Whether the request lists a disabled tool
	 * is read from its tool list, and from the `xd://` listing its `systemPrompt` and the mount notices among
	 * `xdevNotices` give it ({@link #nextRequestXdevNames}).
	 */
	takeSettingsNotice(
		messages: readonly AgentMessage[] = this.#host.agent.state.messages,
		xdevNotices: readonly AgentMessage[] = messages,
		systemPrompt: readonly string[] = this.#host.agent.state.systemPrompt,
	): CustomMessage<SettingsNoticeDetails> | undefined {
		const rebuild = this.#heldSettingsRebuild;
		const held = rebuild ?? this.#keptRestoredPrompt();
		const earlier = this.#earlierNoticesTold(messages, held?.id);
		if (!held) return this.#releasedSettingsNotice(earlier);
		const told = this.#settingsNoticeTold(held, messages);
		const values = new Map(told?.values);
		// A setting the change holds, or one the base was built with at another value, goes out with the rebuild; the
		// prompt and tools the request carries follow every other one already.
		const read = this.#promptSettingsRead;
		const waiting: [AnySetting, unknown][] = [];
		const settled: [AnySetting, unknown][] = [];
		for (const start of noticedSettingStarts(held.before, earlier)) {
			const [setting] = start;
			if (held.before.has(setting) || this.#readAtOtherValue(read, setting)) waiting.push(start);
			else settled.push(start);
		}
		const heldChanges = this.#settingChanges(waiting, values);
		const releasedChanges = this.#settingChanges(settled, values);
		// Without a notice of its own on the branch, the change goes on from what the other changes' notices told.
		const toldDisabled = told?.disabledTools ?? earlier.disabledTools;
		const toldEnabled = told?.enabledTools ?? earlier.enabledTools;
		let disabledTools: readonly string[];
		let enabledTools: readonly string[];
		if (rebuild) {
			// What the notices told that the rebuild still does stays told (a hold without a notice of its own goes on
			// from what the other changes' notices told): a tool given as disabled it does not bring back, and one given
			// as available after the rebuild that it brings.
			const after = this.#enabledAfterHold(rebuild);
			disabledTools = [
				...new Set([...rebuild.disabledTools.keys(), ...toldDisabled.filter(name => !after.has(name))]),
			];
			enabledTools = [...new Set([...rebuild.enabledTools, ...toldEnabled.filter(name => after.has(name))])];
		} else {
			// A kept restored prompt refuses no call and holds no tool back: a tool given as disabled runs again once it
			// is enabled here, and one given as available after the rebuild comes only if it is.
			const enabled = new Set(this.getEnabledToolNames());
			disabledTools = toldDisabled.filter(name => !enabled.has(name));
			enabledTools = toldEnabled.filter(name => enabled.has(name));
		}
		const tools = {
			disabledTools: disabledTools.filter(name => !toldDisabled.includes(name)),
			reenabledTools: toldDisabled.filter(name => !disabledTools.includes(name)),
			enabledTools: enabledTools.filter(name => !toldEnabled.includes(name)),
			noLongerEnabledTools: toldEnabled.filter(name => !enabledTools.includes(name)),
		};
		if (
			heldChanges.changes.length === 0 &&
			releasedChanges.changes.length === 0 &&
			Object.values(tools).every(names => names.length === 0)
		) {
			return undefined;
		}
		held.notices.push({ values, disabledTools, enabledTools });
		const xdevNames =
			tools.disabledTools.length > 0 ? this.#nextRequestXdevNames(xdevNotices, systemPrompt) : undefined;
		const given = [...heldChanges.given, ...releasedChanges.given];
		return settingsNoticeMessage(heldChanges.changes, given, tools, held.id, held.notices.length - 1, {
			rebuildBy: withheldChangeDeadline(held),
			releasedChanges: releasedChanges.changes,
			unlistedTools: xdevNames ? tools.disabledTools.filter(name => !this.#requestListing(name, xdevNames)) : [],
		});
	}

	/** What `held`'s newest settings notice in `messages` told the model; undefined when none is there. */
	#settingsNoticeTold(held: HeldSettings, messages: readonly AgentMessage[]): SettingsNoticeState | undefined {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role !== "custom" || message.customType !== SETTINGS_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (isRecord(details) && details.hold === held.id && typeof details.notice === "number") {
				return held.notices[details.notice];
			}
		}
		return undefined;
	}

	/**
	 * Each setting of `starts` whose value differs now from the one the model was told of it, as a settings notice
	 * and the held-tool refusal name it: from the value `told` gives it, else from its start
	 * ({@link noticedSettingStarts}). Gives each but a credential with its value now too, as the notice records it,
	 * and sets that value in `told`.
	 */
	#settingChanges(
		starts: Iterable<readonly [AnySetting, unknown]>,
		told: Map<AnySetting, unknown>,
	): { changes: SettingChangeView[]; given: HeldSettingRecord[] } {
		const changes: SettingChangeView[] = [];
		const given: HeldSettingRecord[] = [];
		for (const [setting, start] of starts) {
			const known = told.has(setting) ? told.get(setting) : start;
			const value = setting.get(this.#host.settings);
			if (settingValuesEqual(value, known)) continue;
			changes.push(settingChangeView(setting, known, value));
			if (!setting.isCredential) given.push(heldSettingRecord(setting, value));
			told.set(setting, value);
		}
		return { changes, given };
	}

	/**
	 * The hidden notice of what the settings notices in the context told the model that no longer holds, while no
	 * change is withheld (`earlier`, the notices of every change): a change they described ended before a notice of
	 * its last state went out (it was set back, then its held rebuild came due before the next request, or a resumed
	 * process did not keep the transcript's prompt). It names each setting they gave a value the live setting no longer
	 * has, each tool they gave as disabled that is enabled now, and each tool they gave as available after the rebuild
	 * that is not, under the newest notice's change, so the next request counts it as told. Undefined when nothing
	 * they told is contradicted; a credential, whose value no notice records, and a setting this process does not know
	 * are left out ({@link noticedSettingStarts}).
	 */
	#releasedSettingsNotice(earlier: EarlierNoticesTold): CustomMessage<SettingsNoticeDetails> | undefined {
		const { newest } = earlier;
		if (!newest) return undefined;
		const { changes, given } = this.#settingChanges(noticedSettingStarts(NO_SETTINGS, earlier), new Map());
		const enabled = new Set(this.getEnabledToolNames());
		const tools = {
			disabledTools: [],
			reenabledTools: earlier.disabledTools.filter(name => enabled.has(name)),
			enabledTools: [],
			noLongerEnabledTools: earlier.enabledTools.filter(name => !enabled.has(name)),
		};
		if (changes.length === 0 && Object.values(tools).every(names => names.length === 0)) return undefined;
		return settingsNoticeMessage(changes, given, tools, newest.hold, newest.notices, undefined);
	}

	/**
	 * What the settings notices in `messages` of every change but `except` told the model, each notice giving what
	 * changed since the one before it ({@link SettingsNoticeDetails}): the value the newest gave each setting it names,
	 * by id, the tools left given as disabled and as available after the rebuild, the newest notice that names a tool
	 * deciding which ({@link applyNoticeToolLists}), and the change the newest notice describes.
	 */
	#earlierNoticesTold(messages: readonly AgentMessage[], except?: string): EarlierNoticesTold {
		const values = new Map<string, unknown>();
		const disabledTools = new Set<string>();
		const enabledTools = new Set<string>();
		const counts = new Map<string, number>();
		let hold: string | undefined;
		let notices = 0;
		for (const message of messages) {
			if (message.role !== "custom" || message.customType !== SETTINGS_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (!isRecord(details) || typeof details.hold !== "string" || details.hold === except) continue;
			hold = details.hold;
			notices = (counts.get(hold) ?? 0) + 1;
			counts.set(hold, notices);
			if (!isHeldSettingRecords(details.values)) continue;
			for (const { id, value } of details.values) values.set(id, value);
			applyNoticeToolLists(disabledTools, enabledTools, details);
		}
		return {
			values,
			disabledTools: [...disabledTools],
			enabledTools: [...enabledTools],
			newest: hold === undefined ? undefined : { hold, notices },
		};
	}

	/**
	 * Why a call to `name`, bare or `xd://`-prefixed, is refused: a held settings rebuild unregistered it. It names
	 * each setting whose change disabled it as the settings notice names the change, from the value the model was told
	 * of it before the change's notices ({@link noticedSettingStarts}), and only while its value differs from that one;
	 * says where the tool stays listed until the rebuild in what the request the call answers carries (its tool list,
	 * or the `xd://` listing its system prompt and mount notices give), and nowhere when neither lists it; and gives the
	 * time the rebuild comes at the latest. Undefined for every other tool.
	 */
	heldToolRefusal(name: string): string | undefined {
		const bareName = stripXdUrlPrefix(name);
		const held = this.#heldSettingsRebuild;
		const gates = held?.disabledTools.get(bareName);
		if (!held || !gates) return undefined;
		const { messages, systemPrompt } = this.#host.agent.state;
		const starts = noticedSettingStarts(held.before, this.#earlierNoticesTold(messages, held.id));
		const { changes } = this.#settingChanges(
			gates.map(setting => [setting, starts.get(setting)] as const),
			new Map(),
		);
		const listing = this.#requestListing(bareName, this.#toldXdevNames(messages, systemPrompt));
		return prompt.render(heldToolRefusalPrompt, {
			tool: bareName,
			changes,
			inToolList: listing === "tools",
			inDeviceListing: listing === "devices",
			rebuildBy: withheldChangeDeadline(held),
		});
	}

	async #prepareBaseSystemPrompt(isCurrent?: () => boolean): Promise<SystemPromptPreparation | undefined> {
		if (this.#host.isDisposed() || !this.#rebuildSystemPrompt || isCurrent?.() === false) return;
		// Local alias: closures below cannot observe the field narrowing.
		const rebuildSystemPrompt = this.#rebuildSystemPrompt;
		const activeToolNames = this.getActiveToolNames();
		this.#setActiveToolNames?.(activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const heldRoster =
			this.#promptRosterHeld && this.#implicitRebuildBinding() !== "free" ? this.#basePromptRoster : undefined;
		if (heldRoster) {
			const kept = await this.#prepareHeldRosterPrompt(heldRoster, rebuildSystemPrompt, isCurrent);
			if (kept) return kept;
		}
		// Derive the candidate and run the awaited render inside its scope: the
		// tool getters read the candidate while the prompt renders, so the built
		// prompt and the captured signature describe the same state. Nothing is
		// published to {@link #promptSurface} here — an abandoned, stale or
		// throwing preparation leaves the committed snapshot untouched, and the
		// scope frame (not a rollback write) guarantees no clobbering of a newer
		// winner.
		const candidate = this.#derivePromptSurface();
		const built = await this.#promptSurfaceScope.run(candidate, () =>
			rebuildSystemPrompt(activeToolNames, this.#toolRegistry, this.#xdev),
		);
		// A rebuild that renders the build the base stands in for again changes nothing of its own: the base keeps
		// its bytes. Under a held settings rebuild the tool definitions keep theirs too; otherwise they follow this
		// process's state, as its own build's would.
		const standIn = this.#baseStandIn;
		if (
			standIn?.base === previousBaseSystemPrompt &&
			this.#host.model()?.thinking?.prefixBinding === true &&
			sameItems(built.systemPrompt, standIn.build)
		) {
			if (this.#heldSettingsRebuild) {
				return {
					systemPrompt: previousBaseSystemPrompt,
					commit: () => !this.#host.isDisposed() && isCurrent?.() !== false,
				};
			}
			return this.#keptBasePreparation(previousBaseSystemPrompt, candidate, isCurrent);
		}
		const promptTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		const mountedSignatureTools = [...(this.#xdev?.mountedNames ?? [])].flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [tool] : [];
		});
		const signature = this.#promptSurfaceScope.run(candidate, () =>
			this.#computeAppliedToolSignature(activeToolNames, promptTools, mountedSignatureTools),
		);
		return {
			systemPrompt: built.systemPrompt,
			settingsRead: built.settingsRead,
			commit: () => {
				// Publish only to a live, current session whose base this
				// preparation still owns.
				if (this.#host.isDisposed() || isCurrent?.() === false) return false;
				// A handler may have rebuilt policy while this preparation was
				// awaiting its final commit: its own lifecycle published its own
				// snapshot, so only carry the prompt forward.
				if (this.#baseSystemPrompt !== previousBaseSystemPrompt) return true;
				this.#baseSystemPrompt = this.#committedBase(built.systemPrompt);
				this.#promptSettingsRead = built.settingsRead ?? NO_SETTINGS;
				this.#promptUnreadChanges = NO_SETTINGS;
				this.#promptSurface = candidate;
				this.#host.clearMemoryPromotionSnapshot();
				if (!sameItems(previousBaseSystemPrompt, this.#baseSystemPrompt)) {
					this.#host.clearInheritedProviderPromptCacheKey();
				}
				this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
				invalidateToolSchemaMetadata(this.#host.agent.state.tools);
				this.#promptModelKey = this.#currentPromptModelKey();
				this.#promptInlineDescriptors = this.#currentInlineDescriptors();
				this.#lastAppliedToolSignature = signature;
				this.#recordBasePromptListing(activeToolNames, built.xdevCatalogNames);
				return true;
			},
		};
	}

	/**
	 * Re-renders a frozen prefix's base prompt against the roster it was
	 * committed with, so a forced rebuild that changes nothing else (a body-only
	 * skill update, an unchanged memory refresh) keeps the held roster change
	 * out of the bound prefix — eval description included — and leaves it to its
	 * notices. Returns `undefined` when the rebuild changes the prompt anyway:
	 * the prefix breaks regardless, so the caller absorbs the live roster.
	 */
	async #prepareHeldRosterPrompt(
		roster: PromptRoster,
		rebuildSystemPrompt: SystemPromptRebuilder,
		isCurrent: (() => boolean) | undefined,
	): Promise<SystemPromptPreparation | undefined> {
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const candidate: PromptSurface = {
			...this.#derivePromptSurface(),
			evalToolNames: this.#promptSurface.evalToolNames,
		};
		const built = await this.#promptSurfaceScope.run(candidate, () =>
			rebuildSystemPrompt(roster.toolNames, roster.tools, roster.xdev),
		);
		if (!sameItems(built.systemPrompt, previousBaseSystemPrompt)) return undefined;
		return this.#keptBasePreparation(previousBaseSystemPrompt, candidate, isCurrent);
	}

	/**
	 * A rebuild that keeps `base`, the base prompt it was prepared against: the commit publishes `candidate`, the
	 * surface the tool definitions render from, and what a commit records beside it, and leaves the base's bytes.
	 */
	#keptBasePreparation(
		base: string[],
		candidate: PromptSurface,
		isCurrent: (() => boolean) | undefined,
	): SystemPromptPreparation {
		return {
			systemPrompt: base,
			commit: () => {
				if (this.#host.isDisposed() || isCurrent?.() === false) return false;
				if (this.#baseSystemPrompt !== base) return true;
				this.#promptSurface = candidate;
				this.#host.clearMemoryPromotionSnapshot();
				this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
				invalidateToolSchemaMetadata(this.#host.agent.state.tools);
				this.#promptModelKey = this.#currentPromptModelKey();
				this.#promptInlineDescriptors = this.#currentInlineDescriptors();
				return true;
			},
		};
	}

	/** Stages memory prompt injection; the owning turn commits it together with extension policy. */
	async buildSystemPromptForAgentStart(
		promptText: string,
		isCurrent: () => boolean,
		signal?: AbortSignal,
	): Promise<SystemPromptPreparation> {
		const backend = await resolveMemoryBackend(this.#host.settings);
		if (!isCurrent() || !backend.beforeAgentStartPrompt) return { systemPrompt: this.#baseSystemPrompt };

		try {
			const memory = await backend.beforeAgentStartPrompt(this.#host.memoryBackendSession(), promptText, signal);
			if (!isCurrent()) return { systemPrompt: this.#baseSystemPrompt };
			const injected = memory?.context;
			// No recall this turn, or one that found nothing: the base prompt stays as it is. A recall the conversation
			// carries as a hidden message stays its recall unless the backend adopted an empty one in its place.
			if (!memory || !injected) {
				return {
					systemPrompt: this.#baseSystemPrompt,
					memoryNotice: memory?.notice,
					commit: () => {
						if (!isCurrent()) return false;
						if (!memory) return true;
						if (!memory.commit()) return false;
						this.#adoptMemoryRecall(memory, undefined);
						return true;
					},
				};
			}
			// A recall a system block would carry only by rewriting the cached prompt rides the conversation as a hidden
			// message (`adoptMemoryRecall`): a reused one the branch delivered that way, even on resume, and a fresh
			// one after a prefix-bound model answered a prompt sent without it (or while a call sent with that prompt is
			// in flight), where a new block would have the provider write the whole conversation to its cache again
			// and drop its replayed thinking. Each request sends it where its context lacks it, and a prompt rebuild
			// leaves it out of the memory instructions (`recallDelivered`).
			const hidden = memory.reused
				? findDeliveredRecall(this.#host.sessionManager.getBranchView(), () => this.#host.memoryRecallScope()) !==
					undefined
				: this.#promptBound;
			if (hidden) {
				return {
					systemPrompt: this.#baseSystemPrompt,
					memoryNotice: memory.notice,
					commit: () => {
						if (!isCurrent() || !memory.commit()) return false;
						this.#adoptMemoryRecall(memory, { text: injected, hidden: true });
						return true;
					},
				};
			}
			// A reused recall the branch delivered as a system block is in the kept restored transcript prompt already:
			// that prompt goes out as stored, held changes stay held, and the recall is adopted as the block the prompt
			// carries, which every build appends after the memory instructions from now on, as the transcript's first
			// request sent it (the session adopts it from the transcript at startup, so the builds already carry it). The
			// build the restored prompt stands in for takes it in: it goes out with that build, or settles the kept
			// prompt it reproduces ({@link refreshBaseSystemPrompt} with `joinsHeldChange`).
			if (memory.reused && this.#keptRestoredPrompt()) {
				return {
					systemPrompt: this.#baseSystemPrompt,
					memoryNotice: memory.notice,
					commit: () => {
						if (!isCurrent() || !memory.commit()) return false;
						this.#adoptMemoryRecall(memory, { text: injected, hidden: false });
						void this.refreshBaseSystemPrompt(undefined, { joinsHeldChange: true }).catch(error => {
							logger.debug("Prompt rebuild after a reused recall failed", {
								backend: backend.id,
								error: String(error),
							});
						});
						return true;
					},
				};
			}

			let refreshed: SystemPromptPreparation | undefined;
			try {
				// This rebuild renders the live settings, so a held settings rebuild runs first.
				refreshed = await this.runToolRegistryMutation(async () => {
					await this.#absorbHeldSettingsRebuild();
					return this.#prepareBaseSystemPrompt(isCurrent);
				});
			} catch (refreshErr) {
				logger.debug("Memory backend prompt refresh after beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: String(refreshErr),
				});
			}
			if (!isCurrent()) return { systemPrompt: this.#baseSystemPrompt };

			// The recall goes out as the prompt's own last block, which every build appends once it is adopted: a build
			// made after the session adopted it (a reused recall the transcript carries) ends with it already.
			const preparedBase = refreshed?.systemPrompt ?? this.#baseSystemPrompt;
			const stablePrompt = appendRecallBlock(preparedBase, injected);
			return {
				systemPrompt: stablePrompt,
				memoryNotice: memory.notice,
				commit: () => {
					if (!isCurrent() || !memory.commit()) return false;
					this.#adoptMemoryRecall(memory, { text: injected, hidden: false });
					refreshed?.commit?.();
					// A handler may have refreshed tools or policy. Promote the recall onto
					// that winning base, never replace it with the preparation's snapshot.
					const currentBase = this.#baseSystemPrompt;
					this.#host.captureMemoryPromotionSnapshot(currentBase);
					this.#baseSystemPrompt =
						currentBase === preparedBase ? stablePrompt : appendRecallBlock(currentBase, injected);
					this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
					return true;
				},
			};
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return { systemPrompt: this.#baseSystemPrompt };
		}
	}

	/**
	 * Records what the recall the backend just adopted leaves the conversation carrying: `recall`, as a hidden message
	 * or as the system prompt's own last block (undefined when it found nothing), and a reused recall's change
	 * reports, the branch's and the one this turn delivers. A fresh recall carries none.
	 */
	#adoptMemoryRecall(memory: MemoryPromptPreparation, recall: ConversationRecall | undefined): void {
		if (!memory.reused) {
			this.#host.adoptMemoryRecall(recall, []);
			return;
		}
		const changes = findDeliveredRecallChanges(this.#host.sessionManager.getBranchView(), () =>
			this.#host.memoryRecallScope(),
		);
		const notice = memory.notice;
		if (notice && !changes.some(report => report.content === notice.content)) changes.push(notice);
		this.#host.adoptMemoryRecall(recall, changes);
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, wire-visible names, and `skill://`
	 *      read capability — all are rendered into the prompt body (see
	 *      `system-prompt.md` `{{label}}: \`{{name}}\`` and `toolPromptNames` in
	 *      `buildSystemPrompt`). The wire name comes from `tool.customWireName` and
	 *      overrides the internal name on the model wire (e.g. `edit` exposes itself
	 *      as `apply_patch` to GPT-5 in apply_patch mode); a stale wire name would
	 *      desync prompt guidance from actual tool routing. Likewise a flipped
	 *      `readsSkillUris` changes skill catalog/URI guidance with identical
	 *      names and descriptions, so it must rebuild too.
	 *   3. The bounded mounted-MCP projection: escaped original-name labels,
	 *      actual `xd://` paths, and the omission flag in catalog order. These are
	 *      the exact values rendered by the global transport guidance; catalog
	 *      churn wholly behind the fallback does not change the prompt.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *   5. Sorted names of mounted xd:// skill readers: mounting, unmounting,
	 *      or flipping such a reader changes skill catalog/URI guidance without
	 *      touching the direct inventory, so it must rebuild. Mount churn of
	 *      capability-less tools leaves this segment empty and the prompt stable.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time {@link applyActiveToolsByName} runs. Do not refactor `describeTool`
	 * to cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call {@link refreshBaseSystemPrompt}
	 * after side-effecting changes; see the memory hooks and {@link syncAfterModelChange}.
	 *
	 * The calendar date is deliberately NOT part of the signature: the date/cwd
	 * reminder rides on the first user turn at request time (`date-cwd-reminder`),
	 * so a session spanning midnight must NOT rebuild a prompt that no longer
	 * embeds the date — the reminder picks up the new day on its own.
	 */
	#computeAppliedToolSignature(
		toolNames: string[],
		tools: AgentTool[],
		mountedTools: readonly AgentTool[] = [],
	): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}|${toolReadsSkillUris(tool)}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		const mountedMCPProjection = projectMountedMCPXdevGuidance(
			collectMountedMCPToolRoutes(this.#xdev ? listXdevTools(this.#xdev) : []),
		);
		const mountedMCPRouteSegment =
			JSON.stringify({
				mappings: mountedMCPProjection.mappings.map(mapping => [mapping.label, mapping.path] as const),
				hasOmittedMappings: mountedMCPProjection.hasOmittedMappings,
			}) ?? "{}";
		const serverInstructions = this.#getMcpServerInstructions?.();
		let instructionsSegment = "";
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		// The non-MCP remainder of the xd:// inventory is deliberately NOT part
		// of the signature: its mount/unmount announces itself through the
		// mount notice (`#xdevMountNotice`) rather than rewriting the system prompt, keeping
		// the provider cache prefix byte-stable. Mounted MCP routes are the narrow
		// exception above, bounded to the exact projection rendered in the global
		// route guidance so churn wholly behind its fallback does not rebuild.
		// Mounted xd:// readers stay out of the direct inventory, but a mounted
		// skill reader still drives catalog/URI guidance: hash only the sorted
		// names of mounted readers so their mount/unmount/flip rebuilds, while
		// mount churn of capability-less tools keeps the prompt byte-stable.
		const mountedReaderSegment = mountedTools
			.filter(tool => toolReadsSkillUris(tool))
			.map(tool => tool.name)
			.sort()
			.join("\u0002");
		return `${nameSegment}\u0003${descriptionSegment}\u0007${instructionsSegment}\u0008${mountedMCPRouteSegment}\u0009${mountedReaderSegment}`;
	}

	/**
	 * Replace MCP tools in the registry and enable them immediately. Refreshes
	 * are serialized so an older asynchronous prompt rebuild cannot commit
	 * after a newer catalog snapshot. Every connected MCP tool becomes available
	 * (mounted under `xd://` when that transport is active, else top-level);
	 * while vibe mode is active, activation waits for vibe exit.
	 */
	refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const snapshot = [...mcpTools];
		return this.runToolRegistryMutation(() =>
			this.#host.isDisposed() ? Promise.resolve() : this.#applyMCPToolRefresh(snapshot),
		);
	}

	async #applyMCPToolRefresh(mcpTools: CustomTool[]): Promise<void> {
		const previousMcpTools = new Map<string, AgentTool>();
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name)) previousMcpTools.set(name, tool);
		}
		const previousMcpManagerToolNames = new Set(this.#mcpManagerToolNames);
		const previousActiveMcpToolNames = this.getEnabledToolNames().filter(isMCPToolName);
		const restorePreviousMcpTools = () => {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#toolRegistry.delete(name);
			}
			for (const [name, tool] of previousMcpTools) this.#toolRegistry.set(name, tool);
			this.#mcpManagerToolNames = previousMcpManagerToolNames;
		};

		const extensionRunner = this.#host.extensionRunner();
		const managerTools = deduplicateMCPToolsByName(mcpTools).map(customTool => {
			const wrapped = wrapToolWithMetaNotice(
				CustomToolAdapter.wrap(customTool, this.#getCustomToolContext) as AgentTool,
			);
			return (extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped) as AgentTool;
		});
		const managerToolSet = new Set(managerTools);
		const reconciledTools = deduplicateMCPToolsByName([...this.#extensionMcpTools.values(), ...managerTools]);

		for (const name of this.#toolRegistry.keys()) {
			if (isMCPToolName(name)) this.#toolRegistry.delete(name);
		}
		this.#mcpManagerToolNames.clear();
		for (const tool of reconciledTools) {
			this.#toolRegistry.set(tool.name, tool);
			if (managerToolSet.has(tool)) this.#mcpManagerToolNames.add(tool.name);
		}

		// Connected manager tools become active immediately, except while vibe
		// narrows the active set to the director's tools: then every MCP tool keeps
		// its prior selection and vibe exit activates the manager set. Extension-owned
		// MCP tools always retain their prior selection while both share one registry.
		const vibeActive = this.#installedVibeToolNames.size > 0;
		const retainedActiveMcpToolNames = previousActiveMcpToolNames.filter(
			name => (vibeActive || this.#extensionMcpTools.has(name)) && this.#toolRegistry.has(name),
		);
		const nextActive = [
			...new Set([
				...this.#getActiveNonMCPToolNames(),
				...(vibeActive ? [] : this.#mcpManagerToolNames),
				...retainedActiveMcpToolNames,
			]),
		];
		try {
			await this.#applyActiveToolsByName(nextActive);
			if (this.#host.isDisposed()) {
				restorePreviousMcpTools();
			} else {
				if (vibeActive) this.#vibeDeferredMcpRefresh = true;
				// The settled mutation promise may retain this async frame; drop
				// rollback references as soon as the new generation commits.
				previousMcpTools.clear();
			}
		} catch (error) {
			restorePreviousMcpTools();
			throw error;
		}
	}

	/** Replaces RPC host-owned tools and refreshes the active set before the next model call. */
	refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const snapshot = [...rpcTools];
		return this.runToolRegistryMutation(() => this.#applyRpcHostToolRefresh(snapshot));
	}

	async #applyRpcHostToolRefresh(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getEnabledToolNames();
		const previousRpcHostTools = new Map(
			[...previousRpcHostToolNames].flatMap(name => {
				const tool = this.#toolRegistry.get(name);
				return tool ? [[name, tool] as const] : [];
			}),
		);
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		const extensionRunner = this.#host.extensionRunner();
		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				extensionRunner ? new ExtensionToolWrapper(metaWrapped, extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		try {
			await this.#applyActiveToolsByName(
				Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
			);
		} catch (error) {
			for (const name of this.#rpcHostToolNames) this.#toolRegistry.delete(name);
			this.#rpcHostToolNames = previousRpcHostToolNames;
			for (const [name, tool] of previousRpcHostTools) this.#toolRegistry.set(name, tool);
			throw error;
		}
	}
}

function registeredFilesystemSourcePath(runner: ExtensionRunner | undefined, name: string): string | undefined {
	const path = runner?.getRegisteredTool(name)?.sourceInfo.path;
	return path && isFilesystemSourcePath(path) ? path : undefined;
}
