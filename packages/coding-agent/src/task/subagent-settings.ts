/**
 * A subagent's settings overlay: the overlay over its parent's settings, tagged with the root compaction thresholds
 * its chain pins; the spawn's own inputs that build it; and the writes its runs make to it, with the values of
 * credential settings split out.
 */
import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import type { CompactionThresholdPair } from "../config/compaction-threshold";
import { all as allSettings, lookup as lookupSetting } from "../config/registry";
import { buildServiceTierByFamily, isServiceTierForFamily, resolveSubagentServiceTier } from "../config/service-tier";
import { deleteByPath, getByPath, type RawSettings, type Settings, setByPath, setOwn } from "../config/settings";
import {
	cfgCompactionModelThresholdsEnabled,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
} from "../session/context-settings";
import {
	cfgDefaultThinkingLevel,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
	cfgTierSubagent,
} from "../session/settings";

/**
 * Compaction thresholds of the root (non-subagent) settings a subagent chain
 * started from. Per-agent `task.agentCompactionThresholdOverrides` entries
 * replace `compaction.threshold*` and switch off `compaction.modelThresholds`
 * only for the agent they name; every other descendant resolves against these
 * root values, not an ancestor's override.
 */
export const kRootCompactionThresholds = Symbol("task.rootCompactionThresholds");

/** Root compaction thresholds a subagent chain pins (see {@link kRootCompactionThresholds}). */
export interface RootCompactionThresholds extends CompactionThresholdPair {
	modelThresholdsEnabled: boolean;
}

/** Settings from {@link createSubagentSettings}, tagged with its chain's root compaction thresholds. */
export interface SubagentChainSettings extends Settings {
	[kRootCompactionThresholds]?: RootCompactionThresholds;
}

/**
 * Per-family tiers a subagent inherits: the parent's live tiers when a live session supplied
 * them, else its configured `tier.*`. Live entries a family can't realize (a resumed session
 * file may carry `{anthropic: "flex"}`) are dropped — the subagent overlay rejects them.
 */
export function inheritedSubagentServiceTiers(
	baseSettings: Settings,
	inheritedServiceTier?: ServiceTierByFamily | null,
): ServiceTierByFamily {
	if (inheritedServiceTier === undefined) {
		return buildServiceTierByFamily(
			cfgTierOpenai.get(baseSettings),
			cfgTierAnthropic.get(baseSettings),
			cfgTierGoogle.get(baseSettings),
		);
	}
	const tiers: ServiceTierByFamily = {};
	for (const family of ["openai", "anthropic", "google"] as const) {
		const tier = inheritedServiceTier?.[family];
		if (isServiceTierForFamily(family, tier)) tiers[family] = tier;
	}
	return tiers;
}

/**
 * Settings overrides applying an exact-name compaction threshold entry to one
 * subagent. The agent entry outranks `compaction.modelThresholds`, including
 * entries added while the agent runs, so model entries are switched off for it.
 */
export function compactionThresholdSettings(
	threshold: CompactionThresholdPair | undefined,
): Readonly<Record<string, unknown>> | undefined {
	return threshold === undefined
		? undefined
		: {
				"compaction.thresholdPercent": threshold.thresholdPercent,
				"compaction.thresholdTokens": threshold.thresholdTokens,
				"compaction.modelThresholdsEnabled": false,
			};
}

