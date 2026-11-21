/**
 * The task tool records the id it allocates for each spawn in the parent's transcript (a `task_spawn` entry),
 * so `omp --restore` matches a call's subagent by the id it ran under. A call's `name` argument is not that id:
 * a name used before gets a suffix, a nested parent prefixes its own id, a numeric name under
 * `task.crossInstance` becomes `Agent<n>`, an unnamed call gets a generated name, and a name is trimmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** A parent whose calls block on their subagents; `records` collects the `task_spawn` entries it is given. */
function createParent(settings: Record<string, unknown>, agentOutputManager?: AgentOutputManager) {
	const records: unknown[] = [];
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		sessionManager: {
			appendCustomEntry: (customType: string, data?: unknown) => {
				if (customType === "task_spawn") records.push(data);
				return `entry-${records.length}`;
			},
		},
		...(agentOutputManager ? { agentOutputManager } : {}),
	} as unknown as ToolSession;
	return { session, records };
}

describe("the task tool's spawn records", () => {
	/** The ids the subagent runs started under, in order. */
	const ran: string[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ran.push(options.id ?? "?");
			return makeResult(options.id ?? "?");
		});
	});

	afterEach(() => {
		ran.length = 0;
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("records the suffixed id a name used again gets (Scout, then Scout-2)", async () => {
		// If this regresses, the parent's transcript names only "Scout" for both calls, and `omp --restore` cannot
		// tell the second call's subagent from the first one's.
		const { session, records } = createParent({ "task.batch": false });
		const tool = await TaskTool.create(session);

		await tool.execute("tc-1", { agent: "task", name: "Scout", task: "Look." });
		await tool.execute("tc-2", { agent: "task", name: "Scout", task: "Look again." });

		expect(records).toEqual([{ id: "Scout" }, { id: "Scout-2" }]);
		expect(ran).toEqual(["Scout", "Scout-2"]);
	});

	it("records a trimmed name and a generated name as the ids a batch's runs start under", async () => {
		const { session, records } = createParent({ "task.batch": true });
		const tool = await TaskTool.create(session);

		await tool.execute("tc-batch", {
			context: "ctx",
			tasks: [
				{ name: "  Trimmed  ", agent: "task", task: "Do A." },
				{ agent: "task", task: "Do B." },
			],
		});

		// The batch's runs start concurrently, so neither list has a fixed order.
		expect(ran).toHaveLength(2);
		expect(ran).toContain("Trimmed");
		expect(records).toHaveLength(2);
		expect(records).toEqual(expect.arrayContaining(ran.map(id => ({ id }))));
	});

	it("records the prefixed id of a nested parent's spawn (Lead.Worker)", async () => {
		const { session, records } = createParent(
			{ "task.batch": false },
			new AgentOutputManager(() => null, { parentPrefix: "Lead" }),
		);
		const tool = await TaskTool.create(session);

		await tool.execute("tc-nested", { agent: "task", name: "Worker", task: "Work." });

		expect(records).toEqual([{ id: "Lead.Worker" }]);
		expect(ran).toEqual(["Lead.Worker"]);
	});

	it("records the Agent<n> id of a numeric name under task.crossInstance", async () => {
		const { session, records } = createParent({ "task.batch": false, "task.crossInstance": true });
		const tool = await TaskTool.create(session);

		await tool.execute("tc-numeric", { agent: "task", name: "7", task: "Work." });

		expect(records).toEqual([{ id: "Agent7" }]);
		expect(ran).toEqual(["Agent7"]);
	});
});
