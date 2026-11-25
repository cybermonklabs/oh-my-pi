/**
 * `SessionManager` on a SQL store that claims sessions: it claims a session
 * when it opens it, keeps writing through a stall of the database it cannot
 * confirm its claim through, and moves to a sibling at once when another
 * holder took the session over — unless the launcher named the session, which
 * then stops instead of writing a sibling. The exit record a session writes
 * as it ends is logged as recorded only where the store holds it. SQLite
 * always; PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	SessionExclusiveStopError,
	SessionManager,
	type SessionPersistenceNotice,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	SessionWriteConflictError,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type {
	SqlSessionStorage,
	SqlSessionStorageClient,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	type GatedClient,
	gatedClient,
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	reserveWrapped,
	TcpProxy,
	transcript,
	until,
} from "./sql-session-lease-fixture";

// These tests wait in real time on purpose: a lease expires and a heartbeat
// runs on the database clock and the store's own interval timer, which no
// fake timer reaches. The timings below keep each wait to seconds.

const ID = "01a1f100-0000-7000-8000-000000000001";
/** Short timings: a heartbeat every half second, an expiry in three. */
const SHORT = { expiryMs: 3000, heartbeatMs: 500 };
/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

function sessionFile(db: LeaseDb): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

/** Open the session at `file` in `storage` as a resume does, claiming it, and collect its notices. */
async function resume(
	storage: SqlSessionStorage,
	file: string,
): Promise<{ manager: SessionManager; notices: SessionPersistenceNotice[] }> {
	const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
	const notices: SessionPersistenceNotice[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	await manager.claimOpenedSession();
	return { manager, notices };
}

/** As an older build, which claims nothing, does: append a turn with id `id` to the session at `file`. */
async function appendAsOlderBuild(db: LeaseDb, file: string, id: string, text: string): Promise<void> {
	const older = await db.open({ claims: false });
	const writer = older.openWriter(file);
	await writer.append(
		`${JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-11-17T00:00:09.000Z", message: userTurn(text) })}\n`,
	);
	await writer.close();
	await older.drain();
}

/** A size-checked full write of a session: the size it stated, and, when the store refused it, the size the store held. */
interface FullWrite {
	expectedSize: number | null | undefined;
	refusedAt?: number | null;
}

/** Every size-checked full write, synchronous or atomic, that `storage` takes of `file` from now on, in order. */
function recordFullWrites(storage: SqlSessionStorage, file: string): FullWrite[] {
	const writes: FullWrite[] = [];
	const atomic = storage.writeLinesAtomic.bind(storage);
	const sync = storage.writeLinesSync.bind(storage);
	storage.writeLinesAtomic = async (target, lines, options) => {
		if (target !== file) return atomic(target, lines, options);
		const write: FullWrite = { expectedSize: options?.expectedSize };
		writes.push(write);
		try {
			await atomic(target, lines, options);
		} catch (err) {
			if (err instanceof SessionWriteConflictError && err.path === file) write.refusedAt = err.actualSize;
			throw err;
		}
	};
	storage.writeLinesSync = (target, lines, options) => {
		if (target !== file) return sync(target, lines, options);
		const write: FullWrite = { expectedSize: options?.expectedSize };
		writes.push(write);
		try {
			sync(target, lines, options);
		} catch (err) {
			if (err instanceof SessionWriteConflictError && err.path === file) write.refusedAt = err.actualSize;
			throw err;
		}
	};
	return writes;
}

/**
 * The writes that follow a refused one without stating the size the store
 * held when it refused: the refused size again, or any size not read back.
 * Empty when every write after a refusal stated what the store held, and
 * when nothing was refused or nothing followed a refusal.
 */
function retriesOfAStaleSize(writes: readonly FullWrite[]): FullWrite[] {
	return writes.filter((write, index) => {
		const before = writes[index - 1];
		return before?.refusedAt !== undefined && write.expectedSize !== before.refusedAt;
	});
}

/**
 * `client`, whose statements, its transactions' and a SQLite store's (which
 * runs its own BEGIN on the client), wait right before the first one `pause`
 * matches once the gate is closed, until the test opens it.
 */
function holdBefore(client: SqlSessionStorageClient, pause: RegExp): GatedClient {
	let gate: PromiseWithResolvers<void> | undefined;
	let reached = Promise.withResolvers<void>();
	const held = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		async unsafe(query, values) {
			if (gate && pause.test(query)) {
				const waiting = gate;
				gate = undefined;
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
		close() {
			gate = Promise.withResolvers<void>();
			open = gate.resolve;
			reached = Promise.withResolvers<void>();
		},
		paused: () => reached.promise,
		open() {
			open?.();
			open = undefined;
		},
	};
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`SessionManager claims on SQL storage (${adapter})`, () => {
		it("takes in the entries an older build appended to its session, and keeps writing it", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("mine before the change"));
			await manager.flush();
			// An older build, which claims nothing, appends to the session.
			const older = await db.open({ claims: false });
			const writer = older.openWriter(file);
			await writer.append(
				`${JSON.stringify({ type: "message", id: "older1", parentId: null, timestamp: "2026-11-17T00:00:09.000Z", message: userTurn("the older build's turn") })}\n`,
			);
			await writer.close();
			await older.drain();

			// The append meets the changed file; the recovery runs before flush() returns.
			manager.appendMessage(userTurn("mine after the change"));
			const outcome = await manager.flush().then(
				() => undefined,
				(err: unknown) => String(err),
			);

			const stored = (await db.row(file))?.content ?? "";
			expect({
				outcome,
				notices,
				id: manager.getSessionId(),
				stored: ["mine before the change", "the older build's turn", "mine after the change"].map(text =>
					stored.includes(text),
				),
				adopted: manager.getEntries().some(entry => entry.id === "older1"),
			}).toEqual({ outcome: undefined, notices: [], id: ID, stored: [true, true, true], adopted: true });
			await manager.close();
		});

		it("moves to a sibling naming replaced when an older build puts another session over its file, keeping every entry", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("mine before the change"));
			await manager.flush();
			const replacement = transcript("01a1f100-0000-7000-8000-0000000000d5", "another session");
			const older = await db.open({ claims: false });
			await older.writeText(file, replacement);
			await older.drain();

			manager.appendMessage(userTurn("mine after the change"));
			const outcome = await manager.flush().then(
				() => undefined,
				(err: unknown) => String(err),
			);

			const sibling = manager.getSessionFile() ?? "";
			const moved = (await db.row(sibling))?.content ?? "";
			expect({
				outcome,
				notices,
				kept: ["mine before the change", "mine after the change"].map(text => moved.includes(text)),
				untouched: (await db.row(file))?.content === replacement,
			}).toEqual({
				outcome: undefined,
				notices: [{ reason: "replaced", from: file, to: sibling }],
				kept: [true, true],
				untouched: true,
			});
			await manager.close();
		});

		it("releases the claim and the writer slot a switch took when the session's file is emptied between the header read and the load", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			// Another file of the same session, where another process claims it: a claim is keyed by the session id.
			const copy = path.join(path.dirname(file), `2026-11-17T00-00-01-000Z_${ID}.jsonl`);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.writeText(copy, transcript(ID, "a copy"));
			await storage.drain();
			// The hook the test controls: once the switch holds its claim, and before it loads, the file is emptied.
			const acquire = storage.acquireSessionClaim?.bind(storage);
			const emptying = new Proxy(storage, {
				get(target, prop) {
					if (prop === "acquireSessionClaim" && acquire) {
						return async (...args: Parameters<typeof acquire>) => {
							const release = await acquire(...args);
							await target.writeText(args[1], "");
							return release;
						};
					}
					const value: unknown = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const manager = SessionManager.create(db.dir.path(), path.dirname(file), emptying);
			await manager.setSessionFile(file, { claim: { waitMs: 0 } });
			// The emptied file starts a new session at the same path, whose writes claim the path's id again, so the
			// manager holds it while it runs; once it closes, nothing of this store may hold the old id. A store
			// deletes a released lease row once the writes queued under it land; drain() waits for that.
			const newSession = manager.getSessionId() !== ID;
			await manager.close();
			await storage.drain();
			// The writer slot: another writer of this store takes the old id at the copy only once the switch gave it back.
			const writer = await storage.acquireSessionClaim?.(ID, copy, { writer: true, waitMs: 0 });
			const writerSlotFree = typeof writer === "function";
			writer?.();
			await storage.drain();
			await using other = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("other"),
			);
			// The first store still lives: a claim it leaked would refuse this one for the life of the process.
			const claimed = await other.run({ op: "claim", sessionId: ID, path: copy });
			expect({ newSession, writerSlotFree, otherProcessHolds: claimed.held }).toEqual({
				newSession: true,
				writerSlotFree: true,
				otherProcessHolds: true,
			});
		}, 30_000);

		// If this regresses, a session whose stored size moved under it states the refused size again on every later
		// full write, each refused the same way, and none of its writes lands while the process lives. The row where
		// nothing changed the file is the control: the same check passes when no write is refused.
		for (const olderBuildAppended of [true, false]) {
			it(`states the size the store holds, never a refused one, on each rewrite a caller asks for (${olderBuildAppended ? "after an older build appended" : "on a file nobody else wrote"})`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open({ lease: STILL });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.drain();
				const { manager, notices } = await resume(storage, file);
				manager.appendMessage(userTurn("mine before the change"));
				await manager.flush();
				if (olderBuildAppended) await appendAsOlderBuild(db, file, "older1", "the older build's turn");
				const writes = recordFullWrites(storage, file);

				// Two rewrites, as the close of a retry saga asked for one after each automatic retry.
				const outcomes: string[] = [];
				for (let attempt = 0; attempt < 2; attempt++) {
					outcomes.push(
						await manager.rewriteEntries().then(
							() => "stored",
							(err: unknown) => String(err),
						),
					);
				}

				const stored = await db.row(file);
				expect({
					outcomes,
					refused: writes.filter(write => write.refusedAt !== undefined).length,
					retriesOfAStaleSize: retriesOfAStaleSize(writes),
					notices,
					id: manager.getSessionId(),
					kept: ["mine before the change", "the older build's turn"].map(text => stored?.content.includes(text)),
					expectsWhatIsStored: manager.captureState().expectedDiskSize === stored?.byteLen,
				}).toEqual({
					outcomes: ["stored", "stored"],
					refused: olderBuildAppended ? 1 : 0,
					retriesOfAStaleSize: [],
					notices: [],
					id: ID,
					kept: [true, olderBuildAppended],
					expectsWhatIsStored: true,
				});
				await manager.close();
			});
		}

		// If this regresses, after a session listing reloads the store's index every entry is refused against the size
		// this manager expects, which nothing reads again, and none reaches storage while the process lives.
		it("keeps saving its entries after a session listing reloads the size an older build left", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("mine before the change"));
			await manager.flush();
			await appendAsOlderBuild(db, file, "older1", "the older build's turn");
			// What every session listing does before it lists.
			await storage.refresh();
			const writes = recordFullWrites(storage, file);

			const outcomes: string[] = [];
			for (const text of ["mine after the change", "and my next turn"]) {
				manager.appendMessage(userTurn(text));
				outcomes.push(
					await manager.flush().then(
						() => "stored",
						(err: unknown) => String(err),
					),
				);
			}

			const stored = await db.row(file);
			expect({
				outcomes,
				refused: writes.filter(write => write.refusedAt !== undefined).length,
				retriesOfAStaleSize: retriesOfAStaleSize(writes),
				notices,
				kept: ["mine before the change", "the older build's turn", "mine after the change", "and my next turn"].map(
					text => stored?.content.includes(text),
				),
				expectsWhatIsStored: manager.captureState().expectedDiskSize === stored?.byteLen,
			}).toEqual({
				outcomes: ["stored", "stored"],
				refused: 1,
				retriesOfAStaleSize: [],
				notices: [],
				kept: [true, true, true, true],
				expectsWhatIsStored: true,
			});
			await manager.close();
		});

		// If this regresses, an entry recorded while the session's own full rewrite is publishing is checked against
		// the body that rewrite already put in the store's index: it is refused, "Session persistence failed" is
		// reported for a write nothing else changed, and the rewrite is superseded, so the entry waits for a later write.
		it("appends an entry recorded during its own full rewrite once that rewrite lands, reporting no failure", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			let gate!: GatedClient;
			const storage = await db.open({
				lease: STILL,
				// The size check that opens the swap of a full write, once its body is staged: the rewrite is publishing.
				wrap: client => (gate = holdBefore(client, /^SELECT byte_len FROM/)).client,
			});
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("mine before the rewrite"));
			await manager.flush();
			const failures: string[] = [];
			manager.onPersistenceError(error => failures.push(error.message));
			const turn = manager.getEntries().findLast(entry => entry.type === "message");
			if (turn?.type !== "message" || turn.message.role !== "user") throw new Error("Expected the user turn");
			turn.message.content = "pruned before the rewrite";
			const writes = recordFullWrites(storage, file);

			gate.close();
			const rewrite = manager.rewriteEntries().then(
				() => "stored",
				(err: unknown) => String(err),
			);
			await gate.paused();
			manager.appendMessage(userTurn("recorded during the rewrite"));
			gate.open();
			const outcome = await rewrite;
			// What the store holds once its own queued writes land, before any later write of the session.
			await storage.confirmWrites(file);
			const withTheRewrite = (await db.row(file))?.content ?? "";
			await manager.flush();
			const stored = await db.row(file);

			expect({
				outcome,
				failures,
				notices,
				writes,
				landedWithTheRewrite: ["pruned before the rewrite", "recorded during the rewrite"].map(text =>
					withTheRewrite.includes(text),
				),
				copies: stored?.content.split("recorded during the rewrite").length,
				expectsWhatIsStored: manager.captureState().expectedDiskSize === stored?.byteLen,
			}).toEqual({
				outcome: "stored",
				failures: [],
				notices: [],
				writes: [{ expectedSize: writes[0]?.expectedSize }],
				landedWithTheRewrite: [true, true],
				// One copy: the text splits the transcript in two.
				copies: 2,
				expectsWhatIsStored: true,
			});
			await manager.close();
		});

		/**
		 * `storage`, whose in-place write of `file`'s title slot fails once: after the writes queued for the file
		 * settle, as the store's own title write waits for them, and after `before` runs.
		 */
		function failTitleSlotOnce(
			storage: SqlSessionStorage,
			file: string,
			before: () => void | Promise<void> = () => undefined,
		): void {
			const update = storage.updateSessionTitle.bind(storage);
			let failed = false;
			storage.updateSessionTitle = async (target, title) => {
				if (target !== file || failed) return update(target, title);
				failed = true;
				await storage.confirmWrites(file).catch(() => undefined);
				await before();
				throw new Error("the title slot write failed");
			};
		}

		// If this regresses, a rename whose title-slot write falls back to a full rewrite settles before the recovery of
		// a refused write publishes: it reports the rename as done although that recovery fails, or, when the fallback
		// states a size while a recovery reads the stored one, the session moves to a sibling as replaced.
		for (const { name, olderBuildAppends, recoveryPublishes, settled } of [
			{
				name: "the store refuses the fallback, and the recovery it hands the refusal to publishes",
				olderBuildAppends: "after the rename's entry",
				recoveryPublishes: true,
				settled: { renamed: true, refusals: [true, false] },
			},
			{
				name: "the store refuses the fallback, and the recovery it hands the refusal to fails",
				olderBuildAppends: "after the rename's entry",
				recoveryPublishes: false,
				settled: { rejected: "Error: the recovery's publish failed", refusals: [true, false] },
			},
			{
				// The store refuses the rename's own entry, so a recovery runs when the slot write fails.
				name: "a recovery reads the stored size when the slot write fails",
				olderBuildAppends: "before the rename",
				recoveryPublishes: true,
				settled: { renamed: true, refusals: [false, false] },
			},
		]) {
			it(`settles a rename whose title-slot write falls back to a full rewrite with the recovery (${name})`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open({ lease: STILL });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.drain();
				const { manager, notices } = await resume(storage, file);
				manager.appendMessage(userTurn("mine before the change"));
				// The first name gives the file its title slot, so the rename below writes that slot in place.
				await manager.setSessionName("the first name", "user");
				await manager.flush();
				if (olderBuildAppends === "before the rename") {
					await appendAsOlderBuild(db, file, "older1", "the older build's turn");
					failTitleSlotOnce(storage, file);
				} else {
					failTitleSlotOnce(storage, file, () => appendAsOlderBuild(db, file, "older1", "the older build's turn"));
				}
				const writes = recordFullWrites(storage, file);
				if (!recoveryPublishes) {
					const atomic = storage.writeLinesAtomic.bind(storage);
					storage.writeLinesAtomic = async (target, lines, options) => {
						// The first full write is the refused fallback; the second is the recovery's publish.
						if (target === file && writes.length === 1) {
							writes.push({ expectedSize: options?.expectedSize });
							throw new Error("the recovery's publish failed");
						}
						return atomic(target, lines, options);
					};
				}

				// The full writes of the session, each refused or not, at the moment the rename settles.
				const outcome = await manager.setSessionName("the second name", "user").then(
					renamed => ({ renamed, refusals: writes.map(write => write.refusedAt !== undefined) }),
					(err: unknown) => ({
						rejected: String(err),
						refusals: writes.map(write => write.refusedAt !== undefined),
					}),
				);
				await storage.confirmWrites(file);
				const stored = (await db.row(file))?.content ?? "";

				expect({
					outcome,
					notices,
					kept: recoveryPublishes
						? ["the second name", "the older build's turn"].map(text => stored.includes(text))
						: undefined,
				}).toEqual({
					outcome: settled,
					notices: [],
					kept: recoveryPublishes ? [true, true] : undefined,
				});
				await manager.close().catch(() => undefined);
			});
		}

		// If this regresses, an entry recorded while a rename's fallback full rewrite publishes is not appended once that
		// rewrite lands: it waits for the session's next append, flush or close, and a crash before then loses it.
		it("appends an entry recorded during a rename's fallback full rewrite once that rewrite lands", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			let gate!: GatedClient;
			const storage = await db.open({
				lease: STILL,
				// The size check that opens the swap of a full write, once its body is staged: the rewrite is publishing.
				wrap: client => (gate = holdBefore(client, /^SELECT byte_len FROM/)).client,
			});
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("mine before the rename"));
			await manager.setSessionName("the first name", "user");
			await manager.flush();
			const failures: string[] = [];
			manager.onPersistenceError(error => failures.push(error.message));
			// Closed once the rename's own entry has landed, so the fallback rewrite is the write it holds.
			const closed = Promise.withResolvers<void>();
			failTitleSlotOnce(storage, file, () => {
				gate.close();
				closed.resolve();
			});
			const writes = recordFullWrites(storage, file);

			const rename = manager.setSessionName("the second name", "user").then(
				renamed => ({ renamed }),
				(err: unknown) => ({ rejected: String(err) }),
			);
			await closed.promise;
			await gate.paused();
			manager.appendMessage(userTurn("recorded during the rename"));
			gate.open();
			const outcome = await rename;
			// What the store holds once its own queued writes land, before any later write of the session.
			await storage.confirmWrites(file);
			const withTheRename = (await db.row(file))?.content ?? "";

			expect({
				outcome,
				failures,
				notices,
				writes: writes.length,
				landedWithTheRename: ["the second name", "recorded during the rename"].map(text =>
					withTheRename.includes(text),
				),
			}).toEqual({
				outcome: { renamed: true },
				failures: [],
				notices: [],
				writes: 1,
				landedWithTheRename: [true, true],
			});
			await manager.close();
		});

		it("moves a second manager of this process off a journal another manager here writes, as file storage does", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open();
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			const first = await resume(storage, file);
			const second = await resume(storage, file);

			first.manager.appendMessage(userTurn("from the first"));
			await first.manager.flush();
			second.manager.appendMessage(userTurn("from the second"));
			await second.manager.flush();

			const moved = second.manager.getSessionFile() ?? "";
			expect({
				first: first.manager.getSessionFile(),
				secondMoved: moved !== file,
				reasons: [...first.notices, ...second.notices].map(notice => notice.reason),
			}).toEqual({ first: file, secondMoved: true, reasons: ["open-elsewhere"] });
			const content = (await db.row(file))?.content ?? "";
			expect([content.includes("from the first"), content.includes("from the second")]).toEqual([true, false]);
			expect((await db.row(moved))?.content).toContain("from the second");
			await first.manager.close();
			await second.manager.close();
		});
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`SessionManager lease rows (${adapter})`, () => {
		it("keeps its session through a stall past the expiry that no other holder used", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const proxy = TcpProxy.for(url ?? "");
			try {
				const storage = await db.open({ dsn: proxy.urlFor(url ?? ""), lease: SHORT });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				const { manager, notices } = await resume(storage, file);

				proxy.freeze();
				await Bun.sleep(SHORT.expiryMs + 1500);
				manager.appendMessage(userTurn("written during the stall"));
				proxy.thaw();
				await manager.flush();

				expect([manager.getSessionId(), manager.getSessionFile(), notices]).toEqual([ID, file, []]);
				expect(storage.sessionClaimLost?.(ID)).toBe(false);
				expect((await db.row(file))?.content).toContain("written during the stall");
				await manager.close();
			} finally {
				proxy.stop();
			}
		}, 30_000);

		it("moves off at once when the stall let another holder take the session, writing its paused entry there", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const proxy = TcpProxy.for(url ?? "");
			try {
				const storage = await db.open({ dsn: proxy.urlFor(url ?? ""), lease: SHORT });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				const { manager, notices } = await resume(storage, file);
				await manager.flush();
				const before = await db.row(file);

				proxy.freeze();
				await Bun.sleep(SHORT.expiryMs + 1500);
				const next = await db.open({ lease: SHORT });
				const releaseNext = await next.acquireSessionClaim?.(ID, file);
				expect(releaseNext).toBeFunction();
				manager.appendMessage(userTurn("paused by the stall"));
				proxy.thaw();
				await until(() => manager.getSessionId() !== ID);
				await manager.flush();

				const sibling = manager.getSessionFile() ?? "";
				expect(notices).toEqual([{ reason: "open-elsewhere", from: file, to: sibling }]);
				expect((await db.row(sibling))?.content).toContain("paused by the stall");
				expect(await db.row(file)).toEqual(before);
				await manager.close();
				releaseNext?.();
			} finally {
				proxy.stop();
			}
		}, 30_000);

		it("moves off without a write as soon as a heartbeat finds another holder", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: SHORT });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			const { manager, notices } = await resume(storage, file);
			await manager.flush();
			const before = await db.row(file);

			await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [ID]);
			await until(() => manager.getSessionId() !== ID, 5000);

			expect(notices).toEqual([{ reason: "open-elsewhere", from: file, to: manager.getSessionFile() ?? "" }]);
			expect(await db.row(file)).toEqual(before);
			await manager.close();
		}, 30_000);

		it("counts its lease row gone after a stall as lost: it moves off, and X holds the other holder's turns", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const proxy = TcpProxy.for(url ?? "");
			try {
				const storage = await db.open({ dsn: proxy.urlFor(url ?? ""), lease: SHORT });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				const { manager, notices } = await resume(storage, file);
				await manager.flush();

				// A pauses past the expiry; B resumes X, writes two turns and exits, releasing the row.
				proxy.freeze();
				await Bun.sleep(SHORT.expiryMs + 500);
				manager.appendMessage(userTurn("A's entry from the pause"));
				const b = await resume(await db.open({ lease: SHORT }), file);
				expect(b.manager.getSessionId()).toBe(ID);
				b.manager.appendMessage(userTurn("B's first turn"));
				b.manager.appendMessage(userTurn("B's second turn"));
				await b.manager.close();
				expect(await db.leases(ID)).toEqual([]);
				proxy.thaw();
				await until(() => manager.getSessionId() !== ID);
				await manager.flush();

				const sibling = manager.getSessionFile() ?? "";
				expect(notices).toEqual([{ reason: "open-elsewhere", from: file, to: sibling }]);
				expect((await db.row(sibling))?.content).toContain("A's entry from the pause");
				// X's next load holds B's turns on its branch, and nothing of A's after the pause.
				const reloaded = await SessionManager.open(file, path.dirname(file), await db.open({ claims: false }), {
					suppressBreadcrumb: true,
				});
				const branch = reloaded
					.getBranch()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
					);
				expect(branch).toEqual(["before", "B's first turn", "B's second turn"]);
				await manager.close();
			} finally {
				proxy.stop();
			}
		}, 30_000);

		it("pauses its writes through a 25 s outage past its self-fence, then claims again, writes what it kept and keeps its id", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const proxy = TcpProxy.for(url ?? "");
			try {
				// The real timings: a 30 s expiry, a 10 s heartbeat, a 20 s self-fence.
				const storage = await db.open({ dsn: proxy.urlFor(url ?? ""), lease: undefined });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				const { manager, notices } = await resume(storage, file);
				await manager.flush();
				const before = await db.row(file);

				proxy.freeze();
				await Bun.sleep(21_000);
				manager.appendMessage(userTurn("kept through the outage"));
				await Bun.sleep(4000);
				// Nothing was written during the outage.
				expect(await db.row(file)).toEqual(before);
				proxy.thaw();
				await manager.flush();

				expect({ id: manager.getSessionId(), file: manager.getSessionFile(), notices }).toEqual({
					id: ID,
					file,
					notices: [],
				});
				expect((await db.row(file))?.content).toContain("kept through the outage");
				await manager.close();
			} finally {
				proxy.stop();
			}
		}, 60_000);

		it("fences itself on a frozen network: past its self-fence it sends no write at all", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const proxy = TcpProxy.for(url ?? "");
			try {
				const storage = await db.open({ dsn: proxy.urlFor(url ?? ""), lease: SHORT });
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				const { manager, notices } = await resume(storage, file);
				await manager.flush();

				proxy.freeze();
				// Past the self-fence (the expiry less one heartbeat) and inside the expiry.
				await Bun.sleep(SHORT.expiryMs - SHORT.heartbeatMs + 300);
				const queued = proxy.queuedToUpstreamBytes();
				manager.appendMessage(userTurn("held back by the self-fence"));
				await Bun.sleep(400);
				const sent = proxy.queuedToUpstreamBytes() - queued;
				proxy.thaw();
				await manager.flush();

				expect({ sent, id: manager.getSessionId(), notices }).toEqual({ sent: 0, id: ID, notices: [] });
				expect((await db.row(file))?.content).toContain("held back by the self-fence");
				await manager.close();
			} finally {
				proxy.stop();
			}
		}, 30_000);

		it("writes an entry the fence refused in a sibling, and nothing more in the session taken over", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("kept in the session"));
			await manager.flush();
			const before = await db.row(file);
			await db.ageLease(ID, STILL.expiryMs + 60_000);
			const next = await db.open({ lease: STILL });
			const releaseNext = await next.acquireSessionClaim?.(ID, file);
			expect(releaseNext).toBeFunction();

			manager.appendMessage(userTurn("refused by the fence"));
			await until(() => manager.getSessionId() !== ID);
			await manager.flush();

			const sibling = manager.getSessionFile() ?? "";
			expect(notices).toEqual([{ reason: "open-elsewhere", from: file, to: sibling }]);
			const moved = (await db.row(sibling))?.content ?? "";
			expect([moved.includes("kept in the session"), moved.includes("refused by the fence")]).toEqual([true, true]);
			// The sibling is a fork: it names the session it left, and nothing points a resume of it here.
			const header = JSON.parse(
				moved.slice(moved.indexOf('{"type":"session"'), moved.indexOf("\n", moved.indexOf('{"type":"session"'))),
			);
			expect({ parentSession: header.parentSession, continuationOf: header.continuationOf }).toEqual({
				parentSession: ID,
				continuationOf: undefined,
			});
			expect(await db.row(file)).toEqual(before);
			await manager.close();
			releaseNext?.();
		});

		it("reads the session again after an acquire when another holder wrote it since the open", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
			// Between the open and the acquire, another holder writes a turn and lets go.
			const other = await db.open({ lease: STILL });
			const releaseOther = await other.acquireSessionClaim?.(ID, file);
			expect(releaseOther).toBeFunction();
			const writer = other.openWriter(file);
			await writer.append(
				`${JSON.stringify({ type: "message", id: "o1", parentId: "m1", timestamp: "2026-11-17T00:00:01.000Z", message: userTurn("from the other holder") })}\n`,
			);
			await writer.close();
			releaseOther?.();
			await other.drain();
			await storage.refresh();

			await manager.claimOpenedSession();
			manager.appendMessage(userTurn("after the acquire"));
			await manager.flush();

			const content = (await db.row(file))?.content ?? "";
			const mine = content.split("\n").find(line => line.includes("after the acquire")) ?? "";
			expect({
				kept: content.includes("from the other holder"),
				onTheOthersTurn: JSON.parse(mine || "{}").parentId,
				ids: manager.getSessionId(),
			}).toEqual({ kept: true, onTheOthersTurn: "o1", ids: ID });
			await manager.close();
		});

		it("keeps reporting the session it had while a switch waits for another holder's lease", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: SHORT });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "held elsewhere"));
			await storage.drain();
			const holder = await db.open({ lease: SHORT });
			const releaseHolder = await holder.acquireSessionClaim?.(ID, file);
			expect(releaseHolder).toBeFunction();
			const manager = SessionManager.create(db.dir.path(), path.dirname(file), storage);
			const before = manager.getSessionId();
			// A listener, as an extension's heartbeat is, reads the id while the switch waits.
			const seen = new Set<string>();
			const listener = setInterval(() => seen.add(manager.getSessionId()), 20);
			let waited = false;
			const switched = manager.setSessionFile(file, { claim: { waitMs: 1500, onWait: () => (waited = true) } });
			await until(() => waited);
			await Bun.sleep(500);
			const duringWait = [...seen];
			await switched;
			clearInterval(listener);

			expect({ duringWait, after: manager.getSessionId() === ID }).toEqual({ duringWait: [before], after: false });
			releaseHolder?.();
			await manager.close();
		}, 30_000);

		it("claims a new session at its first write, so another store's open of it waits", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "sessions"), storage);
			manager.appendMessage(createAssistantMessage("first"));
			await manager.flush();
			const file = manager.getSessionFile() ?? "";
			const other = await db.open({ lease: STILL });

			expect(await other.acquireSessionClaim?.(manager.getSessionId(), file)).toBeNull();
			await manager.close();
		});

		it("keeps its claim through close's last publish, so nothing lands after another holder acquires the session", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			let gate: GatedClient | undefined;
			// Close's last publish is a full write, or an append past what storage holds (PostgreSQL's `WITH s AS (INSERT …`).
			const sessionRowWrite = new RegExp(`^(?:WITH s AS \\()?INSERT (IGNORE )?INTO (?:"[^"]+"\\.)?${db.table} \\(`);
			const storage = await db.open({
				lease: STILL,
				wrap: client => {
					gate = gatedClient(client, sessionRowWrite);
					return gate.client;
				},
			});
			if (!gate) throw new Error("expected a gated client");
			const manager = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "sessions"), storage);
			// The first publish is deferred and held open; an entry appended meanwhile is owed to close.
			gate.close();
			manager.appendMessage(createAssistantMessage("first"));
			await gate.paused();
			manager.appendMessage(userTurn("late entry"));
			const file = manager.getSessionFile() ?? "";
			const id = manager.getSessionId();
			manager.seal();
			const closing = manager.close();
			gate.open();
			gate.close();
			// Close's last publish has begun and holds its transaction open.
			await gate.paused();
			const other = await db.open({ lease: STILL });
			const acquired = other
				.acquireSessionClaim?.(id, file, { waitMs: 20_000 })
				.then(async release => ({ release, content: (await db.row(file))?.content ?? "" }));
			await Bun.sleep(500);
			gate.open();
			await closing;
			const taken = await acquired;
			const after = (await db.row(file))?.content ?? "";

			expect({
				acquired: typeof taken?.release,
				lateAtAcquire: taken?.content.includes("late entry"),
				changedAfterAcquire: after !== taken?.content,
			}).toEqual({ acquired: "function", lateAtAcquire: true, changedAfterAcquire: false });
			taken?.release?.();
		}, 60_000);

		it("refuses to rename a session another store holds, and creates no sibling", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = sessionFile(db);
			const holder = await db.open({ lease: STILL });
			await holder.writeText(file, transcript(ID, "before"));
			await holder.drain();
			const release = await holder.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			const before = await db.row(file);
			const previous = defaultSessionStorage();
			setDefaultSessionStorage(await db.open({ lease: STILL }));
			let renamed: string | null;
			try {
				renamed = await SessionManager.renameSessionTitle(file, "renamed elsewhere");
			} finally {
				setDefaultSessionStorage(previous);
			}

			expect({ renamed, paths: await db.paths(), unchanged: Bun.deepEquals(await db.row(file), before) }).toEqual({
				renamed: null,
				paths: [file],
				unchanged: true,
			});
			release?.();
		});

		it("refuses to delete a session another store holds, and keeps its rows", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = sessionFile(db);
			const holder = await db.open({ lease: STILL });
			await holder.writeText(file, transcript(ID, "before"));
			await holder.drain();
			const release = await holder.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			const before = await db.row(file);
			const other = SessionManager.create(db.dir.path(), path.dirname(file), await db.open({ lease: STILL }));

			const refused = await other.dropSession(file).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect({
				refused: refused instanceof Error && refused.message,
				paths: await db.paths(),
				unchanged: Bun.deepEquals(await db.row(file), before),
			}).toEqual({
				refused: `Cannot delete session "${file}": another live omp process writes it. Nothing was deleted.`,
				paths: [file],
				unchanged: true,
			});
			release?.();
		});
	});
}

