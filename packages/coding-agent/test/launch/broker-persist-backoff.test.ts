// Integration tests of the real daemon broker with a record whose directory refuses writes (chmod
// 555, as a disk that stays full). In the first two, the record is a detached daemon of an older
// broker that recorded no start mark: recovery keeps it, `stop` leaves it `stopping` (nothing to
// pin), and the broker's monitor of recovered detached daemons keeps polling it. In the last two,
// the record is the broker's own daemon, which exits while the write of its exit fails. The broker's
// writes into the record's directory and its persistence warnings are counted with spies.
import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const NAME = "persist-backoff";

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

async function stateOf(client: DaemonBrokerClient): Promise<string | undefined> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	return listed.daemons.find(daemon => daemon.name === NAME)?.state;
}

async function diskState(metaPath: string): Promise<string> {
	return JSON.parse(await fs.readFile(metaPath, "utf8")).daemon.state;
}

interface Daemon {
	pid: number;
	mark: string | null | undefined;
}

/** Starts a `sleep` daemon through `client`, and returns its pid and start mark. */
async function startSleep(client: DaemonBrokerClient, projectDir: string, detached: boolean): Promise<Daemon> {
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
	if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("no daemon started");
	return { pid: started.daemon.pid, mark: Process.fromPid(started.daemon.pid)?.startMark };
}

/** A detached daemon, recorded by a broker that then exits, as an older broker recorded it: no mark. */
async function recordUnpinnable(projectDir: string, runtimeDir: string, metaPath: string): Promise<Daemon> {
	const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const firstBroker = startBroker(projectDir, runtimeDir);
	let daemon: Daemon;
	try {
		daemon = await startSleep(first, projectDir, true);
	} finally {
		await first.request({ op: "shutdown" }).catch(() => undefined);
		first.close();
		await firstBroker;
	}
	const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
	delete meta.daemon.processStart;
	await fs.writeFile(metaPath, JSON.stringify(meta));
	return daemon;
}

/** Kills only the daemon a test started, by the pid and mark recorded at its start. */
function killDaemon(daemon: Daemon | undefined, signal: NodeJS.Signals): boolean {
	if (daemon?.mark == null || Process.fromPid(daemon.pid)?.startMark !== daemon.mark) return false;
	process.kill(daemon.pid, signal);
	return true;
}

function paths(root: string) {
	const dir = path.join(root, "runtime", "daemons", NAME);
	return {
		projectDir: path.join(root, "project"),
		runtimeDir: path.join(root, "runtime"),
		dir,
		metaPath: path.join(dir, "meta.json"),
	};
}

/** Counts the broker's persistence warnings, and silences every warning. */
function countWarnings(): { warned: { failed: number; again: number }; restore(): void } {
	const warned = { failed: 0, again: 0 };
	const spy = spyOn(logger, "warn").mockImplementation(((message: string) => {
		if (message.startsWith("Failed to persist daemon metadata")) warned.failed++;
		if (message.startsWith("Persisted daemon metadata again")) warned.again++;
	}) as typeof logger.warn);
	return { warned, restore: () => spy.mockRestore() };
}

/**
 * Waits until the broker has handled a write that failed, which it warns at the first failure
 * in a row. A reply does not wait for the write its request queued, so on a loaded host the
 * failure may land after it. The runner bounds the wait.
 */
async function failureHandled(warned: { failed: number }): Promise<void> {
	while (warned.failed === 0) await Bun.sleep(20);
}

