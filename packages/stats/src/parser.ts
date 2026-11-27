import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AssistantMessage,
	coerceServiceTierByFamily,
	getPremiumServiceTierRequests,
	type MessageAttribution,
	parseServiceTier,
	resolveModelServiceTier,
	type ServiceTierByFamily,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { getSessionsDir, isEnoent, readLines, stringifyDeepJson } from "@oh-my-pi/pi-utils";
import {
	applyEntryPatches,
	ENTRY_PATCH_CUSTOM_TYPE,
	type EntryPatch,
	type EntryPatchRecord,
	entryAcceptsPatch,
	entryPatchesOf,
	isEntryPatchRecord,
	setPatchedFields,
} from "@oh-my-pi/pi-utils/entry-patches";
import type {
	AgentType,
	MessageStatsInput,
	SessionEntry,
	SessionMessageEntry,
	SessionModelUsageEntry,
	SessionServiceTierChangeEntry,
	ToolCallStats,
	ToolResultLink,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import {
	emptySpotlightRows,
	emptySpotlightState,
	SpotlightCollector,
	type SpotlightParseRows,
	type SpotlightParserState,
} from "./spotlight-ingest";
import { computeUserMessageMetrics, judgeProse } from "./user-metrics";

/** Basename of an advisor agent's transcript inside a session artifacts dir. */
const ADVISOR_TRANSCRIPT_BASENAME = "__advisor.jsonl";

/** Characters a persisted tool name may consist of without sanitization. */
const TOOL_NAME_PATTERN = /^[\w.:-]+$/;

/**
 * Classify which agent produced a transcript from its path within the sessions
 * directory. Layout: `<sessionsDir>/<project>/<file>.jsonl` is the `main`
 * agent; subagent and advisor transcripts live nested one level deeper inside
 * the session's artifacts dir (`<project>/<session>/<id>.jsonl`,
 * `<project>/<session>/__advisor.jsonl`). Any advisor transcript
 * (`__advisor.jsonl` or `__advisor.<slug>.jsonl`) — at any depth, including a
 * subagent's own advisor — counts as `advisor`; every other nested transcript
 * is a task `subagent`.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	const base = path.basename(sessionPath);
	if (base === ADVISOR_TRANSCRIPT_BASENAME || (base.startsWith("__advisor.") && base.endsWith(".jsonl"))) {
		return "advisor";
	}
	const rel = path.relative(getSessionsDir(), sessionPath);
	// `<project>/<file>.jsonl` -> 2 segments. Deeper nesting is a subagent.
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/**
 * Extract folder name from session filename.
 * Session files are named like: --work--pi--/timestamp_uuid.jsonl
 * The folder part uses -- as path separator.
 */
export function extractFolderFromPath(sessionPath: string): string {
	const sessionsDir = getSessionsDir();
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0];
	// Convert --work--pi-- to /work/pi
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * Check if an entry is an assistant message.
 */
function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	// Legacy sessions (pre-id tracking) recorded message entries without an `id`.
	// They're not linkable and would violate the messages.entry_id NOT NULL
	// constraint, so skip them at the parser boundary.
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

function isModelUsage(entry: SessionEntry): entry is SessionModelUsageEntry {
	if (entry.type !== "model_usage") return false;
	const usageEntry = entry as SessionModelUsageEntry;
	return typeof usageEntry.id === "string" && usageEntry.id.length > 0;
}

/**
 * Check if an entry is a user message (non-toolResult).
 */
function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "user";
}

/**
 * Check if an entry is a service-tier change.
 */
function isServiceTierChange(entry: SessionEntry): entry is SessionServiceTierChangeEntry {
	return entry.type === "service_tier_change";
}

/**
 * Check if an entry is a tool-result message.
 */
function isToolResultMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	return (entry as SessionMessageEntry).message?.role === "toolResult";
}

/**
 * Extract plain text from a user message content payload.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Build user-message stats from an entry. Returns null for empty, synthetic, or agent-attributed content.
 */
function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const msg = entry.message as {
		role: "user";
		content?: unknown;
		synthetic?: boolean;
		attribution?: MessageAttribution;
	};
	if (msg.role !== "user" || msg.synthetic || msg.attribution === "agent") return null;
	const text = extractUserText(msg.content);
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const prose = judgeProse(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
		prose,
		proseHash: prose ? Bun.hash(prose).toString(16) : "",
	};
}

