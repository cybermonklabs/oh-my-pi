/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn, or whose turn ended because its provider key could
 * not be resolved ({@link hasRestorableTurn}), was not killed (no tombstone) and can be
 * revived (a `session_init` contract, not isolated) runs one
 * more monitored turn as a background job of its parent: the lifecycle reviver
 * rebuilds it from its transcript, {@link runSubagentFollowUpTurn} goes on with the
 * cut-off turn and drives it to `yield` (then through the steps a stepped run had not
 * sent yet), and the parent receives the result as the
 * ordinary `async-result` of a job with the subagent's id, the id its first run's
 * job had, so a parent waiting on that job finds it again. A turn that ended because
 * its key could not be resolved stays restorable after a normal exit, so it goes on only
 * while it is still its parent's work: on the branch its transcript selects, in its
 * parent's current conversation (not in work a `/clear` or a move to another branch
 * left behind, {@link SpawnRecords}), and while the parent still waits on it, holding no
 * result that settles it recorded since the turn began
 * ({@link SpawnRecords.awaitedByParent}); a parent that holds the failure acts on it.
 */
import * as path from "node:path";
import { isRecord, logger, stringProperty } from "@oh-my-pi/pi-utils";
import { isTaskToolDetails, taskCardAgentIds } from "@oh-my-pi/pi-tui/tools/task";
import { AsyncJobError } from "../async";
import { EVAL_AGENT_SPAWN_MESSAGE_TYPE, readEvalAgentSpawnRecord } from "../eval/agent-record";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import {
	endsOnCredentialUnavailableTurn,
	hasRestorableTurn,
	isInterruptedToolResult,
	isInterruptedTurnAbort,
	readSessionExit,
	readToolExecutionStart,
} from "../session/exit-diagnostics";
import { isReasonlessAbort } from "../session/messages";
import { activeBranch, type SessionEntry } from "../session/session-entries";
import { extractSessionInit, type SessionManager } from "../session/session-manager";
import { collectSubSessions, type SubSession } from "../session/sub-sessions";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import { persistedAgentDefinition, persistedAgentName } from "./persisted-revive";
import { readStepProgress } from "./steps";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";
import { readTaskSpawnRecord, TASK_SPAWN_MESSAGE_TYPE } from "./task-spawn-record";
import { persistedVibeChildIds } from "../vibe/lifecycle";

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
	// Vibe mode keeps its workers: their lifecycle records claim them, and interactive mode rehydrates them as
	// subagent refs before `--restore` runs, so the roster check cannot tell them apart.
	const vibeWorkers = persistedVibeChildIds(session.sessionManager.getEntries());
	const restored: string[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		if (sub.aborted) continue;
		const id = sub.agentId;
		// The selected branch, as the subagent's own session reopens it: entries on other branches
		// (an abandoned turn, a `/clear` that was rolled back) are not its conversation.
		const branch = activeBranch(sub.entries, sub.leafId);
		if (endsOnCredentialUnavailableTurn(branch)) {
			// Such a turn stays restorable after a normal exit, so it is relaunched only while it is still the
			// parent's work: not a vibe worker of the root session (vibe mode keeps it, and its director decides
			// its next turn), not behind the parent's `/clear` or on a branch it left (whose parent would get a
			// result for a job it never started), and not once the parent holds its failed result.
			if (!key.includes("/") && vibeWorkers.has(id)) {
				logger.debug("Interrupted subagent is a vibe worker, which vibe mode keeps; not restored", { id });
				continue;
			}
			if (!spawns.inCurrentConversation(sub)) {
				logger.debug("Interrupted subagent belongs to work its parent left; not restored", { id });
				continue;
			}
			if (!spawns.awaitedByParent(sub, lastTurnStartedAt(branch))) {
				logger.debug("Subagent's parent holds its result or records no wait on it; not restored", { id });
				continue;
			}
		} else if (endsOnCredentialUnavailableTurn(sub.entries) || !hasRestorableTurn(sub.entries)) {
			// Any other subagent is judged as before, by its whole transcript; a key-unresolved turn there
			// that its selected branch does not end on (an abandoned branch, a `/clear`) is not its work.
			continue;
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
		const sessionFileOfRef = ref.sessionFile;
		const agentName = persistedAgentName(ref.displayName, init);
		const steps = readStepProgress(sub.entries);
		manager.register(
			"task",
			id,
			async ({ signal }) => {
				const result = await runSubagentFollowUpTurn({
					id,
					agent: persistedAgentDefinition(ref.displayName, init),
					message: init.task,
					restore: true,
					steps,
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
 * What a parent transcript records of the subagents it spawned. `current`: those a
 * record names in the conversation on the active branch after its last `/clear` (a
 * `task_spawn` record with the id the task tool or a work pool allocated, an `agent()`
 * spawn record, or a result that names the subagent: a `task`, an `eval`, a `wait`, a kill
 * (`write proc://<id>/kill`) or an async delivery), less the spawns whose latest spawn record (a `task_spawn` or an
 * `agent()` record) marks them discarded: a launch the task tool did not adopt, or a worker of a work pool that was
 * stopped. `discarded`: those spawns. `named`: those any record
 * names, on any branch and before any `/clear`. `held`: those whose result the current
 * conversation holds ({@link heldResults}), each with when its latest such result was
 * handed over, in epoch ms. `cutOffStep`: the window of the current conversation's last
 * tool calls the process ended inside ({@link lastCutOffStep}). A missing record proves
 * nothing: `--restore` never relaunches a key-stranded subagent on that absence.
 */
interface SpawnedSubagents {
	current: Set<string>;
	named: Set<string>;
	held: Map<string, number>;
	/** The ids whose latest spawn record in the current conversation marks them discarded. */
	discarded: Set<string>;
	cutOffStep?: CutOffStep;
}

/**
 * The window of the parent's tool calls the process ended inside: from when the first of
 * them started running to when their turn ended, in epoch ms (`Infinity`: never).
 */
interface CutOffStep {
	startedAt: number;
	endedAt: number;
}

/**
 * The subagent ids a spawn record (`task_spawn`, which the task tool and a work pool write;
 * `eval_agent_spawn`) or a result record ({@link resultAgentIds}) names.
 */
function recordAgentIds(entry: SessionEntry): string[] {
	if (entry.type === "custom") {
		const record =
			entry.customType === TASK_SPAWN_MESSAGE_TYPE
				? readTaskSpawnRecord(entry.data)
				: entry.customType === EVAL_AGENT_SPAWN_MESSAGE_TYPE
					? readEvalAgentSpawnRecord(entry.data)
					: undefined;
		return record ? [record.id] : [];
	}
	return resultAgentIds(entry);
}

/**
 * The subagent ids a persisted result record names: a direct `task`, an eval cell, or a
 * `wait`, a kill (`write proc://<id>/kill`) or an async delivery of a job (an eval job's or
 * a work pool's handovers).
 */
function resultAgentIds(entry: SessionEntry): string[] {
	if (entry.type === "custom_message")
		return entry.customType === ASYNC_RESULT_MESSAGE_TYPE ? jobReportEvalAgentIds(entry.details) : [];
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const { toolName, details } = entry.message;
	if (toolName === "task") return taskCardAgentIds(details);
	if (toolName === "eval") return evalAgentIds(details);
	return jobReportEvalAgentIds(toolName === "wait" ? details : killJobReport(toolName, details));
}

/**
 * The job report a `write` result holds when it killed a background job (`write
 * proc://<id>/kill`): a snapshot of each job it named, as a `wait` result has. A job that had
 * already settled hands its result over there (the kill consumes it, so no async delivery
 * follows), with the subagent results the job records.
 */
function killJobReport(toolName: string, details: unknown): unknown {
	if (toolName !== "write" || !isRecord(details) || !isRecord(details.proc)) return undefined;
	return details.proc.op === "cancel" ? details.proc : undefined;
}

/** The subagent ids an eval result's agentResults names, regardless of whether they settled. */
function evalAgentIds(details: unknown): string[] {
	if (!isRecord(details) || !Array.isArray(details.agentResults)) return [];
	const ids: string[] = [];
	for (const value of details.agentResults) {
		if (!isRecord(value)) continue;
		const id = stringProperty(value, "id");
		if (id) ids.push(id);
	}
	return ids;
}

/**
 * The subagent ids the jobs of a job report (an `async-result` delivery, a `wait` or a kill
 * result) name in their `agentResults`: an eval job's cells' handovers, a work pool's workers'.
 */
function jobReportEvalAgentIds(details: unknown): string[] {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	return details.jobs.flatMap(job => (isRecord(job) ? evalAgentIds(job) : []));
}

/**
 * The subagent ids whose result a parent's transcript entry hands it: a `task` result's
 * results that settle their runs (a sync spawn's; a background spawn's "started" result
 * names it only in its progress), the runs an `eval` result records its cells' bridged
 * calls handed them (`tool.task`, `tool.wait`, `wait()`, a work pool's `peek()`), the settled
 * jobs, and the handovers a settled job records (an eval job's cells', a work pool's
 * workers'), that a background job's delivery (`async-result`), a `wait` or a kill
 * ({@link killJobReport}) returned, and a background `agent()` whose spawn record says its
 * result was delivered. A run its abort ended (`aborted`) or that was
 * lost with its worker thread (`workerLost`) settles only when the parent took a turn after
 * the result (`wentOn`, {@link parentWentOn}), since it then read it, as after a worker
 * crashed while the parent ran on. When the parent's process goes away inside the call, the
 * agent loop still records such a result, but the parent takes no turn after it, and the
 * subagent's turn stays as its transcript left it (a stop of the run left an aborted record
 * there, which `--restore` leaves anyway).
 */
function heldResults(entry: SessionEntry, wentOn: boolean): HeldResult[] {
	if (entry.type === "custom") {
		if (entry.customType !== EVAL_AGENT_SPAWN_MESSAGE_TYPE) return [];
		const record = readEvalAgentSpawnRecord(entry.data);
		return record?.status === "delivered" ? [{ id: record.id }] : [];
	}
	if (entry.type === "custom_message") {
		return entry.customType === ASYNC_RESULT_MESSAGE_TYPE ? jobReportHeldResults(entry.details, wentOn) : [];
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const { toolName, details } = entry.message;
	if (toolName === "task") {
		if (!isTaskToolDetails(details)) return [];
		return details.results
			.filter(result => wentOn || (!result.aborted && !result.workerLost))
			.map(result => ({ id: result.id }));
	}
	if (toolName === "eval") return evalHeldResults(details, wentOn);
	return jobReportHeldResults(toolName === "wait" ? details : killJobReport(toolName, details), wentOn);
}

/**
 * A subagent whose result a parent's transcript entry hands it ({@link heldResults}), with when
 * it was handed over (`at`, epoch ms) where the record says: an eval cell's bridged calls record
 * the moment, which can come before the cell's result is written. Without it, the entry's own
 * time.
 */
interface HeldResult {
	id: string;
	at?: number;
}

/** The subagents an `eval` result's `agentResults` names, read as a `task` result's ({@link heldResults}). */
function evalHeldResults(details: unknown, wentOn: boolean): HeldResult[] {
	if (!isRecord(details) || !Array.isArray(details.agentResults)) return [];
	const results: HeldResult[] = [];
	for (const held of details.agentResults) {
		if (!isRecord(held)) continue;
		const id = stringProperty(held, "id");
		if (!id || (!wentOn && (held.aborted === true || held.workerLost === true))) continue;
		results.push(typeof held.at === "number" && Number.isFinite(held.at) ? { id, at: held.at } : { id });
	}
	return results;
}

/** Subagent results a job report (an `async-result` delivery, a `wait` or kill result) handed the parent: its settled jobs and the handovers they record. */
function jobReportHeldResults(details: unknown, wentOn: boolean): HeldResult[] {
	const results: HeldResult[] = settledJobAgentIds(details).map(id => ({ id }));
	if (!isRecord(details) || !Array.isArray(details.jobs)) return results;
	for (const job of details.jobs) if (isRecord(job)) results.push(...evalHeldResults(job, wentOn));
	return results;
}

/**
 * Whether a parent's transcript entry is a turn it took, so it read the results before it
 * on its branch: an assistant message, other than the record that ends a turn when its
 * process goes away. That is the interrupted-turn abort ({@link isInterruptedTurnAbort}),
 * which exit recovery writes and a dispose for the process exit leaves, or the abort
 * without a reason ({@link isReasonlessAbort}) that a dispose for anything else leaves
 * (a quit, `/restart`, a signal). A stop the session makes itself (`/new`, the task
 * executor ending a parent subagent's run) leaves that record too, but it stops the turn's
 * sync subagents with it, and `--restore` leaves their turns anyway. The user's stop gives
 * its own reason: the parent lived on and chose to stop there.
 */
function parentWentOn(entry: SessionEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	const { message } = entry;
	const reasonlessAbort = message.stopReason === "aborted" && isReasonlessAbort(message);
	return !isInterruptedTurnAbort(message) && !reasonlessAbort;
}

/**
 * The agent ids of the settled jobs a job report lists: an `async-result` delivery's
 * (`agentId`, else `jobId`) or a `wait` or kill result's snapshot's (`agentUrlId`, else `id`),
 * whose running jobs it hands over no result of.
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

/**
 * The conversation's last tool calls that the process ended inside, read from its end, as
 * a window of time: from when the first of those calls started running (its
 * `tool_execution_start` marker, else the time the response that made it was written) to
 * when its turn ended. It places a subagent that no record names anywhere: one a version
 * that wrote no spawn record started. Such a subagent is a cut-off call's work when it
 * began in that window; the window also holds one another call of the same response
 * started while the cut-off call ran (`task` calls run at the same time). Every spawn a turn
 * makes writes a record now (the task tool, a work pool, `agent()`; `--restore` leaves a
 * key-stranded vibe worker to vibe mode, {@link restoreSubagents}), so
 * the window decides nothing for their subagents. Before exit recovery closes the turn (a
 * hard kill, or a nested parent that was never restored), the calls are the response's
 * calls that no result on the branch answers: the agent loop answers every call it
 * finishes, even an aborted one, so an unanswered call is one the process ended inside, and
 * its turn ends at the next input after it or, with none, has not ended. Once exit recovery
 * closed the turn with its interrupted-turn record, which says when the turn ended, they are
 * the calls {@link cutOffCalls} finds.
 */
function lastCutOffStep(conversation: readonly SessionEntry[]): CutOffStep | undefined {
	const answered = new Set<string>();
	const startedAt = new Map<string, number>();
	for (const entry of conversation) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
		const marker = readToolExecutionStart(entry);
		if (marker) startedAt.set(marker.toolCallId, Date.parse(marker.startedAt));
	}
	/** When the first of `callIds` started running; the time `response` was written when none has a marker. */
	const firstStart = (response: SessionEntry, callIds: readonly string[]): number => {
		const starts = callIds.flatMap(id => {
			const at = startedAt.get(id);
			return at !== undefined && Number.isFinite(at) ? [at] : [];
		});
		return starts.length > 0 ? Math.min(...starts) : Date.parse(response.timestamp);
	};
	for (let index = conversation.length - 1; index >= 0; index--) {
		const entry = conversation[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { message } = entry;
		if (isInterruptedTurnAbort(message)) {
			const cut = cutOffCalls(conversation, index);
			if (!cut) return undefined;
			return { startedAt: firstStart(cut.response, cut.callIds), endedAt: Date.parse(entry.timestamp) };
		}
		const unanswered = message.content.flatMap(part =>
			part.type === "toolCall" && !answered.has(part.id) ? [part.id] : [],
		);
		if (unanswered.length === 0) continue;
		const nextInput = conversation.slice(index + 1).find(isTurnInput);
		return {
			startedAt: firstStart(entry, unanswered),
			endedAt: nextInput ? Date.parse(nextInput.timestamp) : Number.POSITIVE_INFINITY,
		};
	}
	return undefined;
}

/**
 * The calls the process ended inside, and the response that made them, in the turn exit
 * recovery closed with its record at `closedAt`. The process exit record, written before
 * the turn is aborted, names the calls still running then, which are the last response's:
 * none means the process ended outside any call (while a response streamed), when no
 * subagent without a record starts. A turn without an exit record (a hard kill, closed by
 * `--restore`'s own recovery) gives the calls recovery paired with its own result
 * ({@link isInterruptedToolResult}), the ones no result answered when the process died: the
 * response's other calls had finished. Undefined when none applies.
 */
function cutOffCalls(
	conversation: readonly SessionEntry[],
	closedAt: number,
): { response: SessionEntry; callIds: string[] } | undefined {
	let pending: string[] | undefined;
	const recovered = new Set<string>();
	for (let index = closedAt - 1; index >= 0; index--) {
		const entry = conversation[index]!;
		if (isTurnInput(entry)) return undefined;
		const exit = pending ? undefined : readSessionExit(entry);
		if (exit) {
			pending = (exit.pendingToolCalls ?? []).flatMap(call => (call.toolCallId ? [call.toolCallId] : []));
			if (pending.length === 0) return undefined;
			continue;
		}
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "toolResult" && isInterruptedToolResult(message)) recovered.add(message.toolCallId);
		if (message.role !== "assistant") continue;
		const calls = message.content.flatMap(part => (part.type === "toolCall" ? [part.id] : []));
		if (calls.length === 0) continue;
		const callIds = pending ?? calls.filter(id => recovered.has(id));
		return callIds.length > 0 ? { response: entry, callIds } : undefined;
	}
	return undefined;
}

function readSpawnedSubagents(entries: readonly SessionEntry[], leafId: string | null): SpawnedSubagents {
	const named = new Set<string>();
	for (const entry of entries) for (const id of recordAgentIds(entry)) named.add(id);
	const current = new Set<string>();
	const discarded = new Set<string>();
	// The ids whose latest spawn record was read: that record decides whether the spawn was discarded.
	const decided = new Set<string>();
	const held = new Map<string, number>();
	const branch = activeBranch(entries, leafId);
	const conversation = branch.slice(branch.findLastIndex(entry => entry.type === "reset_boundary") + 1);
	// The calls a process exit cut off: its exit record, written before the turn is aborted, names them.
	const cutOffCallIds = new Set<string>();
	for (const entry of conversation) {
		for (const call of readSessionExit(entry)?.pendingToolCalls ?? []) {
			if (call.toolCallId) cutOffCallIds.add(call.toolCallId);
		}
	}
	// Whether the parent took a turn after the entry being read ({@link parentWentOn}).
	let wentOn = false;
	for (let index = conversation.length - 1; index >= 0; index--) {
		const entry = conversation[index]!;
		const taskSpawn =
			entry.type === "custom" && entry.customType === TASK_SPAWN_MESSAGE_TYPE
				? readTaskSpawnRecord(entry.data)
				: undefined;
		const spawnId =
			taskSpawn?.id ??
			(entry.type === "custom" && entry.customType === EVAL_AGENT_SPAWN_MESSAGE_TYPE
				? readEvalAgentSpawnRecord(entry.data)?.id
				: undefined);
		// Read from the leaf back: an id's latest spawn record, of any kind, decides. A later process can allocate
		// the id of a launch discarded before it wrote a transcript again (a task spawn, an `agent()`), and that
		// spawn's record follows the discard's.
		if (spawnId !== undefined && !decided.has(spawnId)) {
			decided.add(spawnId);
			if (taskSpawn?.discarded) discarded.add(spawnId);
		}
		if (!taskSpawn?.discarded) for (const id of recordAgentIds(entry)) current.add(id);
		// The result of a call the process exit cut off reached no turn of the parent's (an eval cell's bridged
		// calls may have handed the cell results before the exit): it settles nothing unless the parent took a
		// turn after it, as an aborted run's result does.
		const cutOffResult =
			entry.type === "message" && entry.message.role === "toolResult" && cutOffCallIds.has(entry.message.toolCallId);
		// A subagent's latest handover counts: a turn it began after that is a new run.
		if (wentOn || !cutOffResult) {
			for (const result of heldResults(entry, wentOn)) {
				const at = result.at ?? Date.parse(entry.timestamp);
				held.set(result.id, Math.max(held.get(result.id) ?? Number.NEGATIVE_INFINITY, at));
			}
		}
		if (parentWentOn(entry)) wentOn = true;
	}
	// A spawn whose latest record says discarded was aborted, and no call result reports it: not the parent's work.
	for (const id of discarded) current.delete(id);
	const cutOffStep = lastCutOffStep(conversation);
	return { current, named, held, discarded, ...(cutOffStep ? { cutOffStep } : {}) };
}

/**
 * Whether `sub` is work of its parent's current conversation, as `spawned` records it: a
 * record there names it; else no record anywhere does (one on another branch, before the
 * `/clear`, or of a discarded spawn places it in other work) and it began while the
 * parent's tool calls the process ended inside ran ({@link lastCutOffStep}).
 */
function spawnedInCurrentConversation(sub: SubSession, spawned: SpawnedSubagents): boolean {
	if (spawned.current.has(sub.agentId)) return true;
	if (spawned.named.has(sub.agentId)) return false;
	const cutOffStep = spawned.cutOffStep;
	const startedAt = sub.header ? Date.parse(sub.header.timestamp) : Number.NaN;
	return (
		cutOffStep !== undefined &&
		Number.isFinite(startedAt) &&
		startedAt >= cutOffStep.startedAt &&
		startedAt <= cutOffStep.endedAt
	);
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
	 * Whether `sub`'s own parent still positively waits on its turn that began at
	 * `turnStartedAt`: the subagent is work of the parent's current conversation
	 * ({@link spawnedInCurrentConversation}), and that conversation holds no result that
	 * settles this run since. A missing record is not a reason to relaunch: the parent may
	 * have received it through a path a future runtime did not record.
	 */
	awaitedByParent(sub: SubSession, turnStartedAt: number | undefined): boolean {
		const parent = this.#ofParent(sub.parent);
		if (!parent || !spawnedInCurrentConversation(sub, parent)) return false;
		const heldAt = parent.held.get(sub.agentId);
		if (heldAt === undefined) return true;
		return turnStartedAt !== undefined && heldAt < turnStartedAt;
	}

	/** Whether `sub`'s own parent's current conversation records its spawn as discarded. */
	discardedByParent(sub: SubSession): boolean {
		return this.#ofParent(sub.parent)?.discarded.has(sub.agentId) ?? false;
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
