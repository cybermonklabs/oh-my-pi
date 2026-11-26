/**
 * A session on SQL storage that claims sessions, as `omp -p` opens it, whose model call is refused once with an
 * HTTP 429 and then succeeds with a tool call. Closing the retry records the outcome on the refused attempt's entry.
 * When that write is a whole rewrite of the transcript, it takes seconds on a long session, and the tool's result is
 * recorded while it publishes: the test holds any full write the retry's close makes inside its write at the store
 * until the tool's result is recorded, then lets it land. The second case also fails, once, the next read of the
 * whole transcript after that, as a read of a transcript of a few hundred megabytes can fail while the store is busy.
 *
 * Three properties, each its own test:
 * - Storage: no failure reported, no write refused, and every entry stored, those of the turn after the retry and of
 *   the next turn included. Where the close rewrote the whole transcript, the tool's result was refused ("Session
 *   file changed before rewrite": the store's index already held the rewrite's body), and when the landed rewrite was
 *   not recorded the session kept the size from before it: every later write stated that size and was refused, and
 *   the store took nothing more while the process lived. Appending the outcome as an `entry_patch` record, and an
 *   entry recorded during the session's own full rewrite waiting for it, each keep this from happening.
 * - The retry closes once: the retry's close writes its outcome (an `entry_patch` record), and the test holds that
 *   write open until the reply after the tool has settled. While the close waited on its write, the retry stayed
 *   open, and that reply closed it a second time and wrote the outcome again.
 * - A retry that starts while an earlier retry's close writes keeps its own retry promise and refusal walk: the
 *   earlier close's end resolved the promise the new retry had reused, and cleared the new retry's walk.
 *
 * SQLite always; PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type {
	SqlSessionStorage,
	SqlSessionStorageClient,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, reserveWrapped, transcript } from "./sql-session-lease-fixture";

const ID = "01a1f100-0000-7000-8000-0000000000d7";
/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
/** A rate limit as a model gateway answers a team it holds back. */
const RATE_LIMITED =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"rate_limit_error: priority guard: the team is held back; retry after 1 s"}}';
const TOOL_RESULT = "MARKER-TOOL-RESULT";
const FIRST_ANSWER = "MARKER-FIRST-TURN-ANSWER";
const SECOND_ANSWER = "MARKER-SECOND-TURN-ANSWER";
/** The output tokens the reply after the tool reports, by which the test knows that reply's usage report. */
const NEXT_REPLY_OUTPUT_TOKENS = 7;

/** A statement of a full write that an append never runs: the full write replaces the session's parts. */
const FULL_WRITE_STATEMENT = /^DELETE FROM \S+_parts WHERE path = /;

interface Hold {
	readonly client: SqlSessionStorageClient;
	/** Hold the next statement that matches, before it runs, until {@link release}. */
	arm(): void;
	/** Resolves once a statement waits at the armed hold. */
	readonly reached: Promise<void>;
	release(): void;
}

/**
 * `client`, whose statements (the client's own, its transactions', and on PostgreSQL its reserved connections')
 * wait right before the first one `pause` matches once the hold is armed, until the test releases it.
 */
function holdBefore(client: SqlSessionStorageClient, pause: RegExp): Hold {
	let gate: PromiseWithResolvers<void> | undefined;
	const reached = Promise.withResolvers<void>();
	const held = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		async unsafe(query, values) {
			if (gate && pause.test(query)) {
				const waiting = gate;
				reached.resolve();
				await waiting.promise;
			}
			return executor.unsafe(query, values);
		},
	});
	let open: (() => void) | undefined;
	return {
		client: {
			options: client.options,
			unsafe: held(client).unsafe,
			transaction: callback => client.transaction(transaction => callback(held(transaction))),
			end: () => client.end?.() ?? Promise.resolve(),
			...reserveWrapped(client, held),
		},
		arm() {
			gate = Promise.withResolvers<void>();
			open = gate.resolve;
		},
		reached: reached.promise,
		release() {
			gate = undefined;
			open?.();
			open = undefined;
		},
	};
}

/** A write the store refused because the size it was stated against is not the size the store holds. */
interface Refusal {
	expectedSize: number | null;
	actualSize: number | null;
}

