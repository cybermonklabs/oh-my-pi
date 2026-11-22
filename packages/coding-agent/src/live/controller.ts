import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { expandTilde, logger, prompt, toError } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../session/messages";
import { LiveCallTranscript, type TranscriptLine } from "./call-transcript";
import agentFinalMessageTemplate from "./prompts/agent-final-message.md" with { type: "text" };
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };
import liveSpokenRequestTemplate from "./prompts/live-spoken-request.md" with { type: "text" };
import {
	buildSessionClose,
	CODEX_LIVE_WIRE,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveServerEvent,
	type LiveWire,
	OPENAI_LIVE_WIRE,
} from "./protocol";
import { OUTPUT_ACTIVE_LEVEL, OutputActivity } from "./output-activity";
import { cfgLiveInstructionsFile, cfgLiveProvider, cfgLivePulseServer } from "./settings";
import {
	type LiveEndpoint,
	LiveTransport,
	type OpenAILiveRoute,
	resolveLiveEndpoint,
	resolveOpenAILiveRoute,
} from "./transport";
import type { LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { DEFAULT_LIVE_VOICE } from "./voices";

const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
/** How long a GPT-Live delegation waits for the transcript to reach its offset before it is sent anyway. */
const DELEGATION_TRANSCRIPT_WAIT_MS = 3_000;
/** A GPT-Live call ends by itself after this long with no speech from the user. */
const QUIET_LIMIT_MS = 15 * 60_000;
/** How long omp waits for GPT-Live's `session.closed` after `session.close` before it closes the sideband. */
const SESSION_CLOSED_WAIT_MS = 5_000;
/** Request text of a delegation that no transcript reached before it was sent. */
const NO_WORDS_REQUEST = "(no words reached omp for this request)";

/** Custom message the session gets when a GPT-Live call ends: the call's start, end and transcript file. */
export const LIVE_CALL_END_MESSAGE_TYPE = "live-call-end";

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports connection and activity phase changes. */
	onPhase(phase: LivePhase): void;
	/** Reports clamped microphone and speaker RMS levels. */
	onLevels(input: number, output: number): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/** Reports one terminal stop, optionally carrying its cause. */
	onTerminal(error?: Error): void;
}

/** Dependencies and presentation callbacks for a live session. */
export interface LiveSessionControllerOptions {
	/** Agent session that performs all delegated coding work. */
	session: AgentSession;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Extracts visible assistant text using the caller's normal UI rules. */
	extractAssistantText(message: AssistantMessage): string;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/**
	 * Handlebars template replacing the bundled live instructions; rendered with
	 * `{ username, firstName }` like the bundled prompt.
	 */
	instructions?: string;
	/**
	 * SDP offer from a caller-owned WebRTC peer that carries the microphone and speaker audio
	 * (see `LiveTransportOptions.sdpOffer`). When set, no host microphone or speaker is opened;
	 * the caller applies {@link LiveSessionController.sdpAnswer} to its peer after `start()`
	 * and handles echo cancellation itself. There is no host track to mute: `toggleMute` only
	 * moves the phase to `muted`, and the caller must silence its own microphone track while the
	 * phase is `muted`. Levels are not reported in this mode.
	 */
	sdpOffer?: string;
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

function microphoneLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return clampLevel(Math.sqrt(sumSquares / samples.length));
}

function currentUser(): { username: string; firstName: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstPart = username.split(/[._\-\s]+/).find(part => part.length > 0);
	return { username, firstName: firstPart ?? "there" };
}

/** Coordinates the realtime conversational surface with normal AgentSession turns. */
export class LiveSessionController {
	readonly #session: AgentSession;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #voice: string;
	readonly #instructionsTemplate: string;
	readonly #sdpOffer: string | undefined;

