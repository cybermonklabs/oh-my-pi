/**
 * Stdin EOF in RPC mode with a subagent in the roster, through the real
 * `runRpcMode` input path (`fixtures/subagent-eof-rpc-agent.ts` in a child
 * process): commands the client sent before closing stdin still run against
 * the live roster while the accepted work drains, and a `steer_subagent`
 * waiting for the subagent's next turn ends at once, taking its message back,
 * so the process exits by itself.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "fixtures", "subagent-eof-rpc-agent.ts");
const MESSAGE = "Also check the README.";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every stdout frame of `child`, and a wait for the first frame that matches. */
function frames(stdout: ReadableStream<Uint8Array>) {
	const seen: Record<string, unknown>[] = [];
	const waiters: Array<{ match: (frame: Record<string, unknown>) => boolean; resolve: () => void }> = [];
	const ended = (async () => {
		for await (const frame of readJsonl<unknown>(stdout)) {
			if (!isRecord(frame)) continue;
			seen.push(frame);
			for (const waiter of waiters.filter(candidate => candidate.match(frame))) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	})();
	const next = (match: (frame: Record<string, unknown>) => boolean): Promise<void> => {
		if (seen.some(match)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ match, resolve });
		return promise;
	};
	const response = (id: string) => seen.find(frame => frame.type === "response" && frame.id === id);
	return { next, response, ended };
}

/**
 * Wait for a condition another process makes true (the fixture's queue log).
 * Polls the condition itself; there is no in-process signal across the process.
 */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

describe("RPC stdin EOF with a subagent waiting between turns", () => {
	it("answers commands sent before EOF against the live roster and ends the waiting steer at once", async () => {
		const temp = TempDir.createSync("@rpc-subagent-eof-");
		cleanups.push(() => temp.removeSync());
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: temp.join("agent"),
			PI_NO_TITLE: "1",
		};
		delete env.OMP_SESSION_STORAGE;
		delete env.OMP_SESSION_SQL_DSN_FILE;
		const child = Bun.spawn([process.execPath, FIXTURE], {
			cwd: temp.path(),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Bounds a process the waiting steer would otherwise keep alive.
			timeout: 30_000,
		});
		cleanups.push(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		});
		const stderr = new Response(child.stderr).text();
		const out = frames(child.stdout);
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const queueLog = () => {
			const file = temp.join("subagent-queue.log");
			return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		};
		const roster = (id: string) => {
			const data = out.response(id)?.data;
			const subagents = isRecord(data) && Array.isArray(data.subagents) ? data.subagents : [];
			return subagents.map(subagent =>
				isRecord(subagent) ? { id: subagent.id, status: subagent.status } : subagent,
			);
		};

		await out.next(frame => frame.type === "ready");
		await send({ id: "before", type: "get_subagents" });
		await out.next(frame => frame.type === "response" && frame.id === "before");
		expect(roster("before")).toEqual([{ id: "Worker", status: "running" }]);

		await send({ id: "steer", type: "steer_subagent", subagentId: "Worker", message: MESSAGE });
		await until(() => queueLog().includes(`queued ${MESSAGE}`));
		// new_session waits on a dialog only the disconnect ends, so the next command waits behind it.
		await send({ id: "switch", type: "new_session" });
		await out.next(frame => frame.type === "extension_ui_request" && frame.method === "confirm");
		await send({ id: "late", type: "get_subagents" });
		child.stdin.end();

		const exitCode = await child.exited;
		await out.ended;
		const diagnostics = await stderr;

		expect(exitCode, diagnostics).toBe(0);
		expect(out.response("switch")).toMatchObject({ success: true, data: { cancelled: true } });
		expect(roster("late")).toEqual([{ id: "Worker", status: "running" }]);
		expect(out.response("steer")).toMatchObject({
			success: false,
			error: `Subagent's run ended before the message reached it: Worker`,
		});
		expect(queueLog()).toBe(`queued ${MESSAGE}\ntaken back ${MESSAGE}\n`);
	}, 60_000);
});