/**
 * Session JSONL is written by older versions and foreign producers, so a token
 * counter is whatever was persisted, not what `Usage` declares. A non-numeric
 * bucket (`input: "10"`) must never be parsed and must never be summed: `+`
 * would concatenate it into the derived total and SQLite would coerce the
 * resulting string to a different, far larger number. A non-finite one
 * (`input: 1e999` is legal JSON) must not reach a NOT NULL column either.
 * Malformed input counts as absent.
 */
function isFiniteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function finiteTokenCount(value: unknown): number {
	return isFiniteCount(value) ? value : 0;
}

/**
 * Token-bucket view for total derivation. Persisted session payloads are
 * outside-controlled (old versions, foreign producers), so every counter is
 * `unknown` and validated at read time.
 */
export interface UsageBucketView {
	totalTokens?: unknown;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	orchestration?: { input?: unknown; output?: unknown; cacheRead?: unknown } | null;
}

/**
 * Total tokens for one usage payload, per the documented contract: the
 * conversation buckets plus provider-reported orchestration tokens. A present
 * finite provider total stays authoritative; a missing or malformed one
 * (absent, string, NaN) is derived from the buckets, which would otherwise
 * persist a zero total next to real token counts. Shared by ingest and the
 * trace builder so stored and displayed totals cannot disagree.
 */
export function resolveUsageTotal(usage: UsageBucketView | null | undefined): number {
	if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	if (!usage || typeof usage !== "object") return 0;
	const orchestration =
		usage.orchestration && typeof usage.orchestration === "object" ? usage.orchestration : undefined;
	return (
		finiteTokenCount(usage.input) +
		finiteTokenCount(usage.output) +
		finiteTokenCount(usage.cacheRead) +
		finiteTokenCount(usage.cacheWrite) +
		finiteTokenCount(orchestration?.input) +
		finiteTokenCount(orchestration?.output) +
		finiteTokenCount(orchestration?.cacheRead)
	);
}

/**
 * Extract stats from an assistant message entry.
 *
 * Session JSONL on disk is not guaranteed to match the current
 * `AssistantMessage` shape: crash-truncated turns, sessions written by older
 * versions, and foreign producers all flow through this parser. Every field
 * returned here feeds a NOT NULL column in stats.db, so malformed entries are
 * coerced (missing `stopReason`, token counts, `timestamp`) or skipped
 * (missing `model`/`provider`/`api`/`usage`) instead of crashing the whole
 * sync with a constraint violation.
 */
