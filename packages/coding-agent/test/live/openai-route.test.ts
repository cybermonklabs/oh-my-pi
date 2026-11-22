import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildOpenAILiveSessionRequest,
	type LiveServerEvent,
	OPENAI_LIVE_WIRE,
	parseOpenAILiveServerEvent,
} from "@oh-my-pi/pi-coding-agent/live/protocol";
import {
	LiveTransport,
	type OpenAILiveRoute,
	openAILiveAttachUrl,
	openAILiveSessionsUrl,
	resolveOpenAILiveRoute,
} from "@oh-my-pi/pi-coding-agent/live/transport";

/** Headers only Codex calls carry besides {@link OPENAI_HEADERS}; the public route must never send one. */
const CODEX_ONLY_HEADERS = ["x-oai-attestation", "openai-alpha", "x-session-id"];

/** Auth storage that fails the test if the openai route asks for a Codex login. */
const noCodexLogin = {
	oauth: {
		access: () => {
			throw new Error("the openai live route must not use Codex OAuth");
		},
	},
} as unknown as AuthStorage;

/** The key of a caller the gateway refuses. */
const REFUSED_KEY = "other";

interface LiveApiServerOptions {
	/** Response to `POST /v1/live/sessions`; defaults to a 201 with session `live_123`. */
	answer?: () => Response | Promise<Response>;
	/** Frames the sideband sends once attached. */
	events?: unknown[];
	/** Runs when the sideband's upgrade request arrives, before the server answers it. */
	onAttach?: () => void;
}

/** A local server speaking GPT-Live's public API (`/v1/live/sessions`), recording what it receives. */
function liveApiServer(options: LiveApiServerOptions = {}) {
	const posts: { request: Request; body: unknown }[] = [];
	const upgrades: Request[] = [];
	/** Resolves when a sideband the server accepted closes. */
	const sidebandClosed = Promise.withResolvers<void>();
	const received: unknown[] = [];
	const nextMessage = { resolve: (_: unknown) => {} };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/live/sessions") {
				posts.push({ request, body: await request.json() });
				return (
					options.answer?.() ??
					Response.json(
						{ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } },
						{ status: 201 },
					)
				);
			}
			if (url.pathname === "/v1/live/sessions/live_123/attach") {
				options.onAttach?.();
				if (!srv.upgrade(request)) return new Response("upgrade failed", { status: 400 });
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
				nextMessage.resolve(message);
			},
			close() {
				sidebandClosed.resolve();
			},
		},
	});
	const message = (): Promise<unknown> => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		nextMessage.resolve = resolve;
		return promise;
	};
	return {
		server,
		posts,
		upgrades,
		received,
		message,
		sidebandClosed: sidebandClosed.promise,
		base: `http://127.0.0.1:${server.port}/v1`,
	};
}

function openaiTransport(
	route: OpenAILiveRoute,
	onEvent: (event: LiveServerEvent) => void = () => {},
	signal?: AbortSignal,
): LiveTransport {
	return new LiveTransport({
		authStorage: noCodexLogin,
		openai: route,
		sessionId: "s1",
		instructions: "Be brief.",
		voice: "marin",
		sdpOffer: "v=0 offer",
		callbacks: { onEvent, onOutputLevel: () => {} },
		signal,
	});
}

function expectNoCodexHeaders(request: Request): void {
	for (const name of CODEX_ONLY_HEADERS) expect(request.headers.has(name)).toBe(false);
	for (const key in OPENAI_HEADERS) {
		expect(request.headers.has(OPENAI_HEADERS[key as keyof typeof OPENAI_HEADERS])).toBe(false);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GPT-Live public API URLs", () => {
	test("hangs the session and attach paths off the provider base", () => {
		for (const base of ["http://gw:4000/v1", "http://gw:4000/v1/"]) {
			expect(openAILiveSessionsUrl(base)).toBe("http://gw:4000/v1/live/sessions");
			expect(openAILiveAttachUrl(base, "live_1")).toBe("ws://gw:4000/v1/live/sessions/live_1/attach");
		}
		expect(openAILiveAttachUrl("https://api.openai.com/v1", "live/x y")).toBe(
			"wss://api.openai.com/v1/live/sessions/live%2Fx%20y/attach",
		);
	});
});

