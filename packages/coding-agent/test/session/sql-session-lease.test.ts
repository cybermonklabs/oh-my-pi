/**
 * `SqlSessionStorage` session claims at the storage level: who may claim a
 * session, the database fence on every content write, the heartbeat that
 * keeps a claim and the self-fence that pauses writes when it cannot be
 * confirmed. PostgreSQL and MySQL claim with a lease row in the lease table;
 * a SQLite file database with an OS lock the kernel drops when its process
 * dies. Each runs against SQLite always and against PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionLeaseLostError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SESSION_OPEN_CLAIM_WAIT_MS,
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import {
	type GatedClient,
	gatedClient,
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	type LeaseProcessConfig,
	MYSQL57_URL,
	MYSQL_ROT_URL,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	rejection,
	transcript,
	until,
} from "./sql-session-lease-fixture";

// These tests wait in real time on purpose: a lease expires and a heartbeat
// runs on the database clock and the store's own interval timer, across
// processes, which no fake timer reaches. The timings below keep each wait short.

const ID = "01a1f000-0000-7000-8000-000000000001";
const OTHER_ID = "01a1f000-0000-7000-8000-000000000002";
/** Short timings so a test sees a heartbeat and an expiry in seconds. */
const SHORT = { expiryMs: 3000, heartbeatMs: 500 };
/** Timings under which a test's own changes to a lease row are never refreshed away by a heartbeat. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
/** How far past its wait a claim behind a stalled lock may answer: the lock bound and a little room. */
const LOCK_SLACK_MS = 3500;

/**
 * Session {@link ID} claimed by a store whose next write stalls inside its
 * transaction, right after its fence share-locked the lease row, until
 * `holdMs` passed or `finish()` runs; with `stale`, the lease was aged past
 * its expiry first, so the holder looks dead to the database clock.
 */
async function stallHolderInsideAWrite(
	db: LeaseDb,
	options: { stale: boolean; holdMs: number },
): Promise<{ inside(): boolean; finish(): Promise<void> }> {
	let gate: GatedClient | undefined;
	const fence = new RegExp(`FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder = `);
	const holder = await db.open({
		lease: STILL,
		wrap: client => {
			gate = gatedClient(client, fence);
			return gate.client;
		},
	});
	if (!gate) throw new Error("the holder's client was not gated");
	const file = sessionFile(db);
	const release = await holder.acquireSessionClaim?.(ID, file);
	await holder.writeText(file, transcript(ID, "before"));
	await holder.drain();
	if (options.stale) await db.ageLease(ID, STILL.expiryMs + 60_000);
	gate.close();
	const started = performance.now();
	const written = holder.writeText(file, transcript(ID, "in flight")).catch((err: unknown) => err);
	await gate.paused();
	const timer = setTimeout(() => gate?.open(), options.holdMs);
	return {
		inside: () => performance.now() - started < options.holdMs,
		async finish() {
			clearTimeout(timer);
			gate?.open();
			await written;
			release?.();
			await holder.drain().catch(() => undefined);
		},
	};
}

function sessionFile(db: LeaseDb, id = ID): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${id}.jsonl`);
}

function processConfig(db: LeaseDb, lease = STILL): LeaseProcessConfig {
	return { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease };
}

/**
 * `client`, which answers the store's own fence statement with a held row
 * while `forging()` holds, as if that write's fence were gone: a write that
 * then lands proves its fence, not an earlier check, is what refuses it.
 */
function forgingFence(
	client: SqlSessionStorageClient,
	leaseTable: string,
	forging: () => boolean,
): SqlSessionStorageClient {
	const fence = new RegExp(`^SELECT holder FROM (?:"[^"]+"\\.)?${leaseTable} WHERE session_id = .* AND holder = `);
	const forged = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		unsafe: (query, values) =>
			forging() && fence.test(query) ? Promise.resolve([{ holder: "forged" }]) : executor.unsafe(query, values),
	});
	return {
		options: client.options,
		unsafe: forged(client).unsafe,
		transaction: callback => client.transaction(transaction => callback(forged(transaction))),
		end: () => client.end?.() ?? Promise.resolve(),
	};
}

/** One backend write method, run on the claimed path `file`; `other` is the unclaimed path a rename uses. */
interface FencedWrite {
	name: string;
	/** Whether `other` must hold a session first (a rename onto the claimed path). */
	otherSession?: true;
	/** The path the refusal names, when it is not `file` (a write under the session's artifacts directory). */
	refused?(file: string): string;
	run(storage: SqlSessionStorage, file: string, other: string): Promise<unknown>;
}

const FENCED_WRITES: readonly FencedWrite[] = [
	{
		name: "append",
		async run(storage, file) {
			const writer = storage.openWriter(file);
			try {
				await writer.append('{"type":"late"}\n');
			} finally {
				await writer.close().catch(() => undefined);
			}
		},
	},
	{ name: "writeFull", run: (storage, file) => storage.writeText(file, "replaced\n") },
	{
		name: "truncate",
		async run(storage, file) {
			const writer = storage.openWriter(file, { flags: "w" });
			try {
				await writer.flush();
			} finally {
				await writer.close().catch(() => undefined);
			}
		},
	},
	{
		name: "updateSessionTitle",
		run: (storage, file) =>
			storage.updateSessionTitle(file, { title: "renamed", source: "user", updatedAt: "2026-11-17" }),
	},
	{ name: "remove", run: (storage, file) => storage.unlink(file) },
	{ name: "move (source)", run: (storage, file, other) => storage.rename(file, other) },
	{ name: "move (destination)", otherSession: true, run: (storage, file, other) => storage.rename(other, file) },
	{
		name: "a marker write (the draft-only marker in the session's artifacts directory)",
		refused: markerOf,
		run: (storage, file) => storage.writeText(markerOf(file), ""),
	},
];

/** The draft-only session marker `SessionManager` writes under `file`'s artifacts directory. */
function markerOf(file: string): string {
	return path.join(file.slice(0, -".jsonl".length), ".draft-only-session");
}

