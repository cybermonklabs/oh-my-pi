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
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** A 1x1 PNG: every image the provider path decodes must be readable. */
const IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG };
/** Images each turn attaches, as a run of screenshots does. */
const IMAGES_PER_TURN = 7;

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
		await Bun.write(modelsPath, gatewayModelsYml());
		const { requests } = mockGatewayFetch(answer);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			skills: [],
			contextFiles: [],
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
