/**
 * Numeric memory self-measurement for the periodic `process_sample` journal entry.
 *
 * A session is the only thing that can measure a session. Measured on this fleet:
 * `/proc/<pid>/smaps_rollup` is `Permission denied` across a box's uid namespace, and
 * `/proc/<pid>/mem` returns `EACCES` to every process a session forks because
 * `/proc/sys/kernel/yama/ptrace_scope` is `1` and omp is their ancestor. A profiler, a
 * sidecar or a leak-check beside the session cannot do this; in-process it is self-memory.
 *
 * Three sources are deliberately *not* used here:
 *
 * - **`heapUsed`.** The main thread's JS heap stays flat at 90-108 MiB while the process RSS
 *   climbs to 1.4 GiB, so a report built on it understates by 15x and is wrong in the
 *   reassuring direction. It is carried as a diagnostic field, never as the measure.
 * - **`memory.current` alone.** It includes reclaimable page cache; the observed kill bound on
 *   104 GiB of *anon*, so `memory.stat`'s `anon` is the term that binds and `memory.current`
 *   rides beside it.
 * - **`heapStats()` and `/proc/self/smaps_rollup`.** Both are O(heap) or O(resident pages) and
 *   were measured on this box at 110 ms (2.2 M objects) and 116 ms (7.8 GiB RSS) per call,
 *   rising linearly. On the 104 GiB session a `smaps_rollup` sample would have cost well over a
 *   second. `/proc/self/status` reports the same `VmRSS` and `RssAnon` at a flat 0.014 ms, and
 *   `bun:jsc`'s `heapSize()` reports the JSC heap at 0.12 ms without the object census.
 */

import { readFileSync } from "node:fs";
import { heapSize, memoryUsage as jscMemoryUsage } from "bun:jsc";

/** Resident memory of the whole process, as the kernel accounts it. */
export interface ProcessResident {
	/** `VmRSS` in KiB: every resident page, anonymous and file-backed. */
	rssKb: number;
	/** `RssAnon` in KiB: resident anonymous pages, the term an OOM kill binds on. */
	anonKb: number;
	/** `RssFile` in KiB: resident file-backed pages, which reclaim under pressure. */
	fileKb: number;
	/** OS threads in the process, including every subagent worker's threads. */
	threads: number;
}

/**
 * The box's cgroup v2 memory accounting. `anon` is the alarm and `max` is the wall; `current`
 * rides along because it is what most tools show and the gap between them is page cache.
 */
export interface CgroupMemory {
	/** cgroup path this was read from, for a reader who needs to know which box answered. */
	path: string;
	/** `memory.stat` `anon`: anonymous bytes charged to the cgroup. */
	anon: number;
	/** `memory.stat` `file`: page cache charged to the cgroup, almost all of it reclaimable. */
	file: number;
	/** `memory.current`: everything charged, page cache included. */
	current: number;
	/** `memory.max` in bytes, or null when the cgroup is unlimited (`max`). */
	max: number | null;
}

/**
 * One JavaScript VM's own numbers. The main thread and each subagent worker are separate VMs.
 *
 * **There is no GC time or GC count here, and that is a measured absence, not an omission.**
 * Bun exposes none: `PerformanceObserver` accepts `entryTypes: ["gc"]` and then emits nothing
 * through heavy churn, `bun:jsc` offers only GC *triggers* (`edenGC`, `fullGC`, `gcAndSweep`)
 * and no counter, and `node:v8`'s shim returns machine-wide figures (`total_physical_size` came
 * back as the host's whole memory). The discriminator the GC counter was wanted for survives
 * anyway, because this sample is a series rather than a snapshot: `jscHeapBytes` against the
 * process `anonKb` over time separates allocation churn — anon climbing while the JSC heap stays
 * flat — from live retention, where the two climb together. `pageFaults` is the closest thing to
 * a direct churn counter that exists here.
 */
export interface ThreadMemory {
	/** `main`, or the worker's thread id (`w1`, `w2`, ...). */
	thread: string;
	/** `bun:jsc` `heapSize()` for this VM, in bytes. */
	jscHeapBytes: number | null;
	/** `bun:jsc` `memoryUsage().current`: JSC's own footprint for this VM, in bytes. */
	jscFootprintBytes: number | null;
	/** `bun:jsc` `memoryUsage().pageFaults`, cumulative. The only churn counter this runtime has. */
	pageFaults: number | null;
	/** `process.memoryUsage().heapUsed`. Diagnostic only — see this file's header. */
	heapUsedBytes: number | null;
	/** `process.memoryUsage().heapTotal`. Diagnostic only. */
	heapTotalBytes: number | null;
	/** `process.memoryUsage().external`, bytes held outside the JS heap by this VM. */
	externalBytes: number | null;
	/**
	 * Cumulative CPU of this thread in milliseconds, from `/proc/thread-self/stat`.
	 *
	 * CPU is the one axis that held up across thirteen large sessions under leave-one-out
	 * (r +0.58..+0.82, against +0.21..+0.86 for prompt tokens, which collapses when one outlier
	 * leaves). Per-thread rather than per-process so a worker's cost is separable.
	 */
	cpuMs: number | null;
}

