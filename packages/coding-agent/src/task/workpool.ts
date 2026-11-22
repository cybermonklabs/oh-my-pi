import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import workpoolBatchTemplate from "../prompts/tools/workpool-batch.md" with { type: "text" };
import workpoolTurnResultTemplate from "../prompts/tools/workpool-turn-result.md" with { type: "text" };
import { recordEvalAgentJobs } from "../eval/agent-job-records";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "../async/job-manager";
import { plainTurnAbortReason, turnAbortKind } from "../session/exit-diagnostics";
import type { CustomMessage } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../irc/messaging";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isCompletionProbeEnabled } from "./completion-probe";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import {
	type EffectiveSubagentPolicy,
	reserveStructuredSubagentId,
	runStructuredSubagent,
} from "./structured-subagent";
import { type AgentProgress, oneLineLabel, type SingleResult, type TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { EvalHeldAgentResult } from "@oh-my-pi/pi-tui/tools/eval";
import { TASK_LAUNCH_DISCARDED_CUSTOM_TYPE } from "./speculative-launch";
import { buildWorkPoolOutputSchema, type WorkPoolYieldItem } from "./workpool-yield";

import { cfgEvalWorkpoolFreshAgents } from "../eval/settings";
import { cfgTaskMaxConcurrency, cfgTaskMaxRuntimeMs } from "./settings";

/** One user-supplied unit tracked through a workpool batch. */
export interface WorkPoolItem {
	id: string;
	seq: number;
	text: string;
	agentId?: string;
	batchId?: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	/** The parent's top-level `eval` call whose cell pushed the item; a worker it starts records it. */
	spawnCallId?: string;
}

/** Keep-alive subagent and its queued work within a pool. */
export interface WorkPoolAgent {
	id: string;
	index: number;
	state: "running" | "idle" | "dead";
	queue: WorkPoolItem[];
	turns: number;
	contextTokens?: number;
	contextWindow?: number;
	jobId?: string;
	/** The call that pushed the item the worker was started for ({@link WorkPoolItem.spawnCallId}). */
	spawnCallId?: string;
}

/** One turn assigned to a pool agent and tracked as an internal job. */
export interface WorkPoolBatch {
	id: string;
	agentId: string;
	items: WorkPoolItem[];
	jobId: string;
	startedAt: number;
	status: "running" | "completed" | "failed" | "cancelled";
	output?: string;
}

/** Aggregate pool activity returned by `WorkPool.status()`. */
export interface WorkPoolStatus {
	name: string;
	agent: string;
	limit: number;
	closed: boolean;
	freshAgents: boolean;
	agents: Array<{
		id: string;
		state: WorkPoolAgent["state"];
		queued: number;
		turns: number;
		contextTokens?: number;
		contextWindow?: number;
		current?: string;
	}>;
	items: Record<WorkPoolItem["status"], number>;
	batches: number;
}

/** Non-consuming batch snapshot returned by `WorkPool.peek()`. */
export interface WorkPoolPeekResult {
	batches: Array<{
		id: string;
		agent: string;
		items: string[];
		status: WorkPoolBatch["status"];
		output?: string;
	}>;
	pending: number;
}

/** Resolved policy and optional shared context used to create a pool. */
export interface WorkPoolCreateOptions {
	name: string;
	/** Raw selector applied to each worker at creation, never to follow-up turns. */
	model?: string;
	policy: EffectiveSubagentPolicy;
	context?: string;
	customTools?: CustomTool[];
}

interface TurnOutcome {
	exitCode: number;
	output: string;
	error?: string;
	aborted?: boolean;
	extractedToolData?: Record<string, unknown[]>;
	abortReason?: string;
}

const DELIVERY_OUTPUT_LIMIT = 6_000;

/**
 * The workers whose latest batch settled, among `batches` (in the order they ran): the results a
 * pool hands over when it shows the cell a batch's output (`peek()`) or delivers its aggregate
 * result. A worker whose latest batch still runs owes that turn, so a handover of its earlier batch
 * settles nothing; a cancelled batch is an aborted run. `handedAt`, when given, is when the pool
 * drained (epoch ms): the aggregate result holds each worker's output as of then, so `omp
 * --restore` settles only the turns that began before it, wherever the result is later taken.
 */
export function settledWorkerResults(batches: WorkPoolPeekResult["batches"], handedAt?: number): EvalHeldAgentResult[] {
	const latest = new Map<string, WorkPoolPeekResult["batches"][number]>();
	for (const batch of batches) latest.set(batch.agent, batch);
	const results: EvalHeldAgentResult[] = [];
	for (const [id, batch] of latest) {
		if (batch.status === "running") continue;
		results.push({
			id,
			...(batch.status === "cancelled" ? { aborted: true } : {}),
			...(handedAt === undefined ? {} : { handedAt }),
		});
	}
	return results;
}

/** Dispatches queued items across keep-alive subagents under one aggregate job. */
export class WorkPool {
	readonly name: string;
	readonly ownerId: string;
	readonly session: ToolSession;
	readonly policy: EffectiveSubagentPolicy;
	readonly #model?: string;
	readonly context?: string;
	readonly customTools: CustomTool[];
	readonly freshAgents: boolean;
	readonly agents: WorkPoolAgent[] = [];
	readonly items: WorkPoolItem[] = [];
	readonly batches: WorkPoolBatch[] = [];
	closed = false;
	rrCursor = 0;

	#nextSeq = 1;
	#nextAgentIndex = 1;
	#lastCardTs = 0;
	#dispatchChain: Promise<void> = Promise.resolve();
	#poolJobStarted = false;
	readonly #drainWaiters: PromiseWithResolvers<void>[] = [];
	readonly #freshQueue: WorkPoolItem[] = [];
	/**
	 * The live manager's left-sessions mark when the pool was made: the sessions it leaves after this
	 * one can hold the pool's spawn records, and a stop looks at those only; see {@link #recordDiscards}.
	 */
	readonly #leftSessionsMark: number;
	/**
	 * The entry ids of the pool's spawn records (its workers' `owed` records). A copy of the transcript
	 * keeps them (a whole-session `/fork`; a fork, a branch or a `/btw` branch from a point after one of
	 * them; the move to a sibling file when another process holds the old one), so a session holds the
	 * pool's spawn records when it holds one of these entries. A copy from a point before the first of
	 * them holds none, and gets no discards.
	 */
	readonly #spawnEntryIds = new Set<string>();
	/** A stop's discards being written into sessions the live manager does not write now. */
	#discardsWritten: Promise<void> | undefined;

	constructor(session: ToolSession, options: WorkPoolCreateOptions) {
		this.name = options.name;
		this.ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		this.session = session;
		this.policy = options.policy;
		this.#model = options.model;
		this.context = options.context;
		this.customTools = options.customTools ?? [];
		this.freshAgents = cfgEvalWorkpoolFreshAgents.get(session.settings);
		this.#leftSessionsMark = session.sessionManager?.getLeftSessionsMark?.() ?? 0;
		if (!session.asyncJobManager) {
			throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		}
		if (session.asyncJobManager.getJob(this.name)) {
			throw new ToolError(`workpool job id "${this.name}" already exists`);
		}
	}

	/** Current worker ceiling from the live `task.maxConcurrency` setting. */
	limit(): number {
		const configured = cfgTaskMaxConcurrency.get(this.session.settings);
		return configured > 0 ? configured : Infinity;
	}

	/**
	 * Queue items and start the aggregate pool job on the first non-empty push. `spawnCallId` is the
	 * parent's top-level `eval` call the pushing cell runs under.
	 */
	push(texts: string[], spawnCallId?: string): string[] {
		if (this.closed) throw new ToolError(`workpool ${this.name} is closed`);
		if (texts.length === 0) return [];
		const queued: WorkPoolItem[] = [];
		for (const text of texts) {
			const seq = this.#nextSeq++;
			const item: WorkPoolItem = { id: `${this.name}#${seq}`, seq, text, status: "queued", spawnCallId };
			this.items.push(item);
			queued.push(item);
		}
		this.#ensurePoolJob();
		for (const item of queued) this.#queueDispatch(item);
		return queued.map(item => item.id);
	}

	#ensurePoolJob(): void {
		if (this.#poolJobStarted) return;
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		if (manager.getJob(this.name)) throw new ToolError(`workpool job id "${this.name}" already exists`);
		this.#poolJobStarted = true;
		const id = manager.register(
			"task",
			this.name,
			async ({ signal, reportProgress }) => {
				const onAbort = (): void => {
					this.close();
					// A stop of the pool (a kill, the user's stop) ends its work for the owner: each worker's spawn is
					// recorded discarded, so `omp --restore` relaunches none. That covers a worker whose batch had
					// already failed on its key: its batch settled, so the cancel below cannot stop it, and the stopped
					// pool hands no result over. A shutdown (the manager's shutdown reason) or a cut-off cuts the workers
					// off instead, and `--restore` goes on with them.
					if (signal.reason !== ASYNC_JOB_MANAGER_SHUTDOWN_REASON && turnAbortKind(signal.reason) === "stop") {
						const workers = new Set([
							...this.batches.map(batch => batch.agentId),
							...this.agents.map(agent => agent.id),
						]);
						this.#recordDiscards([...workers]);
					}
					// Each batch aborts with the pool's own reason, so its subagent stops when the owner
					// cancelled the pool and is cut off when the session's process went away.
					for (const batch of this.batches) manager.cancel(batch.jobId, { ownerId: this.ownerId }, signal.reason);
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				try {
					await this.#waitForDrain();
					const batchIds = this.batches.map(batch => batch.jobId);
					await Promise.allSettled(
						batchIds.flatMap(batchId => {
							const job = manager.getJob(batchId);
							return job ? [job.promise] : [];
						}),
					);
					manager.consumeJobResults(batchIds);
					manager.unwatchJobs(batchIds);
					this.closed = true;
					await this.#discardsWritten;
					// The aggregate result hands the owner every worker's output as of now. It reaches the owner only
					// as the job's delivery, a `wait` or a kill of the job, so the job's report names those workers
					// (`agentResults`) and `omp --restore` reads each such handover there: a process end before the
					// owner takes the result leaves the workers owed, and a worker whose key failed goes on. The
					// report carries the time it drained (`handedAt`), not the time of the entry that later returns
					// it: a turn a kept-alive worker begins after the drain (an IRC message woke it) is not in the
					// result, and stays owed.
					const drainedAt = Date.now();
					const summary = `Pool \`${this.name}\` drained: ${this.items.length} item(s), ${this.batches.length} batch(es).`;
					this.#card(signal.aborted ? "cancelled" : "completed", this.ownerId, summary);
					await reportProgress(summary, { agentResults: settledWorkerResults(this.peek().batches, drainedAt) });
					return this.#renderAggregateResult();
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			},
			{ id: this.name, ownerId: this.ownerId, queued: true },
		);
		if (id !== this.name) {
			// A stop of a job no batch runs under yet.
			manager.cancel(id, { ownerId: this.ownerId }, plainTurnAbortReason("stop"));
			throw new ToolError(`workpool job id "${this.name}" is unavailable`);
		}
	}

	/**
	 * Record the spawns of `agentIds` as discarded in each session whose transcript holds the pool's
	 * spawn records, decided by session, not by file path:
	 * - the live session, through its manager, when its transcript holds one of the pool's spawn
	 *   records: the session the pool was made in (also after `/move` or `/worktree` renamed its
	 *   file), or a copy that kept them (a whole-session `/fork`, a fork, a branch or a `/btw` branch
	 *   from a point after one of them, the move to a new file when another process holds the old one);
	 * - by id, every session the live manager left since the pool was made (a `/resume` points the
	 *   manager at the resumed file before it cancels the session's jobs; a fork, a branch, `/btw` or a
	 *   move leaves the session it copied, and a branch from a user message that is the session's first
	 *   entry leaves it for an empty one), at the file it last left each at, each only when its header
	 *   names that session and its transcript holds one of the pool's spawn records.
	 * A write that cannot happen (another live process owns the session, the path holds another
	 * session, the file is gone) is logged and skipped: that session then keeps those workers owed,
	 * and its `--restore` can relaunch one that ended on its key.
	 */
	#recordDiscards(agentIds: readonly string[]): void {
		if (agentIds.length === 0) return;
		const records = agentIds.map(agentId => ({ customType: TASK_LAUNCH_DISCARDED_CUSTOM_TYPE, data: { agentId } }));
		const live = this.session.sessionManager;
		const liveId = live?.getSessionId?.();
		if (live?.getEntries().some(entry => this.#spawnEntryIds.has(entry.id))) {
			for (const record of records) live.appendCustomEntry(record.customType, record.data);
		}
		const others = (live?.getLeftSessions?.(this.#leftSessionsMark) ?? []).filter(left => left.id !== liveId);
		if (others.length === 0) return;
		const holding = [...this.#spawnEntryIds];
		const writes = others.map(async ({ id: sessionId, file: sessionFile }) => {
			try {
				const outcome = live?.appendCustomEntriesToSession
					? await live.appendCustomEntriesToSession(sessionId, sessionFile, records, { holding })
					: await SessionManager.appendCustomEntriesToFile(sessionId, sessionFile, records, undefined, {
							holding,
						});
				if (outcome === "refused") {
					logger.warn("workpool: could not record its stopped workers' discards", {
						pool: this.name,
						sessionId,
						sessionFile,
					});
				}
			} catch (error) {
				logger.warn("workpool: could not record its stopped workers' discards", {
					pool: this.name,
					sessionId,
					sessionFile,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		this.#discardsWritten = Promise.all(writes).then(() => {});
	}

	async #waitForDrain(): Promise<void> {
		if (this.#isDrained()) return;
		const waiter = Promise.withResolvers<void>();
		this.#drainWaiters.push(waiter);
		await waiter.promise;
	}

	#isDrained(): boolean {
		return !this.items.some(item => item.status === "queued" || item.status === "running");
	}

	#notifyDrained(): void {
		if (!this.#isDrained()) return;
		for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve();
	}

	#queueDispatch(item: WorkPoolItem): void {
		this.#dispatchChain = this.#dispatchChain
			.then(() => this.#dispatch(item))
			.catch(error => {
				if (item.status === "queued") item.status = "failed";
				logger.warn("workpool: item dispatch failed", {
					pool: this.name,
					item: item.id,
					error: error instanceof Error ? error.message : String(error),
				});
				this.#notifyDrained();
			});
	}

	#contextLoad(agent: WorkPoolAgent): number {
		const tokens = agent.contextTokens ?? 0;
		const window = agent.contextWindow;
		return window !== undefined && window > 0 ? tokens / window : tokens;
	}

	#leastLoadedIdle(): WorkPoolAgent | undefined {
		let selected: WorkPoolAgent | undefined;
		let selectedLoad = Infinity;
		for (const agent of this.agents) {
			if (agent.state !== "idle") continue;
			const load = this.#contextLoad(agent);
			if (load >= selectedLoad) continue;
			selected = agent;
			selectedLoad = load;
		}
		return selected;
	}

	async #dispatch(item: WorkPoolItem): Promise<void> {
		if (this.closed || item.status !== "queued") return;
		if (this.freshAgents) {
			if (this.agents.length < this.limit()) {
				await this.#spawn(item);
			} else {
				this.#freshQueue.push(item);
				this.#card("queued", this.name, `[${item.id}] ${item.text}`);
			}
			return;
		}
		const idle = this.#leastLoadedIdle();
		if (idle) {
			item.agentId = idle.id;
			idle.queue.push(item);
			this.#card("dispatched", idle.id, `[${item.id}] ${item.text}`);
			this.#drain(idle);
			return;
		}
		if (this.agents.length < this.limit()) {
			await this.#spawn(item);
			return;
		}
		const busy = this.#nextBusy();
		if (!busy) {
			await this.#spawn(item);
			return;
		}
		item.agentId = busy.id;
		busy.queue.push(item);
		this.#card("queued", busy.id, `[${item.id}] ${item.text}`);
	}

	async #spawn(item: WorkPoolItem): Promise<void> {
		const index = this.#nextAgentIndex++;
		const id = await reserveStructuredSubagentId(this.session, { label: `${this.name}-${index}` });
		if (this.closed || item.status !== "queued") return;
		// The worker's run is owed to the pool's owner until a result of its batch is handed over: record that,
		// on disk, before the worker starts, so `omp --restore` relaunches a worker the owner still waits on
		// after the call that pushed the work has finished. A `peek` that returns the worker's latest batch
		// settled writes the handover that settles it; the aggregate result settles it where the owner takes it
		// (its delivery, a `wait`, a kill), whose report names the worker.
		for (const entryId of await recordEvalAgentJobs(this.session, [id], "owed")) this.#spawnEntryIds.add(entryId);
		if (this.closed || item.status !== "queued") return;
		const agent: WorkPoolAgent = {
			id,
			index,
			state: "running",
			queue: [item],
			turns: 0,
			spawnCallId: item.spawnCallId,
		};
		item.agentId = id;
		this.agents.push(agent);
		this.#card("spawned", id, `[${item.id}] ${item.text}`);
		this.#drain(agent);
	}

	#nextBusy(): WorkPoolAgent | undefined {
		if (this.agents.length === 0) return undefined;
		for (let offset = 0; offset < this.agents.length; offset++) {
			const index = (this.rrCursor + offset) % this.agents.length;
			const agent = this.agents[index];
			if (agent?.state === "running") {
				this.rrCursor = (index + 1) % this.agents.length;
				return agent;
			}
		}
		return undefined;
	}

	#drain(agent: WorkPoolAgent): void {
		if (agent.queue.length === 0) {
			agent.state = "idle";
			this.#notifyDrained();
			return;
		}
		const items = agent.queue.splice(0);
		const id = `${agent.id}-b${agent.turns + 1}`;
		const batch: WorkPoolBatch = {
			id,
			agentId: agent.id,
			items,
			jobId: id,
			startedAt: Date.now(),
			status: "running",
		};
		for (const item of items) {
			item.status = "running";
			item.agentId = agent.id;
			item.batchId = batch.id;
		}
		agent.state = "running";
		agent.jobId = batch.jobId;
		this.batches.push(batch);
		const message = this.#batchMessage(batch);
		if (agent.turns > 0) this.#card("batch", agent.id, message);
		this.#startTurn(agent, batch, message);
	}

	#batchMessage(batch: WorkPoolBatch): string {
		return prompt.render(workpoolBatchTemplate, {
			pool: this.name,
			batch: batch.id,
			items: batch.items.map((item, index) => ({ id: item.id, index: index + 1, text: item.text })),
		});
	}

	#startTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, message: string): void {
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		const workPoolYieldItems: WorkPoolYieldItem[] = batch.items.map((item, index) => ({
			id: item.id,
			index: index + 1,
		}));
		const outputSchema = buildWorkPoolOutputSchema(workPoolYieldItems);
		const jobId = manager.register(
			"task",
			batch.id,
			async ({ signal, reportProgress, markRunning }) => {
				markRunning();
				const onProgress = (progress: AgentProgress): void => {
					if (progress.contextTokens !== undefined) agent.contextTokens = progress.contextTokens;
					if (progress.contextWindow !== undefined) agent.contextWindow = progress.contextWindow;
					const details: TaskToolDetails = {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: Date.now() - batch.startedAt,
						progress: [progress],
					};
					void reportProgress(`Running agent ${agent.id}...`, { ...details });
				};
				let result: SingleResult;
				try {
					if (agent.turns === 0) {
						const execution = await runStructuredSubagent({
							session: this.session,
							invocationKind: "eval",
							spawnCallId: agent.spawnCallId,
							assignment: message,
							...(this.context ? { context: this.context } : {}),
							agent: this.policy.agentName,
							...(this.#model !== undefined ? { perCallModel: this.#model } : {}),
							identity: { id: agent.id },
							customTools: this.customTools,
							outputSchema,
							schemaMode: "strict",
							workPoolYieldItems,
							keepAlive: true,
							retainArtifacts: true,
							enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
							signal,
							onProgress,
						});
						result = execution.result;
					} else {
						// A kept-alive worker's later batch holds items later calls pushed: the run is owed for those
						// calls, on disk before the turn starts, so `omp --restore` matches a cut-off one of them to it
						// (its spawn record names only the call that pushed its first item).
						const callIds = [
							...new Set(batch.items.flatMap(item => (item.spawnCallId ? [item.spawnCallId] : []))),
						];
						for (const entryId of await recordEvalAgentJobs(this.session, [agent.id], "owed", callIds)) {
							this.#spawnEntryIds.add(entryId);
						}
						result = await runSubagentFollowUpTurn({
							id: agent.id,
							agent: this.policy.agent,
							message,
							outputSchema,
							outputSchemaMode: "strict",
							outputSchemaSource: "caller",
							workPoolYieldItems,
							signal,
							onProgress,
							eventBus: this.session.eventBus,
							subagentEventBus: this.session.subagentEventBus,
							artifactsDir: this.session.getSessionFile()?.slice(0, -6),
							maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.session.settings),
							completionProbe: isCompletionProbeEnabled(this.session.settings, this.session.taskDepth ?? 0),
							...softRequestBudgetFor(this.policy.agent.name, this.session.settings),
						});
					}
				} catch (error) {
					const output = error instanceof Error ? error.message : String(error);
					return this.#settleTurn(agent, batch, { exitCode: 1, output, error: output });
				}
				return this.#settleTurn(agent, batch, result);
			},
			{ id: batch.id, agentId: agent.id, ownerId: this.ownerId },
		);
		batch.jobId = jobId;
		agent.jobId = jobId;
		manager.watchJobs([jobId]);
	}

	async #settleTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): Promise<string> {
		await this.#finishTurn(agent, batch, result);
		const delivery = this.#renderTurnResult(agent, batch, result);
		if (batch.status !== "completed") throw new Error(delivery);
		return delivery;
	}

	async #finishTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): Promise<void> {
		batch.status = result.aborted ? "cancelled" : result.exitCode !== 0 || result.error ? "failed" : "completed";
		batch.output = result.output;
		const failedItems = new Set<string>();
		for (const yielded of result.extractedToolData?.yield ?? []) {
			if (!isRecord(yielded) || yielded.status !== "success" || typeof yielded.error !== "string") continue;
			if (Array.isArray(yielded.type) && yielded.type.length === 1 && typeof yielded.type[0] === "string") {
				failedItems.add(yielded.type[0]);
			}
		}
		for (const item of batch.items)
			item.status = batch.status === "completed" && failedItems.has(item.id) ? "failed" : batch.status;
		agent.turns++;
		agent.jobId = undefined;
		const ref = AgentRegistry.global().get(agent.id);
		// Retained idle workers can wake through IRC, so clear the runtime schema and cached inline declaration together.
		// A refresh failure must not strand the pool in #waitForDrain(): items are
		// already terminal, so keep the turn result, drop the worker instead of
		// reusing it with a stale keyed declaration, and still notify drain.
		let yieldCleared = true;
		try {
			await ref?.session?.setWorkPoolYieldItems([]);
		} catch (error) {
			yieldCleared = false;
			logger.warn("workpool: failed to clear yield contract", {
				pool: this.name,
				agent: agent.id,
				batch: batch.id,
				error: error instanceof Error ? error.message : String(error),
			});
			// The runtime already flipped to the ordinary schema while the prompt
			// still advertises the keyed one. The worker must not survive as a
			// messageable session: release the lifecycle adoption (guarded by the
			// registry ref so a newer same-id ref is never taken down) so neither
			// pool reuse nor an IRC wake can reach the inconsistent contract. The
			// tombstone keeps the ref terminal so a later persisted-agent scan
			// cannot resurrect the transcript as parked with a stale pooled
			// declaration and an empty runtime set.
			if (ref) {
				try {
					await AgentLifecycleManager.global().release(agent.id, ref, { tombstone: true });
				} catch (releaseError) {
					logger.warn("workpool: failed to release worker after yield clear failure", {
						pool: this.name,
						agent: agent.id,
						batch: batch.id,
						error: releaseError instanceof Error ? releaseError.message : String(releaseError),
					});
				}
			}
		}
		if (this.freshAgents) {
			agent.state = "dead";
			const index = this.agents.indexOf(agent);
			if (index !== -1) this.agents.splice(index, 1);
			const next = this.#freshQueue.shift();
			if (next) this.#queueDispatch(next);
			this.#notifyDrained();
			return;
		}
		if (yieldCleared && ref && (ref.status === "idle" || ref.status === "parked")) {
			this.#drain(agent);
		} else {
			agent.state = "dead";
			const stranded = agent.queue.splice(0);
			const index = this.agents.indexOf(agent);
			if (index !== -1) this.agents.splice(index, 1);
			for (const item of stranded) {
				item.agentId = undefined;
				item.batchId = undefined;
				this.#queueDispatch(item);
			}
		}
		this.#notifyDrained();
	}

	#renderAggregateResult(): string {
		const lines = [
			`Pool \`${this.name}\` completed (${this.items.length} item(s), ${this.batches.length} batch(es)).`,
		];
		for (const batch of this.batches) {
			lines.push("", `## ${batch.id} · agent \`${batch.agentId}\` · ${batch.status}`);
			for (const item of batch.items) {
				lines.push(`- [${item.id}] ${item.status} — ${oneLineLabel(item.text)}`);
			}
			const output = batch.output?.trim();
			if (output) lines.push("", output);
			lines.push(`Transcript: history://${batch.agentId} · full output: agent://${batch.agentId}`);
		}
		lines.push("", "Pool queue drained.");
		return lines.join("\n");
	}

	#renderTurnResult(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): string {
		const remaining = this.items.filter(item => item.status === "queued" || item.status === "running").length;
		const output = result.output.trim() || result.error || result.abortReason || "(no output)";
		const renderedOutput =
			output.length <= DELIVERY_OUTPUT_LIMIT
				? output
				: `${output.slice(0, DELIVERY_OUTPUT_LIMIT)}\n[output truncated to ${DELIVERY_OUTPUT_LIMIT} characters]`;
		return prompt.render(workpoolTurnResultTemplate, {
			pool: this.name,
			agent: agent.id,
			batch: batch.id,
			status: batch.status,
			count: batch.items.length,
			multiple: batch.items.length !== 1,
			items: batch.items.map(item => ({ id: item.id, status: item.status, text: oneLineLabel(item.text) })),
			output: renderedOutput,
			remaining,
		});
	}

	/** Return current workers, item counts, and context usage. */
	status(): WorkPoolStatus {
		const counts: WorkPoolStatus["items"] = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
		for (const item of this.items) counts[item.status]++;
		return {
			name: this.name,
			agent: this.policy.agentName,
			limit: this.limit(),
			closed: this.closed,
			freshAgents: this.freshAgents,
			agents: this.agents.map(agent => ({
				id: agent.id,
				state: agent.state,
				queued: agent.queue.length,
				turns: agent.turns,
				...(agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
				...(agent.contextWindow !== undefined ? { contextWindow: agent.contextWindow } : {}),
				...(agent.jobId ? { current: agent.jobId } : {}),
			})),
			items: counts,
			batches: this.batches.length,
		};
	}

	/** Return batch results without consuming the aggregate job delivery. */
	peek(): WorkPoolPeekResult {
		return {
			batches: this.batches.map(batch => ({
				id: batch.id,
				agent: batch.agentId,
				items: batch.items.map(item => item.id),
				status: batch.status,
				...(batch.output !== undefined ? { output: batch.output } : {}),
			})),
			pending: this.items.filter(item => item.status === "queued" || item.status === "running").length,
		};
	}

	/** Stop accepting work and cancel items not yet assigned to a turn. */
	close(): { dropped: string[] } {
		this.closed = true;
		const dropped: string[] = [];
		for (const item of this.items) {
			if (item.status !== "queued") continue;
			item.status = "cancelled";
			dropped.push(item.id);
		}
		for (const agent of this.agents) agent.queue.splice(0);
		this.#freshQueue.splice(0);
		this.#notifyDrained();
		return { dropped };
	}

	#card(
		mode: "spawned" | "dispatched" | "queued" | "batch" | "completed" | "cancelled",
		agentId: string,
		body: string,
	): void {
		const timestamp = Math.max(Date.now(), this.#lastCardTs + 1);
		this.#lastCardTs = timestamp;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:workpool",
			content: `[pool ${this.name} → ${agentId}]\n\n${body}`,
			display: true,
			details: { pool: this.name, from: `pool:${this.name}`, to: agentId, body, mode },
			attribution: "agent",
			timestamp,
		};
		try {
			AgentRegistry.global().get(this.ownerId)?.session?.emitIrcRelayObservation(record);
		} catch (error) {
			logger.debug("workpool: card emission failed", {
				pool: this.name,
				agent: agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Process-local workpool registry scoped by owner id and pool name. */
export class WorkPoolRegistry {
	static #instance: WorkPoolRegistry | undefined;

	/** Return the process-global workpool registry. */
	static global(): WorkPoolRegistry {
		WorkPoolRegistry.#instance ??= new WorkPoolRegistry();
		return WorkPoolRegistry.#instance;
	}

	/** Replace the global registry with an empty instance for tests. */
	static resetForTests(): void {
		WorkPoolRegistry.#instance = new WorkPoolRegistry();
	}

	readonly #pools = new Map<string, WorkPool>();

	#key(ownerId: string, name: string): string {
		return `${ownerId}\0${name}`;
	}

	/** Create a uniquely named pool for the session owner. */
	create(session: ToolSession, options: WorkPoolCreateOptions): WorkPool {
		const ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const key = this.#key(ownerId, options.name);
		if (this.#pools.has(key)) throw new ToolError(`workpool "${options.name}" already exists`);
		const pool = new WorkPool(session, options);
		this.#pools.set(key, pool);
		return pool;
	}

	/** Find one pool without creating it. */
	get(ownerId: string, name: string): WorkPool | undefined {
		return this.#pools.get(this.#key(ownerId, name));
	}

	/** Close and forget every pool owned by an ending session. */
	releaseOwner(ownerId: string): void {
		for (const [key, pool] of this.#pools) {
			if (pool.ownerId !== ownerId) continue;
			pool.close();
			this.#pools.delete(key);
		}
	}
}
