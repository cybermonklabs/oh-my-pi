/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn, or whose turn ended because its provider key could
 * not be resolved ({@link hasRestorableTurn}), was not killed (no tombstone), belongs
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
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import { endsOnCredentialUnavailableTurn, hasRestorableTurn } from "../session/exit-diagnostics";
import { activeBranch, type SessionEntry } from "../session/session-entries";
import { extractSessionInit, type SessionManager } from "../session/session-manager";
import { collectSubSessions, type SubSession } from "../session/sub-sessions";
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
	const restored: string[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		// The selected branch, as the subagent's own session reopens it: entries on other branches
		// (an abandoned turn, a `/clear` that was rolled back) are not its conversation.
		const branch = activeBranch(sub.entries, sub.leafId);
		if (sub.aborted || !hasRestorableTurn(branch)) continue;
		const id = sub.agentId;
		// A `/clear` or a move to another branch leaves the parent's earlier work behind: that work's
		// subagents are not the new conversation's, whose parent would get a result for a job it never started.
		if (!spawns.inCurrentConversation(sub)) {
			logger.debug("Interrupted subagent belongs to work its parent left; not restored", { id });
			continue;
		}
		if (endsOnCredentialUnavailableTurn(branch) && !spawns.awaitedByParent(sub, lastTurnStartedAt(branch))) {
			logger.debug("Subagent's parent holds its failed result; not restored", { id });
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
 * What a parent transcript records of the subagents its `task` calls spawned:
 * `current`, those its `task` results name in the conversation on the active branch
 * after its last `/clear` (`reset_boundary`); `named`, those of every `task` result,
 * on any branch; `held`, those whose result that conversation holds
 * ({@link heldResultAgentIds}), each with when its latest such result was written, in epoch ms.
 */
interface SpawnedSubagents {
	current: Set<string>;
	named: Set<string>;
	held: Map<string, number>;
	/** When that last `/clear` was written, in epoch ms; undefined without one. */
	clearedAt: number | undefined;
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
 * with its worker thread (`workerLost`) is not settled: when the parent's process goes away
 * inside the call, the agent loop still records such a result, and the subagent's turn
 * stays as its transcript left it (a stop of the run left an aborted record there, which
 * `--restore` leaves anyway).
 */
function heldResultAgentIds(entry: SessionEntry): string[] {
	if (entry.type === "custom_message") {
		return entry.customType === ASYNC_RESULT_MESSAGE_TYPE ? settledJobAgentIds(entry.details) : [];
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const { toolName, details } = entry.message;
	if (toolName === "task") {
		if (!isTaskToolDetails(details)) return [];
		return details.results.filter(result => !result.aborted && !result.workerLost).map(result => result.id);
	}
	return toolName === "wait" ? settledJobAgentIds(details) : [];
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

function readSpawnedSubagents(entries: readonly SessionEntry[], leafId: string | null): SpawnedSubagents {
	const named = new Set<string>();
	for (const entry of entries) for (const id of taskResultAgentIds(entry)) named.add(id);
	const current = new Set<string>();
	const held = new Map<string, number>();
	let clearedAt: number | undefined;
	const branch = activeBranch(entries, leafId);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "reset_boundary") {
			clearedAt = Date.parse(entry.timestamp);
			break;
		}
		for (const id of taskResultAgentIds(entry)) current.add(id);
		// Read from the leaf back: the first result naming a subagent is its latest.
		for (const id of heldResultAgentIds(entry)) if (!held.has(id)) held.set(id, Date.parse(entry.timestamp));
	}
	return { current, named, held, clearedAt };
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
	 * Whether `sub`'s own parent still waits on its turn that began at `turnStartedAt`
	 * (epoch ms): its current conversation holds no result that settles `sub`'s run
	 * ({@link heldResultAgentIds}) written since. A sync spawn's parent whose process ended
	 * inside the call has none: the call got no result, or the agent loop recorded the
	 * result of the run that exit cut off, or of one lost with its worker thread. Nor has
	 * the parent of a background spawn whose job result was never delivered. A result
	 * written before the turn began answered an earlier turn, one the parent then messaged
	 * `sub` to go on from.
	 */
	awaitedByParent(sub: SubSession, turnStartedAt: number | undefined): boolean {
		const heldAt = this.#ofParent(sub.parent)?.held.get(sub.agentId);
		if (heldAt === undefined) return true;
		// An unreadable or unknown time judges nothing, and the result stands.
		return turnStartedAt !== undefined && heldAt < turnStartedAt;
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
