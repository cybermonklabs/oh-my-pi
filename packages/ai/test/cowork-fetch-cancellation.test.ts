import { afterEach, describe, expect, it, vi } from "bun:test";
import * as events from "node:events";
import { getEventListeners } from "node:events";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import * as AIError from "@oh-my-pi/pi-ai/error";

class StubClientRequest extends http.ClientRequest {
	constructor() {
		super({ path: "/", createConnection: () => new net.Socket() });
	}

	override end(): this {
		return this;
	}
}

/**
 * These fixtures supply body chunks and termination manually, so the inert
 * socket must not be treated as a backing body source.
 */
class ManualIncomingMessage extends http.IncomingMessage {
	override _read(_size: number): void {}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("coworkFetch response cancellation", () => {
	it("destroys a compressed response source when its web body is cancelled", async () => {
		const socket = new net.Socket();
		const message = new ManualIncomingMessage(socket);
		message.statusCode = 200;
		message.statusMessage = "OK";
		message.headers = { "content-encoding": "gzip" };
		message.rawHeaders = ["content-encoding", "gzip"];

		const compressed = zlib.gzipSync("event: message_stop\ndata: {}\n\n");
		message.push(compressed.subarray(0, -8));

		const request = new StubClientRequest();
		vi.spyOn(https, "request").mockImplementation((_options, callback) => {
			if (typeof callback === "function") callback(message);
			return request;
		});

		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			headers: { accept: "text/event-stream" },
		});
		if (!response.body) throw new Error("Expected a streaming response body.");
		const reader = response.body.getReader();
		const chunk = await reader.read();
		expect(new TextDecoder().decode(chunk.value)).toContain("event: message_stop");

		const closed = Promise.withResolvers<void>();
		message.once("close", closed.resolve);
		await reader.cancel();
		await closed.promise;

		expect(message.destroyed).toBe(true);
	});
});

// Bun's node:http shim surfaces a body cut off mid-stream as a bare
// `Error("aborted")` (ECONNRESET), which classified as unknown and ended the
// session with no retry. It must reach the reader as a retryable socket close,
// while a caller abort keeps its own error.
describe("coworkFetch premature response close", () => {
	async function streamingResponse(signal?: AbortSignal) {
		const message = new ManualIncomingMessage(new net.Socket());
		message.statusCode = 200;
		message.statusMessage = "OK";
		message.headers = { "content-type": "text/event-stream" };
		message.rawHeaders = ["content-type", "text/event-stream"];
		message.push("event: ping\ndata: {}\n\n");
		vi.spyOn(https, "request").mockImplementation((_options, callback) => {
			if (typeof callback === "function") callback(message);
			return new StubClientRequest();
		});
		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			headers: { accept: "text/event-stream" },
			signal,
		});
		if (!response.body) throw new Error("Expected a streaming response body.");
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(new TextDecoder().decode(first.value)).toContain("event: ping");
		expect(message.complete).toBe(false);
		expect(message.readableEnded).toBe(false);
		expect(message.destroyed).toBe(false);
		return { message, reader };
	}

	function cutOff(message: http.IncomingMessage): void {
		message.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
	}

	it("surfaces a mid-body connection drop as a retryable socket close", async () => {
		const { message, reader } = await streamingResponse();
		cutOff(message);
		const error = await reader.read().then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("socket connection was closed unexpectedly");
		const finalized = await AIError.finalize(error, { api: "anthropic-messages", provider: "anthropic" });
		expect(finalized.stopReason).toBe("error");
		expect(AIError.retriable(finalized.id)).toBe(true);
	});

	it("keeps the original error when the caller aborted the request", async () => {
		const controller = new AbortController();
		const { message, reader } = await streamingResponse(controller.signal);
		controller.abort();
		cutOff(message);
		const error = await reader.read().then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect((error as Error).message).toBe("aborted");
	});
});

// Bun's node:http shim emits 'close' but not 'error' for `request.destroy(error)`.
// A request whose upstream never sent headers stayed pending after the caller
// aborted it, so the first-event watchdog's abort could never surface and the
// turn hung with no socket open and no retry.
describe("coworkFetch abort before response headers", () => {
	it("rejects with the abort reason when the upstream never answers", async () => {
		const request = new StubClientRequest();
		vi.spyOn(https, "request").mockImplementation(() => request);
		const controller = new AbortController();
		let outcome: unknown = "pending";
		void coworkFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { accept: "text/event-stream" },
			body: "{}",
			signal: controller.signal,
		}).then(
			() => {
				outcome = "resolved";
			},
			(reason: unknown) => {
				outcome = reason;
			},
		);
		const reason = new Error("Anthropic stream timed out while waiting for the first event");
		controller.abort(reason);
		// The abort listener runs synchronously, so a settled request is visible after
		// a few microtask turns; a pending one never settles, so drain rather than wait.
		for (let turn = 0; turn < 20 && outcome === "pending"; turn++) await Promise.resolve();

		expect(outcome).toBe(reason);
		expect(request.destroyed).toBe(true);
	});
});

// A session keeps one abort signal for a whole turn and sends many requests
// through it, so a request that registers an abort listener and never removes
// it leaves a closure holding that request — its headers, its body, and every
// tool definition in it — for the rest of the session. The observable contract
// is therefore a count that does not grow with the number of requests.
describe("coworkFetch abort listener retention", () => {
	it("holds no listener per completed response on one long-lived signal", async () => {
		const controller = new AbortController();
		for (let n = 0; n < 24; n++) {
			const message = new ManualIncomingMessage(new net.Socket());
			message.statusCode = 200;
			message.statusMessage = "OK";
			message.headers = { "content-type": "text/event-stream" };
			message.rawHeaders = ["content-type", "text/event-stream"];
			message.push("event: message_stop\ndata: {}\n\n");
			message.push(null);
			vi.spyOn(https, "request").mockImplementation((_options, callback) => {
				queueMicrotask(() => {
					if (typeof callback === "function") callback(message);
				});
				return new StubClientRequest();
			});
			const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { accept: "text/event-stream" },
				body: "{}",
				signal: controller.signal,
			});
			await response.text();
			// The removal runs from the message's 'close', which can land a tick
			// after the body resolves; await the event itself, never a delay.
			if (!message.closed) await events.once(message, "close");
		}

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	// `https.request` validates header names and values and throws
	// synchronously on a bad one, so the request object never exists and
	// neither its 'error' nor a response 'close' can ever run the removal.
	// Before the fix this left exactly one listener per rejected attempt.
	it("holds no listener for a request rejected before it reaches the wire", async () => {
		const controller = new AbortController();
		for (let n = 0; n < 5; n++) {
			const rejected = await coworkFetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { accept: "text/event-stream", "x-trace": "line\nbreak" },
				body: "{}",
				signal: controller.signal,
			}).then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(rejected).toBeInstanceOf(Error);
		}

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
