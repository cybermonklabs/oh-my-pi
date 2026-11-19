/**
 * A deadlock soak for the blob and reference tables, outside the default
 * suite: it runs only when `OMP_TEST_SQL_SOAK_MS` is set, for that many
 * milliseconds on SQLite and on each row backend whose URL is set
 * (PostgreSQL, MySQL or MariaDB). `OMP_TEST_SQL_SOAK_WORKERS` workers (8 by default), each a store
 * of its own, run random appends, full writes, deletes, replacing renames,
 * sweeps, deletes of session rows that leave references dangling (as a build
 * that keeps no references does), and B5's setup (two dangling paths of one
 * blob in one sweep batch, both created again, with a rename from the lower
 * to the higher in flight while the sweep runs, on a blob of the worker's
 * own), and the first worker also inserts parted blobs that share parts,
 * over seven shared images. Each worker writes
 * three session paths of its own, as a session's lease gives one process its
 * writes, so what the workers meet is the shared blob and reference tables,
 * the sweep, and the session table's gaps. One worker inserts blobs: two
 * inserts of one blob row at once, just after a delete marked it, both take
 * InnoDB's shared lock for the duplicate check and then wait for the
 * exclusive one, a race on the row itself that no lock order changes and the
 * blob tier's tries absorb. Every store claims nothing, so no lease row takes
 * part. It counts each operation's runs, those that failed with a deadlock,
 * and the others' errors by kind; at the end it checks that every reference
 * names a blob row and every parted blob row has its parts' references. It
 * passes only with no deadlock and nothing broken; run it with the store's
 * `WRITE_ATTEMPTS` at 1 so the deadlock retry hides none, and read the
 * server's own deadlock reports (`innodb_print_all_deadlocks`) beside it:
 *
 *   OMP_TEST_SQL_SOAK_MS=180000 OMP_TEST_SQL_MYSQL_URL=… bun test test/session/sql-session-storage-deadlock-soak.test.ts
 */
import { describe, expect, it } from "bun:test";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { LEASE_BACKENDS, openLeaseDb, transcript } from "./sql-session-lease-fixture";

const SOAK_MS = Number(process.env.OMP_TEST_SQL_SOAK_MS ?? 0);
const WORKERS = Number(process.env.OMP_TEST_SQL_SOAK_WORKERS ?? 8);
const ID = "01a1f500-0000-7000-8000-000000000002";

function bytes(seed: number, size: number): Buffer {
	const data = Buffer.alloc(size);
	for (let index = 0; index < size; index++) data[index] = (index * 7 + seed * 31) % 251;
	return data;
}

function sha256(data: Uint8Array): string {
	return new Bun.SHA256().update(data).digest("hex");
}

/** An error's kind, for the summary: its code (or name), and its message without paths or hashes. */
function errorKind(error: unknown): string {
	const code = error instanceof Error ? ((error as { code?: unknown }).code ?? error.name) : "thrown";
	const message = (error instanceof Error ? error.message : String(error))
		.replace(/\S*\/\S+/g, "<path>")
		.replace(/[0-9a-f]{64}/g, "<hash>");
	return `${String(code)}: ${message.slice(0, 60)}`;
}

function isDeadlock(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /deadlock/i.test(message) || /40P01/.test(message);
}

/** The blob tier's queue, past its interface: forget a landed blob so the next store of it inserts again. */
interface TierInternals {
	store(hash: string, data: Buffer, mimeType: string | undefined): void;
	forget(hashes: Iterable<string>): void;
	land(hashes?: Iterable<string>): Promise<void>;
}

