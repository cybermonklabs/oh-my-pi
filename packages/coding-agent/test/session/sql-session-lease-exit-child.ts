/**
 * A process for `sql-session-lease-exit.test.ts`: postmortem's signal handlers installed, as the CLI installs them,
 * and one `SqlSessionStorage` with claims that takes a lease the way a short-lived claimant does (a delete, a
 * rename, a move's destination: `acquireSessionClaim`, then work, then the release in a `finally` it never reaches),
 * and writes one line under it. argv[2] is a JSON `{ dsn, table, leaseTable, sessionId, file, peer?, shared?,
 * stopOn? }`; `shared` takes the claim twice (one lease row, two references, as a session and its subagent's
 * transcript under it share one), and `peer` adds another cleanup callback that keeps the pass open past
 * postmortem's 10 s base deadline: `long` settles after 11 s under a `deadlineMs` of 20 s (as a login refresh's
 * save does), `hung` never settles. The process prints `held` once the claim is held and the write landed, then
 * waits for a signal; with `stopOn` (a session file another process holds, run under `OMP_SESSION_EXCLUSIVE=1`) it
 * opens that session instead, which stops the process.
 */
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { SessionManager } from "../../src/session/session-manager";
import { SqlSessionStorage } from "../../src/session/sql-session-storage";

postmortem.installProcessHandlers();
const { dsn, table, leaseTable, sessionId, file, peer, shared, stopOn } = JSON.parse(process.argv[2] ?? "{}") as {
	dsn: string;
	table: string;
	leaseTable: string;
	sessionId: string;
	file: string;
	peer?: "long" | "hung";
	shared?: boolean;
	stopOn?: string;
};
if (peer === "long") postmortem.register("peer-long", () => Bun.sleep(11_000), { deadlineMs: 20_000 });
if (peer === "hung") postmortem.register("peer-hung", () => new Promise<void>(() => {}));
const client = new SQL(dsn);
const storage = await SqlSessionStorage.create({ client, table, leaseTable, claims: true });
const release = await storage.acquireSessionClaim?.(sessionId, file);
if (!release) throw new Error("the claim was refused");
const second = shared ? await storage.acquireSessionClaim?.(sessionId, file) : undefined;
if (shared && !second) throw new Error("the second reference was refused");
try {
	await storage.writeText(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-11-18T00:00:00.000Z", cwd: "/" })}\n`,
	);
	await storage.drain();
	process.stdout.write("held\n");
	if (stopOn) {
		// The launcher-named session another process holds: its claim is refused, and the exclusive stop ends the
		// process while this store still holds the claim above.
		const manager = await SessionManager.open(stopOn, path.dirname(stopOn), storage, { suppressBreadcrumb: true });
		await manager.claimOpenedSession();
	}
	// The work a signal interrupts: the `finally` below never runs on a signal.
	await new Promise(() => {});
} finally {
	second?.();
	release();
}
