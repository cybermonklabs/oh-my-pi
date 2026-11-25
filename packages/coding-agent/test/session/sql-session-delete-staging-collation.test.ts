/**
 * A session delete removes every staging part under the session's artifacts
 * directory whatever collation the `path` column compares with. Here the
 * PostgreSQL database's default collation is ICU's Thai one, which ignores
 * punctuation at its first level, so the paths under `<stem>/` do not all sort
 * below `<stem>0`. The case makes its own database on the server that
 * `OMP_TEST_SQL_POSTGRES_URL` names, and drops it after; it is skipped when
 * that login may not create a database or the server has no Thai ICU
 * collation. The last cases give the `path` columns a nondeterministic ICU
 * collation that ignores letter case, and check that the delete leaves the
 * staging parts of another session's write, and another session's image
 * references and rows, alone; they make a database of their own too, and are
 * skipped when the server cannot make such a collation.
 */
import type {
	SqlSessionStorageClient,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type LeaseDb, openLeaseDb, reserveWrapped, STILL, transcript, until } from "./sql-session-lease-fixture";

const SERVER_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
const ID = "01a1f000-0000-7000-8000-0000000000e2";
const PROCESS_SCRIPT = path.join(import.meta.dir, "sql-session-delete-staging-process.ts");
const DATABASE = `omp_th_${process.pid}_${Date.now().toString(36)}`;

/** Why the case cannot run on `SERVER_URL`'s server, or `undefined` when it can. */
async function skipReason(): Promise<string | undefined> {
	if (!SERVER_URL) return "OMP_TEST_SQL_POSTGRES_URL is not set";
	const admin = new SQL(SERVER_URL);
	try {
		const [role] = (await admin.unsafe(
			"SELECT rolcreatedb OR rolsuper AS can FROM pg_catalog.pg_roles WHERE rolname = current_user",
		)) as Array<{ can: boolean }>;
		if (!role?.can) return "the login may not create a database";
		const thai = await admin.unsafe(
			"SELECT 1 FROM pg_catalog.pg_collation WHERE collprovider = 'i' AND collname IN ('th-x-icu', 'th-TH-x-icu')",
		);
		if (thai.length === 0) return "the server has no Thai ICU collation";
		return undefined;
	} finally {
		await admin.end();
	}
}

const SKIP = await skipReason();
if (SKIP) console.warn(`sql-session-delete-staging-collation: skipped: ${SKIP}`);

/** The URL of {@link DATABASE} on `SERVER_URL`'s server. */
function databaseUrl(): string {
	const url = new URL(SERVER_URL ?? "");
	url.pathname = `/${DATABASE}`;
	return url.toString();
}

/** Every distinct path in the parts table. */
async function partPaths(db: LeaseDb): Promise<string[]> {
	return (await db.sql(`SELECT DISTINCT path FROM ${db.table}_parts`)).map(row => String(row.path)).sort();
}

