/**
 * Reads a SQL store makes through its own backend, which another store on the
 * same database races with a full rewrite right after the first stored part
 * the read fetched:
 *
 * - the session listing's line scan (`scanLines`), which finds a first prompt
 *   or a reply the bounded head and tail windows miss, gives one body's
 *   prompt and reply;
 * - the read-back after a failed atomic publish, which decides whether the
 *   body landed anyway, never takes the other store's body for its own.
 *
 * Runs on SQLite always, and on PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type {
	SqlSessionStorageClient,
	SqlSessionStorageResult,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { line, MiB, partRace, STILL, TIMESTAMP } from "./chunked-read-race";
import { LEASE_BACKENDS, openLeaseDb, rejection } from "./sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000f1";
const LOST_REPLY = "the connection closed before the commit's reply came back";

/**
 * A session whose first prompt and reply sit past the 4 KiB head window,
 * behind a leading entry of 1.5 MiB (a memory recall), and before the 32 KiB
 * tail window: only a line scan finds them. Its second stored part holds them.
 */
function listedBody(fill: string): string[] {
	const pad = (id: string, bytes: number) =>
		line({ type: "custom", customType: "pad", id, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(bytes) });
	return [
		line({ type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/project" }),
		pad("recall", MiB + MiB / 2),
		line({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: { role: "user", content: `prompt ${fill}`, timestamp: 1 },
		}),
		line({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: TIMESTAMP,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `reply ${fill}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				stopReason: "stop",
				timestamp: 2,
			},
		}),
		pad("tail", 64 * 1024),
	];
}

/**
 * A client whose next full write commits its swap of the new parts and then
 * fails, as a write whose connection closes before the commit's reply comes
 * back does: the body landed, and the writer cannot tell.
 */
function lostCommitReply(): {
	wrap: (client: SqlSessionStorageClient) => SqlSessionStorageClient;
	arm(): void;
} {
	let armed = false;
	let swapped = false;
	const lost = (): boolean => {
		if (!armed || !swapped) return false;
		armed = false;
		swapped = false;
		return true;
	};
	const exec = async (
		executor: SqlSessionStorageTransaction,
		query: string,
		values: unknown[] | undefined,
	): Promise<SqlSessionStorageResult> => {
		const result = await executor.unsafe(query, values);
		if (armed && /^UPDATE \S+_parts SET path = /.test(query)) swapped = true;
		// SQLite's transactions are statements on the client.
		if (query === "COMMIT" && lost()) throw new Error(LOST_REPLY);
		return result;
	};
	return {
		wrap: client => ({
			options: client.options,
			unsafe: (query, values) => exec(client, query, values),
			transaction: async callback => {
				await client.transaction(transaction =>
					callback({ unsafe: (query, values) => exec(transaction, query, values) }),
				);
				if (lost()) throw new Error(LOST_REPLY);
			},
			end: () => client.end?.() ?? Promise.resolve(),
		}),
		arm() {
			armed = true;
		},
	};
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`a SQL store's own read that another store's full rewrite races (${adapter})`, () => {
		it("lists one body's first prompt and reply when the line scan that finds them is raced", async () => {
			// If this regresses, the session picker shows a session another process is rewriting as
			// "(no messages)" with no reply, so it reads as empty and cannot be told apart from the others.
			await using db = await openLeaseDb(adapter, url ?? "");
			const dir = path.join(db.dir.path(), "sessions", "-project-");
			const file = path.join(dir, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const holder = await db.open({ lease: STILL });
			await holder.writeLinesAtomic(file, listedBody("a"));
			await holder.drain();
			const race = partRace();
			const lister = await db.open({ lease: STILL, wrap: race.wrap });
			race.arm(async () => {
				await holder.writeLinesAtomic(file, listedBody("b"), { expectedSize: holder.statSync(file).size });
				await holder.drain();
			});

			const [listed] = await listSessions(dir, lister);

			expect(race.ran).toBe(true);
			expect([
				{ firstMessage: "prompt a", assistantTurns: 1 },
				{ firstMessage: "prompt b", assistantTurns: 1 },
			]).toContainEqual({
				firstMessage: listed?.firstMessage ?? "not listed",
				assistantTurns: listed?.assistantTurns ?? 0,
			});
		}, 120_000);

		it("rejects a publish whose reply was lost when another store's rewrite races its read-back", async () => {
			// If this regresses, a session whose rewrite lost its commit reply goes on as if that rewrite
			// were the stored transcript while another process's body replaced it, and appends onto a body
			// it never wrote.
			await using db = await openLeaseDb(adapter, url ?? "");
			const file = path.join(db.dir.path(), "sessions", "-project-", "raced-publish.jsonl");
			const lines = (fill: string, count: number) =>
				Array.from({ length: count }, (_, n) => line({ type: "custom", id: `p${n}`, data: fill.repeat(MiB) }));
			const previous = lines("p", 2);
			const own = lines("o", 3);
			const rival = lines("r", 4);
			const lostCommit = lostCommitReply();
			const race = partRace();
			const writer = await db.open({ lease: STILL, wrap: client => race.wrap(lostCommit.wrap(client)) });
			await writer.writeLinesAtomic(file, previous);
			const other = await db.open({ lease: STILL });
			lostCommit.arm();
			race.arm(async () => {
				await other.writeLinesAtomic(file, rival);
				await other.drain();
			});

			const error = await rejection(
				writer.writeLinesAtomic(file, own, { expectedSize: writer.statSync(file).size }),
			);

			expect(race.ran).toBe(true);
			expect({
				error: error instanceof Error ? error.message : String(error),
				indexedSize: writer.statSync(file).size,
				stored: (await db.row(file))?.content === rival.join(""),
			}).toEqual({ error: LOST_REPLY, indexedSize: Buffer.byteLength(previous.join("")), stored: true });
		}, 120_000);
	});
}