describe.skipIf(!(SOAK_MS > 0))("SqlSessionStorage deadlock soak", () => {
	for (const { adapter, url } of LEASE_BACKENDS) {
		it.skipIf(!url)(
			`runs ${WORKERS} workers for ${SOAK_MS} ms on ${adapter} with no deadlock`,
			async () => {
				const originalAgentDir = getAgentDir();
				const agentDir = TempDir.createSync("@omp-sql-soak-");
				setAgentDir(agentDir.path());
				try {
					await using db = await openLeaseDb(adapter, url ?? "");
					const options = { claims: false, maxBlobBytes: 1024 } as const;
					const stores: SqlSessionStorage[] = [];
					for (let index = 0; index < WORKERS; index++) stores.push(await db.open(options));
					// Three whole images and four parted ones over three 1 KiB chunks, so parts are shared.
					const chunks = [1, 2, 3].map(seed => bytes(seed, 1024));
					const [c0, c1, c2] = chunks as [Buffer, Buffer, Buffer];
					const images = [
						...[4, 5, 6].map(seed => bytes(seed, 512)),
						Buffer.concat([c0, c1]),
						Buffer.concat([c0, c2]),
						Buffer.concat([c1, c2, c0]),
						Buffer.concat([c2, c0]),
					];
					const hashes = images.map(sha256);
					const dir = db.dir.join("sessions");
					const pathsOf = (worker: number) =>
						["a", "b", "c"].map(name => `${dir}/2026-11-19T00-00-00-000Z_w${worker}${name}.jsonl`);
					const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;
					const naming = () =>
						transcript(ID, [pick(hashes), pick(hashes)].map(hash => `blob:sha256:${hash}`).join(" "));
					// A blob of each worker's own, which only that worker inserts and names (B5's setup).
					const owned = stores.map((_store, worker) => bytes(100 + worker, 512));
					const counts = new Map<
						string,
						{ ops: number; deadlocks: number; other: number; kinds: Map<string, number> }
					>();
					const failures: string[] = [];
					const ops: Array<
						[string, (store: SqlSessionStorage, paths: string[], worker: number) => Promise<unknown>]
					> = [
						[
							"append",
							async (store, paths) => {
								const writer = store.openWriter(pick(paths));
								try {
									await writer.append(naming());
								} finally {
									await writer.close();
								}
							},
						],
						["full write", (store, paths) => store.writeText(pick(paths), naming()).then(() => store.drain())],
						["delete", (store, paths) => store.refresh().then(() => store.unlink(pick(paths)))],
						[
							"replacing rename",
							(store, paths) => {
								const src = pick(paths);
								const dst = pick(paths.filter(path => path !== src));
								return store.refresh().then(() => store.rename(src, dst));
							},
						],
						["sweep", store => store.blobTier.sweep(new Set(), Date.now() + 60_000, true)],
						[
							"dangling",
							async (_store, paths) => {
								const path = pick(paths);
								await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [path]);
								await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [path]);
							},
						],
						[
							"parted insert",
							async store => {
								const tier = store.blobTier as unknown as TierInternals;
								const index = 3 + Math.floor(Math.random() * 4);
								const hash = hashes[index] as string;
								tier.forget([hash]);
								tier.store(hash, images[index] as Buffer, "image/png");
								await tier.land([hash]);
							},
						],
						[
							"rename across a sweep",
							async (store, paths, worker) => {
								const own = owned[worker] as Buffer;
								const hash = sha256(own);
								const tier = store.blobTier as unknown as TierInternals;
								tier.forget([hash]);
								tier.store(hash, own, "image/png");
								await tier.land([hash]);
								const [low, high] = [...paths].sort() as [string, string];
								const content = transcript(ID, `blob:sha256:${hash}`);
								await store.writeText(low, content);
								await store.writeText(high, content);
								await store.drain();
								for (const path of [low, high]) {
									await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [path]);
									await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [path]);
								}
								await store.refresh();
								const settled = await Promise.allSettled([
									store.blobTier.sweep(new Set(), Date.now() + 60_000, true),
									(async () => {
										await store.writeText(low, content);
										await store.writeText(high, content);
										await store.rename(low, high);
										await store.drain();
									})(),
								]);
								const reasons = settled.flatMap(result =>
									result.status === "rejected" ? [result.reason] : [],
								);
								const reason = reasons.find(isDeadlock) ?? reasons[0];
								if (reason !== undefined) throw reason;
							},
						],
					];
					const deadline = performance.now() + SOAK_MS;
					await Promise.all(
						stores.map(async (store, worker) => {
							const paths = pathsOf(worker);
							const mine = worker === 0 ? ops : ops.filter(([kind]) => kind !== "parted insert");
							while (performance.now() < deadline) {
								const [kind, op] = pick(mine);
								const count = counts.get(kind) ?? { ops: 0, deadlocks: 0, other: 0, kinds: new Map() };
								counts.set(kind, count);
								count.ops++;
								try {
									await op(store, paths, worker);
								} catch (error) {
									if (isDeadlock(error)) {
										count.deadlocks++;
										const message = error instanceof Error ? error.message : String(error);
										if (failures.length < 5) failures.push(`${kind}: ${message.slice(0, 200)}`);
									} else {
										count.other++;
										const errorKey = errorKind(error);
										count.kinds.set(errorKey, (count.kinds.get(errorKey) ?? 0) + 1);
									}
								}
							}
						}),
					);
					const summary = [...counts].map(
						([kind, count]) =>
							`${kind} ${count.ops} ops, ${count.deadlocks} deadlocks, ${count.other} other errors`,
					);
					console.log(`SOAK ${adapter}: ${summary.join("; ")}`);
					for (const [kind, count] of counts) {
						for (const [errorKey, times] of [...count.kinds].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
							console.log(`SOAK ${adapter} other error: ${kind}: ${times} × ${errorKey}`);
						}
					}
					for (const failure of failures) console.log(`SOAK ${adapter} deadlock: ${failure}`);
					// The end state: every reference names a blob row (no delete took a blob a reference names), and every
					// parted blob row has its parts' references, each naming a row by the check before.
					const stored = adapter === "postgres" ? "octet_length(content)" : "length(content)";
					const blobRows = await db.sql(`SELECT sha256, byte_len, ${stored} AS stored FROM ${db.table}_blobs`);
					const there = new Set(blobRows.map(row => String(row.sha256)));
					const refs = await db.sql(`SELECT path, sha256 FROM ${db.table}_refs`);
					const broken: string[] = [];
					for (const ref of refs) {
						if (!there.has(String(ref.sha256))) broken.push(`${String(ref.path)} names a blob with no row`);
					}
					for (const row of blobRows) {
						if (Number(row.byte_len) === Number(row.stored)) continue;
						const partsPath = `blob:sha256:${String(row.sha256)}`;
						if (!refs.some(ref => String(ref.path) === partsPath)) broken.push(`${partsPath} has no parts`);
					}
					console.log(
						`SOAK ${adapter} end state: ${refs.length} references, ${there.size} blob rows, ${broken.length} broken`,
					);
					for (const line of broken.slice(0, 5)) console.log(`SOAK ${adapter} broken: ${line}`);
					expect({
						deadlocks: [...counts.values()].reduce((sum, count) => sum + count.deadlocks, 0),
						broken,
					}).toEqual({ deadlocks: 0, broken: [] });
				} finally {
					setAgentDir(originalAgentDir);
					agentDir.removeSync();
				}
			},
			SOAK_MS + 120_000,
		);
	}
});
