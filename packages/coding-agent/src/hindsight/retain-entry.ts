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
import { extractMessageEntries } from "./transcript";

export const HINDSIGHT_RETAIN_ENTRY_TYPE = "hindsight_retain";

interface HindsightRetainEntryData {
	version: 1;
	/** Server, account, bank and tags the retain wrote to; a marker counts only for the same ones. */
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
 */
export function nextRetainWindow(
	entries: readonly SessionEntry[],
	scope: string,
	options: RetainWindowOptions,
): RetainWindow | undefined {
	const records = extractMessageEntries(entries);
	if (records.length === 0) return undefined;
	const retainedThrough = findRetainedThrough(entries, scope);
	const lastTurnsStart = startOfLastUserTurns(records, options.everyNTurns + options.overlapTurns, records.length);
	let start: number;
	if (retainedThrough === -1) {
		const firstUser = records.findIndex(record => record.message.role === "user");
		start = lastTurnsStart <= firstUser ? 0 : lastTurnsStart;
	} else {
		let firstNew = records.findIndex(record => record.index > retainedThrough);
		if (firstNew === -1) firstNew = records.length;
		start = startOfLastUserTurns(records, options.overlapTurns, firstNew);
		if (options.forced) start = Math.min(start, lastTurnsStart);
	}
	if (start >= records.length) return undefined;
	return {
		messages: records.slice(start).map(record => record.message),
		lastEntryId: records[records.length - 1].entryId,
	};
}

/**
 * Index of the `turns`-th user message counted back from just before `end`, or 0 when fewer
 * user messages precede `end`; `end` itself when `turns` is 0.
 */
function startOfLastUserTurns(records: readonly { message: HindsightMessage }[], turns: number, end: number): number {
	if (turns <= 0) return end;
	let seen = 0;
	for (let index = end - 1; index >= 0; index--) {
		if (records[index].message.role === "user" && ++seen === turns) return index;
	}
	return 0;
}
