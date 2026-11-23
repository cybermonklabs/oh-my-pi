import { afterEach, describe, expect, test, vi } from "bun:test";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import {
	OpenAILiveTransport,
	type OpenAILiveTransportOptions,
	openAILiveAttachUrl,
	openAILiveSessionsUrl,
	resolveOpenAILiveRoute,
} from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import {
	buildDelegationContextAppend,
	buildSessionContextAppend,
	type LiveServerEvent,
} from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as natives from "@oh-my-pi/pi-natives";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Headers only Codex calls carry besides {@link OPENAI_HEADERS}; the API route must never send one. */
const CODEX_ONLY_HEADERS = ["x-oai-attestation", "openai-alpha", "x-session-id"];

interface ApiServerOptions {
	/** Response to `POST /v1/live/sessions`; defaults to a 201 with session `live_123`. */
	answer?: () => Response;
	/** Frames the sideband sends once attached. */
	events?: unknown[];
}

/** A local server speaking GPT-Live's public API, recording what it receives. */
function liveApiServer(options: ApiServerOptions = {}) {
	const posts: { request: Request; body: unknown }[] = [];
	const upgrades: Request[] = [];
	const received: unknown[] = [];
	let nextMessage = (_: unknown) => {};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/live/sessions") {
				posts.push({ request, body: await request.json() });
				return (
					options.answer?.() ??
					Response.json({ session: { id: "live_123" }, transport: { sdp: "v=0 answer" } }, { status: 201 })
				);
			}
			if (url.pathname === "/v1/live/sessions/live_123/attach" && srv.upgrade(request)) {
				upgrades.push(request);
				return undefined;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(socket) {
				for (const event of options.events ?? []) socket.send(JSON.stringify(event));
			},
			message(_socket, data) {
				const message = JSON.parse(String(data));
				received.push(message);
				nextMessage(message);
			},
		},
	});
	const message = (): Promise<unknown> => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		nextMessage = resolve;
		return promise;
	};
	return { server, posts, upgrades, received, message, base: `http://127.0.0.1:${server.port}/v1` };
}

function transportFor(
	base: string,
	onEvent: (event: LiveServerEvent) => void = () => {},
	options: Partial<OpenAILiveTransportOptions> = {},
): OpenAILiveTransport {
	return new OpenAILiveTransport({
		registry: { getProviderBaseUrl: () => base, getApiKeyForProvider: async () => "sk-test" },
		sessionId: "s1",
		instructions: "Be brief.",
		sdpOffer: "v=0 offer",
		callbacks: { onEvent, onOutputLevel: () => {} },
		...options,
	});
}

/** A native media peer the transport made (a stand-in). */
interface NativePeer {
	/** Delivers `event` on the peer's data channel. */
	emit(event: unknown): void;
}

/**
 * Replaces the native media peer with a stand-in whose data channel opens at once, after `onOpen`
 * runs; returns each one made.
 */
function nativePeers(onOpen: (peer: NativePeer) => void = () => {}): NativePeer[] {
	const made: NativePeer[] = [];
	// bun's spyOn types a class export's implementation as `never`; a plain function (called with `new`) stands in.
	const spy = vi.spyOn(natives, "LiveWebRtcPeer") as unknown as {
		mockImplementation(implementation: (onEvent: (error: Error | null, payload: string) => void) => object): void;
	};
	spy.mockImplementation(function (onEvent) {
		const peer = {
			emit: (event: unknown) => onEvent(null, JSON.stringify(event)),
			createOffer: async () => "v=0 native offer",
			acceptAnswer: async () => {},
			waitForOpen: async () => onOpen(peer),
			setMuted: () => {},
			pushAudio: () => {},
			close: async () => {},
		};
		made.push(peer);
		return peer;
	});
	return made;
}

/** A delegated turn holding `words`, as the transport labels them. */
function heard(id: string, words: string): LiveServerEvent {
	const text = `The user's words for this request, from speech-to-text. They can hold recognition errors and speech that was not a request:\n\n> ${words}`;
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
	};
}

