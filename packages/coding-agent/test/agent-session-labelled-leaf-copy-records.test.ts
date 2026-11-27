/**
 * A label the user puts on an entry from `/tree` is the branch's leaf until the next entry. A copy of the branch into a
 * new file (`/fork <entry>`, `/branch`, a promoted `/btw` answer) leaves the label entries out and re-creates the labels
 * of the entries it keeps under new ids. The copy must still hold the conversation through an entry written after a
 * label, and `session_before_branch`'s `entryId` must name an entry the copy holds.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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

describe("a copy of a branch whose leaf was a label", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("the conversation and session_before_branch's entryId", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const sessions: AgentSession[] = [];
		const authStorages: AuthStorage[] = [];

		afterEach(async () => {
			for (const session of sessions.splice(0)) await session.dispose();
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		});

		/** A process on `sessionManager` whose `session_before_branch` hook records each event's `entryId`. */
		function open(sessionManager: SessionManager): { session: AgentSession; entryIds: string[] } {
			const entryIds: string[] = [];
			const extensionRunner = {
				hasHandlers: (eventType: string) => eventType === "session_before_branch",
				emit: async (event: { type: string; entryId?: string }) => {
					if (event.type === "session_before_branch" && event.entryId) entryIds.push(event.entryId);
					return undefined;
				},
			} as unknown as ExtensionRunner;
			const authStorage = createInMemoryAuthStorage();
			authStorages.push(authStorage);
			authStorage.keys.setRuntime("anthropic", "test-key");
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
				extensionRunner,
			});
			sessions.push(session);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			return { session, entryIds };
		}

		/** A reply on the session's model. */
		function assistant(text: string): AssistantMessage {
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
				usage: usage({ cacheRead: 0, cacheWrite: 5_000 }),
			};
		}

		/** A warm refresh's usage, recorded under the branch's leaf as the session records it. */
		function appendWarmRefresh(sessionManager: SessionManager): void {
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
		}

		it.each([
			{ leaf: "a warm refresh's usage after the label", after: appendWarmRefresh },
			{ leaf: "the label", after: () => {} },
		])("a promoted /btw answer from $leaf keeps the conversation", async ({ after }) => {
			using tempDir = TempDir.createSync("@pi-labelled-leaf-btw-");
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
			const replyId = sessionManager.appendMessage(assistant("the release is ready"));
			sessionManager.appendLabelChange(replyId, "ready");
			after(sessionManager);
			const { session, entryIds } = open(sessionManager);
			const leafId = sessionManager.getLeafId();
			if (!leafId) throw new Error("Expected a leaf");

			const promoted = await session.branchFromBtw(
				"why is it ready?",
				assistant("every check passed"),
				leafId,
				sessionManager.getSessionId(),
			);
			expect(promoted.cancelled).toBe(false);
			const [entryId] = entryIds;
			expect({
				copy: transcriptOf(session.buildDisplaySessionContext().messages),
				sent: transcriptOf(session.agent.state.messages),
				hookEntryHeld: entryId !== undefined && sessionManager.getEntry(entryId) !== undefined,
				label: sessionManager.getLabel(replyId),
			}).toEqual({
				copy: [
					"user: check the release",
					"assistant: the release is ready",
					"user: why is it ready?",
					"assistant: every check passed",
				],
				sent: [
					"user: check the release",
					"assistant: the release is ready",
					"user: why is it ready?",
					"assistant: every check passed",
				],
				hookEntryHeld: true,
				label: "ready",
			});
		});

		it("/branch at a prompt sent after a label and a warm refresh keeps the conversation before it", async () => {
			using tempDir = TempDir.createSync("@pi-labelled-leaf-branch-");
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 2_000 });
			const replyId = sessionManager.appendMessage(assistant("the release is ready"));
			sessionManager.appendLabelChange(replyId, "ready");
			appendWarmRefresh(sessionManager);
			const promptId = sessionManager.appendMessage({
				role: "user",
				content: "ship it",
				timestamp: Date.now() - 1_000,
			});
			sessionManager.appendMessage(assistant("shipped"));
			const { session } = open(sessionManager);

			const result = await session.branch(promptId);
			expect(result.cancelled).toBe(false);
			const copyFile = sessionManager.getSessionFile();
			if (!copyFile) throw new Error("Expected the copy's session file");
			await sessionManager.flush();
			const resumed = open(await SessionManager.open(copyFile)).session;
			expect({
				copy: transcriptOf(session.buildDisplaySessionContext().messages),
				resumed: transcriptOf(resumed.buildDisplaySessionContext().messages),
			}).toEqual({
				copy: ["user: check the release", "assistant: the release is ready"],
				resumed: ["user: check the release", "assistant: the release is ready"],
			});
		});

		it("/fork at a labelled newest reply names that reply as the last entry kept", async () => {
			using tempDir = TempDir.createSync("@pi-labelled-leaf-fork-");
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			sessionManager.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
			const replyId = sessionManager.appendMessage(assistant("the release is ready"));
			sessionManager.appendLabelChange(replyId, "ready");
			const { session, entryIds } = open(sessionManager);

			expect(await session.fork(replyId)).toBe(true);
			expect({ entryIds, held: sessionManager.getEntry(replyId)?.type }).toEqual({
				entryIds: [replyId],
				held: "message",
			});
		});
	});
});
