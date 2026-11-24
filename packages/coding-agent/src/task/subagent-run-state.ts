/**
 * Module state the subagent run (`./executor`) and its warm revive (`./subagent-revive`) share.
 */
import type { AgentSession } from "../session/agent-session";

/**
 * The model session creation started a subagent session on in place of the
 * one it requested, and the `Fallback:` notice saying why
 * (`startupModelFallback`). Kept with the session, not one run, so every
 * monitor that attaches to it (the spawn's, a follow-up turn's, an IRC
 * wake's) reports the substitution whenever that model serves.
 */
export const startupModelFallbacks = new WeakMap<AgentSession, { model: string; reason: string }>();

/**
 * Compaction thresholds of the root (non-subagent) settings a subagent chain
 * started from. Per-agent `task.agentCompactionThresholdOverrides` entries
 * replace `compaction.threshold*` and switch off `compaction.modelThresholds`
 * only for the agent they name; every other descendant resolves against these
 * root values, not an ancestor's override.
 */
export const kRootCompactionThresholds = Symbol("task.rootCompactionThresholds");
