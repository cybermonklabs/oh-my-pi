/**
 * `omp --mode acp --no-session`: a `session/new` keeps its session in memory, as
 * the launch's own session does under `--no-session`, so it opens and writes
 * nothing in the configured session store; and the agent neither advertises nor
 * serves `session/load`, `session/resume` and `session/fork`, which read a stored
 * session, so they open nothing either. (`session/list` still reads the store:
 * that read is the store's first use.) The launch runs through `runRootCommand`,
 * so the start-up's store resolution, the arguments the ACP session factory
 * receives and the options the ACP server gets are the CLI's own. `runAcpMode`
 * stands in for the ACP server: it makes sessions through the factory as
 * `session/new` does (acp-agent.ts, `#createNewSessionRecord`: the factory, then
 * `ensureOnDisk()`), or serves requests through an `AcpAgent` built with the
 * options it was given.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AcpAgent, type AcpAgentOptions } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import type { AcpSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { FileSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger, TempDir, toError } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";

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

/**
 * Launch `omp --mode acp <extra>` on the SQL store `dsn` names, and run `serve` as the ACP server, with the
 * session factory and the options `runAcpMode` receives.
 */
async function serveAcp(
	dir: TempDir,
	dsn: string,
	extra: string[],
	serve: (createAcpSession: AcpSessionFactory, options: AcpAgentOptions | undefined) => Promise<void>,
): Promise<void> {
	const dsnFile = dir.join("dsn");
	await Bun.write(dsnFile, `${dsn}\n`);
	const authStorage = await AuthStorage.create(":memory:");
	const saved = { kind: process.env.OMP_SESSION_STORAGE, dsnFile: process.env.OMP_SESSION_SQL_DSN_FILE };
	process.env.OMP_SESSION_STORAGE = "sql";
	process.env.OMP_SESSION_SQL_DSN_FILE = dsnFile;
	// The ACP server never returns; the stub stops it with a sentinel once `serve` is done.
	const stopServing = new Error("stop ACP server");
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
			runAcpMode: async (createAcpSession, _initialSession, options) => {
				served = true;
				await serve(createAcpSession, options);
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
}

/** Launch `omp --mode acp <extra>` on the SQL store `dsn` names, and run one `session/new` as the ACP server does. */
async function newAcpSession(dir: TempDir, dsn: string, extra: string[]): Promise<NewSession> {
	const result: NewSession = { failure: undefined, sessionId: undefined };
	await serveAcp(dir, dsn, extra, async createAcpSession => {
		try {
			const created = await createAcpSession(dir.path());
			const session = "session" in created ? created.session : created;
			result.sessionId = session.sessionManager.getSessionId();
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.close();
		} catch (err) {
			result.failure = toError(err);
		}
	});
	return result;
}

/** An `AcpAgent` on a connection that records nothing, built as `runAcpMode` builds it. */
function acpAgent(createAcpSession: AcpSessionFactory, options: AcpAgentOptions | undefined): AcpAgent {
	const connection = {
		sessionUpdate: async () => {},
		signal: new AbortController().signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;
	return new AcpAgent(connection, createAcpSession, undefined, options);
}

async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
	try {
		await promise;
		return undefined;
	} catch (err) {
		return toError(err);
	}
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

	it("--no-session: the agent advertises no session/load, resume or fork, and refuses each, naming --no-session, without opening the store", async () => {
		const dir = TempDir.createSync("@omp-acp-no-session-refuse-");
		tempDirs.push(dir);
		const databasePath = dir.join("sessions.db");
		const refusals: Record<string, string | undefined> = {};
		let capabilities: unknown;
		await serveAcp(dir, `sqlite://${databasePath}`, ["--no-session"], async (createAcpSession, options) => {
			const agent = acpAgent(createAcpSession, options);
			capabilities = (await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })).agentCapabilities;
			const request = { sessionId: "0196f0d2-6b1e-7c4a-9f3e-2d5a8b7c6e41", cwd: dir.path(), mcpServers: [] };
			refusals["session/load"] = (await rejection(agent.loadSession(request)))?.message;
			refusals["session/resume"] = (await rejection(agent.resumeSession(request)))?.message;
			refusals["session/fork"] = (await rejection(agent.unstable_forkSession(request)))?.message;
			await agent.dispose();
		});

		const caps = capabilities as { loadSession?: boolean; sessionCapabilities?: Record<string, unknown> } | undefined;
		const refused = (method: string) =>
			`Invalid request: ${method} requires session persistence; omp was started with --no-session`;
		// One expectation, so a failing run shows every part of the answer at once.
		expect({
			loadSession: caps?.loadSession,
			sessionCapabilities: Object.keys(caps?.sessionCapabilities ?? {}).sort(),
			refusals,
			tables: sqliteTables(databasePath),
		}).toEqual({
			loadSession: false,
			sessionCapabilities: ["close", "list"],
			refusals: {
				"session/load": refused("session/load"),
				"session/resume": refused("session/resume"),
				"session/fork": refused("session/fork"),
			},
			tables: [],
		});
	}, 30_000);

	it("without --no-session, the agent advertises session/load, resume and fork", async () => {
		const dir = TempDir.createSync("@omp-acp-session-capabilities-");
		tempDirs.push(dir);
		let capabilities: unknown;
		await serveAcp(dir, `sqlite://${dir.join("sessions.db")}`, [], async (createAcpSession, options) => {
			const agent = acpAgent(createAcpSession, options);
			capabilities = (await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })).agentCapabilities;
			await agent.dispose();
		});

		expect(capabilities).toMatchObject({
			loadSession: true,
			sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} },
		});
	}, 30_000);
});
