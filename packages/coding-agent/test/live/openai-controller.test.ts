import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	LIVE_CALL_END_MESSAGE_TYPE,
	LiveSessionController,
	type LiveSessionControllerOptions,
} from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import { resolveLiveVoice } from "@oh-my-pi/pi-coding-agent/live/settings";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import { extractVisibleAssistantText } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const noCodexLogin = {
	oauth: {
		access: () => {
			throw new Error("the openai live route must not use Codex OAuth");
		},
	},
} as unknown as AuthStorage;

/** Transport double: records what the controller sends and lets the test play the server's events. */
class FakeTransport {
	readonly sent: LiveClientMessage[] = [];
	readonly log: string[] = [];
	readonly sdpAnswer = "v=0 answer";
	closed = false;
	connected = false;
	/** Called after each send, so a test can answer a `session.close`. */
	onSend: ((message: LiveClientMessage) => void) | undefined;
	constructor(
		readonly options: LiveTransportOptions,
		/** Connect only when the controller aborts the connect, as a server that never answers. */
		readonly connectUntilAborted = false,
	) {}
	async connect(): Promise<void> {
		if (this.connectUntilAborted) {
			const { signal } = this.options;
			const { promise, reject } = Promise.withResolvers<never>();
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			await promise;
		}
		this.connected = true;
	}
	async setMuted(): Promise<void> {}
	async send(message: LiveClientMessage): Promise<void> {
		this.sent.push(message);
		this.log.push(`send ${message.type}`);
		this.onSend?.(message);
	}
	async close(): Promise<void> {
		this.closed = true;
		this.connected = false;
		this.log.push("close");
	}
	emit(event: LiveServerEvent): void {
		this.log.push(`event ${event.type}`);
		this.options.callbacks.onEvent(event);
	}
}

interface SentMessage {
	message: { customType?: string; content?: unknown; display?: boolean };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-live-openai-controller-"));
	// The call's limits are seconds and minutes long; the clock is driven, never waited on.
	vi.useFakeTimers();
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

/** Runs the promise continuations the controller queued; no timer moves. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Lets queued continuations register their timers, moves the clock, then runs what the timers queued. */
async function advance(ms: number): Promise<void> {
	await settle();
	vi.advanceTimersByTime(ms);
	await settle();
}

interface CallOptions {
	settings?: Record<string, unknown>;
	/** Answer `session.close` with `session.closed` after this many ms; unset never answers. */
	closedAfterMs?: number;
	/** The connect never ends unless the controller aborts it. */
	connectUntilAborted?: boolean;
}

function call(options: CallOptions = {}) {
	const transports: FakeTransport[] = [];
	const transportSpy = vi.spyOn(liveTransport, "LiveTransport") as unknown as {
		mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
	};
	transportSpy.mockImplementation(function (transportOptions: LiveTransportOptions) {
		const transport = new FakeTransport(transportOptions, options.connectUntilAborted);
		if (options.closedAfterMs !== undefined) {
			const delay = options.closedAfterMs;
			transport.onSend = message => {
				if (message.type !== "session.close") return;
				setTimeout(() => transport.emit({ type: "session.closed", reason: "close_requested", seconds: 30 }), delay);
			};
		}
		transports.push(transport);
		return transport;
	});
	const sentMessages: SentMessage[] = [];
	const registryCalls: string[] = [];
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const transcriptPath = path.join(tempDir, "0.live-transcript.log");
	const session = {
		modelRegistry: {
			authStorage: noCodexLogin,
			getProviderBaseUrl: (provider: string) => {
				registryCalls.push(provider);
				return "http://model-gateway:4000/v1";
			},
			getApiKeyForProvider: async (provider: string) => {
				registryCalls.push(`${provider} key`);
				return "gw-key";
			},
		},
		settings: Settings.isolated({ "live.provider": "openai", ...options.settings }),
		sessionId: "s1",
		sessionManager: { allocateArtifactPath: async () => ({ id: "0", path: transcriptPath }) },
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		sendCustomMessage: async (message: SentMessage["message"], sendOptions?: SentMessage["options"]) => {
			sentMessages.push({ message, options: sendOptions });
			return false;
		},
	} as unknown as LiveSessionControllerOptions["session"];
	const terminals: (Error | undefined)[] = [];
	const controller = new LiveSessionController({
		session,
		extractAssistantText: extractVisibleAssistantText,
		voice: "marin",
		sdpOffer: "v=0 offer",
		callbacks: {
			onPhase: () => {},
			onLevels: () => {},
			onTranscript: () => {},
			onTerminal: error => terminals.push(error),
		},
	});
	return {
		controller,
		transport: () => transports[0]!,
		transports,
		turns: () => sentMessages.filter(sent => sent.message.customType === LIVE_DELEGATION_MESSAGE_TYPE),
		ends: () => sentMessages.filter(sent => sent.message.customType === LIVE_CALL_END_MESSAGE_TYPE),
		terminals,
		registryCalls,
		transcriptPath,
		sessionEvent: (event: unknown) => listener?.(event as AgentSessionEvent),
	};
}

function userSaid(text: string, startMs: number, endMs: number): LiveServerEvent {
	return { type: "transcript.delta", role: "user", text, startMs, endMs };
}

function voiceSaid(text: string, startMs: number, endMs: number): LiveServerEvent {
	return { type: "transcript.delta", role: "assistant", text, startMs, endMs };
}

/** The transcript lines of a delegation turn, without its preamble. */
function requestLines(content: unknown): string[] {
	const text = String(content);
	const body = text.slice(text.indexOf("<transcript>") + "<transcript>".length, text.indexOf("</transcript>"));
	return body
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

describe("GPT-Live delegations", () => {
	test("a delegation whose transcript arrives late becomes one turn, and a bare yes carries the voice's question", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		const transport = live.transport();
		transport.emit(voiceSaid("Should I deploy main?", 0, 1_200));
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 2_600 });
		await advance(1_000);
		expect(live.turns()).toHaveLength(0);
		// The user's word reaches omp after the delegation it asked for.
		transport.emit(userSaid("yes", 2_000, 2_300));
		await advance(1_999);
		expect(live.turns()).toHaveLength(0);
		await advance(1);

		expect(live.turns()).toHaveLength(1);
		const turn = live.turns()[0]!;
		expect(turn.options).toEqual({ triggerTurn: true });
		expect(requestLines(turn.message.content)).toEqual(["Voice: Should I deploy main?", "User: yes"]);
		const preamble = String(turn.message.content).split("<transcript>")[0]!;
		expect(preamble).toMatch(/speech/i);
		expect(preamble).toMatch(/mishear|recogni/i);
		expect(preamble).toMatch(/short/i);
		expect(preamble).toMatch(/aloud|spoken/i);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});

