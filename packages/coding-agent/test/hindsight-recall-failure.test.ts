import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createHindsightClient,
	HindsightApi,
	type HindsightClientApi,
	HindsightError,
	type RecallOptions,
	type RecallResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import {
	type HindsightConfig,
	isHindsightConfigured,
	loadHindsightConfig,
} from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HINDSIGHT_NOTICE_SOURCE, HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const config = {
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	globalScope: false,
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: [],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	recallCooldownMs: 1_800_000,
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
} satisfies HindsightConfig;

interface Notice {
	level: string;
	message: string;
	source?: string;
}

/** Recall that fails with `error` once `fail()` is called, or rejects as soon as its signal aborts. */
class FailingRecallApi extends HindsightApi {
	#failures: (() => void)[] = [];

	constructor(readonly error: Error) {
		super({ baseUrl: "http://localhost" });
	}

	override recall(_bankId: string, _query: string, options?: RecallOptions): Promise<never> {
		const { promise, reject } = Promise.withResolvers<never>();
		options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
		this.#failures.push(() => reject(this.error));
		return promise;
	}

	fail(): void {
		for (const fail of this.#failures.splice(0)) fail();
	}
}

/** What a test made; removed after it. */
const dirs: TempDir[] = [];
const managers: SessionManager[] = [];
const states: HindsightSessionState[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
	setSystemTime();
	vi.restoreAllMocks();
	for (const state of states.splice(0)) state.dispose();
	for (const server of servers.splice(0)) await server.stop(true);
	for (const manager of managers.splice(0)) await manager.close();
	for (const dir of dirs.splice(0)) await dir.remove();
});

function newSessionManager(): SessionManager {
	const dir = TempDir.createSync("@hindsight-recall-failure-");
	dirs.push(dir);
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	managers.push(manager);
	return manager;
}

/** One process: a Hindsight state over `sessionManager`; its notices land in `notices`. */
function start(sessionManager: SessionManager, client: HindsightClientApi, stateConfig: HindsightConfig = config) {
	const notices: Notice[] = [];
	const session = {
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		emitNotice: (level: string, message: string, source?: string) => notices.push({ level, message, source }),
	} as object as AgentSession;
	const state = new HindsightSessionState({
		sessionId: session.sessionId,
		client,
		bankId: "b",
		config: stateConfig,
		session,
		banksSet: new Set(),
	});
	states.push(state);
	return { state, notices };
}

function setup(error: Error = new HindsightError("recall request timed out after 30s")) {
	const client = new FailingRecallApi(error);
	return { client, ...start(newSessionManager(), client) };
}

describe("Hindsight recall failure notice", () => {
	it("warns once with server text stripped of terminal controls and bounded to one line", async () => {
		const { notices, client, state } = setup(
			new HindsightError(`recall failed: \x1b[2Jboom\nline two\t${"x".repeat(5000)}`, 500),
		);
		const outcome = state.recallForContext("query");
		client.fail();

		const result = await outcome;
		expect(result).toMatchObject({ context: null, ok: false });
		expect(result.failure?.startsWith("recall failed: boom line two x")).toBe(true);
		expect(notices).toHaveLength(1);
		const [notice] = notices;
		expect(notice.level).toBe("warning");
		expect(notice.source).toBe(HINDSIGHT_NOTICE_SOURCE);
		expect(notice.message.startsWith("Memory recall failed: recall failed: boom line two x")).toBe(true);
		expect(notice.message).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(notice.message.length).toBeLessThan(250);
		expect(notice.message).toBe(`Memory recall failed: ${result.failure}`);
	});

	it("stays silent when a superseded compaction aborts its recall", async () => {
		const { notices, state } = setup();
		const controller = new AbortController();
		const outcome = state.recallForCompaction([{ role: "user", content: "what did we decide?" }], controller.signal);
		controller.abort();

		expect(await outcome).toBeUndefined();
		expect(notices).toEqual([]);
	});

	it("stays silent when the failure lands after a conversation reset", async () => {
		const { notices, client, state } = setup();
		const outcome = state.recallForContext("query");
		state.resetConversationTracking();
		client.fail();

		expect((await outcome).ok).toBe(false);
		expect(notices).toEqual([]);
	});
});

const PROMPT = "Where is the deploy host?";
/** How long a first failed automatic recall holds off the next one. */
const COOLDOWN_MS = config.recallCooldownMs;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