function extractStats(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	currentServiceTier: ServiceTierByFamily | undefined,
	agentType: AgentType,
): MessageStatsInput | null {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant") return null;
	if (typeof msg.model !== "string" || typeof msg.provider !== "string" || typeof msg.api !== "string") return null;
	const rawUsage = msg.usage as Partial<Usage> | undefined;
	if (!rawUsage || typeof rawUsage !== "object") return null;

	// Backfill: when the session recorded a premium tier (`priority`/`ultrafast`)
	// as the active service tier at this point but the AI usage payload was
	// captured before premium requests were folded into `premiumRequests`, derive
	// the count here so the "Premium Reqs" stat aggregates premium traffic on
	// re-sync. The tier the provider reported serving the turn (`msg.serviceTier`)
	// is authoritative — it is proof the tier reached the wire, so the
	// discovery-metadata gate is skipped; the session's live setting is only a
	// fallback for turns recorded before that field existed. Trust any non-zero
	// value already in `usage.premiumRequests` (Copilot multipliers or the new AI
	// code path) and only synthesise when the field is missing/zero.
	const recorded = rawUsage.premiumRequests ?? 0;
	const model = {
		provider: msg.provider,
		api: msg.api,
		identity: classifyModel(msg.provider, msg.model, { lenient: true }),
	};
	const servedTier = parseServiceTier(msg.serviceTier);
	const tier = servedTier ?? resolveModelServiceTier(currentServiceTier, model);
	const derived =
		recorded > 0 ? recorded : getPremiumServiceTierRequests(tier, model, { served: servedTier !== undefined });
	const wellFormed =
		isFiniteCount(rawUsage.input) &&
		isFiniteCount(rawUsage.output) &&
		isFiniteCount(rawUsage.cacheRead) &&
		isFiniteCount(rawUsage.cacheWrite) &&
		isFiniteCount(rawUsage.totalTokens);
	const usage: MessageStatsInput["usage"] =
		wellFormed && derived === recorded
			? (rawUsage as Usage)
			: {
					...rawUsage,
					input: finiteTokenCount(rawUsage.input),
					output: finiteTokenCount(rawUsage.output),
					cacheRead: finiteTokenCount(rawUsage.cacheRead),
					cacheWrite: finiteTokenCount(rawUsage.cacheWrite),
					// A present finite provider total stays authoritative; a missing
					// or malformed one (absent, string, NaN) is derived from the buckets.
					totalTokens: resolveUsageTotal(rawUsage),
					// An omitted `cost` must stay omitted: `resolveStoredCost` reads
					// absence as "no recorded price" and estimates the request, while
					// a zero would read as an explicitly free request.
					cost: rawUsage.cost,
					premiumRequests: derived,
				};

	return {
		sessionFile,
		entryId: entry.id,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: coerceEntryTimestamp(msg.timestamp, entry),
		duration: msg.duration ?? null,
		ttft: msg.ttft ?? null,
		// A message persisted without a terminal stop reason never completed
		// normally: classify by whether it carried an error.
		stopReason: msg.stopReason ?? (msg.errorMessage ? "error" : "aborted"),
		errorMessage: msg.errorMessage ?? null,
		usage,
		agentType,
		serviceTier: servedTier ?? null,
	};
}

function extractModelUsageStats(
	sessionFile: string,
	folder: string,
	entry: SessionModelUsageEntry,
	agentType: AgentType,
): MessageStatsInput | null {
	const timestamp = Date.parse(entry.timestamp);
	return extractStats(
		sessionFile,
		folder,
		{
			type: "message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			message: {
				role: "assistant",
				content: [],
				api: entry.api,
				provider: entry.provider,
				model: entry.model,
				usage: entry.usage,
				stopReason: entry.stopReason ?? "stop",
				errorMessage: entry.errorMessage,
				timestamp: Number.isFinite(timestamp) ? timestamp : 0,
			},
		},
		undefined,
		agentType,
	);
}

/** Message timestamp, falling back to the entry's ISO timestamp, then 0. */
function coerceEntryTimestamp(timestamp: number | undefined, entry: SessionMessageEntry): number {
	// A stored zero is the "no timestamp" sentinel, not 1970: fall through to
	// the entry envelope so a recoverable ISO time still selects its tariff.
	if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) return timestamp;
	const ts = Date.parse(entry.timestamp);
	return Number.isFinite(ts) ? ts : 0;
}

/**
 * Extract one {@link ToolCallStats} per `toolCall` content block of an
 * assistant message. Returns an empty array for turns without tool calls.
 */
function extractToolCalls(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	agentType: AgentType,
): ToolCallStats[] {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
	// `tool_calls` columns are NOT NULL: skip turns that can't be attributed
	// (malformed persisted entries — see extractStats) and blocks missing ids.
	if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];

	const blocks = msg.content.filter(
		(block): block is ToolCall =>
			block !== null &&
			typeof block === "object" &&
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string",
	);
	if (blocks.length === 0) return [];

	const calls: ToolCallStats[] = [];
	for (const block of blocks) {
		// Names reduced to nothing by sanitization carry no tool identity:
		// skip them rather than attributing usage to garbage (see
		// sanitizeToolName). callsInTurn still counts the raw block total.
		const toolName = sanitizeToolName(block.name);
		if (toolName === null) continue;
		let argsChars = 0;
		try {
			argsChars = stringifyDeepJson(block.arguments ?? {})?.length ?? 0;
		} catch {
			// Non-serializable arguments (shouldn't happen in persisted JSONL); size unknown.
		}
		calls.push({
			sessionFile,
			entryId: entry.id,
			toolCallId: block.id,
			folder,
			toolName,
			model: msg.model,
			provider: msg.provider,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry),
			agentType,
			callsInTurn: blocks.length,
			argsChars,
		});
	}
	return calls;
}

