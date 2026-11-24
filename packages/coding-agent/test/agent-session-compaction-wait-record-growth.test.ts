/**
 * The cut rule's "waits" for an automatic model-summary compaction is kept in the session as a compaction-wait record,
 * so a process that reads the session holds the same wait. While the rule keeps waiting on the same live prompt cache
 * entry, the wait the session records is the same one: each request only touches that entry again, well inside its
 * one-hour lifetime, so the record already written still applies to it. This case sends several prompts past the
 * compaction threshold, each continuing the cached prompt of the one before, and counts the records the session holds.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { continuesCachedPrompt, gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold sits this far below the transcript's context: the rule is asked at every maintenance point. */
const THRESHOLD_MARGIN = 2_000;
/** Prompts sent past the threshold, each a moment after the one before. */
const PROMPTS = 5;

describe("a model-summary compaction the cut rule keeps waiting on", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records the wait once while every request touches the same live cache entry", async () => {
		using tempDir = TempDir.createSync("@pi-compaction-wait-record-growth-");
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

		// The context the transcript sends: the tools and system prompt of a session built as the process builds its
		// own, and the messages.
		const { session: sizing } = await createAgentSession({
			...options,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: processSettings(CONTEXT_WINDOW / 2),
		});
		const contextTokens =
			computeNonMessageTokens(sizing, sizing.agent.tokenizer, sizing.settings.revision) +
			sizing.agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		await sizing.dispose();

		const gateway = recordGateway(contextTokens);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		for (const message of messages) sessionManager.appendMessage(message);
		const { session } = await createAgentSession({
			...options,
			sessionManager,
			settings: processSettings(contextTokens - THRESHOLD_MARGIN),
		});
		try {
			const startedAt = Date.now();
			for (let index = 0; index < PROMPTS; index++) await gateway.send(session, `prompt ${index}`);
			const mains = gateway.requests.filter(request => request.kind === "main");

			// Preconditions: every prompt went out past the threshold and the rule waited on the compaction after each
			// reply, so nothing was cut; each main request sends the prompt the one before it sent, so all of them read
			// and touch the one entry the rule waits on, within a minute of its one-hour lifetime.
			const afterFirstReply = gateway.timeline.slice(gateway.timeline.indexOf("main request"));
			expect({
				mains: mains.length,
				waits: afterFirstReply.filter(entry => entry === SUMMARY_COMPACTION_WAITS).length >= PROMPTS,
				admitted: afterFirstReply.filter(
					entry => entry.startsWith("cut rule: compaction-soft ") && entry !== SUMMARY_COMPACTION_WAITS,
				),
				continues: mains.slice(1).every((request, index) => continuesCachedPrompt(mains[index].body, request.body)),
				compacted: sessionManager.getBranch().some(entry => entry.type === "compaction"),
				withinAMinute: Date.now() - startedAt < 60_000,
			}).toEqual({
				mains: PROMPTS,
				waits: true,
				admitted: [],
				continues: true,
				compacted: false,
				withinAMinute: true,
			});

			// The wait the first record holds applies to every later touch of the entry: one record, not one per request.
			const records = sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "compaction-wait").length;
			expect({ records }).toEqual({ records: 1 });
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 180_000);
});
