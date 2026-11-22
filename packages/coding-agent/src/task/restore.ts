/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn, or whose turn ended because its provider key could
 * not be resolved ({@link hasRestorableTurn}), was not killed (no tombstone), has no
 * subagent above it that was killed or stopped, nor one parked at a terminal `yield` that
 * restore does not go on with (see {@link restoreSubagents}), belongs
 * to its parent's current conversation (not to work a `/clear` or a move to another
 * branch left behind, {@link SpawnRecords}) and can be revived (a `session_init`
 * contract, not isolated) runs one
 * more monitored turn as a background job of its parent: the lifecycle reviver
 * rebuilds it from its transcript, {@link runSubagentFollowUpTurn} goes on with the
 * cut-off turn and drives it to `yield`, and the parent receives the result as the
 * ordinary `async-result` of a job with the subagent's id, the id its first run's
 * job had, so a parent waiting on that job finds it again. A turn that ended because
 * its key could not be resolved handed its parent the failure at once: it goes on only
 * on a record that its parent still waits on that turn ({@link SpawnRecords.parentStillWaits}).
 * A parent that holds the failure acts on it, and a missing record proves nothing: a parent can
 * background a cell, leave a branch, or take a result through another tool.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger, stringProperty } from "@oh-my-pi/pi-utils";
import { isTaskToolDetails, taskCardAgentIds } from "@oh-my-pi/pi-tui/tools/task";
import { AsyncJobError } from "../async";
import { readEvalAgentJobRecord } from "../eval/agent-job-records";
import { EVAL_STATE_CONTEXT_TYPE } from "../eval/state";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { persistedVibeChildIds } from "../vibe/lifecycle";
import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import {
	conversationTail,
	endsOnCredentialUnavailableTurn,
	hasRestorableTurn,
	isInterruptedTurnAbort,
	isRestoreSkippedCallResult,
	type RestoreSkippedCalls,
} from "../session/exit-diagnostics";
import { isReasonlessAbort, isUserInterruptAbort } from "../session/messages";
import { activeBranch, type SessionEntry } from "../session/session-entries";
import { extractSessionInit, type SessionManager } from "../session/session-manager";
import { collectSubSessions, type SubSession } from "../session/sub-sessions";
import { RETRY_CANCELLED } from "../session/turn-recovery";
import type { EventBus } from "../utils/event-bus";
import { yieldEndsRun } from "../tools/yield";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import { persistedAgentDefinition, persistedAgentName } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";
import { readDiscardedLaunch } from "./speculative-launch";

