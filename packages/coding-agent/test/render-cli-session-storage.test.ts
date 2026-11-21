/**
 * `omp render <session>` renders a working copy of the session, never the
 * session itself, and removes the copy when it is done. The copy has the
 * original's session id, so removing it must not purge history.db rows by
 * that id: the prompts, recap and title belong to the original, which stays.
 * Under `session.storage: sql` the copy is a row in the session table.
 *
 * The SQL cases run against SQLite always, and against PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a server,
 * each in a database of its own.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex, recordSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils/dirs";
import { SQL } from "bun";
import { cliDatabase, LEASE_BACKENDS } from "./session/sql-session-lease-fixture";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

/** Rows history.db holds for `id`: the prompt history and the indexed title. */
function historyRows(agentDir: string, id: string): { history?: number; titles?: number } {
	const db = new Database(getHistoryDbPath(agentDir), { readonly: true });
	try {
		const count = (sql: string): number | undefined => db.query<{ n: number }, [string]>(sql).get(id)?.n;
		return {
			history: count("SELECT count(*) AS n FROM history WHERE session_id = ?"),
			titles: count("SELECT count(*) AS n FROM session_titles WHERE session_id = ?"),
		};
	} finally {
		db.close();
	}
}

const KINDS = [
	{ name: "file", backend: undefined },
	...LEASE_BACKENDS.map(backend => ({ name: `sql on ${backend.adapter}`, backend })),
] as const;

describe("omp render keeps the rendered session's history", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-render-history-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("project");
		fs.mkdirSync(project, { recursive: true });
		HistoryStorage.close();
		closeSessionIndex();
		setAgentDir(agentDir);
	});

	afterEach(() => {
		HistoryStorage.close();
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		tempDir.removeSync();
	});

	for (const { name, backend } of KINDS) {
		it.skipIf(backend !== undefined && !backend.url)(
			`keeps history and title rows under ${name} storage and leaves no working copy`,
			async () => {
				const id = `01a1ffff-${crypto.randomUUID().slice(9)}`;
				const at = "2026-11-21T00:00:00.000Z";
				const sessionPath = path.join(sessionDirForCwd(project), `2026-11-21T00-00-00-000Z_${id}.jsonl`);
				const content = `${[
					{ type: "session", version: 3, id, timestamp: at, cwd: project },
					{
						type: "message",
						id: "u1",
						parentId: null,
						timestamp: at,
						message: { role: "user", content: "a prompt about pelicans", timestamp: 1 },
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`;
				const db =
					backend && backend.adapter !== "sqlite" ? await cliDatabase(backend.adapter, backend.url!) : undefined;
				try {
					const database = db?.dsn ?? `sqlite://${tempDir.join("sessions.db")}`;
					const dsnFile = tempDir.join("dsn");
					const env: Record<string, string | undefined> = {
						...process.env,
						NO_COLOR: "1",
						PI_NO_TITLE: "1",
						PI_CODING_AGENT_DIR: agentDir,
						OMP_SESSION_STORAGE: backend ? "sql" : "file",
					};
					if (backend) {
						await Bun.write(dsnFile, `${database}\n`);
						env.OMP_SESSION_SQL_DSN_FILE = dsnFile;
						const client = new SQL(database);
						try {
							const storage = await SqlSessionStorage.create({ client });
							await storage.writeText(sessionPath, content);
							await storage.drain();
						} finally {
							await client.end();
						}
					} else {
						fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
						fs.writeFileSync(sessionPath, content);
					}
					await HistoryStorage.open().add("a prompt about pelicans", project, id);
					recordSessionTitle(id, "Pelican notes");
					HistoryStorage.close();
					closeSessionIndex();
					expect(historyRows(agentDir, id)).toEqual({ history: 1, titles: 1 });

					const proc = Bun.spawn([process.execPath, CLI_ENTRY, "render", sessionPath, "--quiet"], {
						cwd: project,
						env,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
					const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

					expect(exitCode, stderr).toBe(0);
					expect(historyRows(agentDir, id)).toEqual({ history: 1, titles: 1 });
					if (backend) {
						// The working copy was a row too; only the session itself is left.
						const client = new SQL(database);
						try {
							const storage = await SqlSessionStorage.create({ client });
							expect(storage.listAllSync()).toEqual([sessionPath]);
						} finally {
							await client.end();
						}
					}
				} finally {
					await db?.[Symbol.asyncDispose]();
				}
			},
			60_000,
		);
	}
});
