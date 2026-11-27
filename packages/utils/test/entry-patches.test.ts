import { describe, expect, it } from "bun:test";
import { applyEntryPatches, EntryPatchReplay, type EntryPatchSkip } from "@oh-my-pi/pi-utils/entry-patches";

interface Entry {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; content: unknown };
}

function user(id: string, text: string): Entry {
	return { type: "message", id, message: { role: "user", content: text } };
}

function record(id: string, entryId: string, text: string): Entry {
	return {
		type: "custom",
		id,
		customType: "entry_patch",
		data: { patches: [{ entryId, message: { content: text } }] },
	};
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
		const result: Entry = {
			type: "message",
			id: "t1",
			message: { role: "toolResult", content: [{ type: "text", text: "kept" }] },
		};
		const skips: EntryPatchSkip[] = [];
		applyEntryPatches([result, record("p1", "t1", "a string")], { onSkip: skip => skips.push(skip) });
		expect({ skips, content: contentOf(result) }).toEqual({
			skips: [{ reason: "misfit", recordId: "p1", entryId: "t1" }],
			content: [{ type: "text", text: "kept" }],
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