/** Where restored subagents' lifecycle and progress frames go, as a live run's do. */
export interface RestoreOptions {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/** What `omp --restore` went on with. */
export interface RestoreOutcome {
	/** The session's own interrupted turn goes on. */
	turn: boolean;
	/** Ids of the subagents that go on with theirs, parents before their children. */
	subagents: string[];
}

/**
 * Has `session` go on with what its last process left unfinished: its subagents'
 * interrupted turns, each as a background job of its parent (registered first, so
 * a resumed turn waiting on such a job finds it), then its own interrupted turn. A
 * resumed turn does not run again a cut-off call that started a subagent restore
 * relaunched, now or at an earlier restore ({@link relaunchedByCutOffCall}).
 */
export async function restoreSession(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	const { ids, skippedByCall } = await restoreSubagents(session, options);
	const turn = await session.restoreInterruptedTurn(skippedByCall);
	return { turn, subagents: ids };
}

/** A subagent `--restore` goes on with, and what its job needs. */
interface Relaunch {
	key: string;
	sub: SubSession;
	ref: AgentRef & { sessionFile: string };
	init: NonNullable<ReturnType<typeof extractSessionInit>>;
}

/**
 * Has every subagent of `session` that its last process left mid-turn go on with that
 * turn (see the module docs). Nothing is restored for a session without a file, or
 * without background jobs (the `async.enabled` setting off), which could not deliver
 * the results. Returns the relaunched ids, and for `session`'s own cut-off batch the
 * calls not to run again ({@link relaunchedByCutOffCall}).
 */
async function restoreSubagents(
	session: AgentSession,
	options: RestoreOptions,
): Promise<{ ids: string[]; skippedByCall: RestoreSkippedCalls }> {
	const sessionFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	if (!sessionFile || !manager) return { ids: [], skippedByCall: { relaunched: {} } };
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const subSessions = await collectSubSessions(sessionFile, {
		onUnreadable: key => logger.warn("Subagent transcript unreadable; not restored", { key }),
	});
	// Parents first: a child's result is delivered to its parent's session.
	const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
	const spawns = new SpawnRecords(session.sessionManager, subSessions);
	// Vibe mode keeps its workers: their lifecycle records claim them, and interactive mode rehydrates them as
	// subagent refs before `--restore` runs, so the persisted roster's own vibe check cannot tell them apart.
	const vibeWorkers = persistedVibeChildIds(session.sessionManager.getEntries());
	/**
	 * Per sub-session key, the nearest subagent at or above it that was killed (its tombstone,
	 * `SubSession.aborted`) or whose last turn a stop ended ({@link endsOnStop}); no entry when
	 * none was. The loop below fills it for every key before it skips any, a parent before its
	 * children. The jobs a subagent owns (its eval `agent()` handles, its workpool batches) end
	 * with it: a kill or a stop of its run stops their subagents, so `--restore` leaves them,
	 * even one that a cancel giving no reason cut off, which keeps its turn on its marked
	 * attempt; nor does `--restore` relaunch such an ancestor, which would receive their
	 * results. The session itself is no such ancestor: its own stop leaves its background jobs
	 * running. A process exit leaves neither mark (it writes the interrupted-turn record, or the
	 * abort without a reason, which a stop can write too), so the subagents of a chain it cut
	 * off go on. A subagent whose transcript was not collected has no entry, so it judges
	 * nothing above it.
	 */
	const stoppedAtOrAbove = new Map<string, SubSession>();
	/**
	 * The sub-session keys below a subagent whose run a terminal `yield` ended (over, or parked there
	 * on async work it had pending) when restore does not go on with that run ({@link isParkedRun}).
	 * Nothing takes the results of the work it owns: a relaunched subagent under it would deliver to
	 * a session nobody revives, so restore leaves it, also one its parent's `owed` record names or
	 * one an ordinary request failure cut off.
	 */
	const underParked = new Set<string>();
	const relaunches: Relaunch[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		// The selected branch, as the subagent's own session reopens it: entries on other branches
		// (an abandoned turn, a `/clear` that was rolled back) are not its conversation.
		const branch = activeBranch(sub.entries, sub.leafId);
		const stopped = sub.parent === null ? undefined : stoppedAtOrAbove.get(sub.parent);
		const atOrAbove = sub.aborted || endsOnStop(branch) ? sub : stopped;
		if (atOrAbove) stoppedAtOrAbove.set(key, atOrAbove);
		const parent = sub.parent === null ? undefined : subSessions[sub.parent];
		const parked =
			sub.parent !== null &&
			(underParked.has(sub.parent) ||
				(parent !== undefined && isParkedRun(activeBranch(parent.entries, parent.leafId))));
		if (parked) underParked.add(key);
		if (sub.aborted || !hasRestorableTurn(branch)) continue;
		const id = sub.agentId;
		if (stopped) {
			logger.debug("Interrupted subagent is under a subagent that was killed or stopped; not restored", {
				id,
				ancestor: stopped.agentId,
			});
			continue;
		}
		if (parked) {
			logger.debug("Interrupted subagent is under a parked subagent restore leaves; not restored", { id });
			continue;
		}
		// A `/clear` or a move to another branch leaves the parent's earlier work behind: that work's
		// subagents are not the new conversation's, whose parent would get a result for a job it never started.
		if (!spawns.inCurrentConversation(sub)) {
			logger.debug("Interrupted subagent belongs to work its parent left; not restored", { id });
			continue;
		}
		if (endsOnCredentialUnavailableTurn(branch)) {
			// A turn its key ended stays restorable after a normal exit, so it is relaunched only while it is still
			// the parent's work: not a vibe worker of the root session (vibe mode keeps it, and its director decides
			// its next turn), and only while the parent records that it still waits on it.
			if (sub.parent === null && vibeWorkers.has(id)) {
				logger.debug("Key-stranded subagent is a vibe worker, which vibe mode keeps; not restored", { id });
				continue;
			}
			if (!spawns.parentStillWaits(sub, lastTurnStartedAt(branch))) {
				logger.debug("Key-stranded subagent has no positive parent wait record; not restored", { id });
				continue;
			}
		} else if (spawns.discardedByParent(sub)) {
			// Its parent's current conversation records the spawn as discarded (a launch the task call did not
			// adopt, a worker of a pool that was stopped), though its transcript reads as cut off: a whole-session
			// fork copies a running worker's transcript mid-run, and the stop that follows ends it in the original.
			logger.debug("Interrupted subagent's spawn was discarded by its parent; not restored", { id });
			continue;
		}
		const ref = registry.get(id);
		const init = extractSessionInit(sub.entries);
		if (!ref?.sessionFile || ref.kind !== "sub" || !init || init.isolated) {
			logger.debug("Interrupted subagent cannot be revived; not restored", { id });
			continue;
		}
		relaunches.push({ key, sub, ref: { ...ref, sessionFile: ref.sessionFile }, init });
	}
	// Each parent's resumed turn learns which of its cut-off calls started subagents before any relaunch
	// starts, so a relaunched parent does not run such a call again either: the relaunched subagents, and
	// the parent's other subagents for a call an earlier restore already did not run again.
	const relaunchedKeys = new Set(relaunches.map(({ key }) => key));
	const childrenOf = new Map<string | null, { relaunched: SpawnedChild[]; others: SpawnedChild[] }>();
	for (const key of keys) {
		const sub = subSessions[key]!;
		const children = childrenOf.get(sub.parent) ?? { relaunched: [], others: [] };
		const child = { agentId: sub.agentId, spawnCallIds: spawns.callsOf(sub) };
		(relaunchedKeys.has(key) ? children.relaunched : children.others).push(child);
		childrenOf.set(sub.parent, children);
	}
	const skippedByCallOf = (parentKey: string | null): RestoreSkippedCalls => {
		const children = childrenOf.get(parentKey);
		if (!children) return { relaunched: {} };
		const parent = parentKey === null ? undefined : subSessions[parentKey];
		const branch = parent
			? activeBranch(parent.entries, parent.leafId)
			: activeBranch(session.sessionManager.getEntries(), session.sessionManager.getLeafId());
		return relaunchedByCutOffCall(branch, children.relaunched, children.others);
	};
	for (const { key, sub, ref, init } of relaunches) {
		const id = sub.agentId;
		const sessionFileOfRef = ref.sessionFile;
		const agentName = persistedAgentName(ref.displayName, init);
		const structured = init.tools.includes("yield");
		const restoreSkipped = skippedByCallOf(key);
		manager.register(
			"task",
			id,
			async ({ signal }) => {
				const result = await runSubagentFollowUpTurn({
					id,
					agent: persistedAgentDefinition(ref.displayName, init),
					message: init.task,
					restore: true,
					restoreSkipped,
					structured,
					workPoolYieldItems: init.workPoolYieldItems,
					outputSchema: init.outputSchema,
					outputSchemaMode: init.outputSchemaMode,
					signal,
					eventBus: options.eventBus,
					subagentEventBus: options.subagentEventBus,
					artifactsDir: path.dirname(sessionFileOfRef),
					maxRuntimeMs: cfgTaskMaxRuntimeMs.get(session.settings),
					...softRequestBudgetFor(agentName, session.settings),
				});
				const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
				const structuredOutput = result.structuredOutput;
				if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
					throw new AsyncJobError(text, structuredOutput);
				}
				return structuredOutput ? { text, structured: structuredOutput } : text;
			},
			{ id, agentId: id, ownerId: ref.parentId },
		);
	}
	const ids = relaunches.map(({ sub }) => sub.agentId);
	if (ids.length > 0) logger.info("Restored interrupted subagents", { ids });
	return { ids, skippedByCall: skippedByCallOf(null) };
}

/** A subagent of a parent's transcript, and the calls of the parent its current run was requested under ({@link SpawnRecords.callsOf}). */
interface SpawnedChild {
	agentId: string;
	spawnCallIds: readonly string[];
}

