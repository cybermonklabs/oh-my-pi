// Integration tests of a service's ready wait when the client waits for readiness itself (`startService` with a
// ready interrupt): it asks the broker to launch the service without waiting, then waits for what is left of the
// spec's timeout. What is left is counted from the launch, on monotonic clocks: a wait measured from the broker's
// wall-clock `startedAt` would grow by a backward step of the wall clock (and be cut to nothing by a forward one), and
// one counted from the client's request would also spend the time the broker took before the launch.
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

interface EmbeddedBroker {
	/** Settles once this in-process broker has shut down. */
	finished: Promise<void>;
}

/**
 * Starts the in-process broker and waits until it accepts connections. The result wraps `finished`: an async function
 * that returned the promise itself would make its caller's `await` wait for the broker's shutdown.
 */
async function startBroker(projectDir: string, runtimeDir: string): Promise<EmbeddedBroker> {
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
	return { finished };
}

/** Runs `body` against an in-process broker that the client talks to, then stops the service and the broker. */
async function withBroker(
	prefix: string,
	body: (session: ToolSession, client: brokerClients.DaemonBrokerClient) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync(prefix);
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const previousTitle = process.title;
	const broker = await startBroker(projectDir, runtimeDir);
	let brokerFinished = false;
	void broker.finished.then(() => {
		brokerFinished = true;
	});
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
	try {
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		// The in-process broker still runs (a `finished` that had settled would have set the flag by this tick), so
		// the client talks to it and not to a broker of its own spawning.
		await Promise.resolve();
		expect(brokerFinished).toBe(false);
		await body(session, client);
	} finally {
		vi.restoreAllMocks();
		await client.request({ op: "stop", name: NAME, timeoutMs: 2_000 }).catch(() => undefined);
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker.finished;
		process.title = previousTitle;
	}
}

it("times a service's ready wait on the monotonic clock: a backward step of the wall clock does not hold it", async () => {
	await withBroker("@omp-service-ready-clock-", async (session, client) => {
		const realNow = Date.now.bind(Date);
		let clockSpy: { mockRestore(): void } | undefined;
		try {
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
		}
	});
}, 30_000);

it("counts a service's ready wait from its launch: the stop of the service it replaces does not use it up", async () => {
	await withBroker("@omp-service-ready-launch-", async session => {
		const neverInterrupted = new AbortController();
		// A service that ignores TERM, ready once its trap is set: replacing it takes the broker's 2 s stop grace
		// before the KILL, all before the new service's launch.
		const ignoring = await startService(
			session,
			{
				name: NAME,
				command: "trap '' TERM; echo armed; sleep 600",
				pty: false,
				ready: { log: "armed", timeout: 60 },
			},
			undefined,
			neverInterrupted.signal,
		);
		expect(ignoring.readyTimedOut).toBe(false);
		const requested = performance.now();
		const outcome = await startService(
			session,
			{ name: NAME, command: "sleep 600", pty: false, ready: { log: "never printed", timeout: 3 } },
			undefined,
			neverInterrupted.signal,
		);
		const took = performance.now() - requested;
		expect({ readyTimedOut: outcome.readyTimedOut, interrupted: outcome.readyInterrupted }).toEqual({
			readyTimedOut: true,
			interrupted: false,
		});
		// At least the 2 s stop and then the whole 3 s wait; a wait counted from the request ends about 1 s after
		// the launch, 3 s after the request. 50 ms is the timers' own slack.
		expect(took).toBeGreaterThanOrEqual(2_000 + 3_000 - 50);
	});
}, 30_000);
