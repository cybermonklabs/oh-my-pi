import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { SessionBusyError } from "../../session/agent-session";
import { PromptIdleWaitTimeoutError } from "../../session/turn-recovery";

/**
 * The RPC failure code of a prompt error: `session_busy` when the agent was busy
 * (refused at once, or still held by another run after the 30 s wait), else none.
 */
export function rpcBusyCode(error: unknown): "session_busy" | undefined {
	if (
		error instanceof AgentBusyError ||
		error instanceof SessionBusyError ||
		error instanceof PromptIdleWaitTimeoutError
	) {
		return "session_busy";
	}
	return undefined;
}
