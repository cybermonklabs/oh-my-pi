import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { OPENAI_LIVE_MODEL, OpenAILiveTransport } from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import {
	buildDelegationContextAppend,
	buildSessionContextAppend,
	type LiveClientMessage,
} from "@oh-my-pi/pi-coding-agent/live/protocol";
import { extractVisibleAssistantText } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import { CyberPolicyClosure, cyberPolicyHoldMessage } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";

/**
 * A GPT-Live call (`live.provider: openai`) carries the session's text and the `openai` provider's key to OpenAI.
 * While the session tree's cyber-policy closure is active (OpenAI refused the tree's content), the session request
 * does not go out, the sideband attach (it carries the key) does not, and no sideband frame does but `session.close`,
 * which only ends the call, so a held call can still end. Each case holds or records a refusal in the window before
 * one of those sends; each control holds nothing. Synthetic everywhere: a local server stands in for GPT-Live's API,
 * the key is a stub, and nothing reaches the network.
 */

const HOLD = "held: OpenAI refused this session's content";

interface ServerHooks {
	/** Runs when the session request arrives, before it is answered. */
	onPost?: () => void;
	/** Runs when the sideband attaches, before the client sees it open. */
	onAttach?: () => void;
}

/** A local stand-in for GPT-Live's API, recording each session request, attach and sideband frame. */
function gptLiveServer(hooks: ServerHooks = {}) {
	let posts = 0;
	let upgrades = 0;
	let answeredAt = 0;
	const received: { type: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/live/sessions") {
				posts++;
				await request.text();
				hooks.onPost?.();
				answeredAt = Date.now();
				return Response.json({ session: { id: "live_1" }, transport: { sdp: "v=0 answer" } }, { status: 201 });
			}
			if (url.pathname === "/v1/live/sessions/live_1/attach" && srv.upgrade(request)) {
				upgrades++;
				return undefined;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open() {
				hooks.onAttach?.();
			},
			message(_socket, data) {
				received.push(JSON.parse(String(data)));
			},
		},
	});
	return {
		server,
		received,
		base: `http://127.0.0.1:${server.port}/v1`,
		get posts() {
			return posts;
		},
		get upgrades() {
			return upgrades;
		},
		get answeredAt() {
			return answeredAt;
		},
	};
}

function transportFor(base: string, holdReason: () => string | undefined): OpenAILiveTransport {
	return new OpenAILiveTransport({
		registry: { getProviderBaseUrl: () => base, getApiKeyForProvider: async () => "sk-test" },
		sessionId: "s1",
		instructions: "Be brief.",
		sdpOffer: "v=0 offer",
		callbacks: { onEvent: () => {}, onOutputLevel: () => {} },
		holdReason,
	});
}

async function until(check: () => boolean, ms = 4_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(5);
	}
}

const settle = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);

/** Every client message the transport sends but `session.close`, one of each form. */
const FRAMES: [string, LiveClientMessage][] = [
	["a delegation's progress note", buildDelegationContextAppend("item_1", "Reading.", "commentary")],
	["a delegation's answer", buildDelegationContextAppend("item_1", "CI is green.")],
	["context outside a delegation", buildSessionContextAppend("Heads up.", "commentary")],
	["a spoken context line", buildSessionContextAppend("Build done.")],
];

