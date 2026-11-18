/**
 * A process for `session-exclusive-stop-sites.test.ts`, run with `OMP_SESSION_EXCLUSIVE=1`: one session in a SQL
 * store on SQLite (whose writes no lease fence checks), whose claims this script decides, so that a given path of
 * `SessionManager` meets a session another process now holds and stops. The store answers the stop's holder lookup
 * after 1.5 s, as a slow database does, so the process lives on after the stop long enough for any write that
 * follows it to land. argv[2] is a JSON `{ dir, scenario }`; the script prints one JSON line, `{ before }`, the
 * session file's content at the moment the session stops being this process's, then triggers the scenario:
 *
 * - `append`: a turn is appended (the synchronous rewrite).
 * - `claim-lost`: the store reports the claim lost (the claim's `onLost`, as a heartbeat does).
 * - `repair`: `recoverPersistenceFromCurrentState()` (the authoritative publish).
 * - `lease-lost-retry`: the store refuses the authoritative publish once with `SessionLeaseLostError`.
 * - `atomic`: an atomic batch of appends (the fenced atomic rewrite).
 * - `close`: a write failure is latched first, a turn is appended (the stop), and the manager closes during the
 *   stop's wait, as a signal's teardown does.
 */
import * as path from "node:path";
import { SQL } from "bun";
import { SessionManager } from "../../src/session/session-manager";
import { SessionLeaseLostError, type SessionStorage } from "../../src/session/session-storage";
import { SqlSessionStorage } from "../../src/session/sql-session-storage";

const { dir, scenario } = JSON.parse(process.argv[2] ?? "{}") as { dir: string; scenario: string };
const ID = "01a1f600-0000-7000-8000-000000000001";
const sessions = path.join(dir, "sessions");
const file = path.join(sessions, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
const timestamp = "2026-11-17T00:00:00.000Z";
const transcript = `${[
	{ type: "session", version: 3, id: ID, timestamp, cwd: dir },
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "before", timestamp: 1 },
	},
]
	.map(entry => JSON.stringify(entry))
	.join("\n")}\n`;

const client = new SQL(`sqlite://${path.join(dir, "sessions.db")}`);
const storage = await SqlSessionStorage.create({ client, claims: true });
await storage.writeText(file, transcript);
await storage.drain();

// The claims this process holds: while `held`, every claim is granted; `lost` is what the store reports of one.
let held = true;
let lost = false;
let onLost: (() => void) | undefined;
const scripted = storage as unknown as {
	claimSession: SessionStorage["claimSession"];
	acquireSessionClaim: SessionStorage["acquireSessionClaim"];
	sessionClaimLost: SessionStorage["sessionClaimLost"];
	sessionClaimHolder: SessionStorage["sessionClaimHolder"];
	writeTextAtomic: SessionStorage["writeTextAtomic"];
};
scripted.claimSession = (_sessionId, _sessionPath, options) => {
	if (!held) return null;
	onLost = options?.onLost;
	return () => {};
};
scripted.acquireSessionClaim = async (sessionId, sessionPath, options) =>
	scripted.claimSession?.(sessionId, sessionPath, options) ?? null;
scripted.sessionClaimLost = () => lost;
scripted.sessionClaimHolder = async () => {
	await Bun.sleep(1500);
	return undefined;
};
/** Refuse the next atomic publish (SQL storage publishes a whole body with `writeTextAtomic`) with `error`, once. */
const refuseNextAtomicPublish = (error: Error): void => {
	const publish = storage.writeTextAtomic.bind(storage);
	let refused = false;
	scripted.writeTextAtomic = (target, content, options) => {
		if (!refused) {
			refused = true;
			return Promise.reject(error);
		}
		return publish(target, content, options);
	};
};

const manager = await SessionManager.open(file, sessions, storage, { suppressBreadcrumb: true });
// One turn while this process holds the session: it claims the session and writes.
manager.appendMessage({ role: "user", content: "while held", timestamp: 2 });
await manager.flush();
await storage.drain();

if (scenario === "close") {
	// A latched write failure: the authoritative publish fails once with an error that is no conflict.
	refuseNextAtomicPublish(new Error("a write that failed"));
	await manager.recoverPersistenceFromCurrentState().catch(() => undefined);
}
const report = (fields: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(fields)}\n`);
/** The session now belongs to another process: claims are refused and the held one counts as lost. */
const handOver = async (): Promise<void> => {
	await storage.drain();
	report({ before: await storage.readText(file) });
	held = false;
	lost = true;
};

switch (scenario) {
	case "append":
		await handOver();
		manager.appendMessage({ role: "user", content: "after the hand-over", timestamp: 3 });
		break;
	case "claim-lost":
		await handOver();
		onLost?.();
		break;
	case "repair":
		await handOver();
		await manager.recoverPersistenceFromCurrentState().catch(() => undefined);
		break;
	case "lease-lost-retry":
		await handOver();
		held = true;
		lost = false;
		refuseNextAtomicPublish(new SessionLeaseLostError(file, ID));
		await manager.recoverPersistenceFromCurrentState().catch(() => undefined);
		break;
	case "atomic":
		await handOver();
		await manager
			.appendEntriesAtomically(() => manager.appendMessage({ role: "user", content: "a batch", timestamp: 3 }))
			.catch(() => undefined);
		break;
	case "close":
		await handOver();
		manager.appendMessage({ role: "user", content: "after the hand-over", timestamp: 3 });
		await manager.close().catch(() => undefined);
		break;
	default:
		throw new Error(`unknown scenario ${scenario}`);
}
// The stop ends the process once the holder lookup answers; a path that never stops reports so and exits 0.
await Bun.sleep(5000);
report({ stopped: false });
process.exit(0);
