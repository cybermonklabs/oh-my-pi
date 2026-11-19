/**
 * A failed turn the session keeps in context and continues from instead of
 * sending it again (a rate limit or a stream cut after visible text, a stream
 * cut after a complete tool call, a malformed call), and whose continuation
 * then succeeds, is still in the model context the session rebuilds from its
 * file, as a resume, a reload or a compaction rebuilds it: the continuation
 * picks up from that turn, so without it the model would never see the first
 * half of the answer, or would see a tool result whose call is gone. The file
 * marks such a turn `continued`; a failed turn the retry replaced, or one whose
 * continuations all failed, stays out of that context. The primary model's
 * requests run the real provider; only its HTTP client is replaced, so no
 * request leaves the process.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	answer,
	COMPLETE_TOOL_CALL_FRAMES,
	CONTINUED_ANSWER,
	CONTINUED_TEXT,
	conversation,
	FIRST_TEXT,
	FRESH_TEXT,
	failedTurn,
	HTTP_RATE_LIMIT,
	MESSAGE_START_FRAME,
	OVERLOADED_FRAME,
	PRIMARY,
	PROVIDER,
	RATE_LIMIT_FRAME,
	renderTurn,
	TEXT_FRAMES,
	TOOL_CALL_ID,
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

describe("a kept and continued turn in the context rebuilt from the session file", () => {
	const sessions = useKeptTurnSessions();
	const { runAndReopen } = sessions;

	// Regression: a rate limit cuts off an answer after its text is on screen,
	// the session waits and the model continues it, and after a resume the
	// model no longer sees the first half of its own answer.
	it("keeps the text of a turn a rate limit cut off, before its continuation", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME },
			{ stream: CONTINUED_ANSWER },
		]);

		expect(result.requests).toBe(2);
		expect(result.rebuilt).toEqual(["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`]);
		expect(result.rebuilt).toEqual(result.live);
		// The transcript still shows the cut-off turn as recovered, and the file says a turn continued from it.
		expect(result.failedEntry).toMatchObject({
			message: { continued: true, retryRecovery: { status: "recovered" } },
		});
	});

	// Regression: a rate limit cuts off an answer after its text and a complete
	// tool call, the session waits and the model reissues the call, and after a
	// resume the model sees a tool result whose call is gone, and no longer the
	// first half of its answer.
	it("keeps a turn a rate limit cut off after a complete tool call, with its call and result", async () => {
		const result = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + COMPLETE_TOOL_CALL_FRAMES + RATE_LIMIT_FRAME },
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

	// Regression: a rate limit cuts off an answer and every continuation is
	// refused until the attempts are spent; the user resumes the session and
	// retries, and after the next resume the model sees the abandoned first
	// half of the answer in front of the fresh one.
	it("leaves out a kept turn whose continuations all failed, after a resume and a retry", async () => {
		const first = await runAndReopen([
			{ stream: MESSAGE_START_FRAME + TEXT_FRAMES + RATE_LIMIT_FRAME },
			HTTP_RATE_LIMIT,
		]);
		expect(first.failedEntry).toMatchObject({ message: { retryRecovery: { status: "superseded" } } });
		expect(first.failedEntry).not.toMatchObject({ message: { continued: true } });

		sessions.answers = [{ stream: answer(FRESH_TEXT) }];
		const resumed = await sessions.startSession(first.reopened, {
			messages: first.reopened.buildSessionContext().messages,
		});
		expect(await resumed.retry()).toBe(true);
		await resumed.waitForIdle();
		const reopened = await sessions.reopen(first.reopened);

		const rebuilt = conversation(reopened.buildSessionContext().messages);
		expect(rebuilt).toEqual(["user", `assistant[text:${FRESH_TEXT}]`]);
		expect(rebuilt).toEqual(conversation(resumed.agent.state.messages));
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
		{ cut: "a cut stream", frame: OVERLOADED_FRAME, retried: false },
		{ cut: "a rate limit", frame: RATE_LIMIT_FRAME, retried: true },
	])("a turn $cut ended after its text", ({ frame, retried }) => {
		const cutTurn = { stream: MESSAGE_START_FRAME + TEXT_FRAMES + frame };
		const keptConversation = ["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`];

		// The marker changes nothing on screen: after a reload the transcript
		// draws the kept turn as it drew it live (a cut stream as its error, a
		// rate limit as the retried note).
		it("is drawn after a reload as it was drawn live", async () => {
			const result = await runAndReopen([cutTurn, { stream: CONTINUED_ANSWER }]);
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
			const result = await runAndReopen([cutTurn, { stream: CONTINUED_ANSWER }]);
			sessions.answers = [{ stream: answer(FRESH_TEXT) }];
			// The resume builds the live context from the file, as the CLI's `--resume` does.
			const resumed = await sessions.startSession(result.reopened, {
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
			const result = await runAndReopen(
				[{ stream: answer("An earlier answer. ".repeat(1_500)) }, cutTurn, { stream: CONTINUED_ANSWER }],
				{
					prompts: ["An earlier question", "Answer in two parts"],
					settings: { "compaction.keepRecentTokens": 2_000 },
					compactionSummary: "The earlier question was answered.",
				},
			);

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
});
