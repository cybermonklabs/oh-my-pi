import { createSyntheticToolResultMessage, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "../async/job-manager";
import type { SessionEntry } from "./session-entries";

export const TOOL_EXECUTION_START_CUSTOM_TYPE = "tool_execution_start";
export const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

/**
 * Compact projection of tool-call arguments persisted with the start marker.
 * The assistant message already carries the full arguments; this exists only
 * so `appendArgumentSummary` can name the command/path in resume warnings
 * without duplicating whole argument payloads into the session JSONL.
 */
export interface ToolArgumentSummary {
	command?: string;
	path?: string;
}

/** Persisted marker written before a tool implementation starts running. */
export interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
	args?: ToolArgumentSummary;
	intent?: string;
	startedAt: string;
}

/** Tool call left without a matching toolResult at the end of a branch. */
export interface PendingToolCallDiagnostic {
	toolCallId?: string;
	toolName: string;
	args?: unknown;
	intent?: string;
	assistantTimestamp?: number;
	startedAt?: string;
}

/** Session shutdown marker written during normal and fatal process teardown. */
export interface SessionExitData {
	reason: string;
	kind: "normal" | "signal" | "fatal" | "process_exit";
	recordedAt: string;
	pendingToolCalls?: PendingToolCallDiagnostic[];
}

interface PendingToolCallRecord extends PendingToolCallDiagnostic {
	key: string;
}

interface ToolCallContent {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: unknown;
}

export interface AssistantModelMetadata {
	api: AssistantMessage["api"];
	provider: string;
	model: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object") return false;
	return value !== null;
}
function isPendingToolCallDiagnostic(value: unknown): value is PendingToolCallDiagnostic {
	if (!isObject(value) || typeof value.toolName !== "string") return false;
	if ("toolCallId" in value && typeof value.toolCallId !== "string") return false;
	if ("intent" in value && typeof value.intent !== "string") return false;
	if ("assistantTimestamp" in value && typeof value.assistantTimestamp !== "number") return false;
	if ("startedAt" in value && typeof value.startedAt !== "string") return false;
	return true;
}

function readPendingToolCalls(value: unknown): PendingToolCallDiagnostic[] | undefined {
	if (!Array.isArray(value) || !value.every(isPendingToolCallDiagnostic)) return undefined;
	return value;
}

function readSessionExit(entry: SessionEntry): SessionExitData | undefined {
	if (entry.type !== "custom" || entry.customType !== SESSION_EXIT_CUSTOM_TYPE || !isObject(entry.data)) {
		return undefined;
	}
	const { reason, kind, recordedAt } = entry.data;
	if (
		typeof reason !== "string" ||
		(kind !== "normal" && kind !== "signal" && kind !== "fatal" && kind !== "process_exit") ||
		typeof recordedAt !== "string"
	) {
		return undefined;
	}
	return {
		reason,
		kind,
		recordedAt,
		pendingToolCalls: readPendingToolCalls(entry.data.pendingToolCalls),
	};
}

/** Why an interrupted-turn abort record ends a turn its process never finished. */
export const INTERRUPTED_TURN_ERROR = "Previous OMP process exited before completing the turn.";

/** How exit recovery reads a branch whose last process may have died without recording its exit. */
export interface InterruptedTurnOptions {
	/**
	 * The branch's writer is gone even without a `session_exit` after its tail (a
	 * crash, SIGKILL or power loss records none): `omp --restore` says so.
	 */
	assumeExit?: boolean;
}

/** A turn its process left unfinished: the branch's last message and when the process ended. */
interface UnfinishedTurn {
	tail: AgentMessage;
	previousAssistant: AssistantMessage | undefined;
	recordedAt: string;
}

/**
 * The branch's last message and its index, after its last `/clear`
 * (`reset_boundary`): `/clear` ends the conversation before it. Undefined without one.
 */
export function conversationTail(
	entries: readonly SessionEntry[],
): { index: number; message: AgentMessage } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "reset_boundary") return undefined;
		if (entry.type === "message") return { index, message: entry.message };
	}
	return undefined;
}

/**
 * The turn a branch's last process left unfinished: a non-terminal message tail
 * (a prompt or tool results the model never answered, tool calls without results)
 * followed by a process exit, recorded or (with `assumeExit`) assumed. A recorded
 * normal exit with nothing pending, a terminal assistant tail, and tool results that
 * close an aborted or failed turn leave nothing unfinished.
 */
