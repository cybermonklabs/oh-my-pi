// Integration tests of a daemon stop whose native terminate rejects, against an in-process broker and a real daemon
// child. A refusal (the daemon still runs) must fail the stop with it; only a stop whose walk could not read the
// whole tree, once the daemon itself has stopped, goes on with a warning. The terminate of the daemon's own process
// is the only thing faked; the broker, the stop and the daemon are real.
import { describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const NAME = "stop-refused";

interface EmbeddedBroker {
	/** Settles once this in-process broker has shut down. */
	finished: Promise<void>;
}

/** Starts the in-process broker and waits until it accepts connections. */
async function startBroker(projectDir: string, runtimeDir: string): Promise<EmbeddedBroker> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "60000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (!(await Promise.race([listening.promise, finished.then(() => false)])))
		throw new Error("In-process daemon broker did not claim its scope");
	return { finished };
}

/**
 * Starts a daemon that runs until killed, makes its native terminate do `terminate` instead, runs `body`, then kills
 * the daemon for real and shuts the broker down.
 */
async function withRefusingDaemon(
	prefix: string,
	terminate: (real: Process["terminate"], options: Parameters<Process["terminate"]>[0]) => Promise<boolean>,
	body: (client: DaemonBrokerClient, daemonPid: number) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync(prefix);
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
	const previousTitle = process.title;
	const broker = await startBroker(projectDir, runtimeDir);
	let daemonPid: number | undefined;
	try {
		const started = await client.request({
			op: "start",
			spec: {
				name: NAME,
				application: process.execPath,
				args: ["-e", "setInterval(() => {}, 1_000)"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("the daemon did not start");
		daemonPid = started.daemon.pid;
		const pid = daemonPid;
		const fromPid = Process.fromPid.bind(Process);
		spyOn(Process, "fromPid").mockImplementation((candidate: number) => {
			const processRef = fromPid(candidate);
			if (processRef && candidate === pid) {
				const real = processRef.terminate.bind(processRef);
				spyOn(processRef, "terminate").mockImplementation(options => terminate(real, options));
			}
			return processRef;
		});
		await body(client, daemonPid);
	} finally {
		mock.restore();
		if (daemonPid !== undefined) await Process.fromPid(daemonPid)?.terminate({ group: true, timeoutMs: 2_000 });
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker.finished.catch(() => undefined);
		process.title = previousTitle;
	}
}

describe.skipIf(process.platform === "win32")("a daemon stop whose terminate rejects", () => {
	it("fails the stop when terminate refuses and the daemon still runs", async () => {
		const refusal = new Error("terminate refused");
		await withRefusingDaemon(
			"@omp-launch-stop-refused-",
			() => Promise.reject(refusal),
			async (client, daemonPid) => {
				await expect(client.request({ op: "stop", name: NAME, timeoutMs: 500 })).rejects.toThrow(
					"terminate refused",
				);
				// The refusal left the daemon running.
				expect(Process.fromPid(daemonPid)?.status()).toBe(ProcessStatus.Running);
			},
		);
	}, 20_000);

	it("goes on when the walk could not read the whole tree but the daemon stopped", async () => {
		await withRefusingDaemon(
			"@omp-launch-stop-partly-",
			async (real, options) => {
				await real(options);
				throw new Error(
					"cannot list the threads of process 1: Too many open files: signalled 1 processes of the tree, " +
						"but one the walk could not read may not have been",
				);
			},
			async client => {
				const stopped = await client.request({ op: "stop", name: NAME, timeoutMs: 500 });
				if (stopped.op !== "stop") throw new Error(`unexpected result ${stopped.op}`);
				expect(stopped.daemon.state).not.toBe("running");
				expect(stopped.daemon.state).not.toBe("stopping");
			},
		);
	}, 20_000);

	it("fails the stop when the walk could not read the whole tree and the daemon still runs", async () => {
		await withRefusingDaemon(
			"@omp-launch-stop-partly-running-",
			() =>
				Promise.reject(
					new Error(
						"cannot list the threads of process 1: Too many open files: signalled 0 processes of the tree, " +
							"but one the walk could not read may not have been",
					),
				),
			async (client, daemonPid) => {
				await expect(client.request({ op: "stop", name: NAME, timeoutMs: 500 })).rejects.toThrow(
					"the walk could not read",
				);
				expect(Process.fromPid(daemonPid)?.status()).toBe(ProcessStatus.Running);
			},
		);
	}, 20_000);
});
