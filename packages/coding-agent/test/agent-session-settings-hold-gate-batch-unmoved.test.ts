/**
 * A tool gate's change on a bound prompt is held only when it moves the tools the session has enabled; a gate of a
 * tool the session's explicit list leaves out moves nothing, so no settings notice may name it. A configuration sync
 * can change several gates in one reload: one that takes an enabled tool away is held and named, and one beside it
 * whose tool the session never lists still moves nothing. The notice must name the first and not the second.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	RELOAD_CALLS,
	reloadOverlay,
	SETTINGS_NOTICE,
	setClock,
} from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, gatewaySessionOptions, mockGatewayFetch, textOf } from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, GitHub on. */
const INITIAL = "providers:\n  cacheRetention: long\ngithub:\n  enabled: true\n";

/** The sync: `lsp` and `github` turned off together. */
const BOTH_OFF = "providers:\n  cacheRetention: long\ngithub:\n  enabled: false\nlsp:\n  enabled: false\n";

const MINUTE_MS = 60_000;

describe("a sync that changes a moving and an unmoving tool gate together", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names only the gate that moves an enabled tool", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-gate-batch-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, INITIAL);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
			await session.prompt("after the sync");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, changed] = gateway.requests;
		if (!first || !changed) throw new Error("Expected two requests");
		const notices = textOf(changed.messages.slice(first.messages.length));
		// Preconditions: the session never lists `github`; the held change keeps `lsp` declared and names its gate.
		expect(first.tools?.map(tool => tool.name)).not.toContain("github");
		expect(changed.tools?.map(tool => tool.name)).toContain("lsp");
		expect(notices).toContain(SETTINGS_NOTICE);
		expect(notices).toContain("`lsp.enabled`: `true` → `false`");

		expect(notices).not.toContain("github.enabled");
	}, 30_000);
});
