import { afterEach, describe, expect, it, vi } from "bun:test";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { analyzeAuthError } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import type { JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { postmortem } from "@oh-my-pi/pi-utils";
import { nextTask } from "../../ai/test/helpers";

const encoder = new TextEncoder();
/** The deadline the timeout tests hand the transport; they move it on a fake clock. */
const REQUEST_TIMEOUT_MS = 50;
const realFetch = globalThis.fetch;

let server: Bun.Server<undefined> | null = null;

type ToolList = {
	tools: { name: string; inputSchema: { type: string } }[];
};

afterEach(() => {
	vi.useRealTimers();
	globalThis.fetch = realFetch;
	server?.stop(true);
	server = null;
});

/**
 * A transport on the test server. Only a test of the deadline itself hands the transport one, and
 * it drives that deadline on a fake clock: a real deadline measures the machine, and a loaded
 * runner reaches it before the request gets to the behaviour under test.
 */
async function connectedTransport(timeout = 0): Promise<HttpTransport> {
	if (!server) throw new Error("Test server was not started");
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout,
	});
	await transport.connect();
	return transport;
}

function stalledBodyResponse(bodyPrefix: string, init?: ResponseInit): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(bodyPrefix));
			},
		}),
		init,
	);
}

interface ObservedFetch {
	/** The signal the transport handed fetch: its deadline, caller cancellation and close. */
	signal: AbortSignal | undefined;
	/** Settles when the response headers reach the transport. */
	headers: Promise<void>;
	/** Settles when the transport starts reading the body with `json()` or `text()`. */
	bodyRead: Promise<void>;
}

/**
 * Send every fetch the transport makes on to the test server unchanged while recording its
 * phases, so a timeout test moves the fake clock only once the transport is in the phase under
 * test. A fake-timer deadline aborts Bun's real fetch and body stream like a real one does. The
 * returned function resolves once the transport has started its `index`-th fetch.
 */
function observeFetches(): (index: number) => Promise<ObservedFetch> {
	const started: PromiseWithResolvers<ObservedFetch>[] = [];
	const slot = (index: number) => {
		started[index] ??= Promise.withResolvers<ObservedFetch>();
		return started[index];
	};
	let count = 0;
	globalThis.fetch = (async (input, init) => {
		const headers = Promise.withResolvers<void>();
		const bodyRead = Promise.withResolvers<void>();
		slot(count++).resolve({
			signal: init?.signal ?? undefined,
			headers: headers.promise,
			bodyRead: bodyRead.promise,
		});
		const response = await realFetch(input, init);
		for (const reader of ["json", "text"] as const) {
			const read = response[reader].bind(response);
			Object.defineProperty(response, reader, {
				value: () => {
					bodyRead.resolve();
					return read();
				},
			});
		}
		headers.resolve();
		return response;
	}) as typeof globalThis.fetch;
	return index => slot(index).promise;
}

/**
 * Fire a resume's SSE `retry` wait as soon as the transport arms it. The transport arms that timer
 * once it has read the end of the POST stream, which the test cannot see, so this watches the fake
 * timer count rise past `timersBefore` (the request's deadline is already among them). Bun fires a
 * 0 ms timer 1 ms after it is armed, so this moves the fake clock by 1 ms; a test that needs the
 * exact deadline measures it with `Date.now()`, which the fake clock drives.
 */
async function fireRetryTimer(request: Promise<unknown>, timersBefore: number): Promise<void> {
	let settled = false;
	const settle = () => {
		settled = true;
	};
	void request.then(settle, settle);
	while (vi.getTimerCount() <= timersBefore) {
		if (settled) throw new Error("The request settled before the transport armed its SSE retry wait");
		await nextTask();
	}
	vi.advanceTimersToNextTimer();
}

