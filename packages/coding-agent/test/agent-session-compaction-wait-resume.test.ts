/**
 * The cut rule's "waits" for an automatic model-summary compaction keeps every maintenance point from starting a
 * background summary (compaction speculation) for a cut that cannot run, and the session records it, so a process that
 * resumes the session holds it too. These cases restart omp on a session near its compaction threshold, within the
 * prompt cache entry's lifetime unless a case says otherwise, and read every request the resumed process's first
 * prompt sends.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import {
	processSettings,
	recordGateway,
	type SentRequest,
	SUMMARY_COMPACTION_WAITS,
	transcript,
} from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold sits this far below the transcript's context: inside the band where a threshold pass defers. */
const THRESHOLD_MARGIN = 2_000;
/**
 * The threshold sits this far above the transcript's context: the context is in the band below it where a background
 * summary starts, and the few prompts the processes send keep it there.
 */
const BAND_MARGIN = 4_000;
const HOUR_MS = 60 * 60_000;

/** The compaction threshold of each process around a restart, and when omp restarts. */
interface RestartScenario {
	/** The threshold of the process before the restart, given the context the transcript sends. */
	liveThreshold(contextTokens: number): number;
	/** The threshold of the resumed process, given the context the transcript sends. */
	resumedThreshold(contextTokens: number): number;
	/** How long after the first process exits omp restarts; a moment unless given. */
	restartAfterMs?: number;
}

/** Past the threshold on both sides of the restart: the rule waits on the compaction before it and after it. */
const PAST_THE_THRESHOLD: RestartScenario = {
	liveThreshold: contextTokens => contextTokens - THRESHOLD_MARGIN,
	resumedThreshold: contextTokens => contextTokens - THRESHOLD_MARGIN,
};

/**
 * The rule waits on the compaction before the restart; omp restarts with a higher threshold (a configuration change
 * across the restart), so the resumed context is in the band below it, where no cut rule is asked.
 */
const BAND_AFTER_A_WAIT: RestartScenario = {
	liveThreshold: contextTokens => contextTokens - THRESHOLD_MARGIN,
	resumedThreshold: contextTokens => contextTokens + BAND_MARGIN,
};

/** {@link BAND_AFTER_A_WAIT}, with omp restarting after the one-hour cache entry the rule waited on lapsed. */
const BAND_AFTER_A_LAPSE: RestartScenario = { ...BAND_AFTER_A_WAIT, restartAfterMs: HOUR_MS + 60_000 };

/** In the band below the threshold on both sides of the restart: the rule is never asked about the compaction. */
const BAND_WITHOUT_A_WAIT: RestartScenario = {
	liveThreshold: contextTokens => contextTokens + BAND_MARGIN,
	resumedThreshold: contextTokens => contextTokens + BAND_MARGIN,
};

interface ProcessRun {
	/** Every request the process sent, oldest first. */
	requests: SentRequest[];
	/** Each request (`<kind> request`) and each cut rule decision (`cut rule: <site> <reason>`), in order. */
	timeline: string[];
	/** Whether the branch holds a compaction when the process exits. */
	compacted: boolean;
	/** The session file the process wrote. */
	sessionFile: string;
}

