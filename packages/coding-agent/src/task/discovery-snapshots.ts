/**
 * Latest agent discovery scan per resolved cwd plus the exact effective
 * `extensions` roots: the definitions the task tools there list. A scan is
 * published when a task tool's creation scan or an explicit rescan
 * (`refreshAgentDiscovery`) settles. Kept apart from the task tool so the
 * session's prompt surface can snapshot the list without importing the tool.
 */
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { AgentDefinition } from "./types";

const snapshots = new Map<string, readonly AgentDefinition[]>();

/** Stable cache identity for the filesystem root and the full effective extension-root struct. */
export function discoveryCacheKey(cwd: string, extensionRoots?: EffectiveExtensionRoots): string {
	return `${path.resolve(cwd)}\0${JSON.stringify(extensionRoots ?? null)}`;
}

/** The latest published scan for `cwd` and `extensionRoots`; undefined before any settled. */
export function publishedAgentDiscovery(
	cwd: string,
	extensionRoots?: EffectiveExtensionRoots,
): readonly AgentDefinition[] | undefined {
	return snapshots.get(discoveryCacheKey(cwd, extensionRoots));
}

/** Publishes a settled scan under its {@link discoveryCacheKey}. */
export function publishAgentDiscovery(key: string, agents: readonly AgentDefinition[]): void {
	snapshots.set(key, agents);
}

/** Drops every published scan. */
export function clearPublishedAgentDiscovery(): void {
	snapshots.clear();
}