async function failWithBoom(): Promise<RecallResponse> {
	throw new HindsightError("recall request failed: boom");
}

function answerWith(text: string): () => Promise<RecallResponse> {
	return async () => ({ results: [{ id: "m", text }] });
}

/** Counts its recalls; each one does what `answer` does, by default fail at once with "boom". */
class CountingRecallApi extends HindsightApi {
	calls = 0;
	answer: (options?: RecallOptions) => Promise<RecallResponse> = failWithBoom;

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override recall(_bankId: string, _query: string, options?: RecallOptions): Promise<RecallResponse> {
		this.calls++;
		return this.answer(options);
	}
}

describe("Hindsight automatic recall after a failure", () => {
	function promptAt(state: HindsightSessionState, time: number) {
		setSystemTime(time);
		return state.beforeAgentStartPrompt(PROMPT);
	}

	/** Persists the turn the session sent, which puts the transcript on disk; returns its file. */
	async function writeTurn(sessionManager: SessionManager): Promise<string> {
		sessionManager.appendMessage({ role: "user", content: PROMPT, timestamp: Date.now() });
		sessionManager.appendMessage(createAssistantMessage("alpha-7"));
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("session was not persisted");
		return sessionFile;
	}

	it("does not wait for another recall during the pause after a first-turn recall times out", async () => {
		let recallRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// The recall must run into the client's own deadline, not the server's idle cutoff.
			idleTimeout: 0,
			fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/memories/recall")) return Response.json({});
				recallRequests++;
				return new Promise<Response>(() => {});
			},
		});
		servers.push(server);
		const shipped = loadHindsightConfig(
			Settings.isolated({
				"hindsight.apiUrl": server.url.origin,
				"hindsight.autoRecall": true,
				"hindsight.autoRetain": false,
				"hindsight.mentalModelsEnabled": false,
			}),
		);
		if (!isHindsightConfigured(shipped)) throw new Error("hindsight.apiUrl did not resolve");
		const { state } = start(newSessionManager(), createHindsightClient(shipped), shipped);

		let started = performance.now();
		const first = await state.beforeAgentStartPrompt(PROMPT);
		const firstWaitMs = Math.round(performance.now() - started);
		started = performance.now();
		const second = await state.beforeAgentStartPrompt("And the staging host?");
		const secondWaitMs = Math.round(performance.now() - started);
		console.log(JSON.stringify({ firstWaitMs, secondWaitMs, recallRequests }));

		expect(first).toBeUndefined();
		expect(firstWaitMs).toBeGreaterThanOrEqual(25_000);
		expect(second).toBeUndefined();
		expect(secondWaitMs).toBeLessThan(1_000);
		expect(recallRequests).toBe(1);
	}, 90_000);

	it("logs a failed recall once with its cause and a skipped recall once", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const client = new CountingRecallApi();
		const { state, notices } = start(newSessionManager(), client);
		for (const prompt of [PROMPT, "And the staging host?", "And the backup host?"]) {
			expect(await state.beforeAgentStartPrompt(prompt)).toBeUndefined();
		}
		const failureLines = warn.mock.calls.filter(([message]) => message === "Hindsight: recall failed");
		const skipLines = warn.mock.calls.filter(
			([message]) => message === "Hindsight: recall skipped after a recent failure",
		);
		console.log(
			JSON.stringify({
				failureLines: failureLines.length,
				skipLines: skipLines.length,
				notices: notices.length,
				recallCalls: client.calls,
			}),
		);

		expect(failureLines).toHaveLength(1);
		expect(String(failureLines[0][1]?.error)).toContain("boom");
		expect(skipLines).toHaveLength(1);
		expect(skipLines[0][1]).toMatchObject({ bankId: "b", failures: 1 });
		expect(String(skipLines[0][1]?.error)).toContain("boom");
		expect(notices).toHaveLength(2);
		const [failure, skip] = notices;
		expect(failure).toEqual({
			level: "warning",
			message: "Memory recall failed: recall request failed: boom",
			source: HINDSIGHT_NOTICE_SOURCE,
		});
		expect(skip).toMatchObject({ level: "warning", source: HINDSIGHT_NOTICE_SOURCE });
		expect(skip.message).toContain("boom");
		expect(skip.message).not.toBe(failure.message);
		expect(client.calls).toBe(1);
	});

	it("recalls again when the wait ends, and doubles the wait after a second failure", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client);
		await promptAt(state, T0);
		expect(client.calls).toBe(1);
		await promptAt(state, T0 + COOLDOWN_MS - 1_000);
		expect(client.calls).toBe(1);

		const secondFailure = T0 + COOLDOWN_MS + 1_000;
		await promptAt(state, secondFailure);
		expect(client.calls).toBe(2);
		await promptAt(state, secondFailure + COOLDOWN_MS + 1_000);
		expect(client.calls).toBe(2);
		await promptAt(state, secondFailure + 2 * COOLDOWN_MS + 1_000);
		expect(client.calls).toBe(3);
	});

	it("a success resets the wait", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client);
		await promptAt(state, T0);
		expect(client.calls).toBe(1);

		const recovered = T0 + COOLDOWN_MS + 1_000;
		client.answer = answerWith("The deploy host is alpha-7.");
		// Left uncommitted, as when the turn never goes out: the next prompt recalls again.
		expect((await promptAt(state, recovered))?.context).toContain("alpha-7");
		client.answer = failWithBoom;
		await promptAt(state, recovered);
		expect(client.calls).toBe(3);

		await promptAt(state, recovered + COOLDOWN_MS - 1_000);
		expect(client.calls).toBe(3);
		await promptAt(state, recovered + COOLDOWN_MS + 1_000);
		expect(client.calls).toBe(4);
	});

	it("a resumed session during the pause does not recall", async () => {
		setSystemTime(T0);
		const firstManager = newSessionManager();
		const first = start(firstManager, new CountingRecallApi());
		expect(await first.state.beforeAgentStartPrompt(PROMPT)).toBeUndefined();
		const sessionFile = await writeTurn(firstManager);
		await firstManager.close();

		setSystemTime(T0 + 10 * 60_000);
		const resumedManager = await SessionManager.open(sessionFile);
		managers.push(resumedManager);
		const client = new CountingRecallApi();
		client.answer = answerWith("The deploy host is beta-9.");
		const resumed = start(resumedManager, client);
		const started = performance.now();
		const preparation = await resumed.state.beforeAgentStartPrompt(PROMPT);
		const waitMs = performance.now() - started;

		expect(client.calls).toBe(0);
		expect(preparation).toBeUndefined();
		expect(waitMs).toBeLessThan(1_000);
		expect(resumed.notices).toHaveLength(1);
		expect(resumed.notices[0]).toMatchObject({ level: "warning", source: HINDSIGHT_NOTICE_SOURCE });
		expect(resumed.notices[0].message).toContain("boom");
	});

	it("a stored failure cause is cleaned before it is shown", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		setSystemTime(T0);
		const firstManager = newSessionManager();
		const first = start(firstManager, new CountingRecallApi());
		expect(await first.state.beforeAgentStartPrompt(PROMPT)).toBeUndefined();
		const sessionFile = await writeTurn(firstManager);
		await firstManager.close();

		// A damaged or foreign session file can hold what the write side removed from the cause.
		let rewritten = 0;
		const lines = (await Bun.file(sessionFile).text()).split("\n").map(line => {
			if (!line) return line;
			const entry = JSON.parse(line);
			if (entry.type !== "custom" || entry.customType !== "memory_recall_failure") return line;
			entry.data.error = `\x1b]52;c;aGVsbG8=\x07${"x".repeat(5000)}`;
			rewritten++;
			return JSON.stringify(entry);
		});
		expect(rewritten).toBe(1);
		await Bun.write(sessionFile, lines.join("\n"));

		setSystemTime(T0 + 10 * 60_000);
		const resumedManager = await SessionManager.open(sessionFile);
		managers.push(resumedManager);
		const client = new CountingRecallApi();
		const resumed = start(resumedManager, client);
		expect(await resumed.state.beforeAgentStartPrompt(PROMPT)).toBeUndefined();

		expect(client.calls).toBe(0);
		expect(resumed.notices).toHaveLength(1);
		const [notice] = resumed.notices;
		expect(notice).toMatchObject({ level: "warning", source: HINDSIGHT_NOTICE_SOURCE });
		expect(notice.message).not.toMatch(/[\x00-\x1f\x7f]/);
		// The pause text and retry time come before the cause, which is at most 200 characters.
		expect(notice.message.length).toBeLessThan(300);
		const skipLines = warn.mock.calls.filter(
			([message]) => message === "Hindsight: recall skipped after a recent failure",
		);
		expect(skipLines).toHaveLength(1);
		const loggedError = String(skipLines[0][1]?.error);
		expect(loggedError).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(loggedError.length).toBeLessThanOrEqual(200);
		expect(notice.message.endsWith(loggedError)).toBe(true);
	});

	it("an aborted recall starts no pause", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client);
		const called = Promise.withResolvers<void>();
		client.answer = options => {
			called.resolve();
			const { promise, reject } = Promise.withResolvers<RecallResponse>();
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return promise;
		};
		const controller = new AbortController();
		const aborted = state.beforeAgentStartPrompt(PROMPT, controller.signal);
		await called.promise;
		controller.abort();
		expect(await aborted).toBeUndefined();

		client.answer = failWithBoom;
		await state.beforeAgentStartPrompt(PROMPT);
		expect(client.calls).toBe(2);
	});

	it("a failure after a conversation reset starts no pause", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client);
		const called = Promise.withResolvers<void>();
		const pendingRecall = Promise.withResolvers<RecallResponse>();
		client.answer = () => {
			called.resolve();
			return pendingRecall.promise;
		};
		const stale = state.beforeAgentStartPrompt(PROMPT);
		await called.promise;
		state.resetConversationTracking();
		pendingRecall.reject(new HindsightError("recall request failed: boom"));
		expect(await stale).toBeUndefined();

		client.answer = failWithBoom;
		await state.beforeAgentStartPrompt(PROMPT);
		expect(client.calls).toBe(2);
	});

	it("`recallCooldownMs: 0` recalls on every prompt and writes no failure entry", async () => {
		const client = new CountingRecallApi();
		const sessionManager = newSessionManager();
		const { state } = start(sessionManager, client, { ...config, recallCooldownMs: 0 });
		await state.beforeAgentStartPrompt(PROMPT);
		await state.beforeAgentStartPrompt(PROMPT);

		expect(client.calls).toBe(2);
		const failureEntries = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "memory_recall_failure");
		expect(failureEntries).toEqual([]);
	});

	it("the compaction recall waits out the pause, and its failure starts one", async () => {
		const messages = [{ role: "user", content: "what did we decide?" }];
		const afterPrompt = new CountingRecallApi();
		const prompted = start(newSessionManager(), afterPrompt).state;
		await promptAt(prompted, T0);
		setSystemTime(T0 + 60_000);
		expect(await prompted.recallForCompaction(messages)).toBeUndefined();
		expect(afterPrompt.calls).toBe(1);

		const afterCompaction = new CountingRecallApi();
		const compacted = start(newSessionManager(), afterCompaction).state;
		setSystemTime(T0);
		expect(await compacted.recallForCompaction(messages)).toBeUndefined();
		expect(afterCompaction.calls).toBe(1);
		expect(await promptAt(compacted, T0 + 60_000)).toBeUndefined();
		expect(afterCompaction.calls).toBe(1);
	});

	it("a pause longer than a date can hold still holds off the next recall and keeps the failure visible", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const client = new CountingRecallApi();
		// The largest integer the setting holds exactly, as a user sets it to mean "never recall again".
		const { state, notices } = start(newSessionManager(), client, {
			...config,
			recallCooldownMs: Number.MAX_SAFE_INTEGER,
		});

		await expect(promptAt(state, T0)).resolves.toBeUndefined();
		await expect(promptAt(state, T0 + 60_000)).resolves.toBeUndefined();

		expect(client.calls).toBe(1);
		const failureLines = warn.mock.calls.filter(([message]) => message === "Hindsight: recall failed");
		expect(failureLines).toHaveLength(1);
		expect(String(failureLines[0][1]?.error)).toContain("boom");
		const skipLines = warn.mock.calls.filter(
			([message]) => message === "Hindsight: recall skipped after a recent failure",
		);
		expect(skipLines).toHaveLength(1);
		expect(notices).toHaveLength(2);
		expect(notices[0]).toEqual({
			level: "warning",
			message: "Memory recall failed: recall request failed: boom",
			source: HINDSIGHT_NOTICE_SOURCE,
		});
		expect(notices[1].message).toContain("boom");
	});
});
