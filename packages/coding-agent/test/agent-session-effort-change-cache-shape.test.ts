/**
 * On a model that takes effort per message (Anthropic's `supportsPerMessageEffort`, the gateway's claude-opus-5-5), a
 * change between two thinking levels other than off goes out as a control after the newest content, and the
 * request-level effort stays as the first request sent it: the next request reads the whole cached prompt. The session
 * must not count it as a change of the cache key: counted as one, the entry looks unreadable, the cache counts as
 * lapsed, and a settings change held on the bound prompt goes out at once, which writes the whole cached prompt again.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, personalityOverlay, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

describe("a thinking level change on a model that takes effort per message", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("keeps the cache entry readable and a held settings change held", async () => {
		const dir = TempDir.createSync("@pi-effort-change-cache-shape-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, personalityOverlay("default"));
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(async () => restore());
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		// Precondition: the model takes effort per message.
		expect(model.compat).toMatchObject({ supportsPerMessageEffort: true });
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			thinkingLevel: ThinkingLevel.High,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});

		await session.prompt("first");
		// A personality change on the bound prompt is held while the cache entry stays readable.
		await reloadOverlay({ session, settings, overlay: overlayPath }, personalityOverlay("pragmatic"));
		session.setThinkingLevel(ThinkingLevel.Low);
		const status = session.getPromptCacheStatus();
		await session.prompt("second");

		const [first, second] = requests as unknown as Record<string, unknown>[];
		if (!first || !second) throw new Error("Expected two requests");
		// Preconditions: the second request keeps the first one's thinking and request-level effort, so the level
		// change reaches the model as a control after the newest content.
		expect(second.thinking).toEqual(first.thinking);
		expect(second.output_config).toEqual(first.output_config);
		expect(withoutCacheControl(second.messages)).toContain('"effort":"low"');

		expect(status).toMatchObject({ state: "warm" });
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);
});
