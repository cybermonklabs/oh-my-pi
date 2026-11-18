/**
 * Under `OMP_SESSION_EXCLUSIVE=1` a session another process holds stops the
 * process instead of moving it to another id, and the stop names the holder
 * when the storage can say who it is. That lookup is bounded: a storage that
 * never answers it (a database that stopped answering) still lets the
 * process end, without the holder's name, instead of leaving it running with
 * its session sealed.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const SESSION_MANAGER = path.join(import.meta.dir, "../../src/session/session-manager.ts");
const SESSION_STORAGE = path.join(import.meta.dir, "../../src/session/session-storage.ts");

/** A process whose storage says another process holds every session, and whose holder lookup never answers. */
const STOPPED_PROCESS = `
	import { SessionManager } from ${JSON.stringify(SESSION_MANAGER)};
	import { MemorySessionStorage } from ${JSON.stringify(SESSION_STORAGE)};
	const storage = new MemorySessionStorage();
	storage.claimSession = () => null;
	storage.sessionClaimHolder = () => new Promise(() => {});
	const manager = SessionManager.create("/project", "/sessions", storage);
	await manager.ensureOnDisk().catch(() => {});
	await Bun.sleep(30_000);
	process.exit(0);
`;

describe("OMP_SESSION_EXCLUSIVE=1 on a session another process holds", () => {
	it("ends the process non-zero within the holder lookup's bound when the lookup never answers", async () => {
		const started = performance.now();
		const child = Bun.spawn([process.execPath, "--eval", STOPPED_PROCESS], {
			env: { ...process.env, OMP_SESSION_EXCLUSIVE: "1" },
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(15_000),
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		const elapsedMs = performance.now() - started;
		expect({
			exitCode,
			stopped: stderr.includes("stops (open-elsewhere): another omp process holds it."),
			withinBound: elapsedMs < 8000,
		}).toEqual({ exitCode: 1, stopped: true, withinBound: true });
	}, 20_000);
});