function findUnfinishedTurn(
	entries: readonly SessionEntry[],
	options?: InterruptedTurnOptions,
): UnfinishedTurn | undefined {
	let exitIndex = -1;
	let exit: SessionExitData | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const candidate = readSessionExit(entries[index]!);
		if (!candidate) continue;
		exitIndex = index;
		exit = candidate;
		break;
	}

	// Nothing behind a `/clear` is unfinished.
	const last = conversationTail(entries);
	if (!last) return undefined;
	const { index: tailIndex, message: tail } = last;
	if (!exit || tailIndex > exitIndex) {
		if (!options?.assumeExit) return undefined;
		exit = { reason: "restore", kind: "process_exit", recordedAt: new Date().toISOString() };
	} else if (exit.kind === "normal" && !exit.pendingToolCalls?.length) {
		return undefined;
	}
	if (tail.role === "assistant" && !tail.content.some(isToolCallContent)) return undefined;

	let previousAssistant: AssistantMessage | undefined;
	for (let index = tailIndex; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		previousAssistant = entry.message;
		break;
	}
	if (
		tail.role === "toolResult" &&
		(previousAssistant?.stopReason === "error" || previousAssistant?.stopReason === "aborted")
	) {
		return undefined;
	}
	return { tail, previousAssistant, recordedAt: exit.recordedAt };
}

/** Whether `message` is the record exit recovery closed an unfinished turn with. */
export function isInterruptedTurnAbort(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		message.stopReason === "aborted" &&
		message.errorMessage === INTERRUPTED_TURN_ERROR
	);
}

/**
 * Whether `message` ended its turn because no request could resolve the
 * provider's key (`credentialUnavailable`), even after the turn's retries.
 * Nothing was sent and nobody chose to stop, so the turn stays unfinished. A
 * turn the provider refused or that failed otherwise does not carry the field.
 */
function isCredentialUnavailableTurn(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error" && message.credentialUnavailable === true;
}

/**
 * Whether the branch's last turn ended because no request could resolve its
 * provider's key ({@link isCredentialUnavailableTurn}): its last message, after its
 * last `/clear`, is that marked error.
 */
export function endsOnCredentialUnavailableTurn(entries: readonly SessionEntry[]): boolean {
	const tail = conversationTail(entries);
	return tail !== undefined && isCredentialUnavailableTurn(tail.message);
}

/**
 * Whether `omp --restore` has a turn to go on with on this branch: one its last
 * process left unfinished ({@link findUnfinishedTurn}, the exit assumed), one exit
 * recovery already closed that nothing followed, not even a normal exit, or one
 * that ended because its key could not be resolved, whatever exit followed: a
 * worker exits normally on that turn, and nothing else would resume it. A turn
 * behind a `/clear` is never one: the user ended that conversation. Nor is one
 * the user stopped while it waited to retry: an aborted record follows its
 * failed attempt and ends it.
 */
export function hasRestorableTurn(entries: readonly SessionEntry[]): boolean {
	if (endsOnCredentialUnavailableTurn(entries)) return true;
	let normalExit = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "reset_boundary") return false;
		if (readSessionExit(entry)?.kind === "normal") normalExit = true;
		if (entry.type !== "message") continue;
		if (normalExit) return false;
		if (isInterruptedTurnAbort(entry.message)) return true;
		break;
	}
	return findUnfinishedTurn(entries, { assumeExit: true }) !== undefined;
}

/**
 * createInterruptedTurnAbortMessage returns a terminal assistant record when
 * the latest persisted process exit follows a non-terminal conversation tail
 * ({@link findUnfinishedTurn}; with `assumeExit`, also when no exit was recorded).
 */
export function createInterruptedTurnAbortMessage(
	entries: readonly SessionEntry[],
	fallbackModel?: AssistantModelMetadata,
	options?: InterruptedTurnOptions,
): AssistantMessage | undefined {
	const turn = findUnfinishedTurn(entries, options);
	if (!turn) return undefined;
	const model = turn.previousAssistant ?? fallbackModel;
	if (!model) return undefined;

	const recordedAt = Date.parse(turn.recordedAt);
	return createTurnAbortRecord(model, INTERRUPTED_TURN_ERROR, Number.isFinite(recordedAt) ? recordedAt : Date.now());
}

/**
 * The assistant record that ends a turn as aborted: no content, no usage, written
 * under `model`'s identity, with `errorMessage` saying why the turn ended. Exit
 * recovery closes an interrupted turn with one; a retry the user stops closes its
 * turn with one too.
 */
export function createTurnAbortRecord(
	model: AssistantModelMetadata,
	errorMessage: string,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage,
		timestamp,
	};
}

/**
 * Whether an abort stops a turn or cuts it off (its process is going away), as the
 * reason the session's agent aborts with carries it to what runs under the turn: a
 * sync subagent's run follows its parent's turn.
 */
export type TurnAbortKind = "stop" | "cutOff";

/**
 * The field that marks the platform's own abort reason with its kind
 * ({@link plainTurnAbortReason}). The thread RPC carries an error's own fields,
 * enumerable or not, and rebuilds a `DOMException` named `AbortError` as one, so the
 * marked reason crosses a worker thread with its mark.
 */
