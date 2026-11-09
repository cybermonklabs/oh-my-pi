/**
 * The periodic memory self-report: a session recording its own size, its box's remaining room
 * and its own work, onto the journal, where it survives the process being killed.
 *
 * A session on this fleet was killed by its box's cgroup limit at 104 GiB of anonymous memory
 * with no signal beforehand, and its container and cgroup went with it. Its journal survived,
 * and the entries either side of the kill read:
 *
 * ```
 * 16:09:10  last entry written
 *           (killed 16:13:33Z)
 * 16:19:39  first entry after the restart
 * ```
 *
 * Four minutes twenty-three seconds of silence, covering exactly the approach to the wall. That
 * measurement is why the sampler is driven by a **timer** and not only by turn boundaries: a
 * turn can run arbitrarily long, and the longest turns are the ones most likely to be
 * allocating. A record that stops writing four minutes before the event it exists to explain is
 * not a record of the event.
 *
 * The timer is `unref`'d, so it never holds the event loop open or delays a clean exit.
 */

import type { Settings } from "../config/settings";
import { AgentRegistry, type AgentRegistryApi } from "../registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { existingSubagentWorkerPool } from "../thread/subagent-worker";
import {
	type ProcessSample,
	type WorkCounters,
	type WorkerMemory,
	processIdentity,
	readCgroupMemory,
	readProcessResident,
	readThreadMemory,
} from "./memory-sample";
import { cfgMemorySampleEnabled, cfgMemorySampleIntervalMs } from "./memory-sampler-settings";

/**
 * How often a sample is taken when nothing else asks for one.
 *
 * Chosen against the measured 4 m 23 s silence, which is an observed example and not a worst
 * case: 30 s puts roughly nine samples across a gap like that one. Against the measured growth
 * rate of a large session, about 209 MiB/h, consecutive samples are about 1.7 MiB apart — far
 * finer than is needed to watch a process approach a cap.
 *
 * The costs are the other half of the choice, both measured on this box. An entry serialises to
 * about 960 bytes, so a 38-hour session writes roughly 4 560 samples and 4.4 MB — 2.5 % of a
 * real 178 MB session journal. A sample costs a median 0.13-0.18 ms of main-thread time, and
 * that figure is flat from an empty journal to 20 000 entries, because the counters advance
 * over only what is new rather than rescanning.
 */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * A sample triggered within this window of the previous one is dropped.
 *
 * Turn boundaries, compactions and the timer all ask for samples, and near a compaction all
 * three can land together. Bounding the rate keeps those from writing three near-identical
 * entries without weakening the interval guarantee, which is much coarser.
 */
const MIN_GAP_MS = 2_000;

/**
 * How long a subagent worker gets to answer before the sample is written without it.
 *
 * A worker running a subagent turn answers on its next event-loop turn, which is immediate; a
 * worker blocked in synchronous work may not answer at all. The sampler must never be the
 * reason a turn is slow, so a worker that misses this is recorded as `missing: "timeout"` and
 * the sample goes out with the main thread's numbers.
 */
const WORKER_DEADLINE_MS = 50;

/** Tool kinds listed individually in `work.topTools`. */
const TOP_TOOL_COUNT = 8;

export interface MemorySamplerOptions {
	sessionManager: SessionManager;
	/** Publishes the sample to extensions. Core produces the record; shipping it is extension work. */
	publish?: (sample: ProcessSample) => void;
	/** Overrides {@link DEFAULT_INTERVAL_MS}; `0` disables the timer and keeps the event triggers. */
	intervalMs?: number;
	/** Injected so tests need no global registry. */
	registry?: AgentRegistryApi;
}

/**
 * Owns one session's sampling: the timer, the cursor over the journal, and the running counters.
 *
 * Counters are accumulated by walking only the journal entries appended since the previous
 * sample. That keeps the sampler's total cost proportional to the entries a session writes
 * rather than to the journal's length, and it adds nothing at all to the tool call path — a
 * per-tool-call increment would be a cost on every call for a number needed every thirty
 * seconds.
 */
export class MemorySampler {
	readonly #sessionManager: SessionManager;
	readonly #publish: ((sample: ProcessSample) => void) | undefined;
	readonly #registry: AgentRegistryApi;
	readonly #timer: NodeJS.Timeout | undefined;

