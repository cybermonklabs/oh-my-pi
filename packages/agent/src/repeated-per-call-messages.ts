import type { Message } from "@oh-my-pi/pi-ai";
import {
	isPerCallContextMessage,
	kPerCallContextMessage,
	type PerCallContextMessageCarrier,
} from "@oh-my-pi/pi-ai/utils/block-symbols";

/**
 * The per-call messages ({@link isPerCallContextMessage}) an Agent's previous main request sent, by position. Prompt
 * caching keeps breakpoints off a per-call message, since it is rebuilt for every request (Anthropic places one at or
 * before the first such message instead). A message rebuilt equal to the one the previous main request had at the
 * same position, such as a context hook's fixed note after the compaction summary, is history to the cache:
 * {@link settle} sends it as an ordinary message, so it no longer takes a rolling breakpoint. A message that changes or
 * moves stays per-call. Only the Agent's own loop settles its requests: side requests, live steering and other Agents
 * never read or change this record.
 */
export class RepeatedPerCallMessages {
	#previous = new Map<number, Message>();
	/** One history copy per repeated message, so a message the append-only log keeps goes out as the same object. */
	#asHistory = new WeakMap<Message, Message>();

	/** `messages`, with each per-call message equal to the previous main request's at its position sent as history. */
	settle(messages: Message[]): Message[] {
		const current = new Map<number, Message>();
		let settled: Message[] | undefined;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (!isPerCallContextMessage(message)) continue;
			current.set(index, message);
			const previous = this.#previous.get(index);
			if (previous === undefined || (previous !== message && !Bun.deepEquals(previous, message))) continue;
			let history = this.#asHistory.get(message);
			if (!history) {
				history = { ...message };
				delete (history as PerCallContextMessageCarrier)[kPerCallContextMessage];
				this.#asHistory.set(message, history);
			}
			settled ??= messages.slice();
			settled[index] = history;
		}
		this.#previous = current;
		return settled ?? messages;
	}
}
