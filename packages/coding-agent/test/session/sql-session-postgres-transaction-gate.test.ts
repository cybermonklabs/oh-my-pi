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
 * the admin URL is unset) and reads its JUnit report: Bun prints no line per
 * case when it runs under an AI agent (`AGENT`, `CLAUDECODE`), and the report
 * does not depend on that.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
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
	// A server that never answers holds the file's load 5 s at most, as the transaction test's own read.
	const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
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
		const dir = TempDir.createSync("@omp-txn-gate-");
		try {
			const report = dir.join("report.xml");
			const child = Bun.spawn(
				[
					process.execPath,
					"test",
					"./test/session/sql-session-postgres-transaction.test.ts",
					"-t",
					"transaction_timeout",
					"--reporter=junit",
					`--reporter-outfile=${report}`,
				],
				{
					cwd: agent,
					env: {
						...process.env,
						OMP_TEST_SQL_POSTGRES_URL: STORE_URL,
						OMP_TEST_SQL_POSTGRES_ADMIN_URL: ADMIN_URL ?? STORE_URL,
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			await child.exited;
			const xml = await Bun.file(report).text();
			// Each case's outcome: a <failure> or <skipped /> inside its <testcase>, else a pass.
			const outcomes = CASES.map(name => {
				const start = xml.indexOf(`<testcase name="${name}"`);
				if (start < 0) return "missing";
				const open = xml.indexOf(">", start);
				// A self-closing <testcase ... /> holds no <failure> or <skipped />: a pass.
				if (xml[open - 1] === "/") return "pass";
				const body = xml.slice(open, xml.indexOf("</testcase>", open));
				if (body.includes("<failure")) return "fail";
				if (body.includes("<skipped")) return "skip";
				return "pass";
			});
			console.log(`transaction_timeout gate on ${unfit}: ${JSON.stringify(outcomes)}`);
			expect(outcomes).not.toContain("missing");
			expect(outcomes).not.toContain("pass");
		} finally {
			dir.removeSync();
		}
	},
	60_000,
);