	/** Journal index the counters have been advanced through. */
	#cursor = 0;
	#seq = 0;
	#lastSampleAt = 0;
	#stopped = false;

	readonly #toolCounts = new Map<string, number>();
	#toolCalls = 0;
	#subagentDispatches = 0;
	#fileReads = 0;
	#compactions = 0;

	constructor(options: MemorySamplerOptions) {
		this.#sessionManager = options.sessionManager;
		this.#publish = options.publish;
		this.#registry = options.registry ?? AgentRegistry.global();

		const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		if (intervalMs > 0) {
			this.#timer = setInterval(() => this.sample("interval"), intervalMs);
			// Never hold the process open for a sample; a sampler that blocks exit is the worse defect.
			this.#timer.unref();
		}
		this.sample("start");
	}

	/** Stop sampling. Idempotent, and safe to call from a shutdown path. */
	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
	}

	/**
	 * Take a sample and append it to the journal.
	 *
	 * A `turn` or `interval` sample within {@link MIN_GAP_MS} of the last one is dropped, since
	 * near a compaction all three triggers can land together. `start` and `compaction` samples
	 * are never dropped: compaction brackets its work with a sample on each side, and that pair
	 * is what shows per session whether compaction returns memory or only stops sending text.
	 *
	 * Synchronous and non-throwing by construction: it is called from a timer, from a turn
	 * boundary and from the compaction path, and none of those may fail because a `/proc` file
	 * could not be read. Worker numbers are gathered separately and asynchronously.
	 */
	sample(reason: ProcessSample["reason"]): void {
		if (this.#stopped) return;
		const now = Date.now();
		const droppable = reason === "turn" || reason === "interval";
		if (droppable && now - this.#lastSampleAt < MIN_GAP_MS) return;
		this.#lastSampleAt = now;
		void this.#write(reason).catch(() => {
			// A self-report that throws would be a worse defect than one that misses an entry.
		});
	}

	async #write(reason: ProcessSample["reason"]): Promise<void> {
		// Everything the main thread actually spends is measured here, before any await. A single
		// timer around the whole method would include time yielded to the worker round trip, when
		// the event loop is running the session's real work — and would read as this sampler's
		// cost when it is not. A real session measured 1.9-5.3 ms that way against 0.13-0.18 ms
		// of main-thread time, which is the difference between a defensible number and a scary one.
		const started = performance.now();
		const cpu = process.cpuUsage();
		const measured = {
			identity: processIdentity(),
			// Claimed before the first await: two samples in flight together must not share a seq.
			seq: ++this.#seq,
			reason,
			uptimeMs: Math.round(process.uptime() * 1000),
			cpu: { userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000) },
			process: readProcessResident(),
			cgroup: readCgroupMemory(),
			main: readThreadMemory("main"),
			work: this.#work(existingSubagentWorkerPool()?.workers().length ?? 0),
		};
		const costMs = Math.round((performance.now() - started) * 1000) / 1000;

		const waitStarted = performance.now();
		const workers = await this.#readWorkers();
		const workerWaitMs = Math.round((performance.now() - waitStarted) * 1000) / 1000;

		const sample: ProcessSample = { ...measured, workers, costMs, workerWaitMs };
		this.#sessionManager.appendProcessSample(sample);
		this.#publish?.(sample);
	}

	/**
	 * Each live subagent worker's own VM numbers, raced against {@link WORKER_DEADLINE_MS}.
	 *
	 * Workers are separate JSC VMs at roughly 270 MiB each, so without them the record cannot see
	 * where the memory is. But a worker that cannot answer must cost nothing: its absence is a
	 * recorded field, which is strictly better than a sample that never arrives.
	 */
	async #readWorkers(): Promise<WorkerMemory[]> {
		const pool = existingSubagentWorkerPool();
		if (!pool) return [];
		const live = pool.workers();
		if (live.length === 0) return [];
		return await Promise.all(
			live.map(async (worker): Promise<WorkerMemory> => {
				const absent = (missing: WorkerMemory["missing"]): WorkerMemory => ({
					thread: worker.threadId,
					jscHeapBytes: null,
					jscFootprintBytes: null,
					pageFaults: null,
					cpuMs: null,
					heapUsedBytes: null,
					heapTotalBytes: null,
					externalBytes: null,
					load: worker.load,
					missing,
				});
				if (!worker.alive || !worker.booted) return absent("gone");
				const deadline = Promise.withResolvers<null>();
				const timer = setTimeout(() => deadline.resolve(null), WORKER_DEADLINE_MS);
				timer.unref();
				try {
					const answer = await Promise.race([worker.link.call("memorySample"), deadline.promise]);
					if (!answer) return absent("timeout");
					// The worker names itself `worker`; main holds the authoritative slot id.
					return { ...answer, thread: worker.threadId, load: worker.load };
				} catch {
					return absent(worker.alive ? "error" : "gone");
				} finally {
					clearTimeout(timer);
				}
			}),
		);
	}

	/** Counters brought up to date by walking only the entries appended since the last sample. */
	#work(subagentWorkers: number): WorkCounters {
		const total = this.#sessionManager.entryCount();
		for (const entry of this.#sessionManager.entriesFrom(this.#cursor)) {
			if (entry.type === "compaction") {
				this.#compactions++;
				continue;
			}
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const content of entry.message.content) {
				if (content.type !== "toolCall") continue;
				this.#toolCalls++;
				this.#toolCounts.set(content.name, (this.#toolCounts.get(content.name) ?? 0) + 1);
				if (content.name === "task") this.#subagentDispatches++;
				else if (content.name === "read") this.#fileReads++;
			}
		}
		this.#cursor = total;

		let liveSubagents = 0;
		let parkedSubagents = 0;
		for (const ref of this.#registry.list()) {
			if (ref.status === "parked") parkedSubagents++;
			else if (ref.status === "running" || ref.status === "idle") liveSubagents++;
		}

		// O(1): the session index keeps this snapshot, so the text term costs nothing to read.
		const usage = this.#sessionManager.getUsageStatistics();

		return {
			journalEntries: total,
			toolCalls: this.#toolCalls,
			topTools: [...this.#toolCounts].sort((a, b) => b[1] - a[1]).slice(0, TOP_TOOL_COUNT),
			subagentDispatches: this.#subagentDispatches,
			fileReads: this.#fileReads,
			compactions: this.#compactions,
			liveSubagents,
			parkedSubagents,
			tokens: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				total: usage.totalTokens,
			},
			// This session's journal only; a subagent keeps its own. See the field's doc comment.
			tokensIncludeSubagents: false,
			subagentWorkers,
		};
	}
}