/** A subagent worker's VM, or the record of one that could not be reached. */
export interface WorkerMemory extends ThreadMemory {
	/** Subagent runs and holds on this worker when it answered. */
	load?: number;
	/**
	 * Why this worker contributed no numbers. A worker that is busy, starting or already gone
	 * must never delay the sample: its absence is recorded and the sample is written anyway.
	 */
	missing?: "timeout" | "gone" | "error";
}

/**
 * Cumulative work-shape counters at sample time.
 *
 * These are the discriminator nothing outside the box can obtain. Memory tracks what a session
 * has *done* rather than how long it has lived — uptime predicts RSS at only +0.15 across the
 * fleet — but no host can read these counts, and the proxy a host can read, CPU time, cannot
 * tell a thousand tool calls from one long computation. Both are carried, because the measured
 * ranking puts CPU first and the counts are what showed the token axis fails: memory per million
 * prompt tokens varies 3.7x to 20.0x across the same sessions.
 */
export interface WorkCounters {
	/** Journal entries written so far, the session's own `#entries` length. */
	journalEntries: number;
	/** Assistant tool calls of every kind. */
	toolCalls: number;
	/** The largest tool kinds by call count, most-called first. */
	topTools: Array<[name: string, calls: number]>;
	/** `task` tool calls: subagent dispatches. */
	subagentDispatches: number;
	/** `read` tool calls. Calls, not distinct paths: retaining the paths would cost memory. */
	fileReads: number;
	/** Compaction entries on the journal. */
	compactions: number;
	/** Subagents the registry reports as running or idle. */
	liveSubagents: number;
	/** Subagents the registry holds parked. */
	parkedSubagents: number;
	/**
	 * Cumulative text this session has sent to models, from the session's own O(1) usage
	 * snapshot. **The term the live byte figures have to be divided by.**
	 *
	 * Across thirteen processes over 20 GiB, counting every transcript file — root journal plus
	 * 56 to 2 829 subagent transcripts apiece — resident memory came to 6.20..11.14 bytes per
	 * prompt token for twelve of them, median 8.61. A prompt token is about four characters, and
	 * storing every character ever sent in UTF-16 costs exactly 8.00 bytes per token. So the
	 * hypothesis this field exists to test is that the process retains essentially every
	 * character it has ever sent, forever.
	 *
	 * A single snapshot cannot test it. Two samples far apart can: live string bytes **tracking**
	 * cumulative tokens means the strings are retained and the fix is to stop retaining them;
	 * live bytes **flat** while resident memory climbs means they are freed and the allocator is
	 * holding pages, which is a different fix entirely.
	 */
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/**
	 * Whether {@link tokens} includes text sent by subagents.
	 *
	 * Always false: the snapshot is this session's own journal, and a subagent keeps its own.
	 * The field is carried rather than left to a comment because the scope decides what the
	 * bytes-per-token ratio means, and a reader of the data cannot otherwise tell. One of the
	 * thirteen sessions sits at 1.50 bytes per token instead of 8.61; the likeliest explanation
	 * is that its subagents' text never entered the measured address space, which is what
	 * {@link subagentWorkers} is here to show.
	 */
	tokensIncludeSubagents: boolean;
	/**
	 * Subagent worker threads live in this process right now.
	 *
	 * A subagent hosted on a worker thread shares this address space, so its text counts against
	 * this process's memory; one hosted elsewhere does not. Non-zero here, together with
	 * `workers`, says this process is carrying subagent text.
	 */
	subagentWorkers: number;
}

/**
 * Which process wrote a sample.
 *
 * A session journal spans every restart of that session and marks none of them: there is one
 * `session` record, written at creation, and a session resumed across days still carries the
 * one dated when it was first made. Two real failures came of that — summing a journal to
 * explain a *running* process's memory counted days of work by processes that no longer exist,
 * and a search of 248 journals for one killed and restarted five minutes later found no
 * boundary at all, because a long gap is indistinguishable from idleness.
 *
 * A change of `pid` or `startedAtMs` between two samples **is** the restart, readable in the
 * file by anyone, with no access to the host. Pid alone will not do: pids are reused.
 */
