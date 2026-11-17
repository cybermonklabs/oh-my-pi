import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage, AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

/** Map tool-call ids to their calls across `entries[start, end)` (later calls win). */
export function collectToolCallsById(
	entries: readonly SessionEntry[],
	start = 0,
	end = entries.length,
): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	for (let i = start; i < end; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

/**
 * Tool calls of a summarized-away prefix `entries[0, length)` by call id: the
 * assistant entry holding each call, and in `resolved` the calls lookups have
 * read from those entries, arguments included.
 */
interface PrefixToolCalls {
	readonly length: number;
	readonly boundary: SessionEntry;
	readonly entryById: Map<string, SessionEntry>;
	readonly resolved: Map<string, AgentToolCall>;
}

/**
 * The latest prefix index by the first entry of its branch. A branch prefix is
 * the path from the root to its boundary, so one index serves every pass while
 * the boundary and the branch stay; a new boundary or another branch replaces
 * it, so an older compaction's index never outlives the next one built for the
 * session.
 */
const prefixToolCalls = new WeakMap<SessionEntry, PrefixToolCalls>();

function prefixToolCallIndex(entries: readonly SessionEntry[], length: number): PrefixToolCalls {
	const first = entries[0];
	const boundary = entries[length];
	const cached = prefixToolCalls.get(first);
	if (cached && cached.length === length && cached.boundary === boundary) return cached;
	const entryById = new Map<string, SessionEntry>();
	for (let i = 0; i < length; i++) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") entryById.set(block.id, entry);
		}
	}
	const index: PrefixToolCalls = { length, boundary, entryById, resolved: new Map() };
	prefixToolCalls.set(first, index);
	return index;
}

function prefixToolCall(index: PrefixToolCalls, id: string): AgentToolCall | undefined {
	const resolved = index.resolved.get(id);
	if (resolved !== undefined) return resolved;
	const entry = index.entryById.get(id);
	if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
	const call = entry.message.content.findLast(
		(block): block is AgentToolCall => block.type === "toolCall" && block.id === id,
	);
	if (call !== undefined) index.resolved.set(id, call);
	return call;
}

/**
 * Resolve the array index of the compaction boundary (`keepBoundaryId`, the
 * `firstKeptEntryId` of the latest compaction). Entries before this index are
 * summarized away by that compaction and never sent, so the prune and shake
 * passes neither walk nor mutate them. Returns 0 when there is no boundary (no
 * compaction → whole branch is sent) or the id is absent from `entries`.
 *
 * A compaction that kept no entry (`firstKeptEntryId: ""`, as an Anthropic
 * native compaction that summarizes everything leaves) keeps nothing before
 * it: the boundary is that compaction, the latest on `entries`, or the entry
 * after the one its native replay covers when turns were appended while it
 * ran. The context the coding agent sends starts there too
 * (`compactionKeptStart`); reading `""` as no boundary would walk, and read the
 * bodies of, the whole branch on every pass.
 */
export function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	if (keepBoundaryId === "") {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "compaction") continue;
			const replayThroughId = entry.providerReplayThroughEntryId;
			const replayThroughIndex = replayThroughId ? entries.findIndex(other => other.id === replayThroughId) : -1;
			return replayThroughIndex >= 0 && replayThroughIndex + 1 < i ? replayThroughIndex + 1 : i;
		}
		return 0;
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].id === keepBoundaryId) return i;
	}
	return 0;
}

/**
 * Tool-call lookup for results in the sent region `entries[start, end)`.
 * Calls there are indexed eagerly; the summarized-away prefix is indexed only
 * on the first miss, once per boundary and branch (see
 * {@link prefixToolCallIndex}), so lookups match a whole-branch scan while
 * repeated passes never walk history the boundary already excludes.
 */
export class SentToolCalls {
	readonly #entries: readonly SessionEntry[];
	readonly #start: number;
	readonly #sent: Map<string, AgentToolCall>;
	#prefix: PrefixToolCalls | undefined;

	constructor(entries: readonly SessionEntry[], start: number) {
		this.#entries = entries;
		this.#start = start;
		this.#sent = collectToolCallsById(entries, start);
	}

	get(id: string): AgentToolCall | undefined {
		const call = this.#sent.get(id);
		if (call !== undefined || this.#start === 0) return call;
		this.#prefix ??= prefixToolCallIndex(this.#entries, this.#start);
		return prefixToolCall(this.#prefix, id);
	}
}

/** Return the tool-result message carried by a session entry, if any. */
export function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

/**
 * Extract the `path` argument from a paired `read` tool call, when the result
 * is a `read` result carrying a string path. Returns `undefined` otherwise.
 * Shared primitive for read-targeted protection matchers (skills, plans, …).
 */
export function getReadToolPath({ toolResult, toolCall }: ProtectedToolContext): string | undefined {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	const path = (toolCall.arguments as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false;
}

const ARTIFACT_INTERNAL_URL_PREFIX = "artifact://";

/** Recovery reads of session artifacts — eliding one only mints another artifact and can repeat indefinitely. */
export function isArtifactRecoveryToolResult(context: ProtectedToolContext): boolean {
	if (getReadToolPath(context)?.startsWith(ARTIFACT_INTERNAL_URL_PREFIX)) return true;
	const meta = (context.toolResult.details as { meta?: { source?: { type?: string; value?: string } } } | undefined)
		?.meta;
	return meta?.source?.type === "internal" && (meta.source.value?.startsWith(ARTIFACT_INTERNAL_URL_PREFIX) ?? false);
}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
