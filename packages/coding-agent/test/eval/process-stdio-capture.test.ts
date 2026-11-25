import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";

function makeRuntime(): { runtime: JsRuntime; hooks: RuntimeHooks; texts: string[] } {
	const texts: string[] = [];
	const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "test" });
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (_output: EvalDisplayOutput) => {},
		callTool: async () => undefined,
	};
	return { runtime, hooks, texts };
}

describe("process.stdout/stderr capture in JS eval", () => {
	it("routes process.stdout.write into the cell output with exact bytes and no added newline", async () => {
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("process.stdout.write('a'); process.stdout.write('b');", undefined, hooks);
		// Concatenation with no separator proves writes are passed through verbatim
		// (the old behavior lost the text entirely and captured the boolean return).
		expect(texts.join("")).toBe("ab");
	});

	it("routes process.stderr.write into the cell output", async () => {
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("process.stderr.write('oops');", undefined, hooks);
		expect(texts.join("")).toBe("oops");
	});

	it("decodes Buffer chunks written to process.stdout", async () => {
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("process.stdout.write(Buffer.from('héllo', 'utf8'));", undefined, hooks);
		expect(texts.join("")).toBe("héllo");
	});
});

// A fresh process, so the test can read the process's real stdout. The embedder's tool-call hook stands for host code
// a guest call runs (an RPC or print-mode writer); `lateGate` lets it start work that runs after the run ended.
// Before the fix each of those host writes went into the run's `onText`, never to stdout; the late one, from work the
// call started (a timer, a continuation) that fires after the run ended, went into the ended run's `onText` and was
// lost, and reached stdout only once the runtime had been disposed.
const hostWritesProbe = `
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
const runText = [];
const lateGate = Promise.withResolvers();
const hooks = {
	onText: chunk => {
		runText.push(chunk);
	},
	onDisplay: () => {},
	callTool: async name => {
		const prelude = name === "__prelude__";
		process.stdout.write(prelude ? "HOST-WRITE-DURING-PRELUDE\\n" : "HOST-WRITE-DURING-TOOL\\n");
		if (!prelude) void lateGate.promise.then(() => process.stdout.write("HOST-WRITE-AFTER-RUN\\n"));
		return undefined;
	},
};
const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "host-writes" });
const value = await runtime.run(
	'await tool.read({ path: "x" }); await __omp_prelude__("probe", {}); process.stdout.write("GUEST-WRITE\\\\n"); 7;',
	"host-writes.js",
	hooks,
);
process.stdout.write("CONTROL-WRITE-OUTSIDE-ANY-RUN\\n");
lateGate.resolve();
const drained = Promise.withResolvers();
setImmediate(drained.resolve);
await drained.promise;
runtime.dispose();
process.stderr.write("SUMMARY " + JSON.stringify({ value, runText }) + "\\n");
`;

// A run whose tool call is still in flight when its runtime is disposed (so the run is abandoned); the call's host side
// writes to stdout after that, and the guest writes once the call has returned.
const abandonedHostWriteProbe = `
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
const toolCalled = Promise.withResolvers();
const gate = Promise.withResolvers();
const guestDone = Promise.withResolvers();
const hooks = {
	onText: () => {},
	onDisplay: () => {},
	callTool: async () => {
		toolCalled.resolve();
		await gate.promise;
		process.stdout.write("HOST-WRITE-AFTER-ABANDON\\n");
		return undefined;
	},
};
globalThis.guestDone = outcome => guestDone.resolve(outcome);
const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "abandoned-host-write" });
const run = runtime
	.run(
		'await (async () => { let outcome = "returned"; try { await tool.read({ path: "x" }); } catch (error) { outcome = error.name; } process.stdout.write("GUEST-LATE-WRITE\\\\n"); guestDone(outcome); })();',
		"abandoned-host-write.js",
		hooks,
	)
	.catch(() => undefined);
await toolCalled.promise;
runtime.dispose();
gate.resolve();
const outcome = await guestDone.promise;
await run;
process.stdout.write("CONTROL-WRITE-OUTSIDE-ANY-RUN\\n");
process.stderr.write("SUMMARY " + JSON.stringify({ outcome }) + "\\n");
`;

describe("host writes during a run", () => {
	it("sends a tool call's host writes, and what that host code starts, to the process's stdout", async () => {
		const proc = Bun.spawn([process.execPath, "--eval", hostWritesProbe], {
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
		// The control write shows the probe can see stdout; the host writes reach it too, the late one after the run.
		expect(stdout).toBe(
			[
				"HOST-WRITE-DURING-TOOL",
				"HOST-WRITE-DURING-PRELUDE",
				"CONTROL-WRITE-OUTSIDE-ANY-RUN",
				"HOST-WRITE-AFTER-RUN",
				"",
			].join("\n"),
		);
		// The guest's own write still goes to the run's output.
		const summary = stderr
			.split("\n")
			.find(line => line.startsWith("SUMMARY "))
			?.slice("SUMMARY ".length);
		expect(summary, stderr).toBeDefined();
		expect(JSON.parse(summary ?? "null")).toEqual({ value: 7, runText: ["GUEST-WRITE\n"] });
	});

	// With the same-realm run fence: the stdio routing drops an abandoned run's writes, so a tool call's host side must
	// leave the realm's run record as well as the runtime's store (this test fails if it keeps the run record; the test
	// above fails if it keeps the runtime's store), and the bridge must check the run after the call returns, outside
	// `#hostCall`. The host write lands after the runtime is disposed mid-call (its run abandoned).
	it("sends an abandoned run's host writes to stdout, drops its guest's, and refuses its code after the call", async () => {
		const proc = Bun.spawn([process.execPath, "--eval", abandonedHostWriteProbe], {
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
		// The host write reaches stdout; the guest's late write does not; the control write shows the probe sees stdout.
		expect(stdout).toBe(["HOST-WRITE-AFTER-ABANDON", "CONTROL-WRITE-OUTSIDE-ANY-RUN", ""].join("\n"));
		// The bridge refused the abandoned run's code once the call returned.
		const summary = stderr
			.split("\n")
			.find(line => line.startsWith("SUMMARY "))
			?.slice("SUMMARY ".length);
		expect(summary, stderr).toBeDefined();
		expect(JSON.parse(summary ?? "null")).toEqual({ outcome: "AbortError" });
	});
});
