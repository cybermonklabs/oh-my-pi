/**
 * Contract: the `entry_patch` record that `SessionManager.patchEntries` appends is one the cold
 * store treats as a patch record: no kind rule keeps it whole, so it goes cold before the cut,
 * where a `custom` entry of any other type stays whole wherever it lies. The writer
 * (`entry-patches.ts`) and the cold store (`cold-entries.ts`) each name the record's `custom` type;
 * this fails when the two names drift apart.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isColdEntry, keptWholeByKind } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("the entry_patch record patchEntries writes, as the cold store reads it", () => {
	let tmp: TempDir;
	let manager: SessionManager;

	beforeEach(() => {
		tmp = TempDir.createSync("@omp-entry-patch-record-kind-");
		manager = SessionManager.create(tmp.join("project"), tmp.join("sessions"), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
	});

	afterEach(async () => {
		await manager.close();
		await tmp.remove();
	});

	it("goes cold before the cut as a patch record, where another custom entry stays whole", async () => {
		// If this regresses, the cold store keeps every patch record whole after a compaction, so the
		// patched bodies an elide pass copied into them (thinking, text, tool-result images) stay in
		// memory for the rest of a long session.
		manager.appendMessage({ role: "user", content: [{ type: "text", text: `u1 ${BODY}` }], timestamp: 1 });
		const patched = manager.appendMessage(assistant(`a1 ${BODY}`));
		await manager.patchEntries([
			{ entryId: patched, message: { content: [{ type: "text", text: `a1 [elided] ${BODY}` }] } },
		]);
		const recordId = manager.getEntries().at(-1)?.id;
		const otherId = manager.appendCustomEntry("extension-state", { note: BODY });
		const keep = manager.appendMessage({ role: "user", content: [{ type: "text", text: "keep" }], timestamp: 3 });
		manager.appendCompaction(`summary ${BODY}`, undefined, keep, 1000);
		manager.appendMessage(assistant("after"));
		manager.buildSessionContext();

		// The record, then the other custom entry, as the cold store holds each once the cut passed them.
		const held = [recordId, otherId].map(id => {
			const entry = id === undefined ? undefined : manager.getEntry(id);
			return entry && { type: entry.type, wholeByKind: keptWholeByKind(entry), cold: isColdEntry(entry) };
		});
		expect(held).toEqual([
			{ type: "custom", wholeByKind: false, cold: true },
			{ type: "custom", wholeByKind: true, cold: false },
		]);
	});
});