/** The stored rows a fenced write may change: the session, the other session a rename uses, and the marker. */
async function watchedRows(db: LeaseDb, file: string, other: string) {
	return [await db.row(file), await db.row(other), await db.row(markerOf(file))];
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage session claims (${adapter})`, () => {
		it("claims only when asked to, and never on an in-memory SQLite database", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const claiming = await db.open();
			expect([typeof claiming.claimSession, typeof claiming.acquireSessionClaim]).toEqual(["function", "function"]);
			// An SDK caller's store, which passes no `claims`, claims nothing, as before.
			const plain = await db.open({ claims: false });
			expect([plain.claimSession, plain.acquireSessionClaim, plain.sessionClaimLost]).toEqual([
				undefined,
				undefined,
				undefined,
			]);
			if (adapter === "sqlite") {
				const client = new SQL("sqlite::memory:");
				try {
					const memory = await SqlSessionStorage.create({ client, claims: true });
					expect([memory.claimSession, memory.acquireSessionClaim]).toEqual([undefined, undefined]);
				} finally {
					await client.end();
				}
			}
		});

		it("refuses a session another process holds, and gives it up when released", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open();
			const file = sessionFile(db);
			await using other = await LeaseProcess.start(processConfig(db), db.dir.join("home"));
			expect((await other.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);

			expect(await storage.acquireSessionClaim?.(ID, file)).toBeNull();
			await other.run({ op: "release", sessionId: ID });
			const release = await storage.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			release?.();
		}, 30_000);

		it("does not claim a session at a path that now holds another session", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open();
			const file = sessionFile(db);
			await storage.writeText(file, transcript(OTHER_ID, "another session moved here"));

			expect(await storage.acquireSessionClaim?.(ID, file)).toBeNull();
			const release = await storage.acquireSessionClaim?.(OTHER_ID, file);
			expect(release).toBeFunction();
			release?.();
		});

		it("counts the claims of one store: the session stays held until the last release", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open();
			const file = sessionFile(db);
			await using other = await LeaseProcess.start(processConfig(db), db.dir.join("home"));
			const first = await storage.acquireSessionClaim?.(ID, file);
			const second = await storage.acquireSessionClaim?.(ID, file);
			expect([first, second].map(release => typeof release)).toEqual(["function", "function"]);

			first?.();
			await storage.drain();
			expect((await other.run({ op: "claim", sessionId: ID, path: file })).held).toBe(false);
			second?.();
			await storage.drain();
			if (adapter !== "sqlite") expect(await db.leases(ID)).toEqual([]);
			expect((await other.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);
		}, 30_000);

		it("refuses a claim while the holder lives, and after it is killed only once its lease expired", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: SHORT });
			const file = sessionFile(db);
			const holder = await LeaseProcess.start(processConfig(db, SHORT), db.dir.join("home"));
			await using _holder = holder;
			expect((await holder.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);
			// Past one expiry, the live holder's heartbeats keep the session its own.
			await Bun.sleep(SHORT.expiryMs + 500);
			expect(await storage.acquireSessionClaim?.(ID, file)).toBeNull();

			await holder.kill();
			if (adapter === "sqlite") {
				// The kernel dropped the dead holder's lock.
				const release = await storage.acquireSessionClaim?.(ID, file);
				expect(release).toBeFunction();
				release?.();
				return;
			}
			expect(await storage.acquireSessionClaim?.(ID, file)).toBeNull();
			const [refusedAt] = await db.leases(ID);
			expect(refusedAt?.ageMs).toBeLessThan(SHORT.expiryMs);
			await until(async () => ((await db.leases(ID))[0]?.ageMs ?? 0) > SHORT.expiryMs + 250);
			const release = await storage.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			expect((await db.leases(ID))[0]?.pid).toBe(process.pid);
			release?.();
		}, 30_000);

		it.skipIf(adapter !== "sqlite")(
			"refuses a claim through another spelling of the database file while another process holds the session",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const file = sessionFile(db);
				await using holder = await LeaseProcess.start(processConfig(db), db.dir.join("home"));
				expect((await holder.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);
				const alias = db.dir.join("alias.db");
				fs.symlinkSync(db.dir.join("sessions.db"), alias);
				const throughAlias = await db.open({ dsn: `sqlite://${alias}` });

				expect(await throughAlias.acquireSessionClaim?.(ID, file)).toBeNull();
			},
			30_000,
		);

		it.skipIf(adapter !== "sqlite")(
			"lets two stores of one process that reach one new database through two spellings take turns, without a busy-timeout stall",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				// A database file that does not exist yet, opened first through a symlink to it.
				const target = db.dir.join("fresh.db");
				const alias = db.dir.join("fresh-alias.db");
				fs.symlinkSync(target, alias);
				const throughAlias = await db.open({ dsn: `sqlite://${alias}`, claims: false });
				const direct = await db.open({ dsn: `sqlite://${target}`, claims: false });

				const started = performance.now();
				const writes: Promise<void>[] = [];
				for (let n = 0; n < 8; n++) {
					writes.push(throughAlias.writeText(db.dir.join(`alias-${n}.jsonl`), transcript(ID, `alias ${n}`)));
					writes.push(direct.writeText(db.dir.join(`direct-${n}.jsonl`), transcript(OTHER_ID, `direct ${n}`)));
				}
				const outcomes = await Promise.allSettled(writes);

				expect({
					failed: outcomes.filter(outcome => outcome.status === "rejected").length,
					stalled: performance.now() - started > 3000,
				}).toEqual({ failed: 0, stalled: false });
			},
			60_000,
		);
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage lease rows (${adapter})`, () => {
		for (const write of FENCED_WRITES) {
			for (const forged of [false, true]) {
				it(
					forged
						? `lets ${write.name} land when only its own fence's answer is forged: its fence is what refuses it`
						: `refuses ${write.name} at its own fence once another holder took the session over, changing nothing`,
					async () => {
						await using db = await openLeaseDb(adapter, url ?? "");
						let forging = false;
						const storage = await db.open({
							lease: STILL,
							wrap: client => forgingFence(client, db.leaseTable, () => forging),
						});
						const file = sessionFile(db);
						const other = sessionFile(db, OTHER_ID);
						const release = await storage.acquireSessionClaim?.(ID, file);
						expect(release).toBeFunction();
						await storage.writeText(file, transcript(ID, "owner"));
						if (write.otherSession) await storage.writeText(other, transcript(OTHER_ID, "unclaimed"));
						await storage.drain();
						// The session changes hands behind this store's back: it still believes it holds it,
						// so this write, not an earlier one, is the first to meet the loss.
						await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [ID]);
						const before = await watchedRows(db, file, other);
						expect(storage.sessionClaimLost?.(ID)).toBe(false);

						forging = forged;
						const outcome = await write.run(storage, file, other).then(
							() => undefined,
							(err: unknown) => err,
						);
						forging = false;
						const after = await watchedRows(db, file, other);
						if (forged) {
							expect({ outcome, changed: !Bun.deepEquals(after, before) }).toEqual({
								outcome: undefined,
								changed: true,
							});
						} else {
							expect(outcome).toBeInstanceOf(SessionLeaseLostError);
							expect(outcome).toMatchObject({ path: write.refused?.(file) ?? file, sessionId: ID });
							expect({ lost: storage.sessionClaimLost?.(ID), unchanged: Bun.deepEquals(after, before) }).toEqual(
								{
									lost: true,
									unchanged: true,
								},
							);
						}
						release?.();
					},
				);
			}
		}

		/**
		 * The row below waits on no lock. The write is held before its fence (a
		 * held claim's fence takes no lock before its read), so the taker's claim
		 * meets no lock of the write, and the fence then reads the row the taker
		 * committed; each of these statements took under 50 ms. The row's time
		 * is two store start-ups, its writes and the tables' drop: at most 0.8 s
		 * (median 0.3 s) in 90 runs with two trees on one server at a load
		 * average of 200-385 on 288 cores, and at most 2.4 s in 40 runs beside
		 * another tree's whole lease file at 312-474. Two of the reviewer's runs
		 * under parallel load went past bun's 5 s default (MySQL, move), so the
		 * margin is taken from those: 16 s, over three times 5 s.
		 */
		const TAKEOVER_MID_WRITE_TIMEOUT_MS = 16_000;
		for (const write of FENCED_WRITES) {
			it(
				`refuses ${write.name} when a takeover commits while the write is open, before its fence, and changes nothing`,
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					let gate: GatedClient | undefined;
					const fence = new RegExp(
						`^SELECT holder FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder = `,
					);
					const owner = await db.open({
						lease: STILL,
						wrap: client => {
							gate = gatedClient(client, fence, "before");
							return gate.client;
						},
					});
					if (!gate) throw new Error("expected a gated client");
					const file = sessionFile(db);
					const other = sessionFile(db, OTHER_ID);
					const release = await owner.acquireSessionClaim?.(ID, file);
					expect(release).toBeFunction();
					await owner.writeText(file, transcript(ID, "owner"));
					if (write.otherSession) await owner.writeText(other, transcript(OTHER_ID, "unclaimed"));
					await owner.drain();
					await db.ageLease(ID, STILL.expiryMs + 60_000);
					const before = await watchedRows(db, file, other);

					// The write's transaction is open and has not reached its fence.
					gate.close();
					const outcome = write.run(owner, file, other).then(
						() => undefined,
						(err: unknown) => err,
					);
					await gate.paused();
					// Another holder takes the session over, and commits, while the write waits.
					const taker = await db.open({ lease: STILL });
					const releaseTaker = await taker.acquireSessionClaim?.(ID, file);
					expect(releaseTaker).toBeFunction();
					gate.open();

					expect(await outcome).toBeInstanceOf(SessionLeaseLostError);
					expect(Bun.deepEquals(await watchedRows(db, file, other), before)).toBe(true);
					release?.();
					releaseTaker?.();
				},
				TAKEOVER_MID_WRITE_TIMEOUT_MS,
			);

			it(`makes a takeover wait for ${write.name} once its fence ran, so the new holder sees it`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				let gate: GatedClient | undefined;
				const fence = new RegExp(
					`^SELECT holder FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder = `,
				);
				const owner = await db.open({
					lease: STILL,
					wrap: client => {
						gate = gatedClient(client, fence);
						return gate.client;
					},
				});
				if (!gate) throw new Error("expected a gated client");
				const file = sessionFile(db);
				const other = sessionFile(db, OTHER_ID);
				const release = await owner.acquireSessionClaim?.(ID, file);
				expect(release).toBeFunction();
				await owner.writeText(file, transcript(ID, "owner"));
				if (write.otherSession) await owner.writeText(other, transcript(OTHER_ID, "unclaimed"));
				await owner.drain();
				await db.ageLease(ID, STILL.expiryMs + 60_000);

				// The write checked its lease and holds its transaction open.
				gate.close();
				const written = write.run(owner, file, other).then(
					() => undefined,
					(err: unknown) => err,
				);
				await gate.paused();
				const taker = await db.open({ lease: STILL });
				let settled = false;
				const takeover = (taker.acquireSessionClaim?.(ID, file) ?? Promise.resolve(null)).finally(() => {
					settled = true;
				});
				await Bun.sleep(1500);
				const takenBeforeCommit = settled;
				gate.open();
				const outcome = await written;
				const releaseTaker = await takeover;

				expect({ takenBeforeCommit, outcome, taken: typeof releaseTaker }).toEqual({
					takenBeforeCommit: false,
					outcome: undefined,
					taken: "function",
				});
				release?.();
				releaseTaker?.();
			}, 30_000);
		}

		it("makes a takeover wait for a fenced write in flight, so the new holder sees that write", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			let gate: GatedClient | undefined;
			const fence = new RegExp(`FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder = `);
			const owner = await db.open({
				lease: STILL,
				wrap: client => {
					gate = gatedClient(client, fence);
					return gate.client;
				},
			});
			if (!gate) throw new Error("expected a gated client");
			const file = sessionFile(db);
			const release = await owner.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			await owner.writeText(file, transcript(ID, "before"));
			await db.ageLease(ID, STILL.expiryMs + 60_000);
			await using next = await LeaseProcess.start(processConfig(db), db.dir.join("home"));

			// The owner's write has checked its lease and holds its transaction open.
			gate.close();
			const written = owner.writeText(file, `${transcript(ID, "before")}{"type":"from-owner"}\n`);
			await gate.paused();
			let settled = false;
			const takeover = next.run({ op: "claim", sessionId: ID, path: file, read: true }).finally(() => {
				settled = true;
			});
			await Bun.sleep(1500);
			const takenBeforeCommit = settled;
			gate.open();
			await written;

			const taken = await takeover;
			expect({ takenBeforeCommit, held: taken.held, sawOwnersWrite: taken.content?.includes("from-owner") }).toEqual(
				{
					takenBeforeCommit: false,
					held: true,
					sawOwnersWrite: true,
				},
			);
			release?.();
		}, 30_000);

		it("ends a claim's validity at its heartbeat's send time plus the self-fence, however late the answer", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const lease = { expiryMs: 4000, heartbeatMs: 500 };
			const validityMs = lease.expiryMs - lease.heartbeatMs;
			const answerDelayMs = 5000;
			let delaying = false;
			const heartbeat = new RegExp(`^UPDATE (?:"[^"]+"\\.)?${db.leaseTable} SET heartbeat_at`);
			// The heartbeat reaches the database at once; only its answer is late.
			const lateAnswers = (client: SqlSessionStorageClient): SqlSessionStorageClient => {
				const late = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
					async unsafe(query, values) {
						const delay = delaying && heartbeat.test(query);
						const result = await executor.unsafe(query, values);
						if (delay) await Bun.sleep(answerDelayMs);
						return result;
					},
				});
				return {
					options: client.options,
					unsafe: late(client).unsafe,
					transaction: callback => client.transaction(transaction => callback(late(transaction))),
					end: () => client.end?.() ?? Promise.resolve(),
				};
			};
			const storage = await db.open({ lease, wrap: lateAnswers });
			const first = sessionFile(db);
			const second = sessionFile(db, OTHER_ID);
			const releases = [
				await storage.acquireSessionClaim?.(ID, first),
				await storage.acquireSessionClaim?.(OTHER_ID, second),
			];
			await storage.writeText(first, transcript(ID, "one"));
			await storage.writeText(second, transcript(OTHER_ID, "two"));
			await Bun.sleep(lease.heartbeatMs * 3);

			const t0 = Date.now();
			delaying = true;
			// Within the validity the last answered heartbeat gave, a write goes out at once.
			await storage.writeText(first, transcript(ID, "early"));
			expect(Date.now() - t0).toBeLessThan(1000);

			// Every heartbeat sent from t0 on is answered 5 s late, so validity ends by t0 + 3.5 s + 0.5 s.
			await Bun.sleep(t0 + validityMs + lease.heartbeatMs + 200 - Date.now());
			const late = storage.writeText(second, transcript(OTHER_ID, "late"));
			// By now a heartbeat sent after t0 has been answered; its answer did not extend the validity.
			await Bun.sleep(t0 + lease.heartbeatMs + answerDelayMs + 1000 - Date.now());
			expect((await db.row(second))?.content).not.toContain("late");
			delaying = false;
			await late;
			expect((await db.row(second))?.content).toContain("late");
			for (const release of releases) release?.();
		}, 30_000);

		it("keeps its claim when its own heartbeat's answer is slow: the heartbeat holds no row lock a write's fence waits for", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const lease = { expiryMs: 20_000, heartbeatMs: 500 };
			const answerDelayMs = 4000;
			let delaying = false;
			const heartbeat = new RegExp(`UPDATE (?:"[^"]+"\\.)?${db.leaseTable} SET heartbeat_at`);
			// Each heartbeat reaches the database at once; its answer comes back 4 s later, as on a slow network.
			const slowAnswers = (client: SqlSessionStorageClient): SqlSessionStorageClient => {
				const slow = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
					async unsafe(query, values) {
						const delay = delaying && heartbeat.test(query);
						const result = await executor.unsafe(query, values);
						if (delay) await Bun.sleep(answerDelayMs);
						return result;
					},
				});
				return {
					options: client.options,
					unsafe: slow(client).unsafe,
					transaction: callback => client.transaction(transaction => callback(slow(transaction))),
					end: () => client.end?.() ?? Promise.resolve(),
				};
			};
			const storage = await db.open({ lease, wrap: slowAnswers });
			const file = sessionFile(db);
			const release = await storage.acquireSessionClaim?.(ID, file);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			delaying = true;
			// A heartbeat is out, its answer still on the way back.
			await Bun.sleep(lease.heartbeatMs * 2);
			const outcome = await storage.writeText(file, transcript(ID, "during the slow answer")).then(
				() => "written",
				(err: unknown) => String(err),
			);
			delaying = false;
			expect({ outcome, lost: storage.sessionClaimLost?.(ID) }).toEqual({ outcome: "written", lost: false });
			expect((await db.row(file))?.content).toBe(transcript(ID, "during the slow answer"));
			release?.();
		}, 30_000);

		it.skipIf(adapter !== "postgres")(
			"refreshes its lease through a connection another client of a pool left read-only",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const lease = { expiryMs: 20_000, heartbeatMs: 300 };
				// One connection, so the session-level setting below is the one every statement meets.
				const single = new SQL(db.dsn, { max: 1 });
				const storage = await db.open({
					lease,
					wrap: client => {
						void client.end?.();
						return single as unknown as SqlSessionStorageClient;
					},
				});
				const file = sessionFile(db);
				const release = await storage.acquireSessionClaim?.(ID, file);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.drain();
				// As a pooled server connection another client set read-only and never reset.
				await single.unsafe("SET default_transaction_read_only = on");
				await Bun.sleep(lease.heartbeatMs * 5);
				const [refreshed] = await db.leases(ID);
				expect({
					refreshedWithin: (refreshed?.ageMs ?? Number.POSITIVE_INFINITY) < lease.heartbeatMs * 3,
					lost: storage.sessionClaimLost?.(ID),
				}).toEqual({ refreshedWithin: true, lost: false });
				release?.();
				await storage.drain();
				await single.end();
			},
			30_000,
		);

		it.skipIf(adapter !== "postgres")(
			"keeps the connection's own lock_timeout for the rest of a write after its fence",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				// One connection with a session-level lock_timeout of 1 s, as an SDK caller may set.
				const single = new SQL(db.dsn, { max: 1 });
				await single.unsafe("SET lock_timeout = '1s'");
				const storage = await db.open({
					lease: STILL,
					wrap: client => {
						void client.end?.();
						return single as unknown as SqlSessionStorageClient;
					},
				});
				const file = sessionFile(db);
				const release = await storage.acquireSessionClaim?.(ID, file);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.drain();
				// Another client holds the session's row for 8 s; the write's fence passes, then its update waits.
				const locker = new SQL(db.dsn, { max: 1 });
				const { promise: locked, resolve: lockTaken } = Promise.withResolvers<void>();
				const { promise: unlock, resolve: letGo } = Promise.withResolvers<void>();
				const holding = locker.begin(async transaction => {
					await transaction.unsafe(`SELECT path FROM ${db.table} WHERE path = $1 FOR UPDATE`, [file]);
					lockTaken();
					await unlock;
				});
				await locked;
				const timer = setTimeout(letGo, 8000);
				const started = performance.now();
				const outcome = await storage.writeText(file, transcript(ID, "while the row is locked")).then(
					() => "written",
					(err: unknown) => String(err),
				);
				const elapsedMs = performance.now() - started;
				clearTimeout(timer);
				letGo();
				await holding;
				expect({ outcome, withinTheConnectionsTimeout: elapsedMs < 4000 }).toEqual({
					outcome: expect.stringContaining("lock timeout"),
					withinTheConnectionsTimeout: true,
				});
				release?.();
				await storage.drain().catch(() => undefined);
				await locker.end();
				await single.end();
			},
			30_000,
		);

		it("refuses a write to a session this store holds no claim on while another holder's lease of it is fresh", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const holder = await db.open({ lease: STILL });
			const file = sessionFile(db);
			// A subagent's transcript under the session's artifacts directory falls under its lease too.
			const artifact = path.join(path.dirname(file), path.basename(file, ".jsonl"), "agent-1.jsonl");
			const release = await holder.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			await holder.writeText(file, transcript(ID, "held"));
			await holder.drain();
			const before = await db.row(file);
			const other = await db.open({ lease: STILL });

			const refused = await Promise.all(
				[() => other.writeText(file, transcript(ID, "unclaimed")), () => other.writeText(artifact, "{}\n")].map(
					write => rejection(write()),
				),
			);
			expect(refused.map(err => err instanceof SessionLeaseLostError)).toEqual([true, true]);
			expect([await db.row(file), await db.row(artifact)]).toEqual([before, undefined]);
			release?.();
			await holder.drain();
			// Once the holder let go, the same write lands.
			await other.writeText(file, transcript(ID, "unclaimed"));
			expect((await db.row(file))?.content).toContain("unclaimed");
		});

		it("counts a lease row that is gone as lost, and writes nothing more under it", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: SHORT });
			const file = sessionFile(db);
			const release = await storage.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			await storage.writeText(file, transcript(ID, "held"));
			await storage.drain();
			const before = await db.row(file);
			// Another holder came, wrote and released: only a release deletes a row.
			await db.sql(`DELETE FROM ${db.leaseTable} WHERE session_id = @1`, [ID]);
			await until(() => storage.sessionClaimLost?.(ID) === true, 5000);

			expect(await rejection(storage.writeText(file, transcript(ID, "after")))).toBeInstanceOf(
				SessionLeaseLostError,
			);
			expect(await db.row(file)).toEqual(before);
			release?.();
		}, 30_000);

		it("refuses createTable: false without the lease table when it claims, and needs none when it does not", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			await db.open();
			await db.sql(`DROP TABLE ${db.leaseTable}`);
			const client = new SQL(db.dsn);
			try {
				const options = { client, table: db.table, leaseTable: db.leaseTable, createTable: false };
				const error = await rejection(SqlSessionStorage.create({ ...options, claims: true }));
				expect(String(error)).toContain(`no table ${db.leaseTable}`);
				expect(await SqlSessionStorage.create(options)).toBeInstanceOf(SqlSessionStorage);
			} finally {
				await client.end();
			}
		});

		it("gives up a release the database cannot finish within 2 s, and leaves the lease to expire", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			const release = await storage.acquireSessionClaim?.(ID, file);
			expect(release).toBeFunction();
			await storage.writeText(file, transcript(ID, "owner"));
			await storage.drain();
			const unlock = await db.lockLeaseRow(ID);
			let outcome: { drained: boolean; elapsedMs: number };
			try {
				const started = performance.now();
				release?.();
				const drained = await Promise.race([storage.drain().then(() => true), Bun.sleep(6000).then(() => false)]);
				outcome = { drained, elapsedMs: performance.now() - started };
			} finally {
				await unlock();
			}
			expect({ drained: outcome.drained, withinBound: outcome.elapsedMs < 3000 }).toEqual({
				drained: true,
				withinBound: true,
			});
			// The delete the database could not run was rolled back; the unrefreshed row expires on its own.
			expect((await db.leases(ID)).map(lease => lease.pid)).toEqual([process.pid]);
		}, 30_000);

		it("lets a released row whose delete gave up expire while the store holds another session, so another store claims it", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: SHORT });
			const file = sessionFile(db);
			const release = await storage.acquireSessionClaim?.(ID, file);
			const kept = await storage.acquireSessionClaim?.(OTHER_ID, sessionFile(db, OTHER_ID));
			await storage.writeText(file, transcript(ID, "owner"));
			await storage.drain();
			const unlock = await db.lockLeaseRow(ID);
			try {
				release?.();
				await storage.drain();
				// The store stops waiting shortly after the database's 2 s bound; hold the lock until that delete surely gave up.
				await Bun.sleep(1500);
			} finally {
				await unlock();
			}
			// The store goes on heartbeating the session it kept; the released row is left to expire.
			await Bun.sleep(SHORT.expiryMs * 2);
			const next = await db.open({ lease: SHORT });
			const taken = await next.acquireSessionClaim?.(ID, file);
			expect({
				taken: typeof taken,
				keptStillFresh: (await db.leases(OTHER_ID)).map(lease => lease.ageMs < SHORT.expiryMs),
			}).toEqual({ taken: "function", keptStillFresh: [true] });
			taken?.();
			kept?.();
		}, 30_000);

		for (const stale of [false, true]) {
			it(`refuses an acquire behind a holder stalled inside a write (its lease ${stale ? "stale" : "fresh"}) once the wait ends, never later and never as held`, async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const stalled = await stallHolderInsideAWrite(db, { stale, holdMs: 12_000 });
				try {
					const other = await db.open({ lease: STILL });
					const started = performance.now();
					const taken = await other.acquireSessionClaim?.(ID, sessionFile(db), { waitMs: 3000 });
					const elapsedMs = performance.now() - started;
					expect({
						taken: taken ?? null,
						withinWait: elapsedMs < 3000 + LOCK_SLACK_MS,
						holderStillInsideItsWrite: stalled.inside(),
					}).toEqual({ taken: null, withinWait: true, holderStillInsideItsWrite: true });
				} finally {
					await stalled.finish();
				}
			}, 60_000);
		}

		it("keeps an open's 35 s wait behind a holder stalled inside a write", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const stalled = await stallHolderInsideAWrite(db, {
				stale: false,
				holdMs: SESSION_OPEN_CLAIM_WAIT_MS + 10_000,
			});
			try {
				const other = await db.open({ lease: STILL });
				const started = performance.now();
				const taken = await other.acquireSessionClaim?.(ID, sessionFile(db), {
					waitMs: SESSION_OPEN_CLAIM_WAIT_MS,
				});
				const elapsedMs = performance.now() - started;
				expect({
					taken: taken ?? null,
					withinWait: elapsedMs < SESSION_OPEN_CLAIM_WAIT_MS + LOCK_SLACK_MS,
				}).toEqual({
					taken: null,
					withinWait: true,
				});
			} finally {
				await stalled.finish();
			}
		}, 90_000);

		it("makes a claim wait for a write in flight from a store that holds no claim on the session", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			let gate: GatedClient | undefined;
			const foreignFence = new RegExp(`FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder <> `);
			const writer = await db.open({
				lease: STILL,
				wrap: client => {
					gate = gatedClient(client, foreignFence);
					return gate.client;
				},
			});
			if (!gate) throw new Error("the writer's client was not gated");
			const file = sessionFile(db);
			gate.close();
			const written = writer.writeText(file, transcript(ID, "a write without a claim"));
			// The write found no fresh lease of the session and is still open; it is let go in 3 s.
			await gate.paused();
			let letGoAt = Number.POSITIVE_INFINITY;
			setTimeout(() => {
				letGoAt = performance.now();
				gate?.open();
			}, 3000);
			const claimer = await db.open({ lease: STILL });
			const release = await claimer.acquireSessionClaim?.(ID, file, { waitMs: 10_000 });
			const claimedAt = performance.now();
			await written;
			// The claim waits for the write: it can answer only once the write may commit.
			expect({ held: typeof release, claimedAfterTheWriteWasLetGo: claimedAt >= letGoAt }).toEqual({
				held: "function",
				claimedAfterTheWriteWasLetGo: true,
			});
			release?.();
		}, 30_000);

		it("keeps two lease tables apart: a write in flight under one table's lease makes no claim of the same session id under another wait", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			// Another session and lease table on the same database, as a second deployment would have.
			await using elsewhere = await openLeaseDb(adapter, url ?? "");
			let gate: GatedClient | undefined;
			const foreignFence = new RegExp(`FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder <> `);
			const writer = await db.open({
				lease: STILL,
				wrap: client => {
					gate = gatedClient(client, foreignFence);
					return gate.client;
				},
			});
			if (!gate) throw new Error("the writer's client was not gated");
			gate.close();
			const written = writer.writeText(sessionFile(db), transcript(ID, "a write without a claim"));
			// The write found no fresh lease of the session in its table and holds its transaction open for 4 s.
			await gate.paused();
			let letGoAt = Number.POSITIVE_INFINITY;
			setTimeout(() => {
				letGoAt = performance.now();
				gate?.open();
			}, 4000);
			const claimer = await elsewhere.open({ lease: STILL });
			const release = await claimer.acquireSessionClaim?.(ID, sessionFile(elsewhere), { waitMs: 3000 });
			const claimedAt = performance.now();
			await written;
			// The same session id under the other table is another lease: the claim neither waits nor is refused.
			expect({
				held: release === null ? "refused" : typeof release,
				claimedBeforeTheWriteWasLetGo: claimedAt < letGoAt,
			}).toEqual({
				held: "function",
				claimedBeforeTheWriteWasLetGo: true,
			});
			release?.();
		}, 30_000);

		// PostgreSQL folds an unquoted name to lower case, so `omp_x` and `OMP_X` are one table. On MySQL and MariaDB the
		// server's lower_case_table_names decides, and the claim and the fence lock the lease row itself.
		for (const spelling of ["the same", "upper case"] as const) {
			it.skipIf(adapter !== "postgres")(
				`makes a claim wait for a write in flight from a store that names the same lease table, spelled in ${spelling}`,
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const leaseTable = spelling === "upper case" ? db.leaseTable.toUpperCase() : db.leaseTable;
					let gate: GatedClient | undefined;
					const foreignFence = new RegExp(
						`FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder <> `,
					);
					const writer = await db.open({
						lease: STILL,
						wrap: client => {
							gate = gatedClient(client, foreignFence);
							return gate.client;
						},
					});
					if (!gate) throw new Error("the writer's client was not gated");
					const claimer = await db.open({ lease: STILL, leaseTable });
					const [{ tables }] = (await db.sql(
						"SELECT count(*)::int AS tables FROM pg_catalog.pg_class WHERE relname IN (@1, @2) AND relkind = 'r'",
						[db.leaseTable, leaseTable],
					)) as Array<{ tables: number }>;
					const file = sessionFile(db);
					gate.close();
					const written = writer.writeText(file, transcript(ID, "a write without a claim"));
					// The write found no fresh lease of the session and is still open; it is let go in 3 s.
					await gate.paused();
					let letGoAt = Number.POSITIVE_INFINITY;
					setTimeout(() => {
						letGoAt = performance.now();
						gate?.open();
					}, 3000);
					const release = await claimer.acquireSessionClaim?.(ID, file, { waitMs: 10_000 });
					const claimedAt = performance.now();
					await written;
					// Both stores use one physical table, and the claim waits for the write as it would under one spelling.
					expect({
						physicalLeaseTables: tables,
						held: release === null ? "refused" : typeof release,
						claimedAfterTheWriteWasLetGo: claimedAt >= letGoAt,
					}).toEqual({
						physicalLeaseTables: 1,
						held: "function",
						claimedAfterTheWriteWasLetGo: true,
					});
					release?.();
				},
				30_000,
			);
		}

		// Start-up's table check picks out the lease table among the store's tables; the pick must not depend on how the
		// name is spelled, or a lease table that names the session table is checked for the lease's index twice.
		for (const spelling of ["the same", "upper case"] as const) {
			it.skipIf(adapter !== "postgres")(
				`refuses to start on a lease table that names the session table, spelled in ${spelling}, naming its missing holder index once`,
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					await (await db.open()).drain();
					const leaseTable = spelling === "upper case" ? db.table.toUpperCase() : db.table;
					const refused = String(await rejection(db.open({ leaseTable, createTable: false })));
					expect({
						byTheTableCheck: refused.includes("The store starts only on tables as"),
						holderIndexProblems: refused.split("no index on column holder").length - 1,
					}).toEqual({ byTheTableCheck: true, holderIndexProblems: 1 });
				},
			);
		}

		it("bounds a claim behind a stalled write from a store that holds no claim by its wait, except on MySQL, which bounds no INSERT", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const holdMs = 10_000;
			const waitMs = 3000;
			let gate: GatedClient | undefined;
			const foreignFence = new RegExp(`FROM (?:"[^"]+"\\.)?${db.leaseTable} WHERE session_id = .* AND holder <> `);
			const writer = await db.open({
				lease: STILL,
				wrap: client => {
					gate = gatedClient(client, foreignFence);
					return gate.client;
				},
			});
			if (!gate) throw new Error("the writer's client was not gated");
			const file = sessionFile(db);
			gate.close();
			const written = writer.writeText(file, transcript(ID, "a write without a claim"));
			// The write found no fresh lease of the session and stays open for 10 s.
			await gate.paused();
			const stalledAt = performance.now();
			let letGoAt = Number.POSITIVE_INFINITY;
			setTimeout(() => {
				letGoAt = performance.now();
				gate?.open();
			}, holdMs);
			const claimer = await db.open({ lease: STILL });
			const release = await claimer.acquireSessionClaim?.(ID, file, { waitMs });
			const answeredAt = performance.now();
			await written;
			const outcome = {
				held: release === null ? "refused" : typeof release,
				answeredWithinWait: answeredAt - stalledAt < waitMs + LOCK_SLACK_MS,
				answeredAfterTheWriteWasLetGo: answeredAt >= letGoAt,
			};
			if (db.server === "mysql") {
				// MySQL has no statement-scoped bound for an INSERT's lock wait: the
				// claim's insert waits for the write's gap lock, then claims.
				expect(outcome).toEqual({
					held: "function",
					answeredWithinWait: false,
					answeredAfterTheWriteWasLetGo: true,
				});
			} else {
				// Refused once the wait ends, the session held by the other process.
				expect(outcome).toEqual({
					held: "refused",
					answeredWithinWait: true,
					answeredAfterTheWriteWasLetGo: false,
				});
			}
			release?.();
		}, 60_000);

		it("refuses a write whose fence waits past its lock bound on the lease row, and counts the claim lost", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			const release = await storage.acquireSessionClaim?.(ID, file);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const unlock = await db.lockLeaseRow(ID);
			let outcome: unknown;
			let elapsedMs = 0;
			try {
				const started = performance.now();
				outcome = await Promise.race([
					storage.writeText(file, transcript(ID, "while the row is locked")).then(
						() => "written",
						(err: unknown) => err,
					),
					Bun.sleep(10_000).then(() => "still waiting"),
				]);
				elapsedMs = performance.now() - started;
			} finally {
				await unlock();
			}
			expect({
				refused: outcome instanceof SessionLeaseLostError,
				withinBound: elapsedMs < LOCK_SLACK_MS,
				lost: storage.sessionClaimLost?.(ID),
			}).toEqual({ refused: true, withinBound: true, lost: true });
			await storage.drain().catch(() => undefined);
			expect((await db.row(file))?.content).toBe(transcript(ID, "before"));
			release?.();
		}, 30_000);

		it.skipIf(adapter !== "postgres")(
			"opens, claims, heartbeats, writes and releases as a login that owns none of the tables",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const role = `lease_agent_${process.pid}`;
				const parts = `${db.table}_parts`;
				const blobs = `${db.table}_blobs`;
				// The owner makes the tables and the index from docs/session.md; the agent login
				// gets CREATE on the schema and row DML on the four tables, nothing more.
				for (const statement of [
					`CREATE TABLE ${db.table} (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms BIGINT NOT NULL, ` +
						"title TEXT, title_source TEXT, title_updated_at TEXT, byte_len BIGINT)",
					`CREATE TABLE ${parts} (path TEXT NOT NULL, start_offset BIGINT NOT NULL, content TEXT NOT NULL, ` +
						"PRIMARY KEY (path, start_offset))",
					`CREATE TABLE ${blobs} (sha256 TEXT PRIMARY KEY, content BYTEA NOT NULL, byte_len BIGINT NOT NULL, ` +
						"mime_type TEXT, created_ms BIGINT NOT NULL)",
					`CREATE TABLE ${db.leaseTable} (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, host TEXT NOT NULL, ` +
						"pid BIGINT NOT NULL, acquired_at BIGINT NOT NULL, heartbeat_at BIGINT NOT NULL)",
					`CREATE INDEX ${db.leaseTable}_holder ON ${db.leaseTable} (holder)`,
					`CREATE ROLE ${role} LOGIN`,
					`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`,
					`GRANT SELECT, INSERT, UPDATE, DELETE ON ${db.table}, ${parts}, ${blobs}, ${db.leaseTable} TO ${role}`,
				]) {
					await db.sql(statement);
				}
				const agentUrl = new URL(db.dsn);
				agentUrl.username = role;
				const client = new SQL(agentUrl.toString());
				try {
					const storage = await SqlSessionStorage.create({
						client,
						table: db.table,
						leaseTable: db.leaseTable,
						claims: true,
						lease: SHORT,
					});
					const file = sessionFile(db);
					const release = await storage.acquireSessionClaim?.(ID, file);
					expect(release).toBeFunction();
					await storage.writeText(file, transcript(ID, "written by the agent login"));
					await storage.drain();
					expect((await db.row(file))?.content).toContain("written by the agent login");
					await db.ageLease(ID, SHORT.expiryMs);
					await until(async () => ((await db.leases(ID))[0]?.ageMs ?? Number.POSITIVE_INFINITY) < SHORT.expiryMs);
					release?.();
					await storage.drain();
					expect(await db.leases(ID)).toEqual([]);
				} finally {
					await client.end();
					for (const name of [db.leaseTable, parts, blobs, db.table]) await db.sql(`DROP TABLE IF EXISTS ${name}`);
					await db.sql(`REVOKE ALL ON SCHEMA public FROM ${role}`);
					await db.sql(`DROP ROLE IF EXISTS ${role}`);
				}
			},
			30_000,
		);

		it.skipIf(adapter !== "mysql")(
			"opens, claims, heartbeats, writes and releases as a MySQL user with row access and CREATE on the four tables only",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const user = `lease_agent_${process.pid}`;
				// A fresh secret per run, so no fixed credential sits in the test.
				const secret = Bun.randomUUIDv7();
				const parts = `${db.table}_parts`;
				const blobs = `${db.table}_blobs`;
				const options = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";
				// Another user makes the tables and the index from docs/session.md; this user gets row
				// access and CREATE, which `CREATE TABLE IF NOT EXISTS` needs even on a table that exists.
				for (const statement of [
					`CREATE TABLE ${db.table} (path VARCHAR(512) NOT NULL PRIMARY KEY, content LONGTEXT NOT NULL, ` +
						"mtime_ms BIGINT NOT NULL, title TEXT NULL, title_source VARCHAR(16) NULL, " +
						`title_updated_at VARCHAR(64) NULL, byte_len BIGINT NULL)${options}`,
					`CREATE TABLE ${parts} (path VARCHAR(512) NOT NULL, start_offset BIGINT NOT NULL, ` +
						`content LONGTEXT NOT NULL, PRIMARY KEY (path, start_offset))${options}`,
					`CREATE TABLE ${blobs} (sha256 CHAR(64) NOT NULL PRIMARY KEY, content LONGBLOB NOT NULL, ` +
						`byte_len BIGINT NOT NULL, mime_type VARCHAR(127) NULL, created_ms BIGINT NOT NULL)${options}`,
					`CREATE TABLE ${db.leaseTable} (session_id VARCHAR(512) NOT NULL PRIMARY KEY, holder VARCHAR(64) NOT NULL, ` +
						"host VARCHAR(255) NOT NULL, pid BIGINT NOT NULL, acquired_at BIGINT NOT NULL, " +
						`heartbeat_at BIGINT NOT NULL, INDEX ${db.leaseTable}_holder (holder))${options}`,
					`CREATE USER '${user}'@'%' IDENTIFIED BY '${secret}'`,
					...[db.table, parts, blobs, db.leaseTable].map(
						table => `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON ${table} TO '${user}'@'%'`,
					),
				]) {
					await db.sql(statement);
				}
				const agentUrl = new URL(db.dsn);
				agentUrl.username = user;
				agentUrl.password = secret;
				const client = new SQL(agentUrl.toString());
				try {
					const storage = await SqlSessionStorage.create({
						client,
						table: db.table,
						leaseTable: db.leaseTable,
						claims: true,
						lease: SHORT,
					});
					const file = sessionFile(db);
					const release = await storage.acquireSessionClaim?.(ID, file);
					expect(release).toBeFunction();
					await storage.writeText(file, transcript(ID, "written by the agent user"));
					await storage.drain();
					expect((await db.row(file))?.content).toContain("written by the agent user");
					await db.ageLease(ID, SHORT.expiryMs);
					await until(async () => ((await db.leases(ID))[0]?.ageMs ?? Number.POSITIVE_INFINITY) < SHORT.expiryMs);
					release?.();
					await storage.drain();
					expect(await db.leases(ID)).toEqual([]);
				} finally {
					await client.end();
					for (const name of [db.leaseTable, parts, blobs, db.table]) await db.sql(`DROP TABLE IF EXISTS ${name}`);
					await db.sql(`DROP USER IF EXISTS '${user}'@'%'`);
				}
			},
			30_000,
		);
	});
}