const TURN_ABORT_KIND_FIELD = "turnAbortKind";

/**
 * The reason for an abort that gives none of its own: the platform's own abort
 * reason (a `DOMException` named `AbortError`, which every abort label reads as a
 * plain abort), marked with `kind`.
 */
export function plainTurnAbortReason(kind: TurnAbortKind): DOMException {
	const controller = new AbortController();
	controller.abort();
	const reason: DOMException = controller.signal.reason;
	Object.defineProperty(reason, TURN_ABORT_KIND_FIELD, { value: kind, configurable: true });
	return reason;
}

/**
 * The reason the jobs a session owns abort with as it ends, whose kind a subagent of
 * each job reads: a stop or a cut-off marks the platform's own abort reason with it
 * ({@link plainTurnAbortReason}); a shutdown, and an end that names no kind, give the
 * job manager's shutdown reason, which cuts them off, so the task executor parks their
 * subagents and `omp --restore` goes on with them.
 */
export function ownedJobsAbortReason(end: "shutdown" | TurnAbortKind | undefined): unknown {
	return end === "stop" || end === "cutOff" ? plainTurnAbortReason(end) : ASYNC_JOB_MANAGER_SHUTDOWN_REASON;
}

/**
 * The kind of abort a reason gives a turn. The interrupted-turn reason cuts the
 * turn off. Any other reason that carries its own text or identity stops it: other
 * text, a symbol, an error, a plain object. The platform's own abort reason (a
 * `DOMException` named `AbortError`) says its kind when it is marked
 * ({@link plainTurnAbortReason}); unmarked, like no reason at all, it cuts the turn
 * off: nothing tells it apart from a process going away.
 */
export function turnAbortKind(reason: unknown): TurnAbortKind {
	if (typeof reason === "string") return reason === INTERRUPTED_TURN_ERROR ? "cutOff" : "stop";
	if (typeof reason === "symbol") return "stop";
	if (typeof reason !== "object" || reason === null) return "cutOff";
	if (!(reason instanceof DOMException) || reason.name !== "AbortError") return "stop";
	return Reflect.get(reason, TURN_ABORT_KIND_FIELD) === "stop" ? "stop" : "cutOff";
}

/**
 * Whether a persisted process exit follows the branch's last message: the
 * branch's writer is gone, so resume recovery owns its interrupted tail.
 */
export function sessionExitFollowsLastMessage(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "message") return false;
		if (readSessionExit(entry)) return true;
	}
	return false;
}

/** Pairs unresolved calls at the end of an interrupted turn with result messages. */
export function createInterruptedToolResults(
	entries: readonly SessionEntry[],
	context: "process-exit" | "fork" = "process-exit",
): ToolResultMessage[] {
	let tail: AgentMessage | undefined;
	let assistant: AssistantMessage | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		tail ??= entry.message;
		if (entry.message.role === "assistant") {
			assistant = entry.message;
			break;
		}
	}
	if (!assistant || (context !== "fork" && tail?.role !== "assistant" && tail?.role !== "toolResult")) return [];
	const pendingById = new Map<string, PendingToolCallDiagnostic>();
	for (const call of collectPendingToolCalls(entries)) {
		if (call.toolCallId) pendingById.set(call.toolCallId, call);
	}
	const results: ToolResultMessage[] = [];
	for (const call of assistant.content) {
		if (call.type !== "toolCall" || !pendingById.has(call.id)) continue;
		const diagnostic = pendingById.get(call.id);
		if (context === "fork" && assistant.stopReason === "length" && diagnostic?.startedAt === undefined) {
			// A length stop retains its never-executed guard only without
			// persisted evidence that the parent entered tool execution.
			results.push(createSyntheticToolResultMessage(call, "length"));
			continue;
		}
		results.push({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [
				{
					type: "text",
					text:
						context === "fork"
							? "The parent session may still be running this tool; its outcome is unknown."
							: "Previous OMP process exited before this tool returned; its outcome is unknown.",
				},
			],
			isError: true,
			timestamp: Date.now(),
		});
	}
	return results;
}

function isToolCallContent(value: unknown): value is ToolCallContent {
	if (!isObject(value)) return false;
	return value.type === "toolCall" && (typeof value.name === "string" || typeof value.id === "string");
}

/** Character cap for each summarized argument field. */
const ARGUMENT_SUMMARY_MAX_CHARS = 200;

function truncateSummaryField(value: string): string {
	return value.length > ARGUMENT_SUMMARY_MAX_CHARS ? `${value.slice(0, ARGUMENT_SUMMARY_MAX_CHARS)}…` : value;
}

