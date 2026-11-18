// Integration test of the real cross-process daemon broker and real daemon processes whose pin
// (`Process.fromPid`) fails, as with no descriptor left: each `list` refreshes the daemons
// (deterministically, no timer), and exits are awaited through the broker's own exit wait.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { type DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const NAME = "unpinnable";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function snapshotOf(client: DaemonBrokerClient): Promise<DaemonSnapshot> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	const daemon = listed.daemons.find(entry => entry.name === NAME);
	if (!daemon) throw new Error(`daemon ${NAME} not listed`);
	return daemon;
}

async function waitForExit(client: DaemonBrokerClient): Promise<DaemonSnapshot> {
	const waited = await client.request({ op: "wait", name: NAME, for: "exit", timeoutMs: 5_000 });
	if (waited.op !== "wait") throw new Error(`unexpected result: ${waited.op}`);
	expect(waited.timedOut).toBe(false);
	return snapshotOf(client);
}

/** Whether signal 0 reaches `pid`: a process holds it. */
function signalReaches(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * `Process.fromPid` for `pid`, failing (as with no descriptor left) while `pinnable.now` is
 * false, and counting the failures; every other pid pins as usual.
 */
function spyOnPin(pid: () => number | undefined) {
	const realFromPid = Process.fromPid.bind(Process);
	const pinnable = { now: true, failures: 0 };
	const spy = spyOn(Process, "fromPid").mockImplementation(candidate => {
		if (pinnable.now || candidate !== pid()) return realFromPid(candidate);
		pinnable.failures++;
		return null;
	});
	return { pinnable, spy };
}

interface Broker {
	client: DaemonBrokerClient;
	pinnable: { now: boolean; failures: number };
}

/**
 * Starts a detached daemon under a first broker, shuts that broker down, and starts a second
 * one, which recovers the record. `unpinnableFrom` says when `Process.fromPid` starts failing
 * for the daemon: from the second broker's recovery on, or only once it has recovered it.
 */
async function withRecoveredDetachedDaemon(
	unpinnableFrom: "recovery" | "refresh",
	body: (broker: Broker, pid: number) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-unpinnable-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	let pid: number | undefined;

	const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const firstBroker = startBroker(projectDir, runtimeDir);
	try {
		const started = await firstClient.request({
			op: "start",
			spec: {
				name: NAME,
				application: process.execPath,
				args: ["-e", 'Bun.serve({ port: 0, fetch() { return new Response("ok"); } })'],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: true,
				detached: true,
			},
		});
		if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
		pid = started.daemon.pid;
		if (pid === undefined) throw new Error("detached daemon has no pid");
	} finally {
		await firstClient.request({ op: "shutdown" }).catch(() => undefined);
		firstClient.close();
		await firstBroker;
	}

	const daemonPid = pid;
	const { pinnable, spy } = spyOnPin(() => daemonPid);
	pinnable.now = unpinnableFrom !== "recovery";
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const broker = startBroker(projectDir, runtimeDir);
	try {
		const recovered = await snapshotOf(client);
		expect({ state: recovered.state, pid: recovered.pid }).toEqual({ state: "running", pid: daemonPid });
		pinnable.now = false;
		await body({ client, pinnable }, daemonPid);
	} finally {
		spy.mockRestore();
		await client.request({ op: "stop", name: NAME, timeoutMs: 2_000 }).catch(() => undefined);
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		const processRef = Process.fromPid(daemonPid);
		if (processRef?.status() === "running") {
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
		}
		process.title = previousTitle;
	}
}

/** Five refreshes (each `list`) that leave the daemon `pid` running, with as many failed pins. */
async function expectRunningUnpinned(
	{ client, pinnable }: Broker,
	pid: number,
	state: DaemonSnapshot["state"] = "running",
): Promise<void> {
	const failuresBefore = pinnable.failures;
	for (let refresh = 0; refresh < 5; refresh++) {
		const daemon = await snapshotOf(client);
		expect({ state: daemon.state, pid: daemon.pid }).toEqual({ state, pid });
		expect(signalReaches(pid)).toBe(true);
	}
	expect(pinnable.failures - failuresBefore).toBeGreaterThanOrEqual(5);
}

/**
 * The daemon stays running across the broker's refreshes while it cannot be pinned; once it is
 * killed, signal 0 no longer reaches it and the record settles — the control that the probe is
 * no constant.
 */
async function expectRunningUntilKilled(broker: Broker, pid: number): Promise<void> {
	await expectRunningUnpinned(broker, pid);
	process.kill(pid, "SIGKILL");
	expect(["exited", "failed"]).toContain((await waitForExit(broker.client)).state);
}

describe("daemon broker with a detached daemon it cannot pin", () => {
	it("recovers a detached daemon that cannot be pinned but still runs", async () => {
		await withRecoveredDetachedDaemon("recovery", expectRunningUntilKilled);
	}, 20_000);

	it("keeps a recovered detached daemon running when it can no longer be pinned", async () => {
		await withRecoveredDetachedDaemon("refresh", expectRunningUntilKilled);
	}, 20_000);

	it("stops a detached daemon it cannot pin through a later pin, never by its pid", async () => {
		await withRecoveredDetachedDaemon("refresh", async (broker, pid) => {
			const stopped = await broker.client.request({ op: "stop", name: NAME, timeoutMs: 200 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			// The stop could not pin the daemon: nothing was signalled, and it stays stopping.
			await expectRunningUnpinned(broker, pid, "stopping");
			broker.pinnable.now = true;
			const settled = await waitForExit(broker.client);
			expect({ state: settled.state, pid: settled.pid }).toEqual({ state: "exited", pid: undefined });
			expect(signalReaches(pid)).toBe(false);
		});
	}, 20_000);
});

/**
 * The non-detached daemon of a previous broker that died without stopping it, recorded as running
 * with the start mark `recordedStart` gives for it (its own, or another process's): here a process
 * of its own session (as the broker spawns daemons) that the test starts now, recovered under a
 * fresh broker whose pin of it fails while `pinnable.now` is false (when the broker recovers,
 * `pinnable.now` is `pinnableAtRecovery`). It sleeps past the test runner's bound.
 */
async function withRecoveredOrphan(
	recordedStart: (orphanMark: string) => string,
	pinnableAtRecovery: boolean,
	body: (broker: Broker, orphan: Bun.Subprocess) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-unpinnable-orphan-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	const now = Date.now();
	const orphan = Bun.spawn(["sleep", "600"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
	const orphanMark = Process.fromPid(orphan.pid)?.startMark;
	if (orphanMark === undefined) throw new Error("the orphan cannot be pinned");
	const dir = path.join(runtimeDir, "daemons", NAME);
	await Bun.write(
		path.join(dir, "spec.json"),
		JSON.stringify({
			name: NAME,
			application: "sleep",
			args: ["600"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: true,
			detached: false,
		}),
	);
	await Bun.write(
		path.join(dir, "meta.json"),
		JSON.stringify({
			daemon: {
				name: NAME,
				id: NAME,
				state: "running",
				pid: orphan.pid,
				processStart: recordedStart(orphanMark),
				createdAt: now,
				startedAt: now,
				restartCount: 0,
				outputBytes: 0,
				persist: true,
				detached: false,
			},
		}),
	);
	const { pinnable, spy } = spyOnPin(() => orphan.pid);
	pinnable.now = pinnableAtRecovery;
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const broker = startBroker(projectDir, runtimeDir);
	try {
		await body({ client, pinnable }, orphan);
	} finally {
		spy.mockRestore();
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		orphan.kill("SIGKILL");
		process.title = previousTitle;
	}
}

/** The snapshot of a reaped recovered record. */
const REAPED: { state: DaemonSnapshot["state"]; pid: number | undefined; exitReason: string | undefined } = {
	state: "exited",
	pid: undefined,
	exitReason: "previous broker exited",
};

describe("daemon broker with a non-detached daemon of a previous broker it cannot pin", () => {
	it("keeps the record, kills nothing by pid, and kills the daemon through the pin once it pins", async () => {
		await withRecoveredOrphan(
			own => own,
			false,
			async (broker, orphan) => {
				// Recovery could not pin the daemon it must kill: the record stays, running, and
				// the daemon is neither reaped nor signalled.
				await expectRunningUnpinned(broker, orphan.pid);
				expect(orphan.exitCode).toBeNull();
				// Once a refresh pins it, it is killed through the pin, and the record is reaped.
				broker.pinnable.now = true;
				const reaped = await waitForExit(broker.client);
				expect({ state: reaped.state, pid: reaped.pid, exitReason: reaped.exitReason }).toEqual(REAPED);
				await orphan.exited;
				expect(orphan.signalCode).toBe("SIGTERM");
			},
		);
	}, 20_000);

	it("kills no process that took the pid after the recorded daemon", async () => {
		// The record names the start mark of another process (the test's own) than the one now
		// holding its pid, so that one reused the pid: the daemon is gone, and its record is
		// reaped without a kill, whether recovery pins the process or a later refresh does.
		const another = Process.fromPid(process.pid)?.startMark;
		if (another === undefined) throw new Error("the test process cannot be pinned");
		const outcomes: unknown[] = [];
		for (const pinnableAtRecovery of [true, false]) {
			await withRecoveredOrphan(
				() => another,
				pinnableAtRecovery,
				async (broker, orphan) => {
					broker.pinnable.now = true;
					const reaped = await snapshotOf(broker.client);
					// A kill would end the test's own child, which Bun then reaps: signal 0 would
					// no longer reach it.
					outcomes.push({
						pinnableAtRecovery,
						record: { state: reaped.state, pid: reaped.pid, exitReason: reaped.exitReason },
						alive: signalReaches(orphan.pid),
					});
				},
			);
		}
		expect(outcomes).toEqual([
			{ pinnableAtRecovery: true, record: REAPED, alive: true },
			{ pinnableAtRecovery: false, record: REAPED, alive: true },
		]);
	}, 20_000);
});
