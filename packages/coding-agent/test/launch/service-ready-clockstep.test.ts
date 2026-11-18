// Integration test of a service's ready wait after a backward step of the wall clock (an NTP step, a VM restore).
// With a ready interrupt, `startService` asks the broker to launch the service without waiting, then waits for
// readiness itself, for what is left of the spec's timeout. That time is measured on the client's monotonic clock:
// a wait measured from the broker's wall-clock `startedAt` would grow by a backward step of the wall clock (and be
// cut to nothing by a forward one).
import { expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
} from "../../src/launch/protocol";
import { startService } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";

const NAME = "never-ready";

/** Starts the in-process broker and waits until it accepts connections. */
async function startBroker(projectDir: string, runtimeDir: string): Promise<Promise<void>> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (!(await Promise.race([listening.promise, finished.then(() => false)])))
		throw new Error("In-process daemon broker did not claim its scope");
	return finished;
}

it("times a service's ready wait on the monotonic clock: a backward step of the wall clock does not hold it", async () => {
	using tempDir = TempDir.createSync("@omp-service-ready-clock-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const previousTitle = process.title;
	const broker = await startBroker(projectDir, runtimeDir);
	const session: ToolSession = {
		cwd: projectDir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getSessionId: () => "clock-session",
		queueLaunchCompletion: () => Promise.resolve(),
	};
	const realNow = Date.now.bind(Date);
	let clockSpy: { mockRestore(): void } | undefined;
	try {
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		const realRequest = client.request.bind(client);
		vi.spyOn(client, "request").mockImplementation(async (operation: DaemonOperation, signal?: AbortSignal) => {
			const result = await realRequest(operation, signal);
			// The wall clock steps back 60 s once the broker has launched the service.
			if (operation.op === "start") clockSpy = spyOn(Date, "now").mockImplementation(() => realNow() - 60_000);
			return result;
		});
		const neverInterrupted = new AbortController();
		const started = startService(
			session,
			{ name: NAME, command: "sleep 600", ready: { log: "never printed", timeout: 1 } },
			undefined,
			neverInterrupted.signal,
		);
		// The wait ends at the spec's 1 s timeout; one measured from the broker's wall-clock start would wait
		// 60 s more. The bound is timed on the monotonic clock, which the step does not move.
		const held = Bun.sleep(15_000).then(() => "held" as const);
		const outcome = await Promise.race([started, held]);
		if (outcome === "held") throw new Error("the ready wait did not end");
		expect({ readyTimedOut: outcome.readyTimedOut, interrupted: outcome.readyInterrupted }).toEqual({
			readyTimedOut: true,
			interrupted: false,
		});
	} finally {
		clockSpy?.mockRestore();
		vi.restoreAllMocks();
		await client.request({ op: "stop", name: NAME, timeoutMs: 2_000 }).catch(() => undefined);
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		process.title = previousTitle;
	}
}, 30_000);
