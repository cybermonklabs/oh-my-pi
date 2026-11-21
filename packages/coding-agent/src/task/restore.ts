/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn, or whose turn ended because its provider key could
 * not be resolved ({@link hasRestorableTurn}), was not killed (no tombstone), has no
 * subagent above it that was killed or stopped (see {@link restoreSubagents}), belongs
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
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import {
	conversationTail,
	endsOnCredentialUnavailableTurn,
	hasRestorableTurn,
	isInterruptedTurnAbort,
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
 * a resumed turn waiting on such a job finds it), then its own interrupted turn.
 */
export async function restoreSession(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	const subagents = await restoreSubagents(session, options);
	const turn = await session.restoreInterruptedTurn();
	return { turn, subagents };
}

/**
 * Has every subagent of `session` that its last process left mid-turn go on with that
 * turn (see the module docs). Nothing is restored for a session without a file, or
 * without background jobs (the `async.enabled` setting off), which could not deliver
 * the results.
 */
async function restoreSubagents(session: AgentSession, options: RestoreOptions): Promise<string[]> {
	const sessionFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	if (!sessionFile || !manager) return [];
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const subSessions = await collectSubSessions(sessionFile, {
		onUnreadable: key => logger.warn("Subagent transcript unreadable; not restored", { key }),
	});
	// Parents first: a child's result is delivered to its parent's session.
	const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
	const spawns = new SpawnRecords(session.sessionManager, subSessions);
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
	const restored: string[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		// The selected branch, as the subagent's own session reopens it: entries on other branches
		// (an abandoned turn, a `/clear` that was rolled back) are not its conversation.
		const branch = activeBranch(sub.entries, sub.leafId);
		const stopped = sub.parent === null ? undefined : stoppedAtOrAbove.get(sub.parent);
		const atOrAbove = sub.aborted || endsOnStop(branch) ? sub : stopped;
		if (atOrAbove) stoppedAtOrAbove.set(key, atOrAbove);
		if (sub.aborted || !hasRestorableTurn(branch)) continue;
		const id = sub.agentId;
		if (stopped) {
			logger.debug("Interrupted subagent is under a subagent that was killed or stopped; not restored", {
				id,
				ancestor: stopped.agentId,
			});
			continue;
		}
		// A `/clear` or a move to another branch leaves the parent's earlier work behind: that work's
		// subagents are not the new conversation's, whose parent would get a result for a job it never started.
		if (!spawns.inCurrentConversation(sub)) {
			logger.debug("Interrupted subagent belongs to work its parent left; not restored", { id });
			continue;
		}
		if (endsOnCredentialUnavailableTurn(branch) && !spawns.parentStillWaits(sub, lastTurnStartedAt(branch))) {
			logger.debug("Key-stranded subagent has no positive parent wait record; not restored", { id });
			continue;
		}
		const ref = registry.get(id);
		const init = extractSessionInit(sub.entries);
		if (!ref?.sessionFile || ref.kind !== "sub" || !init || init.isolated) {
			logger.debug("Interrupted subagent cannot be revived; not restored", { id });
			continue;
		}
		const sessionFileOfRef = ref.sessionFile;
		const agentName = persistedAgentName(ref.displayName, init);
		const structured = init.tools.includes("yield");
		manager.register(
			"task",
			id,
			async ({ signal }) => {
				const result = await runSubagentFollowUpTurn({
					id,
					agent: persistedAgentDefinition(ref.displayName, init),
					message: init.task,
					restore: true,
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
		restored.push(id);
	}
	if (restored.length > 0) logger.info("Restored interrupted subagents", { ids: restored });
	return restored;
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
	/** Streamed launches nobody adopted, from their discard records ({@link readDiscardedLaunch}): never the parent's work. */
	discarded: Set<string>;
	/**
	 * Those whose result the current conversation holds ({@link heldResultAgentIds}) or whose eval
	 * `agent()` job's latest record is `delivered`, each with when its latest such record was
	 * written, in epoch ms. `delivered` is written before the result reaches the cell, so a process
	 * that went away between the two leaves it.
	 */
	settled: Map<string, number>;
	/** Eval `agent()` jobs whose latest record in the current conversation is `owed`: a result still owed to the parent. */
	owedJobs: Set<string>;
	/** When that last `/clear` was written, in epoch ms; undefined without one. */
	clearedAt: number | undefined;
	/** The windows of the calls the parent's process ended inside ({@link cutOffWindows}). */
	cutOffWindows: CutOffWindow[];
}

/** When (epoch ms) a call the parent's process ended inside started, and when its turn ended (`Infinity`: it never did). */
interface CutOffWindow {
	startedAt: number;
	endedAt: number;
}

/**
 * The subagent ids a parent's transcript entry names: a `task` result's (its settled results and
 * its spawns' progress), the ones an `eval` result's `agentResults`, a job delivery or a `wait`
 * hands it, and an eval `agent()` job record's.
 */
function recordedAgentIds(entry: SessionEntry): string[] {
	const job = readEvalAgentJobRecord(entry);
	return [...taskResultAgentIds(entry), ...heldResultAgentIds(entry, true), ...(job ? [job.agentId] : [])];
}

/** The subagent ids a persisted `task` tool result names: its settled results and its spawns' progress. */
function taskResultAgentIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") return [];
	return taskCardAgentIds(entry.message.details);
}

/**
 * The subagent ids whose result a parent's transcript entry hands it: a `task` result's
 * results that settle their runs (a sync spawn's; a background spawn's "started" result
 * names it only in its progress), and the settled jobs a background job's delivery
 * (`async-result`) or a `wait` returned. A run its abort ended (`aborted`) or that was lost
 * with its worker thread (`workerLost`) settles only when the parent took a turn after the
 * result (`wentOn`, {@link parentWentOn}), since it then read it, as after a worker crashed
 * while the parent ran on. When the parent's process goes away inside the call, the agent
 * loop still records such a result, but the parent takes no turn after it, and the
 * subagent's turn stays as its transcript left it (a stop of the run left an aborted record
 * there, which `--restore` leaves anyway).
 */
function heldResultAgentIds(entry: SessionEntry, wentOn: boolean): string[] {
	if (entry.type === "custom_message") {
		return entry.customType === ASYNC_RESULT_MESSAGE_TYPE ? settledJobAgentIds(entry.details) : [];
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const { toolName, details } = entry.message;
	if (toolName === "task") {
		if (!isTaskToolDetails(details)) return [];
		return details.results
			.filter(result => wentOn || (!result.aborted && !result.workerLost))
			.map(result => result.id);
	}
	if (toolName === "eval") return evalHeldAgentIds(details, wentOn);
	return toolName === "wait" ? settledJobAgentIds(details) : [];
}

/** The subagent ids an `eval` result's `agentResults` names, read as a `task` result's ({@link heldResultAgentIds}). */
function evalHeldAgentIds(details: unknown, wentOn: boolean): string[] {
	if (!isRecord(details) || !Array.isArray(details.agentResults)) return [];
	const ids: string[] = [];
	for (const held of details.agentResults) {
		if (!isRecord(held)) continue;
		const id = stringProperty(held, "id");
		if (id && (wentOn || (held.aborted !== true && held.workerLost !== true))) ids.push(id);
	}
	return ids;
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
 * The agent ids of the settled jobs a job report lists: an `async-result` delivery's
 * (`agentId`, else `jobId`) or a `wait` snapshot's (`agentUrlId`, else `id`), whose
 * running jobs it hands over no result of.
 */
function settledJobAgentIds(details: unknown): string[] {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	const ids: string[] = [];
	for (const job of details.jobs) {
		if (!isRecord(job) || job.status === "running") continue;
		const id =
			stringProperty(job, "agentId") ??
			stringProperty(job, "agentUrlId") ??
			stringProperty(job, "jobId") ??
			stringProperty(job, "id");
		if (id) ids.push(id);
	}
	return ids;
}

/** Whether a transcript entry is input that starts a turn: a message other than a reply or a tool result, or a custom message. */
function isTurnInput(entry: SessionEntry): boolean {
	return (
		entry.type === "custom_message" ||
		(entry.type === "message" && entry.message.role !== "assistant" && entry.message.role !== "toolResult")
	);
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
 *   process went away, from the turn's input on, or from the last entry of a reply it replaced
 *   there. The window runs on to the end. A turn its run ended with a terminal `yield`
 *   ({@link yieldEndsRun}) is not live, though the executor then stops the session with an abort
 *   that gives no reason.
 * - The latest reply with a call no result answers: the agent loop answers every call it finishes,
 *   an aborted one too, so the process ended inside it (a hard kill). Its window ends at the next
 *   input after it, when the conversation went on.
 * A call before the live one got its result, an older turn ended, and a branch the parent left is
 * not on this one, so none of them opens a window.
 */
function cutOffWindows(conversation: readonly SessionEntry[], entries: readonly SessionEntry[]): CutOffWindow[] {
	const windows: CutOffWindow[] = [];
	const live = liveCallStartedAt(conversation, entries);
	if (live !== undefined) windows.push({ startedAt: live, endedAt: Number.POSITIVE_INFINITY });
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

/** When the call of the conversation's live last turn started ({@link cutOffWindows}); undefined when that turn is not live. */
function liveCallStartedAt(
	conversation: readonly SessionEntry[],
	entries: readonly SessionEntry[],
): number | undefined {
	for (let index = conversation.length - 1; index >= 0; index--) {
		const entry = conversation[index]!;
		if (isTurnInput(entry)) return replyStreamStartedAt(conversation, entries, index);
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "toolResult") {
			if (message.toolName === "yield" && !message.isError && yieldEndsRun(message.details)) return undefined;
			continue;
		}
		if (message.role !== "assistant") continue;
		if (message.content.some(part => part.type === "toolCall")) return messageStartedAt(entry);
		// A reply that ended the turn, other than the record of a process exit.
		if (!isProcessExitRecord(message)) return undefined;
	}
	return undefined;
}

/**
 * When the reply to the input at `conversation[inputIndex]` began streaming, its turn having no
 * reply saved: when the input was written, or after the last entry of a reply the parent replaced
 * on a branch it left there, whose calls ended before the parent went back to the input.
 */
function replyStreamStartedAt(
	conversation: readonly SessionEntry[],
	entries: readonly SessionEntry[],
	inputIndex: number,
): number {
	const onBranch = new Map(conversation.map((entry, index) => [entry.id, index]));
	const parentOf = new Map(entries.map(entry => [entry.id, entry.parentId]));
	let startedAt = Date.parse(conversation[inputIndex]!.timestamp);
	for (const entry of entries) {
		if (onBranch.has(entry.id)) continue;
		let ancestor = entry.parentId;
		while (ancestor && !onBranch.has(ancestor)) ancestor = parentOf.get(ancestor) ?? null;
		const forkedAt = ancestor ? onBranch.get(ancestor) : undefined;
		if (forkedAt === undefined || forkedAt < inputIndex) continue;
		const writtenAt = Date.parse(entry.timestamp);
		if (writtenAt > startedAt) startedAt = writtenAt;
	}
	return startedAt;
}

function readSpawnedSubagents(entries: readonly SessionEntry[], leafId: string | null): SpawnedSubagents {
	const named = new Set<string>();
	const discarded = new Set<string>();
	for (const entry of entries) {
		for (const id of recordedAgentIds(entry)) named.add(id);
		const launch = readDiscardedLaunch(entry);
		if (launch) discarded.add(launch);
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
	const branch = activeBranch(entries, leafId);
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
		// Read from the leaf back: the first record of a job, and the first result naming a subagent, is its latest.
		const job = readEvalAgentJobRecord(entry);
		if (job && !seenJobs.has(job.agentId)) {
			seenJobs.add(job.agentId);
			if (job.state === "owed") owedJobs.add(job.agentId);
			else if (!settled.has(job.agentId)) settled.set(job.agentId, writtenAt);
		}
		for (const id of heldResultAgentIds(entry, wentOn)) if (!settled.has(id)) settled.set(id, writtenAt);
		if (parentWentOn(entry)) wentOn = true;
	}
	return {
		current,
		inConversation,
		named,
		discarded,
		settled,
		owedJobs,
		clearedAt,
		cutOffWindows: cutOffWindows(branch.slice(conversationStart), entries),
	};
}

/**
 * Whether `sub` was spawned in its parent's current conversation, judged by `spawned`: a
 * record of that conversation names it. A record anywhere else (before the last `/clear`, or
 * on a branch the parent left) places it in work the parent left behind. When no record
 * names it, the parent's process ended inside the call that spawned it, before the call's
 * result was written: the subagent's transcript then says when it was spawned, which must be
 * after that `/clear`.
 */
function spawnedInCurrentConversation(sub: SubSession, spawned: SpawnedSubagents): boolean {
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
	 * - a result of `sub`'s run handed over (`settled`): written since the turn began, it settles
	 *   the turn; written before, it answered an earlier turn, and this one is a turn the parent
	 *   messaged `sub` for, so the parent waits (an unreadable or unknown time judges nothing, and
	 *   the result stands);
	 * - else a `task` result that names the run and settles none of it (`current`: a background
	 *   spawn's "started" result, or a sync call's result the process exit cut off), or an eval
	 *   `agent()` job still `owed`: the parent waits;
	 * - else `sub` was spawned in the window of a call the parent's process went away inside
	 *   ({@link SpawnedSubagents.cutOffWindows}), and is not a streamed launch that call discarded
	 *   unadopted.
	 * Nothing else is evidence of a wait.
	 */
	parentStillWaits(sub: SubSession, turnStartedAt: number | undefined): boolean {
		const parent = this.#ofParent(sub.parent);
		if (!parent) return false;
		const settledAt = parent.settled.get(sub.agentId);
		if (settledAt !== undefined) return turnStartedAt !== undefined && settledAt < turnStartedAt;
		if (parent.current.has(sub.agentId) || parent.owedJobs.has(sub.agentId)) return true;
		if (!sub.header || parent.discarded.has(sub.agentId)) return false;
		const spawnedAt = Date.parse(sub.header.timestamp);
		if (!Number.isFinite(spawnedAt)) return false;
		return parent.cutOffWindows.some(window => spawnedAt >= window.startedAt && spawnedAt <= window.endedAt);
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
