/**
 * Two processes cannot both append to one SQL session (spec R3, R4; A3).
 * Each test runs a second omp process (a `SessionManager` on its own
 * `SqlSessionStorage` and database client) against the session this process
 * writes. The process that writes a session first holds its lease; the
 * other's write is refused by the database and takes the lost-lease path to a
 * sibling session, which the continuation marker names and a later resume
 * follows. A move is a fenced write too: a session another live process holds
 * is never moved, and a holder's write after a move never lands at the old
 * key. SQLite always; PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	findRecentSessionContinuation,
	findSessionContinuation,
	resolveResumeTarget,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager, SessionMoveRefusedError } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SESSION_LEASE_EXPIRY_MS } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, SqlSessionHolder } from "../helpers/sql-lease-fixture";

/** A holder process loads the whole module graph before it opens the session; a loaded box takes seconds. */
const HOLDER_TEST_MS = 60_000;

let previousStorage: SessionStorage;

beforeEach(() => {
	previousStorage = defaultSessionStorage();
});

afterEach(() => {
	setDefaultSessionStorage(previousStorage);
});

function userTurn(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantTurn(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** A session this process writes (and so holds), with one turn and its reply, published. */
async function ownedSession(db: LeaseDb): Promise<{ owner: SessionManager; file: string; cwd: string; dir: string }> {
	const cwd = db.dir.join("project");
	const dir = path.join(db.root, "-project-");
	const owner = SessionManager.create(cwd, dir, await db.open());
	owner.appendMessage(userTurn("first writer's turn"));
	owner.appendMessage(assistantTurn("first writer's reply"));
	await owner.flush();
	const file = owner.getSessionFile();
	if (!file) throw new Error("the session has no file");
	return { owner, file, cwd, dir };
}

/** `file`'s artifacts directory, under which its subagent transcripts are keyed. */
function stemOf(file: string): string {
	return file.slice(0, -".jsonl".length);
}

/** The first line of a subagent transcript the task tool writes under its parent's stem. */
function subagentHeader(): string {
	return `${JSON.stringify({ type: "session", version: 3, id: "Worker", timestamp: new Date().toISOString(), cwd: "/w" })}\n`;
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`two processes writing one ${adapter} session`, () => {
		it(
			"the second process's first write lands in a sibling; the first row holds the first writer's bytes alone",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { owner, file, cwd, dir } = await ownedSession(db);
				try {
					const { holder, opened } = await SqlSessionHolder.open(db, file);
					await using _holder = holder;
					expect(opened.file).toBe(file);

					const second = await holder.append("second writer's turn");
					owner.appendMessage(userTurn("first writer's later turn"));
					await owner.flush();

					const first = await db.row(file);
					expect(first?.content).toContain("first writer's later turn");
					expect(first?.content).not.toContain("second writer's turn");
					// `byte_len` counts the first writer's bytes alone: exactly what its own store wrote.
					expect(first?.byteLen).toBe(Buffer.byteLength(first?.content ?? "", "utf8"));
					expect(first?.byteLen).toBe(owner.getStorage().statSync(file).size);

					expect(second.error).toBeUndefined();
					expect(second.file).not.toBe(file);
					expect(path.dirname(second.file)).toBe(path.dirname(file));
					const sibling = await db.row(second.file);
					expect(sibling?.content).toContain("second writer's turn");
					// The whole transcript the second process loaded went with it, published once.
					expect(sibling?.content).toContain("first writer's reply");
					expect((await db.row(`${stemOf(file)}.continuation`))?.content).toBe(second.id);
					expect((await holder.exit()).error).toBeUndefined();

					// A later resume of the old session follows the marker to the newest continuation.
					const reader = await db.open();
					setDefaultSessionStorage(reader);
					expect((await findSessionContinuation(file, reader))?.session.path).toBe(second.file);
					expect((await findRecentSessionContinuation(file, reader))?.session.path).toBe(second.file);
					const target = await resolveResumeTarget(opened.id, cwd, dir);
					expect(target?.session.path).toBe(second.file);
					expect(target?.continuation?.from).toBe(file);
				} finally {
					await owner.close();
				}
			},
			HOLDER_TEST_MS,
		);

		it(
			"a fork is never followed",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { owner, file, cwd, dir } = await ownedSession(db);
				const id = owner.getSessionId();
				try {
					const forked = await owner.fork();
					owner.appendMessage(userTurn("a turn of the fork"));
					await owner.flush();
					expect(forked?.newSessionFile).toBe(owner.getSessionFile());

					const reader = await db.open();
					setDefaultSessionStorage(reader);
					expect(await findSessionContinuation(file, reader)).toBeUndefined();
					expect((await resolveResumeTarget(id, cwd, dir))?.session.path).toBe(file);
				} finally {
					await owner.close();
				}
			},
			HOLDER_TEST_MS,
		);

		it(
			"a holder's append after another process moved the session lands in a sibling, never at the old key",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { owner, file } = await ownedSession(db);
				try {
					const { holder } = await SqlSessionHolder.open(db, file);
					await using _holder = holder;

					await owner.moveTo(db.dir.join("moved"), path.join(db.root, "-moved-"));
					const moved = owner.getSessionFile() ?? "";
					expect(moved).not.toBe(file);

					const late = await holder.append("late turn");
					expect(await db.row(file)).toBeUndefined();
					expect((await db.row(moved))?.content).not.toContain("late turn");
					expect(late.error).toBeUndefined();
					expect(late.file).not.toBe(file);
					expect(path.dirname(late.file)).toBe(path.dirname(file));
					expect((await db.row(late.file))?.content).toContain("late turn");
					await holder.exit();
				} finally {
					await owner.close();
				}
			},
			HOLDER_TEST_MS,
		);

		it(
			"a holder of a subagent transcript cannot append once another process moved its parent session",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { owner, file } = await ownedSession(db);
				try {
					const child = path.join(stemOf(file), "Worker.jsonl");
					await owner.getStorage().writeText(child, subagentHeader());
					const { holder } = await SqlSessionHolder.open(db, child);
					await using _holder = holder;

					await owner.moveTo(db.dir.join("moved"), path.join(db.root, "-moved-"));
					const movedChild = path.join(stemOf(owner.getSessionFile() ?? ""), "Worker.jsonl");
					expect((await db.row(movedChild))?.content).toContain('"id":"Worker"');

					const late = await holder.append("late child turn");
					// The parent moved without going on in a sibling, so there is nothing to follow.
					expect(late.error).toContain("did not go on in a sibling");
					expect(await db.keysUnder(stemOf(file))).toEqual([]);
					expect((await db.row(movedChild))?.content).not.toContain("late child turn");
					await holder.exit();
				} finally {
					await owner.close();
				}
			},
			HOLDER_TEST_MS,
		);

		it(
			"a live subagent transcript follows its parent to the sibling the parent moves to when another process takes the lease over",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { owner, file } = await ownedSession(db);
				const child = path.join(stemOf(file), "Worker.jsonl");
				await owner.getStorage().writeText(child, subagentHeader());
				// The writer that created them closes, releasing the lease.
				await owner.close();
				// The holder never heartbeats during the test, so moving its heartbeat back stays put.
				const { holder, opened } = await SqlSessionHolder.open(db, file, {
					subagent: child,
					leaseHeartbeatMs: 3_600_000,
				});
				await using _holder = holder;
				expect((await holder.append("parent's first turn")).file).toBe(file);
				expect((await holder.appendSubagent("subagent's first turn")).file).toBe(child);

				// The holder looks dead to the database: another process takes the lease over.
				await db.ageLease(opened.id, SESSION_LEASE_EXPIRY_MS + 30_000);
				const taker = await SessionManager.open(file, undefined, await db.open());
				try {
					taker.appendMessage(userTurn("taker's turn"));
					await taker.flush();
					expect(taker.getSessionFile()).toBe(file);

					// The subagent writes first, while its parent is idle.
					const subagentLate = await holder.appendSubagent("subagent's late turn");
					const parentLate = await holder.append("parent's late turn");
					expect([subagentLate.error, parentLate.error]).toEqual([undefined, undefined]);
					expect(parentLate.file).not.toBe(file);
					expect(path.dirname(parentLate.file)).toBe(path.dirname(file));
					expect(subagentLate.file).toBe(path.join(stemOf(parentLate.file), "Worker.jsonl"));
					expect(subagentLate.id).toBe("Worker");

					const sibling = (await db.row(parentLate.file))?.content ?? "";
					expect(sibling).toContain("parent's first turn");
					expect(sibling).toContain("parent's late turn");
					const movedChild = (await db.row(subagentLate.file))?.content ?? "";
					expect(movedChild).toContain('"id":"Worker"');
					expect(movedChild).toContain("subagent's first turn");
					expect(movedChild).toContain("subagent's late turn");

					// Nothing the holder wrote after the takeover is at the old keys.
					const old = (await db.row(file))?.content ?? "";
					expect(old).toContain("taker's turn");
					expect(old).not.toContain("parent's late turn");
					expect((await db.row(child))?.content).not.toContain("subagent's late turn");
					expect(await db.keysUnder(stemOf(file))).toEqual([db.key(child)]);
					expect((await db.row(`${stemOf(file)}.continuation`))?.content).toBe(parentLate.id);
					expect((await holder.exit()).error).toBeUndefined();
				} finally {
					await taker.close();
				}
			},
			HOLDER_TEST_MS,
		);

		it(
			"a move of a session another live process holds is refused and moves nothing",
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { owner, file } = await ownedSession(db);
				// The writer that created it closes, releasing the lease.
				await owner.close();
				const { holder } = await SqlSessionHolder.open(db, file);
				await using _holder = holder;
				expect((await holder.append("holder's turn")).file).toBe(file);

				const mover = await SessionManager.open(file, undefined, await db.open());
				try {
					const destinationDir = path.join(db.root, "-moved-");
					const error = await mover.moveTo(db.dir.join("moved"), destinationDir).then(
						() => undefined,
						(err: unknown) => err,
					);
					expect(error).toBeInstanceOf(SessionMoveRefusedError);
					expect(mover.getSessionFile()).toBe(file);
					expect((await db.row(file))?.content).toContain("holder's turn");
					expect(await db.row(path.join(destinationDir, path.basename(file)))).toBeUndefined();
				} finally {
					await mover.close();
				}
				expect((await holder.exit()).error).toBeUndefined();
			},
			HOLDER_TEST_MS,
		);
	});
}
