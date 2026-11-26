/**
 * Keeps the position of a session's last `last-turn` transcript retain with the session.
 *
 * Each successful retain appends a custom entry naming the bank scope it wrote to and the
 * id of the last session entry it sent. The next retain sends from the entry after that one,
 * so a session resumed in a new process does not send again what an earlier process sent,
 * and a turn that no user message started (a custom message such as a notification) is not
 * skipped. Entries are read in the session file's order (`getEntries()`), as the transcript
 * is extracted, so the marker is found across a `/clear` reset boundary and in a copy of the
 * file that keeps entry ids (a fork).
 */
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { HindsightMessage } from "./content";
import { type HindsightMessageEntry, messageEntryAt } from "./transcript";

export const HINDSIGHT_RETAIN_ENTRY_TYPE = "hindsight_retain";

interface HindsightRetainEntryData {
	version: 1;
	/** Server, bank and tags the retain wrote to; a marker counts only for the same ones. */
	scope: string;
	/** Id of the last session entry the retain sent. */
	lastEntryId: string;
}

function isHindsightRetainEntryData(data: unknown): data is HindsightRetainEntryData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"lastEntryId" in data &&
		typeof data.lastEntryId === "string"
	);
}

/**
 * Position in `entries` of the last entry an earlier retain to `scope` sent, from the newest
 * marker of `scope` whose entry is still in `entries`. A marker naming an entry the file no
 * longer holds (a branch copy that left it out) gives way to an older one, so the next retain
 * repeats a little rather than skipping anything. -1 when no such marker exists.
 */
export function findRetainedThrough(entries: readonly SessionEntry[], scope: string): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry.type !== "custom" ||
			entry.customType !== HINDSIGHT_RETAIN_ENTRY_TYPE ||
			!isHindsightRetainEntryData(entry.data) ||
			entry.data.scope !== scope
		) {
			continue;
		}
		const lastEntryId = entry.data.lastEntryId;
		const position = entries.findIndex(candidate => candidate.id === lastEntryId);
		if (position !== -1) return position;
	}
	return -1;
}

/** Records that a retain to `scope` sent everything up to and including `lastEntryId`. */
export function persistRetainedThrough(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	scope: string,
	lastEntryId: string,
): void {
	sessionManager.appendCustomEntry(HINDSIGHT_RETAIN_ENTRY_TYPE, {
		version: 1,
		scope,
		lastEntryId,
	} satisfies HindsightRetainEntryData);
}

export interface RetainWindow {
	/** Messages to send, in session order. */
	messages: HindsightMessage[];
	/** Id of the entry of the last message in {@link messages}: the next marker. */
	lastEntryId: string;
}

export interface RetainWindowOptions {
	/** `hindsight.retainEveryNTurns`. */
	everyNTurns: number;
	/** `hindsight.retainOverlapTurns`: user turns sent again from before the first new message. */
	overlapTurns: number;
	/**
	 * `/memory enqueue`: also send the last `everyNTurns + overlapTurns` user turns again, even
	 * when an earlier retain sent them.
	 */
	forced?: boolean;
}

/**
 * The messages the next `last-turn` retain to `scope` sends. With a marker, every message
 * after the entry it names, preceded by `overlapTurns` user turns from before it. Without
 * one, the last `everyNTurns + overlapTurns` user turns, as before markers existed, or the
 * whole session when it holds no more user turns than that, so a session's first retain
 * keeps what came before its first user message. Undefined when there is nothing to send.
 *
 * The messages are read back from the newest entry, no further than the window reaches
 * (without a marker, to one user turn before it, which tells whether the session holds more
 * user turns than the window), so a body the session keeps out of memory is not read back.
 */
export function nextRetainWindow(
	entries: readonly SessionEntry[],
	scope: string,
	options: RetainWindowOptions,
): RetainWindow | undefined {
	const retainedThrough = findRetainedThrough(entries, scope);
	const lastTurns = options.everyNTurns + options.overlapTurns;
	const back = new MessagesFromEnd(entries);
	let size: number;
	if (retainedThrough === -1) {
		if (lastTurns <= 0) return undefined;
		size = back.reachUserTurn(lastTurns + 1) ? back.sizeThroughUserTurn(lastTurns) : back.records.length;
	} else {
		back.readAfter(retainedThrough);
		size = back.records.length;
		if (options.overlapTurns > 0) size = back.sizeThroughUserTurn(back.userTurnsRead + options.overlapTurns);
		if (options.forced && lastTurns > 0) size = Math.max(size, back.sizeThroughUserTurn(lastTurns));
	}
	if (size === 0) return undefined;
	const window = back.records.slice(0, size).reverse();
	return { messages: window.map(record => record.message), lastEntryId: back.records[0]!.entryId };
}

/** A session's messages read back from its newest entry, as far as asked and no further. */
class MessagesFromEnd {
	/** The messages read, newest first. */
	readonly records: HindsightMessageEntry[] = [];
	/** Positions in {@link records} of the user messages, newest first. */
	readonly #userPositions: number[] = [];
	/** Position in `entries` of the next entry to read. */
	#next: number;

	constructor(readonly entries: readonly SessionEntry[]) {
		this.#next = entries.length - 1;
	}

	/** User messages read so far. */
	get userTurnsRead(): number {
		return this.#userPositions.length;
	}

	/** Reads every message after `entries[index]`. */
	readAfter(index: number): void {
		while (this.#next > index) this.#readOne();
	}

	/** Reads back to the `turns`-th user message from the newest; false when the session holds fewer. */
	reachUserTurn(turns: number): boolean {
		while (this.#userPositions.length < turns && this.#next >= 0) this.#readOne();
		return this.#userPositions.length >= turns;
	}

	/**
	 * How many of the newest messages reach back to the `turns`-th user message from the
	 * newest; every message, read back to the session's start, when it holds fewer.
	 */
	sizeThroughUserTurn(turns: number): number {
		return this.reachUserTurn(turns) ? this.#userPositions[turns - 1]! + 1 : this.records.length;
	}

	#readOne(): void {
		const record = messageEntryAt(this.entries, this.#next--);
		if (!record) return;
		if (record.message.role === "user") this.#userPositions.push(this.records.length);
		this.records.push(record);
	}
}