describe("GPT-Live's sends while a cyber-policy hold stands", () => {
	test.each([
		["holds the session request", true],
		["sends the session request when no hold stands (control)", false],
	] as const)("%s", async (_name, held) => {
		const api = gptLiveServer();
		const transport = transportFor(api.base, () => (held ? HOLD : undefined));
		try {
			const result = await settle(transport.connect());
			if (held) {
				expect((result as Error).message).toBe(HOLD);
				expect(api.posts).toBe(0);
				expect(api.upgrades).toBe(0);
			} else {
				expect(result).toBeUndefined();
				expect(api.posts).toBe(1);
				expect(api.upgrades).toBe(1);
			}
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test.each([
		["holds the sideband attach when a refusal lands while the session request is answered, unretried", true],
		["attaches when no refusal lands (control)", false],
	] as const)("%s", async (_name, refused) => {
		let held = false;
		const api = gptLiveServer({
			onPost: () => {
				if (refused) held = true;
			},
		});
		const transport = transportFor(api.base, () => (held ? HOLD : undefined));
		try {
			const result = await settle(transport.connect());
			const settledAt = Date.now();
			expect(api.posts).toBe(1);
			if (refused) {
				expect((result as Error).message).toBe(HOLD);
				expect(api.upgrades).toBe(0);
				// A retried attach waits 200 ms before its second attempt and 3 s over all; a held one is not retried.
				expect(settledAt - api.answeredAt).toBeLessThan(1_000);
			} else {
				expect(result).toBeUndefined();
				expect(api.upgrades).toBe(1);
			}
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test.each(FRAMES)("holds %s, and still sends session.close", async (_name, message) => {
		let held = false;
		const api = gptLiveServer();
		const transport = transportFor(api.base, () => (held ? HOLD : undefined));
		try {
			await transport.connect();
			held = true;
			expect(((await settle(transport.send(message))) as Error).message).toBe(HOLD);
			await transport.send({ type: "session.close" });
			await until(() => api.received.length > 0);
			expect(api.received.map(frame => frame.type)).toEqual(["session.close"]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("sends each frame when no hold stands (control)", async () => {
		const api = gptLiveServer();
		const transport = transportFor(api.base, () => undefined);
		try {
			await transport.connect();
			for (const [, message] of FRAMES) await transport.send(message);
			await until(() => api.received.length === FRAMES.length);
			expect(api.received).toHaveLength(FRAMES.length);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	// The read holds every frame but `session.close`, so a frame type added later is held too.
	test.each([
		["holds a frame of a type the transport does not name", true],
		["control: with no hold, that frame fails on its own, not with the hold's message", false],
	] as const)("%s", async (_name, holds) => {
		let held = false;
		const api = gptLiveServer();
		const transport = transportFor(api.base, () => (held ? HOLD : undefined));
		try {
			await transport.connect();
			held = holds;
			const unnamed = { type: "session.future_frame" } as unknown as LiveClientMessage;
			const error = (await settle(transport.send(unnamed))) as Error;
			expect(error).toBeInstanceOf(Error);
			expect(error.message === HOLD).toBe(holds);
			await Bun.sleep(20);
			expect(api.received).toEqual([]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});
});

/** A `/live` controller on the real GPT-Live transport, for a session whose closure the test drives. */
function liveCall(base: string, closure: CyberPolicyClosure, onKey: () => void = () => {}) {
	let keyLookups = 0;
	const session = {
		modelRegistry: {
			authStorage: {},
			getProviderBaseUrl: () => base,
			getApiKeyForProvider: async () => {
				keyLookups++;
				onKey();
				return "sk-test";
			},
		},
		settings: Settings.isolated({ "live.provider": "openai" }),
		sessionId: "s1",
		subscribe: () => () => {},
		sendCustomMessage: async () => false,
		cyberPolicyClosure: closure,
	} as unknown as LiveSessionControllerOptions["session"];
	const terminal: (Error | undefined)[] = [];
	const controller = new LiveSessionController({
		session,
		extractAssistantText: extractVisibleAssistantText,
		sdpOffer: "v=0 offer",
		callbacks: {
			onPhase: () => {},
			onLevels: () => {},
			onTranscript: () => {},
			onTerminal: error => terminal.push(error),
		},
	});
	return {
		controller,
		terminal,
		/** How many times the call looked up the `openai` provider's key. */
		get keyLookups() {
			return keyLookups;
		},
	};
}

describe("a GPT-Live /live call during a cyber-policy hold", () => {
	// The hold's message names the route the call goes to: the `openai` provider's GPT-Live model.
	const named = cyberPolicyHoldMessage({ provider: "openai", id: OPENAI_LIVE_MODEL });

	test.each([
		["opens no call and looks up no key while a hold stands, and names GPT-Live's route", true],
		["opens the call when no refusal holds the session (control)", false],
	] as const)("%s", async (_name, refused) => {
		const api = gptLiveServer();
		const closure = new CyberPolicyClosure();
		if (refused) closure.record();
		const live = liveCall(api.base, closure);
		try {
			const result = await settle(live.controller.start());
			if (refused) {
				expect((result as Error).message).toBe(named);
				expect(live.keyLookups).toBe(0);
				expect(api.posts).toBe(0);
			} else {
				expect(result).toBeUndefined();
				expect(live.keyLookups).toBe(1);
				expect(api.posts).toBe(1);
			}
		} finally {
			await live.controller.stop();
			api.server.stop(true);
		}
	});

	// The controller's read before the transport passes; the transport's own read, in the request's step, holds it.
	test("holds the session request when a refusal lands while the key resolves", async () => {
		const api = gptLiveServer();
		const closure = new CyberPolicyClosure();
		const live = liveCall(api.base, closure, () => closure.record());
		try {
			const result = await settle(live.controller.start());
			expect((result as Error).message).toBe(named);
			expect(api.posts).toBe(0);
		} finally {
			await live.controller.stop();
			api.server.stop(true);
		}
	});

	test("closes a call whose sideband attached while a refusal landed, sending nothing but session.close", async () => {
		const closure = new CyberPolicyClosure();
		const api = gptLiveServer({ onAttach: () => closure.record() });
		const live = liveCall(api.base, closure);
		try {
			const result = await settle(live.controller.start());
			expect((result as Error).message).toBe(named);
			expect(api.upgrades).toBe(1);
			await Bun.sleep(20);
			expect(api.received.every(frame => frame.type === "session.close")).toBe(true);
		} finally {
			await live.controller.stop();
			api.server.stop(true);
		}
	});

	// `stop()` awaits `send(session.close)`: a hold must never block or fail the call's end.
	test.each([
		["ends a held call cleanly, still sending session.close", true],
		["ends a call with no hold the same way (control)", false],
	] as const)("%s", async (_name, refused) => {
		const api = gptLiveServer();
		const closure = new CyberPolicyClosure();
		const live = liveCall(api.base, closure);
		try {
			await live.controller.start();
			if (refused) closure.record();
			await live.controller.stop();
			await until(() => api.received.length > 0);
			expect(api.received.map(frame => frame.type)).toEqual(["session.close"]);
			expect(live.terminal).toEqual([undefined]);
		} finally {
			await live.controller.stop();
			api.server.stop(true);
		}
	});
});
