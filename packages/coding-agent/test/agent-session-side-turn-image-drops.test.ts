/**
 * The image count clamp keeps dropping, in later requests of a conversation, the images its last forced drop chose.
 * A side turn (`/btw`, `/omfg`, an extension's ephemeral turn) runs through the main loop's provider transform but is
 * not part of the conversation: what it drops must not change what the conversation's own requests send.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** The gateway's claude-opus-5-5 on a host that takes four images per request. */
const MODELS_YML = gatewayModelsYml(1_000_000, 4);

function images(count: number): ImageContent[] {
	return Array.from({ length: count }, () => ({ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }));
}

/** How many image blocks `request` sends. */
function imageCount(request: MessagesRequest): number {
	let count = 0;
	for (const message of request.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (typeof block === "object" && block !== null && block.type === "image") count++;
		}
	}
	return count;
}

/** The request whose newest user message carries `text`. */
function requestFor(requests: readonly MessagesRequest[], text: string): MessagesRequest {
	const request = requests.find(candidate => textOf(candidate.messages.at(-1)?.content).includes(text));
	if (!request) throw new Error(`Expected a request for "${text}"`);
	return request;
}

describe("a side turn that passes the image budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves the images the conversation's next request sends as they were", async () => {
		using tempDir = TempDir.createSync("@pi-side-turn-image-drops-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			// Three screenshots, inside the budget of four: the request sends all three.
			await session.prompt("first screenshots", { images: images(3) });
			// A side question about two more: five images, past the budget, so the side request drops some.
			await session.runEphemeralTurn({ promptText: "side question about these", promptImages: images(2) });
			// The conversation goes on with no new image: its three images still fit the budget.
			await session.prompt("what changed?");

			const first = requestFor(requests, "first screenshots");
			const next = requestFor(requests, "what changed?");
			expect(imageCount(first)).toBe(3);
			// What the side request dropped is the side request's: the conversation sends its three images again, and
			// its next request reads the prompt it cached.
			expect(imageCount(next)).toBe(3);
			expect(continuesCachedPrompt(first, next)).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}, 30_000);
});
