import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type LiveSessionCallbacks, LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { CyberPolicyClosure } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";

/**
 * A `/live` call runs on OpenAI (Codex realtime) and carries the session's text to it. While the session tree's
 * cyber-policy closure is active (OpenAI refused the tree's content), no call starts and no context append goes
 * out; each control has no refusal. The transport is a stand-in (as in `live-command-controller.test.ts`) and the
 * session a stub: nothing reaches the network.
 */
interface FakeTransport {
	options: LiveTransportOptions;
	sent: LiveClientMessage[];
	connected: number;
}

afterEach(() => {
	vi.restoreAllMocks();
});

function harness() {
	const transports: FakeTransport[] = [];
	// bun's spyOn types a class export's implementation as `never`; the controller only needs a constructible
	// stand-in, so a plain function (not an arrow: it is called with `new`) suffices.
	const transportSpy = vi.spyOn(liveTransport, "CodexLiveTransport") as unknown as {
		mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
	};
	transportSpy.mockImplementation(function (options: LiveTransportOptions) {
		const fake: FakeTransport = { options, sent: [], connected: 0 };
		transports.push(fake);
		return {
			connect: async () => {
				fake.connected++;
			},
			setMuted: async () => {},
			send: async (message: LiveClientMessage) => {
				fake.sent.push(message);
			},
			close: async () => {},
			sdpAnswer: "v=0 answer",
		};
	});
	const closure = new CyberPolicyClosure();
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		cyberPolicyClosure: closure,
		modelRegistry: { authStorage: {} },
		sessionId: "live-session",
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.push(listener);
			return () => {};
		},
		async sendCustomMessage() {},
	} as unknown as AgentSession;
	const terminal: Array<Error | undefined> = [];
	const callbacks: LiveSessionCallbacks = {
		onPhase() {},
		onLevels() {},
		onTranscript() {},
		onTerminal(error) {
			terminal.push(error);
		},
	};
	const controller = new LiveSessionController({
		session,
		callbacks,
		extractAssistantText: message => message.content.map(block => (block.type === "text" ? block.text : "")).join(""),
		// A caller-owned peer: no host microphone is opened.
		sdpOffer: "v=0 offer",
	});
	const emitSession = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return { closure, controller, transports, terminal, emitSession };
}

const DELEGATION: LiveServerEvent = {
	type: "delegation.created",
	item: { type: "delegation", target: "client", id: "delegation-1", content: [{ type: "input_text", text: "Do it" }] },
};

function finalAnswer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("a /live call during a cyber-policy hold", () => {
	it.each([
		["does not start while the session's closure is active", true],
		["starts when no refusal holds the session (control)", false],
	])("%s", async (_name, refused) => {
		const { closure, controller, transports, terminal } = harness();
		if (refused) closure.record();
		if (refused) {
			await expect(controller.start()).rejects.toThrow("cyber_policy");
			expect(transports).toHaveLength(0);
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.message).toContain("cyber_policy");
		} else {
			await controller.start();
			expect(transports).toHaveLength(1);
			expect(transports[0]?.connected).toBe(1);
			await controller.stop();
		}
	});

	it.each([
		["sends none of the session's text once a refusal lands during the call, and ends the call", true],
		["sends the session's final answer when no refusal lands (control)", false],
	])("%s", async (_name, refused) => {
		const { closure, controller, transports, terminal, emitSession } = harness();
		await controller.start();
		const transport = transports[0]!;
		transport.options.callbacks.onEvent(DELEGATION);
		// The delegated turn meets OpenAI's refusal before its answer reaches the call.
		if (refused) closure.record();
		emitSession({ type: "agent_end", messages: [finalAnswer("The session's answer")] } as AgentSessionEvent);
		// The append is queued on the controller's send chain; a stop marks the call stopped before that chain runs,
		// and the chain then sends nothing. Let the chain run first, as a call that keeps going does.
		await Bun.sleep(0);
		await controller.stop();

		const appends = transport.sent.filter(message => message.type === "delegation.context.append");
		if (refused) {
			expect(appends).toHaveLength(0);
			expect(terminal[0]?.message).toContain("cyber_policy");
		} else {
			expect(appends).toHaveLength(1);
			expect(JSON.stringify(appends[0])).toContain("The session's answer");
			expect(terminal).toEqual([undefined]);
		}
	});
});
