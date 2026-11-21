import type { Context, Tool } from "@oh-my-pi/pi-ai";
import type { AnthropicToolControls } from "@oh-my-pi/pi-ai/providers/anthropic-tool-declaration";
import type { AgentMessage } from "./types";

/** A tool declaration a response recorded: the names its request declared, in wire order. */
export type RecordedToolDeclaration = AnthropicToolControls;

/**
 * The tool declaration the newest response in `messages` that recorded one holds (`requestControls.tools`);
 * undefined when none did.
 */
export function latestToolDeclaration(messages: readonly AgentMessage[]): RecordedToolDeclaration | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && message.requestControls?.tools) return message.requestControls.tools;
	}
	return undefined;
}

/**
 * Last wire definition this Agent sent for each tool name, so a provider that keeps
 * withdrawn tools declared (Anthropic `tool_removal`) can re-declare them byte-identically.
 * Used by prepareProviderCall and Agent.buildSideRequestContext.
 */
export class SentToolDefinitions {
	#byName = new Map<string, Tool>();
	#revision = 0;

	/** Changes each time {@link record} runs: the definitions {@link inactiveFor} gives may have changed. */
	get revision(): number {
		return this.#revision;
	}

	/** Remember the definitions a request is about to send. */
	record(tools: readonly Tool[]): void {
		for (const tool of tools) this.#byName.set(tool.name, tool);
		this.#revision++;
	}

	/**
	 * A detached copy: an Agent that replays another's request history declares the same withdrawn tools. `keep`
	 * leaves out a definition the copy must never declare.
	 */
	copy(keep: (name: string) => boolean = () => true): SentToolDefinitions {
		const copy = new SentToolDefinitions();
		copy.record([...this.#byName.values()].filter(tool => keep(tool.name)));
		return copy;
	}

	/**
	 * `context` with {@link Context.inactiveTools} set to the definitions for names the latest
	 * `requestControls.tools.declared` in its messages holds that are not in its `tools`; cleared when
	 * there are none or the request declares no tools ({@link inactiveFor}).
	 */
	withInactiveTools(context: Context): Context {
		const inactiveTools = context.tools?.length
			? this.inactiveFor(latestToolDeclaration(context.messages), context.tools)
			: undefined;
		if (!inactiveTools && !context.inactiveTools) return context;
		return { ...context, inactiveTools };
	}

	/**
	 * The definitions this Agent sent for the names `declaration` declares that are not in `active`; undefined when
	 * there are none. Names never sent by this Agent are skipped: the provider drops them from the declaration.
	 */
	inactiveFor(declaration: RecordedToolDeclaration | undefined, active: readonly Tool[]): Tool[] | undefined {
		if (!declaration) return undefined;
		const activeNames = new Set(active.map(tool => tool.name));
		const inactive: Tool[] = [];
		for (const name of declaration.declared) {
			if (activeNames.has(name)) continue;
			const tool = this.#byName.get(name);
			if (tool) inactive.push(tool);
		}
		return inactive.length > 0 ? inactive : undefined;
	}
}