describe("MCP Streamable HTTP request progress", () => {
	it("routes pre-result SSE progress but only fans out malformed, unknown, and post-result frames", async () => {
		let sent: JsonRpcRequest | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				sent = (await req.json()) as JsonRpcRequest;
				const token = (sent.params?._meta as Record<string, unknown> | undefined)?.progressToken;
				const notification = (progressToken: unknown, progress: unknown) => ({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken, progress, total: 3, message: "fetching" },
				});
				const messages = [
					notification(String(token), 99),
					notification(token, "invalid"),
					notification(token, 1),
					{ jsonrpc: "2.0", id: sent.id, result: { done: true } },
					notification(token, 2),
				];
				return new Response(
					`data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":${JSON.stringify(token)},"progress":1e309}}\n\n` +
						`data: ${JSON.stringify(messages)}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport();
		const updates: MCPProgress[] = [];
		const notifications: unknown[] = [];
		transport.onNotification = (method, params) => {
			if (method === "notifications/progress") notifications.push(params);
		};
		try {
			const args = Object.freeze({ query: "unchanged" });
			const meta = Object.freeze({ trace: "keep", progressToken: "replace" });
			const result = await transport.request(
				"tools/call",
				{ name: "search", arguments: args, _meta: meta },
				{
					onProgress: progress => updates.push(progress),
				},
			);

			expect(result).toEqual({ done: true });
			expect(sent?.params?._meta).toEqual({ trace: "keep", progressToken: sent?.id });
			expect(sent?.params?.arguments).toEqual(args);
			expect(meta).toEqual({ trace: "keep", progressToken: "replace" });
			expect(updates).toEqual([{ progress: 1, total: 3, message: "fetching" }]);
			expect(notifications).toHaveLength(5);
			expect(notifications).toContainEqual(expect.objectContaining({ progress: 2 }));
		} finally {
			await transport.close();
		}
	});

	it("routes GET-listener progress during a pending POST and stops after settlement", async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		let token: unknown;
		const release = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stream = controller;
								controller.enqueue(encoder.encode(": connected\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const body = (await req.json()) as JsonRpcRequest;
				token = (body.params?._meta as Record<string, unknown> | undefined)?.progressToken;
				stream?.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							method: "notifications/progress",
							params: { progressToken: token, progress: 1 },
						})}\n\n`,
					),
				);
				await release.promise;
				return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
			},
		});
		const transport = await connectedTransport();
		const progressReceived = Promise.withResolvers<void>();
		const lateReceived = Promise.withResolvers<void>();
		const updates: MCPProgress[] = [];
		transport.onNotification = (_method, params) => {
			if ((params as Record<string, unknown>).progress === 2) lateReceived.resolve();
		};
		try {
			await transport.startSSEListener();
			const pending = transport.request(
				"tools/call",
				{},
				{
					onProgress: progress => {
						updates.push(progress);
						progressReceived.resolve();
					},
				},
			);
			// The server holds the POST until `release`, so progress seen before then arrived while
			// the request was pending.
			await progressReceived.promise;
			release.resolve();
			await pending;
			expect(updates).toEqual([{ progress: 1 }]);
			stream?.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: token, progress: 2 },
					})}\n\n`,
				),
			);
			await lateReceived.promise;
			expect(updates).toEqual([{ progress: 1 }]);
		} finally {
			release.resolve();
			await transport.close();
		}
	});

	it("allocates a new progress token for an HTTP auth retry", async () => {
		const ids: (string | number)[] = [];
		const tokens: unknown[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as JsonRpcRequest;
				ids.push(body.id);
				tokens.push((body.params?._meta as Record<string, unknown> | undefined)?.progressToken);
				if (ids.length === 1) return new Response("expired", { status: 401 });
				return new Response(
					`data: ${JSON.stringify([
						{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: ids[0], progress: 99 } },
						{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: body.id, progress: 1 } },
						{ jsonrpc: "2.0", id: body.id, result: {} },
					])}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport();
		transport.onAuthError = async () => ({ Authorization: "Bearer refreshed" });
		const updates: MCPProgress[] = [];
		try {
			await transport.request("tools/call", {}, { onProgress: progress => updates.push(progress) });
			expect(ids).toHaveLength(2);
			expect(ids[0]).not.toBe(ids[1]);
			expect(tokens).toEqual(ids);
			expect(updates).toEqual([{ progress: 1 }]);
		} finally {
			await transport.close();
		}
	});
});

