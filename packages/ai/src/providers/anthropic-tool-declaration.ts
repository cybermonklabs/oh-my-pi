import type { AnthropicRequestControls, Model, Tool } from "../types";
import { withoutDisabledExperimentalBetas } from "./anthropic-beta-kill-switch";

/** The tool controls a response recorded (`requestControls.tools`): what its request declared, deferred and made active. */
export type AnthropicToolControls = NonNullable<AnthropicRequestControls["tools"]>;

/** What a live request declares in its top-level `tools` ({@link declareAnthropicTools}). */
export interface AnthropicToolDeclaration {
	/** The declared names, in wire order. */
	declared: string[];
	/** {@link declared} as a set. */
	declaredSet: Set<string>;
	/** The declared names sent with `defer_loading`. */
	deferred: Set<string>;
	/** The definition of each declared name, in wire order, a deferred one with `deferLoading`. */
	tools: Tool[];
}

/**
 * The top-level `tools` a live request declares on a model that keeps its tool
 * declaration ({@link anthropicKeepsToolDeclaration}): the declaration `latest`
 * (the tool controls the newest response recorded) holds, minus names with no
 * definition in `tools` or `inactiveTools`, plus newly active tools appended
 * with `defer_loading`. Without a record, `tools` as given.
 */
export function declareAnthropicTools(
	tools: readonly Tool[],
	inactiveTools: readonly Tool[] | undefined,
	latest: AnthropicToolControls | undefined,
): AnthropicToolDeclaration {
	const definitions = new Map<string, Tool>();
	for (const tool of tools) definitions.set(tool.name, tool);
	for (const tool of inactiveTools ?? []) {
		if (!definitions.has(tool.name)) definitions.set(tool.name, tool);
	}
	// A declared name without a definition cannot be re-sent: accepted cache miss (e.g. after a resume).
	const declared = latest ? latest.declared.filter(name => definitions.has(name)) : tools.map(tool => tool.name);
	const declaredSet = new Set(declared);
	const deferred = new Set<string>();
	if (latest) {
		for (const name of latest.deferred) {
			if (declaredSet.has(name)) deferred.add(name);
		}
		for (const tool of tools) {
			if (declaredSet.has(tool.name)) continue;
			declared.push(tool.name);
			declaredSet.add(tool.name);
			deferred.add(tool.name);
		}
		// The API rejects a declaration whose tools are all deferred (a tool-less
		// conversation gaining tools, or a resume that kept none of the loaded
		// ones), so load them all and let the controls replay availability.
		if (declared.every(name => deferred.has(name))) deferred.clear();
	}
	const declaredTools: Tool[] = [];
	for (const name of declared) {
		const tool = definitions.get(name);
		if (tool) declaredTools.push(deferred.has(name) ? { ...tool, deferLoading: true } : tool);
	}
	return { declared, declaredSet, deferred, tools: declaredTools };
}

/**
 * Whether requests on `model` keep their top-level tool declaration across a
 * conversation, announcing availability changes as controls instead: a tool
 * taken off the roster stays declared ({@link anthropicDeclaredTools}). Read
 * off the compat the request goes out with ({@link withoutDisabledExperimentalBetas}):
 * Claude Code's kill switch turns mid-conversation tool changes off, and a
 * request then declares the active tools alone.
 */
export function anthropicKeepsToolDeclaration(model: Model<"anthropic-messages">): boolean {
	return withoutDisabledExperimentalBetas(model).compat.supportsMidConversationToolChanges === true;
}

/**
 * The top-level `tools` a live request declares, in wire order, on a model that
 * keeps its tool declaration ({@link anthropicKeepsToolDeclaration}): `latest`,
 * the tool controls the newest response recorded (`requestControls.tools`),
 * minus each name with no definition in `tools` (the active tools) or
 * `inactiveTools` (the withdrawn ones the sender can re-declare), plus each
 * newly active tool, appended with `deferLoading`.
 */
export function anthropicDeclaredTools(
	tools: readonly Tool[],
	inactiveTools: readonly Tool[] | undefined,
	latest: AnthropicToolControls,
): Tool[] {
	return declareAnthropicTools(tools, inactiveTools, latest).tools;
}
