/**
 * The words of a GPT-Live call (`live.provider: openai`), kept for the requests its delegations carry
 * into the session.
 *
 * GPT-Live sends each speaker's words as transcript fragments with their interval on the call's
 * timeline (`start_ms`/`end_ms`), and a delegation names no task text, only its timeline offset; so a
 * delegation's request is built from the fragments said before that offset.
 */

export type LiveSpeaker = "user" | "assistant";

/** One transcript fragment, as GPT-Live delivered it. */
export interface TranscriptFragment {
	role: LiveSpeaker;
	/** The text exactly as delivered, spaces included. */
	text: string;
	/** Interval on the call's timeline, in ms from the start of the call. */
	startMs: number;
	endMs: number;
}

const SPEAKER_LABEL: Record<LiveSpeaker, string> = { user: "User", assistant: "Voice" };

/** The fragments of one call that no delegation request has taken yet. */
export class LiveCallTranscript {
	/** Fragments no request has taken yet, in arrival order. */
	#unclaimed: TranscriptFragment[] = [];
	/** How far on the call's timeline the user's own fragments have reached; see {@link reached}. */
	#userReachedMs = Number.NEGATIVE_INFINITY;

	/** Records a fragment for the next request. */
	add(fragment: TranscriptFragment): void {
		this.#unclaimed.push(fragment);
		if (fragment.role === "user") this.#userReachedMs = Math.max(this.#userReachedMs, fragment.endMs);
	}

	/**
	 * Whether the user's words before `offsetMs` are all in: a user fragment has reached `offsetMs`. Only
	 * the user's own fragments tell: the voice keeps talking once it delegates, and its words can reach
	 * omp before the user's earlier ones, so a voice fragment past the offset says nothing about them.
	 */
	reached(offsetMs: number): boolean {
		return this.#userReachedMs >= offsetMs;
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
}
