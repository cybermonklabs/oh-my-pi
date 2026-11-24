/**
 * The cut rule's "waits" for an automatic model-summary compaction is kept in the session as a compaction-wait record,
 * written after the newest message of the branch the rule answered on. `/fork` at that message copies the branch up to
 * it into a new file, under the same provider prompt-cache key: a process that resumes the copy reads the entry the
 * rule waited on, so the wait applies there too. This case forks a session right after the rule waited, restarts omp
 * on the copy with a threshold above its context (the band where only the wait keeps a background summary from
 * starting), and reads every request the resumed process's first prompt sends.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, sessionContextTokens } from "./helpers/agent-session-setup";
import { continuesCachedPrompt, gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold of the process before the restart sits this far below the transcript's context: the rule waits. */
const THRESHOLD_MARGIN = 2_000;
/** The threshold of the resumed process sits this far above it: the band below the threshold, where no rule is asked. */
const BAND_MARGIN = 4_000;

describe("a model-summary compaction the cut rule waits on, across /fork at the newest message and a restart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts no background summary in a process that resumes the copy while the wait holds", async () => {
		using tempDir = TempDir.createSync("@pi-compaction-wait-fork-restart-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(CONTEXT_WINDOW));
		const messages = transcript();
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const options = {
			...gatewaySessionOptions(tempDir),
			authStorage,
			modelRegistry,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		};

		// The context the transcript sends: the tools and system prompt of a session built as each process builds its
		// own, and the messages.
		const { session: sizing } = await createAgentSession({
			...options,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: processSettings(CONTEXT_WINDOW / 2),
		});
		const contextTokens = sessionContextTokens(sizing, messages);
		await sizing.dispose();

		// The process before the restart: its prompt's reply writes the whole context to a one-hour entry, and the rule
		// waits on the compaction after it. It forks the session at that reply and exits.
		const live = recordGateway(contextTokens);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		for (const message of messages) sessionManager.appendMessage(message);
		const { session } = await createAgentSession({
			...options,
			sessionManager,
			settings: processSettings(contextTokens - THRESHOLD_MARGIN),
		});
		let copyFile: string | undefined;
		try {
			await live.send(session, "first prompt");
			const branch = sessionManager.getBranch();
			const replyIndex = branch.findLastIndex(entry => entry.type === "message");
			const reply = branch[replyIndex];
			// Preconditions: the rule waited after the reply, and its record sits after that reply, the newest message.
			expect({
				waited: live.timeline.slice(live.timeline.indexOf("main request")).includes(SUMMARY_COMPACTION_WAITS),
				recordAfterReply: branch
					.slice(replyIndex + 1)
					.some(entry => entry.type === "custom" && entry.customType === "compaction-wait"),
			}).toEqual({ waited: true, recordAfterReply: true });
			expect(await session.fork(reply.id)).toBe(true);
			copyFile = sessionManager.getSessionFile();
			await sessionManager.flush();
		} finally {
			await session.dispose();
			live.restore();
		}
		if (!copyFile) throw new Error("Expected the copy's session file");
		const lastBefore = live.requests.findLast(request => request.kind === "main");
		if (!lastBefore) throw new Error("Expected a main request before the restart");

		// omp restarts on the copy a moment later, with a threshold above the context.
		const resumed = recordGateway(contextTokens);
		const { session: restarted } = await createAgentSession({
			...options,
			sessionManager: await SessionManager.open(copyFile),
			settings: processSettings(contextTokens + BAND_MARGIN),
		});
		try {
			await resumed.send(restarted, "resumed prompt");
			const resumedMain = resumed.requests.find(request => request.kind === "main");
			if (!resumedMain) throw new Error("Expected the resumed process's main request");
			// The resumed process's request reads the entry the rule waited on, and it requests no summary: one costs a
			// model call for a cut that cannot run.
			expect({
				continues: continuesCachedPrompt(lastBefore.body, resumedMain.body),
				summaries: resumed.timeline.filter(entry => entry === "summary request").length,
			}).toEqual({ continues: true, summaries: 0 });
		} finally {
			await restarted.dispose();
			authStorage.close();
			resumed.restore();
		}
	}, 180_000);
});
