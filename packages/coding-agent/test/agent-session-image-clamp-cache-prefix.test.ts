import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** An Anthropic gateway reached on a `.local` host, configured as a deployment's `models.yml` declares it. */
const GATEWAY = "http://gateway.test.local:4000";
const MODELS_YML = `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

/** A 1x1 PNG: every image the provider path decodes must be readable. */
const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};
/** Images each turn attaches, as a run of screenshots does. */
const IMAGES_PER_TURN = 7;

interface MessagesRequest {
	system?: unknown;
	tools?: unknown[];
	messages: unknown[];
}

function answer(turn: number): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `seen ${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
function withoutCacheControl(value: unknown): string {
	return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
}

/**
 * Whether `later` sends `earlier`'s prompt in cache order, tools, then system, then every message, with the same
 * bytes, so its cache lookup reads all of `earlier`'s prompt.
 */
function continuesCachedPrompt(earlier: MessagesRequest, later: MessagesRequest): boolean {
	return (
		withoutCacheControl(later.tools) === withoutCacheControl(earlier.tools) &&
		withoutCacheControl(later.system) === withoutCacheControl(earlier.system) &&
		withoutCacheControl(later.messages.slice(0, earlier.messages.length)) === withoutCacheControl(earlier.messages)
	);
}

function imageBlocks(request: MessagesRequest): number {
	return (withoutCacheControl(request.messages).match(/"type":"image"/g) ?? []).length;
}

describe("image clamp past a gateway's image budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Fifteen real turns through the session outlast the default five seconds on a loaded machine.
	it("keeps each request's prompt as the next one's cached prefix, except at the one forced drop", async () => {
		using tempDir = TempDir.createSync("@pi-image-clamp-cache-prefix-");
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(modelsPath, MODELS_YML);
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				return answer(requests.length);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			// The `.local` host turns append-only context on, as the deployment's gateway does.
			expect(session.agent.appendOnlyContext).toBeDefined();
			// 15 turns of 7 images: the 13th request carries 91, one over the route's budget of 90.
			for (let turn = 1; turn <= 15; turn++) {
				await session.prompt(`screenshots ${turn}`, {
					images: Array.from({ length: IMAGES_PER_TURN }, () => IMAGE),
				});
			}
		} finally {
			await session.dispose();
			authStorage.close();
		}

		expect(requests).toHaveLength(15);
		// Only the 13th request, which cannot be sent with 91 images, rewrites the prompt it follows.
		const continued = requests.slice(1).map((request, index) => continuesCachedPrompt(requests[index], request));
		expect(continued).toEqual(Array.from({ length: 14 }, (_, index) => index !== 11));
		// It drops to half the budget, so the next 45 images ride on its drops.
		expect(requests.map(imageBlocks)).toEqual([7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 84, 45, 52, 59]);
	}, 30_000);
});
