import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlayRebuild, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The rebuilds a reload of these sessions' overlay starts. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshBaseSystemPrompt", "reconcileBuiltinTools"];

/** The file the test writes once the reload's rebuilds have run; the model's command waits for it. */
const RELOADED_MARKER = "reloaded";

describe("a tools.intentTracing change a configuration reload makes on a bound prompt", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("costs at most one rewrite of the cached prompt when it lands while a tool runs", async () => {
		const dir = TempDir.createSync("@pi-settings-hold-intent-tracing-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `${LONG_ENTRIES}tools:\n  intentTracing: true\n`);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		// The session the gateway's second reply reloads the overlay under, set once it exists.
		const live: { session?: AgentSession } = {};
		let reload: Promise<void> | undefined;
		const { requests } = mockGatewayFetch(turn => {
			const session = live.session;
			if (turn !== 2 || !session) return answer(turn, { cacheWriteTokens: 100 });
			// The reload lands while the command the second reply calls is running, between two requests of a run.
			reload = reloadOverlay(
				{ session, settings, overlay },
				`${LONG_ENTRIES}tools:\n  intentTracing: false\n`,
				RELOAD_REBUILDS,
			).then(async () => {
				await Bun.write(dir.join(RELOADED_MARKER), "");
			});
			return toolCallAnswer(
				turn,
				"bash",
				{ command: `while [ ! -f ${RELOADED_MARKER} ]; do sleep 0.05; done`, i: "Waiting for the reload" },
				{ cacheWriteTokens: 100 },
			);
		});
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
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		live.session = session;

		await session.prompt("first");
		await session.prompt("run the command");
		await reload;
		await session.prompt("after the run");

		// Requests 3 (the run's next request) and 4 (the next run) follow the change. Tools come first in cache order,
		// then the system prompt: a request that changes either rewrites the whole cached prompt.
		expect(requests).toHaveLength(4);
		const rewrites = requests.slice(2).filter((request, index) => {
			const previous = requests[index + 1];
			return (
				!previous ||
				withoutCacheControl(request.tools) !== withoutCacheControl(previous.tools) ||
				withoutCacheControl(request.system) !== withoutCacheControl(previous.system)
			);
		});
		// One cache write is the cost a held settings change may take.
		expect(rewrites.length).toBeLessThanOrEqual(1);
	}, 60_000);
});