/**
 * A client of a database where another login made every table, column and
 * index the store needs: the catalog probes say so, and every statement the
 * store sends is recorded in `sent`.
 */
function ownerMadeSchemaClient(adapter: "postgres" | "mysql", sent: string[]): SqlSessionStorageClient {
	const columns = ["path", "content", "mtime_ms", "title", "title_source", "title_updated_at", "byte_len"].map(
		column_name => ({ column_name }),
	);
	const lock = "SET LOCAL search_path = pg_catalog, pg_temp";
	const answer = (sql: string): SqlSessionStorageResult => {
		if (sql.includes(" AS column_name FROM ")) return columns;
		// Every table is there, so PostgreSQL's start-up makes none.
		if (sql.startsWith("SELECT pg_catalog.to_regclass("))
			return [{ session: true, parts: true, lease: true, blobs: true }];
		if (sql === "SELECT VERSION() AS version") return [{ version: "8.4.13" }];
		// The lease table's holder index exists, under the name the store gives it.
		if (sql.startsWith("SELECT i.indexrelid::text AS oid FROM pg_catalog.pg_index i")) return [{ oid: "1" }];
		if (sql.startsWith("SELECT c.oid::text AS oid, c.relkind::text AS kind")) {
			return [
				{ oid: "1", kind: "i", name: "public.omp_session_leases_holder", on_table: "public.omp_session_leases" },
			];
		}
		return [];
	};
	const executor: SqlSessionStorageTransaction = {
		async unsafe(sql): Promise<SqlSessionStorageResult> {
			// A read sent alone carries its search_path lock: record the two statements apart.
			if (sql.startsWith(`${lock}; `)) {
				const read = sql.slice(lock.length + 2);
				sent.push(lock, read);
				return [[], answer(read)];
			}
			sent.push(sql);
			return answer(sql);
		},
	};
	return { options: { adapter }, unsafe: executor.unsafe, transaction: callback => callback(executor) };
}

