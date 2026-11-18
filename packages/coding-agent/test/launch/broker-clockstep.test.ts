// Integration test of the real in-process daemon broker after a forward step of the wall clock
// (an NTP step after a resume, a VM restore, `date -s`). The step is a seam on the broker's wall
// clock: `Date.now` reads 5 s ahead from the step on. A running daemon must stay running in
// `list`, a `stop` must stop it, and a broker that recovers it after the step must recover it as
// running: the broker tells the daemon from a process that reused its pid by the kernel's start
// mark, never by comparing a process age with the wall clock. Each wait is for its event; the test
// runner's timeout is the bound.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

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

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
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

/** Starts `/bin/sleep 600` as a daemon; its pid. */
async function startSleep(client: DaemonBrokerClient, projectDir: string, detached: boolean): Promise<number> {
	const started = await client.request({
		op: "start",
		spec: {
			name: NAME,
			application: "/bin/sleep",
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

/** The wall clock as the broker reads it, `STEP_MS` ahead, until the step is undone. */
function stepTheWallClock(): { undo(): void } {
	const realNow = Date.now.bind(Date);
	const spy = spyOn(Date, "now").mockImplementation(() => realNow() + STEP_MS);
	return { undo: () => spy.mockRestore() };
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
