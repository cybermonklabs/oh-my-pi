/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve the git root.
 *   2. {@link runIsolatedSubprocess}    — start worktree, capture its
 *                                        baseline, run, capture changes, and
 *                                        transfer cleanup ownership.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call; steps 2 and 3 are per-spawn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, postmortem, prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import { trackLateCleanup } from "../utils/late-cleanup";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import { needsNativeTeardown, writeRetainedBackend } from "./isolation-ownership";
import { releaseAfterRunEnd } from "./run-end-release";
import type { NestedRepoPatch, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	applyNestedPatches,
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	cleanupTaskBranches,
	type CommitToBranchResult,
	commitToBranch,
	type DeltaPatchResult,
	ensureIsolation,
	getRepoRoot,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

import { cfgTaskIsolationCommits } from "./settings";

type IsoBackendKind = natives.IsoBackendKind;

/** Which isolation outcome `isolation-summary.md` should describe. */
export type IsolationSummaryKind =
	| "captured"
	| "capture-error"
	| "nested-apply-failed"
	| "not-applied"
	| "branch-merge-failed"
	| "branch-capture-failed"
	| "merge-error";

/** Context for `isolation-summary.md`; unused fields are simply absent. */
export interface IsolationSummaryContext {
	kind: IsolationSummaryKind;
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths?: string[];
	error?: string;
	conflict?: string;
}

/**
 * Render one isolation outcome as the model-facing suffix appended to a task
 * result. Always starts with a blank line so it separates from the output it
 * follows.
 */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	return `\n\n${prompt.render(isolationSummaryTemplate, { ...context })}`;
}

/** Record artifact locations for `agent://` and mark the result as an isolated run. */
function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
	});
	return { ...result, isolated: true };
}

/**
 * Decide the fate of a half-built task branch after apply-back threw.
 *
 * Returns the branch name when it carries at least one commit past `baseSha`
 * — the caller must keep it, because the isolation worktree that also held
 * those objects is about to be torn down. Returns `undefined` after deleting
 * a branch that is absent, empty, or still pinned at the baseline, preserving
 * the original stale-branch cleanup for the cases where nothing is at stake.
 *
 * `revList.range` throws when the branch does not exist, which is the common
 * "commitToBranch failed before it created anything" path; that is treated as
 * "nothing to rescue" only after confirming the ref is absent. Other probe
 * failures preserve the branch because deleting it could lose the only reachable
 * copy of the agent's commits.
 */
async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	const repo = vcs.git(repoRoot);
	try {
		const carriedCommits = (await vcs.requireGit(repoRoot).revListRange(baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await repo?.refExists(`refs/heads/${branchName}`)) return branchName;
		} catch {
			// An inconclusive recovery probe must never risk deleting the only ref.
			return branchName;
		}
	}
	try {
		await repo?.deleteBranch(branchName, true);
	} catch {
		// Best-effort cleanup matches the old façade's tryDelete semantics.
	}
	return undefined;
}

/** Resolved repo shared by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
}

/**
 * Resolve the git repo root isolated spawns are copied from and merged back
 * into. Throws when the cwd is not inside a git repository; callers surface
 * the error as a task-tool failure. Each spawn captures its own baseline from
 * its isolation copy (see {@link captureIsolationBaseline}).
 */
export async function prepareIsolationContext(cwd: string): Promise<IsolationContext> {
	return { repoRoot: await getRepoRoot(cwd) };
}

/**
 * Fingerprint of a captured delta, used to skip rewriting the patch files and
 * re-committing an unchanged workspace on release.
 */
