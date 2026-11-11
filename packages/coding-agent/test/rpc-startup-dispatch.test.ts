import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, readLines, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/**
 * How long the fixture's `session_start` handler blocks in the first case. Real time: the delay is
 * what is measured.
 */
const HANDLER_MS = 8_000;
/**
 * The same delay for the held-type case below, which pays it once per held type. Shorter because
 * that case measures the sign of a difference, not a margin: a frame that is not held is answered
 * in milliseconds, so the handler only has to still be blocking when it would be.
 */
const HELD_HANDLER_MS = 2_500;
/** How long after the ready frame the first answer may take. The first case's handler blocks four times that. */
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
const spawnSlowStartupAgent = (temp: TempDir, handlerMs: number) =>
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
			OMP_STARTUP_HANDLER_MS: String(handlerMs),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

describe("RPC startup input dispatch", () => {
	test("a command sent after the ready frame is answered while a slow startup handler still runs", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-dispatch-");
		const child = spawnSlowStartupAgent(temp, HANDLER_MS);
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
	 * Send `get_state` and one held frame right after the ready frame of an agent of this type's own,
	 * and report when each was answered against the time the startup handler reported its return.
	 * With `after`, one more frame is sent once the held frame has been answered — so after startup —
	 * and its response is returned, which is how a row proves what the held frame left behind.
	 *
	 * One agent per held type, not one agent sent every held frame: `RpcInputDispatcher` runs every
	 * non-background command on a single serial tail, so a second held frame is dequeued only once the
	 * first has waited startup out, and its answer would land after the handler returned whether or
	 * not its own type is held. Only the frame at the head of the tail measures the hold.
	 */
	const measureHeldFrame = async (held: Record<string, unknown>, after?: Record<string, unknown>) => {
		const temp = await TempDir.create("@omp-rpc-startup-held-");
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS);
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
			let afterAnswer: Record<string, unknown> | undefined;
			const answered = Promise.withResolvers<void>();
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
					if (frame.id === "held") {
						heldAt = Date.now();
						// Sent only now: the held frame's answer means startup is over, so this reads what
						// the held frame left behind instead of racing it.
						if (after) {
							child.stdin.write(`${JSON.stringify({ ...after, id: "after" })}\n`);
							await child.stdin.flush();
						}
					}
					if (frame.id === "after") afterAnswer = frame;
					if (stateAt > 0 && heldAt > 0 && (!after || afterAnswer)) answered.resolve();
				}
				answered.reject(new Error("the agent closed its output before it answered every frame"));
			})().catch((readError: unknown) => {
				answered.reject(readError);
			});
			await withTimeout(
				answered.promise,
				HELD_HANDLER_MS + 30_000,
				"the agent answered no frame before the timeout",
			);

			const returned = await withTimeout(
				handlerReturned.promise,
				HELD_HANDLER_MS + 30_000,
				"the startup handler never reported its return",
			);
			expect(returned).toBeDefined();
			return {
				type: held.type,
				msFromReadyToState: stateAt - readyAt,
				msFromStartupReturnToHeld: heldAt - returned!.at,
				after: afterAnswer,
			};
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	};

	// Five agents, each waiting out one `HELD_HANDLER_MS` startup.
	test("every command the startup hold covers waits for startup, and a get_state sent with it does not", async () => {
		const objective = "ship the release";
		// One frame of each held type, so that dropping any single type from the hold fails this case
		// and not only dropping the whole set. Whether a frame answers with a success or with an error
		// is neither asserted nor relevant: the hold sits in `handleCommand` before `handleCommandImpl`,
		// so a frame waits for startup whatever its payload turns out to mean. That is why the
		// `navigate_tree` here names an entry no session tree holds, why `compact` and `handoff` run
		// against a session with nothing in it, and why `live_start` may answer with the machine's
		// missing audio device. `live_start` is held although it is background-dispatched, so it blocks
		// nothing behind it; it is held because a live delegation starts a main-session turn.
		// One agent at a time, in order: five slow-startup agents at once would measure the machine.
		const goal = await measureHeldFrame({ type: "goal", op: "create", objective }, { type: "goal", op: "get" });
		const timings = [
			goal,
			await measureHeldFrame({ type: "compact" }),
			await measureHeldFrame({ type: "navigate_tree", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "handoff" }),
			await measureHeldFrame({ type: "live_start" }),
		];

		// The `get_state` sent with each held frame does not wait for startup, as in the case above.
		expect(timings.filter(timing => timing.msFromReadyToState >= ANSWER_BUDGET_MS)).toEqual([]);
		// The point of the hold: a command that changes state is answered only once startup is over,
		// whatever its own answer says. Take any one type out of the hold and this is the assertion
		// that fails, naming that type and the milliseconds by which its answer beat the handler's
		// return.
		expect(timings.filter(timing => timing.msFromStartupReturnToHeld <= 0)).toEqual([]);
		// What the hold is for, in the one row with state to show for it: the goal the host created
		// during startup is active when the host reads it back. The hold puts `goal create` after the
		// startup reattach (`goalController.reconcile()`), so no part of startup runs over it.
		expect(goal.after).toMatchObject({ success: true, data: { goal: { objective, status: "active" } } });
	}, 240_000);
});
