/**
 * Worker-side {@link AsyncJobManagerApi} over the root's main-thread manager.
 *
 * Every query and command runs on main: synchronous methods through
 * `callSync`, async ones through `call`. Job rows come back as
 * {@link RemoteAsyncJob}s built from {@link AsyncJobWire} projections, with
 * local equivalents of the live fields:
 *
 * - `promise` resolves when main's run promise settles (one `whenSettled`
 *   call per job id while anyone awaits it);
 * - `abortController` is a local controller aborted with main's reason;
 * - `process` and `widgetInputs` are the original live objects for jobs this
 *   worker registered, and a pids snapshot otherwise;
 * - assigning `retainedArtifactsCleanup` forwards the closure to main's row.
 *
 * A job registered here keeps its body in this thread: main calls the `run`
 * function across the link and aborts it through the run context's signal.
 * Its `process` / `widgetInputs` stay here too; main reads them through a
 * {@link WireJobFeed} whose pulls and final push this module answers. The
 * exported `run` runs its body once and keeps none of it afterwards, and the
 * feed lets go of the inputs after its final push; only the manager keeps
 * them, for as long as {@link LOCAL_INPUTS_RETENTION_MS} says, and attaches
 * them only to a row of the registration they came with (its
 * `registrationId`): a later job main gives the same id gets none of them.
 */
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type {
	AsyncJob,
	AsyncJobDeliverySink,
	AsyncJobDeliveryState,
	AsyncJobDetails,
	AsyncJobFilter,
	AsyncJobManagerApi,
	AsyncJobProcess,
	AsyncJobReapResult,
	AsyncJobRegisterOptions,
	AsyncJobRun,
	AsyncJobRunContext,
	AsyncJobRunResult,
	AsyncJobType,
} from "../../async/job-manager";
import type { JobTextSource, JobWidgetInputs, JobWidgetRegistry } from "../../job-widgets/types";
import { type RemoteObject, RpcClosedError } from "../rpc";
import {
	type AsyncJobManagerProtocol,
	type AsyncJobWire,
	fromWireSignal,
	type JobFeedDelta,
	type JobFeedSource,
	toWireReason,
	type WireJobFeed,
	type WireJobRun,
	type WireRegisterOptions,
	type WireRunContext,
} from "./async-jobs-protocol";
import { ignoreSettle, localUnsubscribe } from "./support";

/**
 * How long a settled job's live `process` / `widgetInputs` stay readable here
 * (e.g. `proc://<id>/streams` after the job ended). Longer than main's default
 * row retention, so the row is gone first. A released foreground job's go at
 * the later of its release and its settle, when main discards its row; a
 * release main did not take (it promoted the job first) leaves them.
 */
const LOCAL_INPUTS_RETENTION_MS = 10 * 60 * 1000;

type Remote = RemoteObject<AsyncJobManagerProtocol>;

/** Live inputs of a job registered from this worker. */
interface LocalInputs {
	readonly process?: AsyncJobProcess;
	readonly widgetInputs?: JobWidgetInputs;
}

/** A job registered from this worker with live inputs, and which of main's rows they belong to. */
interface LocalJob {
	readonly inputs: LocalInputs;
	/** Main's {@link AsyncJobWire.registrationId} of the row this worker registered. */
	readonly registrationId: number;
	/** Released while it ran, and main took the release: its inputs go when its run settles. */
	released: boolean;
}

/** Reads a worker job's live inputs as {@link JobFeedDelta}s: each source's text since the last read. */
class WorkerJobFeed {
	#inputs: LocalInputs;
	readonly #offsets = new Map<string, { source: JobTextSource; end: number; open: boolean }>();

	constructor(inputs: LocalInputs) {
		this.#inputs = inputs;
	}

	wire(): WireJobFeed {
		const { process, widgetInputs } = this.#inputs;
		return {
			process: process ? { command: process.command, cwd: process.cwd } : undefined,
			brief: widgetInputs?.brief(),
			pull: () => this.delta(),
		};
	}

