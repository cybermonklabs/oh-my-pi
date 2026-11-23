import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import * as openaiTransport from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import type { OpenAILiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as codexTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import { extractVisibleAssistantText } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";

/** Transport double: records what the controller sends and lets the test play the server's events. */
class FakeTransport {
	readonly sent: LiveClientMessage[] = [];
	readonly sdpAnswer = "v=0 answer";
	constructor(readonly options: OpenAILiveTransportOptions | LiveTransportOptions) {}
	async connect(): Promise<void> {}
	async setMuted(): Promise<void> {}
	pushAudio(): void {}
	async send(message: LiveClientMessage): Promise<void> {
		this.sent.push(message);
	}
	async close(): Promise<void> {}
	emit(event: LiveServerEvent): void {
		this.options.callbacks.onEvent(event);
	}
}

beforeEach(() => {
	// The waits are seconds long; the clock is driven, never waited on.
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Runs the promise continuations the controller queued; no timer moves. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
	await settle();
	vi.advanceTimersByTime(ms);
	await settle();
}

/** Replaces a transport class export with one that makes {@link FakeTransport}s. */
function fakeTransports(module: object, name: string): FakeTransport[] {
	const made: FakeTransport[] = [];
	const spy = vi.spyOn(module as Record<string, unknown>, name as never) as unknown as {
		mockImplementation(implementation: (options: never) => object): void;
	};
	spy.mockImplementation(function (options: never) {
		const transport = new FakeTransport(options);
		made.push(transport);
		return transport;
	});
	return made;
}

function call(settings: Record<string, unknown> = { "live.provider": "openai" }) {
	const openai = fakeTransports(openaiTransport, "OpenAILiveTransport");
	const codex = fakeTransports(codexTransport, "CodexLiveTransport");
	const sent: { customType?: string; content?: unknown }[] = [];
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		modelRegistry: {
			authStorage: {} as AuthStorage,
			getProviderBaseUrl: () => "http://model-gateway:4000/v1",
			getApiKeyForProvider: async () => "sk-test",
		},
		settings: Settings.isolated(settings),
		sessionId: "s1",
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		sendCustomMessage: async (message: { customType?: string; content?: unknown }) => {
			sent.push(message);
			return false;
		},
	} as unknown as LiveSessionControllerOptions["session"];
	const controller = new LiveSessionController({
		session,
		extractAssistantText: extractVisibleAssistantText,
		sdpOffer: "v=0 offer",
		callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
	});
	return {
		controller,
		openai,
		codex,
		transport: () => openai[0]!,
		turns: () => sent.filter(message => message.customType === LIVE_DELEGATION_MESSAGE_TYPE),
		sessionEvent: (event: unknown) => listener?.(event as AgentSessionEvent),
	};
}

function userSaid(text: string, startMs: number, endMs: number): LiveServerEvent {
	return { type: "transcript.delta", role: "user", text, startMs, endMs };
}

function voiceSaid(text: string, startMs: number, endMs: number): LiveServerEvent {
	return { type: "transcript.delta", role: "assistant", text, startMs, endMs };
}

/** The lines of a delegation turn. */
function requestLines(content: unknown): string[] {
	return String(content)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

describe("live.provider", () => {
	test("openai calls GPT-Live with the openai provider's base URL and key", async () => {
		const live = call();
		await live.controller.start();
		expect(live.codex).toEqual([]);
		expect(live.openai).toHaveLength(1);
		const options = live.transport().options as OpenAILiveTransportOptions;
		expect(options.route).toEqual({
			baseUrl: "http://model-gateway:4000/v1",
			apiKey: "sk-test",
			model: "gpt-live-1.1",
		});
		await live.controller.stop();
	});

	test("control: unset, the call goes to Codex as before", async () => {
		const live = call({});
		await live.controller.start();
		expect(live.openai).toEqual([]);
		expect(live.codex).toHaveLength(1);
		await live.controller.stop();
	});
});

describe("GPT-Live delegations", () => {
	test("a delegation becomes one turn from both speakers' words, waiting for the user's late word", async () => {
		const live = call();
		await live.controller.start();
		const transport = live.transport();
		transport.emit(voiceSaid("Should I deploy main?", 0, 1_200));
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 2_600 });
		await advance(1_000);
		expect(live.turns()).toHaveLength(0);
		transport.emit(userSaid("yes", 2_000, 2_300));
		await advance(1_999);
		expect(live.turns()).toHaveLength(0);
		await advance(1);
		expect(live.turns().map(turn => requestLines(turn.content))).toEqual([
			["Voice: Should I deploy main?", "User: yes"],
		]);
		await live.controller.stop();
	});

	test("the voice speaking past the offset does not send the turn before the user's late words", async () => {
		const live = call();
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
		expect(live.turns().map(turn => requestLines(turn.content))).toEqual([
			["Voice: Should I deploy main?", "User: yes"],
		]);
		await live.controller.stop();
	});

	test("a user word past the offset sends the turn at once; a delegation no word reaches is sent after 3 s", async () => {
		const live = call();
		await live.controller.start();
		const transport = live.transport();
		transport.emit(userSaid("check the build", 100, 900));
		transport.emit({ type: "delegation.requested", id: "item_1", offsetMs: 1_000 });
		await settle();
		expect(live.turns()).toHaveLength(0);
		transport.emit(userSaid("please", 1_050, 1_400));
		await settle();
		expect(live.turns().map(turn => requestLines(turn.content))).toEqual([["User: check the build"]]);
		transport.emit({ type: "delegation.requested", id: "item_2", offsetMs: 5_000 });
		await advance(2_999);
		expect(live.turns()).toHaveLength(1);
		await advance(1);
		expect(live.turns().map(turn => requestLines(turn.content))[1]).toEqual(["User: please"]);
		await live.controller.stop();
	});

	test("progress goes to the call as thinking and the final reply as commentary", async () => {
		const live = call();
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
		await live.controller.stop();
		expect(transport.sent.at(-1)).toEqual({ type: "session.close" });
	});
});
