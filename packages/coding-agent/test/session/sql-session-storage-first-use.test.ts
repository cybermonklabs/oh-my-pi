/**
 * `SqlSessionStorage.createOnFirstUse`: a store that runs nothing until its
 * first use. A claim statement or a blob write runs outside the indexed write
 * queue, so when one of them is the first use it must wait for the open, which
 * makes the tables, instead of running against a schema that is not there yet.
 * Each case uses tables of its own name, so the open always finds none.
 */

import { SQL } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, toError } from "@oh-my-pi/pi-utils";

const url = process.env.OMP_TEST_SQL_POSTGRES_URL;
const ID = "0196f0d2-6b1e-7c4a-9f3e-2d5a8b7c6e41";
const FILE = `/sessions/p/2026-11-21T08-00-00-000Z_${ID}.jsonl`;
let sequence = 0;

afterEach(() => {
	vi.restoreAllMocks();
});

/** A store on tables nobody made yet, opened on its first use; `drop` removes every table it made. */
function freshStore(): { storage: SqlSessionStorage; drop: () => Promise<void> } {
	const table = `omp_fu_${process.pid}_${Date.now().toString(36)}_${sequence++}`;
	const client = new SQL(url ?? "", { max: 2 });
	const storage = SqlSessionStorage.createOnFirstUse(
		{ client, table, leaseTable: `${table}_leases`, claims: true },
		toError,
	);
	const drop = async () => {
		await storage.releaseHeldClaims?.();
		await storage.drain().catch(() => undefined);
		const made = (await client.unsafe("SELECT tablename FROM pg_tables WHERE tablename LIKE $1", [
			`${table}%`,
		])) as Array<{ tablename: string }>;
		for (const { tablename } of made) await client.unsafe(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
		await client.end();
	};
	return { storage, drop };
}

describe.skipIf(!url)("SqlSessionStorage.createOnFirstUse on PostgreSQL", () => {
	it("opens before a claim that is its first use: the claim statement never runs against missing tables", async () => {
		const debug = vi.spyOn(logger, "debug");
		const { storage, drop } = freshStore();
		try {
			const release = storage.claimSession?.(ID, FILE);
			expect(release).toBeTypeOf("function");
			await storage.writeText(FILE, `${JSON.stringify({ type: "session", id: ID })}\n`);
			await storage.drain();

			const refused = debug.mock.calls.filter(
				([message]) => message === "SqlSessionStorage could not claim a session",
			);
			expect(refused).toEqual([]);
			expect(await storage.sessionClaimHolder?.(ID)).toMatchObject({ pid: process.pid });
			release?.();
		} finally {
			await drop();
		}
	});

	it("opens before a blob that is its first use: the blob lands", async () => {
		const { storage, drop } = freshStore();
		try {
			const data = Buffer.from("a session image stored before anything else used the store");
			const hash = new Bun.SHA256().update(data).digest("hex");
			storage.blobTier.store(hash, data, "image/png");
			// SqlSessionStorage.drain lands the blobs queued so far.
			await storage.drain();

			expect((await storage.blobTier.sizes([hash])).get(hash)).toBe(data.length);
		} finally {
			await drop();
		}
	});
});
