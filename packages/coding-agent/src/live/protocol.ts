import { isRecord } from "@oh-my-pi/pi-utils";

/** Frameless Bidi model used by Codex Desktop live calls. */
export const LIVE_MODEL = "gpt-live-1-codex" as const;

/** Maximum UTF-8 payload size accepted by each context append. */
export const CONTEXT_CHUNK_BYTES = 500;

/** Semantic stream selected for appended Frameless Bidi context. */
export type LiveContextChannel = "speakable" | "commentary";

/** Text content item accepted by Frameless Bidi context appends. */
export type LiveInputTextContent = { type: "input_text"; text: string };

/** Session object posted alongside the SDP when opening a live call. */
export type LiveSessionPayload = {
	model: typeof LIVE_MODEL;
	instructions: string;
	audio: { output: { voice: string } };
	delegation: { type: "client" };
};

/**
 * Session configuration a custom live endpoint receives in `session.update` once its sideband
 * opens (signaling sent it only the SDP); the endpoint picks the model.
 */
export type LiveSessionUpdate = {
	type: "realtime";
	instructions: string;
	audio: { output: { voice: string } };
	delegation: { type: "client" };
};

/** Messages sent by the client over the Frameless Bidi data channel or a GPT-Live sideband. */
export type LiveClientMessage =
	| { type: "session.update"; session: LiveSessionUpdate }
	| {
			type: "delegation.context.append";
			delegation_item_id: string;
			channel?: LiveContextChannel;
			content: LiveInputTextContent[];
	  }
	| {
			type: "session.context.append";
			channel?: LiveContextChannel;
			content: LiveInputTextContent[];
	  }
	| { type: "session.thinking.append" | "session.commentary.append"; delegation_id: string | null; content: string }
	| { type: "session.close" };

/** Parsed live server events (Frameless Bidi and GPT-Live's public API), including unsupported wire types. */
export type LiveServerEvent =
	| {
			type: "session.started" | "session.updated";
			session: { id: string; instructions?: string };
	  }
	| { type: "output_audio.delta"; audio: string }
	| { type: "input_transcript.added" | "output_transcript.added"; item: { text: string } }
	| { type: "turn.done"; turn: { role: "user" | "assistant"; transcript: string } }
	| {
			type: "delegation.created";
			item: {
				type: "delegation";
				target: "client";
				id: string;
				content: LiveInputTextContent[];
			};
	  }
	| { type: "error"; message: string }
	// GPT-Live's public API (`live.provider: openai`); see {@link parseOpenAILiveServerEvent}.
	| { type: "transcript.delta"; role: "user" | "assistant"; text: string; startMs: number; endMs: number }
	| { type: "delegation.requested"; id: string; offsetMs: number }
	| { type: "usage.updated"; seconds: number }
	| { type: "session.closed"; reason?: string; seconds?: number }
	/** A rejected command or a moderation cut: the call stays open. */
	| { type: "warning"; message: string }
	| { type: "unknown"; wireType: string };

type UnknownRecord = Record<string, unknown>;

/** A JSON string or decoded value from a live event channel, as a record; `null` when it is not one. */
export function parseLiveRecord(payload: unknown): UnknownRecord | null {
	let parsed = payload;
	if (typeof payload === "string") {
		try {
			parsed = JSON.parse(payload);
		} catch {
			return null;
		}
	}
	return isRecord(parsed) ? parsed : null;
}

function parseSessionEvent(
	type: "session.started" | "session.updated",
	payload: UnknownRecord,
): LiveServerEvent | null {
	const session = payload.session;
	if (!isRecord(session) || typeof session.id !== "string") return null;
	if (typeof session.instructions === "string") {
		return { type, session: { id: session.id, instructions: session.instructions } };
	}
	return { type, session: { id: session.id } };
}

function parseTranscriptAddedEvent(
	type: "input_transcript.added" | "output_transcript.added",
	payload: UnknownRecord,
): LiveServerEvent | null {
	const item = payload.item;
	if (!isRecord(item) || typeof item.text !== "string") return null;
	return { type, item: { text: item.text } };
}

function parseTurnDoneEvent(payload: UnknownRecord): LiveServerEvent | null {
	const turn = payload.turn;
	if (!isRecord(turn) || (turn.role !== "user" && turn.role !== "assistant")) return null;
	if (typeof turn.transcript !== "string") return null;
	return { type: "turn.done", turn: { role: turn.role, transcript: turn.transcript } };
}

