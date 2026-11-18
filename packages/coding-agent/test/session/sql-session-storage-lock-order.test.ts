/**
 * The store's lock order (see `#lockBlobRows` in `sql-session-storage.ts` and
 * docs/session.md, "Races"), checked from the statements each kind of
 * transaction sends, on every engine: (1) lease rows, (2) session rows and
 * their parts in path order, (3) blob rows in `sha256` order, parents and
 * parts in one pass, (4) reference rows. A statement that takes a lock is a
 * write (`INSERT`, `UPDATE`, `DELETE`) or a locking read (`FOR UPDATE`,
 * `FOR SHARE`, `LOCK IN SHARE MODE`). Within a transaction, a statement may
 * not lock a key of an earlier step, or a key that sorts before one its step
 * already locked, unless the transaction holds it already. A new path that
 * breaks the order fails here. Each kind's sequence is printed (`LOCK ORDER`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	SqlSessionStorageClient,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { LEASE_BACKENDS, openLeaseDb, reserveWrapped, transcript } from "./sql-session-lease-fixture";

const ID = "01a1f500-0000-7000-8000-000000000001";

interface Recorded {
	tx: number;
	sql: string;
	values: unknown[];
}

/**
 * `client`, recording each statement a transaction sends, with the transaction's number; on PostgreSQL each
 * connection the store reserves is one transaction.
 */
function recorder(client: SqlSessionStorageClient, into: Recorded[]): SqlSessionStorageClient {
	let next = 0;
	const numbered = (transaction: SqlSessionStorageTransaction): SqlSessionStorageTransaction => {
		const tx = ++next;
		return {
			unsafe(query, values) {
				into.push({ tx, sql: query, values: [...(values ?? [])] });
				return transaction.unsafe(query, values);
			},
		};
	};
	return {
		options: client.options,
		unsafe: (query, values) => client.unsafe(query, values),
		transaction: callback => client.transaction(transaction => callback(numbered(transaction))),
		end: () => client.end?.() ?? Promise.resolve(),
		...reserveWrapped(client, numbered),
	};
}

function bytes(seed: number, size: number): Buffer {
	const data = Buffer.alloc(size);
	for (let index = 0; index < size; index++) data[index] = (index * 13 + seed * 29) % 251;
	return data;
}

function sha256(data: Uint8Array): string {
	return new Bun.SHA256().update(data).digest("hex");
}

interface Lock {
	step: 1 | 2 | 3 | 4;
	table: string;
	keys: string[];
	sql: string;
}

