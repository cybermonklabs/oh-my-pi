import { afterEach, describe, expect, it, vi } from "bun:test";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionDisposeOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "agents-hub-deps-test";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the Agent Hub's agent generator", () => {
	it("ends its helper session with a stop of its jobs, as the host session goes on", async () => {
		// If this regresses, the helper session's end cuts off the jobs of the idle subagents its lifecycle teardown
		// releases, as a process exit does: their subagents record a process exit that did not happen, and
		// `omp --restore` relaunches their turns.
		const authStorage = createInMemoryAuthStorage();
		try {
			const modelRegistry = new ModelRegistry(authStorage);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
			vi.spyOn(modelRegistry, "refresh").mockResolvedValue(undefined);
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
			const disposals: Array<AgentSessionDisposeOptions | undefined> = [];
			const helper = {
				subscribe: () => () => {},
				prompt: async () => true,
				state: { messages: [createAssistantMessage("name: reviewer")] },
				dispose: async (options?: AgentSessionDisposeOptions) => {
					disposals.push(options);
				},
			};
			vi.spyOn(sdk, "createAgentSession").mockResolvedValue({
				session: helper,
			} as unknown as sdk.CreateAgentSessionResult);
			const deps = createAgentsHubDeps(process.cwd(), Settings.isolated(), modelRegistry, () => ({
				explicit: [],
				configured: [],
				configuredLevel: "user",
				mode: "explicit-only",
			}));

			expect(await deps.generateAgent("an agent that reviews diffs", () => {})).toBe("name: reviewer");
			expect(disposals).toEqual([{ ownedJobsEnd: "stop" }]);
		} finally {
			authStorage.close();
		}
	});

	it("leaves the host session's Main agent and the agent lifecycle as they were", async () => {
		// If this regresses, the generator's helper session registers under the host's `Main` agent id: it replaces the
		// host's registry ref and unregisters it at its end, so the host session drops out of the agent registry (IRC,
		// the Agent Hub) while it goes on; or its end tears down the process-global agent lifecycle the host owns.
		using dir = TempDir.createSync("@pi-agents-hub-generator-");
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const hostSession = { dispose: async () => {} } as unknown as AgentSession;
		const hostRef = registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: hostSession,
			status: "running",
		});
		try {
			const modelRegistry = new ModelRegistry(authStorage);
			const model = createMockModel({ id: "generator-model", handler: () => ({ content: ["name: reviewer"] }) });
			vi.spyOn(modelRegistry, "refresh").mockResolvedValue(undefined);
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
			// The generator's real session, kept off the user's agent directory.
			const createAgentSession = sdk.createAgentSession;
			vi.spyOn(sdk, "createAgentSession").mockImplementation(options =>
				createAgentSession({
					...options,
					agentDir: dir.join("agent"),
					sessionManager: SessionManager.inMemory(dir.path()),
				}),
			);
			const deps = createAgentsHubDeps(dir.path(), Settings.isolated(), modelRegistry, () => ({
				explicit: [],
				configured: [],
				configuredLevel: "user",
				mode: "explicit-only",
			}));

			expect(await deps.generateAgent("an agent that reviews diffs", () => {})).toBe("name: reviewer");
			expect(registry.get(MAIN_AGENT_ID)).toBe(hostRef);
			expect(hostRef.session).toBe(hostSession);
			expect(AgentLifecycleManager.global()).toBe(lifecycle);
		} finally {
			registry.unregister(MAIN_AGENT_ID, hostRef);
			authStorage.close();
			unregisterCustomApis(MOCK_API_SOURCE);
			// The generator's session opened agent storage under the temp dir removed below.
			AgentStorage.close();
		}
	});
});