describe("a model-summary compaction the cut rule waits on, across a restart", () => {
	const tempDirs: TempDir[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
	});

	/**
	 * One process on `sessionManager`'s session: sends each prompt and lets its background summary settle before the
	 * next one, then exits. Every request it sends is recorded; main requests are answered with a reply that wrote
	 * `replyPromptTokens` to the prompt cache.
	 */
	async function runProcess(
		tempDir: TempDir,
		sessionManager: SessionManager,
		thresholdTokens: number,
		replyPromptTokens: number,
		prompts: string[],
	): Promise<ProcessRun> {
		const gateway = recordGateway(replyPromptTokens);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: processSettings(thresholdTokens),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			for (const prompt of prompts) await gateway.send(session, prompt);
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await sessionManager.flush();
			return {
				requests: gateway.requests,
				timeline: gateway.timeline,
				compacted: sessionManager.getBranch().some(entry => entry.type === "compaction"),
				sessionFile,
			};
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}

	interface Restart {
		/** The process before the restart. */
		live: ProcessRun;
		/** The resumed process. */
		resumed: ProcessRun;
	}

	const restarts = new Map<RestartScenario, Promise<Restart>>();

	/**
	 * A session whose context grew ~90,000 tokens over the transcript's newest reply, near a custom compaction
	 * threshold: its process sends two prompts on `scenario`'s live threshold and exits; omp restarts on the same
	 * session file, at once or `scenario.restartAfterMs` later, and sends one prompt on its resumed threshold. Past the
	 * threshold the cut rule waits on the model-summary compaction while the one-hour entry is live: a compaction would
	 * be back at the threshold within a request or two. Run once for each scenario.
	 */
	function restartOn(scenario: RestartScenario): Promise<Restart> {
		const cached = restarts.get(scenario);
		if (cached) return cached;
		const restart = (async () => {
			const tempDir = TempDir.createSync("@pi-compaction-wait-resume-");
			tempDirs.push(tempDir);
			await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(CONTEXT_WINDOW));
			const messages = transcript();

			// The context the transcript sends: the tools and system prompt of a session built as each process builds
			// its own, and the messages.
			const sizingAuth = createInMemoryAuthStorage();
			const sizingRegistry = new ModelRegistry(sizingAuth, tempDir.join("models.yml"));
			const sizingModel = sizingRegistry.find("anthropic", "claude-opus-5-5");
			if (!sizingModel) throw new Error("Expected the gateway's claude-opus-5-5");
			const { session: sizing } = await createAgentSession({
				...gatewaySessionOptions(tempDir),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage: sizingAuth,
				modelRegistry: sizingRegistry,
				settings: processSettings(CONTEXT_WINDOW / 2),
				model: sizingModel,
				toolNames: ["read"],
				contextFiles: [],
				skills: [],
			});
			const contextTokens =
				computeNonMessageTokens(sizing, sizing.agent.tokenizer, sizing.settings.revision) +
				sizing.agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
			await sizing.dispose();
			sizingAuth.close();

			// The process before the restart runs on the session it resumed; omp restarts on its file.
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			for (const message of messages) sessionManager.appendMessage(message);
			const live = await runProcess(tempDir, sessionManager, scenario.liveThreshold(contextTokens), contextTokens, [
				"first prompt",
				"second prompt",
			]);
			const restartAfterMs = scenario.restartAfterMs;
			const now = Date.now;
			const clock =
				restartAfterMs === undefined
					? undefined
					: vi.spyOn(Date, "now").mockImplementation(() => now.call(Date) + restartAfterMs);
			try {
				const resumed = await runProcess(
					tempDir,
					await SessionManager.open(live.sessionFile),
					scenario.resumedThreshold(contextTokens),
					contextTokens,
					["resumed prompt"],
				);
				return { live, resumed };
			} finally {
				clock?.mockRestore();
			}
		})();
		restarts.set(scenario, restart);
		return restart;
	}

	it("sends the resumed process's first main request on the prefix the last request before the restart sent", async () => {
		const { live, resumed } = await restartOn(PAST_THE_THRESHOLD);
		// Before the restart the rule waited on the compaction and nothing was cut.
		expect({ waited: live.timeline.includes(SUMMARY_COMPACTION_WAITS), compacted: live.compacted }).toEqual({
			waited: true,
			compacted: false,
		});
		const lastBefore = live.requests.findLast(request => request.kind === "main");
		const resumedMain = resumed.requests.find(request => request.kind === "main");
		if (!lastBefore || !resumedMain) throw new Error("Expected a main request on each side of the restart");
		expect({
			tools: withoutCacheControl(resumedMain.body.tools) === withoutCacheControl(lastBefore.body.tools),
			system: withoutCacheControl(resumedMain.body.system) === withoutCacheControl(lastBefore.body.system),
			continues: continuesCachedPrompt(lastBefore.body, resumedMain.body),
			compacted: resumed.compacted,
		}).toEqual({ tools: true, system: true, continues: true, compacted: false });
	}, 180_000);

	it("sends no summary request after the restart while the rule waits on the same live cache entry", async () => {
		const { live, resumed } = await restartOn(PAST_THE_THRESHOLD);
		// Before the restart: once the rule waited, no later point of that process requested a summary.
		const firstWait = live.timeline.indexOf(SUMMARY_COMPACTION_WAITS);
		expect(firstWait).toBeGreaterThanOrEqual(0);
		expect(live.timeline.slice(firstWait)).not.toContain("summary request");
		// After the restart the entry is as live: the rule still waits on the compaction and nothing is cut.
		expect({
			waits: resumed.timeline.includes(SUMMARY_COMPACTION_WAITS),
			admitted: resumed.timeline.filter(
				entry => entry.startsWith("cut rule: compaction-soft ") && entry !== SUMMARY_COMPACTION_WAITS,
			),
			compacted: resumed.compacted,
		}).toEqual({ waits: true, admitted: [], compacted: false });
		// So the resumed process requests no summary either: a summary costs a model call for a cut that cannot run.
		expect(resumed.timeline).not.toContain("summary request");
	}, 180_000);

	it("starts no background summary after the restart in the band below the threshold while the recorded wait holds", async () => {
		const { live, resumed } = await restartOn(BAND_AFTER_A_WAIT);
		// Precondition: before the restart the rule waited on the compaction and nothing was cut.
		expect({ waited: live.timeline.includes(SUMMARY_COMPACTION_WAITS), compacted: live.compacted }).toEqual({
			waited: true,
			compacted: false,
		});
		const lastBefore = live.requests.findLast(request => request.kind === "main");
		const resumedMain = resumed.requests.find(request => request.kind === "main");
		if (!lastBefore || !resumedMain) throw new Error("Expected a main request on each side of the restart");
		// Below the threshold the rule is not asked again: the wait the first process recorded is all that keeps the
		// resumed process from requesting a summary for a cut that cannot run.
		expect({
			summaries: resumed.timeline.filter(entry => entry === "summary request").length,
			continues: continuesCachedPrompt(lastBefore.body, resumedMain.body),
			compacted: resumed.compacted,
		}).toEqual({ summaries: 0, continues: true, compacted: false });
	}, 180_000);

	it.each([
		{ name: "the cache entry the rule waited on lapsed", scenario: BAND_AFTER_A_LAPSE, waited: true },
		{ name: "the rule never waited", scenario: BAND_WITHOUT_A_WAIT, waited: false },
	])(
		"starts a background summary after the restart in the band below the threshold when $name",
		async ({ scenario, waited }) => {
			const { live, resumed } = await restartOn(scenario);
			// Precondition: whether the rule waited on the compaction before the restart.
			expect(live.timeline.includes(SUMMARY_COMPACTION_WAITS)).toBe(waited);
			expect(resumed.timeline).toContain("summary request");
		},
		180_000,
	);
});