/** What the exit recorder logs about its record: that it was recorded, or that it failed. */
const EXIT_RECORD_LOGS: Record<string, true> = { "Session exit recorded": true, "Failed to record session exit": true };

/** Spy on the logger and return what it logged of {@link EXIT_RECORD_LOGS}. */
function exitRecordLogs(): () => string[] {
	const spies = [spyOn(logger, "debug"), spyOn(logger, "warn"), spyOn(logger, "error")];
	return () =>
		spies
			.flatMap(spy => spy.mock.calls.map(call => call[0]))
			.filter(message => Object.hasOwn(EXIT_RECORD_LOGS, message));
}

/** An agent session on `manager`: it registers the exit recorder, which a cleanup pass (a signal's) runs. */
function agentSessionOn(manager: SessionManager): AgentSession {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] }, convertToLlm }),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`the exit record of a session another holder took over (${adapter})`, () => {
		const exclusive = process.env.OMP_SESSION_EXCLUSIVE;

		afterEach(() => {
			if (exclusive === undefined) delete process.env.OMP_SESSION_EXCLUSIVE;
			else process.env.OMP_SESSION_EXCLUSIVE = exclusive;
			vi.restoreAllMocks();
		});

		/**
		 * A resumed session with a reply, wrapped in an agent session, whose
		 * lease another store then takes over: the fence refuses its next write.
		 */
		async function takenOver(db: LeaseDb): Promise<{ session: AgentSession; file: string; release?: () => void }> {
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			const { manager } = await resume(storage, file);
			// The recorder writes a record only for a session that holds a reply.
			manager.appendMessage(createAssistantMessage("done"));
			const session = agentSessionOn(manager);
			await manager.flush();
			await db.ageLease(ID, STILL.expiryMs + 60_000);
			const release = await (await db.open({ lease: STILL })).acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			return { session, file, release: release ?? undefined };
		}

		it("with OMP_SESSION_EXCLUSIVE=1, logs the record as failed when the fence refused it and the session stopped", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { session, file, release } = await takenOver(db);
			const exits: unknown[] = [];
			// The stop ends the process; here it only records that it would.
			spyOn(process, "exit").mockImplementation(code => {
				exits.push(code);
				return undefined as never;
			});
			const logs = exitRecordLogs();
			process.env.OMP_SESSION_EXCLUSIVE = "1";

			// The pass a signal runs before the process ends: it runs the exit recorder.
			await postmortem.cleanup();
			await until(() => exits.length > 0);

			expect({
				logs: logs(),
				exits,
				inFile: ((await db.row(file))?.content ?? "").includes(SESSION_EXIT_CUSTOM_TYPE),
				paths: await db.paths(),
			}).toEqual({ logs: ["Failed to record session exit"], exits: [1], inFile: false, paths: [file] });
			// After the stop, close rejects with it while storage lacks an entry: here the record whose refused write
			// stopped the session.
			await expect(session.dispose()).rejects.toBeInstanceOf(SessionExclusiveStopError);
			release?.();
		}, 30_000);

		it("without OMP_SESSION_EXCLUSIVE, logs the record as recorded once the sibling the session moved to holds it", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { session, file, release } = await takenOver(db);
			const logs = exitRecordLogs();
			delete process.env.OMP_SESSION_EXCLUSIVE;

			await postmortem.cleanup();

			const siblings = (await db.paths()).filter(stored => stored !== file);
			expect({
				logs: logs(),
				siblings: siblings.length,
				inSibling: ((await db.row(siblings[0] ?? ""))?.content ?? "").includes(SESSION_EXIT_CUSTOM_TYPE),
			}).toEqual({ logs: ["Session exit recorded"], siblings: 1, inSibling: true });
			await session.dispose();
			release?.();
		}, 30_000);
	});
}
