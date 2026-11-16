import { afterEach, beforeEach, expect, it } from "bun:test";
import { heapStats } from "bun:jsc";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

/** Live `Map` objects on the JS heap after a full collection. */
function liveMaps(): number {
	Bun.gc(true);
	return heapStats().objectTypeCounts.Map ?? 0;
}

/** Let settled jobs finish their completion callbacks and eviction. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

// The case below registers every job at once under `maxRunningJobs: 0`, which needs a job manager that reads a cap of
// 0 as no cap; where a cap of 0 still allows one running job, the case skips.
const capProbe = new AsyncJobManager({ maxRunningJobs: 0, onJobComplete: () => {} });
capProbe.register("task", "cap probe", async () => ({ text: "done" }));
const itUncapped = it.skipIf(capProbe.atCapacity);
await capProbe.dispose();

// A session with IRC on keeps the process-wide bus. Once a subagent's task job has settled and been
// evicted, the process must hold nothing of that job beyond the subagent's registry record. Regressed: a
// long session that runs many subagents grows its memory with every finished subagent and never gets it back.
itUncapped("the IRC bus keeps no per-agent state for task jobs that have settled and been evicted", async () => {
	IrcBus.global();
	const manager = new AsyncJobManager({ retentionMs: 0, maxRunningJobs: 0, onJobComplete: () => {} });
	try {
		const jobs = 2_000;
		// One job first, so state created once per process is not counted against the jobs.
		manager.register("task", "warm-up", async () => ({ text: "done" }), { agentId: "WarmUp", ownerId: "0-Main" });
		await manager.waitForAll();
		await settle();
		const before = liveMaps();

		for (let i = 0; i < jobs; i++) {
			manager.register("task", `job ${i}`, async () => ({ text: "done" }), {
				agentId: `Sub${i}`,
				ownerId: "0-Main",
			});
		}
		await manager.waitForAll();
		await settle();

		expect(manager.getAllJobs()).toHaveLength(0);
		// Generous bound: one live Map per finished job means the bus remembers every job.
		expect(liveMaps() - before).toBeLessThan(jobs / 10);
	} finally {
		await manager.dispose();
	}
});
