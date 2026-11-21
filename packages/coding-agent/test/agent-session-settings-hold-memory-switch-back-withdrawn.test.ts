import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlayRebuild, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, auto-learn on. */
const LEARNING = "providers:\n  cacheRetention: long\nautolearn:\n  enabled: true\n";

/** {@link LEARNING} with memory switched off, which offers no `learn` tool. */
const MEMORY_OFF = `${LEARNING}memory:\n  backend: off\n`;

/** {@link LEARNING} under the local memory backend, which offers the `learn` tool. */
const LOCAL_MEMORY = `${LEARNING}memory:\n  backend: local\n`;

/** The calls of the session a memory switch may start. */
const RELOAD_CALLS: readonly OverlayRebuild[] = [
	"refreshBaseSystemPrompt",
	"reconcileBuiltinTools",
	"holdToolDeclarationChange",
];

describe("a memory switch held on a bound prompt that enables a tool, switched back", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("tells the model that a tool its notice called available after the rebuild no longer comes", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-memory-switch-back-withdrawn-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, MEMORY_OFF);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
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
		const harness = { session, settings, overlay };
		try {
			await session.settleMemoryBackend();
			await session.prompt("first");
			await reloadOverlay(harness, LOCAL_MEMORY, RELOAD_CALLS);
			await session.settleMemoryBackend();
			await session.prompt("after the switch to local memory");
			await reloadOverlay(harness, MEMORY_OFF, RELOAD_CALLS);
			await session.settleMemoryBackend();
			await session.prompt("after the switch back");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		const [first, afterLocal, afterBack] = requests;
		if (!first || !afterLocal || !afterBack) throw new Error("Expected the requests around the switches");
		// Preconditions: every request keeps the prompt and tool definitions as sent, without `learn`; the first notice
		// told the model that `learn` is available after the rebuild.
		for (const request of [afterLocal, afterBack]) {
			expect(withoutCacheControl(request.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(request.tools)).toBe(withoutCacheControl(first.tools));
		}
		expect(first.tools?.map(tool => tool.name)).not.toContain("learn");
		expect(textOf(afterLocal.messages.slice(first.messages.length))).toContain(
			"available after the rebuild: `learn`",
		);

		// The notice of the switch back names the backend and that `learn` no longer comes with the rebuild.
		const backNotice = textOf(afterBack.messages.slice(afterLocal.messages.length));
		expect(backNotice).toContain("`memory.backend`");
		expect(backNotice).toContain("not available after the rebuild: `learn`");
	}, 60_000);
});
