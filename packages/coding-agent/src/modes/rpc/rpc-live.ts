/**
 * GPT live voice sessions for RPC mode: binds a {@link LiveSessionController} to the
 * RPC AgentSession (so delegated work runs with the host's tools) and forwards its
 * callbacks as unsolicited `live_*` frames.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { toError } from "@oh-my-pi/pi-utils";
import { LiveSessionController, type LiveSessionControllerOptions } from "../../live/controller";
import { cfgLiveProvider, resolveLiveVoice } from "../../live/settings";
import type { AgentSession } from "../../session/agent-session";
import type { LiveCallStatus, SlashCommandLiveHost } from "../../slash-commands/types";
import type { RpcLiveFrame } from "./rpc-types";

/** Minimum spacing between `live_levels` frames. */
export const RPC_LIVE_LEVELS_INTERVAL_MS = 100;

/** The controller surface the RPC bridge drives. */
export type RpcLiveSession = Pick<LiveSessionController, "start" | "stop" | "toggleMute" | "muted" | "sdpAnswer">;

/** Builds the controller for one live session; tests substitute a fake. */
export type RpcLiveSessionFactory = (options: LiveSessionControllerOptions) => RpcLiveSession;

/** `live_start` / `live_connect` parameters. */
export interface RpcLiveStartOptions {
	voice?: string;
	instructions?: string;
	/** Caller-owned WebRTC offer (`live_connect`); the result then carries the SDP answer. */
	sdpOffer?: string;
}

/**
 * A started live session: the voice in use, plus the SDP answer for an `sdpOffer` session. No voice on
 * GPT-Live's API (`live.provider: openai`), which gets none from omp.
 */
export interface RpcLiveStartResult {
	voice?: string;
	sdpAnswer?: string;
}

/** How the RPC host builds and gates the live sessions of its bridge. */
export interface RpcLiveBridgeOptions {
	/** Builds the controller for one live session; defaults to the real {@link LiveSessionController}. */
	createSession?: RpcLiveSessionFactory;
	/** Minimum spacing between `live_levels` frames. */
	levelsIntervalMs?: number;
	/**
	 * Why the host cannot start a live session now (dictation records, the session is changing or
	 * shutting down), or `undefined` when it can. Read at every start, from a `live_start` frame and
	 * from a typed `/live on` alike.
	 */
	startRefusal?: () => string | undefined;
}

/** Visible assistant text: text blocks only, no thinking or tool calls. Shared with interactive mode. */
export function extractVisibleAssistantText(message: AssistantMessage): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim();
}

