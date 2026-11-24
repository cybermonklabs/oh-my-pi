/**
 * A failed turn the session keeps in context and continues from after visible
 * text (a cut stream, a rate limit, a malformed call) stays in the context
 * rebuilt from the session after a reload, a resume and a compaction whether
 * session store masking is on or off, and the transcript draws it after a
 * reload as it drew it live; with masking on, so does such a turn on a long
 * session whose older bodies are cold, read back from the store's masked form
 * of its cold entries. The marker that keeps it (`continued`, set by an
 * `entry_patch` record) is a boolean, which the masking walk leaves as written;
 * with masking on the stored session holds no secret value, so the walk ran.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { CONTINUE_REMINDER_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	answer,
	branchConversation,
	CONTINUED_ANSWER,
	CONTINUED_TEXT,
	conversation,
	FIRST_TEXT,
	FRESH_TEXT,
	failedTurn,
	type KeptTurnSessionOptions,
	MESSAGE_START_FRAME,
	modelConversation,
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

/**
 * Binds `manager` to the agent dir `agentDir` with `secrets.maskSessionStore` set to `masking`;
 * the masker there holds {@link SECRET}, as a secret-named environment variable.
 */
async function bindStoreMasking(manager: SessionManager, agentDir: string, masking: boolean): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	const held = new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: SECRET }), agentDir });
	spyOn(storeMask, "processSessionStoreMasker").mockImplementation(dir =>
		dir === agentDir ? held : new storeMask.SessionStoreMasker({ env: () => ({}), agentDir: dir }),
	);
	manager.setStoreMasking({ enabled: () => masking, agentDir });
}

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

// The long session below and its writer are copied from `cold-entries-features.test.ts`, with only
// what {@link writeColdSession} writes, and with {@link SECRET} in each prompt so masking changes
// the cold entries.

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Each cold-transcript case writes, resumes and compares two copies of a long session. */
const CASE_TIMEOUT_MS = 60_000;

