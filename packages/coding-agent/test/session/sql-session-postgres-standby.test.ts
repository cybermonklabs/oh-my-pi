/**
 * `SqlSessionStorage` on a PostgreSQL server in recovery (a hot standby or a
 * read replica), which accepts no write: a store that would claim sessions or
 * make tables refuses to start there, naming the reason, instead of opening,
 * counting a claim it cannot write as held, and failing at its first write. A
 * store that does neither opens, as before. Runs when
 * `OMP_TEST_SQL_POSTGRES_URL` names a primary and
 * `OMP_TEST_SQL_POSTGRES_STANDBY_URL` a standby of it (for example one made
 * with `pg_basebackup -R`).
 */
import { describe, expect, it } from "bun:test";
import {
	SqlSessionStorage,
	type SqlSessionStorageOptions,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import { until } from "./sql-session-lease-fixture";

const primaryUrl = process.env.OMP_TEST_SQL_POSTGRES_URL;
const standbyUrl = process.env.OMP_TEST_SQL_POSTGRES_STANDBY_URL;
/** What the refusal says. */
const IN_RECOVERY = "the PostgreSQL server is in recovery";

describe.skipIf(!primaryUrl || !standbyUrl)("SqlSessionStorage on a PostgreSQL standby", () => {
	it("refuses a store that claims sessions or makes tables on a server in recovery, naming it, and opens one that does neither", async () => {
		const table = `sb_${process.pid}_${Date.now().toString(36)}`;
		const leaseTable = `${table}_leases`;
		const primary = new SQL(primaryUrl ?? "", { max: 2 });
		const standby = new SQL(standbyUrl ?? "", { max: 2 });
		try {
			const [{ recovery }] = (await standby.unsafe("SELECT pg_is_in_recovery() AS recovery")) as Array<{
				recovery: boolean;
			}>;
			expect(recovery).toBe(true);
			// The tables are made on the primary, and reach the standby.
			await (await SqlSessionStorage.create({ client: primary, table, leaseTable, claims: true })).drain();
			await until(async () => {
				const [row] = (await standby.unsafe("SELECT to_regclass('public.' || $1) IS NOT NULL AS present", [
					leaseTable,
				])) as Array<{ present: boolean }>;
				return row?.present === true;
			}, 30_000);
			const open = (client: InstanceType<typeof SQL>, options: Partial<SqlSessionStorageOptions>): Promise<string> =>
				SqlSessionStorage.create({ client, table, leaseTable, ...options }).then(
					async storage => {
						await storage.drain();
						return "opened";
					},
					(err: unknown) => String(err),
				);

			const onTheStandby = {
				claims: await open(standby, { claims: true }),
				claimsOnTablesItDoesNotMake: await open(standby, { claims: true, createTable: false }),
				makesTables: await open(standby, {}),
				neitherClaimsNorMakesTables: await open(standby, { createTable: false }),
			};
			// Control: the same stores open on the primary.
			const onThePrimary = await open(primary, { claims: true });

			const refusal = (outcome: string) => (outcome.includes(IN_RECOVERY) ? IN_RECOVERY : outcome);
			expect({
				claims: refusal(onTheStandby.claims),
				claimsOnTablesItDoesNotMake: refusal(onTheStandby.claimsOnTablesItDoesNotMake),
				makesTables: refusal(onTheStandby.makesTables),
				neitherClaimsNorMakesTables: onTheStandby.neitherClaimsNorMakesTables,
				onThePrimary,
			}).toEqual({
				claims: IN_RECOVERY,
				claimsOnTablesItDoesNotMake: IN_RECOVERY,
				makesTables: IN_RECOVERY,
				neitherClaimsNorMakesTables: "opened",
				onThePrimary: "opened",
			});
		} finally {
			for (const name of [`${table}_parts`, table, leaseTable]) await primary.unsafe(`DROP TABLE IF EXISTS ${name}`);
			await standby.end();
			await primary.end();
		}
	}, 60_000);
});
