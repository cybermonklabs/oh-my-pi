/**
 * A failed turn the session keeps in context and continues from instead of
 * sending it again (a stream cut after visible text or after a complete tool
 * call, a malformed call), and whose continuation then succeeds, is still in
 * the model context the session rebuilds from its file, as a resume, a reload
 * or a compaction rebuilds it: the continuation
 * picks up from that turn, so without it the model would never see the first
 * half of the answer, or would see a tool result whose call is gone. The file
 * marks such a turn `continued`; a failed turn the retry replaced, or one whose
 * continuations all failed, stays out of that context. The hidden reminder a
 * continuation appends after the turn (pick up where it stopped) stays exactly
 * where and while the turn does. The primary model's requests run the real
 * provider; only its HTTP client is replaced, so no request leaves the process.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CONTINUE_REMINDER_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import {
	answer,
	branchConversation,
	COMPLETE_TOOL_CALL_FRAMES,
	CONTINUED_ANSWER,
	CONTINUED_TEXT,
	conversation,
	FIRST_TEXT,
	FRESH_TEXT,
	failedTurn,
	HTTP_RATE_LIMIT,
	type KeptTurnSessionOptions,
	MESSAGE_START_FRAME,
	modelConversation,
	OVERLOADED_FRAME,
	PRIMARY,
	type PrimaryAnswer,
	PROVIDER,
	RATE_LIMIT_FRAME,
	renderTurn,
	TEXT_FRAMES,
	TOOL_CALL_ID,
	textFrames,
	useKeptTurnSessions,
} from "./helpers/kept-turn-session";

/** A Gemini answer whose only part is `text`, ending on `finishReason`, as one server-sent event. */
function geminiAnswer(text: string, finishReason: string): string {
	const chunk = {
		candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The conversation shape of each assistant entry of `sessionManager` marked `continued`, in file order. */
function continuedTurns(sessionManager: SessionManager): string[] {
	return sessionManager
		.getEntries()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.continued
				? conversation([entry.message])
				: [],
		);
}

/** A primary turn cut off after {@link FIRST_TEXT}, by the failure the case's continuation follows. */
const CUT = Symbol("cut after its text");

/** What one primary request answers: a turn {@link CUT} off, or a whole answer with this text. */
type PrimaryTurn = typeof CUT | string;

/** A case's session when its primary answers `turns` in order, the last repeating. */
interface PrimarySetup {
	answers: PrimaryAnswer[];
	options: KeptTurnSessionOptions;
}

/** The Anthropic primary, whose cut turns end on `frame` after their text. */
function anthropicPrimary(turns: PrimaryTurn[], frame: string): PrimarySetup {
	return {
		answers: turns.map(turn => ({ stream: turn === CUT ? MESSAGE_START_FRAME + TEXT_FRAMES + frame : answer(turn) })),
		options: {},
	};
}

/**
 * A Gemini primary on the real `google-generative-ai` provider, whose cut
 * turns Gemini rejects as a malformed call (MALFORMED_FUNCTION_CALL) after
 * their text; only its `fetch` is replaced.
 */
function geminiPrimary(turns: PrimaryTurn[]): PrimarySetup {
	const model = getBundledModel("google", "gemini-2.5-flash");
	if (!model) throw new Error("Expected bundled google/gemini-2.5-flash");
	const bodies = turns.map(turn =>
		turn === CUT ? geminiAnswer(FIRST_TEXT, "MALFORMED_FUNCTION_CALL") : geminiAnswer(turn, "STOP"),
	);
	const geminiFetch = async (): Promise<Response> => {
		const body = bodies.length > 1 ? bodies.shift()! : bodies[0]!;
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return {
		answers: [],
		options: {
			model,
			streamFn: (requested, context, options) =>
				streamGoogle(requested as Model<"google-generative-ai">, context, {
					...options,
					apiKey: `${requested.provider}-test-key`,
					fetch: geminiFetch as FetchImpl,
				}),
		},
	};
}

describe("a kept and continued turn in the context rebuilt from the session file", () => {
	const sessions = useKeptTurnSessions();
	const { runAndReopen } = sessions;
	/** The Gemini primary of the malformed-call rows, with its key set for the case. */
	const malformedCallPrimary = (turns: PrimaryTurn[]): PrimarySetup => {
		sessions.authStorage.keys.setRuntime("google", "google-test-key");
		return geminiPrimary(turns);
	};

	// Regression: the stream is cut after a complete tool call, the session
	// continues the turn from its tool result, and after a resume the model
	// sees a tool result whose call is gone.
	it("keeps a turn a cut stream ended after a complete tool call, with its call and result", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + OVERLOADED_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);

		expect(result.requests).toBe(2);
		expect(result.rebuilt).toEqual([
			"user",
			`assistant[text:${FIRST_TEXT} call:${TOOL_CALL_ID}]`,
			`result:${TOOL_CALL_ID}`,
			`assistant[text:${CONTINUED_TEXT}]`,
		]);
		expect(result.rebuilt).toEqual(result.live);
		expect(result.failedEntry).toMatchObject({
			message: { continued: true, retryRecovery: { status: "recovered" } },
		});
	});

	// Regression: the stream is cut after visible text, the session continues
	// the answer from where it stopped, and after a resume the model sees the
	// continuation with nothing before it.
	it("keeps the text of a turn a cut stream ended, before its continuation", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + OVERLOADED_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);

		expect(result.requests).toBe(2);
		expect(result.rebuilt).toEqual(["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`]);
		expect(result.rebuilt).toEqual(result.live);
	});

	// Regression: Gemini rejects a call the model wrote as text
	// (MALFORMED_FUNCTION_CALL) after that text is on screen, the session
	// continues with a corrective reminder, and after a resume the model no
	// longer sees what it wrote. Runs the real `google-generative-ai` provider;
	// only its `fetch` is replaced.
	it("keeps the text of a turn a malformed call ended, before its continuation", async () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		if (!model) throw new Error("Expected bundled google/gemini-2.5-flash");
		sessions.authStorage.keys.setRuntime("google", "google-test-key");
		const geminiAnswers = [geminiAnswer(FIRST_TEXT, "MALFORMED_FUNCTION_CALL"), geminiAnswer(CONTINUED_TEXT, "STOP")];
		let geminiRequests = 0;
		const geminiFetch = async (): Promise<Response> => {
			geminiRequests++;
			const body = geminiAnswers.length > 1 ? geminiAnswers.shift()! : geminiAnswers[0]!;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const result = await runAndReopen([], {
			model,
			streamFn: (requested, context, options) =>
				streamGoogle(requested as Model<"google-generative-ai">, context, {
					...options,
					apiKey: `${requested.provider}-test-key`,
					fetch: geminiFetch as FetchImpl,
				}),
		});

		expect(geminiRequests).toBe(2);
		expect(result.rebuilt).toEqual(["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`]);
		expect(result.rebuilt).toEqual(result.live);
		expect(result.failedEntry).toMatchObject({
			message: { continued: true, errorMessage: expect.stringContaining("MALFORMED_FUNCTION_CALL") },
		});
		// The continuation ran outside any retry: nothing in the file says it was retried.
		expect(result.failedEntry).not.toMatchObject({ message: { retryRecovery: expect.anything() } });
	});

	// A cut stream whose continuations are cut too, until the continuation cap
	// ends the run on the error: no continuation succeeded, so no kept turn is
	// marked and the rebuild leaves them all out.
	it("leaves out the turns cut streams ended when every continuation failed", async () => {
		const result = await runAndReopen([{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + OVERLOADED_FRAME }]);

		expect(result.requests).toBeGreaterThan(1);
		expect(result.rebuilt).toEqual(["user"]);
		const continued = result.reopened
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.continued);
		expect(continued).toEqual([]);
	});

	// Regression: a cut stream's continuation is aborted and `/compact`
	// rebuilds the live context without the unmarked kept turn; a later turn
	// that no new prompt starts then marked the turn anyway, so the context
	// rebuilt from the file held a turn the live one had dropped.
	it("leaves unmarked a kept turn the live context dropped before a later turn succeeded", async () => {
		sessions.answers = [
			{ stream: answer("An earlier answer. ".repeat(1_500)) },
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + OVERLOADED_FRAME },
			{ stream: MESSAGE_START_FRAME + textFrames(" and"), held: true },
			{ stream: CONTINUED_ANSWER },
		];
		const sessionManager = sessions.createSessionManager();
		const session = await sessions.startSession(sessionManager, {
			settings: { "compaction.keepRecentTokens": 2_000 },
			compactionSummary: "The earlier question was answered.",
		});
		await session.prompt("An earlier question");
		await session.waitForIdle();
		const prompt = session.prompt("Answer in two parts");
		await sessions.answerHeld;
		await session.abort();
		await prompt;
		await session.waitForIdle();
		await session.compact();
		expect(conversation(session.agent.state.messages)).toEqual(["user"]);

		await session.sendCustomMessage({ customType: "go-on", content: "Go on.", display: true }, { triggerTurn: true });
		await session.waitForIdle();

		const live = conversation(session.agent.state.messages);
		expect(live).toEqual(["user", `assistant[text:${CONTINUED_TEXT}]`]);
		const reopened = await sessions.reopen(sessionManager);
		expect(conversation(reopened.buildSessionContext().messages)).toEqual(live);
		expect(continuedTurns(reopened)).toEqual([]);
	});

	// Regression: cut streams end the run at the continuation cap, `/retry`
	// continues from the turns the continuations kept, and after a resume the
	// model no longer sees them: the run's error had forgotten them before
	// the retry succeeded.
	it("marks the kept turns a manual retry continued from after the run ended at its cap", async () => {
		const cut = (text: string) => ({ stream: MESSAGE_START_FRAME + textFrames(text) + OVERLOADED_FRAME });
		sessions.answers = [cut("One."), cut("Two."), cut("Three."), cut("Four."), { stream: CONTINUED_ANSWER }];
		const sessionManager = sessions.createSessionManager();
		const session = await sessions.startSession(sessionManager);
		await session.prompt("Answer in two parts");
		await session.waitForIdle();
		expect(sessions.requests).toBe(4);

		expect(await session.retry()).toBe(true);
		await session.waitForIdle();

		const kept = ["assistant[text:One.]", "assistant[text:Two.]", "assistant[text:Three.]"];
		const live = conversation(session.agent.state.messages);
		expect(live).toEqual(["user", ...kept, `assistant[text:${CONTINUED_TEXT}]`]);
		const reopened = await sessions.reopen(sessionManager);
		expect(conversation(reopened.buildSessionContext().messages)).toEqual(live);
		expect(continuedTurns(reopened)).toEqual(kept);
	});

	// Every other end of a run that kept a turn (here a stated wait past
	// retry.maxDelayMs on its continuation) marks no `continued`, so the
	// rebuild leaves the turn out, as it did before the marker existed.
	it("leaves out a kept turn whose continuation stated a wait past retry.maxDelayMs", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME },
			{ ...HTTP_RATE_LIMIT, retryAfterSeconds: 600 },
		]);

		expect(result.rebuilt).toEqual(["user"]);
		expect(result.failedEntry).toMatchObject({ message: { content: [{ type: "text", text: FIRST_TEXT }] } });
		expect(result.failedEntry).not.toMatchObject({ message: { continued: true } });
	});

	// Regression guard: a failed tool-call turn the retry replaced (it carries
	// `retryRecovery` and no `continued`) has its entries, its synthetic result
	// included, on the path on disk; the rebuilt context must not bring the
	// turn back, or the model would see a turn its live context dropped.
	it("leaves out a failed tool-call turn the retry replaced", async () => {
		const sessionManager = sessions.createSessionManager();
		const usage: AssistantMessage["usage"] = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const turn = { api: "anthropic-messages", provider: PROVIDER, model: PRIMARY, usage } as const;
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Answer" }], timestamp: 1 });
		sessionManager.appendMessage({
			...turn,
			role: "assistant",
			content: [{ type: "toolCall", id: TOOL_CALL_ID, name: "read", arguments: { path: "/tmp/notes.txt" } }],
			stopReason: "error",
			errorMessage: "503 service unavailable",
			// What the retry writes on a turn it replaced, and on every marked turn of a file written before `continued`.
			retryRecovery: {
				kind: "auto-retry",
				status: "recovered",
				attempt: 1,
				recoveredAt: "2026-11-19T00:00:00.000Z",
				recovery: "plain",
				note: "error; retried",
			},
			timestamp: 2,
		});
		const syntheticResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: TOOL_CALL_ID,
			toolName: "read",
			content: [{ type: "text", text: "Tool call was not executed" }],
			details: { __synthetic: true, executed: false },
			isError: true,
			timestamp: 3,
		};
		sessionManager.appendMessage(syntheticResult);
		sessionManager.appendMessage({
			...turn,
			role: "assistant",
			content: [{ type: "text", text: CONTINUED_TEXT }],
			stopReason: "stop",
			timestamp: 4,
		});
		const reopened = await sessions.reopen(sessionManager);

		const rebuilt = conversation(reopened.buildSessionContext().messages);
		expect(rebuilt.filter(message => message.startsWith("assistant"))).toEqual([`assistant[text:${CONTINUED_TEXT}]`]);
	});

	describe.each([
		{
			cut: "a cut stream",
			primary: (turns: PrimaryTurn[]) => anthropicPrimary(turns, OVERLOADED_FRAME),
			retried: false,
		},
		{
			cut: "a malformed call",
			primary: malformedCallPrimary,
			retried: false,
		},
	])("a turn $cut ended after its text", ({ primary, retried }) => {
		const keptConversation = ["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`];

		// The marker changes nothing on screen: after a reload the transcript
		// draws the kept turn as it drew it live (a cut stream or a malformed
		// call as its error).
		it("is drawn after a reload as it was drawn live", async () => {
			const { answers, options } = primary([CUT, CONTINUED_TEXT]);
			const result = await runAndReopen(answers, options);
			const live = failedTurn(sessions.drawnTurns(result.session));
			const reloaded = failedTurn(result.reopened.buildSessionContext({ transcript: true }).messages);
			if (!live || !reloaded) throw new Error("Expected the kept turn live and in the reloaded transcript");

			const lines = renderTurn(reloaded);
			expect(lines).toEqual(renderTurn(live));
			expect(lines.some(line => line.includes(FIRST_TEXT))).toBe(true);
			expect(lines.some(line => line.includes("retried"))).toBe(retried);
			expect(lines.some(line => line.includes("Error:"))).toBe(!retried);
		});

		// Regression: after a resume, the next request no longer carries the
		// first half of the answer the continuation finished.
		it("is sent to the model again after a resume", async () => {
			const { answers, options } = primary([CUT, CONTINUED_TEXT, FRESH_TEXT]);
			const result = await runAndReopen(answers, options);
			// The resume builds the live context from the file, as the CLI's `--resume` does.
			const resumed = await sessions.startSession(result.reopened, {
				...options,
				messages: result.reopened.buildSessionContext().messages,
			});

			await resumed.prompt("And then?");
			await resumed.waitForIdle();

			expect(conversation(sessions.requestMessages.at(-1) ?? [])).toEqual([...keptConversation, "user"]);
			const reopened = await sessions.reopen(result.reopened);
			const rebuilt = conversation(reopened.buildSessionContext().messages);
			expect(rebuilt).toEqual([...keptConversation, "user", `assistant[text:${FRESH_TEXT}]`]);
			expect(rebuilt).toEqual(conversation(resumed.agent.state.messages));
		});

		// Regression: a compaction after the continuation keeps the turn's prompt
		// and what follows it, yet the context it rebuilds drops the kept turn.
		// The earlier answer is long and the kept-recent budget small, so the
		// cut falls on the prompt of the kept turn.
		it("stays in the kept region of a compaction after its continuation", async () => {
			const { answers, options } = primary(["An earlier answer. ".repeat(1_500), CUT, CONTINUED_TEXT]);
			const result = await runAndReopen(answers, {
				...options,
				prompts: ["An earlier question", "Answer in two parts"],
				settings: { "compaction.keepRecentTokens": 2_000 },
				compactionSummary: "The earlier question was answered.",
			});

			await result.session.compact();

			const live = conversation(result.session.agent.state.messages);
			expect(live).toEqual(keptConversation);
			const reopened = await sessions.reopen(result.session.sessionManager);
			expect(conversation(reopened.buildSessionContext().messages)).toEqual(live);
			const entries = reopened.getEntries();
			const compaction = entries.findLast(entry => entry.type === "compaction");
			const prompt = entries.findLast(entry => entry.type === "message" && entry.message.role === "user");
			expect(compaction).toMatchObject({ firstKeptEntryId: prompt?.id });
		});
	});

	describe.each([
		{
			continuation: "the stream-stall continuation",
			primary: (turns: PrimaryTurn[]) => anthropicPrimary(turns, OVERLOADED_FRAME),
		},
		{
			continuation: "the malformed-call continuation",
			primary: malformedCallPrimary,
		},
	])("the reminder $continuation sends after the kept turn", ({ primary }) => {
		const reminder = expect.stringMatching(/^developer:/);
		const keptTurn = `assistant[text:${FIRST_TEXT}]`;
		const continuation = `assistant[text:${CONTINUED_TEXT}]`;

		// Regression: the reminder lived only in the live context, so after a
		// reload the model read the continuation right after the kept turn, with
		// nothing between them that asked for it.
		it("stays between the kept turn and its continuation after a reload, as it is live", async () => {
			const { answers, options } = primary([CUT, CONTINUED_TEXT]);
			const result = await runAndReopen(answers, options);

			const live = modelConversation(result.session.agent.state.messages);
			expect(live).toEqual(["user", keptTurn, reminder, continuation]);
			// The continuation's own request carried it in that place.
			expect(modelConversation(sessions.requestMessages.at(-1) ?? [])).toEqual(live.slice(0, -1));
			expect(modelConversation(result.reopened.buildSessionContext().messages)).toEqual(live);
			expect(branchConversation(result.reopened)).toEqual([
				"user",
				keptTurn,
				`custom:${CONTINUE_REMINDER_MESSAGE_TYPE}`,
				continuation,
			]);
		});

		// The reminder became a hidden custom message so the file can hold it:
		// the model must still get the developer message it got before, and the
		// transcript must still draw nothing for it.
		it("reaches the model as the developer message it was before the file held it", async () => {
			const { answers, options } = primary([CUT, CONTINUED_TEXT]);
			const result = await runAndReopen(answers, options);

			const hidden = result.session.agent.state.messages.find(
				message => message.role === "custom" && message.customType === CONTINUE_REMINDER_MESSAGE_TYPE,
			);
			if (hidden?.role !== "custom" || typeof hidden.content !== "string") {
				throw new Error("Expected the continue reminder as a custom message in the live context");
			}
			expect(hidden.display).toBe(false);
			const developer: AgentMessage = {
				role: "developer",
				content: [{ type: "text", text: hidden.content }],
				attribution: "agent",
				timestamp: hidden.timestamp,
			};
			expect(convertToLlm([hidden])).toEqual(convertToLlm([developer]));
		});

		// Regression: after a resume, the next request carried the kept turn and
		// its continuation without the reminder the model had read between them.
		it("is sent to the model again after a resume", async () => {
			const { answers, options } = primary([CUT, CONTINUED_TEXT, FRESH_TEXT]);
			const result = await runAndReopen(answers, options);
			const live = modelConversation(result.session.agent.state.messages);
			const resumed = await sessions.startSession(result.reopened, {
				...options,
				messages: result.reopened.buildSessionContext().messages,
			});

			await resumed.prompt("And then?");
			await resumed.waitForIdle();

			expect(live).toEqual(["user", keptTurn, reminder, continuation]);
			expect(modelConversation(sessions.requestMessages.at(-1) ?? [])).toEqual([...live, "user"]);
		});

		// Regression: a compaction after the continuation keeps the kept turn and
		// its continuation, and the context it rebuilds drops the reminder between
		// them. The earlier answer is long and the kept-recent budget small, so the
		// cut falls on the prompt of the kept turn.
		it("stays between the kept turn and its continuation after a compaction", async () => {
			const { answers, options } = primary(["An earlier answer. ".repeat(1_500), CUT, CONTINUED_TEXT]);
			const result = await runAndReopen(answers, {
				...options,
				prompts: ["An earlier question", "Answer in two parts"],
				settings: { "compaction.keepRecentTokens": 2_000 },
				compactionSummary: "The earlier question was answered.",
			});
			const kept = modelConversation(result.session.agent.state.messages).slice(-4);
			expect(kept).toEqual(["user", keptTurn, reminder, continuation]);

			await result.session.compact();

			// The summary reaches the model as a user message, then the kept region.
			const live = modelConversation(result.session.agent.state.messages);
			expect(live).toEqual(["user", ...kept]);
			const reopened = await sessions.reopen(result.session.sessionManager);
			expect(modelConversation(reopened.buildSessionContext().messages)).toEqual(live);
		});

		// Regression guard: a kept turn no continuation finished stays out of a
		// rebuilt context, and so must the reminders recorded after it, or the
		// model would read "continue where you stopped" after nothing.
		it("leaves out the kept turns and their reminders when every continuation failed", async () => {
			const { answers, options } = primary([CUT]);
			const result = await runAndReopen(answers, options);

			expect(sessions.requestMessages.length).toBeGreaterThan(1);
			expect(branchConversation(result.reopened)).toContain(`custom:${CONTINUE_REMINDER_MESSAGE_TYPE}`);
			expect(modelConversation(result.reopened.buildSessionContext().messages)).toEqual(["user"]);
		});
	});

	// Regression guard: the kept turn's entry is written from a persistence
	// slot that can still be pending when the session continues the turn. A
	// reminder recorded first would sit in front of the turn in the file, and
	// the context rebuilt from it would lose the reminder.
	it("records a continue reminder only once the kept turn's own entry is written", async () => {
		const model = getBundledModel(PROVIDER, PRIMARY);
		if (!model) throw new Error(`Expected bundled ${PROVIDER}/${PRIMARY}`);
		const sessionManager = SessionManager.inMemory(sessions.tempDir.path());
		const prompt: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Answer in two parts" }],
			timestamp: 1,
		};
		const turn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: FIRST_TEXT }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Anthropic stream stalled while waiting for the next event",
			errorId: AIError.create(AIError.Flag.Transient),
			timestamp: 2,
		};
		const messages: AgentMessage[] = [prompt, turn];
		const turnWritten = Promise.withResolvers<void>();
		// The members a stream-stall continuation reads; the turn's slot settles when
		// the test says so, and its entry is found by the turn's persistence key.
		const host = {
			agent: { state: { messages }, appendMessage: (message: AgentMessage) => messages.push(message) },
			sessionManager,
			settings: Settings.isolated(),
			model: () => model,
			textOutputCommitted: () => true,
			abortInProgress: () => false,
			isDisposed: () => false,
			streamingEditAbortTriggered: () => false,
			promptGeneration: () => 0,
			scheduleAgentContinue: () => {},
			waitForSessionMessagePersistence: (message: AgentMessage) =>
				message === turn ? turnWritten.promise : Promise.resolve(),
			persistedAssistantEntryId: () => undefined,
		} as unknown as TurnRecoveryHost;
		const reminderRecorded = Promise.withResolvers<void>();
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message") reminderRecorded.resolve();
		};

		const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
		expect(recovery.handleCommittedTextStreamStall(turn)).toBe(true);
		expect(modelConversation(messages)).toEqual([
			"user",
			`assistant[text:${FIRST_TEXT}]`,
			expect.stringMatching(/^developer:/),
		]);

		// The slot writes the turn's entry and settles.
		sessionManager.appendMessage(prompt);
		sessionManager.appendMessage(turn);
		turnWritten.resolve();
		await reminderRecorded.promise;

		expect(branchConversation(sessionManager)).toEqual([
			"user",
			`assistant[text:${FIRST_TEXT}]`,
			`custom:${CONTINUE_REMINDER_MESSAGE_TYPE}`,
		]);
	});
});
