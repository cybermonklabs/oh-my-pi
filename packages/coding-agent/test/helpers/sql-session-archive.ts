/**
 * The test env of the tests that run a session under every session storage:
 * file storage and SQLite always, and PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database. Every SQL store a test opens uses its own table, dropped when the
 * test ends. Upstream's helper of the same name also serves the archive's
 * transcript index, which this tree does not have; this one keeps only the env.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, vi } from "bun:test";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./settings-test-state";

export type Backend = "file" | SqlSessionStorageAdapter;

export const SQL_URLS: Record<SqlSessionStorageAdapter, string | undefined> = {
	sqlite: "sqlite",
	postgres: process.env.OMP_TEST_SQL_POSTGRES_URL,
	mysql: process.env.OMP_TEST_SQL_MYSQL_URL,
};
export const SQL_BACKENDS = (Object.keys(SQL_URLS) as SqlSessionStorageAdapter[]).filter(adapter => SQL_URLS[adapter]);
export const BACKENDS: Backend[] = ["file", ...SQL_BACKENDS];

/** One test file's state: a temp agent directory, and the SQL clients and cleanups its tests opened. */
export interface SqlSessionTestEnv {
	readonly tempDir: TempDir;
	/** The process default storage before the test, restored after it. */
	readonly previousStorage: SessionStorage;
	/** Clients ended after each test. */
	readonly clients: SQL[];
	/** Run after each test, last first, before the clients end. */
	readonly cleanups: Array<() => Promise<void>>;
	/** A tag no other table of this run has. */
	uniqueTag(): string;
	/**
	 * Opens `backend`'s storage. Each call for a SQL backend is a new client of
	 * the same database and table, as each omp process holds its own.
	 */
	backendOpener(backend: Backend): () => Promise<SessionStorage>;
	/** Installs `backend`'s storage as the process default, as `main.ts` does for `session.storage`. */
	installBackend(backend: Backend): Promise<{ storage: SessionStorage; connect: () => Promise<SessionStorage> }>;
}

/** Registers `beforeEach`/`afterEach` for a test file and returns its state. */
export function useSqlSessionTestEnv(prefix: string): SqlSessionTestEnv {
	let seq = 0;
	let tempDir: TempDir | undefined;
	let settingsState: SettingsTestState | undefined;
	let previousStorage: SessionStorage | undefined;
	const clients: SQL[] = [];
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		settingsState = beginSettingsTest();
		previousStorage = defaultSessionStorage();
		tempDir = TempDir.createSync(prefix);
		HistoryStorage.close();
		closeSessionIndex();
		setAgentDir(tempDir.join("agent"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (previousStorage) setDefaultSessionStorage(previousStorage);
		HistoryStorage.close();
		closeSessionIndex();
		clearOmpExtensionCliRoots();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		for (const client of clients.splice(0)) await client.end();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		tempDir?.removeSync();
	});

	const env: SqlSessionTestEnv = {
		get tempDir() {
			if (!tempDir) throw new Error("the SQL session test env is read outside a test");
			return tempDir;
		},
		get previousStorage() {
			if (!previousStorage) throw new Error("the SQL session test env is read outside a test");
			return previousStorage;
		},
		clients,
		cleanups,
		uniqueTag: () => `${process.pid}_${Date.now().toString(36)}_${seq++}`,
		backendOpener(backend) {
			if (backend === "file") return async () => new FileSessionStorage();
			const table = `omp_aar_${env.uniqueTag()}`;
			const url = backend === "sqlite" ? `sqlite:${env.tempDir.join("sessions.db")}` : SQL_URLS[backend]!;
			let first: SQL | undefined;
			return async () => {
				const client = new SQL(url);
				clients.push(client);
				if (!first) {
					first = client;
					cleanups.push(async () => {
						// This tree's store also keeps blobs and their references beside the session table.
						for (const name of [`${table}_parts`, `${table}_blobs`, `${table}_refs`, table]) {
							await client.unsafe(`DROP TABLE IF EXISTS ${name}`);
						}
					});
				}
				return SqlSessionStorage.create({ client, table, adapter: backend });
			};
		},
		async installBackend(backend) {
			const connect = env.backendOpener(backend);
			const storage = await connect();
			setDefaultSessionStorage(storage);
			return { storage, connect };
		},
	};
	return env;
}