export function createSubagentSettings(
	baseSettings: SubagentChainSettings,
	overrides?: Readonly<Record<string, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	// Resolve the subagent's per-family tiers from `tier.subagent` ("inherit" =
	// match the parent's live tiers when a live session supplied them, else the
	// subagent's own configured tier.* settings). The result is stamped onto the
	// overlay so createAgentSession's tier.* reads pick it up.
	const inheritedTiers = inheritedSubagentServiceTiers(baseSettings, inheritedServiceTier);
	const subagentTiers = resolveSubagentServiceTier(cfgTierSubagent.get(baseSettings), inheritedTiers);
	// A parent subagent's own per-agent threshold must not leak to its children: descendants
	// of a subagent pin the root's thresholds. A root parent's children read them through live.
	const inheritedRootThresholds = baseSettings[kRootCompactionThresholds];
	const rootThresholds = inheritedRootThresholds ?? {
		thresholdPercent: cfgCompactionThresholdPercent.get(baseSettings),
		thresholdTokens: cfgCompactionThresholdTokens.get(baseSettings),
		modelThresholdsEnabled: cfgCompactionModelThresholdsEnabled.get(baseSettings),
	};
	// Every other setting reads through to the parent live; writes on the overlay stay local.
	const subagentSettings: SubagentChainSettings = baseSettings.overlay(
		{
			...(inheritedRootThresholds && {
				"compaction.thresholdPercent": inheritedRootThresholds.thresholdPercent,
				"compaction.thresholdTokens": inheritedRootThresholds.thresholdTokens,
				"compaction.modelThresholdsEnabled": inheritedRootThresholds.modelThresholdsEnabled,
			}),
			// A subagent's thinking level is chosen at spawn (agent definition, `effort`, or this
			// snapshot of the parent default); a later parent default edit must not re-steer it.
			defaultThinkingLevel: cfgDefaultThinkingLevel.get(baseSettings),
			"tier.openai": subagentTiers.openai ?? "none",
			"tier.anthropic": subagentTiers.anthropic ?? "none",
			"tier.google": subagentTiers.google ?? "none",
			// Async jobs and bash/eval auto-backgrounding are inherited from the parent:
			// background jobs are owner-routed to the subagent's own session, and
			// the run driver's quiescence barrier + teardown reap guarantee no
			// owner job outlives the run, so worktree capture/cleanup stays
			// race-free (previously both were force-disabled here).

			// Subagents run headless — there is no UI to confirm prompts against, so
			// the parent task approval is the authorization boundary. Use yolo mode
			// to preserve unattended subagent execution. User `tools.approval` policies still apply.
			"tools.approvalMode": "yolo",
			// Subagents run unadvised by default; runSubprocess opts a spawn back in
			// per agent (frontmatter `advisor` / `task.agentAdvisor`) via overrides.
			"advisor.enabled": false,
			// A subagent assignment is one turn: its tool loop ends only when the run
			// yields, so post-turn `checkCompaction` (driven from `agent_end`) fires
			// after the run is over and `maintainContextMidRun` is the only proactive
			// compaction the child ever reaches. `compaction.midTurnEnabled` encodes an
			// interactive preference — keep compaction boundaries on real user turns —
			// that has no counterpart here, so inheriting `false` left hours-long
			// worker runs sailing past the configured threshold until the provider
			// rejected the context (#13211). A per-spawn override still wins.
			"compaction.midTurnEnabled": true,
			...overrides,
		},
		{ derived: true },
	);
	subagentSettings[kRootCompactionThresholds] = rootThresholds;
	return subagentSettings;
}

/**
 * A spawn's own inputs to its settings overlay. Over the live parent settings they build the overlay
 * at spawn and again at each warm revive, so a parked subagent keeps these few values instead of a
 * copy of the overlay's layers.
 */
export interface SubagentSettingsInputs {
	readonly compactionThreshold: CompactionThresholdPair | undefined;
	/** The agent definition turns `read` summaries off. */
	readonly noReadSummaries: boolean;
	/** An isolated run must not expose roots outside its worktree. */
	readonly isolated: boolean;
	readonly advisor: boolean;
	/** The advisor model pattern, expanded against the spawning owner's roles. */
	readonly advisorRolePattern: string | undefined;
	readonly parentServiceTier: ServiceTierByFamily | null | undefined;
}

/** The subagent overlay of `parent` that `inputs` describe (see {@link createSubagentSettings}). */
export function subagentSettingsFromInputs(parent: Settings, inputs: SubagentSettingsInputs): SubagentChainSettings {
	return createSubagentSettings(
		parent,
		{
			...compactionThresholdSettings(inputs.compactionThreshold),
			...(inputs.noReadSummaries ? { "read.summarize.enabled": false } : undefined),
			...(inputs.isolated ? { "workspace.additionalDirectories": [] } : undefined),
			...(inputs.advisor ? { "advisor.enabled": true } : undefined),
			...(inputs.advisorRolePattern
				? { modelRoles: { ...parent.getModelRoles(), advisor: inputs.advisorRolePattern } }
				: undefined),
		},
		inputs.parentServiceTier,
	);
}

/** Writes a subagent's runs made to one layer of its settings overlay, by top-level key. */
export interface SettingsLayerWrites {
	/** Keys a run set, each with the value it held when the live session was disposed. */
	readonly set?: Readonly<Record<string, unknown>>;
	/** Keys a run removed. */
	readonly removed?: readonly string[];
}

