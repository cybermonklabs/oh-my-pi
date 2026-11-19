import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
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
/** Order of worktree captures, cleanups and branch commits, and of the run's IRC wake release. */
let events: string[] = [];
/** The parent whose end releases the agents of the release-race tests below. */
const RELEASING_PARENT = "IsolationReleaseParent";
const BASELINE = {
	root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
	nested: [],
};
/** The agent's work in its worktree, as a capture writes it. */
const WORK_PATCH = "diff --git a/task.txt b/task.txt\n+work\n";
/** A nested repo's part of the agent's work. */
const NESTED_PATCH = "diff --git a/lib.txt b/lib.txt\n+nested\n";

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

function agentSession(dispose: () => Promise<void>): AgentSession {
	return { ...createSessionDefaults(), dispose } as unknown as AgentSession;
}

/** The run's own `finalizeSubagentLifecycle` for a kept-alive isolated agent that finished its turn. */
function finalizeFinished(id: string, session: AgentSession, onRelease?: () => Promise<void>): Promise<void> {
	return executorModule.finalizeSubagentLifecycle({
		id,
		session,
		aborted: false,
		keepAlive: true,
		isolated: true,
		agentIdleTtlMs: 0,
		reviveSession: async () => session,
		onRelease,
	});
}

/** Runs the kept-alive isolated agent `id` in `mergeMode`, its patch files written to `artifactsDir`. */
function runIsolated(id: string, mergeMode: "patch" | "branch", artifactsDir: string): Promise<SingleResult> {
	return runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
		},
		context: { repoRoot: "/repo" },
		openWorkspace: nativeWorkspace(undefined),
		agentId: id,
		mergeMode,
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
}

/**
 * Runs a kept-alive branch-mode isolated agent whose workspace delta is
 * `runEndPatch` when it finishes and `releasePatch` when it is released, and
 * returns how many times a task branch was committed.
 */
async function commitsAcrossRelease(
	id: string,
	runEndPatch: string,
	releasePatch: string,
	options: { cleanup?: () => Promise<void>; afterRun?: () => Promise<void> } = {},
): Promise<number> {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-"));
	tempRoots.push(artifactsDir);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: "/repo/isolated",
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(BASELINE);
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(options.cleanup ?? (async () => {}));
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: releasePatch, nestedPatches: [] });
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: runEndPatch, nestedPatches: [] };
	});
	const session = agentSession(async () => {});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: `/tmp/${options.id}.jsonl`,
			status: "running",
		});
		// A held peer message would wake a turn in the worktree once released.
		options.deferIrcWakeRelease?.(() => events.push("irc wakes released"));
		await finalizeFinished(options.id, session, options.onRelease);
		return result(options.id);
	});

	await runIsolated(id, "branch", artifactsDir);
	if (options.afterRun) await options.afterRun();
	else await AgentLifecycleManager.global().release(id);
	return commitSpy.mock.calls.length;
}

/**
 * Runs a kept-alive isolated agent (patch mode unless `variant.mergeMode` says otherwise) under
 * {@link RELEASING_PARENT} in a real worktree directory that holds its work in `task.txt`, beside a nested repo's
 * fixed patch. A capture reads that file and the cleanup removes the directory, so a capture after the cleanup fails
 * as git fails in a removed worktree; each capture, cleanup and task-branch commit (which throws
 * `variant.commitError` when given) goes to {@link events}. `finish` ends the run once its subagent is registered
 * with `session`, given the release hook the run hands over. Returns the run's result, its artifacts directory and
 * worktree, and how many task-branch commits were tried so far.
 */
async function runInWorktree(
	id: string,
	session: AgentSession,
	finish: (onRelease: () => Promise<void>) => Promise<void>,
	variant: { mergeMode?: "patch" | "branch"; commitError?: Error } = {},
): Promise<{ settled: SingleResult; artifactsDir: string; worktree: string; commits: () => number }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-race-"));
	tempRoots.push(root);
	const slot = path.join(root, "slot");
	const worktree = path.join(slot, "merged");
	const artifactsDir = path.join(root, "artifacts");
	await Bun.write(path.join(worktree, "task.txt"), "work\n");
	await fs.mkdir(artifactsDir);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: worktree,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(BASELINE);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementation(async dir => {
		let work: string;
		try {
			work = await Bun.file(path.join(dir, "task.txt")).text();
		} catch (error) {
			events.push("capture of a removed worktree");
			throw error;
		}
		events.push("capture");
		return {
			rootPatch: `diff --git a/task.txt b/task.txt\n+${work}`,
			nestedPatches: [{ relativePath: "vendor/lib", patch: NESTED_PATCH }],
		};
	});
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
		events.push("cleanup");
		await fs.rm(slot, { recursive: true, force: true });
	});
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		if (variant.commitError) throw variant.commitError;
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: WORK_PATCH, nestedPatches: [] };
	});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: RELEASING_PARENT,
			session,
			sessionFile: `/tmp/${id}.jsonl`,
			status: "running",
		});
		if (!options.onRelease) throw new Error("Expected a release hook for a kept-alive isolated run");
		await finish(options.onRelease);
		return result(id);
	});

	const settled = await runIsolated(id, variant.mergeMode ?? "patch", artifactsDir);
	return { settled, artifactsDir, worktree, commits: () => commitSpy.mock.calls.length };
}