describe("MCP Streamable HTTP initialization", () => {
	it("sends initialized before opening the optional GET SSE stream", async () => {
		const requests: string[] = [];
		let initialized = false;
		let sessionValid = true;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					requests.push("GET");
					if (initialized) return new Response(null, { status: 405 });
					sessionValid = false;
					return new Response("session is not initialized", { status: 400 });
				}
				if (req.method === "DELETE") return new Response(null, { status: 204 });

				const body = (await req.json()) as { id?: string | number; method: string };
				requests.push(body.method);
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "session-order", version: "1.0.0" },
						},
					};
					return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
						headers: {
							"Content-Type": "text/event-stream",
							"Mcp-Session-Id": "session-order",
						},
					});
				}
				if (!sessionValid) return new Response("session terminated", { status: 409 });
				initialized = true;
				return new Response(null, { status: 202 });
			},
		});

		const connection = await connectToServer("session-order", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 0,
		});

		expect(requests).toEqual(["initialize", "notifications/initialized", "GET"]);
		await connection.transport.close();
	});

	it("aborts a stalled GET SSE listener start on the caller signal when timeouts are disabled", async () => {
		const listenerStarted = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					listenerStarted.resolve();
					// Never answers: with timeouts disabled only the caller signal can end the handshake.
					return Promise.withResolvers<Response>().promise;
				}
				if (req.method === "DELETE") return new Response(null, { status: 204 });
				const body = (await req.json()) as { id?: string | number; method: string };
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "stalled-listener", version: "1.0.0" },
						},
					};
					return new Response(JSON.stringify(response), {
						headers: { "Content-Type": "application/json", "Mcp-Session-Id": "stalled-listener" },
					});
				}
				return new Response(null, { status: 202 });
			},
		});

		const controller = new AbortController();
		const connection = connectToServer(
			"stalled-listener",
			{ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 0 },
			{ signal: controller.signal },
		);
		await listenerStarted.promise;
		controller.abort();
		await expect(connection).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("MCP Streamable HTTP failure diagnostics", () => {
	it("does not replay an accepted JSON response whose body is cut short", async () => {
		const tcp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket) {
					socket.end(
						'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"jsonrpc":"2.0",',
					);
				},
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${tcp.port}/mcp`,
			timeout: 0,
		});
		try {
			await transport.connect();
			await expect(transport.request("tools/list")).rejects.toMatchObject({
				transport: "http",
				stage: "decode",
				retryable: false,
			});
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("classifies a reset after connecting as non-replayable without leaking Bun fetch advice", async () => {
		const tcp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.end();
				},
				data() {},
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${tcp.port}/mcp`,
			timeout: 0,
		});
		try {
			await transport.connect();
			const error = await transport.request("tools/list").then(
				() => undefined,
				reason => reason,
			);
			if (!(error instanceof MCPTransportError)) throw error;
			expect(error).toMatchObject({
				transport: "http",
				stage: "send",
				failure: "reset",
				retryable: false,
				code: "ECONNRESET",
			});
			expect(error.message).not.toContain("verbose");
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("distinguishes connection refusal from a reset", async () => {
		const unused = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = unused.port;
		unused.stop(true);
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${port}/mcp`,
			timeout: 0,
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "http",
			stage: "connect",
			failure: "connect",
			retryable: true,
		});
		await transport.close();
	});

	it("classifies malformed JSON-RPC responses at the decode stage", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("{not-json", { headers: { "Content-Type": "application/json" } });
			},
		});
		const transport = await connectedTransport();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});

	it("preserves bounded redacted JSON-RPC data and a response trace ID", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { id: string | number };
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						error: {
							code: -32042,
							message: "upstream rejected the call",
							data: { detail: "x".repeat(3_000), token: "server-secret", traceId: "data-trace" },
						},
					},
					{ headers: { "X-Request-Id": "request-abc123" } },
				);
			},
		});
		const transport = await connectedTransport();
		const error = await transport.request("tools/list").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error).toMatchObject({
			transport: "http",
			stage: "protocol",
			failure: "json_rpc",
			retryable: false,
			code: -32042,
			traceId: "request-abc123",
		});
		expect(error.data?.length).toBeLessThanOrEqual(2_000);
		expect(error.data).toContain("[redacted]");
		expect(error.data).not.toContain("server-secret");
	});

	it("keeps a bare Bearer resource_metadata challenge while redacting echoed credentials", async () => {
		const metadataUrl = "https://auth.example.test/prm/probe";
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("rejected Authorization: Bearer server-secret", {
					status: 401,
					headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
				});
			},
		});
		const transport = await connectedTransport();
		const error = await transport.request("initialize").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error.message).not.toContain("server-secret");
		const auth = analyzeAuthError(error, `http://127.0.0.1:${server.port}/mcp`);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.resourceMetadataUrl).toBe(metadataUrl);
	});
});

