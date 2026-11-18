// An in-process daemon broker for the launch tests, and the checks that the test talks to it and to
// no other broker. A client that connects before the broker listens finds no endpoint and starts a
// broker process of its own (`client.ts`, `#spawnBroker`), which can take the scope: the test then
// talks to a broker without its options and spies, and which outlives it.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import type { DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

export interface EmbeddedBroker {
	/** Settles once this in-process broker has shut down. */
	finished: Promise<void>;
}

/**
 * Starts the in-process broker for the scope and waits until it accepts connections, so that
 * `client` connects to it and starts no broker of its own. When another process holds the scope
 * this fails, and `refused` leaves neither that broker nor `client` behind.
 */
export async function startBroker(
	client: DaemonBrokerClient,
	projectDir: string,
	runtimeDir: string,
	options: DaemonBrokerStartOptions = {},
): Promise<EmbeddedBroker> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ ...options, onListening: () => listening.resolve(true) });
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (await Promise.race([listening.promise, finished.then(() => false)])) return { finished };
	throw await refused(client, runtimeDir);
}

/**
 * The failure of an in-process broker that did not claim its scope. It first asks the broker
 * holding the scope to shut down through `client` (with no broker in the lease, a request would
 * start one), closes `client`, and waits up to 5 s for the lease to be free and that broker's
 * process to end (it frees the lease before it exits), so the failing test leaves neither behind.
 */
async function refused(client: DaemonBrokerClient, runtimeDir: string): Promise<Error> {
	const holder = await leaseHolder(runtimeDir);
	const another = holder !== undefined && holder !== process.pid ? holder : undefined;
	// Pinned before the request, so its status is that process's and never a later one's.
	const other = another === undefined ? null : Process.fromPid(another);
	if (another !== undefined) await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	const deadline = performance.now() + 5_000;
	let left = await leaseHolder(runtimeDir);
	while ((left !== undefined || other?.status() === "running") && performance.now() < deadline) {
		await Bun.sleep(20);
		left = await leaseHolder(runtimeDir);
	}
	const state =
		left !== undefined
			? `and process ${left} still holds it`
			: other?.status() === "running"
				? "and still runs"
				: "and has shut down";
	return new Error(`In-process daemon broker did not claim its scope: process ${holder ?? "none"} held it, ${state}`);
}

/** The pid in the scope's broker lease (`broker.pid`), or `undefined` when no broker holds it. */
export async function leaseHolder(runtimeDir: string): Promise<number | undefined> {
	try {
		return JSON.parse(await fs.readFile(path.join(runtimeDir, "broker.pid"), "utf8")).pid;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Fails, naming the holder, unless this process's broker holds the scope: another broker runs
 * without the test's options, and its writes and warnings reach none of the test's spies.
 */
export async function expectOwnBroker(runtimeDir: string): Promise<void> {
	const holder = await leaseHolder(runtimeDir);
	if (holder !== process.pid) {
		throw new Error(
			`the scope's broker is ${holder === undefined ? "no process" : `process ${holder}`}, not this test's ` +
				`(${process.pid}): it runs without this test's options and spies`,
		);
	}
}

/** Fails unless no broker holds the scope once this process's broker has shut down. */
export async function expectNoBrokerLeft(runtimeDir: string): Promise<void> {
	const holder = await leaseHolder(runtimeDir);
	if (holder !== undefined) throw new Error(`broker process ${holder} holds the scope after the test's broker ended`);
}