function deltaFingerprint(rootPatch: string, nestedPatches: readonly NestedRepoPatch[]): bigint | number {
	let key = rootPatch;
	for (const { relativePath, patch } of nestedPatches) key += `\0${relativePath}\0${patch}`;
	return Bun.hash(key);
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = cfgTaskIsolationCommits.get(session.settings);
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears prepared/path extension preloads and custom-tool paths
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. */
	context: IsolationContext;
	/** Materialises the run's workspace: {@link nativeWorkspace} or `ovnfsWorkspace` (`./ovnfs`). */
	openWorkspace: OpenWorkspace;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` and the nested patch files the run and its release write. */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
	/** Observe the real child result before post-run isolation work. */
	onSubprocessResult?: (result: SingleResult) => void;
}

/**
 * Write each nested-repo patch to `${artifactsDir}/${agentId}.nested-<n>-<path>.patch`
 * and return the paths. Throws on the first write failure: the caller must
 * then keep the isolation workspace alive, because it is the only other copy.
 * Every attempted destination is removed best-effort on failure — including
 * the in-progress file, which `Bun.write` may have created or truncated
 * before rejecting — so a half-written set cannot be mistaken for the
 * complete capture by the persisted-agent scanner.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			// Track before writing: a mid-write failure (ENOSPC, quota) can
			// leave a truncated file behind, and `force: true` makes removing
			// a never-created path a no-op.
			saved.push(destination);
			await Bun.write(destination, nestedPatch.patch);
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return saved;
}

interface IsolationPatchArtifacts {
	patchPath: string;
	hasRootChanges: boolean;
	nestedPatches: NestedRepoPatch[];
	nestedPatchPaths: string[];
}

/** An isolation delta as captured, before anything is written. */
interface IsolationDelta {
	delta: DeltaPatchResult;
	/** {@link deltaFingerprint} of {@link delta}. */
	fingerprint: bigint | number;
}

/** Capture the isolation delta without writing any of it. */
async function captureIsolationDelta(changes: RunChanges): Promise<IsolationDelta> {
	const delta = await changes.delta();
	return { delta, fingerprint: deltaFingerprint(delta.rootPatch, delta.nestedPatches) };
}

/** `${artifactsDir}/${agentId}.patch`: where an isolated run and its release write the root repo's patch. */
function rootPatchPath(artifactsDir: string, agentId: string): string {
	return path.join(artifactsDir, `${agentId}.patch`);
}

/**
 * Write every part of a captured delta to disk — the root patch and one file
 * per nested repo. Throws when any write fails so nothing captured is ever the
 * only copy.
 */
async function persistIsolationPatch(
	delta: DeltaPatchResult,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationPatchArtifacts> {
	const patchPath = rootPatchPath(artifactsDir, agentId);
	await Bun.write(patchPath, delta.rootPatch);
	const nestedPatchPaths = await persistNestedPatches(artifactsDir, agentId, delta.nestedPatches);
	return {
		patchPath,
		hasRootChanges: delta.rootPatch.trim().length > 0,
		nestedPatches: delta.nestedPatches,
		nestedPatchPaths,
	};
}

/** How an isolated run's changes are read: relative to the state its workspace opened in. */
interface RunChanges {
	/** Every change since the workspace opened. */
	delta(): Promise<DeltaPatchResult>;
	/** The baseline the workspace opened in, for branch commits. */
	baseline(): Promise<WorktreeBaseline>;
}

/**
 * Read `workspace`'s changes. A workspace that keeps its own starting state
 * ({@link IsolationWorkspace.start}) needs nothing taken now; any other gets
 * its baseline captured before the run begins.
 */
async function trackChanges(workspace: IsolationWorkspace, repoRoot: string): Promise<RunChanges> {
	const start = workspace.start;
	if (!start) {
		const baseline = await captureIsolationBaseline(workspace.dir, repoRoot);
		return {
			delta: () => captureDeltaPatch(workspace.dir, baseline),
			baseline: async () => baseline,
		};
	}
	let pending: Promise<WorktreeBaseline> | undefined;
	const baseline = (): Promise<WorktreeBaseline> => {
		const read =
			pending ??
			start.baseline().catch((err: unknown) => {
				pending = undefined;
				throw err;
			});
		pending = read;
		return read;
	};
	return {
		delta: async () => {
			const rootPatch = await start.rootPatch();
			if (rootPatch !== undefined) return { rootPatch, nestedPatches: [] };
			return captureDeltaPatch(workspace.dir, await baseline());
		},
		baseline,
	};
}

/**
 * Move a retained isolation workspace out of its deterministic
 * (`repoRoot` + agent id) slot into a globally unique sibling, so a later
 * isolated run with the same id cannot wipe it: `ensureIsolation`
 * unconditionally removes the deterministic base dir before writing its
 * owner marker. The owner marker, `m` mount, and backend sidecar move along,
 * so `omp worktree clear` still classifies and reclaims the workspace with
 * native teardown. Backends needing it (mounts, Btrfs subvolumes) record the
 * sidecar BEFORE the move so it travels atomically — a crash between rename
 * and a later write would leave a mounted workspace with a dead owner and
 * no metadata, and cleanup would traverse the live mount.
 */
export interface RetainedWorkspace {
	/** Workspace path to report (unique sibling on success, original dir when the move fails). */
	dir: string;
	/**
	 * False when cleanup metadata is missing that `clear` would need: the
	 * sidecar could not be written (plausible under the same disk pressure
	 * that forced retention). The error must then say the mount needs a
	 * manual unmount instead of advertising plain `worktree clear`.
	 */
	sidecarOk: boolean;
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend?: natives.IsoBackendKind,
): Promise<RetainedWorkspace> {
	const baseDir = path.dirname(isolationDir);
	const needsSidecar = backend !== undefined && needsNativeTeardown(backend);
	let sidecarOk = !needsSidecar;
	if (needsSidecar && backend !== undefined) {
		try {
			await writeRetainedBackend(baseDir, backend);
			sidecarOk = true;
		} catch {
			sidecarOk = false;
		}
	}
	const retainedBase = await vacateIsolationSlot(baseDir);
	return { dir: retainedBase ? path.join(retainedBase, path.basename(isolationDir)) : isolationDir, sidecarOk };
}

/**
 * Move a task-isolation base dir out of its deterministic slot into a unique
 * sibling and return the sibling, or `undefined` when the move keeps failing
 * (the workspace then stays where it is).
 */
export async function vacateIsolationSlot(baseDir: string): Promise<string | undefined> {
	const retainedBase = `${baseDir}.retained-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	// A valid move can still fail transiently (Windows AV/indexer locks);
	// retry briefly before conceding the deterministic slot.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rename(baseDir, retainedBase);
			return retainedBase;
		} catch {
			if (attempt < 2) await Bun.sleep(25);
		}
	}
	return undefined;
}