/**
 * Tool names as persisted can be polluted by provider-side parse garbage — a
 * gateway may hand the model's whole invocation text back as the function
 * name (e.g. `bash command="ls -la …"` with a stray in-band closer), which
 * then shows up verbatim in every `GROUP BY tool_name` aggregate and the
 * dashboard tool filter. Reduce such names to their leading identifier token;
 * names that yield no identifier at all carry no tool identity and are
 * returned as `null` so the row is skipped.
 */
function sanitizeToolName(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length === 0) return null;
	if (TOOL_NAME_PATTERN.test(trimmed)) return trimmed;
	const candidate = trimmed.split(/[^\w.:-]/)[0] ?? "";
	return candidate.length > 0 ? candidate : null;
}

/** A call the agent loop skipped carries a synthetic `executed: false` result: it never ran, so it is no tool error. */
function isToolExecutionError(message: { isError?: unknown; details?: unknown }): boolean {
	if (message.isError !== true) return false;
	const details = message.details as { __synthetic?: unknown; executed?: unknown } | null | undefined;
	return !(details?.__synthetic === true && details.executed === false);
}

/**
 * Build the result linkage for a `toolResult` entry: text characters fed back
 * into context plus the error flag, keyed to the originating call.
 */
function extractToolResultLink(sessionFile: string, entry: SessionMessageEntry): ToolResultLink | null {
	const msg = entry.message as ToolResultMessage;
	if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return null;
	let resultChars = 0;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				resultChars += block.text.length;
			}
		}
	}
	return {
		sessionFile,
		toolCallId: msg.toolCallId,
		resultChars,
		isError: isToolExecutionError(msg),
	};
}

const LF = 0x0a;
const CR = 0x0d;
const jsonLineDecoder = new TextDecoder();

function parseJsonLine(bytes: Uint8Array, start: number, end: number): SessionEntry | null {
	while (end > start && bytes[end - 1] === CR) end--;
	if (end <= start) return null;
	try {
		return JSON.parse(jsonLineDecoder.decode(bytes.subarray(start, end))) as SessionEntry;
	} catch {
		return null;
	}
}

function visitSessionEntriesLenient(bytes: Uint8Array, visit: (entry: SessionEntry) => void): number {
	let cursor = 0;
	let read = 0;

	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseJsonLine(bytes, cursor, lineEnd);
		if (entry) {
			visit(entry);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			read = newline + 1;
		} else {
			break;
		}
		cursor = hasNewline ? newline + 1 : lineEnd;
	}

	return read;
}

/** Patches of a transcript's `entry_patch` records, by the id of the entry each names, in file order. */
type EntryPatchesById = Map<string, EntryPatch[]>;

/**
 * Bytes the line of every `entry_patch` record holds: its `customType` as JSON writes it. A scan for
 * records parses only the lines that hold them.
 */
const ENTRY_PATCH_MARKER = Buffer.from(JSON.stringify(ENTRY_PATCH_CUSTOM_TYPE));

/** Index of the first {@link ENTRY_PATCH_MARKER} in `bytes` at or after `from`, or -1. */
function entryPatchMarkerAt(bytes: Uint8Array, from = 0): number {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(ENTRY_PATCH_MARKER, from);
}

/** The patches of `entry` when it is a well-formed `entry_patch` record. */
function recordPatches(entry: SessionEntry): readonly EntryPatch[] {
	if (!isEntryPatchRecord(entry)) return [];
	return entryPatchesOf(entry) ?? [];
}

/** The patches of the `entry_patch` records in `bytes`, parsing only the lines that hold {@link ENTRY_PATCH_MARKER}. */
function collectEntryPatches(bytes: Uint8Array): EntryPatchesById {
	const byId: EntryPatchesById = new Map();
	let at = entryPatchMarkerAt(bytes);
	while (at !== -1) {
		const newline = bytes.indexOf(LF, at);
		const entry = parseJsonLine(bytes, bytes.lastIndexOf(LF, at) + 1, newline === -1 ? bytes.length : newline);
		for (const patch of entry ? recordPatches(entry) : []) {
			const held = byId.get(patch.entryId);
			if (held) held.push(patch);
			else byId.set(patch.entryId, [patch]);
		}
		at = newline === -1 ? -1 : entryPatchMarkerAt(bytes, newline + 1);
	}
	return byId;
}

