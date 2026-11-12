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
	 * Send `get_state` and one held frame right after the ready frame of an agent of this row's own,
	 * and report when each was answered against the time the startup handler reported its return.
	 * `alongside` frames go out with the held frame, so they too are read while startup runs: that is
	 * how a row shows what a second frame sent during startup does to the held one. With `after`, one
	 * more frame is sent once the frame named by `afterFollows` (the held frame by default) has been
	 * answered — so after startup — and its response is returned, which is how a row proves what the
	 * frames sent during startup left behind. A row whose outcome is settled by an `alongside` frame
	 * rather than by the held one names that frame's id, so the probe cannot race it.
	 *
	 * One agent per row, not one agent sent every held frame: `RpcInputDispatcher` runs every
	 * non-background command on a single serial tail, so a second held frame is dequeued only once the
	 * first has waited startup out, and its answer would land after the handler returned whether or
	 * not its own type is held. Only the frame at the head of the tail measures the hold.
	 */
	const measureHeldFrame = async (
		held: Record<string, unknown>,
		options: {
			alongside?: Record<string, unknown>[];
			after?: Record<string, unknown>;
			afterFollows?: string;
		} = {},
	) => {
		const { alongside, after, afterFollows = "held" } = options;
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
			let stateAnswer: Record<string, unknown> | undefined;
			let heldAnswer: Record<string, unknown> | undefined;
			let afterAnswer: Record<string, unknown> | undefined;
			let afterSent = false;
			const answered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						readyAt = Date.now();
						// The held frame waits: the hold reads the command type, because each held type
						// starts a turn, changes the session, changes the goal state
						// `goalController.reconcile()` is still settling during startup, or belongs to a
						// live session whose frames must keep their arrival order. `get_state` changes
						// nothing and is answered at once.
						child.stdin.write(`${JSON.stringify({ type: "get_state", id: "state" })}\n`);
						child.stdin.write(`${JSON.stringify({ ...held, id: "held" })}\n`);
						for (const [index, extra] of (alongside ?? []).entries()) {
							child.stdin.write(`${JSON.stringify({ ...extra, id: `alongside-${index}` })}\n`);
						}
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "state") {
						stateAt = Date.now();
						stateAnswer = frame;
					}
					if (frame.id === "held") {
						heldAt = Date.now();
						heldAnswer = frame;
					}
					// Sent only now: the answer it follows means startup is over, so this reads what the
					// frames sent during startup left behind instead of racing them.
					if (after && !afterSent && frame.id === afterFollows) {
						afterSent = true;
						child.stdin.write(`${JSON.stringify({ ...after, id: "after" })}\n`);
						await child.stdin.flush();
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
				state: stateAnswer,
				held: heldAnswer,
				after: afterAnswer,
			};
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	};

	// Eighteen agents, each waiting out one `HELD_HANDLER_MS` startup.
	test("every command the startup hold covers waits for startup, and a get_state sent with it does not", async () => {
		const objective = "ship the release";
		// One frame of each held type. Every member of the hold now has a row that fails when that
		// member alone leaves `STARTUP_HELD_TYPES`: `prompt` through the first case of this file,
		// `new_session` through the withdrawal row further down, and every other member here,
		// including the `goal` ops `waitsForStartup` adds to the set. The live rows lock the hold
		// exactly as the others do: with `live_start` taken out of the hold its answer came 2,424 to
		// 2,492 ms before the handler returned, measured both against the fake controller below and
		// against the real one. `live_connect` needs its own row because the `live_start` row does
		// not cover it: taken alone out of the hold, every other row still passed. Whether a frame
		// answers with a success or with an error is neither asserted nor relevant: the hold sits in
		// `handleCommand` before `handleCommandImpl`, so a frame waits for startup whatever its
		// payload turns out to mean. That is why so many payloads here are deliberately unusable; a
		// row reads its own answer only where the comment above it says what that answer shows. The
		// live rows drive the fixture's fake live controller, so they depend on neither the
		// machine's audio device nor its realtime credentials.
		// One agent at a time, in order: eighteen slow-startup agents at once would measure the
		// machine.
		const goal = await measureHeldFrame(
			{ type: "goal", op: "create", objective },
			{ after: { type: "goal", op: "get" } },
		);
		const timings = [
			goal,
			// The user-input types but `prompt`, whose row is the first case of this file. These three
			// run against a session with no turn to steer and no turn to follow: three more payloads
			// the hold never reads.
			await measureHeldFrame({ type: "steer", message: "held steer" }),
			await measureHeldFrame({ type: "follow_up", message: "held follow up" }),
			await measureHeldFrame({ type: "abort_and_prompt", message: "held abort and prompt" }),
			// The session-change types but `new_session`, whose row is the withdrawal one below. Every
			// payload here is unusable too: the entry ids name nothing in the session tree, and the
			// two paths are relative, so the agent resolves them against its cwd, which is the temp
			// dir of its own run — a session file that is not there and a session directory that is
			// not there either.
			await measureHeldFrame({ type: "switch_session", sessionPath: "no-such-session.jsonl" }),
			await measureHeldFrame({ type: "branch", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "fork", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "open_session", sessionDir: "held-open-session" }),
			await measureHeldFrame({ type: "compact" }),
			await measureHeldFrame({ type: "navigate_tree", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "handoff" }),
			await measureHeldFrame({ type: "live_start" }),
			await measureHeldFrame({ type: "live_connect", sdpOffer: "v=0 held-offer" }),
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

		// Why `live_stop` and `live_mute` are held too: a `live_stop` sent during startup must stop
		// the `live_start` sent before it. The hold puts both after startup, the chain the live frames
		// are read into resumes them in the order the host sent them, and the bridge publishes its
		// controller before its first await, so the stop finds it. Answered during startup instead,
		// the stop would find no controller, do nothing and report success, and the held start would
		// then open the microphone after the host asked it to stop. `live_mute`, sent once startup is
		// over, is how the row reads the outcome: it fails only when no live session is running.
		const liveStopped = await measureHeldFrame(
			{ type: "live_start" },
			{ alongside: [{ type: "live_stop" }], after: { type: "live_mute", muted: true } },
		);
		expect(liveStopped.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(liveStopped.after).toMatchObject({ success: false, error: "No live session is active" });

		// `live_mute` is held for the same ordering reason, and its loss is louder than the stop's:
		// answered during startup it finds no controller and fails, so the live session the host asked
		// to be muted starts with the microphone open. Measured with `live_mute` out of the hold, the
		// mute was answered 13 ms after the ready frame with "No live session is active" while the
		// `live_start` behind it still ran 4 s later. Held, the mute applies to the session the start
		// opened, so the toggle this row sends once startup is over turns it off again; unheld, the
		// same toggle turns it on.
		const liveMuted = await measureHeldFrame(
			{ type: "live_start" },
			{ alongside: [{ type: "live_mute", muted: true }], after: { type: "live_mute" } },
		);
		expect(liveMuted.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(liveMuted.after).toMatchObject({ success: true, data: { muted: false } });

		// The hold alone does not keep the four live frames in arrival order, which is what the chain
		// built as they are read is for. `live_start` and `live_connect` are background commands and
		// start their startup wait as they are read; `live_stop` and `live_mute` start theirs only at
		// the head of the serial tail. With the held `compact` ahead of the pair the stop reaches that
		// head only after startup, by which time the backgrounded start has resumed — so without the
		// chain the stop is applied to the session the start opened, and the host's last request is
		// undone. The probe is sent once the start has been answered and runs behind the stop on the
		// serial tail either way, so it reports which request survived: a mute means the `live_start`
		// the host sent last is the request that is honoured and its session is running, while "No
		// live session is active" means the stop was applied after it.
		const liveStartedAfterStop = await measureHeldFrame(
			{ type: "compact" },
			{
				alongside: [{ type: "live_stop" }, { type: "live_start" }],
				after: { type: "live_mute", muted: true },
				afterFollows: "alongside-1",
			},
		);
		expect(liveStartedAfterStop.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(liveStartedAfterStop.after).toMatchObject({ success: true, data: { muted: true } });

		// An `abort` read while a held session change waits withdraws it. Both frames are numbered as
		// they are read, so the abort is numbered after the `new_session` even though the dispatcher
		// runs it later, and the `isCurrent` read after the startup wait answers the change as
		// cancelled instead of starting a session the host no longer wants.
		const abortedChange = await measureHeldFrame(
			{ type: "new_session" },
			{ alongside: [{ type: "abort" }], after: { type: "get_state" } },
		);
		expect(abortedChange.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(abortedChange.held).toMatchObject({ success: true, command: "new_session", data: { cancelled: true } });
		// Withdrawn means not run: the session the host had when it sent the change is still open.
		const stateData = abortedChange.state?.data;
		const sessionBefore = isRecord(stateData) ? stateData.sessionId : undefined;
		expect(typeof sessionBefore).toBe("string");
		expect(abortedChange.after).toMatchObject({ success: true, data: { sessionId: sessionBefore } });

		// The other side of the same rule, which no row above can show: `goal` with op `get` only
		// reads, so it is answered while startup runs. Hold it and this assertion fails — and a held
		// `goal get` would block every frame the dispatcher serializes behind it for the whole of
		// startup, which is the defect this issue exists for.
		const goalGet = await measureHeldFrame({ type: "goal", op: "get" });
		expect(goalGet.msFromStartupReturnToHeld).toBeLessThan(0);
		expect(goalGet.msFromReadyToState).toBeLessThan(ANSWER_BUDGET_MS);
		// Eighteen agents of 2.5 s each run this case in about 106 s on an idle machine; the budget
		// keeps four times that, so a loaded runner does not turn a slow machine into a failure.
	}, 420_000);

	/**
	 * The withdrawal covers the frames startup held and nothing sent after them. This case needs
	 * frames the agent reads once startup is over, which `measureHeldFrame` cannot send — every frame
	 * it sends goes out during startup, and its one `after` frame is answered on its own — so this
	 * case drives an agent of its own.
	 *
	 * The `export_html` ahead of the pair is what makes the frames behind it arrive the way a held
	 * frame's do: it loads the export module and writes a file, so it is still running when the agent
	 * reads the `new_session` and the `abort` sent with it, and the abort is numbered after the change
	 * the dispatcher has not started yet. Read during startup, that pair is answered `cancelled`; read
	 * after it, the change must run, and a withdrawal that reads `startupSettled` instead of the
	 * frames startup held cancels it forever.
	 */
	test("an abort read after startup does not withdraw a session change read after startup", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-after-");
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS);
		try {
			const answers = new Map<string, Record<string, unknown>>();
			const answered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						// Held, and its payload names no entry, so its answer is an error that means one
						// thing only: startup is over, and every frame sent below is read after it.
						child.stdin.write(
							`${JSON.stringify({ type: "navigate_tree", entryId: "no-such-entry", id: "startup-over" })}\n`,
						);
						await child.stdin.flush();
						continue;
					}
					if (typeof frame.id !== "string") continue;
					answers.set(frame.id, frame);
					if (frame.id === "startup-over") {
						// One write, so the agent reads the four from one chunk while the `export_html` at
						// their head still runs: the `get_state` reports the session the host is in when it
						// sends the change, and the `abort` is read before the change leaves the queue.
						child.stdin.write(
							`${[
								JSON.stringify({ type: "export_html", outputPath: "blocker.html", id: "blocker" }),
								JSON.stringify({ type: "get_state", id: "before" }),
								JSON.stringify({ type: "new_session", id: "change" }),
								JSON.stringify({ type: "abort", id: "abort" }),
							].join("\n")}\n`,
						);
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "change") {
						child.stdin.write(`${JSON.stringify({ type: "get_state", id: "after" })}\n`);
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "after") answered.resolve();
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

			// The change was not held by startup, so the abort behind it does not withdraw it.
			expect(answers.get("change")).toMatchObject({
				success: true,
				command: "new_session",
				data: { cancelled: false },
			});
			// Run, not withdrawn: the host is in a different session than the one it sent the change from.
			const beforeData = answers.get("before")?.data;
			const afterData = answers.get("after")?.data;
			const sessionBefore = isRecord(beforeData) ? beforeData.sessionId : undefined;
			const sessionAfter = isRecord(afterData) ? afterData.sessionId : undefined;
			expect(typeof sessionBefore).toBe("string");
			expect(typeof sessionAfter).toBe("string");
			expect(sessionAfter).not.toBe(sessionBefore);
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	}, 120_000);
});
