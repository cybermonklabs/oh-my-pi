/**
 * A failed turn the session keeps in context and continues from after visible
 * text (a cut stream, a rate limit) stays in the context rebuilt from the
 * session after a reload, a resume and a compaction whether session store
 * masking is on or off, and the transcript draws it after a reload as it drew
 * it live. The marker that keeps it (`continued`, set by an `entry_patch`
 * record) is a boolean, which the masking walk leaves as written; with masking
 * on the stored session holds no secret value, so the walk ran.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	answer,
	CONTINUED_ANSWER,
	CONTINUED_TEXT,
	conversation,
	FIRST_TEXT,
	FRESH_TEXT,
	failedTurn,
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

		/** Sends `prompts` on a new session bound to masking, then opens its file again, bound the same way. */
		async function run(answers: PrimaryAnswer[], prompts: string[], settings?: Record<string, unknown>) {
			sessions.answers = answers;
			const manager = sessions.createSessionManager();
			await bind(manager);
			const session = await sessions.startSession(manager, {
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
			{ cut: "a cut stream", frame: OVERLOADED_FRAME },
			{ cut: "a rate limit", frame: RATE_LIMIT_FRAME },
		])("ended by $cut after its text", ({ frame }) => {
			const cutTurn = { stream: MESSAGE_START_FRAME + TEXT_FRAMES + frame };
			const keptConversation = ["user", `assistant[text:${FIRST_TEXT}]`, `assistant[text:${CONTINUED_TEXT}]`];

			// Regression: after a reload, the model context loses the first half of
			// the answer the continuation finished, or masking rewrites the marker
			// that keeps it; and the transcript draws the turn as it did not live.
			it("stays in the context a reload rebuilds, and is drawn as it was drawn live", async () => {
				const { session, reopened, file } = await run([cutTurn, { stream: CONTINUED_ANSWER }], [PROMPT]);

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
				const { reopened } = await run([cutTurn, { stream: CONTINUED_ANSWER }], [PROMPT]);
				sessions.answers = [{ stream: answer(FRESH_TEXT) }];
				const resumed = await sessions.startSession(reopened, {
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
					[{ stream: answer("An earlier answer. ".repeat(1_500)) }, cutTurn, { stream: CONTINUED_ANSWER }],
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