/**
 * Set on `entry` the fields of each patch `byId` holds for it that fits it, in file order, so the
 * newest value of a field wins. Returns its id when a record names it.
 */
function patchEntry(entry: SessionEntry, byId: EntryPatchesById): string | undefined {
	if (byId.size === 0 || entry.type === "session" || !("id" in entry) || typeof entry.id !== "string")
		return undefined;
	const patches = byId.get(entry.id);
	if (!patches) return undefined;
	for (const patch of patches) if (entryAcceptsPatch(entry, patch)) setPatchedFields(entry, patch);
	return entry.id;
}

/**
 * `entries` without their `entry_patch` records. The entry appended after a record names it as
 * parent; it names the record's own parent instead, as the transcript reads when the fields the
 * record sets are written inline.
 */
function withoutEntryPatchRecords(entries: readonly SessionEntry[]): SessionEntry[] {
	const recordParents = new Map<string, string | null>();
	const kept: SessionEntry[] = [];
	for (const entry of entries) {
		if (!isEntryPatchRecord(entry)) kept.push(entry);
		else if (typeof entry.id === "string")
			recordParents.set(entry.id, "parentId" in entry && typeof entry.parentId === "string" ? entry.parentId : null);
	}
	if (recordParents.size === 0) return kept;
	for (const entry of kept) {
		if (!("parentId" in entry) || typeof entry.parentId !== "string") continue;
		let parentId: string | null = entry.parentId;
		// Records of passes that ran back to back chain onto each other; the hop bound stops a cycle.
		for (let hops = 0; parentId !== null && recordParents.has(parentId) && hops < recordParents.size; hops++) {
			parentId = recordParents.get(parentId) ?? null;
		}
		entry.parentId = parentId;
	}
	return kept;
}

/**
 * The parents of a transcript's `entry_patch` records read so far, by record id, each through the
 * records it names as parent. An entry appended after a record names the record as parent; its
 * parent is the entry the record follows, as the transcript reads with the records' fields inline.
 */
type RecordParents = Map<string, string | null>;

/** Note the parent of `record` in `recordParents`, through the records it already holds. */
function noteRecordParent(recordParents: RecordParents, record: SessionEntry & EntryPatchRecord): void {
	if (typeof record.id !== "string") return;
	const parentId = "parentId" in record && typeof record.parentId === "string" ? record.parentId : null;
	recordParents.set(
		record.id,
		parentId !== null && recordParents.has(parentId) ? (recordParents.get(parentId) ?? null) : parentId,
	);
}

/**
 * Parse every well-formed entry in a transcript buffer (malformed lines skipped), with the fields its
 * `entry_patch` records set. The records themselves are not listed ({@link withoutEntryPatchRecords}).
 */
export function parseAllSessionEntries(bytes: Uint8Array): SessionEntry[] {
	const entries: SessionEntry[] = [];
	visitSessionEntriesLenient(bytes, entry => entries.push(entry));
	applyEntryPatches(entries);
	return withoutEntryPatchRecords(entries);
}

/**
 * Rebuild the cursor state of `bytes` (a transcript prefix): the last service tier, the Spotlight
 * state, from entries carrying the fields `patches` sets, and the parents of its records, noted in
 * `recordParents`.
 */
function scanPrefixState(
	bytes: Uint8Array,
	spotlight: SpotlightCollector,
	patches: EntryPatchesById,
	recordParents: RecordParents,
): ServiceTierByFamily | undefined {
	let currentServiceTier: ServiceTierByFamily | undefined;
	visitSessionEntriesLenient(bytes, entry => {
		if (isServiceTierChange(entry)) currentServiceTier = coerceServiceTierByFamily(entry.serviceTier);
		else if (isEntryPatchRecord(entry)) noteRecordParent(recordParents, entry);
		else {
			patchEntry(entry, patches);
			spotlight.visit(entry);
		}
	});
	return currentServiceTier;
}
export interface SessionParserState {
	version: 1;
	offset: number;
	ino: number;
	birthtimeMs: number;
	size: number;
	mtimeMs: number;
	checkpoint: string;
	serviceTier: ServiceTierByFamily | null;
	/** Absent in cursors persisted before the Spotlight tables; such a tail parse starts from an empty state. */
	spotlight?: SpotlightParserState;
	/**
	 * The parents of the `entry_patch` records read so far, by record id ({@link RecordParents}); absent
	 * when there are none, and in cursors persisted before it.
	 */
	recordParents?: Array<[string, string | null]>;
}