/**
 * The calls of a parent's cut-off batch that `--restore` does not run again, each with the
 * subagents it started. The batch is the last reply with tool calls on the parent's current
 * conversation (`branch` selected, after its last `/clear`). A call started each subagent whose
 * current run was requested under it ({@link SpawnRecords.callsOf}): the call its `session_init`
 * names (`spawnCallId`: a `task` call, also for a streamed launch made before its
 * `tool_execution_start`, or the `eval` call whose cell spawned it with a bridged `tool.task`, an
 * `agent()` job or a work pool), or, for a kept-alive work pool worker's later batch, the calls
 * that pushed that batch's items, which its latest `owed` record names. Such a call is
 * not run again:
 * - when restore relaunches a subagent it started (`relaunched`);
 * - when an earlier restore did not run it again, which its result on `branch` says
 *   ({@link isRestoreSkippedCallResult}): the subagents it started that restore does not
 *   relaunch now (`others`, which ran since that restore) go in `ran`, so a call whose
 *   relaunched subagent finished before the next process end still does not start it again.
 * A subagent another call or a job of an earlier turn started is no call's of the batch, nor is
 * one whose transcript names no call (an older version wrote it): the batch's calls run again,
 * and so does a call whose subagents an earlier restore relaunched under such a transcript.
 * The record is the spawn's own, so a second restore inside the resumed batch reads the same
 * call for a subagent it relaunches again.
 */
export function relaunchedByCutOffCall(
	branch: readonly SessionEntry[],
	relaunched: readonly SpawnedChild[],
	others: readonly SpawnedChild[] = [],
): RestoreSkippedCalls {
	let start = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index]!.type === "reset_boundary") {
			start = index + 1;
			break;
		}
	}
	let batchIndex = -1;
	for (let index = branch.length - 1; index >= start; index--) {
		const entry = branch[index]!;
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(part => part.type === "toolCall")
		) {
			batchIndex = index;
			break;
		}
	}
	const batch = branch[batchIndex];
	if (batch?.type !== "message" || batch.message.role !== "assistant") return { relaunched: {} };
	const callIds = new Set<string>();
	for (const part of batch.message.content) if (part.type === "toolCall") callIds.add(part.id);
	const byCall: Record<string, string[]> = {};
	for (const { agentId, spawnCallIds } of relaunched) {
		for (const call of spawnCallIds) if (callIds.has(call)) (byCall[call] ??= []).push(agentId);
	}
	const skippedBefore = new Set<string>();
	for (const entry of branch.slice(batchIndex + 1)) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (callIds.has(entry.message.toolCallId) && isRestoreSkippedCallResult(entry.message)) {
			skippedBefore.add(entry.message.toolCallId);
		}
	}
	const ran: Record<string, string[]> = {};
	for (const { agentId, spawnCallIds } of others) {
		for (const call of spawnCallIds) if (skippedBefore.has(call)) (ran[call] ??= []).push(agentId);
	}
	return Object.keys(ran).length > 0 ? { relaunched: byCall, ran } : { relaunched: byCall };
}

/**
 * Whether the branch's last turn, after its last `/clear`, ended at a terminal `yield`
 * ({@link yieldEndsRun}) and is not restorable ({@link hasRestorableTurn}): the run is over or
 * parked on async work it had pending, and restore does not go on with it.
 */
function isParkedRun(branch: readonly SessionEntry[]): boolean {
	if (hasRestorableTurn(branch)) return false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "reset_boundary" || isTurnInput(entry)) return false;
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "toolResult") {
			if (message.toolName === "yield" && !message.isError && yieldEndsRun(message.details)) return true;
			continue;
		}
		// The executor's abort that stops a parked run, or a process exit, follows its `yield`.
		if (message.role === "assistant" && !isProcessExitRecord(message)) return false;
	}
	return false;
}

/**
 * Whether the branch's last message, after its last `/clear`, is a record only a stop
 * writes: the user's interrupt ({@link isUserInterruptAbort}), or the record that ends a
 * turn whose retry was stopped ({@link RETRY_CANCELLED}, which carries no other mark).
 */
function endsOnStop(branch: readonly SessionEntry[]): boolean {
	const message = conversationTail(branch)?.message;
	return (
		message?.role === "assistant" &&
		message.stopReason === "aborted" &&
		(isUserInterruptAbort(message) || message.errorMessage === RETRY_CANCELLED)
	);
}

/**
 * What a parent transcript records of the subagents it spawned and of their results. Its
 * current conversation is its active branch after its last `/clear` (`reset_boundary`).
 */
interface SpawnedSubagents {
	/** Those its `task` results in the current conversation name, settled or not (a background spawn's "started" result names it only in its progress). */
	current: Set<string>;
	/** Those any record of the current conversation names ({@link recordedAgentIds}). */
	inConversation: Set<string>;
	/** Those any record names, on any branch, before or after the last `/clear`. */
	named: Set<string>;
	/**
	 * Spawns the parent discarded, each with when its discard record was written (epoch ms): a
	 * streamed launch nobody adopted, and each worker of a work pool the parent stopped (a kill, the
	 * user's stop), whose failed batch the stop cannot cancel. The ids whose latest record of any
	 * kind on the selected branch, read from the leaf back, is a discard record
	 * ({@link readDiscardedLaunch}). A record that names the id after the discard (a later spawn's
	 * job record, a result) is a later spawn of a reused id. Never the parent's work, but only for a
	 * subagent whose transcript began by the discard: a later process can allocate the id of a
	 * launch discarded before it wrote a transcript again, and that spawn may have written no
	 * record yet.
	 */
	discardedAt: Map<string, number>;
	/**
	 * Those whose result the current conversation holds ({@link heldResults}) or whose eval job
	 * has a `delivered` record, each with when its latest handover happened, in epoch ms
	 * ({@link settle}). `delivered` is written before the result reaches the cell, so a process
	 * that went away between the two leaves it.
	 */
	settled: Map<string, number>;
	/**
	 * The handovers the parent's transcript holds on the branches a tool replay left
	 * ({@link replayLeftEntryIds}), as `settled` reads them, but a run handed over only as aborted
	 * (or lost with its worker) settles nothing here: the parent took no turn on that branch's
	 * result. Read only for a subagent placed by the call its spawn record names
	 * ({@link spawnedInCurrentConversation}): a restored turn that runs its cut-off calls again
	 * leaves their first results, and the handovers they held, on a branch of their own, and a parent
	 * that got the subagent's failure there acts on it. A branch a person left by their own
	 * navigation is not read: the conversation they went on with never got those results.
	 */
	settledElsewhere: Map<string, number>;
	/** Eval jobs (an `agent()` job, a bridged `tool.task` background spawn) whose latest record in the current conversation is `owed`: a result still owed to the parent. */
	owedJobs: Set<string>;
	/**
	 * The calls each subagent's latest `owed` record that names any calls names, on any branch: a
	 * kept-alive work pool worker's later batch, whose items later calls pushed.
	 */
	owedCalls: Map<string, string[]>;
	/** When that last `/clear` was written, in epoch ms; undefined without one. */
	clearedAt: number | undefined;
	/**
	 * The ids of the tool calls the replies of the current conversation made (the selected branch,
	 * after the last `/clear`), and of those every saved reply made, on any branch: a subagent whose
	 * spawn record names a call of the first is that conversation's, and of the second only, work the
	 * parent left.
	 */
	conversationCalls: Set<string>;
	savedCalls: Set<string>;
	/** The windows of the calls the parent's process ended inside ({@link cutOffWindows}). */
	cutOffWindows: CutOffWindow[];
}

