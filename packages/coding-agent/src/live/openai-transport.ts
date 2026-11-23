/**
 * Live voice on OpenAI's API (`live.provider: openai`): GPT-Live's public session API, billed to an
 * API key instead of the ChatGPT (Codex) subscription that {@link CodexLiveTransport} uses.
 *
 * One session request (`POST {base}/live/sessions`, the session settings and the WebRTC SDP offer in
 * one JSON body) answered by a 201 that names the session and carries the SDP answer; then the
 * session's sideband WebSocket (`{base}/live/sessions/{id}/attach`) for its events and the client's
 * messages. Both carry the `openai` provider's key as the bearer, and nothing else. GPT-Live's public
 * events and messages differ from Codex's; this transport maps them both ways, so the controller is the
 * same for both routes.
 */
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { kNoAuth } from "../config/model-provider-discovery";
import {
	type LiveClientMessage,
	type LiveContextChannel,
	type LiveInputTextContent,
	type LiveServerEvent,
	parseLiveServerEvent,
} from "./protocol";
import type { CodexLiveTransport, LiveTransportCallbacks } from "./transport";

/** The provider whose key (and base URL, when models.yml sets one) the route uses; also its proxy scope. */
const OPENAI_PROVIDER = "openai";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** The GPT-Live model a call asks for. */
const OPENAI_LIVE_MODEL = "gpt-live-1.1";
const MAX_ERROR_BODY_LENGTH = 2_048;
/** How much of a redirect's `Location` an error repeats. */
const MAX_LOCATION_LENGTH = 256;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
/** Event ids remembered to drop the 3 s the sideband replays from the data channel when it attaches. */
const SEEN_EVENT_IDS_LIMIT = 1_024;
/** How many sent messages' `event_id`s are remembered, to name the message an `error` refers to. */
const SENT_EVENT_IDS_LIMIT = 256;
/**
 * The longest a delegation waits for the transcript to reach its `offset_ms` (see
 * {@link OpenAILiveTransport.#releaseDelegations}); it goes then with the words that have arrived.
 */
const DELEGATION_WAIT_CAP_MS = 1_000;
/** How far before a delegation's offset the user's words can belong to it; also bounds the words kept. */
const DELEGATION_WORDS_WINDOW_MS = 60_000;
/** Heads a delegation's turn: the words below it are the user's speech, not instructions. */
const DELEGATION_WORDS_LABEL =
	"The user's words for this request, from speech-to-text. They can hold recognition errors and speech that was not a request:";
/** A delegation's turn when none of the user's words before it were transcribed. */
const DELEGATION_NO_WORDS =
	"No words of the user were transcribed for this request. Say so, and ask the user to say it again.";

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

/** Where a GPT-Live call goes and with which key. */
export interface OpenAILiveRoute {
	/** Base URL the live paths hang off, e.g. `https://api.openai.com/v1`. */
	baseUrl: string;
	/** The `openai` provider's key, the bearer of the session request and the sideband. */
	apiKey: string;
	/** GPT-Live model. */
	model: string;
}

/** The model registry calls the route needs. */
export type OpenAILiveRegistry = Pick<ModelRegistry, "getProviderBaseUrl" | "getApiKeyForProvider">;

/**
 * The route of a GPT-Live call: the `openai` provider's key as omp resolves it for any OpenAI model
 * (a stored key, `apiKey` in models.yml, else `OPENAI_API_KEY`), and its base URL when models.yml sets
 * one (else `https://api.openai.com/v1`).
 */
export async function resolveOpenAILiveRoute(
	registry: OpenAILiveRegistry,
	sessionId: string,
): Promise<OpenAILiveRoute> {
	const apiKey = await registry.getApiKeyForProvider(OPENAI_PROVIDER, sessionId);
	if (!apiKey || apiKey === kNoAuth) {
		throw new Error(
			"live.provider openai: the openai provider has no key (its apiKey in models.yml, or OPENAI_API_KEY)",
		);
	}
	const baseUrl = registry.getProviderBaseUrl(OPENAI_PROVIDER)?.trim() || DEFAULT_OPENAI_BASE_URL;
	return { baseUrl, apiKey, model: OPENAI_LIVE_MODEL };
}

/** Appends `path` to the base URL's path, keeping its query. */
function liveUrl(baseUrl: string, path: string): URL {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
	return url;
}