/** Session lifecycle events that ask for a sample, and the reason each one records. */
function sampleReasonFor(event: AgentSessionEvent): ProcessSample["reason"] | undefined {
	switch (event.type) {
		case "agent_end":
			return "turn";
		case "auto_compaction_start":
		case "auto_compaction_end":
		case "manual_compaction_start":
		case "manual_compaction_end":
			return "compaction";
		default:
			return undefined;
	}
}

/**
 * Start sampling one top-level session, and publish each sample to extensions.
 *
 * Core's whole obligation is to produce the record, journal it and offer it; shipping samples
 * to a collector is extension work, which is why this publishes a `process_sample` event and
 * owns no client of any kind.
 *
 * Returns undefined when the setting is off. The listener closure holds the sampler alive for
 * the session's lifetime, exactly as the auto-learn controller's does.
 */
export function installMemorySampler(session: AgentSession, settings: Settings): MemorySampler | undefined {
	if (!cfgMemorySampleEnabled.get(settings)) return undefined;
	const sampler = new MemorySampler({
		sessionManager: session.sessionManager,
		intervalMs: cfgMemorySampleIntervalMs.get(settings),
		publish: sample => {
			void session.extensionRunner
				?.emit({ type: "process_sample", sessionId: session.sessionManager.getSessionId(), sample })
				.catch(() => {
					// An extension's failure must never cost the journal entry, which is already written.
				});
		},
	});
	session.subscribe(event => {
		const reason = sampleReasonFor(event);
		if (reason) sampler.sample(reason);
	});
	return sampler;
}