	delta(): JobFeedDelta {
		const { process, widgetInputs } = this.#inputs;
		if (!widgetInputs) return { pids: process ? [...process.pids()] : undefined };
		const sources: JobFeedSource[] = [];
		for (const source of widgetInputs.sources()) {
			const known = this.#offsets.get(source.id);
			const reset = known !== undefined && known.source !== source;
			const from = known && !reset ? known.end : 0;
			const chunk = source.read(from);
			this.#offsets.set(source.id, { source, end: chunk.end, open: chunk.open });
			if (chunk.text.length === 0 && known && !reset && known.open === chunk.open) continue;
			sources.push({
				id: source.id,
				label: source.label,
				text: chunk.text,
				open: chunk.open,
				...(reset ? { reset: true } : {}),
			});
		}
		return { pids: process ? [...process.pids()] : undefined, brief: widgetInputs.brief(), sources };
	}

	/** Let go of the inputs once main has the final delta; a late pull reads none. */
	close(): void {
		this.#inputs = {};
		this.#offsets.clear();
	}
}

/** Worker-side job row: a projection of main's row plus local stand-ins for its live fields. */
export class RemoteAsyncJob implements AsyncJob {
	readonly id: string;
	readonly type: AsyncJobType;
	readonly status: AsyncJob["status"];
	readonly startTime: number;
	readonly endTime?: number;
	readonly label: string;
	readonly intent?: string;
	readonly resultText?: string;
	readonly errorText?: string;
	readonly structured?: AsyncJob["structured"];
	readonly progressText?: string;
	readonly latestDetails?: AsyncJobDetails;
	readonly ownerId?: string;
	readonly agentId?: string;
	readonly agentOutputPublished?: boolean;
	readonly queued?: boolean;
	readonly foreground?: boolean;
	readonly process?: AsyncJobProcess;
	readonly widgetInputs?: JobWidgetInputs;
	readonly #manager: RemoteAsyncJobManager;
	#cleanup: (() => Promise<void>) | undefined;

	constructor(manager: RemoteAsyncJobManager, wire: AsyncJobWire, local: LocalInputs | undefined) {
		this.#manager = manager;
		this.id = wire.id;
		this.type = wire.type;
		this.status = wire.status;
		this.startTime = wire.startTime;
		this.endTime = wire.endTime;
		this.label = wire.label;
		this.intent = wire.intent;
		this.resultText = wire.resultText;
		this.errorText = wire.errorText;
		this.structured = wire.structured;
		this.progressText = wire.progressText;
		this.latestDetails = wire.latestDetails;
		this.ownerId = wire.ownerId;
		this.agentId = wire.agentId;
		this.agentOutputPublished = wire.agentOutputPublished;
		this.queued = wire.queued;
		this.foreground = wire.foreground;
		const pids = wire.process?.pids ?? [];
		this.process =
			local?.process ??
			(wire.process ? { command: wire.process.command, cwd: wire.process.cwd, pids: () => pids } : undefined);
		this.widgetInputs = local?.widgetInputs;
	}

	/** Settles when main's run promise settles; never rejects. */
	get promise(): Promise<void> {
		return this.#manager.whenSettled(this.id);
	}

	/** Local controller aborted when main aborts the job. */
	get abortController(): AbortController {
		return this.#manager.controllerFor(this.id);
	}

	get retainedArtifactsCleanup(): (() => Promise<void>) | undefined {
		return this.#cleanup;
	}

	/** Hands the cleanup to main's row, which runs it on eviction. */
	set retainedArtifactsCleanup(cleanup: (() => Promise<void>) | undefined) {
		this.#cleanup = cleanup;
		this.#manager.setRetainedArtifactsCleanup(this.id, cleanup);
	}
}