describe.skipIf(SKIP !== undefined)(
	`deleting a SQL session on a PostgreSQL database whose default collation is ICU Thai${SKIP ? ` (skipped: ${SKIP})` : ""}`,
	() => {
		beforeAll(async () => {
			const admin = new SQL(SERVER_URL ?? "");
			try {
				await admin.unsafe(
					`CREATE DATABASE ${DATABASE} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'th' LOCALE 'C'`,
				);
			} finally {
				await admin.end();
			}
		});

		afterAll(async () => {
			const admin = new SQL(SERVER_URL ?? "");
			try {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
			} finally {
				await admin.end();
			}
		});

		it("removes the staging parts a killed first write of a subagent transcript left under its artifacts directory, and no neighbour's rows or parts", async () => {
			// If this regresses, deleting a session on a database with a Thai default collation leaves the parts
			// of its half-written subagent transcript in the database, where no listing shows them.
			await using db = await openLeaseDb("postgres", databaseUrl());
			const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const stem = file.slice(0, -".jsonl".length);
			const artifacts = `${stem}/`;
			const subagent = `${artifacts}Task.jsonl`;
			const store = await db.open({ lease: STILL });
			const releaseFirst = await store.acquireSessionClaim?.(ID, file);
			await store.writeText(file, transcript(ID, "parent"));
			await store.drain();
			releaseFirst?.();
			await store.drain();

			// Other sessions whose paths share the session's stem, and their own artifacts directories.
			const neighbours = [
				`${stem} b.jsonl`,
				`${stem}0.jsonl`,
				`${stem}.jsonl.bak`,
				`${stem}b/Task.jsonl`,
				`${stem}-x/Task.jsonl`,
				`${stem}~/Task.jsonl`,
				`${stem}#/Task.jsonl`,
			];
			const others = await db.open({ claims: false });
			for (const neighbour of neighbours) await others.writeText(neighbour, transcript(ID, "neighbour"));
			await others.drain();

			// Another process takes the session over and dies inside the staged first write of its subagent's transcript.
			const child = Bun.spawn(
				[
					process.execPath,
					PROCESS_SCRIPT,
					JSON.stringify({
						dsn: db.dsn,
						table: db.table,
						leaseTable: db.leaseTable,
						lease: STILL,
						id: ID,
						sessionFile: file,
						file: subagent,
					}),
				],
				{ stdout: "pipe", stderr: "pipe", env: process.env },
			);
			try {
				const reader = child.stdout.getReader();
				let report = "";
				while (!report.includes("\n")) {
					const { done, value } = await reader.read();
					if (done) throw new Error(`the writer exited early: ${await new Response(child.stderr).text()}`);
					report += new TextDecoder().decode(value);
				}
				expect(JSON.parse(report)).toEqual({ staged: true });
			} finally {
				child.kill("SIGKILL");
				await child.exited;
			}
			const staged = (await partPaths(db)).filter(stored => stored.startsWith(artifacts));
			expect(staged.length).toBe(1);
			expect(staged[0]?.startsWith(`${subagent}#staging-`)).toBe(true);

			// The dead process's claim is taken over once its lease row looks expired.
			await db.ageLease(ID, STILL.expiryMs + 60_000);
			await store.refresh();
			let release: (() => void) | null | undefined;
			await until(async () => {
				release = await store.acquireSessionClaim?.(ID, file);
				return typeof release === "function";
			});
			await store.deleteSessionWithArtifacts(file);
			await store.drain();
			const parts = await partPaths(db);
			const rows = await db.paths();
			expect({
				partsUnderArtifacts: parts.filter(stored => stored.startsWith(artifacts)),
				sessionRows: rows.filter(stored => stored === file || stored.startsWith(artifacts)),
				neighbourRows: neighbours.filter(neighbour => rows.includes(neighbour)),
				neighbourParts: neighbours.filter(neighbour => parts.includes(neighbour)),
			}).toEqual({
				partsUnderArtifacts: [],
				sessionRows: [],
				neighbourRows: neighbours,
				neighbourParts: neighbours,
			});
			release?.();
		}, 120_000);
	},
);

const ND_DATABASE = `omp_nd_${process.pid}_${Date.now().toString(36)}`;
const ND_COLLATION = "path_ci";

/** Why the nondeterministic-collation case cannot run on `SERVER_URL`'s server, or `undefined` when it can. */
async function nondeterministicSkipReason(): Promise<string | undefined> {
	if (!SERVER_URL) return "OMP_TEST_SQL_POSTGRES_URL is not set";
	const admin = new SQL(SERVER_URL);
	try {
		const [role] = (await admin.unsafe(
			"SELECT rolcreatedb OR rolsuper AS can FROM pg_catalog.pg_roles WHERE rolname = current_user",
		)) as Array<{ can: boolean }>;
		if (!role?.can) return "the login may not create a database";
		// Nondeterministic collations exist since PostgreSQL 12, and only with the ICU provider.
		const [version] = (await admin.unsafe("SELECT current_setting('server_version_num')::int AS num")) as Array<{
			num: number;
		}>;
		if ((version?.num ?? 0) < 120000) return "the server makes no nondeterministic collation (before PostgreSQL 12)";
		const icu = await admin.unsafe("SELECT 1 FROM pg_catalog.pg_collation WHERE collprovider = 'i' LIMIT 1");
		if (icu.length === 0) return "the server has no ICU collations";
		return undefined;
	} finally {
		await admin.end();
	}
}

