import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";

/**
 * A whole call on `live.provider: openai`: the controller with the real GPT-Live transport, against a
 * local server speaking GPT-Live's public API. The session stands in for the agent: it records each
 * delegated turn.
 */

const KEY = "sk-call-test";
interface StubOptions {
	/** Answer to the session POST; defaults to a 201 for `sessionId`. */
	answer?: (request: Request) => Response;
	/** The session id of the default answer; defaults to `live_1`. */
	sessionId?: string;
	/** Frames the sideband sends once attached. */
	frames?: unknown[];
	/** Called with each message omp writes on the sideband. */
	onMessage?: (message: Record<string, unknown>, socket: ServerWebSocket<unknown>) => void;
	/** Closes the sideband this long after it opens. */
	closeAfterMs?: number;
}

function gptLiveStub(options: StubOptions = {}) {
	const posts: unknown[] = [];
	const upgrades: string[] = [];
	const sessionId = options.sessionId ?? "live_1";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/live/sessions") {
				posts.push(await request.json());
				return (
					options.answer?.(request) ??
					Response.json({ session: { id: sessionId }, transport: { sdp: "v=0 answer" } }, { status: 201 })
				);
			}
			if (url.pathname === `/v1/live/sessions/${encodeURIComponent(sessionId)}/attach` && srv.upgrade(request)) {
				upgrades.push(url.pathname);
				return undefined;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(socket) {
				for (const frame of options.frames ?? []) socket.send(JSON.stringify(frame));
				if (options.closeAfterMs !== undefined) setTimeout(() => socket.close(1011, "gone"), options.closeAfterMs);
			},
			message(socket, data) {
				options.onMessage?.(JSON.parse(String(data)), socket);
			},
		},
	});
	return { server, posts, upgrades, base: `http://127.0.0.1:${server.port}/v1` };
}

function liveCall(base: string, apiKey: () => Promise<string> = async () => KEY) {
	const turns: string[] = [];
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		modelRegistry: { authStorage: {}, getProviderBaseUrl: () => base, getApiKeyForProvider: apiKey },
		settings: Settings.isolated({ "live.provider": "openai" }),
		sessionId: "s1",
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		sendCustomMessage: async (message: { customType?: string; content?: unknown }) => {
			if (message.customType === LIVE_DELEGATION_MESSAGE_TYPE) turns.push(String(message.content));
			return false;
		},
	} as unknown as LiveSessionControllerOptions["session"];
	const ended = Promise.withResolvers<Error | undefined>();
	const controller = new LiveSessionController({
		session,
		extractAssistantText: () => "CI is green.",
		sdpOffer: "v=0 offer",
		callbacks: {
			onPhase: () => {},
			onLevels: () => {},
			onTranscript: () => {},
			onTerminal: error => ended.resolve(error),
		},
	});
	return {
		controller,
		turns,
		ended: ended.promise,
		/** The agent's turn ends: the controller sends its answer to the call. */
		answer: () =>
			listener?.({
				type: "agent_end",
				isTerminal: true,
				messages: [{ role: "assistant" }],
			} as unknown as AgentSessionEvent),
	};
}

/** Waits until `check` holds, for at most `ms`; the test's own expectations say what went wrong. */
async function until(check: () => boolean, ms = 4_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await Bun.sleep(10);
}

describe("GPT-Live call lifecycle", () => {
	test("a stop while the key resolves sends no session request and leaves no call open", async () => {
		const stub = gptLiveStub();
		const key = Promise.withResolvers<string>();
		let asked = false;
		const call = liveCall(stub.base, () => {
			asked = true;
			return key.promise;
		});
		try {
			const starting = call.controller.start().then(
				() => "started",
				(error: unknown) => `refused: ${String(error)}`,
			);
			await until(() => asked);
			// The stop ends while the key is still resolving (an OAuth pick, a key command, an auth broker).
			await call.controller.stop();
			key.resolve(KEY);
			expect(await starting).toStartWith("refused");
			await Bun.sleep(100);
			expect(stub.posts).toEqual([]);
			expect(stub.upgrades).toEqual([]);
		} finally {
			await call.controller.stop();
			stub.server.stop(true);
		}
	}, 10_000);
});
