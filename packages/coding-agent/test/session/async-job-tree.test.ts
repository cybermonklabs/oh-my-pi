import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { asyncJobTree } from "@oh-my-pi/pi-coding-agent/session/async-job-views";

describe("asyncJobTree", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("keeps the jobs of a subagent whose parent subagent ended in its ancestor's tree", async () => {
		// If this regresses, a keep-alive subagent whose parent subagent ended (unregistered, its task job gone)
		// drops out of every ancestor's job tree: the session's job view hides that subagent's running jobs.
		AgentRegistry.resetGlobalForTests();
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
		const manager = new AsyncJobManager({});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		try {
			const jobId = manager.register(
				"bash",
				"build",
				async () => {
					started.resolve();
					return release.promise;
				},
				{ ownerId: "Lead.Helper.Worker" },
			);
			await started.promise;

			const tree = asyncJobTree(manager, "Lead");
			expect(tree.running.map(job => job.id)).toEqual([jobId]);
			expect(tree.agents).toEqual([
				{ id: "Lead.Helper.Worker", parentId: "Lead.Helper" },
				{ id: "Lead.Helper", parentId: "Lead" },
			]);
		} finally {
			release.resolve("done");
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
