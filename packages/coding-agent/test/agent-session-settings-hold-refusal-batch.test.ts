/**
 * A tool a held settings change disables is refused until the rebuild, and the refusal names the change. One change
 * can change several gates at once (a configuration sync that turns off `lsp.enabled` and `github.enabled`): the hold
 * does not know which of them disabled which tool, so the refusal names every one, and must say the tool is disabled
 * by one of them, not that each did.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	toolResultOf,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, GitHub on. */
const INITIAL = "providers:\n  cacheRetention: long\ngithub:\n  enabled: true\n";

/** The sync: `lsp` and `github` turned off together. */
const BOTH_OFF = "providers:\n  cacheRetention: long\ngithub:\n  enabled: false\nlsp:\n  enabled: false\n";

const MINUTE_MS = 60_000;

describe("a held tool refusal of a change that turned off several gates", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("says the tool is disabled by one of the changes it names", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-refusal-batch-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, INITIAL);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const gateway = mockGatewayFetch(turn =>
			turn === 2
				? toolCallAnswer(turn, "lsp", { action: "status" }, { cacheWriteTokens: 100 })
				: answer(turn, { cacheWriteTokens: 100 }),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			enableLsp: true,
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "lsp"],
			contextFiles: [],
			skills: [],
		});
		try {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, BOTH_OFF, RELOAD_CALLS);
			setClock(MINUTE_MS);
			await session.prompt("check the language server");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, called, withResult] = gateway.requests;
		if (!first || !called || !withResult) throw new Error("Expected three requests");
		// Precondition: the held change keeps `lsp` declared.
		expect(called.tools?.map(tool => tool.name)).toContain("lsp");
		const refusal = textOf(toolResultOf(withResult, "toolu_2")?.content);
		expect(refusal).toContain("`lsp` is disabled by a settings change");
		expect(refusal).toContain("one of these changes");
		expect(refusal).toContain("`lsp.enabled`: `true` → `false`");
		expect(refusal).toContain("`github.enabled`: `true` → `false`");
	}, 30_000);
});