/**
 * Records in `settled` that subagent `id`'s result was handed over at `at` (epoch ms), keeping
 * its latest handover: the one that settles the turn before it. An unreadable time is kept only
 * while nothing else is known; it then judges nothing, and the result stands.
 */
function settle(settled: Map<string, number>, id: string, at: number): void {
	const prior = settled.get(id);
	if (prior === undefined || (Number.isFinite(at) && !(prior >= at))) settled.set(id, at);
}

/**
 * When (epoch ms) a call the parent's process ended inside started, and when its turn ended
 * (`Infinity`: it never did). A finished call's own spawns are not this window's (`excluded`):
 * a subagent whose `session_init` names the call it was spawned under is left out when that call
 * is one of `calls`; one whose transcript names no call (an older version wrote it), when its
 * transcript began inside one of `spans`, those calls' runs.
 */
interface CutOffWindow {
	startedAt: number;
	endedAt: number;
	excluded?: {
		calls: ReadonlySet<string>;
		spans: ReadonlyArray<{ startedAt: number; endedAt: number }>;
	};
}

/**
 * The subagent ids a parent's transcript entry names: a `task` result's (its settled results and
 * its spawns' progress), the ones an `eval` result's `agentResults`, a job delivery, a `wait` or a
 * kill hands it, and an eval job record's.
 */
function recordedAgentIds(entry: SessionEntry): string[] {
	const job = readEvalAgentJobRecord(entry);
	return [
		...taskResultAgentIds(entry),
		...heldResults(entry, true).map(held => held.id),
		...(job ? [job.agentId] : []),
	];
}

/** The subagent ids a persisted `task` tool result names: its settled results and its spawns' progress. */
function taskResultAgentIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") return [];
	return taskCardAgentIds(entry.message.details);
}

/** A subagent whose result a parent's transcript entry hands it, and when it was handed over when the entry says (epoch ms). */
interface HeldResult {
	id: string;
	handedAt?: number;
}

/**
 * The subagents whose result a parent's transcript entry hands it: a `task` result's
 * results that settle their runs (a sync spawn's; a background spawn's "started" result
 * names it only in its progress), and the settled jobs a background job's delivery
 * (`async-result`), a `wait` or a kill of a job that had settled (a `write` to
 * `proc://<id>/kill`, {@link killJobReport}) returned, with the subagents such a job reports it
 * hands over (a work pool's workers, its `agentResults`). A run its abort ended (`aborted`) or
 * that was lost with its worker thread (`workerLost`) settles only when the parent took a turn
 * after the result (`wentOn`, {@link parentWentOn}), since it then read it, as after a worker
 * crashed while the parent ran on. When the parent's process goes away inside the call, the
 * agent loop still records such a result, but the parent takes no turn after it, and the
 * subagent's turn stays as its transcript left it (a stop of the run left an aborted record
 * there, which `--restore` leaves anyway). An `eval` result and a work pool's report say when their
 * handovers happened (`agentResults[].handedAt`): a cell's handovers, and the pool's drain, come
 * before the entry that holds them (the cell ends later; the owner takes the pool's result later).
 */
