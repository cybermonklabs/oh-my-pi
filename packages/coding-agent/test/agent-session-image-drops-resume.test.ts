/**
 * The image count clamp keeps dropping the images its last forced drop chose, so the requests after it read the
 * prompt cache. These cases check that a restarted process drops the same images instead of making a new forced drop
 * of another set at its first request.
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
	GATEWAY,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** The gateway's claude-opus-5-5 on a host that takes four images per request. */
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
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], imageCountBudget: 4, contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

/** A prompt and the images it attaches. */
interface Turn {
	text: string;
	images: number;
}

/** How many image blocks each of `request`'s messages sends. */
function imagesPerMessage(request: MessagesRequest): number[] {
	return request.messages.map(message =>
		Array.isArray(message.content)
			? message.content.filter(block => typeof block === "object" && block !== null && block.type === "image").length
			: 0,
	);
}

describe("image count clamp across a restart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one): sends each turn, then exits. */
	async function runProcess(
		tempDir: TempDir,
		turns: Turn[],
		sessionFile?: string,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			for (const turn of turns) {
				const images: ImageContent[] = Array.from({ length: turn.images }, () => ({
					type: "image",
					data: ONE_PIXEL_PNG,
					mimeType: "image/png",
				}));
				await session.prompt(turn.text, turn.images > 0 ? { images } : undefined);
			}
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	it("sends the images the previous process sent at the first request after a resume", async () => {
		using tempDir = TempDir.createSync("@pi-image-drops-resume-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		// The second turn's images pass the budget: the forced drop keeps its three and drops the first turn's.
		const live = await runProcess(tempDir, [
			{ text: "first screenshots", images: 3 },
			{ text: "second screenshots", images: 3 },
			{ text: "third screenshot", images: 1 },
		]);
		const resumed = await runProcess(tempDir, [{ text: "what changed?", images: 0 }], live.sessionFile);

		const lastBefore = live.requests.at(-1);
		const firstAfter = resumed.requests[0];
		if (!lastBefore || !firstAfter) throw new Error("Expected a request in each process");
		expect(imagesPerMessage(lastBefore).reduce((sum, count) => sum + count, 0)).toBe(4);
		expect(imagesPerMessage(firstAfter).slice(0, lastBefore.messages.length)).toEqual(imagesPerMessage(lastBefore));
		expect(continuesCachedPrompt(lastBefore, firstAfter)).toBe(true);
	}, 30_000);
});
