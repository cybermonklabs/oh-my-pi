import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	openSessionSqlClient,
	probeStorageSessionLeases,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { expectNoSpelling } from "../helpers/connection-redaction";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb } from "../helpers/sql-lease-fixture";

afterEach(() => vi.restoreAllMocks());

/** Fail the actual database statement, not a fabricated driver error. */
async function refuse(
	db: LeaseDb,
	event: "INSERT" | "UPDATE" | "DELETE",
	message: string,
): Promise<() => Promise<void>> {
	const name = `${db.table}_refuse`;
	const literal = `'${message.replaceAll("'", "''")}'`;
	if (db.adapter === "postgres") {
		await db.sql(
			`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`,
		);
		await db.sql(
			`CREATE TRIGGER ${name} BEFORE ${event} ON ${db.leaseTable} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
		);
		return async () => {
			await db.sql(`DROP FUNCTION ${name}() CASCADE`);
		};
	}
	await db.sql(
		db.adapter === "sqlite"
			? `CREATE TRIGGER ${name} BEFORE ${event} ON ${db.leaseTable} BEGIN SELECT RAISE(ABORT, ${literal}); END`
			: `CREATE TRIGGER ${name} BEFORE ${event} ON ${db.leaseTable} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}`,
	);
	return async () => {
		await db.sql(`DROP TRIGGER ${name}`);
	};
}

/** A row whose freshness expression fails with text quoting the connection string. */
async function failProbe(db: LeaseDb, message: string): Promise<() => Promise<void>> {
	const real = `${db.table}_leases_real`;
	const fail = `${db.table}_fail`;
	const literal = `'${message.replaceAll("'", "''")}'`;
	await db.sql(`ALTER TABLE ${db.leaseTable} RENAME TO ${real}`);
	if (db.adapter === "sqlite") {
		const named = `"${message.replaceAll('"', '""')}"`;
		await db.sql(`CREATE VIEW ${db.leaseTable} AS SELECT * FROM ${named}`);
	} else {
		await db.sql(
			db.adapter === "postgres"
				? `CREATE FUNCTION ${fail}(v timestamptz) RETURNS timestamptz LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`
				: `CREATE FUNCTION ${fail}(v DATETIME(6)) RETURNS DATETIME(6) DETERMINISTIC BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}; RETURN v; END`,
		);
		await db.sql(
			`CREATE VIEW ${db.leaseTable} AS SELECT session_id, holder, host, pid, acquired_at, ${fail}(heartbeat_at) AS heartbeat_at FROM ${real}`,
		);
	}
	return async () => {
		await db.sql(`DROP VIEW ${db.leaseTable}`);
		if (db.adapter !== "sqlite")
			await db.sql(`DROP FUNCTION ${fail}${db.adapter === "postgres" ? "(timestamptz)" : ""}`);
		await db.sql(`ALTER TABLE ${real} RENAME TO ${db.leaseTable}`);
	};
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`${adapter} lease diagnostics`, () => {
		it("redacts claim, heartbeat, release and both lease-consumer probe warnings before quoting", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const password = 'p"w!';
			const dsn = `postgres://app:${encodeURIComponent(password)}@db.example/sessions`;
			const dsnFile = db.dir.join("redaction.dsn");
			await Bun.write(dsnFile, dsn);
			const secret = await openSessionSqlClient({
				settings: Settings.isolated(),
				env: { OMP_SESSION_SQL_DSN_FILE: dsnFile },
			});
			const message = `connect to ${dsn} with ${password}`;
			const warnings: unknown[][] = [];
			let expected: { text: string; resolve: () => void } | undefined;
			vi.spyOn(logger, "warn").mockImplementation((...args) => {
				warnings.push(args);
				if (expected && String(args[0]).includes(expected.text)) expected.resolve();
			});
			const nextWarning = (text: string): Promise<void> => {
				const ready = Promise.withResolvers<void>();
				expected = { text, resolve: () => ready.resolve() };
				return ready.promise;
			};
			const id = "01a19f00-0000-7000-8000-000000000077";
			const file = path.join(db.root, "-p-", `x_${id}.jsonl`);
			try {
				const claimant = await db.open({ redact: secret.redact, leaseHeartbeatMs: 3_600_000 });
				const allowClaim = await refuse(db, "INSERT", message);
				try {
					const warned = nextWarning("could not claim");
					const release = claimant.claimSession(id, file);
					await warned;
					const error = await claimant.writeText(file, "refused").catch((error: unknown) => error);
					expect(Bun.inspect(error)).toContain("connect to <redacted>");
					expectNoSpelling("claim error", Bun.inspect(error), password);
					release();
					await claimant.drain().catch(() => undefined);
				} finally {
					await allowClaim();
				}

				// A real heartbeat timer drives a real database statement; await its warning,
				// rather than guessing a wall-clock delay or faking driver scheduling.
				const owner = await db.open({ redact: secret.redact, leaseHeartbeatMs: 20 });
				const release = owner.claimSession(id, file);
				await owner.writeText(file, "held");
				const allowHeartbeat = await refuse(db, "UPDATE", message);
				try {
					await nextWarning("heartbeat failed");
				} finally {
					await allowHeartbeat();
				}
				const allowRelease = await refuse(db, "DELETE", message);
				try {
					const warned = nextWarning("could not release");
					release();
					await owner.drain();
					await warned;
				} finally {
					await allowRelease();
				}

				const prober = await db.open({ redact: secret.redact });
				const restore = await failProbe(db, message);
				try {
					for (const feature of ["omp session lease", "RPC get_session_lease"]) {
						expect(await probeStorageSessionLeases(prober, [id], feature)).toEqual({ held: [], unknown: [id] });
					}
				} finally {
					await restore();
				}
				const text = JSON.stringify(warnings);
				for (const operation of ["could not claim", "heartbeat failed", "could not release", "could not read"]) {
					const calls = warnings.filter(args => String(args[0]).includes(operation));
					expect(calls.length).toBeGreaterThan(0);
					expect(JSON.stringify(calls)).toContain("connect to <redacted>");
				}
				expect(text).not.toContain(dsn);
				expectNoSpelling("lease warnings", text, password);
			} finally {
				await secret.client.end();
			}
		});
	});
}