function heldResults(entry: SessionEntry, wentOn: boolean): HeldResult[] {
	if (entry.type === "custom_message") {
		return entry.customType === ASYNC_RESULT_MESSAGE_TYPE ? settledJobResults(entry.details, wentOn) : [];
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const { toolName, details } = entry.message;
	if (toolName === "task") {
		if (!isTaskToolDetails(details)) return [];
		return details.results
			.filter(result => wentOn || (!result.aborted && !result.workerLost))
			.map(result => ({ id: result.id }));
	}
	if (toolName === "eval") return isRecord(details) ? agentResultsHeld(details.agentResults, wentOn) : [];
	if (toolName === "wait") return settledJobResults(details, wentOn);
	return settledJobResults(killJobReport(entry.message), wentOn);
}

/**
 * The job report a `write` result holds when it killed a job (`write proc://<id>/kill`): its
 * `proc` details, which list the jobs as a `wait` does; a kill of a job that had settled hands
 * its result over.
 */
function killJobReport(message: { toolName: string; details?: unknown }): unknown {
	const { details } = message;
	if (message.toolName !== "write" || !isRecord(details) || !isRecord(details.proc)) return undefined;
	return details.proc.op === "cancel" ? details.proc : undefined;
}

/** The subagents an `agentResults` list names (an `eval` result's, a settled job's), read as a `task` result's ({@link heldResults}), with the handover times it gives. */
function agentResultsHeld(agentResults: unknown, wentOn: boolean): HeldResult[] {
	if (!Array.isArray(agentResults)) return [];
	const held: HeldResult[] = [];
	for (const result of agentResults) {
		if (!isRecord(result)) continue;
		const id = stringProperty(result, "id");
		if (!id || (!wentOn && (result.aborted === true || result.workerLost === true))) continue;
		const handedAt = typeof result.handedAt === "number" ? result.handedAt : undefined;
		held.push(handedAt === undefined ? { id } : { id, handedAt });
	}
	return held;
}

/**
 * Whether a parent's transcript entry is a turn it took, so it read the results before it
 * on its branch: an assistant message, other than the record that ends a turn when its
 * process goes away ({@link isProcessExitRecord}). A stop the session makes itself (`/new`,
 * the task executor ending a parent subagent's run) leaves that record too, but it stops the
 * turn's sync subagents with it, and `--restore` leaves their turns anyway. The user's stop
 * gives its own reason: the parent lived on and chose to stop there.
 */
function parentWentOn(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant" && !isProcessExitRecord(entry.message);
}

/**
 * Whether `message` is the record a turn ends on when its process goes away: the
 * interrupted-turn abort ({@link isInterruptedTurnAbort}), which exit recovery writes and a
 * dispose for the process exit leaves, or the abort without a reason ({@link isReasonlessAbort})
 * that a dispose for anything else leaves (a quit, `/restart`, a signal). An abort that gives a
 * reason (the user's stop, a stopped retry, a caller's own reason) ended a turn that lived on.
 */
function isProcessExitRecord(message: AgentMessage): boolean {
	return (
		isInterruptedTurnAbort(message) ||
		(message.role === "assistant" && message.stopReason === "aborted" && isReasonlessAbort(message))
	);
}

/**
 * The results the settled jobs of a job report hand over: an `async-result` delivery's, a
 * `wait` snapshot's or a kill's. Each settled job hands over its own agent's (`agentId`, else
 * `agentUrlId`, `jobId` or `id`) and those of the subagents it lists in its `agentResults` (a work
 * pool's workers, read as {@link heldResults} reads them). A running job hands over none.
 */
function settledJobResults(details: unknown, wentOn: boolean): HeldResult[] {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	const held: HeldResult[] = [];
	for (const job of details.jobs) {
		if (!isRecord(job) || job.status === "running") continue;
		const id =
			stringProperty(job, "agentId") ??
			stringProperty(job, "agentUrlId") ??
			stringProperty(job, "jobId") ??
			stringProperty(job, "id");
		if (id) held.push({ id });
		held.push(...agentResultsHeld(job.agentResults, wentOn));
	}
	return held;
}

/**
 * Whether a transcript entry is input that starts a turn: a message other than a reply or a tool
 * result, or a custom message, but for the eval runtime snapshot a process writes as it starts
 * (`EVAL_STATE_CONTEXT_TYPE`): context the resumed process adds before `omp --restore` reads the
 * transcript, not an input anyone sent.
 */
function isTurnInput(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return entry.customType !== EVAL_STATE_CONTEXT_TYPE;
	return entry.type === "message" && entry.message.role !== "assistant" && entry.message.role !== "toolResult";
}

/**
 * When the branch's last turn began, in epoch ms: when the input that started it was
 * written (the task prompt, or the message that woke the subagent again), the last entry
 * before that turn's own replies and tool results. Undefined without one.
 */
function lastTurnStartedAt(branch: readonly SessionEntry[]): number | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (isTurnInput(entry)) return Date.parse(entry.timestamp);
	}
	return undefined;
}

/** When an assistant message started, in epoch ms: a streamed launch can spawn before the message is saved. */
function messageStartedAt(entry: Extract<SessionEntry, { type: "message" }>): number {
	return Number.isFinite(entry.message.timestamp) ? entry.message.timestamp : Date.parse(entry.timestamp);
}

/**
 * The windows of the calls a parent's process ended inside, read on its current conversation
 * (`conversation`, part of the branch `entries` selects): a subagent no record names, spawned in
 * one, is that call's work.
 * - The last turn, when it was still live as the transcript was last written: it ends in a reply's
 *   calls, their results, or the record a process exit leaves ({@link isProcessExitRecord}). Its
 *   call is the last reply that makes calls; with no reply saved, the reply that streamed when the
 *   process went away ({@link replyStreamStartedAt}). The window runs on to the end. A run that a
 *   terminal `yield` ended ({@link yieldEndsRun}) is not live, though the executor then stops the
 *   session with an abort that gives no reason. One whose async work was still pending at that
 *   `yield` is parked there until that work settles; when restore goes on with that run
 *   (`continued`, its turn restorable), the work's own spawns are the run's
 *   ({@link pendingAsyncWork}). A parked run restore does not go on with has no window: a
 *   relaunched subagent's result would reach no one.
 * - The latest reply with a call no result answers: the agent loop answers every call it finishes,
 *   an aborted one too, so the process ended inside it (a hard kill). Its window ends at the next
 *   input after it, when the conversation went on.
 * A call before the live one got its result, an older turn ended, and a branch the parent left is
 * not on this one, so none of them opens a window.
 */
function cutOffWindows(
	conversation: readonly SessionEntry[],
	entries: readonly SessionEntry[],
	continued: boolean,
): CutOffWindow[] {
	const windows: CutOffWindow[] = [];
	const live = liveCallWindow(conversation, entries, continued);
	if (live) windows.push(live);
	const answered = new Set<string>();
	for (const entry of conversation) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	}
	for (let index = conversation.length - 1; index >= 0; index--) {
		const entry = conversation[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (!entry.message.content.some(part => part.type === "toolCall" && !answered.has(part.id))) continue;
		const nextInput = conversation.slice(index + 1).find(isTurnInput);
		windows.push({
			startedAt: messageStartedAt(entry),
			endedAt: nextInput ? Date.parse(nextInput.timestamp) : Number.POSITIVE_INFINITY,
		});
		break;
	}
	return windows;
}