describe("MCP Streamable HTTP transport timeouts", () => {
	it("keeps the request timeout active until a JSON response body is fully read", async () => {
		vi.useFakeTimers();
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse('{"jsonrpc":"2.0","id":"', {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const fetched = observeFetches();
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);

		const request = transport.request("tools/list");
		const post = await fetched(0);
		await post.bodyRead;
		vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
		// The deadline aborts the fetch whose body is being read; a read it no longer bounds would
		// wait for the test server's own idle timeout instead.
		expect(post.signal?.aborted).toBe(true);

		await expect(request).rejects.toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "timeout",
			retryable: false,
			message: `Request timeout after ${REQUEST_TIMEOUT_MS}ms`,
		});
	});

	it("uses one deadline across delayed SSE headers and a stalled response body", async () => {
		// One deadline spans both phases: it expires `timeoutMs` after the request starts, however
		// that time splits between waiting for headers and reading the body. A deadline restarted
		// at the headers would still be running at `timeoutMs`.
		vi.useFakeTimers();
		const timeoutMs = 250;
		const headerDelayMs = 160;
		const requestReceived = Promise.withResolvers<void>();
		const sendHeaders = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch() {
				requestReceived.resolve();
				await sendHeaders.promise;
				return stalledBodyResponse(": accepted\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const fetched = observeFetches();
		const transport = await connectedTransport(timeoutMs);

		try {
			const request = transport.request("tools/list");
			const post = await fetched(0);
			await requestReceived.promise;
			vi.advanceTimersByTime(headerDelayMs);
			sendHeaders.resolve();
			await post.headers;
			// Let the transport reach the stalled body read.
			await nextTask();
			vi.advanceTimersByTime(timeoutMs - headerDelayMs - 1);
			expect(post.signal?.aborted).toBe(false);
			vi.advanceTimersByTime(1);
			expect(post.signal?.aborted).toBe(true);
			await expect(request).rejects.toMatchObject({
				transport: "http",
				stage: "receive",
				failure: "timeout",
				retryable: false,
			});
		} finally {
			await transport.close();
		}
	});

	it("keeps the timeout result when the caller aborts before the JSON body rejection propagates", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const originalFetch = globalThis.fetch;
		const jsonStarted = Promise.withResolvers<void>();
		globalThis.fetch = (async (_input, init) => {
			const response = new Response(null, { headers: { "Content-Type": "application/json" } });
			Object.assign(response, {
				json: () => {
					const { promise, reject } = Promise.withResolvers<unknown>();
					const rejectBodyRead = () => {
						caller.abort();
						reject(new SyntaxError("Unexpected end of JSON input"));
					};
					if (init?.signal?.aborted) rejectBodyRead();
					else init?.signal?.addEventListener("abort", rejectBodyRead, { once: true });
					jsonStarted.resolve();
					return promise;
				},
			});
			return response;
		}) as typeof globalThis.fetch;
		try {
			const transport = new HttpTransport({
				type: "http",
				url: "http://mcp.invalid",
				timeout: REQUEST_TIMEOUT_MS,
			});
			await transport.connect();
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			await jsonStarted.promise;
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);

			await expect(request).rejects.toThrow(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
		} finally {
			globalThis.fetch = originalFetch;
			vi.useRealTimers();
		}
	});

	it("does not report a timeout when caller cancellation wins a delayed JSON body rejection", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const originalFetch = globalThis.fetch;
		const jsonStarted = Promise.withResolvers<void>();
		globalThis.fetch = (async (_input, init) => {
			const response = new Response(null, { headers: { "Content-Type": "application/json" } });
			Object.assign(response, {
				json: () => {
					const { promise, reject } = Promise.withResolvers<unknown>();
					init?.signal?.addEventListener(
						"abort",
						() => {
							setTimeout(() => reject(new SyntaxError("Unexpected end of JSON input")), REQUEST_TIMEOUT_MS + 20);
						},
						{ once: true },
					);
					jsonStarted.resolve();
					return promise;
				},
			});
			return response;
		}) as typeof globalThis.fetch;
		try {
			const transport = new HttpTransport({
				type: "http",
				url: "http://mcp.invalid",
				timeout: REQUEST_TIMEOUT_MS,
			});
			await transport.connect();
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			await jsonStarted.promise;
			caller.abort();
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 20);

			await expect(request).rejects.toThrow("Unexpected end of JSON input");
		} finally {
			globalThis.fetch = originalFetch;
			vi.useRealTimers();
		}
	});

	it("keeps the notify timeout active while reading HTTP error bodies", async () => {
		vi.useFakeTimers();
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse("partial failure body", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				});
			},
		});
		const fetched = observeFetches();
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);

		const notification = transport.notify("notifications/initialized");
		const post = await fetched(0);
		await post.bodyRead;
		vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
		// The deadline aborts the fetch whose body is being read; a read it no longer bounds would
		// wait for the test server's own idle timeout instead.
		expect(post.signal?.aborted).toBe(true);

		await expect(notification).rejects.toThrow(`Notify timeout after ${REQUEST_TIMEOUT_MS}ms`);
	});

	it("close aborts and drains an in-flight SSE POST request", async () => {
		const requestReceived = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse("", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport();

		const request = transport.request("tools/list");
		await requestReceived.promise;
		const closing = transport.close();

		const requestError = await request.then(
			() => undefined,
			error => error,
		);
		expect(requestError).toMatchObject({ name: "AbortError" });
		expect(postmortem.isExpectedCleanupError(requestError)).toBe(true);
		await closing;
	});

	it("preserves caller cancellation when it wins a stalled SSE response", async () => {
		// The deadline stays armed on a fake clock that never reaches it, so the caller wins.
		vi.useFakeTimers();
		const caller = new AbortController();
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse(": accepted\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const fetched = observeFetches();
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);

		try {
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			const post = await fetched(0);
			await post.headers;
			// Let the transport reach the stalled body read.
			await nextTask();
			caller.abort();

			const error = await request.then(
				() => undefined,
				reason => reason,
			);
			expect(error).toMatchObject({ name: "AbortError" });
			expect(error).not.toBeInstanceOf(MCPTransportError);
		} finally {
			await transport.close();
		}
	});

	it("keeps draining an accepted request stream after its caller aborts", async () => {
		const caller = new AbortController();
		const notificationReceived = Promise.withResolvers<void>();
		const sendNotification = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { id: string | number };
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(`data: {"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{}}\n\n`),
							);
							void sendNotification.promise.then(() => {
								if (cancelled) return;
								try {
									controller.enqueue(
										encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
									);
									controller.close();
								} catch {
									// The negative path intentionally cancels the client stream.
								}
							});
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport();
		transport.onNotification = method => {
			if (method === "notifications/progress") notificationReceived.resolve();
		};

		try {
			await transport.request("tools/list", undefined, { signal: caller.signal });
			caller.abort();
			sendNotification.resolve();
			await notificationReceived.promise;
		} finally {
			await transport.close();
		}
	});

	it("keeps draining an accepted notification stream past the POST deadline", async () => {
		vi.useFakeTimers();
		const notificationReceived = Promise.withResolvers<void>();
		const sendNotification = Promise.withResolvers<void>();
		const streamCancelled = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch() {
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(": accepted\n\n"));
							void sendNotification.promise.then(() => {
								if (cancelled) return;
								try {
									// Held open afterwards: a client that drops the stream shows up
									// as `cancel`, never as a clean end.
									controller.enqueue(
										encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
									);
								} catch {
									// The client already dropped the stream; `cancel` reports it.
								}
							});
						},
						cancel() {
							cancelled = true;
							streamCancelled.resolve();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);
		transport.onNotification = method => {
			if (method === "notifications/progress") notificationReceived.resolve();
		};

		try {
			await transport.notify("notifications/initialized");
			// Pass the POST deadline on the fake clock. A deadline still bound to the accepted
			// stream fires here and cancels it.
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 2);
			sendNotification.resolve();
			const outcome = await Promise.race([
				notificationReceived.promise.then(() => "drained"),
				streamCancelled.promise.then(() => "cancelled"),
			]);
			expect(outcome).toBe("drained");
		} finally {
			await transport.close();
		}
	});

	it("keeps an abandoned SSE request rejection observed after caller cancellation", async () => {
		// The deadline stays armed on a fake clock that never reaches it, so the caller's abort is
		// what rejects the request.
		vi.useFakeTimers();
		const requestReceived = Promise.withResolvers<void>();
		const caller = new AbortController();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse("", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			void transport.request("tools/list", undefined, { signal: caller.signal });
			await requestReceived.promise;
			caller.abort();
			await nextTask();

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await transport.close();
		}
	});
});

