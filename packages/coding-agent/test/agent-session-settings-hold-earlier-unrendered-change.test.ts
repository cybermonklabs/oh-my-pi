/**
 * The notice of a held settings change names the settings whose change the rebuild sends: the change that started the
 * hold, and an earlier one the held prompt renders that moved nothing alone. A setting changed in an earlier reload
 * that the prompt's build reads but renders nothing of (`task.maxConcurrency` in a session with no `task` tool) moves
 * nothing beside the later change either. Naming it would tell the model a setting waits for a rebuild that never
 * shows it.
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
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The first sync: a concurrency limit the prompt states only in the delegation guidance of the `task` tool. */
const CONCURRENCY = `${LONG_ENTRIES}task:\n  maxConcurrency: 4\n`;

const MINUTE_MS = 60_000;

describe("a held settings change after an earlier change the prompt renders nothing of", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the held change alone", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-earlier-unrendered-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
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
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, CONCURRENCY, RELOAD_CALLS);
			await reloadOverlay({ session, settings, overlay }, `${CONCURRENCY}personality: pragmatic\n`, RELOAD_CALLS);
			setClock(MINUTE_MS);
			await session.prompt("after both changes");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, changed] = gateway.requests;
		if (!first || !changed) throw new Error("Expected two requests");
		const notices = textOf(changed.messages.slice(first.messages.length));
		// Preconditions: the later change is held (the prompt keeps its bytes) and its notice names it.
		expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));
		expect(notices).toContain(SETTINGS_NOTICE);
		expect(notices).toContain("`personality`");

		expect(notices).not.toContain("task.maxConcurrency");
	}, 60_000);
});
