/**
 * Features that read a session through the session storage, or move it, run
 * under every session storage: the session listing's line scan of a long
 * transcript, and resuming a session whose recorded folder is gone. Under
 * `session.storage: sql` the transcript is a table row, read in windows, and
 * another process's rows show only after a refresh; a store that claims no
 * sessions cannot tell whether another process still writes one.
 *
 * Runs against file storage and SQLite always, against PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database, and against Redis when `OMP_TEST_REDIS_URL` names a throwaway
 * server. Every SQL test uses its own table and drops it when done; every
 * Redis test uses its own key prefix and deletes its keys.
 */
import { $, RedisClient, SQL } from "bun";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchiveSession } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionDirForCwd, writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import * as sessionStorageModule from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeAssistantMessage } from "../session-manager/helpers";
import { LEASE_BACKENDS, openLeaseDb, ROW_LEASE_BACKENDS } from "./sql-session-lease-fixture";

/** A store that claims no sessions: a SQL table opened without `claims`, or a Redis keyspace. */
type KeyedBackend = SqlSessionStorageAdapter | "redis";
type Backend = "file" | KeyedBackend;

const SQL_URLS: Record<SqlSessionStorageAdapter, string | undefined> = {
	sqlite: "sqlite",
	postgres: process.env.OMP_TEST_SQL_POSTGRES_URL,
	mysql: process.env.OMP_TEST_SQL_MYSQL_URL,
};
const REDIS_URL = process.env.OMP_TEST_REDIS_URL;
const SQL_BACKENDS = (Object.keys(SQL_URLS) as SqlSessionStorageAdapter[]).filter(adapter => SQL_URLS[adapter]);
const KEYED_BACKENDS: KeyedBackend[] = [...SQL_BACKENDS, ...(REDIS_URL ? (["redis"] as const) : [])];
const AT = "2026-03-01T00:00:00.000Z";

let tableSeq = 0;
let tempDir: TempDir;
let settingsState: SettingsTestState | undefined;
let previousStorage: SessionStorage;
const clients: SQL[] = [];
const redisClients: RedisClient[] = [];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	settingsState = beginSettingsTest();
	previousStorage = defaultSessionStorage();
	tempDir = TempDir.createSync("@omp-sql-archive-agents-resume-");
	HistoryStorage.close();
	closeSessionIndex();
	setAgentDir(tempDir.join("agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setDefaultSessionStorage(previousStorage);
	HistoryStorage.close();
	closeSessionIndex();
	clearOmpExtensionCliRoots();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const client of clients.splice(0)) await client.end();
	for (const client of redisClients.splice(0)) client.close();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	tempDir.removeSync();
});

/**
 * Opens `backend`'s storage. Each call for a SQL or Redis backend is a new
 * client of the same table or keyspace, as each omp process holds its own.
 */
function backendOpener(backend: Backend): () => Promise<SessionStorage> {
	if (backend === "file") return async () => new FileSessionStorage();
	if (backend === "redis") {
		const prefix = `omp-aar:${process.pid}:${Date.now().toString(36)}:${tableSeq++}:`;
		let first: RedisClient | undefined;
		return async () => {
			const client = new RedisClient(REDIS_URL!);
			redisClients.push(client);
			if (!first) {
				first = client;
				cleanups.push(async () => {
					for (const key of (await client.send("KEYS", [`${prefix}*`])) as string[])
						await client.send("DEL", [key]);
				});
			}
			return RedisSessionStorage.create({ client, prefix });
		};
	}
	const table = `omp_aar_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	const url = backend === "sqlite" ? `sqlite:${tempDir.join("sessions.db")}` : SQL_URLS[backend]!;
	let first: SQL | undefined;
	return async () => {
		const client = new SQL(url);
		clients.push(client);
		if (!first) {
			first = client;
			cleanups.push(async () => {
				await client.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
				await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
			});
		}
		return SqlSessionStorage.create({ client, table, adapter: backend });
	};
}

/** Installs `backend`'s storage as the process default, as `main.ts` does for `session.storage`. */
async function installBackend(
	backend: Backend,
): Promise<{ storage: SessionStorage; connect: () => Promise<SessionStorage> }> {
	const connect = backendOpener(backend);
	const storage = await connect();
	setDefaultSessionStorage(storage);
	return { storage, connect };
}

function header(id: string, cwd: string, at: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd })}\n`;
}