/** The window of the conversation's live last turn ({@link cutOffWindows}); undefined when that turn is not live. */
function liveCallWindow(
	conversation: readonly SessionEntry[],
	entries: readonly SessionEntry[],
	continued: boolean,
): CutOffWindow | undefined {
	const open = (startedAt: number | undefined): CutOffWindow | undefined =>
		startedAt === undefined ? undefined : { startedAt, endedAt: Number.POSITIVE_INFINITY };
	for (let index = conversation.length - 1; index >= 0; index--) {
		const entry = conversation[index]!;
		if (isTurnInput(entry)) return open(replyStreamStartedAt(conversation, entries, index));
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "toolResult") {
			if (message.toolName === "yield" && !message.isError && yieldEndsRun(message.details)) {
				return continued ? pendingAsyncWork(conversation, index) : undefined;
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		if (message.content.some(part => part.type === "toolCall")) return open(messageStartedAt(entry));
		// A reply that ended the turn, other than the record of a process exit.
		if (!isProcessExitRecord(message)) return undefined;
	}
	return undefined;
}

/**
 * The window of the async work of the conversation that was still pending at
 * `conversation[beforeIndex]`, a terminal `yield`'s result; undefined when none was. Async work
 * is a backgrounded eval cell or background `task` spawn (its result's `async` job), or an eval
 * job record that is `owed`; it settles with its job's delivery (`async-result`), a `wait` that
 * lists it settled, or its `delivered` record. The window opens where the earliest pending job
 * began (where the reply that made its call began, or its `owed` record) and leaves out the own
 * spawns of every other call of the conversation that got its result: a subagent such a call
 * spawned (a work-pool or `vibe_wait` worker, whose failure the call handed over) is that call's,
 * while one a pending job spawned during it (a backgrounded cell's `tool.task`) stays the job's.
 */
function pendingAsyncWork(conversation: readonly SessionEntry[], beforeIndex: number): CutOffWindow | undefined {
	const calledAt = new Map<string, number>();
	const pending = new Map<string, { startedAt: number; callId?: string }>();
	const finished: Array<{ callId: string; endedAt: number }> = [];
	for (const entry of conversation.slice(0, beforeIndex)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) {
				if (part.type === "toolCall") calledAt.set(part.id, messageStartedAt(entry));
			}
		}
		const job = readEvalAgentJobRecord(entry);
		if (job) {
			if (job.state === "owed") pending.set(job.agentId, { startedAt: Date.parse(entry.timestamp) });
			else pending.delete(job.agentId);
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			const { toolCallId } = entry.message;
			const async = isRecord(entry.message.details) ? entry.message.details.async : undefined;
			const jobId = isRecord(async) && async.state === "running" ? stringProperty(async, "jobId") : undefined;
			if (jobId) {
				pending.set(jobId, {
					startedAt: calledAt.get(toolCallId) ?? Date.parse(entry.timestamp),
					callId: toolCallId,
				});
			}
			finished.push({ callId: toolCallId, endedAt: Date.parse(entry.timestamp) });
		}
		for (const id of settledJobIds(entry)) pending.delete(id);
	}
	if (pending.size === 0) return undefined;
	let startedAt = Number.POSITIVE_INFINITY;
	const pendingCalls = new Set<string>();
	for (const job of pending.values()) {
		if (job.startedAt < startedAt) startedAt = job.startedAt;
		if (job.callId) pendingCalls.add(job.callId);
	}
	const finishedCalls = finished.filter(call => !pendingCalls.has(call.callId) && calledAt.has(call.callId));
	const excluded = {
		calls: new Set(finishedCalls.map(call => call.callId)),
		spans: finishedCalls.map(call => ({ startedAt: calledAt.get(call.callId)!, endedAt: call.endedAt })),
	};
	return { startedAt, endedAt: Number.POSITIVE_INFINITY, excluded };
}

/**
 * Every id a job report says settled: an `async-result` delivery's, a `wait` snapshot's or a
 * kill's ({@link killJobReport}) settled jobs, by job and subagent id, with the subagents each
 * lists in its `agentResults` (a work pool's workers).
 */
function settledJobIds(entry: SessionEntry): string[] {
	let details: unknown;
	if (entry.type === "custom_message" && entry.customType === ASYNC_RESULT_MESSAGE_TYPE) details = entry.details;
	else if (entry.type === "message" && entry.message.role === "toolResult") {
		details = entry.message.toolName === "wait" ? entry.message.details : killJobReport(entry.message);
	}
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	const ids: string[] = [];
	for (const job of details.jobs) {
		if (!isRecord(job) || job.status === "running") continue;
		for (const key of ["jobId", "id", "agentId", "agentUrlId"]) {
			const id = stringProperty(job, key);
			if (id) ids.push(id);
		}
		for (const held of agentResultsHeld(job.agentResults, true)) ids.push(held.id);
	}
	return ids;
}

/**
 * When the reply to the input at `conversation[inputIndex]` began streaming, its turn having no
 * reply saved: when the input was written. When the parent replaced a reply to that input, on a
 * branch it left, the new reply began after the parent went back to the latest point the two
 * branches share, which only an entry the selected branch wrote after that point can place (a
 * branch summary, say): its time, and undefined with none, since a spawn of the replaced reply
 * made after its last saved entry cannot be told from one of the new reply.
 */
function replyStreamStartedAt(
	conversation: readonly SessionEntry[],
	entries: readonly SessionEntry[],
	inputIndex: number,
): number | undefined {
	const onBranch = new Map(conversation.map((entry, index) => [entry.id, index]));
	const parentOf = new Map(entries.map(entry => [entry.id, entry.parentId]));
	let forkIndex = -1;
	for (const entry of entries) {
		if (onBranch.has(entry.id)) continue;
		let ancestor = entry.parentId;
		while (ancestor && !onBranch.has(ancestor)) ancestor = parentOf.get(ancestor) ?? null;
		const forkedAt = ancestor ? onBranch.get(ancestor) : undefined;
		if (forkedAt !== undefined && forkedAt >= inputIndex && forkedAt > forkIndex) forkIndex = forkedAt;
	}
	if (forkIndex < 0) return Date.parse(conversation[inputIndex]!.timestamp);
	const next = conversation[forkIndex + 1];
	return next ? Date.parse(next.timestamp) : undefined;
}

/**
 * The entries off the selected `branch` that a tool replay left there. A replay (a restored turn's,
 * or `/retry`'s, of a batch whose calls were all cut off) moves the leaf back to the batch's
 * assistant message and runs its calls again, so their first results lie on a branch of their own
 * below that message. Such a branch forks from the selected branch at an assistant message with
 * tool calls, holds a result of one of them, and the selected branch after that message holds one
 * too (the replay's). A branch a person's own navigation left (a branch from a user message, a
 * `/tree` move, a fork) forks elsewhere, or the selected branch holds no result of that message's
 * calls there, and none of its entries is returned.
 */
