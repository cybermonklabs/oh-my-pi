/**
 * The cut rule's "waits" for an automatic model-summary compaction is kept in memory only, so a process that reads a
 * session from its file asks the rule before its first background summary (compaction speculation): the process that
 * wrote the session may have been waiting on the compaction. `omp --fork <session>` (and a resume of a session that
 * moved away) starts on a copy of another process's session file, with the same entries and the same provider
 * prompt-cache key: its first request reads the same cache entry. These cases fork a session whose real compaction
 * waits, right after its process exits, and read every request the fork's first prompt sends.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
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
/** A threshold pass before a prompt that a background summary took over, as a timeline entry. */
const DEFERRED = "threshold pass deferred to a background summary";

/** A request the gateway received: a main request for the prompt being sent, a summary request, or another. */
interface SentRequest {
	body: MessagesRequest;
	kind: "main" | "summary" | "other";
}

/** The transcript the session holds: 64 turns, ~90,000 tokens, whose newest reply sent a small prompt. */
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

describe("a model-summary compaction the cut rule waits on, in a process started on a fork of the session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** The settings the process loads: summary compaction in the background over `thresholdTokens`. */
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

	it("sends no summary request from the fork while the rule waits on the same live cache entry", async () => {
		using tempDir = TempDir.createSync("@pi-compaction-wait-fork-from-");
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

		const requests: SentRequest[] = [];
		const timeline: string[] = [];
		let current = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				if (url !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${url}`);
				const body = JSON.parse(requestBodyText(init) ?? "{}") as MessagesRequest;
				const kind = sendsPrompt(body, current)
					? "main"
					: textOf(body.system).includes(SUMMARIZATION_SYSTEM_PROMPT)
						? "summary"
						: "other";
				requests.push({ body, kind });
				timeline.push(`${kind} request`);
				return kind === "main"
					? answer(requests.length, { cacheWriteTokens: contextTokens })
					: answer(requests.length);
			}),
		);
		// The background summary logs when it arms or fails; each prompt waits for that before the next one.
		let speculationSettled: (() => void) | undefined;
		const debug = logger.debug.bind(logger);
		vi.spyOn(logger, "debug").mockImplementation((message, context) => {
			if (message === "Context cut decision" && context) {
				timeline.push(`cut rule: ${String(context.site)} ${String(context.reason)}`);
			}
			if (message === "Pre-prompt threshold deferred to speculative compaction") timeline.push(DEFERRED);
			if (message === "Speculative compaction armed" || message === "Speculative compaction failed") {
				speculationSettled?.();
			}
			return debug(message, context);
		});
		const send = async (session: AgentSession, prompt: string): Promise<void> => {
			current = prompt;
			await session.prompt(prompt);
			await session.waitForIdle();
			if (session.compactionSpeculation !== "running") return;
			const settled = Promise.withResolvers<void>();
			speculationSettled = settled.resolve;
			await settled.promise;
		};

		// The process before this one: its compaction waits once its second prompt's reply wrote the whole context to a
		// one-hour entry, and it requests no summary after that. It exits.
		const thresholdTokens = contextTokens - THRESHOLD_MARGIN;
		const written = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		for (const message of messages) written.appendMessage(message);
		const { session: before } = await createAgentSession({
			...options,
			sessionManager: written,
			settings: processSettings(thresholdTokens),
		});
		let sessionFile: string | undefined;
		try {
			await send(before, "first prompt");
			await send(before, "second prompt");
			sessionFile = written.getSessionFile();
			await written.flush();
		} finally {
			await before.dispose();
		}
		if (!sessionFile) throw new Error("Expected a persisted session");
		const lastBefore = requests.findLast(request => request.kind === "main");
		if (!lastBefore) throw new Error("Expected the earlier process's main requests");
		// Preconditions: the earlier process waited on the compaction, and no later point of it requested a summary.
		const firstWait = timeline.indexOf(SUMMARY_COMPACTION_WAITS);
		expect(firstWait).toBeGreaterThanOrEqual(0);
		expect(timeline.slice(firstWait)).not.toContain("summary request");
		requests.length = 0;
		timeline.length = 0;

		// `omp --fork <session>` a moment later: a new session file holding the same entries, the same cache key.
		const { session } = await createAgentSession({
			...options,
			sessionManager: await SessionManager.forkFrom(sessionFile, tempDir.path(), tempDir.join("sessions")),
			settings: processSettings(thresholdTokens),
		});
		try {
			await send(session, "forked prompt");
			const forkedMain = requests.find(request => request.kind === "main");
			if (!forkedMain) throw new Error("Expected the fork's main request");
			// Precondition: the fork's request sends the prompt the earlier process's last request sent, so it reads the
			// entry the rule waited on, and the rule still waits on the compaction there.
			expect({
				continues: continuesCachedPrompt(lastBefore.body, forkedMain.body),
				waits: timeline.includes(SUMMARY_COMPACTION_WAITS),
				compacted: session.sessionManager.getBranch().some(entry => entry.type === "compaction"),
			}).toEqual({ continues: true, waits: true, compacted: false });
			// So the fork requests no summary either: a summary costs a model call for a cut that cannot run.
			expect(timeline).not.toContain("summary request");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 180_000);
});
