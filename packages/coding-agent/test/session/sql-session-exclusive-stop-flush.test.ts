/**
 * Under `OMP_SESSION_EXCLUSIVE=1` a session that loses its file to another writer stops: it seals itself, names the
 * stop on stderr, gives back the claims its store holds, and only then ends the process. Until the process ends, a
 * caller that flushes or closes the session must not be told an entry is saved when storage does not hold it: not the
 * turn whose write met the loss, and not a turn the agent finished during the stop's wait, which the seal drops. Each
 * case holds its store's release of the claims, so the stop waits there and the process lives on, and reads what
 * `flush()`, `flushSync()` and `close()` reported meanwhile. Two paths of the release reach the stop: the recovery of
 * a queued append's write conflict, once an older build put another session over the file (every SQL backend), and a
 * lease another holder took over, which the database fence finds (the backends whose claim is a lease row). The
 * controls stop a session before it writes anything (a resume another process holds; an idle session whose heartbeat
 * finds its lease taken over): storage then holds every entry, so flush and close resolve, also when the load owes a
 * republish (an older build's version, a torn record), and so does `AgentSession.dispose()`; only a turn the seal
 * drops makes them reject. The rows named "negative control" pass before this change too: each fails only if a stop
 * that left nothing unsaved made them reject. A stop during a switch keeps the session that stopped, with its turns
 * and its claim, also through `AgentSession.switchSession`, and a stopped session takes no lease of a switch's target.
 * Last, a close after the session was sealed (a dispose) whose own write the fence refuses reports that write's loss,
 * and a sealed subagent transcript's close does as before this change. SQLite always; PostgreSQL and MySQL (MySQL 8
 * or MariaDB) when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	transcript,
	until,
} from "./sql-session-lease-fixture";

const ID = "01a1f700-0000-7000-8000-000000000001";
/** Timings under which no heartbeat runs during a test: only a write meets the loss. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
/** Timings under which a heartbeat finds a takeover within 200 ms, with no write. */
const FAST = { expiryMs: 1_000, heartbeatMs: 200 };

