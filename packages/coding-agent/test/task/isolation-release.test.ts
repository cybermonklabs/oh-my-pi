import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { nativeWorkspace, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { letRefusedReleaseRun } from "../helpers/release-race";
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

/**
 * Runs the kept-alive isolated agent `id` in `mergeMode`, its patch files written to `artifactsDir`, for a caller that
 * takes the run's deferred cleanup over through `onCleanupDeferred` when given.
 */
function runIsolated(
	id: string,
	mergeMode: "patch" | "branch",
	artifactsDir: string,
	onCleanupDeferred?: (completion: Promise<void>) => void,
): Promise<SingleResult> {
	return runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
			onCleanupDeferred,
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
 * as git fails in a removed worktree; each capture, cleanup and task-branch commit (which commits the delta it is
 * given, or throws `variant.commitError` when given) goes to {@link events}. The worktree reports `variant.backend`
 * (Rcopy unless given). `finish` ends the run once its subagent is registered with `session`, given the release hook
 * the run hands over; the run then succeeds, or with `variant.failedWithLateCleanup` fails and leaves that cleanup
 * going on (`onCleanupDeferred`), which the run hands on to `variant.onCleanupDeferred`. With
 * `variant.blockRootPatch`, a directory holds the place of `<id>.patch`, so no root patch can be written. Returns the
 * run's result, the directory holding its worktree slot, its artifacts directory and worktree, how many captures and
 * task-branch commits were tried so far, and the first cleanup's end.
 */
async function runInWorktree(
	id: string,
	session: AgentSession,
	finish: (onRelease: () => Promise<void>) => Promise<void>,
	variant: {
		mergeMode?: "patch" | "branch";
		commitError?: Error;
		backend?: natives.IsoBackendKind;
		failedWithLateCleanup?: Promise<void>;
		onCleanupDeferred?: (completion: Promise<void>) => void;
		blockRootPatch?: boolean;
	} = {},
): Promise<{
	settled: SingleResult;
	root: string;
	artifactsDir: string;
	worktree: string;
	captures: () => number;
	commits: () => number;
	cleanedUp: Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-race-"));
	tempRoots.push(root);
	const slot = path.join(root, "slot");
	const worktree = path.join(slot, "merged");
	const artifactsDir = path.join(root, "artifacts");
	await Bun.write(path.join(worktree, "task.txt"), "work\n");
	await fs.mkdir(artifactsDir);
	if (variant.blockRootPatch) await fs.mkdir(path.join(artifactsDir, `${id}.patch`));
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: worktree,
		backend: variant.backend ?? natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(BASELINE);
	const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementation(async dir => {
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
	const cleanedUp = Promise.withResolvers<void>();
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
		events.push("cleanup");
		await fs.rm(slot, { recursive: true, force: true });
		cleanedUp.resolve();
	});
	const commitSpy = vi
		.spyOn(worktreeModule, "commitToBranch")
		.mockImplementation(async (_dir, _baseline, _taskId, _description, _commitMessage, delta) => {
			events.push("commit");
			if (variant.commitError) throw variant.commitError;
			return {
				branchName: `omp/task/${id}`,
				baseSha: "base",
				rootPatch: delta?.rootPatch ?? "",
				nestedPatches: delta?.nestedPatches ?? [],
			};
		});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: RELEASING_PARENT,
			session,
			sessionFile: path.join(root, `${id}.jsonl`),
			status: "running",
		});
		if (!options.onRelease) throw new Error("Expected a release hook for a kept-alive isolated run");
		await finish(options.onRelease);
		if (!variant.failedWithLateCleanup) return result(id);
		options.onCleanupDeferred?.(variant.failedWithLateCleanup);
		return { ...result(id), exitCode: 1, error: "agent failed" };
	});

	const settled = await runIsolated(id, variant.mergeMode ?? "patch", artifactsDir, variant.onCleanupDeferred);
	return {
		settled,
		root,
		artifactsDir,
		worktree,
		captures: () => captureSpy.mock.calls.length,
		commits: () => commitSpy.mock.calls.length,
		cleanedUp: cleanedUp.promise,
	};
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
			await letRefusedReleaseRun(hook);
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

	it("captures nothing when the release comes after the run's end removed the worktree itself", async () => {
		// If this regresses, a release that disposes the session of an agent adopted a moment before, and calls its
		// release hook only after the run's end found the agent no longer adopted and removed the worktree, captures
		// that removed worktree: it logs a false patch-capture failure and leaves a stray `.retained-*` directory.
		const id = "ReleasedAfterRunEndCleanup";
		const disposing = Promise.withResolvers<void>();
		const session = agentSession(() => disposing.promise);
		const warn = vi.spyOn(logger, "warn");
		let releasing: Promise<boolean> | undefined;
		const { settled, root, artifactsDir } = await runInWorktree(
			id,
			session,
			async onRelease => {
				await finalizeFinished(id, session, onRelease);
				// The parent's end (an ACP close) releases the agent just adopted, and holds it while it disposes
				// its session.
				releasing = AgentLifecycleManager.global().release(id);
			},
			{ backend: natives.IsoBackendKind.Overlayfs },
		);
		// The run has returned; the release's dispose ends only now, and its hook comes after the run's end.
		disposing.resolve();
		await releasing;

		expect(settled.error).toBeUndefined();
		expect(await Bun.file(path.join(artifactsDir, `${id}.patch`)).text()).toBe(WORK_PATCH);
		expect(events).toEqual(["capture", "cleanup"]);
		expect((await fs.readdir(root)).filter(entry => entry.includes(".retained-"))).toEqual([]);
		const warnings = warn.mock.calls.map(call => JSON.stringify(call));
		expect(warnings.filter(warning => warning.includes("Patch capture failed"))).toEqual([]);
	});

	it("captures a failed run's worktree only once the run's deferred cleanup is done, and returns the result first", async () => {
		// If this regresses, the release of a failed run, asked for before the run's end, captures and removes the
		// worktree while the cleanup the run deferred (its owner jobs, its session's shutdown) may still write it, so
		// what they write is in no patch; or the failed run's result waits for that cleanup.
		const id = "ReleasedWithLateCleanup";
		const session = agentSession(async () => {});
		const lateCleanup = Promise.withResolvers<void>();
		const { settled, artifactsDir, worktree, captures, commits, cleanedUp } = await runInWorktree(
			id,
			session,
			async onRelease => {
				await AgentLifecycleManager.global().release(id);
				await finalizeFinished(id, session, onRelease);
			},
			{ failedWithLateCleanup: lateCleanup.promise },
		);

		expect(settled.error).toBe("agent failed");
		expect(captures()).toBe(0);
		expect(events).toEqual([]);
		// An owner job writes the worktree before the deferred cleanup is done.
		await Bun.write(path.join(worktree, "task.txt"), "work\nlate\n");
		lateCleanup.resolve();
		await cleanedUp;

		expect(await Bun.file(path.join(artifactsDir, `${id}.patch`)).text()).toBe(`${WORK_PATCH}late\n`);
		expect(events).toEqual(["capture", "commit", "cleanup"]);
		expect(commits()).toBe(1);
	});

	it("removes the caller's artifacts directory only after a failed run's late release is done with it", async () => {
		// If this regresses, a caller that removes its temporary artifacts directory once the run's deferred cleanup
		// settles (as `runStructuredSubagent` does) removes it while the release of the failed run still captures, and
		// the release's patch then creates the directory again, with nothing left to remove it.
		const id = "ReleasedWithLateCleanupUnderCaller";
		const session = agentSession(async () => {});
		const lateCleanup = Promise.withResolvers<void>();
		let handedOn: Promise<void> | undefined;
		const { settled, artifactsDir, cleanedUp } = await runInWorktree(
			id,
			session,
			async onRelease => {
				await AgentLifecycleManager.global().release(id);
				await finalizeFinished(id, session, onRelease);
			},
			{
				failedWithLateCleanup: lateCleanup.promise,
				// The caller keeps the last completion it is handed, as `runStructuredSubagent` does.
				onCleanupDeferred: completion => {
					handedOn = completion;
				},
			},
		);
		// The caller starts removing its artifacts as the completion settles; any release still going on then would
		// write into the directory being removed.
		const removed = (handedOn ?? Promise.resolve()).then(async () => {
			events.push("artifacts removal");
			await fs.rm(artifactsDir, { recursive: true, force: true });
		});
		lateCleanup.resolve();
		await Promise.all([removed, cleanedUp]);

		expect(settled.error).toBe("agent failed");
		expect(events).toEqual(["capture", "commit", "cleanup", "artifacts removal"]);
		expect(
			await fs.stat(artifactsDir).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("keeps a branch-mode run's root patch, named in the agent's history, when a kill's release comes after the run's end cleaned up", async () => {
		// If this regresses, a branch-mode agent killed as its run ends, whose release hook comes only after the run's
		// end removed the worktree, leaves no `<id>.patch`: its history names no patch, so the Agent Hub shows none.
		const id = "KilledAfterBranchRunEnd";
		const disposing = Promise.withResolvers<void>();
		const session = agentSession(() => disposing.promise);
		let killing: Promise<boolean> | undefined;
		const { artifactsDir } = await runInWorktree(
			id,
			session,
			async onRelease => {
				await finalizeFinished(id, session, onRelease);
				// An Agent Hub kill releases the agent just adopted, keeps its row, and holds the release while it
				// disposes the agent's session.
				killing = AgentLifecycleManager.global().release(id, undefined, { tombstone: true });
			},
			{ mergeMode: "branch" },
		);
		disposing.resolve();
		await killing;

		const patchPath = path.join(artifactsDir, `${id}.patch`);
		expect(await Bun.file(patchPath).text()).toBe(WORK_PATCH);
		expect(AgentRegistry.global().get(id)?.history?.patchPath).toBe(patchPath);
		expect(events).toEqual(["capture", "commit", "cleanup"]);
		AgentRegistry.global().unregister(id);
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

	it("writes a branch-mode run's root patch as the run ends and names it in the agent's history", async () => {
		// If this regresses, a successful branch-mode run leaves no `<id>.patch` until a release writes one, and a
		// release that comes after the run's end cleaned up writes none: the agent's history names no patch, so the
		// Agent Hub shows none for it, and once its merged task branch is deleted no diff of its work is left on disk.
		const id = "BranchRunEndPatch";
		const session = agentSession(async () => {});
		const { artifactsDir } = await runInWorktree(id, session, onRelease => finalizeFinished(id, session, onRelease), {
			mergeMode: "branch",
		});

		const patchPath = path.join(artifactsDir, `${id}.patch`);
		expect(await Bun.file(patchPath).text()).toBe(WORK_PATCH);
		expect(AgentRegistry.global().get(id)?.history?.patchPath).toBe(patchPath);
		await AgentLifecycleManager.global().release(id);
	});

	it("hands its parent the same branch-mode result whether or not the run could write its root patch", async () => {
		// If this regresses, the root patch a successful branch-mode run writes as the agent's record changes what its
		// parent gets: the result names it, so the parent's merge, its task summary or the task's rendering differ from
		// a run at the base, which named no root patch, and from a run whose root patch could not be written.
		const id = "BranchRootPatchRecord";
		for (const blockRootPatch of [false, true]) {
			const session = agentSession(async () => {});
			const { settled, artifactsDir } = await runInWorktree(
				id,
				session,
				onRelease => finalizeFinished(id, session, onRelease),
				{ mergeMode: "branch", blockRootPatch },
			);

			const rootPatch = await Bun.file(path.join(artifactsDir, `${id}.patch`))
				.text()
				.catch(() => undefined);
			expect(rootPatch).toBe(blockRootPatch ? undefined : WORK_PATCH);
			expect(settled).toEqual({
				...result(id),
				isolated: true,
				branchName: `omp/task/${id}`,
				branchBaseSha: "base",
				nestedPatches: [{ relativePath: "vendor/lib", patch: NESTED_PATCH }],
				nestedPatchPaths: [path.join(artifactsDir, `${id}.nested-0-vendor_lib.patch`)],
			});
			await AgentLifecycleManager.global().release(id);
		}
	});

	it("leaves the patch files of a branch-mode run as written when the released workspace is unchanged", async () => {
		// If this regresses, the release of an unchanged branch-mode workspace rewrites the `<id>.patch` and nested
		// patch files its run's end wrote, which the parent's summary names when its merge fails, and removes them all
		// when one write fails.
		const id = "ReleasedBranchUnchanged";
		const session = agentSession(async () => {});
		const { settled, artifactsDir, commits } = await runInWorktree(
			id,
			session,
			onRelease => finalizeFinished(id, session, onRelease),
			{ mergeMode: "branch" },
		);
		const patchFiles = [path.join(artifactsDir, `${id}.patch`), ...(settled.nestedPatchPaths ?? [])];
		expect(patchFiles).toHaveLength(2);
		// Stands for what the run-end capture wrote: any write by the release replaces it.
		for (const file of patchFiles) await Bun.write(file, "as the run-end capture wrote it\n");

		await AgentLifecycleManager.global().release(id);

		for (const file of patchFiles) expect(await Bun.file(file).text()).toBe("as the run-end capture wrote it\n");
		expect(events).toEqual(["capture", "commit", "capture", "cleanup"]);
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