const ND_SKIP = await nondeterministicSkipReason();
if (ND_SKIP) console.warn(`sql-session-delete-staging-collation (nondeterministic): skipped: ${ND_SKIP}`);

/**
 * A client wrapper under which a staged full write stops between its staging
 * and its swap: every transaction after the first one that wrote staging
 * parts waits until `release()`. `staged` resolves once that first one has
 * committed. Where the store reserves a connection for each transaction, a
 * transaction is the statements of one reserved connection, from its opening
 * to its `COMMIT`.
 */
function holdSwapAfterStaging(): {
	wrap: (inner: SqlSessionStorageClient) => SqlSessionStorageClient;
	staged: Promise<void>;
	release: () => void;
} {
	const staged = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let hasStaged = false;
	const committed = (stages: boolean): void => {
		if (stages && !hasStaged) {
			hasStaged = true;
			staged.resolve();
		}
	};
	return {
		staged: staged.promise,
		release: () => gate.resolve(),
		wrap: inner => ({
			options: inner.options,
			unsafe: (query, values) => inner.unsafe(query, values),
			async transaction(callback) {
				if (hasStaged) await gate.promise;
				let stages = false;
				const result = await inner.transaction(transaction =>
					callback({
						unsafe(query, values) {
							if (values?.some(value => typeof value === "string" && value.includes("#staging-"))) stages = true;
							return transaction.unsafe(query, values);
						},
					} satisfies SqlSessionStorageTransaction),
				);
				committed(stages);
				return result;
			},
			end: () => inner.end?.() ?? Promise.resolve(),
			...reserveWrapped(inner, connection => {
				let opened = false;
				let stages = false;
				return {
					async unsafe(query, values) {
						if (!opened) {
							opened = true;
							if (hasStaged) await gate.promise;
						}
						if (values?.some(value => typeof value === "string" && value.includes("#staging-"))) stages = true;
						const result = await connection.unsafe(query, values);
						if (query === "COMMIT") committed(stages);
						return result;
					},
				};
			}),
		}),
	};
}

