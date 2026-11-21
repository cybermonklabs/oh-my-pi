import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, Hindsight on. */
const HINDSIGHT_ON = "providers:\n  cacheRetention: long\nmemory:\n  backend: hindsight\n";

const MEMORIES = "<memories>\nRelevant memories:\n\n- The deploy host is alpha-7.\n</memories>";

/**
 * A memory backend that behaves as Hindsight does: the first turn's recall is adopted into the memory instructions
 * of every later prompt build, and an edit of its own settings installs a fresh state, which recalls afresh, and
 * withdraws the conversation's recall (`reconcilePrimaryState` in `hindsight/backend.ts`).
 */
function hindsightLikeBackend(): MemoryBackend {
	let adopted: string | undefined;
	let recalled = false;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions(_agentDir, _cwd, _settings, _session, options) {
			return adopted && !options?.recallDelivered ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (recalled) return undefined;
			return {
				context: MEMORIES,
				commit: () => {
					recalled = true;
					adopted = MEMORIES;
					return true;
				},
			};
		},
		async applySettings(session) {
			adopted = undefined;
			await session.withdrawMemoryRecall();
		},
	};
}

describe("a memory backend's own setting edited on a bound prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the system prompt as sent while the state the edit rebuilt waits, and names the setting", async () => {
		using dir = TempDir.createSync("@pi-settings-memory-hook-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, HINDSIGHT_ON);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(hindsightLikeBackend());
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			await session.prompt("second");
			await reloadOverlay({ session, settings, overlay }, `${HINDSIGHT_ON}hindsight:\n  recallBudget: high\n`);
			await session.settleMemoryBackend();
			await session.prompt("third");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the first turn's recall is in the system prompt the conversation is bound to.
		expect(withoutCacheControl(second.system)).toContain("alpha-7");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(second.system));
		expect(withoutCacheControl(third.tools)).toBe(withoutCacheControl(second.tools));
		const notices = textOf(third.messages.slice(second.messages.length));
		expect(notices).toContain("is held");
		expect(notices).toContain("`hindsight.recallBudget`");
	}, 30_000);
});
