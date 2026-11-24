/**
 * `/fork` at a branch's newest reply copies the branch up to that reply into a new file. A label the user put on an
 * entry from `/tree` is the branch's leaf until the next entry, so a record written after it (a session title, an
 * extension's record, a cache-warm refresh's usage) is the label's child. A copy keeps the labels of the entries it
 * holds, re-created after its last entry, and leaves the label entries themselves out. The copy must still hold the
 * whole conversation up to the reply, in this process and in a process that resumes it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function usage(tokens: Pick<Usage, "cacheRead" | "cacheWrite">): Usage {
	return {
		input: 1,
		output: 1,
		...tokens,
		totalTokens: 2 + tokens.cacheRead + tokens.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The role and text of each message a context holds. */
function transcriptOf(messages: readonly { role: string; content?: unknown }[]): string[] {
	return messages.map(message => {
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("")
					: "";
		return `${message.role}: ${text}`;
	});
}

describe("/fork at the newest reply after a label and a later record", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let model: Model;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fork-labelled-reply-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	/** A process on `sessionManager`. */
	async function open(sessionManager: SessionManager): Promise<AgentSession> {
		const settings = await Settings.loadIsolated({ agentDir: tempDir.path(), cwd: tempDir.path() });
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		return session;
	}

	it.each([
		{
			record: "a session title",
			write: async (sessionManager: SessionManager) => {
				expect(await sessionManager.setSessionName("Release checklist", "user")).toBe(true);
			},
		},
		{
			record: "an extension's record",
			write: async (sessionManager: SessionManager) => {
				sessionManager.appendCustomEntry("fleet-bank-state", { step: 2 });
			},
		},
		{
			record: "a cache-warm refresh's usage",
			write: async (sessionManager: SessionManager) => {
				// The warmer records its usage under the branch's leaf, as the session does.
				sessionManager.appendModelUsage(
					{
						purpose: "cache-warm",
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ cacheRead: 5_000, cacheWrite: 0 }),
						stopReason: "stop",
					},
					{ sessionId: sessionManager.getSessionId(), parentId: sessionManager.getLeafId() },
				);
			},
		},
	])("keeps the conversation in the copy when $record follows the label", async ({ write }) => {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
		const reply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "the release is ready" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: Date.now(),
			usage: usage({ cacheRead: 0, cacheWrite: 5_000 }),
		};
		const replyId = sessionManager.appendMessage(reply);
		sessionManager.appendLabelChange(replyId, "ready");
		await write(sessionManager);
		await sessionManager.flush();

		const session = await open(sessionManager);
		const before = transcriptOf(session.buildDisplaySessionContext().messages);
		// Precondition: the source holds the turn, and the reply is labelled.
		expect(before).toEqual(["user: check the release", "assistant: the release is ready"]);
		expect(sessionManager.getLabel(replyId)).toBe("ready");

		expect(await session.fork(replyId)).toBe(true);
		const copyFile = sessionManager.getSessionFile();
		if (!copyFile) throw new Error("Expected the copy's session file");
		await sessionManager.flush();
		const resumed = await open(await SessionManager.open(copyFile));

		expect({
			copy: transcriptOf(session.buildDisplaySessionContext().messages),
			sent: transcriptOf(session.agent.state.messages),
			resumed: transcriptOf(resumed.buildDisplaySessionContext().messages),
			label: sessionManager.getLabel(replyId),
		}).toEqual({ copy: before, sent: before, resumed: before, label: "ready" });
	});
});
