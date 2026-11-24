/**
 * `providers.kimiApiFormat` picks the endpoint a Kimi Code request goes to: Kimi's Anthropic-compatible
 * `/v1/messages` or its OpenAI-compatible `/v1/chat/completions`. The two endpoints keep separate prompt caches, so the
 * request after the setting changes reads none of the entry the requests before it wrote. The session's cache
 * decisions read the model a request goes out as, in the format it goes out in; switching the format switches that
 * model, and the session must count it as a change of the cache key, as it counts a switch to another model. Counted as
 * no change, the status line shows a warm entry the next request finds cold, the warmer keeps refreshing an entry no
 * request reads, and the cut rule charges a cut for rewriting an entry already lost.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgProvidersKimiApiFormat } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** Where Kimi Code takes each API format's requests. */
const MESSAGES = "https://api.kimi.com/coding/v1/messages";
const CHAT_COMPLETIONS = "https://api.kimi.com/coding/v1/chat/completions";

function sse(events: readonly Record<string, unknown>[], named: boolean): Response {
	const body = events
		.map(event =>
			named ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n` : `data: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
	return new Response(named ? body : `${body}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** A streamed `/v1/messages` text reply, `seen <turn>`, that wrote 100 prompt tokens to the cache. */
function messagesAnswer(turn: number): Response {
	return sse(
		[
			{
				type: "message_start",
				message: {
					id: `msg_${turn}`,
					type: "message",
					role: "assistant",
					content: [],
					model: "k3",
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 100,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `seen ${turn}` } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 3 },
			},
			{ type: "message_stop" },
		],
		true,
	);
}

/** A streamed `/v1/chat/completions` text reply, `seen <turn>`. */
function completionsAnswer(turn: number): Response {
	const chunk = { id: `chatcmpl_${turn}`, object: "chat.completion.chunk", created: 1, model: "k3" };
	return sse(
		[
			{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: `seen ${turn}` } }] },
			{
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 110, completion_tokens: 3, total_tokens: 113 },
			},
		],
		false,
	);
}

describe("a Kimi Code session whose providers.kimiApiFormat changes between two requests", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("counts the switch to the other endpoint as a change of the cache key", async () => {
		const dir = TempDir.createSync("@pi-kimi-format-switch-cache-shape-");
		cleanups.push(() => dir.remove());
		const k3 = getBundledModel<"openai-completions">("kimi-code", "k3");
		// K3 in the Anthropic format its catalog row resolves, with five-minute and one-hour cache lifetimes, as a
		// models.yml `promptCache` override declares them.
		const model: Model<"openai-completions"> = {
			...k3,
			compat: { ...k3.compat, kimiApiFormat: "anthropic" },
			promptCache: { short: 300, long: 3600 },
		};
		const urls: string[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = String(input instanceof Request ? input.url : input);
				if (url !== MESSAGES && url !== CHAT_COMPLETIONS) throw new Error(`Unexpected request to ${url}`);
				urls.push(url);
				return url === MESSAGES ? messagesAnswer(urls.length) : completionsAnswer(urls.length);
			}),
		);
		cleanups.push(() => spy.mockRestore());
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("kimi-code", "not-a-secret");
		cleanups.push(() => authStorage.close());
		const settings = Settings.isolated({ "compaction.enabled": false, "providers.cacheRetention": "long" });
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.create(dir.path(), path.join(dir.path(), "sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
			settings,
			model,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		cleanups.push(() => session.dispose());

		await session.prompt("first");
		// Precondition: the reply wrote an entry the next request on the same endpoint would read.
		expect(session.getPromptCacheStatus()).toMatchObject({ state: "warm", reason: undefined });

		cfgProvidersKimiApiFormat.set(settings, "openai");
		const status = session.getPromptCacheStatus();
		await session.prompt("second");

		// Precondition: the second request went to the other endpoint, whose cache holds nothing the first one wrote.
		expect(urls).toEqual([MESSAGES, CHAT_COMPLETIONS]);

		expect(status?.state).toBe("cold");
	}, 60_000);
});
