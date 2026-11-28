import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { applyEntryPatches, EntryPatchReplay, type EntryPatchSkip } from "@oh-my-pi/pi-utils/entry-patches";

interface Entry {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	tokensAfter?: number;
	message?: { role: string; content: unknown; prunedAt?: number; elidedOutputTokens?: number };
}

function user(id: string, text: string): Entry {
	return { type: "message", id, message: { role: "user", content: text } };
}

function toolResult(id: string, text: string): Entry {
	return { type: "message", id, message: { role: "toolResult", content: [{ type: "text", text }] } };
}

function recordOf(id: string, patches: unknown[]): Entry {
	return { type: "custom", id, customType: "entry_patch", data: { patches } };
}

function record(id: string, entryId: string, text: string): Entry {
	return recordOf(id, [{ entryId, message: { content: text } }]);
}

function contentOf(entry: Entry | undefined): unknown {
	return entry?.message?.content;
}

describe("applyEntryPatches", () => {
	// A reader that applied records out of file order would show an older elision than the session holds.
	it("sets each field to the value of the last record in file order, a record before its target included", () => {
		const target = user("u1", "original");
		const entries = [
			record("p0", "u1", "before the target"),
			target,
			record("p1", "u1", "first"),
			record("p2", "u1", "last"),
		];
		expect({ changed: applyEntryPatches(entries), content: contentOf(target) }).toEqual({
			changed: true,
			content: "last",
		});
	});

	// A tool result's content is a list of blocks: a string there makes every later request throw.
	it("reports and skips a patch whose content does not fit its target's role", () => {
		const result = toolResult("t1", "kept");
		const skips: EntryPatchSkip[] = [];
		applyEntryPatches([result, record("p1", "t1", "a string")], { onSkip: skip => skips.push(skip) });
		expect({ skips, content: contentOf(result) }).toEqual({
			skips: [{ reason: "misfit", recordId: "p1", entryId: "t1" }],
			content: [{ type: "text", text: "kept" }],
		});
	});

	// A damaged record must not leave a block without its payload, which every provider request built from it
	// rejects, or a counter that is not a number the session sums. Each case breaks one rule.
	const MALFORMED: ReadonlyArray<{ rule: string; target: () => Entry; patch: object }> = [
		{
			rule: "a text block without text",
			target: () => toolResult("t1", "kept"),
			patch: { entryId: "t1", message: { content: [{ type: "text" }] } },
		},
		{
			rule: "an image block without data",
			target: () => toolResult("t1", "kept"),
			patch: { entryId: "t1", message: { content: [{ type: "image", mimeType: "image/png" }] } },
		},
		{
			rule: "an infinite prunedAt",
			target: () => toolResult("t1", "kept"),
			patch: { entryId: "t1", message: { prunedAt: Number.POSITIVE_INFINITY } },
		},
		{
			rule: "a NaN elidedOutputTokens",
			target: () => ({ type: "message", id: "a1", message: { role: "assistant", content: [] } }),
			patch: { entryId: "a1", message: { elidedOutputTokens: Number.NaN } },
		},
		{
			rule: "an infinite tokensAfter",
			target: () => ({ type: "compaction", id: "c1", tokensAfter: 80_000 }),
			patch: { entryId: "c1", entry: { tokensAfter: Number.POSITIVE_INFINITY } },
		},
	];
	for (const { rule, target, patch } of MALFORMED) {
		it(`skips as malformed a record with ${rule}`, () => {
			const entry = target();
			const skips: EntryPatchSkip[] = [];
			const changed = applyEntryPatches([entry, recordOf("p1", [patch])], { onSkip: skip => skips.push(skip) });
			expect({ changed, skips, entry }).toEqual({
				changed: false,
				skips: [{ reason: "malformed", recordId: "p1" }],
				entry: target(),
			});
		});
	}

	// Control: a well-formed record of the same fields applies.
	it("applies a record with text and image blocks that carry their payload and finite counters", () => {
		const result = toolResult("t1", "kept");
		const compaction: Entry = { type: "compaction", id: "c1", tokensAfter: 80_000 };
		applyEntryPatches([
			result,
			compaction,
			recordOf("p1", [
				{
					entryId: "t1",
					message: {
						content: [
							{ type: "text", text: "elided" },
							{ type: "image", data: "iVBORw0K", mimeType: "image/png" },
						],
						prunedAt: 5,
					},
				},
				{ entryId: "c1", entry: { tokensAfter: 20_000 } },
			]),
		]);
		expect({ result, compaction }).toEqual({
			result: {
				type: "message",
				id: "t1",
				message: {
					role: "toolResult",
					content: [
						{ type: "text", text: "elided" },
						{ type: "image", data: "iVBORw0K", mimeType: "image/png" },
					],
					prunedAt: 5,
				},
			},
			compaction: { type: "compaction", id: "c1", tokensAfter: 20_000 },
		});
	});
});

