/**
 * A session that ends on SIGTERM stores its exit record on a store that only
 * queues its writes (indexed backends, SQL storage), and a store that never
 * answers cannot hold the exit past the cleanup deadline. Each case runs
 * `fixtures/session-exit-signal-host.ts` in a child process and signals it.
 * The PostgreSQL cases run when `OMP_TEST_SQL_POSTGRES_URL` names a throwaway
 * database; each uses a table of its own and drops it when done.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const HOST = path.join(import.meta.dir, "../fixtures/session-exit-signal-host.ts");
const POSTGRES_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
/** The cleanup pass's deadline (`CLEANUP_DEADLINE_MS` of the pi-utils postmortem module). */
const CLEANUP_DEADLINE_MS = 10_000;
/** Room over the deadline for a loaded machine's timers and the process teardown. */
const EXIT_SLACK_MS = 4_000;
/** How long the slow PostgreSQL case keeps the store's table locked after the signal. */
const LOCK_AFTER_SIGNAL_MS = 1_500;
const CASE_TIMEOUT_MS = 60_000;

interface Host {
	child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	sessionFile: string;
	storedAt: string | undefined;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workDir(): string {
	const dir = TempDir.createSync("@pi-session-exit-signal-store-");
	cleanups.push(() => dir.removeSync());
	return dir.path();
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string | undefined> {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		text += decoder.decode(chunk, { stream: true });
		const end = text.indexOf("\n");
		if (end >= 0) return text.slice(0, end);
	}
	return undefined;
}

/** Start the host and wait until its session is stored and its exit recorder registered. */
async function startHost(dir: string, args: string[]): Promise<Host> {
	const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, "agent") };
	delete env.OMP_SESSION_STORAGE;
	delete env.OMP_SESSION_SQL_DSN_FILE;
	const child = Bun.spawn([process.execPath, HOST, args[0] ?? "", dir, ...args.slice(1)], {
		cwd: dir,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	cleanups.push(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	const line = await firstLine(child.stdout);
	if (line === undefined) {
		await child.exited;
		throw new Error(`host ended before it was ready: ${await new Response(child.stderr).text()}`);
	}
	const ready = JSON.parse(line) as { sessionFile: string; storedAt?: string };
	return { child, sessionFile: ready.sessionFile, storedAt: ready.storedAt };
}

/** Send SIGTERM; resolve with the exit code and the milliseconds from the signal to the exit. */
async function terminate(host: Host, whileExiting?: () => Promise<void>): Promise<{ code: number; ms: number }> {
	const start = performance.now();
	host.child.kill("SIGTERM");
	await whileExiting?.();
	const code = await host.child.exited;
	return { code, ms: performance.now() - start };
}

function exitRecords(transcript: string): unknown[] {
	return transcript
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })
		.filter(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE)
		.map(entry => entry.data);
}

describe("SIGTERM on a store that only queues its writes", () => {
	it(
		"stores the exit record a slow backend takes after the signal",
		async () => {
			const host = await startHost(workDir(), ["queued", "slow"]);
			const exit = await terminate(host);

			expect(exit.code).toBe(143);
			if (!host.storedAt) throw new Error("Expected the queued store's file");
			expect(exitRecords(fs.readFileSync(host.storedAt, "utf8"))).toMatchObject([
				{ reason: "sigterm", kind: "signal" },
			]);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"exits by the cleanup deadline when the backend never answers",
		async () => {
			const host = await startHost(workDir(), ["queued", "hang"]);
			const exit = await terminate(host);

			expect(exit.code).toBe(143);
			expect(exit.ms).toBeLessThan(CLEANUP_DEADLINE_MS + EXIT_SLACK_MS);
		},
		CASE_TIMEOUT_MS,
	);
});

describe.skipIf(!POSTGRES_URL)("SIGTERM on SQL storage on PostgreSQL", () => {
	const url = POSTGRES_URL ?? "";

	function table(): string {
		const name = `omp_exit_${Math.random().toString(36).slice(2, 10)}`;
		cleanups.push(async () => {
			const client = new SQL(url);
			try {
				await client.unsafe(`DROP TABLE IF EXISTS ${name}_parts, ${name}`);
			} finally {
				await client.end();
			}
		});
		return name;
	}

	/** Lock `name` against writes in a transaction of its own; the returned function ends it. */
	async function lockTable(name: string): Promise<() => Promise<void>> {
		const client = new SQL(url);
		const locked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const transaction = client.begin(async lock => {
			await lock.unsafe(`LOCK TABLE ${name} IN EXCLUSIVE MODE`);
			locked.resolve();
			await release.promise;
		});
		transaction.catch(locked.reject);
		let released: Promise<void> | undefined;
		const unlock = (): Promise<void> => {
			released ??= (async () => {
				release.resolve();
				try {
					await transaction;
				} finally {
					await client.end();
				}
			})();
			return released;
		};
		cleanups.push(unlock);
		await locked.promise;
		return unlock;
	}

	async function storedTranscript(name: string, sessionFile: string): Promise<string> {
		const client = new SQL(url);
		try {
			const storage = await SqlSessionStorage.create({ client, table: name });
			return await storage.readText(sessionFile);
		} finally {
			await client.end();
		}
	}

	it(
		"stores the exit record once the database takes the write",
		async () => {
			const name = table();
			const host = await startHost(workDir(), ["postgres", url, name]);
			// Writes to the session table wait on the lock: the record is still in
			// flight when the signal lands, as on a slow database. The wait is real
			// time because the host is another process on the platform clock: a host
			// that does not wait for the store exits before the lock ends.
			const unlock = await lockTable(name);
			const exit = await terminate(host, async () => {
				await Promise.race([host.child.exited, Bun.sleep(LOCK_AFTER_SIGNAL_MS)]);
				await unlock();
			});

			expect(exit.code).toBe(143);
			expect(exitRecords(await storedTranscript(name, host.sessionFile))).toMatchObject([
				{ reason: "sigterm", kind: "signal" },
			]);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"exits by the cleanup deadline when the database never answers",
		async () => {
			const name = table();
			const host = await startHost(workDir(), ["postgres", url, name]);
			await lockTable(name);
			const exit = await terminate(host);

			expect(exit.code).toBe(143);
			expect(exit.ms).toBeLessThan(CLEANUP_DEADLINE_MS + EXIT_SLACK_MS);
		},
		CASE_TIMEOUT_MS,
	);
});