	test("the voice speaking past the offset does not send the turn before the user's late words", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		const transport = live.transport();
		transport.emit(voiceSaid("Should I deploy main?", 0, 1_200));
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 2_600 });
		// The voice keeps talking once it delegates, and its words reach omp before the user's.
		transport.emit(voiceSaid("Okay, on it.", 2_650, 3_400));
		await advance(1_000);
		expect(live.turns()).toHaveLength(0);
		transport.emit(userSaid("yes", 2_000, 2_300));
		await advance(2_000);

		expect(live.turns().map(turn => requestLines(turn.message.content))).toEqual([
			["Voice: Should I deploy main?", "User: yes"],
		]);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});

	test("a user word past the delegation's offset sends the turn at once", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		const transport = live.transport();
		transport.emit(userSaid("check the build", 100, 900));
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 1_000 });
		await settle();
		expect(live.turns()).toHaveLength(0);
		transport.emit(userSaid("please", 1_050, 1_400));
		await settle();
		// Words after the offset belong to the next request.
		expect(live.turns().map(turn => requestLines(turn.message.content))).toEqual([["User: check the build"]]);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});

	test("a delegation no transcript reaches is still sent, 3 s after it came", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		live.transport().emit({ type: "delegation.requested", id: "item_1", offsetMs: 500 });
		await advance(2_999);
		expect(live.turns()).toHaveLength(0);
		await advance(1);
		expect(live.turns().map(turn => requestLines(turn.message.content))).toEqual([
			["(no words reached omp for this request)"],
		]);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});

	test("each request holds the transcript since the previous delegation", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		const transport = live.transport();
		transport.emit(userSaid("run the tests", 0, 800));
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 900 });
		transport.emit(voiceSaid("Running them.", 1_000, 1_500));
		transport.emit(userSaid("and lint", 2_000, 2_400));
		transport.emit({ type: "delegation.requested", id: "item_2", offsetMs: 2_500 });
		await advance(3_000);
		expect(live.turns().map(turn => requestLines(turn.message.content))).toEqual([
			["User: run the tests"],
			["Voice: Running them.", "User: and lint"],
		]);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});

	test("progress goes to the call as thinking and the final reply as commentary", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		const transport = live.transport();
		transport.emit(userSaid("is CI green", 0, 700));
		transport.emit({ type: "delegation.requested", id: "item_7", offsetMs: 800 });
		await advance(3_000);
		expect(live.turns()).toHaveLength(1);
		live.sessionEvent({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Checking CI." }] },
		});
		live.sessionEvent({
			type: "agent_end",
			isTerminal: true,
			messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "CI is green." }] }],
		});
		await settle();
		expect(transport.sent).toEqual([
			{ type: "session.thinking.append", delegation_id: "item_7", content: "Checking CI." },
			{
				type: "session.commentary.append",
				delegation_id: "item_7",
				content: expect.stringContaining("CI is green."),
			},
		]);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});
});

