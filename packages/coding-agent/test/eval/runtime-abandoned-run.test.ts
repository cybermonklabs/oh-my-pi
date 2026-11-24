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

/** A run's outcome, observed from the start so that a rejection is never unhandled. */
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

/** One macrotask: every microtask queued by then has run. */
async function drained(): Promise<void> {
	const next = Promise.withResolvers<void>();
	setImmediate(next.resolve);
	await next.promise;
}

describe("JsRuntime abandoned runs", () => {
	it("gives the realm back when a runtime is disposed during a run that never settles", async () => {
		const globals = globalThis as Record<string, unknown>;
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "disposed-mid-run" });
		const started = Promise.withResolvers<void>();
		// Plain globals, not run scope: the dispose below takes the runtime's own globals with it.
		globals.started = () => started.resolve();
		let second: JsRuntime | undefined;
		try {
			const stuck = settled(
				first.run("started(); await new Promise(() => {});", "disposed-never.js", recordingHooks().hooks),
			);
			await untilStarted(started.promise, stuck);
			first.dispose();
			second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "after-dispose" });
			expect(await second.run("2 + 3;", undefined, recordingHooks().hooks)).toBe(5);
		} finally {
			delete globals.started;
			second?.dispose();
			first.dispose();
		}
	});

	it("keeps a disposed run's late code out of the next runtime's run", async () => {
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
		let second: JsRuntime | undefined;
		const hold = Promise.withResolvers<void>();
		let secondRun: Promise<unknown> | undefined;
		try {
			// Plain globals, not run scope: the dispose below takes the runtime's own globals with it.
			Object.assign(globals, {
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
			`,
					"abandoned-late.js",
					firstHooks.hooks,
				),
			);
			// Disposed mid-flight: its code is running and waits on wake.
			await untilStarted(lateStarted.promise, abandoned);
			first.dispose();

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

			// The disposed run's code wakes while the second runtime owns the realm.
			wake.resolve();
			await lateDone.promise;
			await drained();

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
			// Its late settlement freed nothing: the second run still holds the realm, with its own globals.
			await abandoned;
			expect(constructError("late-third")).toHaveProperty("message", REALM_BUSY);
			expect(globals.__omp_helpers__).toBe(second.helpers);

			hold.resolve();
			expect(await secondRun).toBe(7);
			expect(constructError("late-fourth")).toBeUndefined();
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

	// From the review that found the stdio route unguarded: a late write reaches no hooks, nor the real stream, and
	// does not throw (host code that shares the run's async context treats a throwing write as fatal). A fresh
	// process, so the real stream can be read.
	it("drops a disposed run's late process.stdout.write", async () => {
		const probe = [
			'import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";',
			"const recording = () => {",
			"	const text = [];",
			"	return { text, hooks: { onText: c => { text.push(c); }, onDisplay: () => {}, callTool: async () => undefined } };",
			"};",
			'const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "stdio-first" });',
			"const firstRecording = recording();",
			"const started = Promise.withResolvers();",
			"const wake = Promise.withResolvers();",
			"const wrote = Promise.withResolvers();",
			"Object.assign(globalThis, { started: () => started.resolve(), wake: wake.promise, wrote: o => wrote.resolve(o) });",
			"const abandoned = first.run(",
			'	\'started(); await wake; try { process.stdout.write("LATE-STDIO-MARKER"); wrote("returned"); } catch (error) { wrote(error.message); }\',',
			'	"stdio-late.js",',
			"	firstRecording.hooks,",
			").then(() => undefined, () => undefined);",
			"await started.promise;",
			"first.dispose();",
			'const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "stdio-second" });',
			"const secondRecording = recording();",
			"const held = Promise.withResolvers();",
			"second.setRunScope({ held: held.promise });",
			'const secondRun = second.run("await held; 4;", "stdio-next.js", secondRecording.hooks);',
			"wake.resolve();",
			"const outcome = await wrote.promise;",
			"held.resolve();",
			"const value = await secondRun;",
			"await abandoned;",
			"second.dispose();",
			"const summary = { outcome, value, firstText: firstRecording.text, secondText: secondRecording.text };",
			'process.stdout.write("SUMMARY " + JSON.stringify(summary) + "\\n");',
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--eval", probe], {
			cwd: path.resolve(import.meta.dir, "../../../.."),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).not.toContain("LATE-STDIO-MARKER");
		const summary = stdout
			.split("\n")
			.find(line => line.startsWith("SUMMARY "))
			?.slice("SUMMARY ".length);
		expect(summary, stdout).toBeDefined();
		expect(JSON.parse(summary ?? "null")).toEqual({ outcome: "returned", value: 4, firstText: [], secondText: [] });
	});

	it("evaluates nothing of a run disposed while its code was still compiling", async () => {
		const globals = globalThis as Record<string, unknown>;
		const compiling = new JsRuntime({ initialCwd: process.cwd(), sessionId: "disposed-compiling" });
		const code = "globalThis.compiledThenAbandoned = (globalThis.compiledThenAbandoned ?? 0) + 1;";
		let other: JsRuntime | undefined;
		try {
			// Warm the compiler first, so both compiles below are microtask chains of the same length.
			await compiling.run("0;", undefined, recordingHooks().hooks);
			const abandoned = settled(compiling.run(code, undefined, recordingHooks().hooks));
			// `run` compiles the code asynchronously, so this dispose lands before it is evaluated.
			compiling.dispose();
			expect(String((await abandoned).error)).toContain("abandoned");
			// The same code in another runtime: once it has compiled and evaluated it, the disposed run's compile is
			// done too.
			other = new JsRuntime({ initialCwd: process.cwd(), sessionId: "after-compiling" });
			await other.run(code, undefined, recordingHooks().hooks);
			await drained();
			expect(globals.compiledThenAbandoned).toBe(1);
		} finally {
			delete globals.compiledThenAbandoned;
			other?.dispose();
			compiling.dispose();
		}
	});

	for (const [bridge, call] of [
		["tool.read", 'tool.read({ path: "image" })'],
		["__omp_prelude__", '__omp_prelude__("probe", {})'],
	] as const) {
		it(`calls no hook of a run disposed while its ${bridge} call was in flight`, async () => {
			const globals = globalThis as Record<string, unknown>;
			const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: `disposed-${bridge}-call` });
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
			globals.settle = (text: string) => outcome.resolve(text);
			try {
				const abandoned = settled(
					runtime.run(
						`try { await ${call}; settle("returned"); } catch (error) { settle(error.message); }`,
						"disposed-tool-call.js",
						hooks,
					),
				);
				await untilStarted(toolCalled.promise, abandoned);
				runtime.dispose();
				// The tool answers after the run was given up, with an image the bridge would display.
				toolResult.resolve({ images: [{ data: "aGk=", mimeType: "image/png" }] });
				expect(await outcome.promise).toContain("abandoned");
				expect(displays).toEqual([]);
			} finally {
				delete globals.settle;
				runtime.dispose();
			}
		});
	}
});