function sessionFile(db: LeaseDb): string {
	return path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

/** `OMP_SESSION_EXCLUSIVE=1` until disposed, as a pod's launcher sets it for the whole process. */
function exclusive(): Disposable {
	const before = process.env.OMP_SESSION_EXCLUSIVE;
	process.env.OMP_SESSION_EXCLUSIVE = "1";
	return {
		[Symbol.dispose]() {
			if (before === undefined) delete process.env.OMP_SESSION_EXCLUSIVE;
			else process.env.OMP_SESSION_EXCLUSIVE = before;
		},
	};
}

/**
 * Hold `storage`'s release of its claims, which a stop awaits before it ends the process, for the rest of the test.
 * `reached` turns true once a stop got there, its stop line written.
 */
function holdClaimRelease(storage: SqlSessionStorage): { reached: boolean } {
	const hold = { reached: false };
	// The store's `releaseHeldClaims` is a readonly field; this store alone gets one that never settles.
	Object.defineProperty(storage, "releaseHeldClaims", {
		value: () => {
			hold.reached = true;
			return new Promise<void>(() => {});
		},
	});
	return hold;
}

/** How `call` ended: `"resolved"`, or the message it rejected with. */
async function outcome(call: Promise<unknown>): Promise<string> {
	return call.then(
		() => "resolved",
		(err: unknown) => (err instanceof Error ? err.message : String(err)),
	);
}

/** How `manager.flushSync()` ended: `"returned"`, or the message it threw. */
function syncOutcome(manager: SessionManager): string {
	try {
		manager.flushSync();
		return "returned";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** Open the session at `file` in `storage` as a resume does, claiming it. */
async function resume(storage: SqlSessionStorage, file: string): Promise<SessionManager> {
	const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
	await manager.claimOpenedSession();
	return manager;
}

/**
 * Call right after the append whose write meets the loss. What the session's callers are told: the flush that waits
 * on that write, then, once the stop reached its release, a turn appended during the stop's wait and its flush,
 * `flushSync()` and `close()`.
 */
async function reportsThroughTheStop(manager: SessionManager, hold: { reached: boolean }) {
	const inFlight = await outcome(manager.flush());
	await until(() => hold.reached, 10_000, { what: "the stop to reach its release of the store's claims" });
	manager.appendMessage(userTurn("finished during the stop's wait"));
	const afterStop = await outcome(manager.flush());
	const sync = syncOutcome(manager);
	return { inFlight, afterStop, sync, closed: await outcome(manager.close()) };
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 stop on SQL storage (${adapter})`, () => {
		it("rejects flush, flushSync and close with the stop once an older build put another session over its file", async () => {
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const manager = await resume(storage, file);
			manager.appendMessage(userTurn("stored before the change"));
			await manager.flush();
			const replacement = transcript("01a1f700-0000-7000-8000-0000000000d5", "another session");
			const older = await db.open({ claims: false });
			await older.writeText(file, replacement);
			await older.drain();

			// The append meets the other session's file: the recovery finds it replaced, and the session stops.
			manager.appendMessage(userTurn("refused by the size check"));
			const reports = await reportsThroughTheStop(manager, hold);

			const stop = expect.stringContaining(`Session ${ID} stops (replaced): its file now holds another session.`);
			expect({
				...reports,
				paths: await db.paths(),
				untouched: (await db.row(file))?.content === replacement,
			}).toEqual({
				inFlight: stop,
				afterStop: stop,
				sync: stop,
				closed: stop,
				paths: [file],
				untouched: true,
			});
		}, 30_000);
	});
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 stop on SQL lease rows (${adapter})`, () => {
		it("rejects flush, flushSync and close with the stop once the fence refused a write after a takeover", async () => {
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			const manager = await resume(storage, file);
			manager.appendMessage(userTurn("stored before the takeover"));
			await manager.flush();
			const before = await db.row(file);
			// This holder looks dead to the database: another holder takes the lease over.
			await db.ageLease(ID, STILL.expiryMs + 60_000);
			const releaseNext = await (await db.open({ lease: STILL })).acquireSessionClaim?.(ID, file);
			expect(releaseNext).toBeFunction();

			// The append's write meets the fence: the claim is lost, and the session stops.
			manager.appendMessage(userTurn("refused by the fence"));
			const reports = await reportsThroughTheStop(manager, hold);

			const stop = expect.stringContaining(
				`Session ${ID} stops (open-elsewhere): another omp process took its lease over.`,
			);
			expect({
				...reports,
				paths: await db.paths(),
				untouched: Bun.deepEquals(await db.row(file), before),
			}).toEqual({
				inFlight: stop,
				afterStop: stop,
				sync: stop,
				closed: stop,
				paths: [file],
				untouched: true,
			});
			releaseNext?.();
		}, 30_000);
	});
}

/** {@link transcript} as an older build wrote it: its header names version 2, which the load migrates. */
function olderTranscript(id: string, text: string): string {
	const [header = "", ...rest] = transcript(id, text).split("\n");
	return [JSON.stringify({ ...JSON.parse(header), version: 2 }), ...rest].join("\n");
}

/**
 * What storage holds of the session before another process claims it, each read back whole by the resume. The last
 * two leave the load owing a republish before its next append (a migration; a record it skips), so the stored bytes
 * are not the entries' as this build writes them, yet storage holds every entry.
 */
const STORED = [
	{ what: "a current transcript", content: transcript(ID, "stored") },
	{ what: "an older build's transcript", content: olderTranscript(ID, "stored") },
	{
		what: "a transcript whose last record is torn",
		content: `${transcript(ID, "stored")}{"type":"message","id":"m2"`,
	},
];

/** Another omp process with its own store on `db`'s database; a `claim` command makes it hold a session. */
function anotherProcess(db: LeaseDb): Promise<LeaseProcess> {
	return LeaseProcess.start(
		{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
		db.dir.join("holder"),
	);
}

/**
 * Resume the session at `file` in `storage` while another process holds it: the resume's claim is refused, so the
 * session stops before it writes anything. Returns once the stop reached its release of the store's claims.
 */
async function resumeHeldElsewhere(
	storage: SqlSessionStorage,
	file: string,
	hold: { reached: boolean },
): Promise<SessionManager> {
	const manager = await resume(storage, file);
	await until(() => hold.reached, 10_000, { what: "the stop to reach its release of the store's claims" });
	return manager;
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 stop at a resume another process holds (${adapter})`, () => {
		for (const { what, content } of STORED) {
			it(`negative control: lets flush, flushSync and close resolve when the stop left every entry stored: ${what}`, async () => {
				// A negative control: it passes without this change too. If it fails, a stop alone rejects: a caller is
				// told entries are unsaved that storage holds.
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open({ lease: STILL });
				const hold = holdClaimRelease(storage);
				const file = sessionFile(db);
				await storage.writeText(file, content);
				await storage.drain();
				const before = await db.row(file);
				await using holder = await anotherProcess(db);
				expect((await holder.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);
				using _exclusive = exclusive();

				const manager = await resumeHeldElsewhere(storage, file, hold);
				const flushed = await outcome(manager.flush());
				const sync = syncOutcome(manager);
				const closed = await outcome(manager.close());

				expect({
					flushed,
					sync,
					closed,
					paths: await db.paths(),
					untouched: Bun.deepEquals(await db.row(file), before),
				}).toEqual({ flushed: "resolved", sync: "returned", closed: "resolved", paths: [file], untouched: true });
			}, 30_000);
		}

		it("rejects flush, flushSync and close with the stop once the seal dropped a turn appended during its wait", async () => {
			// Storage holds every entry the resume read, as in the case above: only the dropped turn is unsaved.
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "stored"));
			await storage.drain();
			const before = await db.row(file);
			await using holder = await anotherProcess(db);
			expect((await holder.run({ op: "claim", sessionId: ID, path: file })).held).toBe(true);
			using _exclusive = exclusive();

			const manager = await resumeHeldElsewhere(storage, file, hold);
			manager.appendMessage(userTurn("finished during the stop's wait"));
			const flushed = await outcome(manager.flush());
			const sync = syncOutcome(manager);
			const closed = await outcome(manager.close());

			const stop = expect.stringContaining(
				`Session ${ID} stops (open-elsewhere): another omp process holds its lease.`,
			);
			expect({
				flushed,
				sync,
				closed,
				paths: await db.paths(),
				untouched: Bun.deepEquals(await db.row(file), before),
			}).toEqual({ flushed: stop, sync: stop, closed: stop, paths: [file], untouched: true });
		}, 30_000);
	});
}

const OTHER_ID = "01a1f700-0000-7000-8000-0000000000e2";
/** The stop's own words once a write found another holder took the lease over. */
const TAKEN_OVER = `Session ${ID} stops (open-elsewhere): another omp process took its lease over.`;
/** The last record of an older build's write that a SIGKILL cut off. */
const TORN = `{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-11-17T00:00:01.000Z","message":{"role":"assistant","conte`;

/** An assistant turn, as a provider's answer is recorded. */
function assistantTurn(text: string) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		api: "anthropic-messages" as const,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * Let another holder take the session's lease over: age the lease row and acquire it from a second store, again when
 * a heartbeat refreshed the row between the two. Returns the taker's release.
 */
async function takeOver(db: LeaseDb, file: string): Promise<() => void> {
	const taker = await db.open({ lease: STILL });
	for (let tries = 0; tries < 40; tries++) {
		await db.ageLease(ID, 3_600_000);
		const release = await taker.acquireSessionClaim?.(ID, file);
		if (release) return release;
		// A heartbeat refreshed the row between the two statements: age it again at once.
	}
	throw new Error("the second store never took the lease over");
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 stop of an idle session (${adapter})`, () => {
		it("lets AgentSession.dispose() resolve once the heartbeat found the lease taken over, every turn stored", async () => {
			// If this fails, the dispose's own exit marker, which the seal drops, makes close() report the stop.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const tempDir = TempDir.createSync("@omp-exclusive-stop-dispose-");
			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("anthropic", "test-key");
			try {
				const storage = await db.open({ lease: FAST });
				const hold = holdClaimRelease(storage);
				const file = sessionFile(db);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.drain();
				const manager = await resume(storage, file);
				const model = getBundledModel("anthropic", "claude-sonnet-4-5");
				if (!model) throw new Error("expected the bundled anthropic claude-sonnet-4-5");
				const session = new AgentSession({
					agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
					sessionManager: manager,
					settings: Settings.isolated(),
					modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
					agentId: "Main",
				});
				// The dispose records its exit marker only for a session with an assistant turn.
				manager.appendMessage(assistantTurn("the stored answer"));
				await manager.flush();
				const stored = await db.row(file);
				const release = await takeOver(db, file);
				await until(() => hold.reached, 15_000, { what: "the stop to reach its release of the store's claims" });

				const disposed = await outcome(session.dispose());

				expect({
					disposed,
					answerStored: stored?.content.includes("the stored answer"),
					untouched: Bun.deepEquals(await db.row(file), stored),
				}).toEqual({ disposed: "resolved", answerStored: true, untouched: true });
				release();
			} finally {
				authStorage.close();
				AsyncJobManager.resetForTests();
				tempDir.removeSync();
			}
		}, 60_000);

		it("negative control: lets flush, flushSync and close resolve when the stop comes before any write after a load that skipped a torn record", async () => {
			// A negative control: it passes without this change too. If it fails, a load that leaves no byte-level proof
			// of its entries counts them unsaved until a write.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: FAST });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			const torn = `${transcript(ID, "before")}${TORN}`;
			await storage.writeText(file, torn);
			await storage.drain();
			const manager = await resume(storage, file);
			const loaded = manager.getEntries().length;
			const release = await takeOver(db, file);
			await until(() => hold.reached, 15_000, { what: "the stop to reach its release of the store's claims" });

			const flushed = await outcome(manager.flush());
			const sync = syncOutcome(manager);
			const closed = await outcome(manager.close());

			expect({ flushed, sync, closed, loaded, untouched: (await db.row(file))?.content === torn }).toEqual({
				flushed: "resolved",
				sync: "returned",
				closed: "resolved",
				loaded: 1,
				untouched: true,
			});
			release();
		}, 30_000);

		it("rejects a switch that a stop interrupts, and keeps judging the session that stopped", async () => {
			// If this fails, the switch loads the other session, and flush and close judge that one: they resolve,
			// though the turn the stop's cause refused is not stored.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			const otherFile = path.join(path.dirname(file), `2026-11-17T00-00-00-000Z_${OTHER_ID}.jsonl`);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.writeText(otherFile, transcript(OTHER_ID, "another session"));
			await storage.drain();
			const manager = await resume(storage, file);
			const before = await db.row(file);
			const other = await db.row(otherFile);
			const release = await takeOver(db, file);

			// No heartbeat runs: the append's write meets the fence while the switch drains it, the first to see the loss.
			manager.appendMessage(userTurn("refused by the fence"));
			const switched = await outcome(manager.setSessionFile(otherFile));
			const flushed = await outcome(manager.flush());
			const closed = await outcome(manager.close());

			const stop = expect.stringContaining(TAKEN_OVER);
			expect({
				switched,
				flushed,
				closed,
				stopped: hold.reached,
				file: manager.getSessionFile(),
				id: manager.getSessionId(),
				untouched: Bun.deepEquals(await db.row(file), before),
				otherUntouched: Bun.deepEquals(await db.row(otherFile), other),
			}).toEqual({
				switched: expect.stringContaining(
					`${TAKEN_OVER} OMP_SESSION_EXCLUSIVE=1 keeps it from moving to another id, so it opens no other session.`,
				),
				flushed: stop,
				closed: stop,
				stopped: true,
				file,
				id: ID,
				untouched: true,
				otherUntouched: true,
			});
			release();
		}, 30_000);
	});

	describe.skipIf(!url)(`a close after the seal whose write the lease fence refuses (${adapter})`, () => {
		/**
		 * Resume the session at `file`; with `takeover`, let another holder take its lease over first, unseen (no
		 * heartbeat runs). Then append a turn, seal the session as a dispose does, and close it: the turn's write is the
		 * first since the takeover. How the close ended.
		 */
		async function closeAfterSeal(db: LeaseDb, storage: SqlSessionStorage, takeover: boolean): Promise<string> {
			const file = sessionFile(db);
			const manager = await resume(storage, file);
			if (takeover) await takeOver(db, file);
			manager.appendMessage(userTurn("appended before the seal"));
			manager.seal();
			return outcome(manager.close());
		}

		it("rejects with the stop under OMP_SESSION_EXCLUSIVE=1, the turn unsaved", async () => {
			// If this fails, nothing moves or stops a sealed session, the refusal latches nothing, and close resolves.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();
			const before = await db.row(file);

			const closed = await closeAfterSeal(db, storage, true);

			expect({
				closed,
				stopped: hold.reached,
				paths: await db.paths(),
				untouched: Bun.deepEquals(await db.row(file), before),
			}).toEqual({ closed: expect.stringContaining(TAKEN_OVER), stopped: true, paths: [file], untouched: true });
		}, 30_000);

		it("moves the session to a sibling that holds the turn without OMP_SESSION_EXCLUSIVE=1", async () => {
			// If this fails, close resolves with the turn stored nowhere, or before the move's copy of the session's
			// artifacts and subagent transcripts reached the sibling's folder, though a mode exits right after the close.
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const file = sessionFile(db);
			const stem = file.slice(0, -".jsonl".length);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.writeText(path.join(stem, "Worker.jsonl"), subagentHeader());
			await storage.drain();
			// Tool artifacts beside the session on disk: enough that the copy outlasts the rest of the close.
			const ARTIFACTS = 400;
			await fs.promises.mkdir(stem, { recursive: true });
			for (let n = 0; n < ARTIFACTS; n++) await Bun.write(path.join(stem, `${n}.bash.log`), "x".repeat(4096));
			const before = await db.row(file);

			const closed = await closeAfterSeal(db, storage, true);
			await storage.drain();

			const folder = path.dirname(file);
			const siblings = (await db.paths()).filter(stored => stored !== file && path.dirname(stored) === folder);
			const [first] = siblings;
			const sibling = first === undefined ? undefined : await db.row(first);
			const siblingStem = first?.slice(0, -".jsonl".length);
			const copy = siblingStem === undefined ? undefined : await db.row(path.join(siblingStem, "Worker.jsonl"));
			const copiedArtifacts = await fs.promises.readdir(siblingStem ?? folder).catch(() => [] as string[]);
			expect({
				closed,
				siblings: siblings.length,
				turnInSibling: sibling?.content.includes("appended before the seal"),
				subagentCopied: copy?.content === subagentHeader(),
				artifactsCopied: copiedArtifacts.filter(name => name.endsWith(".bash.log")).length,
				untouched: Bun.deepEquals(await db.row(file), before),
			}).toEqual({
				closed: "resolved",
				siblings: 1,
				turnInSibling: true,
				subagentCopied: true,
				artifactsCopied: ARTIFACTS,
				untouched: true,
			});
		}, 30_000);

		it("negative control: resolves with the turn stored when no other holder took the lease over", async () => {
			// The negative control of the cases above, which passes without this change too: the same close with the
			// lease still this store's.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.drain();

			const closed = await closeAfterSeal(db, storage, false);

			expect({
				closed,
				stopped: hold.reached,
				paths: await db.paths(),
				turnStored: (await db.row(file))?.content.includes("appended before the seal"),
			}).toEqual({ closed: "resolved", stopped: false, paths: [file], turnStored: true });
		}, 30_000);
	});
}

/** The first line of a subagent transcript the task tool writes under its parent's stem. */
function subagentHeader(): string {
	const header = { type: "session", version: 3, id: "Worker", timestamp: "2026-11-17T00:00:00.000Z", cwd: "/w" };
	return `${JSON.stringify(header)}\n`;
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`a sealed subagent transcript under a parent another holder took over (${adapter})`, () => {
		for (const variable of [false, true]) {
			const label = variable ? "with" : "without";
			it(`closes as before this change: no move of its own, no stop line naming it (${label} OMP_SESSION_EXCLUSIVE=1)`, async () => {
				// If this fails, the sealed-close latch takes a subagent transcript for a main session: it moves to
				// siblings under the parent's stem and close rejects (without the variable), or it stops the process
				// naming the subagent (with it). The parent's own loss is as before this change: the parent moves to a
				// sibling of its own (without the variable) or stops (with it).
				const before = process.env.OMP_SESSION_EXCLUSIVE;
				if (variable) process.env.OMP_SESSION_EXCLUSIVE = "1";
				else delete process.env.OMP_SESSION_EXCLUSIVE;
				const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				try {
					await using db = await openLeaseDb(adapter, url ?? "");
					const storage = await db.open({ lease: STILL });
					const hold = holdClaimRelease(storage);
					const file = sessionFile(db);
					const stem = file.slice(0, -".jsonl".length);
					const child = path.join(stem, "Worker.jsonl");
					await storage.writeText(file, transcript(ID, "before"));
					await storage.writeText(child, subagentHeader());
					await storage.drain();
					const parent = await resume(storage, file);
					const subagent = await SessionManager.open(child, undefined, storage, { suppressBreadcrumb: true });
					const notices: string[] = [];
					subagent.onPersistenceNotice(notice => notices.push(notice.to));
					subagent.appendMessage(assistantTurn("the subagent's stored answer"));
					await subagent.flush();
					const release = await takeOver(db, file);
					subagent.appendMessage(userTurn("the subagent's late turn"));
					subagent.seal();

					const closed = await outcome(subagent.close());
					// With the variable, the parent's stop names it once its holder lookup ends.
					if (variable) await until(() => hold.reached, 15_000, { what: "the parent's stop" });

					const stopLine = /^Session (\S+) stops \(/;
					const stopIds = stderr.mock.calls.flatMap(([chunk]) => stopLine.exec(String(chunk))?.[1] ?? []);
					expect({
						closed,
						notices,
						subagentFile: subagent.getSessionFile(),
						underParentStem: (await db.paths()).filter(stored => stored.startsWith(`${stem}${path.sep}`)),
						stopIds,
					}).toEqual({
						closed: "resolved",
						notices: [],
						subagentFile: child,
						underParentStem: [child],
						stopIds: variable ? [ID] : [],
					});
					release();
					if (!variable) await outcome(parent.close());
				} finally {
					stderr.mockRestore();
					if (before === undefined) delete process.env.OMP_SESSION_EXCLUSIVE;
					else process.env.OMP_SESSION_EXCLUSIVE = before;
				}
			}, 60_000);
		}
	});

	describe.skipIf(!url)(`AgentSession.switchSession after an OMP_SESSION_EXCLUSIVE=1 stop (${adapter})`, () => {
		it("keeps the turn the stop left unsaved, so flush, flushSync and close reject with the stop", async () => {
			// If this fails, the switch's rollback puts back the manager's state from before the turn: the turn is
			// dropped, the file reads as current, and flush and close resolve with the turn stored nowhere.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const tempDir = TempDir.createSync("@omp-exclusive-stop-switch-");
			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("anthropic", "test-key");
			try {
				const storage = await db.open({ lease: STILL });
				holdClaimRelease(storage);
				const file = sessionFile(db);
				const otherFile = path.join(path.dirname(file), `2026-11-17T00-00-00-000Z_${OTHER_ID}.jsonl`);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.writeText(otherFile, transcript(OTHER_ID, "another session"));
				await storage.drain();
				const manager = await resume(storage, file);
				const model = getBundledModel("anthropic", "claude-sonnet-4-5");
				if (!model) throw new Error("expected the bundled anthropic claude-sonnet-4-5");
				const session = new AgentSession({
					agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
					sessionManager: manager,
					settings: Settings.isolated(),
					modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
					agentId: "Main",
				});
				const before = await db.row(file);
				const release = await takeOver(db, file);
				// A turn appended as the switch begins (a switch hook, a work pool's record): its write is the first to
				// meet the fence.
				const switchFile = manager.setSessionFile.bind(manager);
				manager.setSessionFile = ((target, options) => {
					manager.appendMessage(userTurn("appended as the switch begins"));
					return switchFile(target, options);
				}) as SessionManager["setSessionFile"];

				const switched = await outcome(session.switchSession(otherFile));
				const flushed = await outcome(manager.flush());
				const sync = syncOutcome(manager);
				const closed = await outcome(manager.close());

				const stop = expect.stringContaining(TAKEN_OVER);
				expect({
					switched,
					flushed,
					sync,
					closed,
					file: manager.getSessionFile(),
					untouched: Bun.deepEquals(await db.row(file), before),
				}).toEqual({ switched: stop, flushed: stop, sync: stop, closed: stop, file, untouched: true });
				release();
			} finally {
				authStorage.close();
				AsyncJobManager.resetForTests();
				tempDir.removeSync();
			}
		}, 60_000);
	});

	describe.skipIf(!url)(`setSessionFile on a session that stopped under OMP_SESSION_EXCLUSIVE=1 (${adapter})`, () => {
		it("takes no lease of the target: it rejects at once, without waiting for the target's holder", async () => {
			// If this fails, the stopped manager first waits for and takes the target's lease, then rejects.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			const otherFile = path.join(path.dirname(file), `2026-11-17T00-00-00-000Z_${OTHER_ID}.jsonl`);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.writeText(otherFile, transcript(OTHER_ID, "another session"));
			await storage.drain();
			const manager = await resume(storage, file);
			const release = await takeOver(db, file);
			manager.appendMessage(userTurn("refused by the fence"));
			await until(() => hold.reached, 15_000, { what: "the stop to reach its release of the store's claims" });
			await using holder = await anotherProcess(db);
			expect((await holder.run({ op: "claim", sessionId: OTHER_ID, path: otherFile })).held).toBe(true);
			let waited = false;

			const switched = await outcome(
				manager.setSessionFile(otherFile, {
					claim: {
						waitMs: 20_000,
						onWait: () => {
							waited = true;
						},
					},
				}),
			);

			expect({ switched, waited, file: manager.getSessionFile() }).toEqual({
				switched: expect.stringContaining(TAKEN_OVER),
				waited: false,
				file,
			});
			release();
		}, 60_000);
	});
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a switch whose drain first sees an OMP_SESSION_EXCLUSIVE=1 stop (${adapter})`, () => {
		it("refuses before it gives up the claim of the session that stopped", async () => {
			// If this fails, the switch releases the stopped session's claim before it refuses (it refuses only after
			// it loaded the target): another process can claim the session while this one still lives, its turn unsaved.
			using _exclusive = exclusive();
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ lease: STILL });
			const hold = holdClaimRelease(storage);
			const file = sessionFile(db);
			const otherFile = path.join(path.dirname(file), `2026-11-17T00-00-00-000Z_${OTHER_ID}.jsonl`);
			await storage.writeText(file, transcript(ID, "before"));
			await storage.writeText(otherFile, transcript(OTHER_ID, "another session"));
			await storage.drain();
			const manager = await resume(storage, file);
			manager.appendMessage(userTurn("stored before the change"));
			await manager.flush();
			// An older build puts another session over the file. The store's claim of the session stays this store's:
			// a stop for a replaced file gives it back only at the release the test holds.
			const replacement = transcript("01a1f700-0000-7000-8000-0000000000d5", "another session");
			const older = await db.open({ claims: false });
			await older.writeText(file, replacement);
			await older.drain();

			// The append meets the other session's file while the switch drains it, the first to see the replacement.
			manager.appendMessage(userTurn("refused by the size check"));
			const switched = await outcome(manager.setSessionFile(otherFile));
			// A claim the switch gave up is deleted once the store's queued work settles.
			await storage.drain().catch(() => undefined);
			await using holder = await anotherProcess(db);
			// The probe claims the session's id at a path that holds nothing: a claim at its own file, which now holds
			// another session, is refused whoever holds the id.
			const probe = path.join(db.dir.path(), "probe", path.basename(file));
			const claimedElsewhere = (await holder.run({ op: "claim", sessionId: ID, path: probe })).held;

			expect({
				switched,
				stopped: hold.reached,
				claimedElsewhere,
				file: manager.getSessionFile(),
				untouched: (await db.row(file))?.content === replacement,
			}).toEqual({
				switched: expect.stringContaining(
					`Session ${ID} stops (replaced): its file now holds another session. OMP_SESSION_EXCLUSIVE=1 keeps it from moving to another id, so it opens no other session.`,
				),
				stopped: true,
				claimedElsewhere: false,
				file,
				untouched: true,
			});
		}, 60_000);
	});
}
