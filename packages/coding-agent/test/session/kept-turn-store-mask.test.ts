/**
 * A failed turn the session keeps in context and continues from after visible
 * text (a cut stream, a rate limit, a malformed call) stays in the context
 * rebuilt from the session after a reload, a resume and a compaction whether
 * session store masking is on or off, and the transcript draws it after a
 * reload as it drew it live. The marker that keeps it (`continued`, set by an
 * `entry_patch` record) is a boolean, which the masking walk leaves as written;
 * with masking on the stored session holds no secret value, so the walk ran.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	answer,
	CONTINUED_TEXT,
	conversation,
	FIRST_TEXT,
	FRESH_TEXT,
	failedTurn,
	type KeptTurnSessionOptions,
	MESSAGE_START_FRAME,
	OVERLOADED_FRAME,
	type PrimaryAnswer,
	RATE_LIMIT_FRAME,
	renderTurn,
	TEXT_FRAMES,
	useKeptTurnSessions,
} from "../helpers/kept-turn-session";

const SECRET = "zq9-synthetic-service-4821";
/** The prompt names the secret, so masking on changes what the session stores. */
const PROMPT = `Answer in two parts, with the key ${SECRET}`;

/** A Gemini answer whose only part is `text`, ending on `finishReason`, as one server-sent event. */
function geminiAnswer(text: string, finishReason: string): string {
	const chunk = {
		candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
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

describe.each([{ masking: true }, { masking: false }])(
	"a kept turn with session store masking $masking",
	({ masking }) => {
		const sessions = useKeptTurnSessions();

		/** The session's agent dir binding, with `secrets.maskSessionStore` set to `masking`. */
		async function bind(manager: SessionManager): Promise<void> {
			const agentDir = sessions.tempDir.join("agent");
			await fs.mkdir(agentDir, { recursive: true });
			const held = new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: SECRET }), agentDir });
			spyOn(storeMask, "processSessionStoreMasker").mockImplementation(dir =>
				dir === agentDir ? held : new storeMask.SessionStoreMasker({ env: () => ({}), agentDir: dir }),
			);
			manager.setStoreMasking({ enabled: () => masking, agentDir });
		}

		/**
		 * Sends `prompts` on a new session bound to masking, whose primary the given setup answers
		 * for, then opens its file again, bound the same way.
		 */
		async function run({ answers, options }: PrimarySetup, prompts: string[], settings?: Record<string, unknown>) {
			sessions.answers = answers;
			const manager = sessions.createSessionManager();
			await bind(manager);
			const session = await sessions.startSession(manager, {
				...options,
				settings,
				compactionSummary: settings ? "The earlier question was answered." : undefined,
			});
			for (const text of prompts) {
				await session.prompt(text);
				await session.waitForIdle();
			}
			const reopened = await sessions.reopen(manager);
			await bind(reopened);
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected the session to persist a file");
			return { session, manager, reopened, file };
		}

		describe.each([
			{ cut: "a cut stream", primary: (turns: PrimaryTurn[]) => anthropicPrimary(turns, OVERLOADED_FRAME) },
			{ cut: "a rate limit", primary: (turns: PrimaryTurn[]) => anthropicPrimary(turns, RATE_LIMIT_FRAME) },
			// Regression: Gemini rejects a call the model wrote as text (MALFORMED_FUNCTION_CALL) after
			// that text is on screen, and the session continues the turn with a corrective reminder;
			// after a reload, a resume or a compaction, with masking on or off, the model no longer sees
			// what it wrote, or the transcript draws the turn as it did not live. Runs the real
			// `google-generative-ai` provider; only its `fetch` is replaced.
			{
				cut: "a malformed call",
				primary: (turns: PrimaryTurn[]) => {
					sessions.authStorage.keys.setRuntime("google", "google-test-key");
					return geminiPrimary(turns);
				},
			},
		])("ended by $cut after its text", ({ primary }) => {
			const keptConversation = ["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`];

			// Regression: after a reload, the model context loses the first half of
			// the answer the continuation finished, or masking rewrites the marker
			// that keeps it; and the transcript draws the turn as it did not live.
			it("stays in the context a reload rebuilds, and is drawn as it was drawn live", async () => {
				const { session, reopened, file } = await run(primary([CUT, CONTINUED_TEXT]), [PROMPT]);

				expect(conversation(reopened.buildSessionContext().messages)).toEqual(keptConversation);
				expect(conversation(reopened.buildSessionContext().messages)).toEqual(
					conversation(session.agent.state.messages),
				);
				const stored = await Bun.file(file).text();
				expect(stored.includes(SECRET)).toBe(!masking);
				expect(stored.includes('"continued":true')).toBe(true);
				const live = failedTurn(sessions.drawnTurns(session));
				const reloaded = failedTurn(reopened.buildSessionContext({ transcript: true }).messages);
				if (!live || !reloaded) throw new Error("Expected the kept turn live and in the reloaded transcript");
				expect(renderTurn(reloaded)).toEqual(renderTurn(live));
			});

			// Regression: after a resume, the next request no longer carries the
			// first half of the answer the continuation finished.
			it("is sent to the model again after a resume", async () => {
				const setup = primary([CUT, CONTINUED_TEXT, FRESH_TEXT]);
				const { reopened } = await run(setup, [PROMPT]);
				const resumed = await sessions.startSession(reopened, {
					...setup.options,
					messages: reopened.buildSessionContext().messages,
				});

				await resumed.prompt("And then?");
				await resumed.waitForIdle();

				expect(conversation(sessions.requestMessages.at(-1) ?? [])).toEqual([...keptConversation, "user"]);
				const again = await sessions.reopen(reopened);
				expect(conversation(again.buildSessionContext().messages)).toEqual(
					conversation(resumed.agent.state.messages),
				);
			});

			// Regression: a compaction after the continuation keeps the kept turn's
			// prompt and what follows it, yet the context it rebuilds drops the turn.
			it("stays in the kept region of a compaction after its continuation", async () => {
				const { session } = await run(
					primary(["An earlier answer. ".repeat(1_500), CUT, CONTINUED_TEXT]),
					["An earlier question", PROMPT],
					{ "compaction.keepRecentTokens": 2_000 },
				);

				await session.compact();

				const live = conversation(session.agent.state.messages);
				expect(live).toEqual(keptConversation);
				const reopened = await sessions.reopen(session.sessionManager);
				await bind(reopened);
				expect(conversation(reopened.buildSessionContext().messages)).toEqual(live);
			});
		});
	},
);
