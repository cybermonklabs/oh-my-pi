import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { RpcLiveBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { RpcLiveFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-control";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const STOPPED = "Live call did not start: The live call was stopped while it connected";

/**
 * Whether `check` holds within `ms`. The bound is the property tested: the answer must come while a real local
 * server still holds the session request, so it cannot be driven by fake timers (real sockets and fetch).
 */
async function within(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await Bun.sleep(10);
	return check();
}

/**
 * GPT-Live's public API on a local port. The first session request is held until `release()` (a server that
 * does not answer); later ones are answered at once. Sideband messages are recorded by session.
 */
function gptLiveServer() {
	let posts = 0;
	let abortedPosts = 0;
	const firstPost = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const messages: { session: string; type: unknown }[] = [];
	const server = Bun.serve<{ session: string }>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/live/sessions") {
				await request.json();
				const n = ++posts;
				if (n === 1) {
					request.signal.addEventListener("abort", () => abortedPosts++, { once: true });
					firstPost.resolve();
					await release.promise;
				}
				return Response.json({ session: { id: `live_${n}` }, transport: { sdp: "v=0 answer" } }, { status: 201 });
			}
			const attach = /^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(decodeURIComponent(url.pathname));
			if (attach && srv.upgrade(request, { data: { session: attach[1]! } })) return undefined;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				messages.push({ session: ws.data.session, type: JSON.parse(String(message)).type });
			},
		},
	});
	return {
		server,
		firstPost: firstPost.promise,
		release: () => release.resolve(),
		posts: () => posts,
		abortedPosts: () => abortedPosts,
		messages,
		base: `http://127.0.0.1:${server.port}/v1`,
	};
}

/** The real bridge, controller and GPT-Live transport (an SDP offer: signaling only, no host audio), run by `/live`. */
function typedLive(base: string) {
	const session = {
		modelRegistry: { authStorage: {}, getProviderBaseUrl: () => base, getApiKeyForProvider: async () => "sk-test" },
		settings: Settings.isolated({ "live.provider": "openai" }),
		sessionId: "s1",
		cyberPolicyClosure: { active: false },
		subscribe: () => () => {},
		sendCustomMessage: async () => false,
	} as unknown as AgentSession;
	const frames: RpcLiveFrame[] = [];
	const bridge = new RpcLiveBridge(session, frame => frames.push(frame), {
		createSession: options =>
			new LiveSessionController({ ...(options as LiveSessionControllerOptions), sdpOffer: "v=0 offer" }),
	});
	const lines: string[] = [];
	const background: Promise<void>[] = [];
	const abort = new AbortController();
	// The runtime of an RPC `prompt` frame's built-in: `/live on` connects in the background.
	const runtime = {
		live: bridge,
		output: (text: string) => {
			lines.push(text);
		},
		signal: abort.signal,
		runCommandInBackground: (task: () => Promise<void>) => {
			background.push(task());
		},
	} as unknown as SlashCommandRuntime;
	const spec = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "live")!;
	const run = async (args: string) => {
		await spec.handle!({ name: "live", args, text: `/live ${args}` }, runtime);
	};
	return { bridge, frames, lines, background, abort, run };
}

describe("a stop while a GPT-Live call connects (real controller and transport)", () => {
	test("/live off during the session request ends the call clean, and the pending /live on answers at once", async () => {
		const stub = gptLiveServer();
		const live = typedLive(stub.base);
		try {
			await live.run("on");
			await stub.firstPost;
			expect(stub.posts()).toBe(1);
			await live.run("status");
			expect(live.lines.at(-1)).toMatch(/^Live call starting since \S+Z: openai, microphone on\.$/);

			await live.run("off");
			expect(live.lines.at(-1)).toBe("Live call ended.");
			// The session request is still unanswered: the start ends because the stop aborted it.
			const answered = await within(() => live.lines.includes(STOPPED), 2_000);
			console.log(
				`STOP-DURING-CONNECT answered=${answered} lines=${JSON.stringify(live.lines)} frames=${JSON.stringify(live.frames)} server_saw_abort=${stub.abortedPosts()}`,
			);
			expect(answered).toBe(true);
			// A stop before the call is up ends clean: no error phase, and nothing is sent to a session not yet made.
			expect(live.frames).toEqual([{ type: "live_phase", phase: "connecting" }, { type: "live_end" }]);
			expect(stub.messages).toEqual([]);
			await live.run("status");
			expect(live.lines.at(-1)).toBe("No live call is open.");

			// Control: an open call's stop is told to the server (`session.close`) and ends clean too.
			live.frames.length = 0;
			await live.run("on");
			await live.background.at(-1);
			expect(live.lines.at(-1)).toBe("Live call open: openai.");
			await live.run("off");
			expect(live.lines.at(-1)).toBe("Live call ended.");
			expect(live.frames.filter(frame => frame.type === "live_phase" && frame.phase === "error")).toEqual([]);
			expect(live.frames.at(-1)).toEqual({ type: "live_end" });
			// The server reads the sideband's message after the client has gone on; wait for it, not for a guessed time.
			expect(await within(() => stub.messages.length > 0, 2_000)).toBe(true);
			expect(stub.messages).toEqual([{ session: "live_2", type: "session.close" }]);
		} finally {
			stub.release();
			await live.bridge.stop();
			stub.server.stop(true);
		}
	}, 20_000);

	test("an RPC abort during the session request stops the call the same way", async () => {
		const stub = gptLiveServer();
		const live = typedLive(stub.base);
		try {
			await live.run("on");
			await stub.firstPost;
			expect(stub.posts()).toBe(1);
			live.abort.abort("RPC command aborted by host");
			expect(await within(() => live.lines.includes(STOPPED), 2_000)).toBe(true);
			expect(live.lines).toEqual([STOPPED]);
			expect(live.bridge.status()).toEqual({ state: "off" });
			expect(live.frames).toEqual([{ type: "live_phase", phase: "connecting" }, { type: "live_end" }]);
		} finally {
			stub.release();
			await live.bridge.stop();
			stub.server.stop(true);
		}
	}, 20_000);
});
