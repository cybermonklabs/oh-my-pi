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
 * job had, so a parent waiting on that job finds it again.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { taskCardAgentIds } from "@oh-my-pi/pi-tui/tools/task";
import { AsyncJobError } from "../async";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { hasRestorableTurn } from "../session/exit-diagnostics";
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
		if (sub.aborted || !hasRestorableTurn(activeBranch(sub.entries, sub.leafId))) continue;
		const id = sub.agentId;
		// A `/clear` or a move to another branch leaves the parent's earlier work behind: that work's
		// subagents are not the new conversation's, whose parent would get a result for a job it never started.
		if (!spawns.inCurrentConversation(sub)) {
			logger.debug("Interrupted subagent belongs to work its parent left; not restored", { id });
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
 * The subagents a parent transcript's `task` calls spawned, as their results name them:
 * `current`, those of the conversation on the active branch after its last `/clear`
 * (`reset_boundary`); `named`, those of every `task` result, on any branch.
 */
interface SpawnedSubagents {
	current: Set<string>;
	named: Set<string>;
	/** When that last `/clear` was written, in epoch ms; undefined without one. */
	clearedAt: number | undefined;
}

/** The subagent ids a persisted `task` tool result names: its settled results and its spawns' progress. */
function taskResultAgentIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") return [];
	return taskCardAgentIds(entry.message.details);
}

function readSpawnedSubagents(entries: readonly SessionEntry[], leafId: string | null): SpawnedSubagents {
	const named = new Set<string>();
	for (const entry of entries) for (const id of taskResultAgentIds(entry)) named.add(id);
	const current = new Set<string>();
	let clearedAt: number | undefined;
	const branch = activeBranch(entries, leafId);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "reset_boundary") {
			clearedAt = Date.parse(entry.timestamp);
			break;
		}
		for (const id of taskResultAgentIds(entry)) current.add(id);
	}
	return { current, named, clearedAt };
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
 * The `task` results of each parent in a session's subagent tree, read when first
 * needed: the session's own from its open session manager (the parent is already
 * loaded, from whatever storage holds it), and each subagent's from the entries
 * {@link collectSubSessions} collected.
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
	 * behind are that work too. A parent whose transcript was not collected judges nothing.
	 */
	inCurrentConversation(sub: SubSession): boolean {
		let current: SubSession | undefined = sub;
		while (current) {
			const parentKey: string | null = current.parent;
			const spawned = parentKey === null ? this.#ofSession() : this.#ofSubagent(parentKey);
			if (spawned && !spawnedInCurrentConversation(current, spawned)) return false;
			current = parentKey === null ? undefined : this.#subSessions[parentKey];
		}
		return true;
	}

	#ofSession(): SpawnedSubagents {
		this.#session ??= readSpawnedSubagents(this.#sessionManager.getEntries(), this.#sessionManager.getLeafId());
		return this.#session;
	}

	#ofSubagent(key: string): SpawnedSubagents | undefined {
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
