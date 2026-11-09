import type { AssistantMessage, ServiceTier, ServiceTierByFamily, StopReason, Usage } from "@oh-my-pi/pi-ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

/**
 * Extracted stats from an assistant message.
 */
export interface MessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Model ID */
	model: string;
	/** Provider name */
	provider: string;
	/** API type */
	api: string;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Request duration in milliseconds */
	duration: number | null;
	/** Time to first token in milliseconds */
	ttft: number | null;
	/** Stop reason */
	stopReason: StopReason;
	/** Error message if stopReason is error */
	errorMessage: string | null;
	/** Token usage */
	usage: Usage;
	/** Which agent produced this message (main agent, task subagent, advisor) */
	agentType: AgentType;
	/**
	 * Service tier the provider reported serving this turn, or `null` when the
	 * provider reported none. Lets consumers separate a fast serving path's
	 * throughput and premium traffic from standard-tier traffic. Always written by
	 * `rowToMessageStats`; optional only because session fixtures that stand in
	 * for ingest input are typed as `MessageStats` too.
	 */
	serviceTier?: ServiceTier | null;
	/**
	 * Ingest refused to price this request: a scheduled (time-based) card with no
	 * recoverable request timestamp, so `usage.cost.total` of 0 is unknown spend
	 * rather than a free request. Always written by `rowToMessageStats`; optional
	 * only because session fixtures that stand in for ingest input are typed as
	 * `MessageStats` too.
	 */
	costUnpriced?: boolean;
}

/**
 * Session-recorded token usage before pricing: counters are coerced to numbers
 * because their columns are NOT NULL, but `cost` is only present when the
 * session entry actually recorded one. Absence is meaningful — `resolveStoredCost`
 * estimates a request with no recorded price, whereas a recorded zero is a real
 * charge that scheduled cards freeze. `costUnpriced` is omitted because it is a
 * decision of the ingest path, not something the parser or a caller supplies.
 */
export interface MessageStatsInput extends Omit<MessageStats, "usage" | "costUnpriced"> {
	usage: Omit<Usage, "cost"> & { cost?: Partial<Usage["cost"]> };
}

/**
 * Full details of a request, including content.
 */
export interface RequestDetails extends MessageStats {
	/** The full conversation history or just the last turn. */
	messages: unknown[];
	/** The model's response; `null` for `model_usage` entries, which journal no payload. */
	output: unknown;
}

/**
 * Session log entry types.
 */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	title?: string;
}

export interface SessionMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AssistantMessage | { role: "user" | "toolResult" };
}

export interface SessionServiceTierChangeEntry {
	type: "service_tier_change";
	id: string;
	parentId?: string | null;
	timestamp: string;
	serviceTier: ServiceTierByFamily | ServiceTier | null;
}

