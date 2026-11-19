/**
 * `runIsolatedSubprocess` hands the run's IRC wake hold to a caller that takes it over
 * (`ExecutorOptions.deferIrcWakeRelease`, as `runStructuredSubagent` does) and releases nothing itself, so held peer
 * messages wake the agent only once that caller has merged the run's changes. This test runs the real runner;
 * `structured-subagent.test.ts` covers the caller with the runner mocked.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { nativeWorkspace, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];
const BASELINE = {
	root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
	nested: [],
};

afterEach(async () => {
	vi.restoreAllMocks();
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

describe("isolated run's IRC wake hold", () => {
	it("goes to a caller that takes it over, and wakes the agent only when that caller releases it", async () => {
		// If this regresses, an isolated run releases its held peer messages itself as it returns, before its caller
		// (a structured subagent's parent) merges the run's patch: a woken turn writes the worktree while the merge runs.
		const id = "WakeHandOff";
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-wake-"));
		tempRoots.push(artifactsDir);
		const events: string[] = [];
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(BASELINE);
		vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "diff --git a/task.txt b/task.txt\n+work\n",
			nestedPatches: [],
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			// The run holds peer messages back while it runs; the hold is released by whoever owns it at the end.
			options.deferIrcWakeRelease?.(() => events.push("wakes released"));
			return result(options.id);
		});
		let handedOver: (() => void) | undefined;

		const settled = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id,
				keepAlive: false,
				deferIrcWakeRelease: release => {
					events.push("handed over");
					handedOver = release;
				},
			},
			context: { repoRoot: "/repo" },
			openWorkspace: nativeWorkspace(undefined),
			agentId: id,
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
		});

		expect(settled.error).toBeUndefined();
		// The run returned with the hold still held, handed to the caller.
		expect(events).toEqual(["handed over"]);
		expect(handedOver).toBeDefined();
		events.push("merge");
		handedOver?.();
		expect(events).toEqual(["handed over", "merge", "wakes released"]);
	});
});