/** Owns at most one live session for an RPC server; `/live on|off|status` drives it as the host's live call. */
export class RpcLiveBridge implements SlashCommandLiveHost {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcLiveFrame) => void;
	readonly #createSession: RpcLiveSessionFactory;
	readonly #levelsIntervalMs: number;
	readonly #startRefusal: () => string | undefined;

	/** Set from construction until the controller has fully stopped (connecting, active, closing). */
	#controller: RpcLiveSession | undefined;
	/** The current session's provider, voice and start, and whether it has connected. */
	#call: { provider: string; voice: string | undefined; since: Date; open: boolean } | undefined;
	#closing: Promise<void> | undefined;
	#pendingLevels: { input: number; output: number } | undefined;
	#levelsTimer: NodeJS.Timeout | undefined;
	#lastLevelsAt = Number.NEGATIVE_INFINITY;

	constructor(session: AgentSession, output: (frame: RpcLiveFrame) => void, options: RpcLiveBridgeOptions = {}) {
		this.#session = session;
		this.#output = output;
		this.#createSession = options.createSession ?? (sessionOptions => new LiveSessionController(sessionOptions));
		this.#levelsIntervalMs = options.levelsIntervalMs ?? RPC_LIVE_LEVELS_INTERVAL_MS;
		this.#startRefusal = options.startRefusal ?? (() => undefined);
	}

	/** Whether a session is connecting, active, or closing. */
	get active(): boolean {
		return this.#controller !== undefined;
	}

	/** Connects a live session and resolves once it is recording (or, with `sdpOffer`, once the call is signaled). */
	async start(options: RpcLiveStartOptions = {}): Promise<RpcLiveStartResult> {
		if (this.#controller) throw new Error("A live session is already active");
		const refusal = this.#startRefusal();
		if (refusal) throw new Error(refusal);
		const voice = resolveLiveVoice(this.#session.settings, options.voice);
		let terminated = false;
		const controller = this.#createSession({
			session: this.#session,
			extractAssistantText: extractVisibleAssistantText,
			voice,
			instructions: options.instructions,
			sdpOffer: options.sdpOffer,
			callbacks: {
				onPhase: phase => this.#output({ type: "live_phase", phase }),
				onLevels: (input, output) => {
					if (!terminated) this.#queueLevels(input, output);
				},
				onTranscript: transcript => {
					if (!transcript) return;
					this.#output({
						type: "live_transcript",
						role: transcript.role,
						turn: transcript.turn,
						text: transcript.text,
						final: transcript.final,
					});
				},
				onTerminal: error => {
					if (terminated) return;
					terminated = true;
					this.#flushLevels();
					this.#output(error ? { type: "live_end", error: error.message } : { type: "live_end" });
					this.#retire(controller);
				},
			},
		});
		this.#controller = controller;
		const call = { provider: cfgLiveProvider.get(this.#session.settings), voice, since: new Date(), open: false };
		this.#call = call;
		try {
			await controller.start();
		} catch (cause) {
			await this.#retire(controller);
			throw toError(cause);
		}
		call.open = true;
		const started = voice === undefined ? {} : { voice };
		if (options.sdpOffer === undefined) return started;
		const sdpAnswer = controller.sdpAnswer;
		if (sdpAnswer === undefined) {
			await this.#retire(controller);
			throw new Error("The live session stopped before its SDP answer was available");
		}
		return { ...started, sdpAnswer };
	}

	/** Stops the active session; resolves once it has stopped. No-op without one. */
	async stop(): Promise<void> {
		const controller = this.#controller;
		if (!controller) return;
		await this.#retire(controller);
	}

	/** Sets (or toggles when omitted) microphone mute. */
	setMuted(muted?: boolean): { muted: boolean } {
		const controller = this.#controller;
		if (!controller || this.#closing) throw new Error("No live session is active");
		if (muted === undefined || muted !== controller.muted) controller.toggleMute();
		return { muted: controller.muted };
	}

	/** The live call as `/live status` reports it. */
	status(): LiveCallStatus {
		const controller = this.#controller;
		const call = this.#call;
		if (!controller || !call || this.#closing) return { state: "off" };
		return {
			state: call.open ? "open" : "starting",
			provider: call.provider,
			voice: call.voice,
			since: call.since,
			muted: controller.muted,
		};
	}

	/** Stops `controller` and releases the slot once it has fully stopped. Idempotent. */
	#retire(controller: RpcLiveSession): Promise<void> {
		if (this.#controller !== controller) return Promise.resolve();
		this.#closing ??= controller.stop().finally(() => {
			if (this.#controller !== controller) return;
			this.#controller = undefined;
			this.#call = undefined;
			this.#closing = undefined;
			// Levels never follow `live_end`.
			clearTimeout(this.#levelsTimer);
			this.#levelsTimer = undefined;
			this.#pendingLevels = undefined;
		});
		return this.#closing;
	}

	#queueLevels(input: number, output: number): void {
		this.#pendingLevels = { input, output };
		if (this.#levelsTimer) return;
		const wait = this.#lastLevelsAt + this.#levelsIntervalMs - Date.now();
		if (wait <= 0) {
			this.#flushLevels();
			return;
		}
		this.#levelsTimer = setTimeout(() => {
			this.#levelsTimer = undefined;
			this.#flushLevels();
		}, wait);
	}

	#flushLevels(): void {
		if (this.#levelsTimer) {
			clearTimeout(this.#levelsTimer);
			this.#levelsTimer = undefined;
		}
		const levels = this.#pendingLevels;
		if (!levels) return;
		this.#pendingLevels = undefined;
		this.#lastLevelsAt = Date.now();
		this.#output({ type: "live_levels", input: levels.input, output: levels.output });
	}
}