describe("GPT-Live call lifecycle", () => {
	test("omp waits for session.closed before it closes the sideband", async () => {
		const live = call({ closedAfterMs: 800 });
		await live.controller.start();
		const stopping = live.controller.stop();
		await advance(799);
		expect(live.transport().log).toEqual(["send session.close"]);
		await advance(1);
		await stopping;
		expect(live.transport().log).toEqual(["send session.close", "event session.closed", "close"]);
	});

	test("a stop while the call connects aborts the connect and sends nothing on the sideband", async () => {
		const live = call({ connectUntilAborted: true });
		const starting = live.controller.start().then(
			() => undefined,
			(error: unknown) => error,
		);
		// The start can wait on file I/O before it builds the transport; each stat lets that I/O finish.
		for (let i = 0; i < 200 && live.transports.length === 0; i++) await fs.stat(tempDir);
		const transport = live.transport();
		expect(transport.options.signal?.aborted).toBe(false);
		const stopping = live.controller.stop();
		await advance(0);
		expect(transport.options.signal?.aborted).toBe(true);
		await stopping;
		expect(String(await starting)).toMatch(/stopped while it connected/);
		expect(transport.log).toEqual(["close"]);
		expect(live.ends()).toEqual([]);
	});

	test("omp closes the sideband 5 s after session.close when session.closed never comes", async () => {
		const live = call();
		await live.controller.start();
		const stopping = live.controller.stop();
		await advance(4_999);
		expect(live.transport().closed).toBe(false);
		await advance(1);
		await stopping;
		expect(live.transport().log).toEqual(["send session.close", "close"]);
	});

	test("a call ends by itself after 15 minutes in which the user says nothing", async () => {
		const live = call({ closedAfterMs: 0 });
		await live.controller.start();
		const transport = live.transport();
		await advance(10 * 60_000);
		transport.emit(userSaid("still here", 1_000, 1_500));
		await advance(10 * 60_000);
		// The voice talking does not keep the call open; only the user does.
		transport.emit(voiceSaid("Anything else?", 2_000, 2_500));
		await advance(5 * 60_000 - 1);
		expect(transport.closed).toBe(false);
		await advance(1);
		await advance(0);
		await live.controller.stop();
		expect(transport.log.slice(-3)).toEqual(["send session.close", "event session.closed", "close"]);
		expect(live.terminals).toEqual([undefined]);
		expect(String(live.ends()[0]?.message.content)).toMatch(/no speech/i);
	});

	test("a call the server closes ends with its reason", async () => {
		const live = call();
		await live.controller.start();
		const transport = live.transport();
		transport.emit({ type: "session.closed", reason: "expired", seconds: 7_200 });
		await live.controller.stop();
		expect(transport.closed).toBe(true);
		expect(live.terminals).toHaveLength(1);
		expect(live.terminals[0]?.message).toMatch(/expired/);
		expect(transport.sent.map(message => message.type)).not.toContain("session.close");
	});

	test("the transcript file holds both speakers' lines with UTC times, and the session gets the end message", async () => {
		const live = call({ closedAfterMs: 0 });
		const before = Date.now();
		await live.controller.start();
		const transport = live.transport();
		transport.emit(userSaid("check ", 0, 300));
		transport.emit(userSaid("the build", 350, 900));
		// 1.5 s with no new words ends a line; 1 499 ms does not.
		transport.emit(userSaid("please", 2_400, 2_800));
		transport.emit(userSaid(" now", 4_299, 4_500));
		// A change of speaker ends a line.
		transport.emit(voiceSaid("Sure.", 4_600, 5_000));
		// So does a delegation.
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 5_100 });
		await advance(2_000);
		transport.emit(voiceSaid("Working on it.", 5_200, 5_900));
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
		const after = Date.now();

		const lines = (await Bun.file(live.transcriptPath).text()).trimEnd().split("\n");
		const parsed = lines.map(line => /^(\S+) (User|Voice): (.*)$/.exec(line));
		expect(parsed.map(match => match && `${match[2]}: ${match[3]}`)).toEqual([
			"User: check the build",
			"User: please now",
			"Voice: Sure.",
			"Voice: Working on it.",
		]);
		const times = parsed.map(match => new Date(match![1]!));
		for (const [index, at] of times.entries()) {
			expect(parsed[index]![1]).toBe(at.toISOString());
			expect(at.getTime()).toBeGreaterThanOrEqual(before);
			expect(at.getTime()).toBeLessThanOrEqual(after);
		}
		// The line said after the delegation was heard 2 s later.
		expect(times[3]!.getTime() - times[2]!.getTime()).toBe(2_000);

		expect(live.ends()).toHaveLength(1);
		const end = live.ends()[0]!;
		expect(end.options).toEqual({ deliverAs: "nextTurn" });
		const content = String(end.message.content);
		expect(content).toContain(live.transcriptPath);
		const stamps = content.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g) ?? [];
		expect(stamps).toHaveLength(2);
		expect(new Date(stamps[1]!).getTime() - new Date(stamps[0]!).getTime()).toBe(2_000);
	});
});

