import { describe, expect, test } from "bun:test";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	OpenAILiveTransport,
	openAILiveAttachUrl,
	openAILiveSessionsUrl,
	resolveOpenAILiveRoute,
} from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import {
	buildOpenAILiveSessionRequest,
	type LiveServerEvent,
	parseOpenAILiveServerEvent,
} from "@oh-my-pi/pi-coding-agent/live/protocol";

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
		voice: "marin",
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

	test("takes the openai provider's base URL and key, and live.model", async () => {
		const asked: string[] = [];
		const registry = {
			getProviderBaseUrl: (provider: string) => {
				asked.push(provider);
				return "http://model-gateway:4000/v1";
			},
			getApiKeyForProvider: async (provider: string, sessionId?: string) => {
				asked.push(`${provider} key for ${sessionId}`);
				return "sk-test";
			},
		};
		expect(await resolveOpenAILiveRoute(registry, Settings.isolated({ "live.model": "gpt-live-9" }), "s1")).toEqual({
			baseUrl: "http://model-gateway:4000/v1",
			apiKey: "sk-test",
			model: "gpt-live-9",
		});
		expect(asked).toEqual(["openai key for s1", "openai"]);
	});

	test("defaults to OpenAI's API and gpt-live-1.1, and refuses to start without a key", async () => {
		const keyed = { getProviderBaseUrl: () => undefined, getApiKeyForProvider: async () => "sk-test" };
		expect(await resolveOpenAILiveRoute(keyed, Settings.isolated(), "s1")).toEqual({
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-test",
			model: "gpt-live-1.1",
		});
		const keyless = { ...keyed, getApiKeyForProvider: async () => undefined };
		await expect(resolveOpenAILiveRoute(keyless, Settings.isolated(), "s1")).rejects.toThrow(
			/openai provider has no key/,
		);
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
			expect(post.body).toEqual(
				buildOpenAILiveSessionRequest({
					model: "gpt-live-1.1",
					instructions: "Be brief.",
					voice: "marin",
					sdp: "v=0 offer",
				}),
			);
			expect(post.body).toMatchObject({
				session: { delegation: { type: "client" }, idle_timeout_s: 60, wake_policy: { type: "speech" } },
				transport: { type: "webrtc" },
			});
			expect(post.request.headers.get("authorization")).toBe("Bearer sk-test");
			expectNoCodexHeaders(post.request);
			const upgrade = api.upgrades[0]!;
			expect(new URL(upgrade.url).pathname).toBe("/v1/live/sessions/live_123/attach");
			expect(upgrade.headers.get("authorization")).toBe("Bearer sk-test");
			expectNoCodexHeaders(upgrade);
			const sent = api.message();
			await transport.send({
				type: "session.thinking.append",
				delegation_id: "item_1",
				content: "Reading the log.",
			});
			expect(await sent).toEqual({
				type: "session.thinking.append",
				delegation_id: "item_1",
				content: "Reading the log.",
			});
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("delivers the sideband's events once each, mapped onto the controller's", async () => {
		const usage = { type: "session.usage.updated", event_id: "e4", usage: { seconds: 12 } };
		const delegation = {
			type: "session.delegation.created",
			event_id: "e3",
			offset_ms: 1300,
			delegation: { id: "item_9", type: "delegation", target: "client" },
		};
		const api = liveApiServer({
			events: [
				{ type: "session.input_transcript.delta", event_id: "e1", delta: "deploy ", start_ms: 900, end_ms: 1200 },
				{ type: "session.output_transcript.delta", event_id: "e2", delta: "On it.", start_ms: 1500, end_ms: 1900 },
				delegation,
				// The attach replays what the call already delivered.
				delegation,
				usage,
				{ type: "error", event_id: "e5", error: { message: "content too long", code: "invalid_value" } },
				{ type: "session.closed", event_id: "e6", reason: "expired" },
			],
		});
		const events: LiveServerEvent[] = [];
		const closed = Promise.withResolvers<void>();
		const transport = transportFor(api.base, event => {
			events.push(event);
			if (event.type === "session.closed") closed.resolve();
		});
		try {
			await transport.connect();
			await closed.promise;
			expect(events).toEqual([
				{ type: "transcript.delta", role: "user", text: "deploy ", startMs: 900, endMs: 1200 },
				{ type: "transcript.delta", role: "assistant", text: "On it.", startMs: 1500, endMs: 1900 },
				{ type: "delegation.requested", id: "item_9", offsetMs: 1300 },
				{ type: "unknown", wireType: "session.usage.updated" },
				{ type: "warning", message: "content too long" },
				{ type: "session.closed", reason: "expired" },
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

describe("GPT-Live events", () => {
	test("ignore delegations for another target and malformed transcript deltas", () => {
		expect(
			parseOpenAILiveServerEvent({
				type: "session.delegation.created",
				offset_ms: 10,
				delegation: { id: "item_1", type: "delegation", target: "responses" },
			}),
		).toBeNull();
		expect(parseOpenAILiveServerEvent({ type: "session.input_transcript.delta", delta: 3 })).toBeNull();
		expect(parseOpenAILiveServerEvent("not json")).toBeNull();
	});
});
