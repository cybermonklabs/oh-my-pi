/**
 * A switch to the session a manager holds now (a reload, `AgentSession.reload()`) on SQL storage that claims
 * sessions: the switch's writer claim meets the manager's own writer slot, and the release before 6dfeac82's merge
 * gave no way through it, so the reload moved the conversation to a sibling with a new id. Runs against SQLite always
 * and PostgreSQL / MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	openLeaseDb,
	transcript,
	until,
} from "./sql-session-lease-fixture";

/** Timings under which no heartbeat runs during a test. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

function fileOf(db: LeaseDb, id: string): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${id}.jsonl`);
}

/**
 * Runs the rest of a case as an `OMP_SESSION_EXCLUSIVE=1` session, with `process.exit` recorded instead of run: an
 * exclusive stop ends the process with it (`#stopExclusive`). `restore()` puts both back.
 */
function underExclusive(): { codes: unknown[]; restore: () => void } {
	const before = process.env.OMP_SESSION_EXCLUSIVE;
	process.env.OMP_SESSION_EXCLUSIVE = "1";
	const codes: unknown[] = [];
	const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		codes.push(code);
	}) as typeof process.exit);
	return {
		codes,
		restore: () => {
			exit.mockRestore();
			if (before === undefined) delete process.env.OMP_SESSION_EXCLUSIVE;
			else process.env.OMP_SESSION_EXCLUSIVE = before;
		},
	};
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a reload of the session this manager holds, on SQL storage (${adapter})`, () => {
		it("keeps the session's id and file when a manager switches to the session it holds", async () => {
			// If this regresses, the switch's claim is refused by this manager's own writer slot, and the adoption moves
			// the session to a sibling with a new id.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const id = Bun.randomUUIDv7();
			const file = fileOf(db, id);
			await store.writeText(file, transcript(id, "the session", db.dir.path()));
			await store.drain();
			const manager = await SessionManager.open(file, path.dirname(file), store, { suppressBreadcrumb: true });
			manager.claimForWriting();
			manager.appendMessage({ role: "user", content: "a turn", timestamp: Date.now() });
			await manager.flush();
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));

			await manager.setSessionFile(file, { claim: { waitMs: 0 } });

			expect({ id: manager.getSessionId(), file: manager.getSessionFile(), notices }).toEqual({
				id,
				file,
				notices: [],
			});
			await manager.close();
		}, 60_000);

		it("keeps the session's id and file through AgentSession.reload()", async () => {
			// If this regresses, a reload moves the conversation the user is in to a sibling with a new id.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const id = Bun.randomUUIDv7();
			const file = fileOf(db, id);
			await store.writeText(file, transcript(id, "the session", db.dir.path()));
			await store.drain();
			const manager = await SessionManager.open(file, path.dirname(file), store, { suppressBreadcrumb: true });
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const { session } = await createAgentSession({
				cwd: db.dir.path(),
				sessionManager: manager,
				toolNames: [],
				enableMCP: false,
				enableLsp: false,
				disableExtensionDiscovery: true,
				settings: Settings.isolated({ "compaction.enabled": false }),
			});
			manager.appendMessage({ role: "user", content: "a turn", timestamp: Date.now() });
			await manager.flush();

			await session.reload();

			expect({
				id: session.sessionManager.getSessionId(),
				file: session.sessionManager.getSessionFile(),
				notices,
			}).toEqual({ id, file, notices: [] });
			await session.dispose();
			await manager.close();
		}, 60_000);

		it("refuses another manager of this process a switch to a session the first one holds", async () => {
			// The way through is for a manager reading again the session it holds itself. If it widens to any switch
			// to a held journal, a second manager of this process takes the first one's journal, and two agent loops
			// write one session.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const id = Bun.randomUUIDv7();
			const file = fileOf(db, id);
			await store.writeText(file, transcript(id, "the session", db.dir.path()));
			await store.drain();
			const first = await SessionManager.open(file, path.dirname(file), store, { suppressBreadcrumb: true });
			first.claimForWriting();
			first.appendMessage({ role: "user", content: "a turn", timestamp: Date.now() });
			await first.flush();
			const second = SessionManager.create(db.dir.path(), path.join(db.dir.path(), "elsewhere"), store);
			second.appendMessage({ role: "user", content: "another conversation", timestamp: Date.now() });
			await second.flush();
			second.claimForWriting();
			const notices: SessionPersistenceNotice[] = [];
			second.onPersistenceNotice(notice => notices.push(notice));

			await second.setSessionFile(file, { claim: { waitMs: 0 } });

			const sibling = notices[0]?.to ?? "";
			expect({ first: first.getSessionId(), movedOff: second.getSessionId() !== id, notices }).toEqual({
				first: id,
				movedOff: true,
				notices: [{ reason: "open-elsewhere", from: file, to: sibling }],
			});
			await second.close();
			await first.close();
		}, 60_000);

		it("does not stop an OMP_SESSION_EXCLUSIVE=1 session through AgentSession.reload()", async () => {
			// If this regresses, the reload's own claim is refused, and the exclusive session stops the process.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const id = Bun.randomUUIDv7();
			const file = fileOf(db, id);
			await store.writeText(file, transcript(id, "the session", db.dir.path()));
			await store.drain();
			const exits = underExclusive();
			try {
				const manager = await SessionManager.open(file, path.dirname(file), store, { suppressBreadcrumb: true });
				const { session } = await createAgentSession({
					cwd: db.dir.path(),
					sessionManager: manager,
					toolNames: [],
					enableMCP: false,
					enableLsp: false,
					disableExtensionDiscovery: true,
					settings: Settings.isolated({ "compaction.enabled": false }),
				});
				manager.appendMessage({ role: "user", content: "a turn", timestamp: Date.now() });
				await manager.flush();

				await session.reload();
				// An exclusive stop ends the process within its holder lookup's 2 s: wait past it.
				await Bun.sleep(3000);

				expect({ exits: exits.codes, id: session.sessionManager.getSessionId() }).toEqual({ exits: [], id });
				await session.dispose();
				await manager.close();
			} finally {
				exits.restore();
			}
		}, 60_000);

		it("stops an OMP_SESSION_EXCLUSIVE=1 session whose switch meets another process's lease", async () => {
			// The control of the case above, in the same instrument: a refused claim does stop the process here, so
			// no exit there says the reload's claim was not refused.
			await using db = await openLeaseDb(adapter, url ?? "");
			const store = await db.open({ lease: STILL });
			const id = Bun.randomUUIDv7();
			const file = fileOf(db, id);
			const heldId = Bun.randomUUIDv7();
			const held = fileOf(db, heldId);
			await store.writeText(file, transcript(id, "the session", db.dir.path()));
			await store.writeText(held, transcript(heldId, "held elsewhere", db.dir.path()));
			await store.drain();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			expect((await holder.run({ op: "claim", sessionId: heldId, path: held })).held).toBe(true);
			const exits = underExclusive();
			try {
				const manager = await SessionManager.open(file, path.dirname(file), store, { suppressBreadcrumb: true });
				manager.claimForWriting();
				manager.appendMessage({ role: "user", content: "a turn", timestamp: Date.now() });
				await manager.flush();

				await manager.setSessionFile(held, { claim: { waitMs: 0 } });
				await until(() => exits.codes.length > 0, 5000);

				expect(exits.codes).toEqual([1]);
				await manager.close();
			} finally {
				exits.restore();
			}
		}, 60_000);
	});
}
