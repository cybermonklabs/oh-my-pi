// The broker's one-per-scope lock, as two brokers in this process meet it. Every verdict comes from
// an event: a broker either returns (it found the scope held) or calls onListening (it took the
// scope), and a broker's own run settles only after it released its lease.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

/** Long enough that no endpoint check runs during a test: a broker here stops only when asked. */
const NO_ENDPOINT_CHECK_MS = 3_600_000;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, onListening: () => void): Promise<void> {
	const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "3600000";
	const broker = startDaemonBrokerFromEnvironment({ endpointCheckMs: NO_ENDPOINT_CHECK_MS, onListening });
	for (const [name, value] of previous) restoreEnv(name, value);
	return broker;
}

/**
 * Start a broker for a client's scope and wait until it serves that client. The broker's run is
 * returned in an object: an async function would otherwise adopt it, and wait for it to end.
 */
async function serve(
	client: DaemonBrokerClient,
	projectDir: string,
	runtimeDir: string,
): Promise<{ run: Promise<void> }> {
	const listening = Promise.withResolvers<"listening">();
	const run = startBroker(projectDir, runtimeDir, () => listening.resolve("listening"));
	// A broker that returns instead found its scope held; a ping then would spawn a broker process.
	const outcome = await Promise.race([listening.promise, run.then(() => "returned" as const)]);
	if (outcome !== "listening") throw new Error(`the broker for ${runtimeDir} returned without serving`);
	expect((await client.request({ op: "ping" })).op).toBe("ping");
	return { run };
}

async function stop(client: DaemonBrokerClient, broker: { run: Promise<void> }): Promise<void> {
	await client.request({ op: "shutdown" });
	client.close();
	await broker.run;
}

describe.skipIf(process.platform === "win32")("daemon broker scope lock", () => {
	it("keeps its scope through a deleted runtime dir: a broker started meanwhile serves nothing", async () => {
		using tempDir = TempDir.createSync("@omp-launch-scope-lock-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 3_600_000 });
		const first = await serve(client, projectDir, runtimeDir);
		try {
			// A sweep or cleaner removes the scope while the first broker runs, and a client that cannot
			// reach it recreates the dir and its token and starts another broker (client.ts).
			await fs.rm(runtimeDir, { recursive: true, force: true });
			const late = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 3_600_000 });
			const lateListening = Promise.withResolvers<"listening">();
			const second = startBroker(projectDir, runtimeDir, () => lateListening.resolve("listening"));
			const outcome = await Promise.race([second.then(() => "returned" as const), lateListening.promise]);
			if (outcome === "listening") await stop(late, { run: second });
			else late.close();
			// The first still holds the scope, so the second finds it held and returns without serving.
			expect(outcome).toBe("returned");
			// The first still serves the client that reached it before the dir went.
			expect((await client.request({ op: "ping" })).op).toBe("ping");
		} finally {
			process.title = previousTitle;
			await stop(client, first);
		}
	}, 30_000);

	it("removes its broker.pid on shutdown, and never one another broker wrote", async () => {
		using tempDir = TempDir.createSync("@omp-launch-scope-lock-pid-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const pidPath = path.join(runtimeDir, "broker.pid");
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		// A live process that is not this one stands for a broker that took the scope from this one.
		const successor = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
		try {
			// Control: a broker that still owns broker.pid removes it.
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 3_600_000 });
			const own = await serve(client, projectDir, runtimeDir);
			expect(JSON.parse(await fs.readFile(pidPath, "utf8")).pid).toBe(process.pid);
			await stop(client, own);
			expect(await Bun.file(pidPath).exists()).toBe(false);

			// The case: broker.pid records another broker by the time this one gives the scope up.
			const again = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 3_600_000 });
			const lost = await serve(again, projectDir, runtimeDir);
			await fs.writeFile(pidPath, JSON.stringify({ pid: successor.pid }));
			await stop(again, lost);
			expect(JSON.parse(await fs.readFile(pidPath, "utf8"))).toEqual({ pid: successor.pid });
		} finally {
			process.title = previousTitle;
			successor.kill();
			await successor.exited;
		}
	}, 30_000);
});
