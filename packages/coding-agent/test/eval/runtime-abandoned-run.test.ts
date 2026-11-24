import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { bindRunFacade, waitForRun } from "@oh-my-pi/pi-coding-agent/tools/run-scope";
import { isExpectedCleanupError } from "@oh-my-pi/pi-utils/postmortem";

const REALM_BUSY = "Cannot initialize a JS runtime while another same-realm JS runtime is running";

function recordingHooks(): { hooks: RuntimeHooks; text: string[]; tools: string[] } {
	const text: string[] = [];
	const tools: string[] = [];
	return {
		hooks: {
			onText: chunk => {
				text.push(chunk);
			},
			onDisplay: () => {},
			callTool: async name => {
				tools.push(name);
				return undefined;
			},
		},
		text,
		tools,
	};
}

function constructError(sessionId: string): unknown {
	let runtime: JsRuntime | undefined;
	try {
		runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId });
		return undefined;
	} catch (error) {
		return error;
	} finally {
		runtime?.dispose();
	}
}

/** A run's outcome, observed from the start so that an abandoned run's rejection is never unhandled. */
function settled(run: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
	return run.then(
		value => ({ value }),
		(error: unknown) => ({ error }),
	);
}

/** Waits until a run's code reports it started; a run that ends first fails the test with its own outcome. */
async function untilStarted(
	started: Promise<void>,
	outcome: Promise<{ value?: unknown; error?: unknown }>,
): Promise<void> {
	await Promise.race([
		started,
		outcome.then(({ error, value }) => {
			throw error ?? new Error(`the run ended before its code started: ${String(value)}`);
		}),
	]);
}