/** What a login that owns none of the tables may run at start-up: no-op creates, reads, and transaction settings. */
const NON_OWNER_STARTUP: readonly RegExp[] = [
	/^CREATE TABLE IF NOT EXISTS /,
	/^SET TRANSACTION (READ WRITE|ISOLATION LEVEL READ COMMITTED)$/,
	/^SET LOCAL search_path = pg_catalog, pg_temp$/,
	/^SELECT setting, reset_val FROM pg_settings WHERE name = 'default_transaction_read_only'$/,
	/^SELECT pg_advisory_xact_lock\(\d+\)$/,
	/^SELECT (attname|column_name) AS column_name FROM /,
	/^SELECT pg_catalog\.to_regclass\((\$1| \$omp\$)/,
	/^SELECT 1 AS unmeasured FROM /,
	/^SELECT i\.indexrelid::text AS oid FROM pg_catalog\.pg_index i /,
	/^SELECT c\.oid::text AS oid, c\.relkind::text AS kind, /,
	/^SELECT path, mtime_ms, byte_len, title, title_source, title_updated_at FROM /,
	/^SELECT a\.attname AS name, pg_catalog\.format_type\(/,
	/^SELECT 'trigger' AS kind, /,
	/^SELECT a\.attname::text AS name FROM pg_catalog\.pg_index i /,
	/^SELECT pg_catalog\.has_table_privilege\(/,
	// MySQL: whether the server has NOWAIT locking reads.
	/^SELECT VERSION\(\) AS version$/,
	// MySQL and MariaDB: the lock form the version picked, once, matching no row (a read a row grant allows).
	/^SELECT holder FROM \S+ WHERE session_id = \? AND holder = \? (FOR SHARE NOWAIT|LOCK IN SHARE MODE NOWAIT)$/,
	/^SET STATEMENT innodb_lock_wait_timeout = 1 FOR SELECT holder FROM \S+ WHERE false$/,
];

describe("SqlSessionStorage start-up on tables another login made", () => {
	for (const adapter of ["postgres", "mysql"] as const) {
		it(`sends no statement on ${adapter} that only the tables' owner may run`, async () => {
			const sent: string[] = [];
			await SqlSessionStorage.create({ client: ownerMadeSchemaClient(adapter, sent), claims: true });

			expect(sent.filter(sql => !NON_OWNER_STARTUP.some(allowed => allowed.test(sql)))).toEqual([]);
			// PostgreSQL looks first and makes nothing that is there; MySQL runs its four no-op creates, as before.
			expect(sent.filter(sql => sql.startsWith("CREATE TABLE IF NOT EXISTS "))).toHaveLength(
				adapter === "postgres" ? 0 : 4,
			);
		});
	}
});

describe.skipIf(!MYSQL57_URL)("SqlSessionStorage on MySQL 5.7", () => {
	it("refuses to claim sessions at start-up, naming the server version, since it can bound no lock wait", async () => {
		await using db = await openLeaseDb("mysql", MYSQL57_URL ?? "");
		const refused = await rejection(db.open());
		expect(String(refused)).toMatch(
			/SqlSessionStorage: claiming sessions needs MySQL 8\.0 or later, or MariaDB 10\.3 or later; this server is 5\.7\.\d+/,
		);
	}, 60_000);

	it("opens, writes and reads a session without claims, as before", async () => {
		await using db = await openLeaseDb("mysql", MYSQL57_URL ?? "");
		const storage = await db.open({ claims: false });
		const file = sessionFile(db);
		await storage.writeText(file, transcript(ID, "on 5.7"));
		await storage.drain();
		expect([storage.acquireSessionClaim, await storage.readText(file)]).toEqual([
			undefined,
			transcript(ID, "on 5.7"),
		]);
	}, 60_000);
});

/**
 * The MySQL-family servers the lock-refusal rows run on, with the
 * `innodb_rollback_on_timeout` each must have. With it ON a lock wait timeout
 * (error 1205, MariaDB's answer to a refused `NOWAIT` read too) rolls back the
 * whole transaction, not only the statement: nothing the store sends after it
 * in that transaction would be in a transaction, or hold a lock, any more.
 */
const ROLLBACK_ON_TIMEOUT_SERVERS = [
	{ setting: "OFF", url: LEASE_BACKENDS.find(backend => backend.adapter === "mysql")?.url },
	{ setting: "ON", url: MYSQL_ROT_URL },
] as const;

for (const { setting, url } of ROLLBACK_ON_TIMEOUT_SERVERS) {
	describe.skipIf(!url)(
		`SqlSessionStorage lock reads that first meet another transaction's lock (MySQL family, innodb_rollback_on_timeout ${setting})`,
		() => {
			/** Fail unless `db`'s server has the setting these rows are for: a row on the wrong server proves nothing. */
			async function expectSetting(db: LeaseDb): Promise<void> {
				const [row] = await db.sql("SELECT @@GLOBAL.innodb_rollback_on_timeout AS rot");
				expect(Number(row?.rot)).toBe(setting === "ON" ? 1 : 0);
			}

			it("keeps a fence's share lock after its lock read met another transaction's lock, so a takeover waits for the write", async () => {
				await using db = await openLeaseDb("mysql", url ?? "");
				await expectSetting(db);
				let gate: GatedClient | undefined;
				const fence = new RegExp(
					`FROM ${db.leaseTable} WHERE session_id = \\? AND holder = \\? (FOR SHARE|LOCK IN SHARE MODE)`,
				);
				const owner = await db.open({
					lease: STILL,
					wrap: client => {
						gate = gatedClient(client, fence);
						return gate.client;
					},
				});
				if (!gate) throw new Error("expected a gated client");
				const file = sessionFile(db);
				const release = await owner.acquireSessionClaim?.(ID, file);
				expect(release).toBeFunction();
				await owner.writeText(file, transcript(ID, "before"));
				await owner.drain();
				// The owner looks dead to the database clock, so a taker nothing makes wait takes the session at once.
				await db.ageLease(ID, STILL.expiryMs + 60_000);
				// Another transaction holds the lease row for 300 ms, so the write's fence meets its lock first.
				const unlock = await db.lockLeaseRow(ID);
				gate.close();
				const written = owner.writeText(file, transcript(ID, "the owner's write")).then(
					() => "written",
					(err: unknown) => String(err),
				);
				setTimeout(() => void unlock(), 300);
				await gate.paused();

				// The write is past its fence and holds its transaction open.
				const taker = await db.open({ lease: STILL });
				let settled = false;
				const takeover = (
					taker.acquireSessionClaim?.(ID, file, { waitMs: 10_000 }) ?? Promise.resolve(null)
				).finally(() => {
					settled = true;
				});
				await Bun.sleep(1500);
				const takenWhileTheWriteWasOpen = settled;
				gate.open();
				const outcome = await written;
				const releaseTaker = await takeover;

				expect({ takenWhileTheWriteWasOpen, outcome, taken: typeof releaseTaker }).toEqual({
					takenWhileTheWriteWasOpen: false,
					outcome: "written",
					taken: "function",
				});
				release?.();
				releaseTaker?.();
			}, 30_000);

			it("keeps a claim's row lock after its lock read met another transaction's lock, so one claimant holds the session", async () => {
				await using db = await openLeaseDb("mysql", url ?? "");
				await expectSetting(db);
				const file = sessionFile(db);
				// A holder that died: its lease is stale on the database clock.
				const dead = await db.open({ lease: STILL });
				expect(await dead.acquireSessionClaim?.(ID, file)).toBeFunction();
				await db.ageLease(ID, STILL.expiryMs + 60_000);
				let gate: GatedClient | undefined;
				const lockRead = new RegExp(
					`^SELECT holder, CASE WHEN .* FROM ${db.leaseTable} WHERE session_id = \\? FOR UPDATE`,
				);
				const first = await db.open({
					lease: STILL,
					wrap: client => {
						gate = gatedClient(client, lockRead);
						return gate.client;
					},
				});
				if (!gate) throw new Error("expected a gated client");
				// Another transaction holds the lease row for 300 ms, so the first claim's lock read meets its lock first.
				const unlock = await db.lockLeaseRow(ID);
				gate.close();
				const firstClaim = first.acquireSessionClaim?.(ID, file, { waitMs: 10_000 }) ?? Promise.resolve(null);
				setTimeout(() => void unlock(), 300);
				await gate.paused();

				// The first claimant read the stale lease and holds its transaction open, before it takes the row over.
				const second = await db.open({ lease: STILL });
				let settled = false;
				const secondClaim = (
					second.acquireSessionClaim?.(ID, file, { waitMs: 3000 }) ?? Promise.resolve(null)
				).finally(() => {
					settled = true;
				});
				await Bun.sleep(1500);
				const secondAnsweredWhileTheFirstHeldTheRow = settled;
				gate.open();
				const firstRelease = await firstClaim;
				const secondRelease = await secondClaim;

				expect({
					secondAnsweredWhileTheFirstHeldTheRow,
					first: typeof firstRelease,
					second: secondRelease === null ? "refused" : typeof secondRelease,
				}).toEqual({ secondAnsweredWhileTheFirstHeldTheRow: false, first: "function", second: "refused" });
				firstRelease?.();
				secondRelease?.();
			}, 30_000);

			it("keeps the share lock of a write to a session its store holds no claim on after its lock read met another transaction's lock, so a claim waits for the write", async () => {
				await using db = await openLeaseDb("mysql", url ?? "");
				await expectSetting(db);
				const file = sessionFile(db);
				// A holder that died: its lease row is there, and stale on the database clock.
				const dead = await db.open({ lease: STILL });
				expect(await dead.acquireSessionClaim?.(ID, file)).toBeFunction();
				await dead.writeText(file, transcript(ID, "before"));
				await dead.drain();
				await db.ageLease(ID, STILL.expiryMs + 60_000);
				let gate: GatedClient | undefined;
				const foreignFence = new RegExp(`FROM ${db.leaseTable} WHERE session_id = \\? AND holder <> `);
				const writer = await db.open({
					lease: STILL,
					wrap: client => {
						gate = gatedClient(client, foreignFence);
						return gate.client;
					},
				});
				if (!gate) throw new Error("expected a gated client");
				// Another transaction holds the lease row for 300 ms, so the write's fence meets its lock first.
				const unlock = await db.lockLeaseRow(ID);
				gate.close();
				const written = writer.writeText(file, transcript(ID, "a write without a claim")).then(
					() => "written",
					(err: unknown) => String(err),
				);
				setTimeout(() => void unlock(), 300);
				await gate.paused();

				// The write is past its fence and holds its transaction open; it is let go in 1.5 s.
				let letGoAt = Number.POSITIVE_INFINITY;
				setTimeout(() => {
					letGoAt = performance.now();
					gate?.open();
				}, 1500);
				const claimer = await db.open({ lease: STILL });
				const releaseClaim = await claimer.acquireSessionClaim?.(ID, file, { waitMs: 10_000 });
				const claimedAt = performance.now();
				const outcome = await written;

				expect({ held: typeof releaseClaim, claimedAfterTheWriteWasLetGo: claimedAt >= letGoAt, outcome }).toEqual({
					held: "function",
					claimedAfterTheWriteWasLetGo: true,
					outcome: "written",
				});
				releaseClaim?.();
			}, 30_000);
		},
	);
}

/** `client`, whose start-up read of the server's version answers `reported` instead. */
function reportingVersion(client: SqlSessionStorageClient, reported: string): SqlSessionStorageClient {
	return {
		options: client.options,
		unsafe: (query, values) =>
			query === "SELECT VERSION() AS version"
				? Promise.resolve([{ version: reported }])
				: client.unsafe(query, values),
		transaction: callback => client.transaction(callback),
		end: () => client.end?.() ?? Promise.resolve(),
	};
}

const MYSQL_URL = LEASE_BACKENDS.find(backend => backend.adapter === "mysql")?.url;

describe.skipIf(!MYSQL_URL)(
	"SqlSessionStorage start-up on a MySQL-family server that reports another family's version",
	() => {
		it("refuses to claim sessions when the server rejects the lock syntax its reported version calls for, naming both", async () => {
			await using db = await openLeaseDb("mysql", MYSQL_URL ?? "");
			// MariaDB and MySQL 8 each reject the other's lock syntax; the check names the first form the server refuses.
			const reported = db.server === "mariadb" ? "8.0.36" : "10.11.6-MariaDB";
			const syntax = db.server === "mariadb" ? "FOR SHARE NOWAIT" : "LOCK IN SHARE MODE NOWAIT";

			const refused = String(
				await rejection(
					db.open({ wrap: client => reportingVersion(client as unknown as SqlSessionStorageClient, reported) }),
				),
			);
			// Control: the server's own version opens.
			const opened = await db.open();

			expect({
				namesTheVersion: refused.includes(`reports version ${reported}`),
				namesTheSyntax: refused.includes(syntax),
				opensUnderItsOwnVersion: typeof opened.acquireSessionClaim,
			}).toEqual({ namesTheVersion: true, namesTheSyntax: true, opensUnderItsOwnVersion: "function" });
		}, 60_000);
	},
);
