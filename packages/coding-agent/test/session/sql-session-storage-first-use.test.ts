/**
 * `SqlSessionStorage.createOnFirstUse`: a store that runs nothing until its
 * first use. A claim statement or a blob write runs outside the indexed write
 * queue, so when one of them is the first use it must wait for the open, which
 * makes the tables, instead of running against a schema that is not there yet;
 * and on a server that refuses the connection, it must fail with the open's
 * refusal, worded as the refusal at start-up. Each case on a live server uses
 * tables of its own name, so the open always finds none.
 */

import { SQL } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir, toError } from "@oh-my-pi/pi-utils";

const ID = "0196f0d2-6b1e-7c4a-9f3e-2d5a8b7c6e41";
const FILE = `/sessions/p/2026-11-21T08-00-00-000Z_${ID}.jsonl`;
const BLOB_FAILED = "Storing a session blob in the session database failed; the next write naming it tries again";
let sequence = 0;

/** `SqlBlobTier.land`, which `SessionBlobTier` does not name: land the queued blobs among `hashes`, or reject. */
interface BlobLanding {
	land(hashes?: Iterable<string>): Promise<void>;
}

/** The store's blob tier as the `SqlBlobTier` it is, checked: it has `land`. */
function blobLanding(tier: object): BlobLanding {
	if (!("land" in tier) || typeof tier.land !== "function") throw new Error("the blob tier has no land()");
	const land = tier.land;
	return { land: hashes => land.call(tier, hashes) };
}

/** The `error` field of a log call's context, as text; "" when it has none. */
function contextError(context: unknown): string {
	return context && typeof context === "object" && "error" in context ? String(context.error) : "";
}

afterEach(() => {
	vi.restoreAllMocks();
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (err) {
		return toError(err);
	}
	throw new Error("expected a rejection");
}

const SERVERS: Array<{ adapter: "postgres" | "mysql"; url: string | undefined }> = [
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

/** A store on tables nobody made yet, opened on its first use; `drop` removes every table it made. */
function freshStore(
	adapter: "postgres" | "mysql",
	url: string,
): { storage: SqlSessionStorage; drop: () => Promise<void> } {
	const table = `omp_fu_${process.pid}_${Date.now().toString(36)}_${sequence++}`;
	const client = new SQL(url, { max: 2 });
	const storage = SqlSessionStorage.createOnFirstUse(
		{ client, table, leaseTable: `${table}_leases`, claims: true },
		toError,
	);
	const drop = async () => {
		await storage.releaseHeldClaims?.();
		await storage.drain().catch(() => undefined);
		// The table names are this file's own identifiers, never input.
		const made = (await client.unsafe(
			adapter === "postgres"
				? `SELECT tablename FROM pg_tables WHERE tablename LIKE '${table}%'`
				: `SELECT table_name AS tablename FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE '${table}%'`,
		)) as Array<{ tablename: string }>;
		for (const { tablename } of made) {
			await client.unsafe(
				adapter === "postgres"
					? `DROP TABLE IF EXISTS "${tablename}" CASCADE`
					: `DROP TABLE IF EXISTS \`${tablename}\``,
			);
		}
		await client.end();
	};
	return { storage, drop };
}

for (const { adapter, url } of SERVERS) {
	describe.skipIf(!url)(`SqlSessionStorage.createOnFirstUse on ${adapter}`, () => {
		it("opens before a claim that is its first use: the claim statement never runs against missing tables", async () => {
			const debug = vi.spyOn(logger, "debug");
			const { storage, drop } = freshStore(adapter, url ?? "");
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
			const { storage, drop } = freshStore(adapter, url ?? "");
			try {
				const data = Buffer.from("a session image stored before anything else used the store");
				const hash = new Bun.SHA256().update(data).digest("hex");
				storage.blobTier.store(hash, data, "image/png");
				await blobLanding(storage.blobTier).land([hash]);

				expect((await storage.blobTier.sizes([hash])).get(hash)).toBe(data.length);
			} finally {
				await drop();
			}
		});
	});
}

// No server: port 1 answers no connection. On MySQL a blob's write reads
// max_allowed_packet before its insert, so that read too must wait for the
// deferred open, or the blob fails with the driver's own words.
describe("SqlSessionStorage resolved for first use on a MySQL server that refuses the connection", () => {
	it("fails a blob that is its first use with the open's refusal, worded as at start-up", async () => {
		using dir = TempDir.createSync("@omp-first-use-mysql-refused-");
		const dsnFile = dir.join("dsn");
		await Bun.write(dsnFile, "mysql://omp@127.0.0.1:1/sessions\n");
		const storage = await resolveSessionStorage({
			settings: Settings.isolated(),
			env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
			openOnFirstUse: true,
		});
		if (!(storage instanceof SqlSessionStorage)) throw new Error("a sql store resolved to another kind");
		const sql = storage;
		const warn = vi.spyOn(logger, "warn");
		const opening = `OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but the session database could not be opened: `;

		const data = Buffer.from("a session image that is the store's first use");
		const hash = new Bun.SHA256().update(data).digest("hex");
		sql.blobTier.store(hash, data, "image/png");
		const error = await rejection(blobLanding(sql.blobTier).land([hash]));

		expect(error.message).toContain(opening);
		const failed = warn.mock.calls.filter(([message]) => message === BLOB_FAILED);
		expect(failed.length).toBeGreaterThan(0);
		for (const [, context] of failed) {
			expect(contextError(context)).toContain(opening);
		}
	}, 30_000);
});