/** The lock a statement takes, if any: its step, and the keys it orders by (paths for step 2, hashes for step 3). */
function lockOf(sql: string, values: unknown[], table: string, leaseTable: string): Lock | undefined {
	const text = sql.replace(/"public"\./g, "").replace(/[`"]/g, "");
	const writes = /^\s*(INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(text);
	const locks = /\b(FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE)\b/i.test(text);
	if (!writes && !locks) return undefined;
	const found = new RegExp(`\\b(${leaseTable}|${table}(?:_parts|_blobs|_refs)?)\\b`).exec(text)?.[1];
	if (!found) return undefined;
	const strings = values.filter((value): value is string => typeof value === "string");
	if (found === leaseTable) return { step: 1, table: found, keys: [], sql: text };
	if (found === table || found === `${table}_parts`) {
		return { step: 2, table: found, keys: strings.filter(value => value.startsWith("/")), sql: text };
	}
	if (found === `${table}_blobs`) {
		return { step: 3, table: found, keys: strings.filter(value => /^[0-9a-f]{64}$/.test(value)), sql: text };
	}
	return { step: 4, table: found, keys: [], sql: text };
}

/** Each statement of `locks` (one transaction's, in order) that breaks the order. */
function violations(locks: readonly Lock[]): string[] {
	const held = new Map<number, Set<string>>([
		[2, new Set()],
		[3, new Set()],
	]);
	const found: string[] = [];
	let reached = 0;
	for (const lock of locks) {
		const mine = held.get(lock.step);
		const fresh = mine ? lock.keys.filter(key => !mine.has(key)) : [];
		if (lock.step < reached && (lock.step === 1 || fresh.length > 0)) {
			found.push(`step ${lock.step} after step ${reached}: ${lock.sql.slice(0, 90)}`);
		}
		if (mine && mine.size > 0 && fresh.length > 0) {
			const highest = [...mine].sort().at(-1) ?? "";
			const lowest = [...fresh].sort()[0] ?? "";
			if (lowest < highest)
				found.push(`step ${lock.step} key ${short(lowest)} after ${short(highest)}: ${lock.sql.slice(0, 90)}`);
		}
		for (const key of lock.keys) mine?.add(key);
		reached = Math.max(reached, lock.step);
	}
	return found;
}

function short(key: string): string {
	return key.startsWith("/") ? (key.split("/").filter(Boolean).at(-1) ?? key) : key.slice(0, 6);
}

/** One transaction's locks as a line: `session[a,b] → blobs[1a2b3c,…] → refs`. */
function describeLocks(locks: readonly Lock[]): string {
	const runs: string[] = [];
	for (const lock of locks) {
		const name = { 1: "leases", 2: "session", 3: "blobs", 4: "refs" }[lock.step];
		const keys = lock.keys.map(short).join(",");
		const item = keys ? `${name}[${keys}]` : name;
		if (runs.at(-1) !== item) runs.push(item);
	}
	return runs.join(" → ") || "(no lock)";
}

describe("SqlSessionStorage lock order", () => {
	const originalAgentDir = getAgentDir();
	let agentDir: TempDir | undefined;
	beforeEach(() => {
		agentDir = TempDir.createSync("@omp-sql-lock-order-");
		setAgentDir(agentDir.path());
	});
	afterEach(() => {
		setAgentDir(originalAgentDir);
		agentDir?.removeSync();
	});

	for (const { adapter, url } of LEASE_BACKENDS) {
		it.skipIf(!url)(
			`takes every transaction's locks in the store's order on ${adapter}`,
			async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const recorded: Recorded[] = [];
				const storage = await db.open({ wrap: client => recorder(client, recorded), maxBlobBytes: 1024 });
				// Six whole images and two parted ones that share their first part; paths whose order differs from
				// the order the operations name them in.
				const images = [1, 2, 3, 4, 5, 6].map(seed => bytes(seed, 512));
				const shared = bytes(7, 1024);
				// The second parted image has a part that sorts before its own hash, so a parent-first insert breaks the order.
				let seed = 9;
				const partedWith = (tail: number) => Buffer.concat([shared, bytes(tail, 1024)]);
				while (sha256(shared) > sha256(partedWith(seed)) && sha256(bytes(seed, 1024)) > sha256(partedWith(seed)))
					seed++;
				const parted = [partedWith(8), partedWith(seed)];
				for (const data of [...images, parted[0] as Buffer])
					storage.blobTier.store(sha256(data), data, "image/png");
				await storage.drain();
				const hashes = images.map(sha256);
				const naming = (...indices: number[]) =>
					transcript(ID, indices.map(index => `blob:sha256:${hashes[index]}`).join(" "));
				const dir = db.dir.join("sessions");
				const [a, b, c, d] = ["a", "b", "c", "d"].map(name => `${dir}/2026-11-19T00-00-00-000Z_${name}.jsonl`) as [
					string,
					string,
					string,
					string,
				];
				const sub = `${d.slice(0, -6)}/Worker.jsonl`;
				for (const [path, content] of [
					[a, naming(5, 0)],
					[b, naming(4, 1)],
					[c, naming(3, 2)],
					[d, `${naming(2, 5)}${transcript(ID, `blob:sha256:${sha256(parted[0] as Buffer)}`)}`],
					[sub, naming(1)],
				] as const) {
					await storage.writeText(path, content);
				}
				await storage.drain();
				// Two dangling references (their sessions' rows deleted by a build that keeps none) and an orphan.
				for (const path of [`${dir}/gone-z.jsonl`, `${dir}/gone-y.jsonl`]) {
					await db.sql(`INSERT INTO ${db.table}_refs (path, sha256) VALUES (@1, @2)`, [path, hashes[3]]);
				}

				const kinds: Array<[string, () => Promise<unknown>]> = [
					[
						"append",
						async () => {
							const writer = storage.openWriter(a);
							await writer.append(`${naming(4, 1)}`);
							await writer.close();
						},
					],
					[
						"full write, replacing references",
						() => storage.writeText(b, naming(5, 0)).then(() => storage.drain()),
					],
					[
						"open-time write-back",
						() => storage.blobTier.reference(c, [hashes[5] as string, hashes[0] as string]),
					],
					["replacing rename, source before destination", () => storage.rename(a, c)],
					["delete with artifacts", () => storage.deleteSessionWithArtifacts(d)],
					[
						"parted blob insert, part shared",
						async () => {
							storage.blobTier.store(sha256(parted[1] as Buffer), parted[1] as Buffer, "image/png");
							await storage.drain();
						},
					],
					["sweep", () => storage.blobTier.sweep(new Set(), Date.now() + 60_000, true)],
				];
				const table: string[] = [];
				const broken: string[] = [];
				for (const [kind, run] of kinds) {
					const start = recorded.length;
					await run();
					const byTx = new Map<number, Lock[]>();
					for (const statement of recorded.slice(start)) {
						const lock = lockOf(statement.sql, statement.values, db.table, db.leaseTable);
						if (!lock) continue;
						byTx.set(statement.tx, [...(byTx.get(statement.tx) ?? []), lock]);
					}
					for (const locks of byTx.values()) {
						table.push(`| ${kind} | ${describeLocks(locks)} |`);
						for (const found of violations(locks)) broken.push(`${kind}: ${found}`);
					}
				}
				console.log(`LOCK ORDER ${adapter}\n| Transaction | Locks, in order |\n|---|---|\n${table.join("\n")}`);
				expect(broken).toEqual([]);
			},
			60_000,
		);
	}
});