describe("EntryPatchReplay", () => {
	// A viewer that reads a long transcript in windows shows the heavy text an elide pass removed
	// unless a record in a later window reaches the entry it rendered from an earlier one.
	it("applies a record to a target from an earlier window and returns that target", () => {
		const replay = new EntryPatchReplay<Entry>();
		const target = user("u1", "original");
		const first = replay.add([target]);
		const second = replay.add([user("u2", "next"), record("p1", "u1", "elided")]);
		expect({ first, second: second.map(entry => entry.id), content: contentOf(target) }).toEqual({
			first: [],
			second: ["u1"],
			content: "elided",
		});
	});

	// Windows read from the end of a transcript bring a record before its target, and the newer record first.
	it("holds a record until its target arrives, and keeps the later record's value whatever order the windows come in", () => {
		const replay = new EntryPatchReplay<Entry>();
		replay.add([record("p2", "u1", "later in the file")], 300);
		replay.add([record("p1", "u1", "earlier in the file")], 200);
		const target = user("u1", "original");
		replay.add([target], 0);
		expect(contentOf(target)).toBe("later in the file");
	});

	// After a rewrite the reader starts again from byte 0; a cleared replay must not patch the new body from the old.
	it("forgets every entry and waiting patch on clear", () => {
		const replay = new EntryPatchReplay<Entry>();
		replay.add([record("p1", "u1", "stale")], 100);
		replay.clear();
		const target = user("u1", "fresh body");
		replay.add([target], 0);
		expect(contentOf(target)).toBe("fresh body");
	});
});

/**
 * A transcript whose two messages share an id, with a record for that id between them, and the text each
 * message reads; every reader of a session file reads it (the stats parser, the Python sync).
 */
const DUPLICATE_ID_FIXTURE = path.join(
	import.meta.dir,
	"../../../crates/pi-natives/fixtures/entry-patch-duplicate-id.json",
);

/** The text of each message among `entries`, whose content the fixture writes as text blocks. */
function messageTexts(entries: readonly Entry[]): string[] {
	return entries.flatMap(entry =>
		entry.message ? [(entry.message.content as { text: string }[]).map(block => block.text).join("")] : [],
	);
}

describe("entries that share an id", () => {
	// Whole-file readers set a record's fields on the last entry with its id. A reader of windows that left the
	// earlier entry patched once the later arrived would show text the session never held there.
	it("a record sets its fields on the last entry with its id, read whole or in windows in either order", async () => {
		const { lines, reads }: { lines: Entry[]; reads: string[] } = await Bun.file(DUPLICATE_ID_FIXTURE).json();
		const whole = structuredClone(lines);
		applyEntryPatches(whole);

		const forward = structuredClone(lines);
		const replay = new EntryPatchReplay<Entry>();
		replay.add(forward.slice(0, 2));
		// Until the later entry arrives, the earlier is the last read with the id.
		const patched = replay.add(forward.slice(2, 3));
		const patchedText = messageTexts([forward[1]!]);
		const restored = replay.add(forward.slice(3));

		const backward = structuredClone(lines);
		const fromEnd = new EntryPatchReplay<Entry>();
		fromEnd.add(backward.slice(3), 300);
		fromEnd.add(backward.slice(2, 3), 200);
		fromEnd.add(backward.slice(0, 2), 0);

		expect({
			whole: messageTexts(whole),
			forward: messageTexts(forward),
			backward: messageTexts(backward),
			patchedText,
			// Each call returns the earlier entry it changed, so the reader shows it again.
			returned: [...patched, ...restored].map(entry => forward.indexOf(entry)),
			held: replay.get("u1") === forward[3] && fromEnd.get("u1") === backward[3],
		}).toEqual({
			whole: reads,
			forward: reads,
			backward: reads,
			patchedText: [reads[1]],
			returned: [1, 1],
			held: true,
		});
	});

	// A reader that reads a line again holds a new object for it. The earlier line read again is still not the last
	// line with the id, so it must not take the record from the later one; the later line read again keeps it.
	it("tells a line read again from a later line with its id", async () => {
		const { lines, reads }: { lines: Entry[]; reads: string[] } = await Bun.file(DUPLICATE_ID_FIXTURE).json();
		const entries = structuredClone(lines);
		const replay = new EntryPatchReplay<Entry>();
		for (const window of [entries.slice(0, 2), entries.slice(2, 3), entries.slice(3)]) replay.add(window);
		const firstAgain = structuredClone(lines[1]!);
		const afterFirst = replay.add([firstAgain]);
		const secondAgain = structuredClone(lines[3]!);
		const afterSecond = replay.add([secondAgain]);
		expect({
			firstAgain: messageTexts([firstAgain]),
			secondAgain: messageTexts([secondAgain]),
			// The first read of the later line no longer carries the record; the reader shows it again.
			returned: { afterFirst: afterFirst.length, afterSecond: afterSecond.map(entry => entries.indexOf(entry)) },
			held: replay.get("u1") === secondAgain,
		}).toEqual({
			firstAgain: [reads[0]],
			secondAgain: [reads[1]],
			returned: { afterFirst: 0, afterSecond: [3] },
			held: true,
		});
	});
});
