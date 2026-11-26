/**
 * `omp anonymize` on a session whose failed turn was kept and continued from,
 * or replaced by a retry. The session writes the marks of such a turn
 * (`continued`, `retryRecovery`) after the turn's own line; the anonymized
 * export must still carry them, so a reload of the export rebuilds the context
 * the live session had and draws a recovered error as recovered. The session is
 * written by the real write path: the primary's requests run the real
 * `anthropic-messages` provider, and only its HTTP client is replaced.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { runAnonymizeCommand } from "../src/cli/anonymize-cli";
import type { SessionEntry } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";
import {
	COMPLETE_TOOL_CALL_FRAMES,
	CONTINUED_ANSWER,
	MESSAGE_START_FRAME,
	RATE_LIMIT_FRAME,
	useKeptTurnSessions,
} from "./helpers/kept-turn-session";

/**
 * The roles and block kinds of a model context, without the text, which the
 * export redacts: `assistant[text call]`, `result`, `user`, and each custom
 * message as `custom:` and its type, so a comparison holds the hidden continue
 * reminder a kept turn's continuation sent.
 */
function contextShape(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role === "user") return ["user"];
		if (message.role === "toolResult") return ["result"];
		if (message.role === "custom") return [`custom:${message.customType}`];
		if (message.role !== "assistant") return [];
		const blocks = message.content.map(block =>
			block.type === "text" ? "text" : block.type === "toolCall" ? "call" : block.type,
		);
		return [`assistant[${blocks.join(" ")}]`];
	});
}

/** The first failed assistant message among `entries`. */
function failedMessage(entries: readonly SessionEntry[]): AssistantMessage | undefined {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error") {
			return entry.message;
		}
	}
	return undefined;
}

describe("omp anonymize on a session with a kept or retried failed turn", () => {
	const sessions = useKeptTurnSessions();

	/** Runs `omp anonymize` on `sessionFile` and opens the anonymized transcript as a resume opens it. */
	async function anonymizeAndOpen(sessionFile: string, name: string): Promise<SessionManager> {
		const out = path.join(sessions.tempDir.path(), `${name}.anon`);
		await runAnonymizeCommand({ session: sessionFile, out });
		return SessionManager.open(path.join(out, "session.jsonl"), out, undefined, { suppressBreadcrumb: true });
	}

	// Regression: a user exports a session with `omp anonymize` in which a rate
	// limit ended a turn after a complete tool call and a retry recovered it;
	// the export, reopened, draws that recovered turn as a plain failure.
	it("keeps the marks of a turn a rate limit ended after a complete tool call", async () => {
		const result = await sessions.runAndReopen([
			{ stream: MESSAGE_START_FRAME + COMPLETE_TOOL_CALL_FRAMES + RATE_LIMIT_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);
		const sessionFile = result.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected the session to persist a file");
		const original = failedMessage(result.reopened.getEntries());
		expect(original?.retryRecovery?.status).toBe("recovered");

		const anonymized = await anonymizeAndOpen(sessionFile, "tool-call-cut");
		try {
			const marked = failedMessage(anonymized.getEntries());
			expect(marked?.retryRecovery?.status).toBe("recovered");
			expect(marked?.continued).toBe(original?.continued);
			expect(contextShape(anonymized.buildSessionContext().messages)).toEqual(
				contextShape(result.session.agent.state.messages),
			);
		} finally {
			await anonymized.close();
		}
	});
});