function message(id: string, parentId: string | null, at: string, role: "user" | "assistant", text: string): string {
	const body =
		role === "user"
			? { role, content: text, timestamp: 1 }
			: { ...makeAssistantMessage(), content: [{ type: "text", text }] };
	return `${JSON.stringify({ type: "message", id, parentId, timestamp: at, message: body })}\n`;
}

/**
 * A transcript several read windows long: multibyte text throughout, so
 * windows end inside characters, one line longer than a window, and
 * `omega final token` last. Its first prompt is longer than the listing's
 * 4 KiB prefix and its first reply comes late, in neither the listing's head
 * nor its tail, so listing it scans its lines.
 */
function longTranscript(id: string, cwd: string): string {
	let content = header(id, cwd, AT);
	let messages = 0;
	let parent: string | null = null;
	const add = (role: "user" | "assistant", text: string) => {
		const next = `m${messages}`;
		content += message(next, parent, AT, role, text);
		parent = next;
		messages++;
	};
	add("user", `start ${"pasted log ".repeat(600)}`);
	for (let i = 0; i < 40; i++) add("user", `mixed ${i} ${"é€😀a".repeat(2500 + i * 37)} end ${i}`);
	add("user", `long-line ${"é".repeat(700_000)} long-end`);
	add("assistant", "the first reply");
	for (let i = 0; i < 20; i++) add("user", `after ${i} ${"€😀é".repeat(2000 + i * 11)} done ${i}`);
	add("user", "omega final token");
	return content;
}

/**
 * A transcript whose second read window starts with a user prompt that opens
 * with a byte order mark (`MARKED PROMPT`), then the first prompt and the
 * first reply. The loader drops the marked line as malformed (`JSON.parse`
 * refuses a mark), so its first prompt is `FIRST after mark`; nothing before
 * the window holds a prompt or a reply, so listing it scans its lines.
 */
function markedWindowTranscript(id: string, cwd: string, windowBytes: number): string {
	const head = header(id, cwd, AT);
	const pad = (bytes: number) =>
		`${JSON.stringify({ type: "custom", customType: "pad", data: "p".repeat(bytes), id: "pad", parentId: null, timestamp: AT })}\n`;
	// The header and the pad line fill the first window exactly.
	const filler = pad(windowBytes - Buffer.byteLength(head) - Buffer.byteLength(pad(0)));
	return (
		head +
		filler +
		`\uFEFF${message("m0", "pad", AT, "user", "MARKED PROMPT")}` +
		message("m1", "pad", AT, "user", "FIRST after mark") +
		message("m2", "m1", AT, "assistant", "the first reply")
	);
}

/**
 * The keyed stores whose range read keeps a byte order mark that opens the
 * range, as the whole read does. The SQL stores' `readFrom` decodes with a
 * decoder that drops such a mark; once it keeps it, they belong here too.
 */
const MARK_KEEPING_BACKENDS = KEYED_BACKENDS.filter(backend => backend === "redis");

/** Writes `content` as session `id` of project `cwd` through `storage`; returns its key. */
async function storeSession(
	storage: SessionStorage,
	cwd: string,
	id: string,
	at: string,
	content: string,
): Promise<string> {
	const dir = sessionDirForCwd(cwd);
	storage.ensureDirSync(dir);
	const file = path.join(dir, `${new Date(at).getTime()}_${id}.jsonl`);
	await storage.writeText(file, content);
	return file;
}

