import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { LEASE_BACKENDS, openLeaseDb } from "../helpers/sql-lease-fixture";

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`${adapter} subagent parent continuation deadline`, () => {
		it("reports persistence failure at the configured expiry when a cross-process parent has no continuation", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const owner = await db.open();
			const parentId = "01a19f00-0000-7000-8000-000000000099";
			const parent = path.join(db.root, "-project-", `x_${parentId}.jsonl`);
			const child = path.join(parent.slice(0, -6), "Worker.jsonl");
			const header = (id: string) =>
				`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: db.dir.path() })}\n`;
			const release = owner.claimSession(parentId, parent);
			await owner.writeText(parent, header(parentId));
			await owner.writeText(child, header("Worker"));
			let now = 0;
			let closing = false;
			const expiryMs = 250;
			const observed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const scheduled: Array<{ ms: number; finish: () => void }> = [];
			const manager = await SessionManager.open(child, undefined, await db.open(), {
				suppressBreadcrumb: true,
				parentContinuationTiming: {
					expiryMs,
					now: () => now,
					wait: ms => {
						if (closing) {
							now += ms;
							return Promise.resolve();
						}
						const done = Promise.withResolvers<void>();
						scheduled.push({ ms, finish: () => done.resolve() });
						observed[scheduled.length - 1]?.resolve();
						return done.promise;
					},
				},
			});
			const errors: Array<{ error: Error; at: number }> = [];
			manager.onPersistenceError(error => errors.push({ error, at: now }));
			try {
				manager.appendMessage({ role: "user", content: "retained after expiry", timestamp: Date.now() });
				const flushed = manager.flush().catch(() => undefined);
				await observed[0].promise;
				expect(scheduled[0].ms).toBe(100);
				expect(errors).toEqual([]);
				now += scheduled[0].ms;
				scheduled[0].finish();
				await observed[1].promise;
				// The second backoff is capped by the remaining expiry, not 200 ms.
				expect(scheduled[1].ms).toBe(150);
				expect(errors).toEqual([]);
				now += scheduled[1].ms;
				scheduled[1].finish();
				await flushed;
				expect(errors).toHaveLength(1);
				expect(errors[0].at).toBe(expiryMs);
				expect(errors[0].error.message).toContain("did not go on in a sibling");
				expect(
					manager
						.getEntries()
						.some(
							entry =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								entry.message.content === "retained after expiry",
						),
				).toBe(true);
				expect((await db.row(child))?.content).not.toContain("retained after expiry");
				expect(await db.row(parent)).toBeDefined();
			} finally {
				// close() can retry publication and start another bounded follow.
				closing = true;
				await owner.unlink(parent);
				for (const wait of scheduled) wait.finish();
				await manager.close().catch(() => undefined);
				release();
				await owner.drain();
			}
		});
	});
}
