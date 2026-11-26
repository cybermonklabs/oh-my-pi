/**
 * Every view of the `archive` eval prelude under each session storage: file
 * storage, and `session.storage: sql` on SQLite always and on PostgreSQL and
 * MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database. Each backend gets the same two sessions, written the way
 * omp writes them: a turn through the session manager on the configured
 * storage, the prompt submitted to prompt history, and the idle recap the
 * session journals. A second client of the same store, as a later omp process
 * holds, then reads every view. File storage is the control: a view it does
 * not answer is a fault of this test, not of the store.
 *
 * The recaps come from history.db's journal under every storage, so a store
 * whose sessions journal no recap shows none in any view.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ArchiveProject,
	ArchivePrompt,
	ArchiveRecap,
	ArchiveSession,
	ArchiveSessionDetail,
} from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex, listSessionRecaps } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SqlSessionStorageAdapter } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb } from "./sql-session-lease-fixture";

type Backend = { name: "file"; url: string } | { name: SqlSessionStorageAdapter; url: string | undefined };

const BACKENDS: readonly Backend[] = [
	{ name: "file", url: "file" },
	...LEASE_BACKENDS.map(({ adapter, url }) => ({ name: adapter, url })),
];
const TIMEOUT_MS = 60_000;

const A = {
	prompt: "fix the login form",
	reply: "The login form now validates both fields.",
	title: "Login form fix",
	recap: "Fixed the login form validation; its tests pass.",
};
const B = {
	prompt: "refactor the config parser",
	reply: "The parser now reads one key per line.",
	title: "Config parser refactor",
	recap: "Refactored the config parser into one pass.",
};

interface Written {
	id: string;
	file: string;
}

interface Seeded {
	app: string;
	lib: string;
	a: Written;
	b: Written;
	dispose(): Promise<void>;
}

function addTurn(manager: SessionManager, user: string, reply: string): void {
	manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: reply }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

/**
 * One session in `cwd`, written as an interactive omp session writes it: the
 * turn through the session manager, the submitted prompt into prompt history
 * (what the editor does on submit), the title, and the idle recap the idle
 * maintenance journals through `SessionManager.recordRecap`.
 */
async function writeSession(storage: SessionStorage, cwd: string, text: typeof A): Promise<Written> {
	const manager = SessionManager.create(cwd, undefined, storage);
	addTurn(manager, text.prompt, text.reply);
	await manager.flush();
	await manager.setSessionName(text.title, "auto");
	await HistoryStorage.open().add(text.prompt, cwd, manager.getSessionId());
	manager.recordRecap(text.recap);
	await manager.flush();
	const written = { id: manager.getSessionId(), file: manager.getSessionFile() ?? "" };
	await manager.close();
	if (!written.file) throw new Error(`the session in ${cwd} has no session file`);
	return written;
}

/** Points the agent dir, and with it history.db, at `dir` until the returned restore runs. */
function useAgentDir(dir: string): () => void {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	setAgentDir(dir);
	HistoryStorage.close();
	closeSessionIndex();
	return () => {
		HistoryStorage.close();
		closeSessionIndex();
		if (previousAgentDir) setAgentDir(previousAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
	};
}

async function seed(backend: Backend): Promise<Seeded> {
	const previousStorage = defaultSessionStorage();
	const dir = TempDir.createSync(`@omp-archive-${backend.name}-`);
	const restoreAgentDir = useAgentDir(dir.join("agent"));
	const app = dir.join("app");
	const lib = dir.join("lib");
	fs.mkdirSync(app, { recursive: true });
	fs.mkdirSync(lib, { recursive: true });
	let db: LeaseDb | undefined;
	let writer: SessionStorage;
	let reader: () => Promise<SessionStorage>;
	if (backend.name === "file") {
		writer = new FileSessionStorage();
		reader = async () => new FileSessionStorage();
	} else {
		const opened = await openLeaseDb(backend.name, backend.url ?? "");
		db = opened;
		writer = await opened.open();
		reader = () => opened.open();
	}
	// What main.ts installs for the configured storage.
	setDefaultSessionStorage(writer);
	const a = await writeSession(writer, app, A);
	const b = await writeSession(writer, lib, B);
	await writer.drain();
	// A later omp process reads the archive through its own client of the store.
	setDefaultSessionStorage(await reader());
	return {
		app,
		lib,
		a,
		b,
		async dispose() {
			setDefaultSessionStorage(previousStorage);
			try {
				await db?.[Symbol.asyncDispose]();
			} finally {
				restoreAgentDir();
				dir.removeSync();
			}
		},
	};
}

function toolSession(cwd: string): ToolSession {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		// One definition for the session's life: a call checks that the prelude it authorized is the one it runs.
		getEvalPreludes: () => preludes,
	};
	const preludes = [createArchivePrelude(session)];
	return session;
}

