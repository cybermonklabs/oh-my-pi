/**
 * Scratch probe (not for the PR): the lock lists behind the upsert-against-upsert deadlock, on MySQL and MariaDB.
 * Prints `PROBE` lines: each transaction's locks on the probe's tables at each step, from
 * `SHOW ENGINE INNODB STATUS` with `innodb_status_output_locks` on (record lines: heap number, info bits, where 32 is
 * delete-marked, and the first field), and on MySQL from `performance_schema.data_locks`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { type GatedClient, gatedClient, LEASE_BACKENDS, type LeaseDb, openLeaseDb, transcript } from "./sql-session-lease-fixture";

const ID = "01a1f500-0000-7000-8000-0000000000aa";

function short(text: string): string {
	return text.replace(/\/[^ ']*\/sessions\//g, "").replace(/sl_\d+_[a-z0-9]+_\d+/g, "T");
}

async function dump(db: LeaseDb, label: string): Promise<void> {
	const [status] = await db.sql("SHOW ENGINE INNODB STATUS");
	const text = String(status?.Status ?? "");
	const section = text.slice(text.indexOf("\nTRANSACTIONS\n"), text.indexOf("\nFILE I/O\n") > 0 ? text.indexOf("\nFILE I/O\n") : undefined);
	const out: string[] = [];
	const history = /History list length (\d+)/.exec(text)?.[1];
	out.push(`history ${history}`);
	let keep = false;
	for (const line of section.split("\n")) {
		if (/^---TRANSACTION/.test(line)) {
			keep = !/not started/.test(line);
			if (keep) out.push(line.trim());
			continue;
		}
		if (!keep) continue;
		if (/^(LOCK WAIT|RECORD LOCKS|TABLE LOCK|------- TRX HAS BEEN WAITING|mysql tables in use|\d+ lock struct)/.test(line)) out.push(`  ${line.trim()}`);
		else if (/^(INSERT|SELECT|UPDATE|DELETE)/.test(line)) out.push(`  q: ${line.slice(0, 160)}`);
		else if (/^Record lock, heap no/.test(line)) out.push(`    ${line.replace(/PHYSICAL RECORD: /, "").trim()}`);
		else if (/^ 0: len/.test(line)) out.push(`      ${line.replace(/hex [0-9a-f]+; /, "").trim()}`);
	}
	for (const line of out) console.log(`PROBE ${db.server} ${label}: ${short(line)}`);
	if (db.server !== "mysql") return;
	const rows = await db.sql(
		"SELECT l.ENGINE_TRANSACTION_ID AS trx, l.OBJECT_NAME AS tbl, l.INDEX_NAME AS idx, l.LOCK_TYPE AS type, " +
			"l.LOCK_MODE AS mode, l.LOCK_STATUS AS status, l.LOCK_DATA AS data, x.trx_query AS query " +
			"FROM performance_schema.data_locks l LEFT JOIN information_schema.INNODB_TRX x ON x.trx_id = l.ENGINE_TRANSACTION_ID " +
			"WHERE l.OBJECT_SCHEMA = DATABASE() ORDER BY l.ENGINE_TRANSACTION_ID, l.OBJECT_NAME",
	);
	for (const row of rows) {
		console.log(
			`PROBE ${db.server} ${label} data_locks: trx ${row.trx} ${short(String(row.tbl))}.${row.idx ?? "-"} ${row.type} ${row.mode} ${row.status} ${short(String(row.data ?? "-"))} | ${short(String(row.query ?? "(between statements)").slice(0, 100))}`,
		);
	}
}

async function holdPurge(db: LeaseDb, table = db.table): Promise<() => Promise<void>> {
	const holder = new SQL(db.dsn);
	const opened = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const held = holder.transaction(async transaction => {
		await transaction.unsafe(`SELECT COUNT(*) AS n FROM ${table}`);
		opened.resolve();
		await release.promise;
	});
	held.catch((err: unknown) => opened.reject(err));
	await opened.promise;
	let ended: Promise<void> | undefined;
	return () => {
		release.resolve();
		ended ??= held.then(
			() => holder.end(),
			() => holder.end(),
		);
		return ended;
	};
}

async function waitPurge(db: LeaseDb): Promise<string> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const [status] = await db.sql("SHOW ENGINE INNODB STATUS");
		const length = /History list length (\d+)/.exec(String(status?.Status ?? ""))?.[1] ?? "?";
		if (length === "0" || Date.now() > deadline) return length;
		await Bun.sleep(25);
	}
}

function counting(client: SqlSessionStorageClient, log: string[]): SqlSessionStorageClient {
	return {
		options: client.options,
		unsafe: (query, values) => client.unsafe(query, values),
		transaction: callback =>
			client.transaction(transaction =>
				callback({
					async unsafe(query, values) {
						log.push(query);
						try {
							return await transaction.unsafe(query, values);
						} catch (err) {
							log.push(`ERROR ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
							throw err;
						}
					},
				}),
			),
		end: () => client.end?.() ?? Promise.resolve(),
	};
}

describe("purge probe", () => {
	afterAll(async () => {
		const url = process.env.OMP_TEST_SQL_MYSQL_URL;
		if (!url) return;
		const admin = new SQL(url);
		await admin.unsafe("SET GLOBAL innodb_status_output_locks = OFF");
		await admin.end();
	});
	for (const { adapter, url } of LEASE_BACKENDS) {
		if (adapter !== "mysql") continue;
		it.skipIf(!url)("raw SQL: two upserts of delete-marked rows behind a share lock, then purge", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			await db.sql("SET GLOBAL innodb_status_output_locks = ON");
			const t = `${db.table}_probe`;
			await db.sql(`CREATE TABLE ${t} (path VARCHAR(64) NOT NULL PRIMARY KEY, v INT) ENGINE=InnoDB`);
			for (const key of ["a", "k1", "k2", "z"]) await db.sql(`INSERT INTO ${t} VALUES (@1, 0)`, [key]);
			const release = await holdPurge(db, t);
			await db.sql(`DELETE FROM ${t} WHERE path IN ('k1', 'k2')`);
			const sweeper = new SQL(db.dsn);
			const a = new SQL(db.dsn);
			const b = new SQL(db.dsn);
			const go = Promise.withResolvers<void>();
			const locked = Promise.withResolvers<void>();
			const sweeping = sweeper.transaction(async tx => {
				await tx.unsafe(`SELECT path FROM ${t} WHERE path IN ('k1') LOCK IN SHARE MODE`);
				await tx.unsafe(`SELECT path FROM ${t} WHERE path IN ('k2') LOCK IN SHARE MODE`);
				locked.resolve();
				await go.promise;
			});
			await locked.promise;
			const results: string[] = [];
			const upsert = (client: SQL, key: string) =>
				client
					.transaction(tx => tx.unsafe(`INSERT INTO ${t} VALUES (@1, 1) ON DUPLICATE KEY UPDATE v = 1`.replace("@1", `'${key}'`)))
					.then(
						() => results.push(`${key} ok`),
						(err: unknown) => results.push(`${key} ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`),
					);
			const writes = [upsert(a, "k1"), upsert(b, "k2")];
			await Bun.sleep(500);
			await dump(db, "raw 1 waiting, purge held");
			await release();
			console.log(`PROBE ${db.server} raw purge: history ${await waitPurge(db)}`);
			await Bun.sleep(300);
			await dump(db, "raw 2 after purge");
			go.resolve();
			await sweeping;
			await Promise.all(writes);
			console.log(`PROBE ${db.server} raw results: ${results.join("; ")}`);
			await dump(db, "raw 3 end");
			for (const client of [sweeper, a, b]) await client.end();
			await db.sql(`DROP TABLE ${t}`);
			expect(results.length).toBe(2);
		}, 60_000);

		for (const tier of ["on", "off"] as const) {
			it.skipIf(!url)(`store: two writes create again two dangling paths of one gap during the sweep, blob tier ${tier}`, async () => {
				const originalAgentDir = getAgentDir();
				const agentDir = TempDir.createSync("@omp-sql-purge-probe-");
				setAgentDir(agentDir.path());
				try {
					await using db = await openLeaseDb(adapter, url ?? "");
					await db.sql("SET GLOBAL innodb_status_output_locks = ON");
					const storage = await db.open({ claims: false });
					let gate: GatedClient | undefined;
					const sweeperLog: string[] = [];
					const sweeper = await db.open({
						claims: false,
						wrap: client => {
							gate = gatedClient(counting(client, sweeperLog), /^SELECT .* FROM \S*_blobs\b/, "before");
							return gate.client;
						},
					});
					const logs: string[][] = [[], []];
					const writers = [
						await db.open({ claims: false, wrap: client => counting(client, logs[0] as string[]) }),
						await db.open({ claims: false, wrap: client => counting(client, logs[1] as string[]) }),
					];
					const data = Buffer.alloc(600, 9);
					const hash = new Bun.SHA256().update(data).digest("hex");
					if (tier === "on") {
						storage.blobTier.store(hash, data, "image/png");
						await storage.drain();
					}
					const content = transcript(ID, tier === "on" ? `blob:sha256:${hash}` : "no blob");
					const dir = db.dir.join("sessions");
					const [a, k1, k2, z] = ["a", "k1", "k2", "z"].map(name => `${dir}/${name}.jsonl`) as [string, string, string, string];
					for (const path of [a, k1, k2, z]) await storage.writeText(path, content);
					await storage.drain();
					const release = await holdPurge(db);
					for (const path of [k1, k2]) {
						await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [path]);
						await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [path]);
					}
					gate?.close();
					const sweeping = sweeper.blobTier.sweep(new Set(), 0, true);
					const paused = await Promise.race([gate?.paused().then(() => "paused"), sweeping.then(() => "swept")]);
					console.log(`PROBE ${db.server} tier ${tier}: sweep ${paused}`);
					await dump(db, `tier ${tier} 1 sweep at its blob statement`);
					const writing = Promise.allSettled(writers.map((writer, index) => writer.writeText(index === 0 ? k1 : k2, content).then(() => writer.drain())));
					const early = await Promise.race([writing.then(() => "written"), Bun.sleep(800).then(() => "waiting")]);
					console.log(`PROBE ${db.server} tier ${tier}: writes ${early}`);
					await dump(db, `tier ${tier} 2 writes started, purge held`);
					await release();
					console.log(`PROBE ${db.server} tier ${tier} purge: history ${await waitPurge(db)}`);
					await Bun.sleep(300);
					await dump(db, `tier ${tier} 3 after purge`);
					gate?.open();
					const settled = await writing;
					await sweeping;
					for (const [index, log] of logs.entries()) {
						console.log(`PROBE ${db.server} tier ${tier} writer ${index}: ${log.map(q => short(q).slice(0, 70)).join(" ; ")}`);
					}
					console.log(`PROBE ${db.server} tier ${tier} sweeper: ${sweeperLog.map(q => short(q).slice(0, 70)).join(" ; ")}`);
					console.log(`PROBE ${db.server} tier ${tier} results: ${settled.map(r => r.status).join(", ")}`);
					expect(settled.every(r => r.status === "fulfilled")).toBe(true);
				} finally {
					setAgentDir(originalAgentDir);
					agentDir.removeSync();
				}
			}, 120_000);
		}
	}
});
