/**
 * A subagent's settings overlay: the overlay over its parent's settings, tagged with the root compaction thresholds
 * its chain pins; the settings a spawn writes to it; the snapshot of its layers a spawn spec stores and a revive
 * restores; and the writes its runs make beyond the spawn's, which only a warm revive holds.
 */
import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import type { CompactionThresholdPair } from "../config/compaction-threshold";
import { cfgModelRoles } from "../config/model-settings";
import { all as allSettings } from "../config/registry";
import { buildServiceTierByFamily, isServiceTierForFamily, resolveSubagentServiceTier } from "../config/service-tier";
import { deleteByPath, getByPath, type OverlayLayers, type RawSettings, type Settings, setOwn } from "../config/settings";
import {
	cfgCompactionModelThresholdsEnabled,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
} from "../session/context-settings";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
	cfgTierSubagent,
} from "../session/settings";
import { type SpawnSpecSettings, spawnSpecSettings } from "./spawn-spec";

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
 * Settings overrides applying an exact-name compaction threshold entry to one
 * subagent. The agent entry outranks `compaction.modelThresholds`, including
 * entries added while the agent runs, so model entries are switched off for it.
 */
export function compactionThresholdSettings(
	threshold: CompactionThresholdPair | undefined,
): Readonly<SubagentOverlayOverrides> | undefined {
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
	overrides?: Readonly<SubagentOverlayOverrides>,
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
	const pinnedThresholds: Readonly<SubagentOverlayOverrides> | undefined = inheritedRootThresholds && {
		"compaction.thresholdPercent": inheritedRootThresholds.thresholdPercent,
		"compaction.thresholdTokens": inheritedRootThresholds.thresholdTokens,
		"compaction.modelThresholdsEnabled": inheritedRootThresholds.modelThresholdsEnabled,
	};
	// Every other setting reads through to the parent live; writes on the overlay stay local.
	const writes: Readonly<SubagentOverlayOverrides> = {
		...pinnedThresholds,
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
	};
	const subagentSettings: SubagentChainSettings = baseSettings.overlay(writes, { derived: true });
	subagentSettings[kRootCompactionThresholds] = rootThresholds;
	return subagentSettings;
}

/**
 * Every setting a spawn writes to a subagent's overlay that a revive restores: {@link createSubagentSettings}' own,
 * the spawn's per-agent overrides and the retry-fallback role it installs. A cold revive restores only these from
 * a stored overlay; any other stored value reads through to the live parent. (`workspace.additionalDirectories`
 * is written only for an isolated run, which is never revived.) Each writer types its writes with
 * {@link SubagentOverlayOverrides}, so a write of a setting this list leaves out fails the type check.
 */
export const SUBAGENT_OVERLAY_SETTINGS = [
	"compaction.thresholdPercent",
	"compaction.thresholdTokens",
	"compaction.modelThresholdsEnabled",
	"compaction.midTurnEnabled",
	"defaultThinkingLevel",
	"tier.openai",
	"tier.anthropic",
	"tier.google",
	"tools.approvalMode",
	"advisor.enabled",
	"read.summarize.enabled",
	// `installRetryFallbackRole` writes the `subagent:<id>` role through setting handles, so these two are its
	// handles' ids, each typed as its literal id.
	cfgModelRoles.id,
	cfgRetryFallbackChains.id,
] as const;

/** The id of a setting a spawn writes to a subagent's overlay: one of {@link SUBAGENT_OVERLAY_SETTINGS}. */
type SubagentOverlaySettingId = (typeof SUBAGENT_OVERLAY_SETTINGS)[number];

/** The ids a spawn writes to a subagent's overlay: the restored ones, and the roots an isolated run clears. */
type SubagentOverlayWriteId = SubagentOverlaySettingId | "workspace.additionalDirectories";

/** Values a spawn writes to a subagent's overlay, by setting id. */
export type SubagentOverlayOverrides = Partial<Record<SubagentOverlayWriteId, unknown>>;

/** A subagent overlay's own writes and the root compaction thresholds its chain pins. */
export interface SubagentSettingsSnapshot {
	layers: OverlayLayers;
	rootThresholds: RootCompactionThresholds | undefined;
}

/** The snapshot of `settings`, a subagent overlay: its own layers and the root compaction thresholds its chain pins. */
export function captureSubagentSettings(settings: SubagentChainSettings): SubagentSettingsSnapshot {
	return { layers: settings.overlayLayers(), rootThresholds: settings[kRootCompactionThresholds] };
}

/**
 * The subagent overlay `snapshot` holds, restored over `parent`, each stored setting checked as `overlay()`
 * checks its overrides. It is derived whatever `snapshot` says: every spawn writes a derived overlay, and a
 * stored one (a transcript's) never becomes grant authority.
 *
 * @throws Error when the overlay names an unknown setting or holds a value its definition rejects.
 */
export function restoreSubagentSettings(
	parent: Settings,
	snapshot: { layers: OverlayLayers; rootThresholds?: RootCompactionThresholds },
): Settings {
	const settings: SubagentChainSettings = parent.restoreOverlay({ ...snapshot.layers, derived: true });
	settings[kRootCompactionThresholds] = snapshot.rootThresholds;
	return settings;
}

/** `layer` without the value of any credential setting (`Setting.isCredential`: an API key, a token, a password). */
function withoutCredentials(layer: RawSettings): RawSettings {
	let kept: RawSettings | undefined;
	for (const setting of allSettings()) {
		if (!setting.isCredential || getByPath(kept ?? layer, setting.segments) === undefined) continue;
		// A copy, so deleting from it leaves the caller's layer unchanged.
		kept ??= structuredClone(layer);
		deleteByPath(kept, setting.segments);
	}
	return kept ?? layer;
}

/**
 * `snapshot` without the values of credential settings, as a spawn spec stores it: the transcript file stores what it
 * is given, unmasked unless the session store is masked. A credential the overlay held stays in the live overlay,
 * and a warm revive holds it among the runs' writes ({@link layerWrites} against the stored layers finds it).
 */
export function withoutCredentialSettings(snapshot: SubagentSettingsSnapshot): SubagentSettingsSnapshot {
	const { global, overrides, derived } = snapshot.layers;
	return {
		layers: { global: withoutCredentials(global), overrides: withoutCredentials(overrides), derived },
		rootThresholds: snapshot.rootThresholds,
	};
}

/**
 * The layers and root thresholds a spawn spec stores of `settings`, a spawn's overlay: as JSON gives them back, and
 * without the values of credential settings.
 */
export function storedSpawnSettings(settings: SubagentChainSettings): SpawnSpecSettings {
	return spawnSpecSettings(withoutCredentialSettings(captureSubagentSettings(settings)));
}

/** Writes a subagent's runs made to one layer of its settings overlay, by top-level key. */
export interface SettingsLayerWrites {
	/** Keys a run set, each with the value it held when the live session was disposed. */
	readonly set?: Readonly<Record<string, unknown>>;
	/** Keys a run removed. */
	readonly removed?: readonly string[];
}

/**
 * Settings writes a subagent's runs made to its overlay's own layers beyond the layers its spawn spec stores. JSON
 * data, as the stored layers are; only a warm revive holds them (class `S+P` of the spawn input inventory).
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