/** A view through the prelude's host call, the path every `archive.*` call of the eval tool takes. */
async function view<T>(params: Record<string, unknown>, cwd: string): Promise<T> {
	const session = toolSession(cwd);
	const result = await createArchivePrelude(session).invoke(params, { session, toolCallId: "archive-storage" });
	return result.details as T;
}

/**
 * A view through the eval tool's JavaScript `archive` namespace. The cell prints the view's JSON in slices,
 * each closed by `|` so no output trimming can move a slice's edge: eval output cuts every line at 512
 * bytes, which a session detail's JSON passes.
 */
async function viaNamespace<T>(expression: string, cwd: string, sessionId: string): Promise<T> {
	const marker = "ARCHIVE-JSON ";
	const result = await executeJs(
		[
			"{",
			`const json = JSON.stringify((await ${expression}) ?? null);`,
			`for (let at = 0; at < json.length; at += 120) print(${JSON.stringify(marker)} + json.slice(at, at + 120) + "|");`,
			"}",
		].join("\n"),
		{ sessionId, session: toolSession(cwd), cwd },
	);
	const slices = result.output.split("\n").filter(text => text.startsWith(marker) && text.endsWith("|"));
	if (result.exitCode !== 0 || slices.length === 0) {
		throw new Error(
			`archive namespace call ${expression} exited ${result.exitCode}: ${result.output.slice(0, 2000)}`,
		);
	}
	return JSON.parse(slices.map(text => text.slice(marker.length, -1)).join("")) as T;
}

function sessionFacts(session: ArchiveSession) {
	return { id: session.id, project: session.project, title: session.title, recap: session.recap };
}

function detailFacts(detail: ArchiveSessionDetail) {
	return {
		id: detail.id,
		file: detail.file,
		project: detail.project,
		title: detail.title,
		messages: detail.messages,
		prompts: detail.prompts.map(prompt => prompt.text),
		recaps: detail.recaps.map(recap => recap.text),
	};
}

const texts = (records: ArchivePrompt[] | ArchiveRecap[]): string[] => records.map(record => record.text);
const sorted = (values: string[]): string[] => [...values].sort();

afterAll(async () => {
	await disposeAllVmContexts();
});

