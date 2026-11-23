/**
 * A `last-turn` transcript retain sends each message of a session once. The session keeps
 * the position of its last retain as a custom entry, so a session resumed in a new process,
 * cleared with `/clear`, forked or switched to does not send again what an earlier retain
 * sent, and a turn that no user message started (a custom message such as a notification
 * card) reaches the bank in the next retain instead of being skipped. When a retain runs is
 * unchanged: at a turn's end, once `retainEveryNTurns` user turns have passed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type {
	BankProfileResponse,
	CreateBankOptions,
	RetainOptions,
	RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	globalScope: false,
	bankMission: "",
	retainMission: null,
	autoRecall: false,
	autoRetain: true,
	retainMode: "last-turn",
	retainEveryNTurns: 1,
	retainOverlapTurns: 0,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: [],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

/** The bank: records each retain; can fail, or hold each retain until released. */
class FakeBank extends HindsightApi {
	retains: { transcript: string; options?: RetainOptions }[] = [];
	failing = false;
	blocking = false;
	inFlight = 0;
	maxInFlight = 0;
	#gates: PromiseWithResolvers<void>[] = [];

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(_bankId: string, _options?: CreateBankOptions): Promise<BankProfileResponse> {
		return {};
	}

	override async retain(_bankId: string, transcript: string, options?: RetainOptions): Promise<RetainResponse> {
		if (this.failing) throw new Error("bank unavailable");
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.blocking) {
				const gate = Promise.withResolvers<void>();
				this.#gates.push(gate);
				await gate.promise;
			}
			this.retains.push({ transcript, options });
			return {};
		} finally {
			this.inFlight--;
		}
	}

	release(): void {
		for (const gate of this.#gates.splice(0)) gate.resolve();
	}

	/** The message texts of each retain, in order. */
	sent(): string[][] {
		return this.retains.map(retain => messageTexts(retain.transcript));
	}
}

/** The message texts a retained transcript holds (`[role: x]`, optional timestamp line, text, `[x:end]`). */
function messageTexts(transcript: string): string[] {
	const texts: string[] = [];
	for (const match of transcript.matchAll(/\[role: (\w+)\]\n(?:\[timestamp: [^\]\n]*\]\n)?([\s\S]*?)\n\[\1:end\]/g)) {
		texts.push(match[2]);
	}
	return texts;
}