export interface ParseSessionResult {
	stats: MessageStatsInput[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	spotlight: SpotlightParseRows;
	newOffset: number;
	parserState?: SessionParserState;
	reset?: boolean;
}

const CHECKPOINT_BYTES = 256;

/**
 * Bytes `start`..`end` of the file, read by position. `Bun.file(fd).slice(0, n)` reads from the
 * descriptor's position, not from byte 0, so a second read of the same descriptor gets the bytes after
 * the first.
 */
async function readRange(handle: fs.FileHandle, start: number, end: number): Promise<Uint8Array> {
	const bytes = new Uint8Array(end - start);
	let read = 0;
	while (read < bytes.length) {
		const result = await handle.read(bytes, read, bytes.length - read, start + read);
		if (result.bytesRead === 0) break;
		read += result.bytesRead;
	}
	return bytes.subarray(0, read);
}

/**
 * Whether `info` is still the file a cursor was taken from. The device number is deliberately not part of
 * this: ZFS and others renumber it across mounts and reboots while the transcript stays intact; `ino` +
 * `birthtimeMs` (plus size/mtime at call sites) identify the file.
 */
export function matchesSessionFile(state: SessionParserState, info: nodeFs.Stats): boolean {
	return state.ino === info.ino && state.birthtimeMs === info.birthtimeMs;
}

/** What a read of transcript entries derives: their rows, and the cursor state they leave. */
interface DerivedRows {
	stats: MessageStatsInput[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	/** The service tier in force after the entries. */
	serviceTier: ServiceTierByFamily | undefined;
	/** Bytes read, through the last complete entry. */
	read: number;
	/** Ids of the entries a record named. */
	patched: Set<string>;
	/** The parents of the records read, and of those `recordParents` held before them. */
	recordParents: RecordParents;
}

/**
 * Derive the rows of the entries in `bytes`, each carrying the fields `patches` sets; `serviceTier`,
 * `spotlight` and `recordParents` hold the state the entries before them left.
 */
function deriveRows(
	bytes: Uint8Array,
	sessionPath: string,
	serviceTier: ServiceTierByFamily | undefined,
	spotlight: SpotlightCollector,
	patches: EntryPatchesById,
	recordParents: RecordParents,
): DerivedRows {
	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const rows: DerivedRows = {
		stats: [],
		userStats: [],
		userLinks: [],
		toolCalls: [],
		toolResults: [],
		serviceTier,
		read: 0,
		patched: new Set(),
		recordParents,
	};
	// First call per id: the row `INSERT OR IGNORE` keeps, so it can be written with its result.
	const callsById = new Map<string, ToolCallStats>();

	// Reduce each entry immediately so full replays do not retain tool-output/message bodies.
	rows.read = visitSessionEntriesLenient(bytes, entry => {
		// A record is no entry of the session: the entries it names carry its fields.
		if (isEntryPatchRecord(entry)) {
			noteRecordParent(rows.recordParents, entry);
			return;
		}
		const patched = patchEntry(entry, patches);
		if (patched !== undefined) rows.patched.add(patched);
		spotlight.visit(entry);
		if (isServiceTierChange(entry)) {
			rows.serviceTier = coerceServiceTierByFamily(entry.serviceTier);
			return;
		}
		if (isUserMessage(entry)) {
			const userMsg = extractUserStats(sessionPath, folder, entry);
			if (userMsg) rows.userStats.push(userMsg);
			return;
		}
		if (isToolResultMessage(entry)) {
			const link = extractToolResultLink(sessionPath, entry);
			if (!link) return;
			rows.toolResults.push(link);
			const call = callsById.get(link.toolCallId);
			if (call && call.resultChars === undefined) {
				call.resultChars = link.resultChars;
				call.isError = link.isError;
			}
			return;
		}
		if (isModelUsage(entry)) {
			const modelUsageStats = extractModelUsageStats(sessionPath, folder, entry, agentType);
			if (modelUsageStats) rows.stats.push(modelUsageStats);
			return;
		}
		if (isAssistantMessage(entry)) {
			const msgStats = extractStats(sessionPath, folder, entry, rows.serviceTier, agentType);
			if (msgStats) rows.stats.push(msgStats);
			for (const call of extractToolCalls(sessionPath, folder, entry, agentType)) {
				rows.toolCalls.push(call);
				if (!callsById.has(call.toolCallId)) callsById.set(call.toolCallId, call);
			}
			// Persist links even when the user entry was ingested in an earlier tail read. A reply appended
			// after a record names the record: it answers the entry the record follows.
			const parentId =
				entry.parentId && rows.recordParents.has(entry.parentId)
					? rows.recordParents.get(entry.parentId)
					: entry.parentId;
			const msg = entry.message;
			if (parentId && msg.role === "assistant" && msg.model && msg.provider) {
				rows.userLinks.push({
					sessionFile: sessionPath,
					entryId: parentId,
					model: msg.model,
					provider: msg.provider,
				});
			}
		}
	});
	return rows;
}

/**
 * Offset-only callers reconstruct service-tier state once; persisted cursors read only the appended tail.
 * Entries carry the fields their `entry_patch` records set. A record in the tail that names an entry
 * before it makes the read derive the whole transcript again, flagged `reset`, so the rows an earlier
 * read stored for that entry are replaced. A reply whose parent is a record links the entry the record
 * follows, as `parseAllSessionEntries` reads it; the cursor keeps the records' parents, so a reply in
 * a later tail links through a record an earlier read passed.
 */
export async function parseSessionFile(
	sessionPath: string,
	fromOffset = 0,
	state?: SessionParserState,
	replay = false,
): Promise<ParseSessionResult> {
	let start = fromOffset;
	let reset = false;
	let info: nodeFs.Stats;
	let checkpoint: string;
	let rows: DerivedRows;
	let spotlight: SpotlightCollector;
	const folder = extractFolderFromPath(sessionPath);

	try {
		const handle = await fs.open(sessionPath, "r");
		try {
			info = await handle.stat();
			let resume = state?.version === 1 && state.offset === fromOffset;
			if (resume && state) {
				reset =
					!matchesSessionFile(state, info) ||
					info.size < state.size ||
					(info.size === state.size && info.mtimeMs !== state.mtimeMs);
				if (!reset) {
					const previous = await readRange(handle, Math.max(0, fromOffset - CHECKPOINT_BYTES), fromOffset);
					reset = Bun.hash(previous).toString(16) !== state.checkpoint;
				}
				resume = !reset;
			}
			if (fromOffset > info.size) reset = true;
			if (replay) resume = false;
			start = reset || replay ? 0 : Math.max(0, fromOffset);
			let readStart = resume ? start : 0;
			let bytes = await readRange(handle, readStart, info.size);
			const tail = bytes.subarray(start - readStart);
			const tailPatches = collectEntryPatches(tail);
			// A record in the prefix names entries of the prefix scan, or of the tail.
			const patches = readStart === start ? tailPatches : collectEntryPatches(bytes);
			let serviceTier: ServiceTierByFamily | undefined;
			let recordParents: RecordParents;
			if (resume) {
				serviceTier = state?.serviceTier ?? undefined;
				spotlight = new SpotlightCollector(sessionPath, folder, state?.spotlight ?? emptySpotlightState());
				recordParents = new Map(state?.recordParents);
			} else {
				const prefix = new SpotlightCollector(sessionPath, folder, emptySpotlightState(), false);
				recordParents = new Map();
				serviceTier = scanPrefixState(bytes.subarray(0, start), prefix, patches, recordParents);
				spotlight = new SpotlightCollector(sessionPath, folder, prefix.state);
			}
			const tailRows = deriveRows(tail, sessionPath, serviceTier, spotlight, patches, recordParents);
			rows = tailRows;
			// A record of the tail names an entry before it, whose rows an earlier read stored: derive
			// every row again, from entries that carry the records' fields, to replace those rows.
			if (start > 0 && [...tailPatches.keys()].some(id => !tailRows.patched.has(id))) {
				reset = true;
				start = 0;
				if (readStart > 0) {
					readStart = 0;
					bytes = await readRange(handle, 0, info.size);
				}
				spotlight = new SpotlightCollector(sessionPath, folder, emptySpotlightState());
				rows = deriveRows(bytes, sessionPath, undefined, spotlight, collectEntryPatches(bytes), new Map());
			}
			const newOffset = start + rows.read;
			const checkpointStart = Math.max(0, newOffset - CHECKPOINT_BYTES);
			const previous =
				checkpointStart >= readStart
					? bytes.subarray(checkpointStart - readStart, newOffset - readStart)
					: await readRange(handle, checkpointStart, newOffset);
			checkpoint = Bun.hash(previous).toString(16);
		} finally {
			await handle.close();
		}
	} catch (err) {
		if (isEnoent(err))
			return {
				stats: [],
				userStats: [],
				userLinks: [],
				toolCalls: [],
				toolResults: [],
				spotlight: emptySpotlightRows(),
				newOffset: fromOffset,
			};
		throw err;
	}

	await spotlight.finish();
	const newOffset = start + rows.read;
	return {
		stats: rows.stats,
		userStats: rows.userStats,
		userLinks: rows.userLinks,
		toolCalls: rows.toolCalls,
		toolResults: rows.toolResults,
		spotlight: spotlight.rows,
		newOffset,
		reset,
		parserState: {
			version: 1,
			offset: newOffset,
			ino: info.ino,
			birthtimeMs: info.birthtimeMs,
			size: info.size,
			mtimeMs: info.mtimeMs,
			checkpoint,
			serviceTier: rows.serviceTier ?? null,
			spotlight: spotlight.state,
			recordParents: rows.recordParents.size > 0 ? [...rows.recordParents] : undefined,
		},
	};
}

/**
 * List all session directories (folders).
 */
export async function listSessionFolders(): Promise<string[]> {
	try {
		const sessionsDir = getSessionsDir();
		const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(sessionsDir, e.name));
	} catch {
		return [];
	}
}

/**
 * Name prefix of the scratch directories `omp gc --compress` creates beside
 * the files it copies on APFS. Their `.jsonl` files are transient copies of
 * transcripts, never transcripts of their own; a killed run can leave one
 * behind until the next `omp gc --compress --apply` removes it.
 */
export const COMPRESS_SCRATCH_PREFIX = ".omp-gc-compress-";

/** Whether `relativePath` (from any ancestor directory) lies inside a compress scratch directory. */
export function isCompressScratchPath(relativePath: string): boolean {
	return relativePath.split(/[\\/]/).some(part => part.startsWith(COMPRESS_SCRATCH_PREFIX));
}

/**
 * List all session files in a folder, excluding copies inside
 * `omp gc --compress` scratch directories.
 */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries
			.filter(
				e =>
					e.isFile() &&
					e.name.endsWith(".jsonl") &&
					!isCompressScratchPath(path.relative(folderPath, e.parentPath)),
			)
			.map(e => path.join(e.parentPath, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files across all folders.
 */
export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	return (await Promise.all(folders.map(listSessionFiles))).flat();
}

/**
 * Find a specific entry in a session file, carrying the fields its `entry_patch` records set. A record
 * is no entry of the session: asked for a record's id, this finds nothing.
 */
export async function getSessionEntry(sessionPath: string, entryId: string): Promise<SessionEntry | null> {
	let found: SessionEntry | null = null;
	const held: EntryPatch[] = [];
	try {
		for await (const line of readLines(Bun.file(sessionPath).stream())) {
			// Past the entry, only a record can still change it.
			if (found && entryPatchMarkerAt(line) === -1) continue;
			const entry = parseJsonLine(line, 0, line.length);
			if (!entry) continue;
			if (isEntryPatchRecord(entry)) {
				for (const patch of recordPatches(entry)) if (patch.entryId === entryId) held.push(patch);
			} else if (!found && "id" in entry && entry.id === entryId) {
				found = entry;
			}
		}
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	if (found) patchEntry(found, new Map([[entryId, held]]));
	return found;
}
