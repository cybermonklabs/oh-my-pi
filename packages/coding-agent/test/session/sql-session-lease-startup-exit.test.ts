/**
 * A launch that took its session's lease (SQL storage) and then ends by an exit of its own gives the lease back
 * before the process ends: an unknown flag (exit 2, once the extensions loaded), no usable model (exit 1, once the
 * session exists), an `@file` that does not exist (exit 1). Each row's extension counts the session's lease rows at
 * its module top level, which runs after the claim: 1 shows the launch held the row, 0 after the exit shows it gave
 * it back. Real processes, each run on a database of its own under the CLI's default table names. PostgreSQL and
 * MySQL run when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a server; SQLite's claim is an OS lock
 * the kernel drops with the process.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SQL } from "bun";
import { cliDatabase, cliSession, ROW_LEASE_BACKENDS } from "./sql-session-lease-fixture";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const ID = "01a1f900-0000-7000-8000-000000000001";

/**
 * An extension whose module top level counts the lease rows of {@link ID} with `statement` on its own connection
 * to the database `dsnFile` names, and writes the count to `<name>.rows`.
 */
async function rowCountingExtension(dir: TempDir, name: string, dsnFile: string, statement: string) {
	const marker = dir.join(`${name}.rows`);
	const file = dir.join(`${name}.ts`);
	await Bun.write(
		file,
		`import { SQL } from "bun";\n` +
			`const sql = new SQL((await Bun.file(${JSON.stringify(dsnFile)}).text()).trim());\n` +
			`const rows = await sql.unsafe(${JSON.stringify(statement)}, [${JSON.stringify(ID)}]);\n` +
			`await Bun.write(${JSON.stringify(marker)}, String(rows.length));\n` +
			`await sql.end();\n` +
			`export default function (pi) {}\n`,
	);
	return {
		file,
		/** The rows the extension counted, or `undefined` when it never ran. */
		rows: async () => ((await Bun.file(marker).exists()) ? Number(await Bun.file(marker).text()) : undefined),
	};
}

/** The CLI under `OMP_SESSION_EXCLUSIVE=1`, resuming {@link ID} with `args` after it; its exit code and stderr. */
async function launch(home: string, cwd: string, sessionDir: string, dsnFile: string, args: string[]) {
	const proc = Bun.spawn(
		[
			process.execPath,
			cliEntry,
			"--no-title",
			"--no-lsp",
			"--no-tools",
			"--session-dir",
			sessionDir,
			"--resume",
			ID,
			...args,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: process.env.TMPDIR,
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
				OMP_SESSION_STORAGE: "sql",
				OMP_SESSION_SQL_DSN_FILE: dsnFile,
				OMP_SESSION_EXCLUSIVE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(90_000),
		},
	);
	proc.stdin.end();
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
		new Response(proc.stdout).text(),
	]);
	return { exitCode, stderr };
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`a launch that exits by itself after claiming its session (${adapter})`, () => {
		const LEASE_ROWS = `SELECT holder FROM omp_session_leases WHERE session_id = ${adapter === "postgres" ? "$1" : "?"}`;
		const leaseRows = async (sql: SQL): Promise<number> => ((await sql.unsafe(LEASE_ROWS, [ID])) as unknown[]).length;

		const rows: { name: string; model: boolean; args: (extension: string) => string[]; exitCode: number }[] = [
			{
				name: "an unknown flag, found once the extensions loaded (exit 2)",
				model: true,
				args: extension => ["--model", "@default", "--extension", extension, "--mode", "rpc", "--no-such-flag"],
				exitCode: 2,
			},
			{
				name: "no usable model, found once the session exists (exit 1)",
				model: false,
				args: extension => ["--extension", extension, "-p", "hello"],
				exitCode: 1,
			},
			{
				name: "an @file that does not exist (exit 1)",
				model: true,
				args: extension => ["--model", "@default", "--extension", extension, "-p", "@no-such-file.txt"],
				exitCode: 1,
			},
		];
		for (const row of rows) {
			it(`gives the lease back when it ends on ${row.name}`, async () => {
				using dir = TempDir.createSync("@omp-lease-startup-exit-");
				await using db = await cliDatabase(adapter, url ?? "");
				const { cwd, home, sessionDir, dsnFile } = await cliSession(dir, db.dsn, ID, { model: row.model });
				const probe = await rowCountingExtension(dir, "counter", dsnFile, LEASE_ROWS);
				const { exitCode, stderr } = await launch(home, cwd, sessionDir, dsnFile, row.args(probe.file));
				const rowsAtExtensionLoad = await probe.rows();
				const rowsAfterExit = await leaseRows(db.sql);
				console.log(
					`${adapter} ${row.name}: exit ${exitCode}, lease rows ${rowsAtExtensionLoad ?? "none counted"} at extension load and ${rowsAfterExit} after the exit; stderr: ${stderr.trim().split("\n")[0]}`,
				);
				expect({ exitCode, rowsAtExtensionLoad, rowsAfterExit }).toEqual({
					exitCode: row.exitCode,
					rowsAtExtensionLoad: 1,
					rowsAfterExit: 0,
				});
			}, 120_000);
		}
	});
}
