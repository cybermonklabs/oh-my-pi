/**
 * Under `OMP_SESSION_EXCLUSIVE=1`, each path of `SessionManager` that can find its session held by another process
 * stops the session and writes nothing more, its own file included, and so does `close()` after such a stop (a
 * signal's teardown closes the session during the stop's wait). Each case runs in a process of its own
 * (`session-exclusive-stop-child.ts`), since the stop ends its process, on a SQL store on SQLite, where no lease
 * fence would refuse a write the size check lets through: the file still has the size the session last wrote.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { SqlSessionStorage } from "../../src/session/sql-session-storage";

const CHILD = path.join(import.meta.dir, "session-exclusive-stop-child.ts");
const ID = "01a1f600-0000-7000-8000-000000000001";

/** The child's run of `scenario`: its exit code, whether it stopped, and the file's content before and after. */
async function run(scenario: string) {
	using dir = TempDir.createSync("@omp-exclusive-sites-");
	const child = Bun.spawn([process.execPath, CHILD, JSON.stringify({ dir: dir.path(), scenario })], {
		env: { ...process.env, OMP_SESSION_EXCLUSIVE: "1" },
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(30_000),
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const lines = stdout
		.split("\n")
		.filter(line => line.startsWith("{"))
		.map(line => JSON.parse(line) as { before?: string; stopped?: boolean });
	const before = lines.find(line => line.before !== undefined)?.before;
	const client = new SQL(`sqlite://${path.join(dir.path(), "sessions.db")}`);
	try {
		const reader = await SqlSessionStorage.create({ client, claims: false });
		const file = path.join(dir.path(), "sessions", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		const after = await reader.readText(file);
		const files = reader.listFilesSync(path.join(dir.path(), "sessions"), "*.jsonl");
		return {
			exitCode,
			stopped: stderr.includes(`Session ${ID} stops (`),
			unchanged: before !== undefined && after === before,
			files: files.map(name => path.basename(name)),
		};
	} finally {
		await client.end();
	}
}

describe("OMP_SESSION_EXCLUSIVE=1 stops a session another process holds and writes nothing after the stop", () => {
	for (const [scenario, site] of [
		["append", "the synchronous rewrite"],
		["claim-lost", "a claim the store reports lost"],
		["repair", "the authoritative publish"],
		["lease-lost-retry", "the authoritative publish refused with SessionLeaseLostError"],
		["atomic", "an atomic batch's fenced rewrite"],
		["close", "close() during the stop's wait, with a write failure latched"],
	] as const) {
		it(`through ${site}`, async () => {
			expect(await run(scenario)).toEqual({
				exitCode: 1,
				stopped: true,
				unchanged: true,
				files: [`2026-11-17T00-00-00-000Z_${ID}.jsonl`],
			});
		}, 40_000);
	}
});