it("backs off a write that keeps failing, warns once, and writes once the disk takes writes", async () => {
	using tempDir = TempDir.createSync("@omp-launch-persist-backoff-");
	const { projectDir, runtimeDir, dir, metaPath } = paths(tempDir.path());
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	let daemon: Daemon | undefined;
	try {
		daemon = await recordUnpinnable(projectDir, runtimeDir, metaPath);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const writes = { n: 0 };
		const realWrite = Bun.write;
		const writeSpy = spyOn(Bun, "write").mockImplementation(((destination: unknown, ...rest: unknown[]) => {
			if (typeof destination === "string" && destination.startsWith(dir)) writes.n++;
			return (realWrite as (...args: unknown[]) => unknown).call(Bun, destination, ...rest);
		}) as typeof Bun.write);
		const { warned, restore: restoreWarnings } = countWarnings();
		try {
			expect(await stateOf(client)).toBe("running");
			await fs.chmod(dir, 0o555);
			// The stop's write fails: warned once, whatever its wait loop tried since.
			const stopped = await client.request({ op: "stop", name: NAME, timeoutMs: 300 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("stopping");
			await failureHandled(warned);
			expect(warned).toEqual({ failed: 1, again: 0 });

			// 3 s with no request, while the monitor polls every 100 ms: the retries back off
			// (their gaps double from 100 ms), so at most 5 fall in any 3 s, each one write
			// that fails; none is warned. A loaded host only makes fewer.
			const idleFrom = writes.n;
			await Bun.sleep(3_000);
			const idleWrites = writes.n - idleFrom;
			expect({ atMostFive: idleWrites <= 5, idleWrites, warned: { ...warned } }).toEqual({
				atMostFive: true,
				idleWrites,
				warned: { failed: 1, again: 0 },
			});

			// A request tries again at once, whatever the backoff.
			const requestFrom = writes.n;
			expect(await stateOf(client)).toBe("stopping");
			expect(writes.n - requestFrom).toBeGreaterThanOrEqual(1);
			expect(warned).toEqual({ failed: 1, again: 0 });

			// Once the directory takes writes again, a poll (no request) writes the record,
			// within one backoff, and the recovery is warned once. The runner bounds the wait.
			await fs.chmod(dir, 0o755);
			while ((await diskState(metaPath)) !== "stopping") await Bun.sleep(20);
			while (warned.again === 0) await Bun.sleep(20);
			expect(warned).toEqual({ failed: 1, again: 1 });
		} finally {
			writeSpy.mockRestore();
			restoreWarnings();
			await fs.chmod(dir, 0o755).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	} finally {
		process.title = previousTitle;
		killDaemon(daemon, "SIGKILL");
	}
}, 30_000);

it("times the backoff on the monotonic clock: a backward step of the wall clock does not hold a poll's retry", async () => {
	using tempDir = TempDir.createSync("@omp-launch-persist-clock-");
	const { projectDir, runtimeDir, dir, metaPath } = paths(tempDir.path());
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	let daemon: Daemon | undefined;
	try {
		daemon = await recordUnpinnable(projectDir, runtimeDir, metaPath);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const realNow = Date.now.bind(Date);
		let clockSpy: { mockRestore(): void } | undefined;
		const { warned, restore: restoreWarnings } = countWarnings();
		try {
			expect(await stateOf(client)).toBe("running");
			await fs.chmod(dir, 0o555);
			const stopped = await client.request({ op: "stop", name: NAME, timeoutMs: 300 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			await failureHandled(warned);
			expect({ memory: stopped.daemon.state, disk: await diskState(metaPath) }).toEqual({
				memory: "stopping",
				disk: "running",
			});
			// The wall clock steps back 60 s, as when NTP corrects a clock that ran fast, or a VM
			// is restored from a snapshot; then the directory takes writes again.
			clockSpy = spyOn(Date, "now").mockImplementation(() => realNow() - 60_000);
			await fs.chmod(dir, 0o755);
			// With no request, a poll writes the record within one backoff (at most 5 s). A
			// backoff timed on the wall clock waits for the step too, 60 s more. The wait is
			// timed on the monotonic clock, which the step does not move.
			const from = performance.now();
			while ((await diskState(metaPath)) !== "stopping" && performance.now() - from < 15_000) {
				await Bun.sleep(20);
			}
			expect(await diskState(metaPath)).toBe("stopping");
		} finally {
			clockSpy?.mockRestore();
			restoreWarnings();
			await fs.chmod(dir, 0o755).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	} finally {
		process.title = previousTitle;
		killDaemon(daemon, "SIGKILL");
	}
}, 45_000);

for (const detached of [false, true]) {
	it(`writes the exit of a ${detached ? "detached" : "pipe"} daemon again after its write failed`, async () => {
		using tempDir = TempDir.createSync("@omp-launch-persist-settled-");
		const { projectDir, runtimeDir, dir, metaPath } = paths(tempDir.path());
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const { warned, restore: restoreWarnings } = countWarnings();
		let daemon: Daemon | undefined;
		try {
			daemon = await startSleep(client, projectDir, detached);
			await fs.chmod(dir, 0o555);
			// The broker's own child exits while the write of its exit fails.
			expect(killDaemon(daemon, "SIGTERM")).toBe(true);
			const waited = await client.request({ op: "wait", name: NAME, for: "exit", timeoutMs: 10_000 });
			if (waited.op !== "wait") throw new Error(`unexpected result: ${waited.op}`);
			const settled = waited.daemon.state;
			expect({ timedOut: waited.timedOut, settled: ["exited", "failed"].includes(settled) }).toEqual({
				timedOut: false,
				settled: true,
			});
			await failureHandled(warned);
			expect(await diskState(metaPath)).toBe("running");
			// Once the directory takes writes again, a request writes the settled record.
			await fs.chmod(dir, 0o755);
			expect(await stateOf(client)).toBe(settled);
			expect(await diskState(metaPath)).toBe(settled);
		} finally {
			restoreWarnings();
			await fs.chmod(dir, 0o755).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
			killDaemon(daemon, "SIGKILL");
		}
	}, 30_000);
}
