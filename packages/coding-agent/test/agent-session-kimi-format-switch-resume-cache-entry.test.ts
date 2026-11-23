/**
 * `providers.kimiApiFormat` picks the endpoint a Kimi Code request goes to: Kimi's Anthropic-compatible
 * `/v1/messages` or its OpenAI-compatible `/v1/chat/completions`, each with a prompt cache of its own. A process that
 * resumes a session has sent nothing yet: it reads the cache entry off the branch's newest cached reply. When the
 * setting names the other endpoint than the one that reply went to, the next request reads none of what it cached, and
 * the session must read the entry as one the next request cannot read, as after a switch to another model: read as
 * live, the status line shows it warm, the cut rule waits on it, and the resumed process keeps the stored prompt for it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** Where Kimi Code takes the Anthropic format's requests. */
const MESSAGES = "https://api.kimi.com/coding/v1/messages";

/** Kimi Code's bundled K3 with five-minute and one-hour cache lifetimes. */
const MODELS_YML = `providers:
  kimi-code:
    modelOverrides:
      k3: {promptCache: {short: 300, long: 3600}}
`;

/** A streamed `/v1/messages` text reply that wrote 100 prompt tokens to the cache. */
function messagesAnswer(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [],
				model: "k3",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "seen" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("a Kimi Code session resumed under another providers.kimiApiFormat", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A process on `sessionFile` (a new session without one) under `providers.kimiApiFormat: format`. */
	async function startProcess(dir: TempDir, format: "openai" | "anthropic", sessionFile?: string) {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `providers:\n  cacheRetention: long\n  kimiApiFormat: ${format}\n`);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("kimi-code", "not-a-secret");
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("kimi-code", "k3");
		if (!model) throw new Error("Expected Kimi Code's k3");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		return {
			session,
			sessionManager,
			close: async () => {
				await session.dispose();
				authStorage.close();
			},
		};
	}

	it.each([
		{ format: "openai", expected: { state: "cold", reason: { kind: "model" } } },
		{ format: "anthropic", expected: { state: "warm", reason: undefined } },
	] as const)(
		"reads the cached prompt the Anthropic format wrote, resumed in the $format format",
		async ({ format, expected }) => {
			const dir = TempDir.createSync("@pi-kimi-format-switch-resume-cache-entry-");
			cleanups.push(() => dir.remove());
			await Bun.write(dir.join("models.yml"), MODELS_YML);
			const urls: string[] = [];
			const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async input => {
					const url = String(input instanceof Request ? input.url : input);
					if (url !== MESSAGES) throw new Error(`Unexpected request to ${url}`);
					urls.push(url);
					return messagesAnswer();
				}),
			);
			cleanups.push(() => spy.mockRestore());

			const live = await startProcess(dir, "anthropic");
			await live.session.prompt("first");
			const sessionFile = live.sessionManager.getSessionFile();
			await live.close();
			if (!sessionFile) throw new Error("Expected a persisted session");
			// Precondition: the first process's request went to the Anthropic format's endpoint.
			expect(urls).toEqual([MESSAGES]);

			const resumed = await startProcess(dir, format, sessionFile);
			cleanups.push(resumed.close);

			expect(resumed.session.getPromptCacheStatus()).toMatchObject(expected);
		},
		60_000,
	);
});