/**
 * Every write conflict `storage` raises for `file`, once each, in order: from a full write it refuses at once or
 * when it runs, and from a queued write it refuses when the write is confirmed.
 */
function recordRefusals(storage: SqlSessionStorage, file: string): Refusal[] {
	const seen = new Set<Error>();
	const refusals: Refusal[] = [];
	const note = (err: unknown): void => {
		if (!(err instanceof SessionWriteConflictError) || err.path !== file || seen.has(err)) return;
		seen.add(err);
		refusals.push({ expectedSize: err.expectedSize, actualSize: err.actualSize });
	};
	const target = storage as unknown as Record<string, unknown>;
	for (const method of ["writeTextSync", "writeLinesSync"]) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = (...args: unknown[]) => {
			try {
				return original.apply(storage, args);
			} catch (err) {
				note(err);
				throw err;
			}
		};
	}
	for (const method of ["writeTextAtomic", "writeLinesAtomic", "confirmWrites"]) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = (...args: unknown[]) =>
			(original.apply(storage, args) as Promise<unknown>).catch((err: unknown) => {
				note(err);
				throw err;
			});
	}
	return refusals;
}

afterEach(() => {
	vi.restoreAllMocks();
});

async function retriedTurnAndNext(
	db: LeaseDb,
	options: { failReadBack: boolean; holdOutcome?: boolean },
): Promise<{
	observed: Record<string, unknown>;
	close: { outcomeWrites: number; outcomeHeld: string };
	manager: SessionManager;
	session: AgentSession;
}> {
	let hold!: Hold;
	const storage = await db.open({
		lease: STILL,
		wrap: client => {
			hold = holdBefore(client, FULL_WRITE_STATEMENT);
			return hold.client;
		},
	});
	const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-25T00-00-00-000Z_${ID}.jsonl`);
	await storage.writeText(file, transcript(ID, "the session's earlier turn"));
	await storage.drain();
	const refusals = recordRefusals(storage, file);

	// The first full write after the retry starts is the one the retry's close makes: it is held at the store.
	let armed = false;
	let held = false;
	const rewriteHeld = Promise.withResolvers<void>();
	const target = storage as unknown as Record<string, unknown>;
	for (const method of ["writeTextAtomic", "writeLinesAtomic"]) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = (...args: unknown[]) => {
			if (armed && !held) {
				held = true;
				hold.arm();
				void hold.reached.then(() => rewriteHeld.resolve());
			}
			return original.apply(storage, args);
		};
	}

	// The next read of the whole transcript once the held rewrite was let go fails once (second case).
	let released = false;
	const failedReads: string[] = [];
	const readText = storage.readText.bind(storage);
	storage.readText = async (requested: string) => {
		if (options.failReadBack && released && failedReads.length === 0 && requested === file) {
			failedReads.push(requested);
			throw new Error("canceling statement due to statement timeout");
		}
		return readText(requested);
	};

	const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
	await manager.claimOpenedSession();
	const failures: string[] = [];
	manager.onPersistenceError(error => failures.push(error.message));
	const notices: string[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice.reason));
	// Once the tool's result is recorded, the held rewrite goes on and lands. The model call after the tool lets it go
	// too, should no tool result pass through appendMessage first.
	let releasedBy = "none";
	const releaseHold = (by: string): void => {
		if (!held || released) return;
		released = true;
		releasedBy = by;
		hold.release();
	};
	const appendMessage = manager.appendMessage.bind(manager);
	manager.appendMessage = ((message: Parameters<SessionManager["appendMessage"]>[0]) => {
		const id = appendMessage(message);
		if (message.role === "toolResult") releaseHold("the tool's result");
		return id;
	}) as SessionManager["appendMessage"];

	// With `holdOutcome`, the test counts each write of the retry's outcome (an `entry_patch` record that sets
	// `retryRecovery` on the refused attempt's entry) and keeps the first one pending, once its write has started,
	// until the reply after the tool has settled: that reply settles while the retry's close still waits on its
	// write, as it does on a busy store.
	let outcomeWrites = 0;
	let outcomeHeld = "not held";
	const outcomePending = Promise.withResolvers<void>();
	const nextReplySettled = Promise.withResolvers<void>();
	if (options.holdOutcome) {
		const patchEntries = manager.patchEntries.bind(manager);
		manager.patchEntries = (async (patches: Parameters<SessionManager["patchEntries"]>[0]) => {
			const writing = patchEntries(patches);
			const outcome = armed && patches.some(patch => patch.message?.retryRecovery !== undefined);
			if (outcome && outcomeWrites++ === 0) {
				outcomeHeld = "held";
				outcomePending.resolve();
				await nextReplySettled.promise;
				outcomeHeld = "held until the next reply settled";
			}
			await writing;
		}) as SessionManager["patchEntries"];
	}

	const retryEnded = Promise.withResolvers<void>();
	let toolRuns = 0;
	const readTool: AgentTool = {
		name: "read",
		label: "Read",
		description: "Reads a file",
		parameters: type({ "path?": "string" }),
		execute: async () => {
			// The tool after the retry finishes while the retry's rewrite publishes. A build whose retry makes no
			// full write closes the retry first, and the tool goes on then. With `holdOutcome` the tool does not wait
			// for the retry to close: it goes on once the outcome's write is pending (or a full write is held).
			if (toolRuns++ === 0) {
				await (options.holdOutcome
					? Promise.race([outcomePending.promise, rewriteHeld.promise])
					: Promise.race([rewriteHeld.promise, retryEnded.promise]));
			}
			return { content: [{ type: "text" as const, text: TOOL_RESULT }], details: {} };
		},
	};
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	if (options.holdOutcome) {
		// The session reports each reply's usage right after it settles the reply (closing the retry that reply
		// ends): in AgentSession's message_end handler, `authStorage.usage.observe` is the statement after
		// `await onAssistantSettledSuccessfully(...)`, and no session event follows the settle. The report of the
		// reply after the tool lets the held outcome write go on.
		const usage = authStorage.usage;
		const observe = usage.observe.bind(usage);
		usage.observe = entry => {
			observe(entry);
			if (entry.usage.output === NEXT_REPLY_OUTPUT_TOKENS) nextReplySettled.resolve();
		};
	}
	const mock = createMockModel({
		responses: [
			{ throw: RATE_LIMITED },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] },
			() => {
				releaseHold("the model call after the tool");
				return {
					content: [FIRST_ANSWER],
					stopReason: "stop" as const,
					usage: { output: NEXT_REPLY_OUTPUT_TOKENS },
				};
			},
			{ content: [SECOND_ANSWER], stopReason: "stop" },
		],
	});
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [] },
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
			"todo.enabled": false,
		}),
		modelRegistry: new ModelRegistry(authStorage),
	});
	mockSchedulerWaitWithClock();
	const retries: boolean[] = [];
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "auto_retry_start") armed = true;
		if (event.type === "auto_retry_end") {
			retries.push(event.success);
			retryEnded.resolve();
		}
	});

	await session.prompt("Read notes.txt, then answer.");
	await session.waitForIdle();
	// Let a rewrite still held go (a build where no tool result followed it), so nothing waits on the hold.
	releaseHold("the end of the turn");
	await manager.flush().catch(() => undefined);
	// While the process lives, the store holds the turn after the retry.
	const afterRetriedTurn = (await db.row(manager.getSessionFile() ?? file))?.content ?? "";

	await session.prompt("Go on.");
	await session.waitForIdle();
	await manager.flush().catch(() => undefined);
	const written = manager.getSessionFile() ?? file;
	const stored = await db.row(written);
	const refusedSizes = refusals.map(refusal => refusal.expectedSize);
	return {
		manager,
		session,
		close: { outcomeWrites, outcomeHeld },
		observed: {
			retried: retries,
			rewriteHeld: held ? `held, let go by ${releasedBy}` : "no full write after the retry",
			readBackFailed: failedReads.length,
			failures,
			notices,
			refusals,
			refusedSizesRepeated: refusedSizes.length - new Set(refusedSizes).size,
			storedAfterRetriedTurn: [TOOL_RESULT, FIRST_ANSWER, '"retryRecovery"'].map(text =>
				afterRetriedTurn.includes(text),
			),
			storedAfterNextTurn: [TOOL_RESULT, FIRST_ANSWER, SECOND_ANSWER].map(text => stored?.content.includes(text)),
			expectsWhatIsStored: manager.captureState().expectedDiskSize === stored?.byteLen,
		},
	};
}

/** A classifier refusal, as Anthropic's stop details report one. */
const REFUSAL = {
	content: [],
	stopReason: "error" as const,
	stopDetails: { type: "refusal" as const, category: "cyber", explanation: "Declined." },
	errorMessage: "Refusal (cyber): Declined.",
};

/**
 * The first retry (a 429 on model A, which walks to B) closes while its outcome write is held; meanwhile the reply
 * after the tool is a classifier refusal on B, which starts a second retry that walks to C. The held write goes on
 * once the second retry has started, so the first close ends inside the second retry. C refuses too, and its chain
 * names only B, which the second retry already left: the walk ends there unless the first close cleared it.
 */
async function secondRetryDuringClose(db: LeaseDb): Promise<{
	observed: Record<string, unknown>;
	manager: SessionManager;
	session: AgentSession;
}> {
	const storage = await db.open({ lease: STILL });
	const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-25T00-00-00-000Z_${ID}.jsonl`);
	await storage.writeText(file, transcript(ID, "the session's earlier turn"));
	await storage.drain();
	const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
	await manager.claimOpenedSession();

	const modelA = getBundledModel("anthropic", "claude-sonnet-4-5");
	const modelB = getBundledModel("openai", "gpt-4o-mini");
	const modelC = getBundledModel("openai", "gpt-4o");
	if (!modelA || !modelB || !modelC) throw new Error("Expected the bundled test models");
	const selectorA = `${modelA.provider}/${modelA.id}`;
	const selectorB = `${modelB.provider}/${modelB.id}`;
	const selectorC = `${modelC.provider}/${modelC.id}`;

	// The first retry's outcome write stays pending, once it has started, until the second retry has started.
	let armed = false;
	let outcomeWrites = 0;
	const outcomePending = Promise.withResolvers<void>();
	const secondRetryStarted = Promise.withResolvers<void>();
	const firstRetryEnded = Promise.withResolvers<void>();
	const patchEntries = manager.patchEntries.bind(manager);
	manager.patchEntries = (async (patches: Parameters<SessionManager["patchEntries"]>[0]) => {
		const writing = patchEntries(patches);
		const outcome = armed && patches.some(patch => patch.message?.retryRecovery !== undefined);
		if (outcome && outcomeWrites++ === 0) {
			outcomePending.resolve();
			await secondRetryStarted.promise;
		}
		await writing;
	}) as SessionManager["patchEntries"];

	let toolRuns = 0;
	const readTool: AgentTool = {
		name: "read",
		label: "Read",
		description: "Reads a file",
		parameters: type({ "path?": "string" }),
		execute: async () => {
			// The tool goes on once the first retry's outcome write is pending; it does not wait for the retry to end.
			if (toolRuns++ === 0) await outcomePending.promise;
			return { content: [{ type: "text" as const, text: TOOL_RESULT }], details: {} };
		},
	};

	const requested: string[] = [];
	let retryStarts = 0;
	let retryingAfterFirstEnded: boolean | undefined;
	const mock = createMockModel({
		handler: async () => {
			const n = requested.length;
			const model = requested[n - 1];
			if (n === 1) return { throw: RATE_LIMITED };
			if (n === 2) return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
			if (retryStarts >= 2 && retryingAfterFirstEnded === undefined) {
				// The second retry's first request. The first close has published its end; its `finally` runs
				// before the next turn of the event loop, and then the second retry must still be open.
				await firstRetryEnded.promise;
				const nextTurn = Promise.withResolvers<void>();
				setImmediate(nextTurn.resolve);
				await nextTurn.promise;
				retryingAfterFirstEnded = session.isRetrying;
			}
			// B answers only once C was asked, which a walk that kept its record of B never does.
			if (model === selectorB && requested.includes(selectorC)) {
				return { content: [FIRST_ANSWER], stopReason: "stop" };
			}
			return REFUSAL;
		},
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	authStorage.keys.setRuntime("openai", "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": true,
		"retry.baseDelayMs": 5,
		"retry.maxDelayMs": 2_000,
		"retry.maxRetries": 1,
		"retry.fallbackChains": { [selectorA]: [selectorB], [selectorB]: [selectorC], [selectorC]: [selectorB] },
		"features.unexpectedStopDetection": "none",
		"todo.enabled": false,
	});
	settings.setModelRole("default", selectorA);
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: modelA, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
			convertToLlm,
		}),
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	mockSchedulerWaitWithClock();
	const retries: boolean[] = [];
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "auto_retry_start") {
			armed = true;
			if (++retryStarts === 2) secondRetryStarted.resolve();
		}
		if (event.type === "auto_retry_end") {
			retries.push(event.success);
			firstRetryEnded.resolve();
		}
	});

	await session.prompt("Read notes.txt, then answer.");
	// Let a held write go (a build where the second retry never started), so nothing waits on the hold.
	secondRetryStarted.resolve();
	await session.waitForIdle();
	await manager.flush().catch(() => undefined);
	const firstC = requested.indexOf(selectorC);
	return {
		manager,
		session,
		observed: {
			outcomeHeld: outcomeWrites > 0 && retryStarts >= 2,
			retryingAfterFirstEnded,
			askedBAfterC: firstC >= 0 && requested.slice(firstC + 1).includes(selectorB),
			retried: retries,
		},
	};
}

