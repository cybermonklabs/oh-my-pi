import * as path from "node:path";
import type { AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** The artifacts directory a task call keeps its subagents' transcripts and output artifacts in. */
export const ARTIFACTS_DIR = path.join(path.sep, "artifacts", "main");

/** Registers the task subagent `id` with `sessionFile`: `idle` on `session` when given, else `parked`. */
export function registerSubagent(
	registry: AgentRegistry,
	id: string,
	sessionFile: string | null,
	session: AgentSession | null = null,
): AgentRef {
	return registry.register({
		id,
		displayName: "task",
		kind: "sub",
		session,
		sessionFile,
		status: session ? "idle" : "parked",
	});
}
