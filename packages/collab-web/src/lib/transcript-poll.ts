/**
 * The AgentDrawer's incremental transcript reads: the poll loop and its
 * per-reply decision.
 *
 * Mirrors the TUI guest's contract (agent-transcript-viewer): a `null` reply
 * (timeout / session end) is transient and retryable from the same cursor; a
 * frame-level host `error` is terminal — the host replies with an unchanged
 * cursor, so retrying would loop hot without ever surfacing the failure.
 *
 * Each reply is one window of the transcript (at most a few MiB of whole
 * lines). Its `entry_patch` records apply through the loop's one
 * {@link EntryPatchReplay}, which holds every entry read so far: a record set
 * on a target from an earlier reply comes back in `changed`, so the drawer
 * shows that entry again, and a record read before its target applies when
 * the target arrives. A record is never a row.
 */

import { EntryPatchReplay } from "@oh-my-pi/pi-utils/entry-patches";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TranscriptResult } from "./client";
import { isShownEntry, repaintPatchedRows, type TranscriptLine } from "./entry-patch-rows";
import { parseJsonl } from "./jsonl";

/** What one transcript poll round decided (the drawer's effect executes it). */
export type TranscriptPollDecision =
	/** Transient failure (timeout / not yet available): keep the cursor, poll again. */
	| { action: "retry" }
	/** Terminal host error: stop polling and surface the message (prior rows stay). */
	| { action: "stop"; message: string }
	/**
	 * Rows read: advance the cursor, append the parsed entries, and show again
	 * the entries of earlier replies that this reply's records changed.
	 */
	| {
			action: "advance";
			newSize: number;
			carry: string;
			fresh: readonly SessionEntry[];
			changed: readonly TranscriptLine[];
	  };

/**
 * Maps one {@link TranscriptResult} reply to a polling decision. Rows read go
 * through `patches`, the loop's replay of this transcript's records.
 */
export function decideTranscriptPoll(
	reply: TranscriptResult | null,
	carry: string,
	patches: EntryPatchReplay<TranscriptLine>,
): TranscriptPollDecision {
	if (reply === null) return { action: "retry" };
	if (reply.kind === "error") return { action: "stop", message: reply.message };
	const parsed = parseJsonl(reply.text, carry);
	const lines: TranscriptLine[] = [];
	for (const item of parsed.items) {
		if (typeof item !== "object" || item === null) continue;
		if ("type" in item && item.type === "session") continue;
		lines.push(item as TranscriptLine);
	}
	const changed = patches.add(lines);
	return {
		action: "advance",
		newSize: reply.newSize,
		carry: parsed.carry,
		fresh: lines.filter(isShownEntry),
		changed,
	};
}

/** What the poll loop reads from and reports to (the AgentDrawer's effect). */
export interface TranscriptPollOptions {
	/** One read of the transcript from byte `cursor` on. */
	fetch(cursor: number): Promise<TranscriptResult | null>;
	/** Every row read so far, with the fields its records set; a row a record changed is a new object. */
	onRows(rows: readonly SessionEntry[]): void;
	/** A terminal host error: the loop has stopped. */
	onError(message: string): void;
	/** Whether the agent is not running; only then do unchanged polls count towards stopping. */
	quiescent(): boolean;
	intervalMs: number;
	/** Unchanged polls of a quiescent agent, with no partial line pending, before the loop stops. */
	idlePollsBeforeStop: number;
}

export interface TranscriptPoller {
	/** Start a loop that stopped idle again; a no-op while it runs, after an error, and after `dispose`. */
	resume(): void;
	/** Stop for good; a reply still in flight is dropped. */
	dispose(): void;
}

/** Poll the transcript now and every `intervalMs`, until idle, a terminal error, or `dispose`. */
export function startTranscriptPolling(options: TranscriptPollOptions): TranscriptPoller {
	let disposed = false;
	let failed = false;
	let inFlight = false;
	let cursor = 0;
	let carry = "";
	let rows: readonly SessionEntry[] = [];
	const patches = new EntryPatchReplay<TranscriptLine>();
	let idlePolls = 0;
	let timer: Timer | null = null;
	const stop = (): void => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
	const poll = async (): Promise<void> => {
		if (disposed || failed || inFlight) return;
		inFlight = true;
		try {
			const reply = await options.fetch(cursor);
			if (disposed) return;
			const decision = decideTranscriptPoll(reply, carry, patches);
			switch (decision.action) {
				case "retry":
					return; // timeout/transient → keep polling from the same cursor
				case "stop":
					failed = true;
					stop();
					options.onError(decision.message);
					return;
				case "advance": {
					const grew = decision.newSize !== cursor;
					cursor = decision.newSize;
					carry = decision.carry;
					if (decision.fresh.length > 0 || decision.changed.length > 0) {
						const shown = decision.changed.length > 0 ? repaintPatchedRows(rows, decision.changed) : rows;
						rows = [...shown, ...decision.fresh];
						options.onRows(rows);
					}
					idlePolls = grew || !options.quiescent() ? 0 : idlePolls + 1;
					if (carry === "" && idlePolls >= options.idlePollsBeforeStop) stop();
					return;
				}
			}
		} finally {
			inFlight = false;
		}
	};
	const start = (): void => {
		idlePolls = 0;
		void poll();
		timer = setInterval(() => {
			void poll();
		}, options.intervalMs);
	};
	start();
	return {
		resume: () => {
			if (!disposed && !failed && timer === null) start();
		},
		dispose: () => {
			disposed = true;
			stop();
		},
	};
}
