/**
 * The PostgreSQL 17 and later cases of `sql-session-postgres-transaction.test.ts`
 * on a server they cannot use (PostgreSQL before 17, or a pooler such as
 * PgBouncer in front of the server) report skip or fail, never pass: a case
 * that passes while it checks nothing hides from every count that reads the
 * run.
 *
 * Runs when `OMP_TEST_SQL_POSTGRES_URL` names a server that answers and is not
 * PostgreSQL 17 or later reached directly; skipped otherwise. It runs that file
 * with the same URL as the store's and the admin URL (or the store's URL when
 * the admin URL is unset) and reads its report.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";
import { SQL } from "bun";
import { reachesPostgresDirectly } from "./postgres-left-settings-harness";

const STORE_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
const ADMIN_URL = process.env.OMP_TEST_SQL_POSTGRES_ADMIN_URL;
const CASES = [
	"transaction_timeout: a left value shorter than a positive default ends no store transaction",
	"transaction_timeout: a left value longer than a positive default leaves the default to end a store transaction",
];

/** Why the cases cannot use `url`, or undefined when they can (PostgreSQL 17 or later, reached directly). */
async function unfitFor(url: string): Promise<string | undefined> {
	const sql = new SQL(url, { max: 1 });
	try {
		const direct = await reachesPostgresDirectly(sql, url);
		const [row] = (await sql.unsafe(
			"SELECT pg_catalog.current_setting('server_version_num')::int AS version",
		)) as Array<{
			version: number;
		}>;
		if (!direct) return "the URL does not reach PostgreSQL directly";
		if (Number(row?.version) < 170000) return `server_version_num ${row?.version}`;
		return undefined;
	} finally {
		await sql.close();
	}
}

// Read when the file loads, so the case is skipped on a server the cases can use; a server that does not answer skips it too.
const unfit = STORE_URL ? await unfitFor(STORE_URL).catch(() => undefined) : undefined;

it.skipIf(unfit === undefined)(
	"the transaction_timeout cases report skip or fail, never pass, on a server they cannot use",
	async () => {
		const agent = path.join(import.meta.dir, "..", "..");
		const child = Bun.spawn(
			[
				process.execPath,
				"test",
				"./test/session/sql-session-postgres-transaction.test.ts",
				"-t",
				"transaction_timeout",
			],
			{
				cwd: agent,
				env: {
					...process.env,
					OMP_TEST_SQL_POSTGRES_URL: STORE_URL,
					OMP_TEST_SQL_POSTGRES_ADMIN_URL: ADMIN_URL ?? STORE_URL,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		await child.exited;
		const reported = `${out}\n${err}`.split("\n").filter(line => CASES.some(name => line.includes(name)));
		console.log(`transaction_timeout gate on ${unfit}: ${JSON.stringify(reported.map(line => line.split(" ")[0]))}`);
		expect(reported).toHaveLength(CASES.length);
		expect(reported.filter(line => line.startsWith("(pass)"))).toEqual([]);
	},
	60_000,
);
