// Integration test of the real in-process daemon broker after a step of the wall clock (an NTP
// step after a resume, a VM restore, `date -s`). The step is a seam on the broker's wall clock:
// `Date.now` reads ahead (or behind) from the step on. After a forward step, a running daemon
// must stay running in `list`, a `stop` must stop it, and a broker that recovers it after the
// step must recover it as running: the broker tells the daemon from a process that reused its pid
// by the kernel's start mark, never by comparing a process age with the wall clock. After a
// backward step, the broker's waits, a daemon's uptime and the client's wait for its broker are
// timed on the monotonic clock. Each wait is for its event; the test runner's timeout is the
// bound.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonRpcResult,
} from "../../src/launch/protocol";

const NAME = "clockstep";
const STEP_MS = 5_000;

function signalReaches(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Until signal 0 no longer reaches `pid`: the daemon ended and was reaped. */
async function ended(pid: number): Promise<void> {
	while (signalReaches(pid)) await Bun.sleep(20);
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions = {}): Promise<void> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment(options);
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return broker;
}

async function snapshotOf(client: DaemonBrokerClient): Promise<DaemonSnapshot | undefined> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	return listed.daemons.find(daemon => daemon.name === NAME);
}

/** Starts `sleep 600` (found on `PATH`) as a daemon; its pid. */
async function startSleep(client: DaemonBrokerClient, projectDir: string, detached: boolean): Promise<number> {
	const started = await client.request({
		op: "start",
		spec: {
			name: NAME,
			application: "sleep",
			args: ["600"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: true,
			detached,
		},
	});
	if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
	const pid = started.daemon.pid;
	if (pid === undefined) throw new Error("the daemon has no pid");
	return pid;
}

/** The wall clock as the broker reads it, `byMs` ahead (behind when negative), until the step is undone. */
function stepTheWallClock(byMs = STEP_MS): { undo(): void } {
	const realNow = Date.now.bind(Date);
	const spy = spyOn(Date, "now").mockImplementation(() => realNow() + byMs);
	return { undo: () => spy.mockRestore() };
}

function dirs(root: string): { projectDir: string; runtimeDir: string } {
	return { projectDir: path.join(root, "project"), runtimeDir: path.join(root, "runtime") };
}

describe("daemon broker after a forward step of the wall clock", () => {
	for (const detached of [true, false]) {
		it(`lists and stops a ${detached ? "detached" : "pipe"} daemon started before the step`, async () => {
			using tempDir = TempDir.createSync("@omp-launch-clockstep-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const broker = startBroker(projectDir, runtimeDir);
			let pid: number | undefined;
			try {
				pid = await startSleep(client, projectDir, detached);
				const before = (await snapshotOf(client))?.state;
				const stepped = stepTheWallClock();
				try {
					const after = (await snapshotOf(client))?.state;
					const aliveAfterList = signalReaches(pid);
					const stopped = await client.request({ op: "stop", name: NAME, timeoutMs: 1_000 });
					// A stop that reached the daemon ends it; one that did not leaves it running,
					// and this wait for its end is then failed by the runner.
					await ended(pid);
					expect({ before, after, aliveAfterList, stopped: stopped.op }).toEqual({
						before: "running",
						after: "running",
						aliveAfterList: true,
						stopped: "stop",
					});
				} finally {
					stepped.undo();
				}
			} finally {
				if (pid !== undefined && signalReaches(pid)) process.kill(pid, "SIGKILL");
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker;
			}
		}, 30_000);
	}

	it("recovers a detached daemon that runs on across the step as running", async () => {
		using tempDir = TempDir.createSync("@omp-launch-clockstep-recovery-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		let pid: number | undefined;
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir);
		try {
			pid = await startSleep(first, projectDir, true);
		} finally {
			await first.request({ op: "shutdown" }).catch(() => undefined);
			first.close();
			await firstBroker;
		}
		const stepped = stepTheWallClock();
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const recovered = (await snapshotOf(client))?.state;
			const aliveAfterRecovery = signalReaches(pid);
			await client.request({ op: "stop", name: NAME, timeoutMs: 1_000 });
			await ended(pid);
			expect({ recovered, aliveAfterRecovery }).toEqual({ recovered: "running", aliveAfterRecovery: true });
		} finally {
			stepped.undo();
			if (signalReaches(pid)) process.kill(pid, "SIGKILL");
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	}, 30_000);
});

describe("daemon broker and client after a backward step of the wall clock", () => {
	it("times a wait on the monotonic clock: the step does not hold it past its timeout", async () => {
		using tempDir = TempDir.createSync("@omp-launch-clockstep-wait-");
		const { projectDir, runtimeDir } = dirs(tempDir.path());
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		let stepped: { undo(): void } | undefined;
		let pid: number | undefined;
		try {
			pid = await startSleep(client, projectDir, false);
			const waiting = client.request({ op: "wait", name: NAME, for: "exit", timeoutMs: 1_000 });
			await Bun.sleep(200);
			// The wall clock steps back 60 s while the broker waits.
			stepped = stepTheWallClock(-60_000);
			// The wait ends at its 1 s timeout; one timed on the wall clock would wait 60 s more (and
			// the client gives up on it at 6 s). The bound is timed on the monotonic clock.
			const held = Bun.sleep(15_000).then(() => "held" as const);
			const waited = await Promise.race([waiting, held]);
			if (waited === "held" || waited.op !== "wait") throw new Error(`the wait did not end: ${String(waited)}`);
			expect({ timedOut: waited.timedOut, state: waited.daemon.state }).toEqual({
				timedOut: true,
				state: "running",
			});
		} finally {
			stepped?.undo();
			if (pid !== undefined && signalReaches(pid)) process.kill(pid, "SIGKILL");
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 30_000);

	it("times a daemon's uptime on the monotonic clock: a quick crash after the step is corrected is a crash", async () => {
		const BACKOFF_BASE_MS = 100;
		using tempDir = TempDir.createSync("@omp-launch-clockstep-uptime-");
		const { projectDir, runtimeDir } = dirs(tempDir.path());
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir, { restartBackoffBaseMs: BACKOFF_BASE_MS });
		try {
			// The wall clock reads 60 s behind while the daemon starts (a VM restored from a
			// snapshot), and is right again before it exits (NTP steps it forward).
			const stepped = stepTheWallClock(-60_000);
			let started: DaemonRpcResult;
			try {
				started = await client.request({
					op: "start",
					spec: {
						name: NAME,
						// Exits 1 when told to, on its standard input.
						application: process.execPath,
						args: ["-e", "process.stdin.once('data', () => process.exit(1)); setInterval(() => {}, 60_000);"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "on-failure",
						persist: false,
						detached: false,
					},
				});
			} finally {
				stepped.undo();
			}
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
			await client.request({ op: "send", name: NAME, data: "exit\n" });
			// It ran for well under the 30 s that reset the crash count, so this first crash counts:
			// the restart waits twice the backoff base. An uptime from the wall clock (60 s more)
			// resets the count and waits the base alone.
			let restart: RegExpMatchArray | null = null;
			while (restart === null) {
				const logs = await client.request({
					op: "logs",
					name: NAME,
					lines: 50,
					head: false,
					follow: false,
					timeoutMs: 1_000,
				});
				if (logs.op !== "logs") throw new Error(`unexpected result: ${logs.op}`);
				restart = logs.text.match(/restarting in (\d+)ms/);
				if (restart === null) await Bun.sleep(20);
			}
			expect(Number(restart[1])).toBe(BACKOFF_BASE_MS * 2);
		} finally {
			await client.request({ op: "stop", name: NAME, timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 30_000);

	it("times the client's wait for the broker it started on the monotonic clock: the step does not hold it", async () => {
		using tempDir = TempDir.createSync("@omp-launch-clockstep-connect-");
		const { projectDir, runtimeDir } = dirs(tempDir.path());
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const realSpawn = Bun.spawn;
		let stepped: { undo(): void } | undefined;
		// What the client spawns as its broker binds no socket, so the client waits for one until
		// its 10 s timeout; the wall clock steps back 60 s while it waits.
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
			setTimeout(() => {
				stepped = stepTheWallClock(-60_000);
			}, 200);
			return realSpawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		}) as unknown as typeof Bun.spawn);
		try {
			// The client gives up at its 10 s timeout; one timed on the wall clock would wait 60 s
			// more. The bound is timed on the monotonic clock.
			const failed = client.request({ op: "list" }).then(
				() => "connected",
				(error: Error) => error.message,
			);
			const held = Bun.sleep(25_000).then(() => "held");
			expect(await Promise.race([failed, held])).toStartWith("Failed to start daemon broker");
		} finally {
			spawnSpy.mockRestore();
			stepped?.undo();
			client.close();
		}
	}, 40_000);
});