export interface SessionModelUsageEntry {
	type: "model_usage";
	id: string;
	parentId: string | null;
	timestamp: string;
	purpose: string;
	role?: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

/**
 * Custom journal entry (`tool_execution_start`, `session_exit`, …). Mirrors
 * the coding-agent shape structurally — stats never imports coding-agent.
 */
export interface SessionCustomEntry {
	type: "custom";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	customType: string;
	data?: Record<string, unknown>;
}

/**
 * One `process_sample` journal entry: a session's own memory and work-shape
 * measurement. Mirrors `ProcessSample` in the coding agent's
 * `debug/memory-sample.ts` structurally — stats never imports coding-agent.
 */
export interface SessionProcessSampleEntry {
	type: "process_sample";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	sample: {
		/**
		 * Which process wrote the sample. A change of `(pid, startedAtMs)` between two
		 * consecutive samples of one journal **is** a restart: the journal itself marks
		 * none, since its one `session` record is written at creation and survives every
		 * restart. Absent on samples written before the sampler carried it.
		 */
		identity?: { pid: number; startedAtMs: number };
		seq: number;
		reason: "start" | "interval" | "turn" | "compaction";
		uptimeMs: number;
		/** Cumulative CPU of the whole process. The axis that predicts RSS best. */
		cpu?: { userMs: number; systemMs: number };
		process: { rssKb: number; anonKb: number; fileKb: number; threads: number } | null;
		cgroup: { path: string; anon: number; file: number; current: number; max: number | null } | null;
		main: SessionThreadMemory;
		workers: SessionWorkerMemory[];
		work: {
			journalEntries: number;
			toolCalls: number;
			topTools: Array<[string, number]>;
			subagentDispatches: number;
			fileReads: number;
			compactions: number;
			liveSubagents: number;
			parkedSubagents: number;
			/**
			 * Cumulative tokens the session has sent and received. Absent on samples
			 * written before the sampler counted them, which is why every reader must
			 * tolerate its absence rather than read a missing count as zero.
			 */
			tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			/** Whether {@link tokens} includes text sent by subagents. Currently always false. */
			tokensIncludeSubagents?: boolean;
			/** Subagent worker threads living in this process at sample time. */
			subagentWorkers?: number;
		};
		costMs: number;
	};
}

/** One JavaScript VM's numbers inside a {@link SessionProcessSampleEntry}. */
export interface SessionThreadMemory {
	thread: string;
	jscHeapBytes: number | null;
	jscFootprintBytes: number | null;
	/** `bun:jsc` cumulative page faults: the nearest thing to a churn counter here. */
	pageFaults?: number | null;
	/** Diagnostic only — never the memory figure; it understates RSS by up to 15x. */
	heapUsedBytes: number | null;
	heapTotalBytes: number | null;
	externalBytes: number | null;
	/** Cumulative CPU of this thread, in milliseconds. */
	cpuMs?: number | null;
}

/** A subagent worker's VM, or the record of one that could not be reached. */
export interface SessionWorkerMemory extends SessionThreadMemory {
	load?: number;
	missing?: "timeout" | "gone" | "error";
}

/** Structural variants the trace builder matches on beyond messages. */
export interface SessionTypedEntry {
	type: "session_init" | "compaction" | "model_change" | "mode_change" | "reset_boundary";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export type SessionEntry =
	| SessionHeader
	| SessionMessageEntry
	| SessionServiceTierChangeEntry
	| SessionModelUsageEntry
	| SessionCustomEntry
	| SessionProcessSampleEntry
	| SessionTypedEntry
	| { type: string };

/**
 * Behavioral stats extracted from a single user message.
 */
export interface UserMessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path */
	folder: string;
	/** Unix timestamp in ms */
	timestamp: number;
	/** Model that responded to this user message, if linked */
	model: string | null;
	/** Provider that responded to this user message, if linked */
	provider: string | null;
	/** Total characters of message text */
	chars: number;
	/** Whitespace-delimited word count */
	words: number;
	/** Yelling sentences (> 50% uppercase letters) */
	yelling: number;
	/** Profanity hits */
	profanity: number;
	/** Catch-all upset signal: drama runs + `noooo`/`ughh`/... + `dude` + `:(` */
	anguish: number;
	/** Corrective negation ("no", "nope", "thats not what i meant") */
	negation: number;
	/** User repeating themselves ("i meant", "still doesnt work", "like i said") */
	repetition: number;
	/** Second-person reproach ("you didnt", "why did you", "stop X-ing") */
	blame: number;
	/** Judge-facing prose (see `judgeProse`); empty when the message was all markup. */
	prose: string;
	/** Hex `Bun.hash` of `prose`, keying the shared verdict cache; empty when `prose` is. */
	proseHash: string;
}

/**
 * Pair emitted by the parser when it sees an assistant message whose
 * `parentId` points to a user message that wasn't parsed in the same pass
 * (e.g. user prompt landed in an earlier incremental sync). The aggregator
 * applies the link to the persisted `user_messages` row so it stops showing
 * up in the "unknown" model bucket.
 */
export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

/**
 * One tool call extracted from an assistant message's `toolCall` content
 * blocks. `callsInTurn` records how many calls that assistant turn contained
 * so aggregation can split the turn's real provider usage evenly per call.
 */
export interface ToolCallStats {
	/** Session file path */
	sessionFile: string;
	/** Assistant-message entry ID that emitted the call */
	entryId: string;
	/** Provider-assigned tool call ID (unique within a session) */
	toolCallId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Tool name */
	toolName: string;
	/** Model that emitted the call */
	model: string;
	/** Provider name */
	provider: string;
	/** Assistant-message timestamp (Unix ms) */
	timestamp: number;
	/** Which agent produced the call */
	agentType: AgentType;
	/** Total tool calls in the same assistant turn (>= 1) */
	callsInTurn: number;
	/** Serialized argument characters */
	argsChars: number;
	/** Result text characters, when the same parse also read the call's `toolResult` */
	resultChars?: number;
	/** Result error flag, set together with `resultChars` */
	isError?: boolean;
}

/**
 * One `process_sample` journal entry flattened for the `process_samples`
 * table: only the scalars a memory dashboard plots. The sample's nested
 * per-worker records are reduced to a count and a heap total, and the whole
 * sample blob is never stored.
 */
export interface ProcessSampleRow {
	/** Session file path */
	sessionFile: string;
	/** Journal entry ID of the sample (unique within a session) */
	entryId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Which agent produced the sample */
	agentType: AgentType;
	/** Entry timestamp (Unix ms) */
	timestamp: number;
	/**
	 * Pid of the process that wrote the sample; null on samples written before the
	 * sampler carried an identity.
	 */
	pid: number | null;
	/**
	 * That process's exact start instant, epoch ms. With {@link pid} it names one
	 * incarnation: a change between consecutive samples is a restart. Pid alone will
	 * not do, because pids are reused.
	 */
	startedAtMs: number | null;
	/** Sample index within the session's process, from 1; a gap means samples were lost. */
	seq: number;
	/** What asked for the sample: `start` | `interval` | `turn` | `compaction`. */
	reason: string;
	/** Milliseconds since the sampled process started */
	uptimeMs: number;
	/** What taking the sample cost, in milliseconds */
	costMs: number;
	/** Cumulative user CPU of the whole process, ms; null when the sample carried none */
	cpuUserMs: number | null;
	/** Cumulative system CPU of the whole process, ms; null when the sample carried none */
	cpuSystemMs: number | null;
	/** `VmRSS` in KiB, null when /proc was unreadable */
	rssKb: number | null;
	/** `RssAnon` in KiB, null when /proc was unreadable */
	anonKb: number | null;
	/** OS threads in the process, null when /proc was unreadable */
	threads: number | null;
	/** cgroup v2 `memory.stat` `anon`, in bytes; null off cgroup v2 */
	cgroupAnon: number | null;
	/** cgroup v2 `memory.current`, in bytes; null off cgroup v2 */
	cgroupCurrent: number | null;
	/** cgroup v2 `memory.max`, in bytes; null when unlimited or off cgroup v2 */
	cgroupMax: number | null;
	/** Main thread's `bun:jsc` heap size, in bytes */
	mainJscHeapBytes: number | null;
	/** Main thread's own cumulative CPU, in milliseconds */
	mainCpuMs: number | null;
	/** Main thread's cumulative page faults: the only churn counter this runtime has */
	mainPageFaults: number | null;
	/**
	 * Main thread's `process.memoryUsage().heapUsed`. **Diagnostic only** — never the
	 * memory figure. It stays flat at 90–108 MiB while RSS climbs to 1.4 GiB; the gap
	 * between it and {@link rssKb} is the signal worth keeping.
	 */
	mainHeapUsedBytes: number | null;
	/** Subagent worker VMs recorded, answering or not */
	workerCount: number;
	/** Sum of the answering workers' JSC heap sizes, in bytes */
	workerJscHeapBytes: number | null;
	/** Sum of the answering workers' thread CPU, in milliseconds; null when none reported */
	workerCpuMs: number | null;
	/** Journal entries written so far */
	journalEntries: number;
	/** Assistant tool calls of every kind so far */
	toolCalls: number;
	/** `task` tool calls so far */
	subagentDispatches: number;
	/** `read` tool calls so far */
	fileReads: number;
	/** Compaction entries on the journal so far */
	compactions: number;
	/** Subagents the registry reports running or idle */
	liveSubagents: number;
	/** Subagents the registry holds parked */
	parkedSubagents: number;
	/** `WorkCounters.topTools` as JSON text, or null when the sample named none */
	topTools: string | null;
	/**
	 * Cumulative prompt tokens sent, null when the sample carried no token counts.
	 * Null and not zero: a missing count must never read as a real zero, since the
	 * hypothesis these columns exist to test is a ratio with tokens underneath it.
	 */
	tokensInput: number | null;
	/** Cumulative output tokens received; null when the sample carried none */
	tokensOutput: number | null;
	/** Cumulative cache-read tokens; null when the sample carried none */
	tokensCacheRead: number | null;
	/** Cumulative cache-write tokens; null when the sample carried none */
	tokensCacheWrite: number | null;
	/** Cumulative tokens of every kind; the denominator of bytes-per-token */
	tokensTotal: number | null;
	/**
	 * 1 when the counts include subagents' text, 0 when they are this session's own,
	 * null when the sample carried no token counts at all. It decides what a
	 * bytes-per-token figure means, so it travels with the counts.
	 */
	tokensIncludeSubagents: number | null;
	/** Subagent worker threads living in this process at sample time; null when unreported */
	subagentWorkers: number | null;
}

/**
 * Result linkage emitted when the parser sees a `toolResult` message entry.
 * Applied as an UPDATE on the persisted tool-call row — results can land in a
 * later incremental sync pass than the call that produced them (calls parsed
 * in the same pass already carry the result, so their UPDATE is a no-op).
 */
export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	/** Text characters fed back into context */
	resultChars: number;
	isError: boolean;
}
