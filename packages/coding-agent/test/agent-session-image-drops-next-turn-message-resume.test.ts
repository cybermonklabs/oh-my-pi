/**
 * The image count clamp keeps dropping the images its last forced drop chose, and records each such drop in the
 * session by the turns that carried the images, so the requests after it read the prompt cache, after a `/resume` or a
 * restart too. These cases attach screenshots the way an extension does for the next turn
 * (`sendCustomMessage(..., { deliverAs: "nextTurn" })` while idle), let a forced drop drop them, read the session
 * again, and compare the next request with the last one before the read.
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
	type MessagesRequest,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** The gateway's claude-opus-5-5 on a host that takes four images per request. */
const MODELS_YML = gatewayModelsYml(1_000_000, 4);

/** `count` screenshots. */
function images(count: number): ImageContent[] {
	return Array.from({ length: count }, () => ({ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }));
}

describe("image count clamp after a re-read of a session whose dropped images came in a next-turn message", () => {
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

	/**
	 * Three turns on a new session: an extension's next-turn message with three screenshots, then a prompt; a prompt
	 * with three more, whose forced drop keeps those and drops the message's; a prompt with one more, which fits.
	 * Returns the last request.
	 */
	async function dropNextTurnScreenshots(
		session: AgentSession,
		requests: MessagesRequest[],
	): Promise<MessagesRequest> {
		await session.sendCustomMessage(
			{ customType: "screen-capture", content: [{ type: "text", text: "the screen" }, ...images(3)], display: true },
			{ deliverAs: "nextTurn" },
		);
		await session.prompt("what is on the screen?");
		await session.prompt("second screenshots", { images: images(3) });
		await session.prompt("third screenshot", { images: images(1) });
		const last = requests.at(-1);
		if (!last) throw new Error("Expected the requests before the re-read");
		// Precondition: it sent four images, the second turn's three and the third turn's one.
		expect(imagesPerMessage(last).filter(count => count > 0)).toEqual([3, 1]);
		return last;
	}

	it("drops the same images at the first request after /new and /resume", async () => {
		using tempDir = TempDir.createSync("@pi-image-drops-next-turn-resume-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const { session, authStorage } = await openProcess(
			tempDir,
			SessionManager.create(tempDir.path(), tempDir.join("sessions")),
		);
		try {
			const last = await dropNextTurnScreenshots(session, requests);
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session");
			// `/new`, then `/resume` the session: this process reads it again from its file.
			await session.newSession();
			expect(await session.switchSession(sessionFile)).toBe(true);
			await session.prompt("what changed?");
			const next = requests.at(-1);
			if (!next || next === last) throw new Error("Expected the request after the switch back");

			// It sends the last prompt as it was sent, the same images dropped, so it reads that prompt from the cache.
			expect({
				images: imagesPerMessage(next).reduce((total, count) => total + count, 0),
				continues: continuesCachedPrompt(last, next),
			}).toEqual({
				images: 4,
				continues: true,
			});
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}, 60_000);

	it("drops the same images at the first request of a process that resumes the session", async () => {
		using tempDir = TempDir.createSync("@pi-image-drops-next-turn-restart-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		try {
			const first = await openProcess(tempDir, SessionManager.create(tempDir.path(), tempDir.join("sessions")));
			let last: MessagesRequest;
			let sessionFile: string | undefined;
			try {
				last = await dropNextTurnScreenshots(first.session, requests);
				sessionFile = first.session.sessionFile;
			} finally {
				await first.session.dispose();
				first.authStorage.close();
			}
			if (!sessionFile) throw new Error("Expected a persisted session");

			// omp restarts on the session, and the user asks about it.
			const resumed = await openProcess(tempDir, await SessionManager.open(sessionFile));
			try {
				await resumed.session.prompt("what changed?");
			} finally {
				await resumed.session.dispose();
				resumed.authStorage.close();
			}
			const next = requests.at(-1);
			if (!next || next === last) throw new Error("Expected the resumed process's request");

			// It sends the last prompt as it was sent, the same images dropped, so it reads that prompt from the cache.
			expect({
				images: imagesPerMessage(next).reduce((total, count) => total + count, 0),
				continues: continuesCachedPrompt(last, next),
			}).toEqual({
				images: 4,
				continues: true,
			});
		} finally {
			restore();
		}
	}, 60_000);
});
