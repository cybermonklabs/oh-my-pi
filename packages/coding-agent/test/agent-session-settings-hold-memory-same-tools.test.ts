/**
 * An edit of a memory backend's own setting, for a backend with no settings hook (Mnemopi), re-applies the backend:
 * its tools are created again. On a bound prompt a tool the apply takes away or brings is held until the rebuild and
 * the settings notice names the edit; but tools created again with the names and the definitions the requests already
 * declare move nothing a rebuild would send. Such an apply must not be announced as held.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay, SETTINGS_NOTICE, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, Mnemopi on. */
const MNEMOPI_ON = "providers:\n  cacheRetention: long\nmemory:\n  backend: mnemopi\n";

const MINUTE_MS = 60_000;

/** A backend that starts as Mnemopi does, with no settings hook: an edit of its own settings re-applies it. */
const mnemopiLike: MemoryBackend = {
	id: "mnemopi",
	async start() {},
	async buildDeveloperInstructions() {
		return "Mnemopi instructions.";
	},
	async clear() {},
	async enqueue() {},
};

describe("a memory backend apply that creates the same tools again on a bound prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is not announced as held, and the requests keep their prompt and tools", async () => {
		using dir = TempDir.createSync("@pi-settings-memory-same-tools-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, MNEMOPI_ON);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockImplementation(async () => mnemopiLike);
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
			toolNames: ["read", "recall", "retain", "reflect", "memory_edit"],
			contextFiles: [],
			skills: [],
		});
		try {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, `${MNEMOPI_ON}mnemopi:\n  injectionTokenLimit: 10\n`, [
				"refreshBaseSystemPrompt",
				"holdToolDeclarationChange",
			]);
			await session.settleMemoryBackend();
			setClock(MINUTE_MS);
			await session.prompt("after the edit");
			setClock(7 * MINUTE_MS);
			await session.prompt("after the deadline");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, edited, late] = gateway.requests;
		if (!first || !edited || !late) throw new Error("Expected three requests");
		// Preconditions: the requests declare the backend's tools, and none follows the edit, not even the one after
		// the deadline.
		expect(first.tools?.map(tool => tool.name)).toContain("recall");
		expect(withoutCacheControl(edited.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(late.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(late.system)).toBe(withoutCacheControl(first.system));

		expect(textOf(edited.messages.slice(first.messages.length))).not.toContain(SETTINGS_NOTICE);
	}, 30_000);
});