function parseDelegationCreatedEvent(payload: UnknownRecord): LiveServerEvent | null {
	const item = payload.item;
	if (!isRecord(item) || item.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") {
		return null;
	}
	if (!Array.isArray(item.content)) return null;
	const content: LiveInputTextContent[] = [];
	for (const candidate of item.content) {
		if (!isRecord(candidate) || candidate.type !== "input_text" || typeof candidate.text !== "string") continue;
		content.push({ type: "input_text", text: candidate.text });
	}
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: item.id, content },
	};
}

function stringifyErrorValue(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === undefined) return null;
	try {
		return JSON.stringify(value) ?? null;
	} catch {
		return String(value);
	}
}

function parseErrorEvent(payload: UnknownRecord): LiveServerEvent | null {
	if (typeof payload.message === "string") return { type: "error", message: payload.message };
	const error = payload.error;
	if (isRecord(error) && typeof error.message === "string") {
		return { type: "error", message: error.message };
	}
	const message = stringifyErrorValue(error);
	return message === null ? null : { type: "error", message };
}

/** Parse a JSON string or decoded value from the Frameless Bidi data channel. */
export function parseLiveServerEvent(payload: unknown): LiveServerEvent | null {
	const parsed = parseLiveRecord(payload);
	if (!parsed || typeof parsed.type !== "string") return null;

	switch (parsed.type) {
		case "session.started":
		case "session.updated":
			return parseSessionEvent(parsed.type, parsed);
		case "output_audio.delta":
			return typeof parsed.audio === "string" ? { type: parsed.type, audio: parsed.audio } : null;
		case "input_transcript.added":
		case "output_transcript.added":
			return parseTranscriptAddedEvent(parsed.type, parsed);
		case "turn.done":
			return parseTurnDoneEvent(parsed);
		case "delegation.created":
			return parseDelegationCreatedEvent(parsed);
		case "error":
			return parseErrorEvent(parsed);
		default:
			return { type: "unknown", wireType: parsed.type };
	}
}

/** Build the session object posted in the multipart WebRTC call request. */
export function buildLiveSessionPayload(instructions: string, voice: string): LiveSessionPayload {
	return {
		model: LIVE_MODEL,
		instructions,
		audio: { output: { voice } },
		delegation: { type: "client" },
	};
}

/** Build the `session.update` that configures a custom endpoint's call. */
export function buildLiveSessionUpdate(instructions: string, voice: string): LiveClientMessage {
	return {
		type: "session.update",
		session: { type: "realtime", instructions, audio: { output: { voice } }, delegation: { type: "client" } },
	};
}

/** Build a context append associated with a server-created delegation. */
export function buildDelegationContextAppend(
	delegationItemId: string,
	text: string,
	channel?: LiveContextChannel,
): LiveClientMessage {
	return {
		type: "delegation.context.append",
		delegation_item_id: delegationItemId,
		...(channel === undefined ? {} : { channel }),
		content: [{ type: "input_text", text }],
	};
}

/** Build context appended to the live session outside a delegation. */
export function buildSessionContextAppend(text: string, channel?: LiveContextChannel): LiveClientMessage {
	return {
		type: "session.context.append",
		...(channel === undefined ? {} : { channel }),
		content: [{ type: "input_text", text }],
	};
}

/** Build the message that gracefully closes a live session. */
export function buildSessionClose(): LiveClientMessage {
	return { type: "session.close" };
}

/**
 * Seconds without an input or output transcript after which GPT-Live returns a call to standby,
 * which OpenAI bills at its lower rate; 60 is the largest value the API takes (5 to 60).
 */
export const OPENAI_LIVE_IDLE_TIMEOUT_S = 60;

/** Body of `POST {base}/live/sessions`, GPT-Live's public WebRTC session request. */
export interface OpenAILiveSessionRequest {
	session: {
		model: string;
		instructions: string;
		audio: { output: { voice: string } };
		delegation: { type: "client" };
		idle_timeout_s: number;
		/** OpenAI pauses inference while idle only under a speech wake policy. */
		wake_policy: { type: "speech" };
	};
	transport: { type: "webrtc"; sdp: string };
}