for (const backend of BACKENDS) {
	describe.skipIf(!backend.url)(`archive views under ${backend.name} session storage`, () => {
		let fx: Seeded;
		beforeAll(async () => {
			fx = await seed(backend);
		}, TIMEOUT_MS);
		afterAll(async () => {
			await fx?.dispose();
		}, TIMEOUT_MS);

		it(
			"projects lists both projects with their newest session and its recap",
			async () => {
				const projects = await view<ArchiveProject[]>({ action: "projects" }, fx.app);
				// Sorted by path: which of two sessions written in one clock tick is "newest" is not this test's subject.
				expect(
					projects
						.map(project => ({
							path: project.path,
							sessions: project.sessions,
							latest: project.latest.id,
							recap: project.latest.recap,
						}))
						.sort((x, y) => x.path.localeCompare(y.path)),
				).toEqual([
					{ path: fx.app, sessions: 1, latest: fx.a.id, recap: A.recap },
					{ path: fx.lib, sessions: 1, latest: fx.b.id, recap: B.recap },
				]);
			},
			TIMEOUT_MS,
		);

		it(
			"sessions lists the current project's session with its title and recap",
			async () => {
				const sessions = await view<ArchiveSession[]>({ action: "sessions" }, fx.app);
				expect(sessions.map(sessionFacts)).toEqual([
					{ id: fx.a.id, project: fx.app, title: A.title, recap: A.recap },
				]);
			},
			TIMEOUT_MS,
		);

		it(
			"sessions across every project lists both sessions",
			async () => {
				const sessions = await view<ArchiveSession[]>({ action: "sessions", project: "*" }, fx.app);
				expect(sessions.map(sessionFacts).sort((x, y) => x.project.localeCompare(y.project))).toEqual([
					{ id: fx.a.id, project: fx.app, title: A.title, recap: A.recap },
					{ id: fx.b.id, project: fx.lib, title: B.title, recap: B.recap },
				]);
			},
			TIMEOUT_MS,
		);

		it(
			"sessions of another project named by a relative path lists only that project's session",
			async () => {
				const sessions = await view<ArchiveSession[]>({ action: "sessions", project: "../lib" }, fx.app);
				expect(sessions.map(session => session.id)).toEqual([fx.b.id]);
			},
			TIMEOUT_MS,
		);

		for (const [by, id] of [
			["its id prefix", () => fx.a.id.slice(0, 13)],
			["its absolute file", () => fx.a.file],
			["its .jsonl path relative to the project", () => path.relative(fx.app, fx.a.file)],
		] as const) {
			it(
				`session by ${by} opens the session with its own prompts and recaps`,
				async () => {
					const detail = await view<ArchiveSessionDetail>({ action: "session", id: id() }, fx.app);
					expect(detailFacts(detail)).toEqual({
						id: fx.a.id,
						file: fx.a.file,
						project: fx.app,
						title: A.title,
						messages: 2,
						prompts: [A.prompt],
						recaps: [A.recap],
					});
				},
				TIMEOUT_MS,
			);
		}

		it(
			"prompts lists the current project's prompt, and every project's with *",
			async () => {
				const local = await view<ArchivePrompt[]>({ action: "prompts" }, fx.app);
				const all = await view<ArchivePrompt[]>({ action: "prompts", project: "*" }, fx.app);
				expect({ local: texts(local), all: sorted(texts(all)) }).toEqual({
					local: [A.prompt],
					all: sorted([A.prompt, B.prompt]),
				});
			},
			TIMEOUT_MS,
		);

		it(
			"search finds a prompt by a word, within the project or across all",
			async () => {
				const local = await view<ArchivePrompt[]>({ action: "prompts", query: "login" }, fx.app);
				const all = await view<ArchivePrompt[]>({ action: "prompts", query: "parser", project: "*" }, fx.app);
				expect({ local: texts(local), all: texts(all) }).toEqual({ local: [A.prompt], all: [B.prompt] });
			},
			TIMEOUT_MS,
		);

		it(
			"recaps lists the current project's recap, and every project's with *",
			async () => {
				const local = await view<ArchiveRecap[]>({ action: "recaps" }, fx.app);
				const all = await view<ArchiveRecap[]>({ action: "recaps", project: "*" }, fx.app);
				expect({ local: texts(local), all: sorted(texts(all)) }).toEqual({
					local: [A.recap],
					all: sorted([A.recap, B.recap]),
				});
			},
			TIMEOUT_MS,
		);

		it(
			"the eval tool's archive namespace returns the same views",
			async () => {
				const sessionId = `archive-storage-${backend.name}`;
				const ns = <T>(expression: string) => viaNamespace<T>(expression, fx.app, sessionId);
				const sessions = await ns<ArchiveSession[]>("archive.sessions({ silent: true })");
				const detail = await ns<ArchiveSessionDetail>(
					`archive.session(${JSON.stringify(fx.a.id.slice(0, 13))}, { silent: true })`,
				);
				const prompts = await ns<ArchivePrompt[]>("archive.prompts({ silent: true })");
				const found = await ns<ArchivePrompt[]>('archive.search("login", { silent: true })');
				const recaps = await ns<ArchiveRecap[]>("archive.recaps({ silent: true })");
				const projects = await ns<ArchiveProject[]>("archive.projects({ silent: true })");
				expect({
					sessions: sessions.map(sessionFacts),
					detail: detailFacts(detail),
					prompts: texts(prompts),
					found: texts(found),
					recaps: texts(recaps),
					projects: sorted(projects.map(project => project.latest.id)),
				}).toEqual({
					sessions: [{ id: fx.a.id, project: fx.app, title: A.title, recap: A.recap }],
					detail: {
						id: fx.a.id,
						file: fx.a.file,
						project: fx.app,
						title: A.title,
						messages: 2,
						prompts: [A.prompt],
						recaps: [A.recap],
					},
					prompts: [A.prompt],
					found: [A.prompt],
					recaps: [A.recap],
					projects: sorted([fx.a.id, fx.b.id]),
				});
			},
			TIMEOUT_MS,
		);
	});
}

describe("the idle recap journal", () => {
	let dir: TempDir;
	let restoreAgentDir: () => void;
	beforeEach(() => {
		dir = TempDir.createSync("@omp-recap-journal-");
		restoreAgentDir = useAgentDir(dir.join("agent"));
	});
	afterEach(() => {
		restoreAgentDir();
		dir.removeSync();
	});

	const journaled = (manager: SessionManager) =>
		listSessionRecaps({ sessionIds: [manager.getSessionId()] }).map(recap => recap.recap);

	it("journals a recap of a persisted file session, the control for the cases below", async () => {
		const manager = SessionManager.create(dir.path(), dir.join("sessions"), new FileSessionStorage());
		addTurn(manager, A.prompt, A.reply);
		await manager.flush();
		manager.recordRecap(A.recap);
		expect(journaled(manager)).toEqual([A.recap]);
		await manager.close();
	});

	it("journals no recap of an in-memory session, even on a file store", async () => {
		const manager = SessionManager.inMemory(dir.path(), new FileSessionStorage());
		addTurn(manager, A.prompt, A.reply);
		manager.recordRecap(A.recap);
		expect(journaled(manager)).toEqual([]);
		await manager.close();
	});

	it("journals no recap of a session kept in a memory store", async () => {
		const manager = SessionManager.create(dir.path(), dir.join("sessions"), new MemorySessionStorage());
		addTurn(manager, A.prompt, A.reply);
		await manager.flush();
		manager.recordRecap(A.recap);
		expect(journaled(manager)).toEqual([]);
		await manager.close();
	});
});
