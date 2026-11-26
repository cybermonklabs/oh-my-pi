/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * These `{role, content, timestamp}` records are our internal conversation
 * shape. The Hindsight retain API ultimately receives a serialized transcript
 * string, so we drop tool calls, tool results, bash execution wrappers, custom
 * messages, and anything else that isn't a primary conversation turn. Each
 * surviving message's `TextContent` parts are joined with newlines. The
 * SessionEntry timestamp is preserved on the internal record as the source
 * event time.
 */

import { messageEstimateVersion } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type SessionEntry, type SessionHeader, TAN_FORK_BOUNDARY_CUSTOM_TYPE } from "../session/session-entries";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

/** Finds the first retainable entry, skipping the transcript copied into this `/tan` fork. */
export function retentionStart(entries: readonly SessionEntry[], header?: SessionHeader | null): number {
	if (!header?.parentSession) return 0;
	return (
		entries.findLastIndex(
			entry =>
				entry.type === "custom" && entry.customType === TAN_FORK_BOUNDARY_CUSTOM_TYPE && entry.data === header.id,
		) + 1
	);
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. — they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function extractMessages(entries: readonly SessionEntry[], start = 0): HindsightMessage[] {
	const messages: HindsightMessage[] = [];
	for (let i = start; i < entries.length; i++) {
		const message = toHindsightMessage(entries[i]!);
		if (message) messages.push(message);
	}
	return messages;
}

/**
 * `sliceLastTurnsByUserBoundary(extractMessages(entries, start), turns)`, read
 * from the newest entry back to the `turns`-th last user turn, so the entries
 * before that turn are not read.
 */
export function extractLastTurns(entries: readonly SessionEntry[], turns: number, start = 0): HindsightMessage[] {
	if (turns <= 0) return [];
	const messages: HindsightMessage[] = [];
	let userTurns = 0;
	for (let i = entries.length - 1; i >= start && userTurns < turns; i--) {
		const message = toHindsightMessage(entries[i]!);
		if (!message) continue;
		messages.push(message);
		if (message.role === "user") userTurns++;
	}
	return messages.reverse();
}

function toHindsightMessage(entry: SessionEntry): HindsightMessage | undefined {
	if (entry.type !== "message") return undefined;
	const msg = entry.message;
	const role = msg.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
	if (!hasSubstantiveContent(text)) return undefined;
	return { role, content: text, timestamp: entry.timestamp };
}

/**
 * Whether each user message counts as a turn, with the message's estimate
 * version when it was judged: every in-place rewrite of a message (image
 * stripping, an elided block) bumps that version, so only a rewritten message
 * is read again. A message whose body was moved out of memory would
 * otherwise be read back on every count.
 */
const userTurnVerdicts = new WeakMap<object, { version: number; counts: boolean }>();

/**
 * Count user turns exactly as `extractMessages(entries, start).filter(m => m.role === "user").length`,
 * without extracting assistant text or allocating the message list. Each user
 * message's text is read once per rewrite; later counts reuse its verdict.
 */
export function countUserTurns(entries: readonly SessionEntry[], start = 0): number {
	let count = 0;
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const message = entry.message;
		const version = messageEstimateVersion(message);
		let verdict = userTurnVerdicts.get(message);
		if (verdict?.version !== version) {
			verdict = { version, counts: hasSubstantiveContent(extractUserText(message)) };
			userTurnVerdicts.set(message, verdict);
		}
		if (verdict.counts) count++;
	}
	return count;
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}