describe("GPT-Live route from models.yml", () => {
	test("takes the base URL and key of the openai provider", async () => {
		const asked: string[] = [];
		const registry = {
			getProviderBaseUrl: (provider: string) => {
				asked.push(provider);
				return "http://model-gateway:4000/v1";
			},
			getApiKeyForProvider: async (provider: string, sessionId?: string) => {
				asked.push(`${provider} key for ${sessionId}`);
				return "gw-key";
			},
		};
		const settings = Settings.isolated({ "live.model": "gpt-live-9" });
		expect(await resolveOpenAILiveRoute(registry, settings, "s1")).toEqual({
			baseUrl: "http://model-gateway:4000/v1",
			apiKey: "gw-key",
			model: "gpt-live-9",
		});
		expect(asked).toEqual(["openai", "openai key for s1"]);
	});

	test("defaults the model to gpt-live-1.1 and fails without a key", async () => {
		const keyless = {
			getProviderBaseUrl: () => "http://model-gateway:4000/v1",
			getApiKeyForProvider: async () => undefined,
		};
		await expect(resolveOpenAILiveRoute(keyless, Settings.isolated(), "s1")).rejects.toThrow(/openai provider.*key/);
		const keyed = { ...keyless, getApiKeyForProvider: async () => "k" };
		expect((await resolveOpenAILiveRoute(keyed, Settings.isolated(), "s1")).model).toBe("gpt-live-1.1");
	});
});

