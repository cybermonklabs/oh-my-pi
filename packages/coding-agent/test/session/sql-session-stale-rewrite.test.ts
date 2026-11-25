/**
 * A long session on SQL storage that claims sessions recovers a turn an HTTP
 * 429 failed through the automatic retry; then, three times, an older build
 * (a writer that holds no claim) appends to its stored transcript, and the
 * session's next write is a full rewrite a caller asks for (`rewriteEntries()`,
 * as `/dropimages` and `/shake` call it, and as the released build's retry
 * did). Each rewrite completes, no two refusals the store raises state the same
 * expected size, and no value handed to or taken from storage, and no text
 * handed to the JSON parse, passes 16 MiB. SQLite always; PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { byteSize, Longest, recordClient, recordStorage } from "../helpers/longest-value";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb } from "./sql-session-lease-fixture";

const ID = "01a1f100-0000-7000-8000-0000000000c5";
const MiB = 1024 * 1024;
/** No value handed to or taken from storage, and no text handed to the parse, may pass this. */
const BOUND = 16 * MiB;
/** The stored transcript's size before the turn. */
const TRANSCRIPT_BYTES = 64 * MiB;
const CONFLICTS = 3;
const TIMESTAMP = "2026-11-24T00:00:00.000Z";
/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
/** The refusal an over-quota gateway answered the turn with, as the live log shows it. */
const RATE_LIMITED =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"rate_limit_error: the team is held back; retry after 1 s"}}';
const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

/**
 * Store, as an older build that claims nothing writes it, a transcript of
 * session {@link ID} at `file` of at least {@link TRANSCRIPT_BYTES}: a header,
 * then alternating user and assistant messages of about 100 KiB, appended a
 * little over 1 MiB at a time, so no write of it is a long value.
 */
