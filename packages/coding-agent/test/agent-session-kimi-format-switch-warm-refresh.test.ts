/**
 * `providers.kimiApiFormat` picks the endpoint a Kimi Code request goes to: Kimi's Anthropic-compatible
 * `/v1/messages` or its OpenAI-compatible `/v1/chat/completions`, each with a prompt cache of its own. Once the setting
 * names the other endpoint, no request reads the entry the requests before the change wrote on the first one. The cache
 * warmer replays the newest request to keep the entry the next request reads alive; a replay that keeps refreshing the
 * old endpoint's entry pays for an entry nobody reads, reports it as live, and keeps doing so until the idle limit.
 * Each replay must go out in the format the setting names when it goes out, as it did before requests carried the
 * format they were sent in: the first replay after the change went to the endpoint the next request reads, missed
 * there and stopped the warmer.
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

/** Prompt tokens each reply reports, enough for the warmer's economics to refresh an idle session's entry. */
const PROMPT_TOKENS = 800_000;

/**
 * How long the test waits for a refresh: the warmer sends one a second after the reply on an 11-second lifetime. The
 * warmer schedules it on the platform clock inside a whole session, which fake timers would also stop; the test waits
 * for the refresh request itself and gives up after this long, so a warmer that sends none passes as well.
 */
const REFRESH_WINDOW_MS = 8_000;

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

/**
 * A streamed `/v1/messages` text reply, `seen <turn>`: the first one wrote the prompt to the cache, a later one (a
 * refresh) read it.
 */
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
						cache_read_input_tokens: turn === 1 ? 0 : PROMPT_TOKENS,
						cache_creation_input_tokens: turn === 1 ? PROMPT_TOKENS : 0,
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

/** A streamed `/v1/chat/completions` text reply, `seen <turn>`, that found nothing in that endpoint's cache. */
function completionsAnswer(turn: number): Response {
	const chunk = { id: `chatcmpl_${turn}`, object: "chat.completion.chunk", created: 1, model: "k3" };
	return sse(
		[
			{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: `seen ${turn}` } }] },
			{
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: 3, total_tokens: PROMPT_TOKENS + 3 },
			},
		],
		false,
	);
}

describe("the cache warmer of a Kimi Code session whose providers.kimiApiFormat changes after a reply", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** The endpoints a session's requests went to: one prompt, then `switchTo` (if any), then the refresh window. */
	async function run(switchTo: "openai" | undefined): Promise<string[]> {
		const dir = TempDir.createSync("@pi-kimi-format-switch-warm-refresh-");
		cleanups.push(() => dir.remove());
		const k3 = getBundledModel<"openai-completions">("kimi-code", "k3");
		// K3 in the Anthropic format its catalog row resolves, with 11-second cache lifetimes, as a models.yml
		// `promptCache` override declares them: the warmer refreshes the entry a second after the reply.
		const model: Model<"openai-completions"> = {
			...k3,
			compat: { ...k3.compat, kimiApiFormat: "anthropic" },
			promptCache: { short: 11, long: 11 },
		};
		const urls: string[] = [];
		const refreshed = Promise.withResolvers<void>();
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = String(input instanceof Request ? input.url : input);
				if (url !== MESSAGES && url !== CHAT_COMPLETIONS) throw new Error(`Unexpected request to ${url}`);
				urls.push(url);
				if (urls.length === 2) refreshed.resolve();
				return url === MESSAGES ? messagesAnswer(urls.length) : completionsAnswer(urls.length);
			}),
		);
		cleanups.push(() => spy.mockRestore());
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("kimi-code", "not-a-secret");
		cleanups.push(() => authStorage.close());
		const settings = Settings.isolated({ "compaction.enabled": false, "providers.cacheWarming": "idle" });
		// The setting names the format the catalog's row resolves.
		cfgProvidersKimiApiFormat.set(settings, "anthropic");
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
		if (switchTo) cfgProvidersKimiApiFormat.set(settings, switchTo);
		await Promise.race([refreshed.promise, Bun.sleep(REFRESH_WINDOW_MS)]);
		await session.dispose();
		return urls;
	}

	it("refreshes the entry on the endpoint the next request reads while the setting stays", async () => {
		const urls = await run(undefined);

		expect(urls.slice(0, 2)).toEqual([MESSAGES, MESSAGES]);
	}, 30_000);

	it("sends no refresh to the endpoint the setting moved away from", async () => {
		const urls = await run("openai");

		// Precondition: the prompt went to the endpoint the catalog's format names.
		expect(urls[0]).toBe(MESSAGES);

		expect(urls.slice(1)).not.toContain(MESSAGES);
	}, 30_000);
});