describe("GPT-Live call settings", () => {
	test("takes the route from the openai provider and appends live.instructionsFile to the bundled prompt", async () => {
		const instructionsFile = path.join(tempDir, "voice.md");
		await Bun.write(instructionsFile, "Call the user Sami.\n");
		const live = call({
			settings: {
				"live.instructionsFile": instructionsFile,
				"live.pulseServer": "tcp:127.0.0.1:4713",
				"live.model": "gpt-live-1.1",
			},
			closedAfterMs: 0,
		});
		await live.controller.start();
		const options = live.transport().options;
		expect(options.openai).toEqual({
			baseUrl: "http://model-gateway:4000/v1",
			apiKey: "gw-key",
			model: "gpt-live-1.1",
		});
		expect(options.endpoint).toBeUndefined();
		expect(options.pulseServer).toBe("tcp:127.0.0.1:4713");
		expect(options.instructions.startsWith("You: omp Live")).toBe(true);
		expect(options.instructions.endsWith("\n\nCall the user Sami.")).toBe(true);
		const stopping = live.controller.stop();
		await advance(0);
		await stopping;
	});

	test("refuses to start when live.instructionsFile cannot be read", async () => {
		const live = call({ settings: { "live.instructionsFile": path.join(tempDir, "missing.md") } });
		await expect(live.controller.start()).rejects.toThrow(/live\.instructionsFile/);
		expect(live.transports).toEqual([]);
	});

	test("refuses live.endpoint together with live.provider openai", async () => {
		const live = call({ settings: { "live.endpoint": "http://127.0.0.1:8080/v1" } });
		await expect(live.controller.start()).rejects.toThrow(/live\.endpoint/);
		expect(live.transports).toEqual([]);
	});

	test("control: with live.provider unset the Codex route is used, as before", async () => {
		const live = call({ settings: { "live.provider": undefined, "live.endpoint": "http://127.0.0.1:8080/v1" } });
		await live.controller.start();
		const transport = live.transport();
		expect(transport.options.openai).toBeUndefined();
		expect(transport.options.endpoint).toEqual({ baseUrl: "http://127.0.0.1:8080/v1" });
		expect(live.registryCalls).toEqual([]);
		// A Codex delegation still carries its own request text, with no preamble.
		transport.emit({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "d1",
				content: [{ type: "input_text", text: "Fix the build." }],
			},
		});
		await settle();
		expect(live.turns().map(turn => turn.message.content)).toEqual(["Fix the build."]);
		// Codex closes at once, as before: no wait for session.closed, no transcript file, no end message.
		await live.controller.stop();
		expect(transport.log.slice(-2)).toEqual(["send session.close", "close"]);
		expect(live.ends()).toEqual([]);
		expect(await Bun.file(live.transcriptPath).exists()).toBe(false);
	});

	test("the voice defaults to marin on the openai route and to sol on Codex", () => {
		expect(resolveLiveVoice(Settings.isolated({ "live.provider": "openai" }))).toBe("marin");
		expect(resolveLiveVoice(Settings.isolated())).toBe("sol");
		expect(resolveLiveVoice(Settings.isolated({ "live.provider": "openai", "live.voice": "cedar" }))).toBe("cedar");
		expect(resolveLiveVoice(Settings.isolated({ "live.provider": "openai" }), " ash ")).toBe("ash");
	});
});
