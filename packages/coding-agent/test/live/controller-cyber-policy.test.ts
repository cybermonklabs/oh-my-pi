import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as liveAttestation from "@oh-my-pi/pi-coding-agent/live/attestation";
import { type LiveSessionCallbacks, LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveClientMessage } from "@oh-my-pi/pi-coding-agent/live/protocol";
import { CodexLiveTransport } from "@oh-my-pi/pi-coding-agent/live/transport";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { CyberPolicyClosure } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";

/**
 * A `/live` call runs on OpenAI (Codex realtime) and carries the session's text to it. While the session tree's
 * cyber-policy closure is active (OpenAI refused the tree's content), the call's signaling POST does not go out and
 * no frame of the session's text does; a call that connected while a refusal landed is closed before any audio or
 * text. Each case records the refusal in the window before one of those sends, on the real transport; each control
 * records none. Synthetic everywhere: `fetch` and `WebSocket` are stand-ins, the credential is a stub, and nothing
 * reaches the network.
 */

/** A stand-in for the sideband WebSocket: it opens on the next microtask and records what it is sent. */
class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeSocket[] = [];
	/** Runs when the transport constructs the socket, before it opens. */
	static onConstruct: (() => void) | undefined;

	readyState = FakeSocket.CONNECTING;
	binaryType = "";
	readonly sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;

	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
		FakeSocket.onConstruct?.();
		queueMicrotask(() => {
			if (this.readyState !== FakeSocket.CONNECTING) return;
			this.readyState = FakeSocket.OPEN;
			this.onopen?.();
		});
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
		this.readyState = FakeSocket.CLOSED;
	}

	/** The `type` of each frame sent. */
	sentTypes(): string[] {
		return this.sent.map(frame => (JSON.parse(frame) as LiveClientMessage).type);
	}
}

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
let posts: string[] = [];

beforeEach(() => {
	posts = [];
	FakeSocket.instances = [];
	FakeSocket.onConstruct = undefined;
	globalThis.fetch = (async (input: string | URL | Request) => {
		posts.push(String(input));
		return new Response("v=0 synthetic-answer", {
			status: 201,
			headers: { location: "/v1/realtime/calls/rtc_synthetic" },
		});
	}) as unknown as typeof fetch;
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	globalThis.WebSocket = realWebSocket;
	vi.restoreAllMocks();
});

