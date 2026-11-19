import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, acquireFileLock, withFileLock, withFileLockSync } from "../src/file-lock";
import { isEnoent } from "../src/fs-error";
import { removeWithRetries } from "../src/temp";

const { tryAcquireLock, getLockPath } = __internalsForTesting;

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

/** Starts a process that holds `target`'s lock until it is killed, and waits until it holds it. */
async function startHolder(root: string, target: string): Promise<Bun.Subprocess<"ignore", "ignore", "pipe">> {
	const readyPath = path.join(root, "holder-ready");
	const holder = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "fixtures/file-lock-holder.ts"), target, readyPath],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	for (;;) {
		try {
			await fs.access(readyPath);
			return holder;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (holder.exitCode !== null) {
				throw new Error(
					`lock holder exited before readiness (${holder.exitCode}): ${await new Response(holder.stderr).text()}`,
				);
			}
		}
	}
}

async function stopHolder(holder: Bun.Subprocess): Promise<void> {
	if (holder.exitCode !== null) return;
	holder.kill();
	await holder.exited;
}

describe("native file-lock ownership", () => {
	test("a cancelled waiter never enters its critical section or releases the current owner", async () => {
		const root = await mkRoot();
		const target = path.join(root, "cancelled.json");
		const lockPath = getLockPath(target);
		const owner = tryAcquireLock(lockPath);
		if (!owner) throw new Error("owner failed to acquire");
		let entered = false;
		try {
			const controller = new AbortController();
			const waiting = withFileLock(
				target,
				async () => {
					entered = true;
				},
				{
					signal: controller.signal,
					retries: 100,
					retryDelayMs: 1000,
				},
			);
			controller.abort();
			await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
			expect(entered).toBe(false);
			expect(tryAcquireLock(lockPath)).toBeNull();
		} finally {
			owner.release();
		}
		await withFileLock(target, async () => {
			entered = true;
		});
		expect(entered).toBe(true);
	});

	test("process death hands ownership to B while excluding C", async () => {
		const root = await mkRoot();
		const target = path.join(root, "abandoned.json");
		const readyPath = path.join(root, "holder-ready");
		const lockPath = getLockPath(target);
		const holder = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/file-lock-holder.ts"), target, readyPath],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			},
		);

		try {
			for (;;) {
				try {
					await fs.access(readyPath);
					break;
				} catch (error) {
					if (!isEnoent(error)) throw error;
					if (holder.exitCode !== null) {
						throw new Error(
							`lock holder exited before readiness (${holder.exitCode}): ${await new Response(holder.stderr).text()}`,
						);
					}
				}
			}

			holder.kill();
			expect(await holder.exited).not.toBe(0);

			const ownerB = tryAcquireLock(lockPath);
			if (!ownerB) throw new Error("B failed to acquire the abandoned lock");
			const ownerC = tryAcquireLock(lockPath);
			expect(ownerC).toBeNull();
			expect(ownerB.acquired).toBe(true);
			ownerB.release();
		} finally {
			if (holder.exitCode === null) {
				holder.kill();
				await holder.exited;
			}
		}
	}, 10_000);

	test("a former owner's late release cannot unlock its successor", async () => {
		const root = await mkRoot();
		const lockPath = getLockPath(path.join(root, "handoff.json"));
		const formerOwner = tryAcquireLock(lockPath);
		if (!formerOwner) throw new Error("former owner failed to acquire");
		formerOwner.release();

		const successor = tryAcquireLock(lockPath);
		if (!successor) throw new Error("successor failed to acquire");

		// Force the old release path after the successor owns the same name.
		formerOwner.release();
		expect(tryAcquireLock(lockPath)).toBeNull();
		expect(successor.acquired).toBe(true);

		successor.release();
		const finalOwner = tryAcquireLock(lockPath);
		if (!finalOwner) throw new Error("final owner failed to acquire");
		finalOwner.release();
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						await Promise.resolve();
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);

	// If this regresses, a TUI or RPC session that waits on a lock another process holds
	// (settings, the browser daemon, a session write) freezes for about 50 ms on every attempt.
	test("a waiting loop leaves the event loop free while another process holds the lock, and takes it once the holder exits", async () => {
		const root = await mkRoot();
		const target = path.join(root, "contended.json");
		const holder = await startHolder(root, target);
		try {
			// Real time on purpose: the stall is a native call blocking the thread, which a fake clock
			// cannot see. A ticker 1 ms apart records the longest time the event loop could not run;
			// a claim against a live holder blocks it for at least 50 ms, scheduling noise far less.
			let longestGap = 0;
			let ticking = true;
			const ticker = (async () => {
				let last = performance.now();
				while (ticking) {
					await Bun.sleep(1);
					const now = performance.now();
					longestGap = Math.max(longestGap, now - last);
					last = now;
				}
			})();
			const acquiring = acquireFileLock(target, { retries: 1_000, retryDelayMs: 5 });
			// Long enough for several attempts against the live holder.
			await Bun.sleep(300);
			await stopHolder(holder);
			const lock = await acquiring;
			ticking = false;
			await ticker;
			lock.release();

			expect(longestGap).toBeLessThan(50);
		} finally {
			await stopHolder(holder);
		}
	}, 10_000);

	// If this regresses, a synchronous wait on a lock another process holds (the session
	// write gate) blocks its thread about 50 ms longer on every attempt before it gives up.
	test("a synchronous waiting loop gives up on a held lock without a blocking claim on every attempt", async () => {
		const root = await mkRoot();
		const target = path.join(root, "contended-sync.json");
		const holder = await startHolder(root, target);
		try {
			const started = performance.now();
			expect(() => withFileLockSync(target, () => {}, { retries: 20, retryDelayMs: 5 })).toThrow(
				"Failed to acquire lock",
			);
			// 19 probes, 19 delays of 5 ms and one claim; a claim on each attempt takes over a second.
			expect(performance.now() - started).toBeLessThan(500);
		} finally {
			await stopHolder(holder);
		}
	}, 10_000);
});