/** Worker-side {@link JobWidgetRegistry} over the root's main-thread widgets. */
class RemoteJobWidgets implements JobWidgetRegistry {
	readonly #remote: Remote;

	constructor(remote: Remote) {
		this.#remote = remote;
	}

	view(job: AsyncJob): JobWidgetView | undefined {
		return this.#remote.callSync("widgetView", job.id);
	}

	caption(job: AsyncJob): string | undefined {
		return this.#remote.callSync("widgetCaption", job.id);
	}

	requestCaption(job: AsyncJob): void {
		this.#remote.notify("widgetRequestCaption", job.id);
	}

	subscribe(listener: () => void): () => void {
		return localUnsubscribe(this.#remote.callSync("widgetSubscribe", listener));
	}

	forget(jobId: string): void {
		this.#remote.notify("widgetForget", jobId);
	}

	/** The root session owns the widgets; a worker never disposes them. */
	dispose(): void {}
}

/**
 * A worker job body's run context over main's. Module-level, so a body that keeps its context
 * keeps no scope of `register` or of the exported run.
 */
function localRunContext(ctx: WireRunContext): AsyncJobRunContext {
	return {
		jobId: ctx.jobId,
		signal: fromWireSignal(ctx.signal),
		reportProgress: ctx.reportProgress,
		markRunning: () => ignoreSettle(ctx.markRunning()),
	};
}

/** Worker-side root job manager; see the module doc. */
export class RemoteAsyncJobManager implements AsyncJobManagerApi {
	readonly #remote: Remote;
	readonly #local = new Map<string, LocalJob>();
	/** Retention timers of settled jobs' local inputs, by id; each captures only its id. */
	readonly #expiry = new Map<string, NodeJS.Timeout>();
	readonly #settled = new Map<string, Promise<void>>();
	readonly #controllers = new Map<string, AbortController>();
	#widgets: RemoteJobWidgets | null | undefined;

	constructor(remote: Remote) {
		this.#remote = remote;
	}

	get widgets(): JobWidgetRegistry | undefined {
		if (this.#widgets === undefined) {
			this.#widgets = this.#remote.callSync("hasWidgets") ? new RemoteJobWidgets(this.#remote) : null;
		}
		return this.#widgets ?? undefined;
	}

	get atCapacity(): boolean {
		return this.#remote.callSync("atCapacity");
	}