export interface ProcessIdentity {
	pid: number;
	/**
	 * When this process started, epoch milliseconds, from `/proc/self/stat`'s boot-relative
	 * `starttime` against `/proc/stat`'s `btime`. Exact and stable, where `Date.now() -
	 * uptime()` jitters; that subtraction is the fallback where /proc is absent.
	 */
	startedAtMs: number;
}

/** Everything one `process_sample` entry records. */
export interface ProcessSample {
	/** The process that wrote this sample. A change between samples is a restart. */
	identity: ProcessIdentity;
	/** Sample index within this session's process, from 1. A gap means samples were lost with it. */
	seq: number;
	/** What asked for this sample. */
	reason: "start" | "interval" | "turn" | "compaction";
	/** Milliseconds since this process started, so a reader can rate memory against work. */
	uptimeMs: number;
	/** Cumulative CPU of the whole process, milliseconds, from `process.cpuUsage()`. */
	cpu: { userMs: number; systemMs: number };
	/** Whole-process resident memory, or null when /proc is unreadable. */
	process: ProcessResident | null;
	/** The box's cap and what is charged against it, or null off cgroup v2. */
	cgroup: CgroupMemory | null;
	/** The main thread's VM. */
	main: ThreadMemory;
	/** One record per live subagent worker, including workers that did not answer. */
	workers: WorkerMemory[];
	/** Cumulative counters: what this session has done, not only how big it is. */
	work: WorkCounters;
	/**
	 * Main-thread milliseconds this sample cost: every reading, taken before the sampler yields.
	 * A sampler must be able to prove it is cheap, and it cannot do that with a figure that also
	 * counts time the event loop spent on the session's own work.
	 */
	costMs: number;
	/**
	 * Milliseconds spent waiting for subagent workers to answer — yielded, not spent. Rises to
	 * the worker deadline when one is busy; the sample is written either way.
	 */
	workerWaitMs: number;
}

/**
 * This process's identity, computed once because it cannot change while the process lives.
 *
 * `/proc/self/stat` field 22 is `starttime`, in USER_HZ since boot, and `/proc/stat`'s `btime`
 * is the boot instant in epoch seconds; together they give an exact start instant that two
 * processes on the same host cannot share. The fallback subtracts `process.uptime()`, which is
 * good to a few milliseconds and is only reached where /proc is absent.
 */
function computeProcessIdentity(): ProcessIdentity {
	try {
		const stat = readFileSync("/proc/self/stat", "utf8");
		const startTicks = Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "", 10);
		const boot = readFileSync("/proc/stat", "utf8");
		const btime = Number.parseInt(boot.slice(boot.indexOf("\nbtime ") + 7), 10);
		if (Number.isFinite(startTicks) && Number.isFinite(btime)) {
			return { pid: process.pid, startedAtMs: btime * 1000 + startTicks * 10 };
		}
	} catch {
		// No procfs; fall through to the uptime subtraction.
	}
	return { pid: process.pid, startedAtMs: Math.round(Date.now() - process.uptime() * 1000) };
}

const PROCESS_IDENTITY = computeProcessIdentity();

/** Which process is reading. Constant for this process's life; see {@link ProcessIdentity}. */
export function processIdentity(): ProcessIdentity {
	return PROCESS_IDENTITY;
}

/** Value of a `Key:  N kB` line in `/proc/<pid>/status`, in KiB. */
function statusKb(status: string, key: string): number {
	const at = status.indexOf(`\n${key}:`);
	if (at < 0) return 0;
	const value = Number.parseInt(status.slice(at + key.length + 2), 10);
	return Number.isFinite(value) ? value : 0;
}

/**
 * Resident memory and thread count of this process from `/proc/self/status`.
 *
 * Flat 0.014 ms whatever the process holds, against 116 ms at 7.8 GiB for the `smaps_rollup`
 * the same two numbers can also be read from. Measured identical on both files.
 */
export function readProcessResident(): ProcessResident | null {
	let status: string;
	try {
		status = readFileSync("/proc/self/status", "utf8");
	} catch {
		// No procfs: macOS, or a sandbox without /proc. The sample still carries its VM numbers.
		return null;
	}
	return {
		rssKb: statusKb(status, "VmRSS"),
		anonKb: statusKb(status, "RssAnon"),
		fileKb: statusKb(status, "RssFile"),
		threads: statusKb(status, "Threads"),
	};
}

