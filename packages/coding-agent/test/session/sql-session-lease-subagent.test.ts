/**
 * A subagent transcript (`<parent stem>/<Agent>.jsonl`) on SQL session
 * storage is written under its parent session's lease: when another process
 * takes the parent over, the transcript follows the parent to the sibling it
 * goes on in, keeping its id, and never writes under the old stem again; when
 * the parent went on in another process, nothing says where, so the
 * transcript forks to a session of its own beside the parent's file, under a
 * lease it takes there, losing no entry. Ported from 4de591c2's
 * `sql-session-lease-two-writers.test.ts` (`#followParentMove`), less its
 * `.continuation` marker, which this build never writes. SQLite always;
 * PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import {
	LEASE_BACKENDS,
	type LeaseDb,
	LeaseProcess,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
} from "./sql-session-lease-fixture";

// A holder process loads the whole module graph before it opens a session,
// which takes seconds on a loaded box; these tests wait in real time for that.

/** Timings under which no heartbeat runs during a test, so a lease moved back stays put. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

function userTurn(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** `file`'s artifacts directory, under which its subagent transcripts are keyed. */
function stemOf(file: string): string {
	return file.slice(0, -".jsonl".length);
}

/** The first line of a subagent transcript the task tool writes under its parent's stem. */
function subagentHeader(): string {
	return `${JSON.stringify({ type: "session", version: 3, id: "Worker", timestamp: new Date().toISOString(), cwd: "/w" })}\n`;
}

/**
 * A session this process writes (and so holds), with one turn and its reply, published, and a subagent transcript.
 * `lease` sets the owner's store timings (with {@link STILL}, no heartbeat refreshes a lease the test moved back).
 */
async function ownedSession(
	db: LeaseDb,
	lease?: { expiryMs: number; heartbeatMs: number },
): Promise<{ owner: SessionManager; file: string; child: string }> {
	const owner = SessionManager.create(
		db.dir.join("project"),
		db.dir.join("sessions", "-project-"),
		await db.open(lease ? { lease } : {}),
	);
	owner.appendMessage(userTurn("first writer's turn"));
	owner.appendMessage(createAssistantMessage("first writer's reply"));
	await owner.flush();
	const file = owner.getSessionFile();
	if (!file) throw new Error("the session has no file");
	const child = path.join(stemOf(file), "Worker.jsonl");
	await owner.getStorage().writeText(child, subagentHeader());
	await owner.getStorage().drain();
	return { owner, file, child };
}

