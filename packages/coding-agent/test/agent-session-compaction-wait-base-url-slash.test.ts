/**
 * The cut rule's "waits" for an automatic model-summary compaction is kept in the session as a compaction-wait record
 * that names the model the rule weighed the compaction for, as the prompt cache keys it: the endpoint its requests go
 * to among it. A process that resumes the session holds the wait while the next request reads the entry the rule
 * waited on. A trailing slash on the model's `baseUrl` names the same endpoint (the request goes to the same URL and
 * reads the same entry), so a `models.yml` edit that only adds one between two processes must keep the wait: ended,
 * the resumed process starts a background summary, a model call, for a cut that cannot run yet.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, sessionContextTokens } from "./helpers/agent-session-setup";
import { continuesCachedPrompt, GATEWAY, gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold of the process before the restart sits this far below the transcript's context: the rule waits. */
const THRESHOLD_MARGIN = 2_000;
/** The threshold of the resumed process sits this far above it: the band below the threshold, where no rule is asked. */
const BAND_MARGIN = 4_000;

describe("a model-summary compaction the cut rule waits on, across a restart that adds a trailing slash to the model's baseUrl", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts no background summary in the resumed process while the wait holds", async () => {
		using tempDir = TempDir.createSync("@pi-compaction-wait-base-url-slash-");
		const modelsYml = tempDir.join("models.yml");
		await Bun.write(modelsYml, gatewayModelsYml(CONTEXT_WINDOW));
		const messages = transcript();

		/** A process's model, read from `models.yml` as it stands when the process starts. */
		function processModel() {
			const authStorage = createInMemoryAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage, modelsYml);
			const model = modelRegistry.find("anthropic", "claude-opus-5-5");
			if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
			return {
				...gatewaySessionOptions(tempDir),
				authStorage,
				modelRegistry,
				model,
				toolNames: ["read"],
				contextFiles: [],
				skills: [],
			};
		}

		// The context the transcript sends: the tools and system prompt of a session built as each process builds its
		// own, and the messages.
		const sizingOptions = processModel();
		const { session: sizing } = await createAgentSession({
			...sizingOptions,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: processSettings(CONTEXT_WINDOW / 2),
		});
		const contextTokens = sessionContextTokens(sizing, messages);
		await sizing.dispose();
		sizingOptions.authStorage.close();

		// The process before the restart: its prompt's reply writes the whole context to a one-hour entry, and the rule
		// waits on the compaction after it.
		const live = recordGateway(contextTokens);
		const liveOptions = processModel();
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		for (const message of messages) sessionManager.appendMessage(message);
		const { session } = await createAgentSession({
			...liveOptions,
			sessionManager,
			settings: processSettings(contextTokens - THRESHOLD_MARGIN),
		});
		try {
			await live.send(session, "first prompt");
			await sessionManager.flush();
		} finally {
			await session.dispose();
			liveOptions.authStorage.close();
			live.restore();
		}
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		// Precondition: the rule waited on the compaction after the reply.
		expect(live.timeline.slice(live.timeline.indexOf("main request"))).toContain(SUMMARY_COMPACTION_WAITS);
		const lastBefore = live.requests.findLast(request => request.kind === "main");
		if (!lastBefore) throw new Error("Expected a main request before the restart");

		// omp restarts a moment later with a threshold above the context, after an edit of `models.yml` that only adds
		// a trailing slash to the gateway's URL.
		await Bun.write(
			modelsYml,
			gatewayModelsYml(CONTEXT_WINDOW).replace(`baseUrl: ${GATEWAY}\n`, `baseUrl: ${GATEWAY}/\n`),
		);
		const resumedOptions = processModel();
		// Precondition: the resumed process's model names the gateway with the trailing slash.
		expect(resumedOptions.model.baseUrl).toBe(`${GATEWAY}/`);
		const resumed = recordGateway(contextTokens);
		const { session: restarted } = await createAgentSession({
			...resumedOptions,
			sessionManager: await SessionManager.open(sessionFile),
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
			resumedOptions.authStorage.close();
			resumed.restore();
		}
	}, 180_000);
});
