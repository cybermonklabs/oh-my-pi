import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

/** A command an `RpcClient` wrote to the fake agent. */
export interface FakeRpcRequest {
	id: string;
	type: string;
	[field: string]: unknown;
}

/**
 * An RPC agent process for an `RpcClient({ spawn })`: it reports ready at once,
 * records every command written to it, and sends only the frames the test emits.
 */
export function fakeRpcAgent() {
	const exited = Promise.withResolvers<number>();
	const requests: FakeRpcRequest[] = [];
	const encoder = new TextEncoder();
	let output!: ReadableStreamDefaultController<Uint8Array>;
	const proc: RpcAgentProcess = {
		stdin: {
			write(data) {
				requests.push(
					JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as FakeRpcRequest,
				);
				return 0;
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				output = controller;
				controller.enqueue(encoder.encode('{"type":"ready"}\n'));
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	return {
		proc,
		requests,
		emit(frame: unknown) {
			output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
		},
		reply(request: FakeRpcRequest, data?: unknown) {
			output.enqueue(
				encoder.encode(
					`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
				),
			);
		},
		/** The process exits with `code`, closing its output. */
		exit(code: number) {
			output.close();
			exited.resolve(code);
		},
	};
}

/**
 * Run `send` with every timer it starts 300 times shorter, so a request's 30 s
 * deadline lapses in 100 ms. Only while issuing a request: the global is
 * restored before the caller awaits anything.
 */
export function withScaledDeadline<T>(send: () => T): T {
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void, delay?: number) =>
		original(callback, (delay ?? 0) / 300)) as typeof setTimeout;
	try {
		return send();
	} finally {
		globalThis.setTimeout = original;
	}
}
