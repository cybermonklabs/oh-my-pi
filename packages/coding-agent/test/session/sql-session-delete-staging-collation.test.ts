/**
 * A session delete removes every staging part under the session's artifacts
 * directory whatever collation the `path` column compares with. Here the
 * PostgreSQL database's default collation is ICU's Thai one, which ignores
 * punctuation at its first level, so the paths under `<stem>/` do not all sort
 * below `<stem>0`. The case makes its own database on the server that
 * `OMP_TEST_SQL_POSTGRES_URL` names, and drops it after; it is skipped when
 * that login may not create a database or the server has no Thai ICU
 * collation.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type LeaseDb, openLeaseDb, transcript, until } from "./sql-session-lease-fixture";

const SERVER_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
const ID = "01a1f000-0000-7000-8000-0000000000e2";
/** Timings under which no heartbeat runs during a case; the test ages the lease itself. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };
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
