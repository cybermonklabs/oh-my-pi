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
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

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

/** The messages `later` sends after everything `earlier` sent: the new prompt and any hidden notice with it. */
function newMessages(earlier: MessagesRequest, later: MessagesRequest): string {
	return withoutCacheControl(later.messages.slice(earlier.messages.length));
}

describe("hidden notices about what task and eval agent() can use", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(tempDir: TempDir, settings: Settings, toolNames: string[]): Promise<Harness> {
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
		// Another session of this process (a parent, a sibling) has already scanned this directory.
		await refreshAgentDiscovery(tempDir.path());
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames,
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, discovered };
	}

	it("does not announce an agent the settings disable as available", async () => {
		const tempDir = TempDir.createSync("@pi-task-agent-notice-policy-");
		cleanups.push(() => tempDir.remove());
		const settings = Settings.isolated({ "providers.cacheRetention": "long", "task.disabledAgents": ["rec-helper"] });
		const harness = await startSession(tempDir, settings, ["read", "task"]);
		await harness.session.prompt("first");

		// An agent file lands mid-session; the operator has disabled that agent.
		harness.discovered.push(agent("rec-helper", "Helps with recording tests."));
		await refreshAgentDiscovery(harness.session.sessionManager.getCwd(), harness.session.effectiveExtensionRoots);
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		// The task description hides a disabled agent, and a call to it fails: nothing may tell the model it is there.
		expect(withoutCacheControl(second.tools)).not.toContain("rec-helper");
		expect(newMessages(first, second)).not.toContain("rec-helper");
	}, 30_000);

	it("tells the model the new description of an agent edited mid-session", async () => {
		const tempDir = TempDir.createSync("@pi-task-agent-notice-policy-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir, Settings.isolated({ "providers.cacheRetention": "long" }), [
			"read",
			"task",
		]);
		await harness.session.prompt("first");

		// The agents hub rewrites the agent's file with a new description, then rescans.
		harness.discovered.splice(0, 1, agent("explore", "Runs the integration suite and reports failures."));
		await refreshAgentDiscovery(harness.session.sessionManager.getCwd(), harness.session.effectiveExtensionRoots);
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		// The task description keeps the bytes it was sent with, so the edit has to reach the model another way.
		const told = withoutCacheControl(second.tools) + newMessages(first, second);
		expect(told).toContain("Runs the integration suite and reports failures.");
	}, 30_000);

	it("tells a session without the task tool nothing about agents task can spawn", async () => {
		const tempDir = TempDir.createSync("@pi-task-agent-notice-policy-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir, Settings.isolated({ "providers.cacheRetention": "long" }), ["read"]);
		await harness.session.prompt("first");

		harness.discovered.push(agent("rec-helper", "Helps with recording tests."));
		await refreshAgentDiscovery(harness.session.sessionManager.getCwd(), harness.session.effectiveExtensionRoots);
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		expect(second.tools?.map(tool => tool.name)).not.toContain("task");
		expect(newMessages(first, second)).not.toContain("rec-helper");
	}, 30_000);

	it("tells a session with neither task nor eval nothing about per-call models", async () => {
		const tempDir = TempDir.createSync("@pi-task-agent-notice-policy-");
		cleanups.push(() => tempDir.remove());
		const settings = Settings.isolated({
			"providers.cacheRetention": "long",
			"task.perCallModel": "on",
			modelRoles: { "per-call-claude-opus-5-5": "anthropic/claude-opus-5-5:high" },
		});
		const harness = await startSession(tempDir, settings, ["read"]);
		await harness.session.prompt("first");

		settings.setModelRole("per-call-claude-opus-5-5-low", "anthropic/claude-opus-5-5:low");
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		const names = second.tools?.map(tool => tool.name) ?? [];
		expect(names).not.toContain("task");
		expect(names).not.toContain("eval");
		expect(newMessages(first, second)).not.toContain("per-call-claude-opus-5-5-low");
	}, 30_000);
});