describe.skipIf(ND_SKIP !== undefined)(
	`deleting a SQL session on PostgreSQL whose path column has a nondeterministic ICU collation${ND_SKIP ? ` (skipped: ${ND_SKIP})` : ""}`,
	() => {
		/** The URL of {@link ND_DATABASE} on `SERVER_URL`'s server. */
		const ndDatabaseUrl = (): string => {
			const url = new URL(SERVER_URL ?? "");
			url.pathname = `/${ND_DATABASE}`;
			return url.toString();
		};

		beforeAll(async () => {
			const admin = new SQL(SERVER_URL ?? "");
			try {
				await admin.unsafe(`CREATE DATABASE ${ND_DATABASE} TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`);
			} finally {
				await admin.end();
			}
			const db = new SQL(ndDatabaseUrl());
			try {
				// Case-insensitive: "a" and "A" compare equal.
				await db.unsafe(
					`CREATE COLLATION ${ND_COLLATION} (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
				);
			} finally {
				await db.end();
			}
		});

		afterAll(async () => {
			const admin = new SQL(SERVER_URL ?? "");
			try {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${ND_DATABASE} WITH (FORCE)`);
			} finally {
				await admin.end();
			}
		});

		it("lets another session's staged first write under a directory named the same but for letter case finish with its body", async () => {
			// If this regresses, deleting a session makes another session's subagent transcript, whose first save is
			// under way in a directory whose name differs only in letter case, fail to save with a write conflict.
			await using db = await openLeaseDb("postgres", ndDatabaseUrl());
			// The tables, made by hand before the store starts, compare paths with the nondeterministic collation.
			await db.sql(
				`CREATE TABLE ${db.table} (path TEXT COLLATE ${ND_COLLATION} PRIMARY KEY, content TEXT NOT NULL, ` +
					"mtime_ms BIGINT NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, byte_len BIGINT)",
			);
			await db.sql(
				`CREATE TABLE ${db.table}_parts (path TEXT COLLATE ${ND_COLLATION} NOT NULL, start_offset BIGINT NOT NULL, ` +
					"content TEXT NOT NULL, PRIMARY KEY (path, start_offset))",
			);
			const root = path.join(db.dir.path(), "sessions", "-project-");
			const file = path.join(root, "a.jsonl");
			const artifacts = `${path.join(root, "a")}/`;
			const neighbour = path.join(root, "A", "Task.jsonl");
			const owner = await db.open({ claims: false });
			await owner.writeText(file, transcript(ID, "parent"));
			await owner.writeText(`${artifacts}Task.jsonl`, transcript(ID, "child"));
			await owner.drain();

			// Another store writes the neighbour's first body and stops after staging it, before its swap.
			const hold = holdSwapAfterStaging();
			const writer = await db.open({ claims: false, wrap: hold.wrap });
			await writer.refresh();
			const lines = transcript(ID, "neighbour")
				.split("\n")
				.filter(Boolean)
				.map(line => `${line}\n`);
			const write = (async () => {
				await writer.writeLinesAtomic(neighbour, lines, { expectedSize: null });
				await writer.drain();
			})().then(
				() => "saved",
				(err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
			);
			await hold.staged;

			await owner.deleteSessionWithArtifacts(file);
			await owner.drain();
			hold.release();

			expect(await write).toBe("saved");
			const reader = await db.open({ claims: false });
			await reader.refresh();
			expect(await reader.readText(neighbour)).toBe(lines.join(""));
			// The delete did remove the session and its artifacts.
			expect((await db.paths()).filter(stored => stored === file || stored.startsWith(artifacts))).toEqual([]);
		}, 120_000);

		it("keeps the image row, and the reference, of another session under a directory named the same but for letter case", async () => {
			// If this regresses, deleting a session with its artifacts drops the image references of a session whose
			// directory differs only in letter case, and deletes the image rows only that session names: resumed on
			// another machine, it shows its images as missing.
			await using db = await openLeaseDb("postgres", ndDatabaseUrl());
			// The tables whose `path` the delete compares, made by hand before the store starts, with the collation.
			for (const ddl of [
				`CREATE TABLE ${db.table} (path TEXT COLLATE ${ND_COLLATION} PRIMARY KEY, content TEXT NOT NULL, ` +
					"mtime_ms BIGINT NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, byte_len BIGINT)",
				`CREATE TABLE ${db.table}_parts (path TEXT COLLATE ${ND_COLLATION} NOT NULL, start_offset BIGINT NOT NULL, ` +
					"content TEXT NOT NULL, PRIMARY KEY (path, start_offset))",
				`CREATE TABLE ${db.table}_refs (path TEXT COLLATE ${ND_COLLATION} NOT NULL, sha256 TEXT NOT NULL, ` +
					"PRIMARY KEY (path, sha256))",
				`CREATE INDEX ${db.table}_rhash ON ${db.table}_refs (sha256)`,
			]) {
				await db.sql(ddl);
			}
			const root = path.join(db.dir.path(), "sessions", "-project-");
			const file = path.join(root, "a.jsonl");
			const artifacts = `${path.join(root, "a")}/`;
			const neighbour = path.join(root, "A", "Other.jsonl");
			const store = await db.open({ claims: false });
			const image = Buffer.alloc(4096, 5);
			const hash = new Bun.SHA256().update(image).digest("hex");
			store.blobTier.store(hash, image, "image/png");
			await store.drain();
			await store.writeText(file, transcript(ID, "parent"));
			await store.writeText(`${artifacts}Task.jsonl`, transcript(ID, "child"));
			await store.writeText(neighbour, transcript(ID, `blob:sha256:${hash}`));
			await store.drain();

			await store.deleteSessionWithArtifacts(file);
			await store.drain();

			expect(await db.paths()).toEqual([neighbour]);
			expect(await db.sql(`SELECT path, sha256 FROM ${db.table}_refs`)).toEqual([{ path: neighbour, sha256: hash }]);
			expect(await db.sql(`SELECT sha256 FROM ${db.table}_blobs`)).toEqual([{ sha256: hash }]);
		}, 120_000);
	},
);
