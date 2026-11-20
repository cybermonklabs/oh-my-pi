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
 * while the parent still waits on it, holding no result that settles it recorded since
 * the turn began ({@link SpawnRecords.awaitedByParent}); a parent that holds the failure
 * acts on it.
 */
import * as path from "node:path";
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
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import { persistedAgentDefinition, persistedAgentName } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";

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
 * What a parent transcript records of the subagents its `task` calls spawned:
 * `current`, those its `task` results name in the conversation on the active branch
 * after its last `/clear` (`reset_boundary`); `named`, those of every `task` result,
 * on any branch; `held`, those whose result that conversation holds
 * ({@link heldResultAgentIds}), each with when its latest such result was written, in epoch ms;
 * `waitsOnSpawnsSince`, from when (epoch ms) that conversation still waits on every subagent
 * spawned: the start of a `task` call that has no result (the call its process ended inside),
 * or of a last turn its process cut off ({@link liveTurnStartedAt}); undefined without either.
 */
interface SpawnedSubagents {
	current: Set<string>;
	named: Set<string>;
	held: Map<string, number>;
	/** When that last `/clear` was written, in epoch ms; undefined without one. */
	clearedAt: number | undefined;
	waitsOnSpawnsSince: number | undefined;
	/** Eval `agent()` jobs whose latest record in that conversation is `owed`: a result still owed to the parent. */
	owedJobs: Set<string>;
	/** Eval `agent()` jobs whose latest record is `delivered`, each with when it was written, in epoch ms. */
	deliveredJobs: Map<string, number>;
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

/**
 * When the branch's last turn began, in epoch ms: when the input that started it was
 * written (the task prompt, or the message that woke the subagent again), the last entry
 * before that turn's own replies and tool results. Undefined without one.
 */
function lastTurnStartedAt(branch: readonly SessionEntry[]): number | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		const input =
			entry.type === "custom_message" ||
			(entry.type === "message" && entry.message.role !== "assistant" && entry.message.role !== "toolResult");
		if (input) return Date.parse(entry.timestamp);
	}
	return undefined;
}

/**
 * When the conversation's last turn began (epoch ms), while that turn was still live when the
 * transcript was last written: it has no reply yet, ends in a tool call or a tool result, or ends
 * on the record a process going away leaves ({@link isInterruptedTurnAbort}, {@link isReasonlessAbort}).
 * Such a parent still waits on what that turn started. Undefined for a turn that ended.
 */
function liveTurnStartedAt(conversation: readonly SessionEntry[]): number | undefined {
	const tail = conversation.findLast(entry => entry.type === "message" || entry.type === "custom_message");
	if (!tail) return undefined;
	if (tail.type === "message" && tail.message.role === "assistant") {
		const { message } = tail;
		const endsInCall = message.content.some(part => part.type === "toolCall");
		const exitRecord =
			isInterruptedTurnAbort(message) ||
			(message.stopReason === "aborted" &&
				!isUserInterruptAbort(message) &&
				message.errorMessage !== RETRY_CANCELLED);
		if (!endsInCall && !exitRecord) return undefined;
	}
	return lastTurnStartedAt(conversation);
}

function readSpawnedSubagents(entries: readonly SessionEntry[], leafId: string | null): SpawnedSubagents {
	const named = new Set<string>();
	for (const entry of entries) for (const id of taskResultAgentIds(entry)) named.add(id);
	const current = new Set<string>();
	const held = new Map<string, number>();
	let clearedAt: number | undefined;
	let conversationStart = 0;
	let pendingTaskCallAt: number | undefined;
	const answeredCalls = new Set<string>();
	const owedJobs = new Set<string>();
	const deliveredJobs = new Map<string, number>();
	const seenJobs = new Set<string>();
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
		if (entry.type === "message" && entry.message.role === "toolResult") answeredCalls.add(entry.message.toolCallId);
		if (entry.type === "message" && entry.message.role === "assistant") {
			const pending = entry.message.content.some(
				part => part.type === "toolCall" && part.name === "task" && !answeredCalls.has(part.id),
			);
			// The message starts before the call is saved, and a streamed launch can spawn in between.
			if (pending)
				pendingTaskCallAt = Number.isFinite(entry.message.timestamp)
					? entry.message.timestamp
					: Date.parse(entry.timestamp);
		}
		const job = readEvalAgentJobRecord(entry);
		// Read from the leaf back: the first record of a job is its latest.
		if (job && !seenJobs.has(job.agentId)) {
			seenJobs.add(job.agentId);
			if (job.state === "owed") owedJobs.add(job.agentId);
			else deliveredJobs.set(job.agentId, Date.parse(entry.timestamp));
		}
		for (const id of taskResultAgentIds(entry)) current.add(id);
		// Read from the leaf back: the first result naming a subagent is its latest.
		for (const id of heldResultAgentIds(entry, wentOn)) if (!held.has(id)) held.set(id, Date.parse(entry.timestamp));
		if (parentWentOn(entry)) wentOn = true;
	}
	const liveTurnAt = liveTurnStartedAt(branch.slice(conversationStart));
	const since = [pendingTaskCallAt, liveTurnAt].filter((at): at is number => at !== undefined && Number.isFinite(at));
	return {
		current,
		named,
		held,
		clearedAt,
		waitsOnSpawnsSince: since.length > 0 ? Math.min(...since) : undefined,
		owedJobs,
		deliveredJobs,
	};
}

/**
 * Whether `sub` was spawned in its parent's current conversation, judged by `spawned`,
 * the parent's `task` results: one after the parent's last `/clear` on its active branch
 * names it. A result anywhere else (before that `/clear`, or on a branch the parent
 * left) places it in work the parent left behind. When no result names it, the parent's
 * process ended inside the call that spawned it, before the result was written: the
 * subagent's transcript then says when it was spawned, which must be after that `/clear`.
 */
function spawnedInCurrentConversation(sub: SubSession, spawned: SpawnedSubagents): boolean {
	if (spawned.current.has(sub.agentId)) return true;
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
	 * Whether `sub`'s own parent positively records that it still waits on `sub`'s turn that began
	 * at `turnStartedAt` (epoch ms): a result in its current conversation names `sub`'s run and none
	 * written since settles it, or no record names `sub` and the parent still waited on what it
	 * spawned when `sub` was spawned ({@link SpawnedSubagents.waitsOnSpawnsSince}). Missing records
	 * are not evidence: a parent can background a cell, leave a branch, or wait through another tool.
	 */
	parentStillWaits(sub: SubSession, turnStartedAt: number | undefined): boolean {
		const parent = this.#ofParent(sub.parent);
		if (!parent) return false;
		// A job result handed over (or being handed over: `delivered` is written first) never runs again;
		// a later turn the parent messaged the subagent for is a new run.
		const deliveredAt = parent.deliveredJobs.get(sub.agentId);
		if (deliveredAt !== undefined && !(turnStartedAt !== undefined && deliveredAt < turnStartedAt)) return false;
		if (parent.current.has(sub.agentId)) {
			const heldAt = parent.held.get(sub.agentId);
			if (heldAt === undefined) return true;
			// An unreadable or unknown time judges nothing, and the result stands.
			return turnStartedAt !== undefined && heldAt < turnStartedAt;
		}
		if (parent.named.has(sub.agentId) || parent.held.has(sub.agentId)) return false;
		if (parent.owedJobs.has(sub.agentId)) return true;
		const since = parent.waitsOnSpawnsSince;
		if (since === undefined || !sub.header) return false;
		const spawnedAt = Date.parse(sub.header.timestamp);
		return Number.isFinite(spawnedAt) && spawnedAt >= since;
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
