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

/**
 * Spawn the slow-startup RPC agent in `temp`, with a minimal environment: the child must not read
 * the developer's or the runner's home-rooted plugin and config state, which would make a test
 * machine-dependent.
 */
const spawnSlowStartupAgent = (temp: TempDir) =>
	Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "slow-startup-rpc-agent.ts")], {
		cwd: temp.path(),
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

describe("RPC startup input dispatch", () => {
	test("a command sent after the ready frame is answered while a slow startup handler still runs", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-dispatch-");
		const child = spawnSlowStartupAgent(temp);
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

	/**
	 * Send `get_state` and one `SESSION_MUTATING_TYPES` frame right after the ready frame of an agent
	 * of this type's own, and report when each was answered against the time the startup handler
	 * reported its return.
	 *
	 * One agent per held type, not one agent sent every held frame: `RpcInputDispatcher` runs every
	 * non-background command on a single serial tail, so a second held frame is dequeued only once the
	 * first has waited startup out, and its answer would land after the handler returned whether or
	 * not its own type is held. Only the frame at the head of the tail measures the hold.
	 */
	const measureHeldFrame = async (held: Record<string, unknown>) => {
		const temp = await TempDir.create("@omp-rpc-startup-held-");
		const child = spawnSlowStartupAgent(temp);
		try {
			const decoder = new TextDecoder();
			const handlerReturned = Promise.withResolvers<{ at: number } | undefined>();
			void (async () => {
				for await (const line of readLines(child.stderr as ReadableStream<Uint8Array>)) {
					const text = decoder.decode(line);
					if (text.startsWith(HANDLER_RETURNED_PREFIX)) {
						handlerReturned.resolve({ at: Number(text.slice(HANDLER_RETURNED_PREFIX.length).trim()) });
					}
				}
				handlerReturned.resolve(undefined);
			})().catch(() => {
				// As in the case above: a reader that throws when the child is killed must not reject
				// unobserved, which can fail an unrelated later test file.
				handlerReturned.resolve(undefined);
			});

			let readyAt = 0;
			let stateAt = 0;
			let heldAt = 0;
			const bothAnswered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						readyAt = Date.now();
						// The held frame waits: the hold reads the command type, because each held type
						// starts a turn, changes the session or changes the goal state
						// `goalController.reconcile()` is still settling during startup. `get_state` changes
						// nothing and is answered at once.
						child.stdin.write(`${JSON.stringify({ type: "get_state", id: "state" })}\n`);
						child.stdin.write(`${JSON.stringify({ ...held, id: "held" })}\n`);
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "state") stateAt = Date.now();
					if (frame.id === "held") heldAt = Date.now();
					if (stateAt > 0 && heldAt > 0) bothAnswered.resolve();
				}
				bothAnswered.reject(new Error("the agent closed its output before it answered both frames"));
			})().catch((readError: unknown) => {
				bothAnswered.reject(readError);
			});
			await withTimeout(bothAnswered.promise, HANDLER_MS + 30_000, "the agent answered no frame before the timeout");

			const returned = await withTimeout(
				handlerReturned.promise,
				HANDLER_MS + 30_000,
				"the startup handler never reported its return",
			);
			expect(returned).toBeDefined();
			return {
				type: held.type,
				msFromReadyToState: stateAt - readyAt,
				msFromStartupReturnToHeld: heldAt - returned!.at,
			};
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	};

	// Four agents, each waiting out one `HANDLER_MS` startup, so this case needs four times the wall
	// clock of the one above.
	test("every session-mutating command sent after the ready frame waits for startup, and a get_state sent with it does not", async () => {
		// One frame of each `SESSION_MUTATING_TYPES` entry, so that dropping any single entry of that
		// table fails this case and not only dropping the whole table. Whether a frame answers with a
		// success or with an error is neither asserted nor relevant: the hold sits in `handleCommand`
		// before `handleCommandImpl`, so a frame waits for startup whatever its payload turns out to
		// mean. That is why the `navigate_tree` here names an entry no session tree holds, and why
		// `compact` and `handoff` run against a session with nothing in it. `get` is the goal op that
		// needs no goal to exist.
		// One agent at a time, in order: four slow-startup agents at once would measure the machine.
		const timings = [
			await measureHeldFrame({ type: "goal", op: "get" }),
			await measureHeldFrame({ type: "compact" }),
			await measureHeldFrame({ type: "navigate_tree", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "handoff" }),
		];

		// The `get_state` sent with each held frame does not wait for startup, as in the case above.
		expect(timings.filter(timing => timing.msFromReadyToState >= ANSWER_BUDGET_MS)).toEqual([]);
		// The point of the hold: a state-changing command is answered only once startup is over,
		// whatever its own answer says. Remove any one entry from `SESSION_MUTATING_TYPES` and this is
		// the assertion that fails, naming that type and the milliseconds by which its answer beat the
		// handler's return.
		expect(timings.filter(timing => timing.msFromStartupReturnToHeld <= 0)).toEqual([]);
	}, 240_000);
});
