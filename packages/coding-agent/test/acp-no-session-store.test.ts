/**
 * `omp --mode acp --no-session`: a `session/new` keeps its session in memory, as
 * the launch's own session does under `--no-session`, so nothing it makes opens
 * or writes the configured session store. The launch runs through
 * `runRootCommand`, so the start-up's store resolution and the arguments the ACP
 * session factory receives are the CLI's own. `runAcpMode` stands in for the ACP
 * server and does what its `session/new` does (acp-agent.ts,
 * `#createNewSessionRecord`): make a session through the factory, then
 * `ensureOnDisk()`.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { FileSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger, TempDir, toError } from "@oh-my-pi/pi-utils";

const STORE_UNOPENED = "the session database could not be opened";
const tempDirs: TempDir[] = [];

afterEach(async () => {
	// `runRootCommand` registers the CLI's extension roots and installs the session store process-wide.
	clearOmpExtensionCliRoots();
	setDefaultSessionStorage(new FileSessionStorage());
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function acpArgs(extra: string[], sessionDir: string): { parsed: Args; raw: string[] } {
	const raw = ["--mode", "acp", ...extra];
	const parsed = parseArgs(raw);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = sessionDir;
	return { parsed, raw };
}

/** The tables of the SQLite file at `databasePath`: none until a store's open has run its DDL. */
function sqliteTables(databasePath: string): string[] {
	if (!fs.existsSync(databasePath)) return [];
	const db = new Database(databasePath, { readonly: true });
	try {
		const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
		return (rows as Array<{ name: string }>).map(row => row.name);
	} finally {
		db.close();
	}
}

/** Session rows whose path names `sessionId` in the SQLite file at `databasePath`. */
function sqliteSessionRows(databasePath: string, sessionId: string): number {
	const db = new Database(databasePath, { readonly: true });
	try {
		const row = db.query("SELECT count(*) AS n FROM omp_session_files WHERE path LIKE ?").get(`%${sessionId}%`);
		return row && typeof row === "object" && "n" in row ? Number(row.n) : 0;
	} finally {
		db.close();
	}
}

interface NewSession {
	/** What `session/new`'s factory call or its `ensureOnDisk()` threw, if anything. */
	failure: Error | undefined;
	sessionId: string | undefined;
}

/** Launch `omp --mode acp <extra>` on the SQL store `dsn` names, and run one `session/new` as the ACP server does. */
async function newAcpSession(dir: TempDir, dsn: string, extra: string[]): Promise<NewSession> {
	const dsnFile = dir.join("dsn");
	await Bun.write(dsnFile, `${dsn}\n`);
	const authStorage = await AuthStorage.create(":memory:");
	const saved = { kind: process.env.OMP_SESSION_STORAGE, dsnFile: process.env.OMP_SESSION_SQL_DSN_FILE };
	process.env.OMP_SESSION_STORAGE = "sql";
	process.env.OMP_SESSION_SQL_DSN_FILE = dsnFile;
	// The ACP server never returns; the stub stops it with a sentinel once `session/new` is done.
	const stopServing = new Error("stop ACP server");
	const result: NewSession = { failure: undefined, sessionId: undefined };
	let served = false;
	const { parsed, raw } = acpArgs(extra, dir.join("sessions"));
	try {
		await runRootCommand(parsed, raw, {
			discoverAuthStorage: async () => authStorage,
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			createAgentSession: async (options?: CreateAgentSessionOptions) => {
				const session = {
					sessionManager: options?.sessionManager,
					extensionRunner: undefined,
					model: undefined,
					dispose: async () => {},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
			runAcpMode: async createAcpSession => {
				served = true;
				try {
					const { session } = await createAcpSession(dir.path());
					result.sessionId = session.sessionManager.getSessionId();
					await session.sessionManager.ensureOnDisk();
					await session.sessionManager.close();
				} catch (err) {
					result.failure = toError(err);
				}
				throw stopServing;
			},
		});
	} catch (error) {
		if (error !== stopServing) throw error;
	} finally {
		if (saved.kind === undefined) delete process.env.OMP_SESSION_STORAGE;
		else process.env.OMP_SESSION_STORAGE = saved.kind;
		if (saved.dsnFile === undefined) delete process.env.OMP_SESSION_SQL_DSN_FILE;
		else process.env.OMP_SESSION_SQL_DSN_FILE = saved.dsnFile;
		logger.endTiming();
		authStorage.close();
	}
	expect(served).toBe(true);
	return result;
}

describe("omp --mode acp under session.storage: sql", () => {
	it("--no-session: session/new opens no store, so a store that refuses the connection does not fail it", async () => {
		const dir = TempDir.createSync("@omp-acp-no-session-refused-");
		tempDirs.push(dir);
		// Port 1 answers no connection.
		const created = await newAcpSession(dir, "postgres://omp@127.0.0.1:1/sessions", ["--no-session"]);

		expect(created.failure?.message ?? "").not.toContain(STORE_UNOPENED);
		expect(created.failure).toBeUndefined();
	}, 30_000);

	it("--no-session: session/new makes no table in a SQLite store", async () => {
		const dir = TempDir.createSync("@omp-acp-no-session-sqlite-");
		tempDirs.push(dir);
		const databasePath = dir.join("sessions.db");
		const created = await newAcpSession(dir, `sqlite://${databasePath}`, ["--no-session"]);

		expect(created.failure).toBeUndefined();
		expect(sqliteTables(databasePath)).toEqual([]);
	}, 30_000);

	it("without --no-session, session/new writes its session to the store", async () => {
		const dir = TempDir.createSync("@omp-acp-session-sqlite-");
		tempDirs.push(dir);
		const databasePath = dir.join("sessions.db");
		const created = await newAcpSession(dir, `sqlite://${databasePath}`, []);

		expect(created.failure).toBeUndefined();
		expect(created.sessionId).toBeDefined();
		expect(sqliteSessionRows(databasePath, created.sessionId ?? "")).toBe(1);
	}, 30_000);
});
