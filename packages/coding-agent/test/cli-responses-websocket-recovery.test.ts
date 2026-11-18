import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import {
	endpoint,
	send,
	sse,
	textEvents,
	toolEvents,
	type ResponsesSocket,
} from "../../ai/test/fixtures/openai-responses-server";
import { RpcClient } from "../src/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "../src/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "../src/session/agent-session";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
// The one bound on a case is the runner's per-test timeout. A deadline of the test's own on a
// turn would measure the machine: after `ready`, a prompt waits for the child's own start-up
// to finish before its turn runs, and both take seconds of CPU on a cold child.
const testTimeout = 60_000;

/** Launch the real source CLI, never RpcClient's ambient-env-merging default spawn. */
async function withCli(
	baseUrl: string,
	run: (host: {
		client: RpcClient;
		project: string;
		effect: string;
		events: AgentEvent[];
		sessionEvents: AgentSessionEvent[];
	}) => Promise<void>,
	options: { first?: number; idle?: number; websockets?: boolean | "default"; modelPreference?: boolean } = {},
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-responses-rpc-");
	const home = tempDir.join("home");
	const project = tempDir.join("project");
	const agentDir = tempDir.join("agent");
	const tmp = tempDir.join("tmp");
	const xdg = tempDir.join("xdg");
	await Promise.all([home, project, agentDir, tmp, xdg].map(dir => fs.mkdir(dir, { recursive: true })));
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				openai: {
					baseUrl,
					api: "openai-responses",
					auth: "none",
					models: [
						{
							id: "gpt-5-mini",
							name: "Loopback GPT-5 mini",
							preferWebsockets: options.modelPreference ?? true,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 131072,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			modelRoles: { default: "openai/gpt-5-mini" },
			defaultThinkingLevel: "off",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1000, modelFallback: false },
			providers: {
				openaiResponsesWebsockets: options.websockets === "default" ? undefined : (options.websockets ?? true),
				// The stream watchdogs are off (0) unless a case is about them: a 1 s first-event
				// budget is also the WebSocket connect timeout, and a child that a loaded machine
				// stalls past it falls back to SSE before the socket frame the case waits for, so
				// the machine's speed, not the transport, would decide the case.
				streamFirstEventTimeoutSeconds: options.first ?? 0,
				streamIdleTimeoutSeconds: options.idle ?? 0,
				cacheWarming: "off",
			},
			compaction: { enabled: false },
			bash: { allowCompoundCommands: true, direnv: "off" },
		}),
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: path.join(xdg, "config"),
		XDG_CACHE_HOME: path.join(xdg, "cache"),
		XDG_DATA_HOME: path.join(xdg, "data"),
		XDG_STATE_HOME: path.join(xdg, "state"),
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
		SHELL: "/bin/sh",
		NO_COLOR: "1",
		TERM: "dumb",
		...(process.env.PI_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.PI_NATIVES_DIR } : {}),
	};
	const client = new RpcClient({
		provider: "openai",
		model: "gpt-5-mini",
		sessionDir: tempDir.join("sessions"),
		args: ["--no-title", "--no-lsp", "--no-extensions", "--no-context-files", "--tools", "bash"],
		spawn: args => ptree.spawn([process.execPath, cliEntry, ...args], { cwd: project, env, stdin: "pipe" }),
	});
	const events: AgentEvent[] = [];
	const sessionEvents: AgentSessionEvent[] = [];
	const detachEvents = client.onEvent(event => events.push(event));
	const detachSessionEvents = client.onSessionEvent(event => sessionEvents.push(event));
	try {
		await client.start();
		// A fresh home has no model cache, so the child's start-up refresh rewrites every provider's
		// catalog in the background. On a slow machine that keeps the child's event loop busy for
		// seconds, and a WebSocket handshake started meanwhile fails ("socket hang up"), so the turn
		// falls back to SSE. get_available_models answers only once that refresh has finished: wait
		// for it rather than race it.
		await client.getAvailableModels();
		await run({ client, project, effect: path.join(project, "effect"), events, sessionEvents });
	} finally {
		detachEvents();
		detachSessionEvents();
		await client.stop();
	}
}

