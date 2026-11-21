import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

// `task.maxConcurrency` renders into the system prompt ("Max N concurrent subagents") and no listener rebuilds the
// prompt for it. Changed before the first request, nothing is cached and nothing binds the prompt yet: the change
// belongs in the prompt the first request sends, not in one a later rebuild sends after the first reply bound it.
describe("a configuration reload of a setting only the system prompt renders, before the first request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the change with the first request and keeps that prompt through a later rebuild", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-unbound-prompt-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "task"],
			contextFiles: [],
			skills: [],
		});
		try {
			const spy = vi.spyOn(session, "holdToolDeclarationChange");
			await Bun.write(overlay, `${LONG_ENTRIES}task:\n  maxConcurrency: 3\n`);
			await settings.reloadFromDisk();
			await Promise.resolve();
			await Promise.all(spy.mock.results.map(result => result.value));
			spy.mockRestore();
			await session.prompt("first");
			// A rebuild that changes nothing of its own, such as a memory backend's periodic refresh.
			await session.refreshBaseSystemPrompt();
			await session.prompt("second");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, second] = gateway.requests;
		if (!first || !second) throw new Error("Expected two requests");
		// The first request already carries the setting as now set.
		expect(textOf(first.system)).toContain("Max 3 concurrent subagents");
		// The prompt the first reply bound stays: a new one would rewrite the whole cached prompt a moment after its
		// first write.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);
});
