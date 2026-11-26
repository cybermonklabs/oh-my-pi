/**
 * A `last-turn` retain reads its window back from the session's newest entry, no further than
 * the window reaches, so an older body the session keeps out of memory is not read back in.
 * Over many generated sessions it sends what the window read forward over every entry sends,
 * and reads no message before the window (without a marker, before the user turn ahead of it).
 */
import { describe, expect, it } from "bun:test";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import {
	findRetainedThrough,
	HINDSIGHT_RETAIN_ENTRY_TYPE,
	nextRetainWindow,
	type RetainWindowOptions,
} from "@oh-my-pi/pi-coding-agent/hindsight/retain-entry";
import { messageEntryAt } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const SCOPE = "scope-a";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

interface ForwardRecord {
	entryId: string;
	index: number;
	message: HindsightMessage;
}

/**
 * Index of the `turns`-th user message counted back from just before `end`, or 0 when fewer
 * user messages precede `end`; `end` itself when `turns` is 0.
 */
function startOfLastUserTurns(records: readonly ForwardRecord[], turns: number, end: number): number {
	if (turns <= 0) return end;
	let seen = 0;
	for (let index = end - 1; index >= 0; index--) {
		if (records[index]!.message.role === "user" && ++seen === turns) return index;
	}
	return 0;
}

/** The window read forward over every entry, as the retain marker first computed it: the reference. */
function forwardWindow(entries: readonly SessionEntry[], options: RetainWindowOptions) {
	const records: ForwardRecord[] = [];
	for (let index = 0; index < entries.length; index++) {
		const record = messageEntryAt(entries, index);
		if (record) records.push({ ...record, index });
	}
	if (records.length === 0) return undefined;
	const retainedThrough = findRetainedThrough(entries, SCOPE);
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
	return { records, start };
}

/** A deterministic generator (mulberry32), so a failing case is the same on every run. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A generated message: a user question, a user message of blanks, an answer with and without text, a tool result. */
function generatedMessage(roll: number, index: number): Record<string, unknown> {
	if (roll < 0.45) return { role: "user", content: `question ${index}`, timestamp: index };
	if (roll < 0.52) return { role: "user", content: "   ", timestamp: index };
	if (roll < 0.9) return { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], timestamp: index };
	if (roll < 0.95) return { role: "assistant", content: [], timestamp: index };
	return { role: "toolResult", content: [], timestamp: index };
}

/**
 * A session of `length` entries: user and assistant messages with and without text, tool
 * results, other custom entries, compactions, and retain markers of this scope and another,
 * each naming an earlier entry or one the file no longer holds. Each read of a message entry's
 * body records its index in `reads`.
 */
function generateSession(next: () => number, length: number, reads: number[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let index = 0; index < length; index++) {
		const id = `e${index}`;
		const parentId = index === 0 ? null : `e${index - 1}`;
		const kind = next();
		if (kind < 0.55) {
			const message = generatedMessage(next(), index);
			const entry = { type: "message", id, parentId, timestamp: TIMESTAMP } as Record<string, unknown>;
			Object.defineProperty(entry, "message", {
				enumerable: true,
				get() {
					reads.push(index);
					return message;
				},
			});
			entries.push(entry as unknown as SessionEntry);
		} else if (kind < 0.8 && index > 0) {
			const lastEntryId = next() < 0.1 ? `gone-${index}` : `e${Math.floor(next() * index)}`;
			entries.push({
				type: "custom",
				id,
				parentId,
				timestamp: TIMESTAMP,
				customType: HINDSIGHT_RETAIN_ENTRY_TYPE,
				data: { version: 1, scope: next() < 0.75 ? SCOPE : "scope-b", lastEntryId },
			} as unknown as SessionEntry);
		} else if (kind < 0.9) {
			entries.push({
				type: "custom",
				id,
				parentId,
				timestamp: TIMESTAMP,
				customType: "other",
				data: {},
			} as unknown as SessionEntry);
		} else {
			entries.push({
				type: "compaction",
				id,
				parentId,
				timestamp: TIMESTAMP,
				summary: "summary",
				firstKeptEntryId: id,
				tokensBefore: 0,
			} as unknown as SessionEntry);
		}
	}
	return entries;
}

describe("Hindsight last-turn retain window read back from the newest entry", () => {
	it("sends what the forward reading sends, reading no message before the window", () => {
		const next = random(0x239);
		let defined = 0;
		let bounded = 0;
		for (let run = 0; run < 4000; run++) {
			const reads: number[] = [];
			const entries = generateSession(next, Math.floor(next() * 16), reads);
			const options: RetainWindowOptions = {
				everyNTurns: Math.floor(next() * 4),
				overlapTurns: Math.floor(next() * 3),
				forced: next() < 0.3,
			};
			const label = JSON.stringify({ run, options, entries });
			// The label read every body; count only what the window reads.
			reads.length = 0;
			const window = nextRetainWindow(entries, SCOPE, options);
			const windowReads = reads.splice(0);
			const reference = forwardWindow(entries, options);
			if (!reference) {
				expect(window, label).toBeUndefined();
				const retainedThrough = findRetainedThrough(entries, SCOPE);
				if (retainedThrough === -1 && options.everyNTurns + options.overlapTurns <= 0) {
					expect(windowReads, label).toEqual([]);
				} else if (retainedThrough !== -1 && options.overlapTurns <= 0 && !options.forced) {
					expect(Math.min(...windowReads), label).toBeGreaterThan(retainedThrough);
				}
				continue;
			}
			defined++;
			expect(window, label).toEqual({
				messages: reference.records.slice(reference.start).map(record => record.message),
				lastEntryId: reference.records.at(-1)!.entryId,
			});
			if (reference.start === 0) continue;
			// The window reaches back to its first message; without a marker, to the user turn ahead of it.
			const retainedThrough = findRetainedThrough(entries, SCOPE);
			const first = reference.records[reference.start]!;
			const bound =
				retainedThrough === -1
					? reference.records.findLast(
							(record, position) => position < reference.start && record.message.role === "user",
						)!.index
					: Math.min(first.index, retainedThrough + 1);
			expect(Math.min(...windowReads), label).toBeGreaterThanOrEqual(bound);
			bounded++;
		}
		// The generated cases cover windows of every kind, so the comparisons above ran.
		expect(defined).toBeGreaterThan(1000);
		expect(bounded).toBeGreaterThan(300);
	});
});