/** One omp process's Hindsight state over `sessionManager`, with its listener on turn ends. */
class Process {
	readonly state: HindsightSessionState;
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(
		readonly sessionManager: SessionManager,
		readonly bank: FakeBank,
		config: Partial<HindsightConfig> = {},
	) {
		const session = {
			sessionManager,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				this.#listeners.add(listener);
				return () => this.#listeners.delete(listener);
			},
			emitNotice: () => {},
		} as object as AgentSession;
		this.state = new HindsightSessionState({
			sessionId: sessionManager.getSessionId(),
			client: bank,
			bankId: "bank",
			config: makeConfig(config),
			session,
			banksSet: new Set<string>(),
		});
		// Tool retains are not under test; keep their queue off the bank.
		this.state.retainQueue.flush = async () => {};
		this.state.attachSessionListeners();
	}

	userTurn(text: string): void {
		this.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		this.reply(`reply to ${text}`);
	}

	/** A turn a notification card starts: a custom message, no user message, then the reply. */
	cardTurn(card: string): void {
		this.sessionManager.appendCustomMessageEntry("notification-card", card, true);
		this.reply(`reply to ${card}`);
	}

	reply(text: string): void {
		this.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	/** The run's `agent_end`, and the retain it starts run to completion. */
	async endTurn(): Promise<void> {
		this.emitEnd();
		await settle();
	}

	emitEnd(): void {
		for (const listener of this.#listeners) listener({ type: "agent_end", messages: [] });
	}

	/** What the session does on `/clear`: a new provider session id, reset counters, a reset boundary. */
	clear(providerSessionId: string): void {
		this.state.setSessionId(providerSessionId);
		this.state.resetConversationTracking();
		this.sessionManager.appendResetBoundary();
	}

	/** Ends the process: the session file is written and closed. */
	async exit(): Promise<void> {
		this.state.dispose();
		await this.sessionManager.flush();
		await this.sessionManager.close();
	}
}

/**
 * Listeners start retains without exposing a promise; each `Bun.sleep(0)` drains every
 * microtask the fake bank chains, and five bound the wait.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

const dirs: TempDir[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await dir.remove();
});

function tempDir(): TempDir {
	const dir = TempDir.createSync("@hindsight-retain-position-");
	dirs.push(dir);
	return dir;
}

function newSession(dir: TempDir): SessionManager {
	return SessionManager.create(dir.path(), dir.join("sessions"));
}

async function reopen(dir: TempDir, sessionFile: string): Promise<SessionManager> {
	return SessionManager.open(sessionFile, dir.join("sessions"));
}

function sessionFileOf(sessionManager: SessionManager): string {
	const file = sessionManager.getSessionFile();
	if (!file) throw new Error("session was not persisted");
	return file;
}

describe("Hindsight last-turn retain position", () => {
	it("a session resumed in a new process sends no message an earlier retain sent", async () => {
		const dir = tempDir();
		const bank = new FakeBank();
		const first = new Process(newSession(dir), bank);
		first.userTurn("question one");
		await first.endTurn();
		first.cardTurn("card one");
		await first.endTurn();
		expect(bank.sent()).toEqual([["question one", "reply to question one"]]);
		const file = sessionFileOf(first.sessionManager);
		await first.exit();

		const second = new Process(await reopen(dir, file), bank);
		await second.endTurn();

		expect(bank.sent()).toEqual([["question one", "reply to question one"], ["reply to card one"]]);
		await second.exit();
	});

	it("a card's turn reaches the bank in the same process's next retain, with nothing earlier", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank);
		process.userTurn("question one");
		await process.endTurn();
		process.cardTurn("card one");
		await process.endTurn();
		process.userTurn("question two");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["reply to card one", "question two", "reply to question two"],
		]);
		await process.exit();
	});

	it("a card's turn reaches the bank in the next process's retain", async () => {
		const dir = tempDir();
		const bank = new FakeBank();
		const first = new Process(newSession(dir), bank);
		first.userTurn("question one");
		await first.endTurn();
		first.cardTurn("card one");
		await first.endTurn();
		const file = sessionFileOf(first.sessionManager);
		await first.exit();

		const second = new Process(await reopen(dir, file), bank);
		second.userTurn("question two");
		await second.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["reply to card one", "question two", "reply to question two"],
		]);
		await second.exit();
	});

	it("each retain moves the marker: a third retain sends only what the second did not", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank);
		process.userTurn("question one");
		await process.endTurn();
		process.userTurn("question two");
		await process.endTurn();
		process.userTurn("question three");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["question two", "reply to question two"],
			["question three", "reply to question three"],
		]);
		const markers = process.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "hindsight_retain");
		expect(markers).toHaveLength(3);
		await process.exit();
	});

	it("/clear keeps the position: the next retain sends only what came after the last one", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank);
		process.userTurn("question one");
		await process.endTurn();
		process.clear("provider-after-clear");
		process.cardTurn("card after clear");
		await process.endTurn();
		process.userTurn("question two");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["reply to card after clear"],
			["question two", "reply to question two"],
		]);
		expect(bank.retains[1].options?.metadata).toEqual({ session_id: "provider-after-clear" });
		await process.exit();
	});

	it("a fork keeps the position its parent reached, in this process and the next", async () => {
		const dir = tempDir();
		const bank = new FakeBank();
		const process = new Process(newSession(dir), bank);
		process.userTurn("question one");
		await process.endTurn();
		const forked = await process.sessionManager.fork();
		if (!forked) throw new Error("fork made no file");
		process.state.setSessionId(process.sessionManager.getSessionId());
		process.state.resetConversationTracking();
		process.cardTurn("card in fork");
		await process.endTurn();
		expect(bank.sent()).toEqual([["question one", "reply to question one"], ["reply to card in fork"]]);
		await process.exit();

		const resumed = new Process(await reopen(dir, forked.newSessionFile), bank);
		resumed.cardTurn("second card in fork");
		await resumed.endTurn();
		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["reply to card in fork"],
			["reply to second card in fork"],
		]);
		await resumed.exit();
	});

	it("a session switch reads the position of the session switched to", async () => {
		const dir = tempDir();
		const bank = new FakeBank();
		const other = new Process(newSession(dir), bank);
		other.userTurn("other question");
		await other.endTurn();
		const otherFile = sessionFileOf(other.sessionManager);
		await other.exit();

		const process = new Process(newSession(dir), bank);
		process.userTurn("question one");
		await process.endTurn();
		const firstFile = sessionFileOf(process.sessionManager);
		await process.sessionManager.flush();
		await process.sessionManager.setSessionFile(otherFile);
		process.state.setSessionId(process.sessionManager.getSessionId());
		process.state.resetConversationTracking();
		process.cardTurn("card in other");
		await process.endTurn();
		await process.sessionManager.flush();
		await process.sessionManager.setSessionFile(firstFile);
		process.state.setSessionId(process.sessionManager.getSessionId());
		process.state.resetConversationTracking();
		process.cardTurn("card back home");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["other question", "reply to other question"],
			["question one", "reply to question one"],
			["reply to card in other"],
			["reply to card back home"],
		]);
		await process.exit();
	});

	it("/memory enqueue sends from the entry after the marker when that is earlier than its window, then moves the marker", async () => {
		const dir = tempDir();
		const bank = new FakeBank();
		const process = new Process(newSession(dir), bank);
		process.userTurn("question one");
		await process.endTurn();
		bank.failing = true;
		process.userTurn("question two");
		await process.endTurn();
		process.cardTurn("card one");
		await process.endTurn();
		process.userTurn("question three");
		await process.endTurn();
		bank.failing = false;
		await process.state.forceRetainCurrentSession();
		// Enqueue resends its own window on purpose, and the marker it moved holds.
		await process.state.forceRetainCurrentSession();
		const file = sessionFileOf(process.sessionManager);
		await process.exit();

		const resumed = new Process(await reopen(dir, file), bank);
		resumed.cardTurn("card two");
		await resumed.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["question two", "reply to question two", "reply to card one", "question three", "reply to question three"],
			["question three", "reply to question three"],
			["reply to card two"],
		]);
		await resumed.exit();
	});

	it("two turn ends at once send the window once, and a turn appended meanwhile goes in the next retain", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank);
		bank.blocking = true;
		process.userTurn("question one");
		process.emitEnd();
		process.emitEnd();
		await settle();
		process.userTurn("question two");
		process.emitEnd();
		await settle();
		bank.blocking = false;
		bank.release();
		await settle();

		expect(bank.maxInFlight).toBe(1);
		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["question two", "reply to question two"],
		]);
		await process.exit();
	});

	it("a session with no marker sends its last turn once, as before markers existed", async () => {
		const dir = tempDir();
		const legacy = newSession(dir);
		const writer = new Process(legacy, new FakeBank(), { autoRetain: false });
		writer.userTurn("old question one");
		writer.userTurn("old question two");
		writer.cardTurn("old card");
		const file = sessionFileOf(legacy);
		await writer.exit();

		const bank = new FakeBank();
		const first = new Process(await reopen(dir, file), bank);
		await first.endTurn();
		await first.exit();
		const second = new Process(await reopen(dir, file), bank);
		second.cardTurn("new card");
		await second.endTurn();

		expect(bank.sent()).toEqual([
			["old question two", "reply to old question two", "reply to old card"],
			["reply to new card"],
		]);
		await second.exit();
	});

	it("a session's first retain keeps the turns that came before its first user message", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank);
		process.cardTurn("opening card");
		await process.endTurn();
		process.userTurn("question one");
		await process.endTurn();

		expect(bank.sent()).toEqual([["reply to opening card", "question one", "reply to question one"]]);
		await process.exit();
	});

	it("retainOverlapTurns repeats that many user turns from before the marker", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank, { retainOverlapTurns: 1 });
		process.userTurn("question one");
		await process.endTurn();
		process.cardTurn("card one");
		await process.endTurn();
		process.userTurn("question two");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["question one", "reply to question one", "reply to card one", "question two", "reply to question two"],
		]);
		await process.exit();
	});

	it("a marker counts only for its own bank scope: another bank starts from the last turn", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank);
		process.userTurn("question one");
		await process.endTurn();
		process.cardTurn("card one");
		await process.endTurn();
		process.state.bankId = "other-bank";
		process.userTurn("question two");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["question two", "reply to question two"],
		]);
		await process.exit();
	});

	it("the marker's scope holds nothing derived from the API token", async () => {
		// The marker is written into the session, which is stored, copied and read wherever the transcript is.
		const tokens = ["hsk-first-account-token", "hsk-second-account-token"];
		const scopes: unknown[] = [];
		for (const token of tokens) {
			const process = new Process(newSession(tempDir()), new FakeBank(), { hindsightApiToken: token });
			process.userTurn("question one");
			await process.endTurn();
			const markers = process.sessionManager
				.getEntries()
				.flatMap(entry => (entry.type === "custom" && entry.customType === "hindsight_retain" ? [entry.data] : []));
			expect(markers).toHaveLength(1);
			const data = markers[0];
			if (!data || typeof data !== "object" || !("scope" in data)) throw new Error("the marker has no scope");
			scopes.push(data.scope);
			const file = sessionFileOf(process.sessionManager);
			await process.exit();
			const text = await Bun.file(file).text();
			const hash = Bun.hash(token);
			for (const derived of [token, hash.toString(16), hash.toString(36), hash.toString(10)]) {
				expect(text).not.toContain(derived);
			}
		}
		// A field derived from the token in any form differs between the two accounts.
		expect(scopes[0]).toBe(scopes[1]);
	});

	it("a marker of the earlier scope format (with a token hash) reads as none: today's window once, then the new marker", async () => {
		const dir = tempDir();
		const token = "hsk-first-account-token";
		const writer = new Process(newSession(dir), new FakeBank(), { autoRetain: false, hindsightApiToken: token });
		writer.userTurn("old question one");
		writer.userTurn("old question two");
		writer.userTurn("old question three");
		const lastEntryId = writer.sessionManager.getEntries().at(-1)?.id;
		if (!lastEntryId) throw new Error("no entry");
		writer.sessionManager.appendCustomEntry("hindsight_retain", {
			version: 1,
			scope: JSON.stringify(["hindsight", "http://localhost:8888", Bun.hash(token).toString(16), "bank", []]),
			lastEntryId,
		});
		const file = sessionFileOf(writer.sessionManager);
		await writer.exit();

		const bank = new FakeBank();
		const resumed = new Process(await reopen(dir, file), bank, { hindsightApiToken: token });
		await resumed.endTurn();
		// A card turn alone starts no retain (the turn gate is unchanged); the next user turn's retain sends it.
		resumed.cardTurn("new card");
		await resumed.endTurn();
		resumed.userTurn("new question");
		await resumed.endTurn();

		expect(bank.sent()).toEqual([
			["old question three", "reply to old question three"],
			["reply to new card", "new question", "reply to new question"],
		]);
		await resumed.exit();
	});

	it("full-session mode neither reads nor writes a marker", async () => {
		const bank = new FakeBank();
		const process = new Process(newSession(tempDir()), bank, { retainMode: "full-session" });
		process.userTurn("question one");
		await process.endTurn();
		process.userTurn("question two");
		await process.endTurn();

		expect(bank.sent()).toEqual([
			["question one", "reply to question one"],
			["question one", "reply to question one", "question two", "reply to question two"],
		]);
		expect(
			process.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === "hindsight_retain"),
		).toBe(false);
		await process.exit();
	});
});

/** The SQL session store: a SQLite file always; PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL` names one. */
const SQL_BACKENDS = [
	{ name: "sqlite", url: undefined as string | undefined, enabled: true },
	{
		name: "postgres",
		url: process.env.OMP_TEST_SQL_POSTGRES_URL,
		enabled: Boolean(process.env.OMP_TEST_SQL_POSTGRES_URL),
	},
];

describe("Hindsight retain position in the SQL session store", () => {
	for (const backend of SQL_BACKENDS) {
		it.skipIf(!backend.enabled)(`round-trips the marker through ${backend.name}`, async () => {
			const dir = tempDir();
			const table = `omp_retain_pos_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
			const connect = () => new SQL(backend.url ?? `sqlite://${dir.join("sessions.db")}`);
			const sessionDir = dir.join("sessions");
			const bank = new FakeBank();
			const drop = async () => {
				const admin = connect();
				for (const name of [table, `${table}_parts`, `${table}_blobs`]) {
					await admin.unsafe(`DROP TABLE IF EXISTS ${name}`);
				}
				await admin.end();
			};
			try {
				const firstClient = connect();
				const firstStorage = await SqlSessionStorage.create({ client: firstClient, table });
				const first = new Process(SessionManager.create(dir.path(), sessionDir, firstStorage), bank);
				first.userTurn("question one");
				// A new SQL-stored session's first write lands asynchronously. The fake bank answers at once; a real
				// one takes a round trip, by which time that write has landed. Wait for it, so this test reads the
				// marker's round trip through the store and not an append racing the session's first write.
				await first.sessionManager.flush();
				await first.endTurn();
				first.cardTurn("card one");
				await first.endTurn();
				const file = sessionFileOf(first.sessionManager);
				await first.exit();
				await firstStorage.drain();
				await firstClient.end();

				const secondClient = connect();
				const secondStorage = await SqlSessionStorage.create({ client: secondClient, table });
				const reopened = await SessionManager.open(file, sessionDir, secondStorage);
				const markers = reopened
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "hindsight_retain");
				expect(markers).toHaveLength(1);
				const second = new Process(reopened, bank);
				await second.endTurn();
				expect(bank.sent()).toEqual([["question one", "reply to question one"], ["reply to card one"]]);
				await second.exit();
				await secondStorage.drain();
				await secondClient.end();
			} finally {
				await drop();
			}
		});
	}
});
