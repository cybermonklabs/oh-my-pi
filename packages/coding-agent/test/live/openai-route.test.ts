import { describe, expect, test } from "bun:test";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import {
	OpenAILiveTransport,
	openAILiveAttachUrl,
	openAILiveSessionsUrl,
	resolveOpenAILiveRoute,
} from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import { buildDelegationContextAppend, type LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";

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

function transportFor(base: string, onEvent: (event: LiveServerEvent) => void = () => {}): OpenAILiveTransport {
	return new OpenAILiveTransport({
		route: { baseUrl: base, apiKey: "sk-test", model: "gpt-live-1.1" },
		instructions: "Be brief.",
		sdpOffer: "v=0 offer",
		callbacks: { onEvent, onOutputLevel: () => {} },
	});
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
		const keyless = { ...keyed, getApiKeyForProvider: async () => undefined };
		await expect(resolveOpenAILiveRoute(keyless, "s1")).rejects.toThrow(/openai provider has no key/);
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
			// The controller's delegation messages, in Codex's form: progress on the commentary channel, the result spoken.
			let sent = api.message();
			await transport.send(buildDelegationContextAppend("item_1", "Reading the log.", "commentary"));
			expect(await sent).toEqual({
				type: "session.thinking.append",
				delegation_id: "item_1",
				content: "Reading the log.",
			});
			sent = api.message();
			await transport.send(buildDelegationContextAppend("item_1", "CI is green."));
			expect(await sent).toEqual({
				type: "session.commentary.append",
				delegation_id: "item_1",
				content: "CI is green.",
			});
			sent = api.message();
			await transport.send({ type: "session.close" });
			expect(await sent).toEqual({ type: "session.close" });
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("maps the sideband's events onto the controller's, once each; a delegation gets the user's words since the previous one", async () => {
		const delegation = (id: string, eventId: string) => ({
			type: "session.delegation.created",
			event_id: eventId,
			offset_ms: 1300,
			delegation: { id, type: "delegation", target: "client" },
		});
		const first = delegation("item_9", "e4");
		const api = liveApiServer({
			events: [
				{ type: "session.input_transcript.delta", event_id: "e1", delta: "deploy ", start_ms: 900, end_ms: 1000 },
				{ type: "session.input_transcript.delta", event_id: "e2", delta: "main", start_ms: 1000, end_ms: 1200 },
				{ type: "session.output_transcript.delta", event_id: "e3", delta: "On it.", start_ms: 1500, end_ms: 1900 },
				first,
				// The attach replays what the call already delivered.
				first,
				{ type: "session.usage.updated", event_id: "e5", usage: { seconds: 12 } },
				// An error such as an invalid client command leaves the session open: logged, not a failure.
				{ type: "error", event_id: "e6", error: { message: "content too long", code: "invalid_value" } },
				{ type: "session.input_transcript.delta", event_id: "e7", delta: 3 },
				{ ...delegation("item_x", "e8"), delegation: { id: "item_x", type: "delegation", target: "responses" } },
				{
					type: "session.input_transcript.delta",
					event_id: "e9",
					delta: " and test",
					start_ms: 2000,
					end_ms: 2400,
				},
				delegation("item_10", "e10"),
				delegation("item_11", "e11"),
			],
		});
		const events: LiveServerEvent[] = [];
		const done = Promise.withResolvers<void>();
		const transport = transportFor(api.base, event => {
			events.push(event);
			if (event.type === "delegation.created" && event.item.id === "item_11") done.resolve();
		});
		const delegated = (id: string, text?: string): LiveServerEvent => ({
			type: "delegation.created",
			item: { type: "delegation", target: "client", id, content: text ? [{ type: "input_text", text }] : [] },
		});
		try {
			await transport.connect();
			await done.promise;
			expect(events).toEqual([
				{ type: "input_transcript.added", item: { text: "deploy " } },
				{ type: "input_transcript.added", item: { text: "deploy main" } },
				{ type: "turn.done", turn: { role: "user", transcript: "deploy main" } },
				{ type: "output_transcript.added", item: { text: "On it." } },
				delegated("item_9", "deploy main"),
				{ type: "unknown", wireType: "session.usage.updated" },
				{ type: "turn.done", turn: { role: "assistant", transcript: "On it." } },
				{ type: "input_transcript.added", item: { text: " and test" } },
				// Sent at once with the words that have arrived; with none, the controller makes no turn.
				delegated("item_10", "and test"),
				delegated("item_11"),
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
});
