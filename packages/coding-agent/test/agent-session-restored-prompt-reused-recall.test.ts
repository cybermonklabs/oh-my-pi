/**
 * A first-turn memory recall (Hindsight, Mnemopi) on a model that binds thinking to its prompt goes out as a system
 * block after the base prompt, and the session file stores that prompt with the block. A process that resumes the
 * session while the cache entry is warm sends that stored prompt again, and its first prompt reuses the recall the
 * transcript recorded. The stored prompt carries the recall already: the reuse must add nothing to it, and must not
 * send a settings change held since the resume before it is due.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const MEMORIES = "<memories>\nRelevant memories:\n\n- The deploy host is alpha-7.\n</memories>";

/**
 * A memory backend that behaves as Hindsight does: the first prompt recalls (with `reused`, the recall the resumed
 * transcript recorded), and once a recall is adopted the memory instructions of every later prompt build carry it.
 */
function recallingBackend(reused: boolean): MemoryBackend {
	let adopted: string | undefined;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return adopted ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (adopted !== undefined) return undefined;
			return {
				context: MEMORIES,
				reused,
				commit: () => {
					adopted = MEMORIES;
					return true;
				},
			};
		},
	};
}

/** A `--config` overlay with one-hour cache entries and `personality`. */
function overlayWith(personality: "default" | "pragmatic"): string {
	return `providers:\n  cacheRetention: long\npersonality: ${personality}\n`;
}

describe("a resumed session's first prompt that reuses the transcript's first-turn recall", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) with `backend`: runs `steps`, then exits. */
	async function runProcess(
		dir: TempDir,
		backend: MemoryBackend,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings, overlay: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, overlayWith("default"));
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const backendSpy = vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(backend);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
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
		try {
			await steps(session, settings, overlay);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			backendSpy.mockRestore();
			restore();
		}
	}

	it("sends the stored prompt with its one copy of the recall", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-reused-recall-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, recallingBackend(false), undefined, async session => {
			await session.prompt("first");
		});
		const resumed = await runProcess(dir, recallingBackend(true), live.sessionFile, async session => {
			await session.prompt("second");
			await session.prompt("third");
		});

		const [first] = live.requests;
		const [second, third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Precondition: the first-turn recall went out in the system prompt.
		expect(copiesIn(first.system, "alpha-7")).toBe(1);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);

	it("keeps a settings change made after the resume held through the reuse", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-reused-recall-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, recallingBackend(false), undefined, async session => {
			await session.prompt("first");
		});
		const resumed = await runProcess(
			dir,
			recallingBackend(true),
			live.sessionFile,
			async (session, settings, overlay) => {
				await reloadOverlay({ session, settings, overlay }, overlayWith("pragmatic"), RELOAD_CALLS);
				await session.prompt("second");
			},
		);

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(copiesIn(second.messages.slice(first.messages.length), "`personality`")).toBe(1);
	}, 60_000);
});