describe("JsRuntime abandoned runs", () => {
	it("gives the realm back when a run whose code never settles is aborted mid-flight", async () => {
		const globals = globalThis as Record<string, unknown>;
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "abandoned-first" });
		const started = Promise.withResolvers<void>();
		first.setRunScope({ started: () => started.resolve() });
		const ac = new AbortController();
		const reason = new Error("first run timed out");
		let second: JsRuntime | undefined;
		try {
			const stuck = settled(
				first.run("started(); await new Promise(() => {});", "abandoned-never.js", recordingHooks().hooks, {
					signal: ac.signal,
				}),
			);
			await untilStarted(started.promise, stuck);
			ac.abort(reason);
			second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "abandoned-second" });
			expect(await second.run("1 + 1;", undefined, recordingHooks().hooks)).toBe(2);
			expect((await stuck).error).toBe(reason);
		} finally {
			delete globals.started;
			second?.dispose();
			first.dispose();
		}
	});

	it("keeps an abandoned run's late code out of the next runtime's run", async () => {
		const globals = globalThis as Record<string, unknown>;
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "late-first" });
		const firstHooks = recordingHooks();
		const wake = Promise.withResolvers<void>();
		const lateStarted = Promise.withResolvers<void>();
		const lateDone = Promise.withResolvers<void>();
		const late: Record<string, string> = {};
		const kept: unknown[] = [];
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-abandoned-run-"));
		const latePath = path.join(scratch, "late.txt");
		const ac = new AbortController();
		let second: JsRuntime | undefined;
		const hold = Promise.withResolvers<void>();
		let secondRun: Promise<unknown> | undefined;
		try {
			first.setRunScope({
				wake: wake.promise,
				latePath,
				keep: (error: unknown) => {
					kept.push(error);
				},
				report: (key: string, value: string) => {
					late[key] = value;
					if (key === "started") lateStarted.resolve();
					if (key === "done") lateDone.resolve();
				},
			});
			const abandoned = settled(
				first.run(
					`
			report("started", "");
			await wake;
			try {
				const attempt = async action => {
					try {
						await action();
						return "acted";
					} catch (error) {
						keep(error);
						return error.message;
					}
				};
				report("print", await attempt(() => print("late text")));
				report("probe", await attempt(() => probe.act()));
				report("tool", await attempt(() => tool.read({ path: "late" })));
				report("env", await attempt(() => env("OMP_LATE_ENV_PROBE", "set late")));
				report("read", await attempt(() => read(latePath)));
				report("write", await attempt(() => write(latePath, "written late")));
				report("wait", await attempt(() => wait(1)));
			} finally {
				report("done", "");
			}
			"late value";
			`,
					"abandoned-late.js",
					firstHooks.hooks,
					{ signal: ac.signal },
				),
			);
			// Abandoned mid-flight: its code is running and waits on `wake`.
			await untilStarted(lateStarted.promise, abandoned);
			ac.abort(new Error("first run abandoned"));

			second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "late-second" });
			const secondHooks = recordingHooks();
			let acted = false;
			second.setRunScope({
				hold: hold.promise,
				probe: bindRunFacade(
					{
						act: () => {
							acted = true;
						},
					},
					new AbortController().signal,
				),
				wait: (ms: number) => waitForRun(ms, new AbortController().signal),
			});
			secondRun = second.run("await hold; 7;", "next-run.js", secondHooks.hooks);

			// The abandoned code wakes while the second runtime owns the realm.
			wake.resolve();
			await lateDone.promise;
			// One macrotask: every microtask queued by then, the abandoned run's settlement included, has run.
			const drained = Promise.withResolvers<void>();
			setImmediate(drained.resolve);
			await drained.promise;

			expect(late.print).toContain("abandoned");
			expect(late.probe).toContain("abandoned");
			expect(late.tool).toContain("abandoned");
			expect(late.env).toContain("abandoned");
			// The file does not exist yet: without the fence the read would fail with ENOENT instead.
			expect(late.read).toContain("abandoned");
			expect(late.write).toContain("abandoned");
			expect(late.wait).toContain("abandoned");
			// Refused before acting: the second runtime's env is untouched and nothing was written.
			expect(second.helpers.env("OMP_LATE_ENV_PROBE")).toBeUndefined();
			expect(fs.existsSync(latePath)).toBe(false);
			// Each refusal is an expected-cleanup AbortError, so a floating one cannot end the process.
			expect(kept).toHaveLength(7);
			for (const error of kept) {
				expect(error).toHaveProperty("name", "AbortError");
				expect(isExpectedCleanupError(error)).toBe(true);
			}
			expect(acted).toBe(false);
			expect(secondHooks.text).toEqual([]);
			expect(secondHooks.tools).toEqual([]);
			expect(firstHooks.text).toEqual([]);
			expect(firstHooks.tools).toEqual([]);
			expect((await abandoned).error).toHaveProperty("message", "first run abandoned");
			// Settling late released nothing: the second run still holds the realm, with its own globals.
			expect(constructError("late-third")).toHaveProperty("message", REALM_BUSY);
			expect(globals.__omp_helpers__).toBe(second.helpers);

			hold.resolve();
			expect(await secondRun).toBe(7);
			// Nor did it record the second runtime's globals as the first one's.
			expect(await first.run("6 * 7;", undefined, recordingHooks().hooks)).toBe(42);
			expect(globals.__omp_helpers__).toBe(first.helpers);
		} finally {
			wake.resolve();
			hold.resolve();
			if (secondRun) await secondRun.catch(() => undefined);
			delete globals.wake;
			delete globals.latePath;
			delete globals.keep;
			delete globals.report;
			delete globals.hold;
			delete globals.probe;
			fs.rmSync(scratch, { recursive: true, force: true });
			second?.dispose();
			first.dispose();
		}
	});

	it("never evaluates the code of a run whose signal aborted before it started", async () => {
		const globals = globalThis as Record<string, unknown>;
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "aborted-before-start" });
		const reason = new Error("cancelled before start");
		try {
			await expect(
				runtime.run("globalThis.evaluatedAfterAbort = true;", undefined, recordingHooks().hooks, {
					signal: AbortSignal.abort(reason),
				}),
			).rejects.toBe(reason);
			expect("evaluatedAfterAbort" in globals).toBe(false);
			expect(constructError("after-aborted-start")).toBeUndefined();
		} finally {
			delete globals.evaluatedAfterAbort;
			runtime.dispose();
		}
	});

	it("evaluates nothing of a run abandoned while its code was still compiling", async () => {
		const globals = globalThis as Record<string, unknown>;
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "abandoned-compiling" });
		const code = "globalThis.compiledThenAbandoned = (globalThis.compiledThenAbandoned ?? 0) + 1;";
		const reason = new Error("cancelled while compiling");
		try {
			// Warm the compiler first, so both compiles below are microtask chains of the same length.
			await runtime.run("0;", undefined, recordingHooks().hooks);
			const ac = new AbortController();
			const abandoned = settled(runtime.run(code, undefined, recordingHooks().hooks, { signal: ac.signal }));
			// `run` compiles the code asynchronously, so this abort lands before it is evaluated.
			ac.abort(reason);
			expect((await abandoned).error).toBe(reason);
			// The same code again: once this run has compiled and evaluated it, the abandoned run's compile is done too.
			await runtime.run(code, undefined, recordingHooks().hooks);
			const drained = Promise.withResolvers<void>();
			setImmediate(drained.resolve);
			await drained.promise;
			expect(globals.compiledThenAbandoned).toBe(1);
		} finally {
			delete globals.compiledThenAbandoned;
			runtime.dispose();
		}
	});

	it("gives the realm back when a runtime is disposed during a run that never settles", async () => {
		const globals = globalThis as Record<string, unknown>;
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "disposed-mid-run" });
		const started = Promise.withResolvers<void>();
		first.setRunScope({ started: () => started.resolve() });
		let second: JsRuntime | undefined;
		try {
			const stuck = settled(
				first.run("started(); await new Promise(() => {});", "disposed-never.js", recordingHooks().hooks),
			);
			await untilStarted(started.promise, stuck);
			first.dispose();
			second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "after-dispose" });
			expect(await second.run("2 + 3;", undefined, recordingHooks().hooks)).toBe(5);
			expect(String((await stuck).error)).toContain("disposed");
		} finally {
			delete globals.started;
			second?.dispose();
			first.dispose();
		}
	});

	for (const [bridge, call] of [
		["tool.read", 'tool.read({ path: "image" })'],
		["__omp_prelude__", '__omp_prelude__("probe", {})'],
	] as const) {
		it(`calls no hook of a run abandoned while its ${bridge} call was in flight`, async () => {
			const globals = globalThis as Record<string, unknown>;
			const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: `abandoned-${bridge}-call` });
			const toolCalled = Promise.withResolvers<void>();
			const toolResult = Promise.withResolvers<unknown>();
			const outcome = Promise.withResolvers<string>();
			const displays: unknown[] = [];
			const hooks: RuntimeHooks = {
				onText: () => {},
				onDisplay: output => {
					displays.push(output);
				},
				callTool: () => {
					toolCalled.resolve();
					return toolResult.promise;
				},
			};
			runtime.setRunScope({ settle: (text: string) => outcome.resolve(text) });
			const ac = new AbortController();
			try {
				const abandoned = settled(
					runtime.run(
						`try { await ${call}; settle("returned"); } catch (error) { settle(error.message); }`,
						"abandoned-tool-call.js",
						hooks,
						{ signal: ac.signal },
					),
				);
				await untilStarted(toolCalled.promise, abandoned);
				ac.abort(new Error("abandoned while its tool ran"));
				// The tool answers after the run was given up, with an image the bridge would display.
				toolResult.resolve({ images: [{ data: "aGk=", mimeType: "image/png" }] });
				expect(await outcome.promise).toContain("abandoned");
				expect(displays).toEqual([]);
				expect((await abandoned).error).toHaveProperty("message", "abandoned while its tool ran");
			} finally {
				delete globals.settle;
				runtime.dispose();
			}
		});
	}
});
