/**
 * The pause after a failed automatic Hindsight recall (`hindsight.recallCooldownMs`).
 *
 * While the server cannot answer, every prompt would otherwise wait out the recall
 * timeout again. After a failure no automatic recall runs until the wait ends: the
 * first wait is `recallCooldownMs`, each further consecutive failure doubles it, up to
 * 16 times the first; `0` or less turns the pause off. The record lives in the
 * transcript, so a session resumed in a new process waits out the same pause.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";
import { findRecallFailure, persistRecallFailure, type RecallFailure } from "../memory-backend/recall-entry";
import type { SessionManager } from "../session/session-manager";

/** The longest wait, as a multiple of the first. */
const MAX_WAIT_MULTIPLE = 16;

/** Latest epoch ms a date can hold; a later retry cannot be represented, and such a pause never ends anyway. */
const MAX_DATE_MS = 8.64e15;

/** Where a failure record is read from and appended to. */
export interface RecallFailureTranscript {
	sessionManager: Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	/** Recall scope the record belongs to. */
	scope: string;
}

/** An automatic recall the pause holds off. */
export interface RecallSkip {
	failure: RecallFailure;
	/** When automatic recall may run again, epoch ms. */
	retryAt: number;
	/** First skip of this failure in this process: announce it. */
	first: boolean;
}

/** When automatic recall may run again after `failure`, epoch ms. */
function retryAtAfter(failure: RecallFailure, cooldownMs: number): number {
	return Math.min(failure.at + cooldownMs * Math.min(2 ** (failure.failures - 1), MAX_WAIT_MULTIPLE), MAX_DATE_MS);
}

/** Whether `failure`'s wait still runs at `now`; a clock set back before `failure.at` ends it. */
function isWaiting(failure: RecallFailure, cooldownMs: number, now: number): boolean {
	if (failure.failures <= 0) return false;
	return now >= failure.at && now < retryAtAfter(failure, cooldownMs);
}

/**
 * The record after an automatic recall failed at `now`: `previous` unchanged while its wait
 * still runs (the recall was in flight when another failed), else one more consecutive failure.
 */
function nextFailure(
	previous: RecallFailure | undefined,
	cooldownMs: number,
	now: number,
	error: string,
): RecallFailure {
	if (previous && isWaiting(previous, cooldownMs, now)) return previous;
	return { at: now, failures: (previous?.failures ?? 0) + 1, error };
}

/** Notice for the first automatic recall skipped after a failure. */
export function recallSkippedNotice(skip: RecallSkip, now: number): string {
	const clock = new Date(skip.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `Memory recall paused until ${clock} (in ${formatDuration(skip.retryAt - now)}) after a failed recall: ${skip.failure.error}`;
}

/**
 * The last failed automatic recall of one state's scope, read from the transcript on
 * first use. A conversation reset or session switch keeps it: the server's health is
 * not conversation state.
 */
export class RecallFailureWait {
	readonly #cooldownMs: number;
	readonly #transcript: () => RecallFailureTranscript;
	#failure: RecallFailure | undefined;
	#loaded = false;
	/** `at` of the failure whose skip was already announced in this process. */
	#announcedAt: number | undefined;

	/** `cooldownMs` is `hindsight.recallCooldownMs`, the first pause; `0`, less or `NaN` turns the pause off. */
	constructor(cooldownMs: number, transcript: () => RecallFailureTranscript) {
		this.#cooldownMs = cooldownMs > 0 ? cooldownMs : 0;
		this.#transcript = transcript;
	}

	#current(): RecallFailure | undefined {
		if (!this.#loaded) {
			const { sessionManager, scope } = this.#transcript();
			this.#failure = findRecallFailure(sessionManager, scope);
			this.#loaded = true;
		}
		return this.#failure;
	}

	/** The failure that holds off an automatic recall at `now`; undefined when the recall may run. */
	skip(now: number): RecallSkip | undefined {
		if (this.#cooldownMs <= 0) return undefined;
		const failure = this.#current();
		if (!failure || !isWaiting(failure, this.#cooldownMs, now)) return undefined;
		const first = this.#announcedAt !== failure.at;
		this.#announcedAt = failure.at;
		return { failure, retryAt: retryAtAfter(failure, this.#cooldownMs), first };
	}

	/**
	 * When automatic recall may run again if a recall fails at `now`, epoch ms; undefined
	 * when `recallCooldownMs` is `0` or less.
	 */
	retryAtAfterFailure(now: number): number | undefined {
		if (this.#cooldownMs <= 0) return undefined;
		return retryAtAfter(nextFailure(this.#current(), this.#cooldownMs, now, ""), this.#cooldownMs);
	}

	/**
	 * Records an automatic recall's outcome. A failure (`failure`, its cause) starts a pause,
	 * or a doubled one when the previous pause has ended; a failure during a running pause
	 * changes nothing. An answered recall (`ok`) ends the pause. An aborted or stale recall
	 * has neither and records nothing. The transcript gets the record only when
	 * `recallCooldownMs > 0`.
	 */
	record(outcome: { ok: boolean; failure?: string }, now: number): void {
		if (this.#cooldownMs <= 0) return;
		const previous = this.#current();
		let next: RecallFailure;
		if (outcome.failure !== undefined) {
			next = nextFailure(previous, this.#cooldownMs, now, outcome.failure);
			if (next === previous) return;
		} else if (outcome.ok && previous && previous.failures > 0) {
			next = { at: now, failures: 0, error: "" };
		} else {
			return;
		}
		this.#failure = next;
		const { sessionManager, scope } = this.#transcript();
		persistRecallFailure(sessionManager, scope, next);
	}
}
