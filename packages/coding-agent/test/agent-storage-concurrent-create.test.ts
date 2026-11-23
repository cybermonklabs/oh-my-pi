/**
 * Several omp processes that start at once on a machine with no agent.db yet all create it. Each
 * checks for the settings table and creates it when missing; without one write transaction around that
 * check, two processes both see no table and the later `CREATE TABLE settings` fails with
 * "table settings already exists".
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const fixture = path.join(import.meta.dir, "fixtures", "agent-storage-concurrent-open.ts");
const PROCESSES = 6;
const ROUNDS = 10;
const tempDirs: TempDir[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

/** Reads an opener's whole stdout once: resolves `ready` at its READY line and `result` with its last line. */
function watch(opener: Bun.Subprocess<"ignore", "pipe", "pipe">): { ready: Promise<void>; result: Promise<string> } {
	const ready = Promise.withResolvers<void>();
	const result = (async () => {
		let last = "";
		for await (const raw of readLines(opener.stdout)) {
			const line = new TextDecoder().decode(raw).trim();
			if (line === "READY") ready.resolve();
			else if (line) last = line;
		}
		ready.resolve();
		const [stderr] = await Promise.all([new Response(opener.stderr).text(), opener.exited]);
		return last || `no result: ${stderr.slice(-200)}`;
	})();
	return { ready: ready.promise, result };
}

async function round(dir: string, index: number): Promise<string[]> {
	const dbPath = path.join(dir, `agent-${index}.db`);
	const startFile = path.join(dir, `start-${index}`);
	const openers = Array.from({ length: PROCESSES }, () =>
		watch(
			Bun.spawn([process.execPath, fixture, dbPath, startFile], {
				cwd: path.join(import.meta.dir, ".."),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		),
	);
	// Each opener has loaded its modules and waits on the start file before any of them begins.
	await Promise.all(openers.map(opener => opener.ready));
	fs.writeFileSync(startFile, "");
	return Promise.all(openers.map(opener => opener.result));
}

test("processes that create agent.db at the same moment all open it", async () => {
	const tempDir = TempDir.createSync("@omp-agent-storage-concurrent-");
	tempDirs.push(tempDir);
	const failures: string[] = [];
	for (let index = 0; index < ROUNDS; index++) {
		for (const result of await round(tempDir.path(), index)) {
			if (result !== "OK") failures.push(`round ${index}: ${result}`);
		}
	}
	expect(failures).toEqual([]);
}, 240_000);
