import { type AuthStorage, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { isRecord, sleepLong, toError } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { kNoAuth } from "../config/model-provider-discovery";
import type { ScopeLike } from "../config/registry";
import { resolveConfigValue } from "../config/resolve-config-value";
import { generateCodexAttestation } from "./attestation";
import {
	buildLiveSessionPayload,
	buildLiveSessionUpdate,
	buildOpenAILiveSessionRequest,
	type LiveClientMessage,
	type LiveServerEvent,
	parseLiveRecord,
	parseLiveServerEvent,
	parseOpenAILiveServerEvent,
} from "./protocol";
import { cfgLiveApiKey, cfgLiveEndpoint, cfgLiveModel } from "./settings";

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;
/** Proxy scope of a custom live endpoint: `PI_PROXY_LIVE`, else `PI_PROXY`, else the standard variables. */
const LIVE_ENDPOINT_PROXY = "live";
const MAX_ENDPOINT_REDIRECTS = 5;
/** The models.yml provider whose base URL and key the GPT-Live route uses; also its proxy scope. */
const OPENAI_LIVE_PROVIDER = "openai";
/**
 * The session ids GPT-Live hands out (`live_…`): letters, digits, `_` and `-`. An id of any other form
 * is refused before it reaches the sideband URL's path, where `.` and `..` would move it.
 */
const OPENAI_LIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** How much of a redirect's `Location` an error repeats. */
const MAX_LOCATION_LENGTH = 256;
/** Event ids remembered to drop the 3 s replay a sideband attach repeats from the data channel. */
const SEEN_EVENT_IDS_LIMIT = 1_024;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

/** A custom realtime server that replaces Codex for live calls (the `live.endpoint` setting). */
export interface LiveEndpoint {
	/** Base URL the OpenAI Realtime WebRTC paths hang off, e.g. `http://127.0.0.1:8080/v1`. */
	baseUrl: string;
	/** Resolved bearer key, sent only to this endpoint. */
	apiKey?: string;
}

/**
 * The custom endpoint live calls use, with `live.apiKey` resolved like other configured secrets
 * (literal, environment variable name, or `!command`); `undefined` when `live.endpoint` is empty,
 * so calls go to Codex.
 */
export async function resolveLiveEndpoint(scope: ScopeLike): Promise<LiveEndpoint | undefined> {
	const baseUrl = cfgLiveEndpoint.get(scope)?.trim();
	if (!baseUrl) return undefined;
	const keyConfig = cfgLiveApiKey.get(scope)?.trim();
	if (!keyConfig) return { baseUrl };
	const apiKey = await resolveConfigValue(keyConfig);
	if (!apiKey) throw new Error("live.apiKey resolved to no key: its command failed or printed nothing");
	return { baseUrl, apiKey };
}

/** GPT-Live's public API at the `openai` provider of models.yml (`live.provider: openai`). */
export interface OpenAILiveRoute {
	/** The provider's base URL, e.g. `http://model-gateway:4000/v1`; the live paths hang off it. */
	baseUrl: string;
	/** The provider's key, sent as the bearer of the session request and the sideband. */
	apiKey: string;
	/** GPT-Live model (`live.model`). */
	model: string;
}

/** The model registry calls the GPT-Live route needs. */
export type OpenAILiveRegistry = Pick<ModelRegistry, "getProviderBaseUrl" | "getApiKeyForProvider">;

/** The GPT-Live route: the `openai` provider's base URL and key in models.yml, and `live.model`. */
export async function resolveOpenAILiveRoute(
	registry: OpenAILiveRegistry,
	scope: ScopeLike,
	sessionId: string,
): Promise<OpenAILiveRoute> {
	const baseUrl = registry.getProviderBaseUrl(OPENAI_LIVE_PROVIDER)?.trim();
	if (!baseUrl) throw new Error("live.provider openai: the openai provider has no baseUrl (models.yml)");
	const apiKey = await registry.getApiKeyForProvider(OPENAI_LIVE_PROVIDER, sessionId);
	if (!apiKey || apiKey === kNoAuth) {
		throw new Error("live.provider openai: the openai provider has no key (models.yml apiKey)");
	}
	return { baseUrl, apiKey, model: cfgLiveModel.get(scope).trim() || "gpt-live-1.1" };
}

/** GPT-Live's session URL: `{base}/live/sessions`. */
export function openAILiveSessionsUrl(baseUrl: string): string {
	return liveEndpointUrl(baseUrl, "live/sessions").toString();
}

/** GPT-Live's sideband URL: `{base as ws(s)}/live/sessions/{id}/attach`. */
export function openAILiveAttachUrl(baseUrl: string, sessionId: string): string {
	const url = liveEndpointUrl(baseUrl, `live/sessions/${encodeURIComponent(sessionId)}/attach`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

/** Where and with which credentials the call's sideband WebSocket connects. */
interface LiveSideband {
	url: string;
	headers: Record<string, string>;
	proxyScope: string;
}

interface LiveSignalingResult {
	answer: string;
	sideband: LiveSideband;
}

class LiveSignalingError extends Error {
	status: number;
	errorMessage: string;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
		this.errorMessage = message;
	}
}

/** Callbacks emitted by the live WebRTC transport. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Configuration required to establish a live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	/** Custom realtime server; unset signals Codex with the session's ChatGPT (Codex) login. */
	endpoint?: LiveEndpoint;
	/** GPT-Live's public API (`live.provider: openai`); excludes {@link endpoint}. */
	openai?: OpenAILiveRoute;
	/** PulseAudio server for the native peer's speaker (`live.pulseServer`); unset uses the default device. */
	pulseServer?: string;
	sessionId: string;
	instructions: string;
	voice: string;
	callbacks: LiveTransportCallbacks;
	/**
	 * Cancels the connect: an abort while the transport connects cancels the session request and the
	 * sideband's attempts and closes the transport. Once it has connected an abort does nothing; the
	 * caller ends the call (`session.close`) and then {@link LiveTransport.close}s it.
	 */
	signal?: AbortSignal;
	/**
	 * SDP offer from a caller-owned WebRTC peer (one Opus audio track plus an `oai-events`
	 * data channel). When set, no native peer is created: the caller's peer carries the audio,
	 * {@link LiveTransport.sdpAnswer} holds the answer to apply to it, and this transport
	 * keeps only the sideband.
	 */
	sdpOffer?: string;
}

/** Extracts the server-assigned `rtc_*` call ID from a signaling Location header. */
export function parseLiveCallId(location: string | null): string | undefined {
	if (!location) return undefined;
	return location
		.split("?", 1)[0]
		?.split("/")
		.find(segment => LIVE_CALL_ID_PATTERN.test(segment));
}

/** Builds the Frameless Bidi sideband WebSocket URL for an accepted Codex call. */
export function buildLiveSidebandUrl(callId: string): string {
	const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
	url.protocol = "wss:";
	return url.toString();
}

/** Appends `path` to the endpoint base's path, keeping its query (`…/v1` → `…/v1/realtime`). */
function liveEndpointUrl(baseUrl: string, path: string): URL {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
	return url;
}

/** The custom endpoint's signaling URL: `{base}/realtime/calls`. */
export function liveEndpointCallsUrl(baseUrl: string): string {
	return liveEndpointUrl(baseUrl, "realtime/calls").toString();
}

/** The custom endpoint's sideband URL: `{base as ws(s)}/realtime?call_id=<id>`. */
export function liveEndpointSidebandUrl(baseUrl: string, callId: string): string {
	const url = liveEndpointUrl(baseUrl, "realtime");
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("call_id", callId);
	return url.toString();
}

/** Extracts the call ID a custom endpoint names as the last path segment of its Location header. */
export function parseLiveEndpointCallId(location: string | null): string | undefined {
	const segment = location
		?.split(/[?#]/, 1)[0]
		?.split("/")
		.filter(part => part.length > 0)
		.at(-1);
	if (!segment) return undefined;
	try {
		return decodeURIComponent(segment) || undefined;
	} catch {
		return undefined;
	}
}

/** Headers a custom endpoint receives: its own bearer key, never Codex credentials. */
export function liveEndpointHeaders(endpoint: LiveEndpoint): Record<string, string> {
	return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

function liveSessionHeaders(
	access: OAuthAccess,
	sessionId: string,
	realtimeSessionId: string,
	attestation: string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${access.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
		"x-session-id": realtimeSessionId,
		[OPENAI_HEADERS.ORIGINATOR]: LIVE_ORIGINATOR,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		[OPENAI_HEADERS.SCOPED_SESSION_ID]: sessionId,
		[OPENAI_HEADERS.THREAD_ID]: sessionId,
	};
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	if (attestation) headers["x-oai-attestation"] = attestation;
	return headers;
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return statusText || "empty response body";
	if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

/** A redirect's `Location` for an error message, cut to {@link MAX_LOCATION_LENGTH}. */
function boundedLocation(location: string | null): string {
	if (!location) return "nowhere";
	if (location.length <= MAX_LOCATION_LENGTH) return location;
	return `${location.slice(0, MAX_LOCATION_LENGTH)}…`;
}

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

/**
 * WebRTC transport for a live session on Codex (Frameless Bidi), a custom endpoint, or GPT-Live's
 * public API, with a native or caller-owned media peer.
 */
export class LiveTransport {
	readonly #options: LiveTransportOptions;
	/** Prefix of user-facing errors: which server the call talks to. */
	readonly #label: string;
	#peer: LiveWebRtcPeer | undefined;
	#sdpAnswer: string | undefined;
	readonly #realtimeSessionId = crypto.randomUUID();
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#muted = false;
	#unexpectedFailureReported = false;
	/** GPT-Live event ids already delivered, in arrival order; see {@link SEEN_EVENT_IDS_LIMIT}. */
	readonly #seenEventIds = new Set<string>();
	readonly #abortListener: () => void;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#label = options.openai ? "GPT-Live" : options.endpoint ? "Live endpoint" : "Codex live";
		this.#abortListener = () => {
			if (this.#state === "idle" || this.#state === "connecting") void this.close();
		};
		if (!options.signal?.aborted) options.signal?.addEventListener("abort", this.#abortListener, { once: true });
	}

	/** SDP answer for the caller's peer once a {@link LiveTransportOptions.sdpOffer} call has been signaled. */
	get sdpAnswer(): string | undefined {
		return this.#sdpAnswer;
	}

	/** Whether the call is up: signaled, its media channel open and its sideband attached. */
	get connected(): boolean {
		return this.#state === "connected";
	}

	/** Establish the media peer, signal the call, and wait for the data channel or sideband. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed")
			return Promise.reject(new Error("Live transport is closed"));
		if (this.#options.signal?.aborted) return Promise.reject(abortReason(this.#options.signal));
		this.#state = "connecting";
		const operation = this.#connect().catch(async error => {
			await this.close();
			throw error;
		});
		this.#connectPromise = operation;
		return operation;
	}

	async #connect(): Promise<void> {
		let offer = this.#options.sdpOffer;
		let peer: LiveWebRtcPeer | undefined;
		if (offer === undefined) {
			peer = this.#createPeer();
			this.#peer = peer;
			offer = await peer.createOffer();
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		const signaling = await this.#signal(offer);
		if (peer) {
			await peer.acceptAnswer(signaling.answer);
			peer.setMuted(this.#muted);
			await peer.waitForOpen();
		} else {
			this.#sdpAnswer = signaling.answer;
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		await this.#connectSideband(signaling.sideband);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		// A custom endpoint got the bare SDP: the session configuration follows on the sideband.
		if (this.#options.endpoint) {
			const update = buildLiveSessionUpdate(this.#options.instructions, this.#options.voice);
			this.#sideband?.send(JSON.stringify(update));
		}
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
			this.#options.pulseServer,
		);
	}

	async #signal(offer: string): Promise<LiveSignalingResult> {
		if (this.#options.openai) return await this.#signalOpenAI(offer, this.#options.openai);
		if (this.#options.endpoint) return await this.#signalEndpoint(offer, this.#options.endpoint);
		const attestation = await generateCodexAttestation();
		return await withOAuthAccess(
			this.#options.authStorage,
			LIVE_PROVIDER,
			access => this.#signalWithAccess(offer, access, attestation),
			{
				sessionId: this.#options.sessionId,
				signal: this.#options.signal,
				missingAccessMessage: "No Codex OAuth credential is available for a live call.",
			},
		);
	}

	async #signalWithAccess(
		offer: string,
		access: OAuthAccess,
		attestation: string | undefined,
	): Promise<LiveSignalingResult> {
		const headers = new Headers({
			...liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
			Accept: "*/*",
			"Content-Type": "application/json",
		});
		const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);
		const response = await fetchImpl(SIGNALING_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sdp: offer,
				session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice),
			}),
			signal: this.#options.signal,
		});
		const responseBody = await response.text();
		if (!response.ok) {
			const detail = boundedErrorBody(responseBody, response.statusText);
			throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${detail}`);
		}
		const answer = responseBody;
		if (!answer.trim())
			throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
		const callId = parseLiveCallId(response.headers.get("location"));
		if (!callId) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
		}
		const sideband = {
			url: buildLiveSidebandUrl(callId),
			headers: liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
			proxyScope: LIVE_PROVIDER,
		};
		return { answer, sideband };
	}

	/**
	 * Signals a custom endpoint the OpenAI Realtime WebRTC way: the bare SDP offer, the endpoint's
	 * own key, and only same-origin 307/308 redirects followed, so the key never leaves its origin.
	 */
	async #signalEndpoint(offer: string, endpoint: LiveEndpoint): Promise<LiveSignalingResult> {
		const credentials = liveEndpointHeaders(endpoint);
		let url = new URL(liveEndpointCallsUrl(endpoint.baseUrl));
		const origin = url.origin;
		for (let redirects = 0; ; redirects++) {
			this.#options.signal?.throwIfAborted();
			const response = await fetch(url, {
				method: "POST",
				headers: { ...credentials, "Content-Type": "application/sdp" },
				body: offer,
				redirect: "manual",
				proxy: getProxyForUrl(LIVE_ENDPOINT_PROXY, url),
				signal: this.#options.signal,
			});
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const target = location ? new URL(location, url) : undefined;
				const preservesPost = response.status === 307 || response.status === 308;
				if (!target || !preservesPost || target.origin !== origin || redirects >= MAX_ENDPOINT_REDIRECTS) {
					throw new LiveSignalingError(
						response.status,
						`Live endpoint signaling was redirected (${response.status}) to ${boundedLocation(location)}; ` +
							"only same-origin 307/308 redirects are followed",
					);
				}
				url = target;
				continue;
			}
			const answer = await response.text();
			if (!response.ok) {
				const detail = boundedErrorBody(answer, response.statusText);
				throw new LiveSignalingError(
					response.status,
					`Live endpoint signaling failed (${response.status}): ${detail}`,
				);
			}
			if (!answer.trim()) {
				throw new LiveSignalingError(response.status, "Live endpoint signaling returned an empty SDP answer");
			}
			const callId = parseLiveEndpointCallId(location);
			if (!callId) {
				throw new LiveSignalingError(response.status, "Live endpoint signaling returned no call ID in Location");
			}
			const sideband = {
				url: liveEndpointSidebandUrl(endpoint.baseUrl, callId),
				headers: credentials,
				proxyScope: LIVE_ENDPOINT_PROXY,
			};
			return { answer, sideband };
		}
	}

	/**
	 * Opens a GPT-Live session through its public API: the session configuration and the SDP offer in
	 * one JSON request with the provider's bearer key and no Codex header, answered by a 201 naming the
	 * session and carrying the SDP answer. No redirect is followed, so the key stays at the provider.
	 */
	async #signalOpenAI(offer: string, route: OpenAILiveRoute): Promise<LiveSignalingResult> {
		const credentials = { Authorization: `Bearer ${route.apiKey}` };
		const url = new URL(openAILiveSessionsUrl(route.baseUrl));
		const body = buildOpenAILiveSessionRequest({
			model: route.model,
			instructions: this.#options.instructions,
			voice: this.#options.voice,
			sdp: offer,
		});
		const response = await fetch(url, {
			method: "POST",
			headers: { ...credentials, Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify(body),
			redirect: "manual",
			proxy: getProxyForUrl(OPENAI_LIVE_PROVIDER, url),
			signal: this.#options.signal,
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new LiveSignalingError(
				response.status,
				`GPT-Live session request was redirected (${response.status}) to ${boundedLocation(response.headers.get("location"))}; no redirect is followed`,
			);
		}
		const text = await response.text();
		if (!response.ok) {
			const detail = boundedErrorBody(text, response.statusText);
			throw new LiveSignalingError(response.status, `GPT-Live session failed (${response.status}): ${detail}`);
		}
		const answer = parseLiveRecord(text);
		const sessionId = isRecord(answer?.session) ? answer.session.id : undefined;
		if (typeof sessionId !== "string" || !sessionId) {
			throw new LiveSignalingError(response.status, "GPT-Live session returned no session id");
		}
		if (!OPENAI_LIVE_SESSION_ID_PATTERN.test(sessionId)) {
			throw new LiveSignalingError(
				response.status,
				`GPT-Live session returned an invalid session id (${JSON.stringify(sessionId.slice(0, 64))}); ids hold only letters, digits, "_" and "-"`,
			);
		}
		const sdp = isRecord(answer?.transport) ? answer.transport.sdp : undefined;
		if (typeof sdp !== "string" || !sdp.trim()) {
			throw new LiveSignalingError(response.status, "GPT-Live session returned no SDP answer");
		}
		const sideband = {
			url: openAILiveAttachUrl(route.baseUrl, sessionId),
			headers: credentials,
			proxyScope: OPENAI_LIVE_PROVIDER,
		};
		return { answer: sdp, sideband };
	}

	async #connectSideband(sideband: LiveSideband): Promise<void> {
		let failure = new Error(`${this.#label} sideband connection failed`);
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
			try {
				await this.#openSideband(sideband);
				return;
			} catch (cause) {
				failure = toError(cause);
				if (this.#state !== "connecting") throw abortReason(this.#options.signal);
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await sleepLong(200 * 2 ** attempt, this.#options.signal);
			}
		}
		throw failure;
	}

	async #openSideband(sideband: LiveSideband): Promise<void> {
		const options = {
			headers: sideband.headers,
			proxy: getProxyForUrl(sideband.proxyScope, new URL(sideband.url)),
		} satisfies Bun.WebSocketOptions;
		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [sideband.url, options]);
		socket.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			this.#options.signal?.removeEventListener("abort", onAbort);
		};
		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			socket.close(1000, "aborted");
			rejectConnect(abortReason(this.#options.signal));
		};
		socket.onopen = () => {
			// A socket that opens after a stop (the transport is closing) is closed, never kept.
			if (settled || this.#state !== "connecting") {
				socket.close(1000, "stale");
				rejectConnect(abortReason(this.#options.signal));
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.#sideband = socket;
			resolve();
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure(`${this.#label} sideband returned an unexpected binary frame.`);
				return;
			}
			this.#handleSidebandEvent(event.data);
		};
		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`${this.#label} sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportFailure(`${this.#label} sideband failed${detail}`);
		};
		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`${this.#label} sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportFailure(`${this.#label} sideband closed (${event.code})${detail}`);
			}
		};
		if (this.#options.signal?.aborted) {
			onAbort();
		} else {
			this.#options.signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				socket.close(1000, "connect timeout");
				rejectConnect(new Error(`${this.#label} sideband connection timed out`));
			}, SIDEBAND_CONNECT_TIMEOUT_MS);
			timeout.unref?.();
		}
		await promise;
	}

	#handleSidebandEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = this.#parseEvent(payload);
		if (!event) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleServerEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const sidebandOpen = this.#sideband?.readyState === WebSocket.OPEN;
		// GPT-Live sends every event on both channels; once attached, the sideband carries them all.
		if (sidebandOpen && this.#options.openai) return;
		const event = this.#parseEvent(payload);
		if (!event || (sidebandOpen && event.type !== "error")) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	/**
	 * Parses one event for this route. A GPT-Live sideband replays the 3 s before it attached, which
	 * the data channel already delivered, so an event id seen before is dropped.
	 */
	#parseEvent(payload: string): LiveServerEvent | null {
		if (!this.#options.openai) return parseLiveServerEvent(payload);
		const record = parseLiveRecord(payload);
		if (!record) return null;
		const eventId = record.event_id;
		if (typeof eventId === "string") {
			if (this.#seenEventIds.has(eventId)) return null;
			this.#seenEventIds.add(eventId);
			if (this.#seenEventIds.size > SEEN_EVENT_IDS_LIMIT) {
				for (const oldest of this.#seenEventIds) {
					this.#seenEventIds.delete(oldest);
					break;
				}
			}
		}
		return parseOpenAILiveServerEvent(record);
	}

	#handleOutputLevel(level: number): void {
		if (this.#state !== "connected" || !Number.isFinite(level)) return;
		try {
			this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
		} catch {}
	}

	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message });
		} catch {}
	}

	/** Serialize one Frameless Bidi control message onto the call's sideband WebSocket. */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Live transport is not connected");
			const sideband = this.#sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error(`${this.#label} sideband is not connected`);
			}
			sideband.send(JSON.stringify(message));
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

	/** Stop sideband signaling and the native WebRTC media peer. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		const sideband = this.#sideband;
		const peer = this.#peer;
		this.#sideband = undefined;
		this.#peer = undefined;
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
