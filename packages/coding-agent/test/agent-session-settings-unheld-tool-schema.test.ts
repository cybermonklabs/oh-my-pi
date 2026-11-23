import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
}

describe("a configuration reload of a setting a tool definition renders, on a bound prompt", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(overlay: string, tools: string[]): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-unheld-tool-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
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
			toolNames: tools,
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay: overlayPath };
	}

	// Each setting renders into the named tools' definitions (getters over live settings) and belongs to none of the
	// setting groups whose change starts a held rebuild, so no hold keeps the definitions as sent.
	for (const { setting, before, after, tools } of [
		{
			setting: "tools.maxTimeout",
			before: "tools:\n  maxTimeout: 900\n",
			after: "tools:\n  maxTimeout: 120\n",
			tools: ["read", "bash", "eval"],
		},
		{
			setting: "bash.autoBackground.thresholdMs",
			before: "bash:\n  autoBackground:\n    thresholdMs: 60000\n",
			after: "bash:\n  autoBackground:\n    thresholdMs: 5000\n",
			tools: ["read", "bash"],
		},
		{
			setting: "eval.tools.enabled",
			before: "eval:\n  tools:\n    enabled: true\n",
			after: "eval:\n  tools:\n    enabled: false\n",
			tools: ["read", "eval"],
		},
		{
			setting: "task.enableEffort",
			before: "task:\n  enableEffort: false\n",
			after: "task:\n  enableEffort: true\n",
			tools: ["read", "task"],
		},
	]) {
		it(`keeps the tool definitions as sent at the request after a ${setting} change`, async () => {
			const harness = await startSession(`${LONG_ENTRIES}${before}`, tools);
			await harness.session.prompt("first");
			await reloadOverlay(harness, `${LONG_ENTRIES}${after}`);
			await harness.session.prompt("second");

			const [first, second] = harness.requests;
			if (!first || !second) throw new Error("Expected two requests");
			// Tools come first in cache order: one changed definition rewrites the whole cached prompt a few seconds
			// after the last write, while a held change would wait for a lapse, a cut or five minutes.
			const changedTools = (first.tools ?? [])
				.filter((tool, index) => withoutCacheControl(tool) !== withoutCacheControl(second.tools?.[index]))
				.map(tool => tool.name);
			expect(changedTools).toEqual([]);
		}, 60_000);
	}
});