async function storeLongTranscript(db: LeaseDb, file: string): Promise<void> {
	const older = await db.open({ claims: false });
	await older.writeText(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/project" })}\n`,
	);
	const writer = older.openWriter(file);
	let batch = "";
	let parentId: string | null = null;
	for (let n = 0, total = 0; total < TRANSCRIPT_BYTES; n++) {
		const text = `${n} ${"a€😀b".repeat(10_000)}`;
		const message =
			n % 2 === 0
				? { role: "user", content: text, timestamp: n }
				: {
						role: "assistant",
						content: [{ type: "text", text }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: USAGE,
						stopReason: "stop",
						timestamp: n,
					};
		const line = `${JSON.stringify({ type: "message", id: `m${n}`, parentId, timestamp: TIMESTAMP, message })}\n`;
		parentId = `m${n}`;
		batch += line;
		total += Buffer.byteLength(line);
		if (batch.length < MiB) continue;
		await writer.append(batch);
		batch = "";
	}
	if (batch) await writer.append(batch);
	await writer.close();
	await older.drain();
}

/** As an older build, which claims nothing, does: append a turn with id `id` to the stored transcript at `file`. */
async function appendAsOlderBuild(db: LeaseDb, file: string, id: string): Promise<void> {
	const older = await db.open({ claims: false });
	const writer = older.openWriter(file);
	await writer.append(
		`${JSON.stringify({ type: "message", id, parentId: null, timestamp: TIMESTAMP, message: userTurn(`the older build's turn ${id}`) })}\n`,
	);
	await writer.close();
	await older.drain();
}

/**
 * Every write conflict `storage` raises for `file`, once each, in order: from
 * a full write it refuses at once, from a queued write it refuses when the
 * write is confirmed, and from an append it refuses under a writer.
 */
function recordConflicts(storage: SqlSessionStorage, file: string): SessionWriteConflictError[] {
	const conflicts: SessionWriteConflictError[] = [];
	const note = (err: unknown): void => {
		if (err instanceof SessionWriteConflictError && err.path === file && !conflicts.includes(err))
			conflicts.push(err);
	};
	const writeLinesAtomic = storage.writeLinesAtomic.bind(storage);
	const writeLinesSync = storage.writeLinesSync.bind(storage);
	const confirmWrites = storage.confirmWrites.bind(storage);
	const openWriter = storage.openWriter.bind(storage);
	storage.writeLinesAtomic = async (target, lines, options) => {
		try {
			await writeLinesAtomic(target, lines, options);
		} catch (err) {
			note(err);
			throw err;
		}
	};
	storage.writeLinesSync = (target, lines, options) => {
		try {
			writeLinesSync(target, lines, options);
		} catch (err) {
			note(err);
			throw err;
		}
	};
	storage.confirmWrites = target =>
		confirmWrites(target).catch((err: unknown) => {
			note(err);
			throw err;
		});
	storage.openWriter = (target, options) =>
		openWriter(target, {
			...options,
			onError: err => {
				note(err);
				options?.onError?.(err);
			},
		});
	return conflicts;
}

afterEach(() => {
	vi.restoreAllMocks();
});

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a long SQL session whose stored transcript an older build appended to (${adapter})`, () => {
		// If this regresses, every rewrite after the first conflict states the size the store refused, is refused the
		// same way, and the session's later entries never reach storage while the process lives.
		it("completes each rewrite a caller asks for, states no refused size twice, and hands storage and the parse no long value", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-24T00-00-00-000Z_${ID}.jsonl`);
			await storeLongTranscript(db, file);
			const longest = new Longest();
			const store = await db.open({ lease: STILL, wrap: client => recordClient(client, longest) });
			const conflicts = recordConflicts(store, file);
			const storage = recordStorage(store, longest);
			const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			await manager.claimOpenedSession();

			// One turn an HTTP 429 fails, which the automatic retry recovers; every write of it settles.
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected the bundled anthropic model");
			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("anthropic", "test-key");
			const mock = createMockModel({
				responses: [{ throw: RATE_LIMITED }, { content: ["recovered after the rate limit"], stopReason: "stop" }],
			});
			const session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: mock.stream,
					convertToLlm,
				}),
				sessionManager: manager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": true,
					"retry.baseDelayMs": 5,
					"retry.maxDelayMs": 2_000,
					"retry.maxRetries": 1,
					"retry.modelFallback": false,
					"features.unexpectedStopDetection": "none",
				}),
				modelRegistry: new ModelRegistry(authStorage),
			});
			mockSchedulerWaitWithClock();
			const retries: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_end") retries.push(event);
			});
			await session.prompt("Turn the gateway rate limits");
			await session.waitForIdle();
			await manager.flush();
			const conflictsBefore = conflicts.length;

			// From here on: the longest value storage is handed or hands back, and the longest text the parse is given.
			longest.reset();
			const parse = JSON.parse;
			const parseChunk = Bun.JSONL.parseChunk;
			vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
				longest.note(byteSize(text), "a text handed to JSON.parse");
				return parse(text, reviver);
			});
			vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation((input, start, end) => {
				longest.note(byteSize(input), "a text handed to Bun.JSONL.parseChunk");
				return parseChunk(input, start, end);
			});
			const outcomes: string[] = [];
			for (let conflict = 0; conflict < CONFLICTS; conflict++) {
				await appendAsOlderBuild(db, file, `older${conflict}`);
				// The session's next write after the older build's append: no append of the session's comes before it.
				outcomes.push(
					await manager.rewriteEntries().then(
						() => "stored",
						(err: unknown) => String(err),
					),
				);
			}
			vi.restoreAllMocks();

			const written = manager.getSessionFile() ?? "";
			const stored = await db.row(written);
			const refusedSizes = conflicts.slice(conflictsBefore).map(conflict => conflict.expectedSize);
			expect({
				retried: retries.map(retry => retry.success),
				outcomes,
				refusals: refusedSizes.length,
				refusedSizesRepeated: refusedSizes.length - new Set(refusedSizes).size,
				longest: { what: longest.what, bounded: longest.bytes <= BOUND },
				kept: ["older0", "older1", "older2", "recovered after the rate limit"].map(text =>
					stored?.content.includes(text),
				),
				expectsWhatIsStored: manager.captureState().expectedDiskSize === stored?.byteLen,
				notices: notices.map(notice => notice.reason),
			}).toEqual({
				retried: [true],
				outcomes: ["stored", "stored", "stored"],
				refusals: CONFLICTS,
				refusedSizesRepeated: 0,
				longest: { what: longest.what, bounded: true },
				kept: [true, true, true, true],
				expectsWhatIsStored: true,
				notices: [],
			});
			await session.dispose();
			await manager.close();
		}, 600_000);
	});
}
