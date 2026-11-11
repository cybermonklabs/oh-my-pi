import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, readLines, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/** How long the fixture's `session_start` handler blocks. Real time: the delay is what is measured. */
const HANDLER_MS = 8_000;
/** How long after the ready frame the first answer may take. The handler blocks four times that. */
const ANSWER_BUDGET_MS = 2_000;
/** The line the fixture writes to stderr once its `session_start` handler has returned. */
const HANDLER_RETURNED_PREFIX = "startup-handler-returned ";
/** The line the fixture's `input` handler writes, naming whether it saw that return. */
const INPUT_HANDLER_PREFIX = "input-handler-ran ";

describe("RPC startup input dispatch", () => {
	test("a command sent after the ready frame is answered while a slow startup handler still runs", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-dispatch-");
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "slow-startup-rpc-agent.ts")], {
			cwd: temp.path(),
			// A minimal environment: the child must not read the developer's or the runner's
			// home-rooted plugin and config state, which would make this test machine-dependent.
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
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
			// One reader serves both markers: a second reader of the same stream would take its lines.
			const handlerReturned = Promise.withResolvers<{ at: number } | undefined>();
			const inputHandlerRan = Promise.withResolvers<string | undefined>();
			void (async () => {
				for await (const line of readLines(child.stderr as ReadableStream<Uint8Array>)) {
					const text = decoder.decode(line);
					if (text.startsWith(HANDLER_RETURNED_PREFIX)) {
						handlerReturned.resolve({ at: Number(text.slice(HANDLER_RETURNED_PREFIX.length).trim()) });
					} else if (text.startsWith(INPUT_HANDLER_PREFIX)) {
						// `<after|before>-session-start <when>`: the first word is what the handler saw.
						inputHandlerRan.resolve(text.slice(INPUT_HANDLER_PREFIX.length).trim().split("-")[0]);
					}
				}
				// Nothing more can arrive once the agent's stderr ends.
				handlerReturned.resolve(undefined);
				inputHandlerRan.resolve(undefined);
			})().catch(() => {
				// A reader that throws (its stream errors when the child is killed) must not reject
				// unobserved: an unhandled rejection here can fail an unrelated later test file.
				handlerReturned.resolve(undefined);
				inputHandlerRan.resolve(undefined);
			});

			let readyAt = 0;
			let answerAt = 0;
			let answer: Record<string, unknown> | undefined;
			const probeAnswered = Promise.withResolvers<void>();
			// The reader keeps draining after the probe: the prompt below makes the agent write a whole
			// turn, and a reader that stopped would leave it writing into a pipe this test has closed.
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						readyAt = Date.now();
						child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "probe") {
						answerAt = Date.now();
						answer = frame;
						probeAnswered.resolve();
					}
				}
				// A no-op once the probe was answered; otherwise it is what the await below reports.
				probeAnswered.reject(new Error("the agent closed its output before it answered the probe"));
			})().catch((readError: unknown) => {
				// As above: the rejection is reported through the wait below rather than left unobserved.
				probeAnswered.reject(readError);
			});
			await withTimeout(
				probeAnswered.promise,
				HANDLER_MS + 30_000,
				"the agent answered no frame before the timeout",
			);

			expect(answer).toMatchObject({ id: "probe", command: "get_state", success: true });
			// The point of the fix: the answer does not wait for startup to finish.
			expect(answerAt - readyAt).toBeLessThan(ANSWER_BUDGET_MS);

			// A prompt that arrives while startup still runs must not start its turn before the
			// `session_start` broadcast has finished: a handler registered or a state set in a
			// `session_start` handler would otherwise not be in place for the first turn.
			child.stdin.write(`${JSON.stringify({ type: "prompt", id: "first-turn", message: "hello" })}\n`);
			await child.stdin.flush();

			const returned = await withTimeout(
				handlerReturned.promise,
				HANDLER_MS + 30_000,
				"the startup handler never reported its return",
			);
			expect(returned).toBeDefined();
			expect(answerAt).toBeLessThan(returned!.at);

			const inputOrder = await withTimeout(
				inputHandlerRan.promise,
				HANDLER_MS + 30_000,
				"the input handler never reported what it saw",
			);
			expect(inputOrder).toBe("after");
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	}, 120_000);
});
