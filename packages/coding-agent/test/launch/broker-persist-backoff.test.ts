// Integration test of the real daemon broker with a record whose directory refuses writes (chmod
// 555, as a disk that stays full). The record is a detached daemon of an older broker that
// recorded no start mark: recovery keeps it, `stop` leaves it `stopping` (nothing to pin), and the
// broker's monitor of recovered detached daemons keeps polling it. The broker's writes into the
// record's directory and its persistence warnings are counted with spies.
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

it("backs off a write that keeps failing, warns once, and writes once the disk takes writes", async () => {
	using tempDir = TempDir.createSync("@omp-launch-persist-backoff-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const dir = path.join(runtimeDir, "daemons", NAME);
	const metaPath = path.join(dir, "meta.json");
	const previousTitle = process.title;
	let daemon: { pid: number; mark: string | null | undefined } | undefined;
	try {
		// A detached daemon, recorded by a broker that then exits.
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir);
		try {
			const started = await first.request({
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
					detached: true,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("no daemon started");
			daemon = { pid: started.daemon.pid, mark: Process.fromPid(started.daemon.pid)?.startMark };
		} finally {
			await first.request({ op: "shutdown" }).catch(() => undefined);
			first.close();
			await firstBroker;
		}
		// As an older broker recorded it: no mark, so nothing can pin it.
		const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
		delete meta.daemon.processStart;
		await fs.writeFile(metaPath, JSON.stringify(meta));

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const writes = { n: 0 };
		const warned = { failed: 0, again: 0 };
		const realWrite = Bun.write;
		const writeSpy = spyOn(Bun, "write").mockImplementation(((destination: unknown, ...rest: unknown[]) => {
			if (typeof destination === "string" && destination.startsWith(dir)) writes.n++;
			return (realWrite as (...args: unknown[]) => unknown).call(Bun, destination, ...rest);
		}) as typeof Bun.write);
		const warnSpy = spyOn(logger, "warn").mockImplementation(((message: string) => {
			if (message.startsWith("Failed to persist daemon metadata")) warned.failed++;
			if (message.startsWith("Persisted daemon metadata again")) warned.again++;
		}) as typeof logger.warn);
		try {
			expect(await stateOf(client)).toBe("running");
			await fs.chmod(dir, 0o555);
			// The stop's write fails: warned once, whatever its wait loop tried since.
			const stopped = await client.request({ op: "stop", name: NAME, timeoutMs: 300 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect({ state: stopped.daemon.state, warned: { ...warned } }).toEqual({
				state: "stopping",
				warned: { failed: 1, again: 0 },
			});

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
			while (JSON.parse(await fs.readFile(metaPath, "utf8")).daemon.state !== "stopping") {
				await Bun.sleep(20);
			}
			while (warned.again === 0) await Bun.sleep(20);
			expect(warned).toEqual({ failed: 1, again: 1 });
		} finally {
			writeSpy.mockRestore();
			warnSpy.mockRestore();
			await fs.chmod(dir, 0o755).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	} finally {
		process.title = previousTitle;
		// Only the daemon this test started, by the pid and mark recorded at its start.
		if (daemon?.mark != null && Process.fromPid(daemon.pid)?.startMark === daemon.mark) {
			process.kill(daemon.pid, "SIGKILL");
		}
	}
}, 30_000);