describe("isolated agent release", () => {
	it("does not re-commit a workspace that is unchanged since the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseUnchanged", WORK_PATCH, WORK_PATCH)).toBe(1);
	});

	it("commits follow-up work made after the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseChanged", WORK_PATCH, `${WORK_PATCH}+follow-up\n`)).toBe(2);
	});

	it("lets held peer messages wake the agent only after the run-end branch is committed", async () => {
		await commitsAcrossRelease("ReleaseAfterCapture", WORK_PATCH, WORK_PATCH);
		expect(events).toEqual(["commit", "irc wakes released"]);
	});

	it("keeps a timed-out shutdown release alive until the sandbox is removed", async () => {
		const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "omp-signal-isolation-"));
		tempRoots.push(sandbox);
		const finishCleanup = Promise.withResolvers<void>();
		const registrations = vi.spyOn(postmortem, "register");
		await commitsAcrossRelease("ReleaseAfterDeadline", WORK_PATCH, WORK_PATCH, {
			cleanup: async () => {
				await finishCleanup.promise;
				await fs.rm(sandbox, { recursive: true });
			},
			afterRun: async () => {
				await AgentLifecycleManager.global().dispose({ deadlineAt: Date.now() });
				expect(
					await fs.stat(sandbox).then(
						() => true,
						() => false,
					),
				).toBe(true);
				const signalRelease = registrations.mock.calls.find(
					([id]) => id === "isolation-release:ReleaseAfterDeadline",
				)?.[1];
				expect(signalRelease).toBeDefined();
				const awaitedCleanup = signalRelease?.(postmortem.Reason.SIGHUP);
				finishCleanup.resolve();
				await awaitedCleanup;
				expect(
					await fs.stat(sandbox).then(
						() => true,
						() => false,
					),
				).toBe(false);
			},
		});
	});
});

describe("isolated agent released as its run finishes", () => {
	it("captures the run's patch before the release of a refused adoption removes the worktree", async () => {
		// If this regresses, the adoption the release refuses starts the agent's release hook at once: it commits a
		// task branch for the run's own unchanged work and removes the worktree while the run's end still captures
		// it, so the run reports a failed capture, or names a patch of a half-removed worktree that its parent merges.
		const id = "ReleasedWhileFinishing";
		const disposing = Promise.withResolvers<void>();
		const session = agentSession(() => disposing.promise);
		let hookCalls = 0;
		const { settled, artifactsDir, commits } = await runInWorktree(id, session, async onRelease => {
			// The parent's end (an ACP close) releases the agent, and holds it while it disposes its session.
			const releasing = AgentLifecycleManager.global().releaseUnder(RELEASING_PARENT);
			let hook: Promise<void> | undefined;
			await finalizeFinished(id, session, () => {
				hookCalls++;
				hook = onRelease();
				return hook;
			});
			// Let a release the refused adoption started go as far as it can before the run's end goes on.
			// A release that waits for that end would hold the run here, so the wait is bounded (only such a
			// release reaches the bound); a fake clock would also stop the lifecycle's own release deadline.
			if (hook) await Promise.race([hook, Bun.sleep(1000)]);
			disposing.resolve();
			await releasing;
		});

		expect(settled.error).toBeUndefined();
		expect(settled.patchPath).toBe(path.join(artifactsDir, `${id}.patch`));
		expect(await Bun.file(path.join(artifactsDir, `${id}.patch`)).text()).toBe(WORK_PATCH);
		expect(events).toEqual(["capture", "capture", "cleanup"]);
		expect(commits()).toBe(0);
		expect(hookCalls).toBe(1);
	});

	it("captures the run's patch of an agent released before its run finalized, whose finalize runs the hook", async () => {
		// If this regresses, the finalize, which finds the agent gone and runs its release hook itself, lets the hook
		// commit a task branch and remove the worktree before the run's end captures it, or never returns: the hook
		// waits for the run's end, which waits for the finalize.
		const id = "ReleasedBeforeFinalize";
		const session = agentSession(async () => {});
		let hookCalls = 0;
		const { settled, artifactsDir, commits } = await runInWorktree(id, session, async onRelease => {
			await AgentLifecycleManager.global().release(id);
			await finalizeFinished(id, session, () => {
				hookCalls++;
				return onRelease();
			});
		});

		expect(settled.error).toBeUndefined();
		expect(settled.patchPath).toBe(path.join(artifactsDir, `${id}.patch`));
		expect(await Bun.file(path.join(artifactsDir, `${id}.patch`)).text()).toBe(WORK_PATCH);
		expect(events).toEqual(["capture", "capture", "cleanup"]);
		expect(commits()).toBe(0);
		expect(hookCalls).toBe(1);
	});
});