function expectNoCodexHeaders(request: Request): void {
	for (const name of CODEX_ONLY_HEADERS) expect(request.headers.has(name)).toBe(false);
	for (const name of Object.values(OPENAI_HEADERS)) expect(request.headers.has(name)).toBe(false);
}

describe("GPT-Live route", () => {
	test("hangs the session and attach paths off the provider base", () => {
		for (const base of ["https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
			expect(openAILiveSessionsUrl(base)).toBe("https://api.openai.com/v1/live/sessions");
			expect(openAILiveAttachUrl(base, "live_1")).toBe("wss://api.openai.com/v1/live/sessions/live_1/attach");
		}
		expect(openAILiveAttachUrl("http://gw:4000/v1", "live_1")).toBe("ws://gw:4000/v1/live/sessions/live_1/attach");
	});

	test("takes the openai provider's base URL and key, and asks for gpt-live-1.1", async () => {
		const asked: string[] = [];
		const registry = {
			getProviderBaseUrl: (provider: string) => {
				asked.push(provider);
				return "https://gateway.example/v1";
			},
			getApiKeyForProvider: async (provider: string, sessionId?: string) => {
				asked.push(`${provider} key for ${sessionId}`);
				return "sk-test";
			},
		};
		expect(await resolveOpenAILiveRoute(registry, "s1")).toEqual({
			baseUrl: "https://gateway.example/v1",
			apiKey: "sk-test",
			model: "gpt-live-1.1",
		});
		expect(asked).toEqual(["openai key for s1", "openai"]);
	});

	test("defaults to OpenAI's API, and refuses to start without a key", async () => {
		const keyed = { getProviderBaseUrl: () => undefined, getApiKeyForProvider: async () => "sk-test" };
		expect((await resolveOpenAILiveRoute(keyed, "s1")).baseUrl).toBe("https://api.openai.com/v1");
		for (const key of [undefined, kNoAuth]) {
			const keyless = { ...keyed, getApiKeyForProvider: async () => key };
			await expect(resolveOpenAILiveRoute(keyless, "s1")).rejects.toThrow(/openai provider has no key/);
		}
	});
});

describe("GPT-Live transport", () => {
	test("posts the session body with the key and no Codex header, and attaches to the session's sideband", async () => {
		const api = liveApiServer();
		const transport = transportFor(api.base);
		try {
			await transport.connect();
			expect(transport.sdpAnswer).toBe("v=0 answer");
			expect(api.posts).toHaveLength(1);
			const post = api.posts[0]!;
			// The body a GPT-Live gateway route answered 201 to (2026-11-22).
			expect(post.body).toEqual({
				session: { model: "gpt-live-1.1", instructions: "Be brief.", delegation: { type: "client" } },
				transport: { type: "webrtc", sdp: "v=0 offer" },
			});
			expect(post.request.headers.get("authorization")).toBe("Bearer sk-test");
			expectNoCodexHeaders(post.request);
			const upgrade = api.upgrades[0]!;
			expect(new URL(upgrade.url).pathname).toBe("/v1/live/sessions/live_123/attach");
			expect(upgrade.headers.get("authorization")).toBe("Bearer sk-test");
			expectNoCodexHeaders(upgrade);
			// The controller's messages, in Codex's form: a delegation's progress on the commentary channel and
			// its result spoken; context outside a delegation the same, with no delegation id. Each has an event_id.
			const cases = [
				[
					buildDelegationContextAppend("item_1", "Reading.", "commentary"),
					"session.thinking.append",
					"item_1",
					"Reading.",
				],
				[
					buildDelegationContextAppend("item_1", "CI is green."),
					"session.commentary.append",
					"item_1",
					"CI is green.",
				],
				[buildSessionContextAppend("Heads up.", "commentary"), "session.thinking.append", null, "Heads up."],
				[buildSessionContextAppend("Build done."), "session.commentary.append", null, "Build done."],
			] as const;
			for (const [message, type, delegationId, content] of cases) {
				const sent = api.message();
				await transport.send(message);
				expect(await sent).toEqual({
					type,
					delegation_id: delegationId,
					content,
					event_id: expect.stringMatching(/^omp_\d+$/),
				});
			}
			const closing = api.message();
			await transport.send({ type: "session.close" });
			expect(await closing).toEqual({ type: "session.close", event_id: expect.stringMatching(/^omp_\d+$/) });
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("maps the sideband's events onto the controller's, once each", async () => {
		const delegation = (id: string, eventId: string, offsetMs: number, target = "client") => ({
			type: "session.delegation.created",
			event_id: eventId,
			offset_ms: offsetMs,
			delegation: { id, type: "delegation", target },
		});
		const user = (eventId: string, delta: unknown, startMs: number, endMs: number) => ({
			type: "session.input_transcript.delta",
			event_id: eventId,
			delta,
			start_ms: startMs,
			end_ms: endMs,
		});
		const first = delegation("item_9", "e4", 1_300);
		const api = liveApiServer({
			events: [
				user("e1", "deploy ", 900, 1_000),
				user("e2", "main", 1_000, 1_200),
				{
					type: "session.output_transcript.delta",
					event_id: "e3",
					delta: "On it.",
					start_ms: 1_500,
					end_ms: 1_900,
				},
				first,
				// The attach replays what the call already delivered.
				first,
				{ type: "session.usage.updated", event_id: "e5", usage: { seconds: 12 } },
				// An error that names nothing omp sent leaves the session open: logged, not a failure.
				{ type: "error", event_id: "e6", error: { message: "content too long", code: "invalid_value" } },
				user("e7", 3, 1_950, 2_000),
				delegation("item_x", "e8", 2_000, "responses"),
				user("e9", " and test", 2_000, 2_400),
				delegation("item_10", "e10", 2_500),
				user("e11", " thanks", 2_600, 2_900),
			],
		});
		const events: LiveServerEvent[] = [];
		const done = Promise.withResolvers<void>();
		const transport = transportFor(api.base, event => {
			events.push(event);
			if (event.type === "delegation.created" && event.item.id === "item_10") done.resolve();
		});
		try {
			await transport.connect();
			await done.promise;
			expect(events).toEqual([
				{ type: "input_transcript.added", item: { text: "deploy " } },
				{ type: "input_transcript.added", item: { text: "deploy main" } },
				{ type: "turn.done", turn: { role: "user", transcript: "deploy main" } },
				{ type: "output_transcript.added", item: { text: "On it." } },
				// The voice's transcript has passed the offset, and the user's words before it are in.
				heard("item_9", "deploy main"),
				{ type: "unknown", wireType: "session.usage.updated" },
				{ type: "turn.done", turn: { role: "assistant", transcript: "On it." } },
				{ type: "input_transcript.added", item: { text: " and test" } },
				{ type: "input_transcript.added", item: { text: " and test thanks" } },
				// The user's transcript has passed the offset: the words after it wait for the next delegation.
				heard("item_10", "and test"),
			]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("reports a refused session with its status and body, and attaches nothing", async () => {
		const api = liveApiServer({
			answer: () => Response.json({ error: { message: "this key may not use gpt-live-1.1" } }, { status: 403 }),
		});
		const transport = transportFor(api.base);
		try {
			await expect(transport.connect()).rejects.toThrow(/GPT-Live session failed \(403\).*may not use/);
			expect(api.upgrades).toEqual([]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("refuses a 201 without a session id or SDP answer, and a session id that could move the sideband path", async () => {
		for (const [session, pattern] of [
			[{}, /no session id/],
			[{ id: "." }, /invalid session id/],
			[{ id: ".." }, /invalid session id/],
		] as const) {
			const api = liveApiServer({
				answer: () => Response.json({ session, transport: { sdp: "v=0 answer" } }, { status: 201 }),
			});
			const transport = transportFor(api.base);
			try {
				await expect(transport.connect()).rejects.toThrow(pattern);
				expect(api.upgrades).toEqual([]);
			} finally {
				await transport.close();
				api.server.stop(true);
			}
		}
	});

	test("follows no redirect, so the key never leaves the provider's origin", async () => {
		const elsewhere = liveApiServer();
		const redirecting = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null, { status: 307, headers: { Location: `${elsewhere.base}/live/sessions` } }),
		});
		const transport = transportFor(`http://127.0.0.1:${redirecting.port}/v1`);
		try {
			await expect(transport.connect()).rejects.toThrow(/redirected \(307\)/);
			expect(elsewhere.posts).toEqual([]);
		} finally {
			await transport.close();
			redirecting.stop(true);
			elsewhere.server.stop(true);
		}
	});

	test("a close while the key resolves makes no native peer and sends no session request", async () => {
		const api = liveApiServer();
		const peers = nativePeers();
		const key = Promise.withResolvers<string>();
		const transport = transportFor(api.base, undefined, {
			registry: { getProviderBaseUrl: () => api.base, getApiKeyForProvider: () => key.promise },
			sdpOffer: undefined,
		});
		try {
			const connecting = transport.connect().then(
				() => "connected",
				(error: unknown) => `refused: ${String(error)}`,
			);
			await transport.close();
			key.resolve("sk-test");
			expect(await connecting).toStartWith("refused");
			expect(peers).toEqual([]);
			expect(api.posts).toEqual([]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("takes the data channel's events until the sideband attaches, then only the sideband's", async () => {
		const user = (eventId: string, delta: string) => ({
			type: "session.input_transcript.delta",
			event_id: eventId,
			delta,
			start_ms: 0,
			end_ms: 100,
		});
		// The sideband replays what the data channel delivered before it attached.
		const api = liveApiServer({ events: [user("e1", "deploy"), user("e2", " main")] });
		const peers = nativePeers(peer => peer.emit(user("e1", "deploy")));
		const events: LiveServerEvent[] = [];
		const attached = Promise.withResolvers<void>();
		const transport = transportFor(
			api.base,
			event => {
				events.push(event);
				if (event.type === "input_transcript.added" && event.item.text === "deploy main") attached.resolve();
			},
			{ sdpOffer: undefined },
		);
		try {
			await transport.connect();
			await attached.promise;
			peers[0]!.emit(user("e3", " now"));
			expect(events).toEqual([
				{ type: "input_transcript.added", item: { text: "deploy" } },
				{ type: "input_transcript.added", item: { text: "deploy main" } },
			]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("closing the call stops the timer of a delegation still waiting for the user's words", async () => {
		const api = liveApiServer({
			events: [
				{
					type: "session.delegation.created",
					event_id: "e1",
					offset_ms: 5_000,
					delegation: { id: "item_1", type: "delegation", target: "client" },
				},
				{ type: "session.input_transcript.delta", event_id: "e2", delta: "deploy", start_ms: 100, end_ms: 400 },
			],
		});
		const setTimer = vi.spyOn(globalThis, "setTimeout");
		const clearTimer = vi.spyOn(globalThis, "clearTimeout");
		const heardWords = Promise.withResolvers<void>();
		const transport = transportFor(api.base, event => {
			if (event.type === "input_transcript.added") heardWords.resolve();
		});
		try {
			await transport.connect();
			// The words end before the delegation's offset, so it waits for more, at most its 1 s cap.
			await heardWords.promise;
			const cap = setTimer.mock.calls.findIndex(([, ms]) => ms === 1_000);
			expect(cap).toBeGreaterThanOrEqual(0);
			const timer = setTimer.mock.results[cap]?.value;
			await transport.close();
			// By identity: every Timeout equals every other under `toHaveBeenCalledWith`'s deep equality.
			expect(clearTimer.mock.calls.some(([cleared]) => cleared === timer)).toBe(true);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});
});