/**
 * Project full tool-call arguments down to the fields the pending-tool-call
 * resume warning actually renders (`command`/`path`), truncated. Returns
 * `undefined` when the arguments carry neither, so callers can omit `args`
 * entirely instead of persisting an empty object.
 */
export function summarizeToolArguments(args: unknown): ToolArgumentSummary | undefined {
	if (!isObject(args)) return undefined;
	const summary: ToolArgumentSummary = {};
	if (typeof args.command === "string" && args.command.length > 0) {
		summary.command = truncateSummaryField(args.command);
	}
	if (typeof args.path === "string" && args.path.length > 0) {
		summary.path = truncateSummaryField(args.path);
	}
	return summary.command !== undefined || summary.path !== undefined ? summary : undefined;
}

function readToolExecutionStart(entry: SessionEntry): ToolExecutionStartData | undefined {
	if (entry.type !== "custom" || entry.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!isObject(data)) return undefined;
	if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return undefined;
	const startedAt = typeof data.startedAt === "string" ? data.startedAt : entry.timestamp;
	const result: ToolExecutionStartData = {
		toolCallId: data.toolCallId,
		toolName: data.toolName,
		startedAt,
	};
	// Legacy sessions persisted full argument objects; project them down.
	if ("args" in data) {
		const args = summarizeToolArguments(data.args);
		if (args) result.args = args;
	}
	if (typeof data.intent === "string") result.intent = data.intent;
	return result;
}

function appendAssistantToolCalls(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCalls: PendingToolCallRecord[] = [];
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (!isToolCallContent(part)) continue;
		const toolName = part.name ?? "unknown";
		const key = part.id ?? `assistant:${message.timestamp ?? "unknown"}:${index}:${toolName}`;
		const record: PendingToolCallRecord = {
			key,
			toolName,
		};
		if (typeof message.timestamp === "number") record.assistantTimestamp = message.timestamp;
		if (part.id) record.toolCallId = part.id;
		if ("arguments" in part) record.args = part.arguments;
		toolCalls.push(record);
	}
	pending.clear();
	for (const toolCall of toolCalls) pending.set(toolCall.key, toolCall);
}

function applyToolExecutionStart(pending: Map<string, PendingToolCallRecord>, marker: ToolExecutionStartData): void {
	const existing = pending.get(marker.toolCallId);
	if (existing) {
		existing.startedAt = marker.startedAt;
		// The assistant message carries the full arguments; the marker only has
		// the command/path projection. Keep the richer copy when present.
		existing.args ??= marker.args;
		if (marker.intent) existing.intent = marker.intent;
		return;
	}
	const record: PendingToolCallRecord = {
		key: marker.toolCallId,
		toolCallId: marker.toolCallId,
		toolName: marker.toolName,
		args: marker.args,
		startedAt: marker.startedAt,
	};
	if (marker.intent) record.intent = marker.intent;
	pending.set(marker.toolCallId, record);
}

function applyMessageEntry(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role === "toolResult") {
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		if (toolCallId) pending.delete(toolCallId);
		return;
	}
	appendAssistantToolCalls(pending, message);
}

/** Finds tool calls left pending at the end of a session branch. */
export function collectPendingToolCalls(entries: readonly SessionEntry[]): PendingToolCallDiagnostic[] {
	const pending = new Map<string, PendingToolCallRecord>();
	for (const entry of entries) {
		if (entry.type === "message") {
			applyMessageEntry(pending, entry.message);
			continue;
		}
		const marker = readToolExecutionStart(entry);
		if (marker) applyToolExecutionStart(pending, marker);
	}
	return [...pending.values()].map(({ key: _key, ...toolCall }) => toolCall);
}

function appendArgumentSummary(parts: string[], args: unknown): void {
	if (!isObject(args)) return;
	const command = args.command;
	if (typeof command === "string" && command.length > 0) {
		parts.push(`command \`${command}\``);
		return;
	}
	const path = args.path;
	if (typeof path === "string" && path.length > 0) parts.push(`path \`${path}\``);
}

function formatPendingToolCall(call: PendingToolCallDiagnostic): string {
	const parts = [call.toolName];
	if (call.toolCallId) parts.push(call.toolCallId);
	appendArgumentSummary(parts, call.args);
	return parts.join(" ");
}

/** Builds the resume warning shown when a prior branch ended mid-tool-call. */
export function describePendingToolCalls(entries: readonly SessionEntry[]): string | undefined {
	const pending = collectPendingToolCalls(entries);
	if (pending.length === 0) return undefined;
	const formatted = pending.map(formatPendingToolCall).join(", ");
	const noun = pending.length === 1 ? "tool call" : "tool calls";
	return `Previous session ended while ${pending.length} ${noun} remained pending: ${formatted}. The prior OMP process exited before recording tool result(s).`;
}