function replayLeftEntryIds(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): Set<string> {
	const branchIndex = new Map(branch.map((entry, index) => [entry.id, index]));
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const callsOf = (entry: SessionEntry | undefined): Set<string> | undefined => {
		if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
		const ids = new Set<string>();
		for (const part of entry.message.content) if (part.type === "toolCall") ids.add(part.id);
		return ids.size > 0 ? ids : undefined;
	};
	const answers = (entry: SessionEntry, calls: ReadonlySet<string>): boolean =>
		entry.type === "message" && entry.message.role === "toolResult" && calls.has(entry.message.toolCallId);
	// Each off-branch entry's fork point: its nearest ancestor on the selected branch (null: none).
	const forkOf = new Map<string, string | null>();
	const forkPoint = (entry: SessionEntry): string | null => {
		const path: string[] = [];
		let fork: string | null = null;
		for (let current: SessionEntry | undefined = entry; current;) {
			if (branchIndex.has(current.id)) {
				fork = current.id;
				break;
			}
			const known = forkOf.get(current.id);
			if (known !== undefined) {
				fork = known;
				break;
			}
			path.push(current.id);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		for (const id of path) forkOf.set(id, fork);
		return fork;
	};
	const offBranchAt = new Map<string, SessionEntry[]>();
	for (const entry of entries) {
		if (branchIndex.has(entry.id)) continue;
		const fork = forkPoint(entry);
		if (fork === null) continue;
		const group = offBranchAt.get(fork);
		if (group) group.push(entry);
		else offBranchAt.set(fork, [entry]);
	}
	const left = new Set<string>();
	for (const [fork, offBranch] of offBranchAt) {
		const index = branchIndex.get(fork)!;
		const calls = callsOf(branch[index]);
		if (!calls || !offBranch.some(entry => answers(entry, calls))) continue;
		if (!branch.slice(index + 1).some(entry => answers(entry, calls))) continue;
		for (const entry of offBranch) left.add(entry.id);
	}
	return left;
}

function readSpawnedSubagents(entries: readonly SessionEntry[], leafId: string | null): SpawnedSubagents {
	const named = new Set<string>();
	for (const entry of entries) for (const id of recordedAgentIds(entry)) named.add(id);
	const branch = activeBranch(entries, leafId);
	const discardedAt = new Map<string, number>();
	// Read from the leaf back: an id's latest record, of any kind, decides whether its spawn was discarded.
	const decided = new Set<string>();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		const launch = readDiscardedLaunch(entry);
		if (launch !== undefined && !decided.has(launch)) {
			decided.add(launch);
			discardedAt.set(launch, Date.parse(entry.timestamp));
		}
		for (const id of recordedAgentIds(entry)) decided.add(id);
	}
	const current = new Set<string>();
	const inConversation = new Set<string>();
	const settled = new Map<string, number>();
	const owedJobs = new Set<string>();
	const seenJobs = new Set<string>();
	let clearedAt: number | undefined;
	let conversationStart = 0;
	// Whether the parent took a turn after the entry being read ({@link parentWentOn}).
	let wentOn = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "reset_boundary") {
			clearedAt = Date.parse(entry.timestamp);
			conversationStart = index + 1;
			break;
		}
		for (const id of taskResultAgentIds(entry)) current.add(id);
		for (const id of recordedAgentIds(entry)) inConversation.add(id);
		const writtenAt = Date.parse(entry.timestamp);
		// Read from the leaf back: the first record of a job is its latest state. A subagent's settled
		// time is its latest handover's, by when the handover happened, not when the entry was written.
		const job = readEvalAgentJobRecord(entry);
		if (job && !seenJobs.has(job.agentId)) {
			seenJobs.add(job.agentId);
			if (job.state === "owed") owedJobs.add(job.agentId);
		}
		if (job?.state === "delivered") settle(settled, job.agentId, writtenAt);
		for (const held of heldResults(entry, wentOn)) settle(settled, held.id, held.handedAt ?? writtenAt);
		if (parentWentOn(entry)) wentOn = true;
	}
	const settledElsewhere = new Map<string, number>();
	// The calls a run is owed for, by its latest `owed` record that names any, on whatever branch it lies: a
	// restored turn's replay leaves the records of its cut-off batch on a branch of their own, and call ids
	// do not repeat.
	const owedCalls = new Map<string, string[]>();
	const replayLeft = replayLeftEntryIds(entries, branch);
	for (const entry of entries) {
		const job = readEvalAgentJobRecord(entry);
		if (job?.state === "owed" && job.spawnCallIds) owedCalls.set(job.agentId, job.spawnCallIds);
		if (!replayLeft.has(entry.id)) continue;
		const writtenAt = Date.parse(entry.timestamp);
		if (job?.state === "delivered") settle(settledElsewhere, job.agentId, writtenAt);
		for (const held of heldResults(entry, false)) settle(settledElsewhere, held.id, held.handedAt ?? writtenAt);
	}
	const conversation = branch.slice(conversationStart);
	const toolCallIds = (from: readonly SessionEntry[]): Set<string> => {
		const ids = new Set<string>();
		for (const entry of from) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const part of entry.message.content) if (part.type === "toolCall") ids.add(part.id);
		}
		return ids;
	};
	return {
		current,
		inConversation,
		named,
		discardedAt,
		settled,
		settledElsewhere,
		owedJobs,
		owedCalls,
		clearedAt,
		conversationCalls: toolCallIds(conversation),
		savedCalls: toolCallIds(entries),
		cutOffWindows: cutOffWindows(conversation, entries, hasRestorableTurn(branch)),
	};
}

/**
 * Whether `sub` was spawned in its parent's current conversation, judged by `spawned`. A subagent
 * whose `session_init` names the call it was spawned under belongs to the conversation whose reply
 * made that call, wherever its records lie: a restored turn that runs its cut-off calls again leaves
 * their first results on a branch of their own. One whose call no saved reply made (the process ended
 * while the reply streamed), or whose transcript names no call (an older version wrote it), is placed
 * by the records: a record of the current conversation names it. A record anywhere else (before the
 * last `/clear`, or on a branch the parent left) places it in work the parent left behind. When no
 * record names it, the parent's process ended inside the call that spawned it, before the call's
 * result was written: the subagent's transcript then says when it was spawned, which must be after
 * that `/clear`.
 */
function spawnedInCurrentConversation(sub: SubSession, spawned: SpawnedSubagents): boolean {
	const spawnCallId = extractSessionInit(sub.entries)?.spawnCallId;
	if (spawnCallId !== undefined && spawned.conversationCalls.has(spawnCallId)) return true;
	if (spawnCallId !== undefined && spawned.savedCalls.has(spawnCallId)) return false;
	if (spawned.inConversation.has(sub.agentId)) return true;
	if (spawned.named.has(sub.agentId)) return false;
	if (spawned.clearedAt === undefined || !sub.header) return true;
	// An unreadable time judges nothing, and the subagent goes on.
	return !(Date.parse(sub.header.timestamp) < spawned.clearedAt);
}

