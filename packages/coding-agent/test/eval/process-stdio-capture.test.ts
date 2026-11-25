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
});
