/**
 * The image count clamp keeps dropping the images its last forced drop chose, and records each such drop in the
 * session, so the requests after it read the prompt cache. These cases leave a session with `/new`, let another
 * process resume it and make a forced drop of its own, then `/resume` it again in the first process, and compare the
 * first process's next request with the other process's last one.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	imagesPerMessage,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** The gateway's claude-opus-5-5 on a host that takes four images per request. */
const MODELS_YML = gatewayModelsYml(1_000_000, 4);

/** `count` screenshots. */
function images(count: number): ImageContent[] {
	return Array.from({ length: count }, () => ({ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }));
}

describe("image count clamp after another process continued a session this process left", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One omp process: its session on `sessionManager`, built as the CLI builds it. */
	async function openProcess(
		tempDir: TempDir,
		sessionManager: SessionManager,
	): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
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
		return { session, authStorage };
	}

	it("drops the images the other process's last request dropped at the first request after the switch back", async () => {
		using tempDir = TempDir.createSync("@pi-image-drops-switch-back-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const first = await openProcess(tempDir, SessionManager.create(tempDir.path(), tempDir.join("sessions")));
		try {
			// The second turn's images pass the budget: the forced drop keeps its three and drops the first turn's.
			await first.session.prompt("first screenshots", { images: images(3) });
			await first.session.prompt("second screenshots", { images: images(3) });
			const sessionFile = first.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session");
			// `/new`: this process leaves the session, and gives up its file.
			await first.session.newSession();

			// Another omp process resumes the session and goes on: the third turn's images pass the budget again, and
			// its forced drop keeps those three and drops the second turn's too; the fourth turn's image fits.
			const other = await openProcess(tempDir, await SessionManager.open(sessionFile));
			try {
				await other.session.prompt("third screenshots", { images: images(3) });
				await other.session.prompt("fourth screenshot", { images: images(1) });
			} finally {
				await other.session.dispose();
				other.authStorage.close();
			}
			const lastOfOther = requests.at(-1);
			if (!lastOfOther) throw new Error("Expected the other process's requests");

			// `/resume` the session again in the first process, and ask about it.
			expect(await first.session.switchSession(sessionFile)).toBe(true);
			await first.session.prompt("what changed?");
			const next = requests.at(-1);
			if (!next || next === lastOfOther) throw new Error("Expected the request after the switch back");

			// Precondition: the other process's last request sent four images, its forced drop's three and one more.
			expect(imagesPerMessage(lastOfOther).reduce((total, count) => total + count, 0)).toBe(4);
			// The request after the switch back sends the other process's last prompt as it sent it, the same images
			// dropped, so it reads that prompt from the cache.
			expect({
				images: imagesPerMessage(next).reduce((total, count) => total + count, 0),
				continues: continuesCachedPrompt(lastOfOther, next),
			}).toEqual({ images: 4, continues: true });
		} finally {
			await first.session.dispose();
			first.authStorage.close();
			restore();
		}
	}, 60_000);
});