function harness(options: { onAccess?: () => void } = {}) {
	const closure = new CyberPolicyClosure();
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const counts = { accesses: 0 };
	const session = {
		cyberPolicyClosure: closure,
		modelRegistry: {
			authStorage: {
				oauth: {
					access: async () => {
						counts.accesses++;
						options.onAccess?.();
						return { accessToken: "not-a-secret", accountId: "acct_synthetic" };
					},
				},
				limits: { rotate: async () => undefined },
			},
		},
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
		// A caller-owned peer: no host microphone or native peer is opened.
		sdpOffer: "v=0 synthetic-offer",
	});
	const emitSession = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return { closure, controller, terminal, emitSession, counts };
}

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
	// A refusal already standing: the controller reads it before it builds the transport, so the call does not even
	// resolve its Codex credential (a token refresh would be traffic to OpenAI).
	it.each([
		["does not open while the session's closure is active", true],
		["opens when no refusal holds the session (control)", false],
	])("%s", async (_name, refused) => {
		const { closure, controller, terminal, counts } = harness();
		if (refused) closure.record();
		if (refused) {
			await expect(controller.start()).rejects.toThrow("cyber_policy");
			expect(counts.accesses).toBe(0);
			expect(posts).toHaveLength(0);
			expect(FakeSocket.instances).toHaveLength(0);
			expect(terminal[0]?.message).toContain("cyber_policy");
		} else {
			await controller.start();
			expect(posts).toHaveLength(1);
			expect(FakeSocket.instances).toHaveLength(1);
			await controller.stop();
		}
	});

	// The credential and the attestation are awaited after the controller's own read; the transport reads the hold
	// again in the same step as the signaling POST, which carries the call's instructions.
	it.each([
		["sends no signaling POST when a refusal lands while the credential resolves", "credential"],
		["sends no signaling POST when a refusal lands while the attestation is generated", "attestation"],
		["sends the signaling POST when no refusal lands (control)", undefined],
	] as const)("%s", async (_name, window) => {
		let refuse = (): void => {};
		const { closure, controller, terminal } = harness({ onAccess: () => refuse() });
		if (window === "credential") refuse = () => closure.record();
		if (window === "attestation") {
			vi.spyOn(liveAttestation, "generateCodexAttestation").mockImplementation(async () => {
				closure.record();
				return undefined;
			});
		}
		if (window) {
			await expect(controller.start()).rejects.toThrow("cyber_policy");
			expect(posts).toHaveLength(0);
			expect(FakeSocket.instances).toHaveLength(0);
			expect(terminal[0]?.message).toContain("cyber_policy");
		} else {
			await controller.start();
			expect(posts).toHaveLength(1);
			await controller.stop();
		}
	});

	// The POST went out before the refusal: the controller reads the hold again once the call has connected, and
	// closes the call before any audio or session text.
	it.each([
		["closes a call whose refusal lands while its sideband connects", true],
		["keeps a call that connects with no refusal (control)", false],
	])("%s", async (_name, refused) => {
		const { closure, controller, terminal } = harness();
		if (refused) FakeSocket.onConstruct = () => closure.record();
		if (refused) {
			await expect(controller.start()).rejects.toThrow("cyber_policy");
			expect(posts).toHaveLength(1);
			const socket = FakeSocket.instances[0]!;
			// Only the frame that ends the call goes out: it carries none of the session's text, so it is not held.
			expect(socket.sentTypes()).toEqual(["session.close"]);
			expect(socket.closed).toBe(true);
			expect(terminal[0]?.message).toContain("cyber_policy");
		} else {
			await controller.start();
			expect(FakeSocket.instances[0]?.closed).toBe(false);
			await controller.stop();
		}
	});

	// The controller hands a frame to the transport's send queue; the transport reads the hold in the same step as
	// the sideband write. The refusal here lands after the frame is queued and before it is written.
	it.each([
		["writes none of the session's text when a refusal lands while the frame is queued, and ends the call", true],
		["writes the session's final answer when no refusal lands (control)", false],
	])("%s", async (_name, refused) => {
		const { closure, controller, terminal, emitSession } = harness();
		const send = CodexLiveTransport.prototype.send;
		// bun's spyOn types the implementation without `this`; the original needs the instance.
		const sendSpy = vi.spyOn(CodexLiveTransport.prototype, "send") as unknown as {
			mockImplementation(
				implementation: (this: CodexLiveTransport, message: LiveClientMessage) => Promise<void>,
			): void;
		};
		sendSpy.mockImplementation(function (message) {
			if (refused && message.type === "delegation.context.append") queueMicrotask(() => closure.record());
			return send.call(this, message);
		});
		await controller.start();
		const socket = FakeSocket.instances[0]!;
		socket.onmessage?.({
			data: JSON.stringify({
				type: "delegation.created",
				item: {
					type: "delegation",
					target: "client",
					id: "delegation-1",
					content: [{ type: "input_text", text: "Do it" }],
				},
			}),
		});
		emitSession({ type: "agent_end", messages: [finalAnswer("The session's answer")] } as AgentSessionEvent);
		// Let the controller's send chain and the transport's send queue run before the call is stopped.
		await Bun.sleep(5);
		await controller.stop();

		const appends = socket.sent.filter(
			frame => (JSON.parse(frame) as LiveClientMessage).type === "delegation.context.append",
		);
		if (refused) {
			expect(appends).toHaveLength(0);
			expect(terminal[0]?.message).toContain("cyber_policy");
		} else {
			expect(appends).toHaveLength(1);
			expect(appends[0]).toContain("The session's answer");
			expect(terminal).toEqual([undefined]);
		}
	});
});
