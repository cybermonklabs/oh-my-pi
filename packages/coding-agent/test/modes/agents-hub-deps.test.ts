import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSessionDisposeOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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
});