describe("isolated agent released after its run returned", () => {
	it("leaves the run-end patch files as written when the released workspace is unchanged", async () => {
		// If this regresses, the release of an unchanged workspace rewrites the run's `<id>.patch` and nested patch
		// files while the parent may still be reading them to merge, so the parent can read a truncated patch.
		const id = "ReleasedUnchanged";
		const session = agentSession(async () => {});
		const { settled, artifactsDir, commits } = await runInWorktree(id, session, onRelease =>
			finalizeFinished(id, session, onRelease),
		);
		const patchFiles = [path.join(artifactsDir, `${id}.patch`), ...(settled.nestedPatchPaths ?? [])];
		expect(patchFiles).toHaveLength(2);
		// Stands for what the run-end capture wrote: any write by the release replaces it.
		for (const file of patchFiles) await Bun.write(file, "as the run-end capture wrote it\n");

		await AgentLifecycleManager.global().release(id);

		for (const file of patchFiles) expect(await Bun.file(file).text()).toBe("as the run-end capture wrote it\n");
		expect(events).toEqual(["capture", "capture", "cleanup"]);
		expect(commits()).toBe(0);
	});

	it("leaves the patch files of a failed run-end branch commit as written when the released workspace is unchanged", async () => {
		// If this regresses, a branch-mode run whose task-branch commit failed hands its parent `<id>.patch` (its error
		// names it), and the release of the unchanged workspace rewrites that patch while the parent may be reading it
		// and tries the failed commit again.
		const id = "ReleasedAfterFailedCommit";
		const session = agentSession(async () => {});
		const { settled, artifactsDir, commits } = await runInWorktree(
			id,
			session,
			onRelease => finalizeFinished(id, session, onRelease),
			{ mergeMode: "branch", commitError: new Error("task branch conflict") },
		);
		expect(settled.error).toContain("Merge failed: task branch conflict");
		expect(settled.patchPath).toBe(path.join(artifactsDir, `${id}.patch`));
		const patchFiles = [path.join(artifactsDir, `${id}.patch`), ...(settled.nestedPatchPaths ?? [])];
		expect(patchFiles).toHaveLength(2);
		// Stands for what the run-end capture wrote: any write by the release replaces it.
		for (const file of patchFiles) await Bun.write(file, "as the run-end capture wrote it\n");

		await AgentLifecycleManager.global().release(id);

		for (const file of patchFiles) expect(await Bun.file(file).text()).toBe("as the run-end capture wrote it\n");
		expect(events).toEqual(["capture", "commit", "capture", "capture", "cleanup"]);
		expect(commits()).toBe(1);
	});

	it("writes the new patch and commits a task branch when the released workspace has follow-up work", async () => {
		// If this regresses, work the agent did in its worktree after the run's end is lost when it is released: no
		// patch file holds it and no task branch carries it.
		const id = "ReleasedAfterFollowUp";
		const session = agentSession(async () => {});
		const { artifactsDir, worktree, commits } = await runInWorktree(id, session, onRelease =>
			finalizeFinished(id, session, onRelease),
		);
		await Bun.write(path.join(worktree, "task.txt"), "work\nfollow-up\n");

		await AgentLifecycleManager.global().release(id);

		expect(await Bun.file(path.join(artifactsDir, `${id}.patch`)).text()).toBe(`${WORK_PATCH}follow-up\n`);
		expect(events).toEqual(["capture", "capture", "commit", "cleanup"]);
		expect(commits()).toBe(1);
	});
});
