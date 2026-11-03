/**
 * `SqlSessionStorage` session leases (spec R3, "Lease and fenced writes"):
 * the claim, the fence every content write under a session's key prefix
 * carries, expiry and takeover on the database clock, the heartbeat, release
 * on close, the lease probe, and the writes no lease fences. Each store has its
 * own client and holder token, as a separate process has. SQLite always;
 * PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	SessionLeaseLostError,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createSessionSqlClient } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SESSION_LEASE_EXPIRY_MS, SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb } from "../helpers/sql-lease-fixture";

let previousStorage: SessionStorage;

beforeEach(() => {
	previousStorage = defaultSessionStorage();
});

afterEach(() => {
	setDefaultSessionStorage(previousStorage);
});

const SESSION_ID = "01a19f00-0000-7000-8000-000000000001";

/** The file of session {@link SESSION_ID} in a project directory under the fixture's sessions root. */
function sessionFile(db: LeaseDb, id = SESSION_ID): string {
	return path.join(db.root, "-project-", `2026-11-03T00-00-00-000Z_${id}.jsonl`);
}

function transcript(id: string, text: string): string {
	const timestamp = "2026-11-03T00:00:00.000Z";
	return `${[
		{ type: "session", version: 3, id, timestamp, cwd: "/project" },
		{ type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: text, timestamp: 1 } },
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

/** The error `promise` rejects with; fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(err: unknown) => err,
	);
}

/**
 * Wait until `check` holds, polling; fails after `ms`. The heartbeat is a
 * real database statement on a real (shortened) interval, so the test waits
 * for its effect in the database rather than advancing fake timers.
 */
async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("the condition did not hold in time");
		await Bun.sleep(20);
	}
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`${adapter} session leases`, () => {
		it("refuses a second holder's writes under a held session and changes nothing", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = await db.open();
			const other = await db.open();
			const file = sessionFile(db);
			const release = owner.claimSession(SESSION_ID, file);
			try {
				await owner.writeText(file, transcript(SESSION_ID, "owner"));
				const before = await db.row(file);

				const claimed = other.claimSession(SESSION_ID, file);
				const writer = other.openWriter(file);
				const refused = await rejection(writer.append('{"type":"message"}\n'));
				expect(refused).toBeInstanceOf(SessionLeaseLostError);
				expect(refused).toMatchObject({ path: file, sessionId: SESSION_ID });
				expect(other.isSessionClaimLost(file)).toBe(true);
				// A claim the store knows lost refuses at once, every content write alike.
				expect(await rejection(other.writeText(file, "replaced"))).toBeInstanceOf(SessionLeaseLostError);
				expect(await rejection(other.writeText(path.join(file.slice(0, -6), "Worker.jsonl"), "x"))).toBeInstanceOf(
					SessionLeaseLostError,
				);
				await other.refresh({ kind: "session", file });
				expect(await rejection(other.unlink(file))).toBeInstanceOf(SessionLeaseLostError);
				expect(await db.row(file)).toEqual(before);
				await writer.close().catch(() => undefined);
				claimed();

				// A store that never claimed is refused too while the owner's lease is fresh.
				const bystander = await db.open();
				expect(await rejection(bystander.writeText(file, "replaced"))).toBeInstanceOf(SessionLeaseLostError);
				expect(await db.row(file)).toEqual(before);
				expect(owner.isSessionClaimLost(file)).toBe(false);
			} finally {
				release();
			}
		});

		it("lets two stores claiming one free session at once both write only one of them", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const stores = [await db.open(), await db.open()];
			const file = sessionFile(db);
			const releases = stores.map(store => store.claimSession(SESSION_ID, file));
			const outcomes = await Promise.allSettled(
				stores.map((store, index) => store.writeText(file, transcript(SESSION_ID, `writer ${index}`))),
			);
			expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
			const [refused] = outcomes.filter(outcome => outcome.status === "rejected");
			expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(SessionLeaseLostError);
			expect(await db.leases(SESSION_ID)).toHaveLength(1);
			for (const release of releases) release();
		});

		it("takes over a lease whose heartbeat expired; the old holder's append then changes nothing", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const stale = await db.open();
			const next = await db.open();
			const file = sessionFile(db);
			const releaseStale = stale.claimSession(SESSION_ID, file);
			await stale.writeText(file, transcript(SESSION_ID, "stale holder"));
			// The database clock, not a 90 s sleep: the holder stopped heartbeating long ago.
			await db.ageLease(SESSION_ID, SESSION_LEASE_EXPIRY_MS + 30_000);

			const releaseNext = next.claimSession(SESSION_ID, file);
			await next.refresh({ kind: "session", file });
			await next.openWriter(file).append('{"type":"next"}\n');
			const taken = await db.row(file);
			expect(taken?.content).toContain('{"type":"next"}');

			// The stale holder's token no longer holds the lease: its append affects 0 rows.
			const refused = await rejection(stale.openWriter(file).append('{"type":"stale"}\n'));
			expect(refused).toBeInstanceOf(SessionLeaseLostError);
			expect(stale.isSessionClaimLost(file)).toBe(true);
			expect(await db.row(file)).toEqual(taken);
			expect(await db.leases(SESSION_ID)).toHaveLength(1);
			releaseStale();
			releaseNext();
		});

		it("keeps a held lease fresh with heartbeats, notices a takeover, and deletes the row on close", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const storage = await db.open({ leaseHeartbeatMs: 40 });
			const manager = SessionManager.create(db.dir.join("project"), path.join(db.root, "-project-"), storage);
			await manager.ensureOnDisk();
			const id = manager.getSessionId();
			const file = manager.getSessionFile() ?? "";
			await manager.flush();
			expect(await db.leases(id)).toHaveLength(1);

			await db.ageLease(id, 60_000);
			await until(async () => ((await db.leases(id))[0]?.ageMs ?? Number.POSITIVE_INFINITY) < 10_000);

			await manager.close();
			expect(await db.leases(id)).toEqual([]);

			// A lease another holder took is noticed by the next heartbeat.
			const release = storage.claimSession(id, file);
			await storage.writeText(file, transcript(id, "again"));
			await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [id]);
			await until(() => storage.isSessionClaimLost(file));
			expect(await rejection(storage.writeText(file, "lost"))).toBeInstanceOf(SessionLeaseLostError);
			release();
		});

		it("refuses a picker delete while another holder's lease is fresh, and deletes once it is released", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = SessionManager.create(db.dir.join("project"), path.join(db.root, "-project-"), await db.open());
			await owner.ensureOnDisk();
			const file = owner.getSessionFile() ?? "";
			await owner.flush();
			const picker = await db.open();

			const refused = await rejection(picker.deleteSessionWithArtifacts(file));
			expect(refused).toBeInstanceOf(SessionLeaseLostError);
			expect(String(refused)).toContain("another omp process holds the lease");
			expect(await db.row(file)).toBeDefined();

			await owner.close();
			await picker.deleteSessionWithArtifacts(file);
			expect(await db.row(file)).toBeUndefined();
		});

		it("never fences markers or title updates", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = await db.open();
			const other = await db.open();
			const file = sessionFile(db);
			const release = owner.claimSession(SESSION_ID, file);
			await owner.writeText(file, transcript(SESSION_ID, "owner"));

			const marker = `${file.slice(0, -6)}.continuation`;
			await other.writeText(marker, "01a19f00-0000-7000-8000-000000000002");
			expect((await db.row(marker))?.content).toBe("01a19f00-0000-7000-8000-000000000002");
			await other.refresh({ kind: "session", file });
			await other.updateSessionTitle(file, { title: "renamed elsewhere", source: "user", updatedAt: "2026-11-03" });
			const [row] = await db.sql(`SELECT title FROM ${db.table} WHERE path = @1`, [db.key(file)]);
			expect(row?.title).toBe("renamed elsewhere");
			release();
		});

		it("renames a session another process holds by its title columns alone, without moving it", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = SessionManager.create(db.dir.join("project"), path.join(db.root, "-project-"), await db.open());
			await owner.ensureOnDisk();
			const file = owner.getSessionFile() ?? "";
			await owner.flush();
			const before = await db.row(file);
			try {
				const picker = await db.open();
				setDefaultSessionStorage(picker);
				expect(await SessionManager.renameSessionTitle(file, "  picked\nname ")).toBe("picked name");
				expect(await db.row(file)).toEqual(before);
				expect(await db.keysUnder(path.dirname(file))).toEqual([db.key(file)]);
				const [row] = await db.sql(`SELECT title, title_source FROM ${db.table} WHERE path = @1`, [db.key(file)]);
				expect(row).toMatchObject({ title: "picked name", title_source: "user" });
				expect(picker.isSessionClaimLost(file)).toBe(false);
			} finally {
				await owner.close();
			}
		});

		it("refuses to rename a transcript written before title slots while another process holds it, and changes nothing", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = await db.open();
			const file = sessionFile(db);
			const release = owner.claimSession(SESSION_ID, file);
			// No title slot: the rename would have to write one in front, a content write.
			await owner.writeText(file, transcript(SESSION_ID, "older omp"));
			await owner.drain();
			const before = await db.row(file);
			const titleOf = async () =>
				(await db.sql(`SELECT title, title_source FROM ${db.table} WHERE path = @1`, [db.key(file)]))[0];
			const untitled = await titleOf();
			const picker = await db.open();
			setDefaultSessionStorage(picker);

			expect(await SessionManager.renameSessionTitle(file, "picked")).toBeNull();
			expect(await db.row(file)).toEqual(before);
			expect(await titleOf()).toEqual(untitled);

			// Once the holder lets go, the same rename writes the slot and the title.
			release();
			await owner.drain();
			expect(await db.leases(SESSION_ID)).toEqual([]);
			expect(await SessionManager.renameSessionTitle(file, "picked")).toBe("picked");
			await picker.drain();
			expect((await db.row(file))?.content).toStartWith('{"type":"title"');
			expect(await titleOf()).toMatchObject({ title: "picked", title_source: "user" });
		});

		it("reports held for a session another store holds, and free once it closes", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = SessionManager.create(db.dir.join("project"), path.join(db.root, "-project-"), await db.open());
			await owner.ensureOnDisk();
			await owner.flush();
			const id = owner.getSessionId();
			const prober = await db.open();

			expect(await prober.probeSessionLeases([id, "no-such-session"])).toEqual({ held: [id], unknown: [] });
			await owner.close();
			expect(await prober.probeSessionLeases([id])).toEqual({ held: [], unknown: [] });
			// An expired lease row reads as free too.
			const release = prober.claimSession(id, path.join(db.root, "-project-", `x_${id}.jsonl`));
			await prober.writeText(path.join(db.root, "-project-", `x_${id}.jsonl`), transcript(id, "x"));
			await db.ageLease(id, SESSION_LEASE_EXPIRY_MS + 1000);
			expect(await prober.probeSessionLeases([id])).toEqual({ held: [], unknown: [] });
			release();
		});

		it("refuses createTable: false until the lease table exists", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			await db.open();
			await db.sql(`DROP TABLE ${db.leaseTable}`);
			const client = createSessionSqlClient(db.dsn);
			try {
				const error = await rejection(
					SqlSessionStorage.create({ client, table: db.table, leaseTable: db.leaseTable, createTable: false }),
				);
				expect(String(error)).toContain(`no table ${db.leaseTable}`);
			} finally {
				await client.end();
			}
		});
	});
}
