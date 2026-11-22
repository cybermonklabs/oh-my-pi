/**
 * The words of a GPT-Live call (`live.provider: openai`), kept twice: as the requests each delegation
 * carries into the session, and as the transcript file of the call.
 *
 * GPT-Live sends each speaker's words as transcript fragments with their interval on the session
 * timeline (`start_ms`/`end_ms`), and a delegation names no task text, only its timeline offset; so a
 * delegation's request is built from the fragments said before that offset.
 */
import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";

/** A silence of this long on the session timeline between one speaker's fragments ends a line. */
export const TRANSCRIPT_LINE_GAP_MS = 1_500;

export type LiveSpeaker = "user" | "assistant";

/** One transcript fragment, as GPT-Live delivered it. */
export interface TranscriptFragment {
	role: LiveSpeaker;
	/** The text exactly as delivered, spaces included. */
	text: string;
	/** Interval on the session timeline, in ms from the start of the session. */
	startMs: number;
	endMs: number;
}

/** A line of the transcript: one speaker, words with no gap of {@link TRANSCRIPT_LINE_GAP_MS} or more. */
export interface TranscriptLine {
	role: LiveSpeaker;
	text: string;
	/** When the line's first words reached omp. */
	at: Date;
}

const SPEAKER_LABEL: Record<LiveSpeaker, string> = { user: "User", assistant: "Voice" };

interface OpenLine extends TranscriptLine {
	lastEndMs: number;
}

/** Collects one call's fragments for delegation requests and writes its lines to a file. */
export class LiveCallTranscript {
	readonly #path: string;
	readonly #onLine: (line: TranscriptLine, final: boolean) => void;
	/** Fragments no request has taken yet, in arrival order. */
	#unclaimed: TranscriptFragment[] = [];
	#reachedMs = Number.NEGATIVE_INFINITY;
	#line: OpenLine | undefined;
	#writes: Promise<void> = Promise.resolve();
	#writeFailed = false;

	/**
	 * @param path the transcript file; lines are appended as they end.
	 * @param onLine called with the open line as it grows (`final: false`) and once it ends (`final: true`).
	 */
	constructor(path: string, onLine: (line: TranscriptLine, final: boolean) => void = () => {}) {
		this.#path = path;
		this.#onLine = onLine;
	}

	get path(): string {
		return this.#path;
	}

	/** Whether a line could not be written to the file. */
	get writeFailed(): boolean {
		return this.#writeFailed;
	}

	/** Records a fragment: a request can take it, and it extends the open line or starts one. */
	add(fragment: TranscriptFragment): void {
		this.#unclaimed.push(fragment);
		this.#reachedMs = Math.max(this.#reachedMs, fragment.endMs);
		const line = this.#line;
		if (line && (line.role !== fragment.role || fragment.startMs - line.lastEndMs >= TRANSCRIPT_LINE_GAP_MS)) {
			this.endLine();
		}
		if (this.#line) {
			this.#line.text += fragment.text;
			this.#line.lastEndMs = Math.max(this.#line.lastEndMs, fragment.endMs);
		} else {
			this.#line = { role: fragment.role, text: fragment.text, at: new Date(), lastEndMs: fragment.endMs };
		}
		this.#onLine(this.#line, false);
	}

	/** Whether fragments have reached `offsetMs` on the session timeline, so the words before it are in. */
	reached(offsetMs: number): boolean {
		return this.#reachedMs >= offsetMs;
	}

	/**
	 * Takes the words said before `offsetMs` that no earlier request took, as `User: …` and `Voice: …`
	 * lines in timeline order, one per run of a speaker. Words said after `offsetMs` stay for the next
	 * request; so do words that arrive after this request went out, however early they were said.
	 */
	takeRequest(offsetMs: number): string[] {
		const taken = this.#unclaimed.filter(fragment => fragment.startMs < offsetMs);
		this.#unclaimed = this.#unclaimed.filter(fragment => fragment.startMs >= offsetMs);
		taken.sort((a, b) => a.startMs - b.startMs);
		const lines: { role: LiveSpeaker; text: string }[] = [];
		for (const fragment of taken) {
			const last = lines.at(-1);
			if (last?.role === fragment.role) last.text += fragment.text;
			else lines.push({ role: fragment.role, text: fragment.text });
		}
		return lines.filter(line => line.text.trim()).map(line => `${SPEAKER_LABEL[line.role]}: ${line.text.trim()}`);
	}

	/** Ends the open line (at a delegation, and when the call ends) and queues it for the file. */
	endLine(): void {
		const line = this.#line;
		this.#line = undefined;
		if (!line) return;
		const text = line.text.trim();
		if (!text) return;
		this.#onLine({ role: line.role, text, at: line.at }, true);
		const entry = `${line.at.toISOString()} ${SPEAKER_LABEL[line.role]}: ${text}\n`;
		this.#writes = this.#writes.then(() =>
			fs.appendFile(this.#path, entry).catch(error => {
				this.#writeFailed = true;
				logger.warn("Live call transcript line was not written", { path: this.#path, error: String(error) });
			}),
		);
	}

	/** Ends the open line and waits until every line is in the file. */
	async finish(): Promise<void> {
		this.endLine();
		await this.#writes;
	}
}