	onJobSettled(listener: () => void): () => void {
		return localUnsubscribe(this.#remote.callSync("onJobSettled", listener));
	}

	register(type: AsyncJobType, label: string, run: AsyncJobRun, options?: AsyncJobRegisterOptions): string {
		const inputs: LocalInputs | undefined =
			options?.process || options?.widgetInputs
				? { process: options.process, widgetInputs: options.widgetInputs }
				: undefined;
		const feed = inputs ? new WorkerJobFeed(inputs) : undefined;
		// One-shot: main runs each body once, and the exported `wired` keeps none of it afterwards.
		let pending: { readonly run: AsyncJobRun; readonly feed: WorkerJobFeed | undefined } | undefined = {
			run,
			feed,
		};
		const wired: WireJobRun = async ctx => {
			const body = pending;
			pending = undefined;
			if (!body) throw new Error(`Job ${ctx.jobId} already ran`);
			try {
				return await body.run(localRunContext(ctx));
			} finally {
				if (body.feed) {
					// Sent ahead of the result, so main's final widget read sees the job's last output.
					if (ctx.pushFeed) ignoreSettle(ctx.pushFeed(body.feed.delta()));
					body.feed.close();
					this.#settleLocal(ctx.jobId);
				}
			}
		};
		const wireOptions: WireRegisterOptions = {
			id: options?.id,
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			onProgress: options?.onProgress,
			queued: options?.queued,
			foreground: options?.foreground,
			intent: options?.intent,
			feed: feed?.wire(),
		};
		const { id, registrationId } = this.#remote.callSync("register", type, label, wired, wireOptions);
		// A reused id (a released foreground job's, an evicted job's) drops what the earlier job left here.
		this.#dropLocal(id);
		if (inputs) this.#local.set(id, { inputs, registrationId, released: false });
		return id;
	}

	publishCompleted(
		type: AsyncJobType,
		label: string,
		result: AsyncJobRunResult,
		options: { id?: string; ownerId?: string; agentId?: string },
	): string {
		const id = this.#remote.callSync("publishCompleted", type, label, result, options);
		// A reused id drops what the earlier job left here; a published row has no live inputs.
		this.#dropLocal(id);
		return id;
	}

	cancel(id: string, filter?: AsyncJobFilter, reason?: unknown): boolean {
		return this.#remote.callSync("cancel", id, filter, toWireReason(reason));
	}

	getJob(id: string): AsyncJob | undefined {
		const wire = this.#remote.callSync("getJob", id);
		if (!wire) {
			this.#dropLocal(id);
			return undefined;
		}
		return this.#row(wire);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#rows(this.#remote.callSync("getRunningJobs", filter));
	}

	getRecentJobs(limit?: number, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#rows(this.#remote.callSync("getRecentJobs", limit, filter));
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#rows(this.#remote.callSync("getAllJobs", filter));
	}

	backgroundJob(jobId: string): boolean {
		return this.#remote.callSync("backgroundJob", jobId);
	}

	/**
	 * As main discards the row of a release it takes, a foreground job's local inputs go at the later
	 * of that release and its settle. A release main does not take (it promoted the job first, or has
	 * no such row) leaves them, with the background row main keeps. With the link to main closed, main's
	 * row is gone too, and so are they.
	 */
	releaseForegroundJob(jobId: string): void {
		let taken: boolean;
		try {
			taken = this.#remote.callSync("releaseForegroundJob", jobId);
		} catch (error) {
			if (!(error instanceof RpcClosedError)) throw error;
			this.#dropLocal(jobId);
			return;
		}
		if (!taken) return;
		const local = this.#local.get(jobId);
		if (!local) return;
		// A retention timer runs only for a settled job.
		if (this.#expiry.has(jobId)) this.#dropLocal(jobId);
		else local.released = true;
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		return this.#remote.callSync("getDeliveryState", filter);
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.#remote.callSync("hasPendingDeliveries", filter);
	}

	watchJobs(jobIds: string[]): number {
		return this.#remote.callSync("watchJobs", jobIds);
	}

	unwatchJobs(jobIds: string[]): number {
		return this.#remote.callSync("unwatchJobs", jobIds);
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		return this.#remote.callSync("acknowledgeDeliveries", jobIds);
	}

	consumeJobResults(jobIds: string[]): number {
		return this.#remote.callSync("consumeJobResults", jobIds);
	}

	isJobResultConsumed(jobId: string): boolean {
		return this.#remote.callSync("isJobResultConsumed", jobId);
	}

	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#remote.callSync("cancelAll", filter, toWireReason(reason));
	}

	evictCompletedJobs(filter?: AsyncJobFilter): number {
		return this.#remote.callSync("evictCompletedJobs", filter);
	}

	waitForAll(): Promise<void> {
		return this.#remote.call("waitForAll");
	}

	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		return localUnsubscribe(
			this.#remote.callSync("registerDeliverySink", ownerId, (jobId, text, job) =>
				sink(jobId, text, job ? this.#row(job) : undefined),
			),
		);
	}

	waitForOwnerJobs(ownerId: string, options?: { timeoutMs?: number; excludeSuppressed?: boolean }): Promise<boolean> {
		return this.#remote.call("waitForOwnerJobs", ownerId, options);
	}

	cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number, reason: unknown): Promise<AsyncJobReapResult> {
		return this.#remote.call("cancelAndReapOwnerJobs", ownerId, deadlineAt, toWireReason(reason));
	}

	drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		return this.#remote.call("drainDeliveries", options);
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#remote.callSync("isDeliverySuppressed", jobId);
	}

	isDeliveryPending(jobId: string): boolean {
		return this.#remote.callSync("isDeliveryPending", jobId);
	}

	isDeliverySuperseded(jobId: string): boolean {
		return this.#remote.callSync("isDeliverySuperseded", jobId);
	}

	/** One main `whenSettled` call per job id while it is pending; resolves (never rejects) on settle or link loss. */
	whenSettled(jobId: string): Promise<void> {
		let settled = this.#settled.get(jobId);
		if (!settled) {
			settled = this.#remote.call("whenSettled", jobId).then(
				() => {
					this.#settled.delete(jobId);
				},
				() => {
					this.#settled.delete(jobId);
				},
			);
			this.#settled.set(jobId, settled);
		}
		return settled;
	}

	/** Local controller for `jobId`, aborted with main's (unmapped) reason; one per job while it runs. */
	controllerFor(jobId: string): AbortController {
		const existing = this.#controllers.get(jobId);
		if (existing) return existing;
		const controller = new AbortController();
		const signal = this.#remote.callSync("signal", jobId);
		if (!signal) return controller;
		const local = fromWireSignal(signal);
		if (local.aborted) {
			controller.abort(local.reason);
			return controller;
		}
		this.#controllers.set(jobId, controller);
		local.addEventListener("abort", () => controller.abort(local.reason), { once: true });
		void this.whenSettled(jobId).then(() => {
			if (this.#controllers.get(jobId) === controller) this.#controllers.delete(jobId);
		});
		return controller;
	}

	/** Forward a row's `retainedArtifactsCleanup` assignment to main. */
	setRetainedArtifactsCleanup(jobId: string, cleanup: (() => Promise<void>) | undefined): void {
		this.#remote.notify("setRetainedArtifactsCleanup", jobId, cleanup);
	}

	/** A row of `wire`, with this worker's live inputs only when it is the row their registration made. */
	#row(wire: AsyncJobWire): RemoteAsyncJob {
		let local = this.#local.get(wire.id);
		if (local && local.registrationId !== wire.registrationId) {
			// Main gave the id to a later job: the inputs belong to a row that is gone.
			this.#dropLocal(wire.id);
			local = undefined;
		}
		return new RemoteAsyncJob(this, wire, local?.inputs);
	}

	#rows(wires: AsyncJobWire[]): AsyncJob[] {
		return wires.map(wire => this.#row(wire));
	}

	/**
	 * The run of `jobId` settled here: keep its inputs for the retention time, unless main took its
	 * release and still discards its row: no longer has it, or has it still in the foreground. With the
	 * link to main closed, main's row is gone too; the inputs go without an error that would replace
	 * the body's own outcome.
	 */
	#settleLocal(jobId: string): void {
		const local = this.#local.get(jobId);
		if (!local) return;
		if (local.released) {
			// Main may have promoted the job after it took the release; it keeps that row, and these stay with it.
			let row: AsyncJobWire | undefined;
			try {
				row = this.#remote.callSync("getJob", jobId);
			} catch (error) {
				if (!(error instanceof RpcClosedError)) throw error;
				this.#dropLocal(jobId);
				return;
			}
			if (row?.registrationId !== local.registrationId || row.foreground === true) {
				this.#dropLocal(jobId);
				return;
			}
		}
		const timer = setTimeout(() => this.#dropLocal(jobId), LOCAL_INPUTS_RETENTION_MS);
		timer.unref();
		this.#expiry.set(jobId, timer);
	}

	/** Forget the local inputs of `jobId` and stop its retention timer. */
	#dropLocal(jobId: string): void {
		clearTimeout(this.#expiry.get(jobId));
		this.#expiry.delete(jobId);
		this.#local.delete(jobId);
	}
}
