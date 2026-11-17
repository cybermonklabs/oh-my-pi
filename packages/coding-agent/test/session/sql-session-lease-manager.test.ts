/**
 * `SessionManager` on a SQL store that claims sessions: it claims a session
 * when it opens it, keeps writing through a stall of the database it cannot
 * confirm its claim through, and moves to a sibling at once when another
 * holder took the session over — unless the launcher named the session, which
 * then stops instead of writing a sibling. SQLite always; PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	SessionWriteConflictError,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import {
	type GatedClient,
	gatedClient,
	LEASE_BACKENDS,
	type LeaseDb,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
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

		it("rejects a caller's rewrite computed before an older build appended, and keeps that build's turn", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const { manager, notices } = await resume(storage, file);
			manager.appendMessage(userTurn("mine before the change"));
			await manager.flush();
			const older = await db.open({ claims: false });
			const writer = older.openWriter(file);
			await writer.append(
				`${JSON.stringify({ type: "message", id: "older1", parentId: null, timestamp: "2026-11-17T00:00:09.000Z", message: userTurn("the older build's turn") })}\n`,
			);
			await writer.close();
			await older.drain();

			const rejected = await manager.rewriteEntries().then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(rejected).toBeInstanceOf(SessionWriteConflictError);
			expect({
				notices,
				id: manager.getSessionId(),
				kept: ((await db.row(file))?.content ?? "").includes("the older build's turn"),
			}).toEqual({ notices: [], id: ID, kept: true });
			await manager.close().catch(() => undefined);
		});

		it("lets two managers of one store both write the session they opened", async () => {
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

			expect([first.manager.getSessionFile(), second.manager.getSessionFile()]).toEqual([file, file]);
			expect([...first.notices, ...second.notices]).toEqual([]);
			const content = (await db.row(file))?.content ?? "";
			expect([content.includes("from the first"), content.includes("from the second")]).toEqual([true, true]);
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
