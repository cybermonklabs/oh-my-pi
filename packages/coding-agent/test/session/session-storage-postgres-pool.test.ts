import { describe, expect, it } from "bun:test";
import * as net from "node:net";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { openSessionSqlClient, openSessionSqlStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { sessionSqlTestClient } from "../helpers/session-sql-client";

const POSTGRES_DSN = process.env.OMP_TEST_POSTGRES_DSN;
const POOL_MAX = 2;

/** Count this client's connections, not a transaction pooler's shared server connections. */
class ClientProxy implements AsyncDisposable {
	readonly #clients = new Set<net.Socket>();
	readonly #remotes = new Set<net.Socket>();
	readonly #server: net.Server;
	peak = 0;

	constructor(target: URL) {
		this.#server = net.createServer(client => {
			const remote = net.connect({ host: target.hostname, port: Number(target.port || 5432) });
			this.#clients.add(client);
			this.#remotes.add(remote);
			this.peak = Math.max(this.peak, this.#clients.size);
			client.pipe(remote);
			remote.pipe(client);
			client.on("error", () => remote.destroy());
			remote.on("error", () => client.destroy());
			client.on("close", () => {
				this.#clients.delete(client);
				remote.destroy();
			});
			remote.on("close", () => {
				this.#remotes.delete(remote);
				client.destroy();
			});
		});
	}

	async listen(): Promise<number> {
		const ready = Promise.withResolvers<void>();
		this.#server.once("error", ready.reject);
		this.#server.listen(0, "127.0.0.1", () => ready.resolve());
		await ready.promise;
		this.#server.removeListener("error", ready.reject);
		const address = this.#server.address();
		if (!address || typeof address === "string") throw new Error("proxy has no TCP address");
		return address.port;
	}

	get count(): number {
		return this.#clients.size;
	}

	disconnect(): void {
		for (const client of this.#clients) client.resetAndDestroy();
		for (const remote of this.#remotes) remote.destroy();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.disconnect();
		const closed = Promise.withResolvers<void>();
		this.#server.close(error => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	}
}

/** Bun.SQL's real idle reaper uses the platform clock, not fake JavaScript timers. */
async function waitForConnectionCount(proxy: ClientProxy, expected: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (proxy.count !== expected) {
		if (Date.now() >= deadline)
			throw new Error(`timed out waiting for ${expected} client connections; found ${proxy.count}`);
		await Bun.sleep(50);
	}
}

describe.skipIf(!POSTGRES_DSN)("SQL session storage PostgreSQL pool", () => {
	it("bounds client connections, releases them when idle, and writes after disconnection, directly or through a transaction pooler", async () => {
		const target = new URL(POSTGRES_DSN as string);
		await using proxy = new ClientProxy(target);
		const port = await proxy.listen();
		const proxied = new URL(target);
		proxied.hostname = "127.0.0.1";
		proxied.port = String(port);
		const applicationName = `omp-session-pool-${crypto.randomUUID()}`;
		proxied.searchParams.set("application_name", applicationName);
		const monitor = sessionSqlTestClient(target.toString(), { max: 1 });
		using directory = TempDir.createSync("@pi-session-storage-postgres-pool-");
		const dsnFile = directory.join("dsn");
		await Bun.write(dsnFile, proxied.toString());
		const table = `omp_pool_${process.pid}_${Date.now().toString(36)}`;
		const leaseTable = `${table}_lease`;
		const connection = await openSessionSqlClient({
			settings: Settings.isolated({ "session.sql.dsnFile": dsnFile }),
			env: {},
		});
		try {
			const storage = await openSessionSqlStorage(connection, { table, leaseTable });
			const sessionPath = "/sessions/project/session.jsonl";
			await storage.writeText(sessionPath, "first\n");
			await storage.drain();
			// More simultaneous work than the pool admits: the proxy must see exactly two clients.
			await Promise.all(Array.from({ length: 6 }, () => connection.client.unsafe("SELECT pg_sleep(0.05)")));
			expect(proxy.peak).toBe(POOL_MAX);
			await waitForConnectionCount(proxy, 0);
			await storage.writeText(sessionPath, "after idle\n");
			await storage.drain();
			expect(await storage.readText(sessionPath)).toBe("after idle\n");
			expect(proxy.count).toBeGreaterThan(0);
			proxy.disconnect();
			await waitForConnectionCount(proxy, 0);
			await monitor.unsafe("SELECT 1");
			await storage.writeText(sessionPath, "after disconnection\n");
			await storage.drain();
			expect(await storage.readText(sessionPath)).toBe("after disconnection\n");
			expect(proxy.peak).toBe(POOL_MAX);
			// A direct connection still exercises the server's termination error.
			// Through a pooler those server connections also serve other clients.
			if (target.searchParams.get("pool_mode") !== "transaction") {
				const rows = (await monitor.unsafe("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [
					applicationName,
				])) as Array<{ pid: number }>;
				expect(rows.length).toBeGreaterThan(0);
				for (const row of rows) await monitor.unsafe("SELECT pg_terminate_backend($1)", [row.pid]);
				await waitForConnectionCount(proxy, 0);
				await storage.writeText(sessionPath, "after server termination\n");
				await storage.drain();
				expect(await storage.readText(sessionPath)).toBe("after server termination\n");
			}
		} finally {
			await connection.client.end();
			for (const name of [`${table}_parts`, `${table}_meta`, table, leaseTable])
				await monitor.unsafe(`DROP TABLE IF EXISTS ${name}`);
			await monitor.end();
		}
	}, 30_000);
});
