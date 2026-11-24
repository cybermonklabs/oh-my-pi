/**
 * The cut rule's "waits" for an automatic model-summary compaction is kept in the session as a compaction-wait record
 * that names the model the rule weighed the compaction for, as the prompt cache keys it: the endpoint its requests go
 * to among it. A `models.yml` base URL whose host differs only in letter case names the same endpoint: `fetch` sends
 * the resumed process's requests to the same URL, and they read the same entry. A process resumed after such an edit
 * must keep the wait, as it does after an edit that only adds a trailing slash; ended, it starts a background summary,
 * a model call, for a cut that cannot run yet.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, sessionContextTokens } from "./helpers/agent-session-setup";
import { continuesCachedPrompt, GATEWAY, gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold of the process before the restart sits this far below the transcript's context: the rule waits. */
const THRESHOLD_MARGIN = 2_000;
/** The threshold of the resumed process sits this far above it: the band below the threshold, where no rule is asked. */
const BAND_MARGIN = 4_000;
/** The gateway's URL as `models.yml` spells it after the edit: the same server, its host in capitals. */
const RESPELLED = GATEWAY.replace("gateway.test.local", "Gateway.Test.Local");

/**
 * Puts a layer over the `fetch` a gateway recording installed: each URL as the request names it is kept, and the
 * request goes on to the recording at the URL `fetch` sends it to (scheme and host in lower case). Returns the URLs
 * and a function that removes the layer.
 */
function asFetchSendsIt(): { named: string[]; remove: () => void } {
	const recording = globalThis.fetch;
	const named: string[] = [];
	globalThis.fetch = asGlobalFetch((input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		named.push(url);
		return recording(new URL(url).href, init);
	});
	return { named, remove: () => void (globalThis.fetch = recording) };
}

describe("a model-summary compaction the cut rule waits on, across a restart that respells the model's baseUrl", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts no background summary in the resumed process while the wait holds (host in capitals)", async () => {
		using tempDir = TempDir.createSync("@pi-compaction-wait-base-url-respelling-");
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

		// omp restarts a moment later with a threshold above the context, after an edit of `models.yml` that only
		// writes the gateway's host in capitals.
		await Bun.write(
			modelsYml,
			gatewayModelsYml(CONTEXT_WINDOW).replace(`baseUrl: ${GATEWAY}\n`, `baseUrl: ${RESPELLED}\n`),
		);
		const resumedOptions = processModel();
		// Precondition: the resumed process's model names the gateway in the new spelling.
		expect(resumedOptions.model.baseUrl).toBe(RESPELLED);
		const resumed = recordGateway(contextTokens);
		const sent = asFetchSendsIt();
		const { session: restarted } = await createAgentSession({
			...resumedOptions,
			sessionManager: await SessionManager.open(sessionFile),
			settings: processSettings(contextTokens + BAND_MARGIN),
		});
		try {
			await resumed.send(restarted, "resumed prompt");
			const resumedMain = resumed.requests.find(request => request.kind === "main");
			if (!resumedMain) throw new Error("Expected the resumed process's main request");
			// Precondition: the resumed process names the gateway in the new spelling, and `fetch` sends that to the
			// gateway's URL, where the request reads the entry the rule waited on.
			expect(sent.named[0]).toBe(`${RESPELLED}/v1/messages`);
			expect(new URL(sent.named[0]).href).toBe(`${GATEWAY}/v1/messages`);
			expect(continuesCachedPrompt(lastBefore.body, resumedMain.body)).toBe(true);
			// It requests no summary: one costs a model call for a cut that cannot run.
			expect(resumed.timeline.filter(entry => entry === "summary request").length).toBe(0);
		} finally {
			await restarted.dispose();
			resumedOptions.authStorage.close();
			sent.remove();
			resumed.restore();
		}
	}, 180_000);
});