/**
 * Settings writes a subagent's runs made to its overlay's own layers. JSON data, as the settings
 * layers are, so a `SUBAGENT_REVIVE_ENTRY` (subagent-revive.ts) holds them, except the values of
 * credential settings ({@link SubagentCredentialWrites}).
 */
export interface SubagentSettingsWrites {
	readonly global?: SettingsLayerWrites;
	readonly overrides?: SettingsLayerWrites;
}

/** The top-level keys whose value in `layer` differs from `baseline`'s; `undefined` when none does. */
export function layerWrites(baseline: RawSettings, layer: RawSettings): SettingsLayerWrites | undefined {
	let set: Record<string, unknown> | undefined;
	let removed: string[] | undefined;
	for (const key of new Set([...Object.keys(baseline), ...Object.keys(layer)])) {
		// Own fields only: a layer without a `__proto__` key would read its prototype there.
		const before = Object.hasOwn(baseline, key) ? baseline[key] : undefined;
		const after = Object.hasOwn(layer, key) ? layer[key] : undefined;
		if (Bun.deepEquals(before, after)) continue;
		if (after === undefined) (removed ??= []).push(key);
		else setOwn((set ??= {}), key, after);
	}
	return set || removed ? { set, removed } : undefined;
}

/** `layer` with `writes` applied. */
export function withLayerWrites(layer: RawSettings, writes: SettingsLayerWrites | undefined): RawSettings {
	if (!writes) return layer;
	const set = writes.set ?? {};
	const removed = new Set(writes.removed);
	const written: RawSettings = {};
	for (const key of new Set([...Object.keys(layer), ...Object.keys(set)])) {
		const value = Object.hasOwn(set, key) ? set[key] : removed.has(key) ? undefined : layer[key];
		if (value !== undefined) setOwn(written, key, value);
	}
	return written;
}

/**
 * Values of credential settings (`Setting.isCredential`: an API key, a token, a password) a
 * subagent's runs wrote to its overlay's layers, by setting id. They stay out of its
 * `SUBAGENT_REVIVE_ENTRY` (subagent-revive.ts): the transcript file stores what it is given,
 * unmasked unless the session store is masked. The parked subagent keeps them in its
 * `WarmReviveState` (subagent-revive.ts), and its warm revive puts them back into the writes the
 * entry holds.
 */
export interface SubagentCredentialWrites {
	readonly global?: Readonly<Record<string, unknown>>;
	readonly overrides?: Readonly<Record<string, unknown>>;
}

/** `writes` without the values of credential settings, and those values by setting id. */
export function splitCredentialWrites(writes: SettingsLayerWrites | undefined): {
	writes: SettingsLayerWrites | undefined;
	credentials: Record<string, unknown> | undefined;
} {
	if (!writes?.set) return { writes, credentials: undefined };
	let set: RawSettings | undefined;
	let credentials: Record<string, unknown> | undefined;
	for (const setting of allSettings()) {
		if (!setting.isCredential) continue;
		const value = getByPath(set ?? writes.set, setting.segments);
		if (value === undefined) continue;
		(credentials ??= {})[setting.id] = value;
		// A copy, so deleting from it leaves the caller's `writes` unchanged.
		set ??= { ...writes.set };
		deleteByPath(set, setting.segments);
	}
	if (!set) return { writes, credentials };
	const { removed } = writes;
	const kept = Object.keys(set).length > 0 ? set : undefined;
	return { writes: kept || removed ? { set: kept, removed } : undefined, credentials };
}

/** `writes` with the credential values {@link splitCredentialWrites} took out of each layer put back. */
export function withCredentialWrites(
	writes: SubagentSettingsWrites | undefined,
	credentials: SubagentCredentialWrites | undefined,
): SubagentSettingsWrites | undefined {
	if (!credentials) return writes;
	const restore = (
		layer: SettingsLayerWrites | undefined,
		values: Readonly<Record<string, unknown>> | undefined,
	): SettingsLayerWrites | undefined => {
		if (!values) return layer;
		// A copy: the writes' records are the reopened transcript's entry.
		const set: RawSettings = structuredClone(layer?.set ?? {});
		for (const [id, value] of Object.entries(values)) {
			const setting = lookupSetting(id);
			if (setting) setByPath(set, setting.segments, value);
		}
		return { set, removed: layer?.removed };
	};
	return {
		global: restore(writes?.global, credentials.global),
		overrides: restore(writes?.overrides, credentials.overrides),
	};
}
