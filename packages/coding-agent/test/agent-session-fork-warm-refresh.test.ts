/**
 * A cache-warm refresh is recorded after the reply whose prompt it reads (`model_usage` with `cacheRefresh`), and a
 * refresh that hit keeps that reply's cache entry live past the reply's own lifetime. `/fork` at the branch's newest
 * reply copies the branch up to that reply into a new file that reads the same entry, so the refreshes after it must
 * go on in the copy too: without them the copy, and a process that resumes it, see a live entry as lapsed (a cut the
 * rule would make wait goes ahead, a held change is released early).
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
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const MINUTE_MS = 60_000;

function usage(tokens: Pick<Usage, "cacheRead" | "cacheWrite">): Usage {
	return {
		input: 1,
		output: 1,
		...tokens,
		totalTokens: 2 + tokens.cacheRead + tokens.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cttl: { ephemeral5m: tokens.cacheRead + tokens.cacheWrite },
	};
}

describe("/fork at the newest reply after a cache-warm refresh", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let model: Model;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fork-warm-refresh-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		// Five-minute entries.
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { short: 300 } } as Model;
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	/** A process on `sessionManager`, with a warmer that sends nothing. */
	async function open(sessionManager: SessionManager): Promise<AgentSession> {
		const settings = await Settings.loadIsolated({ agentDir: tempDir.path(), cwd: tempDir.path() });
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			cacheWarmer: new CacheWarmer({
				getMode: () => "off",
				getPromptTokens: () => 0,
				stream: () => {
					throw new Error("Expected no warm refresh");
				},
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		return session;
	}

	it("keeps the entry the refresh kept live, in the copy and in a process that resumes it", async () => {
		const now = Date.now();
		const sentAt = now - 7 * MINUTE_MS;
		const refreshedAt = now - 3 * MINUTE_MS;
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		sessionManager.appendMessage({ role: "user", content: "first", timestamp: sentAt - 1_000 });
		const answer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: sentAt,
			usage: usage({ cacheRead: 0, cacheWrite: 50_000 }),
		};
		const replyId = sessionManager.appendMessage(answer);
		// A refresh sent four minutes after the reply read the whole entry, so it is live until two minutes from now.
		sessionManager.appendModelUsage(
			{
				purpose: "cache-warm",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage({ cacheRead: 50_000, cacheWrite: 0 }),
				stopReason: "stop",
				cacheRefresh: { sentAt: refreshedAt, hit: true },
			},
			{ sessionId: sessionManager.getSessionId(), parentId: replyId },
		);
		await sessionManager.flush();

		const session = await open(sessionManager);
		// Precondition: the refresh keeps the entry live although the reply's own lifetime ran out.
		expect(session.getPromptCacheStatus(now)).toMatchObject({ state: "warm", touchedAt: refreshedAt });

		expect(await session.fork(replyId)).toBe(true);
		const copyFile = sessionManager.getSessionFile();
		if (!copyFile) throw new Error("Expected the copy's session file");
		await sessionManager.flush();
		const resumed = await open(await SessionManager.open(copyFile));

		expect({
			copy: session.getPromptCacheStatus(now),
			resumed: resumed.getPromptCacheStatus(now),
		}).toMatchObject({
			copy: { state: "warm", touchedAt: refreshedAt },
			resumed: { state: "warm", touchedAt: refreshedAt },
		});
	});
});