/** GPT-Live's session URL: `{base}/live/sessions`. */
export function openAILiveSessionsUrl(baseUrl: string): string {
	return liveUrl(baseUrl, "live/sessions").toString();
}

/** GPT-Live's sideband URL: `{base as ws(s)}/live/sessions/{id}/attach`. */
export function openAILiveAttachUrl(baseUrl: string, sessionId: string): string {
	const url = liveUrl(baseUrl, `live/sessions/${encodeURIComponent(sessionId)}/attach`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function bounded(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** `text` with each copy of `apiKey` replaced: a server can echo the bearer back in any text it sends. */
function redactKey(text: string, apiKey: string): string {
	return apiKey ? text.replaceAll(apiKey, "[key]") : text;
}

/** Parses a JSON string from an event channel into a record, or `undefined`. */
function parseRecord(payload: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(payload);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** One of GPT-Live's appends: Codex's commentary channel is progress (silent thinking), the rest is spoken. */
function toOpenAIAppend(
	channel: LiveContextChannel | undefined,
	delegationId: string | null,
	content: LiveInputTextContent[],
): { type: string; delegation_id: string | null; content: string } {
	return {
		type: channel === "commentary" ? "session.thinking.append" : "session.commentary.append",
		delegation_id: delegationId,
		content: content.map(part => part.text).join(""),
	};
}

/**
 * A controller message in GPT-Live's form. The controller writes a delegation's progress to Codex's
 * commentary channel and its result to the spoken one; GPT-Live takes progress as silent thinking and
 * the result as commentary, which it speaks. Context outside a delegation has `delegation_id: null`.
 */
function toOpenAIMessage(message: LiveClientMessage): { type: string } {
	switch (message.type) {
		case "delegation.context.append":
			return toOpenAIAppend(message.channel, message.delegation_item_id, message.content);
		case "session.context.append":
			return toOpenAIAppend(message.channel, null, message.content);
		case "session.close":
			return { type: "session.close" };
	}
}

/** The user's words of one transcript fragment, on the session timeline. */
interface UserWords {
	startMs: number;
	text: string;
}

/** A client delegation waiting for the transcript to reach its offset. */
interface PendingDelegation {
	id: string;
	offsetMs: number;
	/** Set when {@link DELEGATION_WAIT_CAP_MS} has passed. */
	expired: boolean;
	timer: NodeJS.Timeout;
}

/**
 * A delegation's turn: the user's words before it, labelled, or a line that none were transcribed. Words
 * with a place on the session timeline come in its order, then words without one in the order they came.
 */
function delegationText(words: UserWords[], untimed: readonly string[]): string {
	const timed = words.toSorted((a, b) => a.startMs - b.startMs).map(part => part.text);
	const said = [...timed, ...untimed].join("").trim();
	if (!said) return DELEGATION_NO_WORDS;
	const quoted = said
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n");
	return `${DELEGATION_WORDS_LABEL}\n\n${quoted}`;
}

/** Configuration of one GPT-Live call. */
export interface OpenAILiveTransportOptions {
	/** Resolves the `openai` provider's key and base URL when the call connects; see {@link resolveOpenAILiveRoute}. */
	registry: OpenAILiveRegistry;
	sessionId: string;
	instructions: string;
	callbacks: LiveTransportCallbacks;
	/** SDP offer from a caller-owned WebRTC peer; unset makes a native peer (see `LiveTransportOptions.sdpOffer`). */
	sdpOffer?: string;
}

/** GPT-Live call over its public API, with a native or caller-owned media peer; the surface of {@link CodexLiveTransport}. */
export class OpenAILiveTransport implements Pick<
	CodexLiveTransport,
	"sdpAnswer" | "connect" | "send" | "pushAudio" | "setMuted" | "close"
> {
	readonly #options: OpenAILiveTransportOptions;
	#peer: LiveWebRtcPeer | undefined;
	#sdpAnswer: string | undefined;
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#muted = false;
	#unexpectedFailureReported = false;
	/** Event ids already delivered, in arrival order; see {@link SEEN_EVENT_IDS_LIMIT}. */
	readonly #seenEventIds = new Set<string>();
	/** The `event_id` of each message sent, with its type, oldest first; see {@link SENT_EVENT_IDS_LIMIT}. */
	readonly #sentEventIds = new Map<string, string>();
	#sentCount = 0;
	/** The user's words not yet in a delegation's turn; see {@link #releaseDelegations}. */
	#userWords: UserWords[] = [];
	/** The user's words with no timing, as they came (`performance.now()`); see {@link #addUntimedWords}. */
	#untimedWords: { arrivedAt: number; text: string }[] = [];
	/** How far each speaker's transcript has reached on the session timeline (the latest `end_ms`). */
	readonly #transcriptEndMs = { user: Number.NEGATIVE_INFINITY, assistant: Number.NEGATIVE_INFINITY };
	/** Client delegations waiting for their words, oldest first. */
	#pendingDelegations: PendingDelegation[] = [];
	/** The offset of the latest delegation handed over: the user's words before it went with it. */
	#handedOverOffsetMs = Number.NEGATIVE_INFINITY;
	/** The speaker of the transcript line being said, and its words so far; see {@link #mapEvent}. */
	#line: { role: "user" | "assistant"; text: string } | undefined;
	/**
	 * Removes the key from server text bound for an error or a log; set once the key is resolved. The key
	 * stays in this closure for the call's life, as it does in the sideband's headers.
	 */
	#redact: (text: string) => string = text => text;

	constructor(options: OpenAILiveTransportOptions) {
		this.#options = options;
	}

	/** SDP answer for the caller's peer once an `sdpOffer` call has been signaled. */
	get sdpAnswer(): string | undefined {
		return this.#sdpAnswer;
	}

	/** Make the media peer, open the session, and attach its sideband. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed")
			return Promise.reject(new Error("Live transport is closed"));
		this.#state = "connecting";
		const operation = this.#connect().catch(async (cause: unknown) => {
			await this.close();
			// Every connect failure can carry server text: a redirect, a refused session, the sideband's URL.
			const error = toError(cause);
			const message = this.#redact(error.message);
			throw message === error.message ? error : new Error(message);
		});
		this.#connectPromise = operation;
		return operation;
	}

	async #connect(): Promise<void> {
		// Resolved here, not before the transport exists, so a close while the key resolves stops the call.
		const route = await resolveOpenAILiveRoute(this.#options.registry, this.#options.sessionId);
		this.#redact = text => redactKey(text, route.apiKey);
		if (this.#state !== "connecting") throw new Error("Live transport is closed");
		let offer = this.#options.sdpOffer;
		let peer: LiveWebRtcPeer | undefined;
		if (offer === undefined) {
			peer = this.#createPeer();
			this.#peer = peer;
			offer = await peer.createOffer();
		}
		if (this.#state !== "connecting") throw new Error("Live transport is closed");
		const session = await this.#signal(route, offer);
		if (peer) {
			await peer.acceptAnswer(session.answer);
			peer.setMuted(this.#muted);
			await peer.waitForOpen();
		} else {
			this.#sdpAnswer = session.answer;
		}
		if (this.#state !== "connecting") throw new Error("Live transport is closed");
		await this.#connectSideband(openAILiveAttachUrl(route.baseUrl, session.id), route.apiKey);
		if (this.#state !== "connecting") throw new Error("Live transport is closed");
		this.#state = "connected";
	}

	#createPeer(): LiveWebRtcPeer {
		return new LiveWebRtcPeer(
			(error, payload) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleServerEvent(payload);
				}
			},
			(error, level) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleOutputLevel(level);
				}
			},
			(error, message) => this.#reportFailure(error?.message ?? message),
		);
	}

	/**
	 * The session request: the model, the instructions, client delegation and the SDP offer, with the
	 * provider's key and no other credential. No redirect is followed, so the key stays at the provider's origin.
	 */
	async #signal(route: OpenAILiveRoute, offer: string): Promise<{ id: string; answer: string }> {
		const url = new URL(openAILiveSessionsUrl(route.baseUrl));
		const body = {
			session: { model: route.model, instructions: this.#options.instructions, delegation: { type: "client" } },
			transport: { type: "webrtc", sdp: offer },
		};
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${route.apiKey}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			redirect: "manual",
			proxy: getProxyForUrl(OPENAI_PROVIDER, url),
		});
		// Server text is redacted before it is cut, so a cut cannot leave part of an echoed key behind.
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			const location = bounded(
				redactKey(response.headers.get("location") ?? "nowhere", route.apiKey),
				MAX_LOCATION_LENGTH,
			);
			throw new Error(
				`GPT-Live session request was redirected (${response.status}) to ${location}; no redirect is followed`,
			);
		}
		const text = await response.text();
		if (!response.ok) {
			const reply = redactKey(text.trim().replaceAll(/\s+/g, " "), route.apiKey);
			const detail = bounded(reply || response.statusText, MAX_ERROR_BODY_LENGTH);
			throw new Error(`GPT-Live session failed (${response.status}): ${detail}`);
		}
		const answer = parseRecord(text);
		const id = isRecord(answer?.session) ? answer.session.id : undefined;
		if (typeof id !== "string" || !id) throw new Error("GPT-Live session returned no session id");
		// The id is opaque and percent-encoded into the sideband path; only `.` and `..` could move that path.
		if (id === "." || id === "..") {
			throw new Error(`GPT-Live session returned an invalid session id (${JSON.stringify(id)})`);
		}
		const sdp = isRecord(answer?.transport) ? answer.transport.sdp : undefined;
		if (typeof sdp !== "string" || !sdp.trim()) throw new Error("GPT-Live session returned no SDP answer");
		return { id, answer: sdp };
	}

	async #connectSideband(url: string, apiKey: string): Promise<void> {
		let failure = new Error("GPT-Live sideband connection failed");
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
			try {
				await this.#openSideband(url, apiKey);
				return;
			} catch (cause) {
				failure = toError(cause);
				if (this.#state !== "connecting") throw failure;
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await Bun.sleep(200 * 2 ** attempt);
			}
		}
		throw failure;
	}

	async #openSideband(url: string, apiKey: string): Promise<void> {
		const options = {
			headers: { Authorization: `Bearer ${apiKey}` },
			proxy: getProxyForUrl(OPENAI_PROVIDER, new URL(url)),
		} satisfies Bun.WebSocketOptions;
		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [url, options]);
		socket.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		const timeout = setTimeout(() => {
			socket.close(1000, "connect timeout");
			rejectConnect(new Error("GPT-Live sideband connection timed out"));
		}, SIDEBAND_CONNECT_TIMEOUT_MS);
		timeout.unref?.();
		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		};
		socket.onopen = () => {
			// A socket that opens after the transport was closed is closed, never kept.
			if (settled || this.#state !== "connecting") {
				socket.close(1000, "stale");
				rejectConnect(new Error("Live transport is closed"));
				return;
			}
			opened = true;
			settled = true;
			clearTimeout(timeout);
			this.#sideband = socket;
			resolve();
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure("GPT-Live sideband returned an unexpected binary frame.");
				return;
			}
			this.#handleEvent(event.data);
		};
		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`GPT-Live sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportFailure(`GPT-Live sideband failed${detail}`);
		};
		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`GPT-Live sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportFailure(`GPT-Live sideband closed (${event.code})${detail}`);
			}
		};
		await promise;
	}

	/** An event from the data channel: GPT-Live sends every event on both channels, so once attached, the sideband's count. */
	#handleServerEvent(payload: string): void {
		if (this.#sideband?.readyState === WebSocket.OPEN) return;
		this.#handleEvent(payload);
	}

	/** Delivers one event, once: the sideband replays the 3 s before it attached, which the data channel delivered. */
	#handleEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const record = parseRecord(payload);
		if (!record) return;
		const eventId = record.event_id;
		if (typeof eventId === "string") {
			if (this.#seenEventIds.has(eventId)) return;
			this.#seenEventIds.add(eventId);
			if (this.#seenEventIds.size > SEEN_EVENT_IDS_LIMIT) {
				const [oldest] = this.#seenEventIds;
				if (oldest !== undefined) this.#seenEventIds.delete(oldest);
			}
		}
		this.#deliver(this.#mapEvent(record));
	}

	#deliver(events: LiveServerEvent[]): void {
		for (const event of events) {
			if (this.#state === "closing" || this.#state === "closed") return;
			try {
				this.#options.callbacks.onEvent(event);
			} catch {}
		}
	}

	/**
	 * GPT-Live's public events as the controller's (Codex's) events.
	 * - Its transcript comes in deltas with no end-of-turn event, so one speaker's line ends when the other
	 *   speaker starts.
	 * - Its delegation carries only an id and its `offset_ms` on the session timeline: OpenAI's client
	 *   delegation guide says to use the transcript events for what the user wants. Its turn is the user's
	 *   words before that offset; see {@link #releaseDelegations}. A user's delta with no timing has no
	 *   place on the timeline and joins the next delegation's turn; see {@link #addUntimedWords}.
	 * - Its `error` reports a problem in the session "such as an invalid client command", and names that
	 *   command by its `client_event_id` (OpenAI's Live reference); the session stays open (the delegation
	 *   guide, on `responses_validation_failed`). An error that names omp's spoken answer
	 *   (`session.commentary.append`) or `session.close` fails the call, as a failed send does on Codex, so
	 *   a refused answer is not lost unseen. One that names a progress note (`session.thinking.append`),
	 *   which the user never hears, is logged and the call goes on; so is any other.
	 */
	#mapEvent(record: Record<string, unknown>): LiveServerEvent[] {
		switch (record.type) {
			case "session.input_transcript.delta":
			case "session.output_transcript.delta": {
				const delta = record.delta;
				if (typeof delta !== "string" || !delta) return [];
				const role = record.type === "session.input_transcript.delta" ? "user" : "assistant";
				const { start_ms: startMs, end_ms: endMs } = record;
				if (typeof startMs === "number" && typeof endMs === "number" && Number.isFinite(endMs)) {
					this.#transcriptEndMs[role] = Math.max(this.#transcriptEndMs[role], endMs);
					if (role === "user") this.#addUserWords(startMs, delta);
				} else if (role === "user") {
					this.#addUntimedWords(delta);
				}
				const events: LiveServerEvent[] = [];
				const previous = this.#line;
				if (previous && previous.role !== role) {
					events.push({ type: "turn.done", turn: { role: previous.role, transcript: previous.text } });
				}
				const text = (previous?.role === role ? previous.text : "") + delta;
				this.#line = { role, text };
				const type = role === "user" ? "input_transcript.added" : "output_transcript.added";
				events.push({ type, item: { text } });
				events.push(...this.#releaseDelegations());
				return events;
			}
			case "session.delegation.created": {
				const delegation = record.delegation;
				if (!isRecord(delegation) || typeof delegation.id !== "string" || delegation.target !== "client") {
					return [];
				}
				const offsetMs =
					typeof record.offset_ms === "number" && Number.isFinite(record.offset_ms)
						? record.offset_ms
						: Math.max(this.#transcriptEndMs.user, this.#transcriptEndMs.assistant, 0);
				const pending: PendingDelegation = {
					id: delegation.id,
					offsetMs,
					expired: false,
					timer: setTimeout(() => {
						pending.expired = true;
						this.#deliver(this.#releaseDelegations());
					}, DELEGATION_WAIT_CAP_MS),
				};
				this.#pendingDelegations.push(pending);
				return this.#releaseDelegations();
			}
			case "error": {
				const error: Record<string, unknown> = isRecord(record.error) ? record.error : {};
				const clientEventId = error.client_event_id ?? record.client_event_id;
				const refused = typeof clientEventId === "string" ? this.#sentEventIds.get(clientEventId) : undefined;
				const reason = this.#redact(typeof error.message === "string" ? error.message : "no reason given");
				if (refused === undefined) {
					const detail = record.error === undefined ? undefined : this.#redact(JSON.stringify(record.error));
					logger.warn("GPT-Live reported an error; the call stays open", { error: detail });
				} else if (refused === "session.thinking.append") {
					logger.warn("GPT-Live refused omp's progress note; the call stays open", { reason });
				} else {
					this.#reportFailure(`GPT-Live refused omp's ${refused}: ${reason}`);
				}
				return [];
			}
			default: {
				const event = parseLiveServerEvent(record);
				return event ? [event] : [];
			}
		}
	}

	/**
	 * Keeps one fragment of the user's words, unless it is from before the latest delegation handed over
	 * (that turn has gone); drops words older than {@link DELEGATION_WORDS_WINDOW_MS}.
	 */
	#addUserWords(startMs: number, text: string): void {
		if (!Number.isFinite(startMs) || startMs < this.#handedOverOffsetMs) return;
		const oldest = this.#transcriptEndMs.user - DELEGATION_WORDS_WINDOW_MS;
		this.#userWords = this.#userWords.filter(words => words.startMs >= oldest);
		this.#userWords.push({ startMs, text });
	}

	/**
	 * Keeps a fragment of the user's words that has no `start_ms` and `end_ms`, so no place on the session
	 * timeline. It joins the next delegation handed over, after the words that have one, if it came within
	 * {@link DELEGATION_WORDS_WINDOW_MS} of that hand-over. It cannot show that the user's transcript has
	 * reached an offset, so a delegation waiting on such words alone goes after {@link DELEGATION_WAIT_CAP_MS}.
	 */
	#addUntimedWords(text: string): void {
		const oldest = performance.now() - DELEGATION_WORDS_WINDOW_MS;
		this.#untimedWords = this.#untimedWords.filter(words => words.arrivedAt >= oldest);
		this.#untimedWords.push({ arrivedAt: performance.now(), text });
	}

	/** Takes the words without a place on the timeline for one delegation's turn; see {@link #addUntimedWords}. */
	#takeUntimedWords(): string[] {
		const oldest = performance.now() - DELEGATION_WORDS_WINDOW_MS;
		const taken = this.#untimedWords.filter(words => words.arrivedAt >= oldest).map(words => words.text);
		this.#untimedWords = [];
		return taken;
	}

	/**
	 * Hands the waiting delegations over in order, each as a turn of the user's words before its offset.
	 * GPT-Live may send a delegation before the transcript of the words that led to it, and sends no
	 * event that ends the user's transcript. So a delegation goes once the transcript has reached its
	 * offset: the user's transcript (no earlier word of the user can follow), or the voice's while some
	 * of the user's words before the offset have arrived. Failing both, it goes after
	 * {@link DELEGATION_WAIT_CAP_MS}. It is never dropped: with no words, its turn says none were heard.
	 */
	#releaseDelegations(): LiveServerEvent[] {
		const events: LiveServerEvent[] = [];
		for (let next = this.#pendingDelegations[0]; next; next = this.#pendingDelegations[0]) {
			const offsetMs = next.offsetMs;
			const earliest = offsetMs - DELEGATION_WORDS_WINDOW_MS;
			const words = this.#userWords.filter(part => part.startMs < offsetMs && part.startMs >= earliest);
			const reached =
				this.#transcriptEndMs.user >= offsetMs || (words.length > 0 && this.#transcriptEndMs.assistant >= offsetMs);
			if (!reached && !next.expired) break;
			clearTimeout(next.timer);
			this.#pendingDelegations.shift();
			this.#userWords = this.#userWords.filter(part => part.startMs >= offsetMs);
			this.#handedOverOffsetMs = Math.max(this.#handedOverOffsetMs, offsetMs);
			const untimed = this.#takeUntimedWords();
			events.push({
				type: "delegation.created",
				item: {
					type: "delegation",
					target: "client",
					id: next.id,
					content: [{ type: "input_text", text: delegationText(words, untimed) }],
				},
			});
		}
		return events;
	}

	#handleOutputLevel(level: number): void {
		if (this.#state !== "connected" || !Number.isFinite(level)) return;
		try {
			this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
		} catch {}
	}

	/** Ends the call with `message`, once; the key is removed from it, since it can quote the server. */
	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message: this.#redact(message) });
		} catch {}
	}

	/**
	 * Serialize one message onto the session's sideband, in GPT-Live's form, with an `event_id` that an
	 * `error` about it names; see {@link #mapEvent}.
	 */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Live transport is not connected");
			const sideband = this.#sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error("GPT-Live sideband is not connected");
			}
			const wire = toOpenAIMessage(message);
			const eventId = `omp_${++this.#sentCount}`;
			this.#sentEventIds.set(eventId, wire.type);
			if (this.#sentEventIds.size > SENT_EVENT_IDS_LIMIT) {
				const [oldest] = this.#sentEventIds.keys();
				if (oldest !== undefined) this.#sentEventIds.delete(oldest);
			}
			sideband.send(JSON.stringify({ ...wire, event_id: eventId }));
		});
		this.#sendTail = operation.catch(() => {});
		return operation;
	}

	/** Queue 16 kHz mono Float32 PCM for native Opus transmission. */
	pushAudio(samples: Float32Array): void {
		if (this.#state !== "connected" || this.#muted || samples.length === 0) return;
		this.#peer?.pushAudio(samples);
	}

	/** Enable or disable the native audio source and discard partial input when muted. */
	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		if (this.#state === "connected") this.#peer?.setMuted(muted);
	}

	/** Close the sideband and the native media peer. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		const sideband = this.#sideband;
		const peer = this.#peer;
		this.#sideband = undefined;
		this.#peer = undefined;
		// The call is over: a delegation still waiting for its words has no call to answer on.
		for (const pending of this.#pendingDelegations) clearTimeout(pending.timer);
		this.#pendingDelegations = [];
		if (sideband && (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)) {
			sideband.close(1000, "done");
		}
		if (peer) {
			try {
				await peer.close();
			} catch {}
		}
		this.#state = "closed";
	}
}