	#transport: LiveTransport | undefined;
	/** The custom server set by `live.endpoint`, resolved at start; unset uses Codex. */
	#endpoint: LiveEndpoint | undefined;
	#recorder: AudioCapture | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#sendChain: Promise<void> = Promise.resolve();
	#stopPromise: Promise<void> | undefined;
	#started = false;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;
	#muted = false;
	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	/** Last pair passed to `onLevels`; repeated identical levels are not re-emitted. */
	#emittedInputLevel = -1;
	#emittedOutputLevel = -1;
	#activeDelegationId: string | undefined;
	#userTranscript = "";
	#assistantTranscript = "";
	#userTranscriptFinal = false;
	#assistantTranscriptFinal = false;
	#userTranscriptTurn = 0;
	#assistantTranscriptTurn = 0;
	#lastTranscript: LiveTranscript | undefined;
	readonly #outputActivity = new OutputActivity(() =>
		this.#guardEvent(() => {
			if (!this.#activeDelegationId) this.#refreshAudioPhase();
		}),
	);
	/** How a delegation's progress and result reach the voice: Codex's context appends or GPT-Live's. */
	#wire: LiveWire = CODEX_LIVE_WIRE;
	/** The words of a GPT-Live call (`live.provider: openai`); unset on Codex, which sends request text itself. */
	#callTranscript: LiveCallTranscript | undefined;
	/** GPT-Live delegations waiting for the transcript to reach their offset, oldest first. */
	#pendingDelegations: { id: string; offsetMs: number; expired: boolean; timer: NodeJS.Timeout }[] = [];
	#quietTimer: NodeJS.Timeout | undefined;
	/** Resolves when GPT-Live reports `session.closed`. */
	readonly #sessionClosed = Promise.withResolvers<void>();
	#sessionClosedReceived = false;
	#callStartedAt: Date | undefined;
	/** Why a GPT-Live call ended, for the end message, when something other than a stop request ended it. */
	#endReason: string | undefined;
	#usageSeconds: number | undefined;
	/** Aborted by {@link stop}: cancels a connect still in progress (the session request, the sideband's attempts). */
	readonly #connectAbort = new AbortController();

	constructor(options: LiveSessionControllerOptions) {
		this.#session = options.session;
		this.#callbacks = options.callbacks;
		this.#extractAssistantText = options.extractAssistantText;
		this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
		this.#instructionsTemplate = options.instructions ?? liveInstructionsTemplate;
		this.#sdpOffer = options.sdpOffer;
	}

	/** Current realtime call phase. */
	get phase(): LivePhase {
		return this.#phase;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/**
	 * SDP answer for the caller's peer in an `sdpOffer` session. It exists as soon as the offer is
	 * signaled, before the control socket connects, so apply it only after `start()` resolves.
	 */
	get sdpAnswer(): string | undefined {
		return this.#transport?.sdpAnswer;
	}

	/** Connects the realtime surface and starts microphone streaming (or, with `sdpOffer`, only signaling). */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitPhase("connecting", true);
		this.#emitTranscript(undefined);
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped while starting.");
		}

		try {
			const settings = this.#session.settings;
			this.#endpoint = await resolveLiveEndpoint(settings);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while starting.");
			}
			const viaOpenAI = cfgLiveProvider.get(settings) === "openai";
			if (viaOpenAI && this.#endpoint) {
				throw new Error(
					"live.endpoint and live.provider: openai cannot both be set: live.endpoint names a Realtime server, live.provider: openai the openai provider's GPT-Live API",
				);
			}
			const instructions = await this.#renderInstructions();
			let openai: OpenAILiveRoute | undefined;
			if (viaOpenAI) {
				openai = await resolveOpenAILiveRoute(this.#session.modelRegistry, settings, this.#session.sessionId);
				this.#callTranscript = new LiveCallTranscript(await this.#transcriptPath(), (line, final) =>
					this.#showTranscriptLine(line, final),
				);
				this.#wire = OPENAI_LIVE_WIRE;
			}
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while starting.");
			}
			const pulseServer = cfgLivePulseServer.get(settings)?.trim() || undefined;
			const transport = new LiveTransport({
				authStorage: this.#session.modelRegistry.authStorage,
				endpoint: this.#endpoint,
				openai,
				pulseServer,
				sessionId: this.#session.sessionId,
				instructions,
				voice: this.#voice,
				sdpOffer: this.#sdpOffer,
				signal: this.#connectAbort.signal,
				callbacks: {
					onEvent: event => this.#receiveLiveEvent(event),
					onOutputLevel: level => this.#guardEvent(() => this.#handleOutputLevel(level)),
				},
			});
			this.#transport = transport;
			await transport.connect();
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while connecting.");
			}
			if (this.#callTranscript) {
				this.#callStartedAt = new Date();
				this.#armQuietLimit();
			}
			this.#unsubscribeSession = this.#session.subscribe(event =>
				this.#guardEvent(() => this.#handleSessionEvent(event)),
			);
			if (this.#muted) await transport.setMuted(true);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped before recording began.");
			}
			if (this.#sdpOffer !== undefined) {
				this.#refreshAudioPhase();
				return;
			}
			const recorder = new AudioCapture(
				16_000,
				(error, samples) => {
					if (error) {
						this.#reportFailure(error);
						return;
					}
					this.#handleMicrophoneAudio(samples);
				},
				pulseServer,
			);
			if (this.#stopped) {
				try {
					recorder.stop();
				} catch {
					// Preserve the failure that stopped startup.
				}
				throw this.#failure ?? new Error("The live session stopped while recording began.");
			}
			this.#recorder = recorder;
			this.#refreshAudioPhase();
		} catch (cause) {
			const error = toError(cause);
			this.#reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		// Remote audio reports no levels, so a mute must not emit a `(0, 0)` pair either.
		if (this.#muted && this.#sdpOffer === undefined) {
			this.#inputLevel = 0;
			this.#emitLevels();
		}
		this.#refreshAudioPhase();
		const transport = this.#transport;
		if (transport) {
			void transport.setMuted(this.#muted).catch(cause => this.#reportFailure(toError(cause)));
		}
	}

	/** Stops recording, closes the live session, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		const endedAt = new Date();
		this.#stopped = true;
		// A stop during the start cancels the connect: no session request or sideband attempt goes on after it.
		this.#connectAbort.abort(new Error("The live call was stopped while it connected"));
		clearTimeout(this.#quietTimer);
		// No delegation is dropped: one still waiting for its transcript becomes a turn now.
		for (const pending of this.#pendingDelegations) pending.expired = true;
		this.#flushDelegations();
		this.#outputActivity.dispose();
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		let cleanupError: Error | undefined;

		const recorder = this.#recorder;
		this.#recorder = undefined;
		if (recorder) {
			try {
				recorder.stop();
			} catch (cause) {
				cleanupError = toError(cause);
			}
		}

		await this.#sendChain;
		const transport = this.#transport;
		this.#transport = undefined;
		let closeConfirmed = this.#sessionClosedReceived;
		if (transport) {
			// Only a call that is up can be told to close; a connect the stop cancelled has no sideband.
			if (transport.connected && !this.#sessionClosedReceived) {
				try {
					await transport.send(buildSessionClose());
					// GPT-Live finalizes the call (its usage) only once `session.closed` arrives.
					if (this.#callTranscript) closeConfirmed = await this.#waitForSessionClosed();
				} catch (cause) {
					cleanupError ??= toError(cause);
				}
			}
			try {
				await transport.close();
			} catch (cause) {
				cleanupError ??= toError(cause);
			}
		}
		await this.#reportCallEnd(endedAt, closeConfirmed);

		if (cleanupError) this.#emitPhaseSafely("error");
		this.#emitTerminal(cleanupError);
	}

	/** Waits up to {@link SESSION_CLOSED_WAIT_MS} for `session.closed`; true when it came. */
	async #waitForSessionClosed(): Promise<boolean> {
		const timedOut = Promise.withResolvers<false>();
		const timer = setTimeout(() => timedOut.resolve(false), SESSION_CLOSED_WAIT_MS);
		const closed = await Promise.race([this.#sessionClosed.promise.then(() => true as const), timedOut.promise]);
		clearTimeout(timer);
		return closed;
	}

	/** Finishes a GPT-Live call's transcript file and tells the session where it is and when the call ran. */
	async #reportCallEnd(endedAt: Date, closeConfirmed: boolean): Promise<void> {
		const transcript = this.#callTranscript;
		const startedAt = this.#callStartedAt;
		if (!transcript || !startedAt) return;
		await transcript.finish();
		const reason = this.#endReason ?? (this.#failure ? `it failed: ${this.#failure.message}` : "it was stopped");
		const usage = this.#usageSeconds === undefined ? "" : `, ${this.#usageSeconds} s of voice time`;
		const notes = [
			transcript.writeFailed ? "Some lines could not be written to it." : "",
			closeConfirmed
				? ""
				: `GPT-Live sent no session.closed within ${SESSION_CLOSED_WAIT_MS / 1000} s, so its final usage is unconfirmed.`,
		].filter(Boolean);
		const content = [
			`The live voice call ended: ${reason}. It ran from ${startedAt.toISOString()} to ${endedAt.toISOString()}${usage}.`,
			`Its transcript, each line with its UTC time, is in ${transcript.path}.`,
			...notes,
		].join(" ");
		await this.#session
			.sendCustomMessage(
				{ customType: LIVE_CALL_END_MESSAGE_TYPE, content, display: true, attribution: "agent" },
				{ deliverAs: "nextTurn" },
			)
			.catch(cause => logger.warn("Live call end message was not delivered", { error: toError(cause).message }));
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	/**
	 * Every transport event lands here. `session.closed` is noted even while the call stops (the stop
	 * waits for it), and words the voice still says while it closes go to the transcript file.
	 */
	#receiveLiveEvent(event: LiveServerEvent): void {
		if (event.type === "session.closed") {
			this.#sessionClosedReceived = true;
			this.#sessionClosed.resolve();
		}
		if (this.#stopped) {
			if (event.type === "transcript.delta") this.#callTranscript?.add(event);
			return;
		}
		this.#guardEvent(() => this.#handleLiveEvent(event));
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				// Mute wins over server-driven phases: a remote peer treats any other phase as unmuted.
				this.#refreshAudioPhase();
				break;
			case "session.updated":
			case "output_audio.delta":
			case "unknown":
				break;
			case "input_transcript.added":
				this.#addTranscript("user", event.item.text);
				break;
			case "output_transcript.added":
				this.#addTranscript("assistant", event.item.text);
				break;
			case "turn.done":
				this.#finishTranscript(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				this.#handleDelegation(event);
				break;
			case "error":
				this.#reportFailure(new Error(event.message));
				break;
			case "transcript.delta":
				this.#callTranscript?.add(event);
				if (event.role === "user") this.#armQuietLimit();
				this.#flushDelegations();
				break;
			case "delegation.requested":
				this.#queueDelegation(event.id, event.offsetMs);
				break;
			case "usage.updated":
				this.#usageSeconds = event.seconds;
				break;
			case "session.closed": {
				const reason = event.reason ?? "no reason given";
				this.#endReason = `GPT-Live closed it (${reason})`;
				this.#reportFailure(new Error(`GPT-Live closed the live call: ${reason}`));
				break;
			}
			case "warning":
				logger.warn("GPT-Live rejected a command or cut its speech", { message: event.message });
				break;
		}
	}

	#handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
		let request = "";
		for (const content of event.item.content) {
			if (content.type !== "input_text") continue;
			request += `${request ? "\n" : ""}${content.text}`;
		}
		request = request.trim();
		if (!request) return;
		this.#startDelegatedTurn(event.item.id, request);
	}

	/**
	 * A GPT-Live delegation names only its offset on the session timeline, and the transcript of the
	 * user's words before it can still be on its way; it waits until the user's own transcript reaches
	 * the offset, or {@link DELEGATION_TRANSCRIPT_WAIT_MS}, and becomes a turn either way.
	 */
	#queueDelegation(id: string, offsetMs: number): void {
		this.#callTranscript?.endLine();
		const pending = {
			id,
			offsetMs,
			expired: false,
			timer: setTimeout(() => {
				pending.expired = true;
				this.#guardEvent(() => this.#flushDelegations());
			}, DELEGATION_TRANSCRIPT_WAIT_MS),
		};
		this.#pendingDelegations.push(pending);
		this.#flushDelegations();
	}

	/** Sends, oldest first, each waiting delegation whose transcript has arrived or whose wait is over. */
	#flushDelegations(): void {
		const transcript = this.#callTranscript;
		if (!transcript) return;
		for (let next = this.#pendingDelegations[0]; next; next = this.#pendingDelegations[0]) {
			if (!next.expired && !transcript.reached(next.offsetMs)) return;
			this.#pendingDelegations.shift();
			clearTimeout(next.timer);
			const lines = transcript.takeRequest(next.offsetMs);
			const request = prompt.render(liveSpokenRequestTemplate, {
				transcript: lines.length > 0 ? lines.join("\n") : NO_WORDS_REQUEST,
			});
			this.#startDelegatedTurn(next.id, request);
		}
	}

	#startDelegatedTurn(delegationId: string, request: string): void {
		this.#activeDelegationId = delegationId;
		this.#refreshAudioPhase();
		void this.#session
			.sendCustomMessage(
				{
					customType: LIVE_DELEGATION_MESSAGE_TYPE,
					content: request,
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: true },
			)
			.catch(cause => this.#reportFailure(toError(cause)));
	}

	/** (Re)starts the quiet limit: a GPT-Live call with no speech from the user for {@link QUIET_LIMIT_MS} ends. */
	#armQuietLimit(): void {
		clearTimeout(this.#quietTimer);
		this.#quietTimer = setTimeout(() => {
			if (this.#stopped) return;
			this.#endReason = `${QUIET_LIMIT_MS / 60_000} minutes passed with no speech from the user`;
			void this.stop();
		}, QUIET_LIMIT_MS);
	}

	/** Shows a GPT-Live transcript line in the live UI: growing while the speaker talks, final once it ends. */
	#showTranscriptLine(line: TranscriptLine, final: boolean): void {
		if (this.#stopped) return;
		if (final) this.#finishTranscript(line.role, line.text);
		else this.#addTranscript(line.role, line.text);
	}

	/** The voice model's instructions: the template rendered for the user, then `live.instructionsFile`'s text. */
	async #renderInstructions(): Promise<string> {
		const instructions = prompt.render(this.#instructionsTemplate, currentUser());
		const file = cfgLiveInstructionsFile.get(this.#session.settings)?.trim();
		if (!file) return instructions;
		let extra: string;
		try {
			extra = (await Bun.file(path.resolve(expandTilde(file))).text()).trim();
		} catch (cause) {
			throw new Error(`live.instructionsFile ${file} could not be read: ${toError(cause).message}`);
		}
		return extra ? `${instructions}\n\n${extra}` : instructions;
	}

	/**
	 * Where the call's transcript goes: among the session's artifacts, or in the temp dir for an unsaved
	 * session. {@link LiveCallTranscript} creates the file, owner-readable only, once the call has words.
	 */
	async #transcriptPath(): Promise<string> {
		const allocated = await this.#session.sessionManager.allocateArtifactPath("live-transcript");
		return (
			allocated.path ?? path.join(os.tmpdir(), `omp-live-transcript-${this.#session.sessionId}-${Date.now()}.log`)
		);
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "toolUse") this.#appendProgress(event.message);
			return;
		}
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		this.#appendFinalResponse(event.messages);
	}

	#appendProgress(message: AssistantMessage): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		const progress = this.#extractAssistantText(message).trim();
		if (!progress) return;
		for (const chunk of chunkLiveContext(progress)) {
			this.#queueSend(this.#wire.progress(delegationId, chunk));
		}
	}

	#appendFinalResponse(messages: readonly AgentMessage[]): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			const text = this.#extractAssistantText(message).trim();
			if (!text) continue;
			const finalContext = prompt.render(agentFinalMessageTemplate, { message: text });
			for (const chunk of chunkLiveContext(finalContext)) {
				this.#queueSend(this.#wire.result(delegationId, chunk));
			}
			break;
		}
		this.#activeDelegationId = undefined;
		this.#refreshAudioPhase();
	}

	#handleOutputLevel(level: number): void {
		this.#outputLevel = clampLevel(level);
		this.#outputActivity.observe(this.#outputLevel);
		this.#emitLevels();
		if (!this.#activeDelegationId) this.#refreshAudioPhase();
	}

	#handleMicrophoneAudio(samples: Float32Array): void {
		if (this.#stopped || !this.#transport) return;
		if (this.#muted) return;
		this.#inputLevel = microphoneLevel(samples);
		this.#emitLevels();
		const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
		const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
		if (outputActive && this.#inputLevel < echoThreshold) return;
		try {
			this.#transport.pushAudio(samples);
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.#startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.#startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = current + text;
		}
		this.#storeTranscript(role, next, false);
	}

	#finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		if (!current) {
			this.#startTranscriptTurn(role);
		} else if (wasFinal) {
			if (text === current) return;
			this.#startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.#storeTranscript(role, next, true);
	}

	#startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") {
			this.#userTranscriptTurn += 1;
		} else {
			this.#assistantTranscriptTurn += 1;
		}
	}

	#storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
		if (role === "user") {
			this.#userTranscript = normalized;
			this.#userTranscriptFinal = final;
		} else {
			this.#assistantTranscript = normalized;
			this.#assistantTranscriptFinal = final;
		}
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn &&
			this.#lastTranscript.text === normalized &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		this.#emitTranscript({ role, turn, text: normalized, final });
	}

	#queueSend(message: LiveClientMessage): void {
		const transport = this.#transport;
		if (!transport || this.#stopped) return;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (!this.#stopped) await transport.send(message);
			})
			.catch(cause => this.#reportFailure(toError(cause)));
	}

	#refreshAudioPhase(): void {
		if (this.#stopped) return;
		if (this.#muted) {
			this.#emitPhase("muted");
		} else if (this.#activeDelegationId) {
			this.#emitPhase("working");
		} else if (this.#outputActivity.active) {
			this.#emitPhase("speaking");
		} else {
			this.#emitPhase("listening");
		}
	}

	#emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.#phase === phase) return;
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#emitPhaseSafely(phase: LivePhase): void {
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitLevels(): void {
		if (this.#inputLevel === this.#emittedInputLevel && this.#outputLevel === this.#emittedOutputLevel) return;
		const input = this.#inputLevel;
		const output = this.#outputLevel;
		try {
			this.#callbacks.onLevels(input, output);
			this.#emittedInputLevel = input;
			this.#emittedOutputLevel = output;
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted) return;
		this.#failure = error;
		this.#emitPhaseSafely("error");
		this.#emitTerminal(error);
		void this.stop();
	}

	#emitTerminal(error?: Error): void {
		if (this.#terminalEmitted) return;
		this.#terminalEmitted = true;
		try {
			this.#callbacks.onTerminal(error);
		} catch {
			// Nothing remains above the terminal callback to receive its error.
		}
	}
}
