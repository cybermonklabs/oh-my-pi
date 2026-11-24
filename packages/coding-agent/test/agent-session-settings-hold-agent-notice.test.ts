/**
 * Enabling an agent the settings disabled is held on a bound prompt: the `task` tool keeps the description it was sent
 * with, which leaves the agent out, and a call to the agent runs under the settings that description was written for,
 * so it is refused until the rebuild. A rescan that edits the agent's description must not tell the model of the agent
 * in a hidden notice meanwhile: the notice would name an agent whose calls are refused.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentDefinition, refreshAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay } from "./helpers/agent-session-setup";
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

/** {@link LONG_ENTRIES} with the agent below disabled. */
const HELPER_DISABLED = `${LONG_ENTRIES}task:\n  disabledAgents:\n    - rec-helper\n`;

function agent(name: string, description: string): AgentDefinition {
	return { name, description, systemPrompt: `You are ${name}.`, source: "project" };
}

describe("an agent enabled by a held settings change", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("is not announced while the task tool's calls to it are refused", async () => {
		const dir = TempDir.createSync("@pi-settings-hold-agent-notice-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, HELPER_DISABLED);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const discovered = [
			agent("explore", "Reads the repository and reports."),
			agent("rec-helper", "Helps with recording tests."),
		];
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => ({
			agents: [...discovered],
			projectAgentsDir: null,
		}));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		await refreshAgentDiscovery(dir.path());
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "task"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});

		await session.prompt("first");
		// The operator enables the agent; then the agents hub rewrites its file with a new description and rescans.
		await reloadOverlay({ session, settings, overlay }, LONG_ENTRIES, RELOAD_CALLS);
		discovered.splice(1, 1, agent("rec-helper", "Records the integration suite."));
		await refreshAgentDiscovery(session.sessionManager.getCwd(), session.effectiveExtensionRoots);
		await session.prompt("second");

		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected two requests");
		// Precondition: the change is held, so the task tool still leaves the agent out, and a call to it is refused.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(second.tools)).not.toContain("rec-helper");

		// The settings notice names the held change; no agents notice names the agent the task tool leaves out.
		const told = textOf(second.messages.slice(first.messages.length));
		expect(told).toContain("`task.disabledAgents`");
		expect(told).not.toContain('<system-notice id="task-agents">');
	}, 30_000);
});