describe("MCP Streamable HTTP protocol version header", () => {
	it("never lets a configured MCP-Protocol-Version reach the server", async () => {
		const seen: { pre: string | null; post: string | null } = { pre: null, post: null };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const body = req.headers.get("MCP-Protocol-Version");
				return Response.json({ jsonrpc: "2.0", id: 1, result: { seen: body } });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 0,
			headers: { "MCP-Protocol-Version": "1999-01-01" },
		});
		await transport.connect();

		// Pre-negotiation: configured header must be stripped, not leaked.
		seen.pre = (await transport.request<{ seen: string | null }>("initialize")).seen;
		// Post-negotiation: the negotiated version wins over the configured one.
		transport.setProtocolVersion("2025-11-25");
		seen.post = (await transport.request<{ seen: string | null }>("tools/list")).seen;

		expect(seen.pre).toBeNull();
		expect(seen.post).toBe("2025-11-25");
	});
});

describe("MCP Streamable HTTP POST response resumption", () => {
	it("reports a timeout when a resumed HTTP error body stalls", async () => {
		vi.useFakeTimers();
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					posts++;
					return new Response("id: stream-1\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return stalledBodyResponse("unavailable", { status: 503 });
			},
		});
		const fetched = observeFetches();
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);
		try {
			const request = transport.request("tools/call");
			await fireRetryTimer(request, vi.getTimerCount());
			const resume = await fetched(1);
			await resume.bodyRead;
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
			// The original deadline aborts the resume fetch whose body is being read; a read it no
			// longer bounds would wait for the test server's own idle timeout instead.
			expect(resume.signal?.aborted).toBe(true);

			await expect(request).rejects.toMatchObject({
				failure: "timeout",
				retryable: false,
			});
			expect(posts).toBe(1);
		} finally {
			await transport.close();
		}
	});

	it("bounds resumed-stream auth refresh by the original request deadline", async () => {
		// The deadline runs from the POST, not from the resume: part of it passes before the server
		// accepts the request, and the rest runs out while the auth refresh is pending.
		vi.useFakeTimers();
		const spentBeforeAcceptMs = 30;
		const postReceived = Promise.withResolvers<void>();
		const acceptPost = Promise.withResolvers<void>();
		const refreshStarted = Promise.withResolvers<void>();
		const refresh = Promise.withResolvers<Record<string, string> | null>();
		let posts = 0;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST") {
					posts++;
					postReceived.resolve();
					await acceptPost.promise;
					return new Response("id: stream-1\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return new Response("expired", { status: 401 });
			},
		});
		const fetched = observeFetches();
		const transport = await connectedTransport(REQUEST_TIMEOUT_MS);
		transport.onAuthError = () => {
			refreshStarted.resolve();
			return refresh.promise;
		};
		try {
			const startedAt = Date.now();
			const request = transport.request("tools/call");
			const timers = vi.getTimerCount();
			await postReceived.promise;
			vi.advanceTimersByTime(spentBeforeAcceptMs);
			acceptPost.resolve();
			await fireRetryTimer(request, timers);
			await refreshStarted.promise;
			const resume = await fetched(1);
			// Stop 1 ms short of the deadline, measured on the fake clock from the request start.
			vi.advanceTimersByTime(startedAt + REQUEST_TIMEOUT_MS - 1 - Date.now());
			expect(resume.signal?.aborted).toBe(false);
			vi.advanceTimersByTime(1);
			expect(resume.signal?.aborted).toBe(true);
			// The refresh answers only after the deadline: a transport that waited for it instead of
			// the deadline reports the failed refresh, not the timeout.
			refresh.resolve(null);

			await expect(request).rejects.toMatchObject({
				failure: "timeout",
				retryable: false,
			});
			expect(posts).toBe(1);
		} finally {
			refresh.resolve(null);
			await transport.close();
		}
	});

	it("resumes a closed response stream with Last-Event-ID after the requested retry delay", async () => {
		const observed: {
			lastEventId: string | null;
			protocolVersion: string | null;
			postClosedAt: number;
			resumedAt: number;
		} = { lastEventId: null, protocolVersion: null, postClosedAt: 0, resumedAt: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.postClosedAt = performance.now();
					return new Response("id: stream-1\nretry: 20\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.resumedAt = performance.now();
				observed.lastEventId = req.headers.get("Last-Event-ID");
				observed.protocolVersion = req.headers.get("MCP-Protocol-Version");
				return new Response(
					'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 0,
		});
		await transport.connect();
		transport.setProtocolVersion("2025-11-25");

		await expect(transport.request<ToolList>("tools/list")).resolves.toEqual({
			tools: [{ name: "resumed", inputSchema: { type: "object" } }],
		});
		expect(observed.lastEventId).toBe("stream-1");
		expect(observed.protocolVersion).toBe("2025-11-25");
		expect(observed.resumedAt - observed.postClosedAt).toBeGreaterThanOrEqual(15);
	});
	it("refreshes auth on a 401 resume GET without replaying the POST", async () => {
		const observed = { posts: 0, gets: 0, auth: [] as (string | null)[], lastEventId: null as string | null };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.posts++;
					return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.gets++;
				observed.auth.push(req.headers.get("Authorization"));
				observed.lastEventId = req.headers.get("Last-Event-ID");
				if (req.headers.get("Authorization") !== "Bearer fresh") {
					return new Response("expired", { status: 401 });
				}
				return new Response(
					'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 0,
			headers: { Authorization: "Bearer stale" },
		});
		transport.onAuthError = async () => ({ Authorization: "Bearer fresh" });
		await transport.connect();

		await expect(transport.request<ToolList>("tools/list")).resolves.toEqual({
			tools: [{ name: "resumed", inputSchema: { type: "object" } }],
		});
		// One POST only: replaying it after the server accepted the request
		// could double-execute a state-changing tool.
		expect(observed.posts).toBe(1);
		expect(observed.gets).toBe(2);
		expect(observed.auth).toEqual(["Bearer stale", "Bearer fresh"]);
		expect(observed.lastEventId).toBe("stream-1");
	});

	it("never replays the POST when a resume GET stays unauthorized", async () => {
		const observed = { posts: 0, gets: 0, refreshes: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.posts++;
					return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.gets++;
				return new Response("expired", { status: 401 });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 0,
			headers: { Authorization: "Bearer stale" },
		});
		// A live refresh would tempt #requestWithAuthRetry to re-POST if the
		// SSEResumeError identity were lost during normalization.
		transport.onAuthError = async () => {
			observed.refreshes++;
			return { Authorization: "Bearer fresh" };
		};
		await transport.connect();

		await expect(transport.request("tools/call")).rejects.toBeDefined();
		// The server accepted the POST once; auth refresh happens inside the resume
		// GET only, and the originating POST is never replayed.
		expect(observed.posts).toBe(1);
		expect(observed.gets).toBe(2);
		expect(observed.refreshes).toBe(1);
	});
	it("marks a clean accepted SSE EOF without an event ID as non-replayable", async () => {
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch() {
				posts++;
				return new Response("", { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const transport = await connectedTransport();

		await expect(transport.request("tools/call")).rejects.toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "eof",
			retryable: false,
		});
		expect(posts).toBe(1);
	});
});

