/**
 * The image count clamp records each drop it keeps in the session, on the branch current then, and a process that
 * resumes the session finds the drops of every branch there. A copy of part of the session into a new file (`/fork` at
 * an entry, `/branch`, a `/btw` answer promoted into a new file) holds only the copied path, so a drop recorded on
 * another branch must go into the copy with it: a process that resumed the session and copied it before sending
 * anything remembers no drop, and without the record its first request in the copy sends the dropped images again.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
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
	gatewayModelsYml,
	gatewaySessionOptions,
	imagesPerMessage,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { ONE_PIXEL_PNG } from "./helpers/skill-image-vision";

/** The gateway's claude-opus-5-5 on a host that takes four images per request. */
const MODELS_YML = gatewayModelsYml(1_000_000, 4);

/** `count` screenshots. */
function images(count: number): ImageContent[] {
	return Array.from({ length: count }, () => ({ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }));
}

/** A `/btw` answer to promote. */
const BTW_ANSWER: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "The screenshots show the same dialog." }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 0,
};

/** The newest message entry of `session`'s branch with `role`. */
function newest(session: AgentSession, role: "user" | "assistant"): string {
	const entry = session.sessionManager
		.getBranch()
		.findLast(candidate => candidate.type === "message" && candidate.message.role === role);
	if (!entry) throw new Error(`Expected a ${role} message`);
	return entry.id;
}

describe("image count clamp drops recorded on another branch, across a copy of the branch", () => {
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

	it.each([
		{
			copy: "/fork at the branch's newest reply",
			make: async (session: AgentSession) => {
				expect(await session.fork(newest(session, "assistant"))).toBe(true);
			},
			// The copy holds the whole branch the last request sent.
			kept: 3,
		},
		{
			copy: "/btw promoted into a new file",
			make: async (session: AgentSession) => {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) throw new Error("Expected a leaf");
				const promoted = await session.branchFromBtw(
					"what do the screenshots show?",
					{ ...BTW_ANSWER, timestamp: Date.now() },
					leafId,
					session.sessionManager.getSessionId(),
				);
				expect(promoted.cancelled).toBe(false);
			},
			kept: 3,
		},
		{
			copy: "/branch at the branch's newest prompt",
			make: async (session: AgentSession) => {
				expect((await session.branch(newest(session, "user"))).cancelled).toBe(false);
			},
			// The copy holds the turns before that prompt: the screenshots' turn and its reply.
			kept: 2,
		},
	])(
		"drops them in the first request after $copy made before any request",
		async ({ make, kept }) => {
			using tempDir = TempDir.createSync("@pi-image-drops-copy-");
			await Bun.write(tempDir.join("models.yml"), MODELS_YML);
			const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
			try {
				// The first process: the second turn's images pass the budget, and the forced drop keeps its three and drops
				// the first turn's. `/tree` goes back to the first reply, and the conversation goes on there with the first
				// turn's images still dropped. The process exits.
				const first = await openProcess(tempDir, SessionManager.create(tempDir.path(), tempDir.join("sessions")));
				let sessionFile: string | undefined;
				try {
					await first.session.prompt("first screenshots", { images: images(3) });
					const firstReply = newest(first.session, "assistant");
					await first.session.prompt("second screenshots", { images: images(3) });
					await first.session.navigateTree(firstReply);
					await first.session.prompt("what do they show?");
					sessionFile = first.session.sessionFile;
				} finally {
					await first.session.dispose();
					first.authStorage.close();
				}
				if (!sessionFile) throw new Error("Expected a persisted session");
				const lastBefore = requests.at(-1);
				if (!lastBefore) throw new Error("Expected the first process's requests");
				// Precondition: the branch's last request dropped the first turn's images.
				expect(imagesPerMessage(lastBefore).reduce((total, count) => total + count, 0)).toBe(0);

				// A second process resumes the session and copies the branch before it sends anything, then asks.
				const second = await openProcess(tempDir, await SessionManager.open(sessionFile));
				try {
					const branch = second.session.sessionManager.getBranch();
					// Precondition: the drop is recorded on the other branch only.
					expect(branch.some(entry => entry.type === "custom" && entry.customType === "provider-image-drop")).toBe(
						false,
					);
					await make(second.session);
					await second.session.prompt("and now?");
				} finally {
					await second.session.dispose();
					second.authStorage.close();
				}
				const next = requests.at(-1);
				if (!next || next === lastBefore) throw new Error("Expected the copy's request");

				// The copy's request sends the turns it keeps as the branch's last request sent them, the same images
				// dropped, so it reads them from the cache.
				expect({
					images: imagesPerMessage(next).slice(0, kept),
					turns: withoutCacheControl(next.messages.slice(0, kept)),
				}).toEqual({
					images: imagesPerMessage(lastBefore).slice(0, kept),
					turns: withoutCacheControl(lastBefore.messages.slice(0, kept)),
				});
			} finally {
				restore();
			}
		},
		60_000,
	);
});