/** Longer than any value a cold entry keeps in memory. */
function longText(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

function usage() {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** An assistant message with the fields a recent Anthropic reply records. */
function assistantMessage(label: string, toolCall?: { id: string; name: string; arguments: object }) {
	return {
		role: "assistant",
		content: [{ type: "text", text: longText(label) }, ...(toolCall ? [{ type: "toolCall", ...toolCall }] : [])],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(),
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: 2,
		requestControls: {
			messageIndex: 8,
			tools: { declared: ["read", "todo", "probe"], deferred: [], active: ["read", "todo", "probe"] },
			effort: { topLevel: "high", tail: "high" },
		},
		responseId: `msg_01${label}Fixture`,
		duration: 4163.076492,
		ttft: 2100.812789,
		completedAt: 1767225604163,
		contextSnapshot: { promptTokens: 40814, nonMessageTokens: 32441, toolSchemaTokens: 9132, compactionEpoch: 0 },
	};
}

function phases(label: string) {
	return [
		{
			name: `Phase ${label}`,
			tasks: Array.from({ length: 40 }, (_, index) => ({
				content: `${label} task ${index}: move module ${index} under src/tree`,
				status: index < 10 ? "completed" : "pending",
			})),
		},
	];
}

/**
 * A titled session. On the current path: `c1` keeps from `u2`, `c2` from `u4`, `c3` from `u7`
 * (the cut). Before the cut lie a session contract (`s0`), two to-do results (`t1`, then `t3`),
 * model changes for the default and the `smol` role, a thinking level, a service tier, a TTSR
 * injection, a plan mode, a custom entry, a custom message, and a second branch off `c2` (`b1`,
 * `b2`) left for `bs`. Each prompt names {@link SECRET}.
 */
function coldSessionText(id: string, cwd: string): string {
	const lines: object[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd }];
	const add = (entryType: string, entryId: string, parentId: string | null, fields: object) =>
		lines.push({ type: entryType, id: entryId, parentId, timestamp: TIMESTAMP, ...fields });
	const user = (entryId: string, parentId: string) =>
		add("message", entryId, parentId, {
			message: {
				role: "user",
				content: [{ type: "text", text: `${longText(entryId)} with the key ${SECRET}` }],
				attribution: "user",
				timestamp: 1,
			},
		});
	const assistant = (entryId: string, parentId: string, toolCall?: { id: string; name: string; arguments: object }) =>
		add("message", entryId, parentId, { message: assistantMessage(entryId, toolCall) });
	const todo = (entryId: string, parentId: string, callId: string) =>
		add("message", entryId, parentId, {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "todo",
				content: [{ type: "text", text: longText(entryId) }],
				details: { op: "replace", phases: phases(entryId) },
				isError: false,
				timestamp: 3,
			},
		});
	const compaction = (entryId: string, parentId: string, firstKeptEntryId: string) =>
		add("compaction", entryId, parentId, { summary: longText(entryId), firstKeptEntryId, tokensBefore: 1000 });

	add("session_init", "s0", null, {
		systemPrompt: [longText("system prompt")],
		task: "Refactor the module tree",
		tools: ["read", "todo", "probe"],
		agent: "task",
		modelRole: "default",
	});
	user("u1", "s0");
	add("model_change", "m1", "u1", { model: "anthropic/claude-sonnet-4-5", role: "default" });
	assistant("a1", "m1", { id: "call_t1", name: "todo", arguments: { op: "replace" } });
	todo("t1", "a1", "call_t1");
	add("custom", "x1", "t1", { customType: "test-ledger", data: { checkpoints: ["first", "second"] } });
	user("u2", "x1");
	assistant("a2", "u2");
	compaction("c1", "a2", "u2");
	add("thinking_level_change", "k1", "c1", { thinkingLevel: "high", configured: "high" });
	add("model_change", "m2", "k1", { model: "anthropic/claude-haiku-4-5", role: "smol" });
	add("service_tier_change", "st", "m2", { serviceTier: { anthropic: "priority" } });
	add("ttsr_injection", "tt", "st", { injectedRules: ["no-console-log", "prefer-bun-file"] });
	add("mode_change", "md", "tt", { mode: "plan", data: { planFile: "PLAN.md" } });
	user("u3", "md");
	assistant("a3", "u3", { id: "call_t3", name: "todo", arguments: { op: "replace" } });
	todo("t3", "a3", "call_t3");
	add("custom_message", "cm", "t3", {
		customType: "test-note",
		content: [{ type: "text", text: longText("cm") }],
		display: true,
	});
	user("u4", "cm");
	assistant("a4", "u4");
	compaction("c2", "a4", "u4");
	user("u5", "c2");
	assistant("a5", "u5");
	user("b1", "c2");
	assistant("b2", "b1");
	add("branch_summary", "bs", "a5", { fromId: "b2", summary: longText("bs") });
	user("u6", "bs");
	assistant("a6", "u6");
	user("u7", "a6");
	assistant("a7", "u7");
	compaction("c3", "a7", "u7");
	user("u8", "c3");
	assistant("a8", "u8");
	const slot = serializeTitleSlot({ title: "Refactor the module tree", source: "user", updatedAt: TIMESTAMP });
	return slot + lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

/** Writes {@link coldSessionText} to its own directory under `root`, with a session id of its own, and answers its file. */
async function writeColdSession(root: string): Promise<string> {
	const id = crypto.randomUUID();
	const name = crypto.randomUUID();
	const cwd = path.join(root, name, "project");
	await fs.mkdir(cwd, { recursive: true });
	const file = path.join(root, name, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	await Bun.write(file, coldSessionText(id, cwd));
	return file;
}

/** What a client or the model receives. */
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe.each([{ masking: true }, { masking: false }])(
	"a kept turn with session store masking $masking",
	({ masking }) => {
		const sessions = useKeptTurnSessions();

		/** The session's agent dir binding, with `secrets.maskSessionStore` set to `masking`. */
		async function bind(manager: SessionManager): Promise<void> {
			await bindStoreMasking(manager, sessions.tempDir.join("agent"), masking);
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

/**
 * The cold-transcript case of `cold-entries-features.test.ts` ("a turn kept and continued from
 * after visible text") with session store masking on: on a long session whose older bodies are
 * cold, written in full with masking on (each cold entry from its record, so the store holds their
 * masked form), a turn the session keeps and continues from after visible text (a stream cut after
 * it); its lines, the `entry_patch` record of its mark among them, are appended masked. The kept
 * turn and the continue reminder after it stay in the context a reload, a resume and a compaction
 * rebuild from that masked store, exactly as a manager that holds every entry (`coldStore: false`)
 * rebuilds it, and the turn is drawn as it was live. The primary runs the real Anthropic provider;
 * only its HTTP client is replaced.
 */
describe("a turn kept and continued from after visible text on a cold transcript, masking on", () => {
	const sessions = useKeptTurnSessions();
	const cleanups: Array<() => Promise<void>> = [];
	const keptTurn = `assistant[text:${FIRST_TEXT}]`;
	const reminder = expect.stringMatching(/^developer:/);
	const continuation = `assistant[text:${CONTINUED_TEXT}]`;
	const cutTurn: PrimaryAnswer = { stream: MESSAGE_START_FRAME + TEXT_FRAMES + OVERLOADED_FRAME };

	// After the harness's own hooks, which dispose of the sessions on these managers.
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	/** `file` opened with `secrets.maskSessionStore` on, closed after the case. */
	async function open(file: string, coldStore: boolean): Promise<SessionManager> {
		const manager = await SessionManager.open(file, path.dirname(file), new FileSessionStorage(), {
			suppressBreadcrumb: true,
			coldStore,
		});
		cleanups.push(() => manager.close());
		await bindStoreMasking(manager, sessions.tempDir.join("agent"), true);
		return manager;
	}

	/**
	 * Resumes the cold session with masking on and writes it in full, then sends `prompts` with the
	 * primary answering `answers` in order, and checks the live context ends on the kept turn, its
	 * reminder and its continuation.
	 */
	async function runOnColdSession(
		answers: PrimaryAnswer[],
		options: KeptTurnSessionOptions & { prompts?: string[] } = {},
	) {
		const file = await writeColdSession(sessions.tempDir.path());
		const cold = await open(file, true);
		expect(cold.coldStoreStats().coldEntries).toBeGreaterThan(10);
		// Before the turn, so the mark the continuation sets is stored as its own patch record.
		await cold.rewriteEntries();
		sessions.answers = answers;
		const session = await sessions.startSession(cold, {
			...options,
			messages: cold.buildSessionContext().messages,
		});
		for (const prompt of options.prompts ?? [PROMPT]) {
			await session.prompt(prompt);
			await session.waitForIdle();
		}
		const live = modelConversation(session.agent.state.messages);
		expect(live.slice(-4)).toEqual(["user", keptTurn, reminder, continuation]);
		return { file, cold, session, live };
	}

	/**
	 * Reopens the session file as a resume opens it, its older bodies cold, and with every entry
	 * held. The stored file holds no secret value, so the walk ran over the cold entries' records
	 * too, and it holds the mark.
	 */
	async function reopenBoth(cold: SessionManager, file: string) {
		const reopened = await sessions.reopen(cold);
		await bindStoreMasking(reopened, sessions.tempDir.join("agent"), true);
		expect(reopened.coldStoreStats().coldEntries).toBeGreaterThan(10);
		const whole = await open(file, false);
		expect(whole.coldStoreStats().coldEntries).toBe(0);
		const stored = await Bun.file(file).text();
		expect(stored.includes(SECRET)).toBe(false);
		expect(stored.includes('"continued":true')).toBe(true);
		return { reopened, whole };
	}

	// Regression: with masking on, on a long session whose older bodies are out of memory, a reload
	// after a full write rebuilds the context without the turn a cut stream ended after its text, or
	// without the reminder between it and its continuation, so the model no longer sees the first
	// half of its answer; or the reloaded transcript draws the turn differently from the live one.
	it(
		"is in the context a reload rebuilds, and drawn as live",
		async () => {
			const { file, cold, session, live } = await runOnColdSession([cutTurn, { stream: CONTINUED_ANSWER }]);
			const { reopened, whole } = await reopenBoth(cold, file);

			const rebuilt = reopened.buildSessionContext().messages;
			expect(modelConversation(rebuilt)).toEqual(live);
			expect(wire(rebuilt)).toEqual(wire(whole.buildSessionContext().messages));
			expect(branchConversation(reopened).slice(-4)).toEqual([
				"user",
				keptTurn,
				`custom:${CONTINUE_REMINDER_MESSAGE_TYPE}`,
				continuation,
			]);
			expect(failedTurn(rebuilt)?.continued).toBe(true);

			const drawnLive = failedTurn(sessions.drawnTurns(session));
			const drawnReloaded = failedTurn(reopened.buildSessionContext({ transcript: true }).messages);
			if (!drawnLive || !drawnReloaded)
				throw new Error("Expected the kept turn live and in the reloaded transcript");
			expect(renderTurn(drawnReloaded)).toEqual(renderTurn(drawnLive));
		},
		CASE_TIMEOUT_MS,
	);

	// Regression: with masking on, after a full write and a resume of a long session whose older
	// bodies are out of memory, the next request no longer carries the kept turn, or the reminder the
	// model read between it and its continuation.
	it(
		"is sent to the model again after a resume",
		async () => {
			const { file, cold, live } = await runOnColdSession([
				cutTurn,
				{ stream: CONTINUED_ANSWER },
				{ stream: answer(FRESH_TEXT) },
			]);
			const { reopened, whole } = await reopenBoth(cold, file);
			const resumed = await sessions.startSession(reopened, { messages: reopened.buildSessionContext().messages });

			await resumed.prompt("And then?");
			await resumed.waitForIdle();

			const sent = modelConversation(sessions.requestMessages.at(-1) ?? []);
			expect(sent).toEqual([...live, "user"]);
			expect(sent).toEqual([...modelConversation(whole.buildSessionContext().messages), "user"]);
		},
		CASE_TIMEOUT_MS,
	);

	// Regression: with masking on, a compaction after the continuation keeps the kept turn's prompt
	// and what follows, yet on a long session whose older bodies are out of memory the context a
	// reload rebuilds after a full write drops the kept turn or its reminder. The earlier answer is
	// long and the kept-recent budget small, so the cut falls on the prompt of the kept turn.
	it(
		"stays in the kept region of a compaction",
		async () => {
			const { file, cold, session } = await runOnColdSession(
				[{ stream: answer("An earlier answer. ".repeat(1_500)) }, cutTurn, { stream: CONTINUED_ANSWER }],
				{
					prompts: ["An earlier question", PROMPT],
					settings: { "compaction.keepRecentTokens": 2_000 },
					compactionSummary: "The earlier question was answered.",
				},
			);

			await session.compact();

			// The summary reaches the model as a user message, then the kept region.
			const live = modelConversation(session.agent.state.messages);
			expect(live).toEqual(["user", "user", keptTurn, reminder, continuation]);
			const { reopened, whole } = await reopenBoth(cold, file);
			const rebuilt = reopened.buildSessionContext().messages;
			expect(modelConversation(rebuilt)).toEqual(live);
			expect(wire(rebuilt)).toEqual(wire(whole.buildSessionContext().messages));
			const entries = reopened.getEntries();
			const compaction = entries.findLast(entry => entry.type === "compaction");
			const prompt = entries.findLast(entry => entry.type === "message" && entry.message.role === "user");
			expect(compaction).toMatchObject({ firstKeptEntryId: prompt?.id });
		},
		CASE_TIMEOUT_MS,
	);
});