/**
 * The state a workspace opened in, kept by the workspace itself (an ovnfs
 * checkout's capture), so the runner need not take a baseline when it opens.
 */
export interface WorkspaceStart {
	/**
	 * The root repo's changes since the workspace opened, as `git diff --binary`
	 * writes them; `undefined` when only git can tell (they are then diffed
	 * against {@link baseline}).
	 */
	rootPatch(): Promise<string | undefined>;
	/** The baseline the workspace opened in, read from a copy of that state; for branch commits. */
	baseline(): Promise<WorktreeBaseline>;
}

/**
 * The checkout an isolated run works in, from materialisation to teardown:
 * a native copy or mount ({@link nativeWorkspace}) or an ovnfs checkout
 * (`ovnfsWorkspace` in `./ovnfs`). Capture and merge only see {@link dir}.
 */
export interface IsolationWorkspace {
	/** The checkout the subagent runs in. */
	readonly dir: string;
	/** Set when the workspace keeps the state it opened in; then no baseline is taken at start. */
	readonly start?: WorkspaceStart;
	/** Keep the workspace past the run (its changes could not be captured) and say where it stays. */
	retain(): Promise<RetainedWorkspace>;
	/** Tear the workspace down. */
	cleanup(): Promise<void>;
}

/** Opens the workspace of one isolated run in `repoRoot` for agent `agentId`. */
export type OpenWorkspace = (repoRoot: string, agentId: string) => Promise<IsolationWorkspace>;