async function archive<T>(params: Record<string, unknown>, cwd: string): Promise<T> {
	const session = { cwd, settings: Settings.isolated() } as unknown as ToolSession;
	return (await createArchivePrelude(session).invoke(params, { session, toolCallId: "archive-test" })).details as T;
}

describe("the session listing over the session storage", () => {
	it.each(KEYED_BACKENDS)(
		"lists a %s-stored transcript several read windows long without ever reading it whole",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			const id = `windows-${crypto.randomUUID()}`;
			const content = longTranscript(id, project);
			const file = await storeSession(storage, project, id, AT, content);
			const whole = Buffer.byteLength(content, "utf-8");
			const readWhole = vi.spyOn(storage, "readText");
			const readFrom = storage.readTextFrom!.bind(storage);
			const windows: number[] = [];
			vi.spyOn(storage, "readTextFrom").mockImplementation(async (key, offset, maxBytes) => {
				const read = await readFrom(key, offset, maxBytes);
				if (key === file) windows.push(Buffer.byteLength(read.text, "utf-8"));
				return read;
			});

			const sessions = await archive<ArchiveSession[]>({ action: "sessions" }, project);

			// The first prompt lies past the listing's prefix: the line scan found it.
			expect(sessions.map(session => [session.id, session.title.slice(0, 16)])).toEqual([[id, "start pasted log"]]);
			expect(readWhole.mock.calls.filter(([key]) => key === file)).toEqual([]);
			expect(windows.length).toBeGreaterThan(1);
			expect(Math.max(...windows)).toBeLessThan(whole);
		},
		30_000,
	);

	it.each(KEYED_BACKENDS)(
		"reads a %s-stored transcript in windows that each end at a line, widen past a longer line and join to its bytes",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			const id = `exact-${crypto.randomUUID()}`;
			const content = longTranscript(id, project);
			const file = await storeSession(storage, project, id, AT, content);
			const readFrom = storage.readTextFrom!.bind(storage);
			const asked: number[] = [];
			vi.spyOn(storage, "readTextFrom").mockImplementation(async (key, offset, maxBytes) => {
				if (key === file && maxBytes !== undefined) asked.push(maxBytes);
				return readFrom(key, offset, maxBytes);
			});
			// Through the module, so the file still loads where the helper does not exist.
			const { readSessionLineWindows, SESSION_READ_WINDOW_BYTES } = sessionStorageModule;
			const windows: Uint8Array[] = [];
			for await (const window of readSessionLineWindows(storage, file)) windows.push(window);
			const visited: string[] = [];
			await storage.scanLines!(file, line => {
				if (line) visited.push(line);
				return false;
			});

			expect(Buffer.concat(windows).equals(Buffer.from(content, "utf-8"))).toBe(true);
			expect(windows.length).toBeGreaterThan(2);
			expect(windows.slice(0, -1).every(window => window.at(-1) === 0x0a)).toBe(true);
			// The 1.4 MB line does not fit one window: a read asked for more.
			expect(Math.max(...asked)).toBeGreaterThan(SESSION_READ_WINDOW_BYTES);
			expect(visited).toEqual(content.split("\n").filter(Boolean));
		},
		30_000,
	);

	it.each(MARK_KEEPING_BACKENDS)(
		"lists the loader's first prompt for a %s-stored transcript whose read window opens with a byte-order-marked line",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			const id = `marked-${crypto.randomUUID()}`;
			// Through the module, so the file still loads where the window size is not exported.
			const windowBytes = sessionStorageModule.SESSION_READ_WINDOW_BYTES ?? 1024 * 1024;
			const content = markedWindowTranscript(id, project, windowBytes);
			const file = await storeSession(storage, project, id, AT, content);
			const loaded = await loadEntriesFromFile(file, storage);
			const loaderFirst = loaded.flatMap(entry =>
				entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
					? [entry.message.content]
					: [],
			)[0];

			const listed = await SessionManager.list(project, undefined, storage);

			// The marked line starts the second window.
			expect(Buffer.from(content, "utf-8").indexOf(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(windowBytes);
			expect({ loader: loaderFirst, listed: listed.map(session => [session.id, session.firstMessage]) }).toEqual({
				loader: "FIRST after mark",
				listed: [[id, "FIRST after mark"]],
			});
		},
		30_000,
	);

	it("lists a SQLite session whose first prompt outgrows the listing's prefix without reading it whole", async () => {
		const { storage } = await installBackend("sqlite");
		const project = tempDir.join("project");
		const manager = SessionManager.create(project, undefined, storage);
		// A pasted log longer than the 4 KiB the listing reads first, then long replies.
		manager.appendMessage({ role: "user", content: `please review this log: ${"x".repeat(6000)}`, timestamp: 1 });
		for (let i = 0; i < 24; i++) {
			manager.appendMessage({
				...makeAssistantMessage(),
				content: [{ type: "text", text: `reply ${i} ${"y".repeat(100_000)}` }],
			});
			manager.appendMessage({ role: "user", content: `turn ${i}`, timestamp: 2 + i });
		}
		await manager.flush();
		const file = manager.getSessionFile()!;
		await manager.close();
		await storage.refresh?.();
		const readWhole = vi.spyOn(storage, "readText");

		const archived = await archive<ArchiveSession[]>({ action: "sessions" }, project);
		closeSessionIndex();
		const picked = await SessionManager.list(project, undefined, storage);

		expect(archived.map(session => session.id)).toEqual([manager.getSessionId()]);
		expect(picked.map(session => session.path)).toEqual([file]);
		expect(readWhole.mock.calls.filter(([key]) => key === file)).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")("resuming a session whose folder is gone", () => {
	const GIT_ENV = {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	let repo: string;

	beforeEach(async () => {
		Object.assign(process.env, GIT_ENV, { OMP_WORKTREE_DIR: tempDir.join("wt-base") });
		repo = tempDir.join("repo");
		fs.mkdirSync(repo, { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
	});

	/** A session written in a `/wt` worktree that `omp worktree clear` then removed; `writer` keeps it open. */
	async function strandedSession(
		storage: SessionStorage,
	): Promise<{ writer: SessionManager; file: string; id: string; worktree: string }> {
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/gone");
		const writer = SessionManager.create(worktree, undefined, storage);
		writer.appendMessage({ role: "user", content: "work in the worktree", timestamp: 1 });
		writer.appendMessage(makeAssistantMessage());
		await writer.flush();
		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
		return { writer, file: writer.getSessionFile()!, id: writer.getSessionId(), worktree };
	}

	function textsOf(entries: FileEntry[]): string[] {
		return entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
	}

	/** Runs the root command's start-up resume picker under `env`, picking `picked`; records which open it chose. */
	async function startUpPick(
		env: Record<string, string>,
		file: string,
		picked: SessionInfo,
	): Promise<{ opened: string[]; relocated: string[] }> {
		Object.assign(process.env, env);
		setProjectDir(repo);
		const opened: string[] = [];
		const relocated: string[] = [];
		class Chosen extends Error {}
		vi.spyOn(SessionManager, "openRelocated").mockImplementation(async sessionPath => {
			relocated.push(sessionPath);
			throw new Chosen();
		});
		const open = SessionManager.open.bind(SessionManager);
		vi.spyOn(SessionManager, "open").mockImplementation(async (sessionPath, ...rest) => {
			if (sessionPath !== file) return open(sessionPath, ...rest);
			opened.push(sessionPath);
			throw new Chosen();
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code ?? 0})`);
		}) as typeof process.exit);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const parsed = parseArgs(["--resume", "--print"]);
		Object.assign(parsed, { noExtensions: true, noSkills: true, noRules: true, noTools: true, noLsp: true });
		try {
			await expect(
				runRootCommand(parsed, ["--resume", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
					selectSession: async () => picked,
				}),
			).rejects.toBeInstanceOf(Chosen);
		} finally {
			authStorage.close();
		}
		return { opened, relocated };
	}

	it("--resume moves a removed worktree's session into the checkout without asking under file storage", async () => {
		const { storage } = await installBackend("file");
		const { writer, file, id } = await strandedSession(storage);
		await writer.close();
		const asked: string[] = [];

		const resumed = await createSessionManager(
			parseArgs(["--resume", id.slice(0, 13)]),
			repo,
			Settings.isolated(),
			async session => {
				asked.push(session.id);
				return "accepted";
			},
		);
		try {
			expect(asked).toEqual([]);
			expect(path.dirname(resumed!.getSessionFile()!)).toBe(SessionManager.getDefaultSessionDir(repo));
			expect(fs.existsSync(file)).toBe(false);
		} finally {
			await resumed?.close();
		}
	});

	it.each(KEYED_BACKENDS)(
		"--resume leaves a removed worktree's session where %s stores it while another process writes it",
		async backend => {
			const { storage, connect } = await installBackend(backend);
			// The omp that was running in the worktree, with its own client of the store.
			const { writer, file, id } = await strandedSession(await connect());
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				repo,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(resumed!.getSessionFile()).toBe(file);
				expect(asked).toEqual([]);
				// That process writes on, and the resumed session reads what it wrote.
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(resumed!.getSessionFile()!, storage))).toEqual([
					"work in the worktree",
					"the writer went on",
				]);
			} finally {
				await resumed?.close();
				await writer.close();
			}
		},
	);

	it.each(LEASE_BACKENDS.filter(backend => backend.url).map(backend => [backend.adapter, backend.url!] as const))(
		"--resume moves a removed worktree's session into the checkout without asking under a %s store that claims sessions",
		async (adapter, url) => {
			await using db = await openLeaseDb(adapter, url);
			const storage = await db.open();
			setDefaultSessionStorage(storage);
			// The omp that ran in the worktree has exited: nothing holds the session.
			const { writer, file, id } = await strandedSession(await db.open());
			await writer.close();
			await storage.refresh?.();
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				repo,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(asked).toEqual([]);
				expect(path.dirname(resumed!.getSessionFile()!)).toBe(SessionManager.getDefaultSessionDir(repo));
				await storage.refresh?.();
				expect(storage.existsSync(file)).toBe(false);
			} finally {
				await resumed?.close();
			}
		},
	);

	it.each(ROW_LEASE_BACKENDS.filter(backend => backend.url).map(backend => [backend.adapter, backend.url!] as const))(
		"--resume refuses to move a removed worktree's session while another omp process holds it on a %s store that claims sessions",
		async (adapter, url) => {
			await using db = await openLeaseDb(adapter, url);
			const storage = await db.open();
			setDefaultSessionStorage(storage);
			// The omp that was running in the worktree still runs, and holds the session's lease.
			const { writer, file, id } = await strandedSession(await db.open());
			try {
				await storage.refresh?.();
				const refusal = await createSessionManager(
					parseArgs(["--resume", id.slice(0, 13)]),
					repo,
					Settings.isolated(),
					async () => "accepted",
				).then(
					() => undefined,
					(error: unknown) => error,
				);

				expect(String(refusal)).toContain("another live omp process writes it");
				await storage.refresh?.();
				expect(storage.existsSync(file)).toBe(true);
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(file, storage))).toEqual([
					"work in the worktree",
					"the writer went on",
				]);
			} finally {
				await writer.close();
			}
		},
	);

	it("the start-up resume picker moves a removed worktree's session into the checkout where the CLI's SQLite store, which claims sessions, keeps it", async () => {
		// What `session.storage: sql` with a SQLite connection file installs at start: a store that claims sessions.
		const database = tempDir.join("picker.db");
		const dsnFile = tempDir.join("session.dsn");
		fs.writeFileSync(dsnFile, `sqlite:${database}`);
		const client = new SQL(`sqlite:${database}`);
		clients.push(client);
		const { writer, file } = await strandedSession(await SqlSessionStorage.create({ client }));
		await writer.close();

		const picked = await startUpPick({ OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile }, file, {
			path: file,
		} as SessionInfo);

		expect(picked).toEqual({ opened: [], relocated: [file] });
	}, 30_000);

	// Pins the start-up picker's wiring only: a stranded pick under a CLI store that claims nothing opens in place.
	// The only such store the CLI builds is an in-memory SQLite database, which is empty at launch and which no
	// other client can reach, so two parts are stubbed. The listing: with nothing in the store the command exits
	// with "No sessions found" before any pick. The removed-worktree check: it finds a removed worktree's session
	// folder by the bucket names the default store lists, and the empty store lists none.
	it("the start-up resume picker routes a stranded pick to open, not to the move, when the CLI's store claims nothing", async () => {
		const dsnFile = tempDir.join("session.dsn");
		fs.writeFileSync(dsnFile, "sqlite::memory:");
		const { writer, file, worktree } = await strandedSession(new FileSessionStorage());
		await writer.close();
		const listed = { path: file, cwd: worktree, id: "stranded" } as SessionInfo;
		vi.spyOn(SessionManager, "listForPicker").mockResolvedValue({ sessions: [listed] } as never);
		vi.spyOn(SessionManager, "isFromRemovedWorktree").mockImplementation(async session => session.path === file);

		const picked = await startUpPick({ OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile }, file, listed);

		expect(picked).toEqual({ opened: [file], relocated: [] });
	}, 30_000);

	/** Resumes `file` from the in-session picker over `storage`; which session it switched to, and which it moved. */
	async function inSessionPick(storage: SessionStorage, file: string) {
		const relocated: string[] = [];
		vi.spyOn(SessionManager, "openRelocated").mockImplementation(async sessionPath => {
			relocated.push(sessionPath);
			throw new Error("moved");
		});
		const switchSession = vi.fn(async (_sessionPath: string) => false);
		const settings = Settings.isolated();
		vi.spyOn(settings, "flush").mockImplementation(async () => {});
		const ctx = {
			session: { switchSession },
			sessionManager: {
				getCwd: () => repo,
				getSessionDir: () => SessionManager.getDefaultSessionDir(repo),
				getSessionFile: () => undefined,
				getStorage: () => storage,
			},
			settings,
			prepareSessionSwitch: vi.fn(async () => {}),
			resetObserverRegistry: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).handleResumeSession(file);

		return { switched: switchSession.mock.calls.map(([sessionPath]) => sessionPath), relocated };
	}

	it.each(KEYED_BACKENDS)(
		"the in-session resume picker resumes a removed worktree's session where %s stores it",
		async backend => {
			const { storage, connect } = await installBackend(backend);
			const { writer, file } = await strandedSession(await connect());
			await writer.close();
			await storage.refresh?.();

			expect(await inSessionPick(storage, file)).toEqual({ switched: [file], relocated: [] });
		},
	);

	it("the in-session resume picker moves a removed worktree's session under file storage", async () => {
		const { storage } = await installBackend("file");
		const { writer, file } = await strandedSession(storage);
		await writer.close();

		expect(await inSessionPick(storage, file)).toEqual({ switched: [], relocated: [file] });
	});

	it.each(LEASE_BACKENDS.filter(backend => backend.url).map(backend => [backend.adapter, backend.url!] as const))(
		"the in-session resume picker moves a removed worktree's session under a %s store that claims sessions",
		async (adapter, url) => {
			await using db = await openLeaseDb(adapter, url);
			const storage = await db.open();
			setDefaultSessionStorage(storage);
			const { writer, file } = await strandedSession(await db.open());
			await writer.close();
			await storage.refresh?.();

			expect(await inSessionPick(storage, file)).toEqual({ switched: [], relocated: [file] });
		},
	);

	it.each(KEYED_BACKENDS)(
		"--continue after the project folder was renamed continues the session where %s stores it",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-rename";
			const { storage, connect } = await installBackend(backend);
			const before = tempDir.join("project-before");
			const after = tempDir.join("project-after");
			fs.mkdirSync(before);
			const writer = SessionManager.create(before, undefined, await connect());
			writer.appendMessage({ role: "user", content: "work before the rename", timestamp: 1 });
			writer.appendMessage(makeAssistantMessage());
			await writer.flush();
			const file = writer.getSessionFile()!;
			writeTerminalBreadcrumb(before, file);
			// `mv`: the same directory at a new path, the evidence of a rename `--continue` looks for.
			fs.renameSync(before, after);
			// A launch's store starts with what other clients committed before it.
			await storage.refresh?.();

			const resumed = await SessionManager.continueRecent(after, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(file, storage))).toEqual([
					"work before the rename",
					"the writer went on",
				]);
			} finally {
				await resumed.close();
				await writer.close();
			}
		},
	);

	it.each(KEYED_BACKENDS)(
		"--continue resumes the terminal's last session when another %s client wrote it after this store loaded",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-breadcrumb";
			const { storage, connect } = await installBackend(backend);
			const project = tempDir.join("project");
			fs.mkdirSync(project);
			// Another omp process ran this terminal's last session, then another terminal's newer one.
			const other = await connect();
			const turn = (text: string) =>
				message("u1", null, AT, "user", text) + message("a1", "u1", AT, "assistant", "noted");
			const file = await storeSession(
				other,
				project,
				`last-${crypto.randomUUID()}`,
				AT,
				header("last-session", project, AT) + turn("this terminal"),
			);
			await storeSession(
				other,
				project,
				`newer-${crypto.randomUUID()}`,
				"2026-03-02T00:00:00.000Z",
				header("newer-session", project, AT) + turn("another terminal"),
			);
			writeTerminalBreadcrumb(project, file);

			const resumed = await SessionManager.continueRecent(project, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
			} finally {
				await resumed.close();
			}
		},
	);

	it.each(KEYED_BACKENDS)(
		"--continue looks the terminal's last session up in the %s store it was given, not in the process default",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-given-store";
			// An SDK host that resumes from its own store while the process default stays file storage.
			setDefaultSessionStorage(new FileSessionStorage());
			const storage = await backendOpener(backend)();
			const project = tempDir.join("project");
			fs.mkdirSync(project);
			const turn = message("u1", null, AT, "user", "last turn") + message("a1", "u1", AT, "assistant", "noted");
			const file = await storeSession(
				storage,
				project,
				"given-store",
				AT,
				header("given-store", project, AT) + turn,
			);
			// Another terminal's newer session, which a pick by time would take instead.
			const newer = "2026-03-02T00:00:00.000Z";
			await storeSession(storage, project, "given-newer", newer, header("given-newer", project, newer) + turn);
			writeTerminalBreadcrumb(project, file);

			const resumed = await SessionManager.continueRecent(project, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
			} finally {
				await resumed.close();
			}
		},
	);

	it.each(KEYED_BACKENDS)(
		"--resume <id> from a renamed folder offers the move of a %s-stored session, and accepting files it there",
		async backend => {
			const { storage } = await installBackend(backend);
			const before = tempDir.join("project-before");
			const after = tempDir.join("project-after");
			fs.mkdirSync(before);
			const writer = SessionManager.create(before, undefined, storage);
			writer.appendMessage({ role: "user", content: "work before the rename", timestamp: 1 });
			writer.appendMessage(makeAssistantMessage());
			await writer.flush();
			const file = writer.getSessionFile()!;
			const id = writer.getSessionId();
			await writer.close();
			fs.renameSync(before, after);
			setProjectDir(after);
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				after,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(asked).toEqual([id]);
				expect(path.dirname(resumed!.getSessionFile()!)).toBe(sessionDirForCwd(after));
				expect(storage.existsSync(file)).toBe(false);
			} finally {
				await resumed?.close();
			}
		},
	);
});
