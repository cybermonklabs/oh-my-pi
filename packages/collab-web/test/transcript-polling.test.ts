/**
 * Regression: the host replies to fetch-transcript with a terminal `error`
 * frame (unchanged cursor) for oversized JSONL rows and missing files. The
 * client must surface that error distinctly from a transient failure (null),
 * and the drawer's polling decision must stop on it instead of hot-retrying
 * from the same cursor forever.
 *
 * And: the drawer's poll loop applies a transcript's `entry_patch` records
 * across replies through one replay, and hands the drawer a new row object,
 * with a new `message`, for each entry a record changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EntryPatchReplay } from "@oh-my-pi/pi-utils/entry-patches";
import type { EntryPatchEntry, HostFrame, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { GuestClient, type TranscriptResult } from "../src/lib/client";
import { repaintPatchedRows, type TranscriptLine } from "../src/lib/entry-patch-rows";
import { encodeBase64Url } from "../src/lib/link";
import { decideTranscriptPoll, startTranscriptPolling, type TranscriptPoller } from "../src/lib/transcript-poll";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

function transcriptFrame(reqId: number, text: string, newSize: number, error?: string): HostFrame {
	return { t: "transcript", reqId, text, newSize, error };
}

function messageEntry(id: string, content: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:01Z",
		message: { role: "user", content, timestamp },
	};
}

function contentRecord(id: string, entryId: string, content: string): EntryPatchEntry {
	return {
		type: "custom",
		customType: "entry_patch",
		id,
		parentId: entryId,
		timestamp: "2026-06-12T00:00:02Z",
		data: { patches: [{ entryId, message: { content } }] },
	};
}

function userContent(entry: SessionEntry | undefined): unknown {
	return entry?.type === "message" ? entry.message.content : undefined;
}

/** A call and its result: the transcript shows the result's output in the call's row, paired by its `message`. */
function toolTurn(output: string): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-06-12T00:00:01Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
				model: "test/model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "t1",
			parentId: "a1",
			timestamp: "2026-06-12T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: 2,
			},
		},
	];
}

function outputRecord(id: string, output: string): EntryPatchEntry {
	return {
		type: "custom",
		customType: "entry_patch",
		id,
		parentId: "t1",
		timestamp: "2026-06-12T00:00:02Z",
		data: { patches: [{ entryId: "t1", message: { content: [{ type: "text", text: output }] } }] },
	};
}

/** The tool result each call pairs with, by the transcript's rule: the result row's `message`. */
function pairedResults(rows: readonly SessionEntry[]): Map<string, ToolResultMessage> {
	const results = new Map<string, ToolResultMessage>();
	for (const row of rows) {
		if (row.type === "message" && row.message.role === "toolResult") results.set(row.message.toolCallId, row.message);
	}
	return results;
}

const jsonl = (lines: readonly unknown[]): string => lines.map(line => `${JSON.stringify(line)}\n`).join("");

