/**
 * A transcript written before the image count clamp kept its drops (the base release) carries no `provider-image-drop`
 * entry. That release dropped, in every request, just the oldest images past the budget
 * (`clampProviderContextImages`), so the transcript's last request and the request a process of that release sends
 * when it resumes the session both drop exactly those. These cases check that the first request after the session is
 * resumed on this release drops them too, so it reads the cache entry the transcript left instead of writing the whole
 * conversation again.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** The gateway's claude-opus-5-5 on a host that takes four images per request. */
const MODELS_YML = gatewayModelsYml(1_000_000, 4);

const MINUTE_MS = 60_000;

/** How many image blocks each of `request`'s messages sends. */
function imagesPerMessage(request: MessagesRequest): number[] {
	return request.messages.map(message =>
		Array.isArray(message.content)
			? message.content.filter(block => typeof block === "object" && block !== null && block.type === "image").length
			: 0,
	);
}

function screenshots(text: string, count: number, timestamp: number): UserMessage {
	const images: ImageContent[] = Array.from({ length: count }, () => ({
		type: "image",
		data: ONE_PIXEL_PNG,
		mimeType: "image/png",
	}));
	return { role: "user", content: [{ type: "text", text }, ...images], timestamp };
}

/** A reply of the gateway's claude-opus-5-5 that wrote its request to the one-hour cache. */
function cachedReply(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 10,
			output: 3,
			cacheRead: 0,
			cacheWrite: 100,
			totalTokens: 113,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("image count clamp on a transcript the base release wrote", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("drops the images the base release dropped at the first request after a resume", async () => {
		const dir = TempDir.createSync("@pi-image-drops-base-transcript-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), MODELS_YML);
		const start = Date.now();
		// Two turns of three screenshots each, as the base release left them: no drop record on the branch.
		const written = SessionManager.create(dir.path(), dir.join("sessions"));
		written.appendMessage(screenshots("first screenshots", 3, start));
		written.appendMessage(cachedReply("seen 1", start + 1_000));
		written.appendMessage(screenshots("second screenshots", 3, start + MINUTE_MS));
		written.appendMessage(cachedReply("seen 2", start + MINUTE_MS + 1_000));
		await written.flush();
		const sessionFile = written.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await written.close();

		// The session is resumed a minute later, well inside the one-hour entry.
		vi.spyOn(Date, "now").mockReturnValue(start + 2 * MINUTE_MS);
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: await SessionManager.open(sessionFile),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
			restore();
		});
		await session.prompt("what changed?");

		const [first] = requests;
		if (!first) throw new Error("Expected the resumed request");
		// The base release's last request dropped the two oldest of the six images (6 - 4): the first turn kept one,
		// the second all three. The resumed request carries no new image, so it needs no other drop.
		expect(imagesPerMessage(first).slice(0, 4)).toEqual([1, 0, 3, 0]);
	}, 30_000);
});