/** The two cases: the landed rewrite reads back, or its next whole read fails once. */
const CASES = [
	{ when: "the retry's close publishes while the next tool's result is recorded", failReadBack: false },
	{ when: "the transcript cannot be read back once after that publish", failReadBack: true },
] as const;

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a SQL session after a model call refused with a 429 and retried (${adapter})`, () => {
		for (const { when, failReadBack } of CASES) {
			// If this regresses, the tool's result is refused against a rewrite already in the store's index ("Session
			// persistence failed: Session file changed before rewrite" for a file nothing else wrote), and when that
			// rewrite is not recorded, every later write states the size from before it and is refused: the store takes no
			// entry of the session again while the process lives.
			it(`keeps storing every entry, reporting no failure and refusing no write, when ${when}`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { observed, manager, session } = await retriedTurnAndNext(db, { failReadBack });
				const { retried: _retried, ...storage } = observed;
				expect(storage).toEqual({
					rewriteHeld: observed.rewriteHeld,
					// Whether the build reads the transcript back at all is not the contract; storing every entry is.
					readBackFailed: failReadBack ? observed.readBackFailed : 0,
					failures: [],
					notices: [],
					refusals: [],
					refusedSizesRepeated: 0,
					storedAfterRetriedTurn: [true, true, true],
					storedAfterNextTurn: [true, true, true],
					expectsWhatIsStored: true,
				});
				await session.dispose();
				await manager.close();
			}, 120_000);
		}

		// If this regresses, the retry stays open while its close writes the outcome, and the reply after the tool,
		// settling in that window, closes it a second time: two `auto_retry_end` events and two writes of the outcome
		// for one refused call.
		it("closes the retry once, when the next reply settles while the retry's outcome is written", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { observed, close, manager, session } = await retriedTurnAndNext(db, {
				failReadBack: false,
				holdOutcome: true,
			});
			expect({ retried: observed.retried, ...close }).toEqual({
				retried: [true],
				outcomeWrites: 1,
				outcomeHeld: "held until the next reply settled",
			});
			await session.dispose();
			await manager.close();
		}, 120_000);

		// If this regresses, the first close's end resolves the retry promise of the retry that started during its
		// write (the session stops reporting a retry while that retry runs), or clears that retry's refusal walk (the
		// walk asks a model it already left, B -> C -> B).
		it("keeps a retry that starts while an earlier retry's close writes open, with its refusal walk", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { observed, manager, session } = await secondRetryDuringClose(db);
			expect(observed).toEqual({
				outcomeHeld: true,
				retryingAfterFirstEnded: true,
				askedBAfterC: false,
				retried: [true, false],
			});
			await session.dispose();
			await manager.close();
		}, 120_000);
	});
}
