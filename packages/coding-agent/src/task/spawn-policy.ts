/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "task";

/** Spawn policy derived from a parent agent's `spawns` frontmatter. */
export interface ResolvedSpawnPolicy {
	/** True when at least one subagent may be spawned. */
	enabled: boolean;
	/** Agent used when the caller omits the agent field. */
	defaultAgent: string;
	/** Explicitly allowed agents, or `null` when the policy is unrestricted. */
	allowedAgents: readonly string[] | null;
	/** Text used in spawn rejection messages. */
	allowedErrorText: string;
	/** Backtick-quoted explicit agents for prompt descriptions. */
	allowedPromptText?: string;
}

/** Resolves spawn frontmatter into the default and prompt/error surfaces. */
export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}

/**
 * Whether a session may spawn the agent `name`: not disabled via `task.disabledAgents`, and permitted by its spawn
 * `policy`.
 */
export function isAgentSpawnable(
	name: string,
	disabledAgents: readonly string[],
	policy: ResolvedSpawnPolicy,
): boolean {
	return (
		policy.enabled &&
		!disabledAgents.includes(name) &&
		(policy.allowedAgents === null || policy.allowedAgents.includes(name))
	);
}

/** Whether the `scout` agent is spawnable in a session ({@link isAgentSpawnable}). */
export function isScoutSpawnable(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	return isAgentSpawnable("scout", disabledAgents ?? [], resolveSpawnPolicy(spawns));
}

/**
 * The agents of `agents` a session may spawn ({@link isAgentSpawnable}). The task description lists these, and the
 * hidden notices about agents announce only these.
 */
export function spawnableAgents<T extends { name: string }>(
	agents: readonly T[],
	disabledAgents: readonly string[],
	policy: ResolvedSpawnPolicy,
): T[] {
	return agents.filter(agent => isAgentSpawnable(agent.name, disabledAgents, policy));
}