/**
 * Subscribe before triggering the action. Resolves on the first matching event of the turn and
 * fails as soon as the turn ends without one, so no clock decides whether it arrived.
 */
function waitForEvent(client: RpcClient, matches: (event: AgentEvent) => boolean): Promise<AgentEvent> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentEvent>();
	const unsubscribe = client.onEvent(event => {
		if (matches(event)) resolve(event);
		else if (event.type === "agent_end")
			reject(new Error("Missing expected real CLI event: the turn ended without it"));
	});
	return promise.finally(unsubscribe);
}

/**
 * `RpcClient.promptAndWait` without its deadline: resolves with the agent events streamed until
 * the prompt's own `prompt_result`, and rejects on a failed one. promptAndWait needs a timeout, and
 * any timeout here would let the machine's speed fail a turn the loopback server answers at once.
 */
async function promptToResult(client: RpcClient, message: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const results = new Map<string, RpcPromptResultFrame>();
	let arrived = Promise.withResolvers<void>();
	const offEvents = client.onEvent(event => events.push(event));
	const offResults = client.onPromptResult(result => {
		if (result.id !== undefined) results.set(result.id, result);
		arrived.resolve();
	});
	try {
		const id = await client.prompt(message);
		let result = results.get(id);
		while (!result) {
			await arrived.promise;
			arrived = Promise.withResolvers<void>();
			result = results.get(id);
		}
		if (result.status === "error") throw new Error(result.error?.message ?? "Prompt failed");
		return events;
	} finally {
		offEvents();
		offResults();
	}
}