describe("GPT-Live transport", () => {
	test("posts the public session body with the provider's bearer and attaches to the session's sideband", async () => {
		const api = liveApiServer();
		const transport = openaiTransport({ baseUrl: api.base, apiKey: "gw-key", model: "gpt-live-1.1" });
		try {
			await transport.connect();
			expect(transport.sdpAnswer).toBe("v=0 answer");
			const post = api.posts[0]!;
			expect(api.posts).toHaveLength(1);
			expect(post.body).toEqual({
				session: {
					model: "gpt-live-1.1",
					instructions: "Be brief.",
					audio: { output: { voice: "marin" } },
					delegation: { type: "client" },
					idle_timeout_s: 60,
					wake_policy: { type: "speech" },
				},
				transport: { type: "webrtc", sdp: "v=0 offer" },
			});
			expect(post.request.headers.get("authorization")).toBe("Bearer gw-key");
			expect(post.request.headers.get("content-type")).toBe("application/json");
			expectNoCodexHeaders(post.request);
			const upgrade = api.upgrades[0]!;
			expect(new URL(upgrade.url).pathname).toBe("/v1/live/sessions/live_123/attach");
			expect(upgrade.headers.get("authorization")).toBe("Bearer gw-key");
			expectNoCodexHeaders(upgrade);
			// Nothing configures the session over the sideband: the POST carried it.
			const sent = api.message();
			await transport.send(OPENAI_LIVE_WIRE.progress("item_1", "Reading the build log."));
			expect(await sent).toEqual({
				type: "session.thinking.append",
				delegation_id: "item_1",
				content: "Reading the build log.",
			});
			expect(api.received).toHaveLength(1);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("maps the public events the sideband delivers, once each", async () => {
		const usage = { type: "session.usage.updated", event_id: "e4", usage: { seconds: 12 } };
		const api = liveApiServer({
			events: [
				{ type: "session.input_transcript.delta", event_id: "e1", delta: "deploy ", start_ms: 900, end_ms: 1200 },
				{ type: "session.output_transcript.delta", event_id: "e2", delta: "On it.", start_ms: 1500, end_ms: 1900 },
				{
					type: "session.delegation.created",
					event_id: "e3",
					offset_ms: 1300,
					delegation: { id: "item_9", type: "delegation", target: "client" },
				},
				usage,
				// The attach replay repeats an event the call already delivered.
				usage,
				{ type: "error", event_id: "e5", error: { message: "content too long", code: "invalid_value" } },
				{ type: "session.closed", event_id: "e6", reason: "expired", usage: { seconds: 7200 } },
			],
		});
		const events: LiveServerEvent[] = [];
		const done = Promise.withResolvers<void>();
		const transport = openaiTransport({ baseUrl: api.base, apiKey: "gw-key", model: "gpt-live-1.1" }, event => {
			events.push(event);
			if (event.type === "session.closed") done.resolve();
		});
		try {
			await transport.connect();
			await done.promise;
			expect(events).toEqual([
				{ type: "transcript.delta", role: "user", text: "deploy ", startMs: 900, endMs: 1200 },
				{ type: "transcript.delta", role: "assistant", text: "On it.", startMs: 1500, endMs: 1900 },
				{ type: "delegation.requested", id: "item_9", offsetMs: 1300 },
				{ type: "usage.updated", seconds: 12 },
				{ type: "warning", message: "content too long" },
				{ type: "session.closed", reason: "expired", seconds: 7200 },
			]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("reports a refused session with its status and body", async () => {
		const api = liveApiServer({
			answer: () =>
				Response.json(
					{ error: { message: "key may not use openai/gpt-live-1.1", type: "permission_error" } },
					{ status: 403 },
				),
		});
		const transport = openaiTransport({ baseUrl: api.base, apiKey: REFUSED_KEY, model: "gpt-live-1.1" });
		try {
			await expect(transport.connect()).rejects.toThrow(/GPT-Live session failed \(403\).*may not use/);
			expect(api.upgrades).toEqual([]);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("refuses a 201 without a session id or an SDP answer", async () => {
		const api = liveApiServer({ answer: () => Response.json({ session: {}, transport: {} }, { status: 201 }) });
		const transport = openaiTransport({ baseUrl: api.base, apiKey: "gw-key", model: "gpt-live-1.1" });
		try {
			await expect(transport.connect()).rejects.toThrow(/no session id/);
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("refuses a session id that is not letters, digits, _ and -, before it builds the attach URL", async () => {
		for (const id of ["..", "live/../x", "live 1"]) {
			const api = liveApiServer({
				answer: () => Response.json({ session: { id }, transport: { sdp: "v=0 answer" } }, { status: 201 }),
			});
			const transport = openaiTransport({ baseUrl: api.base, apiKey: "gw-key", model: "gpt-live-1.1" });
			try {
				await expect(transport.connect()).rejects.toThrow(/invalid session id/);
				expect(api.upgrades).toEqual([]);
			} finally {
				await transport.close();
				api.server.stop(true);
			}
		}
	});

	test("a redirect's error repeats at most 256 characters of its Location", async () => {
		const location = `http://elsewhere.invalid/${"a".repeat(10_000)}`;
		const redirecting = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null, { status: 307, headers: { Location: location } }),
		});
		const transport = openaiTransport({
			baseUrl: `http://127.0.0.1:${redirecting.port}/v1`,
			apiKey: "gw-key",
			model: "gpt-live-1.1",
		});
		try {
			const error = await transport.connect().then(
				() => undefined,
				(cause: unknown) => cause as Error,
			);
			expect(error?.message).toContain(`to ${location.slice(0, 256)}…; no redirect is followed`);
			expect(error!.message.length).toBeLessThan(400);
		} finally {
			await transport.close();
			redirecting.stop(true);
		}
	});

	test("follows no redirect, so the key never leaves the provider's origin", async () => {
		const elsewhere = liveApiServer();
		const redirecting = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null, { status: 307, headers: { Location: `${elsewhere.base}/live/sessions` } }),
		});
		const transport = openaiTransport({
			baseUrl: `http://127.0.0.1:${redirecting.port}/v1`,
			apiKey: "gw-key",
			model: "gpt-live-1.1",
		});
		try {
			await expect(transport.connect()).rejects.toThrow(/redirected \(307\)/);
			expect(elsewhere.posts).toEqual([]);
		} finally {
			await transport.close();
			redirecting.stop(true);
			elsewhere.server.stop(true);
		}
	});

	test("a sideband that opens after the transport closed is closed at once", async () => {
		// The stop lands between the sideband's upgrade request and its answer.
		const api = liveApiServer({ onAttach: () => void transport.close() });
		const transport = openaiTransport({ baseUrl: api.base, apiKey: "gw-key", model: "gpt-live-1.1" });
		try {
			await expect(transport.connect()).rejects.toThrow();
			expect(api.upgrades).toHaveLength(1);
			// A sideband kept open after the close never ends this wait, and the test times out.
			await api.sidebandClosed;
		} finally {
			await transport.close();
			api.server.stop(true);
		}
	});

	test("an abort cancels a connect, and leaves a call that is up for its owner to close", async () => {
		const api = liveApiServer();
		const abort = new AbortController();
		const route = { baseUrl: api.base, apiKey: "gw-key", model: "gpt-live-1.1" };
		const transport = openaiTransport(route, () => {}, abort.signal);
		try {
			await transport.connect();
			abort.abort(new Error("stopped"));
			const sent = api.message();
			await transport.send(OPENAI_LIVE_WIRE.progress("item_1", "Still here."));
			expect(await sent).toMatchObject({ type: "session.thinking.append", content: "Still here." });
			expect(transport.connected).toBe(true);
		} finally {
			await transport.close();
			api.server.stop(true);
		}

		const held = Promise.withResolvers<Response>();
		const posted = Promise.withResolvers<void>();
		const slow = liveApiServer({
			answer: () => {
				posted.resolve();
				return held.promise;
			},
		});
		const connecting = new AbortController();
		const cancelled = openaiTransport(
			{ baseUrl: slow.base, apiKey: "gw-key", model: "gpt-live-1.1" },
			() => {},
			connecting.signal,
		);
		try {
			const connect = cancelled.connect();
			await posted.promise;
			connecting.abort(new Error("stopped while connecting"));
			await expect(connect).rejects.toThrow(/stopped while connecting/);
			expect(slow.upgrades).toEqual([]);
		} finally {
			held.resolve(new Response(null, { status: 499 }));
			await cancelled.close();
			slow.server.stop(true);
		}
	});
});

describe("GPT-Live protocol", () => {
	test("builds the session request of the gateway contract", () => {
		expect(
			buildOpenAILiveSessionRequest({ model: "gpt-live-1.1", instructions: "Hi", voice: "cedar", sdp: "v=0" }),
		).toEqual({
			session: {
				model: "gpt-live-1.1",
				instructions: "Hi",
				audio: { output: { voice: "cedar" } },
				delegation: { type: "client" },
				idle_timeout_s: 60,
				wake_policy: { type: "speech" },
			},
			transport: { type: "webrtc", sdp: "v=0" },
		});
	});

	test("sends progress as silent thinking and the result as speech", () => {
		expect(OPENAI_LIVE_WIRE.progress("item_1", "Running the tests.")).toEqual({
			type: "session.thinking.append",
			delegation_id: "item_1",
			content: "Running the tests.",
		});
		expect(OPENAI_LIVE_WIRE.result("item_1", "They pass.")).toEqual({
			type: "session.commentary.append",
			delegation_id: "item_1",
			content: "They pass.",
		});
	});

	test("ignores delegations for another target and malformed transcript deltas", () => {
		expect(
			parseOpenAILiveServerEvent({
				type: "session.delegation.created",
				offset_ms: 10,
				delegation: { id: "item_1", type: "delegation", target: "responses" },
			}),
		).toBeNull();
		expect(parseOpenAILiveServerEvent({ type: "session.input_transcript.delta", delta: 3 })).toBeNull();
		expect(parseOpenAILiveServerEvent("not json")).toBeNull();
		expect(parseOpenAILiveServerEvent({ type: "session.paused" })).toEqual({
			type: "unknown",
			wireType: "session.paused",
		});
	});
});
