import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readJsonl, readLines, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

/** How long the fixture's `session_start` handler blocks. Real time: the delay is what is measured. */
const HANDLER_MS = 8_000;
/** How long after the ready frame the first answer may take. The handler blocks four times that. */
const ANSWER_BUDGET_MS = 2_000;
/** The line the fixture writes to stderr once its `session_start` handler has returned. */
const HANDLER_RETURNED_PREFIX = "startup-handler-returned ";

describe("RPC startup input dispatch", () => {
	test("a command sent after the ready frame is answered while a slow startup handler still runs", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-startup-dispatch-"));
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "slow-startup-rpc-agent.ts")], {
			cwd: directory,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: directory,
				PI_NO_TITLE: "1",
				OMP_STARTUP_HANDLER_MS: String(HANDLER_MS),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const decoder = new TextDecoder();
			// The handler reports its own return on stderr, so both times come from the running agent.
			const handlerReturned = (async () => {
				for await (const line of readLines(child.stderr as ReadableStream<Uint8Array>)) {
					const text = decoder.decode(line);
					if (text.startsWith(HANDLER_RETURNED_PREFIX)) {
						return { at: Number(text.slice(HANDLER_RETURNED_PREFIX.length).trim()) };
					}
				}
				return undefined;
			})();

			let readyAt = 0;
			let answerAt = 0;
			let answer: Record<string, unknown> | undefined;
			await withTimeout(
				(async () => {
					for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
						if (!isRecord(frame)) continue;
						if (frame.type === "ready") {
							readyAt = Date.now();
							child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
							child.stdin.flush();
							continue;
						}
						if (frame.id === "probe") {
							answerAt = Date.now();
							answer = frame;
							return;
						}
					}
					throw new Error("the agent closed its output before it answered the probe");
				})(),
				HANDLER_MS + 30_000,
				"the agent answered no frame before the timeout",
			);

			expect(readyAt).toBeGreaterThan(0);
			expect(answer).toMatchObject({ id: "probe", command: "get_state", success: true });
			// The point of the fix: the answer does not wait for startup to finish.
			expect(answerAt - readyAt).toBeLessThan(ANSWER_BUDGET_MS);

			const returned = await withTimeout(
				handlerReturned,
				HANDLER_MS + 30_000,
				"the startup handler never reported its return",
			);
			expect(returned).toBeDefined();
			expect(answerAt).toBeLessThan(returned!.at);
		} finally {
			child.kill();
			await child.exited;
			await removeWithRetries(directory);
		}
	}, 120_000);
});