/** Value of a `key value` line in a cgroup flat-keyed file, or null when the key is absent. */
function statKey(stat: string, key: string): number | null {
	const at = stat.startsWith(`${key} `) ? 0 : stat.indexOf(`\n${key} `);
	if (at < 0) return null;
	const value = Number.parseInt(stat.slice(at + key.length + (at === 0 ? 1 : 2)), 10);
	return Number.isFinite(value) ? value : null;
}

/**
 * Directory holding this process's cgroup v2 memory files.
 *
 * `/proc/self/cgroup` names the path as the *writer's* cgroup namespace sees it. In a container
 * with its own cgroup namespace that path is already the mount root, so both candidates are
 * tried and the first with `memory.current` wins.
 */
function resolveCgroupDir(): string | null {
	let self: string;
	try {
		self = readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return null;
	}
	const line = self.split("\n").find(entry => entry.startsWith("0::"));
	const candidates = ["/sys/fs/cgroup"];
	if (line && line.length > 3) candidates.unshift(`/sys/fs/cgroup${line.slice(3)}`);
	for (const dir of candidates) {
		try {
			readFileSync(`${dir}/memory.current`, "utf8");
			return dir;
		} catch {
			// Not this one; cgroup v1, or a path only the host can see.
		}
	}
	return null;
}

/** Resolved once per process and re-resolved after a failed read, since a cgroup can move. */
let cgroupDir: string | null | undefined;

/**
 * The box's memory accounting: the pair that says how close this session is to being killed.
 *
 * A process RSS alone cannot answer that. One measured session was a 20.1 GiB omp inside an
 * 84.3 GiB box at 77.4 % of its cap — the closest to the edge on its host, and a self-report
 * saying only "I am 20 GiB" would have told it it was comfortable.
 */
export function readCgroupMemory(): CgroupMemory | null {
	if (cgroupDir === undefined) cgroupDir = resolveCgroupDir();
	if (cgroupDir === null) return null;
	try {
		const stat = readFileSync(`${cgroupDir}/memory.stat`, "utf8");
		const current = Number.parseInt(readFileSync(`${cgroupDir}/memory.current`, "utf8"), 10);
		const rawMax = readFileSync(`${cgroupDir}/memory.max`, "utf8").trim();
		return {
			path: cgroupDir,
			anon: statKey(stat, "anon") ?? 0,
			file: statKey(stat, "file") ?? 0,
			current: Number.isFinite(current) ? current : 0,
			max: rawMax === "max" ? null : Number.parseInt(rawMax, 10),
		};
	} catch {
		cgroupDir = undefined;
		return null;
	}
}

/**
 * Cumulative CPU of the *calling thread*, in milliseconds.
 *
 * `/proc/thread-self/stat` is the calling thread's own stat file, so a subagent worker reading
 * it reports its own cost rather than the process total. Fields 14 and 15 after the comm field
 * are `utime` and `stime` in USER_HZ, which Linux fixes at 100 for /proc regardless of the
 * kernel's tick rate. The comm field can contain spaces and parentheses, so the split starts
 * after its last `)`.
 */
function readThreadCpuMs(): number | null {
	try {
		const stat = readFileSync("/proc/thread-self/stat", "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const utime = Number.parseInt(fields[11] ?? "", 10);
		const stime = Number.parseInt(fields[12] ?? "", 10);
		if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
		return (utime + stime) * 10;
	} catch {
		return null;
	}
}

/**
 * This realm's VM numbers. Safe to call in the main thread and in a subagent worker: each is a
 * separate JSC VM and reports only its own heap.
 *
 * Never calls `heapStats()`. Besides costing O(objects), its `objectTypeCounts` keys are
 * runtime-derived type names that can carry credentials, which is why the debug report bundle
 * keeps them out of anything serialized.
 */
export function readThreadMemory(thread: string): ThreadMemory {
	const usage = process.memoryUsage();
	let jscHeapBytes: number | null = null;
	let jscFootprintBytes: number | null = null;
	let pageFaults: number | null = null;
	try {
		jscHeapBytes = heapSize();
		const jsc = jscMemoryUsage();
		jscFootprintBytes = jsc.current;
		pageFaults = jsc.pageFaults;
	} catch {
		// bun:jsc is unavailable under a non-Bun runtime; the kernel numbers still stand.
	}
	return {
		thread,
		jscHeapBytes,
		jscFootprintBytes,
		pageFaults,
		cpuMs: readThreadCpuMs(),
		heapUsedBytes: usage.heapUsed,
		heapTotalBytes: usage.heapTotal,
		externalBytes: usage.external,
	};
}
