import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode viewing header", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-viewing-lineage-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
	});

	it("leads back to a focused subagent's live ancestors also above a parent that ended", () => {
		// If this regresses, focusing a subagent whose parent subagent has ended (unregistered) drops every live
		// ancestor above that parent from the viewing header, whose crumbs then no longer lead back to them.
		const registry = AgentRegistry.global();
		registry.register({ id: "Lead", displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		registry.register({ id: "Lead.Helper", displayName: "task", kind: "sub", parentId: "Lead", session: null });
		registry.register({
			id: "Lead.Helper.Worker",
			displayName: "task",
			kind: "sub",
			parentId: "Lead.Helper",
			session: null,
		});
		registry.unregister("Lead.Helper");
		Object.defineProperty(mode, "focusedAgentId", { value: "Lead.Helper.Worker", configurable: true });

		expect(mode.editor.composerState().viewing).toEqual(["Lead", "Lead.Helper.Worker"]);
	});
});
