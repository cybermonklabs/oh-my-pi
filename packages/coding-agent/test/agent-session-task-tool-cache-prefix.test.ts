import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentDefinition, refreshAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

function taskTool(request: MessagesRequest | undefined): string {
	const tool = request?.tools?.find(candidate => candidate.name === "task");
	if (!tool) throw new Error("Expected the task tool in the request");
	return withoutCacheControl(tool);
}

function agent(name: string, description: string): AgentDefinition {
	return { name, description, systemPrompt: `You are ${name}.`, source: "project" };
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	/** Definitions the next agent discovery scan returns. */
	discovered: AgentDefinition[];
}

describe("task tool definition across requests", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(tempDir: TempDir, settings: Settings): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const discovered = [agent("explore", "Reads the repository and reports.")];
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => ({
			agents: [...discovered],
			projectAgentsDir: null,
		}));
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
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, discovered };
	}

	it("keeps the task tool's bytes when agent discovery gains an agent, and tells the model by a notice", async () => {
		using tempDir = TempDir.createSync("@pi-task-tool-cache-prefix-");
		const harness = await startSession(tempDir, Settings.isolated({ "providers.cacheRetention": "long" }));
		await harness.session.prompt("first");

		// An agent file written mid-session reaches discovery through a rescan (the agents hub, a plugin reload).
		harness.discovered.push(agent("rec-helper", "Helps with recording tests."));
		await refreshAgentDiscovery(harness.session.sessionManager.getCwd(), harness.session.effectiveExtensionRoots);
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		expect(taskTool(first)).not.toContain("rec-helper");
		expect(taskTool(second)).toBe(taskTool(first));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		// The new messages of the second request: the prompt and the hidden notice after it.
		const notice = withoutCacheControl(second.messages.slice(first.messages.length));
		expect(notice).toContain("`rec-helper`: Helps with recording tests.");
		expect(notice).not.toContain("`explore`");
	}, 30_000);

	it("keeps the task tool's bytes when the approved per-call models change, and tells the model by a notice", async () => {
		using tempDir = TempDir.createSync("@pi-task-tool-cache-prefix-");
		const settings = Settings.isolated({
			"providers.cacheRetention": "long",
			"task.perCallModel": "on",
			modelRoles: { "per-call-claude-opus-5-5": "anthropic/claude-opus-5-5:high" },
		});
		const harness = await startSession(tempDir, settings);
		await harness.session.prompt("first");

		// An operator config edit approves another per-call model mid-session.
		settings.setModelRole("per-call-claude-opus-5-5-low", "anthropic/claude-opus-5-5:low");
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		expect(taskTool(first)).toContain("`anthropic/claude-opus-5-5:high` (per-call-claude-opus-5-5)");
		expect(taskTool(second)).toBe(taskTool(first));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		const notice = withoutCacheControl(second.messages.slice(first.messages.length));
		expect(notice).toContain("`anthropic/claude-opus-5-5:high` (per-call-claude-opus-5-5)");
		expect(notice).toContain("`anthropic/claude-opus-5-5:low` (per-call-claude-opus-5-5-low)");
	}, 30_000);
});
