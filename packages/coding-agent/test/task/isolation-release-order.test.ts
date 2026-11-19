/**
 * When `runIsolatedSubprocess` hands its result back, relative to the release of the agent and to the cleanup the run
 * deferred (owner jobs, shutdown hooks that may still write the worktree).
 *
 * - A release asked for before the run's end is over once the run returns, so the caller merges, applies and removes
 *   its artifacts only after it.
 * - The same holds for a successful run that waited for its deferred cleanup.
 * - A failed run that nothing released and no adoption holds removes its worktree only once its deferred cleanup is
 *   done.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { nativeWorkspace, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { createSessionDefaults } from "../helpers/session-defaults";

const tempRoots: string[] = [];
const BASELINE = {
	root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
	nested: [],
};
let events: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	events = [];
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

function agentSession(): AgentSession {
	return { ...createSessionDefaults(), dispose: async () => {} } as unknown as AgentSession;
}

/**
 * Runs the isolated agent `id` (kept alive unless `keepAlive` is false) in patch mode in a real worktree directory.
 * Its capture reads the directory; its cleanup takes a while and then removes it, recording `cleanup` once done. `run`
 * plays the run between its registration and its result. When the run returns, `returned` is recorded.
 */
async function runAndRecord(
	id: string,
	run: (options: executorModule.ExecutorOptions) => Promise<SingleResult>,
	keepAlive = true,
): Promise<{ settled: SingleResult; worktree: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-order-"));
	tempRoots.push(root);
	const slot = path.join(root, "slot");
	const worktree = path.join(slot, "merged");
	await Bun.write(path.join(worktree, "task.txt"), "work\n");
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: worktree,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(BASELINE);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementation(async dir => {
		const work = await Bun.file(path.join(dir, "task.txt")).text();
		events.push("capture");
		return { rootPatch: `diff --git a/task.txt b/task.txt\n+${work}`, nestedPatches: [] };
	});
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
		await Bun.sleep(50);
		await fs.rm(slot, { recursive: true, force: true });
		events.push("cleanup");
	});
	vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: "", nestedPatches: [] };
	});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: agentSession(),
			sessionFile: path.join(root, `${id}.jsonl`),
			status: "running",
		});
		return run(options);
	});
	const settled = await runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
			keepAlive,
		},
		context: { repoRoot: "/repo" },
		openWorkspace: nativeWorkspace(undefined),
		agentId: id,
		mergeMode: "patch",
		artifactsDir: root,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	events.push("returned");
	return { settled, worktree };
}

/** The run's finalize for an agent its release removed before the run finalized: it calls the release hook itself. */
function finalizeReleased(id: string, onRelease: (() => Promise<void>) | undefined): Promise<void> {
	return executorModule.finalizeSubagentLifecycle({
		id,
		session: agentSession(),
		aborted: false,
		keepAlive: true,
		isolated: true,
		agentIdleTtlMs: 0,
		reviveSession: null,
		onRelease,
	});
}

describe("isolated run's result and its release", () => {
	it("returns only once a release asked for before the run's end has cleaned up", async () => {
		// If this regresses, the parent gets the result while the release still captures and removes the worktree:
		// it merges, applies and removes its artifacts directory while the release may still write the patch there.
		const id = "OrderReleasedBeforeFinalize";
		const { settled } = await runAndRecord(id, async options => {
			await AgentLifecycleManager.global().release(id);
			await finalizeReleased(id, options.onRelease);
			return result(id);
		});

		expect(settled.error).toBeUndefined();
		expect(events).toEqual(["capture", "capture", "cleanup", "returned"]);
	});

	it("returns only once the release is done for a successful run that waited for its deferred cleanup", async () => {
		// If this regresses, a successful run whose owner jobs outlived it hands its result on while the release it
		// waited for still runs, as a failed run's late release does: the parent merges before the release is done.
		const id = "OrderDeferredSuccess";
		const ownerJobs = Promise.withResolvers<void>();
		const { settled } = await runAndRecord(id, async options => {
			await AgentLifecycleManager.global().release(id);
			await finalizeReleased(id, options.onRelease);
			options.onCleanupDeferred?.(ownerJobs.promise.then(() => void events.push("owner jobs done")));
			setTimeout(() => ownerJobs.resolve(), 20);
			return result(id);
		});

		expect(settled.error).toBeUndefined();
		expect(events).toEqual(["owner jobs done", "capture", "capture", "cleanup", "returned"]);
	});

	it("removes a failed run's worktree only once the cleanup it deferred is done", async () => {
		// If this regresses, the run's end removes the worktree while owner jobs or shutdown hooks it left going on still
		// write in it.
		const id = "OrderFailedDeferred";
		const ownerJobs = Promise.withResolvers<void>();
		await runAndRecord(
			id,
			async options => {
				options.onCleanupDeferred?.(ownerJobs.promise.then(() => void events.push("owner jobs done")));
				return { ...result(id), exitCode: 1, error: "agent failed" };
			},
			false,
		);
		await Bun.sleep(150);
		expect(events).toEqual(["returned"]);

		ownerJobs.resolve();
		await Bun.sleep(150);
		expect(events).toEqual(["returned", "owner jobs done", "cleanup"]);
	});
});