describe("MCP Streamable HTTP GET listener resumption", () => {
	it("resumes the long-lived GET stream with Last-Event-ID instead of reconnecting", async () => {
		const observed = { gets: 0, lastEventIds: [] as (string | null)[] };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method !== "GET") {
					return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
				}
				observed.gets++;
				observed.lastEventIds.push(req.headers.get("Last-Event-ID"));
				if (observed.gets === 1) {
					// Polling-style server: deliver one notification with an
					// event ID, then close the physical connection.
					return new Response(
						'id: poll-1\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/first"}\n\n',
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const response = new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode('id: poll-2\ndata: {"jsonrpc":"2.0","method":"notifications/second"}\n\n'),
							);
							// Held open: the logical stream continues.
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
				return response;
			},
		});
		const transport = await connectedTransport();
		const notifications: string[] = [];
		let closed = false;
		const secondNotification = Promise.withResolvers<void>();
		transport.onNotification = method => {
			notifications.push(method);
			if (notifications.length === 2) secondNotification.resolve();
		};
		transport.onError = error => secondNotification.reject(error);
		transport.onClose = () => {
			closed = true;
			secondNotification.reject(new Error("Logical SSE listener closed before the resumed notification"));
		};

		try {
			await transport.startSSEListener();
			await secondNotification.promise;

			expect(notifications).toEqual(["notifications/first", "notifications/second"]);
			expect(observed.lastEventIds).toEqual([null, "poll-1"]);
			// The resume replaced the manager-level reconnect: no close fired.
			expect(closed).toBe(false);
		} finally {
			await transport.close();
		}
	});
});
