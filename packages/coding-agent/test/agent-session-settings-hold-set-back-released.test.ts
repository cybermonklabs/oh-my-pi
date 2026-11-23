/**
 * A `personality` change on a bound prompt is held, and the hidden settings notice tells the model the change goes out
 * with the rebuild. The setting is set back to the value the prompt was built with while the change is held: the
 * prompt the next request carries already follows it, and the rebuild brings nothing of it. The next notice must name
 * the setting back as in effect, among the settings the change it described no longer holds, not as held.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	personalityOverlay,
	RELOAD_CALLS,
	reloadOverlay,
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

/** The line of a settings notice that starts the settings a change that is no longer held left as they are now. */
const RELEASED_LIST = "the change it described is no longer held";

const MINUTE_MS = 60_000;

describe("a held setting set back to the value the prompt was built with", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is named as in effect in the next notice, not as held", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-set-back-released-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, personalityOverlay("default"));
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
		const harness = { session, settings, overlay };
		try {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay(harness, personalityOverlay("pragmatic"), RELOAD_CALLS);
			setClock(MINUTE_MS);
			await session.prompt("after the change");
			await reloadOverlay(harness, personalityOverlay("default"), RELOAD_CALLS);
			setClock(2 * MINUTE_MS);
			await session.prompt("after the set back");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, changed, setBack] = gateway.requests;
		if (!first || !changed || !setBack) throw new Error("Expected three requests");
		// Preconditions: every request keeps the prompt the model answered under, and the first notice told the change.
		expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(setBack.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(changed.messages.slice(first.messages.length))).toContain(
			'`personality`: `"default"` → `"pragmatic"`',
		);

		const told = textOf(setBack.messages.slice(changed.messages.length));
		const split = told.indexOf(RELEASED_LIST);
		expect(split).toBeGreaterThan(-1);
		expect(told.slice(0, split)).not.toContain("`personality`");
		expect(told.slice(split)).toContain('`personality`: `"pragmatic"` → `"default"`');
	}, 30_000);
});