/** Build the GPT-Live session request: client delegation, standby after silence, the caller's SDP offer. */
export function buildOpenAILiveSessionRequest(options: {
	model: string;
	instructions: string;
	voice: string;
	sdp: string;
}): OpenAILiveSessionRequest {
	return {
		session: {
			model: options.model,
			instructions: options.instructions,
			audio: { output: { voice: options.voice } },
			delegation: { type: "client" },
			idle_timeout_s: OPENAI_LIVE_IDLE_TIMEOUT_S,
			wake_policy: { type: "speech" },
		},
		transport: { type: "webrtc", sdp: options.sdp },
	};
}

/** How a route's server takes a delegation's progress and result. */
export interface LiveWire {
	/** Progress the voice may use later but does not say when it arrives. */
	progress(delegationId: string, text: string): LiveClientMessage;
	/** The delegation's result, for the voice to say. */
	result(delegationId: string, text: string): LiveClientMessage;
}

/** Codex's Frameless Bidi: both go as delegation context, progress on the commentary channel. */
export const CODEX_LIVE_WIRE: LiveWire = {
	progress: (delegationId, text) => buildDelegationContextAppend(delegationId, text, "commentary"),
	result: (delegationId, text) => buildDelegationContextAppend(delegationId, text),
};

/** GPT-Live's public API: progress as `session.thinking.append`, the result as `session.commentary.append`. */
export const OPENAI_LIVE_WIRE: LiveWire = {
	progress: (delegationId, text) => ({ type: "session.thinking.append", delegation_id: delegationId, content: text }),
	result: (delegationId, text) => ({ type: "session.commentary.append", delegation_id: delegationId, content: text }),
};

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Map a GPT-Live public event onto the controller's events. Transcript deltas keep their text exactly
 * (spaces included) and their session-timeline interval; a delegation names no task text, only its
 * id and timeline offset; an `error` in a running call is a warning, since a rejected command or a
 * moderation cut leaves the call open (`session.closed` says when it ends).
 */
export function parseOpenAILiveServerEvent(payload: unknown): LiveServerEvent | null {
	const parsed = parseLiveRecord(payload);
	if (!parsed || typeof parsed.type !== "string") return null;

	switch (parsed.type) {
		case "session.input_transcript.delta":
		case "session.output_transcript.delta": {
			const { delta, start_ms: startMs, end_ms: endMs } = parsed;
			if (typeof delta !== "string" || !isFiniteNumber(startMs) || !isFiniteNumber(endMs)) return null;
			const role = parsed.type === "session.input_transcript.delta" ? "user" : "assistant";
			return { type: "transcript.delta", role, text: delta, startMs, endMs };
		}
		case "session.delegation.created": {
			const delegation = parsed.delegation;
			if (!isRecord(delegation) || typeof delegation.id !== "string" || delegation.target !== "client") return null;
			if (!isFiniteNumber(parsed.offset_ms)) return null;
			return { type: "delegation.requested", id: delegation.id, offsetMs: parsed.offset_ms };
		}
		case "session.usage.updated": {
			const usage = parsed.usage;
			if (!isRecord(usage) || !isFiniteNumber(usage.seconds)) return null;
			return { type: "usage.updated", seconds: usage.seconds };
		}
		case "session.closed": {
			const usage = parsed.usage;
			return {
				type: "session.closed",
				...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
				...(isRecord(usage) && isFiniteNumber(usage.seconds) ? { seconds: usage.seconds } : {}),
			};
		}
		case "error": {
			const error = parseErrorEvent(parsed);
			return error?.type === "error" ? { type: "warning", message: error.message } : null;
		}
		default:
			return { type: "unknown", wireType: parsed.type };
	}
}

function utf8ByteLength(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

/** Split context into character-safe chunks of at most 500 UTF-8 bytes. */
export function chunkLiveContext(text: string): string[] {
	if (text.length === 0) return [""];

	const chunks: string[] = [];
	let chunkStart = 0;
	let chunkBytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const characterLength = codePoint > 0xffff ? 2 : 1;
		const characterBytes = utf8ByteLength(codePoint);
		if (chunkBytes + characterBytes > CONTEXT_CHUNK_BYTES) {
			chunks.push(text.slice(chunkStart, index));
			chunkStart = index;
			chunkBytes = 0;
		}
		chunkBytes += characterBytes;
		index += characterLength;
	}
	chunks.push(text.slice(chunkStart));
	return chunks;
}