/** Every stored path under `stem`'s artifacts directory. */
async function pathsUnder(db: LeaseDb, stem: string): Promise<string[]> {
	return (await db.paths()).filter(file => file.startsWith(`${stem}${path.sep}`));
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`a subagent transcript of a ${adapter} session another process takes over`, () => {
		it("a live subagent transcript follows its parent to the sibling the parent moves to when another process takes the lease over", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { owner, file, child } = await ownedSession(db);
			// The writer that created them closes, releasing the lease.
			await owner.close();
			await using holder = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("holder"),
			);
			const opened = await holder.run({ op: "hold", file, sessionDir: path.dirname(file), subagent: child });
			expect([opened.error, opened.sessionFile]).toEqual([undefined, file]);
			expect((await holder.run({ op: "append", text: "parent's first turn" })).sessionFile).toBe(file);
			expect((await holder.run({ op: "appendSubagent", text: "subagent's first turn" })).sessionFile).toBe(child);

			// The holder looks dead to the database: another process takes the lease over.
			await db.ageLease(opened.sessionId ?? "", STILL.expiryMs + 30_000);
			const taker = await SessionManager.open(file, undefined, await db.open({ lease: STILL }));
			try {
				taker.appendMessage(userTurn("taker's turn"));
				await taker.flush();
				expect(taker.getSessionFile()).toBe(file);

				// The subagent writes first, while its parent is idle.
				const subagentLate = await holder.run({ op: "appendSubagent", text: "subagent's late turn" });
				const parentLate = await holder.run({ op: "append", text: "parent's late turn" });
				expect([subagentLate.error, parentLate.error]).toEqual([undefined, undefined]);
				const parentFile = parentLate.sessionFile ?? "";
				expect(parentFile).not.toBe(file);
				expect(path.dirname(parentFile)).toBe(path.dirname(file));
				expect(subagentLate.sessionFile).toBe(path.join(stemOf(parentFile), "Worker.jsonl"));
				expect(subagentLate.sessionId).toBe("Worker");

				const sibling = (await db.row(parentFile))?.content ?? "";
				expect(sibling).toContain("parent's first turn");
				expect(sibling).toContain("parent's late turn");
				const movedChild = (await db.row(subagentLate.sessionFile ?? ""))?.content ?? "";
				expect(movedChild).toContain('"id":"Worker"');
				expect(movedChild).toContain("subagent's first turn");
				expect(movedChild).toContain("subagent's late turn");

				// Nothing the holder wrote after the takeover is at the old keys.
				const old = (await db.row(file))?.content ?? "";
				expect(old).toContain("taker's turn");
				expect(old).not.toContain("parent's late turn");
				expect((await db.row(child))?.content).not.toContain("subagent's late turn");
				expect(await pathsUnder(db, stemOf(file))).toEqual([child]);
				// The move leaves no pointer: this build writes no continuation marker.
				expect(await db.row(`${stemOf(file)}.continuation`)).toBeUndefined();
			} finally {
				await taker.close();
			}
		}, 60_000);

		it("does not follow a move-off its parent made before it closed: a later subagent transcript whose lease is lost forks", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { owner, file } = await ownedSession(db, STILL);
			const sessionId = owner.getSessionId();
			// Another process takes the session over; the owner's next write moves it off to a sibling, then it closes.
			await db.ageLease(sessionId, STILL.expiryMs + 30_000);
			await using taker = await LeaseProcess.start(
				{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
				db.dir.join("taker"),
			);
			const taken = await taker.run({ op: "hold", file, sessionDir: path.dirname(file) });
			expect([taken.error, taken.sessionFile]).toEqual([undefined, file]);
			owner.appendMessage(userTurn("owner's late turn"));
			await owner.flush();
			const sibling = owner.getSessionFile() ?? "";
			expect(sibling === file).toBe(false);
			await owner.close();

			// Later, a subagent transcript of the session appears (written by a store that claims nothing, since the taker
			// holds the lease), and this process opens and writes it.
			const late = path.join(stemOf(file), "Late.jsonl");
			const unclaimed = await db.open({ claims: false });
			await unclaimed.writeText(late, subagentHeader());
			await unclaimed.drain();
			const storage = await db.open({ lease: STILL });
			const subagent = await SessionManager.open(late, undefined, storage, { suppressBreadcrumb: true });
			try {
				subagent.appendMessage(userTurn("late subagent's turn"));
				await subagent.flush().catch(() => undefined);
				const fork = subagent.getSessionFile() ?? "";
				expect({
					beside: path.dirname(fork),
					underTheClosedSibling: fork.startsWith(`${stemOf(sibling)}${path.sep}`),
					kept: ((await db.row(fork))?.content ?? "").includes("late subagent's turn"),
				}).toEqual({ beside: path.dirname(file), underTheClosedSibling: false, kept: true });
				// The move copied the session's artifacts to the sibling; the late transcript is not among them.
				expect(
					(await pathsUnder(db, stemOf(sibling))).filter(found => path.basename(found) === "Late.jsonl"),
				).toEqual([]);
			} finally {
				await subagent.close().catch(() => undefined);
			}
		}, 60_000);
	});
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a subagent transcript of a ${adapter} session another process holds`, () => {
		it("a subagent transcript whose parent another process holds forks to a session of its own beside the parent, losing no entry", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const { owner, file, child } = await ownedSession(db);
			const parentId = owner.getSessionId();
			try {
				await using holder = await LeaseProcess.start(
					{ dsn: db.dsn, table: db.table, leaseTable: db.leaseTable, lease: STILL },
					db.dir.join("holder"),
				);
				// Its parent's lease is the owner's, so the transcript is refused at open; its parent
				// goes on in no sibling in the holder's process, and nothing says where it went.
				const opened = await holder.run({ op: "hold", file: child, sessionDir: path.dirname(file) });
				const fork = opened.sessionFile ?? "";
				expect({ error: opened.error, beside: path.dirname(fork), movedOff: fork !== child }).toEqual({
					error: undefined,
					beside: path.dirname(file),
					movedOff: true,
				});

				await owner.moveTo(db.dir.join("moved"), db.dir.join("sessions", "-moved-"));
				const movedChild = path.join(stemOf(owner.getSessionFile() ?? ""), "Worker.jsonl");
				expect((await db.row(movedChild))?.content).toContain('"id":"Worker"');

				const late = await holder.run({ op: "append", text: "late child turn" });
				expect([late.error, late.sessionFile]).toEqual([undefined, fork]);
				const forked = (await db.row(fork))?.content ?? "";
				const header = JSON.parse(forked.split("\n").find(line => line.includes('"type":"session"')) ?? "{}");
				expect({
					parentSession: header.parentSession,
					continuationOf: header.continuationOf,
					kept: [`held by ${holder.pid}`, "late child turn"].map(text => forked.includes(text)),
				}).toEqual({ parentSession: parentId, continuationOf: undefined, kept: [true, true] });
				// Nothing was written under the parent's stem, at its old place or its new one.
				expect(await pathsUnder(db, stemOf(file))).toEqual([]);
				expect((await db.row(movedChild))?.content).not.toContain("late child turn");
			} finally {
				await owner.close();
			}
		}, 60_000);
	});
}