function assistantMessages(messages: AgentMessage[]): AssistantMessage[] {
	return messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function assistantText(messages: AgentMessage[]): string {
	return assistantMessages(messages)
		.flatMap(message => message.content.flatMap(block => (block.type === "text" ? [block.text] : [])))
		.join("");
}

function bashEvents(project: string) {
	return toolEvents(
		"bash",
		JSON.stringify({
			i: "Appending one test byte",
			command: "printf x >> effect; printf TOOL_ROUNDTRIP",
			cwd: project,
			timeout: 5,
			pty: false,
		}),
		"resp_tool",
		"call_append_once",
	);
}

function hasTextDelta(event: AgentEvent, text: string): boolean {
	return (
		event.type === "message_update" &&
		event.assistantMessageEvent.type === "text_delta" &&
		event.assistantMessageEvent.delta.includes(text)
	);
}

describe("real CLI Responses WebSocket recovery", () => {
	test.each([
		{ name: "default-off setting", websockets: "default" as const, modelPreference: true },
		{ name: "explicitly disabled setting", websockets: false, modelPreference: true },
		{ name: "model veto under an enabled setting", websockets: true, modelPreference: false },
	])(
		"keeps $name on HTTP through the real CLI",
		async options => {
			const fixture = endpoint();
			try {
				await withCli(
					`${fixture.server.url.origin}/v1`,
					async ({ client }) => {
						await promptToResult(client, "USE_CONFIGURED_TRANSPORT");
						expect(assistantText(await client.getMessages())).toBe("HTTP");
						expect(fixture.httpRequests).toHaveLength(1);
						expect(fixture.upgrades).toHaveLength(0);
					},
					options,
				);
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"round-trips text, actual bash and another user turn using socket-local incremental history",
		async () => {
			let project = "";
			const fixture = endpoint((socket, _body, index) => {
				if (index === 2) send(socket, bashEvents(project));
				else
					send(
						socket,
						textEvents(index === 1 ? "HELLO" : index === 3 ? "TOOL_ACCEPTED" : "NEXT_ACCEPTED", `resp_${index}`),
					);
			});
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async host => {
					project = host.project;
					await promptToResult(host.client, "FIRST_USER");
					const events = await promptToResult(host.client, "RUN_BASH");
					await promptToResult(host.client, "NEXT_USER");
					expect(await Bun.file(host.effect).text()).toBe("x");
					expect(events.filter(event => event.type === "tool_execution_end")).toMatchObject([
						{ toolName: "bash", isError: false },
					]);
					const messages = await host.client.getMessages();
					expect(assistantText(messages)).toBe("HELLOTOOL_ACCEPTEDNEXT_ACCEPTED");
					expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
					expect(JSON.stringify(fixture.requests[2].body.input)).toContain("TOOL_ROUNDTRIP");
					expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1, 1]);
					expect(fixture.requests.map(request => request.body.previous_response_id)).toEqual([
						undefined,
						"resp_1",
						"resp_tool",
						"resp_3",
					]);
					expect(JSON.stringify(fixture.requests[1].body.input)).not.toContain("FIRST_USER");
					expect(JSON.stringify(fixture.requests[3].body.input)).not.toContain("RUN_BASH");
					expect(fixture.httpRequests).toHaveLength(0);
				});
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"replaces a successfully completed socket with full history and no old anchor",
		async () => {
			const fixture = endpoint((socket, _body, index) =>
				send(socket, textEvents(`ANSWER_${index}`, `resp_${index}`)),
			);
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async ({ client }) => {
					await promptToResult(client, "REMEMBER_FIRST");
					fixture.sockets.get(1)?.close(1000, "successful terminal socket replacement");
					await fixture.waitForClosed(1);
					await promptToResult(client, "SECOND_USER");
					expect(fixture.requests.map(request => request.connection)).toEqual([1, 2]);
					expect(fixture.requests[1].body.previous_response_id).toBeUndefined();
					expect(JSON.stringify(fixture.requests[1].body.input)).toContain("REMEMBER_FIRST");
					expect(JSON.stringify(fixture.requests[1].body.input)).toContain("ANSWER_1");
					expect(assistantText(await client.getMessages())).toBe("ANSWER_1ANSWER_2");
					expect(fixture.httpRequests).toHaveLength(0);
				});
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"426 uses the original HTTP 429 retry, tool and usage path, stays sticky, and resets on RPC newSession",
		async () => {
			let rejectUpgrade = true;
			let project = "";
			let events: AgentEvent[] = [];
			let sessionEvents: AgentSessionEvent[] = [];
			const fixture = endpoint(undefined, {
				rejectUpgrade: () => (rejectUpgrade ? new Response("Use SSE", { status: 426 }) : undefined),
				httpResponse: (_body, index) => {
					if (index === 1) {
						return Response.json(
							{ error: { message: "Rate limit", type: "rate_limit_error" } },
							{
								status: 429,
								headers: { "retry-after": "0.001" },
							},
						);
					}
					if (index === 2) return sse(bashEvents(project));
					return sse(textEvents(index === 3 ? "SSE_TOOL_ACCEPTED" : "SSE_STICKY", `resp_http_${index}`));
				},
			});
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async host => {
					project = host.project;
					events = host.events;
					sessionEvents = host.sessionEvents;
					await promptToResult(host.client, "FALLBACK_TOOL");
					expect(fixture.requests).toHaveLength(0);
					expect(fixture.upgrades).toHaveLength(1);
					expect(fixture.httpRequests).toHaveLength(3);
					expect(fixture.httpRequests[0]).toEqual(fixture.httpRequests[1]);
					expect(fixture.httpRequests[0].previous_response_id).toBeUndefined();
					expect(fixture.httpRequests[0].stream).toBe(true);
					expect(JSON.stringify(fixture.httpRequests[0].tools)).toContain("bash");
					expect(JSON.stringify(fixture.httpRequests[2].input)).toContain("TOOL_ROUNDTRIP");
					expect(await Bun.file(host.effect).text()).toBe("x");
					const completed = assistantMessages(await host.client.getMessages()).filter(
						message => message.stopReason !== "error",
					);
					expect(completed.map(message => message.usage.totalTokens)).toEqual([8, 8]);
					expect(assistantText(completed)).toBe("SSE_TOOL_ACCEPTED");
					rejectUpgrade = false;
					await promptToResult(host.client, "STILL_SSE");
					expect(fixture.upgrades).toHaveLength(1);
					expect(fixture.httpRequests).toHaveLength(4);
					expect(assistantText(await host.client.getMessages())).toBe("SSE_TOOL_ACCEPTEDSSE_STICKY");
					expect(await host.client.newSession()).toEqual({ cancelled: false });
					await promptToResult(host.client, "NEW_SESSION_WS");
					expect(fixture.requests).toHaveLength(1);
					expect(fixture.upgrades).toHaveLength(2);
					expect(fixture.requests[0].body.previous_response_id).toBeUndefined();
					expect(JSON.stringify(fixture.requests[0].body.input)).not.toContain("FALLBACK_TOOL");
					expect(assistantText(await host.client.getMessages())).toBe("WS");
				});
			} catch (error) {
				await Bun.write(
					"/tmp/omp-responses-cli-426-failure.json",
					JSON.stringify(
						{
							error: String(error),
							upgrades: fixture.upgrades.map(upgrade => ({
								path: upgrade.path,
								headers: Object.fromEntries(upgrade.headers),
							})),
							requests: fixture.requests,
							httpRequests: fixture.httpRequests,
							events,
							sessionEvents,
						},
						null,
						2,
					),
				);
				throw error;
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"an active complete service outage fails boundedly, then same-address restore uses SSE until a new session",
		async () => {
			const fixture = endpoint(socket => send(socket, textEvents("OUTAGE_PARTIAL", "resp_outage").slice(0, 4)));
			const port = fixture.server.port;
			let restored: { server: { stop(closeActiveConnections?: boolean): Promise<void> | void } } | undefined;
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async ({ client, sessionEvents }) => {
					const partial = waitForEvent(client, event => hasTextDelta(event, "OUTAGE_PARTIAL"));
					const result = promptToResult(client, "OUTAGE_USER").then(
						() => ({ error: undefined }),
						(error: unknown) => ({ error }),
					);
					await partial;
					expect(fixture.requests).toHaveLength(1);
					await fixture.server.stop(true);
					// Bounded: the prompt ends in its own failed `prompt_result`, which is the only way
					// promptToResult rejects, rather than running on with no server.
					const failed = await result;
					expect(failed.error).toBeInstanceOf(Error);
					expect(sessionEvents.filter(event => event.type === "auto_retry_start").length).toBeLessThanOrEqual(1);
					expect(assistantText(await client.getMessages())).toContain("OUTAGE_PARTIAL");
					const replacement = endpoint(undefined, { port });
					restored = replacement;
					await promptToResult(client, "RESTORED_SAME_SESSION");
					expect(replacement.upgrades).toHaveLength(0);
					expect(replacement.httpRequests).toHaveLength(1);
					expect(assistantText(await client.getMessages())).toContain("HTTP");
					await client.newSession();
					await promptToResult(client, "RESTORED_NEW_SESSION");
					expect(replacement.requests).toHaveLength(1);
					expect(replacement.httpRequests).toHaveLength(1);
					expect(assistantText(await client.getMessages())).toBe("WS");
				});
			} finally {
				await restored?.server.stop(true);
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"retains text already delivered over RPC and TurnRecovery sends a new SSE continuation, not a replay",
		async () => {
			let socket: ResponsesSocket | undefined;
			const fixture = endpoint(
				ws => {
					socket = ws;
					send(ws, textEvents("VISIBLE_PREFIX ", "resp_partial").slice(0, 4));
				},
				{ httpResponse: () => sse(textEvents("CONTINUED_SUFFIX", "resp_continued")) },
			);
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async ({ client, events }) => {
					const partial = waitForEvent(client, event => hasTextDelta(event, "VISIBLE_PREFIX"));
					const result = promptToResult(client, "CONTINUE_USER");
					await partial;
					expect(fixture.httpRequests).toHaveLength(0);
					socket?.terminate();
					await result;
					expect(fixture.requests).toHaveLength(1);
					expect(fixture.httpRequests).toHaveLength(1);
					const continuation = JSON.stringify(fixture.httpRequests[0].input);
					expect(continuation).toContain("VISIBLE_PREFIX");
					expect(continuation).toContain("Continue exactly where it stopped");
					expect(fixture.httpRequests[0].previous_response_id).toBeUndefined();
					const messages = await client.getMessages();
					expect(assistantText(messages)).toBe("VISIBLE_PREFIX CONTINUED_SUFFIX");
					expect(
						assistantMessages(messages).some(
							message =>
								message.stopReason === "error" &&
								message.content.some(block => block.type === "text" && block.text === "VISIBLE_PREFIX "),
						),
					).toBe(true);
					expect(events.filter(event => hasTextDelta(event, "VISIBLE_PREFIX"))).toHaveLength(1);
				});
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"keeps an executed bash result when the next response disconnects without executing the call twice",
		async () => {
			let project = "";
			let socket: ResponsesSocket | undefined;
			const fixture = endpoint(
				(ws, _body, index) => {
					if (index === 1) send(ws, bashEvents(project));
					else {
						socket = ws;
						send(ws, textEvents("AFTER_TOOL_PARTIAL ", "resp_after_tool").slice(0, 4));
					}
				},
				{ httpResponse: () => sse(textEvents("TOOL_RECOVERED", "resp_tool_recovered")) },
			);
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async host => {
					project = host.project;
					const executed = waitForEvent(
						host.client,
						event => event.type === "tool_execution_end" && event.toolName === "bash",
					);
					const partial = waitForEvent(host.client, event => hasTextDelta(event, "AFTER_TOOL_PARTIAL"));
					const result = promptToResult(host.client, "EXECUTE_ONCE");
					expect(await executed).toMatchObject({ isError: false });
					await partial;
					expect(await Bun.file(host.effect).text()).toBe("x");
					expect(JSON.stringify(fixture.requests[1].body.input)).toContain("TOOL_ROUNDTRIP");
					socket?.terminate();
					await result;
					expect(fixture.requests).toHaveLength(2);
					expect(fixture.httpRequests).toHaveLength(1);
					expect(JSON.stringify(fixture.httpRequests[0].input)).toContain("TOOL_ROUNDTRIP");
					expect(await Bun.file(host.effect).text()).toBe("x");
					expect(host.events.filter(event => event.type === "tool_execution_start")).toHaveLength(1);
					const messages = await host.client.getMessages();
					expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
					expect(assistantText(messages)).toBe("AFTER_TOOL_PARTIAL TOOL_RECOVERED");
				});
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"never executes incomplete tool arguments and recovers the network failure over SSE",
		async () => {
			let socket: ResponsesSocket | undefined;
			const fixture = endpoint(ws => {
				socket = ws;
				send(ws, toolEvents("bash", '{"command":"printf x >> effect', "resp_half_tool", "call_half").slice(0, 3));
			});
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async host => {
					const args = waitForEvent(
						host.client,
						event => event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta",
					);
					const result = promptToResult(host.client, "HALF_TOOL_USER");
					await args;
					socket?.terminate();
					await result;
					expect(await Bun.file(host.effect).exists()).toBe(false);
					expect(host.events.filter(event => event.type === "tool_execution_start")).toHaveLength(0);
					expect(fixture.requests).toHaveLength(1);
					expect(fixture.httpRequests).toHaveLength(1);
					expect(assistantText(await host.client.getMessages())).toBe("HTTP");
				});
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	test(
		"caller cancellation creates no late recovery or sticky downgrade and the next prompt still uses WS",
		async () => {
			let socket: ResponsesSocket | undefined;
			const fixture = endpoint((ws, _body, index) => {
				if (index === 1) {
					socket = ws;
					send(ws, textEvents("CANCEL_PREFIX", "resp_cancel").slice(0, 4));
				} else send(ws, textEvents("AFTER_CANCEL_WS", "resp_after_cancel"));
			});
			try {
				await withCli(`${fixture.server.url.origin}/v1`, async ({ client, sessionEvents }) => {
					const partial = waitForEvent(client, event => hasTextDelta(event, "CANCEL_PREFIX"));
					const result = promptToResult(client, "CANCEL_USER").then(
						() => undefined,
						(error: unknown) => error,
					);
					await partial;
					await client.abort();
					await result;
					// As waitForSettled, without its deadline: subscribed before asking, so a settle
					// between the two cannot be missed.
					const settled = Promise.withResolvers<void>();
					const offSettled = client.onSessionSettled(settled.resolve);
					try {
						if (!(await client.getState()).isSettled) await settled.promise;
					} finally {
						offSettled();
					}
					if (socket) send(socket, textEvents("LATE_SHOULD_NOT_APPEAR", "resp_late"));
					await client.getState();
					expect(fixture.httpRequests).toHaveLength(0);
					expect(fixture.requests).toHaveLength(1);
					expect(sessionEvents.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
					const cancelled = assistantMessages(await client.getMessages());
					expect(cancelled.some(message => message.stopReason === "aborted")).toBe(true);
					expect(assistantText(cancelled)).not.toContain("LATE_SHOULD_NOT_APPEAR");
					await promptToResult(client, "AFTER_CANCEL_USER");
					expect(fixture.requests).toHaveLength(2);
					expect(fixture.requests[1].body.previous_response_id).toBeUndefined();
					expect(fixture.httpRequests).toHaveLength(0);
					expect(assistantText(await client.getMessages())).toContain("AFTER_CANCEL_WS");
				});
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);

	for (const phase of ["first-event", "idle"] as const) {
		test(
			`${phase} timeout remains a local failure and TurnRecovery continues over SSE instead of treating it as caller cancellation`,
			async () => {
				const fixture = endpoint(socket => {
					if (phase === "idle") send(socket, textEvents("TIMEOUT_PARTIAL ", "resp_timeout").slice(0, 4));
				});
				try {
					await withCli(
						`${fixture.server.url.origin}/v1`,
						async ({ client, events, sessionEvents }) => {
							await promptToResult(client, "TIMEOUT_USER");
							expect(fixture.requests).toHaveLength(1);
							expect(fixture.httpRequests).toHaveLength(1);
							const failed = events.filter(
								event =>
									event.type === "message_end" &&
									event.message.role === "assistant" &&
									event.message.stopReason === "error",
							);
							expect(failed).toHaveLength(1);
							expect(JSON.stringify(failed)).toMatch(/timeout|timed out/i);
							expect(
								events.some(
									event =>
										event.type === "message_end" &&
										event.message.role === "assistant" &&
										event.message.stopReason === "aborted",
								),
							).toBe(false);
							expect(assistantText(await client.getMessages())).toBe(
								phase === "idle" ? "TIMEOUT_PARTIAL HTTP" : "HTTP",
							);
							if (phase === "idle") {
								expect(JSON.stringify(fixture.httpRequests[0].input)).toContain(
									"Continue exactly where it stopped",
								);
							} else {
								expect(sessionEvents.some(event => event.type === "auto_retry_start")).toBe(true);
							}
							await promptToResult(client, "STICKY_AFTER_TIMEOUT");
							expect(fixture.requests).toHaveLength(1);
							expect(fixture.httpRequests).toHaveLength(2);
						},
						// Only the budget under test is on. The first-event budget is also the WebSocket
						// connect timeout, so the idle case turns it off: a loaded machine cannot spend it
						// on the handshake or before the partial arrives. The first-event case cannot turn
						// it off, so a handshake slower than 1 s still falls back to SSE before the request.
						{ first: phase === "idle" ? 0 : 1, idle: phase === "idle" ? 0.2 : 0 },
					);
				} finally {
					await fixture.server.stop(true);
				}
			},
			testTimeout,
		);
	}
});