/**
 * What each parent in a session's subagent tree records of its subagents
 * ({@link SpawnedSubagents}), read when first needed: the session's own from its open
 * session manager (the parent is already loaded, from whatever storage holds it), and
 * each subagent's from the entries {@link collectSubSessions} collected. A parent whose
 * transcript was not collected judges nothing.
 */
class SpawnRecords {
	readonly #sessionManager: SessionManager;
	readonly #subSessions: Record<string, SubSession>;
	#session: SpawnedSubagents | undefined;
	readonly #bySubagent = new Map<string, SpawnedSubagents>();

	constructor(sessionManager: SessionManager, subSessions: Record<string, SubSession>) {
		this.#sessionManager = sessionManager;
		this.#subSessions = subSessions;
	}

	/**
	 * The parent's calls `sub`'s current run was requested under: those its parent's latest `owed`
	 * record for it names ({@link SpawnedSubagents.owedCalls}: a kept-alive pool worker's later batch),
	 * else the call its spawn record names (`spawnCallId`); none for a transcript that names no call.
	 */
	callsOf(sub: SubSession): string[] {
		const owed = this.#ofParent(sub.parent)?.owedCalls.get(sub.agentId);
		if (owed) return owed;
		const spawnCallId = extractSessionInit(sub.entries)?.spawnCallId;
		return spawnCallId === undefined ? [] : [spawnCallId];
	}

	/**
	 * Whether `sub`'s own parent's current conversation records its spawn as discarded
	 * ({@link SpawnedSubagents.discardedAt}: a launch the task tool did not adopt, a worker of a work
	 * pool that was stopped), by a record written once `sub`'s transcript had begun. A transcript
	 * begun after the discard is a later spawn of the same id.
	 */
	discardedByParent(sub: SubSession): boolean {
		const discardedAt = this.#ofParent(sub.parent)?.discardedAt.get(sub.agentId);
		if (discardedAt === undefined) return false;
		const spawnedAt = sub.header ? Date.parse(sub.header.timestamp) : Number.NaN;
		return Number.isFinite(spawnedAt) && !(spawnedAt > discardedAt);
	}

	/**
	 * Whether `sub` belongs to the session's current conversation: it, and each subagent
	 * above it, was spawned in its parent's current conversation
	 * ({@link spawnedInCurrentConversation}), since the subagents of work a `/clear` left
	 * behind are that work too.
	 */
	inCurrentConversation(sub: SubSession): boolean {
		let current: SubSession | undefined = sub;
		while (current) {
			const parentKey: string | null = current.parent;
			const spawned = this.#ofParent(parentKey);
			if (spawned && !spawnedInCurrentConversation(current, spawned)) return false;
			current = parentKey === null ? undefined : this.#subSessions[parentKey];
		}
		return true;
	}

	/**
	 * Whether `sub`'s own parent records that it still waits on `sub`'s turn that began at
	 * `turnStartedAt` (epoch ms), read in this order:
	 * - a discard of `sub`'s spawn ({@link SpawnedSubagents.discardedAt}: a streamed launch nobody
	 *   adopted, or a worker of a work pool the parent stopped, written after `sub`'s transcript
	 *   began): the parent does not wait, whatever it was handed before (a `peek` that handed over
	 *   an earlier batch of a reused pool worker settles nothing of the turn the stop then left);
	 * - else a result of `sub`'s run handed over (`settled`, and for a subagent placed by the call
	 *   its spawn record names, `settledElsewhere` too): handed over since the turn began, it settles
	 *   the turn; before, it answered an earlier turn, and this one is a turn the parent messaged
	 *   `sub` for, so the parent waits (an unreadable or unknown time judges nothing, and the result
	 *   stands);
	 * - else a `task` result that names the run and settles none of it (`current`: a background
	 *   spawn's "started" result, or a sync call's result the process exit cut off), or an eval
	 *   `agent()` job still `owed`: the parent waits;
	 * - else `sub` was spawned in the window of a call the parent's process went away inside
	 *   ({@link SpawnedSubagents.cutOffWindows}), by none of the finished calls the window leaves
	 *   out ({@link CutOffWindow.excluded}).
	 * Nothing else is evidence of a wait.
	 */
	parentStillWaits(sub: SubSession, turnStartedAt: number | undefined): boolean {
		const parent = this.#ofParent(sub.parent);
		if (!parent) return false;
		if (this.discardedByParent(sub)) return false;
		const spawnCallId = extractSessionInit(sub.entries)?.spawnCallId;
		let settledAt = parent.settled.get(sub.agentId);
		const elsewhere =
			spawnCallId !== undefined && parent.conversationCalls.has(spawnCallId)
				? parent.settledElsewhere.get(sub.agentId)
				: undefined;
		// The later of the two handovers, as {@link settle} keeps it.
		if (
			elsewhere !== undefined &&
			(settledAt === undefined || (Number.isFinite(elsewhere) && !(settledAt >= elsewhere)))
		) {
			settledAt = elsewhere;
		}
		if (settledAt !== undefined) return turnStartedAt !== undefined && settledAt < turnStartedAt;
		const spawnedAt = sub.header ? Date.parse(sub.header.timestamp) : Number.NaN;
		if (parent.current.has(sub.agentId) || parent.owedJobs.has(sub.agentId)) return true;
		if (!Number.isFinite(spawnedAt)) return false;
		const leftOut = (window: CutOffWindow): boolean => {
			if (!window.excluded) return false;
			if (spawnCallId !== undefined) return window.excluded.calls.has(spawnCallId);
			return window.excluded.spans.some(span => spawnedAt >= span.startedAt && spawnedAt <= span.endedAt);
		};
		return parent.cutOffWindows.some(
			window => spawnedAt >= window.startedAt && spawnedAt <= window.endedAt && !leftOut(window),
		);
	}

	/** What the parent `key` records (`null`: the session itself); undefined for a parent not collected. */
	#ofParent(key: string | null): SpawnedSubagents | undefined {
		if (key === null) {
			this.#session ??= readSpawnedSubagents(this.#sessionManager.getEntries(), this.#sessionManager.getLeafId());
			return this.#session;
		}
		const parent = this.#subSessions[key];
		if (!parent) return undefined;
		let spawned = this.#bySubagent.get(key);
		if (!spawned) {
			spawned = readSpawnedSubagents(parent.entries, parent.leafId);
			this.#bySubagent.set(key, spawned);
		}
		return spawned;
	}
}