describe("GuestClient.fetchTranscript", () => {
	it("surfaces a frame-level error as a typed terminal result, not null", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscript("agent-1", 128);
		client.applyFrameForTest(transcriptFrame(1, "", 128, "transcript entry exceeds transcript fetch cap"));
		const result = await promise;
		expect(result).toEqual({ kind: "error", message: "transcript entry exceeds transcript fetch cap" });
	});

	it("resolves rows for a successful reply", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscript("agent-1", 0);
		client.applyFrameForTest(transcriptFrame(1, '{"type":"message"}\n', 19));
		const result = await promise;
		expect(result).toEqual({ kind: "rows", text: '{"type":"message"}\n', newSize: 19 });
	});

	it("resolves null (transient) on timeout — distinct from a terminal error", async () => {
		vi.useFakeTimers();
		try {
			const client = new GuestClient(LINK, "tester");
			const promise = client.fetchTranscript("agent-1", 0);
			vi.advanceTimersByTime(10_000);
			expect(await promise).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves null (transient) when the session ends mid-fetch", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscript("agent-1", 0);
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		expect(await promise).toBeNull();
	});

	it("keeps late replies from resolving a timed-out request with stale data", async () => {
		vi.useFakeTimers();
		try {
			const client = new GuestClient(LINK, "tester");
			const first = client.fetchTranscript("agent-1", 0);
			vi.advanceTimersByTime(10_000);
			expect(await first).toBeNull();
			// Late frame for the expired reqId must not throw or leak.
			client.applyFrameForTest(transcriptFrame(1, "late", 4));
			const second = client.fetchTranscript("agent-1", 0);
			client.applyFrameForTest(transcriptFrame(2, "", 0, "no transcript available"));
			expect(await second).toEqual({ kind: "error", message: "no transcript available" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("decideTranscriptPoll", () => {
	it("retries on transient failure (null) without touching the cursor", () => {
		expect(decideTranscriptPoll(null, "", new EntryPatchReplay<TranscriptLine>())).toEqual({ action: "retry" });
	});

	it("stops on a terminal frame error and carries the message to render", () => {
		const decision = decideTranscriptPoll(
			{ kind: "error", message: "transcript entry exceeds transcript fetch cap (4194304 bytes)" },
			"partial-line",
			new EntryPatchReplay<TranscriptLine>(),
		);
		expect(decision).toEqual({
			action: "stop",
			message: "transcript entry exceeds transcript fetch cap (4194304 bytes)",
		});
	});

	it("advances the cursor and parses complete rows, filtering the session header", () => {
		const entry = messageEntry("m1", "hi", 1);
		const rows = `{"type":"session","id":"s1"}\n${JSON.stringify(entry)}\n`;
		const text = `${rows}{"type":"mes`;
		const decision = decideTranscriptPoll(
			{ kind: "rows", text, newSize: text.length },
			"",
			new EntryPatchReplay<TranscriptLine>(),
		);
		expect(decision).toEqual({
			action: "advance",
			newSize: text.length,
			carry: '{"type":"mes',
			fresh: [entry],
			changed: [],
		});
	});

	it("completes a carried partial line on the next advance", () => {
		const entry = messageEntry("m2", "again", 2);
		const line = `${JSON.stringify(entry)}\n`;
		const splitAt = 12;
		const decision = decideTranscriptPoll(
			{ kind: "rows", text: line.slice(splitAt), newSize: 100 },
			line.slice(0, splitAt),
			new EntryPatchReplay<TranscriptLine>(),
		);
		expect(decision).toEqual({
			action: "advance",
			newSize: 100,
			carry: "",
			fresh: [entry],
			changed: [],
		});
	});

	it("applies a record in a later reply to an entry of an earlier one, and never lists the record", () => {
		const patches = new EntryPatchReplay<TranscriptLine>();
		const first = `${JSON.stringify(messageEntry("m1", "heavy tool output", 1))}\n`;
		const firstDecision = decideTranscriptPoll({ kind: "rows", text: first, newSize: first.length }, "", patches);
		if (firstDecision.action !== "advance") throw new Error("expected the first reply to advance");
		expect(firstDecision.fresh.map(userContent)).toEqual(["heavy tool output"]);

		// Control: the same field written inline in the entry's own line.
		const control = messageEntry("m2", "[elided]", 2);
		const second = `${JSON.stringify(contentRecord("p1", "m1", "[elided]"))}\n${JSON.stringify(control)}\n`;
		const decision = decideTranscriptPoll(
			{ kind: "rows", text: second, newSize: first.length + second.length },
			"",
			patches,
		);
		if (decision.action !== "advance") throw new Error("expected the second reply to advance");
		// The record is not a row; the entry it changed comes back to be shown again.
		expect(decision.fresh).toEqual([control]);
		expect(decision.changed.map(entry => entry.id)).toEqual(["m1"]);

		const rows = [...repaintPatchedRows(firstDecision.fresh, decision.changed), ...decision.fresh];
		expect(rows.map(entry => entry.id)).toEqual(["m1", "m2"]);
		expect(rows.map(userContent)).toEqual(["[elided]", "[elided]"]);
		expect(userContent(rows[0])).toBe(userContent(control));
		// A new object, so the transcript's memoized row paints it again.
		expect(rows[0]).not.toBe(firstDecision.fresh[0]);
	});

	it("holds a record read before its target and applies it when the target arrives", () => {
		const patches = new EntryPatchReplay<TranscriptLine>();
		const first = `${JSON.stringify(contentRecord("p1", "m1", "[elided]"))}\n`;
		const firstDecision = decideTranscriptPoll({ kind: "rows", text: first, newSize: first.length }, "", patches);
		expect(firstDecision).toEqual({ action: "advance", newSize: first.length, carry: "", fresh: [], changed: [] });

		const second = `${JSON.stringify(messageEntry("m1", "heavy tool output", 1))}\n`;
		const decision = decideTranscriptPoll(
			{ kind: "rows", text: second, newSize: first.length + second.length },
			"",
			patches,
		);
		if (decision.action !== "advance") throw new Error("expected the second reply to advance");
		expect(decision.fresh.map(userContent)).toEqual(["[elided]"]);
		expect(decision.changed).toEqual([]);
	});
});

describe("repaintPatchedRows", () => {
	it("gives a tool result a record changed a new message, so the call's row pairs with the new output", () => {
		const replay = new EntryPatchReplay<TranscriptLine>();
		const rows = toolTurn("heavy tool output");
		replay.add(rows);
		const before = pairedResults(rows).get("call-1");
		const shown = repaintPatchedRows(rows, replay.add([outputRecord("p1", "[elided]")]));

		const after = pairedResults(shown).get("call-1");
		expect(after?.content).toEqual([{ type: "text", text: "[elided]" }]);
		// The call's row is memoized on the result it pairs with: only a new object repaints it.
		expect(after).not.toBe(before);
		expect(shown[1]).not.toBe(rows[1]);
		// A row no record changed keeps its object.
		expect(shown[0]).toBe(rows[0]);
	});
});

describe("startTranscriptPolling", () => {
	const INTERVAL_MS = 1_000;

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	interface PollRun {
		/** Each row list the loop handed the drawer, in order. */
		shown: (readonly SessionEntry[])[];
		errors: string[];
		reads: () => number;
		poller: TranscriptPoller;
		/** Let the read in flight settle. */
		settle: () => Promise<void>;
		/** Move the clock one interval on, and let the read that starts settle. */
		tick: () => Promise<void>;
	}

	/**
	 * Start the loop on a transcript the host serves as `replies`, one window
	 * per read (or as `reply` gives it), and let the first read settle. A read
	 * settles once its reply's promise has: the loop's own reaction to it,
	 * registered first, has handled the reply by then.
	 */
	async function startOn(
		replies: readonly string[],
		reply?: (cursor: number) => TranscriptResult | null,
	): Promise<PollRun> {
		const starts: number[] = [];
		let end = 0;
		for (const text of replies) {
			starts.push(end);
			end += Buffer.byteLength(text);
		}
		let reads = 0;
		let lastRead: Promise<TranscriptResult | null> = Promise.resolve(null);
		const shown: (readonly SessionEntry[])[] = [];
		const errors: string[] = [];
		const poller = startTranscriptPolling({
			fetch: cursor => {
				reads++;
				const index = starts.indexOf(cursor);
				const text = index < 0 ? "" : (replies[index] ?? "");
				lastRead = Promise.resolve(
					reply ? reply(cursor) : { kind: "rows", text, newSize: cursor + Buffer.byteLength(text) },
				);
				return lastRead;
			},
			onRows: rows => shown.push(rows),
			onError: message => errors.push(message),
			quiescent: () => true,
			intervalMs: INTERVAL_MS,
			idlePollsBeforeStop: 2,
		});
		await lastRead;
		return {
			shown,
			errors,
			reads: () => reads,
			poller,
			settle: async () => {
				await lastRead;
			},
			tick: async () => {
				vi.advanceTimersByTime(INTERVAL_MS);
				await lastRead;
			},
		};
	}

	/** Every reply read, then the two unchanged reads after which a quiescent agent's loop stops. */
	async function pollAll(replies: readonly string[]): Promise<(readonly SessionEntry[])[]> {
		const run = await startOn(replies);
		for (let read = 1; read < replies.length + 2; read++) await run.tick();
		expect(run.reads()).toBe(replies.length + 2);
		run.poller.dispose();
		expect(run.errors).toEqual([]);
		return run.shown;
	}

	const HEADER = `${JSON.stringify({ type: "session", id: "sub", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" })}\n`;

	it("shows again, as new objects, the rows a record in a later reply changed", async () => {
		const shown = await pollAll([
			HEADER + jsonl(toolTurn("heavy tool output")),
			jsonl([outputRecord("p1", "[elided]"), messageEntry("m2", "after", 3)]),
		]);
		const first = shown[0] ?? [];
		const last = shown.at(-1) ?? [];
		expect(last.map(row => row.id)).toEqual(["a1", "t1", "m2"]);
		expect(pairedResults(last).get("call-1")?.content).toEqual([{ type: "text", text: "[elided]" }]);
		expect(last[1]).not.toBe(first[1]);
		expect(pairedResults(last).get("call-1")).not.toBe(pairedResults(first).get("call-1"));
	});

	it("shows again the rows a record alone in a later reply changed", async () => {
		const shown = await pollAll([
			HEADER + jsonl(toolTurn("heavy tool output")),
			jsonl([outputRecord("p1", "[elided]")]),
		]);
		expect(shown).toHaveLength(2);
		expect(shown[1]?.map(row => row.id)).toEqual(["a1", "t1"]);
		expect(shown[1]?.[1]).not.toBe(shown[0]?.[1]);
		expect(pairedResults(shown[1] ?? []).get("call-1")?.content).toEqual([{ type: "text", text: "[elided]" }]);
	});

	it("applies a record read in an earlier reply when its target arrives in a later one", async () => {
		const shown = await pollAll([
			HEADER + jsonl([outputRecord("p1", "[elided]")]),
			jsonl(toolTurn("heavy tool output")),
		]);
		const last = shown.at(-1) ?? [];
		expect(last.map(row => row.id)).toEqual(["a1", "t1"]);
		expect(pairedResults(last).get("call-1")?.content).toEqual([{ type: "text", text: "[elided]" }]);
	});

	it("stops after unchanged reads of a quiescent agent, and resumes on request", async () => {
		const run = await startOn([HEADER + jsonl([messageEntry("m1", "hi", 1)])]);
		await run.tick();
		await run.tick();
		expect(run.reads()).toBe(3);
		await run.tick();
		expect(run.reads()).toBe(3);
		run.poller.resume();
		await run.settle();
		expect(run.reads()).toBe(4);
		await run.tick();
		expect(run.reads()).toBe(5);
		run.poller.dispose();
		await run.tick();
		expect(run.reads()).toBe(5);
		expect(run.shown.map(rows => rows.map(row => row.id))).toEqual([["m1"]]);
	});

	it("stops on a terminal host error and reports it once", async () => {
		const run = await startOn([], () => ({ kind: "error", message: "no transcript available" }));
		await run.tick();
		run.poller.resume();
		await run.tick();
		run.poller.dispose();
		expect(run.reads()).toBe(1);
		expect(run.errors).toEqual(["no transcript available"]);
	});
});
