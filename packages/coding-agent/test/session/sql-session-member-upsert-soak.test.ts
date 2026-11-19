/**
 * A deadlock soak of the member's session writes alone, outside the default
 * suite: no blob table, only `SqlSessionStorage`'s session API. It runs only
 * when `OMP_TEST_SQL_SOAK_MS` is set, for that many milliseconds on each row
 * backend whose URL is set. `OMP_TEST_SQL_SOAK_WORKERS` workers (8 by
 * default), each a store of its own that claims nothing, run random appends,
 * full writes, deletes, replacing renames, deletes of session rows straight
 * in the table, and two session rows deleted and created again at once with
 * a rename from the lower to the higher in flight. Each worker writes three
 * paths of its own in the one shared session table, so the workers meet in
 * that table's gaps. Run it with the store's `WRITE_ATTEMPTS` at 1, so the
 * deadlock retry hides none, and read the server's own deadlock reports
 * (`innodb_print_all_deadlocks`) beside it. It counts each operation's runs,
 * those that failed with a deadlock, and the others' errors by kind.
 */
import { describe, expect, it } from "bun:test";
import type { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { openLeaseDb, ROW_LEASE_BACKENDS, transcript } from "./sql-session-lease-fixture";

const SOAK_MS = Number(process.env.OMP_TEST_SQL_SOAK_MS ?? 0);
const WORKERS = Number(process.env.OMP_TEST_SQL_SOAK_WORKERS ?? 8);
const ID = "01a1f500-0000-7000-8000-000000000003";

function isDeadlock(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /deadlock/i.test(message) || /40P01/.test(message);
}

/** An error's kind, for the summary: its code (or name), and its message without paths. */
function errorKind(error: unknown): string {
	const code = !(error instanceof Error) ? "thrown" : "code" in error ? error.code : error.name;
	const message = (error instanceof Error ? error.message : String(error)).replace(/\S*\/\S+/g, "<path>");
	return `${String(code)}: ${message.slice(0, 60)}`;
}

describe.skipIf(!(SOAK_MS > 0))("SqlSessionStorage session-only deadlock soak", () => {
	for (const { adapter, url } of ROW_LEASE_BACKENDS) {
		it.skipIf(!url)(
			`runs ${WORKERS} workers for ${SOAK_MS} ms on ${adapter}`,
			async () => {
				const originalAgentDir = getAgentDir();
				const agentDir = TempDir.createSync("@omp-sql-member-soak-");
				setAgentDir(agentDir.path());
				try {
					await using db = await openLeaseDb(adapter, url ?? "");
					const stores: SqlSessionStorage[] = [];
					for (let index = 0; index < WORKERS; index++) stores.push(await db.open({ claims: false }));
					const dir = db.dir.join("sessions");
					const pathsOf = (worker: number) =>
						["a", "b", "c"].map(name => `${dir}/2026-11-19T00-00-00-000Z_w${worker}${name}.jsonl`);
					const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;
					const line = () => transcript(ID, `entry ${Math.random().toString(36).slice(2)}`);
					const dropRows = async (paths: readonly string[]) => {
						for (const path of paths) {
							await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [path]);
							await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [path]);
						}
					};
					const ops: Array<[string, (store: SqlSessionStorage, paths: string[]) => Promise<unknown>]> = [
						[
							"append",
							async (store, paths) => {
								const writer = store.openWriter(pick(paths));
								try {
									await writer.append(line());
								} finally {
									await writer.close();
								}
							},
						],
						["full write", (store, paths) => store.writeText(pick(paths), line()).then(() => store.drain())],
						["delete", (store, paths) => store.refresh().then(() => store.unlink(pick(paths)))],
						[
							"replacing rename",
							(store, paths) => {
								const src = pick(paths);
								const dst = pick(paths.filter(path => path !== src));
								return store.refresh().then(() => store.rename(src, dst));
							},
						],
						["row delete", (_store, paths) => dropRows([pick(paths)])],
						[
							"two rows deleted and created again",
							async (store, paths) => {
								const [low, high] = [...paths].sort() as [string, string];
								await store.writeText(low, line());
								await store.writeText(high, line());
								await store.drain();
								await dropRows([low, high]);
								await store.refresh();
								const settled = await Promise.allSettled([
									store.writeText(low, line()),
									store.writeText(high, line()),
									store.rename(low, high),
								]);
								await store.drain();
								const reasons = settled.flatMap(result =>
									result.status === "rejected" ? [result.reason] : [],
								);
								const reason = reasons.find(isDeadlock) ?? reasons[0];
								if (reason !== undefined) throw reason;
							},
						],
					];
					const counts = new Map<
						string,
						{ ops: number; deadlocks: number; other: number; kinds: Map<string, number> }
					>();
					const deadline = performance.now() + SOAK_MS;
					await Promise.all(
						stores.map(async (store, worker) => {
							const paths = pathsOf(worker);
							while (performance.now() < deadline) {
								const [kind, op] = pick(ops);
								const count = counts.get(kind) ?? { ops: 0, deadlocks: 0, other: 0, kinds: new Map() };
								counts.set(kind, count);
								count.ops++;
								try {
									await op(store, paths);
								} catch (error) {
									if (isDeadlock(error)) {
										count.deadlocks++;
									} else {
										count.other++;
										const key = errorKind(error);
										count.kinds.set(key, (count.kinds.get(key) ?? 0) + 1);
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
						for (const [key, times] of [...count.kinds].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
							console.log(`SOAK ${adapter} other error: ${kind}: ${times} × ${key}`);
						}
					}
					expect([...counts.values()].reduce((sum, count) => sum + count.ops, 0)).toBeGreaterThan(0);
				} finally {
					setAgentDir(originalAgentDir);
					agentDir.removeSync();
				}
			},
			SOAK_MS + 120_000,
		);
	}
});