/** Workspaces materialised by the natives PAL, `backend` a hint (`undefined` ⇒ the resolver picks). */
export function nativeWorkspace(backend: IsoBackendKind | undefined): OpenWorkspace {
	return async (repoRoot, agentId) => {
		const handle = await ensureIsolation(repoRoot, agentId, backend);
		return {
			dir: handle.mergedDir,
			retain: () => retainIsolationWorkspace(handle.mergedDir, handle.backend),
			cleanup: () => cleanupIsolation(handle),
		};
	};
}
/** Context for `isolation-error.md`: the `result.error` text for a run whose changes could not be captured or landed. */
interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	/** Set when the workspace was kept because its changes could not be written out. */
	retainedDir?: string;
	/**
	 * Set when the retained mount's unmount metadata is missing: cleanup
	 * cannot unmount before removal, so the message must direct a manual
	 * unmount instead of advertising plain `worktree clear`.
	 */
	sidecarMissing?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches` (+ `nestedPatchPaths`). It also
 * writes the committed root diff to `${artifactsDir}/${agentId}.patch` and
 * names it in the agent's registry history (`patchPath`), as a record for the
 * Agent Hub; the result does not name it. On commit
 * failure the still-live isolation diff is written to
 * `${artifactsDir}/${agentId}.patch`, the task branch is kept when it already
 * carries commits (deleted otherwise), and `result.error` carries the
 * merge-failure message plus recovery hint.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` plus one
 * `${agentId}.nested-<n>-<path>.patch` per nested repo and returns
 * `patchPath` + `nestedPatches` + `nestedPatchPaths`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * Kept-alive runs retain the isolation handle through idle/parked lifecycle
 * transitions, then capture final changes and clean up on release. A release
 * that comes while the run is still ending (a refused adoption, a release as
 * the run finishes) waits for the run-end capture, so it never removes the
 * worktree that capture reads. A release that took the agent's adoption
 * before the run's end calls the hook only once it has disposed the agent's
 * session, and the run's end leaves the cleanup to it. A run's end that found
 * no release asked for and no adoption takes the cleanup over: at once when no
 * release is in flight, else once none is left, if none of them called the
 * hook. A release called after that captures nothing. A release also waits for
 * the cleanup the run deferred (owner jobs, shutdown hooks), which may still
 * write the worktree. A failed run's end does not wait for it, so a release
 * asked for before that end, which waits for it, goes on after the result; so
 * does a release still in flight as any run ends. The caller's deferred
 * cleanup waits for either ({@link ExecutorOptions.onCleanupDeferred}).
 * One-shot and failed startup paths clean up in `finally`. If captured
 * changes cannot be written to disk, the workspace is retained under a unique
 * `.retained-*` sibling and its path is named in the resulting error.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let changes: RunChanges | undefined;
	/** Fingerprint of the delta handed to the caller at run end; a release writes and commits only a changed delta. */
	let handedOff: bigint | number | undefined;
	let workspace: IsolationWorkspace | undefined;
	/** Owner jobs or shutdown hooks still going on after the run (`onCleanupDeferred`), which may write the worktree. */
	let deferredCleanup: Promise<void> | undefined;
	/** Set once the run's end has waited for {@link deferredCleanup}; a failed run's end goes on without it. */
	let deferredCleanupAwaited = false;
	let retainWorkspace = false;
	let baseReleasePromise: Promise<void> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	/**
	 * The cleanup the run's end took over, having found no release asked for and no adoption, and no release in flight
	 * or none that called the hook.
	 */
	let runEndCleanup: Promise<void> | undefined;
	/** The run's IRC wake hold, released only once the run-end capture is done. */
	let releaseIrcWakes: (() => void) | undefined;
	const releaseBase = (): Promise<void> => {
		baseReleasePromise ??= opts.baseOptions.onRelease?.() ?? Promise.resolve();
		return baseReleasePromise;
	};
	const cleanupHandle = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			await releaseBase();
			if (workspace && !retainWorkspace) await workspace.cleanup();
		})();
		return cleanupPromise;
	};
	/** The run's end takes the cleanup over ({@link runEndCleanup}), after the cleanup the run deferred. */
	const takeCleanupOver = (): Promise<void> => {
		runEndCleanup = deferredCleanup ? deferredCleanup.then(cleanupHandle) : cleanupHandle();
		return runEndCleanup;
	};
	/**
	 * Capture the run's delta and write all of it to disk for the caller, which then holds it ({@link handedOff}).
	 * Throws when a write fails ({@link persistIsolationPatch}).
	 */
	const handOffPatch = async (runChanges: RunChanges): Promise<IsolationPatchArtifacts> => {
		const captured = await captureIsolationDelta(runChanges);
		const artifacts = await persistIsolationPatch(captured.delta, opts.artifactsDir, opts.agentId);
		handedOff = captured.fingerprint;
		return artifacts;
	};
	/** A kept-alive run's final capture and cleanup, held until the run-end capture below is done with the worktree. */
	const isolationRelease = releaseAfterRunEnd(
		async () => {
			// Asked for after the run's end took the cleanup over: nothing is left to capture, only that cleanup to wait for.
			if (runEndCleanup) return runEndCleanup;
			// Owner jobs or shutdown hooks the run left going on may still write the worktree.
			if (deferredCleanup) await deferredCleanup;
			if (!workspace || !changes || retainWorkspace) {
				await cleanupHandle();
				return;
			}
			try {
				let captured: IsolationDelta;
				let patchResult: IsolationPatchArtifacts;
				try {
					captured = await captureIsolationDelta(changes);
					// Unchanged since the run's end: the caller already holds this
					// delta (its patch files and, in branch mode, its task branch, or
					// the error that names them), so the release writes and commits
					// nothing.
					if (captured.fingerprint === handedOff) return;
					patchResult = await persistIsolationPatch(captured.delta, opts.artifactsDir, opts.agentId);
				} catch (captureErr) {
					retainWorkspace = true;
					const retained = await workspace.retain();
					throw new Error(
						renderIsolationError({
							kind: "patch-capture-failed",
							message: captureErr instanceof Error ? captureErr.message : String(captureErr),
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					);
				}
				AgentRegistry.global().setHistory(opts.agentId, {
					patchPath: patchResult.patchPath,
					nestedPatchPaths: patchResult.nestedPatchPaths,
				});
				const commitResult = await commitToBranch(
					workspace.dir,
					await changes.baseline(),
					opts.agentId,
					opts.description,
					undefined,
					captured.delta,
				);
				AgentRegistry.global().setHistory(opts.agentId, {
					patchPath: patchResult.patchPath,
					branchName: commitResult?.branchName,
					nestedPatchPaths: patchResult.nestedPatchPaths,
				});
			} finally {
				await cleanupHandle();
			}
		},
		releasing => {
			// Session teardown has only a short grace period. Once the session has
			// stopped, let a signal exit wait for the final capture and backend stop
			// rather than abandoning a large sandbox when that grace period expires.
			const unregister = postmortem.register(`isolation-release:${opts.agentId}`, () => releasing, {
				exitOnly: true,
				deadlineMs: 120_000,
				waitMessage: "Finishing isolated task cleanup",
			});
			void releasing.then(unregister, unregister);
		},
	);
	try {
		workspace = await opts.openWorkspace(opts.context.repoRoot, opts.agentId);
		const isolationDir = workspace.dir;
		const runChanges = await trackChanges(workspace, opts.context.repoRoot);
		changes = runChanges;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
			// One-shot runs get `releaseBase` (never touches the worktree): their
			// `finalizeSubagentLifecycle` calls `onRelease` before this function's
			// post-run capture, so the handle must survive until the `finally`
			// below cleans it up. Only kept-alive runs hand full capture+cleanup to
			// the agent lifecycle, which may also ask for it before that capture:
			// `isolationRelease` then holds it until the `finally`.
			onRelease: opts.baseOptions.keepAlive === false ? releaseBase : isolationRelease.onRelease,
			deferIrcWakeRelease: release => {
				releaseIrcWakes = release;
			},
		});
		opts.onSubprocessResult?.(result);
		// A successful result cannot be captured while deferred owner jobs or
		// shutdown hooks may still write the worktree. Failed runs skip capture,
		// so their cleanup remains asynchronous.
		if (deferredCleanup && result.exitCode === 0) {
			await deferredCleanup;
			deferredCleanupAwaited = true;
		}
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			let commitResult: CommitToBranchResult | null;
			let baseline: WorktreeBaseline | undefined;
			try {
				baseline = await runChanges.baseline();
				commitResult = await commitToBranch(
					isolationDir,
					baseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
					await runChanges.delta(),
				);
			} catch (mergeErr) {
				// Agent succeeded but the branch commit failed. `commitToBranch`
				// is not atomic: the clean-baseline path fetches the agent's
				// commits into the parent ODB and creates `omp/task/<id>` before
				// it commits the leftover working-tree delta, so a throw from
				// that trailing step leaves behind a branch that already holds
				// every commit the agent made. The isolation worktree — the only
				// other copy of those objects — is destroyed by the `finally`
				// below, so deleting the branch unconditionally turned a
				// recoverable merge conflict into permanent loss of committed
				// work (#8868). Delete only when nothing is at stake. Without a
				// baseline no branch was started.
				const branchName = `omp/task/${opts.agentId}`;
				const rescueBranch = baseline
					? await rescueTaskBranch(opts.context.repoRoot, branchName, baseline.root.headCommit)
					: undefined;
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const artifacts = await handOffPatch(runChanges);
					return rememberAgentArtifacts({
						...result,
						...artifacts,
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					});
				} catch (patchErr) {
					retainWorkspace = true;
					const retained = await workspace.retain();
					return rememberAgentArtifacts({
						...result,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					});
				}
			}
			handedOff = deltaFingerprint(commitResult?.rootPatch ?? "", commitResult?.nestedPatches ?? []);
			// The task branch holds the root-repo work; its diff in `<id>.patch`
			// is only the agent's record (the Agent Hub's patch, a later scan of
			// the artifacts), as every successful end writes one. The result
			// does not name it, so the merge reads the branch alone, and a record
			// that cannot be written loses no work.
			const patchPath = rootPatchPath(opts.artifactsDir, opts.agentId);
			try {
				await Bun.write(patchPath, commitResult?.rootPatch ?? "");
				AgentRegistry.global().setHistory(opts.agentId, { patchPath });
			} catch (patchErr) {
				await fs.rm(patchPath, { force: true }).catch(() => undefined);
				logger.warn("Isolated task root patch could not be written", {
					agentId: opts.agentId,
					error: patchErr instanceof Error ? patchErr.message : String(patchErr),
				});
			}
			// Nested-repo patches exist only in memory until written; the
			// workspace goes away in `finally`.
			try {
				const nestedPatchPaths = await persistNestedPatches(
					opts.artifactsDir,
					opts.agentId,
					commitResult?.nestedPatches ?? [],
				);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					nestedPatchPaths,
				});
			} catch (persistErr) {
				retainWorkspace = true;
				const retained = await workspace.retain();
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					error: renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		if (result.exitCode === 0) {
			try {
				const artifacts = await handOffPatch(runChanges);
				return rememberAgentArtifacts({ ...result, ...artifacts });
			} catch (patchErr) {
				retainWorkspace = true;
				const retained = await workspace.retain();
				return rememberAgentArtifacts({
					...result,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: patchErr instanceof Error ? patchErr.message : String(patchErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		return rememberAgentArtifacts(result);
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		// The run-end capture is done with the worktree. A release asked for
		// before now captures and cleans up from here, and owns the cleanup; the
		// caller gets the result once that is over, unless the release waits for
		// a deferred cleanup this run's end went on without (a failed run's):
		// it then goes on as late cleanup, as the cleanup below does, and the
		// caller's deferred cleanup (the removal of the artifacts directory the
		// release writes to) waits for it. The caller keeps the last completion
		// it is handed, and this one ends only after the earlier one, which the
		// release waits for first.
		const keptAlive = opts.baseOptions.keepAlive !== false;
		const lifecycle = AgentLifecycleManager.global();
		const released = isolationRelease.end();
		if (released && deferredCleanup && !deferredCleanupAwaited) {
			trackLateCleanup(released, { agentId: opts.agentId, resource: "isolation" });
			opts.baseOptions.onCleanupDeferred?.(released.catch(() => undefined));
		} else if (released) {
			await released.catch(error => {
				logger.warn("Isolated task release failed", {
					agentId: opts.agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		} else if (!workspace || retainWorkspace || (keptAlive && lifecycle.has(opts.agentId))) {
			// Nothing is left to clean up here, or an adoption holds the agent:
			// its release captures and cleans up. Read before `isReleasing`: a
			// release that starts between the two reads (on a worker each is a
			// round trip to the main thread) marks the agent releasing before it
			// drops the adoption, and cannot end before the second read, since
			// it calls the hook, which needs this thread, before it ends.
		} else if (keptAlive && lifecycle.isReleasing(opts.agentId)) {
			// A release of the agent is in flight, and nothing called the hook
			// yet. One that took the agent's adoption calls it once it has
			// disposed the agent's session, and captures and cleans up then,
			// after the cleanup this run deferred; one that took none calls no
			// hook. Once no release is left (on a worker, a hook call made before
			// then reaches this thread first), the completion is the release the
			// hook started, or, when nothing called the hook, the cleanup this
			// run's end takes over then. It goes on after the result, and the
			// caller's deferred cleanup (the removal of the artifacts directory
			// the release writes to) waits for it; this completion ends after
			// the earlier one, which the release or that cleanup waits for first.
			const completion = lifecycle
				.whenReleased(opts.agentId)
				.then(() => isolationRelease.settled ?? takeCleanupOver());
			trackLateCleanup(completion, { agentId: opts.agentId, resource: "isolation" });
			opts.baseOptions.onCleanupDeferred?.(completion.catch(() => undefined));
		} else {
			// No release was asked for or is in flight, and no adoption holds
			// the agent: this run's end takes the cleanup over, which a release
			// called later only waits for.
			const cleanup = takeCleanupOver();
			if (deferredCleanup) trackLateCleanup(cleanup, { agentId: opts.agentId, resource: "isolation" });
			else await cleanup;
		}
		// The run's end is done with the worktree: a held peer message may now wake a turn in it.
		if (releaseIrcWakes && opts.baseOptions.deferIrcWakeRelease)
			opts.baseOptions.deferIrcWakeRelease(releaseIrcWakes);
		else releaseIrcWakes?.();
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo: patch apply (patch mode) or cherry-pick + cleanup (branch mode).
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	const repo = vcs.requireGit(repoRoot);
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				return {
					summary: renderIsolationSummary({
						kind: "branch-capture-failed",
						error: result.error,
						rootPatchPath: result.patchPath,
						nestedPatchPaths: result.nestedPatchPaths,
					}),
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				// The nested patches are skipped when the branch did not merge; name
				// their files so the parent can recover them alongside the branch.
				summary = renderIsolationSummary({
					kind: "branch-merge-failed",
					branchName: result.branchName,
					conflict: mergeResult.conflict,
					nestedPatchPaths: result.nestedPatchPaths,
				});
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
					repo.canApplyPatch(normalized, {}).catch(() => false),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await repo.applyPatch(normalized, {});
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			// Nested apply is skipped when the root patch did not apply; the
			// persisted nested patches are the parent's only pointer to that work.
			summary = renderIsolationSummary({
				kind: "not-applied",
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			});
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		return {
			summary: renderIsolationSummary({
				kind: "merge-error",
				error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
				branchName: result.branchName,
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			}),
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

/**
 * Apply nested-repo patches after the parent merge phase. Centralizes the
 * three-way gate (exitCode/aborted, patch-mode failed parent, branch-mode
 * branch-merged) and the non-fatal failure handling so `TaskTool` and the
 * eval `agent()` bridge use one implementation.
 *
 * Returns a system-notification suffix to append to the parent merge summary,
 * or an empty string when nothing was applied or the nested apply succeeded.
 */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch (applyErr) {
		// Nested patch failures are non-fatal to the parent merge, but the patch
		// files are the only surviving copy of that work — name them.
		return renderIsolationSummary({
			kind: "nested-apply-failed",
			error: applyErr instanceof Error ? applyErr.message : String(applyErr),
			nestedPatchPaths: result.nestedPatchPaths,
		});
	}
}
