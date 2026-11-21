/**
 * The cut rule's "waits" for an automatic model-summary compaction is kept in memory only: while it holds, no
 * maintenance point starts a background summary (compaction speculation) for a cut that cannot run. These cases
 * restart omp on a session whose real compaction waits, within the prompt cache entry's lifetime, and read every
 * request the resumed process's first prompt sends.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { SUMMARIZATION_SYSTEM_PROMPT } from "@oh-my-pi/pi-agent-core/compaction/utils";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold sits this far below the transcript's context: inside the band where a threshold pass defers. */
const THRESHOLD_MARGIN = 2_000;
/** What the transcript's newest reply says its request sent, far below the context the next requests send. */
const EARLIER_PROMPT_TOKENS = 1_000;
const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(64);
const TURNS = 64;

/** The rule's answer for the model-summary compaction while it waits, as a timeline entry. */
const SUMMARY_COMPACTION_WAITS = "cut rule: compaction-soft waits";

/** A request the gateway received: a main request for the prompt being sent, a summary request, or another. */
interface SentRequest {
	url: string;
	body: MessagesRequest;
	kind: "main" | "summary" | "other";
}

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

/** The transcript a session was resumed with: 64 turns, ~90,000 tokens, whose newest reply sent a small prompt. */
function transcript(): (UserMessage | AssistantMessage)[] {
	const now = Date.now();
	const messages: (UserMessage | AssistantMessage)[] = [];
	for (let i = 0; i < TURNS; i++) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: `turn ${i}: ${FILLER}` }],
			timestamp: now - 60_000,
		});
		const promptTokens = i === TURNS - 1 ? EARLIER_PROMPT_TOKENS : 0;
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `reply ${i}: ${FILLER}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: promptTokens > 0 ? 100 : 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens > 0 ? promptTokens + 100 : 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 59_000,
		});
	}
	return messages;
}

/** Whether `request` is the main request for `prompt`: its last message is the user's prompt. */
function sendsPrompt(request: MessagesRequest, prompt: string): boolean {
	const last = request.messages.at(-1);
	return last?.role === "user" && textOf(last.content).includes(prompt);
}

describe("a model-summary compaction the cut rule waits on, across a restart", () => {
	const tempDirs: TempDir[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
	});

	/** The settings each process loads: summary compaction in the background over `thresholdTokens`. */
	function processSettings(thresholdTokens: number): Settings {
		return Settings.isolated({
			"providers.cacheRetention": "long",
			"compaction.methodOrder": ["soft"],
			"compaction.asyncEnabled": true,
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 4000,
			"compaction.thresholdTokens": thresholdTokens,
		});
	}

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
		const requests: SentRequest[] = [];
		const timeline: string[] = [];
		let current = "";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				const body = JSON.parse(requestBodyText(init) ?? "{}") as MessagesRequest;
				const kind = sendsPrompt(body, current)
					? "main"
					: textOf(body.system).includes(SUMMARIZATION_SYSTEM_PROMPT)
						? "summary"
						: "other";
				requests.push({ url, body, kind });
				timeline.push(`${kind} request`);
				if (url !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${url}`);
				return kind === "main"
					? answer(requests.length, { cacheWriteTokens: replyPromptTokens })
					: answer(requests.length);
			}),
		);
		// The background summary logs when it arms or fails; each prompt waits for that before the next one.
		let speculationSettled: (() => void) | undefined;
		const debug = logger.debug.bind(logger);
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation((message, context) => {
			if (message === "Context cut decision" && context) {
				timeline.push(`cut rule: ${String(context.site)} ${String(context.reason)}`);
			}
			if (message === "Speculative compaction armed" || message === "Speculative compaction failed") {
				speculationSettled?.();
			}
			return debug(message, context);
		});
		const settleSpeculation = async (session: AgentSession): Promise<void> => {
			if (session.compactionSpeculation !== "running") return;
			const settled = Promise.withResolvers<void>();
			speculationSettled = settled.resolve;
			await settled.promise;
		};
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
			for (const prompt of prompts) {
				current = prompt;
				await session.prompt(prompt);
				await session.waitForIdle();
				await settleSpeculation(session);
			}
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await sessionManager.flush();
			return {
				requests,
				timeline,
				compacted: sessionManager.getBranch().some(entry => entry.type === "compaction"),
				sessionFile,
			};
		} finally {
			await session.dispose();
			authStorage.close();
			fetchSpy.mockRestore();
			debugSpy.mockRestore();
		}
	}

	interface Restart {
		/** The process before the restart. */
		live: ProcessRun;
		/** The resumed process. */
		resumed: ProcessRun;
	}

	let restart: Promise<Restart> | undefined;

	/**
	 * A session whose context is just past a custom compaction threshold and whose model-summary compaction the cut
	 * rule waits on: the context grew ~90,000 tokens over the transcript's newest reply, so a compaction would be back
	 * at the threshold within a request or two, and the one-hour entry is live. Its process sends two prompts and
	 * exits; omp restarts a moment later on the same session file and sends one prompt. Run once for both cases.
	 */
	function restartWhileTheRuleWaits(): Promise<Restart> {
		restart ??= (async () => {
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

			// The process before the restart runs on the session it resumed; omp restarts a moment later on its file.
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			for (const message of messages) sessionManager.appendMessage(message);
			const thresholdTokens = contextTokens - THRESHOLD_MARGIN;
			const live = await runProcess(tempDir, sessionManager, thresholdTokens, contextTokens, [
				"first prompt",
				"second prompt",
			]);
			const resumed = await runProcess(
				tempDir,
				await SessionManager.open(live.sessionFile),
				thresholdTokens,
				contextTokens,
				["resumed prompt"],
			);
			return { live, resumed };
		})();
		return restart;
	}

	it("sends the resumed process's first main request on the prefix the last request before the restart sent", async () => {
		const { live, resumed } = await restartWhileTheRuleWaits();
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
		const { live, resumed } = await restartWhileTheRuleWaits();
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
});
